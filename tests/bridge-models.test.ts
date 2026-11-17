import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

/**
 * Choosing a model, the way the desktop bridge does it:
 * - a Foundry Local entry Foundry has cached is installed; an offered one is not, and
 *   shows "Install" (never a GenieX download for a Foundry model);
 * - choosing a Foundry model never starts GenieX with it (the sidecar's Foundry
 *   host serves it on the first chat);
 * - the app default changes only once the new model started: a failed start leaves
 *   the old choice in place;
 * - the start uses the model's kept load profile, like a preload does.
 */

const GENIEX = { id: "q3", name: "Qwen3", repo: "q/qwen3", quant: "Q4_0", engine: "llama_cpp", role: "chat", architecture: "qwen3", sizeGB: 2, recommendedContext: 4096, sampling: { max_tokens: 512 } };
const FOUNDRY = { id: "foundry:phi-4-mini", name: "Phi 4 mini (Foundry)", repo: "phi-4-mini", quant: "npu", engine: "foundry", role: "chat", architecture: "phi", sizeGB: 2.5, recommendedContext: 4096, sampling: { max_tokens: 512 }, foundryInstalled: true };
const FOUNDRY_OFFERED = { ...FOUNDRY, id: "foundry:qwen3-0.6b", name: "Qwen3 0.6B (Foundry Local)", repo: "qwen3-0.6b", foundryInstalled: false };
const REF = "q/qwen3:Q4_0";

let calls: Array<{ cmd: string; args: any }>;
let startFails = false;
let settings: any;

beforeEach(async () => {
  calls = [];
  startFails = false;
  settings = { selectedModelId: "old", compute: "npu", loadProfiles: { [REF]: { id: "low-mem", label: "Low memory", compute: "hybrid", maxCtx: 2048, v: 99 } } };
  const core = await import("@tauri-apps/api/core");
  (core.invoke as any).mockReset();
  (core.invoke as any).mockImplementation(async (cmd: string, args?: any) => {
    calls.push({ cmd, args });
    if (cmd === "get_hardware_cmd") return { ramGB: 32 };
    if (cmd === "get_settings") return settings;
    if (cmd === "save_settings_cmd") { settings = { ...settings, ...args.patch }; return settings; }
    if (cmd === "get_installed_models_cmd") return [{ name: REF, ref: REF }];
    if (cmd === "start_server") { if (startFails) throw new Error("the NPU refused the model"); return { state: "ready" }; }
    if (cmd === "sidecar_call") {
      if (args.method === "customEntries") return [GENIEX];
      if (args.method === "foundryEntries") return [FOUNDRY, FOUNDRY_OFFERED];
      if (args.method === "compiledContexts") return {};
      return null;
    }
    return null;
  });
});

async function api() {
  const { createTauriApi } = await import("../src/renderer/tauriBridge");
  return createTauriApi();
}

describe("choosing a model", () => {
  it("lists a Foundry model the sidecar has cached as installed", async () => {
    const items = await (await api()).catalog();
    expect(items.find((i) => i.entry.id === FOUNDRY.id)?.installed).toBe(true);
  });

  it("offers a Foundry catalog model that is not cached, with its own install", async () => {
    const items = await (await api()).catalog();
    expect(items.find((i) => i.entry.id === FOUNDRY_OFFERED.id)?.installed).toBe(false);
  });

  it("never starts GenieX with a Foundry model, and saves the choice", async () => {
    await (await api()).selectModel(FOUNDRY.id);
    expect(calls.some((c) => c.cmd === "start_server")).toBe(false);
    expect(settings.selectedModelId).toBe(FOUNDRY.id);
  });

  it("keeps the old choice when the new model fails to start", async () => {
    startFails = true;
    await expect((await api()).selectModel(GENIEX.id)).rejects.toThrow(/refused/);
    expect(settings.selectedModelId).toBe("old");
  });

  it("starts the model with its kept load profile", async () => {
    await (await api()).selectModel(GENIEX.id);
    const start = calls.find((c) => c.cmd === "start_server");
    expect(start?.args.req.compute).toBe("hybrid");
    expect(start?.args.req.nctx).toBe(2048);
    expect(settings.selectedModelId).toBe(GENIEX.id);
  });

  it("starts GenieX without its update probe unless the update check is on", async () => {
    // one default (off) for the request and for the Settings row that shows it
    const { readBool } = await import("../src/shared/settingsSchema");
    expect(readBool({}, "geniexUpdateCheck")).toBe(false);
    await (await api()).selectModel(GENIEX.id);
    expect(calls.find((c) => c.cmd === "start_server")?.args.req.skip_update).toBe(true);
    calls.length = 0;
    settings = { ...settings, geniexUpdateCheck: true };
    await (await api()).selectModel(GENIEX.id);
    expect(calls.find((c) => c.cmd === "start_server")?.args.req.skip_update).toBe(false);
  });
});

describe("one engine on the NPU at a time", () => {
  // A Foundry Local NPU model was still loaded when Qwen3-8B was chosen; the window's start went
  // straight to the host, skipping the sidecar's Foundry release, two engines met on the NPU and its DSP crashed
  // ("CDSP subsystem Crashed"), after which every model failed to load until the NPU was reset.
  const nativeStarts = () => calls.filter((c) => c.cmd === "start_server" || c.cmd === "preload_model").map((c) => c.cmd);
  it("routes model selection through the native start command", async () => {
    await (await api()).selectModel(GENIEX.id);
    expect(nativeStarts()).toEqual(["start_server"]);
  });
  it("routes preload through the native preload command", async () => {
    await (await api()).preloadModel({ model: GENIEX.id });
    expect(nativeStarts()).toEqual(["preload_model"]);
  });
  it("leaves Foundry Local alone when a Foundry model is chosen", async () => {
    await (await api()).selectModel(FOUNDRY.id);
    expect(nativeStarts()).toEqual([]);
  });
});
