import { describe, expect, it } from "vitest";
import { mendIds } from "../src/core/construct/fixes";

/**
 * mendIds made the `#` of a querySelector optional, so `querySelector('div > p')` read
 * `div` as an id and could rewrite it to a page id spelled like it.
 */

describe("mendIds only mends a bare #id selector", () => {
  it("leaves a tag selector alone", () => {
    const code = "const p = document.querySelector('div > p');";
    expect(mendIds(code, ["dive"])).toBe(code);
  });

  it("still mends a misspelt #id and a getElementById", () => {
    expect(mendIds("document.querySelector('#scor')", ["score"])).toBe("document.querySelector('#score')");
    expect(mendIds("document.getElementById('scor')", ["score"])).toBe("document.getElementById('score')");
  });
});
