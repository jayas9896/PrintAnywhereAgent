/**
 * Progressive-enhancement contract for the DESTRUCTIVE printer actions:
 *   - stop-sharing a local printer   (POST /printers/share, shared -> false)
 *   - unpublish a platform printer   (POST /platform-printers/remove)
 *
 * Contract:
 *   AJAX (X-Requested-With: fetch) + valid uiToken   -> 200 JSON { ok, notice }
 *   AJAX + missing / invalid uiToken                 -> 403 (same CSRF gate)
 *   plain form submit (no fetch header) + valid token-> 302 PRG redirect (unchanged)
 *   AJAX on a failing action                         -> 400 JSON { ok:false }
 *
 * createUiApp is exported purely as a test seam: it returns the Express app
 * without the HTTPS/cert machinery in startAgentUiServer, so we can listen on
 * port 0 and drive it with real HTTP requests.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { AgentRuntime } from '../src/runtime/agentRuntime.ts'
import { createUiApp } from '../src/ui/server.ts'

const TOKEN = 'tok'

/** Minimal AgentRuntime stub — only the bits the destructive handlers reach. */
function fakeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    verifyUiToken: (token: string) => token === TOKEN,
    snapshot: () => ({ uiToken: TOKEN }),
    setPrinterShared: async () => {},
    removePlatformPrinter: async () => {},
    ...overrides,
  } as unknown as AgentRuntime
}

/** Boot the UI app on a loopback ephemeral port; return base URL + closer. */
async function boot(runtime: AgentRuntime) {
  const app = createUiApp(runtime)
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const { port } = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${port}`
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  return { baseUrl, close }
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString()
}

const URLENCODED = 'application/x-www-form-urlencoded'

// --- /printers/share : stop-sharing ----------------------------------------

test('AJAX stop-sharing with a valid token returns JSON, not a redirect', async () => {
  let calledWith: [string, boolean] | null = null
  const runtime = fakeRuntime({
    setPrinterShared: (async (name: string, shared: boolean) => {
      calledWith = [name, shared]
    }) as AgentRuntime['setPrinterShared'],
  })
  const { baseUrl, close } = await boot(runtime)
  try {
    const res = await fetch(`${baseUrl}/printers/share`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': URLENCODED, 'x-requested-with': 'fetch' },
      body: form({ uiToken: TOKEN, localPrinterName: 'HP', shared: 'false' }),
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
    const payload = (await res.json()) as { ok: boolean; notice: string }
    assert.equal(payload.ok, true)
    assert.equal(payload.notice, 'Printer sharing stopped.')
    assert.deepEqual(calledWith, ['HP', false])
  } finally {
    await close()
  }
})

test('AJAX stop-sharing WITHOUT a uiToken is rejected (same CSRF gate)', async () => {
  let called = false
  const runtime = fakeRuntime({
    setPrinterShared: (async () => {
      called = true
    }) as AgentRuntime['setPrinterShared'],
  })
  const { baseUrl, close } = await boot(runtime)
  try {
    const res = await fetch(`${baseUrl}/printers/share`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': URLENCODED, 'x-requested-with': 'fetch' },
      body: form({ localPrinterName: 'HP', shared: 'false' }),
    })
    assert.equal(res.status, 403)
    assert.equal(called, false)
  } finally {
    await close()
  }
})

test('AJAX stop-sharing with an INVALID uiToken is rejected', async () => {
  const { baseUrl, close } = await boot(fakeRuntime())
  try {
    const res = await fetch(`${baseUrl}/printers/share`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': URLENCODED, 'x-requested-with': 'fetch' },
      body: form({ uiToken: 'wrong', localPrinterName: 'HP', shared: 'false' }),
    })
    assert.equal(res.status, 403)
  } finally {
    await close()
  }
})

test('non-AJAX stop-sharing still 302-redirects (no-JS PRG path unchanged)', async () => {
  const { baseUrl, close } = await boot(fakeRuntime())
  try {
    const res = await fetch(`${baseUrl}/printers/share`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': URLENCODED },
      body: form({ uiToken: TOKEN, localPrinterName: 'HP', shared: 'false' }),
    })
    assert.equal(res.status, 302)
    const location = res.headers.get('location') ?? ''
    assert.match(location, /notice=/)
    // The PRG redirect carries the same human message the toast would show.
    assert.match(location, /Printer%20sharing%20stopped|Printer\+sharing\+stopped/)
  } finally {
    await close()
  }
})

// --- /platform-printers/remove : unpublish ---------------------------------

test('AJAX platform-printer unpublish with a valid token returns JSON', async () => {
  let removedId: string | null = null
  const runtime = fakeRuntime({
    removePlatformPrinter: (async (id: string) => {
      removedId = id
    }) as AgentRuntime['removePlatformPrinter'],
  })
  const { baseUrl, close } = await boot(runtime)
  try {
    const res = await fetch(`${baseUrl}/platform-printers/remove`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': URLENCODED, 'x-requested-with': 'fetch' },
      body: form({ uiToken: TOKEN, printerId: 'pp-1' }),
    })
    assert.equal(res.status, 200)
    const payload = (await res.json()) as { ok: boolean; notice: string }
    assert.equal(payload.ok, true)
    assert.equal(payload.notice, 'Platform printer unpublished.')
    assert.equal(removedId, 'pp-1')
  } finally {
    await close()
  }
})

test('AJAX platform-printer unpublish without a token is rejected', async () => {
  let called = false
  const runtime = fakeRuntime({
    removePlatformPrinter: (async () => {
      called = true
    }) as AgentRuntime['removePlatformPrinter'],
  })
  const { baseUrl, close } = await boot(runtime)
  try {
    const res = await fetch(`${baseUrl}/platform-printers/remove`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': URLENCODED, 'x-requested-with': 'fetch' },
      body: form({ printerId: 'pp-1' }),
    })
    assert.equal(res.status, 403)
    assert.equal(called, false)
  } finally {
    await close()
  }
})

test('an AJAX action that throws returns a non-2xx JSON error (not a redirect)', async () => {
  const runtime = fakeRuntime({
    removePlatformPrinter: (async () => {
      throw new Error('boom')
    }) as AgentRuntime['removePlatformPrinter'],
  })
  const { baseUrl, close } = await boot(runtime)
  try {
    const res = await fetch(`${baseUrl}/platform-printers/remove`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': URLENCODED, 'x-requested-with': 'fetch' },
      body: form({ uiToken: TOKEN, printerId: 'pp-1' }),
    })
    assert.equal(res.status, 400)
    const payload = (await res.json()) as { ok: boolean; notice: string }
    assert.equal(payload.ok, false)
    assert.equal(payload.notice, 'boom')
  } finally {
    await close()
  }
})
