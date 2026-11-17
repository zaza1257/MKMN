import { describe, expect, it } from "vitest";
import {
  EVIDENCE_HINTS,
  EVIDENCE_KINDS,
  EVIDENCE_LABELS,
  type EvidenceRecord,
  type EvidenceContext,
  evidenceState,
  evidenceStates,
  manifestRefFor,
  recordFor,
  recommendedDefault,
  tierChoices,
  tierOfParams,
  TIERS,
} from "../src/core/manifest";

const HERE: EvidenceContext = { machine: "Snapdragon X2 Elite X2E88100, 32 GB", runtimeVersion: "0.10.0" };
const OTHER: EvidenceContext = { machine: "Snapdragon X Plus X1P64100, 16 GB", runtimeVersion: "0.10.0" };

const rec = (over: Partial<EvidenceRecord>): EvidenceRecord => ({
  id: `${over.kind}:${over.ref}`,
  kind: "quality-evaluated",
  ref: "qualcomm/Qwen3-4B",
  asOf: "2026-11-06T10:00:00Z",
  machine: HERE.machine,
  runtimeVersion: HERE.runtimeVersion,
  ...over,
});

describe("evidence kinds contract", () => {
  it("pins the five specific kinds — no vague tested/verified", () => {
    expect(EVIDENCE_KINDS).toEqual([
      "download-verified",
      "compatible-metadata",
      "loaded-on-device",
      "quality-evaluated",
      "performance-measured",
    ]);
    for (const kind of EVIDENCE_KINDS) {
      expect(EVIDENCE_LABELS[kind]).toBeTruthy();
      expect(EVIDENCE_LABELS[kind].toLowerCase()).not.toContain("tested");
      expect(EVIDENCE_LABELS[kind].toLowerCase()).not.toBe("verified");
    }
  });

  it("every kind has a hint explaining the concrete claim", () => {
    for (const kind of EVIDENCE_KINDS) {
      expect(EVIDENCE_HINTS[kind].length).toBeGreaterThan(10);
    }
  });
});

describe("staleness rules", () => {
  it("a record from ANOTHER machine is stale, never current verification", () => {
    const shipped = rec({ ref: "qualcomm/Qwen3-4B", machine: OTHER.machine, result: { quality: 80 } });
    const state = evidenceState(shipped, HERE);
    expect(state.state).toBe("stale");
    expect(state.state === "stale" && state.reason).toMatch(/Snapdragon X Plus/);
  });

  it("a record from an older runtime is stale", () => {
    const old = rec({ runtimeVersion: "0.9.0" });
    const state = evidenceState(old, HERE);
    expect(state.state).toBe("stale");
    expect(state.state === "stale" && state.reason).toContain("0.9.0");
  });

  it("a record for a changed artifact (size/revision) is stale", () => {
    const r = rec({ result: { totalBytes: 100, revision: 5 } });
    expect(evidenceState(r, HERE, { totalBytes: 100, revision: 5 }).state).toBe("present");
    expect(evidenceState(r, HERE, { totalBytes: 200, revision: 5 }).state).toBe("stale");
    expect(evidenceState(r, HERE, { totalBytes: 100, revision: 6 }).state).toBe("stale");
    // An artifact with no revision yet cannot contradict the record.
    expect(evidenceState(r, HERE, { totalBytes: 100 }).state).toBe("present");
  });

  it("machine comparison ignores punctuation and case", () => {
    const r = rec({ machine: "Snapdragon  X2-Elite (X2E88100), 32 GB" });
    expect(evidenceState(r, HERE).state).toBe("present");
  });

  it("evidenceStates covers all five kinds for one artifact", () => {
    const states = evidenceStates([], "qualcomm/Qwen3-4B", HERE);
    expect(states.map((s) => s.kind)).toEqual(EVIDENCE_KINDS);
    expect(states.every((s) => s.state.state === "absent")).toBe(true);
  });

  it("recordFor picks the LATEST record and matches refs canonically", () => {
    const older = rec({ asOf: "2026-11-05T10:00:00Z", result: { quality: 70 } });
    const newer = rec({ asOf: "2026-11-06T10:00:00Z", result: { quality: 90 } });
    const suite = rec({ asOf: "2026-11-06T11:00:00Z", id: "quality-evaluated:tournament:qualcomm/Qwen3-4B", result: { quality: 95 } });
    expect(recordFor([older, newer], "qualcomm/qwen3-4b", "quality-evaluated")?.result).toEqual({ quality: 90 });
    expect(recordFor([older, newer, suite], "qualcomm/Qwen3-4B", "quality-evaluated")?.result).toEqual({ quality: 95 });
    expect(recordFor([older], "qualcomm/Qwen3-4B", "performance-measured")).toBeUndefined();
  });
});

