import { describe, expect, it } from "vitest";
import { updateProbeArgs } from "../src/core/geniex";

const HELP = "Global Flags:\n      --data-dir string   Custom data directory\n      --skip-update       Skip checking for updates\n";

describe("the router's GenieX server and the update check", () => {
  it("is started with --skip-update while the update check is off (its default)", () => {
    expect(updateProbeArgs(undefined, HELP)).toEqual(["--skip-update"]);
    expect(updateProbeArgs(false, HELP)).toEqual(["--skip-update"]);
  });
  it("lets GenieX check when the person turned the check on", () => {
    expect(updateProbeArgs(true, HELP)).toEqual([]);
  });
  it("never sends the flag to a GenieX whose help does not document it, as a word", () => {
    expect(updateProbeArgs(false, "      --skip-updates-later  something else\n")).toEqual([]);
    expect(updateProbeArgs(false, "")).toEqual([]);
  });
});
