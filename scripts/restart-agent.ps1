param(
    [string]$DataDir = "",
    [int]$Port = 43100,
    [string]$EnvFile = "",
    [switch]$OpenUi
)

$ErrorActionPreference = "Stop"
$scriptRoot = $PSScriptRoot

& (Join-Path $scriptRoot "stop-agent.ps1") -Port $Port
Start-Sleep -Seconds 2
& (Join-Path $scriptRoot "start-agent-background.ps1") -DataDir $DataDir -Port $Port -EnvFile $EnvFile -OpenUi:$OpenUi
