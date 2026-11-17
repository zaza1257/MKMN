import { describe, it, expect } from "vitest";
import { resolveModelIdentity, type ModelIdentityContext } from "../src/core/modelIdentity";
import { CATALOG } from "../src/core/catalog";

/**
 * Tests of THE shared model-identity resolver (src/core/modelIdentity.ts). The same
 * pure function backs the renderer's select/preload path and the sidecar's chat,
 * benchmark and lab paths, so every assertion here pins the identity every entry
 * point must agree on: one application id → one cache-shaped ref.
 *
 * The reproduced failure this guards: the chat path asked GenieX for the catalog's
 * `ai-hub-models/Qwen3-1.7B` while the cache and the readiness probe know
 * `qualcomm/Qwen3-1.7B:W4A16` — the probe never saw the requested identity and the
 * load timed out. Resolution must map the namespace and pin the precision.
 */

const ctx = (over: Partial<ModelIdentityContext> = {}): ModelIdentityContext => ({
  catalogEntries: CATALOG,
  customEntries: [],
  installedRefs: [
    "qualcomm/Qwen3-1.7B:W4A16",
    "unsloth/Qwen3-4B-Thinking-2507-GGUF:Q4_0",
    "unsloth/gemma-3-1b-it-GGUF:Q4_0",
  ],
  packs: {
    "2B": {
      models: [
        { ref: "qwen3-1.7b-native", name: "Qwen3 1.7B", repo: "ai-hub-models/Qwen3-1.7B", quant: null },
      ],
    },
  },
  ...over,
});

describe("modelIdentity: catalog entries resolve to the cache's own spelling", () => {
  it("maps the ai-hub-models catalog ref onto the qualcomm cache name WITH precision", () => {
    // The reproduced chat-path failure: the catalog bundle entry names no quant, the
    // cache holds exactly one build of that base — that build is the ref to serve.
    const r = resolveModelIdentity("qwen3-1.7b-native", ctx());
    expect(r).toEqual({
      ok: true,
      ref: "qualcomm/Qwen3-1.7B:W4A16",
      requested: "qwen3-1.7b-native",
      how: "installed-cache",
    });
  });

  it("an ambiguous base (two quants of the same model installed) does not guess", () => {
    const r = resolveModelIdentity("qwen3-1.7b-native", ctx({
      installedRefs: ["qualcomm/Qwen3-1.7B:W4A16", "qualcomm/Qwen3-1.7B:W8A16"],
    }));
    // Not the cache's build — but still a resolvable catalog ref in the cache's namespace.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.how).toBe("catalog");
      expect(r.ref).toBe("qualcomm/Qwen3-1.7B");
    }
  });

  it("a GGUF catalog entry resolves through the installed cache verbatim", () => {
    const r = resolveModelIdentity("qwen3-4b-thinking-2507", ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ref).toBe("unsloth/Qwen3-4B-Thinking-2507-GGUF:Q4_0");
      expect(r.how).toBe("installed-cache");
    }
  });

  it("a not-installed catalog entry asks for the ref in the cache's namespace, case kept", () => {
    const r = resolveModelIdentity("qwen3-1.7b-native", ctx({ installedRefs: [] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.how).toBe("catalog");
      // `reNamespace` maps only the namespace; the model's own case survives, so the
      // install/log message names a model that can actually be found.
      expect(r.ref).toBe("qualcomm/Qwen3-1.7B");
    }
  });
});

