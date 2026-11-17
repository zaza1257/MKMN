/**
 * The document-retrieval benchmark: a repeatable run of the REAL chat turn
 * (runChatOrchestrator) over fixed corpora, with a scripted model server, so
 * every retrieval decision the app makes — the index, BM25, the rewrite, the
 * locator, the packing, the source-quoting answers — is exercised as it ships.
 *
 * What is measured per case: whether the supporting section rode in the first
 * five sections of the answer request (recall@5), whether the facts the case
 * names are in what the person sees (a quoted answer) or in the supporting
 * section that rode (a model answer: the evidence reached the model), the
 * model calls the turn made (locator, rewrite, answer), the answer request's
 * size, the host time of the turn and a modeled end-to-end time.
 *
 * The scripted model is generous to every path: the locator names the
 * supporting section when it is in its outline, the rewrite writes the
 * case's own search words. The modeled time uses published rates for a 4B
 * model on this NPU (prefill 786.7 tokens/s, decode 35 tokens/s, 0.14 s per
 * call; docs/research/dynamic-model-research-2.md and the model
 * tournament): it is an estimate, never a device measurement.
 *
 * Not a test file: `tests/knowledge-bench.test.ts` runs it, and
 * `MKMN_BENCH_OUT=<file>` writes the report as JSON.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { CatalogEntry, ChatEvent, ChatMessage, ChatOptions, HardwareProfile, Settings } from "../src/shared/types";
import { runChatOrchestrator, type ChatHost, type Served } from "../src/core/chatOrchestrator";
import { buildSystemPrompt, knowledgeBudget } from "../src/core/projects";
import { promptTokens } from "../src/core/context";
import { extractPdfText } from "../src/core/pdf";
import { readOffice } from "../src/core/office";
import * as store from "../src/core/knowledge/store";
import { openKnowledgeIndex } from "../src/core/knowledge/store";
import type { KnowledgeFileLike } from "../src/core/knowledge/index";
import { openOnnxEmbedder, type Embedder } from "../src/core/knowledge/embed";

/** The real multilingual model for the benchmark, when `MKMN_BENCH_VECTORS` names an installed model folder; null otherwise (the BM25 and rewrite path). */
export async function benchEmbedder(): Promise<Embedder | null> {
  const dir = process.env.MKMN_BENCH_VECTORS;
  return dir ? openOnnxEmbedder(dir, "bench-multilingual-minilm-q8") : null;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "knowledge");

export const BENCH_NCTX = 8192;
const PREFILL_TPS = 786.7;
const DECODE_TPS = 35;
const CALL_OVERHEAD_S = 0.14;
const OUT_TOKENS = { locator: 6, rewrite: 12, answer: 120, other: 60 } as const;

export const BENCH_ENTRY: CatalogEntry = {
  id: "bench-4b", name: "Bench 4B", repo: "org/bench-4b", quant: "Q4_0", engine: "qairt", role: "chat",
  architecture: "qwen3", sizeGB: 2.5, recommendedContext: BENCH_NCTX, sampling: { temperature: 0.7, top_p: 0.9, max_tokens: 512 },
};
const HW: HardwareProfile = { chipName: "Bench", chipFamily: "x2", isSnapdragon: true, ramGB: 32, npuDetected: true, npuDriverVersion: "1.0.0", npuBudgetGB: 8 };

// ---------------------------------------------------------------- the corpora

