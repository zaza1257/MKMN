// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { Search } from "../src/renderer/Search";

/**
 * The search window:
 * - the project filter stays visible (and is obeyed) on every tab: it hid on the
 *   Projects and Tasks tabs while it emptied them;
 * - a task result opens THAT task (it opened the general list);
 * - Enter on a filter tab is the tab's own, not "open the highlighted result";
 * - the highlighted result is announced (listbox, option, active descendant).
 */

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => { cleanup(); });

const P1 = { id: "p1", name: "Alpha", description: "", instructions: "", files: [], created: 1, updated: 2 };
const P2 = { id: "p2", name: "Beta", description: "", instructions: "", files: [], created: 1, updated: 3 };
const TASK = { id: "t1", name: "Morning digest", prompt: "Summarize the news", projectId: "p1" } as any;
const OTHER = { id: "t2", name: "Weekly report", prompt: "Write the report", projectId: "p2" } as any;
const CONVS = [{ id: "c1", title: "A chat", updated: 5, projectId: "p1", turns: [{ role: "user", content: "hello" }] }] as any;

function open(over: Record<string, unknown> = {}) {
  const props = { convs: CONVS, projects: [P1, P2], artifacts: [], tasks: [TASK, OTHER], onChat: vi.fn(), onProject: vi.fn(), onArtifact: vi.fn(), onTasks: vi.fn(), onClose: vi.fn(), ...over };
  render(createElement(Search as any, props));
  return props;
}

describe("the search window", () => {
  it("keeps the project filter on the Tasks tab, and obeys it", () => {
    open();
    fireEvent.change(screen.getByLabelText("Only in project"), { target: { value: "p1" } });
    fireEvent.click(screen.getByRole("tab", { name: "Tasks" }));
    expect(screen.getByLabelText("Only in project")).toBeTruthy();
    expect(screen.queryByText("Morning digest")).toBeTruthy();
    expect(screen.queryByText("Weekly report")).toBeNull();
  });

  it("opens the task a result names", () => {
    const p = open();
    fireEvent.click(screen.getByRole("tab", { name: "Tasks" }));
    fireEvent.click(screen.getByText("Morning digest"));
    expect(p.onTasks).toHaveBeenCalledWith("t1");
  });

  it("Enter on a filter tab does not open a result", () => {
    const p = open();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Chats" }), { key: "Enter" });
    expect(p.onChat).not.toHaveBeenCalled();
  });

  it("announces the highlighted result", () => {
    open();
    const input = screen.getByRole("combobox", { name: "Search" });
    const list = screen.getByRole("listbox");
    const active = input.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    const option = list.querySelector(`#${CSS.escape(active!)}`);
    expect(option?.getAttribute("role")).toBe("option");
    expect(option?.getAttribute("aria-selected")).toBe("true");
  });
});
