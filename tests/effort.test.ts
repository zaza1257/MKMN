import { describe, expect, it } from "vitest";
import { applyEffort, autoEffort, effectiveEffort, effortsFor, visionSupport } from "../src/core/effort";

describe("Auto thinking level", () => {
  it("does not think for a plain request", () => {
    expect(autoEffort("translate_other", "Translate this text").level).toBe("off");
    expect(autoEffort("chat", "hi").level).toBe("off");
    expect(autoEffort("web_code", "Make a snake game").level).toBe("off");
  });
  it("thinks for maths, logic and plans", () => {
    expect(autoEffort("math", "What is 17 x 23?").level).toBe("medium");
    expect(autoEffort("reasoning", "Three friends each have a hat").level).toBe("medium");
  });
  it("thinks carefully for a demanding or long one", () => {
    expect(autoEffort("math", "Prove that the square root of 2 is irrational").level).toBe("high");
    expect(autoEffort("planning", "x".repeat(600)).level).toBe("high");
  });
  it("thinks briefly to mend code", () => {
    expect(autoEffort("code_repair", "This error shows up").level).toBe("low");
  });
  it("is offered to thinking models only, and leaves the request alone if unresolved", () => {
    expect(effortsFor("toggle")[0]).toBe("auto");
    expect(effortsFor("always")).toContain("auto");
    expect(effortsFor("none")).toEqual([]);
    expect(effectiveEffort("auto", "none")).toBeNull();
    expect(effectiveEffort("auto", "toggle")).toBe("auto");
    const msgs = [{ role: "user" as const, content: "hi" }];
    expect(applyEffort("auto", msgs, { id: "qwen3-4b", name: "Qwen3 4B", repo: "" })).toEqual({ messages: msgs, body: {} });
  });
});

describe("visionSupport (F15)", () => {
  it("does NOT claim image input for the text-only Gemma 3 1B", () => {
    expect(visionSupport({ id: "gemma-3-1b-it", name: "Gemma-3-1B-it", repo: "unsloth/gemma-3-1b-it-GGUF" })).toBe(false);
  });

  it("still claims it for the vision-capable members of the same families", () => {
    expect(visionSupport({ id: "gemma-3-4b-it", name: "Gemma-3-4B-it", repo: "unsloth/gemma-3-4b-it-GGUF" })).toBe(true);
    expect(visionSupport({ id: "vlm", name: "VLM", repo: "ai-hub-models/Qwen2.5-VL" })).toBe(true);
  });
});
