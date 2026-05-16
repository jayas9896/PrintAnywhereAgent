import assert from 'node:assert/strict'
import test from 'node:test'
import {
  paiseToRupeeInput,
  parseRupeesToPaise,
  parseOptionalRupeesToPaise,
  renderPlatformPrinterForm,
} from '../src/ui/server.ts'

/**
 * Extract the substring of `html` from the first `<details` tag onward — i.e.
 * everything that lives inside a collapsible Advanced accordion. The form
 * renders all core fields before the first <details>, so the slice before it
 * is the "simple core" and the slice from it on is "advanced".
 */
function splitCoreAndAdvanced(html: string) {
  const firstDetails = html.indexOf('<details')
  assert.notEqual(firstDetails, -1, 'form should contain at least one <details> accordion')
  return { core: html.slice(0, firstDetails), advanced: html.slice(firstDetails) }
}

// ===========================================================================
// Rupee <-> paise conversion (KAN-38 scope #2)
// ===========================================================================

// --- parseRupeesToPaise ----------------------------------------------------

test('parseRupeesToPaise converts a whole rupee amount', () => {
  assert.equal(parseRupeesToPaise('15'), 1500)
})

test('parseRupeesToPaise converts a 2-decimal rupee amount', () => {
  assert.equal(parseRupeesToPaise('15.50'), 1550)
  assert.equal(parseRupeesToPaise('2.50'), 250)
  assert.equal(parseRupeesToPaise('0.05'), 5)
})

test('parseRupeesToPaise rounds floating-point edge cases correctly', () => {
  // 15.10 * 100 is 1509.9999999999998 in IEEE-754 — Math.round saves us.
  assert.equal(parseRupeesToPaise('15.10'), 1510)
  // A third decimal rounds to the nearest paise.
  assert.equal(parseRupeesToPaise('15.555'), 1556)
  assert.equal(parseRupeesToPaise('15.554'), 1555)
})

test('parseRupeesToPaise tolerates a leading rupee sign and whitespace', () => {
  assert.equal(parseRupeesToPaise('₹12.00'), 1200)
  assert.equal(parseRupeesToPaise('  ₹ 12.00  '), 1200)
  assert.equal(parseRupeesToPaise(' 7.25 '), 725)
})

test('parseRupeesToPaise accepts zero', () => {
  assert.equal(parseRupeesToPaise('0'), 0)
  assert.equal(parseRupeesToPaise('0.00'), 0)
})

test('parseRupeesToPaise handles large amounts without precision loss', () => {
  assert.equal(parseRupeesToPaise('99999.99'), 9999999)
})

test('parseRupeesToPaise rejects a blank value', () => {
  assert.throws(() => parseRupeesToPaise(''), /required/)
  assert.throws(() => parseRupeesToPaise('   '), /required/)
  assert.throws(() => parseRupeesToPaise(null), /required/)
})

test('parseRupeesToPaise rejects non-numeric input', () => {
  assert.throws(() => parseRupeesToPaise('abc'), /valid amount/)
  assert.throws(() => parseRupeesToPaise('12.3.4'), /valid amount/)
})

test('parseRupeesToPaise rejects a negative amount', () => {
  assert.throws(() => parseRupeesToPaise('-5'), /negative/)
})

test('parseRupeesToPaise uses the supplied field label in errors', () => {
  assert.throws(() => parseRupeesToPaise('', 'Base price per job'), /Base price per job is required/)
})

// --- parseOptionalRupeesToPaise --------------------------------------------

test('parseOptionalRupeesToPaise returns null for a blank value', () => {
  assert.equal(parseOptionalRupeesToPaise(''), null)
  assert.equal(parseOptionalRupeesToPaise('   '), null)
  assert.equal(parseOptionalRupeesToPaise(null), null)
  assert.equal(parseOptionalRupeesToPaise(undefined), null)
})

test('parseOptionalRupeesToPaise returns a paise STRING for a present value', () => {
  assert.equal(parseOptionalRupeesToPaise('5.00'), '500')
  assert.equal(parseOptionalRupeesToPaise('₹12'), '1200')
})

test('parseOptionalRupeesToPaise still rejects a present-but-invalid value', () => {
  assert.throws(() => parseOptionalRupeesToPaise('abc'), /valid amount/)
  assert.throws(() => parseOptionalRupeesToPaise('-1'), /negative/)
})

// --- paiseToRupeeInput -----------------------------------------------------

test('paiseToRupeeInput renders a fixed 2-decimal rupee string', () => {
  assert.equal(paiseToRupeeInput(1500), '15.00')
  assert.equal(paiseToRupeeInput(1550), '15.50')
  assert.equal(paiseToRupeeInput(5), '0.05')
  assert.equal(paiseToRupeeInput(0), '0.00')
})

test('paiseToRupeeInput treats null/undefined/non-finite as zero', () => {
  assert.equal(paiseToRupeeInput(null), '0.00')
  assert.equal(paiseToRupeeInput(undefined), '0.00')
  assert.equal(paiseToRupeeInput(Number.NaN), '0.00')
})

// --- round-trip ------------------------------------------------------------

test('paise -> rupee input -> paise round-trips exactly', () => {
  for (const paise of [0, 1, 5, 99, 100, 250, 1510, 9999, 1234567]) {
    assert.equal(parseRupeesToPaise(paiseToRupeeInput(paise)), paise)
  }
})

