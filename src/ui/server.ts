import { createHash } from 'node:crypto'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { createServer as createHttpsServer } from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { Request, Response } from 'express'
import multer from 'multer'
import QRCode from 'qrcode'
import type {
  AgentApprovalStatus,
  AgentLocationSnapshot,
  AgentProfile,
  ConfiguredConstraint,
  PickupJobSnapshot,
  PlatformColorMode,
  PlatformPageSize,
  PlatformPrinter,
  PlatformPrinterStatus,
  PlatformScalingMode,
  PlatformSidesMode,
  RecentJobSnapshot,
} from '../config/types.js'
import type { AgentCouponUpsertPayload } from '../cloud/api.js'
import { AGENT_VERSION, defaultPrintAnywhereBackendUrl } from '../config/defaults.js'
import type { AgentRuntime, PlatformPrinterUpsertInput } from '../runtime/agentRuntime.js'
import { LOCAL_UI_DOMAIN, ensureLocalCert } from './localHttps.js'
import {
  DEFAULT_UI_PORT,
  readLauncherConfig,
  resetLauncherConfigIfMajorUpgrade,
  writeUiRuntimeInfo,
} from './launcherConfig.js'
import { evaluateLocalUiDomainHealth } from './localHttpsHealth.js'
import { runLocalHttpsRepair } from './localHttpsRepair.js'
import {
  RECOMMENDED_SECURE_COVER_SWATCHES,
  parseHexColor,
  resolvePreviewHex,
} from './secureCoverColors.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const COLOR_MODE_OPTIONS: PlatformColorMode[] = ['MONOCHROME', 'COLOR']
const SIDES_MODE_OPTIONS: PlatformSidesMode[] = ['SINGLE_SIDED', 'DOUBLE_SIDED']
const PAGE_SIZE_OPTIONS: PlatformPageSize[] = ['A4', 'A3']
const SCALING_MODE_OPTIONS: PlatformScalingMode[] = ['ACTUAL_SIZE', 'FIT_TO_PAGE', 'SHRINK_TO_FIT']
const PRINTER_STATUS_OPTIONS: PlatformPrinterStatus[] = ['ONLINE', 'BUSY', 'OFFLINE', 'MAINTENANCE']

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function htmlEscape(value: string | null | undefined) {
  return (value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function hiddenUiToken(uiToken: string | null | undefined) {
  return `<input type="hidden" name="uiToken" value="${htmlEscape(uiToken ?? '')}" />`
}

// KAN-165: the local UI is also served at the loopback-pinned domain
// `local.printanywhere.dhruvantasystems.com` (hosts-file entry -> 127.0.0.1).
// The domain is an accepted same-machine origin alongside the raw loopback
// hosts — it never resolves anywhere but 127.0.0.1.
const LOCAL_UI_ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '::1', LOCAL_UI_DOMAIN]

/**
 * KAN-299: an Origin header is `loopback-safe` if it is missing, the literal
 * string `"null"` (sent by sandboxed iframes / certain extensions / redirect
 * chains / stale service workers — there is no remote origin that can forge
 * `Origin: null` against a same-machine loopback POST), or it parses to a URL
 * whose hostname is one of the same-machine loopback hosts. The uiToken still
 * gates real authentication; the origin check is defence-in-depth against an
 * off-machine drive-by, and `"null"` is by definition not off-machine here.
 */
export function isLoopbackOrigin(value: string | undefined) {
  if (!value) return true
  if (value === 'null') return true
  try {
    const url = new URL(value)
    return LOCAL_UI_ALLOWED_HOSTS.includes(url.hostname)
  } catch {
    return false
  }
}

/**
 * KAN-299: parse the loopback host out of the `Host:` header (which is always
 * present on a real HTTP/1.1 request) so a same-origin form POST that the
 * browser stripped of both Origin AND Referer (e.g. cross-document navigations
 * with no-referrer policy, certain extensions) still passes the origin check.
 * The port suffix is discarded; only the hostname is compared.
 */
export function isLoopbackHostHeader(value: string | undefined) {
  if (!value) return false
  // `Host` can be `host:port`, `[ipv6]:port`, or `host`. Strip the port portion.
  const trimmed = value.trim()
  const stripped = trimmed.startsWith('[')
    ? trimmed.slice(1).split(']')[0] // bracketed IPv6
    : trimmed.split(':')[0]
  return LOCAL_UI_ALLOWED_HOSTS.includes(stripped)
}

/**
 * KAN-299: the verification routine each POST handler calls before touching
 * runtime state. Exported so the request-level regression contract (Origin
 * "null" allowed; both Origin+Referer absent with allowed Host allowed;
 * off-machine Origin rejected) can be unit-tested without spinning a server.
 */
export function verifyUiRequest(runtime: AgentRuntime, request: Request, response: Response) {
  const snapshot = runtime.snapshot()
  const uiToken = String(request.body.uiToken ?? '')
  if (!runtime.verifyUiToken(uiToken)) {
    response.status(403).type('text/plain').send('Invalid local UI token')
    return false
  }
  const origin = request.get('origin')
  const referer = request.get('referer')
  const host = request.get('host')

  // KAN-299: when both Origin and Referer are absent (or the literal `"null"`)
  // the browser stripped the usual same-origin signals — fall back to the
  // mandatory Host header instead of returning a blanket 403.
  const originSafe = isLoopbackOrigin(origin)
  const refererSafe = isLoopbackOrigin(referer)
  const bothMissingOrNull =
    (!origin || origin === 'null') && (!referer || referer === 'null')

  const originOk = bothMissingOrNull
    ? isLoopbackHostHeader(host)
    : originSafe && refererSafe

  if (!originOk) {
    // KAN-299: surface the exact failing fields so an operator (and support)
    // can diagnose the 403 instead of staring at a generic message. This
    // endpoint is loopback-only, so the values are not sensitive — and an
    // off-machine attacker cannot reach it in the first place.
    const detail =
      `(origin="${origin ?? ''}", referer="${referer ?? ''}", host="${host ?? ''}")`
    console.warn(`PrintAnywhere Agent UI: origin check failed ${detail}`)
    response
      .status(403)
      .type('text/plain')
      .send(`Local UI origin check failed ${detail}`)
    return false
  }
  if (!snapshot.uiToken) {
    response.status(503).type('text/plain').send('Local UI is not initialized')
    return false
  }
  return true
}

function asArray(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item))
  if (value == null || value === '') return []
  return [String(value)]
}

function parseRequiredText(body: Record<string, unknown>, key: string) {
  const value = String(body[key] ?? '').trim()
  if (!value) throw new Error(`${humanizeKey(key)} is required.`)
  return value
}

function parseOptionalTrimmed(body: Record<string, unknown>, key: string) {
  const value = String(body[key] ?? '').trim()
  return value || null
}

function parseOptionalInt(body: Record<string, unknown>, key: string): number | null {
  const raw = String(body[key] ?? '').trim()
  if (!raw) return null
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function hasCheckbox(body: Record<string, unknown>, key: string) {
  return String(body[key] ?? '') === 'on'
}

function humanizeEnum(value: string | null | undefined) {
  if (!value) return 'Unknown'
  return value
    .toLowerCase()
    .split('_')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

function humanizeKey(value: string) {
  return value
    .replaceAll(/([A-Z])/g, ' $1')
    .replaceAll(/[_-]+/g, ' ')
    .trim()
    .replace(/^./, (character) => character.toUpperCase())
}

function checked(condition: boolean) {
  return condition ? 'checked' : ''
}

function selected<T extends string>(actual: T | null | undefined, expected: T) {
  return actual === expected ? 'selected' : ''
}

function formatMinor(value: number | null | undefined) {
  const amount = (value ?? 0) / 100
  return `₹${amount.toFixed(2)}`
}

// ---------------------------------------------------------------------------
// Rupee <-> paise conversion (KAN-38 scope #2)
// ---------------------------------------------------------------------------
//
// Prices are stored and sent to the cloud in paise (the minor unit; ₹1 =
// 100 paise). A non-technical shop owner thinks in rupees, so the publish
// form lets them enter a ₹ decimal amount and we convert on submit. These
// helpers are the single, tested conversion contract — keep all rupee/paise
// arithmetic here so floating-point rounding is handled in exactly one place.

/**
 * Convert a paise integer to a fixed 2-decimal rupee STRING suitable for the
 * `value` of a `type="number" step="0.01"` input (e.g. 1550 -> "15.50").
 * Null/undefined and non-finite inputs become "0.00".
 */
export function paiseToRupeeInput(paise: number | null | undefined): string {
  const n = typeof paise === 'number' && Number.isFinite(paise) ? paise : 0
  return (n / 100).toFixed(2)
}

/**
 * Parse a rupee amount typed by the owner into an integer paise value.
 *
 * Accepts an optional leading `₹` and surrounding whitespace. Multiplies by
 * 100 and rounds to the nearest paise — `Math.round` is essential here, as
 * `15.10 * 100` is `1509.9999…` in IEEE-754 and would truncate to 1509.
 *
 * Throws a friendly Error for blank, non-numeric or negative input so the
 * caller can surface it through the existing redirect-with-error flow.
 */
export function parseRupeesToPaise(raw: unknown, fieldLabel = 'Price'): number {
  const text = String(raw ?? '').trim().replace(/^₹\s*/, '').trim()
  if (!text) throw new Error(`${fieldLabel} is required.`)
  const rupees = Number(text)
  if (!Number.isFinite(rupees)) throw new Error(`${fieldLabel} must be a valid amount in rupees.`)
  if (rupees < 0) throw new Error(`${fieldLabel} cannot be negative.`)
  return Math.round(rupees * 100)
}

/**
 * Like parseRupeesToPaise but for OPTIONAL fields (the Advanced sections):
 * a blank value returns null (the rule is left unset) instead of throwing.
 * The result is returned as a paise STRING so it slots straight into the
 * existing string-keyed constraint `configuration` objects.
 */
export function parseOptionalRupeesToPaise(raw: unknown, fieldLabel = 'Price'): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  return String(parseRupeesToPaise(text, fieldLabel))
}

function formatTimestamp(value?: string | null, fallback = 'Never') {
  if (!value) return fallback
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function formatLocationSnapshot(location?: AgentLocationSnapshot | null) {
  if (!location) return 'No device location captured'
  const accuracy = location.accuracyMeters != null ? ` · ±${Math.round(location.accuracyMeters)}m` : ''
  return `${location.latitude}, ${location.longitude}${accuracy} · ${humanizeEnum(location.source)} · ${formatTimestamp(location.capturedAt)}`
}

function parseBrowserLocationBody(body: Record<string, unknown>) {
  const latitude = parseOptionalFormNumber(body.latitude)
  const longitude = parseOptionalFormNumber(body.longitude)
  if (latitude == null && longitude == null) return null
  if (latitude == null || longitude == null) throw new Error('Browser location must include both latitude and longitude.')
  return {
    latitude,
    longitude,
    accuracyMeters: parseOptionalFormNumber(body.accuracyMeters),
    capturedAt: String(body.capturedAt ?? '').trim() || null,
  }
}

function parseOptionalFormNumber(value: unknown) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function redirectTo(response: Response, path: string, type: 'notice' | 'error', message: string) {
  const url = new URL(`http://local${path}`)
  url.searchParams.set(type, message)
  response.redirect(url.pathname + url.search)
}

function redirectWithStatus(
  response: Response,
  type: 'notice' | 'error',
  message: string,
  // Phase 1.5a — optional override so /login flows return the
  // operator to /login instead of the dashboard. Existing callers
  // continue to default to '/'.
  path: string = '/',
) {
  redirectTo(response, path, type, message)
}

function friendlyConfigureError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Configuration failed'
  if (message.includes('Machine is already registered') || message.includes('"code":"CONFLICT"')) {
    return 'This machine is already registered in PrintAnywhere. This form will not create another machine. Save settings on the existing registration, generate a new pairing code if support asks you to re-pair, or ask an admin to review the existing machine.'
  }
  return message
}

function findConstraint(printer: PlatformPrinter | null | undefined, type: string) {
  return printer?.documentConstraints.find((constraint) => constraint.type === type)?.configuration ?? {}
}

function findPricingAdjustment(printer: PlatformPrinter | null | undefined, type: string) {
  return printer?.pricingAdjustments.find((adjustment) => adjustment.type === type)?.configuration ?? {}
}

/**
 * Render an OPTIONAL rupee money field for the Advanced sections. An empty
 * stored value renders as an empty input (the rule is disabled) rather than
 * "0.00". `storedPaise` is the raw paise string held in the constraint
 * configuration, or '' / undefined when unset.
 */
function optionalMoneyField(opts: { name: string; label: string; storedPaise: unknown }) {
  const raw = String(opts.storedPaise ?? '').trim()
  const value = raw && Number.isFinite(Number(raw)) ? (Number(raw) / 100).toFixed(2) : ''
  return `
    <label>
      <div class="label-text">${htmlEscape(opts.label)}</div>
      <div class="money-input">
        <input type="number" step="0.01" min="0" inputmode="decimal"
          name="${htmlEscape(opts.name)}" value="${htmlEscape(value)}" placeholder="0.00" />
      </div>
    </label>
  `
}

/**
 * Sticky-aware required rupee field for the publish form (KAN-40 P1-5).
 * When `sticky.submitted` carries this field, the owner's raw typed rupee
 * string is shown verbatim (so an invalid value like "abc" survives for
 * correction); otherwise the stored paise value is formatted to rupees.
 * A field-level error message is rendered beneath when one applies.
 */
function stickyMoneyField(opts: {
  name: string
  label: string
  paiseValue: number | null | undefined
  sticky?: StickyForm
  spanClass?: string
}) {
  const span = opts.spanClass ? ` ${opts.spanClass}` : ''
  const submitted = opts.sticky?.submitted
  const hasSubmitted = !!submitted && Object.prototype.hasOwnProperty.call(submitted, opts.name)
  const value = hasSubmitted
    ? String(submitted![opts.name] ?? '')
    : paiseToRupeeInput(opts.paiseValue)
  const errored = opts.sticky?.fieldErrors?.[opts.name] ? ' has-error' : ''
  return `
    <label class="${(span + errored).trim()}">
      <div class="label-text">${htmlEscape(opts.label)}</div>
      <div class="money-input">
        <input type="number" step="0.01" min="0" inputmode="decimal"
          name="${htmlEscape(opts.name)}" value="${htmlEscape(value)}" />
      </div>
      ${fieldError(opts.sticky, opts.name)}
    </label>
  `
}

function renderCheckboxGroup<T extends string>(name: string, options: T[], selectedValues: T[]) {
  return options
    .map(
      (option) => `
        <label class="choice">
          <input type="checkbox" name="${htmlEscape(name)}" value="${htmlEscape(option)}" ${checked(selectedValues.includes(option))} />
          <span>${htmlEscape(humanizeEnum(option))}</span>
        </label>
      `,
    )
    .join('')
}

function approvalTone(status: AgentApprovalStatus | null | undefined) {
  switch (status) {
    case 'APPROVED': return 'badge badge-good'
    case 'SUSPENDED':
    case 'REJECTED': return 'badge badge-bad'
    default: return 'badge'
  }
}

function statusBadge(status: string) {
  const s = status.toUpperCase()
  if (['COMPLETED', 'COLLECTED', 'APPROVED'].includes(s)) return 'badge badge-good'
  if (['FAILED', 'REJECTED', 'SUSPENDED', 'OFFLINE'].includes(s)) return 'badge badge-bad'
  if (['QUEUED', 'DOWNLOADING', 'DECRYPTING', 'PRINTING', 'DISPATCHING'].includes(s)) return 'badge badge-info'
  return 'badge'
}

// ---------------------------------------------------------------------------
// Logo upload validation (KAN-40 scope #4 — UX review KAN-29 P1-6)
// ---------------------------------------------------------------------------
//
// The business logo was a raw URL text input and the header <img> silently
// hid on error — a non-technical owner had no way to know it failed, and no
// way to upload a file they had on disk. We now accept a real file upload.
// validateLogoUpload sniffs the file's magic bytes (not the client-supplied
// content-type, which cannot be trusted) and enforces a size cap.

/** Largest logo file we accept, in bytes (2 MB). */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024

export interface LogoValidationResult {
  ok: boolean
  /** File extension to store the logo under, when ok. */
  ext?: 'png' | 'jpg' | 'svg'
  /** Friendly, operator-facing reason when not ok. */
  error?: string
}

/**
 * Validate an uploaded logo buffer by sniffing its real format from the
 * leading bytes. Accepts PNG, JPEG and SVG only, up to MAX_LOGO_BYTES.
 * Pure and exported so the rules are unit-testable without a real upload.
 */
export function validateLogoUpload(
  buffer: Buffer | null | undefined,
  declaredName?: string | null,
): LogoValidationResult {
  if (!buffer || buffer.length === 0) {
    return { ok: false, error: 'No file was received. Please choose an image file and try again.' }
  }
  if (buffer.length > MAX_LOGO_BYTES) {
    return {
      ok: false,
      error: 'That image is too large. Please use a logo under 2 MB.',
    }
  }

  // PNG — 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return { ok: true, ext: 'png' }
  }

  // JPEG — starts FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ok: true, ext: 'jpg' }
  }

  // SVG — text format. Look for an <svg tag near the start (allowing an XML
  // prolog / BOM / whitespace), case-insensitively.
  const head = buffer.subarray(0, 512).toString('utf8').toLowerCase()
  if (head.includes('<svg')) {
    // A defensive sanity check: SVG can carry scripts. We only embed the file
    // via an <img> tag (which does not execute SVG scripts) and serve it with
    // nosniff, but reject anything with an obvious inline <script> anyway.
    if (head.includes('<script')) {
      return {
        ok: false,
        error: 'That SVG file contains a script and was not accepted. Please use a plain image logo.',
      }
    }
    return { ok: true, ext: 'svg' }
  }

  const named = declaredName ? ` ("${declaredName}")` : ''
  return {
    ok: false,
    error: `That file${named} is not a supported image. Please upload a PNG, JPG or SVG logo.`,
  }
}

// ---------------------------------------------------------------------------
// Plain-language cloud-error mapping (KAN-40 scope #1 — UX review KAN-29 P1-3)
// ---------------------------------------------------------------------------
//
// Backend failures used to be swallowed into a muted table cell showing raw
// exception text like "HTTP 503: ..." or "TypeError: fetch failed". A non-
// technical print-shop owner cannot act on that. mapCloudError translates any
// thrown error into a reassuring title + body with no stack traces, no
// exception class names, and no HTTP status codes — paired with a prominent
// error stateBanner and a Retry action wherever a cloud fetch fails.

export interface FriendlyError {
  title: string
  body: string
}

/**
 * Pure, testable mapping from any thrown value to operator-facing copy.
 *
 * The cloud client throws `Error("HTTP <status>: <body>")` for non-2xx
 * responses (see api.ts `apiError`) and `fetch` itself throws a `TypeError`
 * (message "fetch failed", often with an ECONNREFUSED/ENOTFOUND cause) when
 * the network is unreachable. We classify on the message text — never
 * surfacing the raw message to the owner.
 */
export function mapCloudError(error: unknown): FriendlyError {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = raw.toLowerCase()
  // Include any nested cause code (Node attaches ECONNREFUSED etc. as a cause).
  const causeCode =
    error instanceof Error && error.cause && typeof error.cause === 'object'
      ? String((error.cause as { code?: unknown }).code ?? '').toLowerCase()
      : ''
  const haystack = `${text} ${causeCode}`

  // --- Timeout / aborted request ------------------------------------------
  if (
    error instanceof Error && error.name === 'AbortError'
    || haystack.includes('timeout')
    || haystack.includes('timed out')
    || haystack.includes('etimedout')
  ) {
    return {
      title: 'PrintAnywhere is slow to respond',
      body: 'The PrintAnywhere server took too long to answer. It may be busy. Wait a moment, then press Retry.',
    }
  }

  // --- Network unreachable (the most common offline case) ------------------
  if (
    haystack.includes('fetch failed')
    || haystack.includes('econnrefused')
    || haystack.includes('enotfound')
    || haystack.includes('econnreset')
    || haystack.includes('eai_again')
    || haystack.includes('network')
    || haystack.includes('socket hang up')
    || (error instanceof TypeError)
  ) {
    return {
      title: 'Cannot reach PrintAnywhere',
      body: 'This PC could not connect to the PrintAnywhere server. Check this computer’s internet connection, then press Retry.',
    }
  }

  // --- Authentication / authorization rejected -----------------------------
  if (/\bhttp 401\b/.test(text) || /\bhttp 403\b/.test(text)) {
    return {
      title: 'PrintAnywhere did not accept this machine',
      body: 'This PC’s connection to PrintAnywhere was refused. Try generating a new pairing code, or contact your PrintAnywhere admin if it keeps happening.',
    }
  }

  // --- Server-side error (5xx) --------------------------------------------
  if (/\bhttp 5\d\d\b/.test(text)) {
    return {
      title: 'PrintAnywhere is having trouble right now',
      body: 'The PrintAnywhere server reported a problem on its side. This is usually temporary — please wait a moment and press Retry.',
    }
  }

  // --- Not found (4xx other than auth) ------------------------------------
  if (/\bhttp 404\b/.test(text)) {
    return {
      title: 'PrintAnywhere could not find that',
      body: 'The PrintAnywhere server could not find what the agent asked for. Try refreshing — if it persists, contact support.',
    }
  }

  if (/\bhttp 4\d\d\b/.test(text)) {
    return {
      title: 'PrintAnywhere could not complete that request',
      body: 'The PrintAnywhere server declined the request. Try refreshing — if it persists, contact support.',
    }
  }

  // --- Anything else -------------------------------------------------------
  return {
    title: 'Something went wrong talking to PrintAnywhere',
    body: 'The agent could not complete that just now. Please wait a moment and press Retry. If it keeps happening, contact support.',
  }
}

/**
 * Render the standard, prominent offline / backend-unreachable banner: an
 * error-variant stateBanner carrying the friendly title + body, followed by
 * a Retry action. `retryHref` is where the Retry button links (the same page
 * by default). Used wherever a cloud fetch fails (KAN-40 P1-3).
 */
export function renderOfflineBanner(error: unknown, retryHref: string = ''): string {
  const friendly = mapCloudError(error)
  const href = retryHref || '.'
  return `<div id="offline-banner" style="display:flex; flex-direction:column; gap:var(--space-2);">
    ${stateBanner({ variant: 'error', title: friendly.title, body: friendly.body })}
    <div class="btn-row">
      <a class="btn btn-secondary" href="${htmlEscape(href)}">Retry</a>
    </div>
  </div>`
}

// ---------------------------------------------------------------------------
// Lifecycle / approval banners (KAN-40 scope #3 — UX review KAN-29 P1-8)
// ---------------------------------------------------------------------------
//
// Approval state used to be communicated by a single small badge in the
// Registration card — a SUSPENDED or REJECTED machine looked almost the same
// as an approved one. selectLifecycleBanner maps the cloud-reported approval
// status to a prominent, plain-language banner with "what this means / what
// to do now" guidance, so a non-technical owner is never left guessing why
// jobs stopped arriving.
//
// Note on REVOKED: the recovery docs talk about a "revoked" machine, but the
// agent data model only carries REJECTED (see AgentApprovalStatus). We treat
// REJECTED as that strongest "this machine can no longer take orders" state
// and use the docs' revoked-recovery wording for it.

export interface LifecycleBanner {
  variant: 'info' | 'warning' | 'error'
  title: string
  body: string
}

/**
 * Pure, testable mapping from an agent profile's approval status to the
 * prominent lifecycle banner the dashboard should show — or `null` when the
 * machine is fully approved (APPROVED) and no standing notice is needed.
 *
 * A missing profile is treated as PENDING_REVIEW: the machine has registered
 * but the cloud has not yet returned an approval decision.
 */
export function selectLifecycleBanner(
  profile: Pick<AgentProfile, 'approvalStatus'> | null | undefined,
): LifecycleBanner | null {
  const status = profile?.approvalStatus ?? 'PENDING_REVIEW'
  switch (status) {
    case 'APPROVED':
      return null
    case 'SUSPENDED':
      return {
        variant: 'warning',
        title: 'This machine is paused by PrintAnywhere',
        body:
          'Customer print jobs are not being sent to this PC right now, and you cannot ' +
          'change your printers until it is un-paused. This is usually temporary. ' +
          'Please contact your PrintAnywhere admin to find out why and get it un-paused.',
      }
    case 'REJECTED':
      return {
        variant: 'error',
        title: 'This machine is no longer connected to PrintAnywhere',
        body:
          'PrintAnywhere has removed this PC from your shop, so it cannot take customer ' +
          'orders. Please stop using it for printing and contact your PrintAnywhere admin. ' +
          'You may need to set this PC up again — see Support for the reset steps.',
      }
    case 'PENDING_REVIEW':
    default:
      return {
        variant: 'info',
        title: 'Waiting for PrintAnywhere to approve this shop',
        body:
          'You can finish setting up your printers and prices now. Customers will not be ' +
          'able to find or print to your shop until a PrintAnywhere admin approves it — ' +
          'this is a one-time check and usually takes less than a day.',
      }
  }
}

// ---------------------------------------------------------------------------
// Coupons gating (KAN-40 scope #5 — UX review KAN-29 P2-5)
// ---------------------------------------------------------------------------
//
// A coupon can only ever discount an order at a platform printer. If the shop
// has not published a single platform printer yet, the Coupons area is a
// dead end — the owner can create codes that nothing can redeem. P2-5 asks us
// to soft-disable Coupons until a platform printer exists, so owners do not
// hit it prematurely.

export type CouponsGateReason = 'no-platform-printer' | 'not-approved'

export interface CouponsGate {
  /** True when the Coupons create form should be hidden / soft-disabled. */
  gated: boolean
  /** Why it is gated — drives the explanatory copy. Null when not gated. */
  reason: CouponsGateReason | null
}

/**
 * Pure, testable decision for whether the Coupons area is gated.
 *
 * Gated when the machine is not yet approved for self-service (it cannot
 * manage anything customer-facing), OR when it is approved but has not
 * published a platform printer yet (a coupon would have nothing to apply to).
 * `not-approved` takes precedence as it is the more fundamental blocker.
 */
export function shouldGateCoupons(
  snapshot: Pick<ReturnType<AgentRuntime['snapshot']>, 'profile' | 'platformPrinters'>,
): CouponsGate {
  const selfServiceEnabled = !!snapshot.profile?.selfServiceEnabled
  if (!selfServiceEnabled) {
    return { gated: true, reason: 'not-approved' }
  }
  const platformPrinters = snapshot.platformPrinters ?? []
  if (platformPrinters.length === 0) {
    return { gated: true, reason: 'no-platform-printer' }
  }
  return { gated: false, reason: null }
}

// ---------------------------------------------------------------------------
// Connection / heartbeat staleness
// ---------------------------------------------------------------------------

/**
 * How long (ms) the agent may go without a successful heartbeat before its
 * cloud connection is treated as stale. The runtime sends a heartbeat every
 * 60s; the operator-facing copy already tells shop owners that a heartbeat
 * older than 2 minutes means the connection may be lost — so 120s is the
 * staleness threshold, sitting cleanly between the 60s interval and the
 * runtime's 180s watchdog.
 */
export const HEARTBEAT_STALE_THRESHOLD_MS = 120_000

export type ConnectionState = 'connected' | 'stale' | 'disconnected' | 'unregistered'

export interface ConnectionStatus {
  /** Coarse state used to pick the pill colour/icon. */
  state: ConnectionState
  /** Whole seconds since the last heartbeat, or null when none has occurred. */
  ageSeconds: number | null
  /** Short, non-technical label for the pill. */
  label: string
  /** Friendly "last sync" sentence for the operator. */
  detail: string
}

