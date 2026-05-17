import crypto from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  defaultKeyMaterialProtector,
  type KeyMaterialProtector,
} from './dpapi.js'

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
/** Byte length of the raw per-install random salt. */
const SALT_LENGTH = 32

/**
 * KAN-62: magic header that marks a salt file whose payload is wrapped by an
 * OS keystore protector (Windows DPAPI). A legacy KAN-60 salt file is exactly
 * 32 raw bytes with no header, so the two formats are unambiguous:
 *  - starts with `PADP1\n` → DPAPI-wrapped, the rest is the protected blob.
 *  - exactly 32 bytes, no header → legacy plaintext salt (auto-migrated).
 */
const SALT_WRAP_MAGIC = Buffer.from('PADP1\n', 'utf8')

/** True when `raw` begins with the KAN-62 wrapped-salt magic header. */
function isWrappedSalt(raw: Buffer): boolean {
  return raw.length > SALT_WRAP_MAGIC.length && raw.subarray(0, SALT_WRAP_MAGIC.length).equals(SALT_WRAP_MAGIC)
}

/**
 * KAN-62: returns the per-install random 32-byte salt, generating and
 * persisting it on first run.
 *
 * The salt is the root of the at-rest key derivation, so it is itself the most
 * sensitive on-disk material. KAN-60 stored it as a 32-byte plaintext file at
 * 0600 — which still left it readable by *any* process running as the agent
 * user. KAN-62 wraps it with the platform key-material protector:
 *  - Windows: DPAPI (`ProtectedData`, CurrentUser scope) — the salt file can
 *    only be unwrapped inside the logged-in Windows user session, even by the
 *    same user a copy lifted to another machine is useless.
 *  - non-Windows: passthrough — keeps the KAN-60 0600-plaintext behaviour so
 *    the cross-platform build/CI is unaffected.
 *
 * Migration: an existing legacy 32-byte plaintext salt is read as-is, then
 * immediately re-written in the wrapped format. A wrapped salt is unwrapped
 * back to its 32 raw bytes. Both the file mode (0600) and the directory mode
 * (0700) are still asserted as defence in depth.
 */
async function loadOrCreateKeySalt(
  dataDir: string,
  protector: KeyMaterialProtector,
): Promise<Buffer> {
  const saltPath = path.join(dataDir, KEY_SALT_FILE)
  await fs.mkdir(dataDir, { recursive: true })
  await chmodIfExists(dataDir, SECURE_DIR_MODE)

  let raw: Buffer | null = null
  try {
    raw = await fs.readFile(saltPath)
  } catch {
    // No salt yet — fall through and create one.
  }

  if (raw) {
    if (isWrappedSalt(raw)) {
      // KAN-62 wrapped salt — unwrap it back to the 32 raw bytes.
      try {
        const salt = await protector.unprotect(raw.subarray(SALT_WRAP_MAGIC.length))
        if (salt.length === SALT_LENGTH) {
          await chmodIfExists(saltPath, SECURE_FILE_MODE)
          return Buffer.from(salt)
        }
        // Unwrapped to the wrong length — treat as corrupt, regenerate below.
      } catch {
        // Unwrap failed (e.g. wrong Windows user / machine) — regenerate
        // below. Pre-existing behaviour: a salt that cannot be recovered
        // makes old blobs unreadable and the agent re-pairs rather than crash.
      }
    } else if (raw.length === SALT_LENGTH) {
      // KAN-60 legacy plaintext salt — migrate it into the wrapped format.
      await writeWrappedSalt(saltPath, raw, protector)
      return raw
    }
    // A truncated/corrupt salt — fall through and regenerate.
  }

  const salt = crypto.randomBytes(SALT_LENGTH)
  await writeWrappedSalt(saltPath, salt, protector)
  return salt
}

/** Wrap a 32-byte salt with the protector and persist it 0600 with the magic header. */
async function writeWrappedSalt(
  saltPath: string,
  salt: Buffer,
  protector: KeyMaterialProtector,
): Promise<void> {
  const wrapped = await protector.protect(salt)
  const file = Buffer.concat([SALT_WRAP_MAGIC, wrapped])
  await fs.writeFile(saltPath, file, { mode: SECURE_FILE_MODE })
  await chmodIfExists(saltPath, SECURE_FILE_MODE)
}

/**
 * Derives the AES-GCM key used to encrypt the agent secret + RSA private key
 * at rest. Combines the (public) machine id with a per-install random salt via
 * HKDF-SHA256. The salt itself is wrapped in the OS keystore (KAN-62), so the
 * key cannot be recomputed outside the logged-in Windows user session.
 *
 * `protector` is injectable purely so tests can exercise the wrap/migrate
 * paths on Linux CI with a fake protector; production always uses the
 * platform default.
 */
export async function deriveMachineKey(
  dataDir: string,
  protector: KeyMaterialProtector = defaultKeyMaterialProtector(),
): Promise<Buffer> {
  const machineId = await getMachineId()
  const salt = await loadOrCreateKeySalt(dataDir, protector)
  const derived = crypto.hkdfSync(
    'sha256',
    Buffer.from(`printanywhere-agent:${machineId}`, 'utf8'),
    salt,
    Buffer.from('printanywhere-agent-at-rest-key', 'utf8'),
    32,
  )
  return Buffer.from(derived)
}

export { loadOrCreateKeySalt, isWrappedSalt, SALT_WRAP_MAGIC, KEY_SALT_FILE, SALT_LENGTH }

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
