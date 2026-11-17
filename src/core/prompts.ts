import { ARTIFACT_CORE, ARTIFACT_DRAWN, ARTIFACT_OFFICE, VOICE_RULES } from "./artifacts";
import { BLOCK_INSTRUCTIONS } from "./blocks";
import { SUBAGENT_INSTRUCTIONS } from "./agents";
import { SEARCH_INSTRUCTIONS } from "./websearch";
import { IMAGE_INSTRUCTIONS } from "./wikimedia";
import { VISUAL_OVERVIEW, visualRules, type VisualRoute } from "./visualRoute";
import { replyReserve, tokensOf } from "./context";
import { IDENTITY_BLOCK } from "./harness/identity";
import { CITATIONS_INSTRUCTIONS } from "./cite";

/**
 * The registry of the app's own instruction blocks, and the budget that decides which of them a request carries
 * (docs/design/design-prompt-budget.md). Before this, one monolithic system prompt went with every request that could
 * produce a file: at a 4096-token window it was bigger than the room for the whole request, so a seven-token
 * question was refused before anything was sent — by the app's own arithmetic, not by the model.
 *
 * Two rules hold everywhere:
 *  - the person's message always fits: the instructions take what is left of the window after the reply reserve
 *    and the conversation, with a ceiling at half the window, and drop whole blocks (never a cut rule) down to
 *    the minimal core;
 *  - what a request needs is decided only by an already-chosen route or by the closed questions of `Q`
 *    (src/core/router.ts) — never by word lists or the length of the message.
 */

/** What a request may need, as the routes and closed questions answered it. Inclusion is the default: a flag left unset by a caller means "keep the block". */
export interface Relevance {
  /** The request may produce a file: the artifact format and the edit blocks. */
  artifacts: boolean;
  /** The Word/Excel/PowerPoint text forms: an office file in the chat, the file question answered so, or no answer. */
  office: boolean;
  /** The drawn blocks of a markdown artifact: a document may be written, or no answer came. */
  drawn: boolean;
  /** The request is for a picture (chart, diagram, calculator, quiz...): its rules replace the artifact rules. */
  visual: VisualRoute | null;
  /** The web search instructions. */
  web: boolean;
  /** The Wikimedia pictures instructions. */
  images: boolean;
  /** The sub-agent (delegation) rules. */
  agents: boolean;
  /** The loaded knowledge sections are on the request: the citation markers' rules. An explicit opt-in, on purpose —
   * unlike the flags above, unset means OFF: citations must never ride a request that carries no sections to cite. */
  citations?: boolean;
}

export interface InstructionBlock {
  name: string;
  /** The export constant(s) of src/core this block carries, for the registry-completeness test. */
  covers?: string;
  /** Higher is kept longer; when room runs out the lowest-priority relevant block is the first to go, whole. */
  priority: number;
  /** Which kinds of request may need this block. */
  when: (r: Relevance) => boolean;
  /** Blocks this one refers to: never included without them, never dropped while this one is kept. */
  requires?: string[];
  text: string | ((r: Relevance) => string);
}

/** Every instruction block the app can put into a system prompt, with its priority and its relevance rule. */
export const INSTRUCTION_BLOCKS: InstructionBlock[] = [
  // The one identity of the assistant: top priority, relevant on every route, never dropped.
  IDENTITY_BLOCK,
  { name: "voice", covers: "VOICE_RULES", priority: 100, when: (r) => r.artifacts || r.visual !== null, text: VOICE_RULES },
  { name: "visual", priority: 95, when: (r) => r.visual !== null, text: (r) => visualRules(r.visual!) },
  { name: "artifact", covers: "ARTIFACT_INSTRUCTIONS", priority: 90, when: (r) => r.artifacts, text: ARTIFACT_CORE },
  { name: "drawn", covers: "ARTIFACT_INSTRUCTIONS", priority: 70, when: (r) => r.artifacts && r.drawn, text: ARTIFACT_DRAWN },
  { name: "blocks", covers: "BLOCK_INSTRUCTIONS", priority: 60, when: (r) => (r.artifacts && r.drawn) || r.visual !== null, text: BLOCK_INSTRUCTIONS },
  // The file's own text form comes before the optional block catalogue: a Word or Excel request is unusable
  // without its syntax, while a block the model does not know it can write is a missed extra, not a failure.
  { name: "office", covers: "ARTIFACT_INSTRUCTIONS", priority: 65, requires: ["drawn"], when: (r) => r.artifacts && r.office, text: ARTIFACT_OFFICE },
  { name: "search", covers: "SEARCH_INSTRUCTIONS", priority: 50, when: (r) => r.web, text: SEARCH_INSTRUCTIONS },
  { name: "images", covers: "IMAGE_INSTRUCTIONS", priority: 50, when: (r) => r.images, text: IMAGE_INSTRUCTIONS },
  { name: "subagent", covers: "SUBAGENT_INSTRUCTIONS", priority: 50, when: (r) => r.agents, text: SUBAGENT_INSTRUCTIONS },
  { name: "citations", covers: "CITATIONS_INSTRUCTIONS", priority: 45, when: (r) => r.citations === true, text: CITATIONS_INSTRUCTIONS },
  { name: "overview", covers: "VISUAL_OVERVIEW", priority: 40, when: (r) => r.artifacts && r.drawn, text: VISUAL_OVERVIEW }
];

