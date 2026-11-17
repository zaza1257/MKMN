import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stepwise, type Session } from "../src/core/build";
import { createLiveRun, type SettledStep, type SettleOutcome } from "../src/core/harness/run";
import { openRunScope, closeRunScope, currentRun } from "../src/core/harness/current";
import { readJournal } from "../src/core/harness/journal";
import { sString } from "../src/core/harness/schema";
import type { ChatEvent } from "../src/shared/types";

/**
 * The build's final status is settle()'s: every model call the build made is
 * a step of the build's run, and the last build event is derived from the verdict over
 * those steps and the gates (src/core/build.ts buildGates) — never decided by
 * the pipeline's own code. Both regressions here fail on the earlier code, where the
 * run wiring does not exist and the status came from counting failures by hand.
 */

const stats = { ttftSec: 0.1, tokPerSec: 10, tokens: 5, totalSec: 0.5 };

const PLAN3 = "Mode: build\nDesign: plain\nFile: index.html | new | the page\nFile: style.css | new | the look\nFile: script.js | new | the words";
const PAGE = '<!doctype html>\n<html><head><title>t</title><link rel="stylesheet" href="style.css"></head><body>\n<p id="n">1</p>\n<script src="script.js"></script>\n</body></html>';

/** A model that answers by session name and journals every call as a step of the open run — what the gateway-backed stream does in the app (journaledStream). */
function fake(reply: (sid: string) => string | Error) {
  const stream: Session = async function* (sid, msgs) {
    if (/:x:ask$/.test(sid)) { yield { id: sid, type: "answer" as const, text: "" }; yield { id: sid, type: "done" as const, stats }; return; }
    const name = sid.replace(/^[^:]*:/, "");
    const out = reply(name);
    const run = currentRun(sid);
    if (out instanceof Error) {
      // the call is a step; a call that throws is a failed step, and the error reaches the caller as it always did
      await run?.step({ id: sid, kind: "model-call", input: { model: "fake", messages: msgs.length }, schema: sString(), exec: () => { throw out; } });
      throw out;
    }
    for (let i = 0; i < out.length; i += 17) yield { id: sid, type: "answer" as const, text: out.slice(i, i + 17) };
    yield { id: sid, type: "done" as const, stats };
    await run?.step({ id: sid, kind: "model-call", input: { model: "fake", messages: msgs.length }, schema: sString(), exec: () => ({ output: out, reply: out }) });
  };
  return { stream };
}

/** A build driven inside its own run, the way the chat orchestrator drives it (the scope stack + runSteps). */
async function scopedBuild(id: string, stream: Session, extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-settle-"));
  const journalFile = path.join(dir, "build.jsonl");
  const run = createLiveRun({ pipeline: "build", runId: `build-${id}`, journalFile });
  openRunScope(id, run);
  const events: ChatEvent[] = [];
  const holder: { verdict?: SettleOutcome } = {};
  try {
    const g = stepwise({ id, messages: [{ role: "user", content: "make a small page" }], stream, maxChars: 8000, runSteps: () => run.steps, runGates: (gates) => run.setGates(gates), ...extra });
    let r = await g.next();
    while (!r.done) { events.push(r.value); r = await g.next(); }
    return { events, result: r.value, run, journalFile, dir, outcome: holder };
  } finally {
    closeRunScope(id, run);
    holder.verdict = run.finish();
  }
}

const buildsOf = (events: ChatEvent[]) => events.filter((e): e is Extract<ChatEvent, { type: "build" }> => e.type === "build");
const answersOf = (events: ChatEvent[]) => events.filter((e): e is Extract<ChatEvent, { type: "answer" }> => e.type === "answer").map((e) => e.text).join("");

const writes = (sid: string) => {
  if (sid === "plan") return PLAN3;
  if (sid.startsWith("write:0")) return PAGE;
  if (sid.startsWith("write:1")) return "p { color: #222 }";
  if (sid.startsWith("write:2")) return "document.getElementById('n');";
  return "";
};

