import { describe, expect, it } from "vitest";
import { Gateway, GatewayJsonError, GatewayLimitError, DEFAULT_NO_PROGRESS_SEC } from "../src/core/harness/gateway";
import { IDENTITY_INSTRUCTIONS } from "../src/core/harness/identity";
import { sObject, sString, sNumber, sOptional, sArray } from "../src/core/harness/schema";
import type { ChatEvent } from "../src/shared/types";

const SAFE = { temperature: 0, top_p: 1, max_tokens: 50 };
const sse = (d: object) => `data: ${JSON.stringify(d)}\n\n`;
const answerChunks = (...parts: string[]) => [
  ...parts.map((p) => sse({ choices: [{ delta: { content: p } }] })),
  sse({ choices: [{ delta: { content: "" } }], usage: { prompt_tokens: 12, completion_tokens: 7 } }),
  "data: [DONE]\n\n",
];

/**
 * A fake server: every POST to /chat/completions is handed the next scripted
 * attempt (the last one is reused), and what was asked is recorded.
 */
function fakeServer() {
  const state = {
    up: true,
    attempts: [] as { chunks: string[]; hang?: boolean }[],
    posts: [] as Record<string, unknown>[],
  };
  const enc = new TextEncoder();
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/models")) {
      if (!state.up) throw new Error("fetch failed"); // what undici says when nothing listens
      return new Response("{}", { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const a = state.attempts[Math.min(state.posts.length, state.attempts.length - 1)];
    state.posts.push(body);
    return new Response(new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of a.chunks) c.enqueue(enc.encode(s));
        if (!a.hang) c.close();
      },
    }), { status: 200 });
  }) as unknown as typeof fetch;
  return { state, fetchFn };
}

const call = (fetchFn: typeof fetch, over: Partial<Parameters<Gateway["ask"]>[0]> = {}) => ({
  endpoint: "http://x/v1",
  model: "m",
  messages: [{ role: "user" as const, content: "hi" }],
  sampling: SAFE,
  fetchFn,
  ...over,
});

const drain = async (gen: AsyncGenerator<ChatEvent>) => {
  const evs: ChatEvent[] = [];
  for await (const ev of gen) evs.push(ev);
  return evs;
};