/** Render a relative "x ago" phrase from a second count. */
function describeAge(ageSeconds: number): string {
  if (ageSeconds < 5) return 'just now'
  if (ageSeconds < 60) return `${ageSeconds}s ago`
  const minutes = Math.floor(ageSeconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  return `${Math.floor(hours / 24)} day(s) ago`
}

/**
 * Pure, testable mapping from raw heartbeat facts to a connection status.
 * Used both for the server-rendered pill and (via /health) the client poll.
 */
export function computeConnectionState(input: {
  registered: boolean
  lastHeartbeatAt: string | null | undefined
  now?: number
  staleThresholdMs?: number
}): ConnectionStatus {
  const now = input.now ?? Date.now()
  const threshold = input.staleThresholdMs ?? HEARTBEAT_STALE_THRESHOLD_MS

  if (!input.registered) {
    return {
      state: 'unregistered',
      ageSeconds: null,
      label: 'Not registered',
      detail: 'This machine is not registered with PrintAnywhere yet.',
    }
  }

  const heartbeatMs = input.lastHeartbeatAt ? Date.parse(input.lastHeartbeatAt) : NaN
  if (!Number.isFinite(heartbeatMs)) {
    return {
      state: 'disconnected',
      ageSeconds: null,
      label: 'Disconnected',
      detail: 'No heartbeat received yet — waiting for the first cloud sync.',
    }
  }

  const ageSeconds = Math.max(0, Math.round((now - heartbeatMs) / 1000))
  const ageMs = now - heartbeatMs

  if (ageMs <= threshold) {
    return {
      state: 'connected',
      ageSeconds,
      label: 'Connected',
      detail: `Last synced ${describeAge(ageSeconds)}.`,
    }
  }

  // Beyond 3x the threshold the connection is treated as fully down.
  if (ageMs > threshold * 3) {
    return {
      state: 'disconnected',
      ageSeconds,
      label: 'Disconnected',
      detail: `No cloud sync for ${describeAge(ageSeconds)}. Restart the agent if this persists.`,
    }
  }

  return {
    state: 'stale',
    ageSeconds,
    label: 'Connection delayed',
    detail: `Last synced ${describeAge(ageSeconds)} — the cloud connection may be slow.`,
  }
}

// ---------------------------------------------------------------------------
// First-run / pairing stage
// ---------------------------------------------------------------------------

/**
 * Coarse first-run lifecycle stage for a print-shop owner setting up a brand
 * new machine. Drives whether the dashboard renders the full operator console
 * or a focused, guided pairing screen (KAN-37, UX review KAN-29 theme 2 P0-1).
 *
 *   config          — no cloud registration yet. The owner sees a short,
 *                      focused config form ("tell us about your shop").
 *   awaiting-pairing — the machine has registered and holds a pairing code,
 *                      but the platform admin has not finished pairing it.
 *                      The hero pairing code + QR are shown here.
 *   paired           — the admin has approved/paired the machine. The full
 *                      operator dashboard (Branding, Pricing, Orders, …) is
 *                      shown.
 */
export type FirstRunStage = 'config' | 'awaiting-pairing' | 'paired'

export interface FirstRunStatus {
  stage: FirstRunStage
  /** True for `config` and `awaiting-pairing` — render the guided screen. */
  isFirstRun: boolean
  /** The pairing code to hand the admin, when one exists. */
  pairingCode: string | null
  /** Raw ISO expiry of the pairing code, when one exists. */
  pairingCodeExpiresAt: string | null
}

/**
 * Pure, testable mapping from an agent snapshot to its first-run stage.
 *
 * Discriminators:
 *  - No `registration.agentId`            → `config`.
 *  - Has `agentId` but the admin has not   → `awaiting-pairing`. We treat the
 *    completed pairing                       machine as paired once the cloud
 *                                            reports `selfServiceEnabled` (the
 *                                            first capability that flips after
 *                                            an admin approves the machine —
 *                                            see agentRuntime.refreshCloudState)
 *                                            or an `APPROVED` approval status.
 *  - A registration with a registered      → still `awaiting-pairing` so the
 *    status but no pairing code yet           guided screen can explain that the
 *                                            code is being generated.
 */
export function computeFirstRunStage(
  snapshot: Pick<ReturnType<AgentRuntime['snapshot']>, 'registration' | 'profile'>,
): FirstRunStatus {
  const registration = snapshot.registration ?? null
  const pairingCode = registration?.pairingCode?.trim() || null
  const pairingCodeExpiresAt = registration?.pairingCodeExpiresAt ?? null

  if (!registration?.agentId) {
    return { stage: 'config', isFirstRun: true, pairingCode: null, pairingCodeExpiresAt: null }
  }

  const profile = snapshot.profile ?? null
  const paired = !!profile && (profile.selfServiceEnabled || profile.approvalStatus === 'APPROVED')
  if (paired) {
    return { stage: 'paired', isFirstRun: false, pairingCode, pairingCodeExpiresAt }
  }

  return { stage: 'awaiting-pairing', isFirstRun: true, pairingCode, pairingCodeExpiresAt }
}

/** True when an ISO pairing-code expiry is in the past relative to `now`. */
export function isPairingCodeExpired(expiresAt: string | null | undefined, now: number = Date.now()) {
  if (!expiresAt) return false
  const ms = Date.parse(expiresAt)
  if (!Number.isFinite(ms)) return false
  return ms <= now
}

// ---------------------------------------------------------------------------
// QR code rendering
// ---------------------------------------------------------------------------

/**
 * Render a payload as an inline, dependency-light SVG QR code.
 *
 * Uses the `qrcode` package (MIT) — but only its synchronous `QRCode.create`
 * matrix API, so the SVG is assembled here and server-rendered straight into
 * the page (no client-side JS, no async). The owner can scan it with a phone
 * to hand the pairing code to their platform admin (KAN-37 P0-2).
 */
export function renderQrSvg(payload: string, opts: { size?: number; label?: string } = {}) {
  const size = opts.size ?? 168
  const label = opts.label ?? 'QR code'
  let qr
  try {
    qr = QRCode.create(payload, { errorCorrectionLevel: 'M' })
  } catch {
    return ''
  }
  const count: number = qr.modules.size
  const quiet = 2
  const dim = count + quiet * 2
  const cells: string[] = []
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.modules.get(row, col)) {
        cells.push(`M${col + quiet} ${row + quiet}h1v1h-1z`)
      }
    }
  }
  return `<svg class="pairing-qr" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${dim} ${dim}" role="img" aria-label="${htmlEscape(label)}" shape-rendering="crispEdges">
    <rect width="${dim}" height="${dim}" fill="#fff"></rect>
    <path d="${cells.join('')}" fill="#142018"></path>
  </svg>`
}

// ---------------------------------------------------------------------------
// Shared CSS
// ---------------------------------------------------------------------------

const SHARED_CSS = `
  /* =========================================================================
   * PrintAnywhere Agent UI — Design System
   * -------------------------------------------------------------------------
   * All visual styling derives from the design tokens declared in :root below.
   * When building new UI, reuse the tokens and component classes documented
   * here instead of hard-coding values — this keeps the operator-facing UI
   * consistent and lets later tasks build on a stable foundation.
   *
   * TOKEN GROUPS
   *   Colour    --brand / --surface / --border / --text / --muted + status hues
   *   Spacing   --space-1 (4px) … --space-7 (40px) — a 4px-based scale
   *   Type      --text-xs … --text-2xl + --font-weight-* + --leading-*
   *   Radius    --radius-sm / -md / -lg + --radius-pill
   *   Elevation --shadow / --shadow-sm
   *
   * COMPONENT CLASSES (reusable primitives)
   *   .card .card-title .card-row .subsection      surfaces & grouping
   *   .stat-card                                   metric tiles
   *   .badge (+ -good/-bad/-info)                  status pills (icon + colour)
   *   .btn (+ -primary/-secondary/-danger)         actions
   *   .alert (+ -success/-error/-info)             transient flash messages
   *   .state-banner (+ -info/-success/-warning     persistent state primitive
   *     /-error)                                   (offline, suspended, …)
   *   .conn-pill (+ -connected/-stale/             header connection indicator
   *     -disconnected/-unknown)
   * =======================================================================*/
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    /* Colour */
    --brand: #184d31;
    --brand-light: #eef5f0;
    --brand-mid: #2d7a4f;
    --surface: #fff;
    --surface-alt: #f7faf8;
    --border: #dbe5df;
    --border-light: #edf2ee;
    --text: #142018;
    --muted: #5a6e5e;
    /* Status hues — used by badges, alerts and banners */
    --status-good-bg: #d8f0e3;     --status-good-fg: #155c31;  --status-good-border: #c0e8ce;
    --status-bad-bg: #fde7e5;      --status-bad-fg: #8b2d22;   --status-bad-border: #f7c9c4;
    --status-info-bg: #ddeeff;     --status-info-fg: #1a4e8a;  --status-info-border: #c0d0f0;
    --status-warn-bg: #fdf0d9;     --status-warn-fg: #8a5a12;  --status-warn-border: #f0d9a8;
    /* Spacing scale — 4px base. Use these for padding/margin/gap. */
    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 20px;
    --space-6: 24px;
    --space-7: 40px;
    /* Typography scale */
    --text-xs: 12px;
    --text-sm: 13px;
    --text-base: 14px;
    --text-md: 16px;
    --text-lg: 18px;
    --text-xl: 22px;
    --text-2xl: 26px;
    --font-weight-normal: 400;
    --font-weight-medium: 500;
    --font-weight-semibold: 600;
    --font-weight-bold: 700;
    --leading-tight: 1.2;
    --leading-normal: 1.5;
    --leading-relaxed: 1.6;
    /* Radius */
    --radius-sm: 8px;
    --radius-md: 14px;
    --radius-lg: 20px;
    --radius-pill: 999px;
    /* Elevation */
    --shadow: 0 1px 4px rgba(0,0,0,.06), 0 4px 16px rgba(0,0,0,.04);
    --shadow-sm: 0 1px 3px rgba(0,0,0,.08);
    /* Focus ring — see :focus-visible rule below */
    --focus-ring: #2d7a4f;
  }
  html { font-size: 15px; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f0f4f1; color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }

  /* Header */
  .site-header { background: var(--brand); padding: 0 24px; display: flex; align-items: center; gap: 16px; height: 58px; flex-shrink: 0; }
  .site-header-brand { display: flex; align-items: center; gap: 10px; text-decoration: none; }
  .site-header-brand img.dhruvanta-logo { height: 30px; width: auto; filter: brightness(0) invert(1); }
  .site-header-brand .brand-text { color: #fff; font-weight: 700; font-size: 15px; letter-spacing: .01em; }
  .site-header-brand .brand-sub { color: rgba(255,255,255,.55); font-size: 12px; margin-left: 2px; }
  .site-header-divider { width: 1px; height: 22px; background: rgba(255,255,255,.18); }
  .site-header-biz { display: flex; align-items: center; gap: 8px; }
  .site-header-biz img.biz-logo { height: 26px; width: auto; border-radius: 4px; }
  .site-header-biz .biz-name { color: rgba(255,255,255,.88); font-size: 13px; font-weight: 600; }
  .site-header-spacer { flex: 1; }

  /* Connection pill — persistent header indicator shown on every page.
   * Auto-refreshed by a client-side poll of /health. State is conveyed by
   * a dot shape + label text, not colour alone. See connectionPill() and
   * the polling script for behaviour. */
  .conn-pill {
    display: inline-flex; align-items: center; gap: var(--space-2);
    padding: 5px 12px 5px 10px; border-radius: var(--radius-pill);
    font-size: var(--text-xs); font-weight: var(--font-weight-semibold);
    background: rgba(255,255,255,.12); color: #fff; white-space: nowrap;
    cursor: default;
  }
  .conn-pill-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; background: currentColor; }
  .conn-pill-label { letter-spacing: .01em; }
  .conn-pill-sync { font-weight: var(--font-weight-normal); opacity: .8; font-size: 11px; }
  /* Variants — explicit background + a distinct dot treatment per state. */
  .conn-pill-connected { background: rgba(126,217,160,.22); color: #d6f5e2; }
  .conn-pill-stale { background: rgba(240,201,120,.26); color: #ffe6b0; }
  .conn-pill-stale .conn-pill-dot { box-shadow: 0 0 0 3px rgba(240,201,120,.3); }
  .conn-pill-disconnected { background: rgba(247,150,140,.26); color: #ffd4cd; }
  .conn-pill-disconnected .conn-pill-dot { border-radius: 2px; }
  .conn-pill-unregistered { background: rgba(255,255,255,.14); color: rgba(255,255,255,.85); }
  .conn-pill-unregistered .conn-pill-dot { background: transparent; border: 2px solid currentColor; }
  @media (max-width: 560px) { .conn-pill-sync { display: none; } }

  /* Legacy horizontal nav (kept for any embedded fragments not yet migrated). */
  .site-nav { background: var(--brand); border-top: 1px solid rgba(255,255,255,.08); padding: 0 24px; display: flex; gap: 0; flex-shrink: 0; }
  .site-nav a { color: rgba(255,255,255,.65); text-decoration: none; padding: 10px 16px; font-size: 13px; font-weight: 500; border-bottom: 2px solid transparent; transition: color .15s, border-color .15s; }
  .site-nav a:hover { color: rgba(255,255,255,.9); }
  .site-nav a.active { color: #fff; border-bottom-color: #7ed9a0; }

  /* KAN-415 Agent Phase 1 — left-nav app shell.
     - Two-column flex: fixed-width sidebar + flexible main column.
     - Sidebar contains brand + per-section grouped nav + footer.
     - Topbar holds the page title + connection pill.
     - Collapses to a stacked layout below 900px. */
  .app-shell { display: flex; min-height: 100vh; }
  .app-sidebar {
    width: 232px; background: var(--brand); color: #fff;
    display: flex; flex-direction: column; gap: var(--space-3);
    padding: 18px 14px 14px; flex-shrink: 0; position: sticky; top: 0;
    max-height: 100vh; overflow-y: auto;
  }
  .app-sidebar-brand {
    display: flex; align-items: center; gap: 10px; text-decoration: none;
    padding: 4px 6px 12px; border-bottom: 1px solid rgba(255,255,255,.10);
  }
  .app-sidebar-brand img.dhruvanta-logo { height: 28px; width: auto; filter: brightness(0) invert(1); }
  .app-sidebar-brand .brand-text { color: #fff; font-weight: 700; font-size: 15px; letter-spacing: .01em; display: block; }
  .app-sidebar-brand .brand-sub { color: rgba(255,255,255,.55); font-size: 11px; display: block; }
  .app-sidebar-nav { display: flex; flex-direction: column; gap: 12px; flex: 1; }
  .app-sidebar-group { display: flex; flex-direction: column; gap: 2px; }
  .app-sidebar-group-label {
    color: rgba(255,255,255,.5); text-transform: uppercase; letter-spacing: .08em;
    font-size: 11px; font-weight: 700; padding: 4px 10px 6px;
  }
  .app-sidebar-link {
    color: rgba(255,255,255,.78); text-decoration: none;
    padding: 8px 12px; border-radius: 8px; font-size: 14px; font-weight: 500;
    transition: background .15s, color .15s;
  }
  .app-sidebar-link:hover { background: rgba(255,255,255,.08); color: #fff; }
  .app-sidebar-link.is-active {
    background: rgba(126,217,160,.18); color: #fff;
    box-shadow: inset 3px 0 0 #7ed9a0;
  }
  .app-sidebar-footer {
    display: flex; flex-direction: column; gap: 2px;
    color: rgba(255,255,255,.45); font-size: 11px;
    padding: 10px 10px 0; border-top: 1px solid rgba(255,255,255,.08);
  }
  .app-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .app-topbar {
    background: #fff; border-bottom: 1px solid var(--border);
    padding: 12px 24px; display: flex; align-items: center; gap: 16px;
    height: 58px; flex-shrink: 0;
  }
  .app-topbar-title { font-size: 16px; font-weight: 700; color: var(--text); }
  .app-topbar-spacer { flex: 1; }
  .app-topbar .conn-pill { background: rgba(45,122,79,.12); color: var(--brand); }
  .app-topbar .conn-pill-connected { background: rgba(46,162,89,.16); color: #1e5f37; }
  .app-topbar .conn-pill-stale { background: rgba(200,140,40,.16); color: #7a5316; }
  .app-topbar .conn-pill-disconnected { background: rgba(200,60,50,.14); color: #862d22; }
  .app-topbar .conn-pill-unregistered { background: rgba(0,0,0,.06); color: var(--text); }
  @media (max-width: 900px) {
    .app-shell { flex-direction: column; }
    .app-sidebar { width: auto; position: static; max-height: none;
      flex-direction: row; flex-wrap: wrap; padding: 12px; gap: 8px; }
    .app-sidebar-brand { border-bottom: 0; padding: 0 6px; }
    .app-sidebar-nav { flex-direction: row; flex-wrap: wrap; gap: 6px; width: 100%; }
    .app-sidebar-group { flex-direction: row; flex-wrap: wrap; gap: 4px; }
    .app-sidebar-group-label { padding: 0; align-self: center; }
    .app-sidebar-footer { display: none; }
  }

  /* Layout */
  .page-content { flex: 1; padding: var(--space-6); max-width: 1100px; width: 100%; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-5); }
  .page-title { font-size: var(--text-xl); font-weight: var(--font-weight-bold); margin-bottom: var(--space-1); }
  .page-eyebrow { font-size: var(--text-xs); font-weight: var(--font-weight-semibold); letter-spacing: .08em; text-transform: uppercase; color: var(--brand-mid); margin-bottom: var(--space-2); }

  /* Cards */
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-5); box-shadow: var(--shadow); }
  .card-title { font-size: var(--text-md); font-weight: var(--font-weight-bold); margin-bottom: var(--space-3); }
  .card-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-3); }
  .card-row:last-child { margin-bottom: 0; }
  /* Inline "View all …" affordance linking a preview card to its full page. */
  .card-link { font-size: var(--text-sm); font-weight: var(--font-weight-semibold); color: var(--brand); text-decoration: none; white-space: nowrap; flex-shrink: 0; }
  .card-link:hover { text-decoration: underline; }
  .subsection { border-top: 1px solid var(--border-light); padding-top: var(--space-4); margin-top: var(--space-4); }
  .subsection-title { font-size: var(--text-sm); font-weight: var(--font-weight-bold); text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: var(--space-3); }

  /* Stats */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--space-3); }
  .stat-card { background: var(--surface-alt); border: 1px solid var(--border-light); border-radius: var(--radius-sm); padding: var(--space-3) var(--space-4); }
  .stat-label { font-size: var(--text-xs); color: var(--muted); font-weight: var(--font-weight-medium); text-transform: uppercase; letter-spacing: .05em; margin-bottom: var(--space-2); }
  .stat-value { font-size: var(--text-2xl); font-weight: var(--font-weight-bold); color: var(--brand); line-height: var(--leading-tight); }

  /* Visually-hidden — present for screen readers, removed from the visual flow. */
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }

  /* Badges — status pills. State is conveyed by BOTH a leading shape/icon
   * glyph and colour, so the meaning survives for colour-blind operators
   * and on monochrome displays (accessibility P1-4). */
  .badge { display: inline-flex; align-items: center; gap: 5px; border-radius: var(--radius-pill); background: var(--border); color: var(--muted); padding: 3px 10px; font-size: var(--text-xs); font-weight: var(--font-weight-semibold); vertical-align: middle; }
  .badge::before { font-size: 11px; line-height: 1; }
  .badge-good { background: var(--status-good-bg); color: var(--status-good-fg); }
  .badge-good::before { content: '\\2714'; }   /* heavy check mark */
  .badge-bad { background: var(--status-bad-bg); color: var(--status-bad-fg); }
  .badge-bad::before { content: '\\2715'; }    /* multiplication x */
  .badge-info { background: var(--status-info-bg); color: var(--status-info-fg); }
  .badge-info::before { content: '\\25CF'; }   /* filled circle */
  .badge-warn { background: var(--status-warn-bg); color: var(--status-warn-fg); }
  .badge-warn::before { content: '\\26A0'; }   /* warning sign */

  /* Forms */
  form.stack { display: grid; gap: var(--space-3); }
  label { display: block; }
  .label-text { font-size: var(--text-xs); font-weight: var(--font-weight-semibold); color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-bottom: var(--space-1); }
  input[type=text], input[type=url], input[type=email], input[type=number], input[type=date], select, textarea {
    padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); border: 1px solid var(--border); width: 100%; font-size: var(--text-base); color: var(--text); background: #fff; transition: border-color .15s;
  }
  input:focus, select:focus, textarea:focus { border-color: var(--brand-mid); }
  .hint { font-size: var(--text-xs); color: var(--muted); margin-top: var(--space-1); }

  /* Logo upload (KAN-40 P1-6) — preview tile + upload form side by side. */
  .logo-row { display: flex; gap: var(--space-5); flex-wrap: wrap; align-items: flex-start; }
  .logo-upload-form { flex: 1; min-width: 240px; }
  .logo-preview {
    width: 132px; flex-shrink: 0; border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: var(--space-3); background: var(--surface-alt);
    display: flex; flex-direction: column; align-items: center; gap: var(--space-2);
  }
  .logo-preview img { max-width: 100%; max-height: 90px; width: auto; height: auto; }
  .logo-preview-broken { display: none; text-align: center; color: var(--status-bad-fg); }
  .logo-preview.is-broken img { display: none; }
  .logo-preview.is-broken .logo-preview-broken { display: block; }
  input[type=file] { font-size: var(--text-sm); width: 100%; }

  /* Field-level validation error — shown directly beneath the offending
   * input when a sticky form re-renders after a failed submit (KAN-40 P1-5).
   * A leading ⚠ glyph carries meaning alongside the colour. */
  .field-error {
    font-size: var(--text-xs); font-weight: var(--font-weight-semibold);
    color: var(--status-bad-fg); margin-top: var(--space-1);
  }
  .field-error::before { content: '\\26A0  '; }
  label.has-error input, label.has-error select, label.has-error textarea,
  .has-error input, .has-error select { border-color: var(--status-bad-fg); }

  /* Rupee-prefixed money input — a ₹ adornment sits inside the field border
   * so a shop owner enters a plain rupee amount (e.g. 15.50) and never sees
   * paise. The amount is converted to paise on submit. See parseRupeesToPaise. */
  .money-input { position: relative; }
  .money-input::before {
    content: '\\20B9'; position: absolute; left: var(--space-3); top: 50%;
    transform: translateY(-50%); color: var(--muted); font-size: var(--text-base);
    pointer-events: none;
  }
  .money-input input[type=number] { padding-left: 26px; }

  /* Accessible focus ring — applies to every interactive element that
   * receives keyboard focus. Mouse clicks do not trigger :focus-visible. */
  a:focus-visible, button:focus-visible, .btn:focus-visible,
  input:focus-visible, select:focus-visible, textarea:focus-visible,
  summary:focus-visible, [tabindex]:focus-visible {
    outline: 3px solid var(--focus-ring);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }

  /* Buttons */
  .btn { display: inline-block; padding: var(--space-2) var(--space-5); border: 0; border-radius: var(--radius-pill); font-size: var(--text-base); font-weight: var(--font-weight-semibold); cursor: pointer; text-decoration: none; transition: opacity .15s; }
  .btn-primary { background: var(--brand); color: #fff; }
  .btn-secondary { background: var(--brand-light); color: var(--brand); }
  .btn-danger { background: #fde7e5; color: #8b2d22; }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .btn-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }

  /* Grid helpers */
  .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .span-2 { grid-column: span 2; }
  .span-3 { grid-column: 1 / -1; }
  @media (max-width: 640px) {
    .grid-2, .grid-3 { grid-template-columns: 1fr; }
    .span-2, .span-3 { grid-column: 1; }
  }

  /* Choices (checkboxes) */
  .choices { display: grid; gap: 8px; }
  .choice { display: flex; gap: 8px; align-items: center; cursor: pointer; }
  .choice input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--brand); flex-shrink: 0; }

  /* Alerts — transient flash messages (driven by ?notice / ?error query
   * params). For persistent state messaging use .state-banner instead. */
  .alert { padding: var(--space-3) var(--space-4); border-radius: var(--radius-sm); font-size: var(--text-base); }
  .alert-success { background: var(--status-good-bg); color: var(--status-good-fg); border: 1px solid var(--status-good-border); }
  .alert-error { background: var(--status-bad-bg); color: var(--status-bad-fg); border: 1px solid var(--status-bad-border); }
  .alert-info { background: var(--status-info-bg); color: var(--status-info-fg); border: 1px solid var(--status-info-border); }

  /* State banner — reusable persistent state primitive. Unlike .alert it is
   * rendered conditionally to communicate a standing condition (offline,
   * pending approval, suspended, revoked, …). Variants: info/success/
   * warning/error. A leading icon glyph carries meaning alongside colour.
   * Usage: stateBanner({ variant, title, body? }) — see helper below. */
  .state-banner { display: flex; gap: var(--space-3); align-items: flex-start; padding: var(--space-3) var(--space-4); border-radius: var(--radius-sm); border: 1px solid var(--border); font-size: var(--text-base); }
  .state-banner-icon { font-size: var(--text-md); line-height: var(--leading-tight); flex-shrink: 0; }
  .state-banner-body { display: flex; flex-direction: column; gap: 2px; }
  .state-banner-title { font-weight: var(--font-weight-bold); }
  .state-banner-text { font-size: var(--text-sm); line-height: var(--leading-normal); }
  .state-banner-info { background: var(--status-info-bg); color: var(--status-info-fg); border-color: var(--status-info-border); }
  .state-banner-success { background: var(--status-good-bg); color: var(--status-good-fg); border-color: var(--status-good-border); }
  .state-banner-warning { background: var(--status-warn-bg); color: var(--status-warn-fg); border-color: var(--status-warn-border); }
  .state-banner-error { background: var(--status-bad-bg); color: var(--status-bad-fg); border-color: var(--status-bad-border); }

  /* Tables */
  .data-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .data-table th { text-align: left; padding: 10px 12px; color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; border-bottom: 2px solid var(--border-light); }
  .data-table td { padding: 12px; border-bottom: 1px solid var(--border-light); vertical-align: top; }
  .data-table tr:last-child td { border-bottom: 0; }
  .data-table tr:hover td { background: var(--surface-alt); }
  .mono { font-family: ui-monospace, monospace; letter-spacing: .06em; }
  .muted { color: var(--muted); font-size: 13px; }
  .small { font-size: 12px; }

  /* Details / Accordion — the native disclosure triangle is kept (display:
   * list-item) so assistive tech announces the expanded/collapsed state.
   * A second chevron on the right is a purely decorative affordance. */
  details { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-3); }
  details + details { margin-top: var(--space-2); }
  summary { cursor: pointer; font-weight: var(--font-weight-semibold); display: list-item; list-style-position: outside; margin-left: 1.1em; }
  summary::-webkit-details-marker { color: var(--muted); }
  summary .summary-row { display: flex; align-items: center; justify-content: space-between; }
  summary .summary-row::after { content: '\\25BE'; font-size: var(--text-xs); color: var(--muted); }
  details[open] summary .summary-row::after { content: '\\25B4'; }
  details > *:not(summary) { margin-top: var(--space-3); }

  /* Pickup code */
  .pickup-code { font-family: ui-monospace, monospace; font-size: 18px; letter-spacing: .12em; font-weight: 700; }

  /* Inline form */
  .inline-form { display: inline-flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }

  /* FAQ */
  .faq-section { margin-bottom: 6px; }
  .faq-q { font-weight: 600; margin-bottom: 6px; }
  .faq-a { color: var(--muted); line-height: 1.6; }
  .faq-a p + p { margin-top: 8px; }

  /* =========================================================================
   * First-run pairing experience (KAN-37)
   * -----------------------------------------------------------------------*/
  /* Step list — the guided "what happens next" sequence. */
  .steps { display: grid; gap: var(--space-3); counter-reset: step; }
  .step { display: flex; gap: var(--space-4); align-items: flex-start; }
  .step-num {
    flex-shrink: 0; width: 30px; height: 30px; border-radius: 50%;
    background: var(--brand); color: #fff; font-weight: var(--font-weight-bold);
    font-size: var(--text-base); display: flex; align-items: center; justify-content: center;
  }
  .step.is-done .step-num { background: var(--status-good-fg); }
  .step.is-pending .step-num { background: var(--border); color: var(--muted); }
  .step-body { padding-top: 3px; }
  .step-title { font-weight: var(--font-weight-semibold); font-size: var(--text-md); }
  .step-text { color: var(--muted); font-size: var(--text-sm); line-height: var(--leading-normal); margin-top: 2px; }

  /* Hero pairing code — the single most important element on the screen. */
  .pairing-hero {
    background: var(--brand-light); border: 1px solid var(--status-good-border);
    border-radius: var(--radius-md); padding: var(--space-6);
    display: flex; gap: var(--space-6); align-items: center; flex-wrap: wrap;
  }
  .pairing-hero-main { flex: 1; min-width: 240px; }
  .pairing-hero-label { font-size: var(--text-xs); font-weight: var(--font-weight-semibold); letter-spacing: .08em; text-transform: uppercase; color: var(--brand-mid); }
  .pairing-code-big {
    font-family: ui-monospace, monospace; font-size: 40px; font-weight: var(--font-weight-bold);
    letter-spacing: .14em; color: var(--brand); line-height: var(--leading-tight);
    margin: var(--space-2) 0; word-break: break-all;
  }
  .pairing-code-empty { font-size: var(--text-md); color: var(--muted); font-weight: var(--font-weight-medium); margin: var(--space-3) 0; }
  .pairing-expiry { font-size: var(--text-sm); color: var(--muted); }
  .pairing-expiry.is-expired { color: var(--status-bad-fg); font-weight: var(--font-weight-semibold); }
  .pairing-qr-wrap { display: flex; flex-direction: column; align-items: center; gap: var(--space-2); }
  .pairing-qr { border-radius: var(--radius-sm); background: #fff; border: 1px solid var(--border); padding: var(--space-2); }
  .pairing-qr-cap { font-size: var(--text-xs); color: var(--muted); }
  .copy-btn { display: inline-flex; align-items: center; gap: 6px; }
  .copy-btn .copy-ok { display: none; }
  .copy-btn.is-copied .copy-ok { display: inline; }
  .copy-btn.is-copied .copy-idle { display: none; }

  /* Trust panel — first-run legitimacy cues. */
  .trust-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-4); }
  .trust-item { display: flex; gap: var(--space-3); align-items: flex-start; }
  .trust-icon { font-size: var(--text-xl); line-height: 1; flex-shrink: 0; }
  .trust-title { font-weight: var(--font-weight-semibold); font-size: var(--text-base); }
  .trust-text { color: var(--muted); font-size: var(--text-sm); line-height: var(--leading-normal); margin-top: 2px; }

  /* Location-permission explainer (P1-1). */
  .loc-explainer { background: var(--surface-alt); border: 1px solid var(--border-light); border-radius: var(--radius-sm); padding: var(--space-4); }
  @media (max-width: 560px) { .pairing-code-big { font-size: 30px; } }

  /* Empty state — a friendly placeholder shown in a table when it has no
   * rows, or as a standalone block. Centred, with optional inline action.
   * See tableEmptyState() / emptyState(). */
  .empty-state { text-align: center; padding: var(--space-6) var(--space-4); color: var(--muted); }
  .empty-state-icon { font-size: 28px; line-height: 1; margin-bottom: var(--space-2); }
  .empty-state-title { font-weight: var(--font-weight-semibold); color: var(--text); font-size: var(--text-base); }
  .empty-state-text { font-size: var(--text-sm); line-height: var(--leading-normal); margin-top: 4px; }
  .empty-state-action { margin-top: var(--space-3); display: flex; justify-content: center; }

  /* Footer */
  .site-footer { background: var(--brand); color: rgba(255,255,255,.5); font-size: 12px; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-shrink: 0; }
  .site-footer a { color: rgba(255,255,255,.65); text-decoration: none; }
  .site-footer a:hover { color: #fff; }

  /* =========================================================================
   * KAN-295: Console UI overhaul — agent health header, dirty-aware forms,
   * inline save toast, secure-cover colour picker (HEX + RGB sliders +
   * native picker + recommended swatch chips), and the "field group" card
   * layout used to re-flow settings sections.
   * =======================================================================*/

  /* Agent health header — a one-glance summary of the agent's current state.
   * Replaces the wall-of-text "Last heartbeat / Last error / Last job" panel.
   * The variant is computed server-side (see agentHealthBanner()) and the
   * three at-a-glance facts (heartbeat / error / last job) are surfaced as
   * stat tiles inside the same card so they remain inspectable on demand. */
  .agent-health {
    display: grid; gap: var(--space-4);
    border: 1px solid var(--border); border-radius: var(--radius-md);
    padding: var(--space-4) var(--space-5); background: var(--surface);
    box-shadow: var(--shadow);
  }
  .agent-health-row { display: flex; gap: var(--space-3); align-items: flex-start; }
  .agent-health-icon {
    flex-shrink: 0; width: 36px; height: 36px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; font-weight: var(--font-weight-bold);
  }
  .agent-health-body { flex: 1; min-width: 0; }
  .agent-health-title { font-size: var(--text-md); font-weight: var(--font-weight-bold); line-height: var(--leading-tight); }
  .agent-health-text { font-size: var(--text-sm); color: var(--muted); margin-top: 2px; line-height: var(--leading-normal); }
  .agent-health.is-good { border-left: 4px solid var(--status-good-fg); }
  .agent-health.is-good .agent-health-icon { background: var(--status-good-bg); color: var(--status-good-fg); }
  .agent-health.is-warning { border-left: 4px solid var(--status-warn-fg); }
  .agent-health.is-warning .agent-health-icon { background: var(--status-warn-bg); color: var(--status-warn-fg); }
  .agent-health.is-error { border-left: 4px solid var(--status-bad-fg); }
  .agent-health.is-error .agent-health-icon { background: var(--status-bad-bg); color: var(--status-bad-fg); }
  .agent-health.is-info { border-left: 4px solid var(--status-info-fg); }
  .agent-health.is-info .agent-health-icon { background: var(--status-info-bg); color: var(--status-info-fg); }
  .agent-health-facts {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: var(--space-3);
  }
  .agent-health-fact {
    background: var(--surface-alt); border: 1px solid var(--border-light);
    border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3);
  }
  .agent-health-fact-label {
    font-size: var(--text-xs); color: var(--muted);
    font-weight: var(--font-weight-medium); text-transform: uppercase;
    letter-spacing: .05em; margin-bottom: 2px;
  }
  .agent-health-fact-value { font-size: var(--text-sm); color: var(--text); word-break: break-word; }

  /* Field group — the card-internal grouping primitive used to re-flow each
   * settings card into labelled sections instead of a wall of inputs. */
  .field-group { display: grid; gap: var(--space-3); }
  .field-group + .field-group { margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--border-light); }
  .field-group-title { font-size: var(--text-sm); font-weight: var(--font-weight-bold); text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .field-group-help { font-size: var(--text-sm); color: var(--muted); line-height: var(--leading-normal); margin-top: -4px; }

  /* Recommendation chips — a row of one-click presets shown beneath a
   * free-form input to make the common values discoverable. Generic enough
   * for the secure-cover colour, label-text presets, etc. */
  .chip-row { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-2); }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px var(--space-3); border-radius: var(--radius-pill);
    border: 1px solid var(--border); background: var(--surface);
    font-size: var(--text-sm); color: var(--text); cursor: pointer;
    transition: background .15s, border-color .15s, box-shadow .15s;
  }
  .chip:hover, .chip:focus-visible { background: var(--brand-light); border-color: var(--brand-mid); }
  .chip:active { transform: translateY(1px); }
  .chip-swatch {
    width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0;
    border: 1px solid rgba(0,0,0,.18); box-shadow: inset 0 0 0 1px rgba(255,255,255,.4);
  }

  /* Secure-cover colour picker — HEX field, native picker, and three RGB
   * sliders sit side-by-side with a live preview tile. */
  .color-picker { display: grid; gap: var(--space-3); }
  .color-picker-row {
    display: grid; grid-template-columns: 56px 1fr auto; gap: var(--space-3);
    align-items: center;
  }
  .color-preview {
    width: 56px; height: 56px; border-radius: var(--radius-sm);
    border: 1px solid var(--border); box-shadow: inset 0 0 0 1px rgba(255,255,255,.4);
    background: #fff;
  }
  input[type=color].color-picker-native {
    width: 56px; height: 36px; padding: 0; border: 1px solid var(--border);
    border-radius: var(--radius-sm); background: var(--surface); cursor: pointer;
  }
  .color-sliders { display: grid; gap: var(--space-2); }
  .color-slider-row {
    display: grid; grid-template-columns: 24px 1fr 56px; gap: var(--space-2);
    align-items: center;
  }
  .color-slider-label { font-size: var(--text-xs); font-weight: var(--font-weight-bold); color: var(--muted); }
  .color-slider-value {
    text-align: right; font-family: ui-monospace, monospace;
    font-size: var(--text-sm); color: var(--text);
  }
  input[type=range].color-slider {
    width: 100%; height: 6px; -webkit-appearance: none; appearance: none;
    background: linear-gradient(to right, var(--border), var(--brand-mid));
    border-radius: var(--radius-pill); outline: none;
  }
  input[type=range].color-slider::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none; width: 16px; height: 16px;
    border-radius: 50%; background: var(--brand); cursor: pointer;
    border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.2);
  }
  input[type=range].color-slider::-moz-range-thumb {
    width: 16px; height: 16px; border-radius: 50%; background: var(--brand);
    cursor: pointer; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.2);
  }

  /* Inline save toast — auto-dismisses after a few seconds and can be
   * closed by hand. Builds on the existing .alert flash so server-side
   * ?notice= redirects keep working unchanged. */
  .alert {
    position: relative; display: flex; align-items: center; gap: var(--space-2);
    transition: opacity .4s ease, transform .4s ease;
  }
  .alert.is-dismissing { opacity: 0; transform: translateY(-4px); }
  .alert-close {
    margin-left: auto; background: transparent; border: 0; color: inherit;
    font-size: var(--text-md); line-height: 1; cursor: pointer; padding: 4px 6px;
    border-radius: var(--radius-sm); opacity: .7;
  }
  .alert-close:hover { opacity: 1; }

  /* Dirty-aware save buttons — start visually disabled, become primary
   * once the form is dirty. The disabled state is managed by JS via a
   * data-dirty attribute on the form, with a CSS hook for the visual. */
  form.js-dirty-aware:not([data-dirty='true']) button[type=submit][data-dirty-required] {
    opacity: .55; pointer-events: none;
  }
`

