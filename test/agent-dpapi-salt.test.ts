import assert from 'node:assert/strict'
import test from 'node:test'
import crypto from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import {
  PassthroughProtector,
  defaultKeyMaterialProtector,
  type KeyMaterialProtector,
} from '../src/core/dpapi.ts'
import {
  loadOrCreateKeySalt,
  deriveMachineKey,
  isWrappedSalt,
  SALT_WRAP_MAGIC,
  SALT_LENGTH,
  KEY_SALT_FILE,
} from '../src/core/machine.ts'

// =========================================================================
// KAN-62 — wrap the agent at-rest key (salt) in an OS keystore (Windows DPAPI)
// =========================================================================

/**
 * A reversible-but-fake protector that lets the wrap/migrate paths be
 * exercised deterministically on Linux CI, where real DPAPI is unavailable.
 * XOR with a fixed pad: not secure, but a faithful stand-in for "the bytes
 * change on protect and come back on unprotect".
 */
class XorProtector implements KeyMaterialProtector {
  readonly bindsToOsKeystore = true
  private readonly pad = Buffer.from('kan62-fake-protector-pad-bytes!!', 'utf8')
  private xor(buf: Buffer): Buffer {
    const out = Buffer.alloc(buf.length)
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ this.pad[i % this.pad.length]
    return out
  }
  async protect(plain: Buffer) {
    return this.xor(plain)
  }
  async unprotect(wrapped: Buffer) {
    return this.xor(wrapped)
  }
}

function tmpDir() {
  return path.join(os.tmpdir(), `pa-dpapi-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)
}

test('KAN-62: PassthroughProtector round-trips a blob unchanged', async () => {
  const p = new PassthroughProtector()
  const secret = crypto.randomBytes(32)
  const wrapped = await p.protect(secret)
  assert.equal(p.bindsToOsKeystore, false)
  assert.deepEqual(await p.unprotect(wrapped), secret)
})

test('KAN-62: defaultKeyMaterialProtector picks DPAPI on Windows, passthrough elsewhere', () => {
  const p = defaultKeyMaterialProtector()
  if (process.platform === 'win32') {
    assert.equal(p.bindsToOsKeystore, true, 'Windows must bind to the DPAPI keystore')
  } else {
    assert.equal(p.bindsToOsKeystore, false, 'non-Windows uses the passthrough protector')
  }
})

test('KAN-62: a fresh install writes a salt file in the wrapped (magic-header) format', async () => {
  const dir = tmpDir()
  try {
    const salt = await loadOrCreateKeySalt(dir, new XorProtector())
    assert.equal(salt.length, SALT_LENGTH)
    const raw = fs.readFileSync(path.join(dir, KEY_SALT_FILE))
    assert.ok(isWrappedSalt(raw), 'salt file must carry the KAN-62 magic header')
    // The on-disk payload must NOT be the raw salt — it is protected.
    assert.notEqual(raw.subarray(SALT_WRAP_MAGIC.length).toString('hex'), salt.toString('hex'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('KAN-62: a wrapped salt is unwrapped back to the same 32 bytes on reload', async () => {
  const dir = tmpDir()
  try {
    const protector = new XorProtector()
    const first = await loadOrCreateKeySalt(dir, protector)
    const second = await loadOrCreateKeySalt(dir, protector)
    assert.deepEqual(second, first, 'reload must recover the identical salt')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('KAN-62 migration: a legacy 32-byte plaintext salt is auto-migrated to wrapped format', async () => {
  const dir = tmpDir()
  try {
    // Simulate a KAN-60 install: a raw 32-byte plaintext salt, no header.
    fs.mkdirSync(dir, { recursive: true })
    const legacySalt = crypto.randomBytes(SALT_LENGTH)
    const saltPath = path.join(dir, KEY_SALT_FILE)
    fs.writeFileSync(saltPath, legacySalt, { mode: 0o600 })
    assert.equal(isWrappedSalt(fs.readFileSync(saltPath)), false, 'precondition: legacy file is unwrapped')

    const protector = new XorProtector()
    // First load reads the legacy salt and must return its exact bytes...
    const loaded = await loadOrCreateKeySalt(dir, protector)
    assert.deepEqual(loaded, legacySalt, 'legacy salt value must be preserved (no re-pair)')
    // ...and rewrite the file in the wrapped format.
    const onDisk = fs.readFileSync(saltPath)
    assert.ok(isWrappedSalt(onDisk), 'salt file must be re-written wrapped after migration')
    // A subsequent load goes through the unwrap path and still recovers it.
    assert.deepEqual(await loadOrCreateKeySalt(dir, protector), legacySalt)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('KAN-62: deriveMachineKey is deterministic across reloads and depends on the salt', async () => {
  const dirA = tmpDir()
  const dirB = tmpDir()
  try {
    const protector = new XorProtector()
    const keyA1 = await deriveMachineKey(dirA, protector)
    const keyA2 = await deriveMachineKey(dirA, protector)
    assert.deepEqual(keyA2, keyA1, 'same install must derive the same key after a reload')
    const keyB = await deriveMachineKey(dirB, protector)
    assert.notEqual(keyB.toString('hex'), keyA1.toString('hex'), 'a different salt yields a different key')
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true })
    fs.rmSync(dirB, { recursive: true, force: true })
  }
})

test('KAN-62: a corrupt (truncated) salt file is regenerated rather than trusted', async () => {
  const dir = tmpDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
    // 10 bytes: neither a valid 32-byte legacy salt nor a wrapped file.
    fs.writeFileSync(path.join(dir, KEY_SALT_FILE), crypto.randomBytes(10), { mode: 0o600 })
    const salt = await loadOrCreateKeySalt(dir, new XorProtector())
    assert.equal(salt.length, SALT_LENGTH, 'a fresh valid salt must be generated')
    assert.ok(isWrappedSalt(fs.readFileSync(path.join(dir, KEY_SALT_FILE))))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('KAN-62: the migrated salt file stays 0600', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX mode bits are not enforced on Windows')
    return
  }
  const dir = tmpDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
    const saltPath = path.join(dir, KEY_SALT_FILE)
    fs.writeFileSync(saltPath, crypto.randomBytes(SALT_LENGTH), { mode: 0o644 })
    fs.chmodSync(saltPath, 0o644)
    await loadOrCreateKeySalt(dir, new XorProtector())
    assert.equal(fs.statSync(saltPath).mode & 0o777, 0o600, 'salt file must be tightened to 0600')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// Windows-only: exercise the real DPAPI Protect/Unprotect round trip. Skipped
// on CI (Linux); documents the production code path on a real Windows host.
test('KAN-62: real Windows DPAPI protects and unprotects the salt', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('DPAPI is Windows-only; this test documents the real keystore path')
    return
  }
  const dir = tmpDir()
  try {
    const salt1 = await loadOrCreateKeySalt(dir, defaultKeyMaterialProtector())
    const salt2 = await loadOrCreateKeySalt(dir, defaultKeyMaterialProtector())
    assert.equal(salt1.length, SALT_LENGTH)
    assert.deepEqual(salt2, salt1, 'DPAPI round trip must recover the salt')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
