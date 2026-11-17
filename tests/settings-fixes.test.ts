import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  benchmarkTargets, normalizeBenchTarget, calibrationResetPatch, createSaveFeedback,
  createEstimateGate, estimateConfigKey, radioMove, dictationLanguageOptions,
  DICTATION_LANGUAGES, filesOpenBesideChat,
} from "../src/core/settingsUi";
import { reconcileContextSettings } from "../src/shared/settings";
import { DEFAULT_VOICE_SETTINGS, VOICE_LIMITS } from "../src/core/voiceModels";
import { llamaArgs } from "../src/core/runtime";
import type { MemoryEstimate } from "../src/shared/types";

const est = (over: Partial<MemoryEstimate> = {}): MemoryEstimate => ({
  weightsGB: 4, kvCacheGB: 1, scratchpadGB: 0.5, totalRequiredGB: 5.5,
  availableRamGB: 12, totalRamGB: 32, fits: true, ...over,
} as MemoryEstimate);

// ---------------------------------------------------------------- 1. benchmark targets

describe("benchmark targets follow the model's engine", () => {
  it("offers hybrid for a GGUF model, only the NPU for a compiled bundle", () => {
    expect(benchmarkTargets("llama_cpp").map((t) => t.id)).toEqual(["npu", "hybrid"]);
    expect(benchmarkTargets(undefined).map((t) => t.id)).toEqual(["npu", "hybrid"]); // unknown engine: the safe default set
    expect(benchmarkTargets("qairt").map((t) => t.id)).toEqual(["npu"]);
  });

  it("normalizes a hybrid choice away when the model changes to a compiled bundle (GGUF hybrid → QAIRT)", () => {
    // the state held "hybrid" for a GGUF model…
    expect(normalizeBenchTarget("hybrid", "llama_cpp")).toBe("hybrid");
    // …and the SAME state must never be submitted for a QAIRT model
    expect(normalizeBenchTarget("hybrid", "qairt")).toBe("npu");
    expect(normalizeBenchTarget("npu", "qairt")).toBe("npu");
    // an unknown value falls back to the one target every model has
    expect(normalizeBenchTarget("gpu", "llama_cpp")).toBe("npu");
    expect(normalizeBenchTarget(undefined, "llama_cpp")).toBe("npu");
  });

  it("normalizes again at run time: runBenchmark would never submit hybrid for a compiled bundle", () => {
    // the double check the run path performs (select normalization + pre-run validation)
    const stateHeldFromAnotherModel = "hybrid";
    const engine = "qairt";
    const target = normalizeBenchTarget(stateHeldFromAnotherModel, engine);
    expect(target).toBe("npu");
    expect(target === stateHeldFromAnotherModel).toBe(false); // the state is corrected before the call
  });
});

// ---------------------------------------------------------------- 2. save-feedback races

