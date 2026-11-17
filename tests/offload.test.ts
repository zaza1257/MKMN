import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { offloadThreshold, previewOf, offloadPayload, offloadSection, previewText, readBack, truncateForPrompt, openPlan } from "../src/core/harness/offload";
import { readJournal } from "../src/core/harness/journal";
import { sString } from "../src/core/harness/schema";
import { createLiveRun } from "../src/core/harness/run";

/**
 * The offload store: a step's large payload does not ride in the journal —
 * it goes to a file next to it, the record keeps the preview and the typed pointer
 * (a PromptSectionRef, names and sizes, never the text), and reading back is an
 * explicit, paged step. The plan of a run is a file the steps read and update; the
 * journal never holds its text.
 */

const LONG = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the payload, some words to give it length`).join("\n");

describe("the offload threshold", () => {
  it("grows with the window, an eighth of it, never below 2048 bytes", () => {
    expect(offloadThreshold(2048)).toBe(2048);
    expect(offloadThreshold(4096)).toBe(2048);
    expect(offloadThreshold(16384)).toBe(6144);
    expect(offloadThreshold(32768)).toBe(12288);
  });
});

describe("the preview", () => {
  it("keeps the first and the last lines, and counts what it does not show", () => {
    const p = previewOf(LONG);
    expect(p.head.split("\n")).toHaveLength(5);
    expect(p.head.split("\n")[0]).toBe("line 1 of the payload, some words to give it length");
    expect(p.tail.split("\n")).toHaveLength(5);
    expect(p.tail.split("\n")[4]).toBe("line 40 of the payload, some words to give it length");
    expect(p.lines).toBe(40);
    expect(p.cut).toBeGreaterThan(0);
  });
  it("a short payload rides whole: nothing is cut", () => {
    const p = previewOf("one\ntwo");
    expect(p.head).toBe("one\ntwo");
    expect(p.cut).toBe(0);
  });
});

describe("the store", () => {
  it("writes the payload once and returns the pointer; the preview text names the file and the sizes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offload-"));
    const ref = offloadPayload(dir, "c-turn-1-2:write:0", LONG);
    expect(ref.file).toBe("c-turn-1-2_write_0.txt"); // the name is safe for a file name
    expect(ref.bytes).toBe(Buffer.byteLength(LONG));
    expect(ref.lines).toBe(40);
    expect(fs.existsSync(path.join(dir, ref.file))).toBe(true);
    expect(fs.readFileSync(path.join(dir, ref.file), "utf8")).toBe(LONG);
    const shown = previewText(ref);
    expect(shown).toContain(ref.head);
    expect(shown).toContain(ref.tail);
    expect(shown).toContain(`${ref.file}`);
    expect(shown).not.toContain("line 20"); // the middle does not ride
    expect(offloadSection(ref)).toEqual({ name: `offload:${ref.file}`, bytes: ref.bytes });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("reading back", () => {
  it("is paged by offset and limit, and says when it is done", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offload-"));
    const ref = offloadPayload(dir, "payload", LONG);
    const file = path.join(dir, ref.file);
    const page1 = readBack(file, 0, 100);
    expect(page1.text).toBe(LONG.slice(0, 100));
    expect(page1.done).toBe(false);
    const page2 = readBack(file, page1.nextOffset, 100);
    expect(page2.text).toBe(LONG.slice(100, 200));
    const whole = readBack(file);
    expect(whole.done).toBe(true);
    expect(whole.text).toBe(LONG);
    expect(readBack(file, LONG.length + 50).text).toBe("");
    expect(readBack(path.join(dir, "nope.txt")).done).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("the marker truncation for a summary", () => {
  it("a short text rides whole; a long one is cut with a marker that says how much was cut", () => {
    expect(truncateForPrompt("short", 100)).toBe("short");
    const cut = truncateForPrompt(LONG, 120);
    expect(cut.startsWith(LONG.slice(0, 120))).toBe(true);
    expect(cut).toContain("truncated");
    expect(cut).toContain(`${LONG.length - 120} characters were cut`);
  });
});

describe("the plan of a run, as a file", () => {
  it("lives on disk; the journal pointer holds its name and size, never its text; updating rewrites it whole", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-"));
    const initial = "1. write the state\n2. write the views\n3. wire the keys";
    const plan = openPlan(dir, "c-turn-1-plan", initial);
    expect(plan.ref()).toEqual({ name: `plan:${path.basename(plan.file)}`, bytes: Buffer.byteLength(initial) });
    expect(fs.readFileSync(plan.file, "utf8")).toContain("wire the keys");
    // paged read, like any offloaded payload
    const page = plan.read(0, 10);
    expect(page.text).toBe("1. write t");
    expect(page.done).toBe(false);
    // the plan is updated by the steps that own it: the file and the pointer follow
    const before = plan.ref().bytes;
    const ref = plan.update("1. write the state\n2. write the views\n3. wire the keys\n4. test the scenarios");
    expect(ref.bytes).toBeGreaterThan(before);
    expect(fs.readFileSync(plan.file, "utf8")).toContain("test the scenarios");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("the kernel offloads a settled step's long reply", () => {
  it("a reply over the threshold is offloaded: the journal holds the preview and the pointer, never the whole text", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-offload-"));
    const file = path.join(dir, "turn.jsonl");
    const run = createLiveRun({ pipeline: "test", runId: "off-1", journalFile: file, offloadBytes: 200 });
    const rec = await run.step({
      id: "s:big", kind: "model-call", input: "m", schema: sString(), outputRetries: 0, transportRetries: 0,
      exec: () => ({ output: LONG, reply: LONG }),
    });
    run.finish();
    // the record the caller holds shows the preview and the pointer
    expect(rec.reply).toContain("offloaded to");
    expect(rec.reply!.length).toBeLessThan(LONG.length);
    expect(rec.promptSections?.some((p) => p.name.startsWith("offload:") && p.bytes === Buffer.byteLength(LONG))).toBe(true);
    // the journal line never carries the whole text
    const steps = readJournal(file).entries.filter((e) => e.type === "step") as { reply?: string; promptSections?: { name: string; bytes: number }[] }[];
    expect(steps).toHaveLength(1);
    expect(steps[0].reply!.includes("line 20")).toBe(false);
    expect(steps[0].promptSections?.some((p) => p.name.startsWith("offload:"))).toBe(true);
    // and the payload is on disk, next to the journal, whole
    const name = steps[0].promptSections!.find((p) => p.name.startsWith("offload:"))!.name.slice("offload:".length);
    expect(fs.readFileSync(path.join(dir, "offload", name), "utf8")).toBe(LONG);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a small reply, a failed step, and a run without a threshold ride exactly as before", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-offload-"));
    const file = path.join(dir, "turn.jsonl");
    const run = createLiveRun({ pipeline: "test", runId: "off-2", journalFile: file, offloadBytes: 200 });
    await run.step({ id: "s:small", kind: "model-call", input: "m", schema: sString(), outputRetries: 0, transportRetries: 0, exec: () => ({ output: "short", reply: "short" }) });
    await run.step({ id: "s:bad", kind: "model-call", input: "m", schema: sString(), outputRetries: 0, transportRetries: 0, exec: () => { throw new Error("gone"); } });
    run.finish();
    const steps = readJournal(file).entries.filter((e) => e.type === "step") as { id: string; reply?: string }[];
    expect(steps.find((s) => s.id === "s:small")!.reply).toBe("short");
    expect(steps.find((s) => s.id === "s:bad")!.reply).toBeUndefined();
    // no threshold: a long reply rides whole, as it always did
    const file2 = path.join(dir, "turn2.jsonl");
    const run2 = createLiveRun({ pipeline: "test", runId: "off-3", journalFile: file2 });
    await run2.step({ id: "s:big", kind: "model-call", input: "m", schema: sString(), outputRetries: 0, transportRetries: 0, exec: () => ({ output: LONG, reply: LONG }) });
    run2.finish();
    const steps2 = readJournal(file2).entries.filter((e) => e.type === "step") as { reply?: string }[];
    expect(steps2[0].reply).toBe(LONG);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
