import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PRIMARY_TABS, SETTINGS_SECTIONS } from "../src/renderer/settingsSearch";

/**
 * Every "Settings → X" path written into the app's own text must name a group the
 * Settings page really shows. The 2.10 regrouping left "Settings → Advanced →
 * Diagnostics", "Settings → System status" and "Settings → Performance" in model
 * cards and meters: places that no longer exist, so the person was sent nowhere.
 */

const ROOTS = ["src/renderer", "src/core"];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(tsx?|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

const groups = new Set([...PRIMARY_TABS, ...SETTINGS_SECTIONS].map((t) => t.label));

describe("Settings paths written in the app", () => {
  it("name a group the Settings page shows", () => {
    const bad: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(root)) {
        const text = readFileSync(f, "utf8");
        for (const m of text.matchAll(/Settings\s*(?:→|&rarr;|>)\s*([A-Z][A-Za-z&;' -]+?)(?=\s*(?:→|&rarr;|>|\(|\.|,|:|"|`|$))/gm)) {
          const g = m[1].replace(/&amp;/g, "&").trim();
          if (!groups.has(g)) bad.push(`${f}: "Settings → ${g}"`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
  it("never name a group by its pre-2.10 name, with or without the Settings prefix", () => {
    // "in Models & speed → Memory use" survived the rename to Speed & memory: it had no
    // "Settings →" in front of it, so the scan above never saw it
    const old = ["Models & speed", "Advanced", "System status", "General & appearance"];
    const bad: string[] = [];
    for (const root of ROOTS) for (const f of files(root)) {
      const text = readFileSync(f, "utf8").replace(/&amp;/g, "&");
      for (const o of old) if (new RegExp(`${o}\\s*(→|&rarr;)`).test(text)) bad.push(`${f}: ${o} →`);
    }
    expect(bad).toEqual([]);
  });
});
