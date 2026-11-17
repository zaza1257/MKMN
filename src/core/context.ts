import type { ChatMessage } from "../shared/types";
import { artifactsIn, replaceArtifact } from "./artifacts";
import { digestOf, memoMessage } from "./memo";
import { compactHistory, latestArtifacts } from "./review";

/** Prose is about 3.5 characters per token; code and markup about 2.8 (symbols, indentation, short names). */
const TEXT_CPT = 3.5;
const CODE_CPT = 2.8;

/** Tokens of a text, with the code in it (artifact bodies, fenced blocks) counted denser than prose. */
export function tokensOf(text: string): number {
  let code = 0;
  for (const m of text.matchAll(/<artifact[^>]*>([\s\S]*?)(?:<\/artifact>|$)/g)) code += m[1].length;
  for (const m of text.matchAll(/```[\s\S]*?```/g)) code += m[0].length;
  code = Math.min(code, text.length);
  return Math.ceil(code / CODE_CPT + (text.length - code) / TEXT_CPT);
}

const textOf = (m: ChatMessage) => (typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join(""));
const IMAGE_TOKENS = 800;
/** An attached file's block in a message, wrapper tags included (`<attachment>`/`<pdfdoc>`, even cut off at the end). */
const FILE_BODY = /<(attachment|pdfdoc)[^>]*>[\s\S]*?(?:<\/\1>|$)/g;
/** Said in place of every file text that did not fit. */
const OMITTED = "\n[…the rest of this file was left out so the request fits; ask about a part of it and it will be looked up]";
export function messageTokens(m: ChatMessage): number {
  const imgs = typeof m.content === "string" ? 0 : m.content.filter((p) => p.type === "image_url").length;
  return tokensOf(textOf(m)) + imgs * IMAGE_TOKENS + 4;
}
export const promptTokens = (ms: ChatMessage[]) => ms.reduce((n, m) => n + messageTokens(m), 0);

export interface Fitted {
  messages: ChatMessage[];
  /** What was done to make it fit, in plain words (shown under the answer). */
  notes: string[];
  tokens: number;
  /** Still too long after everything: the request is sent anyway and will probably be cut. */
  overflow: boolean;
}

const placeholder = (title: string) => `(the file "${title}" is under "Current files" at the end)`;

/** Replaces every artifact of a message by a pointer, so the code lives once, at the end, in its newest version. */
function liftFiles(m: ChatMessage): ChatMessage {
  if (m.role !== "assistant" || typeof m.content !== "string") return m;
  let text = m.content;
  const arts = artifactsIn(text);
  if (!arts.length) return m;
  // from the last to the first, so earlier positions stay valid
  for (let i = arts.length - 1; i >= 0; i--) {
    const m2 = [...text.matchAll(/<artifact(?:\s[^>]*)?>[\s\S]*?<\/artifact>/g)][i];
    if (m2?.index !== undefined) text = text.slice(0, m2.index) + placeholder(arts[i].title) + text.slice(m2.index + m2[0].length);
  }
  return { ...m, content: text };
}

/**
 * Makes a request fit the model's context instead of letting it overflow in the middle of an answer.
 * 1. old versions of a file are replaced by a note; 2. the files move out of the history to the end, newest version only;
 * 3. the oldest messages are left out; 4. the attached files' text in the last message is cut on one shared, measured budget.
 * The system message and the question are never touched. `overflow: true` means even the required content alone does not
 * fit: the caller must not send the request.
 */
