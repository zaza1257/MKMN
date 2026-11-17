// The manual NPU reset: an elevated PowerShell restarts the NPU device.
//
// The inner script travels as -EncodedCommand (UTF-16LE, base64), so no quote in
// it can break the launching command, and it reports the truth through its exit
// code: 0 when every NPU device restarted (3010 = restarted, a reboot finishes it),
// 3 when no NPU device was found, 1 when a restart failed.

/** The script the elevated PowerShell runs. */
export function npuResetInnerScript(): string {
  return [
    "$devs = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'NPU|Hexagon|Neural' })",
    "if ($devs.Count -eq 0) { exit 3 }",
    "$failed = 0",
    "foreach ($d in $devs) {",
    "  & pnputil.exe /restart-device $d.InstanceId | Out-Null",
    "  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) { $failed++ }",
    "}",
    "if ($failed -gt 0) { exit 1 }",
    "exit 0",
  ].join("\n");
}

/** UTF-16LE base64, the form -EncodedCommand reads. */
function encoded(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** The command the sidecar's own PowerShell runs: starts the elevated one (UAC) and
 *  prints its exit code. Base64 holds no quote, so the argument list cannot break. */
export function npuResetLaunchCommand(): string {
  const b64 = encoded(npuResetInnerScript());
  return `$p = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${b64}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; $p.ExitCode`;
}

/** What an exit code of the elevated script means, in words. */
export function npuResetOutcome(code: string): { ok: boolean; message: string } {
  if (code === "0") return { ok: true, message: "The NPU device was restarted." };
  if (code === "3") return { ok: false, message: "No NPU device was found to restart. Restart the PC if the NPU stays stuck." };
  if (code === "1") return { ok: false, message: "Windows could not restart the NPU device. Restart the PC to clear it." };
  return { ok: false, message: `The NPU reset did not complete (${code || "no answer"}). Try again or restart the PC.` };
}
