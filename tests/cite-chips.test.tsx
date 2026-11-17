// @vitest-environment jsdom
/**
 * Citations on the screen: a [source N] marker in the answer
 * renders as a chip; the Sources line the orchestrator appended renders as its
 * own row, not as a paragraph; clicking a chip shows what the source is.
 * The markdown parser itself is unchanged — the chips are the renderer's read
 * of the same text.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";

beforeEach(() => {
  (window as any).matchMedia = (q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
  (window as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

afterEach(cleanup);

import { Markdown } from "../src/renderer/Markdown";

describe("citation chips on the screen", () => {
  it("a [source N] marker renders as a chip, not as bare text", () => {
    const { container } = render(createElement(Markdown, { text: "The budget is 1997 dinars [source 1]. Done." }));
    const chip = container.querySelector(".cite-chip");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe("1");
  });

  it("the Sources line renders as a sources row, not a paragraph, and a chip click names its source", () => {
    const text = "The budget is 1997 dinars [source 1].\n\nSources: [1] report.pdf (p. 150)";
    const { container } = render(createElement(Markdown, { text }));
    expect(container.querySelector(".sources-row")).not.toBeNull();
    expect(container.querySelector(".sources-row")!.textContent).toContain("report.pdf (p. 150)");
    // the Sources line is not left in the body as plain text
    expect(container.textContent).not.toMatch(/Sources: \[1\]/);
    // clicking the chip names the section
    fireEvent.click(container.querySelector(".cite-chip")!);
    expect(screen.getByText(/Source 1 — report\.pdf \(p\. 150\)/)).toBeTruthy();
  });

  it("an invented source has no entry in the Sources line: the chip still shows its number", () => {
    // the orchestrator drops invented markers; the renderer only ever sees what survived,
    // but a message pasted from elsewhere can carry a stray marker — it must not crash
    const { container } = render(createElement(Markdown, { text: "Said [source 7].\n\nSources: [1] report.pdf (p. 150)" }));
    const chip = container.querySelector(".cite-chip");
    expect(chip!.textContent).toBe("7");
    fireEvent.click(chip!);
    expect(screen.getByText("Source 7")).toBeTruthy();
  });
});
