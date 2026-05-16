import assert from 'node:assert/strict'
import test from 'node:test'
import crypto from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { decryptStringMigrating, decryptString, encryptString } from '../src/core/crypto.ts'
import { checkPrinterAllowed } from '../src/runtime/agentRuntime.ts'
import type { LocalPrinter } from '../src/config/types.ts'

// =========================================================================
// KAN-60 AG-M1 — at-rest key migration (legacy public-key -> salted key)
// =========================================================================

test('decryptStringMigrating reads material encrypted under the primary key', () => {
  const primary = crypto.randomBytes(32)
  const legacy = crypto.randomBytes(32)
  const enc = encryptString('agent-secret-xyz', primary)
  const result = decryptStringMigrating(enc, primary, legacy)
  assert.equal(result.value, 'agent-secret-xyz')
  assert.equal(result.usedLegacyKey, false)
})

test('decryptStringMigrating falls back to the legacy key for old material', () => {
  const primary = crypto.randomBytes(32)
  const legacy = crypto.randomBytes(32)
  const enc = encryptString('legacy-agent-secret', legacy)
  const result = decryptStringMigrating(enc, primary, legacy)
  assert.equal(result.value, 'legacy-agent-secret')
  assert.equal(result.usedLegacyKey, true)
})

test('decryptStringMigrating throws when neither key can decrypt', () => {
  const primary = crypto.randomBytes(32)
  const legacy = crypto.randomBytes(32)
  const enc = encryptString('whatever', crypto.randomBytes(32))
  assert.throws(() => decryptStringMigrating(enc, primary, legacy))
})

test('legacy material re-encrypted under the new key is readable as new material', () => {
  // Simulates the migrateEncryptedMaterial() round trip.
  const primary = crypto.randomBytes(32)
  const legacy = crypto.randomBytes(32)
  const oldBlob = encryptString('rsa-private-key-pem', legacy)
  const migrating = decryptStringMigrating(oldBlob, primary, legacy)
  assert.equal(migrating.usedLegacyKey, true)
  const newBlob = encryptString(migrating.value, primary)
  assert.equal(decryptString(newBlob, primary), 'rsa-private-key-pem')
  assert.equal(decryptStringMigrating(newBlob, primary, legacy).usedLegacyKey, false)
})

// AG-M1: the salted key derivation must depend on the per-install salt, so a
// process that cannot read the 0600 salt file cannot recompute the key.
test('AG-M1: a different salt yields a different machine key', () => {
  const machineMaterial = Buffer.from('printanywhere-agent:HOST_ABC123', 'utf8')
  const info = Buffer.from('printanywhere-agent-at-rest-key', 'utf8')
  const keyA = Buffer.from(crypto.hkdfSync('sha256', machineMaterial, crypto.randomBytes(32), info, 32))
  const keyB = Buffer.from(crypto.hkdfSync('sha256', machineMaterial, crypto.randomBytes(32), info, 32))
  assert.notEqual(keyA.toString('hex'), keyB.toString('hex'))
  // Same salt + same machine material is deterministic (so the agent can decrypt).
  const salt = crypto.randomBytes(32)
  const keyC = Buffer.from(crypto.hkdfSync('sha256', machineMaterial, salt, info, 32))
  const keyD = Buffer.from(crypto.hkdfSync('sha256', machineMaterial, salt, info, 32))
  assert.equal(keyC.toString('hex'), keyD.toString('hex'))
})

