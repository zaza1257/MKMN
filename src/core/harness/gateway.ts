/**
 * The model gateway: the one door between the harness and a model server. Every
 * model call a harness pipeline makes goes through here, never straight to the
 * transport in src/core/chat.ts, so four things are decided in one place:
 *
 *  - The identity: the system prompt always carries the identity block
 *    (withIdentity is idempotent, so a caller that already assembled it pays
 *    nothing twice), and one flag turns it off for a call that must stay minimal.
 *  - The stall watchdog: 45 seconds of silence (the measured window is 30-60 s)
 *    before the call is judged stalled; the transport health-probes the server
 *    and the caller's recover callback brings it back at most once.
 *  - The run's usage limits: a Gateway counts its calls and output tokens, and
 *    refuses the call that would cross the run's limit before anything is sent.
 *    What each call spent is reported back so a step can journal its usage.
 *  - The output ladder for a typed answer: first the server is asked for the
 *    schema's shape (response_format), then a plain JSON answer is repaired
 *    (repairJson), then a flat object may still arrive as `field: value` lines.
 *    The schema itself decides what is acceptable at every rung.
 *
 * The gateway is a counter over the transport, not a second one: streaming,
 * window math, loop detection and field-drop retries stay in chat.ts.
 */
import { streamChat, streamComplete, withAnswer, NO_PROGRESS_SEC, type StreamOptions } from "../chat";
import { firstJson, repairJson } from "../look";
import { withIdentity, IDENTITY_INSTRUCTIONS } from "./identity";
import { turnBudgetOf, chargeTurnPrepare, chargeTurnUsage } from "./turn";
import type { JsonShape, Schema } from "./schema";
import type { StepUsage } from "./journal";
import type { ChatEvent, ChatMessage, ChatStats, Sampling } from "../../shared/types";

/** The estimate used where the server reported no count (the build's token total uses the same). */
const CHARS_PER_TOKEN = 3.6;

export { withAnswer };

/** The usage limits of one run, refused at the gateway, not discovered at the bill. */
export interface GatewayLimits {
  /** Model calls this run may make; the next call past the limit is refused before it is sent. */
  maxCalls?: number;
  /** Output tokens this run may spend; a call that crosses the limit is the run's last one. */
  maxOutputTokens?: number;
}

/** A limit crossed: final, never a transport fault, retrying it cannot help. */
export class GatewayLimitError extends Error {
  constructor(readonly kind: "calls" | "tokens", readonly limits: GatewayLimits) {
    super(
      kind === "calls"
        ? `the run's model-call limit is reached (${limits.maxCalls} calls)`
        : `the run's output-token limit is reached (${limits.maxOutputTokens} tokens)`,
    );
    this.name = "GatewayLimitError";
  }
}

/** The TURN's limit crossed (src/core/harness/turn.ts): the message names the turn, not a
 * run, and it IS a gateway limit error — every existing catch site reads it. */
export class GatewayTurnLimitError extends GatewayLimitError {
  constructor(kind: "calls" | "tokens", limits: GatewayLimits, readonly turnCalls?: number) {
    super(kind, limits);
    this.message =
      kind === "calls"
        ? `this turn reached its model-call budget (${limits.maxCalls} calls)`
        : `this turn reached its output-token budget (${limits.maxOutputTokens} tokens)`;
    this.name = "GatewayTurnLimitError";
  }
}

/** The typed answer never satisfied its schema at any rung of the ladder. */
export class GatewayJsonError extends Error {
  constructor(readonly faults: string[]) {
    super(`the answer never matched the schema: ${faults.join("; ")}`);
    this.name = "GatewayJsonError";
  }
}

export interface GatewayCall {
  endpoint: string;
  model: string;
  messages: ChatMessage[];
  sampling: Sampling;
  /** The window size: given, the answer goes through the window-aware continuation path. */
  nctx?: number;
  maxContinues?: number;
  /** Extra request-body fields (response_format is added by askJson, never by hand). */
  body?: Record<string, unknown>;
  /** The prompt template opens the thought itself, so the stream arrives inside one. */
  thinkOpen?: boolean;
  signal?: AbortSignal;
  /** Seconds of silence before the call is judged stalled. Default 45; 0 turns the watchdog off. */
  noProgressSec?: number;
  /** Bring the server back once (through whoever owns it) after a stall. */
  recover?: () => Promise<boolean>;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** The identity block rides on every call by default; decline it only for a call that must stay minimal. */
  identity?: boolean;
  /** Optional request fields a server refused before: never sent again for that server. */
  refused?: Set<string>;
  /** Told which fields were dropped and what the server said, so the caller can remember them. */
  onDropped?: (fields: string[], serverSaid: string) => void;
  /** Characters of thought before the first answer word before the answer is called finished (windowed calls only). */
  thinkLimit?: number;
  /** Fold the older chat into a summary when a continuation no longer fits (windowed calls only). */
  compact?: (messages: ChatMessage[]) => Promise<ChatMessage[] | null>;
  /** The call's name in the event stream and the logs; a generated one when left out. */
  id?: string;
}

