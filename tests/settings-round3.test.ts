// Round-3 settings fixes and the local-benchmark display: the pure logic each fix
// stands on, pinned by tests before (and besides) the live UI verification.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createConnectionTester, connectionFingerprint, createEstimateGate, createSaveFeedback,
  createSliderCommit, estimateConfigKey, estimateConfigLabel, parseRuntimeInt, radioTabStop,
  readAdvOpen, redactCredentials, RUNTIME_FIELD_RANGES, writeAdvOpen,
} from "../src/core/settingsUi";
import {
  benchDetailLines, benchHeadline, benchOutdatedReasons, benchProfileFor, benchRefsFor,
  parseBenchProfiles, parseBenchRun, selectBenchRun, type BenchProfile,
} from "../src/core/benchStore";

// ---------------------------------------------------------------- 1. advanced-group persistence

describe("advanced navigation persistence (the true/false vs 0 mismatch)", () => {
  it("reads both the boolean strings and the legacy '0' spelling", () => {
    expect(readAdvOpen(null)).toBe(true);
    expect(readAdvOpen(undefined)).toBe(true);
    expect(readAdvOpen("true")).toBe(true);
    expect(readAdvOpen("false")).toBe(false);
    expect(readAdvOpen("0")).toBe(false); // the legacy collapsed spelling
    expect(readAdvOpen("anything-else")).toBe(true);
  });

  it("writes 'true'/'false', and a written value reads back the same", () => {
    for (const open of [true, false]) {
      const raw = writeAdvOpen(open);
      expect(raw).toBe(open ? "true" : "false");
      expect(readAdvOpen(raw)).toBe(open);
    }
  });
});

// ---------------------------------------------------------------- 2. radio-group tab stop

describe("the radio group's ONE tab stop", () => {
  const opts = [
    { id: "a" }, { id: "b" }, { id: "c", disabled: true }, { id: "d" },
  ];

  it("is the checked choice when it is enabled", () => {
    expect(radioTabStop(opts, "b")).toBe("b");
  });

  it("falls back to the FIRST ENABLED choice when the saved selection is disabled", () => {
    // the checked option is disabled: the group must stay Tab-reachable
    expect(radioTabStop(opts, "c")).toBe("a");
    expect(radioTabStop([{ id: "x", disabled: true }, { id: "y" }], "x")).toBe("y");
  });

  it("falls back when the value is not among the options at all", () => {
    expect(radioTabStop(opts, "zzz")).toBe("a");
  });

  it("is null when nothing is enabled (nothing can be the tab stop)", () => {
    expect(radioTabStop([{ id: "a", disabled: true }], "a")).toBeNull();
  });
});

// ---------------------------------------------------------------- 3. connection test

