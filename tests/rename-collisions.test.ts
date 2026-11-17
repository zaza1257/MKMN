import { describe, expect, it } from "vitest";
import { renameCollisions } from "../src/core/construct/fixes";

/**
 * renameCollisions renamed a clashing top-level name with a text pattern whose `(?!\s*:)`
 * guard, meant for object keys, also skipped `c ? TILE : 0` and `case TILE:`, so those uses
 * kept pointing at another unit's TILE. It also rewrote strings and turned `{ TILE }` into
 * `{ TILE_u }`, which changed the key.
 */

const taken = new Set(["TILE"]);

describe("renameCollisions renames the binding, not the text", () => {
  it("renames uses in a ternary and a case label", () => {
    const out = renameCollisions("const TILE = 8;\nfunction f(c, k) { switch (k) { case TILE: return c ? TILE : 0; } }", taken, "draw");
    expect(out).toBe("const TILE_draw = 8;\nfunction f(c, k) { switch (k) { case TILE_draw: return c ? TILE_draw : 0; } }");
  });

  it("leaves strings, property names and member names alone, and keeps a shorthand key", () => {
    const out = renameCollisions("const TILE = 8;\nconst o = { TILE, size: TILE, label: 'TILE' };\nconst w = o.TILE;", taken, "draw");
    expect(out).toBe("const TILE_draw = 8;\nconst o = { TILE: TILE_draw, size: TILE_draw, label: 'TILE' };\nconst w = o.TILE;");
  });

  it("does not touch a function that declares the name itself", () => {
    const out = renameCollisions("const TILE = 8;\nfunction g(TILE) { return TILE * 2; }\nconst h = TILE;", taken, "u");
    expect(out).toBe("const TILE_u = 8;\nfunction g(TILE) { return TILE * 2; }\nconst h = TILE_u;");
  });
});
