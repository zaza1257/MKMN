import { afterEach, describe, expect, it } from "vitest";
import { registerEndpointAuth, streamChat } from "../src/core/chat";

const FUSE = "https://api.fuse.humainaic.com/v1";

function sse(...chunks: string[]): Response {
  const body = chunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

afterEach(() => registerEndpointAuth(FUSE, null));

describe("a cloud endpoint's key and defaults ride every request to it", () => {
  it("adds the key header and the provider's default field, and the request's own field wins", async () => {
    const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null });
      return sse(JSON.stringify({ choices: [{ delta: { content: "hi" } }] }));
    }) as unknown as typeof fetch;
    registerEndpointAuth(FUSE, { headers: { Authorization: "Bearer sk-test" }, body: { reasoning_effort: "low", seed: 1 } });
    for await (const _ of streamChat({ endpoint: FUSE, model: "m", messages: [{ role: "user", content: "x" }], sampling: {}, fetchFn, body: { seed: 7 } } as any, "t")) { /* drain */ }
    const post = seen.find((s) => s.url.endsWith("/chat/completions"))!;
    expect(post.headers.Authorization).toBe("Bearer sk-test");
    expect(post.body.reasoning_effort).toBe("low");
    expect(post.body.seed).toBe(7);
  });

  it("never sends the key to another endpoint", async () => {
    const seen: Record<string, string>[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return sse(JSON.stringify({ choices: [{ delta: { content: "hi" } }] }));
    }) as unknown as typeof fetch;
    registerEndpointAuth(FUSE, { headers: { Authorization: "Bearer sk-test" } });
    for await (const _ of streamChat({ endpoint: "http://127.0.0.1:18181/v1", model: "m", messages: [{ role: "user", content: "x" }], sampling: {}, fetchFn } as any, "t")) { /* drain */ }
    expect(seen.every((h) => !("Authorization" in h))).toBe(true);
  });
});

describe("a refused request names what the provider's support needs", () => {
  it("carries the request id and Retry-After of a 429 (the Fuse and Node docs: log X-Request-ID, honour Retry-After)", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
      status: 429, headers: { "x-request-id": "req_abc123", "retry-after": "30" },
    })) as unknown as typeof fetch;
    registerEndpointAuth(FUSE, { headers: { Authorization: "Bearer sk-test" } });
    let message = "";
    try {
      for await (const _ of streamChat({ endpoint: FUSE, model: "m", messages: [{ role: "user", content: "x" }], sampling: {}, fetchFn, noProgressSec: 0 } as any, "t")) { /* drain */ }
    } catch (e) { message = (e as Error).message; }
    expect(message).toContain("429");
    expect(message).toContain("request req_abc123");
    expect(message).toContain("retry after 30s");
    expect(message).not.toContain("sk-test");
  });
});
