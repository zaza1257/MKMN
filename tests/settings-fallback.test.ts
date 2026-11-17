import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fallbackSettingsWrite } from "../src/core/settingsFallback";

/**
 * When the host could not take a settings patch, the sidecar wrote the WHOLE
 * snapshot it read before the request — 30 seconds stale at a timeout — over any
 * newer save, and over a damaged file the host refuses to touch.
 */

describe("the sidecar's last-resort settings write", () => {
  it("merges the patch into the file as it is now, never into an old snapshot", () => {
    let disk: Record<string, unknown> = { appearance: "dark", webSearch: true }; // saved by the host meanwhile
    const ok = fallbackSettingsWrite(() => ({ kind: "object", value: disk }), (v) => { disk = v; }, { placements: { m: "npu" } });
    expect(ok).toBe(true);
    expect(disk).toEqual({ appearance: "dark", webSearch: true, placements: { m: "npu" } });
  });

  it("leaves a file that is not a valid settings object alone", () => {
    let wrote = false;
    expect(fallbackSettingsWrite(() => ({ kind: "unusable" }), () => { wrote = true; }, { a: 1 })).toBe(false);
    expect(wrote).toBe(false);
  });

  it("the sidecar uses it, and no longer writes the pre-request merge (source pin)", () => {
    const src = readFileSync("src/sidecar/main.ts", "utf8");
    expect(src).toContain("fallbackSettingsWrite(");
    expect(src).not.toMatch(/writeJson\(settingsFile\(\), merged\)/);
  });
});
