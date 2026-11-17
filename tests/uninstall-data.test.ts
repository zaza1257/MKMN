import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * "Remove my data" must not claim success while the data stays. The removal
 * script suppressed every deletion error, always exited 0, and nothing checked
 * whether the data folders were gone, so the uninstall reported success with
 * the chats and settings still on disk.
 */

const nsi = readFileSync("installer.nsi", "utf8");
const block = nsi.slice(nsi.indexOf("; 5. The optional data removal"), nsi.indexOf("; 6. Required files must be gone"));

describe("the uninstaller's data removal", () => {
  it("the removal script reports whether the data folders are really gone", () => {
    // the success exit comes only AFTER the check that the folders are gone
    expect(block).toMatch(/if \(\(Test-Path \$\$root\) -or \(Test-Path \$\$wv\)\) \{ exit 1 \}; exit 0"`/);
  });

  it("a folder left behind is said, and the uninstall does not end as a plain success", () => {
    expect(block).toMatch(/\$\{If\} \$0 != 0/);
    expect(block).toMatch(/SetErrorLevel 3/);
    expect(block).toMatch(/MessageBox[^\n]*\/SD IDOK/);
  });
});

describe("the uninstaller's stop journal", () => {
  const stop = nsi.slice(nsi.indexOf("!insertmacro StopThisInstall un.SetInstallDirEnv"), nsi.indexOf("; 3. Shortcuts."));

  it("logs the stop sequence's own result, not a later command's", () => {
    // StopThisInstall leaves its result in $0; any Exec + Pop before the journal
    // line overwrites it, and the log then always read 0.
    const beforeLog = stop.slice(0, stop.indexOf("stop sequence exit code"));
    expect(beforeLog).not.toMatch(/nsExec::Exec|Pop \$0/);
  });

  it("writes no debug file to the person's TEMP folder", () => {
    expect(nsi).not.toMatch(/uninstall-dbg/);
  });
});
