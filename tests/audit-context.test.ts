/**
 * Context-audit evidence pairing (Round 3, problem 3): the supervisor writes the
 * "GenieX capabilities … served context …" line BEFORE the process exists, so it is a launch
 * plan — never an observation. A model's context may be called observed ONLY when a
 * served-context statement is logged AFTER that model's readiness line ("Requested model X is
 * served"), paired by model identity, not by timestamp proximity. These fixtures walk a
 * successful launch, failed launches, retries, model switches, log rotation and overlapping
 * files, and timestamp order.
 */
import { describe, expect, it } from "vitest";
import { parseLogEvents, pairEvidence, pairEvidenceDetailed, applyEvidence, parseGguf, canonicalName, stripPrecision } from "../scripts/audit-context.mjs";

const CAP = (model, nctx, served) => `[100.000] [supervisor] GenieX capabilities: context kind configurable; served context ${served} tokens`;
const SPAWN = (ts, model, nctx) => `[${ts}] [supervisor] Spawning GenieX: "C:\\GenieX CLI\\geniex.exe" ["serve", "--host", "127.0.0.1:18181", "--compute", "npu", "--model", "${model}", ${nctx === null ? "" : `"--nctx", "${nctx}", `}"--keepalive", "300"]`;
const READY = (ts, model) => `[${ts}] [supervisor] Requested model ${model} is served; warming up.`;
const FAILED = (ts) => `[${ts}] [supervisor] GenieX exited prematurely with status: 1`;

const L = (...lines) => lines;

