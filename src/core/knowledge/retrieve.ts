/**
 * Retrieval's own shapes, shared by the orchestrator's retrieve step: how a
 * section names its place ("p. 150", "slide 3", "Parts rows 41-80"), what the
 * locator model sees, and how the picked sections are packed into the
 * knowledge block. Pure text work, no model calls and no file system — the
 * orchestrator (chatOrchestrator.ts) owns the calls, the run step and the
 * offload store; the renderer may reuse the shapes to show what was loaded.
 */
import { inFrame } from "../frames";
import { parseLocatorReply } from "../pdfSections";
import { sectionsOf, tokenize, type KnowledgeFileLike } from "./index";

const OWNERSHIP_WORDS = /\b(?:own(?:s|ed|ership)?|stake|equity interest|shareholding)\b/i;
const OWNERSHIP_FIGURE = /\b\d+(?:\.\d+)?\s*(?:%|percent\b)\s+(?:equity interest|(?:ownership|equity)\s+stake|stake|ownership|shareholding|of (?:the )?shares)\b|\b(?:owns?|owned|holds?|held|acquired|retains?|retained|retaining)\s+(?:an?\s+)?\d+(?:\.\d+)?\s*(?:%|percent\b)/gi;
const OWNERSHIP_STOP = new Set("a an and are as at by company did do does for has have held hold holds how in is it much of on or own owned ownership owns percent percentage share shares shareholding stake the to was were what which who with equity interest".split(" "));

export const asksOwnership = (ask: string) =>
  OWNERSHIP_WORDS.test(ask) && /\b(?:how much|what|which|who|percent(?:age)?|split)\b|%/i.test(ask);

/** For a direct ownership lookup, preserve the source sentence's entity-to-number relationships. */
export function ownershipPassage(files: KnowledgeFileLike[], question: string) {
  const subject = [...new Set(tokenize(question).filter((word) => !OWNERSHIP_STOP.has(word) && !/^\d+$/.test(word)))];
  if (!subject.length) return null;
  const matches = files.flatMap((file) => sectionsOf(file).flatMap((section) => {
    const text = section.text.replace(/\s+/g, " ");
    return text.split(/(?<=[.!?])\s+(?=[A-Z])/).flatMap((sentence) => {
      const words = new Set(tokenize(sentence));
      const figures = [...sentence.matchAll(OWNERSHIP_FIGURE)].length;
      if (figures < 1 || sentence.length > 650 || !subject.every((word) => words.has(word))) return [];
      // PDF extraction can put a heading immediately before the first sentence of a disclosure.
      const passage = sentence.replace(/^.*?\b(?=On [A-Z][a-z]+ \d{1,2}, \d{4}, )/, "");
      return [{ file: file.name, place: placeOf(section), passage, score: figures }];
    });
  }));
  const best = matches.sort((a, b) => b.score - a.score)[0];
  // If different statements tie, the requested scope needs clarification.
  return best && !matches.some((m) => m.score === best.score && m.passage !== best.passage) ? best : null;
}

// ---------------------------------------------------------------- figures quoted from the source

/**
 * The words a question is asked WITH, not ABOUT (English and Arabic): left out
 * of the subject a figure's sentence must hold and of the share a strong match
 * must cover. Scoring words, the way BM25 itself works on words; never a
 * decision about what kind of request this is.
 */
export const QUERY_STOP = new Set(
  ("a an and are as at be by can could did do does for from had has have how i in into is it its me much many my of on or our "
    + "please show tell than that the their there these this those to was we were what when where which who whom whose will with "
    + "would you your about give find any all "
    + "ما ماذا من متى كم كيف هل في على عن الى إلى هو هي ذلك هذا هذه التي الذي او أو").split(" ").flatMap((w) => tokenize(w)),
);

/** A word reduced to its stem for matching a question to a sentence: "declare" meets "declared", "share" meets "shares". English only; Arabic words are matched as the index folds them. */
export function stemOf(word: string): string {
  if (!/^[a-z]+$/.test(word) || word.length <= 4) return word;
  return word.replace(/(?:ing|ed|es|s)$/, "").replace(/e$/, "");
}

