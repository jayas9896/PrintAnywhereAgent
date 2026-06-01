/**
 * KAN-294: detect whether the local HTTPS UI setup that operator-facing pages
 * advertise (the `local.printanywhere.dhruvantasystems.com` domain) is
 * actually wired up on this machine. The agent itself unconditionally binds
 * HTTPS — what can be broken is:
 *
 *   1. the hosts-file entry `127.0.0.1 local.printanywhere.dhruvantasystems.com`
 *      is missing (so the browser can't even resolve the domain), or
 *   2. the per-host TLS certificate file is missing / never generated, or
 *   3. the cert is generated but the install-time `certutil -addstore Root`
 *      step never ran (admin elevation declined). We cannot read the Windows
 *      trust store directly from Node, so we *infer* "trust-store ok" from
 *      "cert file exists" plus "hosts entry exists". If either is missing we
 *      know the setup is incomplete; if both exist and the browser still
 *      shows a cert warning, the operator will see the warning regardless of
 *      what we report here.
 *
 * The public entry point `evaluateLocalUiDomainHealth` returns a structured
 * result the index page uses to decide whether to render the "Local domain
 * not configured" banner from KAN-294.
 */

import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { lookup as dnsLookup } from 'node:dns/promises'
import { LOCAL_UI_DOMAIN, localCertPaths } from './localHttps.js'

/** Loopback addresses the local UI domain is expected to resolve to. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1'])

/** Default budget for the (best-effort) DNS lookup — kept short so a render
 * path never stalls on a misconfigured resolver. */
const DNS_LOOKUP_TIMEOUT_MS = 400

/**
 * Single-line summary the operator-facing banner uses to describe what is
 * wrong. Empty when everything looks healthy.
 */
export type LocalUiDomainHealth = {
  /** Whether `local.printanywhere.dhruvantasystems.com` should be operable. */
  ok: boolean
  /** Whether the per-host cert+key file exists in the data dir. */
  certPresent: boolean
  /**
   * Whether the Windows hosts file contains the loopback entry for the
   * domain. On non-Windows hosts the hosts file is inspected in the standard
   * location anyway so the detection works during local dev too.
   */
  hostsEntryPresent: boolean
  /**
   * Human-readable description of the first detected problem (banner copy).
   * Empty when `ok` is true.
   */
  reason: string
}

/** Resolve the platform hosts file path. */
export function hostsFilePath(): string {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
    return path.join(root, 'System32', 'drivers', 'etc', 'hosts')
  }
  return '/etc/hosts'
}

/**
 * KAN-294: check the hosts file (read-only) for an entry that maps the local
 * UI domain to a loopback address. We accept either `127.0.0.1` or `::1` and
 * tolerate trailing whitespace / comments, since support occasionally
 * hand-edits the file. A missing or unreadable hosts file is reported as
 * "not present" — the banner copy makes the remediation clear.
 */
export function hostsFileHasLocalUiEntry(hostsPath: string = hostsFilePath()): boolean {
  let text: string
  try {
    text = readFileSync(hostsPath, 'utf8')
  } catch {
    return false
  }
  for (const rawLine of text.split(/\r?\n/)) {
    // Skip blank lines and full-line comments. An inline comment after the
    // host entry is fine; we only need to see the IP + name on a live line.
    const line = rawLine.split('#')[0].trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    if (parts.length < 2) continue
    const [ip, ...names] = parts
    if (ip !== '127.0.0.1' && ip !== '::1') continue
    if (names.some((name) => name.toLowerCase() === LOCAL_UI_DOMAIN.toLowerCase())) {
      return true
    }
  }
  return false
}

/**
 * KAN-451: best-effort check whether `domain` resolves to a loopback address
 * on this machine. An operator can configure name resolution EITHER via a
 * Windows hosts-file entry OR by pointing a public DNS A-record at
 * `127.0.0.1` — the latter resolves fine without any hosts entry, so the
 * banner must not fire when it is in use.
 *
 * We use `dns.lookup` (getaddrinfo), not `resolve4`, so the result honours the
 * OS hosts file AND public DNS — exactly how the browser resolves the name.
 * The lookup is guarded by a short timeout and never throws: any
 * failure / timeout / non-loopback answer is reported as "not resolved" so we
 * never produce a false positive (claiming resolution works when it does not).
 *
 * The `lookupFn` seam exists purely so the branches are unit-testable without
 * depending on the test host's resolver.
 */