describe("the model gateway", () => {
  it("one ask: the identity rides first on the system prompt, the answer is folded, the usage is charged", async () => {
    const { state, fetchFn } = fakeServer();
    state.attempts = [{ chunks: answerChunks("Hello there!") }];
    const gw = new Gateway();
    const a = await gw.ask(call(fetchFn, {
      messages: [{ role: "user", content: "hi" }],
    }));
    expect(a.text).toBe("Hello there!");
    expect(a.usage).toEqual({ prompt: 12, output: 7, measured: true });
    expect(gw.calls).toBe(1);
    expect(gw.outputTokens).toBe(7);
  });

  it("a stream stopped before its end still charges what it wrote (an estimate)", async () => {
    const { state, fetchFn } = fakeServer();
    state.attempts = [{ chunks: [sse({ choices: [{ delta: { content: "x".repeat(36) } }] })], hang: true }];
    const gw = new Gateway();
    for await (const ev of gw.stream(call(fetchFn))) if (ev.type === "answer") break;
    expect(gw.outputTokens).toBe(10);
  });

  it("an existing system prompt keeps its words and gains the identity block once, never twice", async () => {
    const { state, fetchFn } = fakeServer();
    state.attempts = [{ chunks: answerChunks("ok") }];
    const gw = new Gateway();
    const sys = "You follow these rules.";
    await gw.ask(call(fetchFn, { messages: [{ role: "system", content: sys }, { role: "user", content: "hi" }] }));
    const sysSent = String((state.posts[0].messages as { role: string; content: string }[]).find((m) => m.role === "system")!.content);
    expect(sysSent).toContain(sys);
    expect(sysSent).toContain(IDENTITY_INSTRUCTIONS.split("\n")[0]);
    await gw.ask(call(fetchFn, { messages: [{ role: "system", content: sysSent }, { role: "user", content: "hi" }] }));
    const sysSent2 = String((state.posts[1].messages as { role: string; content: string }[]).find((m) => m.role === "system")!.content);
    expect(sysSent2).toBe(sysSent); // idempotent: the block is never doubled
  });

  it("a call that declines the identity gets its prompt untouched", async () => {
    const { state, fetchFn } = fakeServer();
    state.attempts = [{ chunks: answerChunks("ok") }];
    const gw = new Gateway();
    await gw.ask(call(fetchFn, { identity: false, messages: [{ role: "system", content: "minimal" }, { role: "user", content: "hi" }] }));
    const sysSent = (state.posts[0].messages as { role: string; content: string }[]).find((m) => m.role === "system")!.content;
    expect(sysSent).toBe("minimal");
  });

  it("the call limit refuses the next call before anything is sent", async () => {
    const { state, fetchFn } = fakeServer();
    state.attempts = [{ chunks: answerChunks("ok") }];
    const gw = new Gateway({ maxCalls: 1 });
    await gw.ask(call(fetchFn));
    await expect(gw.ask(call(fetchFn))).rejects.toThrow(GatewayLimitError);
    expect(state.posts.length).toBe(1);
  });

  it("the output-token limit: the call that crosses it is delivered, the next one is refused", async () => {
    const { state, fetchFn } = fakeServer();
    state.attempts = [{ chunks: answerChunks("ok") }];
    const gw = new Gateway({ maxOutputTokens: 7 });
    const a = await gw.ask(call(fetchFn));
    expect(a.text).toBe("ok");
    await expect(gw.ask(call(fetchFn))).rejects.toThrow(/output-token limit/);
    expect(state.posts.length).toBe(1);
  });

  it("a stalled call is health-probed, recovered once through the caller's callback, and asked again", async () => {
    const { state, fetchFn } = fakeServer();
    state.attempts = [
      { chunks: [sse({ choices: [{ delta: { content: "Hel" } }] }), sse({ choices: [{ delta: { content: "lo" } }] })], hang: true },
      { chunks: answerChunks("Hello there!") },
    ];
    state.up = false; // when the stall is noticed, the server is gone
    let recoveries = 0;
    const recover = async () => { recoveries++; state.up = true; return true; };
    const gw = new Gateway();
    const a = await gw.ask(call(fetchFn, { noProgressSec: 0.05, recover }));
    expect(recoveries).toBe(1);
    expect(state.posts.length).toBe(2);
    expect(a.text).toBe("Hello there!");
    expect(DEFAULT_NO_PROGRESS_SEC).toBe(45);
  });

  it("stream forwards the events and charges the usage at the done event", async () => {
    const { state, fetchFn } = fakeServer();
    state.attempts = [{ chunks: answerChunks("Hello there!") }];
    const gw = new Gateway();
    const evs = await drain(gw.stream(call(fetchFn)));
    expect(evs.some((e) => e.type === "answer")).toBe(true);
    expect(evs[evs.length - 1].type).toBe("done");
    expect(gw.outputTokens).toBe(7);
  });

  describe("askJson: the output ladder", () => {
    const schema = sObject("plan", {
      title: sString({ minLength: 1 }),
      count: sNumber({ int: true, min: 1 }),
    });
    const jsonReply = (v: unknown) => answerChunks("```json\n" + JSON.stringify(v) + "\n```");

    it("rung 1: the shape is asked for in the request and the answer parses on the first rung", async () => {
      const { state, fetchFn } = fakeServer();
      state.attempts = [{ chunks: jsonReply({ title: "a plan", count: 3 }) }];
      const gw = new Gateway();
      const out = await gw.askJson({ ...call(fetchFn), schema, schemaName: "plan" });
      expect(out).toEqual({ title: "a plan", count: 3 });
      const rf = state.posts[0].response_format as Record<string, unknown>;
      expect(rf.type).toBe("json_schema");
      const inner = rf.json_schema as Record<string, unknown>;
      expect(inner.name).toBe("plan");
      expect(inner.schema).toEqual({
        type: "object",
        properties: { title: { type: "string", minLength: 1 }, count: { type: "integer", minimum: 1 } },
        required: ["title", "count"],
        additionalProperties: false,
      });
      expect(gw.calls).toBe(1);
    });

    it("an optional field is left out of required, so the shape stays honest", async () => {
      const { state, fetchFn } = fakeServer();
      state.attempts = [{ chunks: jsonReply({ title: "a plan", note: "hi", count: 2 }) }];
      const gw = new Gateway();
      const sch = sObject("plan", { title: sString(), note: sOptional(sString()), count: sNumber() });
      await gw.askJson({ ...call(fetchFn), schema: sch });
      const inner = (state.posts[0].response_format as Record<string, unknown>).json_schema as Record<string, unknown>;
      expect((inner.schema as Record<string, unknown>).required).toEqual(["title", "count"]);
    });

    it("rung 2: a reply the shape rejects is asked again plain, and a truncated JSON is repaired", async () => {
      const { state, fetchFn } = fakeServer();
      state.attempts = [
        { chunks: answerChunks('{"title": "wro') }, // cut mid-value under response_format
        { chunks: answerChunks('{"title": "right", "count": 5, }') }, // trailing comma: repairable
      ];
      const gw = new Gateway();
      const out = await gw.askJson({ ...call(fetchFn), schema });
      expect(out).toEqual({ title: "right", count: 5 });
      expect(state.posts.length).toBe(2);
      expect(state.posts[1].response_format).toBeUndefined();
      expect(gw.calls).toBe(2);
    });

    it("rung 3: a flat object still arrives as field: value lines", async () => {
      const { state, fetchFn } = fakeServer();
      state.attempts = [
        { chunks: answerChunks("I cannot do that.") },
        { chunks: answerChunks("still no json here") },
        { chunks: answerChunks("title: A fine plan\ncount: 4\nextra: ignored") },
      ];
      const gw = new Gateway();
      const out = await gw.askJson({ ...call(fetchFn), schema });
      expect(out).toEqual({ title: "A fine plan", count: 4 });
      expect(gw.calls).toBe(3);
    });

    it("every rung spent and nothing matched: the error names the faults, and the calls were charged", async () => {
      const { state, fetchFn } = fakeServer();
      state.attempts = [{ chunks: answerChunks("no") }];
      const gw = new Gateway();
      await expect(gw.askJson({ ...call(fetchFn), schema })).rejects.toThrow(GatewayJsonError);
      expect(gw.calls).toBe(3);
      expect(gw.outputTokens).toBeGreaterThan(0);
    });

    it("a nested shape stops at rung 2: lines cannot carry a nested object", async () => {
      const { state, fetchFn } = fakeServer();
      state.attempts = [
        { chunks: answerChunks("no") },
        { chunks: answerChunks("no") },
      ];
      const gw = new Gateway();
      const nested = sObject("plan", { items: sArray(sString()) });
      await expect(gw.askJson({ ...call(fetchFn), schema: nested })).rejects.toThrow(GatewayJsonError);
      expect(gw.calls).toBe(2);
    });
  });
});
