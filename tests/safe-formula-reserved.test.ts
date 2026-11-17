import { describe, expect, it } from "vitest";
import { safeFormula } from "../src/core/templates/site";

/**
 * An input id only had to look like a name, so an input called `constructor` let
 * `Math.constructor` through. Its safety rested on there being no string literal.
 */

describe("safeFormula refuses object machinery whatever the inputs are called", () => {
  it("refuses Math.constructor and a member of an input", () => {
    expect(safeFormula("Math.constructor", ["constructor"])).toBeNull();
    expect(safeFormula("price.constructor", ["price", "constructor"])).toBeNull();
    expect(safeFormula("prototype + 1", ["prototype"])).toBeNull();
  });

  it("still accepts ordinary formulas with Math", () => {
    expect(safeFormula("round(price * qty)", ["price", "qty"])).toBe("Math.round(price * qty)");
    expect(safeFormula("max(a, b) / 2", ["a", "b"])).toBe("Math.max(a, b) / 2");
  });
});
