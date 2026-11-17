import { describe, expect, it, vi } from "vitest";
import * as humain from "../src/core/humain";

describe("HUMAIN", () => {
  it("maps old backup settings to their primary provider", () => {
    expect(humain.cloudProviderOf("fuse-node")).toBe("fuse");
    expect(humain.cloudProviderOf("node-fuse")).toBe("node");
    expect(humain.cloudProviderOf("local")).toBeUndefined();
  });

  it("uses the fixed provider origin and refuses redirects", async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [] }));
    await humain.humainRequest("node", "test-key", "GET", "/v1/models", undefined, undefined, fetcher);
    expect(fetcher).toHaveBeenCalledWith("https://api.node.humain.com/v1/models",
      expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer test-key" }) }));
  });

});
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { humainVault } from "../src/sidecar/humainVault";
import { SidecarDispatcher } from "../src/sidecar/protocol";
import type { ChatEvent } from "../src/shared/types";
import { operationRoute, registerHumain } from "../src/sidecar/humain";

describe("HUMAIN transport and credentials", () => {
  it("exposes inference and public endpoints and rejects management routes", () => {
    expect(() => operationRoute("fuse", "POST", "/v1/organization/presets/p/versions/v/restore")).toThrow("unavailable");
    expect(() => operationRoute("node", "PUT", "/api/consumers/user/budget")).toThrow("unavailable");
    expect(operationRoute("node", "POST", "/v1/embeddings")).toBe("inference");
    expect(operationRoute("node", "GET", "/healthz")).toBe("public");
    expect(operationRoute("fuse", "GET", "/v1/openapi.json")).toBe("public");
    expect(() => operationRoute("fuse", "GET", "/openapi.json")).toThrow("unavailable");
    expect(() => operationRoute("fuse", "GET", "/v1/files/%2e%2e")).toThrow("Invalid");
    expect(() => operationRoute("node", "GET", "/v1/organization")).toThrow("unavailable");
  });

  it("parses named SSE events even when frames cross transport chunks", async () => {
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.output_text.delta\r\nda'));
        controller.enqueue(encoder.encode('ta: {"delta":"hello"}\r\n\r\ndata: [DONE]\n\n'));
        controller.close();
      },
    }));
    const received = [];
    for await (const event of humain.humainEvents(response)) received.push(event);
    expect(received).toEqual([{ event: "response.output_text.delta", data: { delta: "hello" } }]);
  });

  it("blocks disabled capabilities before reading a credential or sending a request", async () => {
    const dispatcher = new SidecarDispatcher();
    registerHumain(dispatcher, ".", () => ({ humainDisabledFeatures: { images: true, search: true, realtime: true } }));
    const call = (method: string, ...args: unknown[]) =>
      dispatcher.respond({ t: "req", id: method, method, args });
    for (const response of await Promise.all([
      call("humainOperation", "fuse", "POST", "/v1/images/generations", {}),
      call("humainOperation", "fuse", "POST", "/v1/responses", { tools: [{ type: "web_search" }] }),
      call("humainRealtimeOpen", "test", "realtime-model"),
    ])) expect(response).toMatchObject({ ok: false, error: expect.stringContaining("Enable this capability") });
  });

  it.skipIf(process.platform !== "win32")("sends Fuse search and reasoning and shows reported citations and estimated cost", async () => {
    const folder = await mkdtemp(join(tmpdir(), "mkmn-humain-research-"));
    const dispatcher = new SidecarDispatcher();
    const chat = registerHumain(dispatcher, folder);
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "research-model" }] });
      expect(url).toMatch(/\/v1\/responses$/);
      expect(JSON.parse(String(options?.body))).toMatchObject({ reasoning: { effort: "high" }, tools: [{ type: "web_search" }] });
      return Response.json({
        output: [{ content: [{ type: "output_text", text: "A cited result.", annotations: [
          { type: "url_citation", title: "Source", url: "https://example.org/source" },
        ] }] }],
        usage: { input_tokens: 1000, output_tokens: 500 },
      }, { headers: { "x-fuse-reasoning-effort": "high" } });
    }));
    try {
      await humainVault(folder).save("fuse", "dummy-key");
      const events: ChatEvent[] = [];
      await chat("research", {
        humainMode: "fuse", humainFuseModel: "research-model", humainChatSearch: "research", humainFuseEffort: "high",
        humainUsdRates: { "fuse:research-model": { input: 2, output: 4 } },
      }, [{ role: "user", content: "Research this" }], new AbortController().signal, (event) => events.push(event));
      expect(events).toContainEqual({ id: "research", type: "notice", text: "Fuse thinking effort: high" });
      expect(events).toContainEqual(expect.objectContaining({ type: "answer", text: expect.stringContaining("[Source](https://example.org/source)") }));
      expect(events.at(-1)).toMatchObject({ type: "done", stats: { estimatedUsd: 0.004 } });
    } finally {
      vi.unstubAllGlobals();
      await rm(folder, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(process.platform !== "win32")("cancels a Realtime open during model discovery", async () => {
    const folder = await mkdtemp(join(tmpdir(), "mkmn-realtime-"));
    const dispatcher = new SidecarDispatcher();
    registerHumain(dispatcher, folder);
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requestStarted();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }));
    const call = (method: string, ...args: unknown[]) =>
      dispatcher.respond({ t: "req", id: method, method, args });
    try {
      expect((await call("humainSaveKey", "node", "dummy-node")).ok).toBe(true);
      const opening = call("humainRealtimeOpen", "test", "realtime-model");
      await started;
      expect((await call("humainRealtimeClose", "test")).ok).toBe(true);
      expect((await opening).ok).toBe(false);
      expect((await call("humainRealtimeEvents", "test")).result).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      await rm(folder, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(process.platform !== "win32")("reports Fuse errors without making a request to Node", async () => {
    const folder = await mkdtemp(join(tmpdir(), "mkmn-humain-chat-"));
    const dispatcher = new SidecarDispatcher();
    const chat = registerHumain(dispatcher, folder);
    const service = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const node = url.hostname === "api.node.humain.com";
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(node ? "Bearer fake-node" : "Bearer fake-fuse");
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: node ? "node-chat" : "fuse-chat" }] });
      if (!node) return Response.json({ error: { code: "unavailable" } }, { status: 503 });
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "node-chat", stream: true });
      return new Response([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"completion_tokens":1}}',
        'data: [DONE]',
      ].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", service);
    try {
      for (const provider of ["fuse", "node"]) {
        const result = await dispatcher.respond({ t: "req", id: provider, method: "humainSaveKey", args: [provider, `fake-${provider}`] });
        expect(result.ok).toBe(true);
      }
      const output: ChatEvent[] = [];
      await chat("turn", { humainMode: "fuse-node", humainFuseModel: "fuse-chat", humainNodeModel: "node-chat" },
        [{ role: "user", content: "Hello" }], new AbortController().signal, (event) => output.push(event));
      expect(service).toHaveBeenCalledTimes(2);
      expect(output).toEqual([
        expect.objectContaining({ id: "turn", type: "error", error: expect.objectContaining({ title: expect.stringContaining("HTTP 503") }) }),
      ]);
    } finally {
      vi.unstubAllGlobals();
      await rm(folder, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(process.platform !== "win32")("stores, replaces and removes keys with Windows DPAPI", async () => {
    const folder = await mkdtemp(join(tmpdir(), "mkmn-humain-"));
    try {
      const vault = humainVault(folder);
      await vault.save("fuse", "dummy-first-key");
      expect(await readFile(join(folder, "Humain", "fuse.dpapi"), "utf8")).not.toContain("dummy-first-key");
      expect(await vault.read("fuse")).toBe("dummy-first-key");
      expect(await vault.exists("node")).toBe(false);
      await vault.save("fuse", "dummy-replacement");
      expect(await vault.read("fuse")).toBe("dummy-replacement");
      await vault.save("fuse", null);
      expect(await vault.exists("fuse")).toBe(false);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("a Node answer with no text", () => {
  // Seen live: the preview Node model once answered without content; the chat said only
  // "returned no text", with no request id (which the Node docs ask to log) and the model's reasoning dropped.
  it.skipIf(process.platform !== "win32")("shows the reasoning and names the finish reason and the request id", async () => {
    const folder = await mkdtemp(join(tmpdir(), "mkmn-humain-notext-"));
    const dispatcher = new SidecarDispatcher();
    const chat = registerHumain(dispatcher, folder);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "m", node: { supported_formats: ["chat_completions"], supports_streaming: false } }] });
      return Response.json({ choices: [{ message: { content: "", reasoning_content: "Thinking about it." }, finish_reason: "length" }] }, { headers: { "x-request-id": "req_n1" } });
    }));
    try {
      await humainVault(folder).save("node", "dummy-key");
      const events: ChatEvent[] = [];
      await chat("nt", { humainMode: "node", humainNodeModel: "m", humainNodeChatApi: "chat/completions" }, [{ role: "user", content: "Hi" }], new AbortController().signal, (e) => events.push(e));
      expect(events).toContainEqual(expect.objectContaining({ type: "thinking", text: "Thinking about it." }));
      const err = events.find((e) => e.type === "error") as any;
      expect(err?.error?.raw).toContain("finish reason length");
      expect(err?.error?.raw).toContain("request req_n1");
    } finally {
      vi.unstubAllGlobals();
      await rm(folder, { recursive: true, force: true });
    }
  }, 30_000);
});
