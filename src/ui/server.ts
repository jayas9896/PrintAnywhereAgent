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
import { defaultPrintAnywhereBackendUrl } from '../config/defaults.js'
import type { AgentRuntime, PlatformPrinterUpsertInput } from '../runtime/agentRuntime.js'

const COLOR_MODE_OPTIONS: PlatformColorMode[] = ['MONOCHROME', 'COLOR']
const SIDES_MODE_OPTIONS: PlatformSidesMode[] = ['SINGLE_SIDED', 'DOUBLE_SIDED']
const PAGE_SIZE_OPTIONS: PlatformPageSize[] = ['A4', 'A3']
const SCALING_MODE_OPTIONS: PlatformScalingMode[] = ['ACTUAL_SIZE', 'FIT_TO_PAGE', 'SHRINK_TO_FIT']
const PRINTER_STATUS_OPTIONS: PlatformPrinterStatus[] = ['ONLINE', 'BUSY', 'OFFLINE', 'MAINTENANCE']

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
  if (!value) {
    throw new Error(`${humanizeKey(key)} is required.`)
  }
  return value
}

function parseRequiredNumber(body: Record<string, unknown>, key: string) {
  const value = String(body[key] ?? '').trim()
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${humanizeKey(key)} must be a valid number.`)
  }
  return parsed
}

function parseNonNegativeInteger(body: Record<string, unknown>, key: string) {
  const parsed = Math.round(parseRequiredNumber(body, key))
  if (parsed < 0) {
    throw new Error(`${humanizeKey(key)} must be zero or higher.`)
  }
  return parsed
}

function parseOptionalTrimmed(body: Record<string, unknown>, key: string) {
  const value = String(body[key] ?? '').trim()
  return value || null
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
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function formatLocationSnapshot(location?: AgentLocationSnapshot | null) {
  if (!location) {
    return 'No device location captured'
  }
  const accuracy = location.accuracyMeters != null ? ` · ±${Math.round(location.accuracyMeters)}m` : ''
  return `${location.latitude}, ${location.longitude}${accuracy} · ${humanizeEnum(location.source)} · ${formatTimestamp(location.capturedAt)}`
}

function redirectWithStatus(response: Response, type: 'notice' | 'error', message: string) {
  const url = new URL('http://local/')
  url.searchParams.set(type, message)
  response.redirect(url.pathname + url.search)
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

function renderConstraintEditor(printer: PlatformPrinter | null | undefined) {
  const size = findConstraint(printer, 'MAX_SINGLE_PDF_SIZE')
  const pageCount = findConstraint(printer, 'MAX_SINGLE_PDF_PAGE_COUNT')
  const pageCoverage = findConstraint(printer, 'MAX_SINGLE_PDF_PAGE_COVERAGE')
  const manualApproval = findConstraint(printer, 'REQUIRE_MANUAL_APPROVAL_FOR_DENSITY_OR_PRICE_CHANGE')
  const pricingFloor = findPricingAdjustment(printer, 'INK_COVERAGE_FLOOR')

  return `
    <div class="subsection">
      <h4>Document constraints</h4>
      <div class="grid-3">
        <label>
          <div class="muted">Max single PDF size (MB)</div>
          <input type="text" name="constraintMaxSizeMb" value="${htmlEscape(size.maxSizeMb ?? '')}" placeholder="15" />
        </label>
        <label>
          <div class="muted">Max single PDF pages</div>
          <input type="text" name="constraintMaxPageCount" value="${htmlEscape(pageCount.maxPageCount ?? '')}" placeholder="100" />
        </label>
        <label>
          <div class="muted">Max printed area per page (%)</div>
          <input type="text" name="constraintMaxPageCoveragePercent" value="${htmlEscape(pageCoverage.maxPageCoveragePercent ?? '')}" placeholder="65" />
        </label>
      </div>
      <div class="subsection">
        <h4>Manual approval for dense or repriced PDFs</h4>
        <div class="muted">Leave all fields empty to disable this rule.</div>
        <div class="grid-3">
          <label>
            <div class="muted">Coverage threshold (%)</div>
            <input type="text" name="manualApprovalMaxPageCoveragePercent" value="${htmlEscape(manualApproval.maxPageCoveragePercent ?? '')}" placeholder="65" />
          </label>
          <label>
            <div class="muted">Black full-page price (minor units)</div>
            <input type="text" name="manualApprovalBlackFullPagePriceMinor" value="${htmlEscape(manualApproval.blackFullPagePriceMinor ?? '')}" placeholder="500" />
          </label>
          <label>
            <div class="muted">Color full-page price (minor units)</div>
            <input type="text" name="manualApprovalColorFullPagePriceMinor" value="${htmlEscape(manualApproval.colorFullPagePriceMinor ?? '')}" placeholder="1200" />
          </label>
          <label>
            <div class="muted">Black conversion factor</div>
            <input type="text" name="manualApprovalBlackConversionFactor" value="${htmlEscape(manualApproval.blackConversionFactor ?? '')}" placeholder="1.00" />
          </label>
          <label>
            <div class="muted">Color conversion factor</div>
            <input type="text" name="manualApprovalColorConversionFactor" value="${htmlEscape(manualApproval.colorConversionFactor ?? '')}" placeholder="1.00" />
          </label>
          <label class="grid-span-3">
            <div class="muted">ICC profile path</div>
            <input type="text" name="manualApprovalIccProfilePath" value="${htmlEscape(manualApproval.iccProfilePath ?? '')}" placeholder="/opt/print-profiles/printer.icc" />
          </label>
        </div>
      </div>
      <div class="subsection">
        <h4>Usage-based ink pricing floor</h4>
        <div class="muted">Leave all required fields empty to disable usage-based price uplift.</div>
        <div class="grid-3">
          <label>
            <div class="muted">Black full-page price (minor units)</div>
            <input type="text" name="pricingFloorBlackFullPagePriceMinor" value="${htmlEscape(pricingFloor.blackFullPagePriceMinor ?? '')}" placeholder="500" />
          </label>
          <label>
            <div class="muted">Color full-page price (minor units)</div>
            <input type="text" name="pricingFloorColorFullPagePriceMinor" value="${htmlEscape(pricingFloor.colorFullPagePriceMinor ?? '')}" placeholder="1200" />
          </label>
          <label>
            <div class="muted">Black conversion factor</div>
            <input type="text" name="pricingFloorBlackConversionFactor" value="${htmlEscape(pricingFloor.blackConversionFactor ?? '')}" placeholder="1.00" />
          </label>
          <label>
            <div class="muted">Color conversion factor</div>
            <input type="text" name="pricingFloorColorConversionFactor" value="${htmlEscape(pricingFloor.colorConversionFactor ?? '')}" placeholder="1.00" />
          </label>
          <label class="grid-span-3">
            <div class="muted">ICC profile path</div>
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
      <h3>${htmlEscape(title)}</h3>
      <div class="grid-2">
        <label>
          <div class="muted">Platform printer name</div>
          <input type="text" name="name" value="${htmlEscape(printer?.name ?? '')}" placeholder="Front Desk A4" required />
        </label>
        <label>
          <div class="muted">Shared local printer</div>
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
          <div class="muted">Status</div>
          <select name="status">
            ${PRINTER_STATUS_OPTIONS.map(
              (option) => `<option value="${option}" ${selected(status, option)}>${htmlEscape(humanizeEnum(option))}</option>`,
            ).join('')}
          </select>
        </label>
      </div>

      <div class="subsection">
        <h4>Pricing</h4>
        <div class="grid-3">
          <label>
            <div class="muted">Base job price</div>
            <input type="text" name="baseJobPriceMinor" value="${htmlEscape(String(printer?.baseJobPriceMinor ?? 0))}" />
          </label>
          <label>
            <div class="muted">Monochrome page price</div>
            <input type="text" name="monochromePagePriceMinor" value="${htmlEscape(String(printer?.monochromePagePriceMinor ?? 0))}" />
          </label>
          <label>
            <div class="muted">Color page price</div>
            <input type="text" name="colorPagePriceMinor" value="${htmlEscape(String(printer?.colorPagePriceMinor ?? 0))}" />
          </label>
          <label>
            <div class="muted">Duplex sheet surcharge</div>
            <input type="text" name="duplexSheetSurchargeMinor" value="${htmlEscape(String(printer?.duplexSheetSurchargeMinor ?? 0))}" />
          </label>
          <label>
            <div class="muted">A3 page surcharge</div>
            <input type="text" name="a3PageSurchargeMinor" value="${htmlEscape(String(printer?.a3PageSurchargeMinor ?? 0))}" />
          </label>
          <label>
            <div class="muted">Glossy paper surcharge</div>
            <input type="text" name="glossyPaperSurchargeMinor" value="${htmlEscape(String(printer?.glossyPaperSurchargeMinor ?? 0))}" />
          </label>
        </div>
      </div>

      <div class="subsection">
        <h4>Customer-facing capabilities</h4>
        <div class="grid-2">
          <div>
            <div class="muted">Color modes</div>
            <div class="choices">${renderCheckboxGroup('supportedColorModes', COLOR_MODE_OPTIONS, colorModes)}</div>
          </div>
          <div>
            <div class="muted">Sides modes</div>
            <div class="choices">${renderCheckboxGroup('supportedSidesModes', SIDES_MODE_OPTIONS, sidesModes)}</div>
          </div>
          <div>
            <div class="muted">Page sizes</div>
            <div class="choices">${renderCheckboxGroup('supportedPageSizes', PAGE_SIZE_OPTIONS, pageSizes)}</div>
          </div>
          <div>
            <div class="muted">Scaling modes</div>
            <div class="choices">${renderCheckboxGroup('supportedScalingModes', SCALING_MODE_OPTIONS, scalingModes)}</div>
          </div>
        </div>
      </div>

      <div class="subsection">
        <h4>Secure cover packet</h4>
        <div class="grid-3">
          <label class="choice">
            <input type="checkbox" name="supportsSecureCoverSheets" ${checked(printer?.supportsSecureCoverSheets ?? false)} />
            <span>Offer secure cover packets</span>
          </label>
          <label>
            <div class="muted">Secure cover surcharge</div>
            <input type="text" name="secureCoverSheetPriceMinor" value="${htmlEscape(String(printer?.secureCoverSheetPriceMinor ?? 0))}" />
          </label>
          <label>
            <div class="muted">Secure cover color</div>
            <input type="text" name="secureCoverSheetColorName" value="${htmlEscape(printer?.secureCoverSheetColorName ?? 'WHITE')}" />
          </label>
          <label class="grid-span-3">
            <div class="muted">Secure cover label</div>
            <input type="text" name="secureCoverSheetLabel" value="${htmlEscape(printer?.secureCoverSheetLabel ?? 'SECURE-DO-NOT-OPEN')}" />
          </label>
        </div>
      </div>

      ${renderConstraintEditor(printer)}

      <div class="actions">
        <button type="submit">${htmlEscape(submitLabel)}</button>
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
  if (maxSizeMb) {
    constraints.push({
      type: 'MAX_SINGLE_PDF_SIZE',
      configuration: { maxSizeMb },
    })
  }
  const maxPageCount = parseOptionalTrimmed(body, 'constraintMaxPageCount')
  if (maxPageCount) {
    constraints.push({
      type: 'MAX_SINGLE_PDF_PAGE_COUNT',
      configuration: { maxPageCount },
    })
  }
  const maxPageCoveragePercent = parseOptionalTrimmed(body, 'constraintMaxPageCoveragePercent')
  if (maxPageCoveragePercent) {
    constraints.push({
      type: 'MAX_SINGLE_PDF_PAGE_COVERAGE',
      configuration: { maxPageCoveragePercent },
    })
  }
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
  if (!blackPrice && !colorPrice) {
    return []
  }
  return [
    {
      type: 'INK_COVERAGE_FLOOR',
      configuration: stripNullish({
        blackFullPagePriceMinor: blackPrice,
        colorFullPagePriceMinor: colorPrice,
        blackConversionFactor: parseOptionalTrimmed(body, 'pricingFloorBlackConversionFactor'),
        colorConversionFactor: parseOptionalTrimmed(body, 'pricingFloorColorConversionFactor'),
        iccProfilePath: parseOptionalTrimmed(body, 'pricingFloorIccProfilePath'),
      }),
    },
  ]
}

