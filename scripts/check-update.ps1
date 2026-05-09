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
$script:HadError = $false
$script:IsBusy = $false
$script:Release = $null
$script:SetupAsset = $null
$script:ChecksumAsset = $null
$script:UpdateForm = $null
$script:StatusLabel = $null
$script:LogBox = $null
$script:ProgressBar = $null
$script:InstallButton = $null
$script:CloseButton = $null

function Initialize-UpdateWindow {
    if ($Console) {
        return
    }

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "PrintAnywhere Agent Update"
    $form.StartPosition = "CenterScreen"
    $form.FormBorderStyle = "FixedDialog"
    $form.MaximizeBox = $false
    $form.MinimizeBox = $true
    $form.Width = 600
    $form.Height = 430
    $form.BackColor = [System.Drawing.Color]::FromArgb(245, 247, 251)

    $iconPath = Join-Path $repoRoot "assets\dhruvanta-agent.ico"
    if (Test-Path $iconPath) {
        $form.Icon = New-Object System.Drawing.Icon($iconPath)
    }

    $title = New-Object System.Windows.Forms.Label
    $title.Text = "Dhruvanta PrintAnywhere Agent"
    $title.Font = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold)
    $title.ForeColor = [System.Drawing.Color]::FromArgb(21, 32, 51)
    $title.AutoSize = $true
    $title.Left = 22
    $title.Top = 18

    $subtitle = New-Object System.Windows.Forms.Label
    $subtitle.Text = "Updater"
    $subtitle.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Regular)
    $subtitle.ForeColor = [System.Drawing.Color]::FromArgb(82, 97, 119)
    $subtitle.AutoSize = $true
    $subtitle.Left = 23
    $subtitle.Top = 48

    $status = New-Object System.Windows.Forms.Label
    $status.Text = "Preparing update check..."
    $status.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
    $status.ForeColor = [System.Drawing.Color]::FromArgb(20, 33, 61)
    $status.AutoEllipsis = $true
    $status.Left = 22
    $status.Top = 84
    $status.Width = 540
    $status.Height = 24

    $progress = New-Object System.Windows.Forms.ProgressBar
    $progress.Left = 22
    $progress.Top = 116
    $progress.Width = 540
    $progress.Height = 18
    $progress.Style = "Marquee"
    $progress.MarqueeAnimationSpeed = 30

    $log = New-Object System.Windows.Forms.TextBox
    $log.Multiline = $true
    $log.ReadOnly = $true
    $log.ScrollBars = "Vertical"
    $log.Left = 22
    $log.Top = 150
    $log.Width = 540
    $log.Height = 170
    $log.BackColor = [System.Drawing.Color]::White
    $log.ForeColor = [System.Drawing.Color]::FromArgb(21, 32, 51)
    $log.Font = New-Object System.Drawing.Font("Consolas", 9)

    $installButton = New-Object System.Windows.Forms.Button
    $installButton.Text = "Download and install"
    $installButton.Left = 286
    $installButton.Top = 338
    $installButton.Width = 150
    $installButton.Height = 34
    $installButton.Enabled = $false

    $closeButton = New-Object System.Windows.Forms.Button
    $closeButton.Text = "Close"
    $closeButton.Left = 452
    $closeButton.Top = 338
    $closeButton.Width = 110
    $closeButton.Height = 34
    $closeButton.Add_Click({ $script:UpdateForm.Close() })

    $installButton.Add_Click({
        Invoke-VisibleInstall
    })

    $form.Add_FormClosing({
        param($sender, $eventArgs)
        if ($script:IsBusy) {
            $eventArgs.Cancel = $true
            [System.Windows.Forms.MessageBox]::Show(
                "An update step is still running. Please wait until it finishes.",
                "PrintAnywhere Agent Update",
                "OK",
                "Information"
            ) | Out-Null
        }
    })

    $form.Controls.AddRange(@($title, $subtitle, $status, $progress, $log, $installButton, $closeButton))

    $script:UpdateForm = $form
    $script:StatusLabel = $status
    $script:LogBox = $log
    $script:ProgressBar = $progress
    $script:InstallButton = $installButton
    $script:CloseButton = $closeButton
}

function Set-ProgressMode {
    param([bool]$Busy)

    if ($Console -or -not $script:ProgressBar) {
        return
    }

    if ($Busy) {
        $script:ProgressBar.Style = "Marquee"
        $script:ProgressBar.MarqueeAnimationSpeed = 30
    } else {
        $script:ProgressBar.Style = "Blocks"
        $script:ProgressBar.MarqueeAnimationSpeed = 0
        $script:ProgressBar.Value = 100
    }
}

function Write-UpdateStep {
    param([string]$Message)

    if ($Console) {
        Write-Host $Message
        return
    }

    $script:StatusLabel.Text = $Message
    $timestamp = Get-Date -Format "HH:mm:ss"
    $script:LogBox.AppendText("[$timestamp] $Message`r`n")
    $script:LogBox.SelectionStart = $script:LogBox.TextLength
    $script:LogBox.ScrollToCaret()
    $script:UpdateForm.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
}

function Write-UpdateError {
    param([string]$Message)

    $script:HadError = $true
    Write-UpdateStep $Message
    if (-not $Console) {
        $script:StatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(161, 92, 7)
        Set-ProgressMode $false
    }
}

function Set-UpdateBusy {
    param([bool]$Busy)

    $script:IsBusy = $Busy
    if (-not $Console) {
        $script:CloseButton.Enabled = -not $Busy
        Set-ProgressMode $Busy
    }
}

