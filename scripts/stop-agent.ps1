param(
    [int]$Port = 43100
)

$ErrorActionPreference = "Stop"

$owners = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -gt 0 -and $_.State -eq "Listen" } |
    Select-Object -ExpandProperty OwningProcess -Unique

if (-not $owners) {
    Write-Host "PrintAnywhere Agent is not listening on port $Port."
    exit 0
}

foreach ($processId in $owners) {
    try {
        Stop-Process -Id $processId -Force -ErrorAction Stop
        Write-Host "Stopped PrintAnywhere Agent process $processId."
    } catch {
        Write-Warning "Could not stop process $processId. Close any visible PrintAnywhere Agent terminal window, then retry."
    }
}
