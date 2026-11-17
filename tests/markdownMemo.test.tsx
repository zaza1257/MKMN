// @vitest-environment jsdom
/**
 * While an answer streams, the chat re-renders on every animation frame, and every
 * Markdown on the screen used to pay for a full re-parse of its whole text each time.
 * Two guards hold this down:
 *  - the parse runs once per distinct text (a re-render with the same text parses nothing);
 *  - a block's signature is stable while the block is unchanged, so the memoized blocks
 *    skip re-rendering and only the last block of a growing answer does any work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";

const parses = vi.hoisted(() => ({ n: 0 }));
vi.mock("../src/core/markdown", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/core/markdown")>();
  return { ...mod, parseMarkdown: (text: string) => { parses.n++; return mod.parseMarkdown(text); } };
});

import { Markdown, blockSignature } from "../src/renderer/Markdown";
import { parseMarkdown } from "../src/core/markdown";

beforeEach(() => {
  (window as any).matchMedia = (q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
  (window as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

afterEach(cleanup);

describe("Markdown parse memo", () => {
  it("parses a text once, not again on every render of the same text", () => {
    const before = parses.n;
    const text = "# Heading\n\nA paragraph with **bold** words.\n\n```js\nlet x = 1\n```";
    const { rerender } = render(createElement(Markdown, { text, streaming: true }));
    expect(parses.n).toBe(before + 1);
    // re-renders with the same text (a streaming frame, a parent re-render) parse nothing
    rerender(createElement(Markdown, { text, streaming: true }));
    rerender(createElement(Markdown, { text, streaming: false }));
    expect(parses.n).toBe(before + 1);
    // new text parses once
    rerender(createElement(Markdown, { text: `${text}\n\nOne more paragraph.`, streaming: true }));
    expect(parses.n).toBe(before + 2);
  });
});

describe("blockSignature", () => {
  it("gives the same blocks the same signature and a changed block a different one", () => {
    const one = parseMarkdown("Intro paragraph\n\n```js\nlet x = 1\n```");
    const two = parseMarkdown("Intro paragraph\n\n```js\nlet x = 1\n```");
    expect(one.map(blockSignature)).toEqual(two.map(blockSignature));
  });

  it("keeps earlier blocks stable while the last block of a growing answer changes", () => {
    const a = parseMarkdown("Intro paragraph\n\nSome more words here.\n\nA half finished sentence");
    const b = parseMarkdown("Intro paragraph\n\nSome more words here.\n\nA half finished sentence that grew");
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length - 1; i++) expect(blockSignature(a[i])).toBe(blockSignature(b[i]));
    expect(blockSignature(a[a.length - 1])).not.toBe(blockSignature(b[b.length - 1]));
  });

  it("answers for the fields the screen shows: a code block's open state, language and text", () => {
    const closed = parseMarkdown("```js\nlet x = 1\n```")[0];
    expect(closed.t).toBe("code");
    expect(blockSignature({ ...closed, open: true })).not.toBe(blockSignature(closed));
    expect(blockSignature(parseMarkdown("```py\nlet x = 1\n```")[0])).not.toBe(blockSignature(closed));
    expect(blockSignature(parseMarkdown("```js\nlet x = 2\n```")[0])).not.toBe(blockSignature(closed));
  });
});
