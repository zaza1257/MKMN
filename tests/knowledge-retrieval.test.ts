import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogEntry, ChatEvent, ChatMessage, ChatOptions, HardwareProfile, Project, Settings } from "../src/shared/types";
import { runChatOrchestrator, type ChatHost, type Served } from "../src/core/chatOrchestrator";
import { buildSystemPrompt, knowledgeBudget } from "../src/core/projects";
import { SECTION_CUT as SECTION_CUT_TEXT } from "../src/core/knowledge/retrieve";
import { promptTokens } from "../src/core/context";
import { readJournal } from "../src/core/harness/journal";
import { extractPdfText } from "../src/core/pdf";
import { wrapPdfDoc } from "../src/core/pdfSections";
import { readOffice } from "../src/core/office";

/**
 * Searchable knowledge on the request path (Phases 6, D3+D4): the knowledge
 * files travel with the request (ChatOptions.knowledge), the orchestrator
 * ensures the index, and the retrieval is a step of the turn's run — BM25 top
 * 12, then the locator (through the gateway) names up to 4 sections, whose
 * text replaces the packed "Project knowledge" block, filled to the knowledge
 * budget, most relevant first. The regression here fails on the earlier code: there,
 * a fact on page 150 of a long PDF is cut away by the packing and never
 * reaches the model's request.
 */

const ENTRY: CatalogEntry = {
  id: "test-1b", name: "Test 1B", repo: "org/test-1b", quant: "Q4_0", engine: "qairt", role: "chat",
  architecture: "llama", sizeGB: 1, recommendedContext: 4096, sampling: { temperature: 0.7, top_p: 0.9, max_tokens: 512 }
};

const HW: HardwareProfile = { chipName: "Test Chip", chipFamily: "x2", isSnapdragon: true, ramGB: 16, npuDetected: true, npuDriverVersion: "1.0.0", npuBudgetGB: 8 };
const baseSettings = (): Settings => ({ selectedModelId: "test-1b", webSearch: false, wikimediaImages: false, agentLoop: false, autoCheck: false } as unknown as Settings);
const NCTX = 2048;

const sse = (text: string): Response => {
  const lines = [`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`, `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 3, prompt_tokens: 9 } })}`, "data: [DONE]", ""];
  return new Response(new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(`${l}\n\n`)); c.close(); }
  }), { status: 200 });
};

type Body = { messages: { role: string; content: unknown }[] };

const sysOf = (b: Body): string => String((b.messages ?? []).find((m: { role: string }) => m.role === "system")?.content ?? "");
const textsOf = (b: Body): string => (b.messages ?? []).map((m) => String(m.content)).join("\n");

/** A scripted server: each reply keyed by the system prompt the call carries. */
function scriptedFetch(bodies: Body[], bySystem: { starts: string; reply: string }[], answer: string) {
  return vi.fn(async (_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const sys = sysOf(body);
    for (const r of bySystem) if (sys.startsWith(r.starts)) return sse(r.reply);
    return sse(answer);
  });
}

function fakeHost(o: {
  events: ChatEvent[];
  journalFile: string | null;
  settings: Settings;
  fetch: ReturnType<typeof scriptedFetch>;
  knowledgeDir?: string | null;
  routerQuery?: string | null;
}): ChatHost {
  return {
    settings: () => o.settings,
    patchSettings: () => {},
    allEntries: () => [ENTRY],
    entryById: (id) => (id === ENTRY.id ? ENTRY : undefined),
    installedEntries: async () => [ENTRY],
    chatHardware: async () => HW,
    lastLoaded: () => null,
    setLastLoaded: () => {},
    benchRunning: () => false,
    ensureServer: async (): Promise<Served> => ({ endpoint: "http://127.0.0.1:9/v1", status: () => ({ nctx: NCTX }) }),
    servedName: (e) => `${e.repo}:${e.quant}`,
    send: (ev) => o.events.push(ev),
    recordSpeed: () => {},
    runSearch: async () => ({ text: "", display: "", sources: 0 }),
    searchImages: async () => ({ text: "", display: "", files: [] }),
    commonsJson: async () => ({}),
    wikiPicture: async () => null,
    folderOf: () => null,
    figure: async () => null,
    renderSlide: async () => ({ problems: [] }),
    lookAtShot: async () => null,
    checkArtifact: async () => ({ ran: "none", errors: [] }),
    harnessJournalFile: () => o.journalFile,
    ...(o.knowledgeDir !== undefined ? { knowledgeDir: () => o.knowledgeDir } : {}),
    router: {
      sort: async () => null,
      yesNo: async () => false,
      query: async () => (o.routerQuery !== undefined ? o.routerQuery : null),
      fileKind: async () => null,
    },
  };
}

const LOCATOR_SYS = "You locate information in a long document.";
const REWRITE_SYS = "You write search words.";
const PART_SYS = "You summarize one part of a longer document";
const REDUCE_SYS = "You write the summary of a whole document";

