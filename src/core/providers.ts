/**
 * Inference providers and artifact sources — two different things, kept apart.
 *
 * An ARTIFACT SOURCE is where model files come from (Hugging Face, the Foundry
 * catalog, …). An INFERENCE PROVIDER is what actually answers a chat: every
 * chat completion in this app goes to a localhost OpenAI-compatible endpoint
 * (`src/core/chat.ts streamChat`); there is no remote LLM provider anywhere.
 *
 * This table is the contract the UI and the tests pin: what each provider is
 * FOR, which build it exists in, what it was verified to do on this machine —
 * and, critically, its EGRESS: whether user content can leave the PC through
 * it. Anything that is not a localhost loopback is marked explicitly, so a
 * prompt can never be routed somewhere remote without the user choosing it.
 */

export type ProviderId =
  | "geniex-qairt"
  | "geniex-gguf"
  | "foundry"
  | "llama-server"
  | "router"
  | "voice-sherpa";

export type Build = "both" | "electron" | "tauri";
export type Egress = "loopback-only" | "local-files" | "web-keywords" | "remote-content";

export interface ProviderCard {
  id: ProviderId;
  name: string;
  /** What role this provider plays: which requests can reach it and how. */
  role: string;
  /** The builds it is wired in: the Tauri app, the legacy desktop build, or both. */
  builds: Build[];
  /** The endpoint content is sent to; `null` when it serves no chat endpoint. */
  endpoint: string | null;
  /** Where user content goes through this provider, honestly classified. */
  egress: Egress;
  /** The egress explanation shown to the user (also drives the matrix). */
  egressNote: string;
  /** What this provider's thinking support actually is — verified vs unknown. */
  thinking: "verified" | "declared-only" | "none" | "not-applicable";
  /** Vision input: verified on this machine, declared by metadata, or none. */
  vision: "verified" | "declared-only" | "none" | "not-applicable";
  /**
   * What was verified ON THE REFERENCE MACHINE the app was developed on — a
   * fact about THAT machine, shipped as documentation. It is never displayed
   * as this device's status: a compiled-in "validated: true" would read the
   * same on every computer, which is exactly the claim it cannot make. THIS
   * device's status is the per-device evidence store (the badges in Models).
   * `null`: not validated anywhere.
   */
  validatedOnReferenceMachine: {
    machine: string;
    paths: { discovery: boolean; download: boolean; load: boolean; inference: boolean };
  } | null;
  notes: string[];
}

/** The machine the shipped validation records were made on. */
const REFERENCE_MACHINE = "the reference PC (Snapdragon X2 Elite, GenieX v0.10.0)";

export const PROVIDERS: ProviderCard[] = [
  {
    id: "geniex-qairt",
    name: "GenieX (QAIRT)",
    role: "Primary chat inference: the Qualcomm-compiled NPU bundles the cache ships.",
    builds: ["both"],
    endpoint: "http://127.0.0.1:18181/v1",
    egress: "loopback-only",
    egressNote: "Every request stays on this PC: the endpoint is 127.0.0.1. Nothing leaves the machine.",
    thinking: "verified",
    vision: "verified",
    validatedOnReferenceMachine: { machine: REFERENCE_MACHINE, paths: { discovery: true, download: true, load: true, inference: true } },
    notes: [
      "Thinking is switched with enable_think:false on GenieX v0.10.0 (chat_template_kwargs.enable_thinking is a no-op there).",
      "Context is the compiled graph's context (4096 for the cached Qwen3-4B): a larger requested nctx is refused, not silently truncated.",
    ],
  },
  {
    id: "geniex-gguf",
    name: "GenieX (GGUF)",
    role: "Chat inference over GGUF artifacts the cache downloaded (llama.cpp plugin under GenieX).",
    builds: ["both"],
    endpoint: "http://127.0.0.1:18181/v1",
    egress: "loopback-only",
    egressNote: "Same localhost endpoint as the QAIRT bundles; only the artifact format differs.",
    thinking: "declared-only",
    vision: "verified",
    validatedOnReferenceMachine: { machine: REFERENCE_MACHINE, paths: { discovery: true, download: true, load: true, inference: true } },
    notes: [
      "Vision projector (mmproj) artifacts answer image input — verified end to end on the reference machine.",
      "Thinking support comes from the GGUF's chat template, not verified per artifact here.",
    ],
  },
  {
    id: "foundry",
    name: "Foundry Local",
    role: "Chat inference over Microsoft Foundry Local models (catalog + cached artifacts).",
    builds: ["electron"],
    endpoint: "http://127.0.0.1:<port>/v1",
    egress: "loopback-only",
    egressNote: "Loopback only — in the Electron build. The Tauri build returns honest stubs for it.",
    thinking: "none",
    vision: "none",
    validatedOnReferenceMachine: null,
    notes: [
      "NOT validated — no Foundry install was available on the reference machine either.",
      "Discovery, download, load and inference all count as unvalidated until run.",
    ],
  },
  {
    id: "llama-server",
    name: "llama.cpp server",
    role: "Chat inference over a user-supplied GGUF file via llama-server (engine comparison).",
    builds: ["electron"],
    endpoint: "http://127.0.0.1:<port>/v1",
    egress: "loopback-only",
    egressNote: "Loopback only — in the Electron build; the Tauri build does not ship it.",
    thinking: "none",
    vision: "none",
    validatedOnReferenceMachine: null,
    notes: ["Not validated anywhere; kept for the engine-comparison path only."],
  },
  {
    id: "router",
    name: "Router model",
    role: "A small local model that classifies the CURRENT message (page tools: search, vision helpers).",
    builds: ["both"],
    endpoint: "http://127.0.0.1:18182/v1",
    egress: "web-keywords",
    egressNote: "Reads the message text locally on 127.0.0.1 and can read local screenshot/image files. Sends only search KEYWORDS to the web — never the chat text — and only when the search setting is on and the turn asks for the web.",
    thinking: "none",
    vision: "none",
    validatedOnReferenceMachine: { machine: REFERENCE_MACHINE, paths: { discovery: true, download: true, load: true, inference: true } },
    notes: [
      "Silently consumes message text by design: it decides whether a page-block action applies. Documented here so the behavior is a stated contract, not a hidden one.",
    ],
  },
  {
    id: "voice-sherpa",
    name: "Voice (Sherpa)",
    role: "Speech-to-text and text-to-speech for voice chat — never a chat responder.",
    builds: ["both"],
    endpoint: null,
    egress: "local-files",
    egressNote: "Runs locally on the PC's audio and text. No network calls.",
    thinking: "not-applicable",
    vision: "not-applicable",
    validatedOnReferenceMachine: { machine: REFERENCE_MACHINE, paths: { discovery: true, download: true, load: true, inference: true } },
    notes: ["Model files are protected by a .complete marker, so a partial download is never served."],
  },
];

