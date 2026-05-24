param(
    [string]$DataDir = "",
    [int]$Port = 0,
    [switch]$RegisterStartupTask,
    [switch]$CreateShortcuts,
    [switch]$StartTray,
    [string]$TaskName = "PrintAnywhereAgent"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# KAN-165: local HTTPS UI setup (per-host cert, trust store, hosts entry).
. (Join-Path $PSScriptRoot "lib\local-https-setup.ps1")

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

function Resolve-DefaultDataDir {
    param([string]$RepoRoot)

    $expectedRoot = Join-Path $env:LOCALAPPDATA "Dhruvanta Systems\PrintAnywhereAgent"
    if ($RepoRoot.StartsWith($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        return Join-Path $expectedRoot "data"
    }

    return Join-Path $RepoRoot "data"
}

function Initialize-StableDataDir {
    param([string]$DataDir, [string]$RepoRoot)

    $statePath = Join-Path $DataDir "agent-state.json"
    if (Test-Path $statePath) {
        return
    }

    $installRoot = Split-Path -Parent $RepoRoot
    $candidate = Get-ChildItem -Path $installRoot -Directory -Filter "printanywhere-agent-v*" -ErrorAction SilentlyContinue |
        ForEach-Object {
            $candidateState = Join-Path $_.FullName "data\agent-state.json"
            if (Test-Path $candidateState) {
                Get-Item $candidateState
            }
        } |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1

    if (-not $candidate) {
        return
    }

    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    $state = Get-Content $candidate.FullName -Raw | ConvertFrom-Json
    if (
        $state.lastError -and
        ([string]$state.lastError).Contains("discover-printers.ps1") -and
        ([string]$state.lastError).Contains("does not exist")
    ) {
        $state.lastError = $null
    }
    $state | ConvertTo-Json -Depth 50 | Set-Content -Encoding UTF8 $statePath
    Write-Host "Migrated existing agent state to stable data directory: $DataDir"
}

function New-AgentShortcut {
    param(
        [string]$ShortcutPath,
        [string]$Arguments,
        [string]$Description,
        # Phase 2a — optional. Defaults to powershell.exe (the old
        # behaviour). When supplied (typically the stable launcher
        # CMD), the shortcut targets that path directly so a version
        # update only has to rewrite the CMD on disk; the .lnk stays
        # valid.
        [string]$TargetPath = ""
    )

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    if ([string]::IsNullOrWhiteSpace($TargetPath)) {
        $shortcut.TargetPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    } else {
        $shortcut.TargetPath = $TargetPath
    }
    $shortcut.Arguments = $Arguments
    $shortcut.WorkingDirectory = $repoRoot
    $shortcut.Description = $Description
    $iconPath = Join-Path $repoRoot "assets\dhruvanta-agent.ico"
    if (Test-Path $iconPath) {
        $shortcut.IconLocation = "$iconPath,0"
    }
    $shortcut.Save()
}

function Test-ManagedPerUserInstall {
    param([string]$RepoRoot)

    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        return $false
    }

    $expectedRoot = Join-Path $env:LOCALAPPDATA "Dhruvanta Systems\PrintAnywhereAgent"
    return $RepoRoot.StartsWith($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)
}

# Phase 2a — write stable launcher CMDs in $installRoot\bin so that
# scheduled tasks and Startup shortcuts can target a fixed path that
# is rewritten on every install. Without this, the tasks/shortcuts
# point at the version-pinned script (e.g.
# ".../printanywhere-agent-v0.1.31/scripts/agent-tray.ps1") and
# Remove-OlderManagedVersions silently breaks them on the next
# update — the tray icon never comes back after the install
# finishes.
#
# The launchers resolve the latest "printanywhere-agent-v*"
# directory at runtime and forward every argument to the matching
# script there. They are pure CMD (no PowerShell session bootstrap)
# so they survive even if the operator's PowerShell ExecutionPolicy
# changes between versions.
function Write-StableLaunchers {
    param([string]$RepoRoot)

    if (-not (Test-ManagedPerUserInstall -RepoRoot $RepoRoot)) {
        return $null
    }

    $installRoot = Split-Path -Parent $RepoRoot
    $binDir = Join-Path $installRoot "bin"
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null

    # CMD template — argument %1 is the script name (e.g.
    # "agent-tray.ps1"), the rest pass through to the script.
    $launcherBody = @'
@echo off
setlocal enabledelayedexpansion
set "INSTALL_ROOT=%LOCALAPPDATA%\Dhruvanta Systems\PrintAnywhereAgent"
set "SCRIPT_NAME=%~1"
shift /1

if "%SCRIPT_NAME%"=="" (
    echo Stable launcher requires the target script name as the first argument. 1>&2
    exit /b 2
)

set "VERSION_DIR="
for /f "delims=" %%i in ('dir "%INSTALL_ROOT%\printanywhere-agent-v*" /b /ad /o-n 2^>nul') do (
    set "VERSION_DIR=%%i"
    goto :found
)
echo PrintAnywhere Agent install not found under "%INSTALL_ROOT%". 1>&2
exit /b 3

:found
set "TARGET=%INSTALL_ROOT%\%VERSION_DIR%\scripts\%SCRIPT_NAME%"
if not exist "%TARGET%" (
    echo Target script not found: "%TARGET%" 1>&2
    exit /b 4
)

REM Forward every remaining arg to powershell.
set "PS_ARGS="
:collect
if "%~1"=="" goto :run
set "PS_ARGS=!PS_ARGS! %1"
shift /1
goto :collect

:run
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%TARGET%" !PS_ARGS!
exit /b %ERRORLEVEL%
'@

    $launcherPath = Join-Path $binDir "agent-launcher.cmd"
    Set-Content -LiteralPath $launcherPath -Value $launcherBody -Encoding ASCII
    Write-Host "Wrote stable launcher: $launcherPath"
    return $launcherPath
}

function Normalize-PathForComparison {
    param([string]$Path)

    return ([System.IO.Path]::GetFullPath($Path)).TrimEnd(
        [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    )
}

function Remove-OlderManagedVersions {
    param([string]$RepoRoot)

    if (-not (Test-ManagedPerUserInstall -RepoRoot $RepoRoot)) {
        return
    }

    $installRoot = Split-Path -Parent $RepoRoot
    $currentRoot = Normalize-PathForComparison -Path $RepoRoot
    $removedCount = 0

    Get-ChildItem -Path $installRoot -Directory -Filter "printanywhere-agent-v*" -ErrorAction SilentlyContinue |
        Where-Object { (Normalize-PathForComparison -Path $_.FullName) -ne $currentRoot } |
        ForEach-Object {
            try {
                Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
                $removedCount += 1
            } catch {
                Write-Warning "Could not remove older PrintAnywhere Agent version folder '$($_.FullName)': $($_.Exception.Message)"
            }
        }

    Get-ChildItem -Path $installRoot -File -Filter "printanywhere-agent-v*.zip" -ErrorAction SilentlyContinue |
        ForEach-Object {
            try {
                Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
                $removedCount += 1
            } catch {
                Write-Warning "Could not remove older PrintAnywhere Agent bundle '$($_.FullName)': $($_.Exception.Message)"
            }
        }

    if ($removedCount -gt 0) {
        Write-Host "Removed $removedCount older managed PrintAnywhere Agent install artifact(s)."
    }
}

function Protect-AgentPath {
    param(
        [string]$Path,
        [switch]$Recursive
    )

    if (-not (Test-Path $Path)) {
        return
    }

    $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $directoryAclArgs = @(
        $Path,
        "/inheritance:r",
        "/grant:r",
        ("*{0}:(OI)(CI)(F)" -f $currentUserSid),
        "*S-1-5-18:(OI)(CI)(F)",
        "*S-1-5-32-544:(OI)(CI)(F)",
        "/remove:g",
        "*S-1-1-0",
        "*S-1-5-11",
        "*S-1-5-32-545",
        "/C"
    )

    & icacls @directoryAclArgs | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not harden Windows ACLs for $Path."
    }

    if (-not $Recursive -or -not (Test-Path $Path -PathType Container)) {
        return
    }

    $children = @(Get-ChildItem -Force -LiteralPath $Path -ErrorAction SilentlyContinue)
    if ($children.Count -eq 0) {
        return
    }

    $childPattern = Join-Path $Path "*"
    & icacls $childPattern "/reset" "/T" "/C" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not repair inherited Windows ACLs under $Path."
    }
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
}

