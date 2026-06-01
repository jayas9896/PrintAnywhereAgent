/**
 * KAN-451: tests for the fail-safe elevation detection + the pure banner
 * selector / render helper. The actual UAC/elevation behaviour only proves out
 * on a real Windows client — these tests pin the fail-safe contract so a
 * working install is never falsely nagged:
 *   - non-Windows / exec error / timeout / garbage stdout -> unknown (null)
 *   - "True"  -> elevated   (true)
 *   - "False" -> NOT elevated (false; the only state that shows a banner)
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __resetElevationCacheForTests,
  detectElevationUncached,
  isElevated,
} from '../src/platform/elevation.ts'
import {
  elevationBannerHtml,
  selectElevationBanner,
} from '../src/ui/server.ts'

// ---- detectElevationUncached: fail-safe branch matrix -----------------------

test('non-Windows platform resolves to unknown without spawning', async () => {
  let called = false
  const result = await detectElevationUncached({
    platform: 'linux',
    exec: async () => {
      called = true
      return { stdout: 'True' }
    },
  })
  assert.equal(result, null)
  // The probe must short-circuit BEFORE attempting to spawn PowerShell.
  assert.equal(called, false)
})

test('"True" from the probe maps to elevated (true)', async () => {
  const result = await detectElevationUncached({
    platform: 'win32',
    exec: async () => ({ stdout: 'True\r\n' }),
  })
  assert.equal(result, true)
})

test('"False" from the probe maps to NOT elevated (false)', async () => {
  const result = await detectElevationUncached({
    platform: 'win32',
    exec: async () => ({ stdout: 'False\r\n' }),
  })
  assert.equal(result, false)
})

test('an exec error resolves to unknown (null), never throws', async () => {
  const result = await detectElevationUncached({
    platform: 'win32',
    exec: async () => {
      throw new Error('spawn powershell.exe ENOENT')
    },
  })
  assert.equal(result, null)
})

test('a timeout (rejection) resolves to unknown (null)', async () => {
  const result = await detectElevationUncached({
    platform: 'win32',
    exec: async () => {
      const err = new Error('timed out') as NodeJS.ErrnoException
      err.code = 'ETIMEDOUT'
      throw err
    },
  })
  assert.equal(result, null)
})

test('unrecognized stdout (garbage / localized) resolves to unknown (null)', async () => {
  for (const garbage of ['', '   ', 'Vrai', 'true', 'yes', 'Error: …']) {
    const result = await detectElevationUncached({
      platform: 'win32',
      exec: async () => ({ stdout: garbage }),
    })
    assert.equal(result, null, `stdout="${garbage}" should be unknown`)
  }
})

// ---- isElevated: process-wide caching ---------------------------------------

test('isElevated caches the resolved value (probes once)', async () => {
  __resetElevationCacheForTests()
  let calls = 0
  const deps = {
    platform: 'win32' as const,
    exec: async () => {
      calls += 1
      return { stdout: 'False' }
    },
  }
  const first = await isElevated(deps)
  // Second call passes deps too, but the cache must short-circuit it.
  const second = await isElevated({
    platform: 'win32' as const,
    exec: async () => {
      calls += 1
      return { stdout: 'True' }
    },
  })
  assert.equal(first, false)
  assert.equal(second, false)
  assert.equal(calls, 1)
  __resetElevationCacheForTests()
})

test('isElevated caches the unknown (null) result too', async () => {
  __resetElevationCacheForTests()
  let calls = 0
  const value = await isElevated({
    platform: 'linux' as const,
    exec: async () => {
      calls += 1
      return { stdout: 'True' }
    },
  })
  const again = await isElevated({ platform: 'win32' as const, exec: async () => ({ stdout: 'False' }) })
  assert.equal(value, null)
  assert.equal(again, null)
  assert.equal(calls, 0)
  __resetElevationCacheForTests()
})

// ---- selectElevationBanner: only `false` shows a banner ---------------------

test('selectElevationBanner returns a banner only when NOT elevated (false)', () => {
  const banner = selectElevationBanner(false)
  assert.ok(banner)
  assert.match(banner.title, /administrator/i)
  assert.match(banner.body, /administrator/i)
})

test('selectElevationBanner returns null when elevated (true)', () => {
  assert.equal(selectElevationBanner(true), null)
})

test('selectElevationBanner returns null when unknown (null) — fail-safe', () => {
  assert.equal(selectElevationBanner(null), null)
})

// ---- elevationBannerHtml: render contract -----------------------------------

test('elevationBannerHtml renders the restart form + uiToken only when NOT elevated', () => {
  const html = elevationBannerHtml(false, 'tok-123')
  assert.match(html, /id="elevation-banner"/)
  assert.match(html, /action="\/actions\/restart-elevated"/)
  assert.match(html, /Restart as administrator/)
  // The uiToken must be embedded so the CSRF/origin check on the POST passes.
  assert.match(html, /name="uiToken" value="tok-123"/)
})

test('elevationBannerHtml htmlEscapes the uiToken', () => {
  const html = elevationBannerHtml(false, '"><script>x</script>')
  assert.doesNotMatch(html, /<script>x<\/script>/)
  assert.match(html, /&lt;script&gt;/)
})

test('elevationBannerHtml renders nothing when elevated or unknown', () => {
  assert.equal(elevationBannerHtml(true, 'tok'), '')
  assert.equal(elevationBannerHtml(null, 'tok'), '')
})
