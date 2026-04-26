import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentLocationSnapshot, AgentLocationSource } from '../config/types.js'

const execFileAsync = promisify(execFile)

export async function detectHostLocation(): Promise<AgentLocationSnapshot | null> {
  const configured = configuredLocation()
  if (configured) {
    return configured
  }

  if (process.platform === 'win32') {
    return windowsLocationService()
  }

  return null
}

export function normalizeLocationSnapshot(input: {
  latitude: number
  longitude: number
  accuracyMeters?: number | null
  source: AgentLocationSource
  capturedAt?: string | null
}): AgentLocationSnapshot {
  validateCoordinate('Latitude', input.latitude, -90, 90)
  validateCoordinate('Longitude', input.longitude, -180, 180)
  const accuracyMeters =
    typeof input.accuracyMeters === 'number' && Number.isFinite(input.accuracyMeters)
      ? Math.max(0, input.accuracyMeters)
      : null
  const capturedAt = input.capturedAt && !Number.isNaN(Date.parse(input.capturedAt))
    ? new Date(input.capturedAt).toISOString()
    : new Date().toISOString()

  return {
    latitude: roundCoordinate(input.latitude),
    longitude: roundCoordinate(input.longitude),
    accuracyMeters,
    source: input.source,
    capturedAt,
  }
}

function configuredLocation() {
  const latitude = parseOptionalNumber(process.env.PRINTANYWHERE_AGENT_LOCATION_LATITUDE)
  const longitude = parseOptionalNumber(process.env.PRINTANYWHERE_AGENT_LOCATION_LONGITUDE)
  if (latitude == null && longitude == null) {
    return null
  }
  if (latitude == null || longitude == null) {
    throw new Error('PRINTANYWHERE_AGENT_LOCATION_LATITUDE and PRINTANYWHERE_AGENT_LOCATION_LONGITUDE must be set together')
  }

  return normalizeLocationSnapshot({
    latitude,
    longitude,
    accuracyMeters: parseOptionalNumber(process.env.PRINTANYWHERE_AGENT_LOCATION_ACCURACY_METERS),
    source: 'configured',
  })
}

async function windowsLocationService() {
  const script = [
    'Add-Type -AssemblyName System.Device',
    '$watcher = New-Object System.Device.Location.GeoCoordinateWatcher',
    '$started = $watcher.TryStart($false, [TimeSpan]::FromSeconds(6))',
    '$location = $watcher.Position.Location',
    'if ($started -and -not $location.IsUnknown) {',
    '  [pscustomobject]@{ latitude = $location.Latitude; longitude = $location.Longitude; accuracyMeters = $location.HorizontalAccuracy } | ConvertTo-Json -Compress',
    '}',
  ].join('; ')

  for (const executable of ['powershell.exe', 'powershell', 'pwsh']) {
    try {
      const { stdout } = await execFileAsync(
        executable,
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: 8000, windowsHide: true },
      )
      const raw = String(stdout).trim()
      if (!raw) {
        continue
      }
      const parsed = JSON.parse(raw) as {
        latitude?: unknown
        longitude?: unknown
        accuracyMeters?: unknown
      }
      const latitude = Number(parsed.latitude)
      const longitude = Number(parsed.longitude)
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        continue
      }
      return normalizeLocationSnapshot({
        latitude,
        longitude,
        accuracyMeters: Number(parsed.accuracyMeters),
        source: 'windows-location-service',
      })
    } catch {
      continue
    }
  }

  return null
}

function parseOptionalNumber(value: string | undefined) {
  if (value == null || value.trim() === '') {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function validateCoordinate(label: string, value: number, min: number, max: number) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`)
  }
}

function roundCoordinate(value: number) {
  return Number(value.toFixed(6))
}
