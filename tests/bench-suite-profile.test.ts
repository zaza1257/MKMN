import { describe, expect, it } from "vitest";
import { suiteRunRecord, benchProfileFor, benchRefsFor, parseBenchProfiles, relatedVariantRun, selectBenchRun, benchHeadline } from "../src/core/benchStore";

/**
 * The benchmark suite measured a model (13.65 tok/s on the NPU for a Foundry Local build) and the Models
 * list never showed it: only the single-model benchmark wrote the profile the card reads. A suite result
 * now becomes the same record, keyed by the exact build it tested.
 */
// the fields of the real result (benchmarks/2026-11-15_125543-19g/foundry-qwen2.5-coder-1.5b.json)
const foundryResult = {
  key: "foundry:qwen2.5-coder-1.5b", name: "Qwen2.5 Coder 1.5B (Foundry Local)", ref: "qwen2.5-coder-1.5b",
  servedModel: "qwen2.5-coder-1.5b-instruct-qnn-npu:1", servedContext: 4096,
  placement: { runsOn: "npu", evidence: ["NPU memory grew"] },
  speedTrack: { medianTokPerSec: 11 },
  summary: { tokPerSec: 13.65, ttftSec: 0.41 },
} as any;

describe("a benchmark suite result becomes the profile the Models list reads", () => {
  it("keys it to the exact build, with the measured speed and the device", () => {
    const rec = suiteRunRecord(foundryResult)!;
    // the exact build Foundry Local served, not the alias the row is named by
    expect(rec.modelRef).toBe("qwen2.5-coder-1.5b-instruct-qnn-npu:1");
    expect(rec.run).toMatchObject({ compute: "npu", powerMode: "default", decodeTokPerSec: 13.65, ttftMs: 410, nctx: 4096, verifiedNpu: false });
  });
  it("reads as a card line once stored, under the row of that build", () => {
    const rec = suiteRunRecord(foundryResult)!;
    const profiles = parseBenchProfiles({ calibratedProfiles: { [rec.modelRef]: { runs: { "npu|default": { ...rec.run, measuredAt: "2026-11-15T10:00:00Z" } } } } });
    const row = { ref: "qwen2.5-coder-1.5b", entry: { id: "foundry:qwen2.5-coder-1.5b", repo: "qwen2.5-coder-1.5b", foundryBuild: "qwen2.5-coder-1.5b-instruct-qnn-npu:1" } };
    const run = selectBenchRun(benchProfileFor(profiles, benchRefsFor(row)))!.run;
    expect(benchHeadline(run)).toBe("Measured here · 13.7 tok/s · NPU"); // 13.65, as the report shows it
  });
  it("records nothing that was not measured: no device, or no speed", () => {
    expect(suiteRunRecord({ ...foundryResult, placement: { runsOn: "unknown" } })).toBeNull();
    expect(suiteRunRecord({ ...foundryResult, speedTrack: { medianTokPerSec: null }, summary: { tokPerSec: null } })).toBeNull();
    expect(suiteRunRecord({ ...foundryResult, error: "did not load" })).toBeNull();
  });
  it("shows the speed the report shows, and the controlled track's only when the report has none", () => {
    expect(suiteRunRecord({ ...foundryResult, summary: { tokPerSec: null, ttftSec: null } })!.run.decodeTokPerSec).toBe(11);
  });
  it("is not shown on the row once that row stands for another build", () => {
    const rec = suiteRunRecord(foundryResult)!;
    const profiles = parseBenchProfiles({ calibratedProfiles: { [rec.modelRef]: { runs: { "npu|default": { ...rec.run, measuredAt: "2026-11-15T10:00:00Z" } } } } });
    const moved = { ref: "qwen2.5-coder-1.5b", entry: { id: "foundry:qwen2.5-coder-1.5b", repo: "qwen2.5-coder-1.5b", foundryBuild: "qwen2.5-coder-1.5b-instruct-qnn-npu:2" } };
    expect(benchProfileFor(profiles, benchRefsFor(moved))).toBeNull();
  });
  it("keeps a GenieX build's own reference", () => {
    expect(suiteRunRecord({ ...foundryResult, key: "phi", ref: "org/phi-GGUF:Q4_0", servedModel: "org/phi-GGUF:Q4_0" })!.modelRef).toBe("org/phi-GGUF:Q4_0");
  });
  it("names a hybrid run as CPU + NPU, never NPU", () => {
    expect(suiteRunRecord({ ...foundryResult, placement: { runsOn: "mixed" } })!.run.compute).toBe("hybrid");
  });
});

