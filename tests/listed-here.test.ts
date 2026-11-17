import { describe, expect, it } from "vitest";
import { listedHere } from "../src/core/modelList";
import type { CatalogItem } from "../src/shared/api";

/**
 * The Models list shows what can work on this PC: a model whose load test failed here is left out (Phi-3.5-Mini
 * and Qwen3.6-27B), and Foundry Local's GPU and CPU builds stay out unless part-CPU loading is
 * allowed (the decided NPU-first rule: GPU and CPU are never chosen silently).
 */
const item = (id: string, ref: string, extra: Record<string, unknown> = {}) =>
  ({ entry: { id, name: id, repo: ref, quant: null, ...extra }, ref, installed: false, hidden: false } as unknown as CatalogItem);

const items = [
  item("qwen3-8b", "bartowski/Qwen_Qwen3-8B-GGUF:Q4_0"),
  item("installed:qualcomm/phi-3.5-mini-instruct", "qualcomm/Phi-3.5-Mini-Instruct"),
  item("foundry:qwen2.5-7b", "qwen2.5-7b", { foundryDevice: "NPU" }),
  item("foundry:qwen3-8b", "qwen3-8b", { foundryDevice: "GPU" }),
  item("foundry:qwen3-0.6b", "qwen3-0.6b", { foundryDevice: "CPU" }),
];
const failures = { "qualcomm/Phi-3.5-Mini-Instruct": { reason: "cannot read metadata.json", geniex: "v0.11.0", at: "2026-11-15T12:00:00Z" } };

describe("the models listed are the ones that can work here", () => {
  it("leaves out a model that did not load here, and Foundry builds made for the GPU or CPU", () => {
    expect(listedHere(items, { loadFailures: failures }).map((i) => i.entry.id)).toEqual(["qwen3-8b", "foundry:qwen2.5-7b"]);
  });
  it("lists the GPU and CPU builds when part-CPU loading is allowed", () => {
    expect(listedHere(items, { loadFailures: failures, allowHybridLoad: true }).map((i) => i.entry.id))
      .toEqual(["qwen3-8b", "foundry:qwen2.5-7b", "foundry:qwen3-8b", "foundry:qwen3-0.6b"]);
  });
  it("keeps a Foundry build measured on the NPU here, whatever its build says", () => {
    expect(listedHere(items, { placements: { "qwen3-8b": "npu" } }).some((i) => i.entry.id === "foundry:qwen3-8b")).toBe(true);
  });
  it("keeps the chosen model listed, so the choice never points at nothing", () => {
    expect(listedHere(items, { loadFailures: failures, selectedModelId: "installed:qualcomm/phi-3.5-mini-instruct" })
      .some((i) => i.entry.id === "installed:qualcomm/phi-3.5-mini-instruct")).toBe(true);
  });
});
