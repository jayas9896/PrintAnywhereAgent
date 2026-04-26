param(
    [string]$DataDir = "",
    [int]$Port = 0,
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
    throw "This installer is intended for Windows."
}

function Require-Command {
    param([string]$Name, [string]$InstallHint)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name was not found. $InstallHint"
    }
}

Require-Command -Name "node" -InstallHint "Install Node.js 20 or newer from https://nodejs.org/en/download"

if (-not (Test-Path "$repoRoot/dist/index.js")) {
    throw "dist/index.js is missing. Rebuild the release bundle before distributing it."
}

if (-not (Test-Path "$repoRoot/node_modules")) {
    throw "node_modules is missing. Rebuild the release bundle before distributing it."
}

if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = Join-Path $repoRoot "data"
}

if ($Port -le 0) {
    $Port = 43100
}

$configDir = Join-Path $repoRoot "config"
$envExamplePath = Join-Path $configDir "agent.env.example"
$envFilePath = Join-Path $configDir "agent.env"

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
New-Item -ItemType Directory -Force -Path $configDir | Out-Null

if ((Test-Path $envExamplePath) -and (-not (Test-Path $envFilePath))) {
    Copy-Item $envExamplePath $envFilePath
    Write-Host "Created config\\agent.env from the example file."
}

if ($RegisterStartupTask) {
    $runScript = Join-Path $repoRoot "scripts\\run-agent.ps1"
    $action = New-ScheduledTaskAction `
        -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runScript`" -EnvFile `"$envFilePath`" -DataDir `"$DataDir`" -Port $Port"
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
    Write-Host "Registered startup task '$TaskName'."
}

Write-Host ""
Write-Host "Release bundle install completed."
Write-Host "Next steps:"
Write-Host "1. Review config\\agent.env if you want to change the port, data folder, or simulation mode."
Write-Host "2. Start the agent with start-agent.cmd or:"
Write-Host "   powershell -ExecutionPolicy Bypass -File .\\scripts\\run-agent.ps1 -EnvFile `"$envFilePath`" -DataDir `"$DataDir`" -Port $Port"
Write-Host "3. Open http://127.0.0.1:$Port"
Write-Host "4. Enter the PrintAnywhere backend URL in the local UI."
Write-Host "5. Share the pairing code with the PrintAnywhere admin so they can verify and approve this machine."
Write-Host "6. After approval, publish or update your customer-facing printers from the local Agent UI."
Write-Host ""
Write-Host "Notes:"
Write-Host "- The backend URL is configured in the local UI, not in the env file."
Write-Host "- The admin-approved business location is the fallback; use the Host location panel when this machine can provide GPS or OS location."
