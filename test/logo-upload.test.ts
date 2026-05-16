import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_LOGO_BYTES, validateLogoUpload } from '../src/ui/server.ts'

// --- validateLogoUpload (KAN-40 scope #4 — P1-6) --------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])

test('a real PNG buffer is accepted as png', () => {
  const result = validateLogoUpload(PNG_MAGIC)
  assert.equal(result.ok, true)
  assert.equal(result.ext, 'png')
})

test('a real JPEG buffer is accepted as jpg', () => {
  const result = validateLogoUpload(JPEG_MAGIC)
  assert.equal(result.ok, true)
  assert.equal(result.ext, 'jpg')
})

test('a plain SVG buffer is accepted as svg', () => {
  const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')
  const result = validateLogoUpload(svg)
  assert.equal(result.ok, true)
  assert.equal(result.ext, 'svg')
})

test('an SVG with an inline <script> is rejected', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  const result = validateLogoUpload(svg)
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /script/i)
})

test('content-type is NOT trusted — a renamed text file is rejected by magic bytes', () => {
  // A .png file that is actually plain text must be rejected — we sniff the
  // bytes, never the client-declared name or content-type.
  const fake = Buffer.from('this is definitely not an image')
  const result = validateLogoUpload(fake, 'logo.png')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /not a supported image/i)
})

test('an empty / missing buffer is rejected with a friendly message', () => {
  assert.equal(validateLogoUpload(Buffer.alloc(0)).ok, false)
  assert.equal(validateLogoUpload(null).ok, false)
  assert.equal(validateLogoUpload(undefined).ok, false)
})

test('a file over the 2 MB cap is rejected', () => {
  // A PNG-magic buffer padded past the limit.
  const tooBig = Buffer.concat([PNG_MAGIC, Buffer.alloc(MAX_LOGO_BYTES + 1)])
  const result = validateLogoUpload(tooBig)
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /too large|2 MB/i)
})

test('a file exactly at the cap with valid magic bytes is accepted', () => {
  const atLimit = Buffer.concat([PNG_MAGIC, Buffer.alloc(MAX_LOGO_BYTES - PNG_MAGIC.length)])
  assert.equal(atLimit.length, MAX_LOGO_BYTES)
  assert.equal(validateLogoUpload(atLimit).ok, true)
})

test('the rejection message names the file when a name is given', () => {
  const result = validateLogoUpload(Buffer.from('nope'), 'mylogo.gif')
  assert.match(result.error ?? '', /mylogo\.gif/)
})

test('a GIF (not a supported format) is rejected', () => {
  const gif = Buffer.from('GIF89a' + '\0'.repeat(10))
  assert.equal(validateLogoUpload(gif).ok, false)
})
