param(
    [switch]$Install,
    [string]$Repo = "Jayashanker-Padishala/PrintAnywhereAgent"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$packagePath = Join-Path $repoRoot "package.json"
$package = Get-Content $packagePath -Raw | ConvertFrom-Json
$currentVersion = [string]$package.version
$apiUrl = "https://api.github.com/repos/$Repo/releases/latest"

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$release = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "PrintAnywhereAgentUpdater" }
$latestVersion = ([string]$release.tag_name).TrimStart("v")
$setupAsset = $release.assets | Where-Object { $_.name -like "*-setup.exe" } | Select-Object -First 1

if (-not $setupAsset) {
    throw "Latest release $($release.tag_name) does not include a setup executable."
}

if ([version]$latestVersion -le [version]$currentVersion) {
    $message = "PrintAnywhere Agent is up to date.`n`nInstalled: v$currentVersion`nLatest: $($release.tag_name)"
    if ($Install) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($message, "PrintAnywhere Agent Update", "OK", "Information") | Out-Null
    } else {
        Write-Host $message
    }
    exit 0
}

if (-not $Install) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "A PrintAnywhere Agent update is available.`n`nInstalled: v$currentVersion`nLatest: $($release.tag_name)`n`nUse Install Latest Update from the tray or Start Menu to download it.",
        "PrintAnywhere Agent Update",
        "OK",
        "Information"
    ) | Out-Null
    exit 0
}

$downloadDir = Join-Path $env:TEMP "PrintAnywhereAgentUpdates"
New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
$downloadPath = Join-Path $downloadDir $setupAsset.name

Invoke-WebRequest -Uri $setupAsset.browser_download_url -OutFile $downloadPath -Headers @{ "User-Agent" = "PrintAnywhereAgentUpdater" }

& (Join-Path $PSScriptRoot "stop-agent.ps1") -ErrorAction SilentlyContinue
Start-Process -FilePath $downloadPath -ArgumentList "/quiet" -Wait

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show(
    "PrintAnywhere Agent updated to $($release.tag_name). It will continue running in the background and at Windows sign-in.",
    "PrintAnywhere Agent Update",
    "OK",
    "Information"
) | Out-Null
