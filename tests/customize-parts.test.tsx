// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { Customize, partNote } from "../src/renderer/Customize";

/**
 * Personalisation explained the context limits but left the person to work out
 * which parts their model gets; its folded parts opened only with a mouse; and
 * Skills' main action was a bare plus. Each part now says whether the current
 * model receives it, the folded parts are buttons with aria-expanded, and the
 * Skills action reads "Add skill".
 */

afterEach(cleanup);

describe("Personalisation says which parts the current model gets", () => {
  it("parts the window can carry are included, the others are named as not sent", () => {
    const small = { name: "Small", contextTokens: 4096 };
    expect(partNote(0, small)?.included).toBe(true);
    expect(partNote(1, small)?.included).toBe(false);
    expect(partNote(1, small)?.text).toMatch(/Not sent to your current model \(Small\)/);
    const big = { name: "Big", contextTokens: 32768 };
    expect([0, 1, 2].map((i) => partNote(i, big)?.included)).toEqual([true, true, true]);
    expect(partNote(0, null)).toBeNull();
  });

  it("the folded parts open from the keyboard", () => {
    render(<Customize settings={{} as any} onSave={async () => {}} onOpenDocs={() => {}} model={{ name: "Small", contextTokens: 4096 }} />);
    fireEvent.click(screen.getByRole("tab", { name: "Personalisation" }));
    const more = screen.getByRole("button", { name: /2\. More details/ });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: /2\. More details/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Included for your current model (Small)")).toBeTruthy();
  });

  it("Skills' main action is named in words", () => {
    const src = readFileSync("src/renderer/Skills.tsx", "utf8");
    expect(src).toMatch(/<Glyph id="plus" size=\{16\} \/> Add skill<\/button>/);
  });
});