describe("save feedback under overlapping saves", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a new save cancels the previous dismissal timer", async () => {
    const s = createSaveFeedback();
    await s.attempt("a", () => Promise.resolve());
    expect(s.get().transient).toEqual({ tone: "ok", text: "Saved" });
    // a second save begins while the first "Saved" is still counting down, and stays busy
    let releaseB!: () => void;
    const b = new Promise((r) => { releaseB = r; });
    void s.attempt("b", () => b);
    expect(s.get().transient).toEqual({ tone: "busy", text: "Saving b…" });
    vi.advanceTimersByTime(2500);
    // the first save's dismissal timer must not have cleared the second save's feedback
    expect(s.get().transient).toEqual({ tone: "busy", text: "Saving b…" });
    releaseB!();
    await Promise.resolve(); await Promise.resolve();
    expect(s.get().transient).toEqual({ tone: "ok", text: "Saved" });
    vi.advanceTimersByTime(2500);
    expect(s.get().transient).toBeNull();
  });

  it("an older completion never overwrites newer feedback (out-of-order saves)", async () => {
    const s = createSaveFeedback();
    let releaseA: ((v?: unknown) => void) | undefined;
    const a = new Promise((r) => { releaseA = r; });
    const attemptA = s.attempt("a", () => a);
    const attemptB = s.attempt("b", () => Promise.resolve()); // finishes first
    expect(s.get().transient).toEqual({ tone: "busy", text: "Saving b…" });
    releaseA!(); // A (older) completes LAST
    await Promise.all([attemptA, attemptB]);
    vi.advanceTimersByTime(2500);
    // A's stale completion must not resurrect "Saving a…" or "Saved" over B's state
    expect(s.get().transient).toBeNull();
    expect(s.get().failures).toEqual([]);
  });

  it("each unresolved failure stays visible with its own Retry — a later failure or success of a DIFFERENT setting never erases it", async () => {
    const s = createSaveFeedback();
    const failing = () => Promise.reject(new Error("disk full"));
    const ok = () => Promise.resolve();
    await s.attempt("settings (threads)", failing);
    await s.attempt("settings (appearance)", failing); // a second, different setting fails
    expect(s.get().failures).toHaveLength(2);
    expect(s.get().failures[0].text).toContain("Saving settings (threads) failed: disk full");
    expect(s.get().failures[1].text).toContain("Saving settings (appearance) failed: disk full");
    expect(s.get().transient).toBeNull();

    // a different, successful save afterwards must not conceal either failure
    await s.attempt("the theme", ok);
    expect(s.get().transient).toEqual({ tone: "ok", text: "Saved" });
    expect(s.get().failures).toHaveLength(2);

    // Retry re-runs exactly ITS OWN failed operation
    s.get().failures[0].retry();
    await vi.runAllTimersAsync();
    expect(s.get().failures).toHaveLength(2); // still failing: the retry re-ran it
    s.dismissFailure(s.get().failures[0].id);
    expect(s.get().failures).toHaveLength(1); // only the dismissed one goes
    expect(s.get().failures[0].text).toContain("appearance");
    s.dismiss();
    expect(s.get().failures).toEqual([]);
    expect(s.get().transient).toBeNull();
  });

  it("a retried failure that succeeds clears the failure and shows Saved", async () => {
    const s = createSaveFeedback();
    let fail = true;
    const op = vi.fn(async () => { if (fail) { fail = false; throw new Error("offline"); } });
    await s.attempt("settings", op);
    expect(s.get().failures).toHaveLength(1);
    s.get().failures[0].retry(); // re-runs `op`, which now succeeds — the failure resolves WITHOUT new input
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(s.get().failures).toEqual([]);
    expect(s.get().transient?.tone).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("a stale FAILURE still registers (the operation really failed) and survives the newer save's success", async () => {
    const s = createSaveFeedback();
    let releaseA: (() => void) | undefined;
    const a = new Promise((_, rej) => { releaseA = () => rej(new Error("older failed")); });
    const attemptA = s.attempt("a", () => a);
    const attemptB = s.attempt("b", () => new Promise((r) => setTimeout(r, 100)));
    releaseA!(); // A (older) fails while B is still in flight
    await attemptA; // the rejection is handled inside the store; let it settle
    expect(s.get().failures[0]?.text).toContain("Saving a failed");
    // A's failure did not overwrite the newest attempt's busy line (separate slots)
    expect(s.get().transient?.text).toContain("Saving b…");
    vi.advanceTimersByTime(100);
    await Promise.allSettled([attemptA, attemptB]);
    // B succeeds — and the success must NOT conceal A's failure (different settings)
    expect(s.get().transient?.tone).toBe("ok");
    expect(s.get().failures[0]?.text).toContain("Saving a failed");
  });

  it("a newer save of the SAME setting supersedes the older failure: its retry must not overwrite the newer choice", async () => {
    const s = createSaveFeedback();
    const saved: string[] = [];
    let fail = true;
    const stale = vi.fn(async () => {
      if (fail) { fail = false; throw new Error("offline"); }
      saved.push("stale patch 30");
    });
    await s.attempt("settings (threads)", stale, "settings:threads");
    expect(s.get().failures).toHaveLength(1);
    const staleRetry = s.get().failures[0].retry;
    // the user fixes the value and saves the SAME setting successfully while the failure is up
    await s.attempt("settings (threads)", async () => { saved.push("newer patch 50"); }, "settings:threads");
    // the newer success resolved the older failure: keeping its Retry would offer a
    // patch that silently overwrites the newer choice
    expect(s.get().failures).toEqual([]);
    // even a captured stale retry closure is refused (it would re-save the old value)
    staleRetry();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(saved).toEqual(["newer patch 50"]);
  });

  it("a newer FAILURE of the same setting replaces the older one (the older patch is outdated)", async () => {
    const s = createSaveFeedback();
    await s.attempt("settings (threads)", () => Promise.reject(new Error("offline")), "settings:threads");
    expect(s.get().failures).toHaveLength(1);
    await s.attempt("settings (threads)", () => Promise.reject(new Error("disk full")), "settings:threads");
    expect(s.get().failures).toHaveLength(1);
    expect(s.get().failures[0].text).toContain("disk full");
    // a different setting failing in between would have added its own entry
  });
});

