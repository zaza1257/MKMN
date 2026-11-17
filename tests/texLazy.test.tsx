// @vitest-environment jsdom
/**
 * KaTeX is one of the largest pieces of the app and is needed only by answers with a
 * formula: it loads on the first formula, and until it lands the formula shows as
 * readable plain text (never as an error and never as an empty box). The page spec
 * reader is kept in its own small module so reading a page's description back never
 * carries the page writer's bundled libraries into the startup bundle.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { Tex } from "../src/renderer/Tex";
import { pageSpecOf } from "../src/core/page/spec";

afterEach(cleanup);

describe("Tex loads KaTeX on the first formula", () => {
  it("shows the formula as plain text first, then typesets it once KaTeX has arrived", async () => {
    const { container } = render(createElement(Tex, { v: "C = \\frac{150}{0.06 \\times \\frac{1}{4}}", display: true }));
    // before the engine lands the formula is readable text, not an error
    expect(container.textContent).toContain("C = 150/(0.06");
    expect(container.querySelector(".tex")).toBeNull();
    await waitFor(() => expect(container.querySelector(".tex")).toBeTruthy());
    expect(container.querySelector(".math-block")?.innerHTML).toContain("katex");
  });

  it("keeps a formula KaTeX cannot read as plain text", async () => {
    const { container } = render(createElement(Tex, { v: "\\this{is not latex", display: false }));
    await waitFor(() => expect(container.querySelector("span.math")).toBeTruthy());
    expect(container.querySelector("span.tex")).toBeNull();
  });

  it("typesets at once once KaTeX has landed, with no plain-text first render", async () => {
    // Warm the engine (already warm when this runs last): the first formula waits for it.
    const first = render(createElement(Tex, { v: "a^2 + b^2 = c^2", display: false }));
    await waitFor(() => expect(first.container.querySelector("span.tex")).toBeTruthy());
    cleanup();
    // KaTeX is loaded now: a new formula must be typeset on its very first render, so the
    // reader never sees it as plain text and then see it flip.
    const { container } = render(createElement(Tex, { v: "x = 1", display: false }));
    expect(container.querySelector("span.tex")).toBeTruthy();
    expect(container.querySelector("span.math")).toBeNull();
  });
});

describe("pageSpecOf (the small reader)", () => {
  it("reads a page's description back out of its HTML, and refuses anything else", () => {
    const spec = { sections: [{ type: "hero", title: "Hi" }] };
    const html = `<html><script type="application/json" id="site-spec">${JSON.stringify(spec).replace(/</g, "\\u003c")}</script></html>`;
    expect(pageSpecOf(html)).toEqual(spec);
    expect(pageSpecOf("<html><body>just a page</body></html>")).toBeNull();
  });
});