// ---------------------------------------------------------------------------
// Connection pill + state banner (shell components)
// ---------------------------------------------------------------------------

/**
 * Render the persistent header connection indicator. Server-renders the
 * current state so the pill is correct on first paint; the client-side
 * poll in SHARED_SCRIPTS then keeps it live. The data-* attributes and
 * element IDs are the contract the polling script updates against.
 */
export function connectionPill(status: ConnectionStatus) {
  const syncText =
    status.state === 'unregistered'
      ? 'Pair this machine to connect'
      : status.ageSeconds == null
        ? status.detail
        : status.detail
  return `<span id="conn-pill" class="conn-pill conn-pill-${status.state}"
    role="status" aria-live="polite" title="${htmlEscape(status.detail)}"
    data-state="${status.state}">
    <span class="conn-pill-dot" aria-hidden="true"></span>
    <span class="conn-pill-label" id="conn-pill-label">${htmlEscape(status.label)}</span>
    <span class="conn-pill-sync" id="conn-pill-sync">${htmlEscape(syncText)}</span>
  </span>`
}

/**
 * Reusable persistent state-banner primitive. Unlike the transient
 * `.alert` flash messages, this communicates a standing condition and is
 * rendered conditionally by pages (offline, pending approval, suspended,
 * revoked, …). Later KAN-3x tasks reuse this — keep the variant set stable.
 */
export function stateBanner(opts: {
  variant: 'info' | 'success' | 'warning' | 'error'
  title: string
  body?: string | null
}) {
  const icons: Record<typeof opts.variant, string> = {
    info: 'ℹ',
    success: '✔',
    warning: '⚠',
    error: '✕',
  }
  const role = opts.variant === 'error' ? 'alert' : 'status'
  const live = opts.variant === 'error' ? 'assertive' : 'polite'
  return `<div class="state-banner state-banner-${opts.variant}" role="${role}" aria-live="${live}">
    <span class="state-banner-icon" aria-hidden="true">${icons[opts.variant]}</span>
    <span class="state-banner-body">
      <span class="state-banner-title">${htmlEscape(opts.title)}</span>
      ${opts.body ? `<span class="state-banner-text">${htmlEscape(opts.body)}</span>` : ''}
    </span>
  </div>`
}

/**
 * Reusable friendly empty-state block (KAN-38 scope #3). Shown when a list or
 * table has no rows yet, so the owner sees reassuring guidance instead of a
 * blank void. An optional `action` HTML fragment (typically an inline form
 * with a Refresh button) is rendered below the copy.
 */
export function emptyState(opts: {
  icon?: string
  title: string
  text: string
  action?: string
}) {
  return `<div class="empty-state">
    <div class="empty-state-icon" aria-hidden="true">${opts.icon ?? '🖨'}</div>
    <div class="empty-state-title">${htmlEscape(opts.title)}</div>
    <div class="empty-state-text">${htmlEscape(opts.text)}</div>
    ${opts.action ? `<div class="empty-state-action">${opts.action}</div>` : ''}
  </div>`
}

/**
 * Wrap `emptyState` in a single full-width table row so it can be dropped
 * into a `<tbody>` that would otherwise render as a headerless void. Mirrors
 * the colspan empty-row pattern the pickup / recent-jobs tables already use,
 * but with the richer empty-state block and an optional inline action.
 */
export function tableEmptyState(opts: {
  colspan: number
  icon?: string
  title: string
  text: string
  action?: string
}) {
  return `<tr><td colspan="${opts.colspan}">${emptyState({
    icon: opts.icon,
    title: opts.title,
    text: opts.text,
    action: opts.action,
  })}</td></tr>`
}

// ---------------------------------------------------------------------------
// Job monitoring & pickup workflow (KAN-39 — UX review KAN-29 theme 5)
// ---------------------------------------------------------------------------

/** How many jobs the dashboard recent-activity preview shows at most. */
export const RECENT_JOBS_PREVIEW_LIMIT = 5

/**
 * Pure slicing helper for the dashboard recent-activity preview (KAN-39 P2-1).
 *
 * The dashboard "Recent jobs" card used to render the full local job cache,
 * duplicating the authoritative `/orders` page. It now shows only the latest
 * few items. `recentJobs` is already stored newest-first by the runtime
 * (`pushRecentJob` prepends), so this just takes the leading slice while
 * preserving order. Exported so the slicing rule can be unit-tested without
 * an HTTP round-trip.
 */
export function selectRecentJobsPreview(
  jobs: RecentJobSnapshot[] | null | undefined,
  limit: number = RECENT_JOBS_PREVIEW_LIMIT,
): RecentJobSnapshot[] {
  if (!Array.isArray(jobs) || jobs.length === 0) return []
  if (limit <= 0) return []
  return jobs.slice(0, limit)
}

export type PickupSearchStatus = 'idle' | 'match' | 'no-match'

export interface PickupSearchResult {
  /** Normalised (uppercased, trimmed) query the owner typed, '' when idle. */
  query: string
  /** idle = no search yet, match = ≥1 job found, no-match = searched, none. */
  status: PickupSearchStatus
  /** The pickup jobs that matched the query (all jobs when idle). */
  matches: PickupJobSnapshot[]
}

/**
 * Pure pickup-code verification helper (KAN-39 scope #2).
 *
 * Given the ready-for-pickup jobs and the owner's typed code, classify the
 * outcome so the page can show an explicit, plain-language success / not-found
 * banner instead of a silently-filtered table. A blank query is `idle` and
 * returns every pending pickup. A non-blank query matches by case-insensitive
 * substring against the pickup code. Exported for unit testing.
 */
export function classifyPickupSearch(
  jobs: PickupJobSnapshot[] | null | undefined,
  rawQuery: string | null | undefined,
): PickupSearchResult {
  const all = Array.isArray(jobs) ? jobs : []
  const query = (rawQuery ?? '').trim().toUpperCase()
  if (query === '') {
    return { query: '', status: 'idle', matches: all }
  }
  const matches = all.filter((job) => job.pickupCode.toUpperCase().includes(query))
  return { query, status: matches.length > 0 ? 'match' : 'no-match', matches }
}

// ---------------------------------------------------------------------------
// First-run pairing screen components (KAN-37)
// ---------------------------------------------------------------------------

/**
 * The hero pairing-code block: the large, legible code the owner reads out
 * (or scans) to their platform admin, a Copy-to-clipboard button, an inline
 * QR code, plain-language sharing copy, and a human-friendly expiry that uses
 * `formatTimestamp` rather than a raw ISO string (KAN-37 P0-2).
 *
 * Exported so the rendering can be unit-tested without an HTTP round-trip.
 */
export function renderPairingHero(opts: {
  pairingCode: string | null
  pairingCodeExpiresAt: string | null
  now?: number
}) {
  const code = opts.pairingCode
  const expired = isPairingCodeExpired(opts.pairingCodeExpiresAt, opts.now ?? Date.now())

  if (!code) {
    return `<div class="pairing-hero">
      <div class="pairing-hero-main">
        <div class="pairing-hero-label">Your pairing code</div>
        <div class="pairing-code-empty">We're generating your pairing code…</div>
        <div class="pairing-expiry">This usually takes a moment. If it does not appear, use
          "Generate a pairing code" below.</div>
      </div>
    </div>`
  }

  const expiryLine = expired
    ? `<div class="pairing-expiry is-expired">This code has expired — generate a new one below before pairing.</div>`
    : opts.pairingCodeExpiresAt
      ? `<div class="pairing-expiry">Valid until ${htmlEscape(formatTimestamp(opts.pairingCodeExpiresAt))}. Generate a fresh one any time.</div>`
      : `<div class="pairing-expiry">Generate a fresh code any time from the button below.</div>`

  return `<div class="pairing-hero">
    <div class="pairing-hero-main">
      <div class="pairing-hero-label">Your pairing code</div>
      <div class="pairing-code-big" id="pairing-code" data-code="${htmlEscape(code)}">${htmlEscape(code)}</div>
      ${expiryLine}
      <p class="muted small" style="margin-top:10px; line-height:1.6;">
        Share this code with your PrintAnywhere platform admin. They enter it in their
        portal to connect this PC to your shop. You do not need to do anything else here —
        this page will update on its own once pairing is complete.
      </p>
      <div class="btn-row" style="margin-top:12px;">
        <button type="button" class="btn btn-primary copy-btn" id="pairing-copy-btn"
          data-copy-target="pairing-code">
          <span class="copy-idle">Copy code</span>
          <span class="copy-ok" aria-hidden="true">✔ Copied</span>
        </button>
      </div>
    </div>
    <div class="pairing-qr-wrap">
      ${renderQrSvg(code, { size: 168, label: `Pairing code ${code}` })}
      <span class="pairing-qr-cap">Or scan this with a phone</span>
    </div>
  </div>`
}

/**
 * The trust panel shown near the pairing code on the first-run screen —
 * first-run legitimacy / reassurance cues for a non-technical owner
 * (KAN-37 P1-7): the console is local-only, print jobs are encrypted, and
 * the publisher is named.
 */
export function renderTrustPanel() {
  const items: Array<{ icon: string; title: string; text: string }> = [
    {
      icon: '🔒',
      title: 'This console is local-only',
      text: 'This page runs only on this computer. It is not on the public internet — no one outside this PC can open it.',
    },
    {
      icon: '🛡️',
      title: 'Print jobs are encrypted',
      text: 'Customer documents are encrypted in transit and only decrypted on this machine, right before they print.',
    },
    {
      icon: '🏢',
      title: 'Published by Dhruvanta Systems',
      text: 'PrintAnywhere is built and supported by Dhruvanta Systems. Questions? Contact support@printanywhere.in.',
    },
  ]
  return `<div class="card">
    <div class="card-title">Why this is safe</div>
    <div class="trust-grid">
      ${items
        .map(
          (item) => `<div class="trust-item">
        <span class="trust-icon" aria-hidden="true">${item.icon}</span>
        <span>
          <span class="trust-title">${htmlEscape(item.title)}</span>
          <span class="trust-text">${htmlEscape(item.text)}</span>
        </span>
      </div>`,
        )
        .join('')}
    </div>
  </div>`
}

/**
 * The focused config form shown in the `config` first-run stage. Deliberately
 * minimal — only the fields a brand-new owner needs before pairing. The
 * production server URL is prefilled and tucked into an optional disclosure
 * so a non-technical owner is not confronted with it.
 *
 * P1-1: location is never requested silently. There is an explicit
 * "Share device location" button with plain-language copy, and a separate
 * plain "Save and continue" submit that proceeds without location.
 */
function renderFirstRunConfigForm(
  snapshot: ReturnType<AgentRuntime['snapshot']>,
  configuredServerUrl: string,
) {
  const profile = snapshot.profile
  return `<div class="card">
    <div class="card-title">Tell us about your shop</div>
    <p class="muted small" style="margin-bottom:14px; line-height:1.6;">
      Just two quick details. You can change any of this later from the dashboard.
    </p>
    <form method="post" action="/configure" class="stack" id="configure-form">
      ${hiddenUiToken(snapshot.uiToken)}
      <input type="hidden" name="latitude" id="configure-location-latitude" />
      <input type="hidden" name="longitude" id="configure-location-longitude" />
      <input type="hidden" name="accuracyMeters" id="configure-location-accuracy" />
      <input type="hidden" name="capturedAt" id="configure-location-captured-at" />
      <label>
        <div class="label-text">A name for this PC</div>
        <input type="text" name="displayName" value="${htmlEscape(snapshot.displayName ?? '')}" placeholder="Counter PC - Front Desk" />
        <div class="hint">So you can recognise this machine in the admin portal. Optional.</div>
      </label>
      <label>
        <div class="label-text">Your shop address</div>
        <input type="text" name="reportedBusinessAddress" value="${htmlEscape(snapshot.reportedBusinessAddress ?? profile?.reportedBusinessAddress ?? '')}" placeholder="Shop number, street, city, state" />
        <div class="hint">The platform admin reviews this when approving your shop.</div>
      </label>

      <div class="loc-explainer">
        <div class="step-title" style="font-size:var(--text-base);">Share your shop's location (optional)</div>
        <p class="muted small" style="margin-top:4px; line-height:1.6;">
          PrintAnywhere uses your location to show your shop on the customer map, so nearby
          customers can find you. Your browser will ask for permission — nothing is shared
          until you click the button below. You can always skip this and add it later.
        </p>
        <div class="btn-row" style="margin-top:10px;">
          <button class="btn btn-secondary" type="button" id="firstrun-location-button">Share device location</button>
          <span class="muted small" id="firstrun-location-status"></span>
        </div>
      </div>

      <details style="margin-top:4px;">
        <summary><span class="summary-row"><span>Advanced: PrintAnywhere server</span></span></summary>
        <label style="margin-top:10px;">
          <div class="label-text">PrintAnywhere server URL</div>
          <input type="url" name="serverUrl" value="${htmlEscape(configuredServerUrl)}" placeholder="${htmlEscape(defaultPrintAnywhereBackendUrl())}" required />
          <div class="hint">The production server is already filled in. Change this only if support asks you to.</div>
        </label>
      </details>

      <div class="btn-row" style="margin-top:6px;">
        <button class="btn btn-primary" type="submit">Save and continue</button>
        <span class="muted small">This connects this PC and creates your pairing code.</span>
      </div>
    </form>
  </div>`
}

/**
 * A standalone, sticky-aware "shop details" form (server URL, display name,
 * business address) used by the focused configure error page (KAN-40 P1-5).
 * Unlike the first-run / dashboard inline configure forms it has no location
 * capture — that is an explicit optional action elsewhere.
 */
function renderConfigureForm(
  snapshot: ReturnType<AgentRuntime['snapshot']>,
  configuredServerUrl: string,
  sticky?: StickyForm,
) {
  const errClass = (name: string) => (sticky?.fieldErrors?.[name] ? ' has-error' : '')
  return `
    <div class="card-title">Your shop details</div>
    <form method="post" action="/configure" class="stack">
      ${hiddenUiToken(snapshot.uiToken)}
      <label class="${errClass('displayName').trim()}">
        <div class="label-text">A name for this PC</div>
        <input type="text" name="displayName" value="${htmlEscape(stickyValue(sticky, 'displayName', snapshot.displayName))}" placeholder="Counter PC - Front Desk" />
        <div class="hint">So you can recognise this machine in the admin portal. Optional.</div>
        ${fieldError(sticky, 'displayName')}
      </label>
      <label class="${errClass('reportedBusinessAddress').trim()}">
        <div class="label-text">Your shop address</div>
        <input type="text" name="reportedBusinessAddress" value="${htmlEscape(stickyValue(sticky, 'reportedBusinessAddress', snapshot.reportedBusinessAddress ?? snapshot.profile?.reportedBusinessAddress))}" placeholder="Shop number, street, city, state" />
        <div class="hint">The platform admin reviews this when approving your shop.</div>
        ${fieldError(sticky, 'reportedBusinessAddress')}
      </label>
      <label class="${errClass('intendedBusinessId').trim()}">
        <div class="label-text">Business ID (optional)</div>
        <input type="text" name="intendedBusinessId"
          value="${htmlEscape(stickyValue(sticky, 'intendedBusinessId', snapshot.intendedBusinessId ?? null))}"
          placeholder="e.g. 8c63ce83-a622-428d-8baa-474b45e0f8f1"
          pattern="^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" />
        <div class="hint">If this PC belongs to a Business that is already onboarded (e.g. another PC at the same shop is already paired), paste the Business ID your platform admin gave you. Leave blank otherwise — the admin will create a new Business and bind this PC during approval.</div>
        ${fieldError(sticky, 'intendedBusinessId')}
      </label>
      <label class="${errClass('serverUrl').trim()}">
        <div class="label-text">PrintAnywhere server address</div>
        <input type="url" name="serverUrl" value="${htmlEscape(stickyValue(sticky, 'serverUrl', configuredServerUrl))}" placeholder="${htmlEscape(defaultPrintAnywhereBackendUrl())}" required />
        <div class="hint">The production server is already filled in. Change this only if PrintAnywhere support asks you to.</div>
        ${fieldError(sticky, 'serverUrl')}
      </label>
      <div class="btn-row">
        <button class="btn btn-primary" type="submit">Save shop details</button>
      </div>
    </form>
  `
}

/**
 * The Branding & white-label card (KAN-40 P1-6 + P2-4).
 *
 * The business logo is now a real file upload (PNG / JPG / SVG) served from
 * the writable /branding directory, with a live preview and a Remove action.
 * A custom logo URL is still supported but demoted into an Advanced
 * disclosure with an inline load-failure hint, since the silent-hide on a
 * broken URL left non-technical owners with no idea it had failed.
 */
function renderBrandingCard(snapshot: ReturnType<AgentRuntime['snapshot']>) {
  const logo = snapshot.brandLogoUrl?.trim() || null
  const isUploaded = !!logo && logo.startsWith('/branding/')
  const logoPreview = logo
    ? `<div class="logo-preview">
        <img src="${htmlEscape(logo)}" alt="Current business logo"
          onerror="this.closest('.logo-preview').classList.add('is-broken')" />
        <div class="logo-preview-broken muted small">
          This logo image could not be loaded. ${isUploaded
            ? 'Try uploading the file again.'
            : 'Check the logo URL in Advanced settings below — it may be wrong or unreachable.'}
        </div>
      </div>`
    : `<div class="muted small">No logo set yet. Your shop name will be shown on its own.</div>`

  return `
    <div class="card">
      <div class="card-title">Branding &amp; white-label</div>
      <p class="muted small" style="margin-bottom:14px;">
        Add your shop's name and logo so this console and your customers' receipts feel like your business.
      </p>

      <div class="subsection" style="margin-top:0; padding-top:0; border-top:0;">
        <div class="subsection-title">Business logo</div>
        <div class="logo-row">
          ${logoPreview}
          <form method="post" action="/settings/logo" enctype="multipart/form-data" class="logo-upload-form js-pending-form">
            ${hiddenUiToken(snapshot.uiToken)}
            <label>
              <div class="label-text">Choose a logo image</div>
              <input type="file" name="logo" accept="image/png,image/jpeg,image/svg+xml" required />
              <div class="hint">PNG, JPG or SVG, up to 2 MB. This is saved on this PC.</div>
            </label>
            <div class="btn-row" style="margin-top:8px;">
              <button class="btn btn-primary" type="submit" data-pending-text="Uploading…">
                ${logo ? 'Replace logo' : 'Upload logo'}
              </button>
              ${isUploaded
                ? `<button class="btn btn-danger" type="submit" formaction="/settings/logo/remove"
                     formenctype="application/x-www-form-urlencoded" data-pending-text="Removing…">Remove logo</button>`
                : ''}
            </div>
          </form>
        </div>
      </div>

      <div class="subsection">
        <div class="subsection-title">Shop name &amp; support contact</div>
        <form method="post" action="/settings/branding" class="stack js-pending-form js-dirty-aware">
          ${hiddenUiToken(snapshot.uiToken)}
          <div class="grid-2">
            <label>
              <div class="label-text">Business name (shown in the header)</div>
              <input type="text" name="brandName" value="${htmlEscape(snapshot.brandName ?? '')}" placeholder="Your Print Shop" />
              <div class="hint">Appears in the top bar and on receipts to customers.</div>
            </label>
            <label>
              <div class="label-text">Support email (shown on the Support page)</div>
              <input type="email" name="supportContactEmail" value="${htmlEscape(snapshot.supportContactEmail ?? '')}" placeholder="support@yourshop.com" />
              <div class="hint">Customers see this when they need help with a print.</div>
            </label>
          </div>
          <details>
            <summary><span class="summary-row"><span>Advanced: use a logo from a web address instead</span></span></summary>
            <p class="muted small" style="margin-top:8px;">
              Most shops should upload a file above. Only use this if your logo is already
              hosted online. If the address is wrong, the logo simply will not appear.
            </p>
            <label style="margin-top:8px;">
              <div class="label-text">Business logo URL</div>
              <input type="url" name="brandLogoUrl"
                value="${isUploaded ? '' : htmlEscape(snapshot.brandLogoUrl ?? '')}"
                placeholder="https://yourshop.com/logo.png" />
              <div class="hint">Leave blank to keep your uploaded logo (if any).</div>
            </label>
          </details>
          <div class="btn-row">
            <button class="btn btn-primary" type="submit" data-pending-text="Saving…" data-dirty-required>Save shop details</button>
          </div>
        </form>
      </div>
    </div>`
}

