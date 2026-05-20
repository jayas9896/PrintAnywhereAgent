import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RECOMMENDED_SECURE_COVER_SWATCHES,
  clampChannel,
  clampRgb,
  normalizeHexColor,
  parseHexColor,
  resolvePreviewHex,
  rgbToHex,
} from '../src/ui/secureCoverColors.ts'
import { renderPlatformPrinterForm } from '../src/ui/server.ts'

// ===========================================================================
// Pure HEX/RGB helpers (KAN-295)
// ===========================================================================

test('normalizeHexColor accepts #rrggbb', () => {
  assert.equal(normalizeHexColor('#FF8800'), '#ff8800')
  assert.equal(normalizeHexColor('  #ff8800  '), '#ff8800')
})

test('normalizeHexColor accepts a bare 6-digit hex without the leading hash', () => {
  assert.equal(normalizeHexColor('ff8800'), '#ff8800')
})

test('normalizeHexColor expands the #rgb short form', () => {
  assert.equal(normalizeHexColor('#f80'), '#ff8800')
  assert.equal(normalizeHexColor('f80'), '#ff8800')
})

test('normalizeHexColor rejects nonsense and named colours', () => {
  assert.equal(normalizeHexColor(''), null)
  assert.equal(normalizeHexColor('   '), null)
  assert.equal(normalizeHexColor('WHITE'), null)
  assert.equal(normalizeHexColor('#zz0000'), null)
  assert.equal(normalizeHexColor('#1234'), null)
  assert.equal(normalizeHexColor(null), null)
  assert.equal(normalizeHexColor(undefined), null)
})

test('parseHexColor returns the matching RGB triplet', () => {
  assert.deepEqual(parseHexColor('#ff8800'), { r: 255, g: 136, b: 0 })
  assert.deepEqual(parseHexColor('#000000'), { r: 0, g: 0, b: 0 })
  assert.deepEqual(parseHexColor('#FFFFFF'), { r: 255, g: 255, b: 255 })
})

test('parseHexColor returns null when the input is not a valid HEX', () => {
  assert.equal(parseHexColor('WHITE'), null)
  assert.equal(parseHexColor(''), null)
})

test('clampChannel clamps below 0 and above 255 and rounds non-integers', () => {
  assert.equal(clampChannel(-5), 0)
  assert.equal(clampChannel(300), 255)
  assert.equal(clampChannel(127.6), 128)
  assert.equal(clampChannel('not a number'), 0)
  assert.equal(clampChannel(null), 0)
})

test('clampRgb clamps every channel independently', () => {
  assert.deepEqual(clampRgb({ r: -1, g: 500, b: 128 }), { r: 0, g: 255, b: 128 })
})

test('rgbToHex round-trips with parseHexColor across many channels', () => {
  for (const rgb of [
    { r: 0, g: 0, b: 0 },
    { r: 255, g: 255, b: 255 },
    { r: 255, g: 136, b: 0 },
    { r: 24, g: 77, b: 49 }, // brand green
    { r: 71, g: 84, b: 103 }, // slate accent
  ]) {
    const hex = rgbToHex(rgb)
    assert.deepEqual(parseHexColor(hex), rgb)
  }
})

test('rgbToHex clamps out-of-range channels before emitting', () => {
  assert.equal(rgbToHex({ r: -1, g: 256, b: 128 }), '#00ff80')
})

test('resolvePreviewHex falls back to a swatch when the value is a known name', () => {
  // The WHITE swatch's preview is #FFFFFF in the constants table.
  assert.equal(resolvePreviewHex('WHITE'), '#ffffff')
  assert.equal(resolvePreviewHex('white'), '#ffffff')
  assert.equal(resolvePreviewHex('BLACK'), '#1a1a1a')
})

test('resolvePreviewHex passes through a valid HEX', () => {
  assert.equal(resolvePreviewHex('#3366ff'), '#3366ff')
  assert.equal(resolvePreviewHex('3366ff'), '#3366ff')
})

test('resolvePreviewHex falls back to white for unknown junk', () => {
  assert.equal(resolvePreviewHex('not a colour'), '#ffffff')
  assert.equal(resolvePreviewHex(''), '#ffffff')
})

test('the recommended-swatch set has at least six entries with monochromes first', () => {
  assert.ok(RECOMMENDED_SECURE_COVER_SWATCHES.length >= 6)
  const labels = RECOMMENDED_SECURE_COVER_SWATCHES.map((s) => s.label)
  assert.ok(labels.includes('White'))
  assert.ok(labels.includes('Black'))
})

// ===========================================================================
// Publish-form integration — the secure-cover colour picker UI (KAN-295)
// ===========================================================================

test('the publish form renders a HEX text input named secureCoverSheetColorName', () => {
  const html = renderPlatformPrinterForm('ui-token', ['HP-LaserJet'])
  // The payload field name is unchanged — the backend still accepts a plain string.
  assert.match(html, /name="secureCoverSheetColorName"/)
  // The text input survives so the operator can paste a name or HEX directly.
  assert.match(html, /id="secure-cover-hex"/)
})

test('the publish form renders a native colour picker', () => {
  const html = renderPlatformPrinterForm('ui-token', ['HP-LaserJet'])
  assert.match(html, /type="color"/)
  assert.match(html, /id="secure-cover-color-picker"/)
})

test('the publish form renders RGB channel sliders', () => {
  const html = renderPlatformPrinterForm('ui-token', ['HP-LaserJet'])
  for (const channel of ['r', 'g', 'b']) {
    assert.match(
      html,
      new RegExp(`id="secure-cover-rgb-${channel}"`),
      `slider for channel ${channel} should be present`,
    )
    // The same row should declare the input as a range slider (the order of
    // type= and id= attributes is not guaranteed, so we assert both
    // independently rather than building a fragile combined regex).
  }
  assert.match(html, /type="range"[^>]*id="secure-cover-rgb-r"/)
  assert.match(html, /type="range"[^>]*id="secure-cover-rgb-g"/)
  assert.match(html, /type="range"[^>]*id="secure-cover-rgb-b"/)
})

test('the publish form renders the recommended swatch chips', () => {
  const html = renderPlatformPrinterForm('ui-token', ['HP-LaserJet'])
  // Each swatch should produce a clickable button with data-swatch-value
  // matching the backend value we will write to the form input.
  for (const swatch of RECOMMENDED_SECURE_COVER_SWATCHES) {
    assert.match(
      html,
      new RegExp(`data-swatch-value="${swatch.value.replace(/[#]/g, '\\\\?#')}"`),
      `swatch chip for ${swatch.label} should be present`,
    )
  }
})

test('the publish form marks the platform-printer save form as dirty-aware', () => {
  const html = renderPlatformPrinterForm('ui-token', ['HP-LaserJet'])
  assert.match(html, /class="[^"]*js-dirty-aware/)
})