/** A long interim report whose quarters carry close figures: the test of a period that matters. */
const NORTHWIND_PAGES: Record<number, string> = {
  5: "Highlights for the third quarter of 2026. Northwind Energy reported revenue of SAR 41.2 billion for Q3 2026, compared with SAR 39.8 billion in Q2 2026. Net income for Q3 2026 was SAR 7.4 billion, compared with SAR 6.9 billion in Q2 2026.",
  6: "Highlights for the second quarter of 2026. Northwind Energy reported revenue of SAR 39.8 billion for Q2 2026, compared with SAR 38.1 billion in Q1 2026. Net income for Q2 2026 was SAR 6.9 billion.",
  7: "Highlights for the first quarter of 2026. Northwind Energy reported revenue of SAR 38.1 billion for Q1 2026. Net income for Q1 2026 was SAR 6.5 billion.",
  12: "Capital expenditure. Capital expenditure in Q3 2026 amounted to SAR 9.6 billion, of which SAR 3.1 billion related to the eastern gas expansion.",
  13: "Capital expenditure. Capital expenditure in Q2 2026 amounted to SAR 8.7 billion, mainly for upstream drilling.",
  20: "Dividends. On August 4, 2026, the Board declared a base dividend of SAR 0.33 per share for Q2 2026, payable on September 15, 2026.",
  21: "Dividends. On November 3, 2026, the Board declared a base dividend of SAR 0.34 per share for Q3 2026, payable on December 14, 2026.",
  30: "Borrowings. As at September 30, 2026, total borrowings were SAR 112.5 billion (June 30, 2026: SAR 109.0 billion).",
  33: "Employees. Northwind Energy had 18,240 employees at September 30, 2026, across its upstream and downstream segments.",
  40: "Cash flow. Free cash flow for the nine months ended September 30, 2026 was SAR 52.3 billion.",
};
const FILLER_TOPICS = ["segment disclosures", "accounting policies", "financial risk management", "related party balances", "provisions", "lease liabilities", "fair value hierarchy", "income taxes", "inventories", "trade receivables"];
export function northwindReport(): string {
  return Array.from({ length: 60 }, (_, i) => {
    const n = i + 1;
    const body = NORTHWIND_PAGES[n] ?? `Notes to the interim condensed consolidated financial statements. This page covers ${FILLER_TOPICS[i % FILLER_TOPICS.length]} for the reporting period, prepared under the same basis as the annual statements of the Group. Amounts are in millions of Saudi riyals unless otherwise stated, and comparative figures relate to the corresponding quarter.`;
    return `[page ${n}]\n${body}`;
  }).join("\n");
}

/** The Aramco Q3 2026 interim report's note 18, on page 43 of a long report, its extracted line breaks kept. */
export function aramcoReport(): string {
  const note = fs.readFileSync(path.join(FIXTURES, "aramco-q3-2026-note-18.txt"), "utf8").trim();
  return Array.from({ length: 60 }, (_, i) => {
    const n = i + 1;
    if (n === 43) return `[page 43]\n${note}`;
    if (n === 12) return "[page 12]\nInvestments in joint ventures and associates. The Company holds interests in several joint ventures and associates, accounted for under the equity method. Aramco's share of results of joint ventures and associates for the nine months was SAR 1.2 billion.";
    return `[page ${n}]\nSaudi Aramco interim condensed consolidated financial statements. This page covers ${FILLER_TOPICS[i % FILLER_TOPICS.length]} for the nine-month period ended September 30, 2026. Amounts are in millions of Saudi riyals unless otherwise stated.`;
  }).join("\n");
}

const bytesOf = (name: string): Uint8Array => {
  const buf = fs.readFileSync(path.join(FIXTURES, name));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};

/** The frozen fixture corpus the eval harness uses (handbook, Arabic guide, scan, Word, Excel, PowerPoint). */
export async function fixtureCorpus(): Promise<KnowledgeFileLike[]> {
  const evals = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "evals", "knowledge.json"), "utf8"));
  const ocrPages: string[] = evals.ocr?.[0]?.pages ?? [];
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const files: KnowledgeFileLike[] = [];
  for (const [name, withOcr] of [["handbook-en.pdf", false], ["dalil-ar.pdf", false], ["scanned-notices.pdf", true]] as const) {
    const doc = await pdfjs.getDocument({ data: bytesOf(name), useWorkerFetch: false, isEvalSupported: false }).promise;
    const text = await extractPdfText(doc as never, 2_000_000, withOcr ? { ocr: async (n: number) => ocrPages[n - 1] ?? "" } : undefined);
    files.push({ id: name, name, content: text });
  }
  for (const [name, kind] of [["staff-handbook.docx", "docx"], ["equipment.xlsx", "xlsx"], ["renovation-plan.pptx", "pptx"]] as const) {
    files.push({ id: name, name, content: await readOffice(kind, bytesOf(name)) });
  }
  return files;
}

export const reportCorpus = (): KnowledgeFileLike[] => [
  { id: "northwind", name: "northwind-interim-q3-2026.pdf", content: northwindReport() },
  { id: "aramco", name: "aramco-interim-q3-2026.pdf", content: aramcoReport() },
];

// ---------------------------------------------------------------- the cases

