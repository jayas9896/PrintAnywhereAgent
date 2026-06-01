import assert from 'node:assert/strict'
import test from 'node:test'
import { mapCloudError, renderDeveloperDetails, renderOfflineBanner } from '../src/ui/server.ts'

// --- mapCloudError (KAN-40 scope #1 — P1-3) -------------------------------

test('network-unreachable fetch failure maps to a "cannot reach" message', () => {
  const friendly = mapCloudError(new TypeError('fetch failed'))
  assert.match(friendly.title, /cannot reach PrintAnywhere/i)
  assert.match(friendly.body, /internet connection/i)
})

test('ECONNREFUSED cause maps to the network-unreachable message', () => {
  const err = new Error('fetch failed')
  ;(err as Error & { cause: unknown }).cause = { code: 'ECONNREFUSED' }
  const friendly = mapCloudError(err)
  assert.match(friendly.title, /cannot reach PrintAnywhere/i)
})

test('ENOTFOUND (DNS) maps to the network-unreachable message', () => {
  const err = new Error('request to https://x failed, reason: getaddrinfo ENOTFOUND x')
  assert.match(mapCloudError(err).title, /cannot reach PrintAnywhere/i)
})

test('HTTP 503 maps to a server-trouble message', () => {
  const friendly = mapCloudError(new Error('HTTP 503: Service Unavailable'))
  assert.match(friendly.title, /having trouble/i)
  assert.match(friendly.body, /temporary/i)
})

test('HTTP 500 maps to the server-trouble message', () => {
  assert.match(mapCloudError(new Error('HTTP 500: boom')).title, /having trouble/i)
})

test('HTTP 401 maps to a credentials-rejected message', () => {
  const friendly = mapCloudError(new Error('HTTP 401: Unauthorized'))
  assert.match(friendly.title, /did not accept this machine/i)
  assert.match(friendly.body, /pairing code/i)
})

test('HTTP 403 maps to the credentials-rejected message', () => {
  assert.match(mapCloudError(new Error('HTTP 403: Forbidden')).title, /did not accept this machine/i)
})

test('HTTP 404 maps to a not-found message', () => {
  assert.match(mapCloudError(new Error('HTTP 404: Not Found')).title, /could not find/i)
})

test('a timeout / AbortError maps to a slow-to-respond message', () => {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  assert.match(mapCloudError(err).title, /slow to respond/i)
})

test('ETIMEDOUT maps to the slow-to-respond message', () => {
  assert.match(mapCloudError(new Error('connect ETIMEDOUT')).title, /slow to respond/i)
})

test('an unrecognised error maps to a generic friendly message', () => {
  const friendly = mapCloudError(new Error('something weird happened'))
  assert.match(friendly.title, /something went wrong/i)
})

test('a non-Error thrown value is handled without crashing', () => {
  const friendly = mapCloudError('plain string failure')
  assert.ok(friendly.title)
  assert.ok(friendly.body)
})

test('mapCloudError never leaks raw exception text to the owner', () => {
  // The raw cloud-client message embeds HTTP status + a server body slice and
  // exception class names — none of that may surface in operator-facing copy.
  const cases: unknown[] = [
    new Error('HTTP 503: {"code":"INTERNAL","trace":"abc"}'),
    new TypeError('fetch failed'),
    new Error('HTTP 401: {"code":"UNAUTHENTICATED"}'),
  ]
  for (const err of cases) {
    const friendly = mapCloudError(err)
    const blob = `${friendly.title} ${friendly.body}`
    assert.doesNotMatch(blob, /HTTP \d/)
    assert.doesNotMatch(blob, /TypeError|Error:|\{"code"/)
  }
})

// --- renderOfflineBanner --------------------------------------------------

test('renderOfflineBanner renders an error stateBanner with a Retry action', () => {
  const html = renderOfflineBanner(new TypeError('fetch failed'), '/orders')
  assert.match(html, /state-banner-error/)
  assert.match(html, /Retry/)
  assert.match(html, /href="\/orders"/)
})

test('renderOfflineBanner shows the friendly copy, not the raw error', () => {
  const html = renderOfflineBanner(new Error('HTTP 503: secret server detail'))
  assert.match(html, /having trouble/i)
  assert.doesNotMatch(html, /secret server detail/)
  assert.doesNotMatch(html, /HTTP 503/)
})

test('renderOfflineBanner carries the offline-banner id contract', () => {
  assert.match(renderOfflineBanner(new Error('x')), /id="offline-banner"/)
})

// --- renderDeveloperDetails (KAN-451) -------------------------------------

test('renderDeveloperDetails returns empty string when developer mode is OFF', () => {
  // The flag gating is the whole feature: OFF must leave error rendering
  // byte-for-byte unchanged (no developer block at all).
  assert.equal(renderDeveloperDetails(new Error('HTTP 400: bad'), false), '')
})

test('renderDeveloperDetails shows the raw HTTP status + backend body when ON', () => {
  const html = renderDeveloperDetails(
    new Error('HTTP 400: {"field":"baseJobPriceMinor","message":"must be >= 0"}'),
    true,
  )
  assert.match(html, /Developer details/)
  assert.match(html, /HTTP 400/)
  assert.match(html, /baseJobPriceMinor/)
})

test('renderDeveloperDetails htmlEscapes the error text (no raw markup injection)', () => {
  const html = renderDeveloperDetails(new Error('HTTP 400: <script>alert(1)</script>'), true)
  assert.doesNotMatch(html, /<script>alert/)
  assert.match(html, /&lt;script&gt;/)
})

test('renderDeveloperDetails tolerates a non-Error thrown value', () => {
  assert.match(renderDeveloperDetails('plain string failure', true), /plain string failure/)
})

test('renderDeveloperDetails renders nothing for an empty/blank message even when ON', () => {
  assert.equal(renderDeveloperDetails(new Error('   '), true), '')
  assert.equal(renderDeveloperDetails('', true), '')
})
