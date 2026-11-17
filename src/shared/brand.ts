/**
 * Approved brand copy for MKMN AI (English only — see docs/design/BRAND.md).
 *
 * Pure shared module: no renderer or Node imports, so both the renderer and any
 * non-renderer code can use it. Core approved strings live here; status-derived
 * copy whose wording must follow runtime evidence lives beside the logic that
 * verifies that evidence (`src/core/settingsUi.ts` execution labels,
 * `src/core/setupView.ts` setup outcomes) and is pinned by tests.
 *
 * Internal identifiers (app id, executable name, storage keys, protocol names)
 * are NOT part of branding and stay untouched for compatibility.
 */
export const BRAND = {
  /** Public-facing brand, used in headings, the title bar and window text. */
  name: "MKMN AI",
  /** Compact brand for tight spaces (buttons, logs, tray). */
  shortName: "MKMN",
  /** The Arabic name, shown beside the Latin one: makman, an oil reservoir. */
  arabicName: "مكمن",
  /** The full lockup: "MKMN AI | مكمن". */
  fullName: "MKMN AI | مكمن",
  /** Primary tagline — the only slogan used across the product. */
  tagline: "Your Private Intelligence Reservoir.",
  /** Supporting message, under the tagline on About and setup. */
  supporting: "Your Knowledge. Your Device. Your Control.",
  /** Product descriptor for About and promotional surfaces. */
  descriptor: "Private AI that runs on your own PC.",

  welcome: {
    heading: "Welcome to MKMN AI",
    description: "Think, write, and explore with AI running on your PC.",
  },
  emptyChat: "What would you like to explore?",
  composerPlaceholder: "Ask a question or add a document…",
  modelReady: "Ready on this device",
  downloadNote: "An internet connection is needed for this download.",
  /** Shown only where the runtime actually reports local execution — see the
   *  execution-verification mapping; never inferred from being offline. */
  localProcessing: "Processing on this device",
  generationFailure: "Couldn't complete the response. Try again.",
  aboutStory:
    "MKMN (مَكْمَن, pronounced MAK-man) takes its name from the Arabic word for an oil reservoir. A reservoir keeps something valuable safe beneath the surface; MKMN AI is a private reservoir for your own knowledge, storing, understanding and retrieving it on your device. MKMN stores chats and documents on this PC. With a local model installed, you can chat offline.",
  productExplainer:
    "With a compatible model installed, AI processing runs on this PC. Model downloads and optional connected tools require an internet connection.",
  connectedNote:
    "Local inference runs separately on this PC, where your chats and documents are stored. When you enable HUMAIN cloud chat, MKMN sends conversation context and attachments to the selected provider.",
  /** Statement of independence — required disclosure, see docs/design/BRAND.md. */
  independence:
    "MKMN AI is an independent project and is not affiliated with or endorsed by any company or organization.",
  /** The product's own licence (the full notices are in LICENSE and THIRD_PARTY_NOTICES.md). */
  attribution:
    "MKMN is open source, released under the MIT License. Runtime dependencies and model files have their own terms; review their licenses before use.",
} as const;
