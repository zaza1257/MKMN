/**
 * Citations for the knowledge sections. The retrieved sections
 * ride the request as `<section source="N">` blocks (src/core/knowledge/
 * retrieve.ts) and the model cites them as [source N]. What stands here:
 *
 *  - `CITATIONS_INSTRUCTIONS`, registered in INSTRUCTION_BLOCKS
 *    (src/core/prompts.ts) and given to a request only when sections were
 *    actually loaded onto it (Relevance.citations, an explicit opt-in).
 *  - `citeAnswer`, which checks the markers against the sections actually
 *    provided: a number the request never carried is invented, and it is
 *    dropped from the answer; the Sources line names what stands, so the
 *    person sees the file and its place without reading the raw markers.
 *  - `citationGuardStep`, the caller's afterStep hook on the turn's run
 *    (src/core/harness/run.ts runs the identity guard first, then this): the
 *    journaled answer holds only citations that stand. The retrieval fills the
 *    hook's section list after the run was created, so the list is read
 *    through a mutable array, never copied.
 *  - `spokenOf`, what the voice says: markers and the Sources line are never
 *    read aloud.
 *
 * A safety net on the output, like the identity guard — never a way of
 * deciding what an answer means.
 */

/** A loaded section as a citation names it: the file's name and its place ("p. 150", "slide 3", "Budget rows 41-80"). */
export interface CitedSection {
  file: string;
  place: string;
  /** The text that actually rode with the request (cut where the request cut it), when known. */
  text?: string;
}

/** Arabic-Indic and Eastern Arabic-Indic digits as ASCII. */
function asciiDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** The figures of a text in one written form: thousands separators gone, trailing decimal zeros gone. */
function figuresOf(s: string): string[] {
  return (asciiDigits(s).match(/\d[\d,٬]*(?:[.٫]\d+)?/g) ?? []).map((f) => {
    const plain = f.replace(/[,٬]/g, "").replace(/٫/, ".");
    return plain.includes(".") ? plain.replace(/0+$/, "").replace(/\.$/, "") : plain;
  });
}

/** A figure worth checking: two digits or more, or a decimal (a lone "3 reasons" is not a sourced fact). */
const MATERIAL = (f: string) => f.replace(".", "").length >= 2 || f.includes(".");

/**
 * The figures a cited sentence states that none of its cited sections holds as
 * written. This is a support check of the NUMBERS only: a marker that stands
 * still says that a source rode, not that it says what the sentence says, and a
 * figure the model rewrote ("1.2 million" for "1,200,000") is reported too —
 * reported, never removed, so the person checks it against the source.
 * Sections without their text (an extractive quote) are not judged.
 */
