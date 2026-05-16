import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldGateCoupons, validateCouponPayload } from '../src/ui/server.ts'

// --- shouldGateCoupons (KAN-40 scope #5 — P2-5) ---------------------------

const approved = { approvalStatus: 'APPROVED' as const, selfServiceEnabled: true }

test('coupons are gated when the machine is not approved for self-service', () => {
  const gate = shouldGateCoupons({
    profile: { ...approved, selfServiceEnabled: false } as never,
    platformPrinters: [],
  })
  assert.equal(gate.gated, true)
  assert.equal(gate.reason, 'not-approved')
})

test('coupons are gated when approved but no platform printer is published', () => {
  const gate = shouldGateCoupons({
    profile: approved as never,
    platformPrinters: [],
  })
  assert.equal(gate.gated, true)
  assert.equal(gate.reason, 'no-platform-printer')
})

test('coupons are NOT gated once approved and a platform printer exists', () => {
  const gate = shouldGateCoupons({
    profile: approved as never,
    platformPrinters: [{ printerId: 'p1', name: 'Front Desk' } as never],
  })
  assert.equal(gate.gated, false)
  assert.equal(gate.reason, null)
})

test('not-approved takes precedence over the no-printer reason', () => {
  const gate = shouldGateCoupons({
    profile: { ...approved, selfServiceEnabled: false } as never,
    platformPrinters: [{ printerId: 'p1', name: 'X' } as never],
  })
  assert.equal(gate.reason, 'not-approved')
})

test('a missing profile gates coupons (treated as not-approved)', () => {
  const gate = shouldGateCoupons({ profile: null, platformPrinters: [] })
  assert.equal(gate.gated, true)
  assert.equal(gate.reason, 'not-approved')
})

test('a missing platformPrinters list gates coupons when approved', () => {
  const gate = shouldGateCoupons({ profile: approved as never, platformPrinters: undefined })
  assert.equal(gate.gated, true)
  assert.equal(gate.reason, 'no-platform-printer')
})

// --- validateCouponPayload (KAN-40 P1-5) ----------------------------------

const validBody = {
  code: 'summer20',
  discountType: 'PERCENTAGE',
  discountValue: '20',
  couponScope: 'AGENT',
}

test('a valid coupon body produces a payload and no errors', () => {
  const { payload, errors } = validateCouponPayload({ ...validBody })
  assert.ok(payload)
  assert.equal(Object.keys(errors).length, 0)
  assert.equal(payload.code, 'SUMMER20') // uppercased
})

test('a blank code yields a code field error', () => {
  const { payload, errors } = validateCouponPayload({ ...validBody, code: '' })
  assert.equal(payload, null)
  assert.match(errors.code, /coupon code/i)
})

test('a code with spaces is rejected', () => {
  const { errors } = validateCouponPayload({ ...validBody, code: 'SUMMER 20' })
  assert.match(errors.code, /spaces/i)
})

test('a percentage over 100 is rejected', () => {
  const { errors } = validateCouponPayload({ ...validBody, discountValue: '150' })
  assert.match(errors.discountValue, /100/)
})

test('a zero or negative discount value is rejected', () => {
  assert.ok(validateCouponPayload({ ...validBody, discountValue: '0' }).errors.discountValue)
  assert.ok(validateCouponPayload({ ...validBody, discountValue: '-5' }).errors.discountValue)
})

test('PRINTER scope without a chosen printer yields a printerId error', () => {
  const { payload, errors } = validateCouponPayload({
    ...validBody,
    couponScope: 'PRINTER',
    printerId: '',
  })
  assert.equal(payload, null)
  assert.match(errors.printerId, /which printer/i)
})

test('PRINTER scope with a printer is valid', () => {
  const { payload } = validateCouponPayload({
    ...validBody,
    couponScope: 'PRINTER',
    printerId: 'p1',
  })
  assert.ok(payload)
  assert.equal(payload.printerId, 'p1')
})

test('ALL field errors are collected at once, not just the first', () => {
  const { errors } = validateCouponPayload({
    code: '',
    discountType: 'NONSENSE',
    discountValue: '',
    couponScope: 'PRINTER',
    printerId: '',
  })
  // code + discountType + discountValue + printerId — every offender flagged.
  assert.ok(errors.code)
  assert.ok(errors.discountType)
  assert.ok(errors.discountValue)
  assert.ok(errors.printerId)
})