export interface BenchCase {
  id: string;
  group: "exact" | "paraphrase" | "arabic" | "quarters" | "multi" | "ownership" | "recheck" | "frozen";
  project: "fixtures" | "reports";
  question: string;
  /** Earlier turns, for a recheck: the reversed answer the person disputes. */
  before?: ChatMessage[];
  /** Where the answer is: the file and the place a citation names (a prefix match: "Equipment" names "Equipment rows 1-6"). */
  support: { file: string; place: string }[];
  /** Values that must reach the person (quoted answers) or ride in the supporting section (model answers). */
  facts: string[];
  /** What a competent rewrite writes (the scripted rewrite returns it; absent = no rewrite answer). */
  searchWords?: string;
}

const NW = "northwind-interim-q3-2026.pdf";
const AR = "aramco-interim-q3-2026.pdf";
const REVERSED = "Saudi Aramco owns 51% and PIF owns 49%.";

export const REPORT_CASES: BenchCase[] = [
  { id: "nw-exact-01", group: "exact", project: "reports", question: "What was Northwind's revenue in Q3 2026?", support: [{ file: NW, place: "p. 5" }], facts: ["41.2"] },
  { id: "nw-exact-02", group: "exact", project: "reports", question: "What was net income for Q2 2026?", support: [{ file: NW, place: "p. 6" }], facts: ["6.9"] },
  { id: "nw-exact-03", group: "exact", project: "reports", question: "How much was capital expenditure in Q2 2026?", support: [{ file: NW, place: "p. 13" }], facts: ["8.7"] },
  { id: "nw-exact-04", group: "exact", project: "reports", question: "What dividend per share did the Board declare for Q3 2026?", support: [{ file: NW, place: "p. 21" }], facts: ["0.34"] },
  { id: "nw-exact-05", group: "exact", project: "reports", question: "When is the Q2 2026 dividend payable?", support: [{ file: NW, place: "p. 20" }], facts: ["September 15, 2026"] },
  { id: "nw-exact-06", group: "exact", project: "reports", question: "What were total borrowings at September 30, 2026?", support: [{ file: NW, place: "p. 30" }], facts: ["112.5"] },
  { id: "nw-quarter-01", group: "quarters", project: "reports", question: "What was net income in Q1 2026?", support: [{ file: NW, place: "p. 7" }], facts: ["6.5"] },
  { id: "nw-quarter-02", group: "quarters", project: "reports", question: "How much was capital expenditure in Q3 2026?", support: [{ file: NW, place: "p. 12" }], facts: ["9.6"] },
  { id: "nw-quarter-03", group: "quarters", project: "reports", question: "What base dividend was declared for Q2 2026?", support: [{ file: NW, place: "p. 20" }], facts: ["0.33"] },
  { id: "nw-para-01", group: "paraphrase", project: "reports", question: "How much did Northwind earn in the third quarter?", support: [{ file: NW, place: "p. 5" }], facts: ["7.4"] },
  { id: "nw-para-02", group: "paraphrase", project: "reports", question: "How much money went into investment projects between July and September?", support: [{ file: NW, place: "p. 12" }], facts: ["9.6"] },
  { id: "nw-para-03", group: "paraphrase", project: "reports", question: "How many people work at Northwind?", support: [{ file: NW, place: "p. 33" }], facts: ["18,240"] },
  { id: "nw-para-04", group: "paraphrase", project: "reports", question: "How much debt did the company carry at the end of September?", support: [{ file: NW, place: "p. 30" }], facts: ["112.5"] },
  { id: "nw-ar-01", group: "arabic", project: "reports", question: "كم كانت إيرادات نورثويند في الربع الثالث من 2026؟", support: [{ file: NW, place: "p. 5" }], facts: ["41.2"], searchWords: "revenue Q3 2026" },
  { id: "nw-ar-02", group: "arabic", project: "reports", question: "ما صافي الدخل في الربع الثاني من 2026؟", support: [{ file: NW, place: "p. 6" }], facts: ["6.9"], searchWords: "net income Q2 2026" },
  { id: "nw-ar-03", group: "arabic", project: "reports", question: "متى تدفع توزيعات أرباح الربع الثالث؟", support: [{ file: NW, place: "p. 21" }], facts: ["December 14, 2026"], searchWords: "dividend Q3 2026 payable" },
  { id: "aramco-ar-01", group: "arabic", project: "reports", question: "ما هي حصة أرامكو في هيوماين؟", support: [{ file: AR, place: "p. 43" }], facts: ["49%", "51%"], searchWords: "Aramco HUMAIN stake" },
  { id: "nw-multi-01", group: "multi", project: "reports", question: "Compare capital expenditure in Q2 2026 and Q3 2026.", support: [{ file: NW, place: "p. 12" }, { file: NW, place: "p. 13" }], facts: ["9.6", "8.7"] },
  { id: "aramco-own-01", group: "ownership", project: "reports", question: "What is the percentage of Aramco in HUMAIN?", support: [{ file: AR, place: "p. 43" }], facts: ["49%", "51%", "HUMAIN Limitless Fund LP", "Al-Mustaqbal Lil-Thaka Al-Istinai Company"] },
  {
    id: "aramco-recheck-01", group: "recheck", project: "reports", question: "Double check and provide the correct info",
    before: [
      { role: "user", content: "What is the percentage of Aramco in HUMAIN?" },
      { role: "assistant", content: REVERSED },
      { role: "user", content: "Is it the other way?" },
      { role: "assistant", content: REVERSED },
    ],
    support: [{ file: AR, place: "p. 43" }], facts: ["49%", "51%", "HUMAIN Limitless Fund LP", "Al-Mustaqbal Lil-Thaka Al-Istinai Company"],
  },
  {
    id: "nw-recheck-01", group: "recheck", project: "reports", question: "Double check that",
    before: [
      { role: "user", content: "What was Northwind's revenue in Q3 2026?" },
      { role: "assistant", content: "Northwind's revenue in Q3 2026 was SAR 39.8 billion." },
    ],
    support: [{ file: NW, place: "p. 5" }], facts: ["41.2"],
  },
];