describe("modelIdentity: custom entries and packs", () => {
  it("a saved custom entry id resolves through its repo:quant", () => {
    const r = resolveModelIdentity("custom:unsloth/gemma-3-1b-it-gguf:q4_0", ctx({
      customEntries: [{ id: "custom:unsloth/gemma-3-1b-it-gguf:q4_0", name: "Gemma 3 1B", repo: "unsloth/gemma-3-1b-it-GGUF", quant: "Q4_0" } as never],
    }));
    expect(r).toMatchObject({ ok: true, ref: "unsloth/gemma-3-1b-it-GGUF:Q4_0", how: "custom-entry" });
  });

  it("a dynamic pack id resolves to the pack model's installed build", () => {
    const r = resolveModelIdentity("dynamic:2B", ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.how).toBe("dynamic-pack");
      expect(r.ref).toBe("qualcomm/Qwen3-1.7B:W4A16");
    }
  });

  it("an EXPLICIT pack member resolves FIRST, with its exact quant — a sibling must not win (F05)", () => {
    // A pack where TWO members are installed: the bare tier id takes the first
    // installed; the member id must take ITS OWN model, not the sibling's.
    const packs = {
      "2B": {
        models: [
          { ref: "alpha-2b", name: "Alpha 2B", repo: "org/alpha-2b-GGUF", quant: "Q4_0" },
          { ref: "beta-2b", name: "Beta 2B", repo: "org/beta-2b-GGUF", quant: "Q4_0" },
        ],
      },
    };
    const installed = ["org/alpha-2b-GGUF:Q4_0", "org/beta-2b-GGUF:Q4_0"];
    const tier = resolveModelIdentity("dynamic:2B", ctx({ packs, installedRefs: installed }));
    expect(tier).toMatchObject({ ok: true, ref: "org/alpha-2b-GGUF:Q4_0", how: "dynamic-pack" });
    const member = resolveModelIdentity("beta-2b", ctx({ packs, installedRefs: installed }));
    expect(member).toMatchObject({ ok: true, ref: "org/beta-2b-GGUF:Q4_0", how: "dynamic-pack" });
  });

  it("a pack member whose quant is NOT the installed one is refused, not downgraded (F05)", () => {
    const packs = {
      "2B": {
        models: [{ ref: "alpha-2b", name: "Alpha 2B", repo: "org/alpha-2b-GGUF", quant: "Q8_0" }],
      },
    };
    const r = resolveModelIdentity("alpha-2b", ctx({ packs, installedRefs: ["org/alpha-2b-GGUF:Q4_0"] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("Q8_0");
      expect(r.reason).toContain("org/alpha-2b-GGUF:Q4_0");
    }
  });

  it("an explicit member that is NOT installed at all is refused, never served a sibling (C02)", () => {
    // A pack whose OTHER member is installed: asking for alpha by its member id
    // must not come back with beta's weights behind alpha's name.
    const packs = {
      "2B": {
        models: [
          { ref: "alpha-2b", name: "Alpha 2B", repo: "org/alpha-2b-GGUF", quant: "Q4_0" },
          { ref: "beta-2b", name: "Beta 2B", repo: "org/beta-2b-GGUF", quant: "Q4_0" },
        ],
      },
    };
    const r = resolveModelIdentity("alpha-2b", ctx({ packs, installedRefs: ["org/beta-2b-GGUF:Q4_0"] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("alpha-2b");
      expect(r.reason).not.toContain("beta-2b-GGUF:Q4_0", "the sibling's build must not be offered as alpha");
    }
    // the BARE tier id still scans the pack and serves the installed sibling
    const tier = resolveModelIdentity("dynamic:2B", ctx({ packs, installedRefs: ["org/beta-2b-GGUF:Q4_0"] }));
    expect(tier).toMatchObject({ ok: true, ref: "org/beta-2b-GGUF:Q4_0", how: "dynamic-pack" });
  });

  it("a legacy custom: id naming a missing quant is refused, not served in another quant (F05)", () => {
    const r = resolveModelIdentity("custom:unsloth/gemma-3-1b-it-GGUF:Q8_0", ctx({
      installedRefs: ["unsloth/gemma-3-1b-it-GGUF:Q4_0"],
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("Q8_0");
      expect(r.reason).toContain("unsloth/gemma-3-1b-it-GGUF:Q4_0");
    }
    // A custom id whose quant IS installed still resolves through it.
    const ok = resolveModelIdentity("custom:unsloth/gemma-3-1b-it-GGUF:Q4_0", ctx({
      installedRefs: ["unsloth/gemma-3-1b-it-GGUF:Q4_0"],
    }));
    expect(ok).toMatchObject({ ok: true, ref: "unsloth/gemma-3-1b-it-GGUF:Q4_0", how: "custom-entry" });
  });
});

describe("modelIdentity: application ids are never served as-is", () => {
  it("an unresolvable dynamic: id is REFUSED with a reason, not forwarded", () => {
    const r = resolveModelIdentity("dynamic:999B", ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("dynamic:999B");
  });

  it("a 'custom:' id with nothing cache-shaped after the prefix is refused", () => {
    const r = resolveModelIdentity("custom:", ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("application model id");
  });

  it("a 'custom:' id whose remainder IS a cache entry still resolves (older builds' ids)", () => {
    const r = resolveModelIdentity("custom:unsloth/gemma-3-1b-it-GGUF:Q4_0", ctx());
    expect(r).toMatchObject({ ok: true, ref: "unsloth/gemma-3-1b-it-GGUF:Q4_0" });
  });

  it("an empty id is refused", () => {
    const r = resolveModelIdentity("  ", ctx());
    expect(r.ok).toBe(false);
  });
});

describe("modelIdentity: raw cache refs pass through untouched", () => {
  it("an exact installed ref comes back byte-for-byte (case included)", () => {
    const r = resolveModelIdentity("unsloth/Qwen3-4B-Thinking-2507-GGUF:Q4_0", ctx());
    expect(r).toEqual({
      ok: true,
      ref: "unsloth/Qwen3-4B-Thinking-2507-GGUF:Q4_0",
      requested: "unsloth/Qwen3-4B-Thinking-2507-GGUF:Q4_0",
      how: "installed-cache",
    });
  });

  it("an unknown-but-well-formed ref is answered as asked (the cache may know it later)", () => {
    const r = resolveModelIdentity("unsloth/Brand-New-Model-GGUF:Q4_0", ctx());
    expect(r).toEqual({ ok: true, ref: "unsloth/Brand-New-Model-GGUF:Q4_0", requested: "unsloth/Brand-New-Model-GGUF:Q4_0", how: "as-asked" });
  });
});

describe("modelIdentity: the shipped catalog resolves the reproduced case end to end", () => {
  it("qwen3-1.7b-native (shipped data, no injected ctx) maps to the installed qualcomm build", () => {
    // No ctx at all: the resolver must do the right thing with just the shipped
    // catalog + Dynamic data — this is exactly how the sidecar's ensureServer calls it.
    const r = resolveModelIdentity("qwen3-1.7b-native", { installedRefs: ["qualcomm/Qwen3-1.7B:W4A16"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ref).toBe("qualcomm/Qwen3-1.7B:W4A16");
      expect(r.ref.startsWith("custom:")).toBe(false);
      expect(r.ref.startsWith("dynamic:")).toBe(false);
    }
  });
});