describe("the connection test: binding, invalidation, supersession, redaction", () => {
  const cfg = { provider: "brave", braveKey: "BSA-secret-key-123", searxngUrl: "" };

  it("binds a result to the exact provider + credential + address", () => {
    expect(connectionFingerprint(cfg)).not.toBe(connectionFingerprint({ ...cfg, braveKey: "other-key" }));
    expect(connectionFingerprint(cfg)).toBe(connectionFingerprint({ ...cfg }));
    expect(connectionFingerprint({ provider: "searxng", searxngUrl: "http://x" }))
      .not.toBe(connectionFingerprint({ provider: "searxng", searxngUrl: "http://y" }));
  });

  it("never exposes credentials in feedback, even when the error echoes them", async () => {
    const tester = createConnectionTester(async () => {
      throw new Error("request to http://host?key=BSA-secret-key-123 failed");
    });
    await tester.test(cfg);
    expect(tester.get().phase).toBe("failed");
    expect(tester.get().text).not.toContain("BSA-secret-key-123");
    expect(tester.get().text).toContain("[redacted]");
  });

  it("redacts the key and the instance address from error text", () => {
    const t = "fetch of http://localhost:8080/search?q=x with key BSA-secret-key-123 failed";
    const out = redactCredentials(t, { provider: "brave", braveKey: "BSA-secret-key-123", searxngUrl: "http://localhost:8080" });
    expect(out).not.toContain("BSA-secret-key-123");
    expect(out).not.toContain("http://localhost:8080");
    expect(out.match(/\[redacted\]/g)).toHaveLength(2);
  });

  it("drops a superseded response: only the newest test's answer shows", async () => {
    const deferreds: ((v: { ok: boolean; n: number }) => void)[] = [];
    const tester = createConnectionTester(async () => new Promise((r) => { deferreds.push(r); }));
    const p1 = tester.test(cfg);
    expect(tester.get().phase).toBe("busy");
    // the configuration changes while the first test is in flight: its answer is orphaned
    const cfg2 = { ...cfg, braveKey: "BSA-new-key-456" };
    tester.invalidate(cfg2);
    expect(tester.get().phase).toBe("idle");
    const p2 = tester.test(cfg2);
    expect(tester.get().phase).toBe("busy");
    deferreds[0]({ ok: true, n: 7 }); // the OLD test's answer arrives late
    await p1;
    expect(tester.get().phase).toBe("busy"); // it must not be shown
    deferreds[1]({ ok: true, n: 3 }); // the newest test's answer
    await p2;
    expect(tester.get().phase).toBe("ok");
    expect(tester.get().text).toContain("3 results");
    expect(tester.get().text).not.toContain("7");
  });

  it("shows the newest test's result and keeps it while the configuration is unchanged", async () => {
    const tester = createConnectionTester(async (c) => ({ ok: true, n: c.braveKey === "good" ? 5 : 1 }));
    await tester.test({ provider: "brave", braveKey: "good" });
    expect(tester.get().phase).toBe("ok");
    expect(tester.get().text).toContain("5 results");
    expect(tester.get().fingerprint).toBe(connectionFingerprint({ provider: "brave", braveKey: "good" }));
    // changing the credential invalidates: a result may not answer for a key it never tested
    tester.invalidate({ provider: "brave", braveKey: "changed" });
    expect(tester.get().phase).toBe("idle");
    // changing BACK to the tested value does not resurrect a cleared result
    tester.invalidate({ provider: "brave", braveKey: "good" });
    expect(tester.get().phase).toBe("idle");
  });

  it("a failed test reports its own message with Retry handled by the caller", async () => {
    const tester = createConnectionTester(async () => ({ ok: false, n: 0, error: "The search did not answer." }));
    await tester.test(cfg);
    expect(tester.get().phase).toBe("failed");
    expect(tester.get().text).toBe("The search did not answer.");
  });
});

// ---------------------------------------------------------------- 4. slider commits

