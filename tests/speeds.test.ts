import { describe, expect, it } from "vitest";
import { speedsById } from "../src/core/speeds";
import type { CatalogEntry, EvidenceRecord } from "../src/core/manifest";
import { entryMatches } from "../src/core/dynamic";
import { ref as entryRef } from "../src/core/catalog";

// The literal speeds here are this test's own fixtures, chosen so no plausible
// implementation constant could satisfy them by accident.
const EMA_FIXTURE = { "custom:unsloth/gemma-3-1b-it-gguf:q4_0": 68.9, "ministral-3-8b-reasoning": 12.5 };

const entry = (id: string, repo: string, quant?: string): CatalogEntry =>
  ({ id, name: id, repo, ...(quant ? { quant } : {}) }) as unknown as CatalogEntry;

const ENTRIES = [
  entry("custom:unsloth/gemma-3-1b-it-gguf:q4_0", "unsloth/gemma-3-1b-it-GGUF", "Q4_0"),
  entry("ministral-3-8b-reasoning", "unsloth/Ministral-3-8B-Reasoning-2512-GGUF", "Q4_0"),
  entry("qwen3-8b", "qualcomm/Qwen3-8B", "W4A16"),
];

const perf = (ref: string, tokPerSec: number, tokens = 41): EvidenceRecord =>
  ({ id: `performance-measured:${ref}`, kind: "performance-measured", ref, asOf: "2026-11-08T05:33:00.747Z", machine: "test", runtimeVersion: "v0.10.0", result: { tokPerSec, tokens } }) as unknown as EvidenceRecord;

describe("speedsById (measured speeds for the model menu)", () => {
  it("keeps the chat EMA as measured, and drops junk values", () => {
    const out = speedsById(
      { ...EMA_FIXTURE, broken: 0, negative: -5, nan: Number.NaN, text: "12" as unknown as number },
      [], ENTRIES, entryMatches, entryRef
    );
    expect(out).toEqual(EMA_FIXTURE);
  });

  it("maps benchmark evidence to catalog entries by ref, and adds models the EMA lacks", () => {
    const out = speedsById(
      EMA_FIXTURE,
      [perf("qualcomm/Qwen3-8B:W4A16", 20.0)],
      ENTRIES, entryMatches, entryRef
    );
    expect(out["qwen3-8b"]).toBe(20.0);
    expect(out["ministral-3-8b-reasoning"]).toBe(12.5); // EMA untouched
  });

  it("the chat EMA wins over a single benchmark run of the same model", () => {
    const out = speedsById(
      EMA_FIXTURE,
      [perf("unsloth/Ministral-3-8B-Reasoning-2512-GGUF:Q4_0", 16.4)],
      ENTRIES, entryMatches, entryRef
    );
    expect(out["ministral-3-8b-reasoning"]).toBe(12.5);
  });

  it("ignores other evidence kinds, invalid results, and refs no entry answers to", () => {
    const out = speedsById(
      {},
      [
        perf("qualcomm/Qwen3-8B:W4A16", 20.0),
        { id: "k:other", kind: "context-verified", ref: "qualcomm/Qwen3-8B:W4A16", asOf: "2026-11-08T05:33:00.747Z", machine: "t", runtimeVersion: "v", result: { tokPerSec: 999 } },
        { id: "k:bad", kind: "performance-measured", ref: "qualcomm/Qwen3-8B:W4A16", asOf: "2026-11-08T05:34:00.747Z", machine: "t", runtimeVersion: "v", result: { tokPerSec: 0 } },
        { id: "k:gone", kind: "performance-measured", ref: "gone/model:Q4_0", asOf: "2026-11-08T05:35:00.747Z", machine: "t", runtimeVersion: "v", result: { tokPerSec: 55 } },
      ] as unknown as EvidenceRecord[],
      ENTRIES, entryMatches, entryRef
    );
    expect(out).toEqual({ "qwen3-8b": 20.0 });
  });

  it("tolerates a missing or malformed evidence store", () => {
    expect(speedsById(EMA_FIXTURE, undefined as unknown as EvidenceRecord[], ENTRIES, entryMatches, entryRef)).toEqual(EMA_FIXTURE);
    expect(speedsById(undefined as unknown as Record<string, number>, [], ENTRIES, entryMatches, entryRef)).toEqual({});
  });
});
