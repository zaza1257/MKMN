import { describe, expect, it } from "vitest";
import { BUSY_WINDOWS_MAX, ServerLostError, droppableFields, evaluatedPromptTokens, parseSseData, streamChat } from "../src/core/chat";
import type { ChatEvent } from "../src/shared/types";

/**
 * GenieX 0.11.0 contract, measured on this PC:
 * - `GET /status` lists the models the server holds, each with `state` "loading", "active" or "idle";
 *   a model released by `--keepalive` disappears from it, and the next request loads it again with no
 *   byte sent until the load ends (an 8B NPU model takes 56-97 s here, more than the 45 s window).
 * - `usage.prompt_tokens` counts the WHOLE prompt, KV-cache reuse included; `prompt_tokens_details.cached_tokens`
 *   is the reused part and `timings.prompt_n` what was really evaluated.
 */

const SAFE = { temperature: 0, top_p: 1, max_tokens: 50 };
const sse = (d: object) => `data: ${JSON.stringify(d)}\n\n`;
const drain = async (gen: AsyncGenerator<ChatEvent>) => {
  const evs: ChatEvent[] = [];
  for await (const ev of gen) evs.push(ev);
  return evs;
};

/** A local GenieX that answers nothing for `silentMs` (loading the model), then streams one word. */
function loadingServer(opts: { silentMs: number; status: () => Response | Promise<Response> }) {
  const state = { statusChecks: 0, modelChecks: 0, posts: 0 };
  const enc = new TextEncoder();
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/status")) { state.statusChecks++; return opts.status(); }
    if (u.endsWith("/models")) { state.modelChecks++; return new Response("{}", { status: 200 }); }
    state.posts++;
    return new Response(new ReadableStream<Uint8Array>({
      start(c) {
        setTimeout(() => {
          c.enqueue(enc.encode(sse({ choices: [{ delta: { content: "Hello" } }] })));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        }, opts.silentMs);
      }
    }), { status: 200 });
  }) as unknown as typeof fetch;
  return { state, fetchFn };
}

const statusWith = (state: string) => () => new Response(JSON.stringify({ alive: true, version: "v0.11.0", models: [{ id: "qualcomm/Qwen3-8B:W4A16", state }] }), { status: 200 });

describe("GenieX /status in the no-progress watch", () => {
  it("a model the server is still LOADING is waited for, not declared lost after two silent windows", async () => {
    const { state, fetchFn } = loadingServer({ silentMs: 300, status: statusWith("loading") });
    const evs = await drain(streamChat({ endpoint: "http://127.0.0.1:18181/v1", model: "m", messages: [{ role: "user", content: "hi" }], sampling: SAFE, noProgressSec: 0.05, fetchFn }, "call:load"));
    expect(evs.filter((e) => e.type === "answer").map((e) => (e as { text: string }).text).join("")).toBe("Hello");
    expect(state.statusChecks).toBeGreaterThanOrEqual(2);
    expect(state.posts).toBe(1);
  });

  it("a server whose /status shows nothing at work still fails fast (the old rule stands)", async () => {
    const { fetchFn } = loadingServer({ silentMs: 2000, status: () => new Response(JSON.stringify({ alive: true, models: [] }), { status: 200 }) });
    await expect(drain(streamChat({ endpoint: "http://127.0.0.1:18181/v1", model: "m", messages: [{ role: "user", content: "hi" }], sampling: SAFE, noProgressSec: 0.05, fetchFn }, "call:idle")))
      .rejects.toBeInstanceOf(ServerLostError);
  });

  it("a model busy forever is given up after BUSY_WINDOWS_MAX windows, naming what it was doing", async () => {
    const { fetchFn } = loadingServer({ silentMs: 60_000, status: statusWith("active") });
    const err = await drain(streamChat({ endpoint: "http://127.0.0.1:18181/v1", model: "m", messages: [{ role: "user", content: "hi" }], sampling: SAFE, noProgressSec: 0.02, fetchFn }, "call:busy")).catch((e) => e);
    expect(err).toBeInstanceOf(ServerLostError);
    expect(String(err.message)).toMatch(/active/);
    expect(BUSY_WINDOWS_MAX).toBeGreaterThanOrEqual(4);
  });

  it("a server with no /status (Foundry Local, an older GenieX) keeps the /v1/models rule", async () => {
    const { state, fetchFn } = loadingServer({ silentMs: 2000, status: () => new Response("not found", { status: 404 }) });
    await expect(drain(streamChat({ endpoint: "http://127.0.0.1:5273/v1", model: "m", messages: [{ role: "user", content: "hi" }], sampling: SAFE, noProgressSec: 0.05, fetchFn }, "call:foundry")))
      .rejects.toBeInstanceOf(ServerLostError);
    expect(state.modelChecks).toBeGreaterThanOrEqual(1);
  });

  it("a cloud endpoint is never asked for /status", async () => {
    const { state, fetchFn } = loadingServer({ silentMs: 2000, status: statusWith("loading") });
    await expect(drain(streamChat({ endpoint: "https://api.example.com/v1", model: "m", messages: [{ role: "user", content: "hi" }], sampling: SAFE, noProgressSec: 0.05, fetchFn }, "call:cloud")))
      .rejects.toBeInstanceOf(ServerLostError);
    expect(state.statusChecks).toBe(0);
  });
});

