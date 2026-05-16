import assert from 'node:assert/strict'
import test from 'node:test'
import { computeConnectionState, connectionPill, stateBanner } from '../src/ui/server.ts'

// --- stateBanner ----------------------------------------------------------

test('stateBanner renders the requested variant class', () => {
  const html = stateBanner({ variant: 'warning', title: 'Heads up' })
  assert.match(html, /class="state-banner state-banner-warning"/)
  assert.match(html, /Heads up/)
})

test('stateBanner error variant uses role=alert + assertive live region', () => {
  const html = stateBanner({ variant: 'error', title: 'Revoked' })
  assert.match(html, /role="alert"/)
  assert.match(html, /aria-live="assertive"/)
})

test('stateBanner non-error variant uses role=status + polite', () => {
  const html = stateBanner({ variant: 'info', title: 'Pending approval' })
  assert.match(html, /role="status"/)
  assert.match(html, /aria-live="polite"/)
})

test('stateBanner omits the body element when no body is given', () => {
  const html = stateBanner({ variant: 'success', title: 'Done' })
  assert.doesNotMatch(html, /state-banner-text/)
})

test('stateBanner includes the body text when provided', () => {
  const html = stateBanner({ variant: 'info', title: 'Offline', body: 'Reconnecting…' })
  assert.match(html, /state-banner-text/)
  assert.match(html, /Reconnecting/)
})

test('stateBanner escapes HTML in title and body', () => {
  const html = stateBanner({ variant: 'error', title: '<script>x</script>', body: 'a & b' })
  assert.doesNotMatch(html, /<script>x<\/script>/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /a &amp; b/)
})

test('stateBanner icon glyph is aria-hidden (decorative)', () => {
  const html = stateBanner({ variant: 'warning', title: 'Suspended' })
  assert.match(html, /state-banner-icon" aria-hidden="true"/)
})

// --- connectionPill -------------------------------------------------------

test('connectionPill reflects a connected status', () => {
  const status = computeConnectionState({
    registered: true,
    lastHeartbeatAt: new Date().toISOString(),
  })
  const html = connectionPill(status)
  assert.match(html, /conn-pill conn-pill-connected/)
  assert.match(html, /data-state="connected"/)
  assert.match(html, /id="conn-pill"/)
})

test('connectionPill carries the contract ids the poller updates', () => {
  const status = computeConnectionState({ registered: false, lastHeartbeatAt: null })
  const html = connectionPill(status)
  for (const id of ['conn-pill', 'conn-pill-label', 'conn-pill-sync']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
})

test('connectionPill unregistered status shows a pairing prompt', () => {
  const html = connectionPill(computeConnectionState({ registered: false, lastHeartbeatAt: null }))
  assert.match(html, /conn-pill-unregistered/)
  assert.match(html, /Pair this machine to connect/)
})

test('connectionPill is an aria-live status region', () => {
  const html = connectionPill(computeConnectionState({ registered: true, lastHeartbeatAt: null }))
  assert.match(html, /role="status"/)
  assert.match(html, /aria-live="polite"/)
})