describe("audit evidence pairing", () => {
  it("a successful launch: the pre-spawn line is a launch plan; without a post-readiness statement the served context stays unknown", () => {
    const ev = parseLogEvents(L(
      CAP(0, 0, 8192),
      SPAWN(100.0, "unsloth/gemma-3-1b-it-GGUF:Q4_0", 8192),
      READY(103.5, "unsloth/gemma-3-1b-it-GGUF:Q4_0"),
    ), "geniex.log");
    const recs = pairEvidence(ev);
    expect(recs).toHaveLength(1);
    const r = recs[0];
    expect(r.model).toBe(canonicalName("unsloth/gemma-3-1b-it-GGUF:Q4_0"));
    expect(r.plannedServed).toBe(8192); // the plan, recorded as a plan
    expect(r.requested).toBe(8192); // the --nctx flag
    expect(r.readiness).not.toBeNull(); // the requested model was seen served
    expect(r.served).toBeNull(); // but the WINDOW was never confirmed at runtime: unknown
    // written into the rows: observed stays null, the plan and readiness are their own columns
    const models = new Map([["unsloth/gemma-3-1b-it-gguf", { identity: "unsloth/gemma-3-1b-it-gguf", requested: null, requestedSource: null, plannedServed: null, planSource: null, readiness: null, observed: null, evidence: null, launchFailed: false }]]);
    applyEvidence(models, recs);
    const row = models.get("unsloth/gemma-3-1b-it-gguf");
    expect(row.observed).toBeNull(); // never claimed observed
    expect(row.plannedServed).toBe(8192);
    expect(row.readiness).toContain("seen served");
  });

  it("a failed launch is never marked observed, even though its plan was logged", () => {
    const ev = parseLogEvents(L(
      CAP(0, 0, 4096),
      SPAWN(100.0, "qualcomm/Qwen2.5-VL-7B-Instruct", 4096),
      FAILED(102.0),
    ), "geniex.log");
    const recs = pairEvidence(ev);
    expect(recs).toHaveLength(1);
    expect(recs[0].failed).toBe(true);
    expect(recs[0].readiness).toBeNull(); // never seen served
    expect(recs[0].plannedServed).toBe(4096); // the plan exists — and stays a plan
    expect(recs[0].served).toBeNull();
  });

  it("a retry after a failed launch: readiness pairs with the retry spawn, not the failed one", () => {
    const ev = parseLogEvents(L(
      SPAWN(100.0, "unsloth/Qwen3-8B-GGUF:Q4_0", 32768),
      FAILED(101.0),
      SPAWN(110.0, "unsloth/Qwen3-8B-GGUF:Q4_0", 16384), // the fallback retry (smaller context)
      READY(118.0, "unsloth/Qwen3-8B-GGUF:Q4_0"),
    ), "geniex.log");
    const recs = pairEvidence(ev);
    expect(recs).toHaveLength(2);
    expect(recs[0].failed).toBe(true);
    expect(recs[0].readiness).toBeNull();
    expect(recs[1].failed).toBe(false);
    expect(recs[1].readiness).not.toBeNull();
    expect(recs[1].requested).toBe(16384); // the retry's own request
  });

  it("overlapping model switches pair by identity, not by timestamp proximity", () => {
    const ev = parseLogEvents(L(
      SPAWN(100.0, "unsloth/gemma-3-1b-it-GGUF:Q4_0", 32768),
      SPAWN(102.0, "unsloth/Ministral-3-8B-Reasoning-2512-GGUF:Q4_0", 262144), // switched before gemma was ready
      READY(110.0, "unsloth/Ministral-3-8B-Reasoning-2512-GGUF:Q4_0"), // ministral ready first…
      READY(115.0, "unsloth/gemma-3-1b-it-GGUF:Q4_0"), // …gemma late, AFTER the other spawn
    ), "geniex.log");
    const recs = pairEvidence(ev);
    const gemma = recs.find((r) => r.model.includes("gemma"));
    const ministral = recs.find((r) => r.model.includes("ministral"));
    expect(gemma.readiness).not.toBeNull(); // its own readiness line, though it came after the other spawn
    expect(ministral.readiness).not.toBeNull();
    expect(gemma.readiness.ts).toBe(115.0);
    expect(ministral.readiness.ts).toBe(110.0);
  });

  it("a readiness line before its spawn's timestamp never pairs (old evidence is not reused)", () => {
    const ev = parseLogEvents(L(
      READY(90.0, "unsloth/gemma-3-1b-it-GGUF:Q4_0"), // a readiness from a previous attempt
      SPAWN(100.0, "unsloth/gemma-3-1b-it-GGUF:Q4_0", 8192),
    ), "geniex.log");
    const recs = pairEvidence(ev);
    expect(recs[0].readiness).toBeNull(); // the old readiness cannot serve the new spawn
  });

  it("log rotation and overlapping files: events are paired in timestamp order across files", () => {
    const older = parseLogEvents(L(SPAWN(100.0, "unsloth/gemma-3-1b-it-GGUF:Q4_0", 8192)), "geniex.log");      // spawn at the end of the rotated file
    const newer = parseLogEvents(L(READY(103.0, "unsloth/gemma-3-1b-it-GGUF:Q4_0")), "geniex.1.log");          // readiness at the start of the next
    const recs = pairEvidence([...older, ...newer].sort((a, b) => a.ts - b.ts));
    expect(recs[0].readiness).not.toBeNull();
    expect(recs[0].readiness.file).toBe("geniex.1.log");
  });

  it("a served-context statement that names NO model is never attributed — the review's repro", () => {
    // spawn org/A + readiness in a.log; an unrelated statement in b.log afterwards.
    // Before the fix this 2048 was assigned to org/A by timestamp order alone.
    const ev = parseLogEvents(L(
      SPAWN(1, "org/A", 8192),
      READY(2, "org/A"),
    ), "a.log").concat(parseLogEvents(L(
      "[3.000] [supervisor] runtime served context 2048 tokens",
    ), "b.log"));
    const d = pairEvidenceDetailed(ev.sort((a, b) => a.ts - b.ts));
    expect(d.records[0].served).toBeNull(); // left unknown: the statement carries no identity
    expect(d.uncorrelated).toHaveLength(1);
    expect(d.uncorrelated[0].served).toBe(2048);
    expect(d.ambiguous).toHaveLength(0);
    // written into the rows: still unknown, with a count of what could not be attributed
    const models = new Map([["org/a", { identity: "org/a", requested: null, requestedSource: null, plannedServed: null, planSource: null, readiness: null, observed: null, evidence: null, launchFailed: false }]]);
    applyEvidence(models, d.records);
    expect(models.get("org/a")!.observed).toBeNull();
  });

  it("a served-context statement that NAMES its model, after that model's readiness, IS an observation", () => {
    const ev = parseLogEvents(L(
      SPAWN(100.0, "unsloth/gemma-3-1b-it-GGUF:Q4_0", 8192),
      READY(103.0, "unsloth/gemma-3-1b-it-GGUF:Q4_0"),
      "[105.000] [supervisor] GenieX reports a served context of 8192 tokens for unsloth/gemma-3-1b-it-GGUF:Q4_0.",
    ), "geniex.log");
    const recs = pairEvidence(ev);
    expect(recs[0].served).toBe(8192); // observed: identity named, after readiness, one unique launch
    expect(recs[0].servedEvidence).toContain("8192");
    expect(recs[0].servedEvidence).toContain("after that model's readiness");
  });

  it("a statement naming a DIFFERENT model never lands on this launch", () => {
    const ev = parseLogEvents(L(
      SPAWN(100.0, "org/A", 8192),
      READY(103.0, "org/A"),
      "[105.000] [supervisor] served context 2048 tokens --model org/B",
    ), "geniex.log");
    const recs = pairEvidence(ev);
    expect(recs[0].served).toBeNull();
    expect(recs[0].servedEvidence).toBeNull();
    const d = pairEvidenceDetailed(ev);
    expect(d.ambiguous).toHaveLength(1); // the statement is kept, with why it is unattributable
    expect(d.ambiguous[0].model).toBe("org/b");
  });

  it("a failed launch receives neither readiness nor a context confirmation", () => {
    const ev = parseLogEvents(L(
      SPAWN(100.0, "org/A", 8192),
      FAILED(101.0),
      READY(102.0, "org/A"), // a stale readiness line, after the failure was logged
      "[103.000] [supervisor] served context 2048 tokens --model org/A",
    ), "geniex.log");
    const recs = pairEvidence(ev);
    expect(recs[0].failed).toBe(true);
    expect(recs[0].readiness).toBeNull(); // a failed launch never 'saw' its model served
    expect(recs[0].served).toBeNull(); // and never receives a context confirmation
  });

  it("overlapping same-model launches: one statement no unique launch owns stays unknown", () => {
    const ev = parseLogEvents(L(
      SPAWN(100.0, "org/A", 8192),
      SPAWN(101.0, "org/A", 4096), // relaunched before the first was ready
      READY(103.0, "org/A"),
      READY(104.0, "org/A"),
      "[105.000] [supervisor] served context 2048 tokens --model org/A",
    ), "geniex.log");
    const d = pairEvidenceDetailed(ev);
    expect(d.records.every((r) => r.served === null)).toBe(true); // which process spoke is not decidable
    expect(d.ambiguous).toHaveLength(1);
    expect(d.ambiguous[0].why).toContain("not decidable");
  });

  it("a later failed attempt does not erase an earlier successful observation", () => {
    const ev = parseLogEvents(L(
      SPAWN(100.0, "org/A", 8192),
      READY(103.0, "org/A"),
      "[105.000] [supervisor] served context 8192 tokens --model org/A",
      SPAWN(110.0, "org/A", 4096),
      FAILED(112.0),
    ), "geniex.log");
    const d = pairEvidenceDetailed(ev);
    const models = new Map([["org/a", { identity: "org/a", requested: null, requestedSource: null, plannedServed: null, planSource: null, readiness: null, observed: null, evidence: null, launchFailed: false }]]);
    applyEvidence(models, d.records);
    const row = models.get("org/a")!;
    expect(row.observed).toBe(8192); // the historical observation stands
    expect(row.readiness).toContain("seen served");
    expect(row.lastAttempt).toContain("later launch attempt failed"); // …and the latest failure is named
  });

  it("the capabilities plan pairs only within the same file (rotation does not glue launches together)", () => {
    const ev = parseLogEvents(L(CAP(0, 0, 8192)), "geniex.log")
      .concat(parseLogEvents(L(SPAWN(2, "org/A", 8192)), "geniex.1.log")); // next file, 2s later
    const recs = pairEvidence(ev.sort((a, b) => a.ts - b.ts));
    expect(recs[0].plannedServed).toBeNull(); // the plan of another launch, not this spawn's
  });

  it("the audit keeps its host:port, paths and timestamps out of a statement's identity", () => {
    const ev = parseLogEvents(L(
      SPAWN(100.0, "org/A", 8192),
      READY(103.0, "org/A"),
      "[105.000] [supervisor] served 127.0.0.1:18181/v1 context 2048 tokens",
    ), "geniex.log");
    const d = pairEvidenceDetailed(ev);
    expect(d.records[0].served).toBeNull(); // "127.0.0.1:18181/v1" is not a model identity
  });

  it("a served-context statement before any readiness is still not an observation", () => {
    const ev = parseLogEvents(L(
      SPAWN(100.0, "unsloth/gemma-3-1b-it-GGUF:Q4_0", 8192),
      "[101.000] [supervisor] served context 8192 tokens", // not after readiness: not an observation
    ), "geniex.log");
    const recs = pairEvidence(ev);
    expect(recs[0].served).toBeNull();
  });

  it("precision suffixes fold into the model row; ai-hub-models counts as qualcomm", () => {
    expect(stripPrecision("unsloth/gemma-3-1b-it-GGUF:Q4_0")).toBe("unsloth/gemma-3-1b-it-GGUF");
    expect(canonicalName("ai-hub-models/Qwen2.5-VL-7B-Instruct")).toBe("qualcomm/qwen2.5-vl-7b-instruct");
  });

  it("both spawn argv spellings are understood", () => {
    const a = pairEvidence(parseLogEvents(L(SPAWN(1, "org/m:Q4_0", 8192)), "a.log"));
    const b = pairEvidence(parseLogEvents(L('[1] [supervisor] Spawning GenieX: geniex.exe --model org/m:Q4_0 --nctx 8192'), "b.log"));
    expect(a[0].model).toBe("org/m:q4_0"); // canonicalized in the paired record
    expect(a[0].requested).toBe(8192); // the --nctx flag, quoted or bare
    expect(b[0].model).toBe("org/m:q4_0");
    expect(b[0].requested).toBe(8192);
  });
});

