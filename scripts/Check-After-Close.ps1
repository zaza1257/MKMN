<#
.SYNOPSIS
  Check what is left after MKMN was closed, using real process records.

.DESCRIPTION
  The report showed MKMN entries in Get-Process whose records had no image
  path and no threads: Windows hang-report leftovers, not running instances. This
  check counts only a process with a readable Path and at least one Threads entry
  as live, and reports pathless/0-thread records as zombies.

  Paths come from Resolve-MkmnPaths.ps1, never from a guessed install folder.

.PARAMETER InstallDir
  Forwarded to the resolver. Optional.

.PARAMETER SelfTest
  Classify three synthetic records (one live, two zombies) and exercise the
  clean-exit marker under MKMN_AFTER_CLOSE_SELFTEST_DIR. No real process is read.

.PARAMETER Json
  Emit one JSON object with lowercase keys.

.PARAMETER MarkerMaxAgeSeconds
  How recent the last-clean-exit marker must be for a normal check (default 300).

.EXAMPLE
  powershell -NoProfile -File scripts\Check-After-Close.ps1 -Json
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "",
  [switch]$SelfTest,
  [switch]$Json,
  [int]$MarkerMaxAgeSeconds = 300
)

$ErrorActionPreference = "Stop"
# Captured output must be UTF-8 without a BOM; JSON.parse rejects a BOM.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# A real process has a readable image Path and at least one Threads entry. A record
# with neither is a Windows hang-report leftover, never a running instance.
function Measure-ProcessState {
  param(
    [object[]]$Records,
    [string]$ExpectedExe
  )
  $live = 0
  $zombies = 0
  $foreign = 0
  foreach ($r in @($Records)) {
    if ($null -eq $r) { continue }
    $path = ""
    if ($r.PSObject.Properties.Match("Path").Count -gt 0 -and $r.Path) {
      try { $path = [string]$r.Path } catch { $path = "" }
    }
    $threads = 0
    if ($r.PSObject.Properties.Match("Threads").Count -gt 0 -and $null -ne $r.Threads) {
      $threads = @($r.Threads).Count
    }
    if (-not $path -or $threads -eq 0) {
      $zombies++
      continue
    }
    if (-not $ExpectedExe -or $path.Equals($ExpectedExe, [StringComparison]::OrdinalIgnoreCase)) {
      $live++
    } else {
      $foreign++
    }
  }
  [pscustomobject]@{ live = $live; zombies = $zombies; foreign = $foreign }
}

function Read-CleanExitMarker {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Write-Result {
  param([System.Collections.Specialized.OrderedDictionary]$Result, [switch]$AsJson)
  if ($AsJson) {
    [Console]::Out.WriteLine(($Result | ConvertTo-Json -Compress))
    return
  }
  foreach ($key in $Result.Keys) { Write-Host ("{0}: {1}" -f $key, $Result[$key]) }
}

if ($SelfTest) {
  $records = @(
    [pscustomobject]@{ Id = 100; Path = "C:\selftest\MKMN.exe"; Threads = @(1, 2, 3, 4) },
    [pscustomobject]@{ Id = 101; Path = $null; Threads = @() },
    [pscustomobject]@{ Id = 102; Path = ""; Threads = @() }
  )
  $state = Measure-ProcessState -Records $records -ExpectedExe "C:\selftest\MKMN.exe"

  $dir = $env:MKMN_AFTER_CLOSE_SELFTEST_DIR
  if (-not $dir) { $dir = Join-Path $env:TEMP "mkmn-after-close-selftest" }
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $markerPath = Join-Path $dir "last-clean-exit.json"
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $markerJson = [ordered]@{
    clean = $true; pid = 100; at = $now; inventory = @("selftest")
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($markerPath, $markerJson)
  $marker = Read-CleanExitMarker -Path $markerPath

  $ok = ($state.live -eq 1) -and ($state.zombies -eq 2) -and ($marker.clean -eq $true)
  $result = [ordered]@{
    ok        = $ok
    live      = $state.live
    zombies   = $state.zombies
    foreign   = $state.foreign
    cleanExit = [bool]($marker.clean)
    check     = "selftest"
  }
  Write-Result -Result $result -AsJson:$Json
  if ($ok) { exit 0 } else { exit 1 }
}

# --- real check --------------------------------------------------------------
$resolver = Join-Path $PSScriptRoot "Resolve-MkmnPaths.ps1"
if (-not (Test-Path -LiteralPath $resolver)) {
  throw "scripts\Resolve-MkmnPaths.ps1 is missing; cannot resolve the install and log paths."
}
$resolved = & $resolver -InstallDir $InstallDir -Json | ConvertFrom-Json

$markerPath = Join-Path $resolved.logsDir "last-clean-exit.json"   # the clean-exit marker
$marker = Read-CleanExitMarker -Path $markerPath
$markerAge = $null
if ($marker -and $null -ne $marker.at) {
  $markerAge = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [long]$marker.at
}
$markerFresh = ($marker -and $marker.clean -eq $true -and $null -ne $markerAge -and $markerAge -ge -5 -and $markerAge -le $MarkerMaxAgeSeconds)

$records = @()
foreach ($p in @(Get-Process -Name "MKMN" -ErrorAction SilentlyContinue)) {
  $path = ""
  try { $path = $p.Path } catch { $path = "" }
  $records += [pscustomobject]@{ Id = $p.Id; Path = $path; Threads = @($p.Threads) }
}
$state = Measure-ProcessState -Records $records -ExpectedExe $resolved.exe

$runtimeDir = Join-Path $resolved.installDir "Runtime"
$nodes = @()
foreach ($p in @(Get-Process -Name "node" -ErrorAction SilentlyContinue)) {
  $path = ""
  try { $path = $p.Path } catch { $path = "" }
  if ($path -and $path.StartsWith($runtimeDir, [StringComparison]::OrdinalIgnoreCase)) {
    $nodes += [pscustomobject]@{ Id = $p.Id; Path = $path; Threads = @($p.Threads) }
  }
}
$nodeState = Measure-ProcessState -Records $nodes -ExpectedExe ""

$ok = ($state.live -eq 0) -and ($nodeState.live -eq 0) -and $markerFresh
$result = [ordered]@{
  ok               = $ok
  live             = $state.live
  zombies          = $state.zombies
  foreign          = $state.foreign
  sidecars         = $nodeState.live
  sidecarZombies   = $nodeState.zombies
  cleanExit        = [bool]($marker -and $marker.clean -eq $true)
  markerAgeSeconds = $markerAge
  installDir       = $resolved.installDir
  exe              = $resolved.exe
  marker           = $markerPath
}
Write-Result -Result $result -AsJson:$Json
if ($ok) { exit 0 } else { exit 1 }
