param(
    [string]$DataDir = "",
    [int]$Port = 43100,
    [string]$EnvFile = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$iconPath = Join-Path $repoRoot "assets\dhruvanta-agent.ico"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:TrayMutex = $null

# KAN-165: the local console is now served over HTTPS with a per-host
# self-signed certificate. The installer trusts that cert in the Windows
# machine Root store, but the tray probes only ever target 127.0.0.1 on the
# same machine — accept the local self-signed cert unconditionally for these
# loopback-only health/refresh calls so the tray works even before/without
# the trust-store import (e.g. a non-elevated first run).
try {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    [System.Net.ServicePointManager]::SecurityProtocol = `
        [System.Net.SecurityProtocolType]::Tls12
} catch {
    # Older PowerShell hosts may not expose every member — non-fatal.
}

# Resolve the address the agent UI is actually reachable at. The agent writes
# ui-runtime.json with the real port once it binds (it may fall back past a
# busy port); ui-launcher.json holds the user-editable domain/localhost choice.
function Get-AgentUiBaseUrl {
    param([string]$DataDir, [int]$Port)

    $uiHost = "local.printanywhere.dhruvantasystems.com"
    $uiPort = $Port

    if (-not [string]::IsNullOrWhiteSpace($DataDir)) {
        $launcherConfigPath = Join-Path $DataDir "ui-launcher.json"
        if (Test-Path $launcherConfigPath) {
            try {
                $launcherConfig = Get-Content $launcherConfigPath -Raw | ConvertFrom-Json
                if ($launcherConfig.uiHost -eq "localhost") {
                    $uiHost = "127.0.0.1"
                }
            } catch {
                # Malformed config — keep the domain default.
            }
        }

        $runtimeInfoPath = Join-Path $DataDir "ui-runtime.json"
        if (Test-Path $runtimeInfoPath) {
            try {
                $runtimeInfo = Get-Content $runtimeInfoPath -Raw | ConvertFrom-Json
                if ($runtimeInfo.port -gt 0) {
                    $uiPort = [int]$runtimeInfo.port
                }
            } catch {
                # File mid-write — keep the configured port.
            }
        }
    }

    return "https://$uiHost`:$uiPort"
}

function Stop-ExistingTrayControllers {
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
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }

    if ($trayProcesses) {
        Start-Sleep -Milliseconds 400
    }
}

function Enter-TraySingleInstance {
    $createdNew = $false
    $script:TrayMutex = [System.Threading.Mutex]::new(
        $true,
        "Local\DhruvantaPrintAnywhereAgentTray",
        [ref]$createdNew
    )

    if (-not $createdNew) {
        exit 0
    }
}

Stop-ExistingTrayControllers
Enter-TraySingleInstance

$script:RestartAttempts = @()

function Test-AgentHealth {
    try {
        $response = Invoke-RestMethod -UseBasicParsing `
            -Uri "https://127.0.0.1:$Port/health" `
            -TimeoutSec 5 `
            -ErrorAction Stop
        return $response
    } catch {
        return $null
    }
}

function Get-CircuitBreakerOpen {
    $windowStart = (Get-Date).AddMinutes(-10)
    $script:RestartAttempts = @($script:RestartAttempts | Where-Object { $_ -gt $windowStart })
    return $script:RestartAttempts.Count -ge 3
}

function Update-TrayStatus {
    $health = Test-AgentHealth
    if ($null -ne $health) {
        $registered = if ($health.registered) { "Registered" } else { "Unregistered" }
        $raw = "PrintAnywhere Agent — Active · $registered"
        $notifyIcon.Text = if ($raw.Length -gt 63) { $raw.Substring(0, 63) } else { $raw }
        $statusItem.Text = "Status: Active · $registered"
        $errorItem.Visible = $false
    } else {
        $notifyIcon.Text = "PrintAnywhere Agent — Not responding"
        $statusItem.Text = "Status: Not responding"
        $errorItem.Text = "Last error: Agent not responding"
        $errorItem.Visible = $true
        if (-not (Get-CircuitBreakerOpen)) {
            $script:RestartAttempts += Get-Date
            Invoke-AgentScript "start-agent-background.ps1" @("-DataDir", "`"$DataDir`"", "-Port", "$Port", "-EnvFile", "`"$EnvFile`"")
        }
    }
}

function Invoke-AgentScript {
    [CmdletBinding()]
    param(
        [string]$ScriptName,
        [string[]]$ExtraArguments = @(),
        [switch]$VisibleWindow
    )

    $scriptPath = Join-Path $PSScriptRoot $ScriptName
    $arguments = @(
        "-NoProfile",
        "-STA",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$scriptPath`""
    ) + $ExtraArguments

    $windowStyle = "Hidden"
    if ($VisibleWindow) {
        $windowStyle = "Normal"
    } else {
        $arguments = @(
            "-NoProfile",
            "-STA",
            "-ExecutionPolicy", "Bypass",
            "-WindowStyle", "Hidden",
            "-File", "`"$scriptPath`""
        ) + $ExtraArguments
    }

    Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -WorkingDirectory $repoRoot -WindowStyle $windowStyle
}

