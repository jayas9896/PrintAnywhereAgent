import assert from 'node:assert/strict'
import test from 'node:test'
import { selectLifecycleBanner } from '../src/ui/server.ts'

// --- selectLifecycleBanner (KAN-40 scope #3 — P1-8) -----------------------

test('APPROVED machine shows no lifecycle banner', () => {
  assert.equal(selectLifecycleBanner({ approvalStatus: 'APPROVED' }), null)
})

test('PENDING_REVIEW maps to an info banner with reassuring guidance', () => {
  const banner = selectLifecycleBanner({ approvalStatus: 'PENDING_REVIEW' })
  assert.ok(banner)
  assert.equal(banner.variant, 'info')
  assert.match(banner.title, /Waiting/i)
  assert.match(banner.body, /approve/i)
})

test('SUSPENDED maps to a warning banner explaining jobs are paused', () => {
  const banner = selectLifecycleBanner({ approvalStatus: 'SUSPENDED' })
  assert.ok(banner)
  assert.equal(banner.variant, 'warning')
  assert.match(banner.title, /paused/i)
  assert.match(banner.body, /contact your PrintAnywhere admin/i)
})

test('REJECTED maps to an error banner with revoked-recovery wording', () => {
  const banner = selectLifecycleBanner({ approvalStatus: 'REJECTED' })
  assert.ok(banner)
  assert.equal(banner.variant, 'error')
  assert.match(banner.title, /no longer connected/i)
  assert.match(banner.body, /contact your PrintAnywhere admin/i)
})

test('a missing profile is treated as pending review', () => {
  const banner = selectLifecycleBanner(null)
  assert.ok(banner)
  assert.equal(banner.variant, 'info')
})

test('an undefined profile is treated as pending review', () => {
  const banner = selectLifecycleBanner(undefined)
  assert.ok(banner)
  assert.equal(banner.variant, 'info')
})

test('pending / suspended / revoked banners are visually distinct variants', () => {
  const variants = (['PENDING_REVIEW', 'SUSPENDED', 'REJECTED'] as const).map(
    (s) => selectLifecycleBanner({ approvalStatus: s })?.variant,
  )
  // Each lifecycle state must select a different banner variant so the owner
  // can tell at a glance which standing condition applies (P1-8).
  assert.equal(new Set(variants).size, 3)
})

test('lifecycle banner copy contains no raw status codes', () => {
  for (const s of ['PENDING_REVIEW', 'SUSPENDED', 'REJECTED'] as const) {
    const banner = selectLifecycleBanner({ approvalStatus: s })
    assert.ok(banner)
    assert.doesNotMatch(`${banner.title} ${banner.body}`, /PENDING_REVIEW|SUSPENDED|REJECTED/)
  }
})
