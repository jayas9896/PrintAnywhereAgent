import { z } from 'zod'
import type {
  AgentJobQueueStatus,
  AgentPrinterStatus,
  ConfiguredConstraint,
  LocalPrinter,
  PollJob,
  PlatformPrinter,
} from '../config/types.js'

const registerResponseSchema = z.object({
  agentId: z.string(),
  agentSecret: z.string(),
  pairingCode: z.string(),
  pairingCodeExpiresAt: z.string(),
  status: z.string(),
})

const pollResponseSchema = z.object({
  jobId: z.string(),
  printerName: z.string(),
  downloadUrl: z.string().url(),
  leaseExpiresAt: z.string(),
  leaseToken: z.string(),
  encryptedJobKey: z.string(),
  settings: z.record(z.string(), z.unknown()),
  pickup: z
    .object({
      code: z.string().nullish(),
      displayName: z.string().nullish(),
      pageCount: z.number().nullish(),
    })
    .nullish(),
})

const reportedPrinterSchema = z.object({
  id: z.string(),
  localPrinterName: z.string(),
  driverName: z.string().nullish(),
  connectionType: z.string(),
  supportsColor: z.boolean(),
  supportsDuplex: z.boolean(),
  supportedPaperSizes: z.array(z.string()),
  defaultPrinter: z.boolean(),
  status: z.string(),
  shared: z.boolean(),
  reportedAt: z.string().nullish(),
})

const agentProfileSchema = z.object({
  agentId: z.string(),
  machineId: z.string(),
  registrationStatus: z.string(),
  approvalStatus: z.enum(['PENDING_REVIEW', 'APPROVED', 'SUSPENDED', 'REJECTED']),
  selfServiceEnabled: z.boolean(),
  displayName: z.string().nullish(),
  businessName: z.string().nullish(),
  businessAddress: z.string().nullish(),
  businessLatitude: z.number().nullish(),
  businessLongitude: z.number().nullish(),
  reportedBusinessAddress: z.string().nullish(),
  reportedLatitude: z.number().nullish(),
  reportedLongitude: z.number().nullish(),
  reportedLocationAccuracyMeters: z.number().nullish(),
  reportedLocationSource: z.string().nullish(),
  reportedLocationCapturedAt: z.string().nullish(),
  reportedLocationReceivedAt: z.string().nullish(),
  approvedAt: z.string().nullish(),
  approvedByUserId: z.string().nullish(),
  agentVersion: z.string().nullish(),
  osVersion: z.string().nullish(),
  lastHeartbeatAt: z.string().nullish(),
  activeJobCount: z.number(),
  completedJobsToday: z.number(),
  failedJobsToday: z.number(),
  reportedPrinters: z.array(reportedPrinterSchema),
})

const configuredConstraintSchema = z.object({
  id: z.string().nullish(),
  type: z.string(),
  displayOrder: z.number().nullish(),
  configuration: z.record(z.string(), z.string()),
  summary: z.string().nullish(),
})

const platformPrinterSchema = z.object({
  printerId: z.string(),
  name: z.string(),
  agentPrinterName: z.string(),
  routingMode: z.string(),
  enabled: z.boolean(),
  status: z.enum(['ONLINE', 'BUSY', 'OFFLINE', 'MAINTENANCE']),
  latitude: z.number().nullish(),
  longitude: z.number().nullish(),
  glossyPaperSurchargeMinor: z.number(),
  baseJobPriceMinor: z.number(),
  monochromePagePriceMinor: z.number(),
  colorPagePriceMinor: z.number(),
  duplexSheetSurchargeMinor: z.number(),
  a3PageSurchargeMinor: z.number(),
  supportedColorModes: z.array(z.enum(['MONOCHROME', 'COLOR'])),
  supportedSidesModes: z.array(z.enum(['SINGLE_SIDED', 'DOUBLE_SIDED'])),
  supportedPageSizes: z.array(z.enum(['A4', 'A3'])),
  supportedScalingModes: z.array(z.enum(['ACTUAL_SIZE', 'FIT_TO_PAGE', 'SHRINK_TO_FIT'])),
  supportsSecureCoverSheets: z.boolean(),
  secureCoverSheetPriceMinor: z.number(),
  secureCoverSheetColorName: z.string(),
  secureCoverSheetLabel: z.string(),
  documentConstraints: z.array(configuredConstraintSchema),
  pricingAdjustments: z.array(configuredConstraintSchema),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
})

export type PlatformPrinterUpsertPayload = Omit<
  PlatformPrinter,
  'printerId' | 'routingMode' | 'latitude' | 'longitude' | 'createdAt' | 'updatedAt'
> & {
  reportedLatitude?: number | null
  reportedLongitude?: number | null
  reportedLocationAccuracyMeters?: number | null
  reportedLocationSource?: string | null
  reportedLocationCapturedAt?: string | null
}

const agentOrderSchema = z.object({
  jobId: z.string(),
  printJobId: z.string(),
  printerId: z.string(),
  printerName: z.string(),
  localPrinterName: z.string(),
  status: z.string(),
  pickupCode: z.string().nullish(),
  displayName: z.string().nullish(),
  pageCount: z.number(),
  failureReason: z.string().nullish(),
  queuedAt: z.string().nullish(),
  completedAt: z.string().nullish(),
  collectedAt: z.string().nullish(),
  failedAt: z.string().nullish(),
})

