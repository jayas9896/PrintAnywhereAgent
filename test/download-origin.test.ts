import assert from 'node:assert/strict'
import test from 'node:test'
import { CloudApiClient, assertSameOrigin } from '../src/cloud/api.ts'

// --- KAN-59: agent must not trust a server-supplied cross-origin downloadUrl ---
// A malicious/compromised/buggy backend can name an attacker-controlled host in
// the poll-response `downloadUrl`. The agent attaches its long-lived
// `Authorization: Bearer <agentSecret>` to the download fetch, so a cross-origin
// URL would harvest the secret and could pivot SSRF onto the print-shop LAN.

const BACKEND = 'https://api.dhruvantasystems.net/printanywhere'

// --- assertSameOrigin (pure unit) -----------------------------------------

test('assertSameOrigin accepts a same-origin download URL', () => {
  const url = assertSameOrigin(BACKEND, 'https://api.dhruvantasystems.net/jobs/abc/download')
  assert.equal(url.origin, 'https://api.dhruvantasystems.net')
})

test('assertSameOrigin accepts a same-origin URL even on a different path', () => {
  // Origin is scheme+host+port — path differences are fine.
  const url = assertSameOrigin(BACKEND, 'https://api.dhruvantasystems.net/anything/here')
  assert.equal(url.origin, 'https://api.dhruvantasystems.net')
})

test('assertSameOrigin rejects a different host', () => {
  assert.throws(
    () => assertSameOrigin(BACKEND, 'https://evil.attacker.example/steal'),
    /different origin/i,
  )
})

test('assertSameOrigin rejects a different scheme', () => {
  assert.throws(
    () => assertSameOrigin(BACKEND, 'http://api.dhruvantasystems.net/jobs/abc/download'),
    /different origin/i,
  )
})

test('assertSameOrigin rejects a different port', () => {
  assert.throws(
    () => assertSameOrigin(BACKEND, 'https://api.dhruvantasystems.net:8443/jobs/abc/download'),
    /different origin/i,
  )
})

test('assertSameOrigin rejects an SSRF pivot onto the print-shop LAN', () => {
  assert.throws(
    () => assertSameOrigin(BACKEND, 'http://192.168.1.10/admin'),
    /different origin/i,
  )
})

test('assertSameOrigin rejects a non-URL download value', () => {
  assert.throws(() => assertSameOrigin(BACKEND, 'not-a-url'), /not a valid URL/i)
})

// --- download() does not send the credential to a cross-origin URL --------

test('download() rejects a mismatched-origin URL and never invokes fetch', async () => {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls += 1
    throw new Error('fetch must not be called for a cross-origin download URL')
  }) as typeof fetch
  try {
    const client = new CloudApiClient(BACKEND)
    await assert.rejects(
      () => client.download('super-secret-agent-token', 'https://evil.attacker.example/steal', 'lease-1'),
      /different origin/i,
    )
    assert.equal(fetchCalls, 0, 'fetch must not be invoked — no credential may leave the process')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('download() sends the Authorization header only to the same-origin backend', async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl: string | null = null
  let capturedAuth: string | null = null
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    capturedAuth = headers.authorization ?? null
    return new Response(Buffer.from('ciphertext'), {
      status: 200,
      headers: { 'x-encryption-iv': 'iv', 'x-encryption-tag': 'tag' },
    })
  }) as typeof fetch
  try {
    const client = new CloudApiClient(BACKEND)
    await client.download('super-secret-agent-token', 'https://api.dhruvantasystems.net/jobs/abc/download', 'lease-1')
    assert.ok(capturedUrl, 'fetch should have been called for the same-origin URL')
    assert.match(capturedUrl!, /^https:\/\/api\.dhruvantasystems\.net\//)
    assert.equal(capturedAuth, 'Bearer super-secret-agent-token')
  } finally {
    globalThis.fetch = originalFetch
  }
})
