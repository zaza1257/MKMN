import { describe, expect, it } from "vitest";
import { ServerLostError, streamChat, streamComplete, withAnswer } from "../src/core/chat";
import type { ChatEvent } from "../src/shared/types";

const SAFE = { temperature: 0, top_p: 1, max_tokens: 50 };
const sse = (d: object) => `data: ${JSON.stringify(d)}\n\n`;

/**
 * A fake server that can be killed and brought back: `up` decides what /v1/models answers,
 * and every chat request is handed the next scripted attempt (`attempts`; the last one is
 * reused when more requests come). An attempt with `hang` streams its chunks and then goes
 * silent forever (a server that hung); one without closes the stream when its chunks are out.
 */
function fakeServer() {
  const state = {
    up: true,
    attempts: [] as { chunks: string[]; hang?: boolean }[],
    posts: 0,
    healthChecks: 0,
    recoveries: 0
  };
  const enc = new TextEncoder();
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/models")) {
      state.healthChecks++;
      if (!state.up) throw new Error("fetch failed"); // what undici says when nothing listens
      return new Response("{}", { status: 200 });
    }
    const a = state.attempts[Math.min(state.posts, state.attempts.length - 1)];
    state.posts++;
    return new Response(new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of a.chunks) c.enqueue(enc.encode(s));
        if (!a.hang) c.close();
      }
    }), { status: 200 });
  }) as unknown as typeof fetch;
  return { state, fetchFn };
}

const drain = async (gen: AsyncGenerator<ChatEvent>) => {
  const evs: ChatEvent[] = [];
  for await (const ev of gen) evs.push(ev);
  return evs;
};

describe("the fail-fast client (a server that stops serving mid-call)", () => {
  it("restarts the server once, asks the call again, and never writes the dead attempt's words twice", async () => {
    const { state, fetchFn } = fakeServer();
    state.attempts = [
      { chunks: [sse({ choices: [{ delta: { content: "Hel" } }] }), sse({ choices: [{ delta: { content: "lo" } }] })], hang: true }, // streams two words, then hangs
      { chunks: [sse({ choices: [{ delta: { content: "Hello there!" } }] }), "data: [DONE]\n\n"] }
    ];
    state.up = false; // when the stall is noticed, the server is gone
    const recover = async () => { state.recoveries++; state.up = true; return true; };
    const evs = await drain(streamChat({ endpoint: "http://x/v1", model: "m", messages: [{ role: "user", content: "hi" }], sampling: SAFE, noProgressSec: 0.05, recover, fetchFn }, "call:1"));
    expect(state.recoveries).toBe(1);
    expect(state.posts).toBe(2);
    // the dead attempt's partial answer is taken back, and the retry's answer is the whole text
    expect(evs.some((e) => e.type === "retract" && (e as { keep: number }).keep === 0)).toBe(true);
    expect(evs.filter((e) => e.type === "done")).toHaveLength(1);
    expect(evs.reduce(withAnswer, "")).toBe("Hello there!");
    expect(evs.some((e) => e.type === "notice" && /Restarting it before retrying/.test(e.text))).toBe(true);
  });

  it("fails the call, naming it, when the retry fails too — and recovers at most once", async () => {
    const { state, fetchFn } = fakeServer();
    state.attempts = [{ chunks: [sse({ choices: [{ delta: { content: "He" } }] })], hang: true }]; // every attempt: one word, then silence
    state.up = false; // the server never comes back
    const recover = async () => { state.recoveries++; return true; };
    let err: Error | null = null;
    try {
      await drain(streamChat({ endpoint: "http://x/v1", model: "m", messages: [{ role: "user", content: "hi" }], sampling: SAFE, noProgressSec: 0.05, recover, fetchFn }, "x:0:Wiring:1"));
    } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(ServerLostError);
    expect(err!.message).toMatch(/x:0:Wiring:1/);
    // the health-check detail rides along, so the failure is diagnosable — and the "server is
    // down" wording is what the build's own two-failed-sessions rule counts
    expect(err!.message).toMatch(/fetch failed/);
    expect(state.recoveries).toBe(1);
    expect(state.posts).toBe(2); // the call itself was retried exactly once, then given up
  });

  it("without a recovery, a stalled call still fails fast and names the call", async () => {
    const { state, fetchFn } = fakeServer();
    state.attempts = [{ chunks: [sse({ choices: [{ delta: { content: "He" } }] })], hang: true }];
    state.up = false;
    await expect(drain(streamChat({ endpoint: "http://x/v1", model: "m", messages: [{ role: "user", content: "hi" }], sampling: SAFE, noProgressSec: 0.05, fetchFn }, "i:1"))).rejects.toThrow(/the model call i:1 failed/);
    expect(state.posts).toBe(1);
  });

  it("a server that answers /v1/models but never streams gets one more window, then one recovery saves the call", async () => {
    const { state, fetchFn } = fakeServer();
    state.attempts = [
      { chunks: [], hang: true }, // the request is taken, then nothing — the hang the acceptance runs saw
      { chunks: [sse({ choices: [{ delta: { content: "Back." } }] }), "data: [DONE]\n\n"] }
    ];
    state.up = true; // the health check keeps answering: up, not serving
    const recover = async () => { state.recoveries++; return true; };
    const evs = await drain(streamChat({ endpoint: "http://x/v1", model: "m", messages: [{ role: "user", content: "hi" }], sampling: SAFE, noProgressSec: 0.05, recover, fetchFn }, "call:2"));
    expect(state.recoveries).toBe(1);
    expect(state.healthChecks).toBe(2); // probed once, given one more window, probed again, then given up
    expect(evs.reduce(withAnswer, "")).toBe("Back.");
    expect(evs.filter((e) => e.type === "done")).toHaveLength(1);
  }, 15000);

  it("a stream that keeps sending is never interrupted (the window resets on every word)", async () => {
    const enc = new TextEncoder();
    let sent = 0;
    const slow = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (sent >= 5) { c.close(); return; }
        await new Promise((r) => setTimeout(r, 20)); // well under the window
        sent++;
        c.enqueue(enc.encode(sse({ choices: [{ delta: { content: "word " } }] })));
      }
    });
    const recoveries: number[] = [];
    const fetchFn = (async () => new Response(slow, { status: 200 })) as unknown as typeof fetch;
    const evs = await drain(streamChat({ endpoint: "http://x/v1", model: "m", messages: [{ role: "user", content: "hi" }], sampling: SAFE, noProgressSec: 0.1, recover: async () => { recoveries.push(1); return true; }, fetchFn }, "i"));
    expect(recoveries).toHaveLength(0);
    expect(evs.reduce(withAnswer, "")).toBe("word word word word word ");
    expect(evs.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("through streamComplete, the retry replaces the dead attempt's answer instead of appending to it", async () => {
    const { state, fetchFn } = fakeServer();
    state.attempts = [
      { chunks: [sse({ choices: [{ delta: { content: "Partial wor" } }] })], hang: true }, // hangs mid-answer
      { chunks: [sse({ choices: [{ delta: { content: "The real answer." } }] }), "data: [DONE]\n\n"] }
    ];
    state.up = false;
    const recover = async () => { state.recoveries++; state.up = true; return true; };
    const evs = await drain(streamComplete({ endpoint: "http://x/v1", model: "m", messages: [{ role: "user", content: "hi" }], sampling: SAFE, nctx: 4096, noProgressSec: 0.05, recover, fetchFn }, "i"));
    expect(evs.filter((e) => e.type === "done")).toHaveLength(1);
    expect(evs.reduce(withAnswer, "")).toBe("The real answer.");
    expect(state.recoveries).toBe(1);
  });
});
