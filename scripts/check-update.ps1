param(
    [switch]$Install,
    [switch]$Console,
    [string]$Repo = "Jayashanker-Padishala/PrintAnywhereAgent"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$packagePath = Join-Path $repoRoot "package.json"
$package = Get-Content $packagePath -Raw | ConvertFrom-Json
$currentVersion = [string]$package.version
function Show-UpdateMessage {
    param(
        [string]$Message,
        [string]$Icon = "Information"
    )

    if ($Console) {
        Write-Host $Message
        return
    }

    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        $Message,
        "PrintAnywhere Agent Update",
        "OK",
        $Icon
    ) | Out-Null
}

try {
    $apiUrl = "https://api.github.com/repos/$Repo/releases/latest"

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $release = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "PrintAnywhereAgentUpdater" }
    $latestVersion = ([string]$release.tag_name).TrimStart("v")
    $setupAsset = $release.assets | Where-Object { $_.name -like "*-setup.exe" } | Select-Object -First 1

    if (-not $setupAsset) {
        throw "Latest release $($release.tag_name) does not include a setup executable."
    }

    if ([version]$latestVersion -lt [version]$currentVersion) {
        Show-UpdateMessage "PrintAnywhere Agent is newer than the latest published release.`n`nInstalled: v$currentVersion`nLatest published: $($release.tag_name)"
        exit 0
    }

    if ([version]$latestVersion -eq [version]$currentVersion) {
        Show-UpdateMessage "PrintAnywhere Agent is up to date.`n`nInstalled: v$currentVersion`nLatest: $($release.tag_name)"
        exit 0
    }

    if (-not $Install) {
        Show-UpdateMessage "A PrintAnywhere Agent update is available.`n`nInstalled: v$currentVersion`nLatest: $($release.tag_name)`n`nUse Install Latest Update from the tray or Start Menu to download it."
        exit 0
    }

    $downloadDir = Join-Path $env:TEMP "PrintAnywhereAgentUpdates"
    New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
    $downloadPath = Join-Path $downloadDir $setupAsset.name

    Invoke-WebRequest -Uri $setupAsset.browser_download_url -OutFile $downloadPath -Headers @{ "User-Agent" = "PrintAnywhereAgentUpdater" }

    & (Join-Path $PSScriptRoot "stop-agent.ps1") -ErrorAction SilentlyContinue
    Start-Process -FilePath $downloadPath -ArgumentList "/quiet" -Wait

    Show-UpdateMessage "PrintAnywhere Agent updated to $($release.tag_name). It will continue running in the background and at Windows sign-in."
} catch {
    Show-UpdateMessage "Could not check for PrintAnywhere Agent updates.`n`n$($_.Exception.Message)" "Warning"
    exit 1
}
