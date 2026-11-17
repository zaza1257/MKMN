import { describe, expect, it } from "vitest";
import { installedOnlyEntries, parseInstalledJson } from "../src/core/installedEntries";
import type { CatalogEntry } from "../src/shared/types";

/**
 * A model installed in GenieX was listed in MKMN only when the catalog, a pack or custom-models.json named it:
 * Qualcomm's native bundles and other models installed outside the app never appeared, though they load
 * (Qwen3-4B, Qwen3-8B, Gemma 4 E4B, Intern3.5 VL 2B, Qwen3 VL 8B, Gemma 4 12B were all missing).
 */
// `geniex list --format json` as GenieX 0.11.0 answers it on this PC (a part of it)
const LIST = JSON.stringify([
  { name: "bartowski/Qwen_Qwen3-8B-GGUF", size: 4787332640, runtime: "llama_cpp", type: "llm", precisions: ["Q4_0"] },
  { name: "ggml-org/gemma-4-12B-it-GGUF", size: 7394788832, runtime: "llama_cpp", type: "vlm", precisions: ["Q4_0"] },
  { name: "qualcomm/Qwen3-4B", size: 3200000000, runtime: "qairt", type: "llm", precisions: ["W4A16"] },
  { name: "qualcomm/Qwen3-1.7B", size: 1800000000, runtime: "qairt", type: "llm", precisions: ["W4A16"] },
  { name: "some/embedder-GGUF", size: 100000000, runtime: "llama_cpp", type: "embedding", precisions: ["F16"] },
]);

const known = [
  { id: "custom:bartowski/qwen_qwen3-8b-gguf:q4_0", repo: "bartowski/Qwen_Qwen3-8B-GGUF", quant: "Q4_0" },
  { id: "qwen3-1.7b-native", repo: "ai-hub-models/Qwen3-1.7B", quant: null },
] as CatalogEntry[];

describe("every model installed in GenieX is in the list", () => {
  const installed = parseInstalledJson(LIST);
  const added = installedOnlyEntries(installed, known);

  it("adds the installed models nothing else names, with their own engine and size", () => {
    expect(added.map((e) => `${e.repo}:${e.quant ?? ""}`)).toEqual(["ggml-org/gemma-4-12B-it-GGUF:Q4_0", "qualcomm/Qwen3-4B:"]);
    const native = added.find((e) => e.repo === "qualcomm/Qwen3-4B")!;
    expect(native.engine).toBe("qairt");
    expect(native.sizeGB).toBeCloseTo(3.2, 1);
    expect(added.find((e) => e.repo.startsWith("ggml-org"))!.engine).toBe("llama_cpp");
  });

  it("never doubles a model the list already has, whatever spelling its namespace uses", () => {
    expect(added.some((e) => /qwen_qwen3-8b|qwen3-1\.7b/i.test(e.repo))).toBe(false);
  });

  it("lists only models that chat, never an embedding model", () => {
    expect(added.some((e) => /embedder/.test(e.repo))).toBe(false);
  });

  it("reads nothing from an answer that is not the list", () => {
    expect(parseInstalledJson("not json")).toEqual([]);
    expect(parseInstalledJson("{}")).toEqual([]);
  });
});
