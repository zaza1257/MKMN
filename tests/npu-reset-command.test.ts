import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { npuResetInnerScript, npuResetLaunchCommand } from "../src/core/npuReset";

/**
 * The manual NPU reset launches an elevated PowerShell that restarts the NPU
 * device. The old command embedded a script with single quotes inside a
 * single-quoted argument: PowerShell still parsed it, but as another command —
 * the argument ended at "-match " and the rest became a pipeline into commands
 * named Hexagon and Neural. The inner script also exited 0 when it found no device
 * or a restart failed.
 */

/** Parse with PowerShell's own parser: errors, and the shape of the first statement. */
function shape(command: string): { errors: number; statements: number; firstElements: number } {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$e=$null; $a=[System.Management.Automation.Language.Parser]::ParseInput($env:MKMN_CMD, [ref]$null, [ref]$e); " +
    "$s=$a.EndBlock.Statements; $first=$s[0]; $n = if ($first.Right) { $first.Right.PipelineElements.Count } else { $first.PipelineElements.Count }; " +
    "'{0} {1} {2}' -f $e.Count, $s.Count, $n"],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, MKMN_CMD: command } });
  const [errors, statements, firstElements] = r.stdout.trim().split(/\s+/).map(Number);
  return { errors, statements, firstElements };
}

const onWindows = process.platform === "win32";

describe("the NPU reset command", () => {
  it("launches as ONE command: one assignment of one Start-Process, then the exit code", () => {
    const cmd = npuResetLaunchCommand();
    expect(cmd).toMatch(/-EncodedCommand/);
    if (onWindows) expect(shape(cmd)).toEqual({ errors: 0, statements: 2, firstElements: 1 });
  });

  it("carries the inner script exactly (the encoded argument decodes to it)", () => {
    const b64 = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(npuResetLaunchCommand())?.[1];
    expect(b64).toBeTruthy();
    expect(Buffer.from(b64!, "base64").toString("utf16le")).toBe(npuResetInnerScript());
  });

  it("the inner script parses, and fails when no device is found or a restart fails", () => {
    const inner = npuResetInnerScript();
    if (onWindows) expect(shape(inner).errors).toBe(0);
    expect(inner).toMatch(/exit 3/); // no NPU device found
    expect(inner).toMatch(/\$LASTEXITCODE/); // each restart's result is read
    expect(inner).not.toMatch(/else \{ exit 0 \}/);
  });
});
