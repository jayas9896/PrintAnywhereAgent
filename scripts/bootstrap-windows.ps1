param(
    [string]$DataDir = "",
    [int]$Port = 43100,
    [switch]$RegisterStartupTask,
    [switch]$CreateShortcuts,
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
    $runScript = Join-Path $repoRoot "scripts\\start-agent-background.ps1"
    $action = New-ScheduledTaskAction `
        -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runScript`" -DataDir `"$DataDir`" -Port $Port"
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
    Write-Host "Registered startup task '$TaskName'."
}

if ($CreateShortcuts) {
    powershell -ExecutionPolicy Bypass -File .\scripts\install-release.ps1 -DataDir "$DataDir" -Port $Port -CreateShortcuts
}

Write-Host ""
Write-Host "Bootstrap completed."
Write-Host "Next steps:"
Write-Host "1. Run: powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File .\\scripts\\start-agent-background.ps1 -DataDir `"$DataDir`" -Port $Port -OpenUi"
Write-Host "2. Open or refresh: https://local.printanywhere.dhruvantasystems.com:$Port (loopback fallback https://127.0.0.1:$Port)"
Write-Host "3. The production backend URL is prefilled as https://api.dhruvantasystems.net/printanywhere."
Write-Host "4. Click Save and register, then share the pairing code with the PrintAnywhere admin so they can verify and approve this machine."
Write-Host "5. After approval, publish or update your customer-facing printers from the local Agent UI."
Write-Host ""
Write-Host "Server URL guidance:"
Write-Host "- Production backend: https://api.dhruvantasystems.net/printanywhere"
Write-Host "- Local test backend: http://127.0.0.1:38080"
Write-Host "- The backend must expose the Print Agent API routes under /api/agent/*"