/** A long Project knowledge PDF: 200 pages, the fact on page 150. */
const longPdf = (fact: boolean): string =>
  Array.from({ length: 200 }, (_, i) =>
    `[page ${i + 1}]\nPage ${i + 1} talks about topic ${i}. It carries planning detail for the year and nothing more.` +
    (fact && i === 149 ? " The xylophone budget is 1997 dinars." : "")
  ).join("\n");

/** The same shape in Arabic: 200 pages, the fact on page 150 (the reverse crossing's files). */
const longPdfAr = (fact: boolean): string =>
  Array.from({ length: 200 }, (_, i) =>
    `[page ${i + 1}]\nالصفحة ${i + 1} تتحدث عن الموضوع ${i}. تحمل تفاصيل تخطيط السنة ولا أكثر.` +
    (fact && i === 149 ? " قاعة القراءة تضم 40000 كتاب منذ عام 1987." : "")
  ).join("\n");

/** The renderer's request: the system prompt built the way Chat.tsx builds it, with the knowledge packed and cut to the budget. */
const packedProject = (content: string): Project => ({
  id: "p-1", name: "Household", description: "", instructions: "",
  files: [{ id: "f1", name: "report.pdf", content }],
  created: 0, updated: 0
});
const packedSystem = (content: string): string =>
  buildSystemPrompt({ project: packedProject(content), knowledgeChars: knowledgeBudget(NCTX), contextTokens: NCTX, conversationTokens: promptTokens([{ role: "user", content: "What is the xylophone budget?" }]) });
