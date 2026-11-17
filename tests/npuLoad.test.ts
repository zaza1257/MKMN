import { describe, expect, it } from "vitest";
import { effectiveLoad } from "../src/core/npuLoad";

/**
 * F16: ONE effective-load resolver for preload and chat, so the same model is
 * preloaded and SERVED under the same compute/context. The renderer's preload
 * used to build its own configuration from the global compute alone while the
 * sidecar's chat path honored the model's kept load profile — a preloaded
 * server then did not match the chat's request.
 */

describe("effectiveLoad precedence", () => {
  const profiles = {
    "org/model:Q4_0": { id: "hybrid", label: "Hybrid", compute: "hybrid", maxCtx: 4096, at: "2026-11-06T00:00:00Z", v: 2 },
  };

  it("an explicit request beats everything", () => {
    const r = effectiveLoad({
      setting: { compute: "cpu", maxCtx: 2048 },
      serveRef: "org/model:Q4_0",
      profiles,
      globalCompute: "npu",
      preferredCompute: "hybrid",
    });
    expect(r).toEqual({ compute: "cpu", nctx: 2048 });
  });

  it("the model's kept load profile beats the shipped default and global compute", () => {
    const r = effectiveLoad({
      serveRef: "org/model:Q4_0",
      entryRef: "model-alias",
      profiles,
      globalCompute: "npu",
      preferredCompute: "hybrid",
    });
    expect(r).toEqual({ compute: "hybrid", nctx: 4096 });
  });

  it("the kept profile can key on the entry ref too", () => {
    const r = effectiveLoad({
      serveRef: "org/other:Q8_0",
      entryRef: "org/model:Q4_0",
      profiles,
      globalCompute: "npu",
    });
    expect(r).toEqual({ compute: "hybrid", nctx: 4096 });
  });

  it("a profile from an older schema version is NOT trusted", () => {
    const r = effectiveLoad({
      serveRef: "org/model:Q4_0",
      profiles: { "org/model:Q4_0": { ...profiles["org/model:Q4_0"], v: 1 } },
      globalCompute: "npu",
    });
    expect(r).toEqual({ compute: "npu", nctx: null });
  });

  it("with no kept profile, the entry's preference beats the global compute; nctx stays unset", () => {
    const r = effectiveLoad({ serveRef: "org/x", globalCompute: "npu", preferredCompute: "cpu" });
    expect(r).toEqual({ compute: "cpu", nctx: null });
  });

  it("nothing set falls back to the NPU default", () => {
    expect(effectiveLoad({ serveRef: "org/x" })).toEqual({ compute: "npu", nctx: null });
    expect(effectiveLoad({ serveRef: "org/x", globalCompute: "cpu" })).toEqual({ compute: "cpu", nctx: null });
  });
});

describe("the load test's own wording", () => {
  it("never says a setting fails before it was tried (the default line was printed under a model that LOADED)", async () => {
    const { LOAD_SETTINGS } = await import("../src/core/npuLoad");
    for (const s of LOAD_SETTINGS) expect(s.why).not.toMatch(/\bthe one that fails\b/i);
  });
});
