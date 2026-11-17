import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createSaveFeedback } from "../src/core/settingsUi";

/**
 * A caller must know whether a save landed: Import counted values as imported and
 * Reset offered Undo before the save finished, even when it then failed.
 */

describe("a save tells its caller whether it landed", () => {
  it("resolves true when the save lands and false when it fails", async () => {
    const fb = createSaveFeedback(10);
    await expect(fb.attempt("ok", async () => undefined)).resolves.toBe(true);
    await expect(fb.attempt("bad", async () => { throw new Error("disk full"); })).resolves.toBe(false);
  });

  it("Import and Reset wait for the save before they report (source pin)", () => {
    const src = readFileSync("src/renderer/SettingsView.tsx", "utf8");
    expect(src).toMatch(/const saved = await applyLeaf\(/);
    expect(src).toMatch(/importSaved/);
  });
});