function Stop-ExistingAgentRuntime {
    param([int]$Port)

    $installRoot = Join-Path $env:LOCALAPPDATA "Dhruvanta Systems\PrintAnywhereAgent"
    $owners = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -gt 0 -and $_.State -eq "Listen" } |
        Select-Object -ExpandProperty OwningProcess -Unique

    $managedRuntimeProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $commandLine = [string]$_.CommandLine
            $_.ProcessId -ne $PID -and
            -not [string]::IsNullOrWhiteSpace($commandLine) -and
            $commandLine -match "PrintAnywhereAgent" -and
            (
                $commandLine -match "run-agent\.ps1" -or
                $commandLine -match "dist[\\/]+index\.js" -or
                $commandLine -match "node-win-x64[\\/]+node\.exe" -or
                $commandLine.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase)
            )
        } |
        Select-Object -ExpandProperty ProcessId -Unique

    foreach ($processId in (($owners + $managedRuntimeProcesses) | Select-Object -Unique)) {
        if ($processId -eq $PID) {
            continue
        }

        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }

    for ($attempt = 0; $attempt -lt 10; $attempt += 1) {
        $listener = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
            Where-Object { $_.OwningProcess -gt 0 -and $_.State -eq "Listen" } |
            Select-Object -First 1
        if (-not $listener) {
            return
        }
        Start-Sleep -Milliseconds 500
    }
}

