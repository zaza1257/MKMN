// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MicSession } from "../src/renderer/audio";

/**
 * The microphone is never left open: a start that fails after the device opened
 * releases it, and a stop that arrives while the start is still opening the device
 * wins (the stream that arrives late is closed at once).
 */

function fakeStream() {
  const track = { stop: vi.fn() };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

function installAudio(opts: { addModule: () => Promise<void> }) {
  const close = vi.fn(async () => undefined);
  (globalThis as any).AudioContext = class {
    audioWorklet = { addModule: opts.addModule };
    close = close;
    resume = async () => undefined;
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  };
  (globalThis as any).AudioWorkletNode = class { port = { onmessage: null }; };
  return { close };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("MicSession never leaves the microphone open", () => {
  it("releases the device when the start fails after opening it", async () => {
    const { stream, track } = fakeStream();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => stream } });
    installAudio({ addModule: async () => { throw new Error("no worklet"); } });
    const m = new MicSession({ event: () => {}, level: () => {} });
    await expect(m.start()).rejects.toThrow("no worklet");
    expect(track.stop).toHaveBeenCalled();
    expect(m.active).toBe(false);
  });

  it("a stop during the start closes the stream that arrives late", async () => {
    const { stream, track } = fakeStream();
    let release!: (s: MediaStream) => void;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => new Promise<MediaStream>((r) => { release = r; }) } });
    installAudio({ addModule: async () => undefined });
    const m = new MicSession({ event: () => {}, level: () => {} });
    const started = m.start();
    m.stop();
    release(stream);
    await started.catch(() => undefined);
    expect(track.stop).toHaveBeenCalled();
    expect(m.active).toBe(false);
  });
});