export interface GatewayAnswer {
  text: string;
  thinking: string;
  stats: ChatStats | null;
  usage: StepUsage;
}

/** The default stall window, seconds: one value for the whole app, defined once in the transport
 * (NO_PROGRESS_SEC) and owned here — the gateway passes it on every call it makes. Callers override
 * it only in tests. */
export const DEFAULT_NO_PROGRESS_SEC = NO_PROGRESS_SEC;

export class Gateway {
  /** Calls made and output tokens spent so far, across every ask, askJson and stream of this gateway. */
  calls = 0;
  outputTokens = 0;

  constructor(private limits: GatewayLimits = {}) {}

  /** Refuse the call that would cross a limit — the run's own and the TURN's — then count the one we send. */
  private prepare(call: GatewayCall): StreamOptions {
    if (this.limits.maxCalls !== undefined && this.calls >= this.limits.maxCalls) {
      throw new GatewayLimitError("calls", this.limits);
    }
    if (this.limits.maxOutputTokens !== undefined && this.outputTokens >= this.limits.maxOutputTokens) {
      throw new GatewayLimitError("tokens", this.limits);
    }
    // the per-turn account (src/core/harness/turn.ts): shared by every gateway of the
    // turn, consulted before anything is sent — the refusal is final, never a transport fault
    const turn = turnBudgetOf(call.id);
    if (turn) {
      const crossed = chargeTurnPrepare(turn);
      if (crossed) throw new GatewayTurnLimitError(crossed, turn.limits);
    }
    this.calls++;
    return {
      endpoint: call.endpoint,
      model: call.model,
      messages: this.withIdentity(call.messages, call.identity !== false),
      sampling: call.sampling,
      body: call.body,
      thinkOpen: call.thinkOpen,
      signal: call.signal,
      noProgressSec: call.noProgressSec ?? DEFAULT_NO_PROGRESS_SEC,
      recover: call.recover,
      fetchFn: call.fetchFn,
      now: call.now,
      refused: call.refused,
      onDropped: call.onDropped,
    };
  }

  /** The identity block rides first on the system prompt, once, however the caller assembled it. */
  private withIdentity(messages: ChatMessage[], identity: boolean): ChatMessage[] {
    if (!identity) return messages;
    const out = [...messages];
    const i = out.findIndex((m) => m.role === "system");
    if (i < 0) return [{ role: "system", content: IDENTITY_INSTRUCTIONS }, ...out];
    const m = out[i];
    if (typeof m.content !== "string") return out; // a part-array prompt assembles its own identity
    out[i] = { ...m, content: withIdentity(m.content) };
    return out;
  }

  /** Record what a call spent; the token check lands on the next call, after the paid one is delivered. */
  private charge(stats: ChatStats | null, callId?: string): StepUsage {
    const usage: StepUsage = {
      prompt: stats?.promptTokens ?? 0,
      output: stats?.tokens ?? 0,
      measured: !!stats && stats.tokensEstimated !== true && stats.promptTokens !== undefined,
    };
    this.outputTokens += usage.output;
    const turn = turnBudgetOf(callId);
    if (turn) chargeTurnUsage(turn, usage.output);
    return usage;
  }

  /** The transport call behind every ask and stream: windowed when a window is named, plain otherwise. */
  private transport(o: StreamOptions, call: GatewayCall, id: string): AsyncGenerator<ChatEvent> {
    return call.nctx !== undefined
      ? streamComplete({ ...o, nctx: call.nctx, maxContinues: call.maxContinues, thinkLimit: call.thinkLimit, compact: call.compact }, id)
      : streamChat(o, id);
  }

  /** One plain-text answer. */
  async ask(call: GatewayCall): Promise<GatewayAnswer> {
    const o = this.prepare(call);
    let text = "";
    let thinking = "";
    let stats: ChatStats | null = null;
    try {
      for await (const ev of this.transport(o, call, call.id ?? `gateway:${this.calls}`)) {
        if (ev.type === "answer" || ev.type === "retract") text = withAnswer(text, ev);
        else if (ev.type === "thinking") thinking += ev.text;
        else if (ev.type === "done") stats = ev.stats;
        else if (ev.type === "error") throw new Error(`${ev.error.title}: ${ev.error.fix}`);
      }
    } catch (e) {
      this.chargeUnfinished(text.length + thinking.length, call.id);
      throw e;
    }
    return { text, thinking, stats, usage: this.charge(stats, call.id) };
  }