const OPTS = (content: string): ChatOptions => ({
  effort: null, subagents: false, projectId: "p-1",
  knowledge: [{ id: "f1", name: "report.pdf", content }],
});
const MSGS = (sys: string, question: string): ChatMessage[] => [
  { role: "system", content: sys },
  { role: "user", content: question }
];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("knowledge retrieval on the request path", () => {
  it("announces the locator timeout and completes with the keyword fallback", async () => {
    vi.useFakeTimers();
    const content = longPdf(true);
    const events: ChatEvent[] = [];
    let locatorStarted = false;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (!sysOf(body).startsWith(LOCATOR_SYS)) return sse("The xylophone budget is 1997 dinars.");
      locatorStarted = true;
      return new Promise<Response>((_, reject) => {
        const signal = init.signal!;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    // a weak match (the files never say "spending"), so the locator is asked: a strong
    // keyword match skips it altogether and could not time out
    const turn = runChatOrchestrator(fakeHost({ events, journalFile: null, settings: baseSettings(), fetch: scriptedFetch([], [], "") }),
      "locator-timeout", ENTRY.id, MSGS(packedSystem(content), "What do the pages say about the xylophone spending?"), OPTS(content));
    await vi.waitFor(() => expect(locatorStarted).toBe(true));
    await vi.advanceTimersByTimeAsync(45_000);
    await turn;
    expect(events.some((e) => e.type === "notice" && /timed out.*keyword matches/.test(e.text))).toBe(true);
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("answers a verification follow-up from the cited ownership disclosure after a reversed reply", async () => {
    // Official Q3 2026 interim report, note 18, page 43. Keep its extracted line
    // breaks in the regression fixture, surrounded by enough text to require retrieval.
    const note = fs.readFileSync(new URL("./fixtures/knowledge/aramco-q3-2026-note-18.txt", import.meta.url), "utf8").trim();
    const disclosure = note.slice(note.indexOf("On November")).replace(/\s+/g, " ");
    const content = longPdf(false).replace("[page 43]\n", `[page 43]\n${note}\n\n`);
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const wrong = "Saudi Aramco owns 51% and PIF owns 49%.";
    const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "none" }], wrong);
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: null, settings: baseSettings(), fetch: fetchFn }), "ownership", ENTRY.id, [
      ...MSGS(packedSystem(content), "What is the percentage of Aramco in HUMAIN?"),
      { role: "assistant", content: wrong },
      { role: "user", content: "Is it the other way?" },
      { role: "assistant", content: wrong },
      { role: "user", content: "Double check and provide the correct info" },
    ], OPTS(content));
    const visible = events.filter((e) => e.type === "answer" || e.type === "replace").map((e) => e.text).join("");
    expect(visible).toContain(disclosure);
    expect(visible).toContain("report.pdf (p. 43)");
    expect(visible).not.toContain(wrong);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(bodies).toHaveLength(0);
  });

  it("looks up a named stake in an attached PDF before fitting its text to the window", async () => {
    const disclosure = "Northstar acquired a 60% stake in Acme, with Harbor retaining 40% ownership.";
    const content = longPdf(false).replace("[page 150]\n", `[page 150]\n${disclosure}\n\n`);
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [], "Northstar owns 40%.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: null, settings: baseSettings(), fetch: fetchFn }), "attached-ownership", ENTRY.id, [
      { role: "user", content: `${wrapPdfDoc("deal.pdf", content, 1500)}\n\nHow much does Northstar own in Acme?` },
    ], { effort: null, subagents: false });
    const answer = events.find((event) => event.type === "answer");
    expect(answer?.text).toContain(disclosure);
    expect(answer?.text).toContain("deal.pdf (p. 150)");
    expect(bodies).toHaveLength(0);
  });

  it("abstains when a percentage cannot be tied to the ownership question", async () => {
    const content = "The survey found that 49% of readers recognized the company name HUMAIN. Aramco and PIF are shareholders.";
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [], "Aramco owns 49%.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: null, settings: baseSettings(), fetch: fetchFn }), "unknown-ownership", ENTRY.id,
      MSGS(packedSystem(content), "How much does Aramco own in HUMAIN?"), OPTS(content));
    expect(events.find((event) => event.type === "answer")?.text).toMatch(/couldn't verify/i);
    expect(bodies).toHaveLength(0);
  });
  it("REGRESSION: the retrieved block rides even when the request carries no renderer system message (on-device knowledge turns: the block was built, then silently dropped)", async () => {
    // On-device test runs: the know step packed the
    // fact's section, the know step's reply held it (realHit=1) — and the answer model's
    // prompt was 230 tokens. The block is delivered by REPLACING the "Project knowledge"
    // block in a system message the caller was expected to send; a request without one (a
    // bare sidecar call, a headless task) silently lost the whole retrieval, and the model
    // — told to cite [source N] — invented facts with invented page numbers.
    const content = longPdf(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-retr-"));
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "1" }], "The xylophone budget is 1997 dinars.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: null, settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-0", ENTRY.id, [{ role: "user", content: "What is the xylophone budget?" }], OPTS(content));
    // the answer's request carries the retrieved fact, system message or no system message
    const answerReq = bodies.at(-1)!;
    const texts = textsOf(answerReq);
    expect(texts).toContain("1997 dinars");
    expect(texts).toContain('<section source="1" file="report.pdf"');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("REGRESSION: the fact on page 150 of a long knowledge PDF is in the model's request now (it was cut away by the packing before)", async () => {
    const content = longPdf(true);
    const sys = packedSystem(content);
    expect(sys.includes("1997 dinars")).toBe(false); // the packing really cut the fact away: retrieval is what must bring it back
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-retr-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "1" }], "The xylophone budget is 1997 dinars.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: file, settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-1", ENTRY.id, MSGS(sys, "What is the xylophone budget?"), OPTS(content));

    // the answer's request carries the fact: the picked page replaced the packed block
    const answerReq = bodies.filter((b) => sysOf(b).includes("Project knowledge")).at(-1)!;
    const texts = textsOf(answerReq);
    expect(texts).toContain("1997 dinars");
    expect(texts).toContain('<section source="1" file="report.pdf"');
    expect(texts).not.toContain("[…cut to fit the model's context]"); // the packed cut version was replaced
    // the retrieval is a step of the turn's run, like every retrieval
    const steps = readJournal(file).entries.filter((e) => e.type === "step") as { id: string; status: string; kind?: string }[];
    expect(steps.some((s) => s.id.endsWith(":know") && s.kind === "retrieve" && s.status === "ok")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an Arabic question over English files: the rewrite writes search words in the files' language, and the router's answer spares the rewrite call", async () => {
    const content = longPdf(true);
    const sys = packedSystem(content);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-retr-"));
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "1" }, { starts: REWRITE_SYS, reply: "xylophone budget" }], "1997 dinars.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: null, settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-2", ENTRY.id, MSGS(sys, "ما هي ميزانية الزايلوفون؟"), OPTS(content));
    // the rewrite was asked of the model (the raw Arabic words match nothing in the English pages)
    expect(bodies.some((b) => sysOf(b).startsWith(REWRITE_SYS))).toBe(true);
    const answerReq = bodies.filter((b) => sysOf(b).includes("Project knowledge")).at(-1)!;
    expect(textsOf(answerReq)).toContain("1997 dinars");

    // the router's own answer to the same need: no rewrite call is made at all
    const bodies2: Body[] = [];
    const fetchFn2 = scriptedFetch(bodies2, [{ starts: LOCATOR_SYS, reply: "1" }], "1997 dinars.");
    vi.stubGlobal("fetch", fetchFn2);
    await runChatOrchestrator(fakeHost({ events: [], journalFile: null, settings: baseSettings(), fetch: fetchFn2, knowledgeDir: dir, routerQuery: "xylophone budget" }), "t-3", ENTRY.id, MSGS(sys, "ما هي ميزانية الزايلوفون؟"), OPTS(content));
    expect(bodies2.some((b) => sysOf(b).startsWith(REWRITE_SYS))).toBe(false);
    expect(textsOf(bodies2.at(-1)!)).toContain("1997 dinars");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the locator's fallback: a reply that names no section loads the best-matching sections by rank", async () => {
    const content = longPdf(true);
    const sys = packedSystem(content);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-retr-"));
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "I cannot tell." }], "1997 dinars.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: null, settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-4", ENTRY.id, MSGS(sys, "What is the xylophone budget?"), OPTS(content));
    const answerReq = bodies.filter((b) => sysOf(b).includes("Project knowledge")).at(-1)!;
    expect(textsOf(answerReq)).toContain("1997 dinars");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the picks are packed most relevant first and filled to the knowledge budget, a section over it is cut and named", async () => {
    // four pages match the question, each with its own marker; the orchestrator's knowledge
    // budget is knowledgeBudget(2048) = 2389 characters, and the sections are sized so three
    // fit whole and the fourth is cut
    const content = [
      ...Array.from({ length: 149 }, (_, i) => `[page ${i + 1}]\nPage ${i + 1} talks about topic ${i}.`),
      `[page 150]\nALPHA the xylophone budget line. ${"budget detail. ".repeat(31)}`,
      `[page 151]\nBETA the xylophone vendors list. ${"vendors detail. ".repeat(31)}`,
      `[page 152]\nGAMMA the xylophone maintenance plan. ${"maintenance detail. ".repeat(31)}`,
      `[page 153]\nDELTA the xylophone delivery plan. ${"delivery detail. ".repeat(31)}`,
      ...Array.from({ length: 46 }, (_, i) => `[page ${i + 154}]\nPage ${i + 154} talks about topic ${i + 154}.`),
    ].join("\n");
    const sys = packedSystem(content);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-retr-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "1, 2, 3, 4" }], "All four lines.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: file, settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-5", ENTRY.id, MSGS(sys, "What do the files say about the xylophone budget, vendors, maintenance and delivery?"), OPTS(content));
    const answerReq = bodies.filter((b) => sysOf(b).includes("Project knowledge")).at(-1)!;
    const texts = textsOf(answerReq);
    expect(texts).toContain("ALPHA");
    const at = (w: string) => texts.indexOf(w);
    expect(at("ALPHA")).toBeLessThan(at("BETA"));
    expect(at("BETA")).toBeLessThan(at("GAMMA"));
    expect(at("GAMMA")).toBeLessThan(at("DELTA"));
    // one section over the budget is cut, and says so; the body stayed within the budget (the
    // journaled retrieve step carries its size)
    expect(texts).toContain(SECTION_CUT_TEXT);
    const steps = readJournal(file).entries.filter((e) => e.type === "step") as { id: string; kind?: string; status: string; input?: { blockChars?: number } }[];
    const know = steps.find((s) => s.id.endsWith(":know"));
    expect(know?.status).toBe("ok");
    expect(know?.input?.blockChars ?? 0).toBeLessThanOrEqual(knowledgeBudget(NCTX) + 60);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("knowledge small enough to fit is sent whole: no locator, no retrieval step, today's packing unchanged", async () => {
    const content = "[page 1]\nThe xylophone budget is 1997 dinars.";
    const sys = packedSystem(content);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-retr-"));
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [], "1997 dinars.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: null, settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-6", ENTRY.id, MSGS(sys, "What is the xylophone budget?"), OPTS(content));
    expect(bodies.length).toBe(2); // the build decision's question, then the answer — no locator, no rewrite
    expect(bodies.some((b) => sysOf(b).startsWith(LOCATOR_SYS) || sysOf(b).startsWith(REWRITE_SYS))).toBe(false);
    expect(textsOf(bodies[1])).toContain("1997 dinars");
    expect(textsOf(bodies[1])).not.toContain("<section ");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("nothing retrieved: today's packing is sent unchanged", async () => {
    // the rule: a locator that answers "none" (or nothing) never empties the block —
    // the BM25 order fills the knowledge budget instead (this test pinned the emptying on
    // earlier; know-en-01 showed the model answering "I don't have access" through it)
    const content = longPdf(true);
    const sys = packedSystem(content);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-retr-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "none" }, { starts: REWRITE_SYS, reply: "happiness" }], "I cannot say.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: file, settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-7", ENTRY.id, MSGS(sys, "What is the meaning of life?"), OPTS(content));
    const answerReq = bodies.filter((b) => sysOf(b).includes("Project knowledge")).at(-1)!;
    const texts = textsOf(answerReq);
    expect(texts).toContain("<section "); // the BM25 order's sections ride even on "none"
    expect(texts).not.toContain("[…cut to fit the model's context]"); // the renderer's packing was replaced
    const steps = readJournal(file).entries.filter((e) => e.type === "step") as { id: string; input?: { blockChars?: number } }[];
    const know = steps.find((s) => s.id.endsWith(":know"));
    expect(know?.input?.blockChars ?? 0).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("REGRESSION (know-en-01 as recorded): the locator answers none while BM25 matched 12 — the fact's section still rides in the request body", async () => {
    const content = longPdf(true);
    const sys = packedSystem(content);
    expect(sys.includes("1997 dinars")).toBe(false); // the packing really cut the fact away: only retrieval can bring it back
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-retr-"));
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    // the locator's recorded shape: a clean "none" — the code read it as an empty
    // pick list and sent the empty packed block, and the model answered "I don't have access"
    const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "none" }], "The xylophone budget is 1997 dinars.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: null, settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-9", ENTRY.id, MSGS(sys, "What is the xylophone budget?"), OPTS(content));
    const answerReq = bodies.filter((b) => sysOf(b).includes("Project knowledge")).at(-1)!;
    expect(textsOf(answerReq)).toContain("1997 dinars");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("REGRESSION (know-cross as recorded): a bad rewrite is searched ALONGSIDE the question's words, merged by best rank — good hits are not thrown away", async () => {
    // the recorded cross cases: the gate fired, the rewrite replaced the query, the search
    // got worse (matched 12 -> 0), and the block emptied. The question here is Arabic over
    // English pages with two content words that still match, so the original hits hold the
    // fact; the scripted router writes useless words, and the merge must keep the originals
    const content = longPdf(true);
    const sys = packedSystem(content);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-retr-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "1" }], "1997 dinars.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: file, settings: baseSettings(), fetchFn, knowledgeDir: dir, routerQuery: "happiness" }), "t-11", ENTRY.id, MSGS(sys, "xylophone budget ميزانية الزايلوفون في عام كتب ارشيف"), OPTS(content));
    const answerReq = bodies.filter((b) => sysOf(b).includes("Project knowledge")).at(-1)!;
    expect(textsOf(answerReq)).toContain("1997 dinars");
    // the rewrite was asked (the scripts differ) through the router, but its words matched
    // nothing, so the titles fallback ran (a rewrite that finds nothing no longer suppresses
    // it, fix) and the record says so; the good hits above were kept either way
    const steps = readJournal(file).entries.filter((e) => e.type === "step") as { id: string; input?: { rewritten?: boolean; rewrite?: string | null; crossLanguage?: boolean } }[];
    const know = steps.find((s) => s.id.endsWith(":know"));
    expect(know?.input?.rewritten).toBe(true);
    expect(know?.input?.rewrite).toBe("titles");
    expect(know?.input?.crossLanguage).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an English question over Arabic files: the rewrite (the reverse crossing) writes the files' language and the fact rides", async () => {
    const content = longPdfAr(true);
    const sys = packedSystem(content);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-retr-"));
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "1" }, { starts: REWRITE_SYS, reply: "قاعة القراءة كتاب 1987" }], "1987.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: null, settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-12", ENTRY.id, MSGS(sys, "What is the reading room capacity؟"), OPTS(content));
    const answerReq = bodies.filter((b) => sysOf(b).includes("Project knowledge")).at(-1)!;
    expect(textsOf(answerReq)).toContain("40000 كتاب");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a script mismatch always asks the rewrite, even when BM25's answer looks strong (the recorded gate missed this corner)", async () => {
    // Arabic question over English files whose Latin words match pages 1-3 strongly — the
    // old weak gate saw a healthy score and never asked; the fact's page matches neither
    // Latin word, so only the rewrite's words can find it
    const content = [
      ...Array.from({ length: 3 }, (_, i) => `[page ${i + 1}]\nThe xylophone budget schedule rides on page ${i + 1}.`),
      ...Array.from({ length: 146 }, (_, i) => `[page ${i + 4}]\nPage ${i + 4} talks about topic ${i}. It carries planning detail.`),
      `[page 150]\nThe reading room holds 40000 books since 1987.`,
      ...Array.from({ length: 50 }, (_, i) => `[page ${i + 151}]\nPage ${i + 151} talks about topic ${i}. It carries planning detail.`),
    ].join("\n");
    const sys = packedSystem(content);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-retr-"));
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "1" }, { starts: REWRITE_SYS, reply: "reading room books 1987" }], "40000 books.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: null, settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-13", ENTRY.id, MSGS(sys, "xylophone budget ميزانية الزايلوفون"), OPTS(content));
    // the rewrite was asked of the model although the original search scored well
    expect(bodies.some((b) => sysOf(b).startsWith(REWRITE_SYS))).toBe(true);
    const answerReq = bodies.filter((b) => sysOf(b).includes("Project knowledge")).at(-1)!;
    expect(textsOf(answerReq)).toContain("40000 books");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("neither model answers the rewrite: the files' own title and heading words are searched as the fallback, and the record says why", async () => {
    // a Word file (its headings stay in the text), an Arabic question over English words:
    // the router is silent and the rewrite model answers empty — the titles fallback runs
    const content = [
      "# Reading room",
      `The reading room holds 40000 books since 1987. ${"room detail. ".repeat(60)}`,
      "# Storage",
      `The storage boxes ride in the basement. ${"box detail. ".repeat(60)}`,
      "# Index",
      `The index lists every year. ${"index detail. ".repeat(60)}`,
    ].join("\n");
    const project: Project = { id: "p-1", name: "Household", description: "", instructions: "", files: [{ id: "f1", name: "notes.docx", content }], created: 0, updated: 0 };
    const sys = buildSystemPrompt({ project, knowledgeChars: knowledgeBudget(NCTX), contextTokens: NCTX, conversationTokens: promptTokens([{ role: "user", content: "سنة الغرفة" }]) });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-retr-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "1" }, { starts: REWRITE_SYS, reply: "" }], "A plain answer.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: file, settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-14", ENTRY.id, MSGS(sys, "سنة الغرفة"), { effort: null, subagents: false, projectId: "p-1", knowledge: [{ id: "f1", name: "notes.docx", content }] });
    const steps = readJournal(file).entries.filter((e) => e.type === "step") as { id: string; input?: { rewrite?: string | null; blockChars?: number } }[];
    const know = steps.find((s) => s.id.endsWith(":know"));
    expect(know?.input?.rewrite).toBe("titles");
    expect(know?.input?.blockChars ?? 0).toBeGreaterThan(0); // the block never empties, whatever answered
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("REGRESSION: a rewrite whose words match nothing does not suppress the titles fallback", async () => {
    const content = [
      "# Reading room",
      `The reading room holds 40000 books since 1987. ${"room detail. ".repeat(Math.ceil(knowledgeBudget(NCTX) / 13))}`,
      "# Storage",
      `The storage boxes ride in the basement. ${"box detail. ".repeat(Math.ceil(knowledgeBudget(NCTX) / 12))}`,
    ].join("\n");
    const project: Project = { id: "p-1", name: "Household", description: "", instructions: "", files: [{ id: "f1", name: "notes.docx", content }], created: 0, updated: 0 };
    const sys = buildSystemPrompt({ project, knowledgeChars: knowledgeBudget(NCTX), contextTokens: NCTX, conversationTokens: promptTokens([{ role: "user", content: "سنة الغرفة" }]) });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-retr-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    // the rewrite answers, but with words found nowhere in the files
    const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "1" }, { starts: REWRITE_SYS, reply: "zqxv wqpt" }], "A plain answer.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: file, settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-rw0", ENTRY.id, MSGS(sys, "سنة الغرفة"), { effort: null, subagents: false, projectId: "p-1", knowledge: [{ id: "f1", name: "notes.docx", content }] });
    const steps = readJournal(file).entries.filter((e) => e.type === "step") as { id: string; input?: { rewrite?: string | null } }[];
    expect(steps.find((x) => x.id.endsWith(":know"))?.input?.rewrite).toBe("titles");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("REGRESSION: what the record says was picked is what rode; a section that did not fit is listed among the other sections", async () => {
    const budget = knowledgeBudget(NCTX);
    const big = (name: string) => `# ${name}\n${`The ${name.toLowerCase()} schedule repeats every week for the team. `.repeat(Math.ceil((budget * 0.45) / 60))}`;
    const content = ["Alpha", "Bravo", "Charlie", "Delta"].map(big).join("\n");
    const project: Project = { id: "p-1", name: "Ops", description: "", instructions: "", files: [{ id: "f1", name: "plan.docx", content }], created: 0, updated: 0 };
    const sys = buildSystemPrompt({ project, knowledgeChars: budget, contextTokens: NCTX, conversationTokens: promptTokens([{ role: "user", content: "team schedule week" }]) });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-retr-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "1, 2, 3, 4" }, { starts: REWRITE_SYS, reply: "" }], "A plain answer.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: file, settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-pk0", ENTRY.id, MSGS(sys, "team schedule week"), { effort: null, subagents: false, projectId: "p-1", knowledge: [{ id: "f1", name: "plan.docx", content }] });
    const steps = readJournal(file).entries.filter((e) => e.type === "step") as { id: string; input?: { picked?: number[] | string } }[];
    const picked = steps.find((x) => x.id.endsWith(":know"))?.input?.picked as number[];
    const sent = sysOf(bodies[bodies.length - 1]);
    // the packed sections carry a file attribute (the citation instruction's own example does not)
    const rode = (sent.match(/<section source="\d+" file=/g) ?? []).length;
    expect(Array.isArray(picked)).toBe(true);
    expect(picked.length).toBe(rode);
    expect(rode).toBeLessThan(4);
    expect(sent).toMatch(/Other sections in the files/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("REGRESSION (know-en-02 as recorded): the locator names one small section — the rest of the knowledge budget still fills from the BM25 order", async () => {
    // four pages match, the locator names only the second; the code sent that one
    // section alone (166 characters as recorded) instead of filling the budget
    const content = [
      ...Array.from({ length: 149 }, (_, i) => `[page ${i + 1}]\nPage ${i + 1} talks about topic ${i}.`),
      `[page 150]\nALPHA the xylophone budget line. ${"budget detail. ".repeat(31)}`,
      `[page 151]\nBETA the xylophone vendors list. ${"vendors detail. ".repeat(31)}`,
      `[page 152]\nGAMMA the xylophone maintenance plan. ${"maintenance detail. ".repeat(31)}`,
      `[page 153]\nDELTA the xylophone delivery plan. ${"delivery detail. ".repeat(31)}`,
      ...Array.from({ length: 46 }, (_, i) => `[page ${i + 154}]\nPage ${i + 154} talks about topic ${i + 154}.`),
    ].join("\n");
    const sys = packedSystem(content);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-retr-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [{ starts: LOCATOR_SYS, reply: "2" }], "The vendors list.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: file, settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-10", ENTRY.id, MSGS(sys, "What do the files say about the xylophone budget, vendors, maintenance and delivery?"), OPTS(content));
    const answerReq = bodies.filter((b) => sysOf(b).includes("Project knowledge")).at(-1)!;
    const texts = textsOf(answerReq);
    expect(texts).toContain("BETA"); // the locator's pick rides
    expect(texts).toContain("ALPHA"); // and the BM25 order fills the budget around it
    const at = (w: string) => texts.indexOf(w);
    expect(at("BETA")).toBeLessThan(at("ALPHA")); // the locator's picks ride first
    const steps = readJournal(file).entries.filter((e) => e.type === "step") as { id: string; input?: { blockChars?: number } }[];
    const know = steps.find((s) => s.id.endsWith(":know"));
    // the block is filled close to the budget (never one tiny section alone)
    expect(know?.input?.blockChars ?? 0).toBeGreaterThan(knowledgeBudget(NCTX) / 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("summarising the whole document goes map-reduce over the sections, journaled, and the summary rides in the block", async () => {
    const content = longPdf(true);
    const sys = packedSystem(content);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-retr-"));
    const file = path.join(dir, "turn.jsonl");
    const events: ChatEvent[] = [];
    const bodies: Body[] = [];
    const fetchFn = scriptedFetch(bodies, [
      { starts: LOCATOR_SYS, reply: "all" },
      { starts: REWRITE_SYS, reply: "overview summary" },
      { starts: PART_SYS, reply: "Part summary: the yearly planning details, one part of the report." },
      { starts: REDUCE_SYS, reply: "Whole document: a yearly report; the xylophone budget is 1997 dinars." },
    ], "Here is the summary.");
    vi.stubGlobal("fetch", fetchFn);
    await runChatOrchestrator(fakeHost({ events, journalFile: file, settings: baseSettings(), fetchFn, knowledgeDir: dir }), "t-8", ENTRY.id, MSGS(sys, "Summarise the whole document."), OPTS(content));
    const answerReq = bodies.filter((b) => ![LOCATOR_SYS, REWRITE_SYS, PART_SYS, REDUCE_SYS].some((p) => sysOf(b).startsWith(p))).at(-1)!;
    const texts = textsOf(answerReq);
    expect(texts).toContain("Whole document: a yearly report");
    // the map-reduce is journaled: the parts and the reduce are steps of the turn's run
    const steps = readJournal(file).entries.filter((e) => e.type === "step") as { id: string; status: string }[];
    expect(steps.filter((s) => s.id.includes(":docsum") && s.status === "ok").length).toBeGreaterThanOrEqual(2);
    expect(steps.some((s) => s.id.endsWith(":docreduce") && s.status === "ok")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- the cross-language cases through the real path
//
// The frozen know-cross cases (tests/fixtures/evals/knowledge.json) scored through
// the REAL orchestrator path — merge → locator → pack, the rewrite seam included —
// not only through the machinery's BM25 top-4 that tests/evals.test.ts scores. The
// recorded real 4b runs lost all six: the
// rewrite model wrote the question's script (or garbage), because the rewrite was
// never told which files are written in which script, and the crossing itself was
// computed over the corpus's MAJORITY script — an English question over a
// mostly-English project with one Arabic file was not a crossing at all (the
// recorded cases earned their rewrite only through the weak-coverage gate, riding
// cov 0.27/0.14/0.13 against the 0.3 floor). The two assertions that fail on the
// old code: the rewrite request names each file's script, and the :know step
// records the crossing per file. The ride assertions pin the seam behind the
// rewrite: when the rewrite does write the files' words, the fact's section rides.

interface KnowledgeCase { id: string; question: string; fact: string; searchWords?: string; crossLanguage?: boolean }
const knowledgeDataset: { ocr: { file: string; pages: string[] }[]; cases: KnowledgeCase[] } =
  JSON.parse(fs.readFileSync(path.join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "evals", "knowledge.json"), "utf8"));
const CROSS_CASES = knowledgeDataset.cases.filter((c) => c.crossLanguage && c.searchWords);

/** The six fixture files as the app reads them: the real extractors, the frozen OCR words (loaded once). */
let corpusCache: { id: string; name: string; content: string }[] | null = null;
async function evalCorpus(): Promise<{ id: string; name: string; content: string }[]> {
  if (corpusCache) return corpusCache;
  const dir = path.join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "knowledge");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjsDoc = async (bytes: Uint8Array) => pdfjs.getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false }).promise;
  const bytesOf = (name: string): Uint8Array => {
    const buf = fs.readFileSync(path.join(dir, name));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  };
  const ocrPages = knowledgeDataset.ocr[0].pages;
  const files: { id: string; name: string; content: string }[] = [];
  for (const [name, withOcr] of [["handbook-en.pdf", false], ["dalil-ar.pdf", false], ["scanned-notices.pdf", true]] as const) {
    const doc = await pdfjsDoc(bytesOf(name));
    files.push({ id: name, name, content: await extractPdfText(doc as never, 2_000_000, withOcr ? { ocr: async (n: number) => ocrPages[n - 1] ?? "" } : undefined) });
  }
  for (const [name, kind] of [["staff-handbook.docx", "docx"], ["equipment.xlsx", "xlsx"], ["renovation-plan.pptx", "pptx"]] as const) {
    files.push({ id: name, name, content: await readOffice(kind, fs.readFileSync(path.join(dir, name))) });
  }
  corpusCache = files;
  return files;
}

describe("the cross-language cases through the real retrieval path", () => {
  it("all six recorded know-cross cases: the rewrite is asked of the model, the request names each file's script, and when the rewrite writes the files' words the fact's section rides", async () => {
    const corpus = await evalCorpus();
    const project: Project = {
      id: "p-x", name: "Library", description: "", instructions: "",
      files: corpus.map((f) => ({ id: f.id, name: f.name, content: f.content })),
      created: 0, updated: 0,
    };
    const sys = buildSystemPrompt({ project, knowledgeChars: knowledgeBudget(NCTX), contextTokens: NCTX, conversationTokens: promptTokens([{ role: "user", content: "سؤال" }]) });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "know-cross-"));
    try {
      const missed: string[] = [];
      for (const c of CROSS_CASES) {
        const file = path.join(dir, `${c.id}.jsonl`);
        const events: ChatEvent[] = [];
        const bodies: Body[] = [];
        // the ideal rewrite (the pinned search words stand for what a rewrite that
        // names the files' scripts writes); the locator picks the fact's own line
        // of the outline it is shown — the request is parsed, so the pick is the
        // fact's real outline number whatever the shortlist turned out to be
        // the marker names the fact's own line of the locator's outline; the outline
        // shows only a section's first 90 characters, so the two English-fact cases
        // whose chapter mark pushes the fact past the cut use a shorter marker that
        // sits inside the shown text
        const marker = c.id === "know-cross-06" ? "Projector" : c.id === "know-cross-04" ? "maker space" : c.id === "know-cross-05" ? "archive room keeps a constant" : c.fact;
        let outlineMissed = false;
        const fetchFn = vi.fn(async (_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const body = JSON.parse(String(init?.body)) as Body;
          bodies.push(body);
          const sysp = sysOf(body);
          if (sysp.startsWith(REWRITE_SYS)) return sse(c.searchWords!);
          if (sysp.startsWith(LOCATOR_SYS)) {
            const outline = textsOf(body).split("\n").filter((l) => /^\d+\. /.test(l));
            const line = outline.find((l) => l.includes(marker));
            if (!line) { outlineMissed = true; return sse("none"); }
            return sse(line.match(/^(\d+)\./)![1]);
          }
          return sse("A plain answer.");
        });
        vi.stubGlobal("fetch", fetchFn);
        await runChatOrchestrator(fakeHost({ events, journalFile: file, settings: baseSettings(), fetchFn, knowledgeDir: dir }), `x-${c.id}`, ENTRY.id, MSGS(sys, c.question), { effort: null, subagents: false, projectId: "p-x", knowledge: corpus });
        // the rewrite was asked of the model (the scripts cross, per file)
        const rewriteReq = bodies.find((b) => sysOf(b).startsWith(REWRITE_SYS));
        if (!rewriteReq) { missed.push(`${c.id}: no rewrite asked`); continue; }
        // THE FAILING-ON-OLD-CODE ASSERTION: the request tells the model which script
        // each file is written in — the recorded real rewrites wrote the question's
        // script because the files' scripts were never named
        const filesLine = textsOf(rewriteReq).match(/Files: (.*)/) ?? [];
        if (outlineMissed) { missed.push(`${c.id}: the fact's section is missing from the locator's outline`); continue; }
        if (!filesLine[1]?.includes("dalil-ar.pdf (Arabic script)") || !filesLine[1]?.includes("handbook-en.pdf (Latin script)")) {
          missed.push(`${c.id}: the rewrite request does not name the files' scripts: ${filesLine[1] ?? "(none)"}`);
          continue;
        }
        // the fact's section rides in the answer's request (merge → locator → pack)
        const answerReq = bodies.filter((b) => sysOf(b).includes("Project knowledge")).at(-1);
        if (!answerReq || !textsOf(answerReq).includes(c.fact)) { missed.push(`${c.id}: the fact's section did not ride`); continue; }
        // the record says the crossing was seen and the rewrite rode
        const steps = readJournal(file).entries.filter((e) => e.type === "step") as { id: string; input?: { rewritten?: boolean; rewrite?: string | null; crossLanguage?: boolean } }[];
        const know = steps.find((s) => s.id.endsWith(":know"));
        if (know?.input?.rewritten !== true || know?.input?.rewrite !== "model") { missed.push(`${c.id}: the step does not record the model rewrite`); continue; }
        // FAILS ON THE OLD CODE for know-cross-01..03: the crossing was read on the
        // corpus's majority script (English), so an English question over a
        // mostly-English project with one Arabic file was not a crossing at all
        if (know?.input?.crossLanguage !== true) { missed.push(`${c.id}: the step does not record the crossing`); continue; }
        fs.rmSync(file, { force: true });
      }
      expect(missed.join("; ")).toBe("");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
