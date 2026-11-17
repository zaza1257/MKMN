<#
.SYNOPSIS
  Resolve the real MKMN install and data paths instead of guessing them.

.DESCRIPTION
  One resolver for every script: an explicit -InstallDir wins, then the
  Software\MKMN InstallDir registry value written by the installer, then the
  image path of a running MKMN process. If none exists, installDir/exe are
  empty and installSource is "not-found": callers must stop, not invent a path.

  The data layout matches src/shared/paths.ts and src-tauri/src/paths.rs:
  %LOCALAPPDATA%\MKMN with Config, Workspace and Logs below it; the earlier
  sidecar folder %APPDATA%\MKMN is reported as legacyDataDir and is only read.

.PARAMETER InstallDir
  The installation folder (the one containing MKMN.exe). Optional.

.PARAMETER Json
  Emit one JSON object with lowercase keys. Exit code stays 0 so the caller can
  inspect installSource; a value of "not-found" means there is nothing to use.

.EXAMPLE
  powershell -NoProfile -File scripts\Resolve-MkmnPaths.ps1 -Json
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "",
  [switch]$Json
)

$ErrorActionPreference = "Stop"
# Captured output must be UTF-8 without a BOM; JSON.parse rejects a BOM.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$installSource = "parameter"
if (-not $InstallDir) {
  $installSource = "registry"
  foreach ($hive in @("HKCU:", "HKLM:")) {
    try {
      $v = (Get-ItemProperty -Path "$hive\Software\MKMN" -Name InstallDir -ErrorAction Stop).InstallDir
    } catch {
      $v = $null
    }
    if ($v -and (Test-Path -LiteralPath (Join-Path $v "MKMN.exe"))) {
      $InstallDir = $v
      break
    }
  }
}

if (-not $InstallDir) {
  $installSource = "process"
  $running = Get-Process -Name "MKMN" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path } |
    Select-Object -First 1
  if ($running) {
    $InstallDir = Split-Path -Parent $running.Path
  }
}

if ($InstallDir) {
  # Keep an absolute path exactly as the caller wrote it (a temp path may use an 8.3
  # short name); only make a relative parameter absolute.
  if (-not [IO.Path]::IsPathRooted($InstallDir)) {
    $InstallDir = [IO.Path]::GetFullPath($InstallDir)
  }
} else {
  $installSource = "not-found"
}
$exe = ""
if ($InstallDir) { $exe = Join-Path $InstallDir "MKMN.exe" }

if (-not $env:LOCALAPPDATA -and -not $env:USERPROFILE) {
  throw "Neither LOCALAPPDATA nor USERPROFILE is set: cannot resolve the MKMN data folder."
}
if (-not $env:APPDATA -and -not $env:USERPROFILE) {
  throw "Neither APPDATA nor USERPROFILE is set: cannot resolve the legacy MKMN folder."
}
$localBase = $env:LOCALAPPDATA
if (-not $localBase) { $localBase = Join-Path $env:USERPROFILE "AppData\Local" }
$roamingBase = $env:APPDATA
if (-not $roamingBase) { $roamingBase = Join-Path $env:USERPROFILE "AppData\Roaming" }

$dataDir = Join-Path $localBase "MKMN"
$configDir = Join-Path $dataDir "Config"
$workspaceDir = Join-Path $dataDir "Workspace"
$logsDir = Join-Path $dataDir "Logs"

$paths = [ordered]@{
  installDir       = $InstallDir
  installSource    = $installSource
  exe              = $exe
  dataDir          = $dataDir
  configDir        = $configDir
  settingsFile     = Join-Path $configDir "settings.json"
  hardwareFile     = Join-Path $configDir "hardware.json"
  customModelsFile = Join-Path $configDir "custom-models.json"
  workspaceDir     = $workspaceDir
  logsDir          = $logsDir
  legacyDataDir    = Join-Path $roamingBase "MKMN"
}

if ($Json) {
  # Write-Output, not [Console]::Out: the acceptance scripts capture this through
  # `& $resolver -Json | ConvertFrom-Json`, and a direct console write bypasses that
  # pipeline. The console encoding is UTF-8 without a BOM (set at the top), so a
  # spawned capture stays parseable too.
  Write-Output ($paths | ConvertTo-Json -Compress)
  exit 0
}
Write-Host "install:   $InstallDir ($installSource)"
Write-Host "exe:       $exe"
Write-Host "data:      $dataDir"
Write-Host "config:    $configDir"
Write-Host "workspace: $workspaceDir"
Write-Host "logs:      $logsDir"
Write-Host "legacy:    $($paths.legacyDataDir)"
exit 0
