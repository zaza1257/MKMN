import { describe, expect, it } from "vitest";
import { ALLOWED, allowlistReason, scanLanguage, scanText } from "../scripts/check-language.mjs";

/**
 * The app speaks English and Arabic. A sentence in another language, an accent
 * from another Latin language or a different script is a fault, in prose and in
 * code alike, unless the file is named in the short allowlist (symbols,
 * third-party text, the Arabic brand). The samples below are the guard's own
 * fixtures: they must stay in another language for the guard to be tested.
 */
describe("the language guard", () => {
  it("accepts English and Arabic", () => {
    expect(scanText("Welcome to MKMN. Your files stay on this PC.\nمرحباً بك في MKMN.")).toEqual([]);
  });

  it("accepts English words that carry an accent or a proper name", () => {
    expect(scanText("The café has a naïve résumé, and Michał Sajnóg wrote the licence.")).toEqual([]);
  });

  it("fails on a French sentence", () => {
    const faults = scanText("Le modèle ne fait aucun calcul et la feuille se recalcule toute seule.");
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("another language");
  });

  it("fails on an accented Latin sentence from another language", () => {
    const faults = scanText("El cálculo de la hoja ya está terminado.");
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("accent");
  });

  it("fails on another script", () => {
    expect(scanText("这是一个测试")).toHaveLength(1);
    expect(scanText("Это тест")).toHaveLength(1);
  });

  it("lets the named files keep their symbols", () => {
    expect(scanText("const greek = \"\u03b1\u03b2\u03b3\";", "src/core/math.ts")).toEqual([]);
  });

  it("fails on an accent in a code line", () => {
    expect(scanText("const words = /\\b(caf\u00e8|r\u00e9union)\\b/;", "src/core/x.ts")).toHaveLength(1);
  });

  it("gives every allowlist entry a reason", () => {
    expect(ALLOWED.length).toBeGreaterThan(3);
    for (const entry of ALLOWED) {
      expect(entry.path.trim(), "allowlist path").not.toBe("");
      expect(entry.why.trim(), entry.path).not.toBe("");
      expect(allowlistReason(entry.path), entry.path).toBe(entry.why);
    }
  });

  it("finds no text in another language outside the allowlist", () => {
    const faults = scanLanguage(process.cwd());
    expect(faults, `\n${faults.join("\n")}\n`).toEqual([]);
  });
});
