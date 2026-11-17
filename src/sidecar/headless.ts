/**
 * The sidecar's CLI mode (the owner chose the scope): one turn
 * in over argv, the answer out on stdout, then exit — so the acceptance and
 * real-run drivers drive the app's OWN turn machinery (the real orchestrator,
 * the real per-turn budget, the real journal) instead of hand-rolling protocol
 * sessions over the sidecar's stdin/stdout, and the installed bundle can be
 * driven directly (`node main.js --ask "..."`) for its release acceptance.
 *
 * The shape of the mode comes from what a CLI process IS: there is no app host
 * here. The Tauri host owns `geniex.exe` and every server bring-up goes through
 * it (ensureServer is a host roundtrip), so headless exec does NOT start model
 * servers — the server must already listen, named by --endpoint, and everything
 * the turn asks of the host is answered honestly from that fact: no busy
 * marking, no NPU recovery, no settings writes, no speed records. The router is
 * left out entirely (the words alone sort the request — the designed fallback),
 * so a CLI turn spawns no processes of its own.
 *
 * The remaining pieces of the sidecar's host are kept AS THEY ARE, because they
 * self-contain: the artifact check plays the page in its own VM, the knowledge
 * index builds in memory, the screenshot describer uses the same --endpoint.
 * main.ts guards the stdout protocol separately (in CLI mode `write` drops
 * protocol lines and fails host roundtrips fast), so stray calls can neither
 * corrupt the CLI's stdout nor hang for the protocol's default timeout.
 */
import * as path from "node:path";
import { runChatOrchestrator, type ChatHost, type Served } from "../core/chatOrchestrator";
import { withAnswer } from "../core/chat";
import { journalDir } from "../core/harness/journal";
import type { ChatEvent, ChatStats } from "../shared/types";
import { readBool, readSetting } from "../shared/settingsSchema";

export interface HeadlessArgs {
  ask: string;
  json: boolean;
  model?: string;
  endpoint?: string;
  workspace?: string;
}

const USAGE =
  "MKMN sidecar, one-shot mode: node main.js --ask \"the request\" [--model <entry id>] [--endpoint <url>] [--workspace <dir>] [--json]\n" +
  "  --ask       the request: one turn in, the answer out, then exit\n" +
  "  --model     which model (an entry id); default: the last one this installation loaded\n" +
  "  --endpoint  an OpenAI-compatible server that already listens (CLI mode never starts model servers)\n" +
  "  --workspace where this turn's harness journal is written (default: the app's own workspace)\n" +
  "  --json      one JSON result on stdout instead of the plain answer";

/** Parses argv; a bad invocation comes back as `{ error }` and nothing runs. */
export function parseHeadlessArgs(argv: string[]): HeadlessArgs | { error: string } {
  const out: HeadlessArgs = { ask: "", json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const flag = eq > 2 && a.startsWith("--") ? a.slice(0, eq) : a;
    const inline = eq > 2 && a.startsWith("--") ? a.slice(eq + 1) : undefined;
    const take = (): string | undefined => {
      if (inline !== undefined) return inline;
      i++;
      return argv[i];
    };
    switch (flag) {
      case "--ask": { const v = take(); if (!v?.trim()) return { error: "--ask needs the request text\n" + USAGE }; out.ask = v; break; }
      case "--json": out.json = true; break;
      case "--model": { const v = take(); if (!v?.trim()) return { error: "--model needs an entry id\n" + USAGE }; out.model = v; break; }
      case "--endpoint": { const v = take(); if (!v?.trim()) return { error: "--endpoint needs an OpenAI-compatible url, e.g. http://127.0.0.1:18181/v1\n" + USAGE }; out.endpoint = v; break; }
      case "--workspace": { const v = take(); if (!v?.trim()) return { error: "--workspace needs a directory\n" + USAGE }; out.workspace = v; break; }
      default: return { error: `unknown argument: ${a}\n` + USAGE };
    }
  }
  if (!out.ask.trim()) return { error: "--ask \"...\" names the request (one turn in, the answer out)\n" + USAGE };
  return out;
}

/** The answer as the screen holds it: appended, taken back (retract), or replaced whole — the same read the window does. */
export function answerOf(events: ChatEvent[]): string {
  let t = "";
  for (const ev of events) {
    if (ev.type === "replace") t = ev.text;
    else t = withAnswer(t, ev);
  }
  return t;
}

export interface HeadlessIO {
  /** The CLI result on stdout (in --json mode exactly one JSON line). May return a promise: the runner flushes before exiting. */
  out: (s: string) => void | Promise<void>;
  /** Diagnostics, notices and the journal path on stderr. May return a promise: the runner flushes before exiting. */
  err: (s: string) => void | Promise<void>;
}

