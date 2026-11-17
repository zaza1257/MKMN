import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRun, type RunHooks, type StepDef } from "../src/core/harness/run";
import { settle } from "../src/core/harness/settle";
import { identityGuardStep } from "../src/core/harness/identity";
import { sString } from "../src/core/harness/schema";
import type { SettledStep } from "../src/core/harness/run";

/**
 * The run's end is settle()'s, and the hooks see every step first: the identity
 * guard rides by default on every answer, a caller's hook runs after it, and the
 * journal holds the delivered text.
 */

const ok = (id: string, output: unknown = "fine"): StepDef<unknown, unknown> => ({
  id, kind: "model-call", input: {}, schema: sString(), exec: () => output,
});

describe("settle: the run's verdict, in one place", () => {
  it("every step ok is done", () => {
    expect(settle({ steps: [{ status: "ok" }, { status: "ok" }] as SettledStep[] })).toEqual({ event: "verdict_ok", state: "done" });
  });
  it("a hard-failed step ends the run failed and names it", () => {
    const o = settle({ steps: [{ status: "ok" }, { status: "failed", id: "write", error: "write: the validator refused" }] as unknown as SettledStep[] });
    expect(o.state).toBe("failed");
    expect(o.event).toBe("verdict_error");
    expect(o.error).toContain("write");
  });
  it("a spent retry budget or an interruption leaves the run unresolved", () => {
    expect(settle({ steps: [{ status: "retry_exhausted", id: "plan" }] as unknown as SettledStep[] }).state).toBe("unresolved");
    expect(settle({ steps: [{ status: "interrupted", id: "plan" }] as unknown as SettledStep[] }).state).toBe("unresolved");
  });
  it("a cancellation outranks the steps: the run ends cancelled", () => {
    const o = settle({ steps: [{ status: "ok" }] as SettledStep[], cancelled: "the person stopped it" });
    expect(o).toEqual({ event: "cancel", state: "cancelled", error: "the person stopped it" });
  });
  it("a stop gate that said stop leaves the run unresolved, one that passed does not", () => {
    const gate = (output: unknown): SettledStep => ({ status: "ok", kind: "stop-gate", id: "gate", output } as unknown as SettledStep);
    const steps = [{ status: "ok", kind: "model-call", id: "work" }, gate(false)] as unknown as SettledStep[];
    const stopped = settle({ steps });
    expect(stopped.state).toBe("unresolved");
    expect(stopped.error).toContain("gate");
    const passed = settle({ steps: [gate(true)] as SettledStep[] });
    expect(passed.state).toBe("done");
  });
  it("a gate that is not passed holds the run at unresolved even with every step ok, and names its reason", () => {
    const o = settle({ steps: [{ status: "ok" }, { status: "ok" }] as SettledStep[], gates: [{ name: "test-run", ok: false, reason: "the test run still shows a problem" }] });
    expect(o.state).toBe("unresolved");
    expect(o.error).toContain("test-run");
    expect(o.error).toContain("the test run still shows a problem");
    const clean = settle({ steps: [{ status: "ok" }] as SettledStep[], gates: [{ name: "test-run", ok: true }, { name: "files", ok: true }] });
    expect(clean.state).toBe("done");
  });
  it("the first not-passed gate decides; passed gates before it do not", () => {
    const o = settle({
      steps: [{ status: "ok" }] as SettledStep[],
      gates: [
        { name: "test-run", ok: true },
        { name: "files", ok: false, reason: "a file could not be made" },
        { name: "calls", ok: false, reason: "a model call failed" },
      ],
    });
    expect(o.state).toBe("unresolved");
    expect(o.error).toContain("files");
    expect(o.error).not.toContain("a model call failed");
  });
  it("a gate fires after the stop gates and the steps: a failed step is still a failed run", () => {
    const o = settle({
      steps: [{ status: "failed", id: "write", error: "boom" }] as unknown as SettledStep[],
      gates: [{ name: "test-run", ok: false, reason: "problems" }],
    });
    expect(o.state).toBe("failed");
    const stopped = settle({
      steps: [{ status: "ok", kind: "stop-gate", id: "gate", output: false }] as unknown as SettledStep[],
      gates: [{ name: "test-run", ok: false, reason: "problems" }],
    });
    expect(stopped.state).toBe("unresolved");
    expect(stopped.error).toContain("stop gate");
    // and a cancellation outranks every gate
    const cancelled = settle({ steps: [{ status: "ok" }] as SettledStep[], cancelled: "the person stopped it", gates: [{ name: "test-run", ok: false, reason: "problems" }] });
    expect(cancelled.state).toBe("cancelled");
  });
});

describe("the run's hooks", () => {
  it("the identity guard rides by default: a step's reply that names another model is corrected before it is journaled or yielded", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mkmn-settle-"));
    try {
      const file = path.join(dir, "run.jsonl");
      const defs = [ok("greet", undefined)];
      defs[0].exec = () => ({ output: "hello", reply: "I am Qwen, made by Alibaba. Nice to meet you." });
      const run = createRun(defs, { pipeline: "test", journalFile: file });
      const steps = [];
      for await (const s of run) steps.push(s);
      expect(run.state).toBe("done");
      expect(steps[0].reply).toBe("I am MKMN AI. Nice to meet you.");
      const journal = readFileSync(file, "utf8");
      expect(journal).toContain("I am MKMN AI.");
      expect(journal).not.toContain("Qwen");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a caller's hook runs after the identity guard and can rewrite the record", async () => {
    const seen: string[] = [];
    const hooks: RunHooks = {
      afterStep(step) {
        seen.push(step.reply ?? "");
        return { ...step, reply: "rewritten" };
      },
    };
    const defs = [ok("s", undefined)];
    defs[0].exec = () => ({ output: "x", reply: "I am Qwen." });
    const run = createRun(defs, { pipeline: "test", journalFile: null, hooks });
    for await (const s of run) expect(s.reply).toBe("rewritten");
    expect(seen).toEqual(["I am MKMN AI."]); // the guard ran first
  });

  it("a failed step's error text is never rewritten: it names the fault as the app wrote it", async () => {
    const defs: StepDef<unknown, unknown>[] = [{
      id: "broken", kind: "model-call", input: {}, schema: sString(),
      validators: [{ name: "no", check: () => ({ verdict: "fail", reason: "Qwen is not what this is" }) }],
      exec: () => "x",
    }];
    const run = createRun(defs, { pipeline: "test", journalFile: null });
    const steps = [];
    for await (const s of run) steps.push(s);
    expect(run.state).toBe("failed");
    expect(steps[0].error).toContain("Qwen is not what this is"); // the fault is named, not guarded away
  });
});

describe("the identity guard hook on its own", () => {
  it("guards an ok step's string output and reply, and leaves a failed step and non-string outputs alone", () => {
    expect(identityGuardStep({ status: "ok", reply: "I'm Qwen.", output: "I am Qwen, made by Meta." }).output).toBe("I am MKMN AI.");
    const untouched = { status: "failed", reply: "I am Qwen.", error: "e" };
    expect(identityGuardStep(untouched)).toBe(untouched); // the same object: nothing touched
    const obj = { status: "ok", output: { who: "I am Qwen." } };
    expect(identityGuardStep(obj).output).toEqual({ who: "I am Qwen." }); // a typed object is the pipeline's business, not the guard's
  });
});
