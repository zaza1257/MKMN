import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SpeakChunk, VoiceStatus } from "../src/shared/types";

// The real Tauri bridge, with invoke intercepted and the sidecar-event source faked
// (the same harness as bridge-chat.test.ts).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

/**
 * Contract tests of the voice bridge (src/renderer/tauriBridge.ts, the voice methods):
 * samples go to the sidecar as JSON-safe arrays, audio events come back rebuilt into the
 * Float32Array the player needs, and every call names the sidecar method it means.
 */

const ready = (over: Partial<VoiceStatus> = {}): VoiceStatus => ({
  worker: "ready",
  stt: null,
  tts: null,
  sttProvider: null,
  ttsProvider: null,
  notice: null,
  ttsSampleRate: null,
  error: null,
  ...over
});

/** The sidecar-event handler the bridge subscribed to (captured from the listen mock). */
let eventHandler: ((e: { payload: { name: string; payload: unknown } }) => void) | null = null;

beforeEach(async () => {
  const core = await import("@tauri-apps/api/core");
  (core.invoke as unknown as ReturnType<typeof vi.fn>).mockReset();
  const ev = await import("@tauri-apps/api/event");
  (ev.listen as unknown as ReturnType<typeof vi.fn>).mockReset();
  (ev.listen as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_name: string, handler: typeof eventHandler) => {
    eventHandler = handler;
    return () => {};
  });
});

async function api() {
  const { createTauriApi } = await import("../src/renderer/tauriBridge");
  const a = createTauriApi();
  await new Promise((r) => setTimeout(r, 0)); // let the listen() promise settle
  return a;
}

/** The sidecar_call mock: answers by method name, records every call. */
async function mockSidecar(handlers: Record<string, (args: unknown[]) => unknown>) {
  const core = await import("@tauri-apps/api/core");
  const invoke = core.invoke as unknown as ReturnType<typeof vi.fn>;
  invoke.mockImplementation(async (cmd: string, args?: any) => {
    if (cmd !== "sidecar_call") return {};
    const h = handlers[args.method];
    if (!h) throw new Error(`unexpected sidecar method ${args.method}`);
    return h(args.args ?? []);
  });
  return invoke;
}

describe("voice bridge contract (real createTauriApi, sidecar calls and events intercepted)", () => {
  it("voiceStatus asks the sidecar and returns what it says", async () => {
    const invoke = await mockSidecar({ voiceStatus: () => ready({ stt: "whisper-tiny" }) });
    const a = await api();
    await expect(a.voiceStatus()).resolves.toMatchObject({ worker: "ready", stt: "whisper-tiny" });
    expect(invoke.mock.calls[0][1].method).toBe("voiceStatus");
  });

  it("transcribe sends the samples as a plain number array (JSON-safe) and passes partial through", async () => {
    let got: unknown[] = [];
    mockSidecar({ transcribe: (args) => { got = args as unknown[]; return "heard it"; } });
    const a = await api();
    const samples = Float32Array.from([0.25, -0.5, 0.75]);
    await expect(a.transcribe(samples, 16000, true)).resolves.toBe("heard it");
    expect(got[0]).toEqual([0.25, -0.5, 0.75]); // an array, not a typed array
    expect(got[1]).toBe(16000);
    expect(got[2]).toBe(true);
  });

  it("a voiceAudio event arrives at the listener with a real Float32Array for the player", async () => {
    await mockSidecar({});
    const a = await api();
    const chunks: SpeakChunk[] = [];
    a.onVoiceAudio((c) => chunks.push(c));
    expect(eventHandler).toBeTruthy();
    eventHandler!({ payload: { name: "voiceAudio", payload: { id: "s1", samples: [0.5, 0.25], sampleRate: 24000, done: true } } });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].samples).toBeInstanceOf(Float32Array);
    expect(Array.from(chunks[0].samples)).toEqual([0.5, 0.25]);
    expect(chunks[0].done).toBe(true);
  });

  it("voiceStatus events are sorted into the onVoiceStatus listeners", async () => {
    await mockSidecar({});
    const a = await api();
    const seen: VoiceStatus[] = [];
    a.onVoiceStatus((s) => seen.push(s));
    eventHandler!({ payload: { name: "voiceStatus", payload: ready({ tts: "piper" }) } });
    expect(seen).toHaveLength(1);
    expect(seen[0].tts).toBe("piper");
  });

  it("saveVoice goes to the sidecar (which clamps and reloads) and returns its settings", async () => {
    const invoke = await mockSidecar({ saveVoice: () => ({ voice: { minLevel: 0.02 }, compute: "npu" }) });
    const a = await api();
    const r = await a.saveVoice({ minLevel: 0.02 });
    expect(r).toMatchObject({ voice: { minLevel: 0.02 } });
    expect(invoke.mock.calls[0][1].method).toBe("saveVoice");
  });

  it("voiceNeeds and voiceQuickInstall pass their arguments through untouched", async () => {
    const invoke = await mockSidecar({
      voiceNeeds: () => [{ kind: "stt", model: { id: "whisper-tiny" } }],
      voiceQuickInstall: () => ({ ok: true })
    });
    const a = await api();
    await a.voiceNeeds(["stt", "tts"]);
    expect(invoke.mock.calls[0][1].args[0]).toEqual(["stt", "tts"]);
    await a.voiceQuickInstall(["tts"], true);
    expect(invoke.mock.calls[1][1]).toMatchObject({ method: "voiceQuickInstall", args: [["tts"], true] });
  });
});

