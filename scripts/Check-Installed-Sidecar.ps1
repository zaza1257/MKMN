#requires -Version 5.1
<#
.SYNOPSIS
  Drives the installed sidecar bundle over its stdin/stdout protocol and prints each answer.

.DESCRIPTION
  One JSON per line: { "t":"req", "id", "method", "args" }. The script starts the sidecar the
  installed app runs, sends the release methods, reads the answers, and stops the process.

.EXAMPLE
  powershell -NoProfile -File scripts\Check-Installed-Sidecar.ps1
#>
[CmdletBinding()]
param(
  [string]$Sidecar = ""
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not $Sidecar) {
  $resolved = powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Resolve-MkmnPaths.ps1") -Json | ConvertFrom-Json
  $Sidecar = Join-Path $resolved.installDir "Runtime\sidecar\main.js"
}
if (-not (Test-Path $Sidecar)) { throw "sidecar not found: $Sidecar" }
$node = Join-Path (Split-Path (Split-Path $Sidecar -Parent) -Parent) "sidecar-runtime\node.exe"
if (-not (Test-Path $node)) { $node = "node" }

$methods = @(
  @{ method = "routerStatus"; args = @() },
  @{ method = "routerTest"; args = @("I want a snake game in html") },
  @{ method = "benchState"; args = @() },
  @{ method = "npuTestRoster"; args = @() },
  @{ method = "labState"; args = @() },
  @{ method = "npuResetStatus"; args = @() }
)
$reqs = foreach ($m in $methods) { @{ t = "req"; id = $m.method; method = $m.method; args = $m.args } | ConvertTo-Json -Compress -Depth 4 }
$inputText = $reqs -join "`n"

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.Arguments = "`"$Sidecar`""
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$p = [System.Diagnostics.Process]::Start($psi)
$p.StandardInput.WriteLine($inputText)
$p.StandardInput.Flush()
$p.StandardInput.Close()

$deadline = [DateTime]::UtcNow.AddSeconds(60)
$answers = @{}
while ([DateTime]::UtcNow -lt $deadline -and -not $p.StandardOutput.EndOfStream) {
  $line = $p.StandardOutput.ReadLine()
  if (-not $line) { continue }
  try { $msg = $line | ConvertFrom-Json } catch { continue }
  if ($msg.t -eq "res") { $answers[$msg.id] = $msg }
  if ($answers.Count -ge $methods.Count) { break }
}
if (-not $p.HasExited) { try { $p.Kill() } catch { try { taskkill /F /T /PID $p.Id 2>$null | Out-Null } catch { } } }
foreach ($m in $methods) {
  $a = $answers[$m.method]
  if ($null -eq $a) { "{0}: NO ANSWER" -f $m.method; continue }
  $res = ($a.result | ConvertTo-Json -Compress -Depth 3)
  if ($res -and $res.Length -gt 220) { $res = $res.Substring(0, 220) + "..." }
  "{0}: ok={1} {2}" -f $m.method, $a.ok, $res
}
