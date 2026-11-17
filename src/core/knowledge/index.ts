/**
 * Project knowledge as sections: a knowledge file is not one block of
 * text — a PDF has pages, a markdown file has headings, a note has paragraphs.
 * Retrieval scores and reads back SECTIONS, so an answer can cite where a fact
 * came from and a long file can be searched instead of packed.
 *
 * This module is pure (no file system, no imports from the rest of the core):
 * the renderer may use it to show a file's sections, and the store (store.ts,
 * node only) builds its index from what it returns.
 */
import { PAGE_MARK } from "../pdf";
import { SCANNED_LINE } from "../ocr";
import { hashText } from "../memo";

/** The kinds of knowledge the app knows: where a file's text came from decides how it is cut into sections. */
export type KnowledgeKind = "pdf" | "markdown" | "word" | "sheet" | "slides" | "text";

export interface KnowledgeFileLike {
  id: string;
  name: string;
  content: string;
}

export interface KnowledgeSection {
  /** Where the section sits in the file, as the person would name it: a page, a heading, or a paragraph range. */
  title: string;
  text: string;
  /** The file the section came from (the name as the person sees it). */
  file?: string;
  /** A PDF page (1-based), when the section is one page. */
  page?: number;
  /** A slide number (1-based), when the section is one slide. */
  slide?: number;
  /** A sheet name, when the section is a sheet's rows. */
  sheet?: string;
  /** The sheet's row range the section holds (1-based; row 1 is the table's first line, the header). */
  rowFrom?: number;
  rowTo?: number;
  /** A PDF page whose words were recognized from the picture (a scan): the citation says "p. N, scanned text". */
  scanned?: boolean;
}

/** The office kinds by their file's name: the name decides, because documentText writes several kinds in near shapes (a `---` is a slide break in a deck and a page break in a Word file). */
const NAME_KIND: [RegExp, KnowledgeKind][] = [
  [/\.(docx|docm|odt|rtf)$/i, "word"],
  [/\.(xlsx|xlsm|ods|csv|tsv)$/i, "sheet"],
  [/\.(pptx|pptm|odp)$/i, "slides"],
];

/** The kind of a knowledge file, from its name and its text (a PDF's extracted text carries `[page N]` marks). */
export function kindOf(file: KnowledgeFileLike): KnowledgeKind {
  const name = file.name.trim();
  for (const [re, kind] of NAME_KIND) if (re.test(name)) return kind;
  if (/\[page \d+\]/.test(file.content.slice(0, 2000))) return "pdf";
  if (/\.md$|\.markdown$/i.test(name)) return "markdown";
  return "text";
}

/** Paragraph blocks of a plain text file: blank-line separated, grouped so a section is worth reading alone. */
function textSections(content: string): KnowledgeSection[] {
  const paras = content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: KnowledgeSection[] = [];
  let cur: string[] = [];
  let size = 0;
  for (const p of paras) {
    cur.push(p);
    size += p.length;
    if (size >= 1200) {
      out.push({ title: `paragraphs ${out.length + 1}`, text: cur.join("\n\n") });
      cur = [];
      size = 0;
    }
  }
  if (cur.length) out.push({ title: `paragraphs ${out.length + 1}`, text: cur.join("\n\n") });
  return out;
}

