// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { Tasks } from "../src/renderer/Tasks";

/**
 * The interval editor keeps the unit the person chose: typing 60 in minutes turned
 * the field into "1 hours", and switching 2 hours to minutes left hours selected.
 * And the "no model" warning only stands when a task really needs the selected
 * model: a task with its own model runs without one.
 */

afterEach(() => { cleanup(); });

const base = { projects: [], artifacts: [], models: [], onSave: async () => {}, onDelete: () => {}, onRun: () => {}, onOpenArtifact: () => {} };

function openIntervalEditor() {
  render(createElement(Tasks as any, { ...base, tasks: [], hasModel: true }));
  fireEvent.click(screen.getByRole("button", { name: /New task/ }));
  fireEvent.change(screen.getByDisplayValue("Every day"), { target: { value: "interval" } });
  const every = screen.getByText(/^Every$/, { selector: "label" }) as HTMLElement;
  return { num: every.querySelector("input") as HTMLInputElement, unit: every.querySelector("select") as HTMLSelectElement };
}

describe("the task interval editor", () => {
  it("typing 60 minutes stays 60 minutes", () => {
    const { num, unit } = openIntervalEditor();
    fireEvent.change(unit, { target: { value: "m" } });
    fireEvent.change(num, { target: { value: "60" } });
    expect(unit.value).toBe("m");
    expect(num.value).toBe("60");
  });

  it("switching hours to minutes selects minutes", () => {
    const { num, unit } = openIntervalEditor();
    fireEvent.change(unit, { target: { value: "h" } });
    fireEvent.change(num, { target: { value: "2" } });
    fireEvent.change(unit, { target: { value: "m" } });
    expect(unit.value).toBe("m");
  });
});

describe("the no-model warning", () => {
  it("is not shown when every task has its own model", () => {
    const own = { id: "t1", name: "Digest", prompt: "x", projectId: null, modelId: "q3", enabled: true, schedule: { kind: "daily", time: "08:00" }, runs: [] };
    render(createElement(Tasks as any, { ...base, tasks: [own], hasModel: false }));
    expect(screen.queryByText(/tasks cannot run yet/)).toBeNull();
  });
});
