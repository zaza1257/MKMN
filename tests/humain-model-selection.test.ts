import { describe, expect, it } from "vitest";
import { modelsForService } from "../src/shared/humain";

describe("HUMAIN model selection", () => {
  it("separates Fuse transcription, image and chat models even when the router owns transcription", () => {
    const models = [
      { id: "CohereLabs/cohere-transcribe-arabic-07-2026", owned_by: "vllm" },
      { id: "Qwen/Qwen-Image-2512", owned_by: "fuse" },
      { id: "fuse/auto", owned_by: "fuse" },
      { id: "moonshotai/Kimi-K3", owned_by: "vllm", supported_reasoning_efforts: ["none", "high"] },
    ];
    expect(modelsForService("fuse", models, "chat").map((m) => m.id)).toEqual(["fuse/auto", "moonshotai/Kimi-K3"]);
    expect(modelsForService("fuse", models, "images").map((m) => m.id)).toEqual(["Qwen/Qwen-Image-2512"]);
  });

  it("uses Node metadata without interpreting vision input as image generation", () => {
    const chat = { id: "chat", node: { supported_formats: ["chat_completions"], supports_images: true } };
    const image = { id: "image", node: { api_interface: "images" } };
    const unknown = { id: "unknown" };
    expect(modelsForService("node", [chat, unknown, image], "images")).toEqual([image, unknown]);
    expect(modelsForService("node", [chat, image, unknown], "chat")).toEqual([chat, unknown]);
  });
});
