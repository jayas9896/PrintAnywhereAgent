import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeConnectionState,
  connectionPill,
  emptyState,
  stateBanner,
  tableEmptyState,
} from '../src/ui/server.ts'

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

// --- emptyState / tableEmptyState (KAN-38 scope #3) -----------------------

test('emptyState renders a friendly title and explanatory text', () => {
  const html = emptyState({ title: 'Nothing here yet', text: 'Add something to get started.' })
  assert.match(html, /class="empty-state"/)
  assert.match(html, /empty-state-title/)
  assert.match(html, /Nothing here yet/)
  assert.match(html, /Add something to get started/)
})

test('emptyState decorative icon is aria-hidden', () => {
  assert.match(emptyState({ title: 'T', text: 'X' }), /empty-state-icon" aria-hidden="true"/)
})

test('emptyState omits the action block when no action is given', () => {
  assert.doesNotMatch(emptyState({ title: 'T', text: 'X' }), /empty-state-action/)
})

test('emptyState renders an inline action when provided', () => {
  const html = emptyState({
    title: 'T',
    text: 'X',
    action: '<button type="submit">Refresh</button>',
  })
  assert.match(html, /empty-state-action/)
  assert.match(html, /Refresh/)
})

test('emptyState escapes HTML in title and text', () => {
  const html = emptyState({ title: '<b>x</b>', text: 'a & b' })
  assert.doesNotMatch(html, /<b>x<\/b>/)
  assert.match(html, /a &amp; b/)
})

test('tableEmptyState wraps the empty state in a full-width table row', () => {
  const html = tableEmptyState({ colspan: 3, title: 'No printers', text: 'Connect one.' })
  assert.match(html, /^<tr><td colspan="3">/)
  assert.match(html, /<\/td><\/tr>$/)
  assert.match(html, /class="empty-state"/)
})

test('tableEmptyState carries an inline Refresh action through', () => {
  const html = tableEmptyState({
    colspan: 3,
    title: 'No printers',
    text: 'Connect one.',
    action: '<form action="/actions/refresh"><button>Refresh printers</button></form>',
  })
  assert.match(html, /action="\/actions\/refresh"/)
  assert.match(html, /Refresh printers/)
})
