$ErrorActionPreference = 'Stop'

$printers = Get-Printer | ForEach-Object {
  $printer = $_
  $config = $null
  try {
    $config = Get-PrintConfiguration -PrinterName $printer.Name
  } catch {
    $config = $null
  }

  $supportsColor = $false
  $supportsDuplex = $false
  if ($config) {
    $supportsColor = [string]$config.Color -eq 'True'
    $supportsDuplex = [string]$config.DuplexingMode -ne 'OneSided'
  }

  $connectionType = if ($printer.PortName -match 'USB') {
    'USB'
  } elseif ($printer.PortName -match 'WSD|IP_|TCP') {
    'NETWORK'
  } else {
    'VIRTUAL'
  }

  [PSCustomObject]@{
    localPrinterName = $printer.Name
    driverName = $printer.DriverName
    connectionType = $connectionType
    supportsColor = $supportsColor
    supportsDuplex = $supportsDuplex
    supportedPaperSizes = @('A4', 'A3')
    isDefault = [bool]$printer.Default
    status = if ($printer.WorkOffline) { 'OFFLINE' } else { 'READY' }
  }
}

$printers | ConvertTo-Json -Depth 4
