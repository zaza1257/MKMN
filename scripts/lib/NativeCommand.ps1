#requires -Version 5.1
<#
.SYNOPSIS
  Runs one native command and judges it by its real exit code.

.DESCRIPTION
  Windows PowerShell 5.1 turns a native command's stderr lines into error records when
  the stream is redirected, and `$ErrorActionPreference = "Stop"` then throws on a
  harmless warning even though the process exited 0 (the reported LNK4099 linker
  warning failed a successful build). This helper:
    - sets its OWN ErrorActionPreference inside its function scope, so the caller's
      preference is untouched before, during and after the call;
    - merges stdout and stderr into one log file, written as UTF-8 without a BOM;
    - returns the process's real exit code, never the presence of text on stderr;
    - writes `<LogPath>.result.json` with lowercase `ok` / `exitCode` for scripts and
      tools that read the outcome without loading PowerShell.

  A nonzero exit is NOT thrown: the result object says Ok = $false and the caller
  decides the message. This keeps one failure path and one exit code everywhere.
#>
function Invoke-NativeCommand {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string]$LogPath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = (Get-Location).Path,
        # Show the command's output while it runs (the build script asks for this; a caller
        # capturing the helper's return value does not, so its own output stays parseable).
        [switch]$Echo
    )

    $command = Get-Command -Name $FilePath -ErrorAction SilentlyContinue
    if (-not $command) {
        if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
            throw "Invoke-NativeCommand: '$FilePath' was not found."
        }
    }

    $logFull = [System.IO.Path]::GetFullPath($LogPath)
    $logDir = [System.IO.Path]::GetDirectoryName($logFull)
    if ($logDir -and -not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    }
    $resultPath = "$logFull.result.json"

    # The caller's preference is read here, and changed only in this function's scope.
    $previous = $ErrorActionPreference
    $lines = New-Object System.Collections.Generic.List[string]
    $exitCode = 1
    $writer = New-Object System.IO.StreamWriter($logFull, $false, (New-Object System.Text.UTF8Encoding($false)))
    try {
        $ErrorActionPreference = "Continue"
        Push-Location -LiteralPath $WorkingDirectory
        try {
            & $FilePath @Arguments 2>&1 | ForEach-Object {
                $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { [string]$_ }
                $lines.Add($line)
                $writer.WriteLine($line)
                if ($Echo) { Write-Host $line }
            }
            if ($null -ne $LASTEXITCODE) { $exitCode = [int]$LASTEXITCODE }
        }
        finally {
            Pop-Location
        }
    }
    finally {
        $writer.Dispose()
        $ErrorActionPreference = $previous
    }

    $ok = ($exitCode -eq 0)
    $document = [ordered]@{
        ok = $ok
        exitCode = $exitCode
        filePath = $FilePath
        arguments = @($Arguments)
        logPath = $logFull
        finishedAt = (Get-Date).ToString("o")
    }
    $json = $document | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($resultPath, $json, (New-Object System.Text.UTF8Encoding($false)))

    return [pscustomobject]@{
        Ok = $ok
        ExitCode = $exitCode
        LogPath = $logFull
        ResultPath = $resultPath
        Output = ($lines -join [Environment]::NewLine)
    }
}
