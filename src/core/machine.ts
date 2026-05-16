import crypto from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
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

/**
 * KAN-60 AG-M1: legacy at-rest key derivation.
 *
 * The original scheme derived the AES-GCM key purely from PUBLIC hardware
 * identifiers (`SHA-256('printanywhere-agent:' + machineId)`). Any local
 * process could recompute the exact same key — this is obfuscation, not
 * protection. It is retained ONLY so that existing installs can decrypt
 * material that was written under the old scheme; on load the runtime
 * re-encrypts under the new key (see `decryptStringMigrating`).
 */
export async function deriveLegacyMachineKey() {
  const machineId = await getMachineId()
  return crypto.createHash('sha256').update(`printanywhere-agent:${machineId}`).digest()
}

/** File name of the per-install random key salt, stored alongside agent state. */
const KEY_SALT_FILE = 'agent-key-salt.bin'
const SECURE_FILE_MODE = 0o600
const SECURE_DIR_MODE = 0o700

/**
 * Returns the per-install random 32-byte salt, generating and persisting it on
 * first run. The salt file is written 0600 inside the (0700) data directory,
 * so a local process that is not this user cannot read it — and therefore
 * cannot recompute the machine key. This is a genuine improvement over the
 * legacy public-identifier-only derivation (AG-M1).
 *
 * A full OS-keystore integration (Windows DPAPI) is tracked as a follow-up.
 */
async function loadOrCreateKeySalt(dataDir: string): Promise<Buffer> {
  const saltPath = path.join(dataDir, KEY_SALT_FILE)
  await fs.mkdir(dataDir, { recursive: true })
  await chmodIfExists(dataDir, SECURE_DIR_MODE)
  try {
    const existing = await fs.readFile(saltPath)
    if (existing.length === 32) {
      await chmodIfExists(saltPath, SECURE_FILE_MODE)
      return existing
    }
    // A truncated/corrupt salt — fall through and regenerate.
  } catch {
    // No salt yet — create one.
  }
  const salt = crypto.randomBytes(32)
  await fs.writeFile(saltPath, salt, { mode: SECURE_FILE_MODE })
  await chmodIfExists(saltPath, SECURE_FILE_MODE)
  return salt
}

/**
 * Derives the AES-GCM key used to encrypt the agent secret + RSA private key
 * at rest. Combines the (public) machine id with a per-install random salt via
 * HKDF-SHA256. Without the 0600 salt file the key cannot be recomputed, so
 * other local processes can no longer trivially decrypt the stored material.
 */
export async function deriveMachineKey(dataDir: string): Promise<Buffer> {
  const machineId = await getMachineId()
  const salt = await loadOrCreateKeySalt(dataDir)
  const derived = crypto.hkdfSync(
    'sha256',
    Buffer.from(`printanywhere-agent:${machineId}`, 'utf8'),
    salt,
    Buffer.from('printanywhere-agent-at-rest-key', 'utf8'),
    32,
  )
  return Buffer.from(derived)
}

/** chmod a path if it exists; POSIX modes are a no-op on Windows but harmless. */
export async function chmodIfExists(targetPath: string, mode: number): Promise<void> {
  try {
    await fs.chmod(targetPath, mode)
  } catch {
    // Path may not exist yet, or the platform ignores POSIX modes (Windows).
  }
}

export { SECURE_FILE_MODE, SECURE_DIR_MODE }

/**
 * KAN-60 AG-M2: resolves the agent data directory.
 *
 * Previously defaulted to `<cwd>/data`, which placed the agent secret + UI
 * token wherever the process happened to start (often a world-readable path).
 * Now defaults to a per-user application-data location:
 *   - Windows: %APPDATA%\PrintAnywhere\Agent
 *   - Unix:    $XDG_DATA_HOME/printanywhere-agent (or ~/.local/share/...)
 * An explicit PRINTANYWHERE_AGENT_DATA_DIR override still wins.
 */
export function resolveDataDir() {
  const explicit = process.env.PRINTANYWHERE_AGENT_DATA_DIR
  if (explicit) return path.resolve(explicit)
  if (isWindows()) {
    const appData = process.env.APPDATA
    if (appData) return path.resolve(appData, 'PrintAnywhere', 'Agent')
    return path.resolve(os.homedir(), 'AppData', 'Roaming', 'PrintAnywhere', 'Agent')
  }
  const xdgData = process.env.XDG_DATA_HOME
  const base = xdgData ? path.resolve(xdgData) : path.resolve(os.homedir(), '.local', 'share')
  return path.join(base, 'printanywhere-agent')
}

/** The legacy data directory used by pre-AG-M2 installs (`<cwd>/data`). */
export function legacyDataDir() {
  return path.resolve(process.cwd(), 'data')
}

/**
 * AG-M2 migration: if a pre-existing `agent-state.json` lives only at the
 * legacy `<cwd>/data` location, move the whole legacy directory's contents
 * into the new per-user location so the install keeps its identity instead of
 * silently re-pairing. Best-effort and synchronous so it runs before any
 * store access. Returns true if a migration was performed.
 */
export function migrateLegacyDataDir(newDataDir: string): boolean {
  if (process.env.PRINTANYWHERE_AGENT_DATA_DIR) return false
  const legacy = legacyDataDir()
  if (path.resolve(legacy) === path.resolve(newDataDir)) return false
  const legacyState = path.join(legacy, 'agent-state.json')
  const newState = path.join(newDataDir, 'agent-state.json')
  if (!fsSync.existsSync(legacyState) || fsSync.existsSync(newState)) return false
  try {
    fsSync.mkdirSync(newDataDir, { recursive: true })
    for (const entry of fsSync.readdirSync(legacy)) {
      const from = path.join(legacy, entry)
      const to = path.join(newDataDir, entry)
      if (fsSync.existsSync(to)) continue
      fsSync.cpSync(from, to, { recursive: true })
    }
    return true
  } catch {
    return false
  }
}
