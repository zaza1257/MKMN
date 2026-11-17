import { describe, expect, it } from "vitest";
import { ARTIFACT_SOURCES, type Build, PROVIDERS, providerFor, providersForBuild, type ProviderId } from "../src/core/providers";

/** The Tauri build's provider stubs: what tauriBridge actually implements today. */
const TAURI_STUBBED: ProviderId[] = ["foundry", "llama-server"];

describe("provider contract", () => {
  it("covers every provider the app actually wires", () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual([
      "geniex-qairt",
      "geniex-gguf",
      "foundry",
      "llama-server",
      "router",
      "voice-sherpa",
    ]);
  });

  it("EVERY provider is loopback or explicitly classified — no silent remote chat", () => {
    for (const p of PROVIDERS) {
      expect(["loopback-only", "local-files", "web-keywords", "remote-content"]).toContain(p.egress);
      // A loopback endpoint must literally be 127.0.0.1 or localhost or null.
      if (p.egress === "loopback-only") {
        expect(p.endpoint === null || /127\.0\.0\.1|localhost/.test(p.endpoint)).toBe(true);
      }
      expect(p.egressNote.length).toBeGreaterThan(20);
    }
    // No provider may claim a public LLM endpoint.
    for (const p of PROVIDERS) {
      expect(p.endpoint ?? "").not.toMatch(/^https?:\/\/(?!127\.0\.0\.1|localhost)/);
    }
  });

  it("the router's silent message consumption is documented, not hidden", () => {
    const router = PROVIDERS.find((p) => p.id === "router")!;
    expect(router.egressNote).toContain("message text");
    expect(router.notes.some((n) => n.toLowerCase().includes("silently"))).toBe(true);
  });

  it("GenieX thinking is verified per-runtime contract; GGUF thinking is not", () => {
    const qairt = PROVIDERS.find((p) => p.id === "geniex-qairt")!;
    const gguf = PROVIDERS.find((p) => p.id === "geniex-gguf")!;
    expect(qairt.thinking).toBe("verified");
    expect(gguf.thinking).toBe("declared-only");
    expect(qairt.notes.join(" ")).toContain("enable_think");
  });

  it("Foundry/llama.cpp are Electron-only, matching the Tauri stubs", () => {
    const stubbed = PROVIDERS.filter((p) => TAURI_STUBBED.includes(p.id));
    for (const p of stubbed) {
      expect(p.builds).toEqual(["electron"]);
      expect(p.validatedOnReferenceMachine).toBeNull();
    }
    expect(providersForBuild("tauri").map((p) => p.id)).not.toContain("foundry");
    expect(providersForBuild("electron").map((p) => p.id)).toContain("foundry");
  });

  it("no shipped constant claims validation on the READER'S machine", () => {
    for (const p of PROVIDERS) {
      // A reference-machine record names the machine it was made on, or is absent.
      if (p.validatedOnReferenceMachine) {
        expect(p.validatedOnReferenceMachine.machine.toLowerCase()).toContain("reference pc");
      }
      // Nothing anywhere claims "validated here" as a bare constant.
      expect(JSON.stringify(p).toLowerCase()).not.toContain("validated here");
      expect(JSON.stringify(p).toLowerCase()).not.toContain("validated on this machine");
    }
  });
});

describe("providerFor classification (F10)", () => {
  it("classifies by the RESOLVED engine, not by a first-match fallback", () => {
    expect(providerFor("qwen3-4b-thinking-2507", "qairt")?.id).toBe("geniex-qairt");
    expect(providerFor("gemma-3-1b-it", "llama_cpp")?.id).toBe("geniex-gguf");
    expect(providerFor("custom:unsloth/x:q4_0")?.id).toBe("geniex-gguf");
    expect(providerFor("foundry:llama")?.id).toBe("foundry");
  });

  it("an id that is neither Foundry nor a named engine is UNKNOWN — never answered with the first GenieX card", () => {
    // The old fallback returned the QAIRT card for ANY unrecognized id, so a
    // dynamic pack id or a typo read as "GenieX (QAIRT)" — a claim about the
    // runtime that was never made.
    expect(providerFor("qwen3-1.7b-native")).toBeUndefined();
    expect(providerFor("dynamic:2B")).toBeUndefined();
    expect(providerFor("totally-unknown-id", undefined)).toBeUndefined();
  });
});

describe("artifact sources contract", () => {
  it("sources are distinct from providers (no id overlap)", () => {
    const providerIds = new Set(PROVIDERS.map((p) => p.id));
    for (const s of ARTIFACT_SOURCES) expect(providerIds.has(s.id as ProviderId)).toBe(false);
  });

  it("every source states its duplicate-import protection status", () => {
    for (const s of ARTIFACT_SOURCES) {
      expect(["protected", "protected-now", "unprotected"]).toContain(s.duplicateProtection);
      expect(s.protectionNote.length).toBeGreaterThan(10);
    }
    // None may remain unprotected: duplicate imports are the failure mode this phase closes.
    expect(ARTIFACT_SOURCES.some((s) => s.duplicateProtection === "unprotected")).toBe(false);
  });
});

describe("build gating type", () => {
  it("Build values are the three wire shapes", () => {
    const builds: Build[] = ["both", "electron", "tauri"];
    expect(builds).toHaveLength(3);
  });
});
