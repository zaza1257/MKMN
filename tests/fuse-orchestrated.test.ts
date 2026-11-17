import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent, HardwareProfile, Settings } from "../src/shared/types";
import { runChatOrchestrator, type ChatHost } from "../src/core/chatOrchestrator";
import { CLOUD_CHAT_ID, FUSE_ENDPOINT, fuseEntry, fuseServed } from "../src/core/cloudChat";
import { registerEndpointAuth } from "../src/core/chat";

/**
 * Chat on HUMAIN Fuse used a path of its own that skipped the app's pipeline (files, builds,
 * checked charts, knowledge, the turn budget). It now runs through the orchestrator, with Fuse
 * served as an OpenAI-compatible endpoint: the same turn machinery, the key on every request.
 */

const HW: HardwareProfile = { chipName: "Test", chipFamily: "x2", isSnapdragon: true, ramGB: 16, npuDetected: true, npuDriverVersion: "1", npuBudgetGB: 8 };
const SETTINGS = { webSearch: false, wikimediaImages: false, agentLoop: false, autoCheck: false, effort: null, subagents: false, humainFuseEffort: "low" } as unknown as Settings;

const sse = (chunks: object[]) => new Response(new ReadableStream({
  start(c) { for (const l of [...chunks.map((x) => `data: ${JSON.stringify(x)}`), "data: [DONE]", ""]) c.enqueue(new TextEncoder().encode(`${l}\n\n`)); c.close(); }
}), { status: 200 });

afterEach(() => { vi.unstubAllGlobals(); registerEndpointAuth(FUSE_ENDPOINT, null); });

describe("a chat on HUMAIN Fuse runs through the orchestrator", () => {
  it("answers through the turn machinery, with the key, the Fuse model and the Fuse effort on the request", async () => {
    const entry = fuseEntry("moonshotai/Kimi-K3", 1_048_576);
    const started: string[] = [];
    const host = {
      settings: () => SETTINGS, patchSettings: () => {},
      allEntries: () => [entry], entryById: (id: string) => (id === CLOUD_CHAT_ID ? entry : undefined),
      installedEntries: async () => [], chatHardware: async () => HW,
      lastLoaded: () => null, setLastLoaded: () => {}, benchRunning: () => false,
      ensureServer: async (e: any) => { started.push(e.id); return fuseServed({ model: "moonshotai/Kimi-K3", key: "sk-test", maxModelLen: 1_048_576, effort: "low" }); },
      servedName: (e: any) => e.repo,
      send: (ev: ChatEvent) => events.push(ev),
      recordSpeed: () => {}, folderOf: () => null, figure: async () => null,
      lookAtShot: async () => null, checkArtifact: async () => ({ ran: "none", errors: [] }),
      harnessJournalFile: () => null,
    } as unknown as ChatHost;
    const events: ChatEvent[] = [];
    const posts: { url: string; auth?: string; body: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (String(url).endsWith("/chat/completions")) posts.push({ url: String(url), auth: h.Authorization, body: JSON.parse(String(init!.body)) });
      return sse([{ choices: [{ delta: { content: "Hello from Fuse." } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 4, prompt_tokens: 9 } }]);
    }));
    await runChatOrchestrator(host, "f-1", CLOUD_CHAT_ID, [{ role: "user", content: "Say hello." }], { effort: null, subagents: false } as any);

    expect(started).toContain(CLOUD_CHAT_ID);
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) {
      expect(p.url).toBe(`${FUSE_ENDPOINT}/chat/completions`);
      expect(p.auth).toBe("Bearer sk-test");
      expect(p.body.model).toBe("moonshotai/Kimi-K3");
    }
    expect(posts.at(-1)!.body.reasoning_effort).toBe("low");
    expect(events.filter((e) => e.type === "answer").map((e: any) => e.text).join("")).toContain("Hello from Fuse.");
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.some((e) => e.type === "run")).toBe(true); // the turn's run: the harness drew it
  });
});
