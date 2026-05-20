/**
 * KAN-299: regression tests for the loopback origin check used by every
 * `/actions/*` POST. The bug was that browsers occasionally send
 * `Origin: null` (sandboxed iframes, certain extensions, redirect chains,
 * stale service workers) and `new URL("null")` threw, producing a silent
 * 403 "Local UI origin check failed" that prevented a paired-shop owner
 * from clicking "Generate new pairing code".
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Request, Response } from 'express'
import type { AgentRuntime } from '../src/runtime/agentRuntime.ts'
import {
  isLoopbackHostHeader,
  isLoopbackOrigin,
  verifyUiRequest,
} from '../src/ui/server.ts'

// ---- verifyUiRequest fakes ---------------------------------------------------

/** Minimal AgentRuntime stub — only the bits verifyUiRequest reaches into. */
function fakeRuntime(): AgentRuntime {
  return {
    verifyUiToken: () => true,
    snapshot: () => ({ uiToken: 'tok' }),
  } as unknown as AgentRuntime
}

/** Build an Express-shaped request from a small headers map plus uiToken. */
function fakeRequest(headers: Record<string, string | undefined>, uiToken = 'tok') {
  const lower: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    body: { uiToken },
    get(name: string) {
      return lower[name.toLowerCase()]
    },
  } as unknown as Request
}

/** Capture status + body so a test can assert what the response would be. */
function fakeResponse() {
  const captured: { status: number; body: string; type: string } = {
    status: 0,
    body: '',
    type: '',
  }
  const response = {
    status(code: number) {
      captured.status = code
      return response
    },
    type(t: string) {
      captured.type = t
      return response
    },
    send(body: string) {
      captured.body = body
      return response
    },
  }
  return { response: response as unknown as Response, captured }
}

// ---- isLoopbackOrigin --------------------------------------------------------

test('isLoopbackOrigin allows a missing Origin header (same-origin form POST)', () => {
  assert.equal(isLoopbackOrigin(undefined), true)
})

test('isLoopbackOrigin allows the literal string "null" (KAN-299)', () => {
  // Sandboxed iframes / certain extensions / redirect chains send this. The
  // uiToken still gates real authentication, so it is safe to accept here.
  assert.equal(isLoopbackOrigin('null'), true)
})

test('isLoopbackOrigin allows every same-machine loopback origin', () => {
  for (const candidate of [
    'http://127.0.0.1:43100',
    'https://127.0.0.1:43100',
    'http://localhost:43100',
    'https://localhost',
    'https://local.printanywhere.dhruvantasystems.com:43100',
    'https://local.printanywhere.dhruvantasystems.com',
  ]) {
    assert.equal(isLoopbackOrigin(candidate), true, `expected ${candidate} to be allowed`)
  }
})

test('isLoopbackOrigin rejects any off-machine origin', () => {
  for (const candidate of [
    'http://attacker.example',
    'https://evil.local.printanywhere.dhruvantasystems.com.attacker.example',
    'https://203.0.113.5',
    'https://example.com:43100',
  ]) {
    assert.equal(isLoopbackOrigin(candidate), false, `expected ${candidate} to be rejected`)
  }
})

test('isLoopbackOrigin rejects malformed garbage (not "null")', () => {
  // The literal "null" is explicitly allowed (above) — but any *other* string
  // that does not parse as a URL must still be rejected.
  assert.equal(isLoopbackOrigin('not a url'), false)
  assert.equal(isLoopbackOrigin('javascript:void(0)'), false)
})

// ---- isLoopbackHostHeader ----------------------------------------------------

test('isLoopbackHostHeader accepts the local UI domain with a port', () => {
  assert.equal(
    isLoopbackHostHeader('local.printanywhere.dhruvantasystems.com:43100'),
    true,
  )
})

test('isLoopbackHostHeader accepts a raw loopback IP with a port', () => {
  assert.equal(isLoopbackHostHeader('127.0.0.1:43100'), true)
  assert.equal(isLoopbackHostHeader('localhost:43100'), true)
})

test('isLoopbackHostHeader accepts a bracketed IPv6 loopback', () => {
  assert.equal(isLoopbackHostHeader('[::1]:43100'), true)
})

