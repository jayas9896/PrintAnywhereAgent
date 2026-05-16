import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeFirstRunStage,
  isPairingCodeExpired,
  renderPairingHero,
  renderQrSvg,
  renderTrustPanel,
} from '../src/ui/server.ts'

// --- computeFirstRunStage -------------------------------------------------

test('no registration reports the config stage', () => {
  const status = computeFirstRunStage({ registration: null, profile: null })
  assert.equal(status.stage, 'config')
  assert.equal(status.isFirstRun, true)
  assert.equal(status.pairingCode, null)
})

test('an undefined registration also reports the config stage', () => {
  const status = computeFirstRunStage({} as never)
  assert.equal(status.stage, 'config')
})

test('a registration with an agentId but no profile is awaiting pairing', () => {
  const status = computeFirstRunStage({
    registration: {
      agentId: 'agent-1',
      encryptedAgentSecret: 'x',
      pairingCode: 'PAIR-4821',
      pairingCodeExpiresAt: '2026-05-16T12:00:00.000Z',
    },
    profile: null,
  })
  assert.equal(status.stage, 'awaiting-pairing')
  assert.equal(status.isFirstRun, true)
  assert.equal(status.pairingCode, 'PAIR-4821')
  assert.equal(status.pairingCodeExpiresAt, '2026-05-16T12:00:00.000Z')
})

test('agentId present but pairing code missing still awaits pairing', () => {
  const status = computeFirstRunStage({
    registration: { agentId: 'agent-1', encryptedAgentSecret: 'x', pairingCode: null },
    profile: null,
  })
  assert.equal(status.stage, 'awaiting-pairing')
  assert.equal(status.pairingCode, null)
})

test('a blank/whitespace pairing code is normalised to null', () => {
  const status = computeFirstRunStage({
    registration: { agentId: 'agent-1', encryptedAgentSecret: 'x', pairingCode: '   ' },
    profile: null,
  })
  assert.equal(status.pairingCode, null)
})

test('a profile with self-service enabled reports the paired stage', () => {
  const status = computeFirstRunStage({
    registration: { agentId: 'agent-1', encryptedAgentSecret: 'x', pairingCode: 'PAIR-1' },
    profile: { selfServiceEnabled: true, approvalStatus: 'PENDING_REVIEW' } as never,
  })
  assert.equal(status.stage, 'paired')
  assert.equal(status.isFirstRun, false)
})

test('a profile with an APPROVED approval status reports the paired stage', () => {
  const status = computeFirstRunStage({
    registration: { agentId: 'agent-1', encryptedAgentSecret: 'x', pairingCode: 'PAIR-1' },
    profile: { selfServiceEnabled: false, approvalStatus: 'APPROVED' } as never,
  })
  assert.equal(status.stage, 'paired')
})

test('a pending profile that is not yet self-service is still awaiting pairing', () => {
  const status = computeFirstRunStage({
    registration: { agentId: 'agent-1', encryptedAgentSecret: 'x', pairingCode: 'PAIR-1' },
    profile: { selfServiceEnabled: false, approvalStatus: 'PENDING_REVIEW' } as never,
  })
  assert.equal(status.stage, 'awaiting-pairing')
})

// --- isPairingCodeExpired -------------------------------------------------

const NOW = Date.parse('2026-05-16T10:00:00.000Z')

test('a future expiry is not expired', () => {
  assert.equal(isPairingCodeExpired('2026-05-16T11:00:00.000Z', NOW), false)
})

test('a past expiry is expired', () => {
  assert.equal(isPairingCodeExpired('2026-05-16T09:00:00.000Z', NOW), true)
})

test('a null or invalid expiry is treated as not expired', () => {
  assert.equal(isPairingCodeExpired(null, NOW), false)
  assert.equal(isPairingCodeExpired('not-a-date', NOW), false)
})

// --- renderQrSvg ----------------------------------------------------------

test('renderQrSvg produces an inline SVG element', () => {
  const svg = renderQrSvg('PAIR-4821')
  assert.match(svg, /^<svg/)
  assert.match(svg, /<\/svg>$/)
  assert.match(svg, /class="pairing-qr"/)
})

test('renderQrSvg marks the QR as an accessible image with a label', () => {
  const svg = renderQrSvg('PAIR-4821', { label: 'Pairing code QR' })
  assert.match(svg, /role="img"/)
  assert.match(svg, /aria-label="Pairing code QR"/)
})

test('renderQrSvg honours a custom pixel size', () => {
  const svg = renderQrSvg('PAIR-4821', { size: 220 })
  assert.match(svg, /width="220"/)
  assert.match(svg, /height="220"/)
})

test('renderQrSvg encodes different payloads into different matrices', () => {
  assert.notEqual(renderQrSvg('PAIR-0001'), renderQrSvg('PAIR-9999'))
})

// --- renderPairingHero ----------------------------------------------------

const FUTURE = '2026-05-16T12:00:00.000Z'
const PAST = '2026-05-16T08:00:00.000Z'

test('renderPairingHero shows the code large and verbatim', () => {
  const html = renderPairingHero({ pairingCode: 'PAIR-4821', pairingCodeExpiresAt: FUTURE, now: NOW })
  assert.match(html, /class="pairing-code-big"/)
  assert.match(html, /PAIR-4821/)
})

test('renderPairingHero includes a Copy-to-clipboard button targeting the code', () => {
  const html = renderPairingHero({ pairingCode: 'PAIR-4821', pairingCodeExpiresAt: FUTURE, now: NOW })
  assert.match(html, /data-copy-target="pairing-code"/)
  assert.match(html, /Copy code/)
})

test('renderPairingHero embeds an inline QR code of the pairing code', () => {
  const html = renderPairingHero({ pairingCode: 'PAIR-4821', pairingCodeExpiresAt: FUTURE, now: NOW })
  assert.match(html, /<svg class="pairing-qr"/)
  assert.match(html, /scan this with a phone/)
})

test('renderPairingHero renders a human-friendly expiry, not a raw ISO string', () => {
  const html = renderPairingHero({ pairingCode: 'PAIR-4821', pairingCodeExpiresAt: FUTURE, now: NOW })
  assert.doesNotMatch(html, /2026-05-16T12:00:00/)
  assert.match(html, /Valid until/)
})

test('renderPairingHero flags an expired pairing code', () => {
  const html = renderPairingHero({ pairingCode: 'PAIR-4821', pairingCodeExpiresAt: PAST, now: NOW })
  assert.match(html, /is-expired/)
  assert.match(html, /expired/)
})

test('renderPairingHero shows a generating message when no code exists yet', () => {
  const html = renderPairingHero({ pairingCode: null, pairingCodeExpiresAt: null })
  assert.match(html, /generating your pairing code/)
  assert.doesNotMatch(html, /pairing-code-big/)
})

test('renderPairingHero includes plain-language sharing instructions', () => {
  const html = renderPairingHero({ pairingCode: 'PAIR-4821', pairingCodeExpiresAt: FUTURE, now: NOW })
  assert.match(html, /Share this code with your PrintAnywhere platform admin/)
})

// --- renderTrustPanel -----------------------------------------------------

test('renderTrustPanel surfaces local-only, encryption and publisher cues', () => {
  const html = renderTrustPanel()
  assert.match(html, /local/i)
  assert.match(html, /encrypted/i)
  assert.match(html, /Dhruvanta Systems/)
})

test('renderTrustPanel decorative icons are aria-hidden', () => {
  assert.match(renderTrustPanel(), /trust-icon" aria-hidden="true"/)
})
