// What the installer itself puts in place: the WebView2 runtime when Windows has none, and the speech runtime always.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const nsi = readFileSync("installer.nsi", "utf8");

describe("the installer's requirements", () => {
  it("installs WebView2 from Microsoft when Windows records no version of it", () => {
    // the runtime's client key, in both registry views and per user
    expect(nsi).toContain("{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}");
    expect(nsi).toMatch(/ReadRegStr \$1 HKLM "\$\{WEBVIEW2_CLIENT32\}" "pv"/);
    expect(nsi).toMatch(/ReadRegStr \$1 HKCU "\$\{WEBVIEW2_CLIENT\}" "pv"/);
    // Microsoft's evergreen bootstrapper, run only with a valid Microsoft signature
    expect(nsi).toContain("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
    expect(nsi).toMatch(/Get-AuthenticodeSignature[\s\S]*Status -ne 'Valid'[\s\S]*O=Microsoft Corporation/);
    expect(nsi).toContain("-ArgumentList '/silent','/install'");
  });

  it("refuses anything but Windows 11 on ARM64 before a file is written, and says what it needs", () => {
    const init = nsi.slice(nsi.indexOf("Function .onInit"), nsi.indexOf("FunctionEnd", nsi.indexOf("Function .onInit")));
    expect(init).toMatch(/\$\{IfNot\} \$\{IsNativeARM64\}[\s\S]*?Abort/);
    expect(init).toMatch(/\$\{IfNot\} \$\{AtLeastBuild\} 22000[\s\S]*?Abort/);
    // a silent install must never hang on the message
    for (const l of init.split("\n").filter((x) => x.includes("MessageBox"))) expect(l).toContain("/SD IDOK");
    const welcome = nsi.match(/MUI_WELCOMEPAGE_TEXT "([^"]*)"/)![1];
    for (const w of ["Windows 11", "ARM64", "GenieX v0.11.0 or newer", "NPU driver", "WebView2", "speech runtime"]) expect(welcome).toContain(w);
  });

  it("never ships an installer without the speech runtime", () => {
    const voice = nsi.split(/\r?\n/).filter((l) => /sherpa-onnx/.test(l) && /^\s*File\b/.test(l));
    expect(voice.length).toBe(2);
    for (const l of voice) expect(l).not.toContain("/nonfatal");
  });
});
