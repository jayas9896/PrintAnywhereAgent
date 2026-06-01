import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import {
  LOCAL_UI_CERT_ORG,
  LOCAL_UI_CERT_SANS,
  LOCAL_UI_DOMAIN,
  ensureLocalCert,
  generateLocalCert,
  localCertPaths,
} from '../src/ui/localHttps.ts'
import {
  DEFAULT_LAUNCHER_CONFIG,
  DEFAULT_UI_PORT,
  ensureLauncherConfig,
  launcherConfigPath,
  readLauncherConfig,
  uiRuntimeInfoPath,
  writeUiRuntimeInfo,
} from '../src/ui/launcherConfig.ts'

// KAN-165: the local UI is served over HTTPS at
// local.printanywhere.dhruvantasystems.com with a per-host self-signed cert.

function freshDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'pa-agent-https-'))
}

// --- certificate ----------------------------------------------------------

test('generateLocalCert issues a cert covering the domain, localhost and 127.0.0.1', async () => {
  const material = await generateLocalCert()
  const cert = new X509Certificate(material.cert)
  // subjectAltName lists every SAN the loopback fallback and the domain need.
  for (const san of LOCAL_UI_CERT_SANS) {
    assert.ok(
      cert.subjectAltName?.includes(san),
      `expected SAN to include ${san}, got: ${cert.subjectAltName}`,
    )
  }
  assert.match(material.key, /BEGIN (RSA )?PRIVATE KEY/)
  // The thumbprint is the colon-free uppercase SHA-1 certutil expects.
  assert.match(material.thumbprint, /^[0-9A-F]+$/)
})

test('generateLocalCert stamps the organization into the cert subject (KAN-451)', async () => {
  const material = await generateLocalCert()
  const cert = new X509Certificate(material.cert)
  // The cert viewer previously showed an empty Organization ("Not part of
  // certificate"); the subject must now carry O=Dhruvanta Systems ... while
  // keeping the CN = the local UI domain.
  assert.match(cert.subject, /O=Dhruvanta Systems Private Limited/)
  assert.equal(LOCAL_UI_CERT_ORG, 'Dhruvanta Systems Private Limited')
  assert.match(cert.subject, new RegExp(`CN=${LOCAL_UI_DOMAIN.replace(/\./g, '\\.')}`))
})

test('generateLocalCert issues a long-lived (multi-year) certificate', async () => {
  const material = await generateLocalCert()
  const cert = new X509Certificate(material.cert)
  const lifetimeMs = new Date(cert.validTo).getTime() - new Date(cert.validFrom).getTime()
  const lifetimeYears = lifetimeMs / (365 * 24 * 60 * 60 * 1000)
  assert.ok(lifetimeYears > 5, `expected a >5y cert, got ~${lifetimeYears.toFixed(1)}y`)
})

test('ensureLocalCert persists the key 0600 and reuses it on the next call', async () => {
  const dataDir = freshDataDir()
  try {
    const first = await ensureLocalCert(dataDir)
    const paths = localCertPaths(dataDir)
    assert.equal(first.paths.keyPath, paths.keyPath)
    // The key file must exist and never be group/other readable.
    if (process.platform !== 'win32') {
      const { mode } = statSync(paths.keyPath)
      assert.equal(mode & 0o077, 0, 'private key must not be group/other readable')
    }
    // Second call reuses the same material rather than regenerating.
    const second = await ensureLocalCert(dataDir)
    assert.equal(second.cert, first.cert)
    assert.equal(second.key, first.key)
    assert.equal(second.thumbprint, first.thumbprint)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('ensureLocalCert regenerates when the stored cert is unreadable', async () => {
  const dataDir = freshDataDir()
  try {
    const first = await ensureLocalCert(dataDir)
    const paths = localCertPaths(dataDir)
    writeFileSync(paths.certPath, 'not a certificate')
    const second = await ensureLocalCert(dataDir)
    assert.notEqual(second.cert, first.cert)
    assert.match(second.cert, /BEGIN CERTIFICATE/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// --- launcher config ------------------------------------------------------

test('ensureLauncherConfig writes a documented default file once', () => {
  const dataDir = freshDataDir()
  try {
    ensureLauncherConfig(dataDir)
    const raw = readFileSync(launcherConfigPath(dataDir), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    assert.equal(parsed.uiHost, 'domain')
    assert.equal(parsed.port, DEFAULT_UI_PORT)
    // A comment header is present so support can talk a user through edits.
    assert.match(String(parsed._comment), /localhost/)
    // Idempotent: a hand-edited file is never clobbered.
    writeFileSync(launcherConfigPath(dataDir), JSON.stringify({ uiHost: 'localhost', port: 5000 }))
    ensureLauncherConfig(dataDir)
    assert.equal(readLauncherConfig(dataDir).uiHost, 'localhost')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('readLauncherConfig falls back to defaults for a missing or malformed file', () => {
  const dataDir = freshDataDir()
  try {
    assert.deepEqual(readLauncherConfig(dataDir), DEFAULT_LAUNCHER_CONFIG)
    writeFileSync(launcherConfigPath(dataDir), '{ not json')
    assert.deepEqual(readLauncherConfig(dataDir), DEFAULT_LAUNCHER_CONFIG)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('readLauncherConfig normalizes an out-of-range port and unknown uiHost', () => {
  const dataDir = freshDataDir()
  try {
    writeFileSync(launcherConfigPath(dataDir), JSON.stringify({ uiHost: 'banana', port: 999999 }))
    const config = readLauncherConfig(dataDir)
    assert.equal(config.uiHost, 'domain')
    assert.equal(config.port, DEFAULT_UI_PORT)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// --- runtime info ---------------------------------------------------------

test('writeUiRuntimeInfo records the actual listening port for the launcher', () => {
  const dataDir = freshDataDir()
  try {
    writeUiRuntimeInfo(dataDir, {
      scheme: 'https',
      port: 43101,
      domain: LOCAL_UI_DOMAIN,
      loopbackHost: '127.0.0.1',
    })
    const info = JSON.parse(readFileSync(uiRuntimeInfoPath(dataDir), 'utf8')) as Record<
      string,
      unknown
    >
    assert.equal(info.scheme, 'https')
    assert.equal(info.port, 43101)
    assert.equal(info.domain, LOCAL_UI_DOMAIN)
    assert.equal(info.loopbackHost, '127.0.0.1')
    assert.match(String(info.updatedAt), /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
