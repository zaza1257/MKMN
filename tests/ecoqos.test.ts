import { describe, it, expect, vi } from "vitest";
import { fakeBackend } from "../src/voice/backend";
import { VoiceEngine } from "../src/core/voiceEngine";
import { createTauriApi } from "../src/renderer/tauriBridge";
import type { QoSSummary } from "../src/shared/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));

/**
 * QoS tests, labeled by the evidence each one actually collects:
 * - The tier fixture checks the type contract the renderer and Rust side share
 *   (src/shared/types.ts QoSSummary / HardwareVerification, src-tauri/src/qos.rs serde names).
 * - The bridge tests call the real createTauriApi with invoke intercepted, so they prove
 *   the commands the native side registers (get_qos_status_cmd / set_qos_tier_cmd) are
 *   the ones the bridge calls, with the argument shapes the Rust signature expects.
 * - The native Windows policy itself (priority classes, EcoQoS throttling, sleep
 *   inhibition) is verified by the Win32 unit tests inside src-tauri/src/qos.rs on the
 *   target platform, not by this suite.
 * - The voice engine test exercises the real VoiceEngine wrapper with the deterministic
 *   fakeBackend — it makes no claim about real-mode audio hardware.
 */

const qosSummary = (over: Partial<QoSSummary>): QoSSummary => ({
  pid: 1000,
  tier: "Interactive",
  priorityClass: "NORMAL_PRIORITY_CLASS",
  ecoqosActive: false,
  timerCoalescingActive: false,
  sleepInhibited: false,
  verifiedHwState: true,
  details: "",
  ...over,
});

describe("QoS tier contract (shared type, serde names)", () => {
  it("carries the 3-tier workload classification the native side applies", () => {
    // Values as the Rust QoSTier enum serializes them (qos.rs as_str / from_str_loose).
    const tiers = ["Interactive", "InferenceCritical", "BackgroundEco"] as const;
    const interactive = qosSummary({
      tier: "Interactive",
      priorityClass: "NORMAL_PRIORITY_CLASS",
      details: "PID 1000 running at NORMAL_PRIORITY_CLASS (EcoQoS: Disabled, Timers: High Precision)",
    });
    const inference = qosSummary({
      pid: 2000,
      tier: "InferenceCritical",
      priorityClass: "ABOVE_NORMAL_PRIORITY_CLASS",
      sleepInhibited: true,
    });
    const background = qosSummary({
      pid: 3000,
      tier: "BackgroundEco",
      priorityClass: "BELOW_NORMAL_PRIORITY_CLASS",
      ecoqosActive: true,
      timerCoalescingActive: true,
    });

    expect(tiers).toContain(interactive.tier);
    expect(tiers).toContain(inference.tier);
    expect(tiers).toContain(background.tier);

    // Invariants the native policy guarantees per tier (verified on Windows by qos.rs tests)
    expect(interactive.ecoqosActive).toBe(false);
    expect(inference.ecoqosActive).toBe(false);
    expect(inference.sleepInhibited).toBe(true);
    expect(background.ecoqosActive).toBe(true);
    expect(background.timerCoalescingActive).toBe(true);
  });

  it("a QoSSummary decoded from the native command's JSON satisfies the renderer contract", () => {
    const decoded: QoSSummary = JSON.parse(`{
      "pid": 4242,
      "tier": "BackgroundEco",
      "priorityClass": "BELOW_NORMAL_PRIORITY_CLASS",
      "ecoqosActive": true,
      "timerCoalescingActive": true,
      "sleepInhibited": false,
      "verifiedHwState": true,
      "details": "PID 4242 running at BELOW_NORMAL_PRIORITY_CLASS (EcoQoS: Active, Timers: Coalescing Enabled)"
    }`);
    expect(decoded.pid).toBe(4242);
    expect(decoded.ecoqosActive).toBe(true);
    expect(decoded.timerCoalescingActive).toBe(true);
  });
});