/** The frozen eval dataset's knowledge cases, over the fixture corpus. */
export function frozenCases(): BenchCase[] {
  const d = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "evals", "knowledge.json"), "utf8"));
  return d.cases.map((c: { id: string; file: string; place: string; question: string; searchWords?: string; crossLanguage?: boolean }) => ({
    id: c.id, group: "frozen" as const, project: "fixtures" as const, question: c.question,
    support: [{ file: c.file, place: c.place.replace(/^sheet /, "") }], facts: [],
    ...(c.searchWords ? { searchWords: c.searchWords } : {}),
  }));
}

// ---------------------------------------------------------------- one turn

const sse = (text: string): Response => {
  const lines = [`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`, `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 3, prompt_tokens: 9 } })}`, "data: [DONE]", ""];
  return new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(`${l}\n\n`)); c.close(); } }), { status: 200 });
};

type Msg = { role: string; content: unknown };
const sysOf = (ms: Msg[]): string => String(ms.find((m) => m.role === "system")?.content ?? "");
const LOCATOR_SYS = "You locate information in a long document.";
const REWRITE_SYS = "You write search words.";
const ANSWER_MARK = "BENCH-ANSWER";

const placeMatches = (place: string, want: string): boolean => place === want || place.startsWith(`${want} `) || place.startsWith(`${want},`);

export function benchHost(events: ChatEvent[], knowledgeDir: string | null, routerWords: string | null): ChatHost {
  const settings = { selectedModelId: BENCH_ENTRY.id, webSearch: false, wikimediaImages: false, agentLoop: false, autoCheck: false } as unknown as Settings;
  return {
    settings: () => settings, patchSettings: () => {}, allEntries: () => [BENCH_ENTRY], entryById: (id) => (id === BENCH_ENTRY.id ? BENCH_ENTRY : undefined),
    installedEntries: async () => [BENCH_ENTRY], chatHardware: async () => HW, lastLoaded: () => null, setLastLoaded: () => {}, benchRunning: () => false,
    ensureServer: async (): Promise<Served> => ({ endpoint: "http://127.0.0.1:9/v1", status: () => ({ nctx: BENCH_NCTX }) }),
    servedName: (e) => `${e.repo}:${e.quant}`, send: (ev) => events.push(ev), recordSpeed: () => {},
    runSearch: async () => ({ text: "", display: "", sources: 0 }), searchImages: async () => ({ text: "", display: "", files: [] }),
    commonsJson: async () => ({}), wikiPicture: async () => null, folderOf: () => null, figure: async () => null,
    renderSlide: async () => ({ problems: [] }), lookAtShot: async () => null, checkArtifact: async () => ({ ran: "none", errors: [] }),
    harnessJournalFile: () => null, knowledgeDir: () => knowledgeDir,
    router: { sort: async () => null, yesNo: async () => false, query: async () => routerWords, fileKind: async () => null },
  };
}