// ===========================================================================
// Publish form — progressive disclosure: core vs advanced (KAN-38 scope #1)
// ===========================================================================

// A printer fixture with NO advanced configuration set — the common case for
// a non-technical owner publishing for the first time.
const plainPrinter = {
  printerId: 'pp-1',
  name: 'Front Desk A4',
  agentPrinterName: 'HP-LaserJet',
  routingMode: 'DIRECT',
  enabled: true,
  status: 'ONLINE',
  glossyPaperSurchargeMinor: 0,
  baseJobPriceMinor: 500,
  monochromePagePriceMinor: 200,
  colorPagePriceMinor: 800,
  duplexSheetSurchargeMinor: 0,
  a3PageSurchargeMinor: 0,
  supportedColorModes: ['MONOCHROME', 'COLOR'],
  supportedSidesModes: ['SINGLE_SIDED'],
  supportedPageSizes: ['A4'],
  supportedScalingModes: ['FIT_TO_PAGE'],
  supportsSecureCoverSheets: false,
  secureCoverSheetPriceMinor: 0,
  secureCoverSheetColorName: 'WHITE',
  secureCoverSheetLabel: 'SECURE-DO-NOT-OPEN',
  documentConstraints: [],
  pricingAdjustments: [],
} as never

test('the publish form renders collapsible <details> Advanced sections', () => {
  const html = renderPlatformPrinterForm('ui-token', ['HP-LaserJet'])
  assert.match(html, /<details/)
  assert.match(html, /Advanced settings/)
})

test('the three primary prices live in the simple core, not an accordion', () => {
  const { core } = splitCoreAndAdvanced(renderPlatformPrinterForm('ui-token', ['HP-LaserJet']))
  for (const field of ['baseJobPriceMinor', 'monochromePagePriceMinor', 'colorPagePriceMinor']) {
    assert.match(core, new RegExp(`name="${field}"`), `${field} should be a core field`)
  }
  // The printer name and shared-printer picker are core too.
  assert.match(core, /name="name"/)
  assert.match(core, /name="agentPrinterName"/)
})

test('ICC profile paths are tucked inside an Advanced accordion', () => {
  const { core, advanced } = splitCoreAndAdvanced(renderPlatformPrinterForm('ui-token', ['HP-LaserJet']))
  for (const field of ['manualApprovalIccProfilePath', 'pricingFloorIccProfilePath']) {
    assert.doesNotMatch(core, new RegExp(`name="${field}"`), `${field} must not be a core field`)
    assert.match(advanced, new RegExp(`name="${field}"`))
  }
})

test('ink-coverage conversion factors are tucked inside an Advanced accordion', () => {
  const { core, advanced } = splitCoreAndAdvanced(renderPlatformPrinterForm('ui-token', ['HP-LaserJet']))
  for (const field of [
    'manualApprovalBlackConversionFactor',
    'manualApprovalColorConversionFactor',
    'pricingFloorBlackConversionFactor',
    'pricingFloorColorConversionFactor',
  ]) {
    assert.doesNotMatch(core, new RegExp(`name="${field}"`))
    assert.match(advanced, new RegExp(`name="${field}"`))
  }
})

test('per-sheet surcharges are advanced, not core', () => {
  const { core, advanced } = splitCoreAndAdvanced(renderPlatformPrinterForm('ui-token', ['HP-LaserJet']))
  for (const field of ['duplexSheetSurchargeMinor', 'a3PageSurchargeMinor', 'glossyPaperSurchargeMinor']) {
    assert.doesNotMatch(core, new RegExp(`name="${field}"`))
    assert.match(advanced, new RegExp(`name="${field}"`))
  }
})

test('price inputs are rupee number fields, not raw paise text fields', () => {
  const html = renderPlatformPrinterForm('ui-token', ['HP-LaserJet'])
  // No "(paise)" labels remain — the owner thinks in rupees.
  assert.doesNotMatch(html, /\(paise\)/)
  // The primary price inputs are decimal number inputs.
  assert.match(html, /name="baseJobPriceMinor" value="[0-9.]+"/)
  assert.match(html, /type="number" step="0\.01"/)
})

test('an existing printer prefills prices as rupee decimals', () => {
  const html = renderPlatformPrinterForm('ui-token', ['HP-LaserJet'], plainPrinter)
  // baseJobPriceMinor 500 paise -> "5.00" rupees in the input value.
  assert.match(html, /name="baseJobPriceMinor" value="5\.00"/)
  assert.match(html, /name="monochromePagePriceMinor" value="2\.00"/)
  assert.match(html, /name="colorPagePriceMinor" value="8\.00"/)
})

test('a printer with no advanced config keeps every Advanced accordion collapsed', () => {
  const html = renderPlatformPrinterForm('ui-token', ['HP-LaserJet'], plainPrinter)
  // No accordion should be force-opened when there is nothing advanced set.
  assert.doesNotMatch(html, /<details open/)
})

test('editing a printer with advanced config opens the matching accordion', () => {
  const withFloor = {
    ...(plainPrinter as object),
    pricingAdjustments: [
      { type: 'INK_COVERAGE_FLOOR', configuration: { blackFullPagePriceMinor: '500' } },
    ],
  } as never
  const html = renderPlatformPrinterForm('ui-token', ['HP-LaserJet'], withFloor)
  // The ink pricing-floor accordion should be open so the value is visible.
  assert.match(html, /<details open/)
})
