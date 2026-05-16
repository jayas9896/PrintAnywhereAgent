import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeFirstRunStage,
  isPairingCodeExpired,
  renderFirstRunScreen,
  renderPairingHero,
  renderQrSvg,
  renderTrustPanel,
} from '../src/ui/server.ts'

// Minimal snapshot fixtures — only the fields the first-run screen reads.
const baseSnapshot = {
  sharedPrinters: {},
  printers: [],
  uiToken: 'ui-token-test',
} as never

const configSnapshot = { ...(baseSnapshot as object) } as never
const awaitingSnapshot = {
  ...(baseSnapshot as object),
  displayName: 'Counter PC',
  registration: {
    agentId: 'agent-1',
    encryptedAgentSecret: 'x',
    pairingCode: 'PAIR-4821',
    pairingCodeExpiresAt: '2030-01-01T00:00:00.000Z',
  },
} as never

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

// --- renderFirstRunScreen — registration-state branching ------------------

test('config-stage screen shows the focused config form, not the hero code', () => {
  const status = computeFirstRunStage(configSnapshot)
  const html = renderFirstRunScreen(configSnapshot, status, 'https://api.example/printanywhere')
  assert.equal(status.stage, 'config')
  assert.match(html, /Tell us about your shop/)
  assert.match(html, /action="\/configure"/)
  assert.doesNotMatch(html, /pairing-code-big/)
})

test('config-stage screen defers every operator card until after pairing', () => {
  const status = computeFirstRunStage(configSnapshot)
  const html = renderFirstRunScreen(configSnapshot, status, 'https://api.example/printanywhere')
  // None of the deferred operator cards should appear on the first-run screen.
  for (const deferred of [
    'Branding &amp; white-label',
    'Published platform printers',
    'Recent jobs',
    'Ready for pickup',
    'Host location',
    'Shared local printers',
  ]) {
    assert.doesNotMatch(html, new RegExp(deferred))
  }
})

test('config-stage screen explains location permission with an explicit action', () => {
  const status = computeFirstRunStage(configSnapshot)
  const html = renderFirstRunScreen(configSnapshot, status, 'https://api.example/printanywhere')
  assert.match(html, /id="firstrun-location-button"/)
  assert.match(html, /Share device location/)
  assert.match(html, /show your shop on the customer map/)
})

test('awaiting-pairing screen promotes the hero pairing code + QR', () => {
  const status = computeFirstRunStage(awaitingSnapshot)
  const html = renderFirstRunScreen(awaitingSnapshot, status, 'https://api.example/printanywhere')
  assert.equal(status.stage, 'awaiting-pairing')
  assert.match(html, /pairing-code-big/)
  assert.match(html, /PAIR-4821/)
  assert.match(html, /<svg class="pairing-qr"/)
  assert.match(html, /id="awaiting-pairing-screen"/)
})

test('awaiting-pairing screen still defers operator cards', () => {
  const status = computeFirstRunStage(awaitingSnapshot)
  const html = renderFirstRunScreen(awaitingSnapshot, status, 'https://api.example/printanywhere')
  assert.doesNotMatch(html, /Published platform printers/)
  assert.doesNotMatch(html, /Recent jobs/)
})

test('awaiting-pairing screen offers a regenerate-code action', () => {
  const status = computeFirstRunStage(awaitingSnapshot)
  const html = renderFirstRunScreen(awaitingSnapshot, status, 'https://api.example/printanywhere')
  assert.match(html, /Generate a new pairing code/)
  assert.match(html, /action="\/actions\/repair"/)
})

test('first-run screen reuses the KAN-36 stateBanner primitive', () => {
  const html = renderFirstRunScreen(configSnapshot, computeFirstRunStage(configSnapshot), 'x')
  assert.match(html, /class="state-banner state-banner-info"/)
})
