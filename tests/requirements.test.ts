// What MKMN needs on the PC, how each need is seen, and how a missing one is installed from the internet.
import { describe, expect, it } from "vitest";
import { REQUIREMENTS, checkRequirements, installedChatModels, installRequirement, parseWebView2Version, parseNpuDevices, wingetArgs } from "../src/core/requirements";

type R = { code: number; out: string };
const fake = (answers: Record<string, R>) => {
  const calls: string[] = [];
  const run = async (exe: string, args: string[]) => { const k = `${exe} ${args.join(" ")}`; calls.push(k); return Object.entries(answers).find(([p]) => k.includes(p))?.[1] ?? { code: 1, out: "" }; };
  return { run, calls };
};

describe("the requirements list", () => {
  it("names every runtime the app uses, each with a way to get it", () => {
    const ids = REQUIREMENTS.map((r) => r.id);
    expect(ids).toEqual(["webview2", "geniex", "npuDriver", "models", "voiceRuntime", "foundry", "python", "libreoffice"]);
    // local inference needs GenieX, the NPU driver and a model; the rest stays optional
    expect(REQUIREMENTS.filter((r) => r.need === "required").map((r) => r.id)).toEqual(["webview2", "geniex", "npuDriver", "models"]);
    for (const r of REQUIREMENTS) {
      expect(r.need === "required" || r.need === "optional").toBe(true);
      // a missing requirement is never a dead end: it has a package to install, the app's own setup, or a Windows page
      expect(Boolean(r.install.winget || r.install.setup || r.install.settingsUri || r.install.bundled || r.install.library)).toBe(true);
    }
  });

  it("installs only packages of its own fixed list, silently and with the agreements accepted", () => {
    expect(wingetArgs("Microsoft.FoundryLocal")).toEqual(["install", "--id", "Microsoft.FoundryLocal", "--exact", "--silent", "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity"]);
    const ids = REQUIREMENTS.flatMap((r) => (r.install.winget ? [r.install.winget] : []));
    expect(ids).toEqual(["Microsoft.EdgeWebView2Runtime", "Microsoft.FoundryLocal", "Python.Python.3.12", "TheDocumentFoundation.LibreOffice"]);
  });
});

describe("reading what is there", () => {
  it("reads the WebView2 version Windows records, and nothing from an empty key", () => {
    expect(parseWebView2Version("    pv    REG_SZ    142.0.3595.80\r\n")).toBe("142.0.3595.80");
    expect(parseWebView2Version("    pv    REG_SZ    0.0.0.0")).toBeNull();
    expect(parseWebView2Version("ERROR: The system was unable to find the specified registry key or value.")).toBeNull();
  });

  it("finds a working NPU device, and says nothing is there when the list is empty", () => {
    expect(parseNpuDevices("OK|Snapdragon(R) X Elite - X1E78100 - Qualcomm(R) Hexagon(TM) NPU\r\n")).toEqual({ ok: true, name: "Snapdragon(R) X Elite - X1E78100 - Qualcomm(R) Hexagon(TM) NPU" });
    expect(parseNpuDevices("Error|Qualcomm(R) Hexagon(TM) NPU")).toEqual({ ok: false, name: "Qualcomm(R) Hexagon(TM) NPU" });
    expect(parseNpuDevices("")).toBeNull();
  });

  it("reports each requirement as found or missing, with what it found", async () => {
    const { run } = fake({
      "reg query HKLM": { code: 0, out: "    pv    REG_SZ    142.0.3595.80" },
      "Get-PnpDevice": { code: 0, out: "OK|Qualcomm(R) Hexagon(TM) NPU" },
      "foundry --version": { code: 0, out: "0.12.1\r\n" }
    });
    const st = await checkRequirements({ run, geniex: () => "C:/g/geniex.exe", voiceRuntime: () => true, python: () => null, office: () => null, platform: "win32" });
    const by = Object.fromEntries(st.map((s) => [s.id, s]));
    expect(by.webview2).toMatchObject({ present: true, detail: "142.0.3595.80" });
    expect(by.geniex).toMatchObject({ present: true, detail: "C:/g/geniex.exe" });
    expect(by.npuDriver).toMatchObject({ present: true, detail: "Qualcomm(R) Hexagon(TM) NPU" });
    expect(by.foundry).toMatchObject({ present: true, detail: "0.12.1" });
    expect(by.python.present).toBe(false);
    expect(by.libreoffice.present).toBe(false);
    expect(by.voiceRuntime.present).toBe(true);
  });

  it("asks Windows for neural processors by class, or by the word NPU on its own (not 'Input')", async () => {
    // measured on this PC: a case-blind 'NPU' match took "Microsoft Input Configuration Device" for the NPU
    const { run, calls } = fake({});
    await checkRequirements({ run, geniex: () => null, voiceRuntime: () => false, python: () => null, office: () => null, platform: "win32" });
    const q = calls.find((c) => c.includes("Get-PnpDevice"))!;
    expect(q).toContain("-cmatch '\\bNPU\\b'");
    expect(q).toContain("ComputeAccelerator");
    expect(q).not.toContain('"');
  });

  it("an NPU that Windows lists with an error is not counted as working", async () => {
    const { run } = fake({ "Get-PnpDevice": { code: 0, out: "Error|Qualcomm(R) Hexagon(TM) NPU" } });
    const st = await checkRequirements({ run, geniex: () => null, voiceRuntime: () => false, python: () => null, office: () => null, platform: "win32" });
    expect(st.find((s) => s.id === "npuDriver")).toMatchObject({ present: false, detail: "Qualcomm(R) Hexagon(TM) NPU: Windows reports a problem with its driver" });
  });
});