/**
 * The full guided first-run screen (KAN-37). Renders one of two states:
 *  - `config`: a welcome, a step list, and the focused config form.
 *  - `awaiting-pairing`: a welcome, the step list (config done), the hero
 *    pairing code + QR, the trust panel, and a regenerate-code action.
 *
 * Branding, pricing, host location, orders, recent jobs — every operator
 * card — are deliberately deferred until pairing succeeds (KAN-29 P0-1).
 */
export function renderFirstRunScreen(
  snapshot: ReturnType<AgentRuntime['snapshot']>,
  firstRun: FirstRunStatus,
  configuredServerUrl: string,
) {
  const awaiting = firstRun.stage === 'awaiting-pairing'

  const steps = [
    {
      title: 'Tell us about your shop',
      text: 'A couple of quick details so the platform admin can recognise this machine.',
      state: awaiting ? 'is-done' : '',
    },
    {
      title: 'Get your pairing code',
      text: 'This PC creates a short code (and a QR code) for you to share.',
      state: awaiting ? '' : 'is-pending',
    },
    {
      title: 'Your admin pairs this PC',
      text: 'They enter the code in the PrintAnywhere portal. This page updates on its own.',
      state: 'is-pending',
    },
  ]

  const stepList = `<div class="card">
    <div class="card-title">${awaiting ? 'Final step — share your pairing code' : 'Getting started — 3 quick steps'}</div>
    <div class="steps">
      ${steps
        .map(
          (step, index) => `<div class="step ${step.state}">
        <span class="step-num" aria-hidden="true">${step.state === 'is-done' ? '✓' : index + 1}</span>
        <span class="step-body">
          <span class="step-title">${htmlEscape(step.title)}</span>
          <span class="step-text">${htmlEscape(step.text)}</span>
        </span>
      </div>`,
        )
        .join('')}
    </div>
  </div>`

  const welcome = `<div>
      <div class="page-eyebrow">Welcome to PrintAnywhere</div>
      <div class="page-title">${awaiting ? 'Almost done — pair this PC' : "Let's set up this PC"}</div>
    </div>
    ${stateBanner({
      variant: 'info',
      title: awaiting
        ? 'This PC is registered and waiting to be paired.'
        : 'This PC is not connected to PrintAnywhere yet.',
      body: awaiting
        ? 'Share the pairing code below with your platform admin. Once they pair it, your full dashboard appears here automatically.'
        : 'PrintAnywhere lets customers send print jobs to your shop. Setup takes about a minute — no technical knowledge needed.',
    })}`

  if (!awaiting) {
    return `${welcome}
      ${stepList}
      ${renderFirstRunConfigForm(snapshot, configuredServerUrl)}
      ${renderTrustPanel()}`
  }

  return `<div id="awaiting-pairing-screen">
    ${welcome}
    ${stepList}
    ${renderPairingHero({
      pairingCode: firstRun.pairingCode,
      pairingCodeExpiresAt: firstRun.pairingCodeExpiresAt,
    })}
    ${renderTrustPanel()}
    <div class="card">
      <div class="card-title">Need a fresh code?</div>
      <p class="muted small" style="margin-bottom:12px; line-height:1.6;">
        Pairing codes expire for security. If yours has expired, or your admin asks for a new
        one, generate a replacement here — the old code stops working immediately.
      </p>
      <form method="post" action="/actions/repair">
        ${hiddenUiToken(snapshot.uiToken)}
        <button class="btn btn-secondary" type="submit">Generate a new pairing code</button>
      </form>
    </div>
  </div>`
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

/**
 * KAN-295: a one-glance "agent health" header. Replaces the wall-of-text
 * status panel (three muted lines for heartbeat / error / last job) on the
 * dashboard with a green / amber / red banner that summarises whether the
 * agent is healthy, has a transient issue, or needs attention. The three
 * facts that used to be paragraph lines are surfaced as inline fact tiles
 * so a curious operator can still see them, just structured for skimming.
 *
 * Variant rules:
 *  - error:   not paired, OR connection is fully disconnected.
 *  - warning: a recent `lastError`, OR the connection is stale.
 *  - good:    paired + heartbeating fresh + no `lastError`.
 *  - info:    paired but no heartbeat yet (waiting for first cloud sync).
 *
 * Exported so the variant selection can be unit-tested without rendering
 * the entire dashboard.
 */
export function selectAgentHealthVariant(input: {
  connection: ConnectionStatus
  lastError: string | null | undefined
}): { variant: 'good' | 'warning' | 'error' | 'info'; title: string; detail: string } {
  const { connection, lastError } = input
  if (connection.state === 'unregistered') {
    return {
      variant: 'error',
      title: 'Not paired yet',
      detail: 'This machine has not been paired with PrintAnywhere. Customer jobs cannot reach it yet.',
    }
  }
  if (connection.state === 'disconnected') {
    return {
      variant: 'error',
      title: 'Agent is offline',
      detail: connection.detail,
    }
  }
  if (lastError) {
    return {
      variant: 'warning',
      title: 'Agent reported an error',
      detail: lastError,
    }
  }
  if (connection.state === 'stale') {
    return {
      variant: 'warning',
      title: 'Cloud connection is slow',
      detail: connection.detail,
    }
  }
  if (connection.ageSeconds == null) {
    return {
      variant: 'info',
      title: 'Waiting for the first cloud sync',
      detail: connection.detail,
    }
  }
  return {
    variant: 'good',
    title: 'Agent is healthy',
    detail: connection.detail,
  }
}

const AGENT_HEALTH_ICONS: Record<'good' | 'warning' | 'error' | 'info', string> = {
  good: '✔',
  warning: '⚠',
  error: '✕',
  info: 'ℹ',
}

/**
 * Render the agent health banner card. `lastJobLabel` is the optional
 * fact-tile text describing the most recent job, e.g. "abc123 · Completed".
 */
export function renderAgentHealthBanner(opts: {
  connection: ConnectionStatus
  lastError: string | null | undefined
  lastHeartbeatLabel: string
  lastJobLabel: string
}): string {
  const verdict = selectAgentHealthVariant({
    connection: opts.connection,
    lastError: opts.lastError ?? null,
  })
  const role = verdict.variant === 'error' ? 'alert' : 'status'
  const live = verdict.variant === 'error' ? 'assertive' : 'polite'
  return `<section class="agent-health is-${verdict.variant}" role="${role}" aria-live="${live}" aria-label="Agent health">
    <div class="agent-health-row">
      <div class="agent-health-icon" aria-hidden="true">${AGENT_HEALTH_ICONS[verdict.variant]}</div>
      <div class="agent-health-body">
        <div class="agent-health-title">${htmlEscape(verdict.title)}</div>
        <div class="agent-health-text">${htmlEscape(verdict.detail)}</div>
      </div>
    </div>
    <div class="agent-health-facts">
      <div class="agent-health-fact">
        <div class="agent-health-fact-label">Last heartbeat</div>
        <div class="agent-health-fact-value">${htmlEscape(opts.lastHeartbeatLabel)}</div>
      </div>
      <div class="agent-health-fact">
        <div class="agent-health-fact-label">Last error</div>
        <div class="agent-health-fact-value">${htmlEscape(opts.lastError ?? 'None')}</div>
      </div>
      <div class="agent-health-fact">
        <div class="agent-health-fact-label">Last job</div>
        <div class="agent-health-fact-value">${htmlEscape(opts.lastJobLabel)}</div>
      </div>
    </div>
  </section>`
}

/**
 * Render the secure-cover colour picker block (KAN-295). Combines:
 *  - a HEX text input that doubles as the form field the backend reads
 *    (`secureCoverSheetColorName` — backend still accepts an arbitrary
 *    string, so we round-trip the legacy named colours unchanged);
 *  - a live preview swatch;
 *  - a native `<input type="color">` picker;
 *  - three RGB sliders with live numeric readouts;
 *  - a row of recommended one-click swatch chips.
 *
 * The dirty/sync logic is wired by SHARED_SCRIPTS using the element IDs
 * declared here as a contract.
 */
function renderSecureCoverColorPicker(opts: {
  initialValue: string
  errClass: string
  fieldErrorHtml: string
}) {
  const initialHex = resolvePreviewHex(opts.initialValue)
  const rgb = parseHexColor(initialHex) ?? { r: 255, g: 255, b: 255 }
  const chips = RECOMMENDED_SECURE_COVER_SWATCHES.map(
    (swatch) => `
      <button type="button" class="chip" data-secure-cover-swatch
              data-swatch-value="${htmlEscape(swatch.value)}"
              data-swatch-preview="${htmlEscape(swatch.preview)}"
              aria-label="Set secure cover colour to ${htmlEscape(swatch.label)}">
        <span class="chip-swatch" aria-hidden="true" style="background:${htmlEscape(swatch.preview)};"></span>
        <span>${htmlEscape(swatch.label)}</span>
      </button>`,
  ).join('')
  return `
    <div class="color-picker" data-secure-cover-picker
         data-initial-value="${htmlEscape(opts.initialValue)}"
         data-initial-preview="${htmlEscape(initialHex)}">
      <div class="color-picker-row">
        <div id="secure-cover-preview" class="color-preview"
             style="background:${htmlEscape(initialHex)};" aria-hidden="true"></div>
        <label class="${opts.errClass}">
          <div class="label-text">Secure cover color</div>
          <input type="text" id="secure-cover-hex" name="secureCoverSheetColorName"
                 value="${htmlEscape(opts.initialValue)}"
                 autocomplete="off" spellcheck="false" inputmode="text"
                 aria-describedby="secure-cover-help" />
          ${opts.fieldErrorHtml}
          <div class="hint" id="secure-cover-help">Type a colour name (WHITE, KRAFT, …) or a HEX value like #1F4E8C.</div>
        </label>
        <label>
          <div class="label-text">Picker</div>
          <input type="color" id="secure-cover-color-picker"
                 class="color-picker-native" value="${htmlEscape(initialHex)}"
                 aria-label="Open the native colour picker" />
        </label>
      </div>
      <div class="color-sliders" role="group" aria-label="RGB channels">
        <div class="color-slider-row">
          <span class="color-slider-label" aria-hidden="true">R</span>
          <input type="range" id="secure-cover-rgb-r" class="color-slider"
                 min="0" max="255" step="1" value="${rgb.r}" aria-label="Red channel" />
          <span class="color-slider-value" id="secure-cover-rgb-r-value">${rgb.r}</span>
        </div>
        <div class="color-slider-row">
          <span class="color-slider-label" aria-hidden="true">G</span>
          <input type="range" id="secure-cover-rgb-g" class="color-slider"
                 min="0" max="255" step="1" value="${rgb.g}" aria-label="Green channel" />
          <span class="color-slider-value" id="secure-cover-rgb-g-value">${rgb.g}</span>
        </div>
        <div class="color-slider-row">
          <span class="color-slider-label" aria-hidden="true">B</span>
          <input type="range" id="secure-cover-rgb-b" class="color-slider"
                 min="0" max="255" step="1" value="${rgb.b}" aria-label="Blue channel" />
          <span class="color-slider-value" id="secure-cover-rgb-b-value">${rgb.b}</span>
        </div>
      </div>
      <div>
        <div class="label-text" style="margin-bottom:4px;">Recommended</div>
        <div class="chip-row">${chips}</div>
      </div>
    </div>
  `
}

const SECURE_COVER_LABEL_SUGGESTIONS = [
  'SECURE-DO-NOT-OPEN',
  'CONFIDENTIAL',
  'PRIVATE',
  'FOR-CUSTOMER-ONLY',
]

/**
 * Render a reusable "suggestion chips" row that writes a preset value into
 * a sibling text input. Used for the secure-cover label (and any other
 * free-form field with a small known set of common values).
 */
function renderSuggestionChips(opts: { targetId: string; suggestions: ReadonlyArray<string> }) {
  return `<div class="chip-row" data-suggestion-row data-target-id="${htmlEscape(opts.targetId)}">
    ${opts.suggestions
      .map(
        (value) =>
          `<button type="button" class="chip" data-suggestion-value="${htmlEscape(value)}"
                   aria-label="Use suggestion ${htmlEscape(value)}">
             <span>${htmlEscape(value)}</span>
           </button>`,
      )
      .join('')}
  </div>`
}

function pageShell(
  opts: {
    title: string
    activePage: string
    snapshot: ReturnType<AgentRuntime['snapshot']>
    notice?: string | null
    error?: string | null
  },
  content: string,
) {
  const { title, activePage, snapshot, notice, error } = opts
  const brandName = snapshot.brandName?.trim() || null
  const brandLogoUrl = snapshot.brandLogoUrl?.trim() || null
  const connection = computeConnectionState({
    registered: !!snapshot.registration?.agentId,
    lastHeartbeatAt: snapshot.lastHeartbeatAt ?? null,
  })

  const bizBranding =
    brandName || brandLogoUrl
      ? `
        <div class="site-header-divider"></div>
        <div class="site-header-biz">
          ${brandLogoUrl ? `<img class="biz-logo" src="${htmlEscape(brandLogoUrl)}" alt="${htmlEscape(brandName ?? 'Business logo')}" onerror="this.style.display='none'" />` : ''}
          ${brandName ? `<span class="biz-name">${htmlEscape(brandName)}</span>` : ''}
        </div>
      `
      : ''

  // KAN-415 Agent Phase 1 — grouped left-nav. Each group has an
  // explicit purpose so a first-time operator can find the right page
  // without having to read every label first.
  type NavGroup = { label: string; items: Array<{ href: string; label: string; id: string }> }
  const navGroups: NavGroup[] = [
    {
      label: 'Get started',
      items: [
        { href: '/setup', label: 'Backend configuration', id: 'setup' },
        { href: '/registration', label: 'Registration & approval', id: 'registration' },
      ],
    },
    {
      label: 'Operate',
      items: [
        { href: '/', label: 'Dashboard', id: 'dashboard' },
        { href: '/printers', label: 'Printers', id: 'printers' },
        { href: '/orders', label: 'Orders', id: 'orders' },
        { href: '/coupons', label: 'Coupons', id: 'coupons' },
        { href: '/settings', label: 'Settings', id: 'settings' },
      ],
    },
    {
      label: 'Account',
      items: [
        // Phase 1.5a — local staff sign-in. Label flips between
        // "Sign in" / signed-in email so the operator can see at a
        // glance whether the agent has an active staff identity.
        {
          href: '/login',
          label: snapshot.staffSession?.email ?? 'Sign in',
          id: 'login',
        },
      ],
    },
    {
      label: 'Resources',
      items: [
        { href: '/help', label: 'Help & FAQ', id: 'help' },
        { href: '/support', label: 'Support', id: 'support' },
        { href: '/about', label: 'About', id: 'about' },
      ],
    },
  ]

  const navHtml = navGroups
    .map(
      (group) => `
        <div class="app-sidebar-group" role="group" aria-label="${htmlEscape(group.label)}">
          <div class="app-sidebar-group-label">${htmlEscape(group.label)}</div>
          ${group.items
            .map(
              (link) =>
                `<a class="app-sidebar-link${activePage === link.id ? ' is-active' : ''}" href="${link.href}"${activePage === link.id ? ' aria-current="page"' : ''}>${htmlEscape(link.label)}</a>`,
            )
            .join('')}
        </div>
      `,
    )
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(title)} — PrintAnywhere Agent</title>
  <style>${SHARED_CSS}</style>
</head>
<body>
  <div class="app-shell">
    <aside class="app-sidebar" aria-label="PrintAnywhere Agent navigation">
      <a href="/" class="app-sidebar-brand">
        <img class="dhruvanta-logo" src="/assets/dhruvanta-symbol.svg" alt="Dhruvanta" />
        <span>
          <span class="brand-text">PrintAnywhere</span>
          <span class="brand-sub">Agent</span>
        </span>
      </a>
      ${bizBranding}
      <nav class="app-sidebar-nav">
        ${navHtml}
      </nav>
      <div class="app-sidebar-footer">
        <span>v${htmlEscape(AGENT_VERSION)}</span>
        <span>&copy; Dhruvanta Systems</span>
      </div>
    </aside>
    <div class="app-main">
      <header class="app-topbar">
        <div class="app-topbar-title">${htmlEscape(title)}</div>
        <span class="app-topbar-spacer"></span>
        ${connectionPill(connection)}
      </header>
      <main class="page-content">
        ${notice ? `<div class="alert alert-success" role="status" aria-live="polite">${htmlEscape(notice)}</div>` : ''}
        ${error ? `<div class="alert alert-error" role="alert" aria-live="assertive">${htmlEscape(error)}</div>` : ''}
        ${content}
      </main>
    </div>
  </div>
  ${SHARED_SCRIPTS}
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Shared inline scripts (geolocation)
// ---------------------------------------------------------------------------

const SHARED_SCRIPTS = `<script>
(function () {
  function writeLocationFields(prefix, position) {
    var lat = document.getElementById(prefix + '-latitude');
    var lng = document.getElementById(prefix + '-longitude');
    var acc = document.getElementById(prefix + '-accuracy');
    var cap = document.getElementById(prefix + '-captured-at');
    if (lat) lat.value = String(position.coords.latitude);
    if (lng) lng.value = String(position.coords.longitude);
    if (acc) acc.value = String(position.coords.accuracy || '');
    if (cap) cap.value = new Date(position.timestamp || Date.now()).toISOString();
  }

  function requestBrowserLocation(status, onDone, onUnavailable) {
    if (!navigator.geolocation) {
      if (status) status.textContent = 'Browser geolocation is not available.';
      if (onUnavailable) onUnavailable();
      return;
    }
    if (status) status.textContent = 'Requesting location permission…';
    navigator.geolocation.getCurrentPosition(function (pos) { onDone(pos); }, function (err) {
      if (status) status.textContent = err && err.message ? err.message : 'Location permission was not granted.';
      if (onUnavailable) onUnavailable();
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 300000 });
  }

  // NOTE: the config form (#configure-form) no longer prompts for geolocation
  // on submit. Location is shared only via an explicit button — see
  // wireExplicitLocationButton below. This avoids a silent browser permission
  // prompt when the owner just wants to Save settings (KAN-38, scope #4).

  var hostBtn = document.getElementById('host-location-button');
  var hostStatus = document.getElementById('host-location-status');
  var hostForm = document.getElementById('host-location-form');
  if (hostBtn && hostStatus && hostForm) {
    hostBtn.addEventListener('click', function () {
      requestBrowserLocation(hostStatus, function (pos) {
        writeLocationFields('host-location', pos);
        hostForm.submit();
      });
    });
  }

  // --- Copy-to-clipboard buttons ------------------------------------------
  // Any button with data-copy-target="<id>" copies that element's
  // data-code (or textContent) and briefly shows a "Copied" confirmation.
  var copyButtons = document.querySelectorAll('[data-copy-target]');
  for (var ci = 0; ci < copyButtons.length; ci++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var target = document.getElementById(btn.getAttribute('data-copy-target'));
        if (!target) return;
        var text = target.getAttribute('data-code') || target.textContent || '';
        function confirmCopied() {
          btn.classList.add('is-copied');
          setTimeout(function () { btn.classList.remove('is-copied'); }, 2000);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(confirmCopied, function () {});
        } else {
          var ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); confirmCopied(); } catch (e) {}
          document.body.removeChild(ta);
        }
      });
    })(copyButtons[ci]);
  }

  // --- Explicit "Share device location" action ----------------------------
  // P1-1 (KAN-37) + KAN-38: never silently prompt for geolocation. Both the
  // first-run config form and the paired-state config form expose an explicit
  // button; the owner clicks it to consciously share, then the form submits
  // with the result. Only one config form (#configure-form) is on the page at
  // a time, so we wire up whichever button is present.
  function wireExplicitLocationButton(buttonId, statusId) {
    var btn = document.getElementById(buttonId);
    var locForm = document.getElementById('configure-form');
    var status = document.getElementById(statusId);
    if (!btn || !locForm) return;
    btn.addEventListener('click', function () {
      btn.disabled = true;
      requestBrowserLocation(status, function (pos) {
        writeLocationFields('configure-location', pos);
        if (status) status.textContent = 'Location captured. Saving…';
        locForm.submit();
      }, function () {
        btn.disabled = false;
      });
    });
  }
  wireExplicitLocationButton('firstrun-location-button', 'firstrun-location-status');
  wireExplicitLocationButton('paired-location-button', 'paired-location-status');

  // --- Auto-refresh the awaiting-pairing screen ---------------------------
  // While the owner waits for the admin to pair, poll /health and reload
  // once the agent reports it is registered + self-service enabled so the
  // full dashboard appears without a manual refresh.
  if (document.getElementById('awaiting-pairing-screen')) {
    setInterval(function () {
      fetch('/health', { cache: 'no-store' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          if (data && data.pairingComplete) window.location.reload();
        })
        .catch(function () {});
    }, 15000);
  }

  // --- Persistent header connection pill ----------------------------------
  // Polls /health every 20s and reflects the computed connection state.
  // /health returns a server-computed { connection } object; if the agent
  // process itself is unreachable, the fetch fails and we show "Offline".
  (function () {
    var pill = document.getElementById('conn-pill');
    if (!pill) return;
    var labelEl = document.getElementById('conn-pill-label');
    var syncEl = document.getElementById('conn-pill-sync');
    var STATES = ['connected', 'stale', 'disconnected', 'unregistered'];

    function applyState(state, label, sync) {
      for (var i = 0; i < STATES.length; i++) pill.classList.remove('conn-pill-' + STATES[i]);
      pill.classList.add('conn-pill-' + state);
      pill.setAttribute('data-state', state);
      if (labelEl) labelEl.textContent = label;
      if (syncEl) syncEl.textContent = sync;
      pill.setAttribute('title', sync);
    }

    function poll() {
      fetch('/health', { cache: 'no-store' })
        .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error('bad status')); })
        .then(function (data) {
          var c = data && data.connection;
          if (!c || !c.state) return;
          var sync = c.state === 'unregistered' ? 'Pair this machine to connect' : c.detail;
          applyState(c.state, c.label, sync);
        })
        .catch(function () {
          // The agent service is not answering at all — strongest signal.
          applyState('disconnected', 'Agent offline', 'Cannot reach the agent service on this PC.');
        });
    }

    poll();
    setInterval(poll, 20000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') poll();
    });
  })();

  // --- Action loading feedback (KAN-39 P2-3) ------------------------------
  // Any form carrying class "js-pending-form" gets pending feedback on submit:
  // its submit button is disabled, marked aria-busy, and (if it declares a
  // data-pending-text) its label is swapped to a reassuring "…" message. This
  // prevents double-submits and shows the owner the action was received.
  // Scoped to an opt-in marker class so it never conflicts with the forms the
  // scripts above submit programmatically (host-location, configure-form, …).
  var pendingForms = document.querySelectorAll('form.js-pending-form');
  for (var pf = 0; pf < pendingForms.length; pf++) {
    (function (form) {
      form.addEventListener('submit', function () {
        var btn = form.querySelector('button[type=submit], button:not([type])');
        if (!btn || btn.disabled) return;
        var pendingText = btn.getAttribute('data-pending-text');
        if (pendingText) {
          if (!btn.getAttribute('data-idle-text')) {
            btn.setAttribute('data-idle-text', btn.textContent);
          }
          btn.textContent = pendingText;
        }
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        // A disabled submit button is excluded from the POST body by the
        // browser, but its hidden-input siblings still submit — so named
        // values (jobId, uiToken, …) are unaffected.
      });
    })(pendingForms[pf]);
  }

  // --- KAN-295: dirty-aware save buttons ---------------------------------
  // A form marked .js-dirty-aware starts with data-dirty="false". Any
  // change/input event from one of its named inputs flips it to "true",
  // which lets the CSS rule above re-enable buttons that declare
  // data-dirty-required. The original input values are snapshotted on
  // first paint so a user can toggle a field back to the snapshot and the
  // form returns to clean.
  //
  // For real accessibility (keyboard users can Tab + Enter), we also
  // toggle the buttons' DOM "disabled" property — CSS pointer-events alone
  // would not stop keyboard submission. We avoid clobbering the
  // "js-pending-form" handler that disables a button on submit by leaving
  // aria-busy buttons alone (they are mid-submit and should stay disabled).
  var dirtyForms = document.querySelectorAll('form.js-dirty-aware');
  for (var df = 0; df < dirtyForms.length; df++) {
    (function (form) {
      form.setAttribute('data-dirty', 'false');
      var inputs = form.querySelectorAll('input, select, textarea');
      var requiredButtons = form.querySelectorAll('button[data-dirty-required]');
      var initial = [];
      for (var ii = 0; ii < inputs.length; ii++) {
        var el = inputs[ii];
        if (el.type === 'hidden' || el.type === 'file') continue;
        var key = el.name || el.id || ('field-' + ii);
        var value;
        if (el.type === 'checkbox' || el.type === 'radio') value = el.checked ? '1' : '0';
        else value = el.value;
        initial.push({ el: el, key: key, value: value });
      }
      function applyDisabled(dirty) {
        for (var bi = 0; bi < requiredButtons.length; bi++) {
          var b = requiredButtons[bi];
          // Never re-enable a button that is mid-submit (the js-pending-form
          // handler disabled it and is owning the lifecycle until reload).
          if (b.getAttribute('aria-busy') === 'true') continue;
          b.disabled = !dirty;
        }
      }
      function recompute() {
        var dirty = false;
        for (var i = 0; i < initial.length; i++) {
          var item = initial[i];
          var current;
          if (item.el.type === 'checkbox' || item.el.type === 'radio') current = item.el.checked ? '1' : '0';
          else current = item.el.value;
          if (current !== item.value) { dirty = true; break; }
        }
        form.setAttribute('data-dirty', dirty ? 'true' : 'false');
        applyDisabled(dirty);
      }
      form.addEventListener('input', recompute);
      form.addEventListener('change', recompute);
      // Apply the initial clean -> disabled state on first paint.
      applyDisabled(false);
    })(dirtyForms[df]);
  }

  // --- KAN-295: auto-dismissing flash toast ------------------------------
  // The redirect-with-?notice= pattern (and the inline ?error=) renders an
  // .alert at the top of the page. Attach a close button + a 5-second
  // auto-dismiss so the operator sees the success without it pinning the
  // viewport forever. Errors are NOT auto-dismissed — they require an
  // explicit click so the operator doesn't miss them.
  var alerts = document.querySelectorAll('.alert');
  for (var ai = 0; ai < alerts.length; ai++) {
    (function (alert) {
      if (alert.querySelector('.alert-close')) return;
      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'alert-close';
      close.setAttribute('aria-label', 'Dismiss this message');
      close.textContent = '\\u00d7';
      close.addEventListener('click', function () {
        alert.classList.add('is-dismissing');
        setTimeout(function () {
          if (alert.parentNode) alert.parentNode.removeChild(alert);
        }, 400);
      });
      alert.appendChild(close);
      if (alert.classList.contains('alert-success')) {
        setTimeout(function () {
          if (!alert.parentNode) return;
          alert.classList.add('is-dismissing');
          setTimeout(function () {
            if (alert.parentNode) alert.parentNode.removeChild(alert);
          }, 400);
        }, 5000);
      }
    })(alerts[ai]);
  }

  // --- KAN-295: secure-cover colour picker -------------------------------
  // The picker keeps four UI affordances in sync (hex text input, native
  // colour picker, three RGB sliders, swatch chips). Pure helpers below
  // are duplicated from src/ui/secureCoverColors.ts (which is the unit-
  // tested source of truth); keep them in sync if the canonical helpers
  // change.
  function normalizeHex(raw) {
    if (raw == null) return null;
    var t = String(raw).trim().toLowerCase();
    if (!t) return null;
    var s = t.charAt(0) === '#' ? t.slice(1) : t;
    if (/^[0-9a-f]{3}$/.test(s)) return '#' + s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
    if (/^[0-9a-f]{6}$/.test(s)) return '#' + s;
    return null;
  }
  function parseHex(raw) {
    var hex = normalizeHex(raw);
    if (!hex) return null;
    return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
  }
  function clampChan(n) {
    var v = typeof n === 'number' ? n : parseInt(String(n || ''), 10);
    if (!isFinite(v) || isNaN(v)) return 0;
    if (v < 0) return 0;
    if (v > 255) return 255;
    return Math.round(v);
  }
  function rgbToHexStr(rgb) {
    function pad(n) { var s = clampChan(n).toString(16); return s.length < 2 ? '0' + s : s; }
    return '#' + pad(rgb.r) + pad(rgb.g) + pad(rgb.b);
  }

  var picker = document.querySelector('[data-secure-cover-picker]');
  if (picker) {
    var hexInput = document.getElementById('secure-cover-hex');
    var nativePicker = document.getElementById('secure-cover-color-picker');
    var preview = document.getElementById('secure-cover-preview');
    var rEl = document.getElementById('secure-cover-rgb-r');
    var gEl = document.getElementById('secure-cover-rgb-g');
    var bEl = document.getElementById('secure-cover-rgb-b');
    var rVal = document.getElementById('secure-cover-rgb-r-value');
    var gVal = document.getElementById('secure-cover-rgb-g-value');
    var bVal = document.getElementById('secure-cover-rgb-b-value');

    function paint(hex, alsoWriteHexInput) {
      if (!hex) return;
      if (preview) preview.style.background = hex;
      if (nativePicker) nativePicker.value = hex;
      var rgb = parseHex(hex);
      if (rgb) {
        if (rEl) rEl.value = String(rgb.r);
        if (gEl) gEl.value = String(rgb.g);
        if (bEl) bEl.value = String(rgb.b);
        if (rVal) rVal.textContent = String(rgb.r);
        if (gVal) gVal.textContent = String(rgb.g);
        if (bVal) bVal.textContent = String(rgb.b);
      }
      if (alsoWriteHexInput && hexInput) hexInput.value = hex;
    }

    if (hexInput) {
      hexInput.addEventListener('input', function () {
        var hex = normalizeHex(hexInput.value);
        if (hex) paint(hex, false);
      });
    }
    if (nativePicker) {
      nativePicker.addEventListener('input', function () {
        paint(nativePicker.value, true);
        if (hexInput) hexInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    function onSliderInput() {
      var hex = rgbToHexStr({ r: rEl.value, g: gEl.value, b: bEl.value });
      paint(hex, true);
      if (hexInput) hexInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (rEl) rEl.addEventListener('input', onSliderInput);
    if (gEl) gEl.addEventListener('input', onSliderInput);
    if (bEl) bEl.addEventListener('input', onSliderInput);

    var swatches = picker.querySelectorAll('[data-secure-cover-swatch]');
    for (var si = 0; si < swatches.length; si++) {
      (function (chip) {
        chip.addEventListener('click', function () {
          var value = chip.getAttribute('data-swatch-value') || '';
          var previewHex = chip.getAttribute('data-swatch-preview') || normalizeHex(value);
          if (hexInput) {
            hexInput.value = value;
            hexInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (previewHex) paint(previewHex, false);
        });
      })(swatches[si]);
    }
  }

  // --- KAN-295: generic suggestion chips ----------------------------------
  // A row marked [data-suggestion-row] writes its chip's data-suggestion-value
  // into the input identified by data-target-id, then fires a change event so
  // dirty-tracking picks it up.
  var suggestionRows = document.querySelectorAll('[data-suggestion-row]');
  for (var sri = 0; sri < suggestionRows.length; sri++) {
    (function (row) {
      var targetId = row.getAttribute('data-target-id') || '';
      var target = targetId ? document.getElementById(targetId) : null;
      if (!target) return;
      var chips = row.querySelectorAll('[data-suggestion-value]');
      for (var ci2 = 0; ci2 < chips.length; ci2++) {
        (function (chip) {
          chip.addEventListener('click', function () {
            target.value = chip.getAttribute('data-suggestion-value') || '';
            target.dispatchEvent(new Event('change', { bubbles: true }));
            target.focus();
          });
        })(chips[ci2]);
      }
    })(suggestionRows[sri]);
  }
})();
</script>`

// ---------------------------------------------------------------------------
// Platform printer sub-forms
// ---------------------------------------------------------------------------

/**
 * The Advanced (collapsed) portion of the publish form (KAN-38 scope #1).
 *
 * Document constraints, manual-approval rules, and the usage-based ink
 * pricing floor — including ICC profile paths and ink-coverage conversion
 * factors — are tucked into nested `<details>` accordions. They stay
 * collapsed by default and are pre-filled with sensible defaults so a
 * non-technical owner can publish without ever opening them. An accordion
 * is opened on first paint only when the printer being edited already has
 * a value in it, so existing advanced config stays visible.
 *
 * The constraint builders treat empty fields as "rule disabled", so an
 * unopened accordion always produces a valid submit.
 */
export function renderAdvancedPrinterSections(
  printer: PlatformPrinter | null | undefined,
  sticky?: StickyForm,
) {
  const size = findConstraint(printer, 'MAX_SINGLE_PDF_SIZE')
  const pageCount = findConstraint(printer, 'MAX_SINGLE_PDF_PAGE_COUNT')
  const pageCoverage = findConstraint(printer, 'MAX_SINGLE_PDF_PAGE_COVERAGE')
  const manualApproval = findConstraint(printer, 'REQUIRE_MANUAL_APPROVAL_FOR_DENSITY_OR_PRICE_CHANGE')
  const pricingFloor = findPricingAdjustment(printer, 'INK_COVERAGE_FLOOR')

  // KAN-40 P1-5: when re-rendering after a failed submit, each advanced field
  // prefers the owner's typed value over the stored constraint value.
  const adv = (name: string, fallback: unknown) =>
    htmlEscape(stickyValue(sticky, name, String(fallback ?? '')))
  // A sticky-aware optional money field: typed rupee value survives a failed
  // submit; otherwise the stored paise value is formatted to rupees.
  const optMoney = (name: string, label: string, storedPaise: unknown) => {
    const submitted = sticky?.submitted
    if (submitted && Object.prototype.hasOwnProperty.call(submitted, name)) {
      const raw = String(submitted[name] ?? '')
      return `<label>
        <div class="label-text">${htmlEscape(label)}</div>
        <div class="money-input">
          <input type="number" step="0.01" min="0" inputmode="decimal"
            name="${htmlEscape(name)}" value="${htmlEscape(raw)}" placeholder="0.00" />
        </div>
        ${fieldError(sticky, name)}
      </label>`
    }
    return optionalMoneyField({ name, label, storedPaise })
  }

  const hasValues = (obj: Record<string, unknown>) =>
    Object.values(obj).some((value) => String(value ?? '').trim() !== '')
  // A submitted (sticky) body counts as "has values" for an accordion when the
  // owner had typed into any of that section's named fields.
  const submittedHas = (...names: string[]) => {
    const submitted = sticky?.submitted
    if (!submitted) return false
    return names.some((name) => String(submitted[name] ?? '').trim() !== '')
  }
  const open = (condition: boolean) => (condition ? ' open' : '')

  const constraintsOpen = open(
    hasValues(size) || hasValues(pageCount) || hasValues(pageCoverage)
      || submittedHas('constraintMaxSizeMb', 'constraintMaxPageCount', 'constraintMaxPageCoveragePercent'),
  )
  const manualApprovalOpen = open(
    hasValues(manualApproval)
      || submittedHas(
        'manualApprovalMaxPageCoveragePercent', 'manualApprovalBlackFullPagePriceMinor',
        'manualApprovalColorFullPagePriceMinor', 'manualApprovalBlackConversionFactor',
        'manualApprovalColorConversionFactor', 'manualApprovalIccProfilePath',
      ),
  )
  const pricingFloorOpen = open(
    hasValues(pricingFloor)
      || submittedHas(
        'pricingFloorBlackFullPagePriceMinor', 'pricingFloorColorFullPagePriceMinor',
        'pricingFloorBlackConversionFactor', 'pricingFloorColorConversionFactor',
        'pricingFloorIccProfilePath',
      ),
  )

  return `
    <div class="subsection">
      <div class="subsection-title">Advanced settings</div>
      <p class="muted small" style="margin-bottom:10px;">
        Optional. These are pre-filled with sensible defaults — you can publish
        without opening them. Open a section only if you need to fine-tune it.
      </p>

      <details${constraintsOpen}>
        <summary><span class="summary-row"><span>Document limits</span></span></summary>
        <p class="muted small">Caps on the files customers can send. Leave blank for no limit.</p>
        <div class="grid-3" style="margin-top:10px;">
          <label>
            <div class="label-text">Max PDF size (MB)</div>
            <input type="text" name="constraintMaxSizeMb" value="${adv('constraintMaxSizeMb', size.maxSizeMb)}" placeholder="15" />
          </label>
          <label>
            <div class="label-text">Max PDF pages</div>
            <input type="text" name="constraintMaxPageCount" value="${adv('constraintMaxPageCount', pageCount.maxPageCount)}" placeholder="100" />
          </label>
          <label>
            <div class="label-text">Max printed area per page (%)</div>
            <input type="text" name="constraintMaxPageCoveragePercent" value="${adv('constraintMaxPageCoveragePercent', pageCoverage.maxPageCoveragePercent)}" placeholder="65" />
          </label>
        </div>
      </details>

      <details${manualApprovalOpen}>
        <summary><span class="summary-row"><span>Manual approval for dense or repriced PDFs</span></span></summary>
        <p class="muted small">Hold heavy-ink jobs for your review. Leave all fields empty to disable this rule.</p>
        <div class="grid-3" style="margin-top:10px;">
          <label>
            <div class="label-text">Coverage threshold (%)</div>
            <input type="text" name="manualApprovalMaxPageCoveragePercent" value="${adv('manualApprovalMaxPageCoveragePercent', manualApproval.maxPageCoveragePercent)}" placeholder="65" />
          </label>
          ${optMoney('manualApprovalBlackFullPagePriceMinor', 'Black full-page price', manualApproval.blackFullPagePriceMinor)}
          ${optMoney('manualApprovalColorFullPagePriceMinor', 'Color full-page price', manualApproval.colorFullPagePriceMinor)}
          <label>
            <div class="label-text">Black conversion factor</div>
            <input type="text" name="manualApprovalBlackConversionFactor" value="${adv('manualApprovalBlackConversionFactor', manualApproval.blackConversionFactor)}" placeholder="1.00" />
          </label>
          <label>
            <div class="label-text">Color conversion factor</div>
            <input type="text" name="manualApprovalColorConversionFactor" value="${adv('manualApprovalColorConversionFactor', manualApproval.colorConversionFactor)}" placeholder="1.00" />
          </label>
          <label class="span-3">
            <div class="label-text">ICC profile path</div>
            <input type="text" name="manualApprovalIccProfilePath" value="${adv('manualApprovalIccProfilePath', manualApproval.iccProfilePath)}" placeholder="/opt/print-profiles/printer.icc" />
          </label>
        </div>
      </details>

      <details${pricingFloorOpen}>
        <summary><span class="summary-row"><span>Usage-based ink pricing floor</span></span></summary>
        <p class="muted small">Charge more for heavy-ink pages. Leave all fields empty to disable.</p>
        <div class="grid-3" style="margin-top:10px;">
          ${optMoney('pricingFloorBlackFullPagePriceMinor', 'Black full-page price', pricingFloor.blackFullPagePriceMinor)}
          ${optMoney('pricingFloorColorFullPagePriceMinor', 'Color full-page price', pricingFloor.colorFullPagePriceMinor)}
          <label>
            <div class="label-text">Black conversion factor</div>
            <input type="text" name="pricingFloorBlackConversionFactor" value="${adv('pricingFloorBlackConversionFactor', pricingFloor.blackConversionFactor)}" placeholder="1.00" />
          </label>
          <label>
            <div class="label-text">Color conversion factor</div>
            <input type="text" name="pricingFloorColorConversionFactor" value="${adv('pricingFloorColorConversionFactor', pricingFloor.colorConversionFactor)}" placeholder="1.00" />
          </label>
          <label class="span-3">
            <div class="label-text">ICC profile path</div>
            <input type="text" name="pricingFloorIccProfilePath" value="${adv('pricingFloorIccProfilePath', pricingFloor.iccProfilePath)}" placeholder="/opt/print-profiles/printer.icc" />
          </label>
        </div>
      </details>
    </div>
  `
}

export function renderPlatformPrinterForm(
  uiToken: string | null | undefined,
  availablePrinterNames: string[],
  printer?: PlatformPrinter,
  sticky?: StickyForm,
) {
  const title = printer ? printer.name : 'Publish a new platform printer'
  const submitLabel = printer ? 'Save printer' : 'Publish printer'

  // KAN-40 P1-5: a sticky checkbox-group value resolver. After a failed
  // submit, prefer the owner's submitted ticks; otherwise the printer's
  // stored modes (and the all-options default for a brand-new printer).
  const submitted = sticky?.submitted
  const hasSub = (name: string) =>
    !!submitted && Object.prototype.hasOwnProperty.call(submitted, name)
  const groupValue = <T extends string>(name: string, stored: T[] | undefined, all: T[]): T[] => {
    if (hasSub(name)) return asArray(submitted![name]) as T[]
    return stored ?? all
  }
  const status = (hasSub('status') ? String(submitted!.status ?? '') : printer?.status) || 'ONLINE'
  const colorModes = groupValue('supportedColorModes', printer?.supportedColorModes, COLOR_MODE_OPTIONS)
  const sidesModes = groupValue('supportedSidesModes', printer?.supportedSidesModes, SIDES_MODE_OPTIONS)
  const pageSizes = groupValue('supportedPageSizes', printer?.supportedPageSizes, PAGE_SIZE_OPTIONS)
  const scalingModes = groupValue('supportedScalingModes', printer?.supportedScalingModes, SCALING_MODE_OPTIONS)
  const agentPrinterName = hasSub('agentPrinterName')
    ? String(submitted!.agentPrinterName ?? '')
    : (printer?.agentPrinterName ?? '')
  const errClass = (name: string) => (sticky?.fieldErrors?.[name] ? ' has-error' : '')

  return `
    <form method="post" action="/platform-printers/save" class="stack js-pending-form js-dirty-aware">
      ${hiddenUiToken(uiToken)}
      ${printer ? `<input type="hidden" name="printerId" value="${htmlEscape(printer.printerId)}" />` : ''}
      <div class="card-title">${htmlEscape(title)}</div>
      <div class="grid-2">
        <label class="${errClass('name').trim()}">
          <div class="label-text">Platform printer name</div>
          <input type="text" name="name" value="${htmlEscape(stickyValue(sticky, 'name', printer?.name))}" placeholder="Front Desk A4" required />
          ${fieldError(sticky, 'name')}
        </label>
        <label class="${errClass('agentPrinterName').trim()}">
          <div class="label-text">Shared local printer</div>
          <select name="agentPrinterName" required>
            <option value="">Select a shared printer</option>
            ${availablePrinterNames
              .map(
                (printerName) =>
                  `<option value="${htmlEscape(printerName)}" ${selected(agentPrinterName, printerName)}>${htmlEscape(printerName)}</option>`,
              )
              .join('')}
          </select>
          ${fieldError(sticky, 'agentPrinterName')}
        </label>
        <label class="choice">
          <input type="checkbox" name="enabled" ${checked(stickyChecked(sticky, 'enabled', printer?.enabled ?? true))} />
          <span>Enabled for customer orders</span>
        </label>
        <label>
          <div class="label-text">Status</div>
          <select name="status">
            ${PRINTER_STATUS_OPTIONS.map(
              (option) => `<option value="${option}" ${selected(status, option)}>${htmlEscape(humanizeEnum(option))}</option>`,
            ).join('')}
          </select>
        </label>
      </div>
      <div class="subsection">
        <div class="subsection-title">Pricing</div>
        <p class="muted small">Enter prices in rupees — for example, type 2.50 for ₹2.50.</p>
        <div class="grid-3" style="margin-top:10px;">
          ${stickyMoneyField({ name: 'baseJobPriceMinor', label: 'Base price per job', paiseValue: printer?.baseJobPriceMinor, sticky })}
          ${stickyMoneyField({ name: 'monochromePagePriceMinor', label: 'Black & white page price', paiseValue: printer?.monochromePagePriceMinor, sticky })}
          ${stickyMoneyField({ name: 'colorPagePriceMinor', label: 'Colour page price', paiseValue: printer?.colorPagePriceMinor, sticky })}
        </div>
      </div>
      <div class="subsection">
        <div class="subsection-title">Customer-facing capabilities</div>
        <div class="grid-2" style="margin-top:10px;">
          <div>
            <div class="label-text">Color modes</div>
            <div class="choices" style="margin-top:6px;">${renderCheckboxGroup('supportedColorModes', COLOR_MODE_OPTIONS, colorModes)}</div>
          </div>
          <div>
            <div class="label-text">Sides modes</div>
            <div class="choices" style="margin-top:6px;">${renderCheckboxGroup('supportedSidesModes', SIDES_MODE_OPTIONS, sidesModes)}</div>
          </div>
          <div>
            <div class="label-text">Page sizes</div>
            <div class="choices" style="margin-top:6px;">${renderCheckboxGroup('supportedPageSizes', PAGE_SIZE_OPTIONS, pageSizes)}</div>
          </div>
          <div>
            <div class="label-text">Scaling modes</div>
            <div class="choices" style="margin-top:6px;">${renderCheckboxGroup('supportedScalingModes', SCALING_MODE_OPTIONS, scalingModes)}</div>
          </div>
        </div>
      </div>
      <div class="subsection">
        <div class="subsection-title">Extra charges &amp; options</div>
        <p class="muted small" style="margin-bottom:10px;">
          Optional. Pre-filled with sensible defaults — open a section only to change it.
        </p>
        <details${hasSub('duplexSheetSurchargeMinor') || hasSub('a3PageSurchargeMinor') || hasSub('glossyPaperSurchargeMinor') ? ' open' : ''}>
          <summary><span class="summary-row"><span>Surcharges</span></span></summary>
          <p class="muted small">Extra charges added on top of the page prices above.</p>
          <div class="grid-3" style="margin-top:10px;">
            ${stickyMoneyField({ name: 'duplexSheetSurchargeMinor', label: 'Double-sided surcharge', paiseValue: printer?.duplexSheetSurchargeMinor, sticky })}
            ${stickyMoneyField({ name: 'a3PageSurchargeMinor', label: 'A3 page surcharge', paiseValue: printer?.a3PageSurchargeMinor, sticky })}
            ${stickyMoneyField({ name: 'glossyPaperSurchargeMinor', label: 'Glossy paper surcharge', paiseValue: printer?.glossyPaperSurchargeMinor, sticky })}
          </div>
        </details>
        <details${stickyChecked(sticky, 'supportsSecureCoverSheets', printer?.supportsSecureCoverSheets ?? false) ? ' open' : ''}>
          <summary><span class="summary-row"><span>Secure cover packet</span></span></summary>
          <p class="muted small" style="margin-top:8px;">
            Optional. When enabled, customers can ask for a coloured cover sheet to hide
            sensitive prints from view in the pickup tray.
          </p>
          <div class="field-group" style="margin-top:10px;">
            <label class="choice">
              <input type="checkbox" name="supportsSecureCoverSheets" ${checked(stickyChecked(sticky, 'supportsSecureCoverSheets', printer?.supportsSecureCoverSheets ?? false))} />
              <span>Offer secure cover packets</span>
            </label>
            <div class="grid-2">
              ${stickyMoneyField({ name: 'secureCoverSheetPriceMinor', label: 'Secure cover surcharge', paiseValue: printer?.secureCoverSheetPriceMinor, sticky })}
            </div>
          </div>
          <div class="field-group">
            <div class="field-group-title">Cover colour</div>
            <p class="field-group-help">Pick a colour by name, HEX value, RGB sliders, or one of the recommended swatches below.</p>
            ${renderSecureCoverColorPicker({
              initialValue: stickyValue(sticky, 'secureCoverSheetColorName', printer?.secureCoverSheetColorName ?? 'WHITE'),
              errClass: errClass('secureCoverSheetColorName').trim(),
              fieldErrorHtml: fieldError(sticky, 'secureCoverSheetColorName'),
            })}
          </div>
          <div class="field-group">
            <div class="field-group-title">Cover label</div>
            <p class="field-group-help">Printed on the cover sheet so staff handle it carefully. Tap a suggestion or type your own.</p>
            <label class="${errClass('secureCoverSheetLabel').trim()}">
              <div class="label-text">Secure cover label</div>
              <input type="text" id="secure-cover-label" name="secureCoverSheetLabel" value="${htmlEscape(stickyValue(sticky, 'secureCoverSheetLabel', printer?.secureCoverSheetLabel ?? 'SECURE-DO-NOT-OPEN'))}" />
              ${fieldError(sticky, 'secureCoverSheetLabel')}
            </label>
            ${renderSuggestionChips({ targetId: 'secure-cover-label', suggestions: SECURE_COVER_LABEL_SUGGESTIONS })}
          </div>
        </details>
      </div>
      ${renderAdvancedPrinterSections(printer, sticky)}
      <div class="btn-row">
        <button class="btn btn-primary" type="submit" data-pending-text="Saving…" data-dirty-required>${htmlEscape(submitLabel)}</button>
      </div>
    </form>
  `
}

/**
 * Validate a submitted publish-printer body, collecting EVERY field error at
 * once (KAN-40 P1-5) rather than throwing on the first bad field — so the
 * sticky re-render can flag all offenders together. Returns the built payload
 * when valid, or `{ payload: null, errors }` keyed by form field name.
 *
 * Exported so the validation contract is unit-testable without an HTTP round
 * trip — the ~12-field publish form is the most painful one to lose input on.
 */
export function validatePlatformPrinterPayload(
  body: Record<string, unknown>,
  printerId?: string | null,
): { payload: PlatformPrinterUpsertInput | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {}

  // Required text fields.
  const requireText = (name: string, message: string) => {
    const value = String(body[name] ?? '').trim()
    if (!value) errors[name] = message
    return value
  }
  // A required rupee field — records a field error instead of throwing.
  const requireMoney = (name: string, label: string): number => {
    try {
      return parseRupeesToPaise(body[name], label)
    } catch (error) {
      errors[name] = error instanceof Error ? error.message : `${label} is invalid.`
      return 0
    }
  }
  // An optional rupee field used by the advanced sections.
  const optionalMoney = (name: string, label: string): string | null => {
    try {
      return parseOptionalRupeesToPaise(body[name], label)
    } catch (error) {
      errors[name] = error instanceof Error ? error.message : `${label} is invalid.`
      return null
    }
  }

  const name = requireText('name', 'Give this printer a name customers will see.')
  const agentPrinterName = requireText('agentPrinterName', 'Choose which shared printer on this PC to publish.')
  const secureCoverSheetColorName = requireText('secureCoverSheetColorName', 'Enter a colour for the secure cover sheet.')
  const secureCoverSheetLabel = requireText('secureCoverSheetLabel', 'Enter a label for the secure cover sheet.')
  const status = String(body.status ?? '').trim() || 'ONLINE'

  const baseJobPriceMinor = requireMoney('baseJobPriceMinor', 'Base price per job')
  const monochromePagePriceMinor = requireMoney('monochromePagePriceMinor', 'Black & white page price')
  const colorPagePriceMinor = requireMoney('colorPagePriceMinor', 'Colour page price')
  const duplexSheetSurchargeMinor = requireMoney('duplexSheetSurchargeMinor', 'Double-sided surcharge')
  const a3PageSurchargeMinor = requireMoney('a3PageSurchargeMinor', 'A3 page surcharge')
  const glossyPaperSurchargeMinor = requireMoney('glossyPaperSurchargeMinor', 'Glossy paper surcharge')
  const secureCoverSheetPriceMinor = requireMoney('secureCoverSheetPriceMinor', 'Secure cover surcharge')

  // Advanced optional rupee fields — collect any conversion errors too.
  const manualApprovalBlackPrice = optionalMoney('manualApprovalBlackFullPagePriceMinor', 'Manual-approval black full-page price')
  const manualApprovalColorPrice = optionalMoney('manualApprovalColorFullPagePriceMinor', 'Manual-approval colour full-page price')
  const pricingFloorBlackPrice = optionalMoney('pricingFloorBlackFullPagePriceMinor', 'Pricing-floor black full-page price')
  const pricingFloorColorPrice = optionalMoney('pricingFloorColorFullPagePriceMinor', 'Pricing-floor colour full-page price')

  if (Object.keys(errors).length > 0) {
    return { payload: null, errors }
  }

  return {
    payload: {
      printerId: printerId || null,
      name,
      agentPrinterName,
      enabled: hasCheckbox(body, 'enabled'),
      status: status as PlatformPrinterStatus,
      glossyPaperSurchargeMinor,
      baseJobPriceMinor,
      monochromePagePriceMinor,
      colorPagePriceMinor,
      duplexSheetSurchargeMinor,
      a3PageSurchargeMinor,
      documentConstraints: buildDocumentConstraints(body, manualApprovalBlackPrice, manualApprovalColorPrice),
      pricingAdjustments: buildPricingAdjustments(body, pricingFloorBlackPrice, pricingFloorColorPrice),
      supportedColorModes: asArray(body.supportedColorModes) as PlatformColorMode[],
      supportedSidesModes: asArray(body.supportedSidesModes) as PlatformSidesMode[],
      supportedPageSizes: asArray(body.supportedPageSizes) as PlatformPageSize[],
      supportedScalingModes: asArray(body.supportedScalingModes) as PlatformScalingMode[],
      supportsSecureCoverSheets: hasCheckbox(body, 'supportsSecureCoverSheets'),
      secureCoverSheetPriceMinor,
      secureCoverSheetColorName,
      secureCoverSheetLabel,
    },
    errors,
  }
}

// `manualApprovalBlackPrice`/`manualApprovalColorPrice` are pre-parsed paise
// strings (or null) supplied by validatePlatformPrinterPayload, so this
// builder never re-parses rupee input and never throws.
function buildDocumentConstraints(
  body: Record<string, unknown>,
  manualApprovalBlackPrice: string | null,
  manualApprovalColorPrice: string | null,
): ConfiguredConstraint[] {
  const constraints: ConfiguredConstraint[] = []
  const maxSizeMb = parseOptionalTrimmed(body, 'constraintMaxSizeMb')
  if (maxSizeMb) constraints.push({ type: 'MAX_SINGLE_PDF_SIZE', configuration: { maxSizeMb } })
  const maxPageCount = parseOptionalTrimmed(body, 'constraintMaxPageCount')
  if (maxPageCount) constraints.push({ type: 'MAX_SINGLE_PDF_PAGE_COUNT', configuration: { maxPageCount } })
  const maxPageCoveragePercent = parseOptionalTrimmed(body, 'constraintMaxPageCoveragePercent')
  if (maxPageCoveragePercent) constraints.push({ type: 'MAX_SINGLE_PDF_PAGE_COVERAGE', configuration: { maxPageCoveragePercent } })
  const manualApprovalCoverage = parseOptionalTrimmed(body, 'manualApprovalMaxPageCoveragePercent')
  if (manualApprovalCoverage || manualApprovalBlackPrice || manualApprovalColorPrice) {
    constraints.push({
      type: 'REQUIRE_MANUAL_APPROVAL_FOR_DENSITY_OR_PRICE_CHANGE',
      configuration: stripNullish({
        maxPageCoveragePercent: manualApprovalCoverage,
        blackFullPagePriceMinor: manualApprovalBlackPrice,
        colorFullPagePriceMinor: manualApprovalColorPrice,
        blackConversionFactor: parseOptionalTrimmed(body, 'manualApprovalBlackConversionFactor'),
        colorConversionFactor: parseOptionalTrimmed(body, 'manualApprovalColorConversionFactor'),
        iccProfilePath: parseOptionalTrimmed(body, 'manualApprovalIccProfilePath'),
      }),
    })
  }
  return constraints
}

// `blackPrice`/`colorPrice` are pre-parsed paise strings (or null) supplied
// by validatePlatformPrinterPayload — this builder never re-parses or throws.
function buildPricingAdjustments(
  body: Record<string, unknown>,
  blackPrice: string | null,
  colorPrice: string | null,
): ConfiguredConstraint[] {
  if (!blackPrice && !colorPrice) return []
  return [{
    type: 'INK_COVERAGE_FLOOR',
    configuration: stripNullish({
      blackFullPagePriceMinor: blackPrice,
      colorFullPagePriceMinor: colorPrice,
      blackConversionFactor: parseOptionalTrimmed(body, 'pricingFloorBlackConversionFactor'),
      colorConversionFactor: parseOptionalTrimmed(body, 'pricingFloorColorConversionFactor'),
      iccProfilePath: parseOptionalTrimmed(body, 'pricingFloorIccProfilePath'),
    }),
  }]
}

function stripNullish(value: Record<string, string | null>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item != null && item !== ''),
  ) as Record<string, string>
}

