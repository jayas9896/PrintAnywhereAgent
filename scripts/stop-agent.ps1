param(
    [int]$Port = 43100,
    [string]$InstallRoot = ""
)

$ErrorActionPreference = "Stop"
$currentPid = $PID

if ([string]::IsNullOrWhiteSpace($InstallRoot) -and -not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $InstallRoot = Join-Path $env:LOCALAPPDATA "Dhruvanta Systems\PrintAnywhereAgent"
}

function Stop-ProcessIds {
    param(
        [int[]]$ProcessIds,
        [string]$Reason
    )

    foreach ($processId in ($ProcessIds | Where-Object { $_ -gt 0 -and $_ -ne $currentPid } | Select-Object -Unique)) {
        try {
            Stop-Process -Id $processId -Force -ErrorAction Stop
            Write-Host "Stopped PrintAnywhere Agent process $processId ($Reason)."
        } catch {
            Write-Warning "Could not stop process $processId. Close any visible PrintAnywhere Agent terminal window, then retry."
        }
    }
}

$owners = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -gt 0 -and $_.State -eq "Listen" } |
    Select-Object -ExpandProperty OwningProcess -Unique

Stop-ProcessIds -ProcessIds $owners -Reason "local UI port $Port"

if (-not [string]::IsNullOrWhiteSpace($InstallRoot)) {
    $managedProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $commandLine = [string]$_.CommandLine
            $_.ProcessId -ne $currentPid -and
            -not [string]::IsNullOrWhiteSpace($commandLine) -and
            $commandLine -match "PrintAnywhereAgent" -and
            (
                $commandLine -match "run-agent\.ps1" -or
                $commandLine -match "agent-tray\.ps1" -or
                $commandLine -match "dist[\\/]+index\.js" -or
                $commandLine -match "node-win-x64[\\/]+node\.exe"
            )
        } |
        Select-Object -ExpandProperty ProcessId -Unique

    Stop-ProcessIds -ProcessIds $managedProcesses -Reason "managed install path"
}

for ($attempt = 0; $attempt -lt 10; $attempt += 1) {
    $listener = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -gt 0 -and $_.State -eq "Listen" } |
        Select-Object -First 1
    if (-not $listener) {
        Write-Host "PrintAnywhere Agent is stopped on port $Port."
        exit 0
    }
    Start-Sleep -Milliseconds 500
}

Write-Warning "PrintAnywhere Agent is still listening on port $Port after stop attempts."
