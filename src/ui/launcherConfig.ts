/**
 * KAN-165: launcher configuration + runtime info for the local UI.
 *
 * Two small JSON files live in the agent data directory:
 *
 *  - `ui-launcher.json` — the *user-editable* config. A business user (with
 *    support help) can change `uiHost` to `localhost` if the
 *    `local.printanywhere.dhruvantasystems.com` domain has trouble on their
 *    network (e.g. a router that strips loopback DNS answers). It is the only
 *    knob support needs to talk a user through. See `DEFAULT_LAUNCHER_CONFIG`
 *    and the README "Local UI address" section.
 *
 *  - `ui-runtime.json` — written by the agent itself every time the UI server
 *    binds. It records the *actual* port and scheme the server is listening on,
 *    so the launcher script opens the correct URL even when the configured port
 *    was occupied and the agent fell back to another free port.
 *
 * KAN-294: across a *major* agent version bump (e.g. `0.x.y → 1.0.0`) the
 * launcher config is reset to defaults so a stale `uiHost: "localhost"` chosen
 * by support for an old install no longer silently downgrades the next major
 * release. A minor/patch bump leaves the operator's choice alone — see
 * `resetLauncherConfigIfMajorUpgrade`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Which address the launcher should open the operator's browser at. */
export type UiHostMode = 'domain' | 'localhost'

export const DEFAULT_UI_PORT = 43100

export interface LauncherConfig {
  /**
   * `domain`   → open https://local.printanywhere.dhruvantasystems.com:<port>
   * `localhost`→ open https://127.0.0.1:<port>
   */
  uiHost: UiHostMode
  /** Preferred port. The agent still falls back to a free port if this is taken. */
  port: number
}

export const DEFAULT_LAUNCHER_CONFIG: LauncherConfig = {
  uiHost: 'domain',
  port: DEFAULT_UI_PORT,
}

/**
 * A short header written into the launcher config file so support / a business
 * user can understand and safely edit it without reading the docs.
 */
const LAUNCHER_CONFIG_HEADER = [
  'PrintAnywhere Agent — local console launcher settings.',
  'Edit this file ONLY if support asks you to.',
  '',
  'uiHost:',
  '  "domain"    -> opens https://local.printanywhere.dhruvantasystems.com:<port>',
  '                 (the normal, professional address).',
  '  "localhost" -> opens https://127.0.0.1:<port>',
  '                 (use this if the domain address fails on your network).',
  'port: the port the console listens on. Leave as 43100 unless support',
  '      tells you otherwise. If 43100 is busy the agent picks another free',
  '      port automatically and the launcher still opens the right address.',
].join('\n')

export function launcherConfigPath(dataDir: string): string {
  return path.join(dataDir, 'ui-launcher.json')
}

export function uiRuntimeInfoPath(dataDir: string): string {
  return path.join(dataDir, 'ui-runtime.json')
}

function normalizeUiHost(value: unknown): UiHostMode {
  return value === 'localhost' ? 'localhost' : 'domain'
}

function normalizePort(value: unknown): number {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_UI_PORT
}

/**
 * Read the launcher config, tolerating a missing or malformed file by falling
 * back to defaults. The leading `_comment` field (if present) is ignored.
 */
export function readLauncherConfig(dataDir: string): LauncherConfig {
  const file = launcherConfigPath(dataDir)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    return {
      uiHost: normalizeUiHost(parsed.uiHost),
      port: normalizePort(parsed.port),
    }
  } catch {
    return { ...DEFAULT_LAUNCHER_CONFIG }
  }
}

/**
 * Write the launcher config file if it does not already exist. Idempotent — an
 * existing file (possibly hand-edited by support) is never overwritten.
 *
 * KAN-294: also stamps `installedAgentVersion` on the freshly-written config
 * so a later major-bump reset can detect "this config was written under an
 * earlier major version". Optional argument so existing callers/tests stay
 * backwards-compatible — when omitted the version stamp is left blank.
 */
export function ensureLauncherConfig(dataDir: string, installedAgentVersion?: string): void {
  const file = launcherConfigPath(dataDir)
  if (existsSync(file)) return
  mkdirSync(dataDir, { recursive: true })
  const body: Record<string, unknown> = {
    _comment: LAUNCHER_CONFIG_HEADER,
    uiHost: DEFAULT_LAUNCHER_CONFIG.uiHost,
    port: DEFAULT_LAUNCHER_CONFIG.port,
  }
  if (installedAgentVersion) {
    body.installedAgentVersion = installedAgentVersion
  }
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
}

