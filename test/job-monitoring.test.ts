import assert from 'node:assert/strict'
import test from 'node:test'
import type { PickupJobSnapshot, RecentJobSnapshot } from '../src/config/types.ts'
import {
  RECENT_JOBS_PREVIEW_LIMIT,
  classifyPickupSearch,
  selectRecentJobsPreview,
} from '../src/ui/server.ts'

// --- Test fixtures --------------------------------------------------------

function makeJob(id: string, status: RecentJobSnapshot['status'] = 'COMPLETED'): RecentJobSnapshot {
  return { jobId: id, printerName: 'Front Desk HP', status, updatedAt: '2026-05-16T10:00:00.000Z' }
}

function makeJobs(count: number): RecentJobSnapshot[] {
  return Array.from({ length: count }, (_, i) => makeJob(`job-${i + 1}`))
}

function makePickup(code: string, jobId = `job-${code}`): PickupJobSnapshot {
  return {
    jobId,
    printerName: 'Front Desk HP',
    pickupCode: code,
    completedAt: '2026-05-16T09:30:00.000Z',
  }
}

// --- selectRecentJobsPreview (KAN-39 P2-1 — dashboard preview slicing) ----

test('selectRecentJobsPreview returns an empty array for no jobs', () => {
  assert.deepEqual(selectRecentJobsPreview([]), [])
})

test('selectRecentJobsPreview tolerates null / undefined input', () => {
  assert.deepEqual(selectRecentJobsPreview(null), [])
  assert.deepEqual(selectRecentJobsPreview(undefined), [])
})

test('selectRecentJobsPreview returns all jobs when fewer than the limit', () => {
  const jobs = makeJobs(3)
  assert.deepEqual(selectRecentJobsPreview(jobs), jobs)
})

test('selectRecentJobsPreview returns all jobs when exactly at the limit', () => {
  const jobs = makeJobs(RECENT_JOBS_PREVIEW_LIMIT)
  assert.equal(selectRecentJobsPreview(jobs).length, RECENT_JOBS_PREVIEW_LIMIT)
})

test('selectRecentJobsPreview caps the slice at the default limit', () => {
  const preview = selectRecentJobsPreview(makeJobs(RECENT_JOBS_PREVIEW_LIMIT + 7))
  assert.equal(preview.length, RECENT_JOBS_PREVIEW_LIMIT)
})

test('selectRecentJobsPreview preserves order (newest-first slice from the front)', () => {
  const jobs = makeJobs(10)
  const preview = selectRecentJobsPreview(jobs)
  assert.deepEqual(
    preview.map((j) => j.jobId),
    ['job-1', 'job-2', 'job-3', 'job-4', 'job-5'],
  )
})

test('selectRecentJobsPreview honours an explicit custom limit', () => {
  assert.equal(selectRecentJobsPreview(makeJobs(10), 2).length, 2)
})

test('selectRecentJobsPreview returns empty for a non-positive limit', () => {
  assert.deepEqual(selectRecentJobsPreview(makeJobs(5), 0), [])
  assert.deepEqual(selectRecentJobsPreview(makeJobs(5), -3), [])
})

test('selectRecentJobsPreview does not mutate the source array', () => {
  const jobs = makeJobs(8)
  selectRecentJobsPreview(jobs)
  assert.equal(jobs.length, 8)
})

// --- classifyPickupSearch (KAN-39 scope #2 — pickup-code verification) ----

test('classifyPickupSearch with a blank query is idle and returns all jobs', () => {
  const jobs = [makePickup('7F3K2'), makePickup('9AB1C')]
  const result = classifyPickupSearch(jobs, '')
  assert.equal(result.status, 'idle')
  assert.equal(result.query, '')
  assert.deepEqual(result.matches, jobs)
})

test('classifyPickupSearch treats whitespace-only input as idle', () => {
  const result = classifyPickupSearch([makePickup('7F3K2')], '   ')
  assert.equal(result.status, 'idle')
})

test('classifyPickupSearch tolerates null / undefined jobs and query', () => {
  assert.equal(classifyPickupSearch(null, null).status, 'idle')
  assert.deepEqual(classifyPickupSearch(undefined, undefined).matches, [])
})

test('classifyPickupSearch returns match when an exact code is found', () => {
  const result = classifyPickupSearch([makePickup('7F3K2'), makePickup('9AB1C')], '7F3K2')
  assert.equal(result.status, 'match')
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]!.pickupCode, '7F3K2')
})

test('classifyPickupSearch is case-insensitive', () => {
  const result = classifyPickupSearch([makePickup('7F3K2')], '7f3k2')
  assert.equal(result.status, 'match')
  assert.equal(result.matches.length, 1)
})

test('classifyPickupSearch normalises the query to upper-case', () => {
  assert.equal(classifyPickupSearch([makePickup('7F3K2')], ' 7f3k2 ').query, '7F3K2')
})

test('classifyPickupSearch matches on a substring of the code', () => {
  const result = classifyPickupSearch([makePickup('7F3K2'), makePickup('XF3K9')], 'F3K')
  assert.equal(result.status, 'match')
  assert.equal(result.matches.length, 2)
})

test('classifyPickupSearch returns no-match for an unknown code', () => {
  const result = classifyPickupSearch([makePickup('7F3K2')], 'ZZZZZ')
  assert.equal(result.status, 'no-match')
  assert.equal(result.matches.length, 0)
})

test('classifyPickupSearch on an empty pending list is no-match for any query', () => {
  const result = classifyPickupSearch([], 'ANY')
  assert.equal(result.status, 'no-match')
  assert.deepEqual(result.matches, [])
})
