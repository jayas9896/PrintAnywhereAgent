param(
    [switch]$KeepData,
    [switch]$RemoveData,
    [switch]$Quiet,
    [string]$DataDir = "",
    [int]$Port = 43100,
    [string]$TaskName = "PrintAnywhereAgent"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Show-Message {
    param(
        [string]$Message,
        [string]$Icon = "Information"
    )

    if ($Quiet) {
        Write-Host $Message
        return
    }

    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        $Message,
        "PrintAnywhere Agent Uninstall",
        "OK",
        $Icon
    ) | Out-Null
}

function Resolve-DefaultDataDir {
    param([string]$RepoRoot)

    $expectedRoot = Join-Path $env:LOCALAPPDATA "Dhruvanta Systems\PrintAnywhereAgent"
    if ($RepoRoot.StartsWith($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        return Join-Path $expectedRoot "data"
    }

    return Join-Path $RepoRoot "data"
}

function Confirm-DataChoice {
    if ($KeepData -and $RemoveData) {
        throw "Choose either -KeepData or -RemoveData, not both."
    }

    if ($KeepData -or $RemoveData) {
        if ($RemoveData -and -not $Quiet) {
            Add-Type -AssemblyName System.Windows.Forms
            $confirm = [System.Windows.Forms.MessageBox]::Show(
                "Remove all local PrintAnywhere Agent data too?`n`nThis deletes pairing state, backend URL, printer sharing choices, local health history, and logs from:`n$DataDir",
                "PrintAnywhere Agent Uninstall",
                "OKCancel",
                "Warning"
            )
            if ($confirm -ne [System.Windows.Forms.DialogResult]::OK) {
                exit 0
            }
        }
        return
    }

    if ($Quiet) {
        $script:KeepData = $true
        return
    }

    Add-Type -AssemblyName System.Windows.Forms
    $choice = [System.Windows.Forms.MessageBox]::Show(
        "Do you also want to remove local PrintAnywhere Agent data?`n`nYes: remove program and local data.`nNo: remove only program files and keep pairing/printer data for reinstall.`nCancel: do not uninstall.",
        "PrintAnywhere Agent Uninstall",
        "YesNoCancel",
        "Question"
    )

    if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) {
        $script:RemoveData = $true
        return
    }
    if ($choice -eq [System.Windows.Forms.DialogResult]::No) {
        $script:KeepData = $true
        return
    }
    exit 0
}

function Remove-ShortcutIfPresent {
    param([string]$Path)

    if (Test-Path $Path) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    }
}

if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = Resolve-DefaultDataDir -RepoRoot $repoRoot
}

Confirm-DataChoice

try {
    & (Join-Path $PSScriptRoot "stop-agent.ps1") -Port $Port
} catch {
    Write-Warning "Could not stop the background agent cleanly: $($_.Exception.Message)"
}

$currentPid = $PID
$trayProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.ProcessId -ne $currentPid -and
        $_.CommandLine -and
        $_.CommandLine -match "PrintAnywhereAgent" -and
        $_.CommandLine -match "agent-tray.ps1"
    }

foreach ($process in $trayProcesses) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

foreach ($name in @($TaskName, "$TaskName Tray")) {
    try {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($task) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Warning "Could not unregister scheduled task '$name': $($_.Exception.Message)"
    }
}

$desktop = [Environment]::GetFolderPath("DesktopDirectory")
$startup = [Environment]::GetFolderPath("Startup")
$programs = [Environment]::GetFolderPath("Programs")
$startMenuDir = Join-Path $programs "Dhruvanta Systems"

$shortcutNames = @(
    "PrintAnywhere Agent.lnk",
    "PrintAnywhere Agent Tray.lnk",
    "PrintAnywhere Agent Background.lnk",
    "Stop PrintAnywhere Agent.lnk",
    "Check for PrintAnywhere Agent Updates.lnk",
    "Install Latest PrintAnywhere Agent Update.lnk",
    "Uninstall PrintAnywhere Agent.lnk",
    "Uninstall PrintAnywhere Agent (Keep Data).lnk",
    "Uninstall PrintAnywhere Agent (Remove All Data).lnk"
)

foreach ($folder in @($desktop, $startup, $startMenuDir)) {
    if ([string]::IsNullOrWhiteSpace($folder)) {
        continue
    }
    foreach ($name in $shortcutNames) {
        Remove-ShortcutIfPresent -Path (Join-Path $folder $name)
    }
}

if ((Test-Path $startMenuDir) -and -not (Get-ChildItem -Path $startMenuDir -Force -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $startMenuDir -Force -ErrorAction SilentlyContinue
}

$installRoot = Split-Path -Parent $repoRoot
$pathsToRemove = @()
if ($repoRoot -match "printanywhere-agent-v[0-9]") {
    $pathsToRemove += Get-ChildItem -Path $installRoot -Directory -Filter "printanywhere-agent-v*" -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName
    $pathsToRemove += Get-ChildItem -Path $installRoot -File -Filter "printanywhere-agent-v*.zip" -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName
    $pathsToRemove += Join-Path $installRoot "run-printanywhere-agent-install.ps1"
} else {
    $pathsToRemove += $repoRoot
}

if ($RemoveData) {
    $pathsToRemove += $DataDir
}

$pathsToRemove = $pathsToRemove |
    Where-Object { $_ -and (Test-Path $_) } |
    Select-Object -Unique

$cleanupScript = Join-Path $env:TEMP ("printanywhere-agent-uninstall-{0}.ps1" -f ([Guid]::NewGuid().ToString("N")))
$encodedPaths = $pathsToRemove | ForEach-Object { $_.Replace("'", "''") }
$completionMessage = if ($RemoveData) {
    "PrintAnywhere Agent program files and local data were removed."
} else {
    "PrintAnywhere Agent program files were removed. Local data was kept for reinstall."
}
$escapedMessage = $completionMessage.Replace("'", "''")
$quietLiteral = ([bool]$Quiet).ToString().ToLowerInvariant()

Set-Content -Path $cleanupScript -Encoding UTF8 -Value @"
`$ErrorActionPreference = "SilentlyContinue"
Start-Sleep -Seconds 3
`$paths = @(
$($encodedPaths | ForEach-Object { "    '$_'" } | Out-String)
)
foreach (`$path in `$paths) {
    if (Test-Path -LiteralPath `$path) {
        Remove-Item -LiteralPath `$path -Recurse -Force
    }
}
if (-not $quietLiteral) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show('$escapedMessage', 'PrintAnywhere Agent Uninstall', 'OK', 'Information') | Out-Null
}
Remove-Item -LiteralPath `$MyInvocation.MyCommand.Path -Force
"@

Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-File", "`"$cleanupScript`""
) -WindowStyle Hidden

Show-Message "Uninstall cleanup has started. If you chose to keep data, reinstalling the agent will reuse the saved pairing and printer settings."
