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
$script:ForegroundTimer = $null

function Hide-ConsoleWindow {
    if ($Console) {
        return
    }

    try {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class PrintAnywhereUpdaterWindow {
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@ -ErrorAction SilentlyContinue

        $handle = [PrintAnywhereUpdaterWindow]::GetConsoleWindow()
        if ($handle -ne [IntPtr]::Zero) {
            [PrintAnywhereUpdaterWindow]::ShowWindow($handle, 0) | Out-Null
        }
    } catch {
        # The updater form is the important UI; continue even if console hiding fails.
    }
}

function Bring-UpdateWindowToFront {
    if ($Console -or -not $script:UpdateForm) {
        return
    }

    $script:UpdateForm.WindowState = [System.Windows.Forms.FormWindowState]::Normal
    $script:UpdateForm.ShowInTaskbar = $true
    $script:UpdateForm.TopMost = $true
    $script:UpdateForm.BringToFront()
    $script:UpdateForm.Activate()
    $script:UpdateForm.Refresh()
    [System.Windows.Forms.Application]::DoEvents()

    if ($script:ForegroundTimer) {
        $script:ForegroundTimer.Stop()
        $script:ForegroundTimer.Dispose()
    }

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 1800
    $timer.Add_Tick({
        $script:ForegroundTimer.Stop()
        $script:ForegroundTimer.Dispose()
        $script:ForegroundTimer = $null
        if ($script:UpdateForm -and -not $script:UpdateForm.IsDisposed) {
            $script:UpdateForm.TopMost = $false
        }
    })
    $script:ForegroundTimer = $timer
    $timer.Start()
}

Hide-ConsoleWindow

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
    $form.ShowInTaskbar = $true
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

function Set-ProgressPercent {
    param(
        [string]$Activity,
        [int]$Percent
    )

    $boundedPercent = [Math]::Max(0, [Math]::Min(100, $Percent))

    if ($Console) {
        Write-Progress -Activity $Activity -Status "$boundedPercent%" -PercentComplete $boundedPercent
        return
    }

    if (-not $script:ProgressBar) {
        return
    }

    $script:ProgressBar.Style = "Blocks"
    $script:ProgressBar.MarqueeAnimationSpeed = 0
    $script:ProgressBar.Value = $boundedPercent
    $script:StatusLabel.Text = "$Activity ($boundedPercent%)"
    $script:UpdateForm.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
}

function Complete-Progress {
    param([string]$Activity)

    if ($Console) {
        Write-Progress -Activity $Activity -Completed
        return
    }

    if ($script:ProgressBar) {
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
        if ($Busy -and $script:InstallButton) {
            $script:InstallButton.Enabled = $false
        }
        $script:CloseButton.Enabled = -not $Busy
        Set-ProgressMode $Busy
    }
}

function Stop-AgentTrayProcesses {
    $installRoot = Join-Path $env:LOCALAPPDATA "Dhruvanta Systems\PrintAnywhereAgent"
    $currentPid = $PID
    $trayProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $commandLine = [string]$_.CommandLine
            $_.ProcessId -ne $currentPid -and
            -not [string]::IsNullOrWhiteSpace($commandLine) -and
            $commandLine -match "agent-tray\.ps1" -and
            (
                $commandLine -match "PrintAnywhereAgent" -or
                $commandLine.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase)
            )
        }

    foreach ($process in $trayProcesses) {
        try {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
            Write-UpdateStep "Closed existing tray controller process $($process.ProcessId)."
        } catch {
            Write-UpdateStep "Could not close existing tray controller process $($process.ProcessId): $($_.Exception.Message)"
        }
    }
}

