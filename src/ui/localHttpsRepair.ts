/**
 * KAN-294: "Repair local URL setup" action.
 *
 * Backs the POST /actions/repair-local-https route the loud-fallback banner
 * exposes. The action is a deliberate thin wrapper over the existing
 * `scripts/lib/local-https-setup.ps1` helpers — they are the source of
 * truth for cert + hosts-file + trust-store handling on Windows. Spawning
 * the existing PowerShell entry point avoids duplicating `certutil` /
 * hosts-file logic in Node, and means the agent can pick up future
 * improvements to that script unchanged.
 *
 * The agent itself is not elevated. If the user is not currently running as
 * an administrator, writing to the hosts file and importing into the
 * machine Root store will both fail — the action surfaces a clear "Run as
 * Administrator and try again" message instead of pretending it succeeded.
 *
 * **Deviation noted in PR:** the underlying ticket called for "restart the
 * UI server in-process so the new cert is picked up". The runtime today does
 * not surface a restart handle (the UI server's `{ close }` is held by
 * `src/index.ts`, not the runtime); the repair action therefore returns a
 * "Restart the agent to finish" notice. A follow-up ticket (KAN-300, filed
 * by this PR) tracks plumbing the restart handle through the runtime.
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostsFilePath } from './localHttpsHealth.js'

export interface LocalHttpsRepairResult {
  ok: boolean
  /** Single-line summary the UI flash banner shows. */
  message: string
  /**
   * Verbose log lines the support / operator can see by expanding "Details".
   * Always populated, never null — empty array means nothing was tried yet.
   */
  details: string[]
  /**
   * `true` if the failure path was specifically "this process is not
   * elevated". The UI uses this to render the "Run as Administrator" call
   * to action prominently.
   */
  requiresElevation: boolean
}

/**
 * KAN-294: best-effort elevation probe on Windows. We try to open the hosts
 * file for append — a non-admin process gets `EACCES`/`EPERM` immediately
 * with no side effects, which is a reliable enough signal to short-circuit
 * the action with a friendly "Run as Administrator" message before paying
 * the cost of spawning PowerShell. On non-Windows hosts (local dev), we
 * always report "elevation not required".
 */
export function probeElevation(): boolean {
  if (process.platform !== 'win32') return true
  try {
    // `constants.W_OK` is a strong-enough proxy on Windows — the hosts file
    // grants Modify only to Administrators and SYSTEM. `accessSync` does
    // not actually write anything.
    accessSync(hostsFilePath(), constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the path to the bundled PowerShell repair entry point inside the
 * installed agent. The path is constructed relative to this module so that
 * the resolution is the same whether we are running from `dist/` (release
 * bundle) or `src/` (dev). Returns `null` if the helper is not present —
 * the caller surfaces that as an installer-bundle problem.
 */
export function resolveLocalHttpsSetupScript(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url))
  // dist/ui/ -> dist/ -> repo root -> scripts/lib/...
  // src/ui/ -> src/  -> repo root -> scripts/lib/...
  const candidate = path.resolve(here, '..', '..', 'scripts', 'lib', 'local-https-setup.ps1')
  return existsSync(candidate) ? candidate : null
}

/**
 * KAN-294: run the existing PowerShell repair helpers in-process. The
 * helpers are dot-sourced and the two top-level functions are invoked back
 * to back so a single elevated UAC prompt covers the whole repair.
 *
 * `nodeCommand` defaults to `process.execPath` (the Node binary the agent
 * itself is running under), which is the same `runtime\node-win-x64\node.exe`
 * the installer uses. `dataDir` is the same agent data dir the rest of the
 * code reads — passed in rather than re-resolved so a test harness can use
 * a tempdir.
 */
export async function runLocalHttpsRepair(opts: {
  dataDir: string
  nodeCommand?: string
  setupScriptPath?: string
  timeoutMs?: number
}): Promise<LocalHttpsRepairResult> {
  const details: string[] = []

  // Elevation gate first — produces a clear, fast "Run as Administrator"
  // path that does not leave half-applied changes when the hosts-file write
  // would have failed anyway.
  if (!probeElevation()) {
    return {
      ok: false,
      message:
        'Open the agent as an administrator and click "Repair local URL setup" again. The repair needs write access to the Windows hosts file and the machine certificate store.',
      details: ['Elevation check failed: hosts file is not writable by this process.'],
      requiresElevation: true,
    }
  }

  const setupScript = opts.setupScriptPath ?? resolveLocalHttpsSetupScript()
  if (!setupScript) {
    return {
      ok: false,
      message:
        'The repair helpers are missing from this install. Reinstall the agent to restore them, or contact support.',
      details: [
        'Could not find scripts/lib/local-https-setup.ps1 next to the agent bundle.',
      ],
      requiresElevation: false,
    }
  }

  const nodeCommand = opts.nodeCommand ?? process.execPath
  // The same repo-root inference as `resolveLocalHttpsSetupScript`.
  const repoRoot = path.resolve(path.dirname(setupScript), '..', '..')
  const dataDir = opts.dataDir

  // Build a tiny inline script that dot-sources the helpers and calls the
  // two top-level functions. This is the same pattern install-release.ps1
  // uses, so any future change to the helpers is picked up automatically.
  const psBody = [
    '$ErrorActionPreference = "Stop"',
    `. "${setupScript.replaceAll('"', '`"')}"`,
    `Install-LocalHttpsUi -NodeCommand "${nodeCommand.replaceAll('"', '`"')}" -RepoRoot "${repoRoot.replaceAll('"', '`"')}" -DataDir "${dataDir.replaceAll('"', '`"')}"`,
  ].join('; ')

  if (process.platform !== 'win32') {
    // On non-Windows hosts the PowerShell helpers do not apply — the agent
    // is Windows-first by design. Return a clear "this is Windows-only"
    // message so the dev-host code path doesn't pretend to repair anything.
    return {
      ok: false,
      message:
        'The local URL setup is a Windows-only feature. There is nothing to repair on this host.',
      details: [`Detected platform: ${process.platform}`],
      requiresElevation: false,
    }
  }

  return await new Promise<LocalHttpsRepairResult>((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psBody],
      { windowsHide: true },
    )
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(
      () => {
        timedOut = true
        child.kill()
      },
      opts.timeoutMs ?? 60_000,
    )

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      details.push(`Failed to spawn powershell.exe: ${error.message}`)
      resolve({
        ok: false,
        message: 'Could not start the repair script. Reinstall the agent or contact support.',
        details,
        requiresElevation: false,
      })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (stdout) details.push(...stdout.trim().split(/\r?\n/))
      if (stderr) details.push(...stderr.trim().split(/\r?\n/))
      if (timedOut) {
        resolve({
          ok: false,
          message:
            'The repair script timed out. Open a PowerShell window as administrator and run install-agent.cmd by hand to see the error.',
          details,
          requiresElevation: false,
        })
        return
      }
      if (code === 0) {
        resolve({
          ok: true,
          // Deviation: not an in-process restart (see module header).
          message:
            'Local URL setup was repaired. Restart the agent (tray icon → Restart Agent) to finish picking up the new certificate.',
          details,
          requiresElevation: false,
        })
        return
      }
      resolve({
        ok: false,
        message: `The repair script exited with code ${code}. Open the details below or contact support.`,
        details,
        requiresElevation: false,
      })
    })
  })
}
