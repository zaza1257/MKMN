export type HumainProvider = "fuse" | "node";
export type HumainMode = "local" | "fuse" | "node";
export interface HumainModel {
  id: string;
  owned_by?: string;
  supported_reasoning_efforts?: string[] | null;
  node?: { api_interface?: string; supported_formats?: string[]; supports_streaming?: boolean };
}
export const HUMAIN_LABEL = { fuse: "HUMAIN Fuse", node: "HUMAIN Node" } as const;
export function cloudProviderOf(mode: unknown): HumainProvider | undefined {
  if (mode === "fuse" || mode === "fuse-node") return "fuse";
  if (mode === "node" || mode === "node-fuse") return "node";
  return undefined;
}

export type HumainUpload = { field: string; filename: string; mime: string; base64: string };
export type HumainResult = { type: "json"; value: unknown } | { type: "file"; mime: string; base64: string };
export const HUMAIN_FEATURES = [
  ["search", "Hosted web search and research"],
  ["images", "Image generation"],
  ["video", "Video generation"],
  ["speech", "Speech synthesis"],
  ["transcription", "Transcription"],
  ["voices", "Custom voices and voice cloning"],
  ["embeddings", "Embeddings"],
  ["rerank", "Reranking"],
  ["systemone", "System One decisions"],
  ["files", "Provider files"],
  ["batch", "Batch jobs"],
  ["realtime", "Node Realtime"],
  ["advancedText", "Text API requests"],
] as const;
export type HumainFeature = typeof HUMAIN_FEATURES[number][0];
export const FUSE_EFFORTS = ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export function featureEnabled(disabled: unknown, feature: HumainFeature): boolean {
  if (disabled && typeof disabled === "object") return (disabled as Record<string, unknown>)[feature] !== true;
  return true;
}

type ModelService = "chat" | "images" | "video" | "speech" | "transcription" | "embeddings" | "rerank" | "systemone" | "realtime";

// From the Fuse model catalog's capability matrix: `/v1/models` carries no modality field, so a model is
// sorted by this table, then by its reasoning efforts (only chat models have them), else left unknown.
const fuseServiceModels: Record<string, ModelService> = {
  "tarjama/llmx-1.0": "chat",
  "tarjama/arabicai-translation": "chat",
  "tarjama/arabicai-vision": "chat",
  "iq/allam-qwen": "chat",
  "tarjama/arabicai-stt": "transcription",
  "tarjama/arabicai-reranker": "rerank",
  "coherelabs/cohere-transcribe-arabic-07-2026": "transcription",
  "tarjama/arabicai-stt2": "transcription",
  "tarjama/arabicai-tts": "speech",
  "openbmb/voxcpm2": "speech",
  "qwen/qwen-image-2512": "images",
  "qwen/qwen3-embedding-8b": "embeddings",
  "tarjama/arabicai-embedding": "embeddings",
  "qwen/qwen3-reranker-4b": "rerank",
  "wan-ai/wan2.2-i2v-a14b": "video",
  "wan-ai/wan2.2-t2v-a14b": "video",
  "convaiinnovations/laya": "systemone",
  "surogate/rune-26b-a4b": "systemone",
};

const nodeFormatService: Record<string, ModelService> = {
  chat_completions: "chat",
  responses: "chat",
  messages: "chat",
  images: "images",
  image_generations: "images",
  embeddings: "embeddings",
  rerank: "rerank",
  systemone: "systemone",
  realtime: "realtime",
};

export function modelServices(provider: HumainProvider, model: HumainModel): ModelService[] {
  if (provider === "fuse") {
    const documented = fuseServiceModels[model.id.toLowerCase()];
    if (documented) return [documented];
    if (model.id === "fuse/auto" || model.id.startsWith("@preset/") || Array.isArray(model.supported_reasoning_efforts)) return ["chat"];
    return [];
  }
  const formats = model.node?.supported_formats;
  const services = [...(Array.isArray(formats) ? formats : []), model.node?.api_interface ?? ""]
    .map((format) => typeof format === "string" ? nodeFormatService[format.replaceAll("/", "_")] : undefined)
    .filter((service): service is ModelService => typeof service === "string");
  return [...new Set(services)];
}

/** Explicit matches first. Incomplete metadata stays selectable and is labelled in the picker. */
export function modelsForService(provider: HumainProvider, models: HumainModel[], service?: ModelService): HumainModel[] {
  if (!service) return models;
  const ranked = models.map((model) => ({ model, services: modelServices(provider, model) }));
  return [
    ...ranked.filter(({ services }) => services.includes(service)),
    ...ranked.filter(({ services }) => services.length === 0),
  ].map(({ model }) => model);
}

export function requestModelService(path: string): ModelService | undefined {
  const [, , family, route] = path.split("?")[0].split("/");
  switch (family) {
    case "responses": case "chat": case "messages": case "completions": return "chat";
    case "images": return "images";
    case "videos": return "video";
    case "audio": return route === "transcriptions" ? "transcription" : "speech";
    case "embeddings": case "rerank": case "systemone": case "realtime": return family;
    default: return undefined;
  }
}
