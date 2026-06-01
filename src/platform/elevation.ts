/**
 * KAN-451: process-elevation detection for the local agent UI.
 *
 * The per-user installer runs the agent runtime NON-elevated. Two pieces of
 * local-domain setup — importing the per-host cert into the machine Root store
 * and writing the Windows hosts-file entry — both silently fail without
 * administrator rights, which surfaces to the operator as cert warnings and a
 * "Local domain not configured" banner with no explanation.
 *
 * This module answers one question: "is the current process running with
 * administrator rights?" so the UI can recommend an elevated relaunch.
 *
 * FAIL-SAFE BY DESIGN — this is the load-bearing rule. The feature only ever
 * proves out at runtime on a real Windows client; there is no CI/local
 * validation of the actual UAC/elevation behaviour. So anything other than a
 * clean, parseable "not elevated" answer is treated as UNKNOWN and the UI
 * shows NO banner. We never falsely nag a working install:
 *   - non-Windows platform                     -> null (unknown)
 *   - spawn/exec error                         -> null (unknown)
 *   - timeout                                  -> null (unknown)
 *   - stdout is anything but "True" / "False"  -> null (unknown)
 *   - "True"                                    -> true  (elevated)
 *   - "False"                                   -> false (NOT elevated; banner)
 *
 * The resolved value is cached process-wide (the elevation of a running
 * process does not change), and `null` is cached too — unknown means "no
 * banner", and re-probing on every page load would add latency for no gain.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Tri-state elevation result. `null` == unknown (fail-safe → no banner). */
export type ElevationState = boolean | null

/**
 * Injectable seam so the fail-safe branch matrix is unit-testable without a
 * real PowerShell / Windows host. Production wiring uses the module defaults.
 */
export interface ElevationProbeDeps {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /**
   * Runs the elevation check and resolves with the raw stdout. Defaults to a
   * short, non-interactive `powershell.exe` invocation with a hard timeout.
   * Rejecting (spawn error / timeout / non-zero exit) is treated as unknown.
   */
  exec?: () => Promise<{ stdout: string }>
}

/**
 * The PowerShell expression that prints `True` / `False`. A .NET boolean
 * stringifies to exactly `True`/`False`, which is what we parse.
 *
 * NOTE: nothing in CI parses this inline string, so the parentheses are
 * balanced by hand — the outer `(...)` wraps the cast+GetCurrent() so
 * `.IsInRole(...)` is called on the resulting WindowsPrincipal.
 */
export const ELEVATION_PS_EXPRESSION =
  '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
  '.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)'

/** Hard cap on the probe so a wedged PowerShell never hangs a page load. */
const PROBE_TIMEOUT_MS = 5_000

function defaultExec(): Promise<{ stdout: string }> {
  return execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ELEVATION_PS_EXPRESSION],
    { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
  )
}

/**
 * Single-shot, UNCACHED probe. Returns the tri-state result, never throws.
 * Exported for tests so each branch can be exercised without the cache
 * locking in the first answer.
 */
export async function detectElevationUncached(
  deps: ElevationProbeDeps = {},
): Promise<ElevationState> {
  const platform = deps.platform ?? process.platform
  // Short-circuit non-Windows BEFORE spawning anything — the check is
  // Windows-only, and on a dev host "unknown" is the correct, no-banner answer.
  if (platform !== 'win32') return null

  const exec = deps.exec ?? defaultExec
  try {
    const { stdout } = await exec()
    const value = stdout.trim()
    if (value === 'True') return true
    if (value === 'False') return false
    // Any other output (empty, an error string, a localized boolean, …) is
    // not something we can trust — fail safe to unknown.
    return null
  } catch {
    // Spawn failure, timeout, or non-zero exit — all unknown, no banner.
    return null
  }
}

/**
 * Process-wide memoized elevation promise. We cache the PROMISE (not the
 * resolved value) so concurrent first callers share one probe.
 */
let cachedElevation: Promise<ElevationState> | null = null

/**
 * Cached elevation check. The first call probes; subsequent calls reuse the
 * resolved (or in-flight) result. `null` (unknown) is cached deliberately —
 * unknown means "no banner", and that decision is stable for the process.
 */
export function isElevated(deps: ElevationProbeDeps = {}): Promise<ElevationState> {
  if (cachedElevation === null) {
    cachedElevation = detectElevationUncached(deps)
  }
  return cachedElevation
}

/** Test-only: drop the memoized result so the next `isElevated` re-probes. */
export function __resetElevationCacheForTests(): void {
  cachedElevation = null
}