function stripNullish(value: Record<string, string | null>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item != null && item !== ''),
  ) as Record<string, string>
}

function approvalTone(status: AgentApprovalStatus | null | undefined) {
  switch (status) {
    case 'APPROVED':
      return 'pill good'
    case 'SUSPENDED':
    case 'REJECTED':
      return 'pill bad'
    default:
      return 'pill'
  }
}

export async function startUiServer(runtime: AgentRuntime) {
  const app = express()
  app.use(express.urlencoded({ extended: false }))

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

    response.type('html').send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>PrintAnywhere Agent</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 24px; background: #f5f7f6; color: #142018; }
      .panel { background: #fff; border: 1px solid #dbe5df; border-radius: 16px; padding: 18px; margin-bottom: 16px; }
      h1, h2, h3, h4 { margin: 0 0 12px; }
      form.stack { display: grid; gap: 12px; }
      input[type=text], input[type=url], select { padding: 10px 12px; border-radius: 10px; border: 1px solid #cad7cf; width: 100%; box-sizing: border-box; }
      button { padding: 10px 14px; border: 0; border-radius: 999px; background: #184d31; color: #fff; cursor: pointer; }
      button.secondary { background: #eef3ef; color: #184d31; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 10px; border-top: 1px solid #edf2ee; vertical-align: top; }
      .muted { color: #617261; font-size: 14px; }
      .code { font-family: ui-monospace, monospace; letter-spacing: .15em; font-size: 20px; }
      .actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
      .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
      .stat { background: #f7faf8; border: 1px solid #e6efea; border-radius: 12px; padding: 12px; }
      .pill { display: inline-block; border-radius: 999px; background: #edf4ef; color: #184d31; padding: 3px 10px; font-size: 12px; }
      .pill.good { background: #dff5e6; color: #146030; }
      .pill.bad { background: #fde7e5; color: #8b2d22; }
      .pickup-code { font-family: ui-monospace, monospace; font-size: 18px; letter-spacing: .12em; }
      .inline-form { display: inline-flex; gap: 8px; align-items: center; }
      .grid-2, .grid-3 { display: grid; gap: 12px; }
      .grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .grid-span-3 { grid-column: 1 / -1; }
      .choices { display: grid; gap: 8px; margin-top: 8px; }
      .choice { display: flex; gap: 8px; align-items: center; }
      .notice { padding: 12px 14px; border-radius: 12px; margin-bottom: 16px; }
      .notice.good { background: #e7f7ec; color: #155c31; border: 1px solid #c8e7d2; }
      .notice.bad { background: #fdeceb; color: #8b2d22; border: 1px solid #f7c9c4; }
      .subsection { border-top: 1px solid #edf2ee; padding-top: 12px; }
      details { border: 1px solid #e6efea; border-radius: 12px; padding: 12px; }
      summary { cursor: pointer; font-weight: 600; }
    </style>
  </head>
  <body>
    <div class="panel">
      <h1>PrintAnywhere Agent</h1>
      <p class="muted">Local operator console for a print-shop owner machine.</p>
      <div class="muted">Admin verifies business identity and location centrally. This local console only manages printer inventory after the agent is approved.</div>
    </div>

    ${notice ? `<div class="notice good">${htmlEscape(notice)}</div>` : ''}
    ${errorMessage ? `<div class="notice bad">${htmlEscape(errorMessage)}</div>` : ''}

    <div class="panel">
      <h2>Backend configuration</h2>
      <form method="post" action="/configure" class="stack">
        ${hiddenUiToken(snapshot.uiToken)}
        <label>
          <div class="muted">PrintAnywhere server URL</div>
          <input type="url" name="serverUrl" value="${htmlEscape(configuredServerUrl)}" placeholder="${htmlEscape(defaultPrintAnywhereBackendUrl())}" required />
          <div class="muted">Production default is prefilled. Change it only for a local test backend or support-directed override.</div>
        </label>
        <label>
          <div class="muted">Display name</div>
          <input type="text" name="displayName" value="${htmlEscape(snapshot.displayName ?? '')}" placeholder="Counter PC - Front Desk" />
        </label>
        <button type="submit">Save and register</button>
      </form>
    </div>

    <div class="panel">
      <h2>Registration and approval</h2>
      <div class="grid-2">
        <div>
          <div class="muted">Machine ID</div>
          <div>${htmlEscape(snapshot.identity?.machineId ?? 'Not initialized')}</div>
          <div class="muted" style="margin-top:12px;">Registration status</div>
          <div><span class="pill">${htmlEscape(profile?.registrationStatus ?? snapshot.registration?.status ?? 'Not registered')}</span></div>
          <div class="muted" style="margin-top:12px;">Approval</div>
          <div><span class="${approvalTone(profile?.approvalStatus)}">${htmlEscape(humanizeEnum(profile?.approvalStatus ?? 'PENDING_REVIEW'))}</span></div>
          <div class="muted" style="margin-top:12px;">Self-service printer management</div>
          <div>${profile?.selfServiceEnabled ? 'Enabled' : 'Blocked until admin approval'}</div>
        </div>
        <div>
          <div class="muted">Verified business name</div>
          <div>${htmlEscape(profile?.businessName ?? 'Pending admin review')}</div>
          <div class="muted" style="margin-top:12px;">Verified address</div>
          <div>${htmlEscape(profile?.businessAddress ?? 'Pending admin review')}</div>
          <div class="muted" style="margin-top:12px;">Verified coordinates</div>
          <div>${htmlEscape(
            profile?.businessLatitude != null && profile?.businessLongitude != null
              ? `${profile.businessLatitude}, ${profile.businessLongitude}`
              : 'Pending admin review',
          )}</div>
          <div class="muted" style="margin-top:12px;">Approved at</div>
          <div>${htmlEscape(formatTimestamp(profile?.approvedAt, 'Not approved'))}</div>
        </div>
      </div>
      <div class="muted" style="margin-top:12px;">Pairing code</div>
      <div class="code">${htmlEscape(snapshot.registration?.pairingCode ?? '—')}</div>
      <div class="muted">Expires: ${htmlEscape(snapshot.registration?.pairingCodeExpiresAt ?? '—')}</div>
      <div class="actions" style="margin-top:14px;">
        <form method="post" action="/actions/repair">
          ${hiddenUiToken(snapshot.uiToken)}
          <button type="submit">Generate new pairing code</button>
        </form>
        <form method="post" action="/actions/refresh">
          ${hiddenUiToken(snapshot.uiToken)}
          <button type="submit">Refresh printers now</button>
        </form>
      </div>
    </div>

    <div class="panel">
      <h2>Host location</h2>
      <div class="muted">Latest device location</div>
      <div>${htmlEscape(formatLocationSnapshot(hostLocation))}</div>
      <div class="muted" style="margin-top:12px;">Published printers use this device location when available. If it cannot be captured, the backend uses the admin-approved business coordinates.</div>
      <form method="post" action="/location/browser" id="host-location-form" class="actions" style="margin-top:14px;">
        ${hiddenUiToken(snapshot.uiToken)}
        <input type="hidden" name="latitude" id="host-location-latitude" />
        <input type="hidden" name="longitude" id="host-location-longitude" />
        <input type="hidden" name="accuracyMeters" id="host-location-accuracy" />
        <input type="hidden" name="capturedAt" id="host-location-captured-at" />
        <button type="button" id="host-location-button">Use this device location</button>
        <span class="muted" id="host-location-status"></span>
      </form>
    </div>

    <div class="panel">
      <h2>Health</h2>
      <div class="stats">
        <div class="stat">
          <div class="muted">Active jobs</div>
          <strong>${snapshot.stats?.activeJobCount ?? 0}</strong>
        </div>
        <div class="stat">
          <div class="muted">Completed today</div>
          <strong>${snapshot.stats?.completedJobsToday ?? 0}</strong>
        </div>
        <div class="stat">
          <div class="muted">Failed today</div>
          <strong>${snapshot.stats?.failedJobsToday ?? 0}</strong>
        </div>
      </div>
      <div class="muted" style="margin-top:12px;">Last heartbeat: ${htmlEscape(snapshot.lastHeartbeatAt ?? 'Never')}</div>
      <div class="muted">Last error: ${htmlEscape(snapshot.lastError ?? 'None')}</div>
      <div class="muted">Last job: ${htmlEscape(snapshot.lastJob ? `${snapshot.lastJob.jobId} · ${snapshot.lastJob.status}` : 'None')}</div>
    </div>

    <div class="panel">
      <h2>Published platform printers</h2>
      <div class="muted">These are the actual customer-facing printers for this machine. The agent reports device location when available, and the backend falls back to the admin-approved business coordinates.</div>
      ${
        profile?.selfServiceEnabled
          ? renderPlatformPrinterForm(snapshot.uiToken, sharedPrinterNames)
          : `<p class="muted" style="margin-top:12px;">Admin approval is required before this machine can publish or edit platform printers.</p>`
      }
      ${platformPrinters.length === 0 ? '<p class="muted" style="margin-top:12px;">No platform printers have been published from this machine yet.</p>' : ''}
      ${
        platformPrinters.length > 0
          ? `
            <div style="margin-top:16px; display:grid; gap:12px;">
              ${platformPrinters
                .map(
                  (printer) => `
                    <details>
                      <summary>${htmlEscape(printer.name)} · ${htmlEscape(printer.agentPrinterName)} · ${htmlEscape(printer.enabled ? 'Enabled' : 'Hidden')}</summary>
                      <div class="muted" style="margin:8px 0 12px;">
                        Status ${htmlEscape(humanizeEnum(printer.status))} · Base ${htmlEscape(formatMinor(printer.baseJobPriceMinor))} · Mono ${htmlEscape(formatMinor(printer.monochromePagePriceMinor))} · Color ${htmlEscape(formatMinor(printer.colorPagePriceMinor))} · Location ${htmlEscape(
                          printer.latitude != null && printer.longitude != null
                            ? `${printer.latitude}, ${printer.longitude}`
                            : 'Fallback pending',
                        )}
                      </div>
                      ${
                        profile?.selfServiceEnabled
                          ? `
                            ${renderPlatformPrinterForm(snapshot.uiToken, sharedPrinterNames, printer)}
                            <form method="post" action="/platform-printers/remove" style="margin-top:12px;">
                              ${hiddenUiToken(snapshot.uiToken)}
                              <input type="hidden" name="printerId" value="${htmlEscape(printer.printerId)}" />
                              <button type="submit" class="secondary">Unpublish printer</button>
                            </form>
                          `
                          : `<div class="muted">Editing is blocked until the agent is approved.</div>`
                      }
                    </details>
                  `,
                )
                .join('')}
            </div>
          `
          : ''
      }
    </div>

    <div class="panel">
      <h2>Ready for pickup</h2>
      <form method="get" action="/" class="inline-form">
        <label style="flex:1">
          <div class="muted">Search by pickup code</div>
          <input type="text" name="pickupCode" value="${htmlEscape(pickupSearch)}" placeholder="Enter pickup code" />
        </label>
        <button type="submit">Search</button>
      </form>
      <table>
        <thead>
          <tr><th>Pickup code</th><th>Customer</th><th>Printer</th><th>Completed</th><th>Action</th></tr>
        </thead>
        <tbody>
          ${readyForPickup.length === 0 ? `
            <tr><td colspan="5" class="muted">No completed secure pickup jobs are waiting.</td></tr>
          ` : readyForPickup.map((job) => `
            <tr>
              <td><strong class="pickup-code">${htmlEscape(job.pickupCode)}</strong><br/><span class="muted">${htmlEscape(job.jobId)}</span></td>
              <td>${htmlEscape(job.displayName ?? 'Anonymous pickup')}<br/><span class="muted">${htmlEscape(job.pageCount ? `${job.pageCount} pages` : 'Page count unknown')}</span></td>
              <td>${htmlEscape(job.printerName)}</td>
              <td>${htmlEscape(job.completedAt)}</td>
              <td>
                <form method="post" action="/jobs/collect">
                  ${hiddenUiToken(snapshot.uiToken)}
                  <input type="hidden" name="jobId" value="${htmlEscape(job.jobId)}" />
                  <button type="submit">Mark as collected</button>
                </form>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h2>Shared local printers</h2>
      <div class="muted">Only shared local printers can be published as customer-facing platform printers.</div>
      <table>
        <thead>
          <tr><th>Printer</th><th>Capabilities</th><th>Share</th></tr>
        </thead>
        <tbody>
          ${snapshot.printers.map((printer) => `
            <tr>
              <td>
                <strong>${htmlEscape(printer.localPrinterName)}</strong><br/>
                <span class="muted">${htmlEscape(printer.driverName ?? 'Unknown driver')} · ${htmlEscape(printer.connectionType)}</span>
              </td>
              <td>
                <span class="muted">
                  ${printer.supportsColor ? 'Color' : 'Mono'} ·
                  ${printer.supportsDuplex ? 'Duplex' : 'Single-sided'} ·
                  ${htmlEscape(printer.supportedPaperSizes.join(', ') || 'Unknown sizes')}
                </span>
              </td>
              <td>
                <form method="post" action="/printers/share">
                  ${hiddenUiToken(snapshot.uiToken)}
                  <input type="hidden" name="localPrinterName" value="${htmlEscape(printer.localPrinterName)}" />
                  <input type="hidden" name="shared" value="${printer.shared ? 'false' : 'true'}" />
                  <button type="submit">${printer.shared ? 'Stop sharing' : 'Share printer'}</button>
                </form>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h2>Recent jobs</h2>
      <table>
        <thead>
          <tr><th>Job</th><th>Printer</th><th>Status</th><th>Details</th></tr>
        </thead>
        <tbody>
          ${(snapshot.recentJobs ?? []).length === 0 ? `
            <tr><td colspan="4" class="muted">No jobs have run yet.</td></tr>
          ` : (snapshot.recentJobs ?? []).map((job) => `
            <tr>
              <td>${htmlEscape(job.jobId)}<br/><span class="muted">${htmlEscape(job.updatedAt)}</span></td>
              <td>${htmlEscape(job.printerName)}</td>
              <td><span class="pill">${htmlEscape(job.status)}</span></td>
              <td>
                ${htmlEscape(job.displayName ?? job.pickupCode ?? '—')}
                ${job.failureReason ? `<br/><span class="muted">${htmlEscape(job.failureReason)}</span>` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <script>
      (function () {
        var button = document.getElementById('host-location-button');
        var status = document.getElementById('host-location-status');
        var form = document.getElementById('host-location-form');
        if (!button || !status || !form) return;
        button.addEventListener('click', function () {
          if (!navigator.geolocation) {
            status.textContent = 'Browser geolocation is not available.';
            return;
          }
          status.textContent = 'Requesting location permission...';
          navigator.geolocation.getCurrentPosition(function (position) {
            document.getElementById('host-location-latitude').value = String(position.coords.latitude);
            document.getElementById('host-location-longitude').value = String(position.coords.longitude);
            document.getElementById('host-location-accuracy').value = String(position.coords.accuracy || '');
            document.getElementById('host-location-captured-at').value = new Date(position.timestamp || Date.now()).toISOString();
            form.submit();
          }, function (error) {
            status.textContent = error && error.message ? error.message : 'Location permission was not granted.';
          }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 300000 });
        });
      })();
    </script>
  </body>
</html>`)
  })

  app.post('/configure', async (request, response) => {
    if (!verifyUiRequest(runtime, request, response)) return
    try {
      await runtime.configure(String(request.body.serverUrl ?? ''), String(request.body.displayName ?? ''))
      redirectWithStatus(response, 'notice', 'Backend configuration saved and agent registration refreshed.')
    } catch (error) {
      redirectWithStatus(response, 'error', error instanceof Error ? error.message : 'Configuration failed')
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