  /** A call that failed or was stopped still spent what it wrote: charged as an estimate, so the token cap is not reached late. */
  private chargeUnfinished(chars: number, callId?: string): void {
    if (chars <= 0) return;
    this.charge({ tokens: Math.ceil(chars / CHARS_PER_TOKEN), tokensEstimated: true } as ChatStats, callId);
  }

  /** The event stream, for a pipeline that shows the words as they arrive. Usage is charged at the done event. */
  stream(call: GatewayCall): AsyncGenerator<ChatEvent> {
    const o = this.prepare(call);
    const self = this;
    return (async function* () {
      let charged = false, chars = 0;
      try {
        for await (const ev of self.transport(o, call, call.id ?? `gateway:${self.calls}`)) {
          if (ev.type === "done") { self.charge(ev.stats, call.id); charged = true; }
          else if (ev.type === "answer" || ev.type === "thinking") chars += ev.text.length;
          yield ev;
        }
      } finally {
        // an error, a stop, or a consumer that stopped reading: what was written is still charged
        if (!charged) self.chargeUnfinished(chars, call.id);
      }
    })();
  }

  /** One typed answer, down the ladder: response_format, then repair, then lines. */
  async askJson<T>(call: GatewayCall & { schema: Schema<T>; schemaName?: string }): Promise<T> {
    const { schema } = call;
    const faults: string[] = [];
    const shape = schema.jsonSchema;
    const described = `Answer with one JSON value only: ${schema.describe}. No other words.`;

    // Rung 1: the server is asked for the shape itself.
    if (shape) {
      const strict = objectAllRequired(shape);
      const text = await this.ask({
        ...call,
        messages: withJsonInstruction(call.messages, described),
        body: {
          ...call.body,
          response_format: {
            type: "json_schema",
            json_schema: { name: call.schemaName ?? "result", strict, schema: shape.shape },
          },
        },
      }).then((a) => a.text);
      const check = schema.check(firstJson(text) ?? repairJson(text), "answer");
      if (check.ok) return check.value;
      faults.push(...check.errors);
    }

    // Rung 2: a plain JSON answer, repaired where the model left it unfinished.
    {
      const text = await this.ask({ ...call, messages: withJsonInstruction(call.messages, described) }).then((a) => a.text);
      const check = schema.check(firstJson(text) ?? repairJson(text), "answer");
      if (check.ok) return check.value;
      faults.push(...check.errors);
    }

    // Rung 3: a flat object may still arrive as `field: value` lines.
    if (shape && isFlatObjectShape(shape)) {
      const lineAsked = `Answer in lines, one per field, as "field: value". No other words.`;
      const text = await this.ask({ ...call, messages: withJsonInstruction(call.messages, lineAsked) }).then((a) => a.text);
      const check = schema.check(parseLines(text, shape), "answer");
      if (check.ok) return check.value;
      faults.push(...check.errors);
    }

    throw new GatewayJsonError(faults);
  }
}

/** True when the shape is an object whose every property is a primitive (the line format cannot nest). */
function isFlatObjectShape(shape: JsonShape): boolean {
  const props = shape.shape.properties;
  if (shape.shape.type !== "object" || typeof props !== "object" || props === null) return false;
  return Object.values(props).every((p) => {
    const t = (p as Record<string, unknown>).type;
    return t === "string" || t === "number" || t === "integer" || t === "boolean";
  });
}

function objectAllRequired(shape: JsonShape): boolean {
  const required = shape.shape.required;
  const props = shape.shape.properties;
  return Array.isArray(required) && typeof props === "object" && props !== null && required.length === Object.keys(props).length;
}

/** The JSON instruction joins the system prompt, after whatever the caller assembled. */
function withJsonInstruction(messages: ChatMessage[], instruction: string): ChatMessage[] {
  const out = [...messages];
  const i = out.findIndex((m) => m.role === "system");
  if (i < 0) return [{ role: "system", content: instruction }, ...out];
  const m = out[i];
  if (typeof m.content !== "string") return out;
  out[i] = { ...m, content: `${m.content}\n${instruction}` };
  return out;
}

/** Parse `field: value` lines into a flat object. Unknown lines are ignored; the schema refuses what is missing. */
function parseLines(text: string, shape: JsonShape): Record<string, unknown> {
  const props = (shape.shape.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^:]{1,64}?)\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    const prop = props[key];
    if (!prop) continue;
    const raw = m[2].trim().replace(/^["']|["'],?$/g, "");
    out[key] = prop.type === "number" || prop.type === "integer" ? Number(raw) : prop.type === "boolean" ? raw === "true" : raw;
  }
  return out;
}