export function unsupportedFigures(answer: string, loaded: CitedSection[]): { figure: string; sources: number[] }[] {
  const out: { figure: string; sources: number[] }[] = [];
  const seen = new Set<string>();
  const known = new Map<number, Set<string>>();
  const figuresIn = (n: number) => {
    if (!known.has(n)) known.set(n, new Set(figuresOf(loaded[n - 1]?.text ?? "")));
    return known.get(n)!;
  };
  const sentences = answer.split("\n").filter((l) => !OWN_SOURCES_LINE.test(l.trim())).join("\n").split(/(?<=[.!?؟])\s+|\n+/);
  for (const sentence of sentences) {
    const sources = [...sentence.matchAll(SOURCE_MARK_ALL)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= loaded.length);
    if (!sources.length || sources.some((n) => loaded[n - 1]?.text === undefined)) continue;
    const claim = sentence.replace(SOURCE_MARK_ALL, " ");
    for (const f of figuresOf(claim).filter(MATERIAL)) {
      if (sources.some((n) => figuresIn(n).has(f))) continue;
      const key = `${f}|${sources.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ figure: f, sources });
    }
  }
  return out;
}

/** The notice the chat shows for unsupported figures, or null. */
export function unsupportedNotice(found: { figure: string; sources: number[] }[]): string | null {
  if (!found.length) return null;
  const list = found.slice(0, 6).map((u) => `${u.figure} [source ${u.sources.join(", ")}]`).join(", ");
  return `${found.length === 1 ? "A figure" : `${found.length} figures`} in this answer ${found.length === 1 ? "is" : "are"} not written that way in the passage it cites: ${list}${found.length > 6 ? " and more" : ""}. Check ${found.length === 1 ? "it" : "them"} against the source.`;
}

/** The citation marker and its number, as the instructions ask the model to write it. */
export const SOURCE_MARK = /\[source (\d+)\]/;

const SOURCE_MARK_ALL = /\[source (\d+)\]/g;
/** The Sources line the app itself appends (never the model): `[N] file (place)`, comma separated. */
const OWN_SOURCES_LINE = /^Sources: \[\d+\] .+$/;

export const CITATIONS_INSTRUCTIONS = `Cite the project knowledge: when a statement comes from a <section source="N"> block, write [source N] right after it (example: The budget is 310000 dinars [source 12].). Cite only numbers that appear in the provided sections - never invent a source. Do not write a list of sources yourself; the app adds it.`;

/**
 * Checks an answer's markers against the sections actually provided: valid
 * markers stand (the screen renders them as chips), invented ones are dropped
 * (the prose around them tidied), and the cited sections are named in a
 * Sources line the app adds. Running it twice changes nothing.
 */
export function citeAnswer(answer: string, loaded: CitedSection[]): { text: string; cited: number[]; invented: number[] } {
  const cited: number[] = [];
  const invented: number[] = [];
  const seenCited = new Set<number>();
  const seenInvented = new Set<number>();
  let text = answer.replace(SOURCE_MARK_ALL, (mark, nStr: string) => {
    const n = Number(nStr);
    if (n >= 1 && n <= loaded.length) {
      if (!seenCited.has(n)) { seenCited.add(n); cited.push(n); }
      return mark; // a real source: the marker stands, the screen renders it as a chip
    }
    if (!seenInvented.has(n)) { seenInvented.add(n); invented.push(n); }
    return ""; // invented: dropped
  });
  if (invented.length) {
    // the prose around a dropped marker is not left tattered ("cost 5 [source 9]." -> "cost 5.")
    text = text.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([.,;:!?،؟])/g, "$1");
  }
  if (cited.length) {
    const line = `Sources: ${cited.map((n) => `[${n}] ${loaded[n - 1].file} (${loaded[n - 1].place})`).join(", ")}`;
    // the Sources line is the app's own: a previous run of this check (the hook
    // corrected the step, the turn corrects the screen) is replaced, not doubled
    const lines = text.split("\n");
    while (lines.length && OWN_SOURCES_LINE.test(lines[lines.length - 1].trim())) lines.pop();
    text = `${lines.join("\n").trimEnd()}\n\n${line}`;
  }
  return { text, cited, invented };
}

/**
 * The caller's afterStep hook (src/core/harness/run.ts): an ok step's reply —
 * and its answer when it is a string — carries only citations that stand.
 * Steps whose reply holds no markers (the locator's "1, 2", the retrieval's
 * section blocks, a failed step's error) pass untouched.
 * `loaded` is the mutable array the retrieval fills after this run was
 * created; the hook reads it at step time, never at creation time.
 */
export function citationGuardStep<S extends { status: string; reply?: string; output?: unknown }>(loaded: CitedSection[]) {
  return (step: S): S => {
    if (step.status !== "ok") return step;
    if (typeof step.reply !== "string" || !SOURCE_MARK.test(step.reply)) return step;
    const fixedReply = citeAnswer(step.reply, loaded).text;
    const fixedOutput = typeof step.output === "string" ? citeAnswer(step.output, loaded).text : undefined;
    if (fixedReply === step.reply && fixedOutput === step.output) return step;
    return { ...step, ...(fixedReply !== undefined ? { reply: fixedReply } : {}), ...(fixedOutput !== undefined ? { output: fixedOutput } : {}) } as S;
  };
}

/**
 * What the voice says of an answer: the markers and the Sources line are never
 * read aloud. Empty after the strip — a marker alone, the Sources line alone —
 * means nothing is said.
 */
export function spokenOf(text: string): string {
  const withoutSources = text.split("\n").filter((l) => !OWN_SOURCES_LINE.test(l.trim())).join("\n");
  return withoutSources
    .replace(/[ \t]*\[source \d+\]/g, "")
    .replace(/[ \t]+([.,;:!?،؟])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