// Mirrors migrateEncryptedMaterial(): walk all three at-rest blobs (RSA private
// key, agent secret, signing secret), re-encrypt any legacy-key blob under the
// new key, and confirm every blob is then readable as new-key material — i.e.
// the install does NOT need to re-pair after the key-derivation change.
test('AG-M1: all three encrypted blobs survive a legacy->new key migration', () => {
  const primary = crypto.randomBytes(32)
  const legacy = crypto.randomBytes(32)
  const blobs = {
    encryptedPrivateKeyPem: encryptString('rsa-pem-body', legacy),
    encryptedAgentSecret: encryptString('agent-secret-body', legacy),
    encryptedSigningSecret: encryptString('signing-secret-body', legacy),
  }
  let changed = false
  const reEncrypt = (enc: string) => {
    const { value, usedLegacyKey } = decryptStringMigrating(enc, primary, legacy)
    if (!usedLegacyKey) return enc
    changed = true
    return encryptString(value, primary)
  }
  const migrated = {
    encryptedPrivateKeyPem: reEncrypt(blobs.encryptedPrivateKeyPem),
    encryptedAgentSecret: reEncrypt(blobs.encryptedAgentSecret),
    encryptedSigningSecret: reEncrypt(blobs.encryptedSigningSecret),
  }
  assert.equal(changed, true, 'legacy blobs must be detected and re-encrypted')
  assert.equal(decryptString(migrated.encryptedPrivateKeyPem, primary), 'rsa-pem-body')
  assert.equal(decryptString(migrated.encryptedAgentSecret, primary), 'agent-secret-body')
  assert.equal(decryptString(migrated.encryptedSigningSecret, primary), 'signing-secret-body')
  // Already-new material is left untouched (no needless re-encryption / churn).
  changed = false
  reEncrypt(encryptString('already-new', primary))
  assert.equal(changed, false)
})

// =========================================================================
// KAN-60 AG-M2 — data dir location + secure file/dir permissions
// =========================================================================

test('AG-M2: resolveDataDir defaults to a per-user location, not the CWD', async () => {
  const saved = { ...process.env }
  delete process.env.PRINTANYWHERE_AGENT_DATA_DIR
  try {
    // Re-import fresh so module-level reads of env are re-evaluated.
    const machine = await import(`../src/core/machine.ts?case=peruser-${Date.now()}`)
    const dir = machine.resolveDataDir()
    assert.notEqual(path.resolve(dir), path.resolve(process.cwd(), 'data'))
    if (process.platform === 'win32') {
      assert.match(dir, /PrintAnywhere[\\/]Agent$/)
    } else {
      assert.match(dir, /printanywhere-agent$/)
    }
  } finally {
    process.env = saved
  }
})

test('AG-M2: explicit PRINTANYWHERE_AGENT_DATA_DIR override still wins', async () => {
  const saved = { ...process.env }
  const override = path.join(os.tmpdir(), `pa-override-${Date.now()}`)
  process.env.PRINTANYWHERE_AGENT_DATA_DIR = override
  try {
    const machine = await import(`../src/core/machine.ts?case=override-${Date.now()}`)
    assert.equal(path.resolve(machine.resolveDataDir()), path.resolve(override))
  } finally {
    process.env = saved
  }
})