// ---------------------------------------------------------------------------
// Coupons page (KAN-40 — gating P2-5, offline P1-3, sticky form P1-5)
// ---------------------------------------------------------------------------

/**
 * The "Create a new coupon" form, sticky-aware: when `sticky.submitted` is
 * present (a re-render after a failed submit) each field keeps the owner's
 * typed value and `sticky.fieldErrors` puts a message beside the offender.
 */
function renderCouponForm(
  uiToken: string | null | undefined,
  platformPrinters: PlatformPrinter[],
  sticky?: StickyForm,
) {
  const printerOptions = platformPrinters
    .map((p) => {
      const sel = stickyValue(sticky, 'printerId', '') === p.printerId ? ' selected' : ''
      return `<option value="${htmlEscape(p.printerId)}"${sel}>${htmlEscape(p.name)}</option>`
    })
    .join('')
  const errClass = (name: string) => (sticky?.fieldErrors?.[name] ? ' has-error' : '')
  const discountType = stickyValue(sticky, 'discountType', 'PERCENTAGE')
  const scope = stickyValue(sticky, 'couponScope', 'AGENT')
  const typeOption = (value: string, label: string) =>
    `<option value="${value}"${discountType === value ? ' selected' : ''}>${label}</option>`
  const scopeOption = (value: string, label: string) =>
    `<option value="${value}"${scope === value ? ' selected' : ''}>${label}</option>`

  return `
    <div class="card">
      <div class="card-title">Create a new coupon</div>
      <form method="post" action="/coupons/create" class="stack">
        ${hiddenUiToken(uiToken)}
        <div class="grid-2">
          <label class="${errClass('code').trim()}">
            <div class="label-text">Coupon code</div>
            <input type="text" name="code" value="${htmlEscape(stickyValue(sticky, 'code', ''))}"
              placeholder="SUMMER20" required style="text-transform:uppercase;" />
            <div class="hint">Customers type this exactly at checkout. Letters and numbers, no spaces.</div>
            ${fieldError(sticky, 'code')}
          </label>
          <label>
            <div class="label-text">Display name (optional)</div>
            <input type="text" name="name" value="${htmlEscape(stickyValue(sticky, 'name', ''))}" placeholder="Summer Sale 20%" />
          </label>
          <label>
            <div class="label-text">Discount type</div>
            <select name="discountType" required>
              ${typeOption('PERCENTAGE', 'Percentage off')}
              ${typeOption('FIXED_AMOUNT', 'Fixed amount off (in paise)')}
              ${typeOption('PER_PAGE_FIXED', 'Per-page discount (in paise)')}
            </select>
          </label>
          <label class="${errClass('discountValue').trim()}">
            <div class="label-text">Discount value</div>
            <input type="number" name="discountValue" min="1" value="${htmlEscape(stickyValue(sticky, 'discountValue', ''))}" placeholder="20" required />
            <div class="hint">Percentage: a number from 1 to 100. Fixed / per-page: an amount in paise (₹1 = 100 paise).</div>
            ${fieldError(sticky, 'discountValue')}
          </label>
          <label>
            <div class="label-text">Where it applies</div>
            <select name="couponScope" id="coupon-scope-select" required>
              ${scopeOption('AGENT', 'All my printers')}
              ${scopeOption('PRINTER', 'One specific printer only')}
            </select>
          </label>
          <label id="printer-select-label" class="${errClass('printerId').trim()}">
            <div class="label-text">Printer (when applying to one printer)</div>
            <select name="printerId">
              <option value="">— Select a printer —</option>
              ${printerOptions}
            </select>
            ${fieldError(sticky, 'printerId')}
          </label>
          <label>
            <div class="label-text">Starts on (optional)</div>
            <input type="date" name="startsAt" value="${htmlEscape(stickyValue(sticky, 'startsAt', ''))}" />
          </label>
          <label>
            <div class="label-text">Ends on (optional)</div>
            <input type="date" name="expiresAt" value="${htmlEscape(stickyValue(sticky, 'expiresAt', ''))}" />
          </label>
          <label>
            <div class="label-text">Total uses allowed (optional)</div>
            <input type="number" name="maxUses" min="1" value="${htmlEscape(stickyValue(sticky, 'maxUses', ''))}" placeholder="100" />
          </label>
          <label>
            <div class="label-text">Uses allowed per customer (optional)</div>
            <input type="number" name="maxUsesPerUser" min="1" value="${htmlEscape(stickyValue(sticky, 'maxUsesPerUser', ''))}" placeholder="1" />
          </label>
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">Create coupon</button>
        </div>
      </form>
    </div>
    <script>
      (function() {
        var scopeSelect = document.getElementById('coupon-scope-select');
        var printerLabel = document.getElementById('printer-select-label');
        function updatePrinterVisibility() {
          if (printerLabel) printerLabel.style.display = scopeSelect && scopeSelect.value === 'PRINTER' ? '' : 'none';
        }
        if (scopeSelect) { scopeSelect.addEventListener('change', updatePrinterVisibility); updatePrinterVisibility(); }
      })();
    </script>
  `
}