export function fitMessages(messages: ChatMessage[], budgetTokens: number): Fitted {
  const notes: string[] = [];
  let ms = compactHistory(messages);
  const done = (overflow: boolean): Fitted => ({ messages: ms, notes, tokens: promptTokens(ms), overflow });
  if (promptTokens(ms) <= budgetTokens) return done(false);

  // 2. files out of the history to the end, newest versions only. Only the files that fit are carried, the most recently
  // written first: a chat that made five different games must not send all five every time.
  const all = latestArtifacts(messages);
  if (all.length) {
    const lastUser = [...ms].map((m) => m.role).lastIndexOf("user");
    const bare = ms.map((m, i) => (i === lastUser ? m : liftFiles(m)));
    const base = promptTokens(bare) + 120;
    const room = Math.max(0, budgetTokens - base);
    const fileBlock = (a: (typeof all)[number]) => `<artifact type="${a.kind}"${a.kind === "code" ? ` language="${a.language}"` : ""} title="${a.title.replace(/"/g, "'")}">\n${a.content.replace(/\s+$/, "")}\n</artifact>`;
    const carried: typeof all = [];
    let used = 0;
    for (const a of [...all].reverse()) {
      const t = tokensOf(fileBlock(a));
      if (carried.length === 0 || used + t <= room) { carried.push(a); used += t; }
    }
    const left = all.filter((a) => !carried.includes(a));
    const block = `Current files (the files YOU wrote earlier in this conversation, newest version; the user did not paste them. Edit these, never start over):\n${carried.reverse().map(fileBlock).join("\n")}${left.length ? `\n(Older files not shown here: ${left.map((a) => a.title).join(", ")}.)` : ""}`;
    ms = bare;
    if (lastUser >= 0) {
      const u = ms[lastUser];
      ms = ms.map((m, i) => (i === lastUser ? { ...u, content: typeof u.content === "string" ? `${u.content}\n\n${block}` : [...u.content, { type: "text" as const, text: `\n\n${block}` }] } : m));
    }
    notes.push(left.length ? `Only the newest file${carried.length === 1 ? "" : "s"} (${carried.map((a) => a.title).join(", ")}) ${carried.length === 1 ? "is" : "are"} sent; ${left.length} older file${left.length === 1 ? "" : "s"} left out.` : "The files were moved to the end of the request, newest version only.");
  }
  if (promptTokens(ms) <= budgetTokens) return done(false);

  // 3. the oldest turns leave the request, and a short recap of them takes their place (never a bare "left out"): one line each, made
  // without a model. The conversation's real summary, when there is one, is already the first message and is kept whole in the recap.
  const sysAt = ms[0]?.role === "system" ? 1 : 0;
  const recapRoom = Math.min(Math.floor(budgetTokens * 0.12), 700);
  const gone: ChatMessage[] = [];
  while (promptTokens(ms) + recapRoom > budgetTokens && ms.length - sysAt > 2) {
    gone.push(ms[sysAt]);
    ms = [...ms.slice(0, sysAt), ...ms.slice(sysAt + 1)];
  }
  if (gone.length) {
    let chars = Math.floor(recapRoom * 3.2);
    let recap = memoMessage(digestOf(gone, chars), true);
    // the recap itself must fit: it is cut shorter, and left out only when even a few lines do not fit
    while (chars > 120 && promptTokens([...ms.slice(0, sysAt), recap, ...ms.slice(sysAt)]) > budgetTokens) { chars = Math.floor(chars / 2); recap = memoMessage(digestOf(gone, chars), true); }
    if (promptTokens([...ms.slice(0, sysAt), recap, ...ms.slice(sysAt)]) <= budgetTokens) ms = [...ms.slice(0, sysAt), recap, ...ms.slice(sysAt)];
    notes.push(`${gone.length} earlier message${gone.length === 1 ? " was" : "s were"} folded into a short recap to fit the context.`);
  }
  // 4. still too long: the text of the attached files inside the last message is cut to what fits. One shared
  // budget: everything that must be sent besides the file bodies (the system, the history, the question, the
  // images, the wrapper tags and the omission notices) is measured first, and the files share only what is
  // left — nothing is added back on top. The question itself is never touched. The result is measured again,
  // so "fits" is claimed only when the measured request really fits; when the required content alone cannot
  // fit, the note says what to do instead of pretending the request was made room for.
  if (promptTokens(ms) > budgetTokens && ms.length) {
    const at = ms.length - 1;
    const m = ms[at];
    const apply = (keep: number): ChatMessage => {
      const cut = (text: string): string => {
        return text.replace(FILE_BODY, (whole) => {
          const nl = whole.indexOf("\n");
          const head = nl >= 0 ? whole.slice(0, nl + 1) : whole;
          const close = whole.endsWith(">") && /<\/(attachment|pdfdoc)>\s*$/.test(whole) ? `\n</${/^<pdfdoc/.test(whole) ? "pdfdoc" : "attachment"}>` : "";
          const bodyLen = Math.max(0, whole.length - nl - 1 - close.length);
          const kept = Math.max(0, Math.min(bodyLen, keep));
          return `${head}${whole.slice(nl + 1, nl + 1 + kept)}${kept < bodyLen ? OMITTED : ""}${close}`;
        });
      };
      return typeof m.content === "string"
        ? { ...m, content: cut(m.content) }
        : { ...m, content: m.content.map((p) => (p.type === "text" ? { type: "text" as const, text: cut(p.text) } : p)) };
    };
    // the least that can be sent: every other message plus the last one with no file text at all (wrappers and omission notices stay)
    const floor_ = promptTokens([...ms.slice(0, at), apply(0)]);
    if (floor_ > budgetTokens) {
      // name the real parts, so the advice can be followed: only the question can be shortened by the person.
      // The question is the last USER message (it may be the only message), never "whatever sits last".
      const sysTokens = ms[0]?.role === "system" ? messageTokens(ms[0]) : 0;
      const lastUser = ms.map((m) => m.role).lastIndexOf("user");
      const questionTokens = lastUser >= 0 ? messageTokens(ms[lastUser]) : 0;
      const conversationTokens = Math.max(0, floor_ - sysTokens - questionTokens);
      const questionTooBig = questionTokens > budgetTokens / 2;
      notes.push(`The request cannot fit the model's window even with every attached file left out: the system prompt is about ${sysTokens.toLocaleString()} tokens, the conversation about ${conversationTokens.toLocaleString()}, your question about ${questionTokens.toLocaleString()}, and the budget is ${budgetTokens.toLocaleString()}. ${questionTooBig ? "Shorten your message, " : ""}start a new chat, or choose a model with a bigger window. Nothing was sent.`);
    } else {
      // each file gets an equal share of what is left, in characters at the dense rate (2.8 per token), and a
      // remeasure loop halves the share while the estimate is too low: the final measure decides, never the guess
      const nFiles = (textOf(m).match(FILE_BODY) ?? []).length;
      let keep = Math.floor(((budgetTokens - floor_) / nFiles) * 2.8);
      let next = apply(keep);
      for (let tries = 0; promptTokens([...ms.slice(0, at), next]) > budgetTokens && tries < 12; tries++) { keep = Math.floor(keep / 2); next = apply(keep); }
      ms = [...ms.slice(0, at), next];
      notes.push(`The text of the attached files was cut so the request fits the window (each file kept about ${keep.toLocaleString()} characters); the question was kept whole.`);
    }
  }
  return done(promptTokens(ms) > budgetTokens);
}

