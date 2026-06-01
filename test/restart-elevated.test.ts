/**
 * KAN-451: tests for the best-effort "Restart as administrator" relaunch.
 * The real UAC handoff only proves out on a Windows client — these tests pin
 * the build-the-command + best-effort contract:
 *   - non-Windows                          -> ok:false, clear message
 *   - missing start script                 -> ok:false, manual fallback
 *   - spawn throws                          -> ok:false, manual fallback (no throw)
 *   - happy path                            -> ok:true, detached+unref'd spawn
 * plus the PowerShell `Start-Process -Verb RunAs` command shape + quoting.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRestartElevatedCommand,
  resolveStartAgentScript,
  restartElevated,
  type DetachedSpawn,
} from '../src/ui/restartElevated.ts'

// ---- buildRestartElevatedCommand: command shape + quoting --------------------

test('buildRestartElevatedCommand issues a single elevated Start-Process', () => {
  const cmd = buildRestartElevatedCommand({
    scriptPath: 'C:\\Agent\\scripts\\start-agent-background.ps1',
    dataDir: 'C:\\Agent\\data',
    port: 43100,
  })
  assert.match(cmd, /^Start-Process -FilePath 'powershell\.exe' -Verb RunAs/)
  // The inner launcher + its args go via -ArgumentList for -Verb RunAs.
  assert.match(cmd, /-ArgumentList @\(/)
  assert.match(cmd, /'-File', 'C:\\Agent\\scripts\\start-agent-background\.ps1'/)
  assert.match(cmd, /'-DataDir', 'C:\\Agent\\data'/)
  assert.match(cmd, /'-Port', '43100'/)
  // -OpenUi so the elevated instance reopens the console for the operator.
  assert.match(cmd, /'-OpenUi'/)
})

test('buildRestartElevatedCommand escapes single quotes in paths', () => {
  const cmd = buildRestartElevatedCommand({
    scriptPath: "C:\\O'Brien\\start-agent-background.ps1",
    dataDir: "C:\\O'Brien\\data",
    port: 43100,
  })
  // Single quotes must be doubled so the PS literal stays balanced.
  assert.match(cmd, /'C:\\O''Brien\\start-agent-background\.ps1'/)
  assert.match(cmd, /'C:\\O''Brien\\data'/)
})

// ---- restartElevated: fail-safe branch matrix -------------------------------

test('non-Windows returns ok:false with a Windows-only message', async () => {
  const result = await restartElevated({
    dataDir: '/tmp/data',
    port: 43100,
    platform: 'linux',
    // scriptPath/spawnImpl never reached on the non-Windows short-circuit.
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /only available on Windows/i)
})

test('a missing start script returns ok:false with a reinstall + manual fallback', async () => {
  const result = await restartElevated({
    dataDir: 'C:\\Agent\\data',
    port: 43100,
    platform: 'win32',
    scriptPath: null,
    spawnImpl: (() => {
      throw new Error('spawn must not be called when the script is missing')
    }) as unknown as DetachedSpawn,
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /missing/i)
  assert.match(result.message, /run as administrator/i)
})

test('a spawn failure returns ok:false with the manual fallback, never throws', async () => {
  const result = await restartElevated({
    dataDir: 'C:\\Agent\\data',
    port: 43100,
    platform: 'win32',
    scriptPath: 'C:\\Agent\\scripts\\start-agent-background.ps1',
    spawnImpl: (() => {
      throw new Error('EACCES')
    }) as unknown as DetachedSpawn,
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /right-click/i)
  assert.match(result.message, /run as administrator/i)
})

test('happy path spawns powershell detached, unref\'d, and returns ok:true', async () => {
  let spawnedCommand: string | null = null
  let spawnedArgs: string[] = []
  let spawnedOptions: Record<string, unknown> = {}
  let unrefed = false
  let errorHandlerAttached = false

  const fakeSpawn: DetachedSpawn = (command, args, options) => {
    spawnedCommand = command
    spawnedArgs = args
    spawnedOptions = options as unknown as Record<string, unknown>
    return {
      unref: () => {
        unrefed = true
      },
      on: (event) => {
        if (event === 'error') errorHandlerAttached = true
      },
    }
  }

  const result = await restartElevated({
    dataDir: 'C:\\Agent\\data',
    port: 43100,
    platform: 'win32',
    scriptPath: 'C:\\Agent\\scripts\\start-agent-background.ps1',
    spawnImpl: fakeSpawn,
  })

  assert.equal(result.ok, true)
  assert.match(result.message, /administrator/i)
  assert.equal(spawnedCommand, 'powershell.exe')
  // The PS command is one argv element (no shell:true) to avoid cmd quoting.
  assert.deepEqual(spawnedArgs.slice(0, 2), ['-NoProfile', '-Command'])
  assert.match(spawnedArgs[2], /Start-Process -FilePath 'powershell\.exe' -Verb RunAs/)
  assert.equal(spawnedOptions.detached, true)
  assert.equal(spawnedOptions.stdio, 'ignore')
  assert.equal(spawnedOptions.windowsHide, true)
  assert.equal(unrefed, true)
  assert.equal(errorHandlerAttached, true)
})

// ---- resolveStartAgentScript: path resolution -------------------------------

test('resolveStartAgentScript finds the bundled launcher next to this module', () => {
  // In the dev (src) layout the script lives at <repo>/scripts/...; the helper
  // resolves relative to the compiled/transpiled module dir. It must return a
  // real path here (this repo has scripts/start-agent-background.ps1) and never
  // throw.
  const resolved = resolveStartAgentScript()
  assert.ok(resolved, 'expected the start launcher to resolve in this repo layout')
  assert.match(resolved, /start-agent-background\.ps1$/)
})