/**
/**
 * KAN-415 Agent Phase 1 (post-MVP) — extracted printers cards shared
 * by GET / (Dashboard) and the dedicated GET /printers page. Both
 * cards used to live inline in the Dashboard template; pulling them
 * into a helper lets the dedicated page reuse the exact same markup
 * + lets the Dashboard collapse them into a short summary + link.
 */
function renderPrintersPageCards(
  snapshot: ReturnType<AgentRuntime['snapshot']>,
): string {
  const profile = snapshot.profile
  const platformPrinters = snapshot.platformPrinters ?? []
  const sharedPrinterNames = snapshot.printers
    .filter((p) => p.shared)
    .map((p) => p.localPrinterName)
  return `
    <div class="card">
      <div class="card-title">Published platform printers</div>
      <p class="muted small">These are the customer-facing printers published from this machine.</p>
      ${profile?.selfServiceEnabled
        ? renderPlatformPrinterForm(snapshot.uiToken, sharedPrinterNames)
        : `<div class="alert alert-info" style="margin-top:12px;">Admin approval is required before this machine can publish or edit platform printers.</div>`}
      ${platformPrinters.length === 0
        ? `<div style="margin-top:12px;">${emptyState({
            title: 'No printers published to customers yet',
            text: profile?.selfServiceEnabled
              ? 'Use the form above to publish your first printer. Once published, customers can find and print to it.'
              : 'Once your machine is approved, publish a printer here so customers can find and print to it.',
            action: `<form method="post" action="/actions/refresh" class="js-pending-form">
              ${hiddenUiToken(snapshot.uiToken)}
              <button class="btn btn-secondary" type="submit" data-pending-text="Refreshing…">Refresh</button>
            </form>`,
          })}</div>`
        : ''}
      ${platformPrinters.length > 0
        ? `<div style="margin-top:16px;">
            ${platformPrinters
              .map(
                (printer) => `
                  <details>
                    <summary>
                      <span class="summary-row">
                        <span>${htmlEscape(printer.name)} · <span class="muted">${htmlEscape(printer.agentPrinterName)}</span></span>
                        <span class="${printer.enabled ? 'badge badge-good' : 'badge'}">${printer.enabled ? 'Enabled' : 'Disabled'}</span>
                      </span>
                    </summary>
                    <div class="muted small" style="margin-bottom:12px;">
                      Status: ${htmlEscape(humanizeEnum(printer.status))} ·
                      Base ${htmlEscape(formatMinor(printer.baseJobPriceMinor))} ·
                      Mono ${htmlEscape(formatMinor(printer.monochromePagePriceMinor))} ·
                      Color ${htmlEscape(formatMinor(printer.colorPagePriceMinor))} ·
                      Location: ${htmlEscape(printer.latitude != null && printer.longitude != null ? `${printer.latitude}, ${printer.longitude}` : 'Fallback pending')}
                    </div>
                    ${profile?.selfServiceEnabled
                      ? `
                        ${renderPlatformPrinterForm(snapshot.uiToken, sharedPrinterNames, printer)}
                        <form method="post" action="/platform-printers/remove" class="js-pending-form" style="margin-top:12px;">
                          ${hiddenUiToken(snapshot.uiToken)}
                          <input type="hidden" name="printerId" value="${htmlEscape(printer.printerId)}" />
                          <button class="btn btn-danger" type="submit" data-pending-text="Unpublishing…">Unpublish printer</button>
                        </form>
                      `
                      : `<div class="muted small">Editing is blocked until the agent is approved.</div>`}
                  </details>
                `,
              )
              .join('')}
          </div>`
        : ''}
    </div>

    <div class="card">
      <div class="card-title">Shared local printers</div>
      <p class="muted small">Only shared local printers can be published as customer-facing platform printers.</p>
      <table class="data-table" style="margin-top:12px;">
        <thead><tr><th>Printer</th><th>Capabilities</th><th>Action</th></tr></thead>
        <tbody>
          ${snapshot.printers.length === 0
            ? tableEmptyState({
                colspan: 3,
                title: 'No printers detected on this PC yet',
                text: 'Connect a printer to this computer and install its Windows driver, then refresh to detect it here.',
                action: `<form method="post" action="/actions/refresh" class="js-pending-form">
                  ${hiddenUiToken(snapshot.uiToken)}
                  <button class="btn btn-secondary" type="submit" data-pending-text="Refreshing…">Refresh printers</button>
                </form>`,
              })
            : snapshot.printers.map((printer) => `
            <tr>
              <td>
                <strong>${htmlEscape(printer.localPrinterName)}</strong><br/>
                <span class="muted small">${htmlEscape(printer.driverName ?? 'Unknown driver')} · ${htmlEscape(printer.connectionType)}</span>
              </td>
              <td class="muted small">
                ${printer.supportsColor ? 'Color' : 'Mono'} ·
                ${printer.supportsDuplex ? 'Duplex' : 'Single-sided'} ·
                ${htmlEscape(printer.supportedPaperSizes.join(', ') || 'Unknown sizes')}
              </td>
              <td>
                <form method="post" action="/printers/share" class="js-pending-form">
                  ${hiddenUiToken(snapshot.uiToken)}
                  <input type="hidden" name="localPrinterName" value="${htmlEscape(printer.localPrinterName)}" />
                  <input type="hidden" name="shared" value="${printer.shared ? 'false' : 'true'}" />
                  <button class="btn btn-secondary" type="submit" data-pending-text="Saving…">${printer.shared ? 'Stop sharing' : 'Share printer'}</button>
                </form>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`
}

/**
 * Build the full Coupons page content. Reused by GET /coupons and by the
 * POST /coupons/create handler when a submit fails validation, so the owner's
 * typed values are preserved (P1-5). Handles the gated state (P2-5) and a
 * cloud-fetch failure (P1-3) before ever rendering the create form.
 */
async function renderCouponsPageContent(
  runtime: AgentRuntime,
  snapshot: ReturnType<AgentRuntime['snapshot']>,
  sticky?: StickyForm,
): Promise<string> {
  const platformPrinters = snapshot.platformPrinters ?? []
  const gate = shouldGateCoupons(snapshot)

  const header = `
    <div>
      <div class="page-eyebrow">Promotions</div>
      <div class="page-title">Coupons</div>
    </div>`

  // P2-5: soft-disable the whole Coupons workflow until a platform printer
  // exists — a coupon would have nothing to apply to before then.
  if (gate.gated) {
    const gateBody =
      gate.reason === 'not-approved'
        ? emptyState({
            icon: '🔒',
            title: 'Coupons open up once your shop is approved',
            text: 'PrintAnywhere is still reviewing this shop. Once it is approved and you have published a printer, you can create discount coupons here.',
          })
        : emptyState({
            icon: '🎟',
            title: 'Publish a printer first, then create coupons',
            text: 'Coupons give customers a discount when they print at one of your printers. You have not published a printer yet — set one up on the dashboard, then come back here.',
            action: `<a class="btn btn-primary" href="/">Go to the dashboard</a>`,
          })
    return `
      ${header}
      ${stateBanner({
        variant: 'info',
        title: 'Coupons are not available yet',
        body:
          gate.reason === 'not-approved'
            ? 'This area unlocks after your shop is approved and has a published printer.'
            : 'This area unlocks once you publish your first printer.',
      })}
      <div class="card">${gateBody}</div>
    `
  }

  // Load the coupon list — a cloud failure renders the dedicated offline
  // banner (P1-3) instead of swallowing raw exception text into a cell.
  let couponsHtml = ''
  let couponsLoadError: unknown = null
  try {
    const coupons = await runtime.listCoupons()
    if (coupons.length === 0) {
      couponsHtml = tableEmptyState({
        colspan: 7,
        icon: '🎟',
        title: 'No coupons created yet',
        text: 'Use the form below to create your first coupon. Customers can then enter it at checkout for a discount at your printers.',
      })
    } else {
      couponsHtml = coupons
        .map(
          (coupon) => `
        <tr>
          <td><strong class="mono">${htmlEscape(coupon.code)}</strong>${coupon.name ? `<br/><span class="muted small">${htmlEscape(coupon.name)}</span>` : ''}</td>
          <td><span class="${coupon.active ? 'badge badge-good' : 'badge badge-bad'}">${coupon.active ? 'Active' : 'Inactive'}</span></td>
          <td>${htmlEscape(humanizeEnum(coupon.discountType))}<br/><strong>${htmlEscape(formatCouponValue(coupon.discountType, coupon.discountValue))}</strong></td>
          <td>${htmlEscape(humanizeEnum(coupon.couponScope))}</td>
          <td class="muted small">${coupon.usedCount} uses${coupon.maxUses ? ` / ${coupon.maxUses}` : ''}</td>
          <td class="muted small">${htmlEscape(formatTimestamp(coupon.expiresAt, 'No expiry'))}</td>
          <td>
            <form method="post" action="/coupons/toggle" class="js-pending-form" style="display:inline;">
              ${hiddenUiToken(snapshot.uiToken)}
              <input type="hidden" name="couponId" value="${htmlEscape(coupon.couponId)}" />
              <input type="hidden" name="active" value="${coupon.active ? 'false' : 'true'}" />
              <button class="btn btn-secondary" type="submit" style="font-size:12px; padding:5px 10px;"
                data-pending-text="${coupon.active ? 'Deactivating…' : 'Activating…'}">${coupon.active ? 'Deactivate' : 'Activate'}</button>
            </form>
          </td>
        </tr>
      `,
        )
        .join('')
    }
  } catch (error) {
    couponsLoadError = error
    couponsHtml = tableEmptyState({
      colspan: 7,
      icon: '⚠️',
      title: 'Your coupons could not be loaded',
      text: 'The agent could not reach the PrintAnywhere server to fetch your coupons. See the message above and press Retry.',
    })
  }

  return `
    ${header}
    ${couponsLoadError ? `<div style="margin-bottom:4px;">${renderOfflineBanner(couponsLoadError, '/coupons')}</div>` : ''}
    <div class="state-banner state-banner-info" role="status">
      <span class="state-banner-icon" aria-hidden="true">ℹ</span>
      <span class="state-banner-body">
        <span class="state-banner-title">Your coupons stay private to your shop</span>
        <span class="state-banner-text">They are not listed on the customer promotions page. A customer who knows the code can type it at checkout, and it is checked automatically at your printer.</span>
      </span>
    </div>
    <div class="card">
      <div class="card-title">Your coupons</div>
      <table class="data-table">
        <thead><tr><th>Code</th><th>Status</th><th>Discount</th><th>Applies to</th><th>Usage</th><th>Ends</th><th>Action</th></tr></thead>
        <tbody>${couponsHtml}</tbody>
      </table>
    </div>
    ${renderCouponForm(snapshot.uiToken, platformPrinters, sticky)}
  `
}

// ---------------------------------------------------------------------------
// Sticky-form value helper (KAN-40 scope #2 — UX review KAN-29 P1-5)
// ---------------------------------------------------------------------------
//
// On a validation error the forms used to redirect back to a snapshot,
// discarding everything the owner typed (painful on the ~12-field publish /
// config forms). The fix: on failure the POST handler re-renders the same
// page in-process, passing the submitted body + per-field error messages so
// each input keeps its value and shows its own error.

export interface StickyForm {
  /** The raw submitted body to prefer over stored values, when re-rendering. */
  submitted?: Record<string, unknown> | null
  /** Field-name -> plain-language error message, shown beside that field. */
  fieldErrors?: Record<string, string> | null
}

/**
 * Read a string field for a sticky re-render: prefer the owner's submitted
 * value, falling back to the stored/default value. Exported for testing.
 */
export function stickyValue(
  sticky: StickyForm | null | undefined,
  name: string,
  fallback: string | null | undefined,
): string {
  const submitted = sticky?.submitted
  if (submitted && Object.prototype.hasOwnProperty.call(submitted, name)) {
    const value = submitted[name]
    if (value != null) return String(value)
  }
  return fallback ?? ''
}

/**
 * True when a checkbox should render ticked on a sticky re-render.
 *
 * An unticked HTML checkbox is *absent* from the submitted body — so when a
 * submitted body exists at all (a re-render after a failed submit), an absent
 * checkbox means the owner left it unticked and must read `false`, NOT revert
 * to the stored fallback. The fallback applies only when there is no sticky
 * submission (a fresh GET render).
 */
export function stickyChecked(
  sticky: StickyForm | null | undefined,
  name: string,
  fallback: boolean,
): boolean {
  const submitted = sticky?.submitted
  if (submitted) {
    return String(submitted[name] ?? '') === 'on'
  }
  return fallback
}

/** Render an inline field-level error message, or '' when the field is OK. */
export function fieldError(sticky: StickyForm | null | undefined, name: string): string {
  const message = sticky?.fieldErrors?.[name]
  if (!message) return ''
  return `<div class="field-error" role="alert">${htmlEscape(message)}</div>`
}

/**
 * A focused "fix and resubmit" page rendered when a large form fails
 * validation. Rather than re-rendering the whole dashboard, the owner sees
 * just the offending form (sticky, with field errors) plus a clear lead
 * message and a "Back to dashboard" link — keeping them in correction mode.
 */
function renderFormErrorPage(opts: {
  eyebrow: string
  title: string
  lead: string
  leadVariant?: 'warning' | 'error'
  formHtml: string
  backHref: string
  backLabel: string
}): string {
  return `
    <div>
      <div class="page-eyebrow">${htmlEscape(opts.eyebrow)}</div>
      <div class="page-title">${htmlEscape(opts.title)}</div>
    </div>
    ${stateBanner({ variant: opts.leadVariant ?? 'error', title: opts.lead })}
    <div class="card">${opts.formHtml}</div>
    <div class="btn-row">
      <a class="btn btn-secondary" href="${htmlEscape(opts.backHref)}">${htmlEscape(opts.backLabel)}</a>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Route server
// ---------------------------------------------------------------------------

/**
 * Remove every previously-stored logo file from the branding directory.
 * Logo files are content-hash named, so on a replace/remove we sweep the
 * whole directory rather than tracking the exact old filename.
 */
async function clearBrandingDir(brandingDir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(brandingDir)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((name) => /^logo-[0-9a-f]+\.(png|jpg|svg)$/.test(name))
      .map((name) => unlink(path.join(brandingDir, name)).catch(() => {})),
  )
}

/**
 * Write a validated logo buffer to the branding directory under a content-
 * hashed filename and return the public `/branding/...` URL it is served at.
 * Any previously-stored logo is removed first.
 */
async function storeBrandingLogo(
  brandingDir: string,
  buffer: Buffer,
  ext: 'png' | 'jpg' | 'svg',
): Promise<string> {
  await clearBrandingDir(brandingDir)
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16)
  const fileName = `logo-${hash}.${ext}`
  await writeFile(path.join(brandingDir, fileName), buffer)
  return `/branding/${fileName}`
}

