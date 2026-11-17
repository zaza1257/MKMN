import { describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { GENIEX_MIN_VERSION, GeniexGate, compareVersions, judgeGeniex, parseGeniexCliVersion } from "../src/core/geniexGate";

const REAL_011 = "GenieX CLI Version:     v0.11.0\nQAIRT Runtime Version:  2.50\nLlamaCPP Runtime Hash:  93cf736\n";
const out = (v: string) => REAL_011.replace("v0.11.0", v);

function gate(found: string | null, version: string | null | (() => Promise<string | null>), id = "1") {
  const readVersion = vi.fn(typeof version === "function" ? version : async () => version);
  return { g: new GeniexGate({ find: () => found, readVersion, identity: () => id }), readVersion };
}

describe("GenieX minimum version", () => {
  it("is v0.11.0 and matches the Rust host's constant", () => {
    expect(GENIEX_MIN_VERSION).toBe("0.11.0");
    const rs = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "capabilities.rs"), "utf8");
    expect(rs).toMatch(/pub const GENIEX_MIN_VERSION: \(u64, u64, u64\) = \(0, 11, 0\);/);
  });

  it("reads the CLI's own version line, never the QAIRT runtime's", () => {
    expect(parseGeniexCliVersion(REAL_011)).toBe("0.11.0");
    expect(parseGeniexCliVersion("Geniex CLI Version: v0.10.0")).toBe("0.10.0");
    expect(parseGeniexCliVersion("\u001b[1mGenieX CLI Version:\u001b[0m v0.12.3")).toBe("0.12.3");
    expect(parseGeniexCliVersion("QAIRT Runtime Version:  2.50.1")).toBeNull();
    expect(parseGeniexCliVersion("error: unknown")).toBeNull();
    expect(parseGeniexCliVersion("")).toBeNull();
  });

  it("reads every shared version line as the Rust host does", () => {
    const { cases } = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "shared", "geniexVersionLines.json"), "utf8")) as { cases: { out: string; version: string | null }[] };
    expect(cases.length).toBeGreaterThan(8);
    for (const c of cases) expect(parseGeniexCliVersion(c.out), JSON.stringify(c.out)).toBe(c.version);
  });

  it("compares numerically, not as text", () => {
    expect(compareVersions("0.11.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.10.9", "0.11.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.11.0")).toBe(1);
  });

  it("missing GenieX: blocked, says the minimum", () => {
    const s = judgeGeniex(null, null);
    expect(s).toMatchObject({ state: "missing", detected: null, required: "0.11.0" });
    expect(s.message).toContain("v0.11.0 or newer");
  });

  it("an older GenieX: blocked, names the detected and required versions", () => {
    const s = judgeGeniex("C:\\g\\geniex.exe", out("v0.10.0"));
    expect(s).toMatchObject({ state: "outdated", detected: "0.10.0", required: "0.11.0" });
    expect(s.message).toContain("v0.10.0");
    expect(s.message).toContain("v0.11.0 or newer");
  });

  it("v0.11.0 and newer: allowed", () => {
    expect(judgeGeniex("C:\\g\\geniex.exe", REAL_011).state).toBe("ok");
    expect(judgeGeniex("C:\\g\\geniex.exe", out("v0.11.1")).state).toBe("ok");
    expect(judgeGeniex("C:\\g\\geniex.exe", out("v1.2.0")).state).toBe("ok");
  });

  it("an invalid or silent version: blocked", () => {
    expect(judgeGeniex("C:\\g\\geniex.exe", "GenieX CLI Version: unknown").state).toBe("invalid");
    expect(judgeGeniex("C:\\g\\geniex.exe", null).state).toBe("invalid");
  });
});

describe("the cached gate", () => {
  it("require() throws the person-facing message when blocked and returns the path when allowed", async () => {
    await expect(gate(null, null).g.require()).rejects.toThrow(/not installed/);
    await expect(gate("C:\\g\\geniex.exe", out("v0.9.3")).g.require()).rejects.toThrow(/v0\.9\.3.*v0\.11\.0 or newer/);
    await expect(gate("C:\\g\\geniex.exe", "garbage").g.require()).rejects.toThrow(/did not report a valid version/);
    await expect(gate("C:\\custom\\geniex.exe", REAL_011).g.require()).resolves.toBe("C:\\custom\\geniex.exe");
    expect(await gate("C:\\g\\geniex.exe", out("v0.10.0")).g.usable()).toBeNull();
  });

  it("checks a custom geniex.exe, not only the default folder", async () => {
    let chosen = "C:\\Users\\x\\AppData\\Local\\GenieX CLI\\geniex.exe";
    const versions: Record<string, string> = { [chosen]: REAL_011, "D:\\old\\geniex.exe": out("v0.10.0") };
    const g = new GeniexGate({ find: () => chosen, readVersion: async (e) => versions[e] ?? null, identity: () => "1" });
    expect((await g.check()).state).toBe("ok");
    chosen = "D:\\old\\geniex.exe";
    expect((await g.check()).state).toBe("outdated");
  });

  it("runs --version once per executable identity and again after an in-place update", async () => {
    let id = "a";
    let v = out("v0.10.0");
    const readVersion = vi.fn(async () => v);
    const g = new GeniexGate({ find: () => "C:\\g\\geniex.exe", readVersion, identity: () => id });
    expect((await g.check()).state).toBe("outdated");
    await g.check();
    expect(readVersion).toHaveBeenCalledTimes(1);
    id = "b"; v = REAL_011;
    expect((await g.check()).state).toBe("ok");
    expect(readVersion).toHaveBeenCalledTimes(2);
  });

  it("works offline: the check only runs the local executable", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    try {
      expect(await gate("C:\\g\\geniex.exe", REAL_011).g.require()).toBe("C:\\g\\geniex.exe");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  it("asks a GenieX that did not answer again next time", async () => {
    let answer: string | null = null;
    const { g, readVersion } = gate("C:\\g\\geniex.exe", async () => answer);
    expect((await g.check()).state).toBe("invalid");
    answer = REAL_011;
    expect((await g.check()).state).toBe("ok");
    expect(readVersion).toHaveBeenCalledTimes(2);
  });
});