/** True when a server's error says the request did not fit the window (the wording differs from server to server). */
export function isContextOverflow(message: string): boolean {
  return /exceed(s|ed)?[^.]{0,60}(context|window|n_ctx|ctx)|(context|window|n_ctx|ctx)[^.]{0,60}(exceed|too (long|large|small)|overflow|full|limit)|too (many|long)[^.]{0,30}tokens|prompt is too long|input is too long|n_keep|kv cache|no kv slot|failed to find a memory slot|maximum context length|requested \d+ tokens/i.test(message);
}

/** The reply a model gave up in the middle of, glued to what it wrote when asked to continue (repeated tail removed). */
export function joinContinuation(prev: string, next: string): string {
  const tail = prev.slice(-300);
  for (let k = Math.min(tail.length, next.length, 300); k >= 12; k--) {
    if (next.startsWith(tail.slice(-k))) return prev + next.slice(k);
  }
  return prev + next;
}

/** The names a piece of code defines (functions, classes, constants, element ids), so a continuation that cannot see it still uses them. */
export function surfaceOf(code: string): string {
  const names = new Set<string>();
  for (const m of code.matchAll(/(?:^|\n)\s{0,2}(?:export\s+)?(?:async\s+)?(?:function\*?\s+([\w$]+)|class\s+([\w$]+)|(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function|\(|[\w$]+\s*=>))/g)) names.add(m[1] ?? m[2] ?? m[3]);
  for (const m of code.matchAll(/\bid="([\w-]+)"/g)) names.add(`#${m[1]}`);
  return [...names].slice(0, 40).join(", ");
}

/**
 * The answer written so far, as the model reads it to continue: all of it while it is short, else only its end (from a line start),
 * with a line saying what was left out and what the left-out part defines. A long file would otherwise fill the window by itself.
 */
export function windowAnswer(all: string, keepTokens: number): string {
  if (tokensOf(all) <= keepTokens) return all;
  let tail = all.slice(-Math.floor(keepTokens * 2.8));
  const nl = tail.indexOf("\n");
  if (nl >= 0 && nl < 400) tail = tail.slice(nl + 1);
  const head = all.slice(0, all.length - tail.length);
  const file = [...head.matchAll(/<artifact[^>]*\btitle="([^"]*)"/g)].at(-1)?.[1];
  const names = surfaceOf(head);
  return `[The first ${head.length.toLocaleString()} characters of your answer are left out to leave room${file ? `; they are the start of the file "${file}"` : ""}.${names ? ` They define: ${names}.` : ""} What follows is the end of what you wrote.]\n${tail}`;
}

export const CONTINUE_PROMPT = "You were cut off in the middle of your answer. Continue from the last character you wrote and send only the rest: no greeting, no repetition, and close the file with its closing tag when it is finished.";

/** True when the text ends inside an artifact that was never closed. */
export const endsOpen = (text: string) => {
  const opens = (text.match(/<artifact(?:\s[^>]*)?>/g) ?? []).length;
  const closes = (text.match(/<\/artifact>/g) ?? []).length;
  return opens > closes;
};

export { replaceArtifact };

/** Room kept for the answer inside the window: a share of the window, between 512 and 2048,
 * never more than the answer limit. The old flat "at least 2K" reserve ate half of a
 * 4,096-token window (the QAIRT bundles' compiled size) and twice the window of a
 * 2,048-token model; a proportional share keeps an answer room on every size. */
export const replyReserve = (nctx: number, maxTokens: number) => Math.min(maxTokens, Math.max(512, Math.min(2048, Math.floor(nctx * 0.3))));

export interface RequestUse {
  /** Tokens the request would carry once fitted (what is really sent), including `extraTokens`. */
  usedTokens: number;
  /** What the request can hold: the window minus the room kept for the answer. */
  budgetTokens: number;
  /** The model's whole window (the served context, when known): input budget + output reserve. */
  nctx: number;
  /** The room kept for the answer inside the window. */
  reserveTokens: number;
  /** Counts come from character lengths (about 3.5 characters a token), never the model's tokenizer. */
  estimated: true;
  percent: number;
  level: "ok" | "warn" | "full";
  /** Something had to be left out or moved to make it fit. */
  fitted: boolean;
  overflow: boolean;
  notes: string[];
}

/** How full the NEXT request is, measured after the same fitting that runs before sending: the number that matters. */
export function requestUse(messages: ChatMessage[], o: { nctx: number; maxTokens: number; extraTokens?: number }): RequestUse {
  const reserve = replyReserve(o.nctx, o.maxTokens);
  const budget = Math.max(512, o.nctx - reserve);
  const fit = fitMessages(messages, budget - (o.extraTokens ?? 0));
  const used = fit.tokens + (o.extraTokens ?? 0);
  const percent = Math.min(100, Math.round((used / budget) * 100));
  return { usedTokens: used, budgetTokens: budget, nctx: o.nctx, reserveTokens: reserve, estimated: true, percent, level: percent >= 90 ? "full" : percent >= 70 ? "warn" : "ok", fitted: fit.notes.length > 0, overflow: fit.overflow, notes: fit.notes };
}
