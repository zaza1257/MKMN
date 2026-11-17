import { describe, expect, it } from "vitest";
import { installedRefsOf } from "../src/core/geniex";
import { resolveModelIdentity } from "../src/core/modelIdentity";

// The sidecar named installed models without their precision, so a GGUF build ("ggml-org/gemma-4-12B-it-GGUF:Q4_0")
// was refused as "a build the cache does not hold" and its load test recorded a failure without ever trying it.
describe("the installed refs name every build the cache holds", () => {
  const list = [
    { name: "ggml-org/gemma-4-12B-it-GGUF", ref: "ggml-org/gemma-4-12B-it-GGUF", precisions: ["Q4_0"] },
    { name: "qualcomm/Qwen3-4B", ref: "qualcomm/Qwen3-4B", precisions: ["W4A16"] },
  ];
  it("keeps the bare name and adds each precision", () => {
    expect(installedRefsOf(list)).toEqual(["ggml-org/gemma-4-12B-it-GGUF", "ggml-org/gemma-4-12B-it-GGUF:Q4_0", "qualcomm/Qwen3-4B", "qualcomm/Qwen3-4B:W4A16"]);
  });
  it("lets the GGUF build resolve to the cache's own name", () => {
    const r = resolveModelIdentity("installed:ggml-org/gemma-4-12b-it-gguf:q4_0", { installedRefs: installedRefsOf(list) });
    expect(r).toMatchObject({ ok: true, ref: "ggml-org/gemma-4-12B-it-GGUF:Q4_0" });
  });
  it("still refuses a precision the cache does not hold", () => {
    expect(resolveModelIdentity("installed:ggml-org/gemma-4-12b-it-gguf:q8_0", { installedRefs: installedRefsOf(list) }).ok).toBe(false);
  });
});