export interface CaseResult {
  id: string;
  group: BenchCase["group"];
  /** The supporting section was among the first five sections of the answer request, or cited by a quoted answer. */
  recall5: boolean;
  /** BM25 on the question's own words alone (no rewrite, no locator): the supporting section in its top five. */
  bm25Top5: boolean;
  /** Quoted answer: every fact is in what the person sees and the supporting place is cited. Model answer: the supporting section rode whole with every fact. */
  accurate: boolean;
  /** The turn answered from a source quote, with no model call. */
  quoted: boolean;
  locatorCalls: number;
  rewriteCalls: number;
  modelCalls: number;
  /** Tokens of the answer request (0 when the answer was quoted). */
  answerPromptTokens: number;
  /** Characters of the retrieved knowledge that rode in the answer request. */
  knowledgeChars: number;
  hostMs: number;
  /** Modeled seconds to the first answer token and to the end of the turn (published NPU rates; not measured on a device). */
  modeledTtftS: number;
  modeledTotalS: number;
  /** The diagnostic timings the turn itself reported, when it reports them. */
  timings?: Record<string, unknown>;
}

const sectionsIn = (text: string): { file: string; place: string; body: string }[] =>
  [...text.matchAll(/<section source="\d+" file="([^"]*)" place="([^"]*)">\n([\s\S]*?)\n<\/section>/g)].map((m) => ({ file: m[1], place: m[2], body: m[3] }));

