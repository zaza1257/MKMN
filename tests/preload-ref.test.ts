import { describe, expect, it } from "vitest";
import { preloadRefOf } from "../src/core/modelList";
import type { CatalogItem } from "../src/shared/api";

// A chat on Deepseek-R1-7B (Foundry Local) preloaded "deepseek-r1-7b" through GenieX, which cannot serve a
// Foundry Local model: "The model could not be loaded". The chat passed the item's ref, which carries no "foundry:".
const item = (id: string, ref: string) => ({ entry: { id, name: id, repo: ref }, ref } as unknown as CatalogItem);

describe("what a chat preloads through GenieX", () => {
  it("never a Foundry Local model, whatever its ref looks like", () => {
    expect(preloadRefOf(item("foundry:deepseek-r1-7b", "deepseek-r1-7b"), false)).toBe("");
  });
  it("never a cloud chat", () => {
    expect(preloadRefOf(item("custom:org/m:q4_0", "org/m:Q4_0"), true)).toBe("");
  });
  it("a GenieX model by its ref", () => {
    expect(preloadRefOf(item("custom:unsloth/qwen3-0.6b-gguf:q4_0", "unsloth/Qwen3-0.6B-GGUF:Q4_0"), false)).toBe("unsloth/Qwen3-0.6B-GGUF:Q4_0");
  });
});