// ------------------------------------------------------------------ the standalone GGUF header parser

/** Builds a minimal GGUF buffer: "GGUF", version, tensor count, then the given key/value pairs. */
const T = { u8: 0, i8: 1, u16: 2, i16: 3, u32: 4, i32: 5, f32: 6, bool: 7, str: 8, arr: 9, u64: 10, i64: 11, f64: 12 };
function ggufBuf(kvs: Array<[string, number, unknown]>): Buffer {
  const parts: Buffer[] = [];
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  const u64 = (v: number | bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const str = (s: string) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([u64(b.length), b]); };
  const scalar = (t: number, v: unknown): Buffer => {
    switch (t) {
      case T.u8: case T.bool: { const b = Buffer.alloc(1); b.writeUInt8(t === T.bool ? (v ? 1 : 0) : (v as number)); return b; }
      case T.i8: { const b = Buffer.alloc(1); b.writeInt8(v as number); return b; }
      case T.u16: { const b = Buffer.alloc(2); b.writeUInt16LE(v as number); return b; }
      case T.i16: { const b = Buffer.alloc(2); b.writeInt16LE(v as number); return b; }
      case T.u32: return u32(v as number);
      case T.i32: { const b = Buffer.alloc(4); b.writeInt32LE(v as number); return b; }
      case T.f32: { const b = Buffer.alloc(4); b.writeFloatLE(v as number); return b; }
      case T.u64: return u64(v as number);
      case T.i64: { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v as number)); return b; }
      case T.f64: { const b = Buffer.alloc(8); b.writeDoubleLE(v as number); return b; }
      case T.str: return str(v as string);
      case T.arr: { const [et, items] = v as [number, unknown[]]; return Buffer.concat([u32(et), u64(items.length), ...items.map((x) => scalar(et, x))]); }
      default: throw new Error(`bad type ${t}`);
    }
  };
  parts.push(Buffer.from("GGUF", "ascii"), u32(3), u64(0), u64(kvs.length));
  for (const [key, t, v] of kvs) parts.push(str(key), u32(t), scalar(t, v));
  return Buffer.concat(parts);
}