export async function runCase(c: BenchCase, files: KnowledgeFileLike[], knowledgeDir: string | null, embedder: Embedder | null = null): Promise<CaseResult> {
  const events: ChatEvent[] = [];
  const calls: { kind: keyof typeof OUT_TOKENS; tokens: number; messages: Msg[] }[] = [];
  vi.stubGlobal("fetch", async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Msg[] };
    const sys = sysOf(body.messages);
    const tokens = promptTokens(body.messages as ChatMessage[]);
    if (sys.startsWith(LOCATOR_SYS)) {
      calls.push({ kind: "locator", tokens, messages: body.messages });
      // a generous locator: it names the supporting section when the outline holds it
      const outline = String(body.messages.at(-1)?.content ?? "").split("\n").filter((l) => /^\d+\. /.test(l));
      const hit = outline.find((l) => c.support.some((s) => l.includes(`${s.file} —`) && new RegExp(`\\((${s.place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})[^)]*\\)`).test(l)));
      // MKMN_BENCH_REWRITE=junk also gives the locator the installed 4B's count
      if (process.env.MKMN_BENCH_REWRITE === "junk") return sse("22, 23, 24, 25, 26, 27,");
      return sse(hit ? hit.split(".")[0] : "none");
    }
    if (sys.startsWith(REWRITE_SYS)) {
      calls.push({ kind: "rewrite", tokens, messages: body.messages });
      // MKMN_BENCH_REWRITE=junk: the rewrite the installed 4B wrote, digits
      return sse(process.env.MKMN_BENCH_REWRITE === "junk" ? "3000000000000000000000000000000000000000000000" : c.searchWords ?? "");
    }
    const isAnswer = body.messages.some((m) => m.role === "user");
    calls.push({ kind: isAnswer ? "answer" : "other", tokens, messages: body.messages });
    return sse(ANSWER_MARK);
  });
  const project = { id: `bench-${c.project}`, name: "Bench", description: "", instructions: "", files: files.map((f) => ({ id: f.id, name: f.name, content: f.content })), created: 0, updated: 0 };
  const history: ChatMessage[] = [...(c.before ?? []), { role: "user", content: c.question }];
  const system = buildSystemPrompt({ project, knowledgeChars: knowledgeBudget(BENCH_NCTX), contextTokens: BENCH_NCTX, conversationTokens: promptTokens(history) });
  const opts: ChatOptions = { effort: null, subagents: false, projectId: project.id, knowledge: files.map((f) => ({ id: f.id, name: f.name, content: f.content })) };
  const t0 = performance.now();
  await runChatOrchestrator({ ...benchHost(events, knowledgeDir, null), embedder: async () => embedder }, `bench-${c.id}`, BENCH_ENTRY.id, [{ role: "system", content: system }, ...history], opts);
  const hostMs = performance.now() - t0;
  vi.unstubAllGlobals();

  const visible = events.filter((e) => e.type === "answer" || e.type === "replace").map((e) => (e as { text: string }).text).join("");
  const answerCalls = calls.filter((x) => x.kind === "answer");
  const last = answerCalls.at(-1);
  const quoted = !last && visible.length > 0 && !visible.includes(ANSWER_MARK);
  const rode = last ? sectionsIn(last.messages.map((m) => String(m.content)).join("\n")) : [];
  const supportedAt = (list: { file: string; place: string }[]) => c.support.every((s) => list.some((r) => r.file === s.file && placeMatches(r.place, s.place)));
  const citesSupport = c.support.every((s) => visible.includes(`${s.file} (${s.place}`));
  const recall5 = quoted ? citesSupport : supportedAt(rode.slice(0, 5));
  const supportBodies = rode.filter((r) => c.support.some((s) => r.file === s.file && placeMatches(r.place, s.place))).map((r) => r.body.replace(/\s+/g, " ")).join("\n");
  const accurate = quoted
    ? citesSupport && c.facts.every((f) => visible.replace(/\s+/g, " ").includes(f))
    : supportedAt(rode) && c.facts.every((f) => supportBodies.includes(f));
  const index = openKnowledgeIndex(null, `bench-raw-${c.project}`, files);
  const raw = index.search(c.question, 5).map((h) => ({ file: h.name, place: placeOfHit(h) }));
  const bm25Top5 = supportedAt(raw);

  const callSecs = (x: { kind: keyof typeof OUT_TOKENS; tokens: number }) => CALL_OVERHEAD_S + x.tokens / PREFILL_TPS + OUT_TOKENS[x.kind] / DECODE_TPS;
  const before = calls.slice(0, last ? calls.indexOf(last) : calls.length);
  const pre = before.reduce((n, x) => n + callSecs(x), 0);
  const modeledTtftS = hostMs / 1000 + pre + (last ? CALL_OVERHEAD_S + last.tokens / PREFILL_TPS : 0);
  const modeledTotalS = hostMs / 1000 + calls.reduce((n, x) => n + callSecs(x), 0);
  const step = events.find((e) => e.type === "run") as { view?: { steps?: { id: string; input?: Record<string, unknown> }[] } } | undefined;
  const timings = (step?.view?.steps ?? []).find((s) => s.id.endsWith(":know"))?.input?.timings as Record<string, unknown> | undefined;
  return {
    id: c.id, group: c.group, recall5, bm25Top5, accurate, quoted,
    locatorCalls: calls.filter((x) => x.kind === "locator").length,
    rewriteCalls: calls.filter((x) => x.kind === "rewrite").length,
    modelCalls: calls.length,
    answerPromptTokens: last?.tokens ?? 0,
    knowledgeChars: rode.reduce((n, r) => n + r.body.length, 0),
    hostMs: Math.round(hostMs * 10) / 10,
    modeledTtftS: Math.round(modeledTtftS * 100) / 100,
    modeledTotalS: Math.round(modeledTotalS * 100) / 100,
    ...(timings ? { timings } : {}),
  };
}

function placeOfHit(h: { title: string; page?: number; slide?: number; sheet?: string; rowFrom?: number; rowTo?: number; scanned?: boolean }): string {
  if (h.page !== undefined) return h.scanned ? `p. ${h.page}, scanned text` : `p. ${h.page}`;
  if (h.slide !== undefined) return `slide ${h.slide}`;
  if (h.sheet !== undefined) return `${h.sheet} rows ${h.rowFrom ?? 1}-${h.rowTo ?? h.rowFrom ?? 1}`;
  return h.title;
}

// ---------------------------------------------------------------- the report

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 : 0);
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};

export interface BenchSummary {
  cases: number;
  recallAt5Pct: number;
  bm25Top5Pct: number;
  accuracyPct: number;
  quotedPct: number;
  locatorCallRatePct: number;
  rewriteCallRatePct: number;
  modelCallsPerTurn: number;
  answerPromptTokensP50: number;
  knowledgeCharsP50: number;
  hostMsP50: number;
  hostMsP95: number;
  modeledTtftP50: number;
  modeledTtftP95: number;
  modeledTotalP50: number;
  modeledTotalP95: number;
}