// ---------------------------------------------------------------- 3. calibration reset

describe("calibration reset restores the actual defaults", () => {
  it("returns every calibration field to DEFAULT_VOICE_SETTINGS (no duplicated hardcoded numbers)", () => {
    const patch = calibrationResetPatch();
    expect(patch.minLevel).toBe(DEFAULT_VOICE_SETTINGS.minLevel);
    expect(patch.interruptLevel).toBe(DEFAULT_VOICE_SETTINGS.interruptLevel);
    expect(patch.interruptMs).toBe(DEFAULT_VOICE_SETTINGS.interruptMs);
    expect(patch.minSpeechMs).toBe(DEFAULT_VOICE_SETTINGS.minSpeechMs);
    expect(patch.endSilenceMs).toBe(DEFAULT_VOICE_SETTINGS.endSilenceMs);
    expect(patch.waitMs).toBe(DEFAULT_VOICE_SETTINGS.waitMs);
    expect(Object.keys(patch).sort()).toEqual(["endSilenceMs", "interruptLevel", "interruptMs", "minLevel", "minSpeechMs", "waitMs"]);
  });

  it("the defaults are within the limits the sliders enforce", () => {
    const d = calibrationResetPatch();
    for (const k of ["minLevel", "interruptLevel", "interruptMs", "minSpeechMs", "endSilenceMs", "waitMs"] as const) {
      const lim = VOICE_LIMITS[k];
      expect(d[k]).toBeGreaterThanOrEqual(lim.min);
      expect(d[k]).toBeLessThanOrEqual(lim.max);
    }
  });
});

// ---------------------------------------------------------------- 4. memory estimate gate