/** Sections of a markdown file: one per heading; a file without headings falls back to paragraph blocks. */
function markdownSections(content: string): KnowledgeSection[] {
  const lines = content.split("\n");
  const heads: number[] = [];
  for (const [i, l] of lines.entries()) if (/^#{1,6}\s+\S/.test(l)) heads.push(i);
  if (heads.length === 0) return textSections(content);
  const out: KnowledgeSection[] = [];
  for (const [n, start] of heads.entries()) {
    const end = n + 1 < heads.length ? heads[n + 1] : lines.length;
    const text = lines.slice(start + 1, end).join("\n").trim();
    const title = lines[start].replace(/^#+\s*/, "").trim() || `heading ${n + 1}`;
    if (text) out.push({ title, text });
  }
  return out.length ? out : textSections(content);
}

/** Sections of a PDF's extracted text: one per `[page N]` mark; text before the first mark rides with page 1. */
function pdfSections(content: string): KnowledgeSection[] {
  const lines = content.split("\n");
  const marks: number[] = [];
  for (const [i, l] of lines.entries()) if (PAGE_MARK.test(l.trim())) marks.push(i);
  if (marks.length === 0) return textSections(content);
  const out: KnowledgeSection[] = [];
  const head = lines.slice(0, marks[0]).join("\n").trim();
  for (const [n, start] of marks.entries()) {
    const end = n + 1 < marks.length ? marks[n + 1] : lines.length;
    const rest = lines.slice(start + 1, end);
    // a scan's recognized words ride under the mark; the flag carries what the words are, the mark itself is not search text
    const scanned = rest.map((l) => l.trim()).find(Boolean) === SCANNED_LINE;
    const body = (scanned ? rest.slice(rest.map((l) => l.trim()).indexOf(SCANNED_LINE) + 1) : rest).join("\n").trim();
    const text = [head && n === 0 ? head : "", body].filter(Boolean).join("\n\n");
    if (text) out.push({ title: lines[start].trim(), text, page: n + 1, ...(scanned ? { scanned: true } : {}) });
  }
  return out.length ? out : textSections(content);
}

// ---------------------------------------------------------------- Word, OpenDocument and RTF

/** A block cut lands after about this many characters, always at a paragraph end. */
const WORD_BLOCK_CHARS = 2000;
/** A block's last paragraph opens the next one, so a fact that straddles a cut is in both — but only when it is small enough to be worth repeating. */
const WORD_OVERLAP_CHARS = 300;
/** One paragraph far bigger than this is split at word ends instead of waiting for a paragraph end that never comes. */
const WORD_PARA_HARD_SPLIT = 4000;

function wordSections(content: string): KnowledgeSection[] {
  const lines = content.split("\n");
  const heads: number[] = [];
  for (const [i, l] of lines.entries()) if (/^#{1,6}\s+\S/.test(l)) heads.push(i);
  if (heads.length > 0) {
    const out: KnowledgeSection[] = [];
    for (const [n, start] of heads.entries()) {
      const end = n + 1 < heads.length ? heads[n + 1] : lines.length;
      const text = lines.slice(start, end).join("\n").trim();
      const title = lines[start].replace(/^#+\s*/, "").trim() || `heading ${n + 1}`;
      // the heading line stays in the text: its words are search words too
      if (text) out.push({ title, text });
    }
    if (out.length) return out;
  }
  // no headings (a letter, an RTF): blocks of about 2000 characters, cut at paragraph ends
  const paras = content.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const out: KnowledgeSection[] = [];
  let cur: string[] = [];
  let size = 0;
  let carried = false; // cur holds only the overlap carried over from the last flush, no paragraph of its own yet
  const flush = () => {
    if (!cur.length) return;
    out.push({ title: `paragraphs ${out.length + 1}`, text: cur.join("\n\n") });
    const last = cur[cur.length - 1];
    cur = last.length <= WORD_OVERLAP_CHARS ? [last] : [];
    size = cur.reduce((n, p) => n + p.length, 0);
    carried = cur.length > 0;
  };
  for (const p of paras) {
    if (p.length > WORD_PARA_HARD_SPLIT) {
      // one paragraph far bigger than a block (a run-on RTF line) cannot wait for a paragraph end: split it at word ends
      flush();
      for (let at = 0; at < p.length; ) {
        let end = Math.min(p.length, at + WORD_BLOCK_CHARS);
        if (end < p.length) { const sp = p.lastIndexOf(" ", end); if (sp > at) end = sp; }
        const piece = p.slice(at, end).trim();
        if (piece) out.push({ title: `paragraphs ${out.length + 1}`, text: piece });
        at = end;
      }
      cur = [];
      size = 0;
      carried = false;
      continue;
    }
    carried = false;
    cur.push(p);
    size += p.length;
    if (size >= WORD_BLOCK_CHARS) flush();
  }
  if (!carried && cur.length) out.push({ title: `paragraphs ${out.length + 1}`, text: cur.join("\n\n") });
  return out;
}

// ---------------------------------------------------------------- Excel, OpenDocument sheets and CSV

/** How many table rows one section of a sheet holds. */
const SHEET_ROWS_PER_BLOCK = 40;

const ruleOf = (header: string): string => {
  // `| a | b |` has two cells; a `\|` inside a cell is not a separator
  const cells = header.split(/(?<!\\)\|/).length - 2;
  return `|${Array.from({ length: Math.max(1, cells) }, () => "---").join("|")}|`;
};

function rowBlockSections(sheetName: string, rows: string[], rule: string | null, fileName: string): KnowledgeSection[] {
  const out: KnowledgeSection[] = [];
  const header = rows[0];
  const pipe = header.startsWith("|");
  const sep = rule ?? ruleOf(header);
  for (let from = 0; from < rows.length; from += SHEET_ROWS_PER_BLOCK) {
    const block = rows.slice(from, from + SHEET_ROWS_PER_BLOCK);
    const rowFrom = from + 1;
    const rowTo = from + block.length;
    // every block reads alone: the header row (and its rule) is repeated at its top
    const body = (from === 0 ? block : pipe ? [header, sep, ...block] : [header, ...block]).join("\n");
    out.push({ title: `${sheetName} rows ${rowFrom}-${rowTo}`, text: body, file: fileName, sheet: sheetName, rowFrom, rowTo });
  }
  return out;
}

function sheetSections(file: KnowledgeFileLike): KnowledgeSection[] {
  const lines = file.content.split("\n");
  // the workbook's text form: `## Sheet` starts a sheet, its rows are the `|` lines under it (the `|---|` rule is not a row)
  const sheets: { name: string; rows: string[]; rule: string | null }[] = [];
  for (const l of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(l);
    if (h) sheets.push({ name: h[1], rows: [], rule: null });
    else if (/^\s*\|/.test(l)) {
      if (/^\s*\|[\s:|-]+\|?\s*$/.test(l)) { if (sheets.length && !sheets[sheets.length - 1].rule) sheets[sheets.length - 1].rule = l.trim(); continue; }
      if (sheets.length) sheets[sheets.length - 1].rows.push(l.trim());
    }
  }
  const named = sheets.filter((s) => s.rows.length);
  if (named.length) return named.flatMap((s) => rowBlockSections(s.name, s.rows, s.rule, file.name));
  // a csv or tsv arrives as plain text, one row per line: the file itself is the one sheet
  const rows = lines.map((l) => l.trim()).filter(Boolean);
  const name = file.name.replace(/\.[^.]+$/, "") || "Sheet1";
  return rows.length ? rowBlockSections(name, rows, null, file.name) : [];
}

// ---------------------------------------------------------------- PowerPoint and OpenDocument slides

function slidesSections(content: string): KnowledgeSection[] {
  const lines = content.split("\n");
  const slides: string[][] = [[]];
  for (const l of lines) {
    if (/^\s*---\s*$/.test(l)) slides.push([]);
    else slides[slides.length - 1].push(l);
  }
  const out: KnowledgeSection[] = [];
  for (const [i, slide] of slides.entries()) {
    const text = slide.join("\n").trim();
    // a slide the app could not read any text from carries no words worth an index entry
    if (!text || text === "(empty slide)") continue;
    const titleLine = slide.find((l) => /^#\s+\S/.test(l));
    const title = titleLine ? titleLine.replace(/^#\s*/, "").trim() : `slide ${i + 1}`;
    out.push({ title, text, slide: i + 1 });
  }
  return out;
}

/** The sections of one knowledge file, cut the way its kind is read; each carries where it came from. */
export function sectionsOf(file: KnowledgeFileLike): KnowledgeSection[] {
  const c = file.content;
  if (!c.trim()) return [];
  const kind = kindOf(file);
  const cut =
    kind === "pdf" ? pdfSections(c) :
    kind === "markdown" ? markdownSections(c) :
    kind === "word" ? wordSections(c) :
    kind === "sheet" ? sheetSections(file) :
    kind === "slides" ? slidesSections(c) :
    textSections(c);
  return cut.map((s) => ({ ...s, file: s.file ?? file.name }));
}

/** The fingerprint a project's index is keyed by (the same hash the store file carries), pure so the Project knowledge screen can compare its files to what was built without importing the store (node-only). */
export function filesHashOf(files: KnowledgeFileLike[]): string {
  return hashText(files.map((f) => `${f.id}\u0000${f.name}\u0000${f.content}`).join("\u0001"));
}

/** What the Project knowledge screen shows per file: its sections, how many pages they cover, and how many of those pages were read from scans (D6). */
export function fileKnowledgeStats(file: KnowledgeFileLike): { sections: number; pages: number; scannedPages: number } {
  const secs = sectionsOf(file);
  const pages = new Set(secs.map((s) => s.page).filter((p) => p !== undefined));
  return { sections: secs.length, pages: pages.size, scannedPages: secs.filter((s) => s.scanned).length };
}

// ---------------------------------------------------------------- the files that say the same thing (C4)

/** Two sections overlap when at least four fifths of the SHORTER one's distinct words are also the longer one's: the same passage riding twice. */
const overlapJaccard = 0.8;
/** A section too short to mean anything (a heading, a number) is never an overlap. */
const OVERLAP_MIN_WORDS = 8;

const jaccardOf = (x: string[], y: string[]): number => {
  const set = new Set(x);
  let inter = 0;
  for (const w of new Set(y)) if (set.has(w)) inter++;
  return inter / (x.length + y.length - inter);
};

/**
 * Pairs of files whose SECTIONS say the same thing — decided by the code
 * from the sections' own words, never from the file names. The panel says of each pair
 * that the files overlap and an answer may quote either. One pair of matching sections
 * is enough; a name shared or different proves nothing either way.
 */
export function overlappingFilePairs(files: KnowledgeFileLike[]): Array<[string, string]> {
  const tokenSets = new Map<string, string[][]>(
    files.map((f) => [f.id, sectionsOf(f).map((s) => [...new Set(tokenize(s.text))]).filter((t) => t.length >= OVERLAP_MIN_WORDS)] as const),
  );
  const out: Array<[string, string]> = [];
  for (let a = 0; a < files.length; a++) {
    for (let b = a + 1; b < files.length; b++) {
      const A = tokenSets.get(files[a].id)!;
      const B = tokenSets.get(files[b].id)!;
      if (A.some((sa) => B.some((sb) => jaccardOf(sa, sb) >= overlapJaccard))) out.push([files[a].name, files[b].name]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the words: English and Arabic normalisation

/**
 * One normalised search token: lowercase; Arabic letters folded to one shape
 * each (the hamza forms to the bare alef, the taa marbuta to the haa, the alef
 * maqsura to the yaa), the tashkeel (diacritics) and the tatweel dropped — so a
 * question written أحمد finds احمد, and مباشرةً finds مباشرة. Punctuation and
 * digits are word separators in both languages.
 */
export function tokenize(text: string): string[] {
  const folded = text
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "") // tashkeel and tatweel
    .replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627") // أ إ آ ٱ -> ا
    .replace(/\u0629/g, "\u0647") // ة -> ه
    .replace(/\u0649/g, "\u064A") // ى -> ي
    .replace(/\u0624/g, "\u0648") // ؤ -> و
    .replace(/\u0626/g, "\u064A"); // ئ -> ي
  return folded.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
}

/**
 * The script a text's letters are written in — "ar" when Arabic letters
 * outnumber Latin ones, "en" otherwise, "" when it holds neither (nothing to
 * detect). A character count, never a language guess and never a model: the
 * orchestrator reads it on the question and on the files to see that a
 * question and the files it asks about do not share an alphabet, and then
 * always gives the rewrite its chance.
 */
export function scriptOf(text: string): "ar" | "en" | "" {
  let ar = 0;
  let latin = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x0600 && c <= 0x06ff) ar++;
    else if ((c >= 0x0041 && c <= 0x005a) || (c >= 0x0061 && c <= 0x007a)) latin++;
  }
  if (!ar && !latin) return "";
  return ar > latin ? "ar" : "en";
}
