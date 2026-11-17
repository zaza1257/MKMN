/** Measures the wall time of the two PowerShell probes the sidecar used to spawn:
 * `node scripts/bench-probe-spawns.ts` (run on the machine, PowerShell 5.1). */
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";

const NPU_UTIL_SCRIPT = String.raw`
$ErrorActionPreference='SilentlyContinue'
$sets = @(Get-Counter -ListSet '*NPU*','*Neural*','*Hexagon*' | Sort-Object CounterSetName -Unique)
$names = @($sets | ForEach-Object { $_.CounterSetName })
$paths = @(); foreach ($s in $sets) { $paths += $s.PathsWithInstances }
$adapters = @()
Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\DirectX' | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath
  if ($p.Description -and $null -ne $p.AdapterLuid) {
    $l = [int64]$p.AdapterLuid
    $adapters += [pscustomobject]@{ name = [string]$p.Description; luid = ('luid_0x{0:X8}_0x{1:X8}' -f (($l -shr 32) -band 0xFFFFFFFF), ($l -band 0xFFFFFFFF)).ToLower() }
  }
}
$found = @{}
if (-not $paths) {
  foreach ($a in $adapters) { if ($a.name -match 'NPU|Hexagon|Neural|AI Boost|Compute') { $found[$a.luid] = $a.name } }
  foreach ($e in @((Get-Counter -ListSet 'GPU Engine').PathsWithInstances)) {
    if ($e -match 'engtype_NPU' -and $e -match 'luid_0x[0-9a-fA-F]+_0x[0-9a-fA-F]+') {
      $k = $matches[0].ToLower()
      if (-not $found.ContainsKey($k)) { $found[$k] = 'NPU engine counters' }
    }
  }
}
if ($found.Count -gt 0) {
  foreach ($set in 'GPU Engine','GPU Adapter Memory','GPU Process Memory') {
    foreach ($x in @((Get-Counter -ListSet $set).PathsWithInstances)) {
      $lx = $x.ToLower()
      foreach ($k in $found.Keys) { if ($lx.Contains($k)) { $paths += $x; break } }
    }
  }
}
if ($paths) {
  $c = @(Get-Counter -Counter $paths -SampleInterval 1 -MaxSamples 2)
}
[pscustomobject]@{ sets = $names.Count } | ConvertTo-Json -Compress
`;

const BATTERY_SCRIPT = String.raw`
$s = Get-CimInstance -Namespace root\wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue | Select-Object -First 1;
$f = Get-CimInstance -Namespace root\wmi -ClassName BatteryFullChargedCapacity -ErrorAction SilentlyContinue | Select-Object -First 1;
if ($s) { [pscustomobject]@{ remaining = $s.RemainingCapacity; full = $f.FullChargedCapacity } | ConvertTo-Json -Compress } else { '{}' }
`;

function ps(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`], { timeout: 20000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

async function time(name: string, fn: () => Promise<void>): Promise<number> {
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  console.log(`${name}: ${ms.toFixed(0)} ms`);
  return ms;
}

await time("empty PowerShell spawn", () => ps(""));
const bat = await time("BATTERY_SCRIPT", () => ps(BATTERY_SCRIPT));
const npu = await time("NPU_UTIL_SCRIPT", () => ps(NPU_UTIL_SCRIPT));
console.log(`selectForRequest before (battery then NPU, sequential): ${(bat + npu).toFixed(0)} ms added latency`);