describe("the standalone GGUF header parser", () => {
  // parseGguf keeps only `general.architecture` and `*.context_length` keys, so every scalar type
  // is tested AS a context_length: a wrong cursor advance for any type corrupts every later value.
  it("reads every supported scalar type with the correct width", () => {
    const kv = parseGguf(ggufBuf([
      ["x.pre.architecture", T.i16, -7], // an i16 ahead of the kept keys, like the old bug's fixture
      ["x.u8.context_length", T.u8, 200], ["x.i8.context_length", T.i8, -100],
      ["x.u16.context_length", T.u16, 65500], ["x.i16.context_length", T.i16, -30000],
      ["x.u32.context_length", T.u32, 4_000_000_000], ["x.i32.context_length", T.i32, -2_000_000],
      ["x.f32.context_length", T.f32, 1.5],
      ["x.bool.context_length", T.bool, 1],
      ["x.u64.context_length", T.u64, 9_000_000_000], ["x.i64.context_length", T.i64, -9_000_000_000],
      ["x.f64.context_length", T.f64, -0.25],
      ["general.architecture", T.str, "llama"],
      ["llama.context_length", T.u32, 8192],
    ]));
    expect(kv["x.u8.context_length"]).toBe(200);
    expect(kv["x.i8.context_length"]).toBe(-100);
    expect(kv["x.u16.context_length"]).toBe(65500);
    expect(kv["x.i16.context_length"]).toBe(-30000);
    expect(kv["x.u32.context_length"]).toBe(4_000_000_000);
    expect(kv["x.i32.context_length"]).toBe(-2_000_000);
    expect(kv["x.f32.context_length"]).toBeCloseTo(1.5);
    expect(kv["x.bool.context_length"]).toBe(true);
    expect(kv["x.u64.context_length"]).toBe(9_000_000_000);
    expect(kv["x.i64.context_length"]).toBe(-9_000_000_000);
    expect(kv["x.f64.context_length"]).toBe(-0.25);
    // the tail is still exact: every width above was walked correctly
    expect(kv["general.architecture"]).toBe("llama");
    expect(kv["llama.context_length"]).toBe(8192);
  });

  it("an i16 field BEFORE the architecture/context keys no longer corrupts them", () => {
    // the regression: the i16 case read the value without advancing the cursor, so every
    // following key was read from the middle of the buffer
    const kv = parseGguf(ggufBuf([
      ["general.alignment", T.i16, -7],
      ["general.architecture", T.str, "llama"],
      ["llama.context_length", T.u32, 8192],
    ]));
    expect(kv["general.architecture"]).toBe("llama");
    expect(kv["llama.context_length"]).toBe(8192);
  });

  it("arrays are skipped without being materialized, and the cursor still advances past them", () => {
    const kv = parseGguf(ggufBuf([
      ["tokenizer.ggml.tokens", T.arr, [T.str, ["a", "bb", "ccc"]]], // a big tokenizer array: walked, not kept
      ["general.architecture", T.str, "qwen3"],
      ["qwen3.context_length", T.u32, 40960],
    ]));
    expect(kv["tokenizer.ggml.tokens"]).toBeUndefined();
    expect(kv["general.architecture"]).toBe("qwen3"); // readable only if the array's bytes were walked correctly
    expect(kv["qwen3.context_length"]).toBe(40960);
  });

  it("an empty string array and a deep array of numbers are bounded and safe", () => {
    const kv = parseGguf(ggufBuf([
      ["t.empty", T.arr, [T.u32, []]],
      ["t.nums", T.arr, [T.i16, [-1, -2, -3]]],
      ["llama.context_length", T.u64, 131072],
    ]));
    expect(kv["llama.context_length"]).toBe(131072);
  });

  it("a truncated header fails with a bounded error, never a wrong number", () => {
    const good = ggufBuf([["general.architecture", T.str, "llama"], ["llama.context_length", T.u32, 8192]]);
    expect(() => parseGguf(good.subarray(0, good.length - 3))).toThrow(); // cut inside the last value
    expect(() => parseGguf(Buffer.from("GGXFFFFF", "ascii"))).toThrow(/not a GGUF/);
    expect(() => parseGguf(Buffer.alloc(0))).toThrow();
  });
});