// ---------------------------------------------------------------------------
// Artifact sources: where model FILES come from. They produce artifacts for the
// inference providers above; they never answer a chat themselves.
// ---------------------------------------------------------------------------

export interface ArtifactSource {
  id: string;
  name: string;
  /** What it downloads/imports, and for which provider. */
  role: string;
  /** Duplicate-import protection status: where a re-download is prevented. */
  duplicateProtection: "protected" | "protected-now" | "unprotected";
  protectionNote: string;
}

export const ARTIFACT_SOURCES: ArtifactSource[] = [
  {
    id: "geniex-cache",
    name: "GenieX cache (geniex download)",
    role: "Downloads QAIRT bundles and GGUF artifacts into ~/.cache/geniex/models — the cache the manifest scans.",
    duplicateProtection: "protected-now",
    protectionNote: "Install entry points now check listInstalled / the existing artifact directory before pulling, so the same artifact is not fetched twice.",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    role: "Resolves repo files for GGUF downloads and custom models.",
    duplicateProtection: "protected-now",
    protectionNote: "The destination file is checked before a direct GGUF download starts.",
  },
  {
    id: "foundry-catalog",
    name: "Foundry Local catalog",
    role: "Lists and caches Foundry models (Electron build only).",
    duplicateProtection: "protected-now",
    protectionNote: "Install checks foundry.cached() before downloading.",
  },
  {
    id: "modelscope",
    name: "ModelScope",
    role: "An alternative mirror the custom-model resolver can read from.",
    duplicateProtection: "protected-now",
    protectionNote: "Shares the GenieX download path, which is duplicate-checked.",
  },
  {
    id: "ai-hub",
    name: "AI Hub (Qualcomm)",
    role: "The legacy publisher namespace for QAIRT bundles (mapped to qualcomm/ in the cache).",
    duplicateProtection: "protected-now",
    protectionNote: "The identity resolver maps ai-hub-models/ onto the cache's qualcomm/ spelling, so one artifact is one identity across both names.",
  },
  {
    id: "sherpa",
    name: "Sherpa voice models",
    role: "Voice STT/TTS model downloads.",
    duplicateProtection: "protected",
    protectionNote: "A .complete marker file guards against serving or re-fetching a partial download.",
  },
];

/** The provider a catalog entry uses, for the matrix and the UI. Classified by
 * the RESOLVED engine where the caller knows it: an id alone cannot tell the
 * QAIRT bundle from the GGUF build of the same model, and the old fallback
 * (first GenieX card) answered "GenieX (QAIRT)" even for ids that are neither. */
export function providerFor(entryId: string, engine?: string): ProviderCard | undefined {
  if (entryId.startsWith("foundry:")) return PROVIDERS.find((p) => p.id === "foundry");
  if (engine === "qairt") return PROVIDERS.find((p) => p.id === "geniex-qairt");
  if (engine === "llama_cpp") return PROVIDERS.find((p) => p.id === "geniex-gguf");
  if (entryId.startsWith("custom:")) return PROVIDERS.find((p) => p.id === "geniex-gguf");
  return undefined;
}

/** Providers available in a given build (the UI gates on this). */
export function providersForBuild(build: Build): ProviderCard[] {
  return PROVIDERS.filter((p) => p.builds.includes(build) || p.builds.includes("both"));
}
