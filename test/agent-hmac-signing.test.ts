import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'

import { AGENT_SIG_VERSION, signRequest } from '../src/core/crypto.js'

const SECRET_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

function expectedSignature(ts: number, method: string, path: string, body: string): string {
  const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex')
  const input = `${ts}\n${method.toUpperCase()}\n${path}\n${bodyHash}`
  return crypto.createHmac('sha256', Buffer.from(SECRET_HEX, 'hex')).update(input, 'utf8').digest('hex')
}

test('signRequest covers the request body in the signing input (KAN-92 v2)', () => {
  const ts = 1_700_000_000_000
  const path = '/api/agent/printers'
  const body = '{"printers":[]}'

  const sig = signRequest(ts, 'POST', path, SECRET_HEX, body)
  assert.equal(sig, expectedSignature(ts, 'POST', path, body))
})

test('a different body produces a different signature', () => {
  const ts = 1_700_000_000_000
  const path = '/api/agent/printers'

  const signed = signRequest(ts, 'POST', path, SECRET_HEX, '{"printers":[]}')
  const tampered = signRequest(ts, 'POST', path, SECRET_HEX, '{"printers":["injected"]}')
  assert.notEqual(signed, tampered)
})

test('bodyless requests sign over the empty-string hash', () => {
  const ts = 1_700_000_000_000
  const path = '/api/agent/jobs/poll'

  // Omitting the body argument must be identical to passing ''.
  assert.equal(
    signRequest(ts, 'GET', path, SECRET_HEX),
    signRequest(ts, 'GET', path, SECRET_HEX, ''),
  )
  assert.equal(
    signRequest(ts, 'GET', path, SECRET_HEX),
    expectedSignature(ts, 'GET', path, ''),
  )
})

test('the agent advertises signature scheme version 2', () => {
  assert.equal(AGENT_SIG_VERSION, '2')
})
