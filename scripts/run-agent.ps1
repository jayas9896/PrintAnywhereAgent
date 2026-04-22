param(
    [string]$DataDir = "",
    [int]$Port = 43100
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js was not found on PATH. Install Node.js 20+ first."
}

if (-not (Test-Path "$repoRoot/dist/index.js")) {
    throw "dist/index.js is missing. Run 'npm install' and 'npm run build' first."
}

if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = Join-Path $repoRoot "data"
}

if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
}

$env:PRINTANYWHERE_AGENT_DATA_DIR = $DataDir
$env:PRINTANYWHERE_AGENT_PORT = [string]$Port

Write-Host "Starting PrintAnywhere Agent"
Write-Host "Repo: $repoRoot"
Write-Host "Data directory: $DataDir"
Write-Host "UI: http://127.0.0.1:$Port"

node "$repoRoot/dist/index.js"