describe("QoS bridge contract (real createTauriApi, invoke intercepted)", () => {
  it("getQoSStatus calls the native get_qos_status_cmd, forwarding the pid", async () => {
    const core = await import("@tauri-apps/api/core");
    const invoke = core.invoke as unknown as ReturnType<typeof vi.fn>;
    const summary = qosSummary({ pid: 4242 });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_qos_status_cmd") return summary;
      throw new Error(`unexpected command ${cmd}`);
    });

    const api = createTauriApi();
    await expect(api.getQoSStatus(4242)).resolves.toEqual(summary);
    expect(invoke).toHaveBeenCalledWith("get_qos_status_cmd", { pid: 4242 });
  });

  it("getQoSStatus without a pid queries the current process", async () => {
    const core = await import("@tauri-apps/api/core");
    const invoke = core.invoke as unknown as ReturnType<typeof vi.fn>;
    invoke.mockImplementation(async () => qosSummary({}));

    const api = createTauriApi();
    await api.getQoSStatus();
    expect(invoke).toHaveBeenLastCalledWith("get_qos_status_cmd", { pid: undefined });
  });

  it("setQoSTier calls the native set_qos_tier_cmd with the tier and pid", async () => {
    const core = await import("@tauri-apps/api/core");
    const invoke = core.invoke as unknown as ReturnType<typeof vi.fn>;
    const applied = qosSummary({ pid: 99, tier: "BackgroundEco", ecoqosActive: true, priorityClass: "BELOW_NORMAL_PRIORITY_CLASS" });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "set_qos_tier_cmd") return applied;
      throw new Error(`unexpected command ${cmd}`);
    });

    const api = createTauriApi();
    await expect(api.setQoSTier("background_eco", 99)).resolves.toEqual(applied);
    expect(invoke).toHaveBeenLastCalledWith("set_qos_tier_cmd", { tier: "background_eco", pid: 99 });
  });

  it("an invalid tier name surfaces the native error to the caller", async () => {
    const core = await import("@tauri-apps/api/core");
    const invoke = core.invoke as unknown as ReturnType<typeof vi.fn>;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "set_qos_tier_cmd") throw new Error("Invalid QoS tier 'turbo'. Valid tiers: interactive, inference_critical, background_eco");
      throw new Error(`unexpected command ${cmd}`);
    });

    const api = createTauriApi();
    await expect(api.setQoSTier("turbo")).rejects.toThrow("Invalid QoS tier");
  });
});

describe("NPU diagnostics bridge contract (real createTauriApi, invoke intercepted)", () => {
  it("npuDiagnostics asks the native npu_diagnostics_cmd and passes its measured payload through", async () => {
    const core = await import("@tauri-apps/api/core");
    const invoke = core.invoke as unknown as ReturnType<typeof vi.fn>;
    // Shape produced by src-tauri/src/npudiag.rs on a PC whose NPU counters Windows does not expose.
    const measured = {
      ok: false,
      problem: "Windows has no performance counters for the NPU on this PC: no counter set with NPU in its name, and no compute-only adapter among the GPU counters. Updating Windows and the NPU driver may add them (Task Manager's NPU tab needs them too).",
      windows: "28000.3365",
      windowsHasNpuMonitoring: true,
      sets: [],
      adapter: null,
      adapters: ["Qualcomm(R) Adreno(TM) X2-90 GPU luid_0x00000000_0x00010c23"],
      topUtil: [],
      allSets: ["GPU Engine", "NPU Engine"],
      sample: [],
      util: null,
      memGB: null,
    };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "npu_diagnostics_cmd") return measured;
      throw new Error(`unexpected command ${cmd}`);
    });

    const api = createTauriApi();
    await expect(api.npuDiagnostics()).resolves.toEqual(measured);
    expect(invoke).toHaveBeenCalledWith("npu_diagnostics_cmd");
  });

  it("a measured diagnosis is passed through unchanged, never rewritten by the renderer", async () => {
    const core = await import("@tauri-apps/api/core");
    const invoke = core.invoke as unknown as ReturnType<typeof vi.fn>;
    const measured = {
      ok: true,
      problem: null,
      windows: "26100.8524",
      windowsHasNpuMonitoring: true,
      sets: ["GPU Engine", "GPU Adapter Memory"],
      adapter: "compute-only adapter",
      adapters: [],
      topUtil: ["pid_99_luid_0x00000000_0x00010f31_engtype_compute = 42"],
      allSets: ["GPU Engine"],
      sample: ["pid_99_luid_0x00000000_0x00010f31_engtype_compute = 42"],
      util: 42.0,
      memGB: 0.13,
    };
    invoke.mockImplementation(async () => measured);

    const api = createTauriApi();
    await expect(api.npuDiagnostics()).resolves.toBe(measured);
  });
});

describe("Voice engine wrapper (real VoiceEngine, deterministic fake backend)", () => {
  it("loads and transcribes through the fake backend", async () => {
    const engine = new VoiceEngine(fakeBackend());
    await engine.loadStt({});
    await engine.loadTts({});

    const transcription = await engine.transcribe(new Float32Array(16000), 16000, false);
    expect(transcription).toContain("heard 16000 samples");

    let audioChunks = 0;
    await engine.speak("req-1", "Test speech synthesis", 0, 1.0, (chunk) => {
      if (chunk.length > 0) audioChunks++;
    });
    expect(audioChunks).toBeGreaterThan(0);
  });
});