function Get-LatestReleaseInfo {
    $apiUrl = "https://api.github.com/repos/$Repo/releases/latest"

    Write-UpdateStep "Checking GitHub for the latest PrintAnywhere Agent release..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $release = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "PrintAnywhereAgentUpdater" }
    $latestVersion = ([string]$release.tag_name).TrimStart("v")
    $setupAsset = $release.assets | Where-Object { $_.name -like "*-setup.exe" } | Select-Object -First 1
    $checksumAsset = $release.assets | Where-Object { $_.name -eq "SHA256SUMS.txt" } | Select-Object -First 1

    if (-not $setupAsset) {
        throw "Latest release $($release.tag_name) does not include a setup executable."
    }

    [pscustomobject]@{
        Release = $release
        LatestVersion = $latestVersion
        SetupAsset = $setupAsset
        ChecksumAsset = $checksumAsset
    }
}

function Install-LatestRelease {
    if (-not $script:Release -or -not $script:SetupAsset) {
        throw "No available release has been selected for installation."
    }

    if (-not $script:ChecksumAsset) {
        throw "Latest release $($script:Release.tag_name) does not include SHA256SUMS.txt."
    }

    $downloadDir = Join-Path $env:TEMP "PrintAnywhereAgentUpdates"
    New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
    $downloadPath = Join-Path $downloadDir $script:SetupAsset.name
    $checksumPath = Join-Path $downloadDir "SHA256SUMS.txt"

    Write-UpdateStep "Downloading setup executable $($script:SetupAsset.name)..."
    Invoke-WebRequest -UseBasicParsing -Uri $script:SetupAsset.browser_download_url -OutFile $downloadPath -Headers @{ "User-Agent" = "PrintAnywhereAgentUpdater" }

    Write-UpdateStep "Downloading checksum manifest SHA256SUMS.txt..."
    Invoke-WebRequest -UseBasicParsing -Uri $script:ChecksumAsset.browser_download_url -OutFile $checksumPath -Headers @{ "User-Agent" = "PrintAnywhereAgentUpdater" }

    Write-UpdateStep "Verifying downloaded setup executable checksum..."
    $escapedName = [regex]::Escape($script:SetupAsset.name)
    $checksumLine = Get-Content $checksumPath |
        Where-Object { $_ -match "^[A-Fa-f0-9]{64}\s+(.*/)?$escapedName$" } |
        Select-Object -First 1
    if (-not $checksumLine) {
        throw "SHA256SUMS.txt does not include $($script:SetupAsset.name)."
    }
    $expectedHash = (($checksumLine -split "\s+")[0]).ToLowerInvariant()
    $actualHash = ((Get-FileHash -Path $downloadPath -Algorithm SHA256).Hash).ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "Downloaded installer checksum mismatch. Expected $expectedHash but got $actualHash."
    }

    Write-UpdateStep "Stopping the running background agent before update..."
    & (Join-Path $PSScriptRoot "stop-agent.ps1") -ErrorAction SilentlyContinue

    Write-UpdateStep "Installing $($script:Release.tag_name). This window will update when setup finishes..."
    Start-Process -FilePath $downloadPath -ArgumentList "/quiet" -Wait

    Write-UpdateStep "Update installed: $($script:Release.tag_name). The agent will continue running in the background and at Windows sign-in."
}

function Invoke-VisibleInstall {
    try {
        Set-UpdateBusy $true
        if (-not $Console -and $script:InstallButton) {
            $script:InstallButton.Enabled = $false
        }
        Install-LatestRelease
    } catch {
        Write-UpdateError "Update failed: $($_.Exception.Message)"
    } finally {
        Set-UpdateBusy $false
    }
}

function Invoke-UpdateWorkflow {
    param([bool]$AutoInstall)

    Set-UpdateBusy $true
    try {
        $info = Get-LatestReleaseInfo
        $script:Release = $info.Release
        $script:SetupAsset = $info.SetupAsset
        $script:ChecksumAsset = $info.ChecksumAsset
        $latestVersion = [string]$info.LatestVersion

        Write-UpdateStep "Installed version: v$currentVersion. Latest release: $($script:Release.tag_name)."

        if ([version]$latestVersion -lt [version]$currentVersion) {
            Write-UpdateStep "This installation is newer than the latest published release."
            return
        }

        if ([version]$latestVersion -eq [version]$currentVersion) {
            Write-UpdateStep "PrintAnywhere Agent is up to date."
            return
        }

        Write-UpdateStep "Update available: v$currentVersion -> $($script:Release.tag_name)."

        if (-not $AutoInstall) {
            if ($Console) {
                Write-UpdateStep "Run this script with -Install to download and install the update."
            } else {
                $script:InstallButton.Enabled = $true
                Write-UpdateStep "Click Download and install to update now."
            }
            return
        }
    } catch {
        Write-UpdateError "Could not check for PrintAnywhere Agent updates: $($_.Exception.Message)"
        return
    } finally {
        Set-UpdateBusy $false
    }

    Invoke-VisibleInstall
}

if ($Console) {
    Invoke-UpdateWorkflow -AutoInstall ([bool]$Install)
    if ($script:HadError) {
        exit 1
    }
    exit 0
}

Initialize-UpdateWindow
$autoInstall = [bool]$Install
$script:UpdateForm.Add_Shown({
    Invoke-UpdateWorkflow -AutoInstall $autoInstall
})
[void]$script:UpdateForm.ShowDialog()
if ($script:HadError) {
    exit 1
}
