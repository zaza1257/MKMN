import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CatalogEntry, ChatEvent, HardwareProfile, Settings } from "../src/shared/types";
import type { ChatHost, Served } from "../src/core/chatOrchestrator";
import { readJournal } from "../src/core/harness/journal";
import { headlessAsk, parseHeadlessArgs, answerOf, type HeadlessIO } from "../src/sidecar/headless";

/**
 * The sidecar's CLI mode (the owner chose the scope): one turn
 * in over argv (`--ask "..."`), the answer out on stdout, then exit — so the
 * acceptance and real-run drivers drive the app's own turn machinery (the real
 * orchestrator, the real budget, the real journal) instead of hand-rolling
 * protocol sessions over the sidecar's stdin/stdout. There is no app host in
 * CLI mode: the model's server must already listen, named by --endpoint.
 * Everything else the turn needs is the same code the window uses.
 */

const ENTRY: CatalogEntry = {
  id: "test-1b", name: "Test 1B", repo: "org/test-1b", quant: "Q4_0", engine: "qairt", role: "chat",
  architecture: "llama", sizeGB: 1, recommendedContext: 4096, sampling: { temperature: 0.7, top_p: 0.9, max_tokens: 512 }
};

const HW: HardwareProfile = { chipName: "Test Chip", chipFamily: "x2", isSnapdragon: true, ramGB: 16, npuDetected: true, npuDriverVersion: "1.0.0", npuBudgetGB: 8 };
const SETTINGS = { selectedModelId: "test-1b", webSearch: false, wikimediaImages: false, agentLoop: false, autoCheck: false, effort: null, subagents: false } as unknown as Settings;

const sse = (chunks: object[]): Response => {
  const lines = [...chunks.map((c) => `data: ${JSON.stringify(c)}`), "data: [DONE]", ""];
  return new Response(new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(`${l}\n\n`)); c.close(); }
  }), { status: 200 });
};
const DELTA = (content: string) => ({ choices: [{ delta: { content } }] });
const STOP = { choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 3, prompt_tokens: 9 } };

/** The base host the CLI mode derives from — here a test double with the same shape the sidecar's own host has. */
function fakeBaseHost(events: ChatEvent[], o?: { lastLoaded?: CatalogEntry | null }): ChatHost {
  return {
    settings: () => SETTINGS,
    patchSettings: () => {},
    allEntries: () => [ENTRY],
    entryById: (id) => (id === ENTRY.id ? ENTRY : undefined),
    installedEntries: async () => [ENTRY],
    chatHardware: async () => HW,
    lastLoaded: () => o?.lastLoaded ?? null,
    setLastLoaded: () => {},
    benchRunning: () => false,
    ensureServer: async (): Promise<Served> => ({ endpoint: "http://from-the-base-host.invalid/v1", status: () => ({ nctx: null }) }),
    servedName: (e) => `${e.repo}:${e.quant}`,
    send: (ev) => events.push(ev),
    recordSpeed: () => {},
    runSearch: async () => ({ text: "", display: "", sources: 0 }),
    searchImages: async () => ({ text: "", display: "", files: [] }),
    commonsJson: async () => ({}),
    wikiPicture: async () => null,
    folderOf: () => null,
    figure: async () => null,
    lookAtShot: async () => null,
    checkArtifact: async () => ({ ran: "none", errors: [] }),
    harnessJournalFile: () => null,
  };
}

function io(): HeadlessIO & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return { outs, errs, out: (s) => outs.push(s), err: (s) => errs.push(s) };
}

const ENDPOINT = "http://127.0.0.1:18181/v1";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the CLI arguments", () => {
  it("parses --ask, --json, --model, --endpoint and --workspace, in both --x v and --x=v forms", () => {
    expect(parseHeadlessArgs(["--ask", "make a snake", "--json", "--model", "test-1b", "--endpoint", ENDPOINT, "--workspace", "C:\\tmp\\scratch"]))
      .toEqual({ ask: "make a snake", json: true, model: "test-1b", endpoint: ENDPOINT, workspace: "C:\\tmp\\scratch" });
    expect(parseHeadlessArgs(["--ask=who are you", "--endpoint=http://127.0.0.1:9/v1"]))
      .toEqual({ ask: "who are you", json: false, endpoint: "http://127.0.0.1:9/v1" });
  });

  it("refuses an unknown argument, a missing or empty --ask", () => {
    expect(parseHeadlessArgs(["--wat"])).toHaveProperty("error");
    expect(parseHeadlessArgs([])).toHaveProperty("error");
    expect(parseHeadlessArgs(["--ask", "   "])).toHaveProperty("error");
  });
});