export async function startUiServer(runtime: AgentRuntime) {
  const app = express()

  // KAN-294: launcher config is needed both up here (for the dashboard
  // health banner) and below at server-bind time. Read it once and reuse.
  // The major-upgrade reset (KAN-294) runs before every read so a stale
  // `uiHost: "localhost"` from a prior major install does not silently
  // downgrade this release.
  const startupDataDir = runtime.dataDir
  try {
    resetLauncherConfigIfMajorUpgrade(startupDataDir, AGENT_VERSION)
  } catch (error) {
    console.warn('PrintAnywhere Agent UI: major-upgrade reset check failed:', error)
  }
  const startupLauncherConfig = readLauncherConfig(startupDataDir)

  app.use((_request, response, next) => {
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: https:; form-action 'self'",
    )
    next()
  })

  const assetsDir = path.resolve(__dirname, '../../assets')
  app.use('/assets', express.static(assetsDir))

  // KAN-40 P1-6: uploaded business logos are written to a writable runtime
  // directory (data/branding) — NOT assets/, which is packaged with the
  // release and is read-only in an installed agent. Served at /branding.
  const brandingDir = path.resolve(__dirname, '../../data/branding')
  await mkdir(brandingDir, { recursive: true })
  app.use(
    '/branding',
    express.static(brandingDir, {
      // Logo filenames are content-hashed, so a given file never changes.
      maxAge: '7d',
      setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
    }),
  )

  // multer holds the upload in memory so we can magic-byte validate the
  // buffer before ever writing it to disk. The hard cap is enforced here too.
  const logoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_LOGO_BYTES, files: 1 },
  })

  app.use(express.urlencoded({ extended: false }))

  // ── Health (JSON, no page shell) ──────────────────────────────────────────
  app.get('/health', (_request, response) => {
    const snapshot = runtime.snapshot()
    const registered = !!snapshot.registration?.agentId
    const lastHeartbeatAt = snapshot.lastHeartbeatAt ?? null
    const connection = computeConnectionState({ registered, lastHeartbeatAt })
    const firstRun = computeFirstRunStage(snapshot)
    response.json({
      status: 'UP',
      version: AGENT_VERSION,
      registered,
      // First-run pairing visibility — the awaiting-pairing screen polls
      // this to auto-reload once the admin completes pairing (KAN-37).
      firstRunStage: firstRun.stage,
      pairingComplete: firstRun.stage === 'paired',
      agentStatus: snapshot.registration?.status ?? null,
      completedToday: snapshot.stats?.completedJobsToday ?? 0,
      failedToday: snapshot.stats?.failedJobsToday ?? 0,
      activeJobs: snapshot.stats?.activeJobCount ?? 0,
      lastError: snapshot.lastError ?? null,
      // Heartbeat / connection visibility — consumed by the header
      // connection pill's client-side poll (KAN-36 theme 3, P0-3).
      lastHeartbeatAt,
      heartbeatStaleThresholdMs: HEARTBEAT_STALE_THRESHOLD_MS,
      connection,
    })
  })

  // ── Dashboard ─────────────────────────────────────────────────────────────
  app.get('/', (request, response) => {
    const snapshot = runtime.snapshot()
    const notice = typeof request.query.notice === 'string' ? request.query.notice : null
    const errorMessage = typeof request.query.error === 'string' ? request.query.error : null
    // KAN-39 scope #2: classify the pickup-code search so the page can show an
    // explicit verified / not-found outcome rather than a silently-filtered
    // table. `pickupSearch` is the result of the pure classifier helper.
    const rawPickupQuery = typeof request.query.pickupCode === 'string' ? request.query.pickupCode : ''
    const pickupSearch = classifyPickupSearch(snapshot.readyForPickup, rawPickupQuery)
    const readyForPickup = pickupSearch.matches
    const sharedPrinterNames = snapshot.printers.filter((printer) => printer.shared).map((printer) => printer.localPrinterName)
    const profile = snapshot.profile
    const platformPrinters = snapshot.platformPrinters ?? []
    const hostLocation = snapshot.hostLocation ?? null
    const configuredServerUrl = snapshot.serverUrl ?? defaultPrintAnywhereBackendUrl()
    const isRegistered = !!snapshot.registration?.agentId

    // KAN-37: a brand-new owner should not see ~8 operator cards (pricing in
    // paise, ICC profile paths, …) before pairing. Branch on the first-run
    // stage and render a focused, guided pairing screen until pairing is done.
    const firstRun = computeFirstRunStage(snapshot)
    if (firstRun.isFirstRun) {
      const firstRunContent = renderFirstRunScreen(snapshot, firstRun, configuredServerUrl)
      response.type('html').send(
        pageShell({ title: 'Set up', activePage: 'dashboard', snapshot, notice, error: errorMessage }, firstRunContent),
      )
      return
    }

    // KAN-40 P1-8: a prominent, plain-language banner for pending / suspended /
    // revoked machines. Only shown on the paired dashboard — the first-run
    // screen is already a focused experience and carries its own messaging.
    const lifecycleBanner = selectLifecycleBanner(profile)

    // KAN-294: loud-fallback banner — when the launcher is configured to use
    // the `local.printanywhere.dhruvantasystems.com` domain but the
    // underlying support (hosts entry, per-host cert) is missing, surface a
    // prominent banner with a "Repair local URL setup" button so the
    // operator never has to wonder why the URL is wrong.
    const domainHealth = evaluateLocalUiDomainHealth({
      dataDir: startupDataDir,
      uiHost: startupLauncherConfig.uiHost,
    })

    const content = `
      <div>
        <div class="page-eyebrow">Agent console</div>
        <div class="page-title">Dashboard</div>
      </div>
      ${lifecycleBanner
        ? `<div id="lifecycle-banner">${stateBanner({
            variant: lifecycleBanner.variant,
            title: lifecycleBanner.title,
            body: lifecycleBanner.body,
          })}</div>`
        : ''}
      ${!domainHealth.ok
        ? `<div id="local-https-banner" class="state-banner state-banner-warning" role="status" aria-live="polite">
            <span class="state-banner-icon" aria-hidden="true">⚠</span>
            <span class="state-banner-body">
              <span class="state-banner-title">Local domain not configured</span>
              <span class="state-banner-text">${htmlEscape(domainHealth.reason)}</span>
              <form method="post" action="/actions/repair-local-https" class="js-pending-form" style="margin-top:8px;">
                ${hiddenUiToken(snapshot.uiToken)}
                <button type="submit" class="btn btn-primary">Repair local URL setup</button>
              </form>
            </span>
          </div>`
        : ''}

      ${renderAgentHealthBanner({
        connection: computeConnectionState({
          registered: !!snapshot.registration?.agentId,
          lastHeartbeatAt: snapshot.lastHeartbeatAt ?? null,
        }),
        lastError: snapshot.lastError ?? null,
        lastHeartbeatLabel: formatTimestamp(snapshot.lastHeartbeatAt),
        lastJobLabel: snapshot.lastJob
          ? `${snapshot.lastJob.jobId} · ${humanizeEnum(snapshot.lastJob.status)}`
          : 'None',
      })}

      <div class="card">
        <div class="card-title">Today's activity</div>
        <p class="muted small" style="margin-bottom:var(--space-3);">
          A quick count of jobs that have come through this machine today.
        </p>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Active jobs</div>
            <div class="stat-value">${snapshot.stats?.activeJobCount ?? 0}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Completed today</div>
            <div class="stat-value">${snapshot.stats?.completedJobsToday ?? 0}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Failed today</div>
            <div class="stat-value">${snapshot.stats?.failedJobsToday ?? 0}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Backend configuration</div>
        <form method="post" action="/configure" class="stack js-pending-form js-dirty-aware" id="configure-form">
          ${hiddenUiToken(snapshot.uiToken)}
          <input type="hidden" name="latitude" id="configure-location-latitude" />
          <input type="hidden" name="longitude" id="configure-location-longitude" />
          <input type="hidden" name="accuracyMeters" id="configure-location-accuracy" />
          <input type="hidden" name="capturedAt" id="configure-location-captured-at" />
          <!-- Save never silently prompts for geolocation. The owner shares
               location only via the explicit button below (KAN-38, mirrors
               the KAN-37 first-run fix). -->
          <div class="field-group">
            <div class="field-group-title">Cloud connection</div>
            <label>
              <div class="label-text">PrintAnywhere server URL</div>
              <input type="url" name="serverUrl" value="${htmlEscape(configuredServerUrl)}" placeholder="${htmlEscape(defaultPrintAnywhereBackendUrl())}" required />
              <div class="hint">Production default is prefilled. Change only for a local test backend or support-directed override.</div>
            </label>
          </div>
          <div class="field-group">
            <div class="field-group-title">Shop identity</div>
            <p class="field-group-help">How this machine appears to your platform admin in the PrintAnywhere console.</p>
            <div class="grid-2">
              <label>
                <div class="label-text">Display name</div>
                <input type="text" name="displayName" value="${htmlEscape(snapshot.displayName ?? '')}" placeholder="Counter PC - Front Desk" />
                <div class="hint">A short label so the admin can tell your machines apart.</div>
              </label>
              <label>
                <div class="label-text">Business address for admin review</div>
                <input type="text" name="reportedBusinessAddress" value="${htmlEscape(snapshot.reportedBusinessAddress ?? profile?.reportedBusinessAddress ?? '')}" placeholder="Shop number, street, city, state" />
                <div class="hint">Used during onboarding to verify the shop location.</div>
              </label>
            </div>
          </div>
          <div class="field-group">
            <div class="field-group-title">Shop location</div>
            <div class="loc-explainer">
              <div class="step-title" style="font-size:var(--text-base);">Update this shop's location (optional)</div>
              <p class="muted small" style="margin-top:4px; line-height:1.6;">
                Saving these settings will <strong>not</strong> ask for your location. If your shop
                has moved or its location was never set, click below — your browser will then ask
                for permission, and the new location is sent on the next sync.
              </p>
              <div class="btn-row" style="margin-top:10px;">
                <button class="btn btn-secondary" type="button" id="paired-location-button">Share device location</button>
                <span class="muted small" id="paired-location-status"></span>
              </div>
            </div>
          </div>
          ${isRegistered ? `<div class="hint">This machine is already registered. Saving updates local settings and sends the latest address/location on the next heartbeat; it does not create another machine.</div>` : ''}
          <div class="btn-row">
            <button class="btn btn-primary" type="submit" data-pending-text="Saving…" data-dirty-required>${isRegistered ? 'Save settings' : 'Save and register'}</button>
          </div>
        </form>
      </div>

      <div class="card">
        <div class="card-row">
          <div class="card-title" style="margin-bottom:0;">Branding</div>
          <a class="card-link" href="/settings">Open settings →</a>
        </div>
        <p class="muted small" style="margin-top:6px;">
          Customer-facing logo and white-label settings now live on the dedicated
          <a href="/settings">Settings page</a>.
        </p>
      </div>

      <div class="card">
        <div class="card-title">Registration &amp; approval</div>
        <div class="grid-2">
          <div>
            <div class="muted small">Machine ID</div>
            <div style="margin-top:3px;">${htmlEscape(snapshot.identity?.machineId ?? 'Not initialized')}</div>
            <div class="muted small" style="margin-top:12px;">Registration status</div>
            <div style="margin-top:3px;"><span class="badge">${htmlEscape(profile?.registrationStatus ?? snapshot.registration?.status ?? 'Not registered')}</span></div>
            <div class="muted small" style="margin-top:12px;">Approval</div>
            <div style="margin-top:3px;"><span class="${approvalTone(profile?.approvalStatus)}">${htmlEscape(humanizeEnum(profile?.approvalStatus ?? 'PENDING_REVIEW'))}</span></div>
            <div class="muted small" style="margin-top:12px;">Self-service printer management</div>
            <div style="margin-top:3px;">${profile?.selfServiceEnabled ? 'Enabled' : 'Blocked until admin approval'}</div>
          </div>
          <div>
            <div class="muted small">Verified business name</div>
            <div style="margin-top:3px;">${htmlEscape(profile?.businessName ?? 'Pending admin review')}</div>
            <div class="muted small" style="margin-top:12px;">Verified address</div>
            <div style="margin-top:3px;">${htmlEscape(profile?.businessAddress ?? 'Pending admin review')}</div>
            <div class="muted small" style="margin-top:12px;">Approved at</div>
            <div style="margin-top:3px;">${htmlEscape(formatTimestamp(profile?.approvedAt, 'Not approved'))}</div>
          </div>
        </div>
        <div class="subsection" style="margin-top:14px; padding-top:14px;">
          <div class="muted small">Pairing code</div>
          <div class="mono" style="font-size:20px; letter-spacing:.15em; margin-top:4px;">${htmlEscape(snapshot.registration?.pairingCode ?? '—')}</div>
          <div class="muted small" style="margin-top:4px;">Expires: ${htmlEscape(snapshot.registration?.pairingCodeExpiresAt ?? '—')}</div>
          <div class="btn-row" style="margin-top:12px;">
            <form method="post" action="/actions/repair" class="js-pending-form">
              ${hiddenUiToken(snapshot.uiToken)}
              <button class="btn btn-secondary" type="submit" data-pending-text="Generating…">Generate new pairing code</button>
            </form>
            <form method="post" action="/actions/refresh" class="js-pending-form">
              ${hiddenUiToken(snapshot.uiToken)}
              <button class="btn btn-secondary" type="submit" data-pending-text="Refreshing…">Refresh printers</button>
            </form>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Host location</div>
        <div class="muted small">${htmlEscape(formatLocationSnapshot(hostLocation))}</div>
        <form method="post" action="/location/browser" id="host-location-form" class="btn-row" style="margin-top:12px;">
          ${hiddenUiToken(snapshot.uiToken)}
          <input type="hidden" name="latitude" id="host-location-latitude" />
          <input type="hidden" name="longitude" id="host-location-longitude" />
          <input type="hidden" name="accuracyMeters" id="host-location-accuracy" />
          <input type="hidden" name="capturedAt" id="host-location-captured-at" />
          <button class="btn btn-secondary" type="button" id="host-location-button">Use this device location</button>
          <span class="muted small" id="host-location-status"></span>
        </form>
      </div>

      <div class="card">
        <div class="card-title">Verify a pickup code</div>
        <p class="muted small" style="margin-top:-4px;">
          A customer collecting a finished print reads you their pickup code. Enter it
          here to confirm the job is ready, then hand over the prints and mark it collected.
        </p>
        <form method="get" action="/" class="inline-form js-pending-form" style="margin:14px 0 4px;">
          <label>
            <div class="label-text">Pickup code from the customer</div>
            <input type="text" name="pickupCode" value="${htmlEscape(pickupSearch.query)}"
              placeholder="e.g. 7F3K2" autocomplete="off" autocapitalize="characters"
              style="width:220px; text-transform:uppercase; letter-spacing:.12em;" />
          </label>
          <button class="btn btn-primary" type="submit" data-pending-text="Checking…">Verify code</button>
          ${pickupSearch.status !== 'idle'
            ? `<a class="btn btn-secondary" href="/">Clear</a>`
            : ''}
        </form>
        ${pickupSearch.status === 'match'
          ? `<div style="margin:12px 0;">${stateBanner({
              variant: 'success',
              title: `Code ${pickupSearch.query} is valid — ${readyForPickup.length} ${readyForPickup.length === 1 ? 'job is' : 'jobs are'} ready`,
              body: 'Check the customer details below, hand over the prints, then press "Mark collected".',
            })}</div>`
          : ''}
        ${pickupSearch.status === 'no-match'
          ? `<div style="margin:12px 0;">${stateBanner({
              variant: 'warning',
              title: `No ready job matches code ${pickupSearch.query}`,
              body: 'Ask the customer to read the code again. It may have been mistyped, already collected, or the print may still be in progress — check the orders list.',
            })}</div>`
          : ''}
        <div class="subsection" style="margin-top:14px; padding-top:14px;">
          <div class="muted small" style="margin-bottom:10px;">
            ${pickupSearch.status === 'idle'
              ? 'All jobs waiting for secure pickup'
              : `Showing jobs that match "${htmlEscape(pickupSearch.query)}"`}
          </div>
          <table class="data-table">
            <thead><tr><th>Pickup code</th><th>Customer</th><th>Printer</th><th>Completed</th><th>Action</th></tr></thead>
            <tbody>
              ${readyForPickup.length === 0
                ? (pickupSearch.status === 'idle'
                    ? tableEmptyState({
                        colspan: 5,
                        icon: '✅',
                        title: 'No jobs are waiting for pickup',
                        text: 'When a customer’s secure print finishes, it will appear here with its pickup code.',
                      })
                    : `<tr><td colspan="5" class="muted">No ready job matches that pickup code.</td></tr>`)
                : readyForPickup.map((job) => `
                  <tr>
                    <td>
                      <strong class="pickup-code">${htmlEscape(job.pickupCode)}</strong><br/>
                      <span class="muted small">${htmlEscape(job.jobId)}</span>
                    </td>
                    <td>
                      ${htmlEscape(job.displayName ?? 'Anonymous pickup')}<br/>
                      <span class="muted small">${htmlEscape(job.pageCount ? `${job.pageCount} pages` : '')}</span>
                    </td>
                    <td>${htmlEscape(job.printerName)}</td>
                    <td class="muted small">${htmlEscape(formatTimestamp(job.completedAt))}</td>
                    <td>
                      <form method="post" action="/jobs/collect" class="js-pending-form">
                        ${hiddenUiToken(snapshot.uiToken)}
                        <input type="hidden" name="jobId" value="${htmlEscape(job.jobId)}" />
                        <button class="btn btn-primary" type="submit" data-pending-text="Marking…">Mark collected</button>
                      </form>
                    </td>
                  </tr>
                `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-row">
          <div class="card-title" style="margin-bottom:0;">Printers</div>
          <a class="card-link" href="/printers">Manage printers →</a>
        </div>
        <p class="muted small" style="margin-top:6px;">
          ${platformPrinters.length} published platform printer${platformPrinters.length === 1 ? '' : 's'} ·
          ${sharedPrinterNames.length} shared local printer${sharedPrinterNames.length === 1 ? '' : 's'} ·
          ${snapshot.printers.length} detected on this PC.
          Open the <a href="/printers">Printers page</a> to share local printers, publish customer-facing platform printers, and edit pricing.
        </p>
      </div>

      ${(() => {
        // KAN-39 P2-1: compact recent-activity preview. The full, authoritative
        // job list lives at /orders — this card shows only the latest few items
        // and links there. Columns/terminology are kept aligned with /orders so
        // it is obviously the same data at a lower fidelity.
        const recentJobs = snapshot.recentJobs ?? []
        const preview = selectRecentJobsPreview(recentJobs)
        return `
      <div class="card">
        <div class="card-row">
          <div class="card-title" style="margin-bottom:0;">Recent activity</div>
          <a class="card-link" href="/orders">View all orders →</a>
        </div>
        <p class="muted small" style="margin-top:6px;">
          The latest jobs at your printers. The
          <a href="/orders">Orders page</a> has the full, complete history.
        </p>
        <table class="data-table" style="margin-top:10px;">
          <thead><tr><th>Job</th><th>Printer</th><th>Status</th><th>Customer</th><th>Updated</th></tr></thead>
          <tbody>
            ${preview.length === 0
              ? tableEmptyState({
                  colspan: 5,
                  icon: '🖨',
                  title: 'No jobs have run yet',
                  text: 'Once a customer prints to one of your published printers, the most recent jobs will appear here.',
                })
              : preview.map((job) => `
                <tr>
                  <td class="mono small">${htmlEscape(job.jobId.slice(0, 8))}…</td>
                  <td>${htmlEscape(job.printerName)}</td>
                  <td><span class="${statusBadge(job.status)}">${htmlEscape(humanizeEnum(job.status))}</span></td>
                  <td>
                    ${job.displayName ? htmlEscape(job.displayName) : '<span class="muted">—</span>'}
                    ${job.pickupCode ? `<br/><span class="pickup-code" style="font-size:13px;">${htmlEscape(job.pickupCode)}</span>` : ''}
                    ${job.failureReason ? `<br/><span class="muted small">${htmlEscape(job.failureReason)}</span>` : ''}
                  </td>
                  <td class="muted small">${htmlEscape(formatTimestamp(job.updatedAt))}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
        ${recentJobs.length > preview.length
          ? `<div class="muted small" style="margin-top:12px;">
              Showing the ${preview.length} most recent jobs.
              <a href="/orders">View all orders →</a>
            </div>`
          : ''}
      </div>`
      })()}
    `

    response.type('html').send(pageShell({ title: 'Dashboard', activePage: 'dashboard', snapshot, notice, error: errorMessage }, content))
  })

  // ── Printers ──────────────────────────────────────────────────────────────
  // KAN-415 Agent Phase 1 — printers used to live as two cards inside
  // the Dashboard, mixed with status/health/pickup/orders content. On
  // their own page the operator can focus on the publish + share
  // workflow without competing for screen real-estate.
  app.get('/printers', (request, response) => {
    const snapshot = runtime.snapshot()
    const notice = typeof request.query.notice === 'string' ? request.query.notice : null
    const errorMessage = typeof request.query.error === 'string' ? request.query.error : null

    const content = `
      <div>
        <div class="page-eyebrow">Operate</div>
        <div class="page-title">Printers</div>
        <p class="page-subtitle">Share local printers and publish customer-facing platform printers from this machine.</p>
      </div>
      ${renderPrintersPageCards(snapshot)}
    `
    response.type('html').send(
      pageShell({ title: 'Printers', activePage: 'printers', snapshot, notice, error: errorMessage }, content),
    )
  })

  // ── Setup (Backend configuration) ─────────────────────────────────────────
  // KAN-415 Agent Phase 1 — dedicated page for backend URL + shop details.
  // Lifts the configure-form card out of the Dashboard so first-time setup
  // has a clear destination from the left-nav. POST /configure still
  // handles persistence; this page just renders the form.
  // ── Settings (branding + logo) ────────────────────────────────────────────
  // Extracted from the Dashboard so the branding workflow has a clear
  // destination from the left nav. POST handlers (/settings/branding,
  // /settings/logo, /settings/logo/remove) are unchanged.
  app.get('/settings', (request, response) => {
    const snapshot = runtime.snapshot()
    const notice = typeof request.query.notice === 'string' ? request.query.notice : null
    const errorMessage = typeof request.query.error === 'string' ? request.query.error : null

    const content = `
      <div>
        <div class="page-eyebrow">Operate</div>
        <div class="page-title">Settings</div>
        <p class="page-subtitle">Customer-facing branding and white-label settings for this machine.</p>
      </div>
      ${renderBrandingCard(snapshot)}
    `
    response.type('html').send(
      pageShell({ title: 'Settings', activePage: 'settings', snapshot, notice, error: errorMessage }, content),
    )
  })

  // ── Staff login (Phase 1.5a) ─────────────────────────────────────────────
  // Operator signs into the local Agent UI as a PA staff user. Sessions
  // are local-only today (1.5a) — page gating + upstream-call use
  // ride on 1.5b. The token is stored encrypted at rest with the
  // per-machine key.
  app.get('/login', (request, response) => {
    const snapshot = runtime.snapshot()
    const notice = typeof request.query.notice === 'string' ? request.query.notice : null
    const errorMessage = typeof request.query.error === 'string' ? request.query.error : null
    const identity = runtime.staffIdentity()
    const content = `
      <div>
        <div class="page-eyebrow">Account</div>
        <div class="page-title">Staff sign-in</div>
        <p class="page-subtitle">Sign in as a PrintAnywhere staff user (store owner, store worker, sales, support). Today this is a local-only sign-in; page-level capability gating ships in the next slice.</p>
      </div>
      ${identity ? `
        <div class="card">
          <div class="card-title">Signed in</div>
          <p>${htmlEscape(identity.email)} &middot; roles: ${htmlEscape(identity.roles.join(', ') || 'none')}</p>
          <p class="muted small">Session expires ${htmlEscape(formatTimestamp(identity.expiresAt))}.</p>
          <form method="post" action="/logout" class="js-pending-form" style="margin-top:10px;">
            ${hiddenUiToken(snapshot.uiToken)}
            <button type="submit" class="btn btn-secondary">Sign out</button>
          </form>
        </div>
      ` : `
        <div class="card">
          <div class="card-title">Sign in</div>
          <form method="post" action="/login" class="stack js-pending-form">
            ${hiddenUiToken(snapshot.uiToken)}
            <label>
              <div class="label-text">Email</div>
              <input type="email" name="email" required autocomplete="username" />
            </label>
            <label>
              <div class="label-text">Password</div>
              <input type="password" name="password" required autocomplete="current-password" />
            </label>
            <label>
              <div class="label-text">TOTP code (if you have one enrolled)</div>
              <input type="text" name="totp" inputmode="numeric" autocomplete="one-time-code" />
              <div class="hint">Leave blank if you do not have TOTP enrolled.</div>
            </label>
            <div class="btn-row">
              <button class="btn btn-primary" type="submit" data-pending-text="Signing in…">Sign in</button>
            </div>
          </form>
        </div>
      `}
    `
    response.type('html').send(
      pageShell({ title: 'Staff sign-in', activePage: 'login', snapshot, notice, error: errorMessage }, content),
    )
  })

  app.post('/login', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    const body = request.body as Record<string, unknown>
    const email = String(body.email ?? '').trim()
    const password = String(body.password ?? '')
    const totp = body.totp ? String(body.totp).trim() : null
    if (!email || !password) {
      redirectWithStatus(response, 'error', 'Enter your email and password.', '/login')
      return
    }
    try {
      await runtime.signInStaff(email, password, totp || null)
      redirectWithStatus(response, 'notice', 'Signed in.', '/login')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sign in failed.'
      redirectWithStatus(response, 'error', message, '/login')
    }
  })

  app.post('/logout', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    await runtime.signOutStaff()
    redirectWithStatus(response, 'notice', 'Signed out.', '/login')
  })

  app.get('/setup', (request, response) => {
    const snapshot = runtime.snapshot()
    const notice = typeof request.query.notice === 'string' ? request.query.notice : null
    const errorMessage = typeof request.query.error === 'string' ? request.query.error : null
    const configuredServerUrl = snapshot.serverUrl ?? defaultPrintAnywhereBackendUrl()
    const isRegistered = !!snapshot.registration?.agentId

    const content = `
      <div>
        <div class="page-eyebrow">Get started</div>
        <div class="page-title">Backend configuration</div>
        <p class="page-subtitle">Point this PC at the PrintAnywhere backend and give it a friendly name so the platform admin can recognise it.</p>
      </div>
      <div class="card">
        ${renderConfigureForm(snapshot, configuredServerUrl)}
      </div>
      ${
        isRegistered
          ? `<div class="card">
              <div class="card-title">Next step</div>
              <p>This PC is already registered with the backend. Head to <a href="/registration">Registration &amp; approval</a> to see your approval status, or to <a href="/">Dashboard</a> for live operations.</p>
            </div>`
          : `<div class="card">
              <div class="card-title">Next step</div>
              <p>Once you save your shop details, the agent will register itself with the backend and produce a pairing code. Open <a href="/registration">Registration &amp; approval</a> to complete pairing.</p>
            </div>`
      }
    `
    response.type('html').send(
      pageShell({ title: 'Backend configuration', activePage: 'setup', snapshot, notice, error: errorMessage }, content),
    )
  })

  // ── Registration & approval ───────────────────────────────────────────────
  // KAN-415 Agent Phase 1 — dedicated page that surfaces the pairing
  // QR/code and the current approval lifecycle (pending / approved /
  // suspended / revoked). The dashboard kept showing this material
  // alongside ops cards which was visually noisy for a first-run owner.
  app.get('/registration', (request, response) => {
    const snapshot = runtime.snapshot()
    const notice = typeof request.query.notice === 'string' ? request.query.notice : null
    const errorMessage = typeof request.query.error === 'string' ? request.query.error : null
    const configuredServerUrl = snapshot.serverUrl ?? defaultPrintAnywhereBackendUrl()
    const profile = snapshot.profile
    const lifecycleBanner = selectLifecycleBanner(profile)
    const isConfigured = !!snapshot.serverUrl
    const isPaired = !!snapshot.registration?.agentId

    const lifecycleHtml = lifecycleBanner
      ? `<div id="lifecycle-banner">${stateBanner({
          variant: lifecycleBanner.variant,
          title: lifecycleBanner.title,
          body: lifecycleBanner.body,
        })}</div>`
      : ''

    let body: string
    if (!isConfigured) {
      body = `
        <div class="card">
          <div class="card-title">Configure the backend first</div>
          <p>Before this PC can pair with the platform, set the PrintAnywhere server address and your shop name. Open <a href="/setup">Backend configuration</a>.</p>
        </div>`
    } else if (!isPaired) {
      body = `
        ${lifecycleHtml}
        ${renderPairingHero({
          pairingCode: snapshot.registration?.pairingCode ?? null,
          pairingCodeExpiresAt: snapshot.registration?.pairingCodeExpiresAt ?? null,
        })}
        ${renderTrustPanel()}`
    } else {
      body = `
        ${lifecycleHtml}
        <div class="card">
          <div class="card-title">Pairing details</div>
          <ul class="kv">
            <li><span>Status</span><strong>${htmlEscape(profile?.approvalStatus ?? 'unknown')}</strong></li>
            <li><span>Agent ID</span><strong>${htmlEscape(snapshot.registration?.agentId ?? '—')}</strong></li>
            <li><span>Backend URL</span><strong>${htmlEscape(configuredServerUrl)}</strong></li>
            ${profile?.approvedAt ? `<li><span>Approved</span><strong>${htmlEscape(profile.approvedAt)}</strong></li>` : ''}
          </ul>
          <p style="margin-top:12px">If your platform admin needs to re-pair this PC, contact <a href="/support">Support</a>.</p>
        </div>`
    }

    const content = `
      <div>
        <div class="page-eyebrow">Get started</div>
        <div class="page-title">Registration &amp; approval</div>
        <p class="page-subtitle">Pair this PC with the platform admin and track your shop's approval status.</p>
      </div>
      ${body}
    `
    response.type('html').send(
      pageShell({ title: 'Registration & approval', activePage: 'registration', snapshot, notice, error: errorMessage }, content),
    )
  })

  // ── Orders ────────────────────────────────────────────────────────────────
  // KAN-39 P2-1: this is the single AUTHORITATIVE, full job list. The dashboard
  // "Recent activity" card is only a compact preview that links here. Columns
  // and terminology are kept aligned with that preview (Job / Printer / Status
  // / Customer / Updated) so they read as the same data at two fidelities.
  app.get('/orders', async (request, response) => {
    const snapshot = runtime.snapshot()
    const notice = typeof request.query.notice === 'string' ? request.query.notice : null
    const errorMessage = typeof request.query.error === 'string' ? request.query.error : null

    let ordersHtml = ''
    let orderCount = 0
    // KAN-40 P1-3: a backend failure is no longer swallowed into a muted cell
    // of raw exception text. `loadError` holds the raw thrown value so the
    // page can render the dedicated offline banner via mapCloudError.
    let loadError: unknown = null
    try {
      const orders = await runtime.listOrders()
      orderCount = orders.length
      if (orders.length === 0) {
        ordersHtml = tableEmptyState({
          colspan: 7,
          icon: '🖨',
          title: 'No orders have been received yet',
          text: 'When a customer prints to one of your published printers, every job will be listed here with its status and pickup code.',
        })
      } else {
        ordersHtml = orders.map((order) => `
          <tr>
            <td class="mono small">${htmlEscape(order.jobId.slice(0, 8))}…</td>
            <td>${htmlEscape(order.printerName)}</td>
            <td><span class="${statusBadge(order.status)}">${htmlEscape(humanizeEnum(order.status))}</span></td>
            <td>
              ${order.displayName ? htmlEscape(order.displayName) : '<span class="muted">—</span>'}
              ${order.pickupCode ? `<br/><span class="pickup-code" style="font-size:13px;">${htmlEscape(order.pickupCode)}</span>` : ''}
              ${order.failureReason ? `<br/><span class="muted small">${htmlEscape(order.failureReason)}</span>` : ''}
            </td>
            <td class="muted small">${order.pageCount} pages</td>
            <td class="muted small">${htmlEscape(formatTimestamp(order.queuedAt))}</td>
            <td class="muted small">${htmlEscape(formatTimestamp(order.completedAt ?? order.collectedAt ?? order.failedAt, '—'))}</td>
          </tr>
        `).join('')
      }
    } catch (error) {
      loadError = error
      ordersHtml = tableEmptyState({
        colspan: 7,
        icon: '⚠️',
        title: 'The orders list could not be loaded',
        text: 'The agent could not reach the PrintAnywhere server to fetch your orders. See the message above and press Retry.',
      })
    }

    const content = `
      <div class="card-row">
        <div>
          <div class="page-eyebrow">Print jobs</div>
          <div class="page-title">Orders</div>
        </div>
        <form method="post" action="/actions/refresh" class="js-pending-form">
          ${hiddenUiToken(snapshot.uiToken)}
          <button class="btn btn-secondary" type="submit" data-pending-text="Refreshing…">Refresh</button>
        </form>
      </div>
      ${loadError
        ? `<div style="margin-bottom:14px;">${renderOfflineBanner(loadError, '/orders')}</div>`
        : ''}
      <div class="card">
        <div class="card-row">
          <div class="card-title" style="margin-bottom:0;">All orders received at your printers</div>
          ${orderCount > 0 ? `<span class="muted small">${orderCount} ${orderCount === 1 ? 'order' : 'orders'}</span>` : ''}
        </div>
        <p class="muted small" style="margin-top:6px; margin-bottom:12px;">
          This is the complete, authoritative list of every print job. The dashboard shows only the most recent few.
        </p>
        <table class="data-table">
          <thead><tr><th>Job</th><th>Printer</th><th>Status</th><th>Customer</th><th>Pages</th><th>Queued</th><th>Finished</th></tr></thead>
          <tbody>${ordersHtml}</tbody>
        </table>
      </div>
    `

    response.type('html').send(pageShell({ title: 'Orders', activePage: 'orders', snapshot, notice, error: errorMessage }, content))
  })

  // ── Coupons ───────────────────────────────────────────────────────────────
  app.get('/coupons', async (request, response) => {
    const snapshot = runtime.snapshot()
    const notice = typeof request.query.notice === 'string' ? request.query.notice : null
    const errorMessage = typeof request.query.error === 'string' ? request.query.error : null
    const content = await renderCouponsPageContent(runtime, snapshot)
    response.type('html').send(pageShell({ title: 'Coupons', activePage: 'coupons', snapshot, notice, error: errorMessage }, content))
  })

  // ── Help / FAQ ────────────────────────────────────────────────────────────
  app.get('/help', (request, response) => {
    const snapshot = runtime.snapshot()
    const notice = typeof request.query.notice === 'string' ? request.query.notice : null
    const errorMessage = typeof request.query.error === 'string' ? request.query.error : null

    const content = `
      <div>
        <div class="page-eyebrow">Documentation</div>
        <div class="page-title">Help &amp; FAQ</div>
      </div>

      <div class="card">
        <div class="card-title">Getting started</div>
        <details class="faq-section" open>
          <summary>What is the PrintAnywhere Agent?</summary>
          <div class="faq-a" style="margin-top:10px;">
            <p>The PrintAnywhere Agent is a background service that runs on your print shop's computer. It connects your local printers to the PrintAnywhere cloud platform, allowing customers to send print jobs remotely and collect them in-store.</p>
            <p>This console (the page you're reading now) lets you manage your printers, view orders, and configure your agent — all without needing to log into a separate web portal.</p>
          </div>
        </details>
        <details class="faq-section">
          <summary>How do I register this machine?</summary>
          <div class="faq-a" style="margin-top:10px;">
            <p>Go to the <a href="/">Dashboard</a> and fill in the server URL and display name, then click "Save and register". The agent will register automatically and generate a pairing code.</p>
            <p>Share the pairing code with your PrintAnywhere administrator so they can approve your machine. You will not be able to publish printers until your machine is approved.</p>
          </div>
        </details>
        <details class="faq-section">
          <summary>How do I publish a printer to customers?</summary>
          <div class="faq-a" style="margin-top:10px;">
            <p>First, share a local printer using the "Shared local printers" section on the Dashboard. Only shared printers appear in the "Publish" form.</p>
            <p>After sharing a printer, fill in the "Published platform printers" form with pricing and capabilities, then click "Publish printer". The printer will appear to customers once your machine is approved.</p>
          </div>
        </details>
      </div>

      <div class="card">
        <div class="card-title">Coupons</div>
        <details class="faq-section" open>
          <summary>Can I create my own coupons?</summary>
          <div class="faq-a" style="margin-top:10px;">
            <p>Yes. Go to the <a href="/coupons">Coupons</a> page and use the "Create a new coupon" form. You can scope a coupon to all your printers (Agent scope) or to a specific printer (Printer scope).</p>
            <p>Your coupons are <strong>not shown</strong> on the customer promo preview list — they are kept private to your shop. A customer who knows the code can enter it at checkout and it will be validated automatically at your printer.</p>
          </div>
        </details>
        <details class="faq-section">
          <summary>What is Agent scope vs. Printer scope?</summary>
          <div class="faq-a" style="margin-top:10px;">
            <p><strong>Agent scope</strong> — the coupon is valid at <em>any</em> printer registered from this machine. Use this for a shop-wide promotion.</p>
            <p><strong>Printer scope</strong> — the coupon is valid only at the specific printer you select. Use this to run promotions on a particular printer (e.g., the color printer at the front desk).</p>
          </div>
        </details>
        <details class="faq-section">
          <summary>Can the same coupon code be reused in a future period?</summary>
          <div class="faq-a" style="margin-top:10px;">
            <p>Yes. Deactivate the old coupon first, then create a new coupon with the same code. The system enforces that only one coupon with the same code (at the same scope, agent, and printer) can be active at any time. The new coupon gets a fresh internal ID so redemption history is separate.</p>
          </div>
        </details>
      </div>

      <div class="card">
        <div class="card-title">Orders &amp; pickup</div>
        <details class="faq-section" open>
          <summary>How do I view incoming orders?</summary>
          <div class="faq-a" style="margin-top:10px;">
            <p>The <a href="/orders">Orders</a> page shows all print jobs that have been dispatched to your printers. Jobs that are ready for in-store pickup show a pickup code. Compare that code to what the customer shows you on their phone before handing over the prints.</p>
          </div>
        </details>
        <details class="faq-section">
          <summary>A job is stuck in "Queued" — what do I do?</summary>
          <div class="faq-a" style="margin-top:10px;">
            <p>Check that the agent service is running and connected (look at "Last heartbeat" on the Dashboard). If the heartbeat is stale, restart the agent service.</p>
            <p>Also confirm the printer is shared and online. Go to Dashboard → Shared local printers and check the printer status. If the printer shows as offline in Windows, restart the print spooler or reconnect the printer.</p>
          </div>
        </details>
        <details class="faq-section">
          <summary>What does "Mark collected" do?</summary>
          <div class="faq-a" style="margin-top:10px;">
            <p>When a customer picks up their printout, click "Mark collected" next to their job on the Dashboard. This updates the job status to COLLECTED in the cloud and removes it from the pickup list. The customer's order tracking will also show the final collected status.</p>
          </div>
        </details>
      </div>

      <div class="card">
        <div class="card-title">Passwords &amp; access</div>
        <details class="faq-section" open>
          <summary>I forgot my agent credentials — how do I log in?</summary>
          <div class="faq-a" style="margin-top:10px;">
            <p>The agent console at <code>local.printanywhere.dhruvantasystems.com</code> (or <code>localhost</code> as a fallback) does not use a password. It uses a machine-level security token automatically. If you can open this page, you are already authenticated.</p>
            <p>If this console is inaccessible, make sure the PrintAnywhere Agent service is running. Check Windows Services (services.msc) or the system tray icon.</p>
          </div>
        </details>
        <details class="faq-section">
          <summary>I need to re-pair this machine with the admin portal.</summary>
          <div class="faq-a" style="margin-top:10px;">
            <p>Go to Dashboard → Registration &amp; approval and click "Generate new pairing code". Share the new code with your PrintAnywhere administrator. They will use it to re-associate this machine with the platform account.</p>
          </div>
        </details>
      </div>
    `

    response.type('html').send(pageShell({ title: 'Help & FAQ', activePage: 'help', snapshot, notice, error: errorMessage }, content))
  })

  // ── Support & Troubleshooting ─────────────────────────────────────────────
  app.get('/support', (request, response) => {
    const snapshot = runtime.snapshot()
    const notice = typeof request.query.notice === 'string' ? request.query.notice : null
    const errorMessage = typeof request.query.error === 'string' ? request.query.error : null
    const brandName = snapshot.brandName?.trim() || null
    const supportEmail = snapshot.supportContactEmail?.trim() || null

    const content = `
      <div>
        <div class="page-eyebrow">Contact &amp; troubleshooting</div>
        <div class="page-title">Support</div>
      </div>

      ${supportEmail ? `
        <div class="card">
          <div class="card-title">${htmlEscape(brandName ?? 'Shop')} support contact</div>
          <p class="muted small">Contact your shop administrator for printer access issues, billing questions, or local setup help.</p>
          <div style="margin-top:12px;">
            <strong>Email:</strong> <a href="mailto:${htmlEscape(supportEmail)}">${htmlEscape(supportEmail)}</a>
          </div>
        </div>
      ` : ''}

      <div class="card">
        <div class="card-title">PrintAnywhere platform support</div>
        <p class="muted small">For platform-level issues (account approval, billing, API errors), contact Dhruvanta Systems.</p>
        <div style="margin-top:12px; display:flex; flex-direction:column; gap:6px;">
          <div><strong>Email:</strong> support@printanywhere.in</div>
          <div><strong>Platform:</strong> PrintAnywhere by Dhruvanta Systems</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Common troubleshooting</div>

        <details class="faq-section" open>
          <summary>Printer is not picking up jobs</summary>
          <div class="faq-a" style="margin-top:10px;">
            <ol style="padding-left:18px; line-height:2;">
              <li>Open Dashboard and check "Last heartbeat". If it's more than 2 minutes ago, the agent may have lost its cloud connection.</li>
              <li>Restart the PrintAnywhere Agent service: open Windows Services (<kbd>Win + R</kbd> → <code>services.msc</code>) and restart "PrintAnywhere Agent".</li>
              <li>Verify the local printer is online in Windows: open Printers &amp; Scanners in Settings and check the printer status.</li>
              <li>Verify the printer is shared: Dashboard → Shared local printers → the printer's row should show a "Stop sharing" button (meaning it is already shared).</li>
              <li>Verify the printer has been published as a platform printer and is set to Enabled and Online.</li>
            </ol>
          </div>
        </details>

        <details class="faq-section">
          <summary>Agent console is not opening at local.printanywhere.dhruvantasystems.com</summary>
          <div class="faq-a" style="margin-top:10px;">
            <ol style="padding-left:18px; line-height:2;">
              <li>Check that the PrintAnywhere Agent is running: look for it in the system tray or check Windows Services.</li>
              <li>If the service is stopped, start it from Services (<kbd>Win + R</kbd> → <code>services.msc</code> → find "PrintAnywhere Agent" → Start).</li>
              <li>If it crashes immediately after starting, check the agent log file in <code>%AppData%\PrintAnywhere\logs\</code>.</li>
              <li>If the <code>local.printanywhere.dhruvantasystems.com</code> address fails on your network, support can switch the launcher to the <code>localhost</code> address by editing <code>ui-launcher.json</code> in the agent data folder (set <code>"uiHost"</code> to <code>"localhost"</code>).</li>
              <li>Try a different browser or clear the browser cache. The console is only accessible from <strong>this computer</strong>.</li>
            </ol>
          </div>
        </details>

        <details class="faq-section">
          <summary>Agent is registered but still shows "Pending approval"</summary>
          <div class="faq-a" style="margin-top:10px;">
            <p>The PrintAnywhere admin reviews each new machine registration before it can publish printers. This is a one-time process per machine.</p>
            <ol style="padding-left:18px; line-height:2;">
              <li>Share the pairing code from the Dashboard with your PrintAnywhere administrator.</li>
              <li>The admin will verify your business details and approve the machine. This can take up to 24 hours.</li>
              <li>Once approved, this page will show "Approved" and you can publish platform printers.</li>
            </ol>
          </div>
        </details>

        <details class="faq-section">
          <summary>Print jobs are failing with a red "Failed" status</summary>
          <div class="faq-a" style="margin-top:10px;">
            <ol style="padding-left:18px; line-height:2;">
              <li>Go to <a href="/orders">Orders</a> and find the failed job. The failure reason column shows what went wrong.</li>
              <li>Common reasons: the local printer was offline, the print spooler rejected the job, or the encrypted file could not be decrypted (key mismatch — contact support).</li>
              <li>For failed jobs, the customer receives a refund automatically through the platform wallet.</li>
              <li>If multiple jobs are failing, restart the printer and the agent service, then try a test print from Windows to confirm the printer is working.</li>
            </ol>
          </div>
        </details>

        <details class="faq-section">
          <summary>Backend configuration error / cannot reach the server</summary>
          <div class="faq-a" style="margin-top:10px;">
            <ol style="padding-left:18px; line-height:2;">
              <li>Check the server URL on the Dashboard. It should match the PrintAnywhere backend URL provided by Dhruvanta Systems.</li>
              <li>Check your internet connection. The agent requires outbound HTTPS access to the backend server.</li>
              <li>If you are behind a corporate firewall or proxy, the agent may need an exception. Contact your IT department or Dhruvanta Systems support.</li>
              <li>Check "Last error" on the Dashboard for the exact error message — include it when contacting support.</li>
            </ol>
          </div>
        </details>

        <details class="faq-section">
          <summary>How do I completely reset or re-register this machine?</summary>
          <div class="faq-a" style="margin-top:10px;">
            <p class="muted">⚠ Warning: This erases all local credentials and starts fresh. Only do this if instructed by support.</p>
            <ol style="padding-left:18px; line-height:2;">
              <li>Stop the PrintAnywhere Agent service.</li>
              <li>Delete the agent state file at <code>%AppData%\PrintAnywhere\state.json</code>.</li>
              <li>Restart the agent service. It will generate a new identity and registration on next start.</li>
              <li>Re-enter the server URL on the Dashboard and click "Save and register".</li>
              <li>Contact your PrintAnywhere administrator with the new pairing code to re-approve the machine.</li>
            </ol>
          </div>
        </details>
      </div>
    `

    response.type('html').send(pageShell({ title: 'Support', activePage: 'support', snapshot, notice, error: errorMessage }, content))
  })

  // ── About ─────────────────────────────────────────────────────────────────
  app.get('/about', (request, response) => {
    const snapshot = runtime.snapshot()
    const notice = typeof request.query.notice === 'string' ? request.query.notice : null
    const errorMessage = typeof request.query.error === 'string' ? request.query.error : null

    const content = `
      <div>
        <div class="page-eyebrow">System information</div>
        <div class="page-title">About this agent</div>
      </div>

      <div class="card">
        <div class="card-title">Agent information</div>
        <div class="grid-2">
          <div>
            <div class="muted small">Product</div>
            <div>PrintAnywhere Agent</div>
          </div>
          <div>
            <div class="muted small">Version</div>
            <div class="mono">${htmlEscape(AGENT_VERSION)}</div>
          </div>
          <div>
            <div class="muted small">Machine ID</div>
            <div class="mono small">${htmlEscape(snapshot.identity?.machineId ?? 'Not initialized')}</div>
          </div>
          <div>
            <div class="muted small">Agent ID</div>
            <div class="mono small">${htmlEscape(snapshot.registration?.agentId ?? 'Not registered')}</div>
          </div>
          <div>
            <div class="muted small">Display name</div>
            <div>${htmlEscape(snapshot.displayName ?? '—')}</div>
          </div>
          <div>
            <div class="muted small">Backend server</div>
            <div class="mono small">${htmlEscape(snapshot.serverUrl ?? defaultPrintAnywhereBackendUrl())}</div>
          </div>
          <div>
            <div class="muted small">Registration status</div>
            <div><span class="badge">${htmlEscape(snapshot.profile?.registrationStatus ?? snapshot.registration?.status ?? 'Not registered')}</span></div>
          </div>
          <div>
            <div class="muted small">Approval status</div>
            <div><span class="${approvalTone(snapshot.profile?.approvalStatus)}">${htmlEscape(humanizeEnum(snapshot.profile?.approvalStatus ?? 'PENDING_REVIEW'))}</span></div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Platform</div>
        <div class="grid-2">
          <div>
            <div class="muted small">Verified business name</div>
            <div>${htmlEscape(snapshot.profile?.businessName ?? 'Pending admin review')}</div>
          </div>
          <div>
            <div class="muted small">Verified address</div>
            <div>${htmlEscape(snapshot.profile?.businessAddress ?? 'Pending admin review')}</div>
          </div>
          <div>
            <div class="muted small">Agent version (server)</div>
            <div class="mono small">${htmlEscape(snapshot.profile?.agentVersion ?? '—')}</div>
          </div>
          <div>
            <div class="muted small">Last heartbeat</div>
            <div>${htmlEscape(formatTimestamp(snapshot.lastHeartbeatAt))}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Powered by Dhruvanta Systems</div>
        <div style="display:flex; align-items:center; gap:16px; margin-bottom:12px;">
          <img src="/assets/dhruvanta-symbol.svg" alt="Dhruvanta" style="height:48px; width:auto;" />
          <div>
            <div style="font-weight:700; font-size:15px;">PrintAnywhere</div>
            <div class="muted small">Cloud-connected print shop platform</div>
          </div>
        </div>
        <p class="muted small" style="line-height:1.6;">PrintAnywhere is a product by Dhruvanta Systems. The agent software connects your local Windows print shop to the PrintAnywhere cloud, enabling remote print job submission, secure job delivery, and in-store pickup with a pickup code.</p>
        <p class="muted small" style="margin-top:8px; line-height:1.6;">For support or licensing questions, contact <a href="mailto:support@printanywhere.in">support@printanywhere.in</a>.</p>
      </div>
    `

    response.type('html').send(pageShell({ title: 'About', activePage: 'about', snapshot, notice, error: errorMessage }, content))
  })

  // ── Action routes (POST) ──────────────────────────────────────────────────

  app.post('/configure', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    const body = request.body as Record<string, unknown>
    const snapshot = runtime.snapshot()

    // KAN-40 P1-5: validate the shop-details fields up-front so a failed
    // submit re-renders sticky instead of redirecting to a blank snapshot.
    const errors: Record<string, string> = {}
    const serverUrl = String(body.serverUrl ?? '').trim()
    if (!serverUrl) {
      errors.serverUrl = 'Enter the PrintAnywhere server address.'
    } else {
      try {
        const parsed = new URL(serverUrl)
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          errors.serverUrl = 'The server address must start with http:// or https://.'
        }
      } catch {
        errors.serverUrl = 'That does not look like a valid web address.'
      }
    }

    const renderConfigError = (lead: string, leadVariant: 'warning' | 'error', fieldErrors: Record<string, string>) => {
      const formHtml = renderConfigureForm(snapshot, serverUrl || defaultPrintAnywhereBackendUrl(), {
        submitted: body,
        fieldErrors,
      })
      response.status(leadVariant === 'error' ? 502 : 400).type('html').send(
        pageShell(
          { title: 'Check shop details', activePage: 'dashboard', snapshot },
          renderFormErrorPage({
            eyebrow: 'Shop setup',
            title: leadVariant === 'error' ? 'Could not save your details' : 'A detail needs fixing',
            lead,
            leadVariant,
            formHtml,
            backHref: '/',
            backLabel: 'Back to dashboard',
          }),
        ),
      )
    }

    if (Object.keys(errors).length > 0) {
      renderConfigError('Please correct the highlighted field — nothing you typed has been lost.', 'warning', errors)
      return
    }

    try {
      await runtime.configure(
        serverUrl,
        String(body.displayName ?? ''),
        String(body.reportedBusinessAddress ?? ''),
        // KAN-418 — optional Business UUID. The runtime tolerates a
        // blank string (treated as null) and rejects non-UUID
        // strings before persisting.
        String(body.intendedBusinessId ?? ''),
      )
      const location = parseBrowserLocationBody(body)
      if (location) await runtime.setBrowserLocation(location)
      redirectWithStatus(response, 'notice', 'Your shop details were saved.')
    } catch (error) {
      // friendlyConfigureError handles the "already registered" CONFLICT
      // case; everything else flows through the friendly cloud-error mapper.
      const message = friendlyConfigureError(error)
      const lead = message.includes('already registered')
        ? message
        : `${mapCloudError(error).body} Your details below are kept — press Save to try again.`
      renderConfigError(lead, 'error', {})
    }
  })

  app.post('/settings/branding', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    try {
      const body = request.body as Record<string, unknown>
      const typedUrl = parseOptionalTrimmed(body, 'brandLogoUrl')
      const currentLogo = runtime.snapshot().brandLogoUrl?.trim() || null
      // KAN-40 P1-6: the Advanced URL field is left blank by owners who
      // uploaded a file. A blank URL must not wipe an existing uploaded logo
      // — only an explicitly typed URL replaces it.
      const logo = typedUrl ?? currentLogo
      await runtime.updateBranding(
        parseOptionalTrimmed(body, 'brandName'),
        logo,
        parseOptionalTrimmed(body, 'supportContactEmail'),
      )
      redirectWithStatus(response, 'notice', 'Your shop details were saved.')
    } catch (error) {
      redirectWithStatus(response, 'error', error instanceof Error ? error.message : 'Could not save branding')
    }
  })

  // KAN-40 P1-6 — business logo file upload. The file is magic-byte
  // validated in memory before being written to the writable branding dir.
  // The multer middleware is wrapped so an over-size / malformed multipart
  // upload becomes a friendly redirect, not an unhandled 500.
  const handleLogoUpload: express.RequestHandler = (request, response, next) => {
    logoUpload.single('logo')(request, response, (error: unknown) => {
      if (error) {
        const tooLarge =
          error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
        redirectWithStatus(
          response,
          'error',
          tooLarge
            ? 'That image is too large. Please use a logo under 2 MB.'
            : 'That file could not be read as an image. Please try a PNG, JPG or SVG.',
        )
        return
      }
      next()
    })
  }

  app.post('/settings/logo', handleLogoUpload, async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    try {
      const file = request.file
      const validation = validateLogoUpload(file?.buffer, file?.originalname)
      if (!validation.ok || !validation.ext || !file) {
        redirectWithStatus(response, 'error', validation.error ?? 'That logo could not be used.')
        return
      }
      const logoUrl = await storeBrandingLogo(brandingDir, file.buffer, validation.ext)
      const snapshot = runtime.snapshot()
      await runtime.updateBranding(snapshot.brandName ?? null, logoUrl, snapshot.supportContactEmail ?? null)
      redirectWithStatus(response, 'notice', 'Your logo was uploaded.')
    } catch (error) {
      redirectWithStatus(response, 'error', error instanceof Error ? error.message : 'Could not upload the logo')
    }
  })

  app.post('/settings/logo/remove', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    try {
      await clearBrandingDir(brandingDir)
      const snapshot = runtime.snapshot()
      await runtime.updateBranding(snapshot.brandName ?? null, null, snapshot.supportContactEmail ?? null)
      redirectWithStatus(response, 'notice', 'Your logo was removed.')
    } catch (error) {
      redirectWithStatus(response, 'error', error instanceof Error ? error.message : 'Could not remove the logo')
    }
  })

  app.post('/printers/share', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    try {
      await runtime.setPrinterShared(String(request.body.localPrinterName ?? ''), String(request.body.shared ?? '') === 'true')
      redirectWithStatus(response, 'notice', 'Local printer sharing updated.')
    } catch (error) {
      redirectWithStatus(response, 'error', error instanceof Error ? error.message : 'Could not update printer sharing')
    }
  })

  app.post('/actions/repair', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    try {
      await runtime.repairPairingCode()
      redirectWithStatus(response, 'notice', 'A new pairing code was generated.')
    } catch (error) {
      redirectWithStatus(response, 'error', error instanceof Error ? error.message : 'Could not refresh pairing code')
    }
  })

  // KAN-294: "Repair local URL setup" action — wired to the loud-fallback
  // banner on the dashboard. Verifies the hosts-file entry, reinstalls the
  // per-host self-signed cert, and (per the deviation noted in
  // localHttpsRepair.ts) asks the operator to restart the agent to finish
  // picking up the new certificate. Surfaces the elevation requirement
  // clearly so the operator does not silently fail again.
  app.post('/actions/repair-local-https', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    try {
      const result = await runLocalHttpsRepair({ dataDir: startupDataDir })
      if (!result.ok) {
        console.warn(
          'PrintAnywhere Agent UI: local-https repair failed:',
          ...result.details,
        )
      }
      redirectWithStatus(response, result.ok ? 'notice' : 'error', result.message)
    } catch (error) {
      redirectWithStatus(
        response,
        'error',
        error instanceof Error ? error.message : 'Could not run the local URL repair.',
      )
    }
  })

  app.post('/actions/refresh', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    try {
      await runtime.syncPrinters()
      redirectWithStatus(response, 'notice', 'Local printers were refreshed from the machine.')
    } catch (error) {
      redirectWithStatus(response, 'error', error instanceof Error ? error.message : 'Could not refresh printers')
    }
  })

  app.post('/location/browser', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    try {
      const accuracy = String(request.body.accuracyMeters ?? '').trim()
      await runtime.setBrowserLocation({
        latitude: Number(request.body.latitude),
        longitude: Number(request.body.longitude),
        accuracyMeters: accuracy ? Number(accuracy) : null,
        capturedAt: String(request.body.capturedAt ?? ''),
      })
      redirectWithStatus(response, 'notice', 'Device location captured.')
    } catch (error) {
      redirectWithStatus(response, 'error', error instanceof Error ? error.message : 'Could not capture device location')
    }
  })

  app.post('/platform-printers/save', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    const body = request.body as Record<string, unknown>
    const snapshot = runtime.snapshot()
    const printerId = parseOptionalTrimmed(body, 'printerId')
    const sharedPrinterNames = snapshot.printers
      .filter((printer) => printer.shared)
      .map((printer) => printer.localPrinterName)
    const existing = printerId
      ? (snapshot.platformPrinters ?? []).find((p) => p.printerId === printerId)
      : undefined

    // KAN-40 P1-5: validate up-front and collect every field error so the
    // ~12-field publish form can be re-rendered with the owner's input intact.
    const { payload, errors } = validatePlatformPrinterPayload(body, printerId)
    if (!payload) {
      const formHtml = renderPlatformPrinterForm(snapshot.uiToken, sharedPrinterNames, existing, {
        submitted: body,
        fieldErrors: errors,
      })
      response.status(400).type('html').send(
        pageShell(
          { title: 'Fix printer details', activePage: 'dashboard', snapshot },
          renderFormErrorPage({
            eyebrow: 'Publish a printer',
            title: 'A few details need fixing',
            lead: 'Please correct the highlighted fields below — nothing you typed has been lost.',
            leadVariant: 'warning',
            formHtml,
            backHref: '/',
            backLabel: 'Back to dashboard without saving',
          }),
        ),
      )
      return
    }

    try {
      await runtime.upsertPlatformPrinter(payload)
      redirectWithStatus(response, 'notice', 'Platform printer saved.')
    } catch (error) {
      // A cloud-side failure — re-render the form sticky so input survives,
      // with the friendly offline message instead of raw exception text.
      const friendly = mapCloudError(error)
      const formHtml = renderPlatformPrinterForm(snapshot.uiToken, sharedPrinterNames, existing, {
        submitted: body,
      })
      response.status(502).type('html').send(
        pageShell(
          { title: 'Could not save printer', activePage: 'dashboard', snapshot },
          renderFormErrorPage({
            eyebrow: 'Publish a printer',
            title: friendly.title,
            lead: `${friendly.body} Your details below are kept — press "Publish printer" to try again.`,
            leadVariant: 'error',
            formHtml,
            backHref: '/',
            backLabel: 'Back to dashboard',
          }),
        ),
      )
    }
  })

  app.post('/platform-printers/remove', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    try {
      await runtime.removePlatformPrinter(String(request.body.printerId ?? ''))
      redirectWithStatus(response, 'notice', 'Platform printer unpublished.')
    } catch (error) {
      redirectWithStatus(response, 'error', error instanceof Error ? error.message : 'Could not unpublish platform printer')
    }
  })

  app.post('/jobs/collect', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    try {
      await runtime.markCollected(String(request.body.jobId ?? ''))
      redirectWithStatus(response, 'notice', 'Job marked as collected.')
    } catch (error) {
      redirectWithStatus(response, 'error', error instanceof Error ? error.message : 'Could not mark the job as collected')
    }
  })

  app.post('/coupons/create', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    const body = request.body as Record<string, unknown>
    const snapshot = runtime.snapshot()

    // KAN-40 P1-5: validate all fields up-front and collect every error so the
    // form can re-render in-process with the owner's typed values preserved.
    const { payload, errors } = validateCouponPayload(body)
    if (!payload) {
      const content = await renderCouponsPageContent(runtime, snapshot, { submitted: body, fieldErrors: errors })
      response
        .status(400)
        .type('html')
        .send(
          pageShell(
            { title: 'Coupons', activePage: 'coupons', snapshot, error: 'Please fix the highlighted fields and try again.' },
            content,
          ),
        )
      return
    }

    try {
      await runtime.createCoupon(payload)
      redirectTo(response, '/coupons', 'notice', 'Coupon created successfully.')
    } catch (error) {
      // A cloud-side failure (not a form error): re-render sticky so the
      // owner's input survives, and show the friendly offline message.
      const friendly = mapCloudError(error)
      const content = await renderCouponsPageContent(runtime, snapshot, { submitted: body })
      response
        .status(502)
        .type('html')
        .send(
          pageShell(
            { title: 'Coupons', activePage: 'coupons', snapshot, error: `${friendly.title}. ${friendly.body}` },
            content,
          ),
        )
    }
  })

  app.post('/coupons/toggle', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    try {
      const couponId = parseRequiredText(request.body as Record<string, unknown>, 'couponId')
      const active = String(request.body.active ?? '') === 'true'
      await runtime.setCouponActive(couponId, active)
      redirectTo(response, '/coupons', 'notice', active ? 'Coupon activated.' : 'Coupon deactivated.')
    } catch (error) {
      redirectTo(response, '/coupons', 'error', error instanceof Error ? error.message : 'Could not update coupon')
    }
  })

  // ── Start ─────────────────────────────────────────────────────────────────
  // KAN-165: the UI is now served over HTTPS with a per-host self-signed
  // certificate so the operator console can open at the professional domain
  // `https://local.printanywhere.dhruvantasystems.com:<port>`. The same socket
  // also answers `127.0.0.1` / `localhost` (the domain is a hosts-file alias
  // for 127.0.0.1) so the loopback fallback stays fully functional.
  const dataDir = startupDataDir
  const launcherConfig = startupLauncherConfig
  // Precedence: explicit env override > launcher config file > built-in default.
  const configuredPort = Number(
    process.env.PRINTANYWHERE_AGENT_PORT ?? launcherConfig.port ?? DEFAULT_UI_PORT,
  )
  const preferredPort =
    Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536
      ? configuredPort
      : DEFAULT_UI_PORT

  const { key, cert } = await ensureLocalCert(dataDir)

  return new Promise<{ close: () => Promise<void> }>((resolve, reject) => {
    // Generate at most a handful of fallback candidates above the preferred
    // port. The stale-listener reclaim in start-agent-background.ps1 frees a
    // stale *agent* listener before launch, so this only fires when the port
    // is genuinely held by an unrelated process.
    const MAX_PORT_FALLBACK = 16

    const listenOn = (port: number, attemptsLeft: number) => {
      const server = createHttpsServer({ key, cert }, app)

      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
          console.warn(
            `PrintAnywhere Agent UI: port ${port} is in use, trying ${port + 1}…`,
          )
          listenOn(port + 1, attemptsLeft - 1)
          return
        }
        reject(error)
      })

      server.listen(port, '127.0.0.1', () => {
        // Persist the *actual* port so the launcher opens the right URL even
        // after a fallback. Best-effort: a write failure must not stop the UI.
        try {
          writeUiRuntimeInfo(dataDir, {
            scheme: 'https',
            port,
            domain: LOCAL_UI_DOMAIN,
            loopbackHost: '127.0.0.1',
          })
        } catch (error) {
          console.warn('PrintAnywhere Agent UI: could not write ui-runtime.json:', error)
        }
        console.log(
          `PrintAnywhere Agent UI listening on https://${LOCAL_UI_DOMAIN}:${port}` +
            ` (loopback fallback https://127.0.0.1:${port})`,
        )
        resolve({
          close: () =>
            new Promise((closeResolve, closeReject) => {
              server.close((error) => (error ? closeReject(error) : closeResolve()))
            }),
        })
      })
    }

    listenOn(preferredPort, MAX_PORT_FALLBACK)
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCouponValue(discountType: string, value: number) {
  switch (discountType) {
    case 'PERCENTAGE': return `${value}%`
    case 'FIXED_AMOUNT': return formatMinor(value)
    case 'PER_PAGE_FIXED': return `${formatMinor(value)}/page`
    default: return String(value)
  }
}

/**
 * Validate a submitted coupon body, collecting ALL field errors at once
 * (KAN-40 P1-5) rather than throwing on the first one. Returns the built
 * payload when valid, or `{ payload: null, errors }` keyed by field name.
 * Exported so the validation contract can be unit-tested directly.
 */
export function validateCouponPayload(body: Record<string, unknown>): {
  payload: AgentCouponUpsertPayload | null
  errors: Record<string, string>
} {
  const errors: Record<string, string> = {}

  const code = String(body.code ?? '').trim().toUpperCase()
  if (!code) errors.code = 'Enter a coupon code customers will type at checkout.'
  else if (/\s/.test(code)) errors.code = 'A coupon code cannot contain spaces.'

  const discountType = String(body.discountType ?? '').trim()
  if (!['PERCENTAGE', 'FIXED_AMOUNT', 'PER_PAGE_FIXED'].includes(discountType)) {
    errors.discountType = 'Choose a discount type.'
  }

  const discountRaw = String(body.discountValue ?? '').trim()
  const discountValue = Number(discountRaw)
  if (!discountRaw) {
    errors.discountValue = 'Enter how big the discount is.'
  } else if (!Number.isFinite(discountValue) || discountValue <= 0) {
    errors.discountValue = 'The discount must be a number greater than zero.'
  } else if (discountType === 'PERCENTAGE' && discountValue > 100) {
    errors.discountValue = 'A percentage discount cannot be more than 100.'
  }

  const scope = String(body.couponScope ?? 'AGENT').trim() || 'AGENT'
  const printerId = scope === 'PRINTER' ? (String(body.printerId ?? '').trim() || null) : null
  if (scope === 'PRINTER' && !printerId) {
    errors.printerId = 'Choose which printer this coupon applies to.'
  }

  if (Object.keys(errors).length > 0) {
    return { payload: null, errors }
  }

  return {
    payload: {
      code,
      name: parseOptionalTrimmed(body, 'name'),
      discountType,
      discountValue,
      active: true,
      startsAt: startsAtIso(parseOptionalTrimmed(body, 'startsAt')),
      expiresAt: expiresAtIso(parseOptionalTrimmed(body, 'expiresAt')),
      maxUses: parseOptionalInt(body, 'maxUses'),
      maxUsesPerUser: parseOptionalInt(body, 'maxUsesPerUser'),
      couponScope: scope as 'AGENT' | 'PRINTER',
      printerId,
    },
    errors,
  }
}

function startsAtIso(dateStr: string | null) {
  if (!dateStr) return null
  return new Date(`${dateStr}T00:00:00`).toISOString()
}

function expiresAtIso(dateStr: string | null) {
  if (!dateStr) return null
  return new Date(`${dateStr}T23:59:59`).toISOString()
}
