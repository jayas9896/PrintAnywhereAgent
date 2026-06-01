/**
 * KAN-451: "Restart as administrator" action.
 *
 * Backs the POST /actions/restart-elevated route the elevation banner exposes.
 * When the agent runtime is running NON-elevated, the local-domain cert-trust
 * and hosts-file setup silently fail. This action relaunches the agent
 * elevated via a UAC prompt so that setup can complete.
 *
 * It is a deliberate thin wrapper over the existing
 * `scripts/start-agent-background.ps1` launcher — the same script the tray and
 * installer already use to (re)start the runtime. That script does
 * Stop-Existing-then-start, so it self-handles the handoff: the elevated
 * instance reclaims the stale (non-elevated) listener on the port and takes
 * over. We do NOT duplicate that lifecycle logic in Node.
 *
 * BEST-EFFORT BY DESIGN. The relaunch is fired and forgotten:
 *   - If `powershell.exe` cannot be spawned at all, we return a clear error +
 *     manual fallback ("right-click the agent shortcut → Run as administrator")
 *     and never crash or hang the running runtime.
 *   - A UAC *decline* is undetectable here: the outer (non-elevated) PowerShell
 *     returns success the instant `Start-Process -Verb RunAs` is issued,
 *     regardless of whether the user later approves the prompt. That is fine —
 *     "best effort" means we surface the attempt, not the outcome.
 *   - On a successful elevated relaunch, this very process is killed when the
 *     new instance reclaims the port, so the HTTP response may never reach the
 *     browser. The caller redirects with a "Restarting…" notice up front.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RestartElevatedResult {
  /** True only if the relaunch command was handed off to the OS. */
  ok: boolean
  /** Single-line summary the UI flash banner shows. */
  message: string
}

/**
 * Minimal slice of `child_process.spawn` we depend on — lets tests inject a
 * fake to exercise the spawn-failure branch without touching a real shell.
 */
export type DetachedSpawn = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean },
) => { unref: () => void; on: (event: 'error', listener: (err: Error) => void) => void }

/**
 * Resolve the bundled start launcher relative to this module so the path is
 * correct whether we run from `dist/ui/` (release bundle) or `src/ui/` (dev).
 * Mirrors `resolveLocalHttpsSetupScript` in localHttpsRepair.ts. The release
 * builder copies `scripts/start-agent-background.ps1` into the bundle, so this
 * holds in both layouts. Returns `null` if the script is missing.
 */
export function resolveStartAgentScript(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url))
  // dist/ui/ -> dist/ -> repo root -> scripts/...
  // src/ui/  -> src/  -> repo root -> scripts/...
  const candidate = path.resolve(here, '..', '..', 'scripts', 'start-agent-background.ps1')
  return existsSync(candidate) ? candidate : null
}

/** Manual fallback shown whenever the automated relaunch cannot be issued. */
const MANUAL_FALLBACK =
  'Could not start an elevated relaunch automatically. Right-click the PrintAnywhere Agent shortcut and choose "Run as administrator".'

/**
 * Escape a string for embedding inside a PowerShell single-quoted literal:
 * single quotes are doubled. Used for the script path / data dir we interpolate
 * into the `Start-Process` command.
 */
function psSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Build the PowerShell command run by the (non-elevated) outer process. It
 * issues a single `Start-Process … -Verb RunAs`, which triggers the UAC prompt
 * and launches an elevated copy of `start-agent-background.ps1`.
 *
 * `-Verb RunAs` requires the inner program + its args to be passed via
 * `-ArgumentList`; we point it at `powershell.exe -File <script> …` so the
 * elevated instance runs the same launcher the tray/installer use.
 */
export function buildRestartElevatedCommand(opts: {
  scriptPath: string
  dataDir: string
  port: number
}): string {
  const innerArgs = [
    "'-NoProfile'",
    "'-ExecutionPolicy'",
    "'Bypass'",
    "'-WindowStyle'",
    "'Hidden'",
    "'-File'",
    psSingleQuote(opts.scriptPath),
    "'-DataDir'",
    psSingleQuote(opts.dataDir),
    "'-Port'",
    `'${String(opts.port)}'`,
    "'-OpenUi'",
  ].join(', ')

  return (
    "Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden " +
    `-ArgumentList @(${innerArgs})`
  )
}

/**
 * Spawn a detached, elevated relaunch of the agent. Never throws — any failure
 * to even issue the command resolves with `ok:false` + the manual fallback.
 *
 * `spawnImpl` and `platform` are injectable for tests; production uses the
 * real `spawn` and `process.platform`.
 */
export async function restartElevated(opts: {
  dataDir: string
  port: number
  platform?: NodeJS.Platform
  spawnImpl?: DetachedSpawn
  scriptPath?: string | null
}): Promise<RestartElevatedResult> {
  const platform = opts.platform ?? process.platform
  if (platform !== 'win32') {
    // Relaunching elevated is a Windows-only concept. On a dev host there is
    // nothing to do — surface that plainly rather than pretend.
    return {
      ok: false,
      message: 'Restart as administrator is only available on Windows.',
    }
  }

  const scriptPath =
    opts.scriptPath !== undefined ? opts.scriptPath : resolveStartAgentScript()
  if (!scriptPath) {
    return {
      ok: false,
      message:
        'The agent start script is missing from this install, so it could not be ' +
        'restarted automatically. Reinstall the agent, or right-click the PrintAnywhere ' +
        'Agent shortcut and choose "Run as administrator".',
    }
  }

  const command = buildRestartElevatedCommand({
    scriptPath,
    dataDir: opts.dataDir,
    port: opts.port,
  })

  const spawnImpl =
    opts.spawnImpl ?? (spawn as unknown as DetachedSpawn)

  try {
    const child = spawnImpl(
      'powershell.exe',
      ['-NoProfile', '-Command', command],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    // A late spawn error (e.g. the binary vanished between lookup and exec)
    // is swallowed — the runtime must never crash on a best-effort relaunch.
    child.on('error', () => {})
    child.unref()
    return {
      ok: true,
      message:
        'Restarting the agent as administrator… Approve the Windows prompt, then reopen ' +
        'the agent. If no prompt appears, right-click the PrintAnywhere Agent shortcut ' +
        'and choose "Run as administrator".',
    }
  } catch {
    return { ok: false, message: MANUAL_FALLBACK }
  }
}
