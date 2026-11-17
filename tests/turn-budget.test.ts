import { describe, expect, it } from "vitest";
import { Gateway, GatewayLimitError } from "../src/core/harness/gateway";
import { openTurnBudget, closeTurnBudget, turnBudgetOf, TURN_BUDGET } from "../src/core/harness/turn";
import type { ChatEvent } from "../src/shared/types";

/**
 * The per-turn budget:
 * ONE cap on ALL model calls a user-visible turn makes, summed across every
 * run it spawns — the main answer, the fold, the reviewer, the locator, the
 * sub-agents, the build sub-runs. Today every model call constructs a fresh
 * `new Gateway()` whose limits are empty, so nothing is ever budgeted; the
 * turn account is the first real wiring of the gateway's refusal machinery.
 * Every call inside the turn carries an id whose first segment is the turn's
 * id (`<turnId>:agent:2`, `<turnId>:know`), so the account is found the same
 * way the journal scope is (src/core/harness/current.ts). The tiny router
 * calls (0.6B on the CPU, id `router:...`) are NOT the NPU budget and stay
 * outside the account; a background compaction that keeps running after the
 * turn closed its account is uncounted too (it is stopped at the next turn's
 * start).
 */

const SAFE = { temperature: 0, top_p: 1, max_tokens: 50 };
const sse = (d: object) => `data: ${JSON.stringify(d)}\n\n`;
const answerChunks = (...parts: string[]) => [
  ...parts.map((p) => sse({ choices: [{ delta: { content: p } }] })),
  sse({ choices: [{ delta: { content: "" } }], usage: { prompt_tokens: 12, completion_tokens: 7 } }),
  "data: [DONE]\n\n",
];

function fakeServer() {
  const state = { posts: [] as Record<string, unknown>[] };
  const enc = new TextEncoder();
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return new Response("{}", { status: 200 });
    state.posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(new ReadableStream<Uint8Array>({
      start(c) { for (const s of answerChunks("ok")) c.enqueue(enc.encode(s)); c.close(); },
    }), { status: 200 });
  }) as unknown as typeof fetch;
  return { state, fetchFn };
}

const call = (fetchFn: typeof fetch, id: string, over: Partial<Parameters<Gateway["ask"]>[0]> = {}) => ({
  endpoint: "http://x/v1",
  model: "m",
  messages: [{ role: "user" as const, content: "hi" }],
  sampling: SAFE,
  fetchFn,
  id,
  ...over,
});

const drain = async (gen: AsyncGenerator<ChatEvent>) => { for await (const _ of gen) void _; };

describe("the per-turn budget: one account over every call the turn makes", () => {
  it("the default cap exists, measured headroom named in the constant", () => {
    expect(TURN_BUDGET.maxCalls).toBeGreaterThanOrEqual(100);
    expect(TURN_BUDGET.maxOutputTokens).toBeGreaterThanOrEqual(50_000);
  });

  it("calls from separate Gateway instances of one turn land in the ONE account", async () => {
    const { fetchFn } = fakeServer();
    openTurnBudget("t1", {});
    try {
      // the main answer, a locator, a sub-agent: three separate Gateways, one turn
      await new Gateway().ask(call(fetchFn, "t1"));
      await new Gateway().ask(call(fetchFn, "t1:know"));
      await new Gateway().ask(call(fetchFn, "t1:agent:2"));
      const b = turnBudgetOf("t1:agent:2")!;
      expect(b.calls).toBe(3);
      expect(b.outputTokens).toBe(21); // 3 calls × 7 output tokens charged
    } finally { closeTurnBudget("t1"); }
    expect(turnBudgetOf("t1:anything")).toBeUndefined();
  });

  it("streamed calls are charged too", async () => {
    const { fetchFn } = fakeServer();
    openTurnBudget("t2", {});
    try {
      await drain(new Gateway().stream(call(fetchFn, "t2")));
      expect(turnBudgetOf("t2")!.calls).toBe(1);
      expect(turnBudgetOf("t2")!.outputTokens).toBe(7);
    } finally { closeTurnBudget("t2"); }
  });

  it("the cap refuses the next call BEFORE it is sent, across every gateway of the turn", async () => {
    const { state, fetchFn } = fakeServer();
    openTurnBudget("t3", { maxCalls: 2 });
    try {
      await new Gateway().ask(call(fetchFn, "t3"));
      await new Gateway().ask(call(fetchFn, "t3:agent:1"));
      expect(state.posts.length).toBe(2);
      await expect(new Gateway().ask(call(fetchFn, "t3:build"))).rejects.toBeInstanceOf(GatewayLimitError);
      expect(state.posts.length).toBe(2); // nothing left the machine for the refused call
    } finally { closeTurnBudget("t3"); }
  });

  it("the output-token cap lands on the next call, after the paid one is delivered", async () => {
    const { state, fetchFn } = fakeServer();
    openTurnBudget("t4", { maxOutputTokens: 7 });
    try {
      const a = await new Gateway().ask(call(fetchFn, "t4")); // spends 7
      expect(a.text).toBe("ok"); // the paid call is delivered in full
      await expect(new Gateway().ask(call(fetchFn, "t4"))).rejects.toThrow(/output-token/);
      expect(state.posts.length).toBe(1);
    } finally { closeTurnBudget("t4"); }
  });

  it("the router's tiny CPU calls (id router:...) stay outside the account", async () => {
    const { fetchFn } = fakeServer();
    openTurnBudget("t5", { maxCalls: 1 });
    try {
      // the router vote is refused-free even after the turn's own call burned the cap
      await new Gateway().ask(call(fetchFn, "t5"));
      const r = await new Gateway().ask(call(fetchFn, "router:123"));
      expect(r.text).toBe("ok");
      expect(turnBudgetOf("t5")!.calls).toBe(1);
    } finally { closeTurnBudget("t5"); }
  });

  it("a call from outside every turn (bench, a bare collect) finds no account and is unlimited", async () => {
    const { fetchFn } = fakeServer();
    const a = await new Gateway().ask(call(fetchFn, "bench-xyz"));
    expect(a.text).toBe("ok");
  });
});
