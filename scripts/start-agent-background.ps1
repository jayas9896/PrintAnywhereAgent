param(
    [string]$DataDir = "",
    [int]$Port = 0,
    [string]$EnvFile = "",
    [switch]$OpenUi
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$runScript = Join-Path $PSScriptRoot "run-agent.ps1"

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

if (-not $listener) {
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
