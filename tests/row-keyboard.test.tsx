// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { readFileSync, readdirSync } from "node:fs";
import { rowAction } from "../src/renderer/rowAction";

/**
 * A row whose main action is a click must be reachable from the keyboard too. The
 * project cards, project chats, artifacts, the files and tasks beside a project and
 * the version list opened only with the mouse.
 */

afterEach(() => { cleanup(); });

describe("rowAction", () => {
  it("is focusable and opens with Enter or Space, but not from a button inside it", () => {
    const fn = vi.fn();
    const inner = vi.fn();
    const { container } = render(createElement("div", { ...rowAction(fn), "data-row": "1" }, createElement("button", { onClick: inner }, "Delete")));
    const row = container.querySelector("[data-row]") as HTMLElement;
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.getAttribute("role")).toBe("button");
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(fn).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(container.querySelector("button")!, { key: "Enter" });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("no mouse-only row is left in the renderer", () => {
  it("every clickable row opens from the keyboard (source scan)", () => {
    const bad: string[] = [];
    for (const name of readdirSync("src/renderer").filter((n) => n.endsWith(".tsx"))) {
      const lines = readFileSync(`src/renderer/${name}`, "utf8").split(/\r?\n/);
      lines.forEach((l, i) => {
        if (/<div[^>]*className=\{?[`"][^`"]*(clickable|ver-item)[^>]*onClick=/.test(l) && !/rowAction\(|onKeyDown=|tabIndex=/.test(l)) bad.push(`${name}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