describe("the person's skip/back press becomes a journal fact of the build's run", () => {
  it("a press the build sees is recorded once as a rewind entry of its run, and the build completes", async () => {
    // The press waits in the map before the writes start (the person pressed skip while
    // the plan was being made): the first control poll that sees it fires onControl ONCE,
    // and the run records it — the same wiring the chat orchestrator uses
    // (src/core/chatOrchestrator.ts, the stepwise call inside the build's scopedRun).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-settle-press-"));
    const journalFile = path.join(dir, "build.jsonl");
    const run = createLiveRun({ pipeline: "build", runId: "build-t4", journalFile });
    openRunScope("t4", run);
    const events: ChatEvent[] = [];
    const presses: ("skip" | "back")[] = [];
    try {
      const g = stepwise({
        id: "t4", messages: [{ role: "user", content: "make a small page" }], stream: fake(writes).stream, maxChars: 8000,
        control: () => ({ n: 1, action: "skip" as const }), // the press sits in the map from before the first poll
        onControl: (action) => { presses.push(action); run.rewind(action, action === "back" ? "the person pressed go back a step" : "the person pressed skip this step"); },
        check: async () => ({ errors: [], notes: [], wired: 3 }),
        runSteps: () => run.steps, runGates: (gates) => run.setGates(gates),
      });
      let r = await g.next();
      while (!r.done) { events.push(r.value); r = await g.next(); }
      // the press was seen exactly once, whatever the many control polls
      expect(presses).toEqual(["skip"]);
      const rewinds = readJournal(journalFile).entries.filter((e) => e.type === "rewind");
      expect(rewinds).toHaveLength(1);
      expect((rewinds[0] as { action: string }).action).toBe("skip");
      // the build finished its files; the verdict is settle()'s over the effective steps
      expect((r.value as { handled: boolean }).handled).toBe(true);
      expect(buildsOf(events).at(-1)!.build.status).toBe("done");
      expect(run.finish().state).toBe("done");
    } finally {
      closeRunScope("t4", run);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the build's verdict is settle()'s over the run's steps", () => {
  it("a build whose summary call fails ends unresolved through settle(), and the failed call is a journaled step", async () => {
    const m = fake((name) => (name === "explain" ? new Error("explain: the model server is gone") : writes(name)));
    const { events, run, journalFile, outcome, dir } = await scopedBuild("t1", m.stream, { check: async () => ({ errors: [], notes: [], wired: 3 }) });
    try {
      expect(buildsOf(events).at(-1)!.build.status).toBe("unresolved");
      // the failed summary is a step of the run, and settle() saw it: the run's own verdict is failed
      // (a hard-failed step), which the build machine shows as unresolved
      const failed = run.steps.find((s) => s.id.endsWith(":explain"));
      expect(failed?.status).toBe("failed");
      expect(failed?.error ?? "").toContain("the model server is gone");
      expect(outcome.verdict?.state).toBe("failed");
      // the journal holds it: append-only evidence of what the turn spent
      const { entries } = readJournal(journalFile);
      const journaled = entries.find((e) => e.type === "step" && (e as { id?: string }).id?.endsWith(":explain")) as { status: string; error?: string } | undefined;
      expect(journaled?.status).toBe("failed");
      expect(journaled?.error).toContain("the model server is gone");
      // the person still gets the fallback summary: the window is never a silent stop
      expect(answersOf(events)).toContain("Done: index.html, style.css, script.js.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a build whose page wires nothing ends unresolved through settle(), and the verdict names the gate; a wired page settles done", async () => {
    const bare = await scopedBuild("t2", fake(writes).stream, { check: async () => ({ errors: [], notes: [], wired: 0 }) });
    try {
      expect(buildsOf(bare.events).at(-1)!.build.status).toBe("unresolved");
      expect(bare.outcome.verdict?.state).toBe("unresolved");
      expect(bare.outcome.verdict?.error ?? "").toContain("test-run"); // the gate's name is the cause
      // every step settled ok: the unresolved comes from the gate, not from a failed call
      expect(bare.run.steps.every((s: SettledStep) => s.status === "ok")).toBe(true);
    } finally {
      fs.rmSync(bare.dir, { recursive: true, force: true });
    }

    const wired = await scopedBuild("t3", fake(writes).stream, { check: async () => ({ errors: [], notes: [], wired: 3 }) });
    try {
      expect(buildsOf(wired.events).at(-1)!.build.status).toBe("done");
      expect(wired.outcome.verdict?.state).toBe("done");
      // the journal holds the whole build: one step per model call, all ok
      const steps = readJournal(wired.journalFile).entries.filter((e) => e.type === "step") as { id: string; status: string }[];
      expect(steps.length).toBe(5); // plan, the three writes, the summary
      expect(steps.every((s) => s.status === "ok")).toBe(true);
    } finally {
      fs.rmSync(wired.dir, { recursive: true, force: true });
    }
  });
});
