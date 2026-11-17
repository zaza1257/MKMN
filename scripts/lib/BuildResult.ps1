#requires -Version 5.1
<#
.SYNOPSIS
  Writes the one result file of a complete build.

.DESCRIPTION
  A build is a sequence of native commands. Each command already writes its own
  `<log>.result.json` through NativeCommand.ps1; this helper adds the summary the caller
  reads without loading PowerShell:

    - `ok` and `exitCode` say whether the whole build passed;
    - `version`, `startedAt` and `finishedAt` place it in time;
    - `failure` carries the message of the first real failure (empty on success);
    - `steps` lists every command with its name, outcome, log and result file, so a
      failing step is found without reading the console.

  The file is always UTF-8 without a BOM and is written even when a step fails, so the
  caller sees the same shape on both paths.
#>
function New-BuildResultDocument {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][bool]$Ok,
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][datetime]$StartedAt,
        [object[]]$Steps = @(),
        [string]$Failure = "",
        [string]$Installer = ""
    )

    $normalized = @($Steps | ForEach-Object {
        [ordered]@{
            name = [string]$_.name
            ok = [bool]$_.ok
            exitCode = [int]$_.exitCode
            logPath = [string]$_.logPath
            resultPath = [string]$_.resultPath
        }
    })
    return [ordered]@{
        ok = $Ok
        exitCode = if ($Ok) { 0 } else { 1 }
        version = $Version
        startedAt = $StartedAt.ToUniversalTime().ToString("o")
        finishedAt = (Get-Date).ToUniversalTime().ToString("o")
        failure = $Failure
        installer = $Installer
        steps = $normalized
    }
}

function Write-BuildResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Document
    )

    $full = [System.IO.Path]::GetFullPath($Path)
    $dir = [System.IO.Path]::GetDirectoryName($full)
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $json = $Document | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($full, $json, (New-Object System.Text.UTF8Encoding($false)))
}
