import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Only the content column of Settings scrolls. A deep link (a search result, the
 * Changed list's Open) scrolls its section into view, and scrollIntoView also
 * scrolls every ancestor that CAN scroll, which includes an `overflow: hidden`
 * box. The outer boxes of the Settings shell are clipped (`overflow: clip`),
 * which cannot be scrolled by script, so a deep link never pushes the side
 * column out of the window. jsdom does no layout, so the rule is pinned in the
 * stylesheet itself (observed in the browser preview before the fix: the side
 * column scrolled away after "Power mode" was opened).
 */

const css = readFileSync("src/renderer/styles.css", "utf8");

function rule(selector: string): string {
  const i = css.indexOf(`${selector} {`);
  expect(i, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(i, css.indexOf("}", i));
}

describe("the Settings shell cannot be scrolled away by a deep link", () => {
  it("clips the dialog body and the page instead of hiding their overflow", () => {
    expect(rule(".modal-settings .modal-body")).toMatch(/overflow:\s*clip/);
    expect(rule(".modal-body .page.set-page")).toMatch(/overflow:\s*clip/);
  });
});