describe("the answer as the CLI holds it", () => {
  it("appends answers, applies take-backs, and a replace stands for the whole answer", () => {
    const ev = (e: ChatEvent) => e;
    expect(answerOf([ev({ id: "t", type: "answer", text: "Hel" }), ev({ id: "t", type: "answer", text: "lo" })])).toBe("Hello");
    expect(answerOf([ev({ id: "t", type: "answer", text: "Hello wor" }), ev({ id: "t", type: "retract", keep: 5 }), ev({ id: "t", type: "answer", text: " there" })])).toBe("Hello there");
    expect(answerOf([ev({ id: "t", type: "answer", text: "draft" }), ev({ id: "t", type: "replace", text: "the final answer" })])).toBe("the final answer");
  });
});

describe("one ask, one answer, one exit", () => {
  it("runs the turn against --endpoint and prints ONE json result on stdout, with the journal named", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-headless-"));
    const events: ChatEvent[] = [];
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      return sse([DELTA("Hello from the model."), STOP]);
    }));
    const theIo = io();
    try {
      const code = await headlessAsk(
        ["--ask", "say hello", "--json", "--model", "test-1b", "--endpoint", ENDPOINT, "--workspace", dir],
        fakeBaseHost(events), theIo,
      );
      expect(code).toBe(0);
      // the request went to the endpoint the flag named, not to the base host's server
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.every((u) => u.startsWith(ENDPOINT))).toBe(true);
      // exactly one line of JSON on stdout, nothing else (protocol-free stdout)
      expect(theIo.outs).toHaveLength(1);
      const result = JSON.parse(theIo.outs[0]) as { outcome: string; answer: string; notices: string[]; model: string; turnId: string; journal: string; stats?: { tokens: number } };
      expect(result.outcome).toBe("done");
      expect(result.answer).toContain("Hello from the model.");
      // no router in CLI mode: the words alone sort the request, and the turn
      // says so honestly — the routing notice is part of the result
      expect(result.notices.some((n) => n.startsWith("Understood as:"))).toBe(true);
      expect(result.model).toBe("test-1b");
      expect(result.turnId).toMatch(/^cli-/);
      expect(result.journal).toBe(path.join(dir, "harness.jsonl"));
      expect(result.stats?.tokens).toBeGreaterThan(0);
      // the journal was written where --workspace named it, and holds the run
      const { entries } = readJournal(result.journal);
      expect(entries.some((e) => e.type === "run")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("in plain mode the stdout carries only the answer; notices and the journal path go to stderr", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-headless-"));
    const events: ChatEvent[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => sse([DELTA("Plain words."), STOP])));
    const theIo = io();
    try {
      const code = await headlessAsk(
        ["--ask", "say hello", "--model", "test-1b", "--endpoint", ENDPOINT, "--workspace", dir],
        fakeBaseHost(events), theIo,
      );
      expect(code).toBe(0);
      expect(theIo.outs.join("")).toContain("Plain words.");
      expect(theIo.outs).toHaveLength(1); // the answer, pipable clean
      expect(theIo.errs.join("")).toContain("journal:");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("without --endpoint it refuses before any turn runs: there is no app host here to start a model server", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const theIo = io();
    const code = await headlessAsk(["--ask", "hi", "--model", "test-1b"], fakeBaseHost([]), theIo);
    expect(code).toBe(1);
    expect(theIo.errs.join("")).toContain("--endpoint");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an unknown --model id is refused with a readable error, before any turn runs", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const theIo = io();
    const code = await headlessAsk(["--ask", "hi", "--model", "no-such-model", "--endpoint", ENDPOINT], fakeBaseHost([]), theIo);
    expect(code).toBe(1);
    expect(theIo.errs.join("")).toContain("no-such-model");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("without --model it falls back to the last loaded model, and asks for --model when there is none", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const theIo = io();
    const none = await headlessAsk(["--ask", "hi", "--endpoint", ENDPOINT], fakeBaseHost([]), theIo);
    expect(none).toBe(1);
    expect(theIo.errs.join("")).toContain("--model");
    expect(fetchSpy).not.toHaveBeenCalled();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-headless-"));
    const events: ChatEvent[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => sse([DELTA("Loaded fallback."), STOP])));
    const theIo2 = io();
    try {
      const code = await headlessAsk(
        ["--ask", "hi", "--json", "--endpoint", ENDPOINT, "--workspace", dir],
        fakeBaseHost(events, { lastLoaded: ENTRY }), theIo2,
      );
      expect(code).toBe(0);
      const result = JSON.parse(theIo2.outs[0]) as { model: string };
      expect(result.model).toBe("test-1b");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a model server failure comes out as the error result with exit 1, the friendly shape", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-headless-"));
    const events: ChatEvent[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    const theIo = io();
    try {
      const code = await headlessAsk(
        ["--ask", "hi", "--json", "--model", "test-1b", "--endpoint", ENDPOINT, "--workspace", dir],
        fakeBaseHost(events), theIo,
      );
      expect(code).toBe(1);
      const result = JSON.parse(theIo.outs[0]) as { outcome: string; error?: { title: string } };
      expect(result.outcome).toBe("error");
      expect(result.error?.title).toBeTruthy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
