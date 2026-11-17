#requires -Version 5.1
<#
.SYNOPSIS
  Verifies that a built MKMN installer actually contains the components this build
  produced, and that every version declaration agrees.

.DESCRIPTION
  This is a release GATE, not a build step: it inspects what is already on disk and
  fails loudly when something would ship wrong.

  It checks, all against the single source of truth (package.json):
    - package.json, src-tauri\tauri.conf.json and src-tauri\Cargo.toml all declare the
      same version;
    - the compiled host (src-tauri\target\aarch64-pc-windows-msvc\release\MKMN.exe)
      exists and its FileVersion matches;
    - the renderer, the Node sidecar and the bundled Node runtime are present and
      non-empty (a missing sidecar or runtime makes the installed app unusable);
    - the installer artifact dist\MKMN-<version>-arm64-Setup.exe exists, is plausibly
      sized, and is at least as new as the host it packages.

  It NEVER installs, uninstalls, starts or stops anything: it only reads files. Run it
  after .\scripts\Build-Windows.ps1 and before publishing.

.PARAMETER HostExe
  Path to the compiled host. Defaults to the standard release output.

.PARAMETER Release
  Full release validation. In addition to the checks above, this verifies the
  installer's embedded PAYLOAD without installing it: scripts\nsis_extract.py
  unpacks the solid LZMA container read-only and proves that every file this
  build would package (the same File sources installer.nsi uses) is embedded
  byte-for-byte inside the installer. This is what catches a stale installer
  that timestamps cannot: an installer built before the last dist rebuild.
  Requires Python 3 on the machine (no third-party packages).

.PARAMETER PythonExe
  Python executable for the payload check. Defaults to auto-discovery
  (py launcher, python on PATH, the per-user ARM64 install).
