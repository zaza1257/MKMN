import { describe, it, expect, vi, beforeEach } from "vitest";
import { VoiceChat, type VoiceHandlers, type VoiceState } from "../src/renderer/voiceChat";
import { DEFAULT_VOICE_SETTINGS } from "../src/core/voiceModels";
import { canTransition } from "../src/shared/stateMachines";
import type { VadEvent } from "../src/core/vad";
import type { VoiceSettings } from "../src/shared/types";

/**
 * Stop / dispose while a transcription is still in flight (the P2 voice finding):
 * the words that come back after stop() was pressed must never be sent as a message.
 * The microphone and the application API are fakes; VoiceChat itself is the real class.
 */

vi.mock("../src/renderer/api", () => ({
  api: () => (globalThis as unknown as { __fakeApi: unknown }).__fakeApi,
}));

type MicEvent = { event: (e: VadEvent) => void; level: (l: number) => void; block?: () => void };

vi.mock("../src/renderer/audio", () => ({
  MicSession: class FakeMic {
    events: MicEvent;
    constructor(on: MicEvent) { this.events = on; }
    configure() { /* nothing */ }
    async start() { /* nothing */ }
    stop() { /* nothing */ }
    setEndSilence() { /* nothing */ }
    snapshot() { return new Float32Array(0); }
    get speaking() { return true; }
    get quietMs() { return 0; }
    get active() { return true; }
    setUserMute() { /* nothing */ }
    get userMute() { return false; }
    mute() { /* nothing */ }
    setBargeIn() { /* nothing */ }
    switchInput() { return Promise.resolve(true); }
  },
  Player: class {
    onIdle = () => {};
    enqueue() { /* nothing */ }
    get playing() { return false; }
    pause() { /* nothing */ }
    resume() { /* nothing */ }
    stop() { /* nothing */ }
    level() { return 0; }
    heard() { return new Map(); }
  },
}));

const drain = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function makeChat() {
  const states: VoiceState[] = [];
  const pairs: [VoiceState, VoiceState][] = [];
  const utterances: string[] = [];
  let previous: VoiceState = "idle";
  let resolveTranscribe: ((t: string | null) => void) | null = null;
  const api = {
    transcribe: vi.fn(() => new Promise<string | null>((res) => { resolveTranscribe = res; })),
    speak: vi.fn(async () => {}),
    cancelSpeak: vi.fn(async () => {}),
    onVoiceAudio: vi.fn(() => () => {}),
    onVoiceStatus: vi.fn(() => () => {}),
    onVoiceDownload: vi.fn(() => () => {}),
  };
  (globalThis as unknown as { __fakeApi: unknown }).__fakeApi = api;

  const handlers: VoiceHandlers = {
    state: (s) => { pairs.push([previous, s]); previous = s; states.push(s); },
    level: () => {},
    utterance: (t) => utterances.push(t),
    live: () => {},
    interrupt: () => {},
    error: () => {},
  };
  const cfg = (): VoiceSettings => ({ ...(DEFAULT_VOICE_SETTINGS as VoiceSettings) });
  const vc = new VoiceChat(handlers, cfg);
  const emit = (e: VadEvent) => vc["mic"].events.event(e);
  return { vc, states, pairs, utterances, emit, resolveTranscribe: () => resolveTranscribe, api };
}

const END: VadEvent = { type: "end", samples: new Float32Array(16000), durationMs: 1000, speechSamples: 16000, rms: 0.2 };

beforeEach(() => {
  delete (globalThis as unknown as { __fakeApi?: unknown }).__fakeApi;
});

describe("stopping a voice chat while its transcription is in flight", () => {
  it("never sends the words that come back after stop()", async () => {
    const { vc, states, utterances, emit, resolveTranscribe } = makeChat();
    await vc.start();
    emit({ type: "start" });
    emit(END);
    await drain();
    expect(states).toContain("transcribing");          // the transcription is underway
    vc.stop();                                          // the person pressed stop
    expect(vc.current).toBe("idle");
    resolveTranscribe()!("please make a chart");        // the late answer arrives
    await drain();
    expect(utterances).toEqual([]);                     // it must not become a message
    expect(vc.current).toBe("idle");
  });

  it("still sends the words when the session was not stopped", async () => {
    const { vc, states, utterances, emit, resolveTranscribe } = makeChat();
    await vc.start();
    emit({ type: "start" });
    emit(END);
    await drain();
    resolveTranscribe()!("please make a chart");
    await drain();
    expect(utterances).toEqual(["please make a chart"]);
    expect(states[states.length - 1]).toBe("thinking");
  });
});

describe("the voice state machine", () => {
  it("makes every move of a whole session one the registry lists", async () => {
    const { vc, pairs, emit, resolveTranscribe } = makeChat();
    await vc.start();                             // idle -> listening
    emit({ type: "start" });                      // listening -> hearing
    emit(END);                                    // hearing -> transcribing
    await drain();
    resolveTranscribe()!("what is on my screen"); // transcribing -> thinking
    await drain();
    vc.endAnswer();                               // thinking -> listening (microphone open)
    await drain();
    vc.stop();                                    // listening -> idle
    expect(pairs.length).toBeGreaterThan(4);
    for (const [from, to] of pairs) {
      expect(canTransition("voice", from, to), `${from} -> ${to} must be in docs/state-machines.md`).toBe(true);
    }
  });
});

describe("a reading stopped in a typed chat", () => {
  // Stopping a Read aloud left the voice state at "speaking", and a typed chat read every following reply aloud
  // because its state was no longer idle.
  it("puts the voice state back to idle when no voice chat is listening", async () => {
    const { vc, states } = makeChat();
    Object.defineProperty(vc["mic"], "active", { get: () => false });
    vc.readAloud("Hello there. This is a reply.");
    await drain();
    expect(states.at(-1)).toBe("speaking");
    vc.cancelSpeech();
    expect(states.at(-1)).toBe("idle");
  });
  it("goes back to listening when a voice chat is on", async () => {
    const { vc, states } = makeChat();
    vc.readAloud("Hello there.");
    await drain();
    vc.cancelSpeech();
    expect(states.at(-1)).toBe("listening");
  });
});
