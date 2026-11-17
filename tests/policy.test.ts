import { describe, expect, it } from "vitest";
import { DEFAULT_TURN_BUDGET, turnBudget, turnBudgetOfSettings } from "../src/core/harness/policy";
import { openTurnBudget, closeTurnBudget, turnBudgetOf, chargeTurnPrepare } from "../src/core/harness/turn";
import { createLiveRun } from "../src/core/harness/run";
import { settle } from "../src/core/harness/settle";
import { sString } from "../src/core/harness/schema";

/**
 * The policy layer: the app's runtime rules in one place, the
 * layer the gateway (call time) and settle() (verdict time) consult. The turn's
 * budget cap is its first rule — moved here from the turn account, which now
 * consults it at open. The verdict rule is its second: a run the policy stopped
 * (the budget refused a further call) settles unresolved with the cause named —
 * never `done`, and never `cancelled` (that is the person's stop, not the app's).
 */

describe("the policy layer owns the turn budget", () => {
  it("the measured cap lives here, and the accessor hands out a copy", () => {
    expect(DEFAULT_TURN_BUDGET.maxCalls).toBe(120);
    expect(DEFAULT_TURN_BUDGET.maxOutputTokens).toBe(100_000);
    const b = turnBudget();
    expect(b).toEqual(DEFAULT_TURN_BUDGET);
    b.maxCalls = 1; // a caller cannot mutate the rule for everyone else
    expect(turnBudget().maxCalls).toBe(120);
  });

  it("the turn account consults the policy when opened without explicit limits", () => {
    openTurnBudget("p1");
    try {
      const b = turnBudgetOf("p1");
      expect(b?.limits).toEqual({ maxCalls: 120, maxOutputTokens: 100_000 });
      // the cap the account enforces IS the policy's: charged to it, the next call is refused
      for (let i = 0; i < DEFAULT_TURN_BUDGET.maxCalls; i++) expect(chargeTurnPrepare(b!)).toBeNull();
      expect(chargeTurnPrepare(b!)).toBe("calls");
    } finally {
      closeTurnBudget("p1");
    }
  });

  it("the Settings row tunes the cap; a bad saved pair never disables the guard", () => {
    // a sane saved pair is honored (floored to whole calls/tokens)
    expect(turnBudgetOfSettings({ turnBudget: { maxCalls: 60, maxOutputTokens: 50_000 } })).toEqual({ maxCalls: 60, maxOutputTokens: 50_000 });
    expect(turnBudgetOfSettings({ turnBudget: { maxCalls: 7.9, maxOutputTokens: 100.5 } })).toEqual({ maxCalls: 7, maxOutputTokens: 100 });
    // unset, null, or a value that would break the guard: the measured default stands
    expect(turnBudgetOfSettings({})).toEqual(DEFAULT_TURN_BUDGET);
    expect(turnBudgetOfSettings(null)).toEqual(DEFAULT_TURN_BUDGET);
    expect(turnBudgetOfSettings({ turnBudget: null })).toEqual(DEFAULT_TURN_BUDGET);
    expect(turnBudgetOfSettings({ turnBudget: { maxCalls: 0, maxOutputTokens: 50_000 } })).toEqual(DEFAULT_TURN_BUDGET);
    expect(turnBudgetOfSettings({ turnBudget: { maxCalls: -5, maxOutputTokens: 50_000 } })).toEqual(DEFAULT_TURN_BUDGET);
    expect(turnBudgetOfSettings({ turnBudget: { maxCalls: Number.POSITIVE_INFINITY, maxOutputTokens: 50_000 } })).toEqual(DEFAULT_TURN_BUDGET);
    expect(turnBudgetOfSettings({ turnBudget: { maxCalls: 60, maxOutputTokens: "many" as unknown as number } })).toEqual(DEFAULT_TURN_BUDGET);
    // a copy each call: mutating one result never edits the saved rule
    const tuned = turnBudgetOfSettings({ turnBudget: { maxCalls: 60, maxOutputTokens: 50_000 } });
    tuned.maxCalls = 1;
    expect(turnBudgetOfSettings({ turnBudget: { maxCalls: 60, maxOutputTokens: 50_000 } }).maxCalls).toBe(60);
  });
});

describe("settle() consults the policy at verdict time: a stop by the app's rule is not a cancel and not a pass", () => {
  it("a run the policy stopped settles unresolved with the cause named — even though every step that ran is ok", async () => {
    const run = createLiveRun({ pipeline: "chat", runId: "p2", journalFile: null });
    await run.step({ id: "p2", kind: "model-call", input: "p2", schema: sString(), exec: () => "the answer so far" });
    // a further call is refused by the turn's budget before it is sent: the run ends by policy
    const outcome = run.finish("this turn reached its model-call budget (120 calls)", "this turn reached its model-call budget (120 calls)");
    expect(outcome.state).toBe("unresolved");
    expect(outcome.event).toBe("verdict_problems");
    expect(outcome.error).toContain("model-call budget");
  });

  it("the same run without the policy stop reads as the person's cancel — the contrast", async () => {
    const run = createLiveRun({ pipeline: "chat", runId: "p3", journalFile: null });
    await run.step({ id: "p3", kind: "model-call", input: "p3", schema: sString(), exec: () => "the answer so far" });
    const outcome = run.finish("the turn was stopped");
    expect(outcome.state).toBe("cancelled");
  });

  it("settle() directly: the policy stop outranks a step fault read (the refused call is the stop, not a failure), and the person's cancel outranks the policy", () => {
    const step = (seq: number, status: "ok" | "failed", error?: string) => ({
      type: "step" as const, runId: "p4", seq, id: `call-${seq}`, kind: "model-call" as const, status,
      startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z", seconds: 1,
      attempts: 1, outputRetriesUsed: 0, transportRetriesUsed: 0, validations: [],
      tokens: { prompt: 0, output: 0, measured: false }, ...(error ? { error } : {}),
    });
    // the refused call settles failed with the budget message; the policy stop decides the verdict
    const stopped = settle({ steps: [step(0, "ok"), step(1, "failed", "this turn reached its model-call budget (120 calls)")], stoppedBy: "this turn reached its model-call budget (120 calls)" });
    expect(stopped.state).toBe("unresolved");
    expect(stopped.error).toContain("model-call budget");
    // the person's stop outranks the policy (they pressed stop): cancelled
    const person = settle({ steps: [step(0, "ok")], cancelled: "the turn was stopped", stoppedBy: "this turn reached its model-call budget (120 calls)" });
    expect(person.state).toBe("cancelled");
  });
});
