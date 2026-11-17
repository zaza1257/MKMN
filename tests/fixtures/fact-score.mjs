/**
 * How a case's fact is recognised in a model's own words. Extracted from the
 * real-run driver so the vitest suite pins the SAME scorer the records are
 * scored by (the scoring bug: a table fact — a raw pipe row from a
 * sheet — was scored as prose, and a correct answer to the asked cell was
 * scored not-held).
 */

// ---- how a case's fact is recognised in a model's own words: every number of the fact ----
// must come back, plus most of its distinctive words (paraphrase keeps the values)
export const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "has", "have", "its", "their", "every", "per", "day", "each", "one", "two"]);
const normOf = (s) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, " ");
const wordsOf = (s) => [...new Set(normOf(s).split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d/.test(w)))];
export const factKeys = (fact) => {
  // a table fact (a raw row lifted from a sheet, its cells joined with " | "): it is
  // scored on the ASKED CELL — the row's value (the first numeric cell after the
  // leading label cells) plus the label's distinctive words — never on every number
  // in the row (a row carries a year, a condition column, neighbours' figures)
  if (fact.includes("|")) {
    const cells = fact.split("|").map((s) => s.trim()).filter((s) => s.length);
    const label = [];
    let value = null;
    for (const c of cells) {
      if (value === null && !/\d/.test(c)) { label.push(c); continue; }
      value = c;
      break;
    }
    if (value !== null) return { table: true, value, words: wordsOf(label.join(" ")) };
    // no numeric cell at all: the row is all labels — score it as prose below
  }
  const numbers = fact.match(/\d[\d.,:]*/g) ?? [];
  const words = wordsOf(fact);
  return { numbers, words };
};
export const factHeld = (text, keys) => {
  const norm = normOf(text);
  if (keys.table) {
    // the value must stand as its own number: a digit boundary, so the row's "2" is
    // never read inside "12" or "23" (the 4b's recorded wrong answer "12 projector
    // units" stays not-held, the right "2 projector units" is held). The pattern is
    // built from the value the way the answer was normalized (punctuation became a
    // space), so a decimal "0.25" is looked for as "0 25" — and "0.251" ("0 251")
    // does not match, the boundary after the value is still a non-digit.
    const vn = normOf(keys.value).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const valueOk = !/\d/.test(keys.value) || !vn || new RegExp(`(^|[^\\p{N}])${vn}(?!\\p{N})`, "u").test(norm);
    const found = keys.words.filter((w) => norm.includes(w)).length;
    const share = keys.words.length ? found / keys.words.length : 1;
    return { numbersOk: valueOk, wordShare: Math.round(share * 100) / 100, held: valueOk && (keys.words.length === 0 || share >= 0.6) };
  }
  const numbersOk = keys.numbers.every((n) => {
    const bare = n.replace(/[.,]$/, "");
    return norm.includes(bare.toLowerCase()) || norm.includes(n.replace(/[.,]/g, "").toLowerCase());
  });
  const held = keys.words.filter((w) => norm.includes(w)).length;
  return { numbersOk, wordShare: keys.words.length ? held / keys.words.length : 1, held: numbersOk && (keys.words.length === 0 || held / keys.words.length >= 0.6) };
};