const MONTH = "(?:January|February|March|April|May|June|July|August|September|October|November|December)";
/** A reporting period named in a question: a quarter, a half, a fiscal year, nine months, a month and year, a dated day, or a year. A shape of the data, never a guess at intent. */
const PERIOD = new RegExp(
  `\\b(?:Q[1-4]|H[12]|FY\\s?\\d{2,4}|(?:first|second|third|fourth) quarter|(?:first|second) half|nine months|${MONTH}\\s+\\d{1,2},?\\s+\\d{4}|${MONTH}\\s+\\d{4}|(?:19|20)\\d{2})\\b|الربع\\s+(?:الأول|الاول|الثاني|الثالث|الرابع)`,
  "i",
);
export const namesPeriod = (question: string): boolean => PERIOD.test(question);

/** A value a sentence reports: an amount with its currency or scale, a percentage, or a full date. */
const VALUE = new RegExp(
  [
    `(?:SAR|SR|USD|US\\$|\\$|€|£|AED|EUR|GBP)\\s?\\d[\\d,]*(?:\\.\\d+)?(?:\\s?(?:billion|million|thousand|bn|mn|m)\\b)?`,
    `\\d[\\d,]*(?:\\.\\d+)?\\s?(?:%|percent\\b|billion\\b|million\\b|thousand\\b|riyals?\\b|dollars?\\b|dinars?\\b|euros?\\b)`,
    `${MONTH}\\s+\\d{1,2},\\s+\\d{4}`,
    `\\d{1,2}\\s+${MONTH}\\s+\\d{4}`,
  ].join("|"),
  "gi",
);
/** A bare count, accepted as the value only when the person asks to check an answer again. */
const COUNT = /\b\d[\d,]*(?:\.\d+)?\b/g;

const digitsOf = (s: string): string[] => s.match(/\d+(?:\.\d+)?/g) ?? [];

/**
 * The sentences that tie a question to a reported value: a sentence
 * qualifies when it holds EVERY subject word of the question (stemmed; the
 * entity and the period are subject words) and a value the question itself
 * does not already carry. Several qualifying sentences that share a value say
 * the same thing (the one with the fewest values is quoted); qualifying
 * sentences with no value in common are a conflict, quoted side by side. No
 * qualifying sentence is no answer: the caller falls back to the model.
 * `anyCount` also accepts a bare count (a recheck of "how many seats").
 */
export type FigureEvidence =
  | { kind: "one"; file: string; place: string; passage: string }
  | { kind: "conflict"; quotes: { file: string; place: string; passage: string }[] };