function Show-Balloon {
    param([string]$Title, [string]$Text)
    $notifyIcon.BalloonTipTitle = $Title
    $notifyIcon.BalloonTipText = $Text
    $notifyIcon.ShowBalloonTip(4000)
}

function Refresh-Printers {
    try {
        $page = Invoke-WebRequest -UseBasicParsing -Uri "https://127.0.0.1:$Port/" -TimeoutSec 5
        $match = [regex]::Match($page.Content, 'name="uiToken" value="([^"]+)"')
        if (-not $match.Success) {
            throw "Local UI token was not found."
        }
        Invoke-WebRequest `
            -UseBasicParsing `
            -Method Post `
            -Uri "https://127.0.0.1:$Port/actions/refresh" `
            -Body @{ uiToken = $match.Groups[1].Value } `
            -TimeoutSec 20 `
            -MaximumRedirection 0 `
            -ErrorAction SilentlyContinue | Out-Null
        Show-Balloon "PrintAnywhere Agent" "Printer discovery refreshed."
    } catch {
        Show-Balloon "PrintAnywhere Agent" "Refresh failed. Open the local UI for details."
    }
}

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
if (Test-Path $iconPath) {
    $notifyIcon.Icon = New-Object System.Drawing.Icon($iconPath)
} else {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
}
$notifyIcon.Text = "Dhruvanta PrintAnywhere Agent"
$notifyIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$statusItem = $menu.Items.Add("Status: Starting...")
$statusItem.Enabled = $false

$errorItem = $menu.Items.Add("Last error: None")
$errorItem.Enabled = $false
$errorItem.Visible = $false

$menu.Items.Add("-") | Out-Null

$openItem = $menu.Items.Add("Open PrintAnywhere Agent")
$openItem.Add_Click({ Start-Process (Get-AgentUiBaseUrl -DataDir $DataDir -Port $Port) })

$startItem = $menu.Items.Add("Start Agent")
$startItem.Add_Click({
    Invoke-AgentScript "start-agent-background.ps1" @("-DataDir", "`"$DataDir`"", "-Port", "$Port", "-EnvFile", "`"$EnvFile`"")
    Show-Balloon "PrintAnywhere Agent" "Agent start requested."
})

$restartItem = $menu.Items.Add("Restart Agent")
$restartItem.Add_Click({
    Invoke-AgentScript "restart-agent.ps1" @("-DataDir", "`"$DataDir`"", "-Port", "$Port", "-EnvFile", "`"$EnvFile`"")
    Show-Balloon "PrintAnywhere Agent" "Agent restart requested."
})

$refreshItem = $menu.Items.Add("Refresh Printers")
$refreshItem.Add_Click({ Refresh-Printers })

$menu.Items.Add("-") | Out-Null

$checkUpdateItem = $menu.Items.Add("Check for Updates...")
$checkUpdateItem.Add_Click({
    Show-Balloon "PrintAnywhere Agent" "Opening the update window."
    Invoke-AgentScript -ScriptName "check-update.ps1" -ExtraArguments @() -VisibleWindow
})

$installUpdateItem = $menu.Items.Add("Install Latest Update...")
$installUpdateItem.Add_Click({
    Show-Balloon "PrintAnywhere Agent" "Opening the update window and starting the latest installer."
    Invoke-AgentScript -ScriptName "check-update.ps1" -ExtraArguments @("-Install") -VisibleWindow
})

$menu.Items.Add("-") | Out-Null

$stopItem = $menu.Items.Add("Stop Agent")
$stopItem.Add_Click({
    Invoke-AgentScript "stop-agent.ps1" @("-Port", "$Port")
    Show-Balloon "PrintAnywhere Agent" "Agent stop requested."
})

$exitItem = $menu.Items.Add("Exit Tray")
$exitItem.Add_Click({
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.Add_DoubleClick({ Start-Process (Get-AgentUiBaseUrl -DataDir $DataDir -Port $Port) })

$healthTimer = New-Object System.Windows.Forms.Timer
$healthTimer.Interval = 30000
$healthTimer.add_Tick({ Update-TrayStatus })
$healthTimer.Start()

Update-TrayStatus

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    if ($healthTimer) {
        $healthTimer.Stop()
        $healthTimer.Dispose()
    }
    if ($notifyIcon) {
        $notifyIcon.Visible = $false
        $notifyIcon.Dispose()
    }
    if ($script:TrayMutex) {
        $script:TrayMutex.ReleaseMutex()
        $script:TrayMutex.Dispose()
    }
}
