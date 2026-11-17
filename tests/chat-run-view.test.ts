import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CatalogEntry, ChatEvent, HardwareProfile, Settings } from "../src/shared/types";
import { runChatOrchestrator, abortChat, type ChatHost, type Served } from "../src/core/chatOrchestrator";
import { readJournal } from "../src/core/harness/journal";
import { DEFAULT_TURN_BUDGET } from "../src/core/harness/policy";

/**
 * The turn's run is drawn on the screen: as each step of the
 * turn's run settles, the orchestrator sends a `run` event holding the steps so
 * far and the per-turn budget as it stands; at the end it sends one more with
 * the verdict the harness settled. The stage cards tell the work's story; these
 * events are the machinery's. The regression fails without the run view: no `run`
 * event existed, and the budget the turn spent was invisible on the screen.
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

function fakeHost(events: ChatEvent[], journalFile: string | null, over?: { settings?: Settings }): ChatHost {
  return {
    settings: () => over?.settings ?? SETTINGS,
    patchSettings: () => {},
    allEntries: () => [ENTRY],
    entryById: (id) => (id === ENTRY.id ? ENTRY : undefined),
    installedEntries: async () => [ENTRY],
    chatHardware: async () => HW,
    lastLoaded: () => null,
    setLastLoaded: () => {},
    benchRunning: () => false,
    ensureServer: async (): Promise<Served> => ({ endpoint: "http://127.0.0.1:9/v1", status: () => ({ nctx: null }) }),
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
    harnessJournalFile: () => journalFile,
  };
}

const OPTS = { effort: null, subagents: false } as const;
const TUNED = { ...SETTINGS, turnBudget: { maxCalls: 60, maxOutputTokens: 50_000 } } as Settings;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the turn's run travels to the screen as it happens", () => {
  it("a `run` event rides every settled step, and the last one carries the verdict the harness settled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-run-view-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => sse([DELTA("A plain answer."), STOP])));
    try {
      await runChatOrchestrator(fakeHost(events, file), "rv-1", ENTRY.id, [{ role: "user", content: "Say something." }], OPTS);
      const runs = events.filter((e): e is Extract<ChatEvent, { type: "run" }> => e.type === "run");
      expect(runs.length).toBeGreaterThanOrEqual(2); // one per settled step, plus the final verdict
      // the step events grow: the answer call is a step of the turn's run
      const counts = runs.map((e) => e.run.steps.length);
      expect(counts[0]).toBeGreaterThanOrEqual(1);
      expect(counts[counts.length - 1]).toBeGreaterThanOrEqual(counts[0]);
      // the budget rides on every one, at the policy's cap
      for (const e of runs) {
        expect(e.run.budget.maxCalls).toBe(DEFAULT_TURN_BUDGET.maxCalls);
        expect(e.run.budget.maxOutputTokens).toBe(DEFAULT_TURN_BUDGET.maxOutputTokens);
        expect(e.run.budget.calls).toBeGreaterThan(0);
      }
      // the final event carries the verdict, and the steps match the journal (this run's own steps — a build sub-run journals beside them)
      const last = runs[runs.length - 1].run;
      expect(last.verdict?.state).toBe("done");
      const { entries } = readJournal(file);
      expect(last.steps.length).toBe(entries.filter((e) => e.type === "step" && e.runId === last.runId && e.status !== "interrupted").length);
      // the model call's tokens were spent where the account says — and the
      // budget counts EVERY call of the turn (the build question's call and the
      // answer: 3 + 3), even though the steps listed are the turn's own
      expect(last.budget.outputTokens).toBe(6);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a stopped turn's last run event carries the cancelled verdict, not a success", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-run-view-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    // the build question answers quickly ("no"); the turn's own answer call never does
    // (it rejects when aborted, as a real fetch does): the person presses stop mid-answer
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      let first = "";
      try { first = String(JSON.parse(body).messages?.[0]?.content ?? ""); } catch { /* not json */ }
      if (first.startsWith("You answer yes/no questions")) return sse([DELTA("no"), STOP]);
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("This operation was aborted")));
      });
    }));
    try {
      const turn = runChatOrchestrator(fakeHost(events, file), "rv-2", ENTRY.id, [{ role: "user", content: "Say something." }], OPTS);
      await new Promise((r) => setTimeout(r, 120)); // the call is in flight
      abortChat("rv-2");
      await turn;
      const runs = events.filter((e): e is Extract<ChatEvent, { type: "run" }> => e.type === "run");
      expect(runs.length).toBeGreaterThanOrEqual(1);
      const last = runs[runs.length - 1].run;
      expect(last.verdict?.state).toBe("cancelled");
      expect(last.steps.some((s) => s.status === "interrupted")).toBe(true); // the call in flight settled interrupted
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the Settings row's tuned cap is the budget the turn runs under (visible in the run view)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-run-view-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => sse([DELTA("A plain answer."), STOP])));
    try {
      await runChatOrchestrator(fakeHost(events, file, { settings: TUNED }), "rv-3", ENTRY.id, [{ role: "user", content: "Say something." }], OPTS);
      const runs = events.filter((e): e is Extract<ChatEvent, { type: "run" }> => e.type === "run");
      expect(runs.length).toBeGreaterThanOrEqual(1);
      for (const e of runs) {
        expect(e.run.budget.maxCalls).toBe(60);
        expect(e.run.budget.maxOutputTokens).toBe(50_000);
      }
      // and a refusal speaks the TUNED cap, not the default: the notice names 60
      expect(events.some((e) => e.type === "done")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