export function figurePassage(files: KnowledgeFileLike[], question: string, opts: { anyCount?: boolean } = {}): FigureEvidence | null {
  const subject = [...new Set(tokenize(question).filter((w) => !QUERY_STOP.has(w)).map(stemOf))];
  if (subject.length < 2) return null;
  const asked = new Set(digitsOf(question));
  const candidates: { file: string; place: string; passage: string; values: string[] }[] = [];
  for (const file of files) for (const section of sectionsOf(file)) {
    const words = new Set(tokenize(section.text).map(stemOf));
    if (!subject.every((w) => words.has(w))) continue;
    const text = section.text.replace(/\s+/g, " ").trim();
    for (const sentence of text.split(/(?<=[.!?؟])\s+(?=[A-Z؀-ۿ0-9"“(])/)) {
      if (sentence.length > 650) continue;
      const sw = new Set(tokenize(sentence).map(stemOf));
      if (!subject.every((w) => sw.has(w))) continue;
      const found = [...sentence.matchAll(VALUE)].map((m) => m[0]);
      if (opts.anyCount) found.push(...[...sentence.matchAll(COUNT)].map((m) => m[0]));
      // a value is new when it carries a number the question did not already name
      const values = [...new Set(found.filter((v) => digitsOf(v).some((d) => !asked.has(d))).flatMap(digitsOf).filter((d) => !asked.has(d)))];
      if (!values.length) continue;
      candidates.push({ file: file.name, place: placeOf(section), passage: sentence, values });
    }
  }
  const distinct = candidates.filter((c, i) => candidates.findIndex((d) => d.passage === c.passage) === i);
  if (!distinct.length) return null;
  const chosen = [...distinct].sort((a, b) => a.values.length - b.values.length)[0];
  const disagree = distinct.filter((c) => c !== chosen && !c.values.some((v) => chosen.values.includes(v)));
  if (disagree.length) return { kind: "conflict", quotes: [chosen, ...disagree].slice(0, 3).map(({ file, place, passage }) => ({ file, place, passage })) };
  return { kind: "one", file: chosen.file, place: chosen.place, passage: chosen.passage };
}

/** Above this IDF-weighted share of the question's subject words in the top hit — the hit in the question's own script — the keyword match is strong: the locator and the rewrite are skipped. Measured on the retrieval benchmark: every case at or above it had its supporting section first; every miss sat at 0.23 or below. */
export const STRONG_COVERAGE = 0.6;
/** On the strong path, a section rides when it scored at least this share of the top hit (a second page that holds the same figure, the neighbouring quarter) — at most `STRONG_MAX`. */
export const STRONG_RATIO = 0.5;
export const STRONG_MAX = 3;
/** On the strong path, the outline of the other sections is held to this many characters: it names what else exists, it is not the answer. */
export const STRONG_OUTLINE_CHARS = 1200;

/** One section as retrieval handles it: the store's hit fields and the sections cut in place, made one shape. `doc` is the section's position in the index's own list (the outline's skip-set names positions). */
export interface RetrSection {
  doc?: number;
  fileId: string;
  file: string;
  title: string;
  text: string;
  page?: number;
  slide?: number;
  sheet?: string;
  rowFrom?: number;
  rowTo?: number;
  /** The words were recognized from the page's picture (a scan, D6). */
  scanned?: boolean;
}

/** Where a section sits, as a citation names it: a page, a slide, or a sheet's rows — a scanned page says so. */
export function placeOf(s: Pick<RetrSection, "title" | "page" | "slide" | "sheet" | "rowFrom" | "rowTo" | "scanned">): string {
  if (s.page !== undefined) return s.scanned ? `p. ${s.page}, scanned text` : `p. ${s.page}`;
  if (s.slide !== undefined) return `slide ${s.slide}`;
  if (s.sheet !== undefined) return `${s.sheet} rows ${s.rowFrom ?? 1}-${s.rowTo ?? s.rowFrom ?? 1}`;
  return s.title;
}

/** Below this share of the question's own words in the top hit, the match rides one or two generic words — the query is weak. */
export const COVERAGE_MIN = 0.3;

/**
 * The share of the question's own words (three letters or more, normalised the
 * way the index normalises them) that the top hit's text holds. A real match
 * shares most of them; a cross-language question or a question of generic
 * words ("who has been the manager...") shares almost none, and the one
 * rewrite must get its chance — the weak gate reads this beside the score.
 */
export function queryCoverage(question: string, topText: string): number {
  const q = tokenize(question).filter((w) => w.length >= 3);
  if (!q.length) return 1;
  const inTop = new Set(tokenize(topText));
  return q.filter((w) => inTop.has(w)).length / q.length;
}

/** What the locator model sees: one line per section with its first words, never the whole text (the attached-PDF locator's shape, for knowledge sections). The outline stops at `maxChars` characters — the request must fit the window; a section past the cap can still be found by its words (the BM25 shortlist), never by this outline. Lines keep their position numbers, so a pick names the same section however long the outline ran. */
export function locatorMessagesFor(sections: RetrSection[], question: string, before: string, maxChars = 20000): { role: "system" | "user"; content: string }[] {
  const lines: string[] = [];
  let used = 0;
  for (const [i, s] of sections.slice(0, 200).entries()) {
    const line = `${i + 1}. ${s.file} — ${s.title} (${placeOf(s)}) — ${s.text.replace(/\s+/g, " ").trim().slice(0, 90)}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  const outline = lines.join("\n");
  return [
    { role: "system", content: "You locate information in a long document. You are given the sections of the person's files and a question. Reply with only the numbers of the sections that contain the answer, most relevant first, at most 4, separated by commas (example: 3, 7). Reply `all` if the question is about the whole material (summary, overview). Reply `none` if no section can contain the answer. No explanation." },
    { role: "user", content: `Sections:\n${outline}\n\n${before ? `Earlier question: ${before}\n` : ""}Question: ${question}\n\nSection numbers:` }
  ];
}

export { parseLocatorReply };

/**
 * Two searches over the same index, one rank order out: a
 * question's own hits and a rewrite's hits are merged by each section's BEST
 * rank — a section both queries found rides first, then the rest by how high
 * either query ranked it. The question's own hits keep their floor: a rewrite
 * that answered badly cannot throw good matches away (the recorded cross
 * cases lost matched 12 to a rewrite that matched 0).
 */
export function mergeByBestRank<T>(first: readonly T[], second: readonly T[], keyOf: (x: T) => string | number, limit: number): T[] {
  const rank = (list: readonly T[]) => new Map(list.map((x, i) => [keyOf(x), i] as const));
  const a = rank(first);
  const b = rank(second);
  const all = new Map<string | number, T>();
  for (const x of first) all.set(keyOf(x), x);
  for (const x of second) { const k = keyOf(x); if (!all.has(k)) all.set(k, x); }
  const FAR = Number.MAX_SAFE_INTEGER;
  return [...all.values()]
    .map((x) => { const k = keyOf(x); const ra = a.get(k) ?? FAR; const rb = b.get(k) ?? FAR; return { x, best: Math.min(ra, rb), both: a.has(k) && b.has(k) }; })
    .sort((p, q) => (p.both === q.both ? p.best - q.best : p.both ? -1 : 1))
    .slice(0, limit)
    .map((p) => p.x);
}

/** The marker a section cut to fit the budget carries (distinct from the packing's own cut marker, so the two can be told apart in a request). */
export const SECTION_CUT = "[…section cut to fit the knowledge budget]";

/**
 * The picked sections packed into the knowledge block's body, most relevant
 * first, numbered for citations: whole while they fit the budget, the one that
 * does not fit cut, the rest named in one line. Returns the body text (the
 * caller adds the block's lead line), how much of the budget it used, how
 * many sections were left out, and `loaded` — the sections that actually rode,
 * in source order with their places (the citation check reads this: a source
 * that never rode cannot be cited).
 */
export function packSections(sections: RetrSection[], picked: number[], budget: number): { body: string; used: number; leftOut: number; loaded: { file: string; place: string; text: string }[]; loadedIdx: number[] } {
  const parts: string[] = [];
  const loaded: { file: string; place: string; text: string }[] = [];
  /** The positions (into `sections`) of what actually rode: two sections may share a file and a place. */
  const loadedIdx: number[] = [];
  let left = budget;
  let leftOut = 0;
  for (const [n, i] of picked.entries()) {
    const s = sections[i];
    if (!s) continue;
    const head = `<section source="${n + 1}" file="${s.file.replace(/"/g, "'")}" place="${placeOf(s).replace(/"/g, "'")}">`;
    const foot = "</section>";
    if (s.text.length + head.length + foot.length + 2 <= left) {
      parts.push(`${head}\n${inFrame(s.text)}\n${foot}`);
      left -= s.text.length + head.length + foot.length + 2;
      loaded.push({ file: s.file, place: placeOf(s), text: s.text });
      loadedIdx.push(i);
    } else if (left > 400) {
      const cut = s.text.slice(0, Math.max(0, left - head.length - foot.length - SECTION_CUT.length - 3));
      parts.push(`${head}\n${inFrame(cut)}\n${SECTION_CUT}\n${foot}`);
      left = 0;
      loaded.push({ file: s.file, place: placeOf(s), text: cut });
      loadedIdx.push(i);
    } else leftOut++;
  }
  return { body: parts.join("\n"), used: budget - left, leftOut, loaded, loadedIdx };
}

/**
 * The rest of the material as outline lines (`file — title (place)`), so the
 * model knows what else exists and can name it: as many lines as the block's
 * leftover budget holds, at most 120; the count that did not fit comes back.
 * `skip` holds the positions (the store's doc numbers) of the loaded sections.
 */
export function outlineLines(sections: RetrSection[], skip: Set<number>, maxChars: number, cap = 120): { lines: string[]; overflow: number } {
  const lines: string[] = [];
  let used = 0;
  let overflow = 0;
  for (const [i, s] of sections.entries()) {
    if (skip.has(i)) continue;
    const line = `- ${s.file} — ${s.title} (${placeOf(s)})`;
    if (lines.length >= cap || used + line.length + 1 > maxChars) { overflow++; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  return { lines, overflow };
}
