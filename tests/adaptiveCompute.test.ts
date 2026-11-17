import { describe, expect, it } from "vitest";
import { AUTO_GOALS, COMPUTE_LABEL, Candidate, EngineFacts, Measurement, candidatesFor, describeSelection, predictedLatencyMs, selectAuto, selectManual } from "../src/core/adaptiveCompute";

const NOW = 1_800_000_000_000;
const measured = (over: Partial<Measurement> = {}): Measurement => ({
  decodeTokPerSec: 20, ttftMs: 300, mWhPerToken: null, peakRamGB: 2, at: NOW - 60_000, source: "mkmn-bench", ...over,
});
const cand = (over: Partial<Candidate> & { id: string }): Candidate => ({ engine: "geniex", compute: "npu", serveCompute: "npu", measurement: null, ...over });
const facts = (over: Partial<EngineFacts> = {}): EngineFacts => ({ engine: "geniex", isQairt: false, gpuVerified: false, hybridAllowed: true, ...over });
const input = (over: Partial<Parameters<typeof selectAuto>[0]> = {}) => ({
  goal: "balanced" as const,
  candidates: [] as Candidate[],
  battery: { onMains: true, percent: 100 },
  headroomGB: 8,
  residentId: null,
  reloadSec: null,
  contention: { npuBusy: null, gpuBusy: null, samplesFresh: true },
  expectedOutputTokens: 128,
  now: NOW,
  ...over,
});

describe("labels and goals", () => {
  it("hybrid is always CPU + NPU, never GPU", () => {
    expect(COMPUTE_LABEL.hybrid).toBe("CPU + NPU");
    expect(Object.values(COMPUTE_LABEL).filter((l) => /npu/i.test(l) && /gpu/i.test(l))).toEqual([]);
  });
  it("every goal states why, and no goal promises energy it cannot measure", () => {
    for (const g of AUTO_GOALS) {
      expect(g.label.length).toBeGreaterThan(3);
      expect(g.why).toMatch(/measured/);
    }
  });
});

describe("candidatesFor — gating from facts, with reasons", () => {
  it("offers NPU, CPU+NPU hybrid and CPU for a GGUF, and GPU only when placement was verified", () => {
    const { candidates, gatedOut } = candidatesFor({ repo: "org/m" }, facts(), {});
    expect(candidates.map((c) => c.compute).sort()).toEqual(["cpu", "hybrid", "npu"]);
    expect(gatedOut.find((g) => g.compute === "gpu")?.why).toMatch(/never verified/);
  });

  it("a QAIRT bundle is NPU-only: no hybrid, no GPU, no CPU conversion of the bundle", () => {
    const q = facts({ isQairt: true, hybridAllowed: false });
    const { candidates, gatedOut } = candidatesFor({ repo: "qualcomm/x" }, q, {});
    expect(candidates.map((c) => c.compute)).toEqual(["npu"]);
    expect(gatedOut.map((g) => g.compute).sort()).toEqual(["cpu", "gpu", "hybrid"]);
    expect(gatedOut.find((g) => g.compute === "hybrid")?.why).toMatch(/QAIRT/);
  });
});

describe("predictedLatencyMs — TTFT includes prefill, terms never overlap", () => {
  it("adds first-token latency and decode time, once", () => {
    const c = cand({ id: "x", measurement: measured({ decodeTokPerSec: 25, ttftMs: 400 }) });
    expect(predictedLatencyMs(c, 128)).toBe(400 + (128 / 25) * 1000);
  });
  it("is null without a measurement or the rates it needs", () => {
    expect(predictedLatencyMs(cand({ id: "x", measurement: null }), 10)).toBeNull();
    expect(predictedLatencyMs(cand({ id: "x", measurement: measured({ ttftMs: null }) }), 10)).toBeNull();
    expect(predictedLatencyMs(cand({ id: "x", measurement: measured({ decodeTokPerSec: 0 }) }), 10)).toBeNull();
  });
});