describe("tiers", () => {
  it("groups by parameter count: efficiency ≤2.5B, balanced 2.5–5.5B, quality >5.5B", () => {
    expect(tierOfParams(0.6)).toBe("efficiency");
    expect(tierOfParams(2.5)).toBe("efficiency");
    expect(tierOfParams(4)).toBe("balanced");
    expect(tierOfParams(5.5)).toBe("balanced");
    expect(tierOfParams(8)).toBe("quality");
    expect(tierOfParams(27)).toBe("quality");
    expect(tierOfParams(undefined)).toBeNull();
    expect(tierOfParams(0)).toBeNull();
  });

  it("orders candidates smallest-first — never biggest-that-fits", () => {
    const entries = [
      { ref: "a/8b", plugin: "qairt", precisions: ["W4A16"], totalBytes: 1, paramsB: 8 },
      { ref: "a/1.7b", plugin: "qairt", precisions: ["W4A16"], totalBytes: 1, paramsB: 1.7 },
      { ref: "a/4b", plugin: "qairt", precisions: ["W4A16"], totalBytes: 1, paramsB: 4 },
      { ref: "a/2b", plugin: "llama_cpp", precisions: ["Q4_0"], totalBytes: 1, paramsB: 2 },
    ];
    const choices = tierChoices(entries, [], HERE);
    expect(choices.quality.candidates.map((c) => c.ref)).toEqual(["a/8b"]);
    expect(choices.balanced.candidates.map((c) => c.ref)).toEqual(["a/4b"]);
    expect(choices.efficiency.candidates.map((c) => c.ref)).toEqual(["a/1.7b", "a/2b"]);
  });

  it("every tier without a current quality record here is provisional", () => {
    const entries = [{ ref: "qualcomm/Qwen3-4B", plugin: "qairt", precisions: ["W4A16"], totalBytes: 1, paramsB: 4 }];
    const stale = tierChoices(entries, [rec({ machine: OTHER.machine })], HERE);
    expect(stale.balanced.provisional).toBe(true);
    expect(stale.balanced.candidates[0].provisional).toBe(true);
    expect(stale.balanced.candidates[0].provisionalReason).toBeTruthy();
  });

  it("performance evidence alone does NOT lift provisional — quality is the gate", () => {
    const entries = [{ ref: "qualcomm/Qwen3-4B", plugin: "qairt", precisions: ["W4A16"], totalBytes: 1, paramsB: 4 }];
    const perf = tierChoices(entries, [rec({ kind: "performance-measured", result: { tokPerSec: 20 } })], HERE);
    expect(perf.balanced.provisional).toBe(true);
  });
});

