import { describe, expect, it } from "vitest";
import { checkUpdates, geniexInstallerNewer, parseUpgrades, updateRequirement, wingetUpgradeArgs } from "../src/core/requirements";

/**
 * Updates of MKMN's own requirements: `winget upgrade` is read for the packages MKMN installs (and only those),
 * an update names a package of the fixed list, and GenieX is compared by the installer's publish date.
 * The listing below is the real `winget upgrade` output measured on this PC, shortened, with one row
 * added by hand (Python.Python.3.11: that PC's Python had no newer version listed).
 */

const LISTING = `Name                                                            Id                             Version              Available            Source
-----------------------------------------------------------------------------------------------------------------------------------------------
Antigravity 2.29.0                                              Google.Antigravity             2.29.0               2.32.1               winget
Foundry Local CLI                                               Microsoft.FoundryLocal         0.12.1.0             0.14.0.0             winget
Microsoft Visual C++ 2022 Redistributable (Arm64) - 14.51.36247 Microsoft.VCRedist.2015+.arm64 14.51.36247.0        14.52.37029.0        winget
Python 3.11.9 (ARM64)                                           Python.Python.3.11             3.11.9               3.11.11              winget
Python Launcher                                                 Python.Launcher                3.11.9               3.15.2               winget
`;

describe("updates of the requirements", () => {
  it("reads only MKMN's own packages from the listing, Python under any 3.x id", () => {
    expect(parseUpgrades(LISTING)).toEqual([
      { id: "foundry", pkg: "Microsoft.FoundryLocal", current: "0.12.1.0", available: "0.14.0.0" },
      { id: "python", pkg: "Python.Python.3.11", current: "3.11.9", available: "3.11.11" },
    ]);
  });

  it("an update runs winget upgrade on that exact package", async () => {
    const calls: string[][] = [];
    const r = await updateRequirement("foundry", "Microsoft.FoundryLocal", { run: async (_e, a) => { calls.push(a); return { code: 0, out: "" }; } });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([wingetUpgradeArgs("Microsoft.FoundryLocal")]);
  });

  it("refuses a package that is not the requirement's own, without running anything", async () => {
    let ran = false;
    const run = async () => { ran = true; return { code: 0, out: "" }; };
    expect((await updateRequirement("python", "Python.Launcher", { run })).ok).toBe(false);
    expect((await updateRequirement("foundry", "Evil.Package", { run })).ok).toBe(false);
    expect((await updateRequirement("geniex", "Qualcomm.GenieX", { run })).ok).toBe(false);
    expect(ran).toBe(false);
  });

  it("winget's non-zero exit on a good listing is not a failure; a missing winget is said plainly", async () => {
    const ok = await checkUpdates({ run: async () => ({ code: -1, out: LISTING }) });
    expect(ok.ok).toBe(true);
    expect(ok.updates).toHaveLength(2);
    const none = await checkUpdates({ run: async () => { throw new Error("spawn winget ENOENT"); } });
    expect(none.ok).toBe(false);
    expect(none.message).toMatch(/App Installer/);
  });

  it("GenieX is newer only when its installer was published more than a day after it was installed", () => {
    const installed = new Date("2026-11-01T10:00:00Z");
    expect(geniexInstallerNewer("Tue, 10 Nov 2026 08:00:00 GMT", installed)).toBe(true);
    expect(geniexInstallerNewer("Sun, 01 Nov 2026 20:00:00 GMT", installed)).toBe(false);
    expect(geniexInstallerNewer(null, installed)).toBeNull();
    expect(geniexInstallerNewer("Tue, 10 Nov 2026 08:00:00 GMT", null)).toBeNull();
  });
});