export function summarize(rows: CaseResult[]): BenchSummary {
  const n = rows.length;
  const answered = rows.filter((r) => r.answerPromptTokens > 0);
  return {
    cases: n,
    recallAt5Pct: pct(rows.filter((r) => r.recall5).length, n),
    bm25Top5Pct: pct(rows.filter((r) => r.bm25Top5).length, n),
    accuracyPct: pct(rows.filter((r) => r.accurate).length, n),
    quotedPct: pct(rows.filter((r) => r.quoted).length, n),
    locatorCallRatePct: pct(rows.filter((r) => r.locatorCalls > 0).length, n),
    rewriteCallRatePct: pct(rows.filter((r) => r.rewriteCalls > 0).length, n),
    modelCallsPerTurn: Math.round((rows.reduce((s, r) => s + r.modelCalls, 0) / (n || 1)) * 100) / 100,
    answerPromptTokensP50: quantile(answered.map((r) => r.answerPromptTokens), 0.5),
    knowledgeCharsP50: quantile(answered.map((r) => r.knowledgeChars), 0.5),
    hostMsP50: quantile(rows.map((r) => r.hostMs), 0.5),
    hostMsP95: quantile(rows.map((r) => r.hostMs), 0.95),
    modeledTtftP50: quantile(rows.map((r) => r.modeledTtftS), 0.5),
    modeledTtftP95: quantile(rows.map((r) => r.modeledTtftS), 0.95),
    modeledTotalP50: quantile(rows.map((r) => r.modeledTotalS), 0.5),
    modeledTotalP95: quantile(rows.map((r) => r.modeledTotalS), 0.95),
  };
}

/** Index costs, cold and warm: a first build (cut + write the store), a reopen from the store, a reopen in the same process, one search. */
export function indexTimings(files: KnowledgeFileLike[], dir: string, projectId: string, question: string): { coldMs: number; warmMs: number; warmAgainMs: number; searchMs: number; rebuiltCold: boolean; rebuiltWarm: boolean; heapDeltaMB: number } {
  const heap0 = process.memoryUsage().heapUsed;
  let t = performance.now();
  const cold = openKnowledgeIndex(dir, projectId, files);
  const coldMs = performance.now() - t;
  const heapDeltaMB = Math.round(((process.memoryUsage().heapUsed - heap0) / 1048576) * 10) / 10;
  // a reopen as a new process sees it: the in-memory indexes forgotten, the store read
  (store as { forgetKnowledgeIndexes?: () => void }).forgetKnowledgeIndexes?.();
  t = performance.now();
  const warm = openKnowledgeIndex(dir, projectId, files);
  const warmMs = performance.now() - t;
  t = performance.now();
  openKnowledgeIndex(dir, projectId, files);
  const warmAgainMs = performance.now() - t;
  t = performance.now();
  for (let i = 0; i < 20; i++) warm.search(question, 12);
  const searchMs = (performance.now() - t) / 20;
  const r = (x: number) => Math.round(x * 100) / 100;
  return { coldMs: r(coldMs), warmMs: r(warmMs), warmAgainMs: r(warmAgainMs), searchMs: r(searchMs), rebuiltCold: cold.rebuilt, rebuiltWarm: warm.rebuilt, heapDeltaMB };
}

/** A large project for the index costs: `files` files of about `kb` kilobytes each, every page different. */
export function largeCorpus(files = 100, kb = 100): KnowledgeFileLike[] {
  return Array.from({ length: files }, (_, f) => ({
    id: `large-${f}`, name: `large-${f}.pdf`,
    content: Array.from({ length: Math.ceil((kb * 1024) / 400) }, (_, p) =>
      `[page ${p + 1}]\nFile ${f} page ${p + 1}: the ${FILLER_TOPICS[(f + p) % FILLER_TOPICS.length]} note records item ${f * 1000 + p} with amount ${(f * 37 + p * 11) % 9973} riyals and reference code R${f}-${p}, prepared for the period under review by the finance team.`).join("\n"),
  }));
}

export const peakRssMB = (): number => Math.round((process.resourceUsage().maxRSS / 1024) * 10) / 10;