describe("recommendedDefault", () => {
  const entries = [
    { ref: "qualcomm/Qwen3-4B", name: "Qwen3-4B", plugin: "qairt", precisions: ["W4A16"], totalBytes: 1, paramsB: 4 },
    { ref: "qualcomm/Qwen3-8B", name: "Qwen3-8B", plugin: "qairt", precisions: ["W4A16"], totalBytes: 1, paramsB: 8 },
    { ref: "qualcomm/Qwen3-1.7B", name: "Qwen3-1.7B", plugin: "qairt", precisions: ["W4A16"], totalBytes: 1, paramsB: 1.7 },
  ];

  it("picks the SMALLEST tier that has a quality-evaluated-here candidate", () => {
    // Quality evidence only on the 8B → 8B is the honest default, even though 1.7B and 4B exist.
    const records = [rec({ ref: "qualcomm/Qwen3-8B", result: { passed: 17, total: 20 } })];
    const d = recommendedDefault(entries, records, HERE);
    expect(d).toMatchObject({ ref: "qualcomm/Qwen3-8B", tier: "quality" });
  });

  it("prefers the smallest qualified tier over a bigger one", () => {
    const records = [
      rec({ ref: "qualcomm/Qwen3-4B", result: { passed: 16, total: 20 } }),
      rec({ ref: "qualcomm/Qwen3-8B", result: { passed: 18, total: 20 } }),
    ];
    const d = recommendedDefault(entries, records, HERE);
    expect(d).toMatchObject({ ref: "qualcomm/Qwen3-4B", tier: "balanced" });
  });

  it("an evaluation UNDER the quality bar does not qualify — evaluated is not good enough", () => {
    // 1.7B evaluated here at 4/6 (below the 80% bar), 4B at 5/6 → the 4B wins
    // over the smaller model, and the reason says why when nothing qualifies.
    const records = [
      rec({ ref: "qualcomm/Qwen3-1.7B", result: { passed: 4, total: 6 } }),
      rec({ ref: "qualcomm/Qwen3-4B", result: { passed: 5, total: 6 } }),
    ];
    const d = recommendedDefault(entries, records, HERE);
    expect(d).toMatchObject({ ref: "qualcomm/Qwen3-4B", tier: "balanced" });
    const allBelow = recommendedDefault(entries, [rec({ ref: "qualcomm/Qwen3-1.7B", result: { passed: 2, total: 6 } })], HERE);
    expect(allBelow.ref).toBeNull();
    expect(allBelow.ref === null && allBelow.reason).toContain("under the 80% quality bar");
  });

  it("returns an explicit provisional reason instead of guessing", () => {
    const d = recommendedDefault(entries, [], HERE);
    expect(d.ref).toBeNull();
    expect(d.ref === null && d.reason).toContain("quality-evaluated");
    // A record from another machine is not qualification.
    const shipped = recommendedDefault(entries, [rec({ machine: OTHER.machine })], HERE);
    expect(shipped.ref).toBeNull();
  });

  it("fails CLOSED on malformed scores — unreadable is not passing (F08)", () => {
    // The shapes that used to qualify through the fail-open `ratio === null` path.
    for (const result of [{ quality: 85 }, {}, { passed: 16 }, { total: 20 }, { passed: 21, total: 20 }, { passed: -1, total: 20 }, { passed: 16, total: 0 }]) {
      const d = recommendedDefault(entries, [rec({ ref: "qualcomm/Qwen3-8B", result })], HERE);
      expect(d.ref, `result ${JSON.stringify(result)} must not qualify`).toBeNull();
      expect(d.ref === null && d.reason.toLowerCase()).toContain("provisional");
    }
  });
});

describe("artifact identity (F06)", () => {
  it("canonArtifactRef KEEPS the precision: two quantizations are two artifacts", async () => {
    const { canonArtifactRef } = await import("../src/core/manifest");
    expect(canonArtifactRef("unsloth/Gemma-3-1B-it-GGUF:Q4_0")).toBe("unsloth/gemma-3-1b-it-gguf:q4_0");
    expect(canonArtifactRef("unsloth/Gemma-3-1B-it-GGUF:Q8_0")).not.toBe(canonArtifactRef("unsloth/Gemma-3-1B-it-GGUF:Q4_0"));
    expect(canonArtifactRef("ai-hub-models/Qwen3-1.7B")).toBe("qualcomm/qwen3-1.7b");
  });

  it("recordFor never shares evidence across precisions; a bare ask matches the ONLY build", async () => {
    const { recordFor } = await import("../src/core/manifest");
    const q4 = rec({ ref: "unsloth/gemma-3-1b-it-GGUF:Q4_0", result: { passed: 10, total: 20 } });
    // An exact-precision ask finds it…
    expect(recordFor([q4], "unsloth/gemma-3-1b-it-GGUF:Q4_0", "quality-evaluated")).toBeTruthy();
    // …a DIFFERENT precision never does…
    expect(recordFor([q4], "unsloth/gemma-3-1b-it-GGUF:Q8_0", "quality-evaluated")).toBeUndefined();
    // …and a precision-less ask matches only when there is exactly ONE build.
    expect(recordFor([q4], "unsloth/gemma-3-1b-it-GGUF", "quality-evaluated")).toBeTruthy();
    const q8 = rec({ ref: "unsloth/gemma-3-1b-it-GGUF:Q8_0", result: { passed: 12, total: 20 } });
    expect(recordFor([q4, q8], "unsloth/gemma-3-1b-it-GGUF", "quality-evaluated")).toBeUndefined();
  });
});