function Invoke-SetupExecutable {
    param(
        [string]$Path,
        [string]$Arguments = "/quiet",
        [int]$TimeoutSeconds = 600
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Path
    $startInfo.Arguments = $Arguments
    $startInfo.WorkingDirectory = Split-Path -Parent $Path
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Could not start setup executable."
    }

    $startedAt = Get-Date
    $lastStatusAt = $startedAt.AddSeconds(-30)
    while (-not $process.WaitForExit(1000)) {
        $elapsed = [int]((Get-Date) - $startedAt).TotalSeconds
        if ($elapsed -ge $TimeoutSeconds) {
            try {
                $process.Kill()
            } catch {
                # Best effort only; surface the timeout below.
            }
            throw "Setup did not finish within $TimeoutSeconds seconds."
        }

        if (((Get-Date) - $lastStatusAt).TotalSeconds -ge 10) {
            Write-UpdateStep "Setup is still running ($elapsed seconds elapsed)..."
            $lastStatusAt = Get-Date
        } elseif (-not $Console -and $script:UpdateForm) {
            $script:UpdateForm.Refresh()
            [System.Windows.Forms.Application]::DoEvents()
        }
    }

    if ($process.ExitCode -ne 0) {
        throw "Setup exited with code $($process.ExitCode)."
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

function Save-ReleaseAsset {
    param(
        [object]$Asset,
        [string]$Destination,
        [string]$Activity
    )

    if (-not $Asset -or [string]::IsNullOrWhiteSpace([string]$Asset.browser_download_url)) {
        throw "Release asset URL is missing for $Activity."
    }

    if (Test-Path $Destination) {
        Remove-Item -Force $Destination
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $request = [System.Net.HttpWebRequest]::Create([string]$Asset.browser_download_url)
    $request.UserAgent = "PrintAnywhereAgentUpdater"
    $request.AllowAutoRedirect = $true

    $response = $null
    $inputStream = $null
    $outputStream = $null
    $lastLoggedPercent = -1

    try {
        $response = $request.GetResponse()
        $inputStream = $response.GetResponseStream()
        $outputStream = [System.IO.File]::Open($Destination, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $buffer = New-Object byte[] 65536
        $totalBytes = [int64]$response.ContentLength
        $downloadedBytes = [int64]0

        if ($totalBytes -le 0) {
            Set-ProgressMode $true
        }

        while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $outputStream.Write($buffer, 0, $read)
            $downloadedBytes += $read

            if ($totalBytes -gt 0) {
                $percent = [int][Math]::Floor(($downloadedBytes * 100.0) / $totalBytes)
                $percent = [Math]::Max(0, [Math]::Min(100, $percent))
                if ($percent -eq 100 -or $percent -ge ($lastLoggedPercent + 5)) {
                    Set-ProgressPercent -Activity $Activity -Percent $percent
                    $lastLoggedPercent = $percent
                }
            } else {
                if (-not $Console) {
                    $script:StatusLabel.Text = $Activity
                    $script:UpdateForm.Refresh()
                    [System.Windows.Forms.Application]::DoEvents()
                }
            }
        }
    } finally {
        if ($outputStream) {
            $outputStream.Dispose()
        }
        if ($inputStream) {
            $inputStream.Dispose()
        }
        if ($response) {
            $response.Close()
        }
    }

    Complete-Progress -Activity $Activity
    Write-UpdateStep "$Activity completed."
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
    Save-ReleaseAsset -Asset $script:SetupAsset -Destination $downloadPath -Activity "Downloading setup executable"

    Write-UpdateStep "Downloading checksum manifest SHA256SUMS.txt..."
    Save-ReleaseAsset -Asset $script:ChecksumAsset -Destination $checksumPath -Activity "Downloading checksum manifest"

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

    Write-UpdateStep "Stopping the running background agent and old tray controller before update..."
    & (Join-Path $PSScriptRoot "stop-agent.ps1") -ErrorAction SilentlyContinue
    Stop-AgentTrayProcesses

    Write-UpdateStep "Installing $($script:Release.tag_name). This window will update when setup finishes..."
    Invoke-SetupExecutable -Path $downloadPath -Arguments "/quiet"

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
            if ($AutoInstall) {
                Write-UpdateStep "Reinstalling the latest release because Install Latest Update was selected."
                Invoke-VisibleInstall
                return
            }
            if ($Console) {
                Write-UpdateStep "Run this script with -Install if support asks you to reinstall the current latest release."
            } else {
                $script:InstallButton.Text = "Reinstall latest"
                $script:InstallButton.Enabled = $true
                Write-UpdateStep "The current latest release can be reinstalled from this window if support asks you to repair the install."
            }
            return
        }

        Write-UpdateStep "Update available: v$currentVersion -> $($script:Release.tag_name)."

        if (-not $AutoInstall) {
            if ($Console) {
                Write-UpdateStep "Run this script with -Install to download and install the update."
            } else {
                $script:InstallButton.Text = "Download and install"
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
    Bring-UpdateWindowToFront
    Write-UpdateStep "Update window opened. This window will show checking, download, verification, and install status."
    Invoke-UpdateWorkflow -AutoInstall $autoInstall
})
[void]$script:UpdateForm.ShowDialog()
if ($script:HadError) {
    exit 1
}
