import { HUMAIN_LABEL, cloudProviderOf, type HumainProvider } from "../shared/humain";
export { cloudProviderOf };

export const HUMAIN_ORIGINS = {
  fuse: "https://api.fuse.humainaic.com",
  node: "https://api.node.humain.com",
} as const;

export class HumainError extends Error {
  constructor(readonly provider: HumainProvider, readonly status: number, code = "", requestId = "", retryAfter = "") {
    const safe = (value: string) => /^[\w.:-]{1,100}$/.test(value) ? value : "";
    super([
      `${HUMAIN_LABEL[provider]}: ${status ? `HTTP ${status}` : "connection unavailable"}`,
      safe(code), safe(requestId) && `request ${requestId}`, /^\d{1,9}$/.test(retryAfter) && `retry after ${retryAfter}s`,
    ].filter(Boolean).join(" · "));
  }

}

export async function humainRequest(
  provider: HumainProvider, key: string, method: string, path: string, body?: unknown,
  signal?: AbortSignal, fetcher: typeof fetch = fetch, origin = HUMAIN_ORIGINS[provider] as string,
): Promise<Response> {
  const url = new URL(path, origin);
  if (url.origin !== origin || !path.startsWith("/") || url.hash) throw new Error("Invalid HUMAIN endpoint.");
  let response: Response;
  try {
    response = await fetcher(url.href, {
      method, redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
      headers: { ...(url.pathname === "/v1/messages" || url.pathname === "/v1/messages/count_tokens" ? { "anthropic-version": "2023-06-01" } : {}),
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(body === undefined || body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    signal?.throwIfAborted();
    throw new HumainError(provider, 0);
  }
  if (!response.ok) {
    const envelope = await response.json().catch(() => null);
    const code = envelope?.error?.code ?? envelope?.error?.type;
    throw new HumainError(provider, response.status, typeof code === "string" && !code.includes(key || "\0") ? code : "",
      [response.headers.get("x-request-id"), response.headers.get("x-fuse-request-id")].find((id) => id && !id.includes(key || "\0")) ?? "",
      response.headers.get("retry-after") ?? "");
  }
  return response;
}

export async function* humainEvents(response: Response): AsyncGenerator<{ event: string; data: any }> {
  if (!response.body) throw new Error("HUMAIN returned an empty stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (done && buffer.trim()) buffer += "\n\n";
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const lines = frame.split(/\r?\n/);
        const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (data === "[DONE]") return;
        if (data) yield { event: lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "", data: JSON.parse(data) };
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