/** The smallest instruction budget: the minimal core (voice + artifact format + edit blocks, about 400 tokens measured), with a little room. */
export const CORE_FLOOR = 480;

/**
 * The room the instructions may take: what is left of the window after the reply reserve, the conversation and
 * the appended text, with a ceiling at half the window (instructions never crowd out the answer on any size),
 * and a floor at the minimal core (the app's own text is never the reason a request fails).
 */
export function instructionBudgetFor(nctx: number, maxTokens: number, conversationTokens: number, appendTokens = 0): number {
  const room = nctx - replyReserve(nctx, maxTokens) - conversationTokens - appendTokens;
  return Math.max(CORE_FLOOR, Math.min(room, Math.floor(nctx / 2)));
}

/** The measurement's own slack: blocks are sized by `tokensOf` but the finished request is measured by
 *  `promptTokens` (+4 per message) and joined with separators — a few tokens of error. The appends are
 *  optional by design, so they leave this margin instead of risking the whole request on the estimate. */
const APPEND_MARGIN = 32;

/** The budget for the sidecar's appends (search, images, sub-agents, a folder), which have no floor: when nothing fits, none go. */
export function appendBudget(nctx: number, usedTokens: number): number {
  return Math.max(0, Math.min(nctx - replyReserve(nctx, 4096) - usedTokens - APPEND_MARGIN, Math.floor(nctx / 2)));
}

/**
 * Assembles the instruction text for a request: the relevant blocks, highest priority first, while they fit the
 * budget. A block that does not fit is dropped WHOLE (a cut rule is worse than no rule), and a kept block is
 * never separated from the blocks it refers to. The core is never dropped: whatever happens, the model is told
 * who speaks and what format to write.
 *
 * The size is measured on the JOINED text, not as the sum of the blocks: a block that opens markup (an
 * `<artifact` snippet, a code fence) makes the following text count at the denser rate once joined, and the
 * sum used to under-report the finished instruction text by hundreds of tokens.
 */
export function assembleInstructions(r: Relevance, budget: number, extras: InstructionBlock[] = [], keepFirst = true): { text: string; tokens: number; dropped: string[] } {
  const blocks = [...INSTRUCTION_BLOCKS, ...extras].filter((b) => b.when(r));
  const byName = new Map(blocks.map((b) => [b.name, b]));
  const kept = new Set<string>();
  const textOf = (names: Set<string>) => blocks.filter((b) => names.has(b.name)).map((b) => (typeof b.text === "string" ? b.text : b.text(r))).join("\n\n");
  for (const b of [...blocks].sort((x, y) => y.priority - x.priority || x.name.localeCompare(y.name))) {
    if (kept.has(b.name)) continue;
    const next = new Set(kept);
    for (const d of b.requires ?? []) if (!next.has(d) && byName.has(d)) next.add(d);
    next.add(b.name);
    const text = textOf(next);
    if (tokensOf(text) <= budget || (keepFirst && kept.size === 0)) {
      kept.clear();
      for (const name of next) kept.add(name);
    }
  }
  const text = textOf(kept);
  return { text, tokens: tokensOf(text), dropped: blocks.filter((b) => !kept.has(b.name)).map((b) => b.name) };
}

/**
 * The sidecar's appends (search, images, sub-agents, a project folder) joined into one text that fits what is
 * left of the window after the whole request so far (the renderer's system prompt, the conversation, the
 * question). Unlike the core blocks, an append that does not fit is simply left out: the feature still works,
 * the request just does not carry its rules.
 */
export function appendInstructions(r: Relevance, nctx: number, usedTokens: number, extras: InstructionBlock[] = []): { text: string; tokens: number; dropped: string[] } {
  // No floor for appends: with no room left, none go at all (a feature still works without its rules).
  return assembleInstructions(r, appendBudget(nctx, usedTokens), extras, false);
}