describe("a GenieX execution error is not a refused field (GenieX #1611, 0.10.0)", () => {
  const body = { enable_think: false, chat_template_kwargs: { enable_thinking: false }, presence_penalty: 1.5, response_format: { type: "json_object" }, top_p: 0.9 };

  it("a picture GenieX cannot load (400 with its SDK code) drops no field", () => {
    expect(droppableFields('{"error":"invalid image: failed to decode the image","code":-201001}', body)).toEqual([]);
    expect(droppableFields('{"error":"Invalid input","code":-100004}', body)).toEqual([]);
  });

  it("a server that refuses a field it names still loses that field (Foundry Local)", () => {
    expect(droppableFields("Unsupported parameter: presence_penalty", body)).toEqual(["presence_penalty"]);
    // a refusal that names no field, from a server with no SDK error code: the optional fields go, as before
    expect(droppableFields("unsupported parameter", body).length).toBeGreaterThan(0);
  });
});

describe("GenieX 0.11.0 usage: total versus evaluated prompt tokens", () => {
  const chunk = '{"choices":[],"usage":{"completion_tokens":2,"prompt_tokens":15,"prompt_tokens_details":{"cached_tokens":14}},"timings":{"prompt_n":1,"prompt_ms":40}}';

  it("reads the cached part and what was evaluated from the final chunk", () => {
    const p = parseSseData(chunk)!;
    expect(p.promptTokens).toBe(15);
    expect(p.cachedTokens).toBe(14);
    expect(p.promptEvaluated).toBe(1);
  });

  it("a prefill rate is measured on the evaluated tokens, never on the reused ones", () => {
    expect(evaluatedPromptTokens({ promptTokens: 15, promptEvaluated: 1 })).toBe(1);
    expect(evaluatedPromptTokens({ promptTokens: 15, cachedTokens: 14 })).toBe(1);
    expect(evaluatedPromptTokens({ promptTokens: 900 })).toBe(900);
    expect(evaluatedPromptTokens({})).toBeUndefined();
  });

  it("the stream's stats carry the evaluated count", async () => {
    const enc = new TextEncoder();
    const fetchFn = (async () => new Response(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(sse({ choices: [{ delta: { content: "Hi" } }] })));
        c.enqueue(enc.encode(`data: ${chunk}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      }
    }), { status: 200 })) as unknown as typeof fetch;
    const evs = await drain(streamChat({ endpoint: "http://127.0.0.1:18181/v1", model: "m", messages: [{ role: "user", content: "hi" }], sampling: SAFE, fetchFn }, "call:usage"));
    const done = evs.find((e) => e.type === "done") as { stats: { promptTokens?: number; promptEvaluated?: number; cachedTokens?: number } };
    expect(done.stats.promptTokens).toBe(15);
    expect(done.stats.promptEvaluated).toBe(1);
    expect(done.stats.cachedTokens).toBe(14);
  });
});
