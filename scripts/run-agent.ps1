param(
    [string]$DataDir = "",
    [int]$Port = 0,
    [string]$EnvFile = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Import-EnvFile {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        throw "Environment file '$Path' was not found."
    }

    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $separatorIndex = $line.IndexOf("=")
            if ($separatorIndex -ge 1) {
                $name = $line.Substring(0, $separatorIndex).Trim()
                $value = $line.Substring($separatorIndex + 1).Trim()

                if (
                    ($value.StartsWith('"') -and $value.EndsWith('"')) -or
                    ($value.StartsWith("'") -and $value.EndsWith("'"))
                ) {
                    $value = $value.Substring(1, $value.Length - 2)
                }

                [Environment]::SetEnvironmentVariable($name, $value, "Process")
            }
        }
    }
}

function Resolve-NodeCommand {
    $bundledNode = Join-Path $repoRoot "runtime\node-win-x64\node.exe"
    if (Test-Path $bundledNode) {
        return $bundledNode
    }

    $pathNode = Get-Command node -ErrorAction SilentlyContinue
    if ($pathNode) {
        return $pathNode.Source
    }

    throw "Node.js was not found. Use the Windows installer/release bundle with bundled runtime, or install Node.js 20+ first."
}

if (-not (Test-Path "$repoRoot/dist/index.js")) {
    throw "dist/index.js is missing. Run 'npm install' and 'npm run build' first."
}

if (-not (Test-Path "$repoRoot/node_modules")) {
    throw "node_modules is missing. Use the release bundle or run 'npm ci' first."
}

if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $defaultEnvFile = Join-Path $repoRoot "config\\agent.env"
    if (Test-Path $defaultEnvFile) {
        $EnvFile = $defaultEnvFile
    }
}

if (-not [string]::IsNullOrWhiteSpace($EnvFile)) {
    Import-EnvFile -Path $EnvFile
}

if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = $env:PRINTANYWHERE_AGENT_DATA_DIR
}

if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = Join-Path $repoRoot "data"
}

if ($Port -le 0) {
    $PortValue = $env:PRINTANYWHERE_AGENT_PORT
    if (-not [string]::IsNullOrWhiteSpace($PortValue)) {
        $Port = [int]$PortValue
    }
}

if ($Port -le 0) {
    $Port = 43100
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
if (-not [string]::IsNullOrWhiteSpace($EnvFile)) {
    Write-Host "Environment file: $EnvFile"
}

$nodeCommand = Resolve-NodeCommand
Write-Host "Node runtime: $nodeCommand"

& $nodeCommand "$repoRoot/dist/index.js"
