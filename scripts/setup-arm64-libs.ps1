# Sets up src-tauri\native-sdk (an NTFS junction) so the native ARM64 build links
# against this machine's Windows SDK import libraries without any personal absolute
# path being committed to the repository.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/setup-arm64-libs.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/setup-arm64-libs.ps1 -Source "D:\sdk-libs"

param(
    [string]$Source = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$link = Join-Path $repoRoot "src-tauri\native-sdk"

# Candidate sources, in preference order:
# 1. an explicitly passed -Source directory
# 2. MKMN_ARM64_LIBS environment variable
# 3. the machine's existing ~/.arm64-libs directory
$candidates = @()
if ($Source -ne "") { $candidates += $Source }
if ($env:MKMN_ARM64_LIBS) { $candidates += $env:MKMN_ARM64_LIBS }
$candidates += (Join-Path $env:USERPROFILE ".arm64-libs")

$found = $null
foreach ($c in $candidates) {
    if ($c -and (Test-Path (Join-Path $c "lib"))) { $found = $c; break }
}

if (-not $found) {
    Write-Error @"
No ARM64 import-library directory found (looked for a 'lib' subfolder in:
  -Source argument, `$env:MKMN_ARM64_LIBS, ~\.arm64-libs).
Install the Windows SDK ARM64 import libraries and pass the directory via -Source.
"@
}

if (Test-Path $link) {
    $item = Get-Item $link -Force
    if ($item.LinkType -eq "Junction" -or $item.LinkType -eq "SymbolicLink") {
        $currentTarget = $item.Target
        Write-Host "native-sdk junction already exists -> $currentTarget"
        if ($currentTarget -like $found -or $found -like $currentTarget) {
            Write-Host "Already pointing at the right place; nothing to do."
            exit 0
        }
        # Repoint it at the requested source.
        cmd /C rmdir "$link" | Out-Null
    }
    else {
        Write-Error "$link exists and is a real directory; remove it before running this script."
    }
}

cmd /C mklink /J "$link" "$found" | Out-Null
if (-not (Test-Path (Join-Path $link "lib"))) {
    Write-Error "Junction created but '$link\lib' is still missing."
}
Write-Host "Created junction: $link -> $found"