describe("manifest ref resolution (C03)", () => {
  // A repo-LEVEL manifest entry: its ref carries no precision; the precisions
  // it vouches for are declared separately (the Rust scan's shape).
  const repoLevel = [
    { ref: "qualcomm/Qwen3-4B-GGUF", precisions: ["Q4_0", "Q8_0"] },
  ];

  it("resolves an exact spelling and a precisionless ask to the only base", () => {
    expect(manifestRefFor("qualcomm/Qwen3-4B-GGUF", repoLevel)).toBe("qualcomm/Qwen3-4B-GGUF");
    expect(manifestRefFor("qualcomm/Qwen3-4B", repoLevel)).toBe("qualcomm/Qwen3-4B-GGUF");
  });

  it("resolves a QUALIFIED ref through a repo-level entry that DECLARES the precision", () => {
    expect(manifestRefFor("qualcomm/Qwen3-4B:Q4_0", repoLevel)).toBe("qualcomm/Qwen3-4B-GGUF");
    expect(manifestRefFor("qualcomm/Qwen3-4B-GGUF:Q8_0", repoLevel)).toBe("qualcomm/Qwen3-4B-GGUF");
  });

  it("does NOT resolve a precision the entry does not declare — that artifact is not vouched for", () => {
    expect(manifestRefFor("qualcomm/Qwen3-4B:W4A16", repoLevel)).toBeUndefined();
  });

  it("prefers a per-quant entry (its own ref carries the precision) over the repo-level one", () => {
    const manifest = [
      { ref: "qualcomm/Qwen3-4B-GGUF", precisions: ["Q4_0"] },
      { ref: "qualcomm/Qwen3-4B-GGUF:Q4_0", precisions: ["Q4_0"] },
    ];
    expect(manifestRefFor("qualcomm/Qwen3-4B:Q4_0", manifest)).toBe("qualcomm/Qwen3-4B-GGUF:Q4_0");
  });

  it("an undeclared precision with several bases stays ambiguous, never guessed", () => {
    const manifest = [
      { ref: "qualcomm/Qwen3-4B-GGUF", precisions: ["Q4_0"] },
      { ref: "qualcomm/Qwen3-8B-GGUF", precisions: ["Q8_0"] },
    ];
    expect(manifestRefFor("qualcomm/Qwen3-8B:W4A16", manifest)).toBeUndefined();
  });
});

describe("evidence labels tell the truth (F09)", () => {
  it("download evidence says FILES PRESENT, not a hash-checked 'verified'", () => {
    expect(EVIDENCE_LABELS["download-verified"]).toBe("Files present");
    expect(EVIDENCE_HINTS["download-verified"].toLowerCase()).toContain("not hash-checked");
    expect(EVIDENCE_HINTS["download-verified"].toLowerCase()).not.toContain("expected size");
  });
});

describe("tier labels", () => {
  it("exposes the three explicit choices with purpose text", () => {
    expect(TIERS.map((t) => t.id)).toEqual(["efficiency", "balanced", "quality"]);
    for (const t of TIERS) expect(t.purpose.length).toBeGreaterThan(10);
  });
});