describe("GenieX's minimum version and the chat models", () => {
  const base = { run: fake({}).run, geniex: () => "C:/g/geniex.exe", voiceRuntime: () => true, python: () => null, office: () => null, platform: "win32" };
  it("reports an older GenieX as missing, naming the detected and required versions", async () => {
    const st = await checkRequirements({ ...base, geniexGate: async () => ({ state: "outdated", path: "C:/g/geniex.exe", detected: "0.10.0", required: "0.11.0", message: "GenieX v0.10.0 is installed, and MKMN needs v0.11.0 or newer." }) });
    expect(st.find((s) => s.id === "geniex")).toMatchObject({ present: false, detail: expect.stringMatching(/v0\.10\.0.*v0\.11\.0 or newer/) });
  });
  it("reports a compatible GenieX with its version and path", async () => {
    const st = await checkRequirements({ ...base, geniexGate: async () => ({ state: "ok", path: "C:/g/geniex.exe", detected: "0.11.0", required: "0.11.0", message: "" }) });
    expect(st.find((s) => s.id === "geniex")).toMatchObject({ present: true, detail: "v0.11.0 · C:/g/geniex.exe" });
  });
  it("reports no chat model as missing, and an unreadable list as missing with why", async () => {
    const none = await checkRequirements({ ...base, chatModels: async () => 0 });
    expect(none.find((s) => s.id === "models")).toMatchObject({ present: false, detail: expect.stringContaining("Settings → Models") });
    const some = await checkRequirements({ ...base, chatModels: async () => 3 });
    expect(some.find((s) => s.id === "models")).toMatchObject({ present: true, detail: "3 installed" });
    const unknown = await checkRequirements({ ...base, chatModels: async () => null });
    expect(unknown.find((s) => s.id === "models")?.present).toBe(false);
  });
  it("counts Foundry Local's installed chat models only, never its speech models", () => {
    // the Models list's Foundry entries are chat builds only (foundryCatalogEntries drops speech and embeddings)
    const foundry = [{ foundryInstalled: true }, { foundryInstalled: false }, { foundryInstalled: true }];
    expect(installedChatModels(2, foundry)).toBe(4);
    expect(installedChatModels(null, foundry)).toBe(2);
    expect(installedChatModels(0, [])).toBe(0);
    expect(installedChatModels(3, null)).toBe(3);
    expect(installedChatModels(null, null)).toBeNull();
  });
});

describe("installing a missing requirement", () => {
  it("runs winget for a package of the list and says when it worked", async () => {
    const { run, calls } = fake({ "winget install": { code: 0, out: "Successfully installed" } });
    expect(await installRequirement("foundry", { run })).toEqual({ ok: true, message: "Microsoft Foundry Local is installed." });
    expect(calls).toEqual([`winget ${wingetArgs("Microsoft.FoundryLocal").join(" ")}`]);
  });

  it("gives the real reason when winget fails, and points to the page when winget is not there", async () => {
    const failed = fake({ "winget install": { code: 2316632107, out: "No package found matching input criteria." } });
    const r = await installRequirement("python", { run: failed.run });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("No package found matching input criteria.");
    const none = { run: async () => ({ code: -4058, out: "spawn winget ENOENT" }) };
    const n = await installRequirement("libreoffice", none);
    expect(n.ok).toBe(false);
    expect(n.message).toContain("https://www.libreoffice.org/download/");
  });

  it("refuses an id that is not a package of the list", async () => {
    const { run, calls } = fake({});
    expect((await installRequirement("geniex", { run })).ok).toBe(false);
    expect((await installRequirement("anything; del *", { run })).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
