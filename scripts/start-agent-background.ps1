param(
    [string]$DataDir = "",
    [int]$Port = 0,
    [string]$EnvFile = "",
    [switch]$OpenUi
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$runScript = Join-Path $PSScriptRoot "run-agent.ps1"

function Normalize-PathForComparison {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }

    try {
        return ([System.IO.Path]::GetFullPath($Path)).TrimEnd(
            [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
        )
    } catch {
        return $Path.TrimEnd([char[]]@("\", "/"))
    }
}

function Get-ProcessCommandLine {
    param([int]$ProcessId)

    try {
        return [string](Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue).CommandLine
    } catch {
        return ""
    }
}

function Test-CurrentRepoRuntime {
    param([string]$CommandLine, [string]$RepoRoot)

    if ([string]::IsNullOrWhiteSpace($CommandLine)) {
        return $false
    }

    $normalizedRepo = Normalize-PathForComparison -Path $RepoRoot
    return $CommandLine.IndexOf($normalizedRepo, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Test-PrintAnywhereRuntime {
    param([string]$CommandLine)

    if ([string]::IsNullOrWhiteSpace($CommandLine)) {
        return $false
    }

    $installRoot = Join-Path $env:LOCALAPPDATA "Dhruvanta Systems\PrintAnywhereAgent"
    return $CommandLine -match "PrintAnywhereAgent" -or
        $CommandLine -match "printanywhere-agent-v" -or
        $CommandLine -match "run-agent\.ps1" -or
        $CommandLine -match "dist[\\/]+index\.js" -or
        $CommandLine -match "node-win-x64[\\/]+node\.exe" -or
        (-not [string]::IsNullOrWhiteSpace($installRoot) -and
            $CommandLine.IndexOf($installRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
}

function Stop-StaleAgentRuntimeForPort {
    param([int]$Port, [string]$RepoRoot)

    $listener = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -gt 0 -and $_.State -eq "Listen" } |
        Select-Object -First 1

    if (-not $listener) {
        return $false
    }

    $ownerPid = [int]$listener.OwningProcess
    $commandLine = Get-ProcessCommandLine -ProcessId $ownerPid
    if (Test-CurrentRepoRuntime -CommandLine $commandLine -RepoRoot $RepoRoot) {
        return $true
    }

    if (-not (Test-PrintAnywhereRuntime -CommandLine $commandLine)) {
        return $true
    }

    Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
    for ($attempt = 0; $attempt -lt 10; $attempt += 1) {
        $stillListening = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
            Where-Object { $_.OwningProcess -gt 0 -and $_.State -eq "Listen" } |
            Select-Object -First 1
        if (-not $stillListening) {
            return $false
        }
        Start-Sleep -Milliseconds 500
    }

    return $true
}

function Resolve-DefaultDataDir {
    param([string]$RepoRoot)

    $expectedRoot = Join-Path $env:LOCALAPPDATA "Dhruvanta Systems\PrintAnywhereAgent"
    if ($RepoRoot.StartsWith($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        return Join-Path $expectedRoot "data"
    }

    return Join-Path $RepoRoot "data"
}

if ($Port -le 0) {
    $Port = 43100
}

if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = Resolve-DefaultDataDir -RepoRoot $repoRoot
}

if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile = Join-Path $repoRoot "config\agent.env"
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$listener = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -gt 0 -and $_.State -eq "Listen" } |
    Select-Object -First 1

$listenerIsCurrentRuntime = $false
if ($listener) {
    $listenerIsCurrentRuntime = Stop-StaleAgentRuntimeForPort -Port $Port -RepoRoot $repoRoot
}

if (-not $listenerIsCurrentRuntime) {
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$runScript`"",
        "-DataDir", "`"$DataDir`"",
        "-Port", $Port
    )

    if (Test-Path $EnvFile) {
        $arguments += @("-EnvFile", "`"$EnvFile`"")
    }

    Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList $arguments `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden
}

if ($OpenUi) {
    Start-Process "http://127.0.0.1:$Port"
}
