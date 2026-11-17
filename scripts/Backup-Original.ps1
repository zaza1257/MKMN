#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$BackupDirectory
)
$ErrorActionPreference = "Stop"
$sourcePath = (Resolve-Path -LiteralPath $Source).Path.TrimEnd("\")
if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) { throw "Source must be a directory." }
$destination = [IO.Path]::GetFullPath($BackupDirectory).TrimEnd("\")
if ($destination.StartsWith($sourcePath + "\", [StringComparison]::OrdinalIgnoreCase) -or
    $destination.Equals($sourcePath, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Backup must not be inside or equal to the source directory."
}
if (Test-Path -LiteralPath $destination) { throw "Destination already exists. Choose a new empty backup path." }
Write-Warning "This copies the entire selected source, including models or private data if present. It can require substantial disk space. No data is uploaded."
if (-not $PSCmdlet.ShouldProcess($destination, "Copy complete local backup of $sourcePath")) { return }
New-Item -ItemType Directory -Path $destination | Out-Null
& robocopy $sourcePath $destination /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /XJ /NFL /NDL /NJH /NJS
$result = $LASTEXITCODE
if ($result -ge 8) { throw "Backup failed (robocopy exit $result). Keep the partial backup and investigate; the source was not deleted." }
Write-Host "Backup copied to $destination. Junction targets are excluded; back up their contents separately if needed."
Write-Host "The original source is unchanged. This is a copy backup, not a backup-integrity certification."
