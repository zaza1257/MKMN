// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { runItems } from "../src/core/workLog";
import { RunLedger } from "../src/renderer/WorkLog";
import type { RunView } from "../src/shared/types";

/**
 * The turn's run as the screen draws it: the harness's
 * settled steps become work items — what the stage cards do not name (a fold, a
 * locator pass, the reviewer's call) reads as work, a fault reads as a fault,
 * and a step stopped by the person says so instead of reading as a fault.
 */

const run = (steps: RunView["steps"]): RunView => ({
  runId: "chat-t-1", pipeline: "chat", steps,
  budget: { calls: steps.length, outputTokens: 12, maxCalls: 120, maxOutputTokens: 100_000 },
});

describe("the run's steps as work items", () => {
  it("each settled step reads as work with its seconds, faults read as faults", () => {
    const items = runItems(run([
      { seq: 0, kind: "model-call", status: "ok", seconds: 2.4, tokens: { prompt: 9, output: 3, measured: true } },
      { seq: 1, kind: "compact", status: "ok", seconds: 1.1, tokens: { prompt: 0, output: 0, measured: false } },
      { seq: 2, kind: "model-call", status: "failed", seconds: 0.2, tokens: { prompt: 0, output: 0, measured: false }, error: "the model server is gone" },
    ]));
    expect(items.map((i) => i.label)).toEqual(["Made a model call", "Summarized older messages", "Made a model call"]);
    expect(items.map((i) => i.state)).toEqual(["done", "done", "error"]);
    expect(items[0].sec).toBe(2);
    expect(items[2].note).toBe("the model server is gone");
  });

  it("a step stopped by the person says it was stopped, not that it failed; an unknown kind still reads", () => {
    const items = runItems(run([
      { seq: 0, kind: "model-call", status: "interrupted", seconds: 0, tokens: { prompt: 0, output: 0, measured: false } },
      { seq: 1, kind: "locator-pass", status: "ok", seconds: 0.4, tokens: { prompt: 0, output: 0, measured: false } },
    ]));
    expect(items[0].state).toBe("error");
    expect(items[0].note).toBe("Stopped before it finished.");
    expect(items[1].label).toBe("locator-pass"); // an unnamed kind is never made up
  });
});

describe("the run card on the screen", () => {
  it("the budget line and the verdict are there, and the step ledger is one click away", () => {
    const view: RunView = {
      runId: "chat-t-1", pipeline: "chat",
      steps: [
        { seq: 0, kind: "model-call", status: "ok", seconds: 2.4, tokens: { prompt: 9, output: 3, measured: true } },
        { seq: 1, kind: "model-call", status: "ok", seconds: 1.2, tokens: { prompt: 9, output: 3, measured: true } },
      ],
      budget: { calls: 2, outputTokens: 31_000, maxCalls: 120, maxOutputTokens: 100_000 },
      verdict: { state: "unresolved", error: "this turn reached its model-call budget (120 calls)" },
    };
    const { container } = render(createElement(RunLedger, { run: view, running: false }));
    try {
      expect(screen.getByText(/A rule of the app stopped the turn/).textContent).toContain("model-call budget");
      expect(container.textContent).toContain("2 of 120 model calls");
      expect(container.textContent).toContain("31,000 of 100,000 output tokens");
      // the ledger is one click away and names the steps
      fireEvent.click(container.querySelector("button.bp-head")!);
      expect(container.textContent).toContain("Made a model call");
    } finally { cleanup(); }
  });
});
