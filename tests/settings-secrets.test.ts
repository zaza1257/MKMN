import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { exportSettings, importSettings } from "../src/shared/settingsSchema";

/**
 * Settings files travel (Export, Import), so what they carry is checked:
 * - a credential (the Brave key) never leaves in an export and is masked on screen;
 * - a path to a program the app RUNS (the runtime path) is set on this PC only:
 *   an imported file could otherwise point the app at any executable;
 * - a nested value (the turn budget) is checked leaf by leaf, not only as "an object".
 */

describe("what an export carries", () => {
  it("never writes the Brave key or the runtime path", () => {
    const doc = exportSettings({ braveKey: "sk-dummy-123", geniexPath: "C:\\tools\\geniex.exe", appearance: "dark" });
    expect(doc.values.appearance).toBe("dark");
    expect(doc.values).not.toHaveProperty("braveKey");
    expect(doc.values).not.toHaveProperty("geniexPath");
    expect(JSON.stringify(doc)).not.toContain("sk-dummy-123");
  });
});

describe("what an import accepts", () => {
  it("refuses a credential and a program path, saying why", () => {
    const r = importSettings({ values: { braveKey: "sk-x", geniexPath: "C:\\evil.exe", appearance: "light" } });
    expect(r.rest).toEqual({ appearance: "light" });
    expect(r.refusals.map((x) => x.key).sort()).toEqual(["braveKey", "geniexPath"]);
  });

  it("checks a nested value leaf by leaf", () => {
    const bad = importSettings({ values: { turnBudget: { maxCalls: "many", maxOutputTokens: -5 } } });
    expect(bad.rest).not.toHaveProperty("turnBudget");
    expect(bad.refusals.some((x) => x.key.startsWith("turnBudget"))).toBe(true);
    const good = importSettings({ values: { turnBudget: { maxCalls: 60, maxOutputTokens: 50000 } } });
    expect(good.rest.turnBudget).toEqual({ maxCalls: 60, maxOutputTokens: 50000 });
  });
});

describe("the Changed list", () => {
  it("masks a secret value instead of printing it (source pin)", () => {
    const src = readFileSync("src/renderer/SettingsView.tsx", "utf8");
    expect(src).toMatch(/decl\.secret/);
  });
});