describe("selectAuto", () => {
  it("with no measurements anywhere, picks a known-supported default and marks it provisional", () => {
    const sel = selectAuto(input({ candidates: [cand({ id: "geniex:cpu", compute: "cpu", serveCompute: "cpu" }), cand({ id: "geniex:npu", compute: "npu", serveCompute: "npu" })] }));
    expect(sel.config!.id).toBe("geniex:npu");
    expect(sel.provisional).toBe(true);
    expect(sel.reason.join(" ")).toMatch(/provisional/);
  });

  it("battery saver NEVER invents energy: without battery measurements it falls back and says so", () => {
    const cands = [
      cand({ id: "geniex:npu", compute: "npu", serveCompute: "npu", measurement: measured({ decodeTokPerSec: 40, ttftMs: 200 }) }),
      cand({ id: "geniex:cpu", compute: "cpu", serveCompute: "cpu", measurement: measured({ decodeTokPerSec: 5, ttftMs: 900 }) }),
    ];
    const sel = selectAuto(input({ goal: "battery_saver", candidates: cands }));
    expect(sel.config!.id).toBe("geniex:npu"); // the fastest, not a guess at mWh
    expect(sel.reason.join(" ")).toMatch(/no credible whole-task energy measurement/);
    expect(sel.reason.join(" ")).toMatch(/mWh|energy/);
    expect(JSON.stringify(sel)).not.toMatch(/\d+(\.\d+)?\s*mWh\/token/); // no invented number
  });

  it("battery saver picks the lowest MEASURED energy within the latency target", () => {
    const cands = [
      cand({ id: "geniex:npu", compute: "npu", serveCompute: "npu", measurement: measured({ decodeTokPerSec: 40, ttftMs: 200, mWhPerToken: 0.9 }) }),
      cand({ id: "geniex:cpu", compute: "cpu", serveCompute: "cpu", measurement: measured({ decodeTokPerSec: 10, ttftMs: 800, mWhPerToken: 0.4 }) }),
      cand({ id: "geniex:hybrid", compute: "hybrid", serveCompute: "hybrid", measurement: measured({ decodeTokPerSec: 30, ttftMs: 300, mWhPerToken: 0.2 }) }),
    ];
    const sel = selectAuto(input({ goal: "battery_saver", candidates: cands }));
    expect(sel.config!.id).toBe("geniex:hybrid");
    expect(sel.reason.join(" ")).toMatch(/0\.2 mWh\/token/);
    expect(sel.provisional).toBe(false);
  });

  it("fastest picks the lowest predicted end-to-end time", () => {
    const cands = [
      cand({ id: "geniex:npu", compute: "npu", serveCompute: "npu", measurement: measured({ decodeTokPerSec: 40, ttftMs: 200 }) }),
      cand({ id: "geniex:cpu", compute: "cpu", serveCompute: "cpu", measurement: measured({ decodeTokPerSec: 5, ttftMs: 900 }) }),
    ];
    const sel = selectAuto(input({ goal: "fastest", candidates: cands }));
    expect(sel.config!.id).toBe("geniex:npu");
    expect(sel.reason.join(" ")).toMatch(/fastest of 2 measured/);
  });

  it("balanced stays within 1.5x of the fastest when energy is known, else takes the fastest", () => {
    const mk = (id: string, compute: Candidate["compute"], tps: number, mWh: number | null) =>
      cand({ id, compute, serveCompute: compute, measurement: measured({ decodeTokPerSec: tps, ttftMs: 200, mWhPerToken: mWh }) });
    const withEnergy = [mk("geniex:npu", "npu", 40, 0.9), mk("geniex:hybrid", "hybrid", 34, 0.5)];
    expect(selectAuto(input({ candidates: withEnergy })).config!.id).toBe("geniex:hybrid");
    expect(selectAuto(input({ candidates: [mk("geniex:npu", "npu", 40, null), mk("geniex:cpu", "cpu", 20, null)] })).config!.id).toBe("geniex:npu");
  });

  it("residency: the loaded config is kept unless a switch promises a sustained (>25%) gain", () => {
    const cands = [
      cand({ id: "geniex:npu", compute: "npu", serveCompute: "npu", measurement: measured({ decodeTokPerSec: 40, ttftMs: 200 }) }),
      cand({ id: "geniex:cpu", compute: "cpu", serveCompute: "cpu", measurement: measured({ decodeTokPerSec: 36, ttftMs: 220 }) }), // only 10% slower
    ];
    const sel = selectAuto(input({ candidates: cands, residentId: "geniex:cpu", reloadSec: 4 }));
    expect(sel.config!.id).toBe("geniex:cpu");
    expect(sel.reason.join(" ")).toMatch(/staying resident|already resident/);
    // a big gain does switch, despite the reload
    const big = [cands[0], cand({ id: "geniex:cpu", compute: "cpu", serveCompute: "cpu", measurement: measured({ decodeTokPerSec: 5, ttftMs: 900 }) })];
    const sel2 = selectAuto(input({ candidates: big, residentId: "geniex:cpu", reloadSec: 4 }));
    expect(sel2.config!.id).toBe("geniex:npu");
  });

  it("cooldown: a switch inside the window keeps the resident config", () => {
    const cands = [
      cand({ id: "geniex:npu", compute: "npu", serveCompute: "npu", measurement: measured({ decodeTokPerSec: 40, ttftMs: 200 }) }),
      cand({ id: "geniex:cpu", compute: "cpu", serveCompute: "cpu", measurement: measured({ decodeTokPerSec: 5, ttftMs: 900 }) }),
    ];
    const sel = selectAuto(input({ candidates: cands, residentId: "geniex:cpu", lastSwitch: { at: NOW - 10_000, toId: "geniex:cpu" } }));
    expect(sel.config!.id).toBe("geniex:cpu");
    expect(sel.reason.join(" ")).toMatch(/cooldown/);
    // …but the window expires
    const sel2 = selectAuto(input({ candidates: cands, residentId: "geniex:cpu", lastSwitch: { at: NOW - 300_000, toId: "geniex:cpu" } }));
    expect(sel2.config!.id).toBe("geniex:npu");
  });

  it("memory: a config that needs more RAM than the headroom is refused with its reason, not silently dropped", () => {
    const cands = [
      cand({ id: "geniex:npu", compute: "npu", serveCompute: "npu", measurement: measured({ peakRamGB: 6 }) }),
      cand({ id: "geniex:cpu", compute: "cpu", serveCompute: "cpu", measurement: measured({ peakRamGB: 1, decodeTokPerSec: 5, ttftMs: 900 }) }),
    ];
    const sel = selectAuto(input({ candidates: cands, headroomGB: 3 }));
    expect(sel.config!.id).toBe("geniex:cpu");
    expect(sel.gatedOut.find((g) => g.id === "geniex:npu")?.why).toMatch(/headroom/);
  });

  it("contention: a busy NPU (owned counters, fresh) refuses NPU and CPU+NPU paths — never utilization-rate guesses", () => {
    const cands = [
      cand({ id: "geniex:npu", compute: "npu", serveCompute: "npu", measurement: measured() }),
      cand({ id: "geniex:hybrid", compute: "hybrid", serveCompute: "hybrid", measurement: measured() }),
      cand({ id: "geniex:cpu", compute: "cpu", serveCompute: "cpu", measurement: measured({ decodeTokPerSec: 5, ttftMs: 900 }) }),
    ];
    const sel = selectAuto(input({ candidates: cands, contention: { npuBusy: true, gpuBusy: false, samplesFresh: true } }));
    expect(sel.config!.id).toBe("geniex:cpu");
    expect(sel.gatedOut.map((g) => g.id).sort()).toEqual(["geniex:hybrid", "geniex:npu"]);
    expect(sel.gatedOut[0].why ?? sel.gatedOut[1].why).toMatch(/NPU is busy/);
  });

  it("stale monitoring samples read as UNKNOWN, not as a free device: nothing is rejected on absent data", () => {
    const cands = [cand({ id: "geniex:npu", compute: "npu", serveCompute: "npu", measurement: measured() })];
    const sel = selectAuto(input({ candidates: cands, contention: { npuBusy: null, gpuBusy: null, samplesFresh: false } }));
    expect(sel.config!.id).toBe("geniex:npu"); // not rejected for data we do not have
    expect(sel.reason.join(" ")).toMatch(/stale/);
  });

  it("returns a null config with an explanation when nothing passes, never a silent guess", () => {
    const cands = [cand({ id: "geniex:npu", compute: "npu", serveCompute: "npu", measurement: measured({ peakRamGB: 6 }) })];
    const sel = selectAuto(input({ candidates: cands, headroomGB: 1 }));
    expect(sel.config).toBeNull();
    expect(sel.reason[0]).toMatch(/No supported configuration/);
  });
});

