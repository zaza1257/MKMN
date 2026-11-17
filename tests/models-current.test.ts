import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { currentModelLine } from "../src/renderer/Models";

/**
 * In the narrow layout the Models page opened on the settings search, the group
 * picker, Export / Import and the catalogue search before any model. It now opens
 * on the model in use with a jump to the installed ones, and the settings tools
 * (about settings, not models) are not drawn above it.
 */

const items = [
  { entry: { id: "a", name: "Alpha" }, installed: true, hidden: false },
  { entry: { id: "b", name: "Beta" }, installed: true, hidden: false },
  { entry: { id: "c", name: "Gamma" }, installed: false, hidden: false },
  { entry: { id: "d", name: "Old" }, installed: true, hidden: true },
] as any;

describe("the Models page opens on what the person has", () => {
  it("names the model in use and counts the installed ones", () => {
    expect(currentModelLine(items, "b")).toEqual({ current: "Beta", installed: 2 });
  });

  it("says what to do when nothing is chosen or installed", () => {
    expect(currentModelLine(items, null).current).toMatch(/press Use/);
    expect(currentModelLine([], null)).toEqual({ current: "None installed yet: install one under Recommended", installed: 0 });
  });

  it("the strip comes before the catalogue search", () => {
    const src = readFileSync("src/renderer/Models.tsx", "utf8");
    expect(src.indexOf('className="current-model"')).toBeGreaterThan(0);
    expect(src.indexOf('className="current-model"')).toBeLessThan(src.indexOf('className="searchbar"'));
  });

  it("the settings tools are not drawn above the models in the narrow layout", () => {
    const sv = readFileSync("src/renderer/SettingsView.tsx", "utf8");
    const css = readFileSync("src/renderer/styles.css", "utf8");
    expect(sv).toContain('tab === "library" ? "on-library" : ""');
    const narrow = css.slice(css.indexOf("@media (max-width: 860px) {"));
    expect(narrow).toContain(".set-tools.on-library { display: none; }");
  });
});