export interface HeadlessResult {
  outcome: "done" | "error";
  answer: string;
  notices: string[];
  error?: { title: string; fix?: string; raw?: string };
  stats?: ChatStats;
  model: string;
  turnId: string;
  journal: string;
}

/**
 * Runs the one turn and returns the process exit code (0 the turn ended done,
 * 1 it ended in error or the invocation was refused). `warm` runs before the
 * entry is resolved (the sidecar warms its Foundry catalog there); the base
 * host is the sidecar's own — the headless host is it, with the host-owned
 * pieces answered from the --endpoint fact.
 */
export async function headlessAsk(argv: string[], base: ChatHost, io: HeadlessIO, warm?: () => Promise<void>): Promise<number> {
  const parsed = parseHeadlessArgs(argv);
  if ("error" in parsed) {
    await io.err(parsed.error);
    return 1;
  }
  const args: HeadlessArgs = parsed;
  if (!args.endpoint) {
    await io.err("headless exec does not start model servers (there is no app host in CLI mode): pass --endpoint <url> of an OpenAI-compatible server that already listens.\n" + USAGE);
    return 1;
  }
  try {
    await warm?.();
  } catch { /* the entry is resolved from what is known */ }

  const entry = args.model ? base.entryById(args.model) : base.lastLoaded();
  if (!entry) {
    await io.err(args.model
      ? `--model ${args.model} names no model this app knows.`
      : "no --model given and no model is loaded in this installation: pass --model <entry id>.");
    return 1;
  }

  // the endpoint named, the one fact the host-owned pieces are answered from
  const served: Served = { endpoint: args.endpoint, model: base.servedName(entry), status: () => ({ nctx: null, contextKind: null }) };
  const turnId = `cli-${Date.now().toString(36)}`;
  const journalFile = args.workspace
    ? path.join(args.workspace, "harness.jsonl")
    : path.join(journalDir(), "cli.jsonl"); // the app's own harness folder, one file for the CLI's runs

  const events: ChatEvent[] = [];
  const host: ChatHost = {
    ...base,
    // the events ARE the CLI's result now: collected, not streamed to a window
    send: (ev) => { events.push(ev); },
    // a one-shot turn persists nothing: no settings patches, no speed records,
    // no evidence — the CLI reads this installation, it does not write it
    patchSettings: () => {},
    recordSpeed: () => {},
    // the server is already up, owned by whoever named --endpoint
    ensureServer: async () => served,
    recoverServer: async () => served,
    markGeneration: () => {},
    npuRecovery: async () => ({
      external: [],
      canReset: false,
      reset: async () => ({ ok: false, message: "headless exec does not manage the NPU: the model server belongs to whoever named --endpoint." }),
    }),
    // no router here: the words alone sort the request (the designed fallback),
    // so a CLI turn spawns no processes of its own
    router: undefined,
    harnessJournalFile: () => journalFile,
  };

  const settings = base.settings();
  await runChatOrchestrator(host, turnId, entry.id, [{ role: "user", content: args.ask }], {
    effort: readSetting(settings, "effort"),
    subagents: readBool(settings, "subagents"),
  });

  // the last done / error event (plain loops: the target's lib has no findLast)
  let done: Extract<ChatEvent, { type: "done" }> | undefined;
  let bad: Extract<ChatEvent, { type: "error" }> | undefined;
  for (const e of events) {
    if (e.type === "done") done = e;
    if (e.type === "error") bad = e;
  }
  const answer = answerOf(events);
  const notices = events.filter((e): e is Extract<ChatEvent, { type: "notice" }> => e.type === "notice").map((e) => e.text);
  const result: HeadlessResult = {
    outcome: done ? "done" : "error",
    answer,
    notices,
    ...(bad ? {
      error: {
        title: bad.error.title,
        ...(bad.error.fix ? { fix: bad.error.fix } : {}),
        ...(bad.error.raw ? { raw: bad.error.raw } : {}),
      },
    } : {}),
    ...(done ? { stats: done.stats } : {}),
    model: entry.id,
    turnId,
    journal: journalFile,
  };

  if (args.json) {
    await io.out(JSON.stringify(result) + "\n");
  } else {
    // plain mode: the stdout is the answer, pipable clean; everything else is stderr
    await io.out(answer.trimEnd() + (answer.trim() ? "\n" : ""));
    for (const n of notices) await io.err(`notice: ${n}`);
    if (result.error) await io.err(`error: ${result.error.title}${result.error.fix ? ` — ${result.error.fix}` : ""}`);
    await io.err(`journal: ${journalFile}`);
  }
  return done ? 0 : 1;
}