describe("the GenieX row shows the Foundry Local build's result as a related one", () => {
  const profiles = parseBenchProfiles({ calibratedProfiles: { "Phi-4-mini-instruct-qnn-npu:2": { runs: { "npu|default": { compute: "npu", powerMode: "default", decodeTokPerSec: 13.65, ttftMs: 410, tokensGenerated: 64, maxTokens: 64, ngl: -1, nctx: 4096, verifiedNpu: false, measuredAt: "2026-11-15T10:00:00Z" } } } } });
  const geniex = { ref: "microsoft/Phi-4-mini-instruct-GGUF:Q4_0", entry: { id: "phi-4-mini", name: "Phi-4-mini", repo: "microsoft/Phi-4-mini-instruct-GGUF" } };
  const foundry = { ref: "Phi-4-mini-instruct-qnn-npu:2", entry: { id: "foundry:phi-4-mini", name: "Phi-4-mini (Foundry Local)", repo: "Phi-4-mini-instruct-qnn-npu" } };
  it("labels it as the Foundry Local variant's", () => {
    const rel = relatedVariantRun(geniex, [geniex, foundry], profiles)!;
    expect(rel.label).toBe("Foundry Local variant · 13.7 tok/s · NPU");
  });
  it("is not shown when the row has its own measurement, or on the Foundry row itself", () => {
    expect(relatedVariantRun(foundry, [geniex, foundry], profiles)).toBeNull();
    const own = parseBenchProfiles({ calibratedProfiles: { ...{ "Phi-4-mini-instruct-qnn-npu:2": { runs: { "npu|default": { compute: "npu", powerMode: "default", decodeTokPerSec: 13.65, measuredAt: "2026-11-15T10:00:00Z" } } } }, "microsoft/Phi-4-mini-instruct-GGUF:Q4_0": { runs: { "npu|burst": { compute: "npu", powerMode: "burst", decodeTokPerSec: 20, measuredAt: "2026-11-15T10:00:00Z" } } } } });
    expect(relatedVariantRun(geniex, [geniex, foundry], own)).toBeNull();
  });
});

describe("the related result pairs builds as the Models list does", () => {
  it("matches a GenieX name that says Instruct with the Foundry Local alias", () => {
    const profiles = parseBenchProfiles({ calibratedProfiles: { "qwen2.5-coder-1.5b-instruct-qnn-npu:1": { runs: { "npu|default": { compute: "npu", powerMode: "default", decodeTokPerSec: 13.65, measuredAt: "2026-11-15T10:00:00Z" } } } } });
    const geniex = { ref: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_0", entry: { id: "qwen-coder-1.5b", name: "Qwen2.5-Coder-1.5B-Instruct", repo: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF" } };
    const foundry = { ref: "qwen2.5-coder-1.5b", entry: { id: "foundry:qwen2.5-coder-1.5b", name: "Qwen2.5 Coder 1.5B (Foundry Local)", repo: "qwen2.5-coder-1.5b", foundryBuild: "qwen2.5-coder-1.5b-instruct-qnn-npu:1" } };
    expect(relatedVariantRun(geniex, [geniex, foundry], profiles)?.label).toBe("Foundry Local variant · 13.7 tok/s · NPU");
  });
});