test('isLoopbackHostHeader rejects an off-machine host', () => {
  assert.equal(isLoopbackHostHeader('attacker.example:43100'), false)
  assert.equal(isLoopbackHostHeader('203.0.113.5:43100'), false)
})

test('isLoopbackHostHeader rejects an empty/missing Host header', () => {
  assert.equal(isLoopbackHostHeader(undefined), false)
  assert.equal(isLoopbackHostHeader(''), false)
  assert.equal(isLoopbackHostHeader('   '), false)
})

// ---- verifyUiRequest (request-level) ----------------------------------------

test('verifyUiRequest accepts a normal loopback POST with Origin + Referer', () => {
  const { response, captured } = fakeResponse()
  const ok = verifyUiRequest(
    fakeRuntime(),
    fakeRequest({
      origin: 'http://127.0.0.1:43100',
      referer: 'http://127.0.0.1:43100/',
      host: '127.0.0.1:43100',
    }),
    response,
  )
  assert.equal(ok, true)
  assert.equal(captured.status, 0, 'no error response was sent')
})

test('KAN-299: verifyUiRequest accepts Origin: "null" (sandboxed iframe / extension)', () => {
  const { response, captured } = fakeResponse()
  const ok = verifyUiRequest(
    fakeRuntime(),
    fakeRequest({
      origin: 'null',
      referer: 'http://127.0.0.1:43100/',
      host: '127.0.0.1:43100',
    }),
    response,
  )
  assert.equal(ok, true)
  assert.equal(captured.status, 0)
})

test('KAN-299: verifyUiRequest falls back to Host when Origin AND Referer are absent', () => {
  const { response, captured } = fakeResponse()
  const ok = verifyUiRequest(
    fakeRuntime(),
    fakeRequest({ host: 'local.printanywhere.dhruvantasystems.com:43100' }),
    response,
  )
  assert.equal(ok, true)
  assert.equal(captured.status, 0)
})

test('KAN-299: verifyUiRequest falls back to Host when Origin AND Referer are "null"', () => {
  const { response, captured } = fakeResponse()
  const ok = verifyUiRequest(
    fakeRuntime(),
    fakeRequest({ origin: 'null', referer: 'null', host: '127.0.0.1:43100' }),
    response,
  )
  assert.equal(ok, true)
  assert.equal(captured.status, 0)
})

test('KAN-299: verifyUiRequest STILL rejects an off-machine Origin', () => {
  const { response, captured } = fakeResponse()
  const ok = verifyUiRequest(
    fakeRuntime(),
    fakeRequest({
      origin: 'http://attacker.example',
      referer: 'http://127.0.0.1:43100/',
      host: '127.0.0.1:43100',
    }),
    response,
  )
  assert.equal(ok, false)
  assert.equal(captured.status, 403)
  assert.match(captured.body, /Local UI origin check failed/)
  // Diagnostics: each field is surfaced in the response body so an operator
  // and support can see exactly which header was wrong (KAN-299 silent-403
  // fix). The endpoint is loopback-only — no information disclosure risk.
  assert.match(captured.body, /origin="http:\/\/attacker\.example"/)
  assert.match(captured.body, /host="127\.0\.0\.1:43100"/)
})

test('KAN-299: verifyUiRequest rejects when both Origin/Referer absent AND Host is off-machine', () => {
  const { response, captured } = fakeResponse()
  const ok = verifyUiRequest(
    fakeRuntime(),
    fakeRequest({ host: 'attacker.example:43100' }),
    response,
  )
  assert.equal(ok, false)
  assert.equal(captured.status, 403)
})

test('verifyUiRequest rejects an invalid uiToken before the origin check runs', () => {
  const runtime = {
    verifyUiToken: () => false,
    snapshot: () => ({ uiToken: 'tok' }),
  } as unknown as AgentRuntime
  const { response, captured } = fakeResponse()
  const ok = verifyUiRequest(runtime, fakeRequest({}, 'wrong'), response)
  assert.equal(ok, false)
  assert.equal(captured.status, 403)
  assert.match(captured.body, /Invalid local UI token/)
})
