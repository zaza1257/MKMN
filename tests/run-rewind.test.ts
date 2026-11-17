import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createLiveRun } from "../src/core/harness/run";
import { readJournal, resumeReplay } from "../src/core/harness/journal";
import { sString } from "../src/core/harness/schema";

/**
 * The person's skip / go-back-a-step press becomes a journal fact:
 * while a step of a run is in flight, the press is appended as a rewind entry naming
 * the step it landed on, and settle() reads the EFFECTIVE steps — the ones the press
 * threw away do not decide the verdict; the redo's steps do. The journal stays
 * append-only: the superseded step stays in the file, the rewind entry says how to
 * read it.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mkmn-run-rewind-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a run records the person's skip/back press", () => {
  it("rewind appends a rewind entry naming the step it landed on (the one in flight)", async () => {
    const file = path.join(dir, "r1.jsonl");
    const run = createLiveRun({ pipeline: "build", runId: "r1", journalFile: file });
    const first = run.step({ id: "call-1", kind: "model-call", input: "a", schema: sString(), exec: () => "one" });
    await first;
    // the second step hangs in flight while the person presses go-back-a-step:
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const second = run.step({ id: "call-2", kind: "model-call", input: "b", schema: sString(), exec: async () => { await gate; return "two"; } });
    run.rewind("back", "the person pressed go back a step");
    release();
    await second;
    run.finish();
    const { entries } = readJournal(file);
    const rewinds = entries.filter((e) => e.type === "rewind");
    expect(rewinds).toHaveLength(1);
    const r = rewinds[0] as { type: "rewind"; runId: string; seq: number; action: string; reason: string; at: string };
    expect(r.runId).toBe("r1");
    expect(r.action).toBe("back");
    expect(r.reason).toBe("the person pressed go back a step");
    expect(r.seq).toBe(1); // the step in flight when the press landed (seqs count from 0)
    expect(r.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("a press between steps lands on the last issued step and supersedes nothing", async () => {
    const file = path.join(dir, "r2.jsonl");
    const run = createLiveRun({ pipeline: "build", runId: "r2", journalFile: file });
    await run.step({ id: "call-1", kind: "model-call", input: "a", schema: sString(), exec: () => "one" });
    run.rewind("skip", "the person pressed skip this step"); // nothing is in flight here
    await run.step({ id: "call-2", kind: "model-call", input: "b", schema: sString(), exec: () => "two" });
    const outcome = run.finish();
    expect(outcome.state).toBe("done");
    const rewinds = readJournal(file).entries.filter((e) => e.type === "rewind");
    expect(rewinds).toHaveLength(1);
    expect((rewinds[0] as { seq: number }).seq).toBe(0); // the last issued step (seqs count from 0)
  });

  it("settle() reads the effective steps: the step the press threw away does not fail the verdict — without the press it still does", async () => {
    const file = path.join(dir, "r3.jsonl");
    const run = createLiveRun({ pipeline: "build", runId: "r3", journalFile: file });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const abandoned = run.step({ id: "call-1", kind: "model-call", input: "a", schema: sString(), exec: async () => { await gate; throw new Error("the model server is gone"); } });
    run.rewind("back", "the person pressed go back a step"); // the press lands while the call is in flight
    release();
    await abandoned.catch(() => undefined); // the call failed; the build threw its work away
    await run.step({ id: "call-1-again", kind: "model-call", input: "a", schema: sString(), exec: () => "the redo" }); // the redo settles ok
    const outcome = run.finish();
    expect(outcome.state).toBe("done"); // the redo stands, the abandoned failure does not decide
    expect(outcome.error).toBeUndefined();
  });

  it("the same shape without a press still ends failed: only a recorded press supersedes", async () => {
    const file = path.join(dir, "r4.jsonl");
    const run = createLiveRun({ pipeline: "build", runId: "r4", journalFile: file });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const failed = run.step({ id: "call-1", kind: "model-call", input: "a", schema: sString(), exec: async () => { await gate; throw new Error("the model server is gone"); } });
    release();
    await failed.catch(() => undefined);
    await run.step({ id: "call-1-again", kind: "model-call", input: "a", schema: sString(), exec: () => "the redo" });
    const outcome = run.finish();
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("the model server is gone");
  });

  it("resumeReplay ignores rewind entries: they name no step and leave nothing dangling", async () => {
    const file = path.join(dir, "r5.jsonl");
    const run = createLiveRun({ pipeline: "build", runId: "r5", journalFile: file });
    await run.step({ id: "call-1", kind: "model-call", input: "a", schema: sString(), exec: () => "one" });
    run.rewind("back", "the person pressed go back a step");
    run.finish();
    const replay = resumeReplay(file);
    expect(replay.settled).toHaveLength(1);
    expect(replay.dangling).toHaveLength(0);
  });
});