#>
[CmdletBinding()]
param(
  [string]$HostExe = "src-tauri\target\aarch64-pc-windows-msvc\release\MKMN.exe",
  [switch]$Release,
  [string]$PythonExe = ""
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$failures = New-Object System.Collections.Generic.List[string]
function Check([string]$Name, [bool]$Ok, [string]$Detail) {
  $suffix = if ($Detail) { " - $Detail" } else { "" }
  if ($Ok) {
    Write-Host ("  [ok]   {0}{1}" -f $Name, $suffix)
  } else {
    Write-Host ("  [FAIL] {0}{1}" -f $Name, $suffix) -ForegroundColor Red
    $failures.Add($Name)
  }
}

Write-Host "MKMN installer validation"

# --- 1. Version declarations agree -----------------------------------------
$pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
$version = $pkg.version
if ([string]::IsNullOrWhiteSpace($version)) { throw "package.json has no version." }

$tauri = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
Check "tauri.conf.json version" ($tauri.version -eq $version) "tauri=$($tauri.version) package=$version"

$cargoRaw = Get-Content "src-tauri\Cargo.toml" -Raw
$cargoMatch = [regex]::Match($cargoRaw, '(?ms)^\[package\]\s*(.*?)(?=^\[|\z)')
if (-not $cargoMatch.Success) { throw "src-tauri\Cargo.toml has no [package] section." }
$cargoVerMatch = [regex]::Match($cargoMatch.Groups[1].Value, '(?m)^\s*version\s*=\s*"([^"]+)"')
$cargoVersion = if ($cargoVerMatch.Success) { $cargoVerMatch.Groups[1].Value } else { "" }
Check "Cargo.toml version" ($cargoVersion -eq $version) "cargo=$cargoVersion package=$version"

Write-Host ("  version under test: {0}" -f $version)

# --- 2. The compiled host ---------------------------------------------------
$exeTime = $null
if (-not (Test-Path $HostExe)) {
  Check "compiled host exists" $false $HostExe
} else {
  Check "compiled host exists" $true $HostExe
  $exeVer = (Get-Item $HostExe).VersionInfo.FileVersion
  Check "compiled host FileVersion" ($exeVer -like "$version*") "MKMN.exe=$exeVer package=$version"
  $exeTime = (Get-Item $HostExe).LastWriteTimeUtc
}

# --- 3. Packaged components -------------------------------------------------
$components = @(
  @{ Name = "renderer entry";         Path = "dist\renderer\index.html" },
  @{ Name = "renderer assets";        Path = "dist\renderer\assets" },
  @{ Name = "node sidecar";           Path = "dist\sidecar\main.js" },
  @{ Name = "sidecar core modules";   Path = "dist\core" },
  @{ Name = "sidecar shared modules"; Path = "dist\shared" },
  @{ Name = "bundled node runtime";   Path = "dist\sidecar-runtime\node.exe" },
  @{ Name = "bundled node closure";   Path = "dist\sidecar-runtime\node_modules" },
  @{ Name = "agent-desktop driver";   Path = "src-tauri\target\aarch64-pc-windows-msvc\release\agent-desktop.exe" }
)
foreach ($c in $components) {
  $p = $c.Path
  $exists = Test-Path $p
  $detail = $p
  if ($exists -and (Get-Item $p).PSIsContainer -eq $false) {
    $len = (Get-Item $p).Length
    $exists = $len -gt 0
    $detail = "$p ($len bytes)"
  }
  Check $c.Name $exists $detail
}

# --- 4. The installer artifact ---------------------------------------------
$installer = "dist\MKMN-$version-arm64-Setup.exe"
if (-not (Test-Path $installer)) {
  Check "installer artifact" $false $installer
} else {
  $info = Get-Item $installer
  Check "installer artifact" $true ("{0} ({1:N1} MB)" -f $installer, ($info.Length / 1MB))
  Check "installer size is plausible" ($info.Length -gt 25MB) ("{0:N1} MB" -f ($info.Length / 1MB))
  if ($exeTime) {
    # The installer must have been made from the host that is on disk now: a stale
    # installer packaging an old MKMN.exe is the failure this catches.
    Check "installer is newer than the host it packages" ($info.LastWriteTimeUtc -ge $exeTime) `
      ("installer={0:o} host={1:o}" -f $info.LastWriteTimeUtc, $exeTime)
  }
}

# --- 5. The installer's embedded payload (release gate) ---------------------
# Without -Release this stage is skipped: parsing 150+ MB of LZMA needs Python
# and a few seconds, which everyday dev loops should not pay.
if ($Release) {
  if (-not (Test-Path $installer)) {
    Check "installer payload" $false "no installer to inspect"
  } else {
    $py = $PythonExe
    if (-not $py) {
      foreach ($cand in @("py", "python", "$env:LOCALAPPDATA\Programs\Python\Python311-arm64\python.exe")) {
        $cmd = Get-Command $cand -ErrorAction SilentlyContinue
        if ($cmd) { $py = $cmd.Source; break }
      }
    }
    if (-not $py -or -not (Test-Path $py)) {
      Check "installer payload" $false "no Python 3 found for nsis_extract.py (pass -PythonExe)"
    } else {
      # Exactly the File sources installer.nsi packages; a source that does not
      # exist was not packaged (the sherpa modules are /nonfatal by design).
      $payloadSources = @(
        "dist\voice", "dist\sidecar", "dist\core", "dist\shared",
        "dist\sidecar-runtime", "dist\renderer",
        "src-tauri\target\aarch64-pc-windows-msvc\release\MKMN.exe",
        "src-tauri\target\aarch64-pc-windows-msvc\release\comctl32.dll",
        "src-tauri\target\aarch64-pc-windows-msvc\release\MKMN.exe.manifest",
        "src-tauri\target\aarch64-pc-windows-msvc\release\agent-desktop.exe",
        "build\icon.ico", "build\tray.png",
        "LICENSE", "THIRD_PARTY_LICENSES.txt", "THIRD_PARTY_NOTICES.md",
        "node_modules\sherpa-onnx-node", "node_modules\sherpa-onnx-win-arm64"
      ) | Where-Object { Test-Path $_ }
      Write-Host "  payload check: unpacking the installer read-only (this can take a minute)..."
      $env:PYTHONIOENCODING = "utf-8"
      $pyArgs = @("$PSScriptRoot\nsis_extract.py", "verify", $installer)
      foreach ($s in $payloadSources) { $pyArgs += @("--source", $s) }
      & $py @pyArgs
      Check "installer payload contains this build" ($LASTEXITCODE -eq 0) `
        "nsis_extract.py verify exit=$LASTEXITCODE (0 = every packaged file is embedded byte-for-byte)"
    }
  }
} else {
  Write-Host "  [skip] installer payload (use -Release for the full gate)"
}

Write-Host ""
if ($failures.Count -gt 0) {
  Write-Host ("INSTALLER VALIDATION FAILED ({0}): {1}" -f $failures.Count, ($failures -join "; ")) -ForegroundColor Red
  exit 1
}
Write-Host "INSTALLER VALIDATION PASSED" -ForegroundColor Green
Write-Host "Note: this verifies packaging contents and versions; it does not install or run the app."
exit 0