describe("memory estimate gate: loading, failure, freshness, out-of-order", () => {
  it("starts loading, becomes ready with the answer", async () => {
    const gate = createEstimateGate(() => Promise.resolve(est()));
    gate.request("m1", 4096, "f16");
    expect(gate.get().phase).toBe("loading");
    await Promise.resolve(); await Promise.resolve();
    expect(gate.get().phase).toBe("ready");
    expect(gate.get().est?.weightsGB).toBe(4);
  });

  it("a failed request shows a failed phase with Retry — never an endless 'Measuring…'", async () => {
    let fail = true;
    const gate = createEstimateGate(() => fail ? Promise.reject(new Error("no estimator")) : Promise.resolve(est()));
    gate.request("m1");
    await Promise.resolve(); await Promise.resolve();
    expect(gate.get().phase).toBe("failed");
    expect(gate.get().canRetry).toBe(true);
    expect(gate.get().est).toBeNull();

    fail = false;
    gate.retry(); // asks the same configuration again
    await Promise.resolve(); await Promise.resolve();
    expect(gate.get().phase).toBe("ready");
  });

  it("never shows a previous model's estimate as the new model's result: it is marked stale", async () => {
    let answer = est({ weightsGB: 4 });
    const gate = createEstimateGate(() => Promise.resolve(answer));
    gate.request("model-a");
    await Promise.resolve(); await Promise.resolve();
    expect(gate.get().key).toBe(estimateConfigKey("model-a"));
    expect(gate.get().est?.weightsGB).toBe(4);

    answer = est({ weightsGB: 9 });
    gate.request("model-b"); // different model: old numbers stay only as clearly-stale
    expect(gate.get().phase).toBe("stale");
    expect(gate.get().est?.weightsGB).toBe(4); // still the OLD numbers, never the new answer
    await Promise.resolve(); await Promise.resolve();
    expect(gate.get().phase).toBe("ready");
    expect(gate.get().est?.weightsGB).toBe(9);
    expect(gate.get().key).toBe(estimateConfigKey("model-b"));
  });

  it("an out-of-order response cannot replace a newer result", async () => {
    let releaseSlow: ((e: MemoryEstimate) => void) | undefined;
    const gate = createEstimateGate((ref) => ref === "slow" ? new Promise<MemoryEstimate>((r) => { releaseSlow = r; }) : Promise.resolve(est({ weightsGB: 2 })));
    gate.request("slow");
    await Promise.resolve(); await Promise.resolve();
    gate.request("fast");
    await Promise.resolve(); await Promise.resolve();
    expect(gate.get().phase).toBe("ready");
    expect(gate.get().est?.weightsGB).toBe(2);
    releaseSlow!(est({ weightsGB: 77 })); // the slow answer lands LAST
    await Promise.resolve(); await Promise.resolve();
    expect(gate.get().est?.weightsGB).toBe(2); // dropped: the newer request owns the display
  });

  it("a same-configuration refresh shows refreshing, then updates; an unusable answer is unavailable", async () => {
    let answer = est();
    const gate = createEstimateGate(() => Promise.resolve(answer));
    gate.request("m1", 2048, "f16");
    await Promise.resolve(); await Promise.resolve();
    gate.request("m1", 2048, "f16"); // same key: refresh in flight, old numbers visible
    expect(gate.get().phase).toBe("refreshing");
    expect(gate.get().est).not.toBeNull();
    await Promise.resolve(); await Promise.resolve();
    expect(gate.get().phase).toBe("ready");

    answer = est({ weightsGB: 0, totalRequiredGB: 0 });
    gate.request("m1", 2048, "f16");
    await Promise.resolve(); await Promise.resolve();
    expect(gate.get().phase).toBe("unavailable");
  });

  it("a refresh failure on the same key keeps the previous numbers, marked failed with retry", async () => {
    let fail = false;
    const gate = createEstimateGate(() => fail ? Promise.reject(new Error("x")) : Promise.resolve(est()));
    gate.request("m1");
    await Promise.resolve(); await Promise.resolve();
    fail = true;
    gate.request("m1");
    await Promise.resolve(); await Promise.resolve();
    expect(gate.get().phase).toBe("failed");
    expect(gate.get().est).not.toBeNull(); // previous numbers for the SAME configuration are kept
    expect(gate.get().canRetry).toBe(true);
  });
});

// ---------------------------------------------------------------- 5. context/cache migration + effective args

describe("context/cache reconciliation (runtime.* → top level)", () => {
  it("folds kvType and kvInRam up and drops the duplicates", () => {
    const r = reconcileContextSettings({ runtime: { threads: 4, kvType: "q8_0", kvInRam: true } });
    expect(r.changed).toBe(true);
    expect(r.next.kvType).toBe("q8_0");
    expect(r.next.kvInRam).toBe(true);
    expect((r.next.runtime as Record<string, unknown>).threads).toBe(4);
    expect((r.next.runtime as Record<string, unknown>).kvType).toBeUndefined();
  });

  it("an existing top-level choice wins; the duplicate is dropped", () => {
    const r = reconcileContextSettings({ kvType: "q4_0", runtime: { kvType: "q8_0" } });
    expect(r.changed).toBe(true);
    expect(r.next.kvType).toBe("q4_0");
  });

  it("copies runtime.ctx up only for the offered window sizes; other values stay llama-only", () => {
    const moved = reconcileContextSettings({ runtime: { ctx: 4096 } });
    expect(moved.next.nctxMode).toBe("4096");
    expect(moved.next.runtime).toBeUndefined();

    const kept = reconcileContextSettings({ runtime: { ctx: 3072 } });
    expect(kept.next.nctxMode).toBeUndefined();
    expect((kept.next.runtime as Record<string, unknown>).ctx).toBe(3072);

    const zero = reconcileContextSettings({ runtime: { ctx: 0 } });
    expect(zero.next.runtime).toBeUndefined();
  });

  it("a clean file is untouched", () => {
    const clean = { nctxMode: "4096", kvType: "f16", kvInRam: false, runtime: { threads: 6 } };
    const r = reconcileContextSettings(clean);
    expect(r.changed).toBe(false);
    expect(r.next).toEqual(clean);
  });

  it("the effective llama arguments agree with the top-level settings after the fold", () => {
    // what ensureLlamaFor now builds: top-level values folded into rt
    const saved = { kvType: "q8_0", kvInRam: true, nctxMode: "4096", runtime: { threads: 6 } as Record<string, unknown> };
    const r = reconcileContextSettings(saved);
    const settings = r.next as unknown as { kvType?: string; kvInRam?: boolean; nctxMode?: string; runtime?: Record<string, unknown> };
    const rt = { ...settings.runtime, kvType: settings.kvType, kvInRam: settings.kvInRam };
    const chosenCtx = settings.nctxMode && settings.nctxMode !== "auto" ? parseInt(settings.nctxMode, 10) : undefined;
    const a = llamaArgs({ model: "m.gguf", host: "127.0.0.1:18183", ctx: chosenCtx ?? 8192, target: "gpu", rt });
    expect(a[a.indexOf("-c") + 1]).toBe("4096"); // the top-level context window is effective
    expect(a).toEqual(expect.arrayContaining(["-ctk", "q8_0", "-ctv", "q8_0", "--no-kv-offload"]));
  });
});

