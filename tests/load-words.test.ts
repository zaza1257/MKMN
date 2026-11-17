// A model that does not run on the NPU must never be shown as loading onto it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadDevice, loadFailedLabel, loadingLabel, loadPhrases, warmingLabel } from "../src/core/loadWords";

describe("loading words follow the real device", () => {
  it("a CPU or hybrid model never claims the NPU alone", () => {
    expect(loadingLabel(loadDevice("cpu", "npu"))).toBe("Loading the model on the processor");
    expect(loadingLabel("hybrid")).toBe("Loading the model onto the NPU and the processor");
    expect(warmingLabel("cpu")).not.toMatch(/NPU/);
    expect(loadPhrases("cpu").join(" ")).not.toMatch(/NPU/);
    expect(loadFailedLabel("cpu")).toBe("The model could not be loaded on the processor");
  });
  it("an NPU model still says NPU, and an unknown one names no device", () => {
    expect(loadingLabel(loadDevice(undefined, "npu"))).toBe("Loading the model onto the NPU");
    expect(loadingLabel(null)).toBe("Loading the model");
  });
  it("the chat no longer hard-codes the NPU in its loading line or chip", () => {
    const chat = readFileSync("src/renderer/Chat.tsx", "utf8");
    expect(chat).not.toContain('label="Loading the model onto the NPU"');
    expect(chat).not.toContain("NPU Warming Up...");
    expect(readFileSync("src/renderer/preloadController.ts", "utf8")).not.toContain("could not be warmed");
  });
});