/**
 * KAN-294: parse the leading `major` digit out of a SemVer-ish version. We do
 * a deliberately permissive parse — `0.1.29-beta+sha.deadbeef` is "major 0",
 * and a missing/garbled value is reported as `null` so a caller can treat it
 * as "unknown" rather than guessing.
 */
export function parseMajorVersion(value: string | null | undefined): number | null {
  if (!value) return null
  const match = /^\s*(\d+)/.exec(value)
  if (!match) return null
  const major = Number(match[1])
  return Number.isFinite(major) ? major : null
}

/**
 * KAN-294: read the `installedAgentVersion` field out of the launcher config
 * file (if present). Returns `null` for a missing/malformed file — every
 * caller should treat `null` as "this config has no version stamp".
 */
export function readLauncherConfigVersion(dataDir: string): string | null {
  const file = launcherConfigPath(dataDir)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const stamp = parsed.installedAgentVersion
    return typeof stamp === 'string' && stamp.length > 0 ? stamp : null
  } catch {
    return null
  }
}

/**
 * KAN-294: across a *major* agent version bump (e.g. `0.x.y -> 1.0.0`), reset
 * `ui-launcher.json` to its documented default and stamp the new version.
 * A minor/patch bump (e.g. `0.1.29 -> 0.1.30`) is a no-op — the operator's
 * choice (or a support-set `uiHost: "localhost"`) is preserved.
 *
 * The version stamp is always updated, so a freshly-installed bundle that
 * already matches the major version still records the *exact* current
 * version for future comparisons. Returns `true` if a reset was performed.
 */
export function resetLauncherConfigIfMajorUpgrade(
  dataDir: string,
  installedAgentVersion: string,
): boolean {
  const file = launcherConfigPath(dataDir)
  if (!existsSync(file)) return false

  const newMajor = parseMajorVersion(installedAgentVersion)
  // A garbled current version is treated as "do nothing" — better than
  // accidentally clobbering a working config because we cannot read our own
  // package.json. The next install with a parseable version will catch up.
  if (newMajor === null) return false

  const oldMajor = parseMajorVersion(readLauncherConfigVersion(dataDir))
  // No stamp → assume the file is from a pre-stamp era; refresh the stamp
  // but leave uiHost / port alone (it predates this feature, the operator's
  // choice is the source of truth).
  if (oldMajor === null) {
    const existing = readLauncherConfig(dataDir)
    const body = {
      _comment: LAUNCHER_CONFIG_HEADER,
      uiHost: existing.uiHost,
      port: existing.port,
      installedAgentVersion,
    }
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
    return false
  }

  if (oldMajor === newMajor) {
    // Same major → refresh the recorded version (so support can see what is
    // installed) but otherwise leave the config alone.
    const existing = readLauncherConfig(dataDir)
    const body = {
      _comment: LAUNCHER_CONFIG_HEADER,
      uiHost: existing.uiHost,
      port: existing.port,
      installedAgentVersion,
    }
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
    return false
  }

  // Different major → reset.
  const reset = {
    _comment: LAUNCHER_CONFIG_HEADER,
    uiHost: DEFAULT_LAUNCHER_CONFIG.uiHost,
    port: DEFAULT_LAUNCHER_CONFIG.port,
    installedAgentVersion,
  }
  writeFileSync(file, `${JSON.stringify(reset, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
  return true
}

export interface UiRuntimeInfo {
  /** Always `https` since KAN-165. */
  scheme: 'https'
  /** The actual port the UI server bound to (may differ from the configured port). */
  port: number
  /** The local UI domain, for the launcher's `domain` mode. */
  domain: string
  /** Loopback host, for the launcher's `localhost` mode. */
  loopbackHost: string
  /** ISO timestamp of when the server bound. */
  updatedAt: string
}

/**
 * Persist the actual listening details so the launcher can open the correct
 * URL even after a port fallback. Written every time the server binds.
 */
export function writeUiRuntimeInfo(dataDir: string, info: Omit<UiRuntimeInfo, 'updatedAt'>): void {
  mkdirSync(dataDir, { recursive: true })
  const payload: UiRuntimeInfo = { ...info, updatedAt: new Date().toISOString() }
  writeFileSync(uiRuntimeInfoPath(dataDir), `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  })
}