describe("slider commit discipline (one latch, no duplicate saves)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (initial = 10, save = vi.fn()) =>
    ({ c: createSliderCommit({ initial, save, debounceMs: 600 }), save });

  it("saves once for change + gestureEnd + blur of the same value", () => {
    const { c, save } = make();
    c.change(30);       // schedules the debounced commit
    c.gestureEnd(30);   // pointer released: commits now
    c.blur();           // focus left: nothing pending any more
    c.gestureEnd(30);   // duplicate trigger
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(30);
  });

  it("does not save when the value returns to the committed one", () => {
    const { c, save } = make();
    c.change(30);
    c.change(10); // dragged back before the debounce fired
    vi.advanceTimersByTime(1000);
    expect(save).not.toHaveBeenCalled();
  });

  it("debounces rapid changes into one save of the final value", () => {
    const { c, save } = make();
    c.change(20); c.change(21); c.change(22);
    vi.advanceTimersByTime(599);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(22);
  });

  it("blur commits the pending value and cancels the debounce", () => {
    const { c, save } = make();
    c.change(25);
    c.blur();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(25);
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("dispose flushes the pending value (navigate-away never drops it)", () => {
    const { c, save } = make();
    c.change(40);
    c.dispose();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(40);
  });

  it("sync re-latches on an outside change without clobbering a pending edit", () => {
    const { c, save } = make();
    c.sync(50);          // an in-flight save landed / a reset happened
    c.change(50);        // same value as the new committed one: no save
    expect(save).not.toHaveBeenCalled();
    // a pending local edit survives an outside sync and still commits
    c.change(60);
    c.sync(50);
    c.blur();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(60);
  });
});

// ---------------------------------------------------------------- 5. runtime numbers

describe("runtime numeric validation (non-finite, integers, ranges)", () => {
  it("empty means not set", () => {
    for (const field of Object.keys(RUNTIME_FIELD_RANGES) as (keyof typeof RUNTIME_FIELD_RANGES)[]) {
      expect(parseRuntimeInt("", field)).toEqual({ ok: true, value: undefined });
      expect(parseRuntimeInt("   ", field)).toEqual({ ok: true, value: undefined });
    }
  });

  it("rejects non-finite values that would corrupt the settings JSON", () => {
    // JSON.stringify(Infinity) === null: these must never reach the settings
    expect(parseRuntimeInt("Infinity", "threads").ok).toBe(false);
    expect(parseRuntimeInt("-Infinity", "threads").ok).toBe(false);
    expect(parseRuntimeInt("NaN", "threads").ok).toBe(false);
    expect(parseRuntimeInt("1e999", "threads").ok).toBe(false); // parses to Infinity
    expect(parseRuntimeInt("abc", "threads").ok).toBe(false);
  });

  it("rejects non-integers", () => {
    expect(parseRuntimeInt("3.5", "threads").ok).toBe(false);
    expect(parseRuntimeInt("3.5", "batch").ok).toBe(false);
  });

  it("enforces each field's own range", () => {
    expect(parseRuntimeInt("0", "threads").ok).toBe(false);
    expect(parseRuntimeInt("8", "threads")).toEqual({ ok: true, value: 8 });
    expect(parseRuntimeInt("9999", "threads").ok).toBe(false);
    expect(parseRuntimeInt("100", "ctx").ok).toBe(false);        // below 512
    expect(parseRuntimeInt("4096", "ctx")).toEqual({ ok: true, value: 4096 });
    expect(parseRuntimeInt("999999", "ctx").ok).toBe(false);
    expect(parseRuntimeInt("-1", "gpuLayers")).toEqual({ ok: true, value: -1 }); // -1 = all layers
    expect(parseRuntimeInt("-2", "gpuLayers").ok).toBe(false);
    expect(parseRuntimeInt("8193", "ubatch").ok).toBe(false);
  });

  it("names the field and the range in the error", () => {
    const r = parseRuntimeInt("999999", "ctx");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Context window override");
  });
});

// ---------------------------------------------------------------- 6. estimate identity

describe("memory-estimate configuration identity (budget included, stale labelled)", () => {
  it("the key changes when the memory budget changes", () => {
    const base = estimateConfigKey("m", 4096, "f16", 24);
    expect(estimateConfigKey("m", 4096, "f16", 12)).not.toBe(base);
    expect(estimateConfigKey("m", 4096, "f16", null)).not.toBe(base);
    expect(estimateConfigKey("m", 4096, "f16", 24)).toBe(base);
  });

  it("the label names model, context, cache and budget", () => {
    expect(estimateConfigLabel("m", 4096, "f16", 24)).toBe("m · context 4096 · cache f16 · budget 24 GB");
    expect(estimateConfigLabel("m", undefined, undefined, null)).toBe("m · cache f16");
  });

  it("the gate's stale phase keeps the OLD configuration's label on the shown numbers", async () => {
    const gate = createEstimateGate(async (ref) => ({
      modelRef: ref, weightsGB: 1, kvCacheGB: 0.1, scratchpadGB: 0.1, totalRequiredGB: 1.2,
      availableRamGB: 8, totalRamGB: 16, npuBudgetGB: 7.8, fits: true, recommendedNctx: 4096,
      recommendedKvType: "f16", isQairt: false, note: "",
    }));
    gate.request("model-a", 4096, "f16", 24);
    await Promise.resolve();
    expect(gate.get().phase).toBe("ready");
    expect(gate.get().label).toBe(estimateConfigLabel("model-a", 4096, "f16", 24));
    gate.request("model-b", 8192, "q8", 12); // a different configuration
    expect(gate.get().phase).toBe("stale");
    // the label still names what the SHOWN numbers belong to — never the new config
    expect(gate.get().label).toContain("model-a");
    expect(gate.get().label).toContain("budget 24 GB");
  });
});

// ---------------------------------------------------------------- 7. save-feedback failures list

describe("save feedback: overlapping failures of different settings", () => {
  it("a second failing save does not erase the first unresolved failure", async () => {
    const s = createSaveFeedback();
    await s.attempt("settings (a)", () => Promise.reject(new Error("one")), "settings:a");
    await s.attempt("settings (b)", () => Promise.reject(new Error("two")), "settings:b");
    expect(s.get().failures.map((f) => f.text)).toEqual([
      "Saving settings (a) failed: one",
      "Saving settings (b) failed: two",
    ]);
    // retrying one failure leaves the other untouched
    s.get().failures[0].retry();
    await Promise.resolve(); await Promise.resolve();
    expect(s.get().failures).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- 8. benchmark display

const run = (over: { compute: string; decodeTokPerSec: number; measuredAt: string; ttftMs?: number; tokensGenerated?: number; maxTokens?: number; ngl?: number; nctx?: number; verifiedNpu?: boolean; powerMode?: string }) =>
  parseBenchRun({ ttftMs: 210, tokensGenerated: 100, maxTokens: 100, ngl: -1, nctx: 4096, verifiedNpu: true, ...over })!;

describe("local benchmark records: parsing, matching, selection", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const fresh = "2026-05-20T10:00:00Z";

  it("an unusable record is never displayed (no compute, no speed, no date)", () => {
    expect(parseBenchRun(null)).toBeNull();
    expect(parseBenchRun({ compute: "npu", decodeTokPerSec: 0, measuredAt: fresh })).toBeNull();
    expect(parseBenchRun({ compute: "npu", decodeTokPerSec: 24, measuredAt: "not-a-date" })).toBeNull();
    expect(parseBenchRun({ compute: "", decodeTokPerSec: 24, measuredAt: fresh })).toBeNull();
    expect(run({ compute: "npu", decodeTokPerSec: 24.6, measuredAt: fresh, verifiedNpu: true })).toMatchObject({ decodeTokPerSec: 24.6, verifiedNpu: true });
  });

  it("matches by the item's stable refs, never by display name", () => {
    const profiles = parseBenchProfiles({ calibratedProfiles: { "geniex:llama-3.2-1b": { runs: { "npu|burst": { compute: "npu", decodeTokPerSec: 24.6, measuredAt: fresh } } } } });
    const item = { ref: "geniex:llama-3.2-1b", entry: { id: "llama-3.2-1b", repo: "unsloth/Llama-3.2-1B-GGUF", name: "Llama 3.2 1B" } };
    expect(benchRefsFor(item)).toContain("geniex:llama-3.2-1b");
    expect(benchProfileFor(profiles, benchRefsFor(item))?.runs["npu|burst"]).toBeTruthy();
    // a different model with the same NAME stays unmatched
    const other = { ref: "geniex:other", entry: { id: "other", repo: "x", name: "Llama 3.2 1B" } };
    expect(benchProfileFor(profiles, benchRefsFor(other))).toBeNull();
  });

  it("ignores profiles without usable runs", () => {
    const profiles = parseBenchProfiles({
      calibratedProfiles: {
        "a": { runs: { junk: { compute: "npu", decodeTokPerSec: 0, measuredAt: fresh } } },
        "b": { runs: { ok: { compute: "npu", decodeTokPerSec: 5, measuredAt: fresh } } },
        "c": {},
      },
    });
    expect(Object.keys(profiles)).toEqual(["b"]);
    expect(parseBenchProfiles(null)).toEqual({});
    expect(parseBenchProfiles({})).toEqual({});
  });

  it("displays the newest run for the CURRENT compute target — not the fastest historical run", () => {
    const profile: BenchProfile = {
      runs: {
        "npu|burst": run({ compute: "npu", decodeTokPerSec: 40, measuredAt: "2026-01-01T00:00:00Z" }), // fast, old
        "npu|power_saver": run({ compute: "npu", decodeTokPerSec: 12, measuredAt: fresh }),            // slow, NEW
        "cpu|burst": run({ compute: "cpu", decodeTokPerSec: 3, measuredAt: "2026-05-25T00:00:00Z" }),
      },
    };
    const sel = selectBenchRun(profile, "npu")!;
    expect(sel.basis).toBe("current-compute");
    expect(sel.run.decodeTokPerSec).toBe(12); // newest npu run, though the slowest of the three
    // without a preferred target: the newest run overall (the cpu one, measured later)
    const any = selectBenchRun(profile)!;
    expect(any.basis).toBe("latest");
    expect(any.run.decodeTokPerSec).toBe(3);
    expect(any.run.compute).toBe("cpu");
  });

  it("falls back to the newest run of any target when none match the current one", () => {
    const profile: BenchProfile = { runs: { "cpu|burst": run({ compute: "cpu", decodeTokPerSec: 3, measuredAt: fresh }) } };
    const sel = selectBenchRun(profile, "npu")!;
    expect(sel.basis).toBe("latest");
    expect(sel.run.compute).toBe("cpu");
    expect(selectBenchRun(null, "npu")).toBeNull();
    expect(selectBenchRun({ runs: {} }, "npu")).toBeNull();
  });

  it("flags staleness: age, compute mismatch — and never claims verification without evidence", () => {
    const old = run({ compute: "npu", decodeTokPerSec: 24.6, measuredAt: "2026-01-01T00:00:00Z", verifiedNpu: false });
    const reasons = benchOutdatedReasons(old, { preferredCompute: "npu", now });
    expect(reasons.some((r) => r.includes("days ago"))).toBe(true);
    // compute mismatch only when the current target differs
    expect(benchOutdatedReasons(run({ compute: "npu", decodeTokPerSec: 24.6, measuredAt: fresh }), { preferredCompute: "gpu", now })).toContainEqual(expect.stringContaining("not the current GPU"));
    expect(benchOutdatedReasons(run({ compute: "npu", decodeTokPerSec: 24.6, measuredAt: fresh }), { preferredCompute: "npu", now })).toEqual([]);
    // the detail lines state verification honestly, from the run's own evidence
    const unverified = benchDetailLines(run({ compute: "npu", decodeTokPerSec: 24.6, measuredAt: fresh, verifiedNpu: false })).join(" · ");
    expect(unverified).toContain("NOT verified");
    expect(benchDetailLines(run({ compute: "npu", decodeTokPerSec: 24.6, measuredAt: fresh, verifiedNpu: true })).join(" · ")).toContain("was verified");
  });

  it("the headline is compact and names the compute target", () => {
    expect(benchHeadline(run({ compute: "npu", decodeTokPerSec: 24.55, measuredAt: fresh }))).toBe("Measured here · 24.6 tok/s · NPU");
    expect(benchHeadline(run({ compute: "hybrid", decodeTokPerSec: 18, measuredAt: fresh }))).toBe("Measured here · 18.0 tok/s · CPU + NPU");
    expect(benchDetailLines(run({ compute: "npu", decodeTokPerSec: 24.6, measuredAt: fresh, ttftMs: 210.4 })).join(" · ")).toContain("first token in 210 ms");
  });

  it("a missing or physically impossible TTFT is never displayed as 0 ms — it says not measured", () => {
    // The real Qwen3-0.6B run recorded ttftMs 0.0 (the telemetry line read
    // "0.0 s first token" — no first token can arrive in 0 s), and the detail line
    // rendered "first token in 0 ms": a missing measurement displayed as a fact.
    const impossible = benchDetailLines(run({ compute: "npu", decodeTokPerSec: 135.5, measuredAt: fresh, ttftMs: 0 })).join(" · ");
    expect(impossible).toContain("first token: not measured");
    expect(impossible).not.toContain("0 ms");
    expect(benchDetailLines(run({ compute: "npu", decodeTokPerSec: 135.5, measuredAt: fresh, ttftMs: -5 })).join(" · ")).toContain("first token: not measured");
    // a stored record without the figure at all parses to null, never 0
    expect(parseBenchRun({ compute: "npu", decodeTokPerSec: 24, measuredAt: fresh })!.ttftMs).toBeNull();
  });
});
