/**
 * KAN-294: tests for the local-HTTPS recovery + major-upgrade reset surface.
 * The Windows installer code path (`certutil`, hosts-file edits) is exercised
 * by the existing v0.1.x release smoke; these tests cover the pure
 * detection + config logic that runs in-process inside the agent.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  DEFAULT_LAUNCHER_CONFIG,
  ensureLauncherConfig,
  launcherConfigPath,
  parseMajorVersion,
  readLauncherConfig,
  readLauncherConfigVersion,
  resetLauncherConfigIfMajorUpgrade,
} from '../src/ui/launcherConfig.ts'
import { LOCAL_UI_DOMAIN, localCertPaths } from '../src/ui/localHttps.ts'
import {
  evaluateLocalUiDomainHealth,
  hostsFileHasLocalUiEntry,
} from '../src/ui/localHttpsHealth.ts'
import {
  probeElevation,
  resolveLocalHttpsSetupScript,
  runLocalHttpsRepair,
} from '../src/ui/localHttpsRepair.ts'

function freshDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'pa-agent-rec-'))
}

// ---- parseMajorVersion ------------------------------------------------------

test('parseMajorVersion handles plain SemVer', () => {
  assert.equal(parseMajorVersion('0.1.29'), 0)
  assert.equal(parseMajorVersion('1.0.0'), 1)
  assert.equal(parseMajorVersion('12.34.56'), 12)
})

test('parseMajorVersion handles pre-release + build metadata', () => {
  assert.equal(parseMajorVersion('1.0.0-beta+sha.deadbeef'), 1)
  assert.equal(parseMajorVersion('0.1.29-rc.1'), 0)
})

test('parseMajorVersion reports null for missing/garbled input', () => {
  assert.equal(parseMajorVersion(null), null)
  assert.equal(parseMajorVersion(undefined), null)
  assert.equal(parseMajorVersion(''), null)
  assert.equal(parseMajorVersion('not-a-version'), null)
})

// ---- resetLauncherConfigIfMajorUpgrade --------------------------------------

test('resetLauncherConfigIfMajorUpgrade is a no-op when the launcher file is missing', () => {
  const dataDir = freshDataDir()
  try {
    // A fresh dir with no ui-launcher.json — never reset, never write.
    const reset = resetLauncherConfigIfMajorUpgrade(dataDir, '1.0.0')
    assert.equal(reset, false)
    // And no file was written behind our back.
    assert.throws(() =>
      readFileSync(launcherConfigPath(dataDir), 'utf8'),
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('KAN-294: same major bump is a no-op for uiHost/port (0.1.29 -> 0.1.30)', () => {
  const dataDir = freshDataDir()
  try {
    // Support hand-set "localhost" for this operator; that choice must survive
    // a patch/minor agent update.
    writeFileSync(
      launcherConfigPath(dataDir),
      JSON.stringify({ uiHost: 'localhost', port: 43101, installedAgentVersion: '0.1.29' }),
    )
    const reset = resetLauncherConfigIfMajorUpgrade(dataDir, '0.1.30')
    assert.equal(reset, false, 'a patch/minor bump must NOT reset')
    const after = readLauncherConfig(dataDir)
    assert.equal(after.uiHost, 'localhost')
    assert.equal(after.port, 43101)
    // Version stamp is refreshed so support can see the current version.
    assert.equal(readLauncherConfigVersion(dataDir), '0.1.30')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('KAN-294: a different major triggers a reset to defaults (0.1.29 -> 1.0.0)', () => {
  const dataDir = freshDataDir()
  try {
    writeFileSync(
      launcherConfigPath(dataDir),
      JSON.stringify({ uiHost: 'localhost', port: 43101, installedAgentVersion: '0.1.29' }),
    )
    const reset = resetLauncherConfigIfMajorUpgrade(dataDir, '1.0.0')
    assert.equal(reset, true)
    const after = readLauncherConfig(dataDir)
    assert.equal(after.uiHost, DEFAULT_LAUNCHER_CONFIG.uiHost)
    assert.equal(after.port, DEFAULT_LAUNCHER_CONFIG.port)
    assert.equal(readLauncherConfigVersion(dataDir), '1.0.0')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('KAN-294: a launcher file with no version stamp is left alone (legacy pre-stamp install)', () => {
  const dataDir = freshDataDir()
  try {
    // Older agent never wrote installedAgentVersion. Refresh the stamp on
    // first run of the new agent, but keep the operator's uiHost choice.
    writeFileSync(
      launcherConfigPath(dataDir),
      JSON.stringify({ uiHost: 'localhost', port: 5000 }),
    )
    const reset = resetLauncherConfigIfMajorUpgrade(dataDir, '1.0.0')
    assert.equal(reset, false)
    const after = readLauncherConfig(dataDir)
    assert.equal(after.uiHost, 'localhost')
    assert.equal(after.port, 5000)
    assert.equal(readLauncherConfigVersion(dataDir), '1.0.0')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('KAN-294: ensureLauncherConfig stamps installedAgentVersion when supplied', () => {
  const dataDir = freshDataDir()
  try {
    ensureLauncherConfig(dataDir, '1.0.0')
    assert.equal(readLauncherConfigVersion(dataDir), '1.0.0')
    // Existing tests pass `undefined` — the optional arg must be backwards-
    // compatible.
    const other = freshDataDir()
    try {
      ensureLauncherConfig(other)
      assert.equal(readLauncherConfigVersion(other), null)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---- evaluateLocalUiDomainHealth -------------------------------------------

test('evaluateLocalUiDomainHealth always reports ok when uiHost is "localhost"', () => {
  const dataDir = freshDataDir()
  try {
    // The launcher is deliberately on the loopback fallback — no banner.
    const health = evaluateLocalUiDomainHealth({ dataDir, uiHost: 'localhost' })
    assert.equal(health.ok, true)
    assert.equal(health.reason, '')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('evaluateLocalUiDomainHealth flags a missing cert for domain mode', () => {
  const dataDir = freshDataDir()
  try {
    const health = evaluateLocalUiDomainHealth({ dataDir, uiHost: 'domain' })
    assert.equal(health.ok, false)
    assert.equal(health.certPresent, false)
    // The reason copy must mention the domain so the operator understands.
    assert.match(health.reason, /local\.printanywhere\.dhruvantasystems\.com/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('evaluateLocalUiDomainHealth reports certPresent when the data dir has the per-host cert', () => {
  const dataDir = freshDataDir()
  try {
    // Lay down fake cert + key files at the paths the agent expects — the
    // health check is file-level, so it does not need a real PEM.
    const paths = localCertPaths(dataDir)
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(paths.keyPath, 'KEY')
    writeFileSync(paths.certPath, 'CERT')
    const health = evaluateLocalUiDomainHealth({ dataDir, uiHost: 'domain' })
    assert.equal(health.certPresent, true)
    // Hosts entry is environment-dependent on the test runner; the cert
    // half of the check is the bit we can deterministically assert here.
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---- hostsFileHasLocalUiEntry ----------------------------------------------

test('hostsFileHasLocalUiEntry recognises the loopback entry', () => {
  const dir = freshDataDir()
  const file = path.join(dir, 'hosts')
  try {
    writeFileSync(
      file,
      [
        '# A hosts file like Windows ships',
        '127.0.0.1 localhost',
        `127.0.0.1 ${LOCAL_UI_DOMAIN}`,
        '# trailing comment',
      ].join('\n'),
    )
    assert.equal(hostsFileHasLocalUiEntry(file), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hostsFileHasLocalUiEntry tolerates inline comments and ::1', () => {
  const dir = freshDataDir()
  const file = path.join(dir, 'hosts')
  try {
    writeFileSync(file, `::1 ${LOCAL_UI_DOMAIN} # added by installer`)
    assert.equal(hostsFileHasLocalUiEntry(file), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hostsFileHasLocalUiEntry rejects a public-IP mapping (defence against tampering)', () => {
  const dir = freshDataDir()
  const file = path.join(dir, 'hosts')
  try {
    writeFileSync(file, `203.0.113.5 ${LOCAL_UI_DOMAIN}`)
    assert.equal(hostsFileHasLocalUiEntry(file), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hostsFileHasLocalUiEntry reports false when the file is missing', () => {
  assert.equal(hostsFileHasLocalUiEntry('/no/such/hosts/file'), false)
})

// ---- runLocalHttpsRepair ----------------------------------------------------

test('probeElevation reports true on non-Windows (test host)', (t) => {
  if (process.platform === 'win32') {
    t.skip('elevation probe is platform-specific; covered by Windows install smoke')
    return
  }
  assert.equal(probeElevation(), true)
})

test('resolveLocalHttpsSetupScript finds the bundled helper in this repo', () => {
  const resolved = resolveLocalHttpsSetupScript()
  assert.ok(resolved, 'expected to find scripts/lib/local-https-setup.ps1')
  assert.match(resolved!, /scripts[\\/]+lib[\\/]+local-https-setup\.ps1$/)
})

test('runLocalHttpsRepair reports "Windows-only" on a non-Windows host', async (t) => {
  if (process.platform === 'win32') {
    t.skip('this assertion is for the dev-host (non-Windows) path')
    return
  }
  const dataDir = freshDataDir()
  try {
    const result = await runLocalHttpsRepair({ dataDir })
    assert.equal(result.ok, false)
    // On Linux/macOS we get either the elevation message (if hosts is not
    // writable) or the Windows-only fallthrough; both are acceptable
    // honest answers and never claim a false success.
    assert.match(
      result.message,
      /Windows-only|administrator/i,
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
