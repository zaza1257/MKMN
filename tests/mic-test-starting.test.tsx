// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { MicTest } from "../src/renderer/VoiceSetup";

/**
 * The microphone test showed nothing while the device was opening (Windows can
 * take seconds, or wait on a permission), and a click then did nothing. It now
 * says "Starting the microphone…" and the button cancels the start; the stream
 * that arrives late is closed.
 */

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const voice = { minLevel: 0.02 } as any;

describe("the microphone test shows its start and can cancel it", () => {
  it("shows Starting… and a Cancel button while the device opens, and Cancel closes the late stream", async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    let release!: (s: MediaStream) => void;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => new Promise<MediaStream>((r) => { release = r; }) } });
    (globalThis as any).AudioContext = class { audioWorklet = { addModule: async () => undefined }; close = async () => undefined; resume = async () => undefined; createMediaStreamSource() { return { connect() {}, disconnect() {} }; } };
    (globalThis as any).AudioWorkletNode = class { port = { onmessage: null }; };

    render(<MicTest voice={voice} />);
    fireEvent.click(screen.getByRole("button", { name: "Test the microphone" }));
    expect(screen.getByRole("status").textContent).toBe("Starting the microphone…");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Test the microphone" })).toBeTruthy();
    await act(async () => { release(stream); await new Promise((r) => setTimeout(r, 0)); });
    expect(track.stop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Test the microphone" })).toBeTruthy();
  });

  it("the voice chat names hearing apart from waiting to listen", () => {
    const chat = readFileSync("src/renderer/Chat.tsx", "utf8");
    expect(chat).toMatch(/hearing: "Hearing you…"/);
  });
});