test('AG-M2: AgentStore.save writes the state file 0600 and the dir 0700', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX mode bits are not enforced on Windows')
    return
  }
  const saved = { ...process.env }
  const dir = path.join(os.tmpdir(), `pa-store-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)
  process.env.PRINTANYWHERE_AGENT_DATA_DIR = dir
  try {
    const { AgentStore } = await import(`../src/config/store.ts?case=perm-${Date.now()}`)
    const store = new AgentStore()
    await store.save({ sharedPrinters: {}, printers: [], uiToken: 'plaintext-ui-token' })
    const fileMode = fs.statSync(store.statePath).mode & 0o777
    const dirMode = fs.statSync(store.dataDir).mode & 0o777
    assert.equal(fileMode, 0o600, `state file must be 0600, got ${fileMode.toString(8)}`)
    assert.equal(dirMode, 0o700, `data dir must be 0700, got ${dirMode.toString(8)}`)
  } finally {
    process.env = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('AG-M2: an existing world-readable state file is tightened to 0600 on load', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX mode bits are not enforced on Windows')
    return
  }
  const saved = { ...process.env }
  const dir = path.join(os.tmpdir(), `pa-store-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)
  process.env.PRINTANYWHERE_AGENT_DATA_DIR = dir
  try {
    fs.mkdirSync(dir, { recursive: true })
    const statePath = path.join(dir, 'agent-state.json')
    // Simulate a file written by an older agent version: world-readable 0644.
    fs.writeFileSync(statePath, JSON.stringify({ sharedPrinters: {}, printers: [] }), { mode: 0o644 })
    fs.chmodSync(statePath, 0o644)
    const { AgentStore } = await import(`../src/config/store.ts?case=tighten-${Date.now()}`)
    const store = new AgentStore()
    await store.load()
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600)
  } finally {
    process.env = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('AG-M2: migrateLegacyDataDir moves a legacy <cwd>/data install into the new dir', async (t) => {
  const saved = { ...process.env }
  const sandbox = path.join(os.tmpdir(), `pa-mig-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)
  const legacy = path.join(sandbox, 'data')
  const target = path.join(sandbox, 'newhome')
  const originalCwd = process.cwd()
  try {
    fs.mkdirSync(legacy, { recursive: true })
    fs.writeFileSync(path.join(legacy, 'agent-state.json'), '{"sharedPrinters":{},"printers":[],"uiToken":"legacy-tok"}')
    fs.writeFileSync(path.join(legacy, 'agent-key-salt.bin'), crypto.randomBytes(32))
    process.chdir(sandbox) // so legacyDataDir() resolves to <sandbox>/data
    delete process.env.PRINTANYWHERE_AGENT_DATA_DIR
    const machine = await import(`../src/core/machine.ts?case=migdir-${Date.now()}`)
    const moved = machine.migrateLegacyDataDir(target)
    assert.equal(moved, true)
    assert.ok(fs.existsSync(path.join(target, 'agent-state.json')), 'state file copied')
    assert.ok(fs.existsSync(path.join(target, 'agent-key-salt.bin')), 'salt file copied')
    const state = JSON.parse(fs.readFileSync(path.join(target, 'agent-state.json'), 'utf8'))
    assert.equal(state.uiToken, 'legacy-tok', 'identity preserved through migration')
    // Idempotent: a second run finds the target already populated and is a no-op.
    assert.equal(machine.migrateLegacyDataDir(target), false)
  } finally {
    process.chdir(originalCwd)
    process.env = saved
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

// =========================================================================
// KAN-60 AG-M3 — backend-supplied printerName must be in the allow-list
// =========================================================================

function printer(name: string, shared: boolean): LocalPrinter {
  return {
    localPrinterName: name,
    connectionType: 'USB',
    supportsColor: true,
    supportsDuplex: false,
    supportedPaperSizes: ['A4'],
    isDefault: false,
    status: 'READY',
    shared,
  }
}

test('AG-M3: a shared printer named by the backend is allowed', () => {
  const printers = [printer('Front Desk HP', true), printer('Back Office Canon', false)]
  assert.equal(checkPrinterAllowed('Front Desk HP', printers), null)
})

test('AG-M3: a non-shared printer named by the backend is rejected', () => {
  const printers = [printer('Front Desk HP', true), printer('Back Office Canon', false)]
  const reason = checkPrinterAllowed('Back Office Canon', printers)
  assert.match(reason ?? '', /not in this shop's shared/i)
})

test('AG-M3: an unknown printer named by the backend is rejected', () => {
  const printers = [printer('Front Desk HP', true)]
  const reason = checkPrinterAllowed('Attacker Network Printer', printers)
  assert.match(reason ?? '', /not in this shop's shared/i)
})

test('AG-M3: an empty/missing printer name is rejected', () => {
  const printers = [printer('Front Desk HP', true)]
  assert.match(checkPrinterAllowed('', printers) ?? '', /did not specify a printer/i)
  assert.match(checkPrinterAllowed('   ', printers) ?? '', /did not specify a printer/i)
})
