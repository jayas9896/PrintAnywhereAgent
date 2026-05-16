import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { Request, Response } from 'express'
import type {
  AgentApprovalStatus,
  AgentLocationSnapshot,
  ConfiguredConstraint,
  PlatformColorMode,
  PlatformPageSize,
  PlatformPrinter,
  PlatformPrinterStatus,
  PlatformScalingMode,
  PlatformSidesMode,
} from '../config/types.js'
import type { AgentCouponUpsertPayload } from '../cloud/api.js'
import { AGENT_VERSION, defaultPrintAnywhereBackendUrl } from '../config/defaults.js'
import type { AgentRuntime, PlatformPrinterUpsertInput } from '../runtime/agentRuntime.js'

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

function isLoopbackOrigin(value: string | undefined) {
  if (!value) return true
  try {
    const url = new URL(value)
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

function verifyUiRequest(runtime: AgentRuntime, request: Request, response: Response) {
  const snapshot = runtime.snapshot()
  const uiToken = String(request.body.uiToken ?? '')
  if (!runtime.verifyUiToken(uiToken)) {
    response.status(403).type('text/plain').send('Invalid local UI token')
    return false
  }
  const origin = request.get('origin')
  const referer = request.get('referer')
  if (!isLoopbackOrigin(origin) || !isLoopbackOrigin(referer)) {
    response.status(403).type('text/plain').send('Local UI origin check failed')
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

function parseRequiredNumber(body: Record<string, unknown>, key: string) {
  const value = String(body[key] ?? '').trim()
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${humanizeKey(key)} must be a valid number.`)
  return parsed
}

function parseNonNegativeInteger(body: Record<string, unknown>, key: string) {
  const parsed = Math.round(parseRequiredNumber(body, key))
  if (parsed < 0) throw new Error(`${humanizeKey(key)} must be zero or higher.`)
  return parsed
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

function redirectWithStatus(response: Response, type: 'notice' | 'error', message: string) {
  redirectTo(response, '/', type, message)
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
  .site-nav { background: var(--brand); border-top: 1px solid rgba(255,255,255,.08); padding: 0 24px; display: flex; gap: 0; flex-shrink: 0; }
  .site-nav a { color: rgba(255,255,255,.65); text-decoration: none; padding: 10px 16px; font-size: 13px; font-weight: 500; border-bottom: 2px solid transparent; transition: color .15s, border-color .15s; }
  .site-nav a:hover { color: rgba(255,255,255,.9); }
  .site-nav a.active { color: #fff; border-bottom-color: #7ed9a0; }

  /* Layout */
  .page-content { flex: 1; padding: var(--space-6); max-width: 1100px; width: 100%; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-5); }
  .page-title { font-size: var(--text-xl); font-weight: var(--font-weight-bold); margin-bottom: var(--space-1); }
  .page-eyebrow { font-size: var(--text-xs); font-weight: var(--font-weight-semibold); letter-spacing: .08em; text-transform: uppercase; color: var(--brand-mid); margin-bottom: var(--space-2); }

  /* Cards */
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-5); box-shadow: var(--shadow); }
  .card-title { font-size: var(--text-md); font-weight: var(--font-weight-bold); margin-bottom: var(--space-3); }
  .card-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-3); }
  .card-row:last-child { margin-bottom: 0; }
  .subsection { border-top: 1px solid var(--border-light); padding-top: var(--space-4); margin-top: var(--space-4); }
  .subsection-title { font-size: var(--text-sm); font-weight: var(--font-weight-bold); text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: var(--space-3); }

  /* Stats */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--space-3); }
  .stat-card { background: var(--surface-alt); border: 1px solid var(--border-light); border-radius: var(--radius-sm); padding: var(--space-3) var(--space-4); }
  .stat-label { font-size: var(--text-xs); color: var(--muted); font-weight: var(--font-weight-medium); text-transform: uppercase; letter-spacing: .05em; margin-bottom: var(--space-2); }
  .stat-value { font-size: var(--text-2xl); font-weight: var(--font-weight-bold); color: var(--brand); line-height: var(--leading-tight); }

  /* Badges */
  .badge { display: inline-block; border-radius: 999px; background: var(--border); color: var(--muted); padding: 3px 10px; font-size: 12px; font-weight: 600; vertical-align: middle; }
  .badge-good { background: #d8f0e3; color: #155c31; }
  .badge-bad { background: #fde7e5; color: #8b2d22; }
  .badge-info { background: #ddeeff; color: #1a4e8a; }

  /* Forms */
  form.stack { display: grid; gap: var(--space-3); }
  label { display: block; }
  .label-text { font-size: var(--text-xs); font-weight: var(--font-weight-semibold); color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-bottom: var(--space-1); }
  input[type=text], input[type=url], input[type=email], input[type=number], input[type=date], select, textarea {
    padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); border: 1px solid var(--border); width: 100%; font-size: var(--text-base); color: var(--text); background: #fff; transition: border-color .15s;
  }
  input:focus, select:focus, textarea:focus { border-color: var(--brand-mid); }
  .hint { font-size: var(--text-xs); color: var(--muted); margin-top: var(--space-1); }

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

  /* Alerts */
  .alert { padding: 12px 16px; border-radius: var(--radius-sm); font-size: 14px; }
  .alert-success { background: #e7f7ec; color: #155c31; border: 1px solid #c0e8ce; }
  .alert-error { background: #fdeceb; color: #8b2d22; border: 1px solid #f7c9c4; }
  .alert-info { background: #e8f0ff; color: #1a4080; border: 1px solid #c0d0f0; }

  /* Tables */
  .data-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .data-table th { text-align: left; padding: 10px 12px; color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; border-bottom: 2px solid var(--border-light); }
  .data-table td { padding: 12px; border-bottom: 1px solid var(--border-light); vertical-align: top; }
  .data-table tr:last-child td { border-bottom: 0; }
  .data-table tr:hover td { background: var(--surface-alt); }
  .mono { font-family: ui-monospace, monospace; letter-spacing: .06em; }
  .muted { color: var(--muted); font-size: 13px; }
  .small { font-size: 12px; }

  /* Details / Accordion */
  details { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px; }
  details + details { margin-top: 10px; }
  summary { cursor: pointer; font-weight: 600; list-style: none; display: flex; align-items: center; justify-content: space-between; }
  summary::after { content: '▾'; font-size: 12px; color: var(--muted); }
  details[open] summary::after { content: '▴'; }
  details > *:not(summary) { margin-top: 14px; }

  /* Pickup code */
  .pickup-code { font-family: ui-monospace, monospace; font-size: 18px; letter-spacing: .12em; font-weight: 700; }

  /* Inline form */
  .inline-form { display: inline-flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }

  /* FAQ */
  .faq-section { margin-bottom: 6px; }
  .faq-q { font-weight: 600; margin-bottom: 6px; }
  .faq-a { color: var(--muted); line-height: 1.6; }
  .faq-a p + p { margin-top: 8px; }

  /* Footer */
  .site-footer { background: var(--brand); color: rgba(255,255,255,.5); font-size: 12px; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-shrink: 0; }
  .site-footer a { color: rgba(255,255,255,.65); text-decoration: none; }
  .site-footer a:hover { color: #fff; }
`

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

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

  const navLinks = [
    { href: '/', label: 'Dashboard', id: 'dashboard' },
    { href: '/orders', label: 'Orders', id: 'orders' },
    { href: '/coupons', label: 'Coupons', id: 'coupons' },
    { href: '/help', label: 'Help', id: 'help' },
    { href: '/support', label: 'Support', id: 'support' },
    { href: '/about', label: 'About', id: 'about' },
  ]

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(title)} — PrintAnywhere Agent</title>
  <style>${SHARED_CSS}</style>
</head>
<body>
  <header class="site-header">
    <a href="/" class="site-header-brand">
      <img class="dhruvanta-logo" src="/assets/dhruvanta-symbol.svg" alt="Dhruvanta" />
      <span>
        <span class="brand-text">PrintAnywhere</span>
        <span class="brand-sub">Agent</span>
      </span>
    </a>
    ${bizBranding}
  </header>
  <nav class="site-nav">
    ${navLinks.map((link) => `<a href="${link.href}"${activePage === link.id ? ' class="active"' : ''}>${link.label}</a>`).join('')}
  </nav>
  <main class="page-content">
    ${notice ? `<div class="alert alert-success">${htmlEscape(notice)}</div>` : ''}
    ${error ? `<div class="alert alert-error">${htmlEscape(error)}</div>` : ''}
    ${content}
  </main>
  <footer class="site-footer">
    <span>PrintAnywhere Agent v${htmlEscape(AGENT_VERSION)} · &copy; Dhruvanta Systems</span>
    <span>
      <a href="/help">Help &amp; FAQ</a> &middot;
      <a href="/support">Support</a> &middot;
      <a href="/about">About</a>
    </span>
  </footer>
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

  var configureForm = document.getElementById('configure-form');
  var configureStatus = document.getElementById('configure-location-status');
  var configureAttempted = document.getElementById('configure-location-attempted');
  if (configureForm && configureAttempted) {
    configureForm.addEventListener('submit', function (event) {
      if (configureAttempted.value === 'true' || (document.getElementById('configure-location-latitude') || {}).value) return;
      event.preventDefault();
      configureAttempted.value = 'true';
      if (configureStatus) configureStatus.textContent = 'Saving settings and requesting device location…';
      requestBrowserLocation(configureStatus, function (pos) {
        writeLocationFields('configure-location', pos);
        if (configureStatus) configureStatus.textContent = 'Location captured. Saving…';
        configureForm.submit();
      }, function () {
        if (configureStatus) configureStatus.textContent = 'Saving without device location.';
        configureForm.submit();
      });
    });
  }

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
})();
</script>`

// ---------------------------------------------------------------------------
// Platform printer sub-forms
// ---------------------------------------------------------------------------

function renderConstraintEditor(printer: PlatformPrinter | null | undefined) {
  const size = findConstraint(printer, 'MAX_SINGLE_PDF_SIZE')
  const pageCount = findConstraint(printer, 'MAX_SINGLE_PDF_PAGE_COUNT')
  const pageCoverage = findConstraint(printer, 'MAX_SINGLE_PDF_PAGE_COVERAGE')
  const manualApproval = findConstraint(printer, 'REQUIRE_MANUAL_APPROVAL_FOR_DENSITY_OR_PRICE_CHANGE')
  const pricingFloor = findPricingAdjustment(printer, 'INK_COVERAGE_FLOOR')

  return `
    <div class="subsection">
      <div class="subsection-title">Document constraints</div>
      <div class="grid-3">
        <label>
          <div class="label-text">Max single PDF size (MB)</div>
          <input type="text" name="constraintMaxSizeMb" value="${htmlEscape(size.maxSizeMb ?? '')}" placeholder="15" />
        </label>
        <label>
          <div class="label-text">Max single PDF pages</div>
          <input type="text" name="constraintMaxPageCount" value="${htmlEscape(pageCount.maxPageCount ?? '')}" placeholder="100" />
        </label>
        <label>
          <div class="label-text">Max printed area per page (%)</div>
          <input type="text" name="constraintMaxPageCoveragePercent" value="${htmlEscape(pageCoverage.maxPageCoveragePercent ?? '')}" placeholder="65" />
        </label>
      </div>
      <div class="subsection">
        <div class="subsection-title">Manual approval for dense or repriced PDFs</div>
        <p class="muted small">Leave all fields empty to disable this rule.</p>
        <div class="grid-3" style="margin-top:10px;">
          <label>
            <div class="label-text">Coverage threshold (%)</div>
            <input type="text" name="manualApprovalMaxPageCoveragePercent" value="${htmlEscape(manualApproval.maxPageCoveragePercent ?? '')}" placeholder="65" />
          </label>
          <label>
            <div class="label-text">Black full-page price (paise)</div>
            <input type="text" name="manualApprovalBlackFullPagePriceMinor" value="${htmlEscape(manualApproval.blackFullPagePriceMinor ?? '')}" placeholder="500" />
          </label>
          <label>
            <div class="label-text">Color full-page price (paise)</div>
            <input type="text" name="manualApprovalColorFullPagePriceMinor" value="${htmlEscape(manualApproval.colorFullPagePriceMinor ?? '')}" placeholder="1200" />
          </label>
          <label>
            <div class="label-text">Black conversion factor</div>
            <input type="text" name="manualApprovalBlackConversionFactor" value="${htmlEscape(manualApproval.blackConversionFactor ?? '')}" placeholder="1.00" />
          </label>
          <label>
            <div class="label-text">Color conversion factor</div>
            <input type="text" name="manualApprovalColorConversionFactor" value="${htmlEscape(manualApproval.colorConversionFactor ?? '')}" placeholder="1.00" />
          </label>
          <label class="span-3">
            <div class="label-text">ICC profile path</div>
            <input type="text" name="manualApprovalIccProfilePath" value="${htmlEscape(manualApproval.iccProfilePath ?? '')}" placeholder="/opt/print-profiles/printer.icc" />
          </label>
        </div>
      </div>
      <div class="subsection">
        <div class="subsection-title">Usage-based ink pricing floor</div>
        <p class="muted small">Leave all fields empty to disable.</p>
        <div class="grid-3" style="margin-top:10px;">
          <label>
            <div class="label-text">Black full-page price (paise)</div>
            <input type="text" name="pricingFloorBlackFullPagePriceMinor" value="${htmlEscape(pricingFloor.blackFullPagePriceMinor ?? '')}" placeholder="500" />
          </label>
          <label>
            <div class="label-text">Color full-page price (paise)</div>
            <input type="text" name="pricingFloorColorFullPagePriceMinor" value="${htmlEscape(pricingFloor.colorFullPagePriceMinor ?? '')}" placeholder="1200" />
          </label>
          <label>
            <div class="label-text">Black conversion factor</div>
            <input type="text" name="pricingFloorBlackConversionFactor" value="${htmlEscape(pricingFloor.blackConversionFactor ?? '')}" placeholder="1.00" />
          </label>
          <label>
            <div class="label-text">Color conversion factor</div>
            <input type="text" name="pricingFloorColorConversionFactor" value="${htmlEscape(pricingFloor.colorConversionFactor ?? '')}" placeholder="1.00" />
          </label>
          <label class="span-3">
            <div class="label-text">ICC profile path</div>
            <input type="text" name="pricingFloorIccProfilePath" value="${htmlEscape(pricingFloor.iccProfilePath ?? '')}" placeholder="/opt/print-profiles/printer.icc" />
          </label>
        </div>
      </div>
    </div>
  `
}

function renderPlatformPrinterForm(
  uiToken: string | null | undefined,
  availablePrinterNames: string[],
  printer?: PlatformPrinter,
) {
  const title = printer ? printer.name : 'Publish a new platform printer'
  const submitLabel = printer ? 'Save printer' : 'Publish printer'
  const status = printer?.status ?? 'ONLINE'
  const colorModes = printer?.supportedColorModes ?? COLOR_MODE_OPTIONS
  const sidesModes = printer?.supportedSidesModes ?? SIDES_MODE_OPTIONS
  const pageSizes = printer?.supportedPageSizes ?? PAGE_SIZE_OPTIONS
  const scalingModes = printer?.supportedScalingModes ?? SCALING_MODE_OPTIONS

  return `
    <form method="post" action="/platform-printers/save" class="stack">
      ${hiddenUiToken(uiToken)}
      ${printer ? `<input type="hidden" name="printerId" value="${htmlEscape(printer.printerId)}" />` : ''}
      <div class="card-title">${htmlEscape(title)}</div>
      <div class="grid-2">
        <label>
          <div class="label-text">Platform printer name</div>
          <input type="text" name="name" value="${htmlEscape(printer?.name ?? '')}" placeholder="Front Desk A4" required />
        </label>
        <label>
          <div class="label-text">Shared local printer</div>
          <select name="agentPrinterName" required>
            <option value="">Select a shared printer</option>
            ${availablePrinterNames
              .map(
                (printerName) =>
                  `<option value="${htmlEscape(printerName)}" ${selected(printer?.agentPrinterName, printerName)}>${htmlEscape(printerName)}</option>`,
              )
              .join('')}
          </select>
        </label>
        <label class="choice">
          <input type="checkbox" name="enabled" ${checked(printer?.enabled ?? true)} />
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
        <div class="subsection-title">Pricing (amounts in paise, ₹1 = 100 paise)</div>
        <div class="grid-3" style="margin-top:10px;">
          <label>
            <div class="label-text">Base job price</div>
            <input type="text" name="baseJobPriceMinor" value="${htmlEscape(String(printer?.baseJobPriceMinor ?? 0))}" />
          </label>
          <label>
            <div class="label-text">Monochrome page price</div>
            <input type="text" name="monochromePagePriceMinor" value="${htmlEscape(String(printer?.monochromePagePriceMinor ?? 0))}" />
          </label>
          <label>
            <div class="label-text">Color page price</div>
            <input type="text" name="colorPagePriceMinor" value="${htmlEscape(String(printer?.colorPagePriceMinor ?? 0))}" />
          </label>
          <label>
            <div class="label-text">Duplex sheet surcharge</div>
            <input type="text" name="duplexSheetSurchargeMinor" value="${htmlEscape(String(printer?.duplexSheetSurchargeMinor ?? 0))}" />
          </label>
          <label>
            <div class="label-text">A3 page surcharge</div>
            <input type="text" name="a3PageSurchargeMinor" value="${htmlEscape(String(printer?.a3PageSurchargeMinor ?? 0))}" />
          </label>
          <label>
            <div class="label-text">Glossy paper surcharge</div>
            <input type="text" name="glossyPaperSurchargeMinor" value="${htmlEscape(String(printer?.glossyPaperSurchargeMinor ?? 0))}" />
          </label>
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
        <div class="subsection-title">Secure cover packet</div>
        <div class="grid-3" style="margin-top:10px;">
          <label class="choice span-3">
            <input type="checkbox" name="supportsSecureCoverSheets" ${checked(printer?.supportsSecureCoverSheets ?? false)} />
            <span>Offer secure cover packets</span>
          </label>
          <label>
            <div class="label-text">Secure cover surcharge</div>
            <input type="text" name="secureCoverSheetPriceMinor" value="${htmlEscape(String(printer?.secureCoverSheetPriceMinor ?? 0))}" />
          </label>
          <label>
            <div class="label-text">Secure cover color</div>
            <input type="text" name="secureCoverSheetColorName" value="${htmlEscape(printer?.secureCoverSheetColorName ?? 'WHITE')}" />
          </label>
          <label class="span-3">
            <div class="label-text">Secure cover label</div>
            <input type="text" name="secureCoverSheetLabel" value="${htmlEscape(printer?.secureCoverSheetLabel ?? 'SECURE-DO-NOT-OPEN')}" />
          </label>
        </div>
      </div>
      ${renderConstraintEditor(printer)}
      <div class="btn-row">
        <button class="btn btn-primary" type="submit">${htmlEscape(submitLabel)}</button>
      </div>
    </form>
  `
}

function buildManagedPrinterPayload(body: Record<string, unknown>, printerId?: string | null): PlatformPrinterUpsertInput {
  return {
    printerId: printerId || null,
    name: parseRequiredText(body, 'name'),
    agentPrinterName: parseRequiredText(body, 'agentPrinterName'),
    enabled: hasCheckbox(body, 'enabled'),
    status: parseRequiredText(body, 'status') as PlatformPrinterStatus,
    glossyPaperSurchargeMinor: parseNonNegativeInteger(body, 'glossyPaperSurchargeMinor'),
    baseJobPriceMinor: parseNonNegativeInteger(body, 'baseJobPriceMinor'),
    monochromePagePriceMinor: parseNonNegativeInteger(body, 'monochromePagePriceMinor'),
    colorPagePriceMinor: parseNonNegativeInteger(body, 'colorPagePriceMinor'),
    duplexSheetSurchargeMinor: parseNonNegativeInteger(body, 'duplexSheetSurchargeMinor'),
    a3PageSurchargeMinor: parseNonNegativeInteger(body, 'a3PageSurchargeMinor'),
    documentConstraints: buildDocumentConstraints(body),
    pricingAdjustments: buildPricingAdjustments(body),
    supportedColorModes: asArray(body.supportedColorModes) as PlatformColorMode[],
    supportedSidesModes: asArray(body.supportedSidesModes) as PlatformSidesMode[],
    supportedPageSizes: asArray(body.supportedPageSizes) as PlatformPageSize[],
    supportedScalingModes: asArray(body.supportedScalingModes) as PlatformScalingMode[],
    supportsSecureCoverSheets: hasCheckbox(body, 'supportsSecureCoverSheets'),
    secureCoverSheetPriceMinor: parseNonNegativeInteger(body, 'secureCoverSheetPriceMinor'),
    secureCoverSheetColorName: parseRequiredText(body, 'secureCoverSheetColorName'),
    secureCoverSheetLabel: parseRequiredText(body, 'secureCoverSheetLabel'),
  }
}

function buildDocumentConstraints(body: Record<string, unknown>): ConfiguredConstraint[] {
  const constraints: ConfiguredConstraint[] = []
  const maxSizeMb = parseOptionalTrimmed(body, 'constraintMaxSizeMb')
  if (maxSizeMb) constraints.push({ type: 'MAX_SINGLE_PDF_SIZE', configuration: { maxSizeMb } })
  const maxPageCount = parseOptionalTrimmed(body, 'constraintMaxPageCount')
  if (maxPageCount) constraints.push({ type: 'MAX_SINGLE_PDF_PAGE_COUNT', configuration: { maxPageCount } })
  const maxPageCoveragePercent = parseOptionalTrimmed(body, 'constraintMaxPageCoveragePercent')
  if (maxPageCoveragePercent) constraints.push({ type: 'MAX_SINGLE_PDF_PAGE_COVERAGE', configuration: { maxPageCoveragePercent } })
  const manualApprovalCoverage = parseOptionalTrimmed(body, 'manualApprovalMaxPageCoveragePercent')
  const manualApprovalBlackPrice = parseOptionalTrimmed(body, 'manualApprovalBlackFullPagePriceMinor')
  const manualApprovalColorPrice = parseOptionalTrimmed(body, 'manualApprovalColorFullPagePriceMinor')
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

function buildPricingAdjustments(body: Record<string, unknown>): ConfiguredConstraint[] {
  const blackPrice = parseOptionalTrimmed(body, 'pricingFloorBlackFullPagePriceMinor')
  const colorPrice = parseOptionalTrimmed(body, 'pricingFloorColorFullPagePriceMinor')
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
// Route server
// ---------------------------------------------------------------------------

export async function startUiServer(runtime: AgentRuntime) {
  const app = express()

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
  app.use(express.urlencoded({ extended: false }))

  // ── Health (JSON, no page shell) ──────────────────────────────────────────
  app.get('/health', (_request, response) => {
    const snapshot = runtime.snapshot()
    response.json({
      status: 'UP',
      version: AGENT_VERSION,
      registered: !!snapshot.registration?.agentId,
      agentStatus: snapshot.registration?.status ?? null,
      completedToday: snapshot.stats?.completedJobsToday ?? 0,
      failedToday: snapshot.stats?.failedJobsToday ?? 0,
      activeJobs: snapshot.stats?.activeJobCount ?? 0,
      lastError: snapshot.lastError ?? null,
    })
  })

  // ── Dashboard ─────────────────────────────────────────────────────────────
  app.get('/', (request, response) => {
    const snapshot = runtime.snapshot()
    const pickupSearch = typeof request.query.pickupCode === 'string' ? request.query.pickupCode.trim().toUpperCase() : ''
    const notice = typeof request.query.notice === 'string' ? request.query.notice : null
    const errorMessage = typeof request.query.error === 'string' ? request.query.error : null
    const readyForPickup = (snapshot.readyForPickup ?? []).filter((job) =>
      pickupSearch ? job.pickupCode.toUpperCase().includes(pickupSearch) : true,
    )
    const sharedPrinterNames = snapshot.printers.filter((printer) => printer.shared).map((printer) => printer.localPrinterName)
    const profile = snapshot.profile
    const platformPrinters = snapshot.platformPrinters ?? []
    const hostLocation = snapshot.hostLocation ?? null
    const configuredServerUrl = snapshot.serverUrl ?? defaultPrintAnywhereBackendUrl()
    const isRegistered = !!snapshot.registration?.agentId

    const content = `
      <div>
        <div class="page-eyebrow">Agent console</div>
        <div class="page-title">Dashboard</div>
      </div>

      <div class="card">
        <div class="card-title">Health &amp; status</div>
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
        <div class="subsection" style="margin-top:14px; padding-top:12px;">
          <div class="muted small">Last heartbeat: ${htmlEscape(formatTimestamp(snapshot.lastHeartbeatAt))}</div>
          <div class="muted small" style="margin-top:4px;">Last error: ${htmlEscape(snapshot.lastError ?? 'None')}</div>
          <div class="muted small" style="margin-top:4px;">Last job: ${htmlEscape(snapshot.lastJob ? `${snapshot.lastJob.jobId} · ${humanizeEnum(snapshot.lastJob.status)}` : 'None')}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Backend configuration</div>
        <form method="post" action="/configure" class="stack" id="configure-form">
          ${hiddenUiToken(snapshot.uiToken)}
          <input type="hidden" name="latitude" id="configure-location-latitude" />
          <input type="hidden" name="longitude" id="configure-location-longitude" />
          <input type="hidden" name="accuracyMeters" id="configure-location-accuracy" />
          <input type="hidden" name="capturedAt" id="configure-location-captured-at" />
          <input type="hidden" id="configure-location-attempted" value="false" />
          <label>
            <div class="label-text">PrintAnywhere server URL</div>
            <input type="url" name="serverUrl" value="${htmlEscape(configuredServerUrl)}" placeholder="${htmlEscape(defaultPrintAnywhereBackendUrl())}" required />
            <div class="hint">Production default is prefilled. Change only for a local test backend or support-directed override.</div>
          </label>
          <div class="grid-2">
            <label>
              <div class="label-text">Display name</div>
              <input type="text" name="displayName" value="${htmlEscape(snapshot.displayName ?? '')}" placeholder="Counter PC - Front Desk" />
            </label>
            <label>
              <div class="label-text">Business address for admin review</div>
              <input type="text" name="reportedBusinessAddress" value="${htmlEscape(snapshot.reportedBusinessAddress ?? profile?.reportedBusinessAddress ?? '')}" placeholder="Shop number, street, city, state" />
            </label>
          </div>
          ${isRegistered ? `<div class="hint">This machine is already registered. Saving updates local settings and sends the latest address/location on the next heartbeat; it does not create another machine.</div>` : ''}
          <div class="btn-row">
            <button class="btn btn-primary" type="submit">${isRegistered ? 'Save settings' : 'Save and register'}</button>
            <span class="muted small" id="configure-location-status"></span>
          </div>
        </form>
      </div>

      <div class="card">
        <div class="card-title">Branding &amp; white-label</div>
        <form method="post" action="/settings/branding" class="stack">
          ${hiddenUiToken(snapshot.uiToken)}
          <div class="grid-2">
            <label>
              <div class="label-text">Business name (shown in header)</div>
              <input type="text" name="brandName" value="${htmlEscape(snapshot.brandName ?? '')}" placeholder="Your Print Shop" />
            </label>
            <label>
              <div class="label-text">Business logo URL (optional)</div>
              <input type="url" name="brandLogoUrl" value="${htmlEscape(snapshot.brandLogoUrl ?? '')}" placeholder="https://yourshop.com/logo.png" />
            </label>
            <label class="span-2">
              <div class="label-text">Support contact email (shown on Support page)</div>
              <input type="email" name="supportContactEmail" value="${htmlEscape(snapshot.supportContactEmail ?? '')}" placeholder="support@yourshop.com" />
            </label>
          </div>
          <div class="btn-row">
            <button class="btn btn-primary" type="submit">Save branding</button>
          </div>
        </form>
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
            <form method="post" action="/actions/repair">
              ${hiddenUiToken(snapshot.uiToken)}
              <button class="btn btn-secondary" type="submit">Generate new pairing code</button>
            </form>
            <form method="post" action="/actions/refresh">
              ${hiddenUiToken(snapshot.uiToken)}
              <button class="btn btn-secondary" type="submit">Refresh printers</button>
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
        <div class="card-title">Ready for pickup</div>
        <form method="get" action="/" class="inline-form" style="margin-bottom:14px;">
          <label>
            <div class="label-text">Search by pickup code</div>
            <input type="text" name="pickupCode" value="${htmlEscape(pickupSearch)}" placeholder="Enter pickup code" style="width:220px;" />
          </label>
          <button class="btn btn-secondary" type="submit">Search</button>
        </form>
        <table class="data-table">
          <thead><tr><th>Pickup code</th><th>Customer</th><th>Printer</th><th>Completed</th><th>Action</th></tr></thead>
          <tbody>
            ${readyForPickup.length === 0
              ? `<tr><td colspan="5" class="muted">No completed secure pickup jobs are waiting.</td></tr>`
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
                  <td class="muted small">${htmlEscape(job.completedAt)}</td>
                  <td>
                    <form method="post" action="/jobs/collect">
                      ${hiddenUiToken(snapshot.uiToken)}
                      <input type="hidden" name="jobId" value="${htmlEscape(job.jobId)}" />
                      <button class="btn btn-primary" type="submit">Mark collected</button>
                    </form>
                  </td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-title">Published platform printers</div>
        <p class="muted small">These are the customer-facing printers published from this machine.</p>
        ${profile?.selfServiceEnabled
          ? renderPlatformPrinterForm(snapshot.uiToken, sharedPrinterNames)
          : `<div class="alert alert-info" style="margin-top:12px;">Admin approval is required before this machine can publish or edit platform printers.</div>`}
        ${platformPrinters.length === 0 ? '<p class="muted small" style="margin-top:12px;">No platform printers have been published from this machine yet.</p>' : ''}
        ${platformPrinters.length > 0
          ? `<div style="margin-top:16px;">
              ${platformPrinters
                .map(
                  (printer) => `
                    <details>
                      <summary>
                        <span>${htmlEscape(printer.name)} · <span class="muted">${htmlEscape(printer.agentPrinterName)}</span></span>
                        <span class="${printer.enabled ? 'badge badge-good' : 'badge'}">${printer.enabled ? 'Enabled' : 'Disabled'}</span>
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
                          <form method="post" action="/platform-printers/remove" style="margin-top:12px;">
                            ${hiddenUiToken(snapshot.uiToken)}
                            <input type="hidden" name="printerId" value="${htmlEscape(printer.printerId)}" />
                            <button class="btn btn-danger" type="submit">Unpublish printer</button>
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
            ${snapshot.printers.map((printer) => `
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
                  <form method="post" action="/printers/share">
                    ${hiddenUiToken(snapshot.uiToken)}
                    <input type="hidden" name="localPrinterName" value="${htmlEscape(printer.localPrinterName)}" />
                    <input type="hidden" name="shared" value="${printer.shared ? 'false' : 'true'}" />
                    <button class="btn btn-secondary" type="submit">${printer.shared ? 'Stop sharing' : 'Share printer'}</button>
                  </form>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-title">Recent jobs</div>
        <table class="data-table">
          <thead><tr><th>Job ID</th><th>Printer</th><th>Status</th><th>Details</th><th>Time</th></tr></thead>
          <tbody>
            ${(snapshot.recentJobs ?? []).length === 0
              ? `<tr><td colspan="5" class="muted">No jobs have run yet.</td></tr>`
              : (snapshot.recentJobs ?? []).map((job) => `
                <tr>
                  <td class="mono small">${htmlEscape(job.jobId)}</td>
                  <td>${htmlEscape(job.printerName)}</td>
                  <td><span class="${statusBadge(job.status)}">${htmlEscape(humanizeEnum(job.status))}</span></td>
                  <td>
                    ${htmlEscape(job.displayName ?? job.pickupCode ?? '—')}
                    ${job.failureReason ? `<br/><span class="muted small">${htmlEscape(job.failureReason)}</span>` : ''}
                  </td>
                  <td class="muted small">${htmlEscape(formatTimestamp(job.updatedAt))}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    `

    response.type('html').send(pageShell({ title: 'Dashboard', activePage: 'dashboard', snapshot, notice, error: errorMessage }, content))
  })

  // ── Orders ────────────────────────────────────────────────────────────────
  app.get('/orders', async (request, response) => {
    const snapshot = runtime.snapshot()
    const notice = typeof request.query.notice === 'string' ? request.query.notice : null
    const errorMessage = typeof request.query.error === 'string' ? request.query.error : null

    let ordersHtml = ''
    try {
      const orders = await runtime.listOrders()
      if (orders.length === 0) {
        ordersHtml = `<tr><td colspan="7" class="muted">No orders have been received yet.</td></tr>`
      } else {
        ordersHtml = orders.map((order) => `
          <tr>
            <td class="mono small">${htmlEscape(order.jobId.slice(0, 8))}…</td>
            <td>${htmlEscape(order.printerName)}</td>
            <td><span class="${statusBadge(order.status)}">${htmlEscape(humanizeEnum(order.status))}</span></td>
            <td>
              ${order.displayName ? htmlEscape(order.displayName) : '<span class="muted">—</span>'}
              ${order.pickupCode ? `<br/><span class="pickup-code" style="font-size:13px;">${htmlEscape(order.pickupCode)}</span>` : ''}
            </td>
            <td class="muted small">${order.pageCount} pages</td>
            <td class="muted small">${htmlEscape(formatTimestamp(order.queuedAt))}</td>
            <td class="muted small">${htmlEscape(formatTimestamp(order.completedAt ?? order.collectedAt ?? order.failedAt, '—'))}</td>
          </tr>
        `).join('')
      }
    } catch (error) {
      ordersHtml = `<tr><td colspan="7" class="muted">${htmlEscape(error instanceof Error ? error.message : 'Could not load orders')}</td></tr>`
    }

    const content = `
      <div>
        <div class="page-eyebrow">Print jobs</div>
        <div class="page-title">Orders</div>
      </div>
      <div class="card">
        <div class="card-title">All orders received at your printers</div>
        <table class="data-table">
          <thead><tr><th>Job ID</th><th>Printer</th><th>Status</th><th>Customer</th><th>Pages</th><th>Queued</th><th>Finished</th></tr></thead>
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
    const platformPrinters = snapshot.platformPrinters ?? []

    let couponsHtml = ''
    try {
      const coupons = await runtime.listCoupons()
      if (coupons.length === 0) {
        couponsHtml = `<tr><td colspan="7" class="muted">No coupons created yet. Use the form below to create your first coupon.</td></tr>`
      } else {
        couponsHtml = coupons.map((coupon) => `
          <tr>
            <td><strong class="mono">${htmlEscape(coupon.code)}</strong>${coupon.name ? `<br/><span class="muted small">${htmlEscape(coupon.name)}</span>` : ''}</td>
            <td><span class="${coupon.active ? 'badge badge-good' : 'badge badge-bad'}">${coupon.active ? 'Active' : 'Inactive'}</span></td>
            <td>${htmlEscape(humanizeEnum(coupon.discountType))}<br/><strong>${htmlEscape(formatCouponValue(coupon.discountType, coupon.discountValue))}</strong></td>
            <td>${htmlEscape(humanizeEnum(coupon.couponScope))}</td>
            <td class="muted small">${coupon.usedCount} uses${coupon.maxUses ? ` / ${coupon.maxUses}` : ''}</td>
            <td class="muted small">${htmlEscape(formatTimestamp(coupon.expiresAt, 'No expiry'))}</td>
            <td>
              <form method="post" action="/coupons/toggle" style="display:inline;">
                ${hiddenUiToken(snapshot.uiToken)}
                <input type="hidden" name="couponId" value="${htmlEscape(coupon.couponId)}" />
                <input type="hidden" name="active" value="${coupon.active ? 'false' : 'true'}" />
                <button class="btn btn-secondary" type="submit" style="font-size:12px; padding:5px 10px;">${coupon.active ? 'Deactivate' : 'Activate'}</button>
              </form>
            </td>
          </tr>
        `).join('')
      }
    } catch (error) {
      couponsHtml = `<tr><td colspan="7" class="muted">${htmlEscape(error instanceof Error ? error.message : 'Could not load coupons')}</td></tr>`
    }

    const printerOptions = platformPrinters.map(
      (p) => `<option value="${htmlEscape(p.printerId)}">${htmlEscape(p.name)}</option>`,
    ).join('')

    const content = `
      <div>
        <div class="page-eyebrow">Promotions</div>
        <div class="page-title">Coupons</div>
      </div>
      <div class="alert alert-info">
        Agent and printer coupons are <strong>not shown</strong> on the customer promo preview list. Customers can enter them manually at checkout — they are validated automatically at your printer.
      </div>
      <div class="card">
        <div class="card-title">Your coupons</div>
        <table class="data-table">
          <thead><tr><th>Code</th><th>Status</th><th>Discount</th><th>Scope</th><th>Usage</th><th>Expires</th><th>Action</th></tr></thead>
          <tbody>${couponsHtml}</tbody>
        </table>
      </div>
      <div class="card">
        <div class="card-title">Create a new coupon</div>
        <form method="post" action="/coupons/create" class="stack">
          ${hiddenUiToken(snapshot.uiToken)}
          <div class="grid-2">
            <label>
              <div class="label-text">Coupon code</div>
              <input type="text" name="code" placeholder="SUMMER20" required style="text-transform:uppercase;" />
              <div class="hint">Customers enter this exactly. Alphanumeric, no spaces recommended.</div>
            </label>
            <label>
              <div class="label-text">Display name (optional)</div>
              <input type="text" name="name" placeholder="Summer Sale 20%" />
            </label>
            <label>
              <div class="label-text">Discount type</div>
              <select name="discountType" required>
                <option value="PERCENTAGE">Percentage off</option>
                <option value="FIXED_AMOUNT">Fixed amount off (paise)</option>
                <option value="PER_PAGE_FIXED">Per-page discount (paise)</option>
              </select>
            </label>
            <label>
              <div class="label-text">Discount value</div>
              <input type="number" name="discountValue" min="1" placeholder="20" required />
              <div class="hint">For percentage: 1–100. For fixed/per-page: amount in paise (₹1 = 100 paise).</div>
            </label>
            <label>
              <div class="label-text">Scope</div>
              <select name="couponScope" id="coupon-scope-select" required>
                <option value="AGENT">All my printers (Agent scope)</option>
                <option value="PRINTER">Specific printer only</option>
              </select>
            </label>
            <label id="printer-select-label">
              <div class="label-text">Printer (for Printer scope)</div>
              <select name="printerId">
                <option value="">— Select printer —</option>
                ${printerOptions}
              </select>
            </label>
            <label>
              <div class="label-text">Starts at (optional)</div>
              <input type="date" name="startsAt" />
            </label>
            <label>
              <div class="label-text">Expires at (optional)</div>
              <input type="date" name="expiresAt" />
            </label>
            <label>
              <div class="label-text">Max total uses (optional)</div>
              <input type="number" name="maxUses" min="1" placeholder="100" />
            </label>
            <label>
              <div class="label-text">Max uses per customer (optional)</div>
              <input type="number" name="maxUsesPerUser" min="1" placeholder="1" />
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
            <p>The agent console at <code>localhost:43100</code> does not use a password. It uses a machine-level security token automatically. If you can open this page, you are already authenticated.</p>
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
          <summary>Agent console is not opening at localhost:43100</summary>
          <div class="faq-a" style="margin-top:10px;">
            <ol style="padding-left:18px; line-height:2;">
              <li>Check that the PrintAnywhere Agent is running: look for it in the system tray or check Windows Services.</li>
              <li>If the service is stopped, start it from Services (<kbd>Win + R</kbd> → <code>services.msc</code> → find "PrintAnywhere Agent" → Start).</li>
              <li>If it crashes immediately after starting, check the agent log file in <code>%AppData%\PrintAnywhere\logs\</code>.</li>
              <li>Try a different browser or clear the browser cache. The console is only accessible from <strong>this computer</strong> (localhost).</li>
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
    try {
      await runtime.configure(
        String(request.body.serverUrl ?? ''),
        String(request.body.displayName ?? ''),
        String(request.body.reportedBusinessAddress ?? ''),
      )
      const location = parseBrowserLocationBody(request.body as Record<string, unknown>)
      if (location) await runtime.setBrowserLocation(location)
      redirectWithStatus(response, 'notice', 'Backend configuration saved.')
    } catch (error) {
      redirectWithStatus(response, 'error', friendlyConfigureError(error))
    }
  })

  app.post('/settings/branding', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    try {
      const body = request.body as Record<string, unknown>
      await runtime.updateBranding(
        parseOptionalTrimmed(body, 'brandName'),
        parseOptionalTrimmed(body, 'brandLogoUrl'),
        parseOptionalTrimmed(body, 'supportContactEmail'),
      )
      redirectWithStatus(response, 'notice', 'Branding settings saved.')
    } catch (error) {
      redirectWithStatus(response, 'error', error instanceof Error ? error.message : 'Could not save branding')
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
    try {
      const body = request.body as Record<string, unknown>
      await runtime.upsertPlatformPrinter(buildManagedPrinterPayload(body, parseOptionalTrimmed(body, 'printerId')))
      redirectWithStatus(response, 'notice', 'Platform printer saved.')
    } catch (error) {
      redirectWithStatus(response, 'error', error instanceof Error ? error.message : 'Could not save platform printer')
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
    try {
      const body = request.body as Record<string, unknown>
      const scope = String(body.couponScope ?? 'AGENT')
      const printerId = scope === 'PRINTER' ? parseOptionalTrimmed(body, 'printerId') : null
      const payload: AgentCouponUpsertPayload = {
        code: parseRequiredText(body, 'code').toUpperCase(),
        name: parseOptionalTrimmed(body, 'name'),
        discountType: parseRequiredText(body, 'discountType'),
        discountValue: parseRequiredNumber(body, 'discountValue'),
        active: true,
        startsAt: startsAtIso(parseOptionalTrimmed(body, 'startsAt')),
        expiresAt: expiresAtIso(parseOptionalTrimmed(body, 'expiresAt')),
        maxUses: parseOptionalInt(body, 'maxUses'),
        maxUsesPerUser: parseOptionalInt(body, 'maxUsesPerUser'),
        couponScope: scope as 'AGENT' | 'PRINTER',
        printerId,
      }
      await runtime.createCoupon(payload)
      redirectTo(response, '/coupons', 'notice', 'Coupon created successfully.')
    } catch (error) {
      redirectTo(response, '/coupons', 'error', error instanceof Error ? error.message : 'Could not create coupon')
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
  const port = Number(process.env.PRINTANYWHERE_AGENT_PORT ?? 43100)
  return new Promise<{ close: () => Promise<void> }>((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      console.log(`PrintAnywhere Agent UI listening on http://127.0.0.1:${port}`)
      resolve({
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()))
          }),
      })
    })
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

function startsAtIso(dateStr: string | null) {
  if (!dateStr) return null
  return new Date(`${dateStr}T00:00:00`).toISOString()
}

function expiresAtIso(dateStr: string | null) {
  if (!dateStr) return null
  return new Date(`${dateStr}T23:59:59`).toISOString()
}
