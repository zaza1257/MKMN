import { describe, expect, it } from "vitest";
import { pureCopy } from "../src/core/construct/fixes";

/**
 * pureCopy made every function that changes an argument work on a copy, even one that
 * returns something else: `p.vx = 0; return p.x > w.x` then silently stopped changing p,
 * and the frozen-argument check that would have named the fault passed.
 */

describe("pureCopy only rewrites a function that hands its argument back", () => {
  it("leaves a function that returns something else alone", () => {
    const code = "function hitWall(p, w) { p.vx = 0; return p.x > w.x; }";
    expect(pureCopy(code, "hitWall")).toBe(code);
  });

  it("still copies a function that returns nothing", () => {
    const out = pureCopy("function move(p) { p.x += 1; }", "move");
    expect(out).toContain("JSON.parse(JSON.stringify(p))");
    expect(out).toContain("return p;");
  });

  it("still copies a function that returns the argument it changed", () => {
    expect(pureCopy("function move(p) { p.x += 1; return p; }", "move")).toContain("JSON.parse(JSON.stringify(p))");
  });
});
