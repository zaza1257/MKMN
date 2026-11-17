/**
 * The fake models: test doubles that plug into the gateway in place of a server.
 * They implement the one seam a real server occupies — the fetch of an OpenAI-style
 * endpoint — so a test that uses them exercises the WHOLE transport: the stream,
 * the fitting, the field-drop retry, the watchdog. A test never points the gateway
 * at a real server; if it needs a model, it hands the gateway one of these.
 *
 *  - `FakeModel` replays scripted replies (text or raw chunks), the last one
 *    repeating when more requests come; a reply may `hang` (a server that stopped
 *    serving) so the watchdog can be tested against it.
 *  - `FunctionModel` computes its answer from the request body: the deterministic
 *    model tests are written against.
 *
 * Both record every request body they were sent, so a test asserts on what the
 * pipeline actually asked, not on what it hoped to ask.
 */

const enc = new TextEncoder();

/** One SSE `data:` line. */
export const sseData = (d: object): string => `data: ${JSON.stringify(d)}\n\n`;
/** An answer chunk. */
export const DELTA = (t: string): string => sseData({ choices: [{ delta: { content: t } }] });
/** The finish chunk. */
export const STOP = sseData({ choices: [{ delta: {}, finish_reason: "stop" }] });
/** A measured usage chunk. */
export const USAGE = (prompt: number, completion: number): string =>
  sseData({ choices: [{ delta: {} }], usage: { prompt_tokens: prompt, completion_tokens: completion } });
/** The end of the stream. */
export const DONE = "data: [DONE]\n\n";

/** One scripted reply: the chunks are streamed in order; `hang` keeps the stream open after them. */
export interface FakeReply {
  chunks: string[];
  hang?: boolean;
}

/**
 * A text answer, streamed a few words at a time the way a real server streams,
 * ending with the finish chunk and the end of the stream (or a measured usage
 * chunk, when the test wants the gateway's usage to be measured, not estimated).
 */
export function answerReply(
  text: string,
  opts: { usage?: { prompt: number; completion: number }; pieces?: number } = {},
): FakeReply {
  const words = text.split(/(?<=\s)/).filter((w) => w.length > 0);
  const pieces = Math.max(1, Math.min(opts.pieces ?? 4, words.length || 1));
  const per = Math.ceil(words.length / pieces);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += per) chunks.push(DELTA(words.slice(i, i + per).join("")));
  chunks.push(opts.usage ? USAGE(opts.usage.prompt, opts.usage.completion) : STOP);
  chunks.push(DONE);
  return { chunks };
}

/** A JSON answer, streamed as one text reply. */
export function jsonReply(v: unknown, opts: { usage?: { prompt: number; completion: number } } = {}): FakeReply {
  return answerReply(JSON.stringify(v), opts);
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/** The shared server behaviour behind both fakes: /v1/models is up, a completion serves the next reply. */
function modelFetch(
  requests: Record<string, unknown>[],
  pick: (body: Record<string, unknown>, served: number) => FakeReply,
): typeof fetch {
  let served = 0;
  return (async (url: FetchInput, init?: FetchInit) => {
    const u = String(url instanceof URL ? url : (url as { url?: string })?.url ?? url);
    if (u.endsWith("/models")) return new Response("{}", { status: 200 });
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>; } catch { /* a body that is not JSON is still a request */ }
    requests.push(body);
    const r = pick(body, served);
    served++;
    return new Response(new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of r.chunks) c.enqueue(enc.encode(s));
        if (!r.hang) c.close();
      },
    }), { status: 200 });
  }) as unknown as typeof fetch;
}

/** A scripted model: the last reply repeats when the requests keep coming. */
export class FakeModel {
  /** Every request body the pipeline sent. */
  readonly requests: Record<string, unknown>[] = [];
  private queue: FakeReply[];

  constructor(...replies: (string | FakeReply)[]) {
    this.queue = replies.map((r) => (typeof r === "string" ? answerReply(r) : r));
  }

  /** Queue one more reply, after the ones already scripted. */
  push(reply: string | FakeReply): this {
    this.queue.push(typeof reply === "string" ? answerReply(reply) : reply);
    return this;
  }

  /** The body of the Nth request (0-based), typed for the asserts. */
  request(n: number): Record<string, unknown> {
    return this.requests[n];
  }

  /** How many completions were served. */
  get served(): number {
    return this.requests.length;
  }

  fetchFn = modelFetch(this.requests, (_body, served) =>
    this.queue.length === 0 ? answerReply("") : this.queue[Math.min(served, this.queue.length - 1)],
  );
}

/** A computed model: the answer (or a raw reply) comes back from the function, deterministically. */
export class FunctionModel {
  /** Every request body the pipeline sent. */
  readonly requests: Record<string, unknown>[] = [];

  constructor(private readonly answer: (body: Record<string, unknown>, served: number) => string | FakeReply) {}

  /** The body of the Nth request (0-based). */
  request(n: number): Record<string, unknown> {
    return this.requests[n];
  }

  /** How many completions were served. */
  get served(): number {
    return this.requests.length;
  }

  fetchFn = modelFetch(this.requests, (body, served) => {
    const a = this.answer(body, served);
    return typeof a === "string" ? answerReply(a) : a;
  });
}
