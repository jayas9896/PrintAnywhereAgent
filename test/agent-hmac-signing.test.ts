import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'

import { AGENT_SIG_VERSION, generateNonce, signRequest } from '../src/core/crypto.js'

const SECRET_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
const NONCE = 'fedcba9876543210fedcba9876543210'

function expectedSignature(
  ts: number,
  method: string,
  path: string,
  nonce: string,
  body: string,
): string {
  const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex')
  // Backend v2 (AgentAuthenticationFilter): ts\nMETHOD\npath\nsha256hex(body)\nNONCE — nonce LAST.
  const input = `${ts}\n${method.toUpperCase()}\n${path}\n${bodyHash}\n${nonce}`
  return crypto.createHmac('sha256', Buffer.from(SECRET_HEX, 'hex')).update(input, 'utf8').digest('hex')
}

test('signRequest covers body AND the nonce in the signing input (KAN-451 v2)', () => {
  const ts = 1_700_000_000_000
  const path = '/api/agent/printers'
  const body = '{"printers":[]}'

  const sig = signRequest(ts, 'POST', path, SECRET_HEX, NONCE, body)
  assert.equal(sig, expectedSignature(ts, 'POST', path, NONCE, body))
})

test('a different body produces a different signature', () => {
  const ts = 1_700_000_000_000
  const path = '/api/agent/printers'

  const signed = signRequest(ts, 'POST', path, SECRET_HEX, NONCE, '{"printers":[]}')
  const tampered = signRequest(ts, 'POST', path, SECRET_HEX, NONCE, '{"printers":["injected"]}')
  assert.notEqual(signed, tampered)
})

test('a different nonce produces a different signature', () => {
  const ts = 1_700_000_000_000
  const path = '/api/agent/printers'
  const body = '{"printers":[]}'

  const a = signRequest(ts, 'POST', path, SECRET_HEX, NONCE, body)
  const b = signRequest(ts, 'POST', path, SECRET_HEX, '0011223344556677', body)
  assert.notEqual(a, b)
})

test('bodyless requests sign over the empty-string hash', () => {
  const ts = 1_700_000_000_000
  const path = '/api/agent/jobs/poll'

  // Omitting the body argument must be identical to passing ''.
  assert.equal(
    signRequest(ts, 'GET', path, SECRET_HEX, NONCE),
    signRequest(ts, 'GET', path, SECRET_HEX, NONCE, ''),
  )
  assert.equal(
    signRequest(ts, 'GET', path, SECRET_HEX, NONCE),
    expectedSignature(ts, 'GET', path, NONCE, ''),
  )
})

test('the agent advertises signature scheme version 2', () => {
  assert.equal(AGENT_SIG_VERSION, '2')
})

test('generateNonce returns a fresh hex nonce within the backend length limit', () => {
  const a = generateNonce()
  const b = generateNonce()
  // 16 random bytes => 32 hex chars; backend rejects nonce.length() > 128.
  assert.match(a, /^[0-9a-f]{32}$/)
  assert.match(b, /^[0-9a-f]{32}$/)
  assert.ok(a.length <= 128)
  // Single-use on the backend: two calls must not collide.
  assert.notEqual(a, b)
})