export type AgentOrder = z.infer<typeof agentOrderSchema>

const agentCouponSchema = z.object({
  couponId: z.string(),
  code: z.string(),
  name: z.string().nullish(),
  discountType: z.string(),
  discountValue: z.number(),
  active: z.boolean(),
  startsAt: z.string().nullish(),
  expiresAt: z.string().nullish(),
  maxUses: z.number().nullish(),
  maxUsesPerUser: z.number().nullish(),
  usedCount: z.number(),
  couponScope: z.string(),
  agentRegistrationId: z.string().nullish(),
  printerId: z.string().nullish(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
})

export type AgentCoupon = z.infer<typeof agentCouponSchema>

export interface AgentCouponUpsertPayload {
  code: string
  name?: string | null
  discountType: string
  discountValue: number
  active: boolean
  startsAt?: string | null
  expiresAt?: string | null
  maxUses?: number | null
  maxUsesPerUser?: number | null
  couponScope: 'AGENT' | 'PRINTER'
  printerId?: string | null
}

function apiError(response: Response, body: string): Error {
  const safe = body.slice(0, 120).replace(/[\r\n]+/g, ' ').trim()
  return new Error(`HTTP ${response.status}: ${safe || response.statusText}`)
}

export class CloudApiClient {
  constructor(private readonly serverUrl: string) {}

  async register(payload: {
    machineId: string
    agentVersion: string
    osVersion: string
    publicKey: string
    displayName?: string | null
  }) {
    const response = await fetch(`${this.serverUrl}/api/agent/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      throw apiError(response, await response.text())
    }
    return registerResponseSchema.parse(await response.json())
  }

  async reportPrinters(agentSecret: string, printers: LocalPrinter[]) {
    const response = await fetch(`${this.serverUrl}/api/agent/printers`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agentSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ printers }),
    })
    if (!response.ok) {
      throw apiError(response, await response.text())
    }
    return response.json()
  }

  async poll(agentSecret: string, printerNames: string[], timeout = 30): Promise<PollJob | null> {
    const search = new URLSearchParams()
    search.set('timeout', String(timeout))
    for (const printerName of printerNames) {
      search.append('printerNames', printerName)
    }
    const response = await fetch(`${this.serverUrl}/api/agent/jobs/poll?${search.toString()}`, {
      headers: { authorization: `Bearer ${agentSecret}` },
    })
    if (response.status === 204) return null
    if (!response.ok) throw apiError(response, await response.text())
    return pollResponseSchema.parse(await response.json())
  }

  async download(agentSecret: string, downloadUrl: string, leaseToken: string) {
    const url = new URL(downloadUrl)
    url.searchParams.set('lease', leaseToken)
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${agentSecret}` },
    })
    if (!response.ok) throw apiError(response, await response.text())
    const ciphertext = Buffer.from(await response.arrayBuffer())
    return {
      ciphertext,
      ivBase64: response.headers.get('x-encryption-iv') ?? '',
      tagBase64: response.headers.get('x-encryption-tag') ?? '',
    }
  }

  async updateStatus(
    agentSecret: string,
    jobId: string,
    payload: {
      leaseToken?: string | null
      status: AgentJobQueueStatus
      printerStatusAfterJob?: AgentPrinterStatus | null
      printDurationMs?: number | null
      failureReason?: string | null
    },
  ) {
    const response = await fetch(`${this.serverUrl}/api/agent/jobs/${jobId}/status`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${agentSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      throw apiError(response, await response.text())
    }
    return response.json()
  }

  async heartbeat(
    agentSecret: string,
    payload: {
      agentVersion: string
      displayName?: string | null
      uptimeSeconds: number
      printerStatuses: Record<string, AgentPrinterStatus>
      activeJobCount: number
      completedJobsToday: number
      failedJobsToday: number
      memoryUsageMb: number
      diskFreeGb: number
      reportedBusinessAddress?: string | null
      reportedLatitude?: number | null
      reportedLongitude?: number | null
      reportedLocationAccuracyMeters?: number | null
      reportedLocationSource?: string | null
      reportedLocationCapturedAt?: string | null
    },
  ) {
    const response = await fetch(`${this.serverUrl}/api/agent/heartbeat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agentSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw apiError(response, await response.text())
    return response.json()
  }

  async repair(agentSecret: string) {
    const response = await fetch(`${this.serverUrl}/api/agent/repair`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentSecret}` },
    })
    if (!response.ok) throw apiError(response, await response.text())
    return z
      .object({
        pairingCode: z.string(),
        pairingCodeExpiresAt: z.string(),
      })
      .parse(await response.json())
  }

  async profile(agentSecret: string) {
    const response = await fetch(`${this.serverUrl}/api/agent/profile`, {
      headers: { authorization: `Bearer ${agentSecret}` },
    })
    if (!response.ok) throw apiError(response, await response.text())
    return agentProfileSchema.parse(await response.json())
  }

  async listPlatformPrinters(agentSecret: string) {
    const response = await fetch(`${this.serverUrl}/api/agent/platform-printers`, {
      headers: { authorization: `Bearer ${agentSecret}` },
    })
    if (!response.ok) throw apiError(response, await response.text())
    return z.array(platformPrinterSchema).parse(await response.json())
  }

  async createPlatformPrinter(agentSecret: string, payload: PlatformPrinterUpsertPayload) {
    const response = await fetch(`${this.serverUrl}/api/agent/platform-printers`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agentSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(this.serializePlatformPrinterPayload(payload)),
    })
    if (!response.ok) throw apiError(response, await response.text())
    return platformPrinterSchema.parse(await response.json())
  }

  async updatePlatformPrinter(agentSecret: string, printerId: string, payload: PlatformPrinterUpsertPayload) {
    const response = await fetch(`${this.serverUrl}/api/agent/platform-printers/${printerId}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${agentSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(this.serializePlatformPrinterPayload(payload)),
    })
    if (!response.ok) throw apiError(response, await response.text())
    return platformPrinterSchema.parse(await response.json())
  }

  async removePlatformPrinter(agentSecret: string, printerId: string) {
    const response = await fetch(`${this.serverUrl}/api/agent/platform-printers/${printerId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${agentSecret}` },
    })
    if (!response.ok) throw apiError(response, await response.text())
    return platformPrinterSchema.parse(await response.json())
  }

  async listOrders(agentSecret: string): Promise<AgentOrder[]> {
    const response = await fetch(`${this.serverUrl}/api/agent/orders`, {
      headers: { authorization: `Bearer ${agentSecret}` },
    })
    if (!response.ok) throw apiError(response, await response.text())
    return z.array(agentOrderSchema).parse(await response.json())
  }

  async listCoupons(agentSecret: string): Promise<AgentCoupon[]> {
    const response = await fetch(`${this.serverUrl}/api/agent/coupons`, {
      headers: { authorization: `Bearer ${agentSecret}` },
    })
    if (!response.ok) throw apiError(response, await response.text())
    return z.array(agentCouponSchema).parse(await response.json())
  }

  async createCoupon(agentSecret: string, payload: AgentCouponUpsertPayload): Promise<AgentCoupon> {
    const response = await fetch(`${this.serverUrl}/api/agent/coupons`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw apiError(response, await response.text())
    return agentCouponSchema.parse(await response.json())
  }

  async updateCoupon(agentSecret: string, couponId: string, payload: AgentCouponUpsertPayload): Promise<AgentCoupon> {
    const response = await fetch(`${this.serverUrl}/api/agent/coupons/${couponId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${agentSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw apiError(response, await response.text())
    return agentCouponSchema.parse(await response.json())
  }

  async setCouponActive(agentSecret: string, couponId: string, active: boolean): Promise<AgentCoupon> {
    const response = await fetch(`${this.serverUrl}/api/agent/coupons/${couponId}/active`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${agentSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ active }),
    })
    if (!response.ok) throw apiError(response, await response.text())
    return agentCouponSchema.parse(await response.json())
  }

  private serializePlatformPrinterPayload(payload: PlatformPrinterUpsertPayload) {
    return {
      name: payload.name,
      agentPrinterName: payload.agentPrinterName,
      enabled: payload.enabled,
      status: payload.status,
      reportedLatitude: payload.reportedLatitude ?? null,
      reportedLongitude: payload.reportedLongitude ?? null,
      reportedLocationAccuracyMeters: payload.reportedLocationAccuracyMeters ?? null,
      reportedLocationSource: payload.reportedLocationSource ?? null,
      reportedLocationCapturedAt: payload.reportedLocationCapturedAt ?? null,
      glossyPaperSurchargeMinor: payload.glossyPaperSurchargeMinor,
      baseJobPriceMinor: payload.baseJobPriceMinor,
      monochromePagePriceMinor: payload.monochromePagePriceMinor,
      colorPagePriceMinor: payload.colorPagePriceMinor,
      duplexSheetSurchargeMinor: payload.duplexSheetSurchargeMinor,
      a3PageSurchargeMinor: payload.a3PageSurchargeMinor,
      documentConstraints: serializeConfiguredConstraints(payload.documentConstraints),
      pricingAdjustments: serializeConfiguredConstraints(payload.pricingAdjustments),
      supportedColorModes: payload.supportedColorModes,
      supportedSidesModes: payload.supportedSidesModes,
      supportedPageSizes: payload.supportedPageSizes,
      supportedScalingModes: payload.supportedScalingModes,
      supportsSecureCoverSheets: payload.supportsSecureCoverSheets,
      secureCoverSheetPriceMinor: payload.secureCoverSheetPriceMinor,
      secureCoverSheetColorName: payload.secureCoverSheetColorName,
      secureCoverSheetLabel: payload.secureCoverSheetLabel,
    }
  }
}

function serializeConfiguredConstraints(items: ConfiguredConstraint[]) {
  return items.map((item, index) => ({
    type: item.type,
    displayOrder: item.displayOrder ?? index,
    configuration: item.configuration,
  }))
}