$nodeCommand = Resolve-NodeCommand

if (-not (Test-Path "$repoRoot/dist/index.js")) {
    throw "dist/index.js is missing. Rebuild the release bundle before distributing it."
}

if (-not (Test-Path "$repoRoot/node_modules")) {
    throw "node_modules is missing. Rebuild the release bundle before distributing it."
}

if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = Resolve-DefaultDataDir -RepoRoot $repoRoot
}

if ($Port -le 0) {
    $Port = 43100
}

Stop-ExistingTrayControllers
Stop-ExistingAgentRuntime -Port $Port
Write-Host "Stopped any existing PrintAnywhere Agent runtime and tray controller for this Windows user."

$configDir = Join-Path $repoRoot "config"
$envExamplePath = Join-Path $configDir "agent.env.example"
$envFilePath = Join-Path $configDir "agent.env"

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
Initialize-StableDataDir -DataDir $DataDir -RepoRoot $repoRoot

if ((Test-Path $envExamplePath) -and (-not (Test-Path $envFilePath))) {
    Copy-Item $envExamplePath $envFilePath
    Write-Host "Created config\\agent.env from the example file."
}

# KAN-165: provision the per-host TLS certificate, trust it, add the hosts-file
# entry, and seed the launcher config. Run before ACL hardening so the new
# files in the data dir are covered by the lockdown below.
#
# KAN-294: explicit, verbose logging + a post-install smoke check. If the
# admin elevation step was declined the user would previously silently end up
# with a half-applied setup that points at http://127.0.0.1 instead of the
# professional https domain — make that loud, with the remediation in the
# message instead of buried in support logs.
function Test-IsElevated {
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

$elevated = Test-IsElevated
if ($elevated) {
    Write-Host "Local HTTPS UI setup: running with administrator privileges."
} else {
    Write-Warning "Local HTTPS UI setup: this PowerShell session is NOT elevated. The hosts-file edit and certificate trust step will be skipped or fail."
    Write-Warning "Re-run the installer as administrator (right-click -> Run as administrator) to finish the local domain setup."
}

try {
    Install-LocalHttpsUi -NodeCommand $nodeCommand -RepoRoot $repoRoot -DataDir $DataDir
} catch {
    Write-Warning "Local HTTPS UI setup did not fully complete: $($_.Exception.Message)"
    Write-Warning "The agent will still serve the console; the browser may show a certificate warning or you may need to open https://127.0.0.1:$Port directly."
}

# KAN-294 — post-install smoke check. Verify the two pieces of state the local
# domain depends on are actually in place: the hosts-file entry and the
# per-host cert file. We do not curl the URL itself here because the agent
# isn't started yet — that probe happens once start-agent-background.ps1
# launches the runtime. If we DID elevate and these checks still fail, that's
# a genuine install regression worth halting on; if we did NOT elevate, the
# operator already saw a clear warning above and the agent will still serve
# https://127.0.0.1:$Port — so we degrade to a warning rather than failing
# an unrelated user's install.
$localUiDomain = "local.printanywhere.dhruvantasystems.com"
$hostsFile = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
$hostsOk = $false
if (Test-Path $hostsFile) {
    foreach ($line in (Get-Content -LiteralPath $hostsFile -ErrorAction SilentlyContinue)) {
        if ($line -match "^\s*(127\.0\.0\.1|::1)\s+.*\b$([Regex]::Escape($localUiDomain))\b") {
            $hostsOk = $true
            break
        }
    }
}

$certPath = Join-Path $DataDir "tls\local-ui-cert.pem"
$keyPath = Join-Path $DataDir "tls\local-ui-key.pem"
$certOk = (Test-Path $certPath) -and (Test-Path $keyPath)

if ($hostsOk -and $certOk) {
    Write-Host "Local HTTPS UI smoke check: hosts entry present, per-host certificate present."
} elseif ($elevated) {
    Write-Error "Local HTTPS UI smoke check FAILED after an elevated install (hostsOk=$hostsOk, certOk=$certOk). The local domain https://$localUiDomain`:$Port will not work. Open the agent's local UI as administrator and click 'Repair local URL setup', or contact support."
    throw "Local HTTPS UI smoke check failed."
} else {
    Write-Warning "Local HTTPS UI smoke check: hostsOk=$hostsOk, certOk=$certOk. The agent will still serve https://127.0.0.1:$Port. Re-run the installer as administrator, or after first launch click 'Repair local URL setup' on the agent dashboard."
}

$stableLauncher = Write-StableLaunchers -RepoRoot $repoRoot

if (Test-ManagedPerUserInstall -RepoRoot $repoRoot) {
    $installRoot = Split-Path -Parent $repoRoot
    Protect-AgentPath -Path $installRoot
    Protect-AgentPath -Path $repoRoot -Recursive
    Protect-AgentPath -Path $DataDir -Recursive
    Protect-AgentPath -Path $configDir -Recursive
    Write-Host "Hardened agent install, config, and data ACLs for this Windows user, SYSTEM, and Administrators."
    Remove-OlderManagedVersions -RepoRoot $repoRoot
}

if ($RegisterStartupTask) {
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited

    # Phase 2a — managed installs invoke the stable launcher so a
    # later version update does not orphan the scheduled task at
    # the previous version's file path. Non-managed (zip-extracted)
    # installs fall back to the original direct-script invocation
    # since they have no $installRoot to anchor the launcher to.
    if ($stableLauncher) {
        $startArgument = "/c `"$stableLauncher`" start-agent-background.ps1 -EnvFile `"$envFilePath`" -DataDir `"$DataDir`" -Port $Port"
        $trayArgument = "/c `"$stableLauncher`" agent-tray.ps1 -EnvFile `"$envFilePath`" -DataDir `"$DataDir`" -Port $Port"
        $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $startArgument
        $trayAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $trayArgument
    } else {
        $runScript = Join-Path $repoRoot "scripts\\start-agent-background.ps1"
        $trayScript = Join-Path $repoRoot "scripts\\agent-tray.ps1"
        $action = New-ScheduledTaskAction `
            -Execute "powershell.exe" `
            -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runScript`" -EnvFile `"$envFilePath`" -DataDir `"$DataDir`" -Port $Port"
        $trayAction = New-ScheduledTaskAction `
            -Execute "powershell.exe" `
            -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$trayScript`" -EnvFile `"$envFilePath`" -DataDir `"$DataDir`" -Port $Port"
    }

    try {
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
        Write-Host "Registered startup task '$TaskName'."
        Register-ScheduledTask -TaskName "$TaskName Tray" -Action $trayAction -Trigger $trigger -Principal $principal -Force | Out-Null
        Write-Host "Registered startup task '$TaskName Tray'."
    } catch {
        Write-Warning "Scheduled Task registration failed. Falling back to per-user Startup folder shortcuts."
        $startup = [Environment]::GetFolderPath("Startup")
        if ($stableLauncher) {
            New-AgentShortcut `
                -ShortcutPath (Join-Path $startup "PrintAnywhere Agent Background.lnk") `
                -TargetPath $stableLauncher `
                -Arguments "start-agent-background.ps1 -EnvFile `"$envFilePath`" -DataDir `"$DataDir`" -Port $Port" `
                -Description "Start the Dhruvanta PrintAnywhere Agent in the background at sign-in."
            New-AgentShortcut `
                -ShortcutPath (Join-Path $startup "PrintAnywhere Agent Tray.lnk") `
                -TargetPath $stableLauncher `
                -Arguments "agent-tray.ps1 -EnvFile `"$envFilePath`" -DataDir `"$DataDir`" -Port $Port" `
                -Description "Show the Dhruvanta PrintAnywhere Agent tray controls at sign-in."
        } else {
            $runScript = Join-Path $repoRoot "scripts\\start-agent-background.ps1"
            $trayScript = Join-Path $repoRoot "scripts\\agent-tray.ps1"
            New-AgentShortcut `
                -ShortcutPath (Join-Path $startup "PrintAnywhere Agent Background.lnk") `
                -Arguments "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runScript`" -EnvFile `"$envFilePath`" -DataDir `"$DataDir`" -Port $Port" `
                -Description "Start the Dhruvanta PrintAnywhere Agent in the background at sign-in."
            New-AgentShortcut `
                -ShortcutPath (Join-Path $startup "PrintAnywhere Agent Tray.lnk") `
                -Arguments "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$trayScript`" -EnvFile `"$envFilePath`" -DataDir `"$DataDir`" -Port $Port" `
                -Description "Show the Dhruvanta PrintAnywhere Agent tray controls at sign-in."
        }
        Write-Host "Created Startup folder shortcuts."
    }
}

if ($CreateShortcuts) {
    $desktop = [Environment]::GetFolderPath("DesktopDirectory")
    $programs = [Environment]::GetFolderPath("Programs")
    $startMenuDir = Join-Path $programs "Dhruvanta Systems"
    New-Item -ItemType Directory -Force -Path $startMenuDir | Out-Null

    $startScript = Join-Path $repoRoot "scripts\start-agent-background.ps1"
    $trayScript = Join-Path $repoRoot "scripts\agent-tray.ps1"
    $stopScript = Join-Path $repoRoot "scripts\stop-agent.ps1"
    $updateScript = Join-Path $repoRoot "scripts\check-update.ps1"
    $uninstallScript = Join-Path $repoRoot "scripts\uninstall-agent.ps1"

    # Phase 2a — when running a managed install, route the
    # frequently-used shortcuts (Agent + Tray + Stop) through the
    # stable launcher so a later version update only has to rewrite
    # the launcher CMD; the .lnk paths in Desktop / Start Menu stay
    # valid. Less-frequent shortcuts (Update, Uninstall) are kept on
    # the version-pinned path — they are always invoked manually so
    # an operator who runs them does not benefit from launcher
    # indirection.
    if ($stableLauncher) {
        $commonStartArgs = "start-agent-background.ps1 -EnvFile `"$envFilePath`" -DataDir `"$DataDir`" -Port $Port -OpenUi"
        $commonTrayArgs = "agent-tray.ps1 -EnvFile `"$envFilePath`" -DataDir `"$DataDir`" -Port $Port"
        $commonStopArgs = "stop-agent.ps1 -Port $Port"
        $startTarget = $stableLauncher
        $trayTarget = $stableLauncher
        $stopTarget = $stableLauncher
    } else {
        $commonStartArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -EnvFile `"$envFilePath`" -DataDir `"$DataDir`" -Port $Port -OpenUi"
        $commonTrayArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$trayScript`" -EnvFile `"$envFilePath`" -DataDir `"$DataDir`" -Port $Port"
        $commonStopArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$stopScript`" -Port $Port"
        $startTarget = ""
        $trayTarget = ""
        $stopTarget = ""
    }

    New-AgentShortcut `
        -ShortcutPath (Join-Path $desktop "PrintAnywhere Agent.lnk") `
        -TargetPath $startTarget `
        -Arguments $commonStartArgs `
        -Description "Start the Dhruvanta PrintAnywhere Agent and open the local UI."
    New-AgentShortcut `
        -ShortcutPath (Join-Path $desktop "PrintAnywhere Agent Tray.lnk") `
        -TargetPath $trayTarget `
        -Arguments $commonTrayArgs `
        -Description "Show the Dhruvanta PrintAnywhere Agent tray controls."
    New-AgentShortcut `
        -ShortcutPath (Join-Path $startMenuDir "PrintAnywhere Agent.lnk") `
        -TargetPath $startTarget `
        -Arguments $commonStartArgs `
        -Description "Start the Dhruvanta PrintAnywhere Agent and open the local UI."
    New-AgentShortcut `
        -ShortcutPath (Join-Path $startMenuDir "PrintAnywhere Agent Tray.lnk") `
        -TargetPath $trayTarget `
        -Arguments $commonTrayArgs `
        -Description "Show the Dhruvanta PrintAnywhere Agent tray controls."
    New-AgentShortcut `
        -ShortcutPath (Join-Path $startMenuDir "Stop PrintAnywhere Agent.lnk") `
        -TargetPath $stopTarget `
        -Arguments $commonStopArgs `
        -Description "Stop the local Dhruvanta PrintAnywhere Agent."
    New-AgentShortcut `
        -ShortcutPath (Join-Path $startMenuDir "Check for PrintAnywhere Agent Updates.lnk") `
        -Arguments "-NoProfile -STA -ExecutionPolicy Bypass -File `"$updateScript`"" `
        -Description "Check for Dhruvanta PrintAnywhere Agent updates."
    New-AgentShortcut `
        -ShortcutPath (Join-Path $startMenuDir "Install Latest PrintAnywhere Agent Update.lnk") `
        -Arguments "-NoProfile -STA -ExecutionPolicy Bypass -File `"$updateScript`" -Install" `
        -Description "Download and install the latest Dhruvanta PrintAnywhere Agent release."
    New-AgentShortcut `
        -ShortcutPath (Join-Path $startMenuDir "Uninstall PrintAnywhere Agent.lnk") `
        -Arguments "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$uninstallScript`" -DataDir `"$DataDir`" -Port $Port" `
        -Description "Uninstall Dhruvanta PrintAnywhere Agent with a choice to keep or remove local data."
    Write-Host "Created Desktop and Start Menu shortcuts."
}

if ($StartTray) {
    Stop-ExistingTrayControllers
    # Phase 2a — launch via the stable launcher so the running tray
    # is rooted at the same indirection the scheduled tasks /
    # shortcuts use. Falls back to the version-pinned script when no
    # launcher exists (non-managed install).
    if ($stableLauncher) {
        Start-Process `
            -FilePath "cmd.exe" `
            -ArgumentList @("/c", "`"$stableLauncher`"", "agent-tray.ps1", "-EnvFile", "`"$envFilePath`"", "-DataDir", "`"$DataDir`"", "-Port", $Port) `
            -WorkingDirectory $repoRoot `
            -WindowStyle Hidden
    } else {
        $trayScript = Join-Path $repoRoot "scripts\agent-tray.ps1"
        Start-Process `
            -FilePath "powershell.exe" `
            -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "`"$trayScript`"", "-EnvFile", "`"$envFilePath`"", "-DataDir", "`"$DataDir`"", "-Port", $Port) `
            -WorkingDirectory $repoRoot `
            -WindowStyle Hidden
    }
}

Write-Host ""
Write-Host "Release bundle install completed."
Write-Host "Node runtime: $nodeCommand"
Write-Host "Next steps:"
Write-Host "1. Review config\\agent.env if you want to change the port, data folder, or simulation mode."
Write-Host "2. Start the agent with start-agent.cmd, the Desktop shortcut, or:"
Write-Host "   powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File .\\scripts\\start-agent-background.ps1 -EnvFile `"$envFilePath`" -DataDir `"$DataDir`" -Port $Port -OpenUi"
Write-Host "3. Use the tray icon or https://local.printanywhere.dhruvantasystems.com:$Port (loopback fallback https://127.0.0.1:$Port) for refresh, health, and printer publishing."
Write-Host "   If the domain address has trouble on your network, support can set `"uiHost`": `"localhost`" in $DataDir\ui-launcher.json."
Write-Host "4. The production backend URL is prefilled as https://api.dhruvantasystems.net/printanywhere."
Write-Host "5. Click Save and register, then share the pairing code with the PrintAnywhere admin so they can verify and approve this machine."
Write-Host "6. After approval, publish or update your customer-facing printers from the local Agent UI."
Write-Host ""
Write-Host "Notes:"
Write-Host "- Change the backend URL only for local testing or a support-directed override."
Write-Host "- The admin-approved business location is the fallback; use the Host location panel when this machine can provide GPS or OS location."
