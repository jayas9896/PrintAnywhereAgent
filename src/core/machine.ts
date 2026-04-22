import crypto from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export function isWindows() {
  return process.platform === 'win32'
}

async function windowsHardwareFingerprint() {
  const script = `
$board = (Get-CimInstance Win32_BaseBoard | Select-Object -First 1 -ExpandProperty SerialNumber)
$disk = (Get-CimInstance Win32_DiskDrive | Select-Object -First 1 -ExpandProperty SerialNumber)
$payload = [PSCustomObject]@{
  board = $board
  disk = $disk
}
$payload | ConvertTo-Json -Compress
`
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script])
  return stdout.trim()
}

async function unixHardwareFingerprint() {
  const machineIdPaths = ['/etc/machine-id', '/var/lib/dbus/machine-id']
  for (const candidate of machineIdPaths) {
    try {
      const value = await fs.readFile(candidate, 'utf8')
      if (value.trim()) return value.trim()
    } catch {
      // ignore
    }
  }
  return `${os.hostname()}_${os.arch()}_${os.platform()}`
}

export async function getMachineId() {
  const hostname = os.hostname()
  const hardware = isWindows()
    ? await windowsHardwareFingerprint().catch(() => `${hostname}_WINDOWS_FALLBACK`)
    : await unixHardwareFingerprint()
  const digest = crypto.createHash('sha256').update(hardware).digest('hex').slice(0, 12).toUpperCase()
  return `${hostname}_${digest}`
}

export async function deriveMachineKey() {
  const machineId = await getMachineId()
  return crypto.createHash('sha256').update(`printanywhere-agent:${machineId}`).digest()
}

export function resolveDataDir() {
  const explicit = process.env.PRINTANYWHERE_AGENT_DATA_DIR
  if (explicit) return path.resolve(explicit)
  return path.resolve(process.cwd(), 'data')
}