describe("selectManual", () => {
  it("honors an explicit pick and reports its measurement", () => {
    const cands = [
      cand({ id: "geniex:npu", compute: "npu", serveCompute: "npu", measurement: measured() }),
      cand({ id: "geniex:cpu", compute: "cpu", serveCompute: "cpu", measurement: null }),
    ];
    const sel = selectManual(cands, [], "cpu", input({ candidates: cands }));
    expect(sel.config!.id).toBe("geniex:cpu");
    expect(sel.provisional).toBe(true);
    expect(sel.reason.join(" ")).toMatch(/chosen manually/);
  });

  it("refuses an unsupported pick with the gate's reason, and never reinterprets it", () => {
    const { candidates, gatedOut } = candidatesFor({ repo: "qualcomm/x" }, facts({ isQairt: true, hybridAllowed: false }), {});
    const sel = selectManual(candidates, gatedOut, "hybrid", input({ candidates }));
    expect(sel.config).toBeNull();
    expect(sel.reason.join(" ")).toMatch(/QAIRT bundle is a compiled NPU artifact/);
  });

  it("refuses a pick the current constraints gate out (busy NPU), with the reason", () => {
    const cands = [cand({ id: "geniex:npu", compute: "npu", serveCompute: "npu", measurement: measured() })];
    const sel = selectManual(cands, [], "npu", input({ candidates: cands, contention: { npuBusy: true, gpuBusy: null, samplesFresh: true } }));
    expect(sel.config).toBeNull();
    expect(sel.reason.join(" ")).toMatch(/NPU is busy/);
  });
});

describe("describeSelection", () => {
  it("one line: engine · device · measured/provisional", () => {
    const sel = selectAuto(input({ candidates: [cand({ id: "geniex:npu", compute: "npu", serveCompute: "npu", measurement: measured() })] }));
    expect(describeSelection(sel)).toMatch(/^GenieX · NPU · selected from this device's measurements$/);
    const p = selectAuto(input({ candidates: [cand({ id: "geniex:cpu", compute: "cpu", serveCompute: "cpu" })] }));
    expect(describeSelection(p)).toMatch(/^GenieX · CPU · provisional$/);
    expect(describeSelection({ config: null, reason: ["nothing available"], provisional: true, gatedOut: [] })).toBe("nothing available");
  });
});
