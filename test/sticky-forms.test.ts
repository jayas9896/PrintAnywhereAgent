import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fieldError,
  renderPlatformPrinterForm,
  stickyChecked,
  stickyValue,
  validatePlatformPrinterPayload,
} from '../src/ui/server.ts'

// --- stickyValue (KAN-40 scope #2 — P1-5) ---------------------------------

test('stickyValue prefers a submitted value over the fallback', () => {
  assert.equal(stickyValue({ submitted: { name: 'Typed' } }, 'name', 'Stored'), 'Typed')
})

test('stickyValue falls back when the field was not submitted', () => {
  assert.equal(stickyValue({ submitted: { other: 'x' } }, 'name', 'Stored'), 'Stored')
})

test('stickyValue falls back when there is no sticky context at all', () => {
  assert.equal(stickyValue(undefined, 'name', 'Stored'), 'Stored')
})

test('stickyValue preserves an empty submitted string (owner cleared the field)', () => {
  // A submitted-but-empty value must survive — not silently revert to stored.
  assert.equal(stickyValue({ submitted: { name: '' } }, 'name', 'Stored'), '')
})

test('stickyValue returns empty string when fallback is null/undefined', () => {
  assert.equal(stickyValue(undefined, 'name', null), '')
  assert.equal(stickyValue(undefined, 'name', undefined), '')
})

// --- stickyChecked --------------------------------------------------------

test('stickyChecked reads a submitted "on" as true', () => {
  assert.equal(stickyChecked({ submitted: { enabled: 'on' } }, 'enabled', false), true)
})

test('stickyChecked reads a missing submitted checkbox as false', () => {
  // An unticked checkbox is absent from the body — on a sticky re-render it
  // must read false, not revert to the (true) stored fallback.
  assert.equal(stickyChecked({ submitted: { other: 'x' } }, 'enabled', true), false)
})

test('stickyChecked uses the fallback when there is no sticky context', () => {
  assert.equal(stickyChecked(undefined, 'enabled', true), true)
})

// --- fieldError -----------------------------------------------------------

test('fieldError renders the message for a flagged field', () => {
  const html = fieldError({ fieldErrors: { name: 'Name is required.' } }, 'name')
  assert.match(html, /field-error/)
  assert.match(html, /Name is required/)
  assert.match(html, /role="alert"/)
})

test('fieldError renders nothing for a clean field', () => {
  assert.equal(fieldError({ fieldErrors: { other: 'x' } }, 'name'), '')
  assert.equal(fieldError(undefined, 'name'), '')
})

test('fieldError escapes HTML in the message', () => {
  assert.doesNotMatch(fieldError({ fieldErrors: { name: '<b>x</b>' } }, 'name'), /<b>x<\/b>/)
})

// --- validatePlatformPrinterPayload ---------------------------------------

const validBody = {
  name: 'Front Desk A4',
  agentPrinterName: 'HP-LaserJet',
  status: 'ONLINE',
  baseJobPriceMinor: '5.00',
  monochromePagePriceMinor: '2.00',
  colorPagePriceMinor: '8.00',
  duplexSheetSurchargeMinor: '1.00',
  a3PageSurchargeMinor: '3.00',
  glossyPaperSurchargeMinor: '4.00',
  secureCoverSheetPriceMinor: '10.00',
  secureCoverSheetColorName: 'WHITE',
  secureCoverSheetLabel: 'SECURE-DO-NOT-OPEN',
}

test('a fully valid publish body produces a payload with rupees converted to paise', () => {
  const { payload, errors } = validatePlatformPrinterPayload({ ...validBody })
  assert.ok(payload)
  assert.equal(Object.keys(errors).length, 0)
  assert.equal(payload.baseJobPriceMinor, 500)
  assert.equal(payload.colorPagePriceMinor, 800)
})

test('an empty publish body flags EVERY required field at once', () => {
  const { payload, errors } = validatePlatformPrinterPayload({})
  assert.equal(payload, null)
  // name + agentPrinterName + the required rupee fields + secure cover text.
  for (const field of [
    'name',
    'agentPrinterName',
    'baseJobPriceMinor',
    'monochromePagePriceMinor',
    'colorPagePriceMinor',
    'secureCoverSheetColorName',
    'secureCoverSheetLabel',
  ]) {
    assert.ok(errors[field], `expected an error for ${field}`)
  }
})

test('a negative rupee price is flagged on the offending field only', () => {
  const { payload, errors } = validatePlatformPrinterPayload({
    ...validBody,
    baseJobPriceMinor: '-3.00',
  })
  assert.equal(payload, null)
  assert.ok(errors.baseJobPriceMinor)
  assert.equal(errors.monochromePagePriceMinor, undefined)
})

test('a non-numeric rupee price is flagged rather than throwing', () => {
  const { errors } = validatePlatformPrinterPayload({ ...validBody, colorPagePriceMinor: 'abc' })
  assert.ok(errors.colorPagePriceMinor)
})

test('an invalid advanced optional rupee field is collected as a field error', () => {
  const { payload, errors } = validatePlatformPrinterPayload({
    ...validBody,
    manualApprovalBlackFullPagePriceMinor: 'not-money',
  })
  assert.equal(payload, null)
  assert.ok(errors.manualApprovalBlackFullPagePriceMinor)
})

test('printerId is carried through into the validated payload', () => {
  const { payload } = validatePlatformPrinterPayload({ ...validBody }, 'printer-123')
  assert.ok(payload)
  assert.equal(payload.printerId, 'printer-123')
})

// --- renderPlatformPrinterForm sticky behaviour ---------------------------

test('the publish form reflects submitted values over the stored printer', () => {
  const printer = {
    printerId: 'p1',
    name: 'Stored Name',
    agentPrinterName: 'HP-LaserJet',
    routingMode: 'DIRECT',
    enabled: true,
    status: 'ONLINE',
    baseJobPriceMinor: 500,
    monochromePagePriceMinor: 200,
    colorPagePriceMinor: 800,
    glossyPaperSurchargeMinor: 0,
    duplexSheetSurchargeMinor: 0,
    a3PageSurchargeMinor: 0,
    supportedColorModes: [],
    supportedSidesModes: [],
    supportedPageSizes: [],
    supportedScalingModes: [],
    supportsSecureCoverSheets: false,
    secureCoverSheetPriceMinor: 0,
    secureCoverSheetColorName: 'WHITE',
    secureCoverSheetLabel: 'SECURE',
    documentConstraints: [],
    pricingAdjustments: [],
  } as never
  const html = renderPlatformPrinterForm('tok', ['HP-LaserJet'], printer, {
    submitted: { name: 'Owner Typed This', baseJobPriceMinor: '9.99' },
    fieldErrors: { name: 'Too short.' },
  })
  // Submitted name wins over the stored printer name.
  assert.match(html, /value="Owner Typed This"/)
  assert.doesNotMatch(html, /value="Stored Name"/)
  // Submitted rupee value is shown raw.
  assert.match(html, /value="9.99"/)
  // The field-level error renders.
  assert.match(html, /Too short/)
})

test('the publish form with no sticky context renders the stored printer values', () => {
  const html = renderPlatformPrinterForm('tok', ['HP-LaserJet'])
  assert.match(html, /Publish a new platform printer/)
  assert.doesNotMatch(html, /field-error/)
})
