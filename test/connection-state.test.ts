import assert from 'node:assert/strict'
import test from 'node:test'
import { computeConnectionState, HEARTBEAT_STALE_THRESHOLD_MS } from '../src/ui/server.ts'

const NOW = Date.parse('2026-05-16T10:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

test('unregistered agent reports unregistered regardless of heartbeat', () => {
  const status = computeConnectionState({ registered: false, lastHeartbeatAt: ago(1000), now: NOW })
  assert.equal(status.state, 'unregistered')
  assert.equal(status.ageSeconds, null)
})

test('registered with no heartbeat reports disconnected', () => {
  const status = computeConnectionState({ registered: true, lastHeartbeatAt: null, now: NOW })
  assert.equal(status.state, 'disconnected')
  assert.equal(status.ageSeconds, null)
})

test('registered with an invalid heartbeat timestamp reports disconnected', () => {
  const status = computeConnectionState({ registered: true, lastHeartbeatAt: 'not-a-date', now: NOW })
  assert.equal(status.state, 'disconnected')
})

test('recent heartbeat reports connected', () => {
  const status = computeConnectionState({ registered: true, lastHeartbeatAt: ago(30_000), now: NOW })
  assert.equal(status.state, 'connected')
  assert.equal(status.ageSeconds, 30)
  assert.match(status.detail, /Last synced/)
})

test('heartbeat exactly at the threshold is still connected', () => {
  const status = computeConnectionState({
    registered: true,
    lastHeartbeatAt: ago(HEARTBEAT_STALE_THRESHOLD_MS),
    now: NOW,
  })
  assert.equal(status.state, 'connected')
})

test('heartbeat just past the threshold reports stale', () => {
  const status = computeConnectionState({
    registered: true,
    lastHeartbeatAt: ago(HEARTBEAT_STALE_THRESHOLD_MS + 1_000),
    now: NOW,
  })
  assert.equal(status.state, 'stale')
  assert.equal(status.label, 'Connection delayed')
})

test('heartbeat beyond 3x the threshold reports disconnected', () => {
  const status = computeConnectionState({
    registered: true,
    lastHeartbeatAt: ago(HEARTBEAT_STALE_THRESHOLD_MS * 3 + 1_000),
    now: NOW,
  })
  assert.equal(status.state, 'disconnected')
  assert.ok((status.ageSeconds ?? 0) > 0)
})

test('age is clamped to zero for a future heartbeat clock skew', () => {
  const status = computeConnectionState({
    registered: true,
    lastHeartbeatAt: new Date(NOW + 5_000).toISOString(),
    now: NOW,
  })
  assert.equal(status.ageSeconds, 0)
  assert.equal(status.state, 'connected')
})

test('detail age phrasing scales from seconds to minutes', () => {
  const secs = computeConnectionState({ registered: true, lastHeartbeatAt: ago(40_000), now: NOW })
  assert.match(secs.detail, /40s ago/)
  const mins = computeConnectionState({ registered: true, lastHeartbeatAt: ago(8 * 60_000), now: NOW })
  assert.match(mins.detail, /8 min ago/)
})

test('a custom stale threshold is honoured', () => {
  // 1.5s old against a 1s threshold: past the threshold, within 3x → stale.
  const status = computeConnectionState({
    registered: true,
    lastHeartbeatAt: ago(1_500),
    now: NOW,
    staleThresholdMs: 1_000,
  })
  assert.equal(status.state, 'stale')
})
