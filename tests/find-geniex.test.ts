import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { findGeniex } from "../src/core/geniex";

// An MKMN started without LOCALAPPDATA in its environment said "GenieX is not installed" while it was:
// the app's own paths fall back to the user profile (mkmnPaths), the GenieX lookup did not.
describe("finding geniex.exe", () => {
  const profile = path.join("C:", "Users", "u");
  const exe = path.join(profile, "AppData", "Local", "GenieX CLI", "geniex.exe");
  it("finds it under the user profile when LOCALAPPDATA is missing", () => {
    expect(findGeniex(null, { USERPROFILE: profile } as NodeJS.ProcessEnv, (p) => p === exe)).toBe(exe);
  });
  it("still prefers LOCALAPPDATA when it is set", () => {
    const local = path.join("D:", "Local");
    const other = path.join(local, "GenieX CLI", "geniex.exe");
    expect(findGeniex(null, { LOCALAPPDATA: local, USERPROFILE: profile } as NodeJS.ProcessEnv, (p) => p === other || p === exe)).toBe(other);
  });
});