export async function domainResolvesToLoopback(
  domain: string = LOCAL_UI_DOMAIN,
  opts: {
    timeoutMs?: number
    lookupFn?: (hostname: string) => Promise<{ address: string }>
  } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? DNS_LOOKUP_TIMEOUT_MS
  const lookupFn = opts.lookupFn ?? ((hostname) => dnsLookup(hostname))

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<{ address: string } | null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
    // Don't let the timer hold the event loop / process open.
    timer.unref?.()
  })

  try {
    // Swallow a late rejection so it can't surface as an unhandled rejection
    // after the timeout has already won the race.
    const resolved = await Promise.race([
      lookupFn(domain).catch(() => null),
      timeout,
    ])
    if (!resolved) return false
    return LOOPBACK_ADDRESSES.has(resolved.address)
  } catch {
    // The function must never throw — the render-path caller awaits it.
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * KAN-294: structured health check that powers the index-page banner.
 * The agent UI is always running over HTTPS by the time this is called (the
 * server bound successfully), so we only need to report whether the
 * domain-based access path is wired up. If `uiHost === "localhost"` the
 * banner is suppressed regardless — the operator (or support) explicitly
 * chose to use the loopback fallback.
 *
 * KAN-451: name resolution is satisfied by EITHER the hosts-file entry OR the
 * domain resolving to loopback via DNS (public A-record). The DNS lookup is
 * async, so the caller performs it and passes the boolean result in via
 * `domainResolvesToLoopback`; this keeps the evaluator pure and synchronous.
 * The CERT requirement is unchanged — TLS still needs the cert present.
 */
export function evaluateLocalUiDomainHealth(opts: {
  dataDir: string
  uiHost: 'domain' | 'localhost'
  /**
   * Whether a DNS lookup confirmed the domain resolves to a loopback address.
   * Defaults to `false` (absent ≡ "not resolved") so the only effect of
   * omitting it is to fall back on the hosts-file check — never a false
   * positive.
   */
  domainResolvesToLoopback?: boolean
}): LocalUiDomainHealth {
  if (opts.uiHost === 'localhost') {
    return { ok: true, certPresent: true, hostsEntryPresent: true, reason: '' }
  }

  const certPaths = localCertPaths(opts.dataDir)
  const certPresent = existsSync(certPaths.certPath) && existsSync(certPaths.keyPath)
  const hostsEntryPresent = hostsFileHasLocalUiEntry()
  // Name resolution is satisfied by EITHER a hosts entry OR public DNS that
  // points the domain at loopback.
  const nameResolutionOk = hostsEntryPresent || opts.domainResolvesToLoopback === true

  if (!nameResolutionOk && !certPresent) {
    return {
      ok: false,
      certPresent,
      hostsEntryPresent,
      reason:
        `The local domain ${LOCAL_UI_DOMAIN} is not yet set up on this Windows user (no hosts entry, no certificate). Open as administrator and click "Repair local URL setup".`,
    }
  }
  if (!nameResolutionOk) {
    return {
      ok: false,
      certPresent,
      hostsEntryPresent,
      reason:
        `The local domain ${LOCAL_UI_DOMAIN} does not resolve to this machine (no hosts-file entry and no loopback DNS record). Open as administrator and click "Repair local URL setup".`,
    }
  }
  if (!certPresent) {
    return {
      ok: false,
      certPresent,
      hostsEntryPresent,
      reason:
        `The local TLS certificate for ${LOCAL_UI_DOMAIN} is missing. Open as administrator and click "Repair local URL setup".`,
    }
  }
  return { ok: true, certPresent, hostsEntryPresent, reason: '' }
}
