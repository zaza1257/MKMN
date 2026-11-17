import { describe, expect, it } from "vitest";
import { cleanSyntax } from "../src/core/construct/fixes";

/**
 * Typographic quotes were replaced everywhere, before trying to parse, so an apostrophe
 * inside a string ('It’s over') became a quote and broke code that was fine.
 */

describe("cleanSyntax keeps typographic quotes that are text", () => {
  it("leaves an apostrophe inside a string alone when the code parses", () => {
    const code = "function end() { return 'It’s over'; }";
    expect(cleanSyntax(code)).toBe(code);
  });

  it("still mends code written with typographic quotes as its quotes", () => {
    expect(cleanSyntax("function f() { return “hi”; }")).toBe('function f() { return "hi"; }');
  });
});
