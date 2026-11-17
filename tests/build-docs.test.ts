import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The build instructions must build the release the README names:
 * - the manual NSIS command passed no version, and installer.nsi fell back to
 *   a stale number — a hand-built installer was mislabelled;
 * - no document may name a Build-Windows.ps1 parameter the script does not accept.
 */

const readme = readFileSync("README.md", "utf8");
const contributing = readFileSync("CONTRIBUTING.md", "utf8");
const nsi = readFileSync("installer.nsi", "utf8");
const build = readFileSync("scripts/Build-Windows.ps1", "utf8");

describe("the build instructions", () => {
  it("installer.nsi has no fallback version: building it without one stops with a message", () => {
    expect(nsi).not.toMatch(/!define VERSION "\d+\.\d+\.\d+"/);
    expect(nsi).toMatch(/!ifndef VERSION\s+!error /);
  });

  it("the README's manual makensis passes the version from package.json", () => {
    expect(readme).toMatch(/makensis \/DVERSION=/);
    expect(readme).not.toMatch(/^\s*makensis installer\.nsi\s*$/m);
  });

  it("no document names a build-script parameter the script does not accept", () => {
    const params = [...build.matchAll(/\[switch\]\$(\w+)|\[string\]\$(\w+)/g)].map((m) => (m[1] ?? m[2]).toLowerCase());
    for (const doc of [readme, contributing]) {
      for (const m of doc.matchAll(/Build-Windows\.ps1\s+-(\w+)/g)) expect(params, m[0]).toContain(m[1].toLowerCase());
    }
  });
});
