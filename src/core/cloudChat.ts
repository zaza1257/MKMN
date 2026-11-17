import type { CatalogEntry } from "../shared/types";
import type { Served } from "./chatOrchestrator";
import { registerEndpointAuth } from "./chat";
import { HUMAIN_ORIGINS } from "./humain";

/**
 * Chat on HUMAIN Fuse goes through the app's own pipeline (files, builds, checked charts, project
 * knowledge, the per-turn budget, long-chat summaries): Fuse is served to the orchestrator as an
 * OpenAI-compatible endpoint. Nothing here starts a process or touches the NPU.
 */

/** The model id the window sends for a chat on a HUMAIN provider. */
export const CLOUD_CHAT_ID = "humain:chat";
export const FUSE_ENDPOINT = `${HUMAIN_ORIGINS.fuse}/v1`;

/** The chosen Fuse model as a catalog entry: no file, no size, no engine to start. */
export function fuseEntry(model: string, maxModelLen: number | null): CatalogEntry {
  return {
    id: CLOUD_CHAT_ID, name: `HUMAIN Fuse · ${model}`, repo: model, quant: null, engine: "llama_cpp",
    role: "chat", architecture: "cloud", sizeGB: 0, cloud: "fuse",
    recommendedContext: maxModelLen ?? 32768,
    sampling: { temperature: 0.7, top_p: 0.95, max_tokens: 8192 },
  };
}

/** Where the orchestrator sends its requests for Fuse; the key and the Fuse effort ride every request to it. */
export function fuseServed(o: { model: string; key: string; maxModelLen: number | null; effort?: unknown }): Served {
  const effort = typeof o.effort === "string" && o.effort && o.effort !== "default" ? o.effort : null;
  registerEndpointAuth(FUSE_ENDPOINT, {
    headers: { Authorization: `Bearer ${o.key}` },
    ...(effort ? { body: { reasoning_effort: effort } } : {}),
  });
  return { endpoint: FUSE_ENDPOINT, model: o.model, status: () => ({ nctx: o.maxModelLen, contextKind: null }) };
}