// ---------------------------------------------------------------- 6. radio groups

describe("radio group keyboard movement", () => {
  it("arrows step and wrap; Home and End jump", () => {
    expect(radioMove(3, 0, "ArrowRight")).toBe(1);
    expect(radioMove(3, 2, "ArrowRight")).toBe(0); // wrap
    expect(radioMove(3, 1, "ArrowLeft")).toBe(0);
    expect(radioMove(3, 0, "ArrowLeft")).toBe(2); // wrap
    expect(radioMove(3, 1, "ArrowDown")).toBe(2);
    expect(radioMove(3, 1, "ArrowUp")).toBe(0);
    expect(radioMove(3, 2, "Home")).toBe(0);
    expect(radioMove(3, 0, "End")).toBe(2);
    expect(radioMove(3, 1, "Space")).toBe(1); // other keys: no movement
  });

  it("clamps an out-of-range position instead of escaping the group", () => {
    expect(radioMove(3, 99, "ArrowRight")).toBe(0); // clamped to the last choice, then wraps
    expect(radioMove(3, -5, "ArrowLeft")).toBe(2); // clamped to the first, then wraps
    expect(radioMove(0, 0, "ArrowRight")).toBe(0);
  });
});

// ---------------------------------------------------------------- 7. dictation languages

describe("dictation language options follow the selected model", () => {
  const m = (languages: string) => ({ id: "x", kind: "stt" as const, name: "x", family: "x", archive: "x", sizeMB: 1, languages });

  it("a multilingual model offers the full list, auto-detect first", () => {
    const opts = dictationLanguageOptions(m("99 languages"), "");
    expect(opts[0]).toEqual({ code: "", label: "Auto-detect" });
    expect(opts.map((o) => o.code)).toContain("ar");
    expect(opts.length).toBe(DICTATION_LANGUAGES.length + 1);
  });

  it("an English-only model offers only English (plus auto-detect)", () => {
    const opts = dictationLanguageOptions(m("English"), "");
    expect(opts.map((o) => o.code)).toEqual(["", "en"]);
  });

  it("a European model offers the European subset", () => {
    const opts = dictationLanguageOptions(m("25 European languages"), "");
    expect(opts.map((o) => o.code)).toEqual(["", "en"]);
  });

  it("a saved language the new model does not support is kept, marked as saved", () => {
    const opts = dictationLanguageOptions(m("English"), "ar");
    const ar = opts.find((o) => o.code === "ar");
    expect(ar?.label).toContain("saved");
    expect(ar?.saved).toBe(true);
  });

  it("no model selected: the full list, and any saved language stays offered", () => {
    expect(dictationLanguageOptions(null, "").map((o) => o.code)).toEqual(["", "en", "ar"]);
    const opts = dictationLanguageOptions(undefined, "ar");
    expect(opts.find((o) => o.code === "ar")?.saved).toBeUndefined(); // supported by the list
  });
});

describe("the files-beside-the-chat switch", () => {
  it("is on when the setting was never saved and when it is explicitly on", () => {
    expect(filesOpenBesideChat({})).toBe(true);
    expect(filesOpenBesideChat({ openFilesBesideChat: true })).toBe(true);
  });

  it("is off only when the person turned it off", () => {
    expect(filesOpenBesideChat({ openFilesBesideChat: false })).toBe(false);
  });
});
