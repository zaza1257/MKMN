import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as schema from "../src/shared/settingsSchema";

/**
 * Reset only touches what the Settings page itself controls. The Changed
 * list offered a Reset on records the app writes (the measured places and load
 * profiles, the chosen model) and on text written elsewhere (the personal
 * instructions, the skills): one click wiped a benchmark's results or a person's
 * own words. Those keys are not "changed settings" to reset; they are data.
 */

const stored = {
  appearance: "dark",
  selectedModelId: "q/repo:W4A16",
  placements: { "q/repo:W4A16": "npu" },
  loadProfiles: { "q/repo:W4A16": { nctx: 4096 } },
  customInstructions: "Answer briefly.",
  skills: [{ id: "s1" }],
};

describe("what Reset may touch", () => {
  it("resettableChangedKeys keeps the settings with a control here and leaves records and outside text alone", () => {
    const fn = (schema as Record<string, unknown>).resettableChangedKeys as ((s: unknown) => string[]) | undefined;
    expect(typeof fn).toBe("function");
    const keys = fn!(stored);
    expect(keys).toContain("appearance");
    for (const k of ["selectedModelId", "placements", "loadProfiles", "customInstructions", "skills"]) expect(keys).not.toContain(k);
  });

  it("the Settings page builds its counts, its Changed list and its group Reset from that list (source pin)", () => {
    const src = readFileSync("src/renderer/SettingsView.tsx", "utf8");
    expect(src).toMatch(/resettableChangedKeys\(settings\)/);
  });
});

describe("settings with a control are resettable, even when they are halves of a pair", () => {
  it("the turn limits and the read-aloud speaker are listed and reset like any setting", () => {
    const fn = (schema as Record<string, unknown>).resettableChangedKeys as (s: unknown) => string[];
    const keys = fn({ turnBudget: { maxCalls: 60, maxOutputTokens: 100000 }, voice: { ttsSid: 3 } });
    expect(keys).toContain("turnBudget.maxCalls");
    expect(keys).toContain("voice.ttsSid");
  });
});
