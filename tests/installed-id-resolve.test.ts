import { describe, expect, it } from "vitest";
import { resolveModelIdentity } from "../src/core/modelIdentity";

// A model listed from the GenieX cache has the id "installed:<ref lowercased>"; that id was passed
// to GenieX as the model ("--model installed:ggml-org/gemma-4-12b-it-gguf:q4_0"), which found nothing and hung for 90 s twice.
describe("an installed: id resolves to the cache's own name", () => {
  const installedRefs = ["ggml-org/gemma-4-12B-it-GGUF:Q4_0", "qualcomm/Qwen3-4B"];
  it("names the GGUF build exactly as the cache spells it", () => {
    const r = resolveModelIdentity("installed:ggml-org/gemma-4-12b-it-gguf:q4_0", { installedRefs });
    expect(r).toMatchObject({ ok: true, ref: "ggml-org/gemma-4-12B-it-GGUF:Q4_0" });
  });
  it("names a native bundle with no precision", () => {
    expect(resolveModelIdentity("installed:qualcomm/qwen3-4b", { installedRefs })).toMatchObject({ ok: true, ref: "qualcomm/Qwen3-4B" });
  });
  it("never sends the application id itself to GenieX", () => {
    const r = resolveModelIdentity("installed:gone/model-gguf:q4_0", { installedRefs });
    expect(r.ok && r.ref.startsWith("installed:")).toBe(false);
  });
});
