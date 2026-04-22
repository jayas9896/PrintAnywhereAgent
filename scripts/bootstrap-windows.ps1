param(
    [string]$DataDir = "",
    [int]$Port = 43100,
    [switch]$RegisterStartupTask,
    [string]$TaskName = "PrintAnywhereAgent"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$isWindowsPlatform = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [System.Runtime.InteropServices.OSPlatform]::Windows
)

if (-not $isWindowsPlatform) {
    throw "This bootstrap script is intended for Windows."
}

function Require-Command {
    param([string]$Name, [string]$InstallHint)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name was not found. $InstallHint"
    }
}

Require-Command -Name "node" -InstallHint "Install Node.js 20 or newer from https://nodejs.org/en/download"
Require-Command -Name "npm" -InstallHint "Install Node.js 20 or newer from https://nodejs.org/en/download"

if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = Join-Path $repoRoot "data"
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

Write-Host "Installing dependencies..."
npm ci

Write-Host "Building agent..."
npm run build

if ($RegisterStartupTask) {
    $runScript = Join-Path $repoRoot "scripts\\run-agent.ps1"
    $action = New-ScheduledTaskAction `
        -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runScript`" -DataDir `"$DataDir`" -Port $Port"
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
    Write-Host "Registered startup task '$TaskName'."
}

Write-Host ""
Write-Host "Bootstrap completed."
Write-Host "Next steps:"
Write-Host "1. Run: powershell -ExecutionPolicy Bypass -File .\\scripts\\run-agent.ps1 -DataDir `"$DataDir`" -Port $Port"
Write-Host "2. Open: http://127.0.0.1:$Port"
Write-Host "3. Enter the PrintAnywhere backend URL and save the registration."
Write-Host "4. Share the pairing code with the PrintAnywhere admin so they can verify and approve this machine."
Write-Host "5. After approval, publish or update your customer-facing printers from the local Agent UI."
Write-Host ""
Write-Host "Server URL guidance:"
Write-Host "- Local test backend: http://127.0.0.1:38080 or the deployed public backend URL"
Write-Host "- The backend must expose the Print Agent API routes under /api/agent/*"
