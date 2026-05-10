import os from 'node:os'
import crypto from 'node:crypto'
import type {
  AgentState,
  AgentLocationSnapshot,
  ConfiguredConstraint,
  LocalPrinter,
  PlatformColorMode,
  PlatformPageSize,
  PlatformPrinterStatus,
  PlatformScalingMode,
  PlatformSidesMode,
  PollJob,
} from '../config/types.js'
import { AgentStore } from '../config/store.js'
import { AGENT_VERSION, defaultPrintAnywhereBackendUrl } from '../config/defaults.js'
import { decryptJobPdf, decryptString, encryptString, generateRsaIdentity, unwrapJobKey } from '../core/crypto.js'
import { deriveMachineKey, getMachineId, isWindows } from '../core/machine.js'
import { CloudApiClient } from '../cloud/api.js'
import { detectHostLocation, normalizeLocationSnapshot } from '../platform/location.js'
import { discoverPrinters, printPdf } from '../platform/printers.js'

export class AgentRuntime {
  private state: AgentState = { sharedPrinters: {}, printers: [] }
  private startedAt = Date.now()
  private machineKey!: Buffer
  private running = false
  private heartbeatTimer?: NodeJS.Timeout
  private pollPromise?: Promise<void>

  constructor(private readonly store: AgentStore) {}

  async start() {
    this.machineKey = await deriveMachineKey()
    this.state = await this.store.load()
    await this.ensureIdentity()
    await this.ensureUiToken()
    await this.cleanupTempFiles()
    await this.refreshHostLocation()
    this.resetStatsIfNeeded()
    this.running = true
    await this.syncPrinters()
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatTick()
    }, 60_000)
    this.pollPromise = this.pollLoop()
  }

  async stop() {
    this.running = false
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    await this.pollPromise
  }

  snapshot() {
    return this.state
  }

  verifyUiToken(token: string | null | undefined) {
    return !!this.state.uiToken && !!token && this.state.uiToken === token
  }

  async configure(serverUrl: string, displayName?: string | null, reportedBusinessAddress?: string | null) {
    const nextServerUrl = normalizeServerUrl(serverUrl || defaultPrintAnywhereBackendUrl())
    const previousServerUrl = this.state.serverUrl ? normalizeServerUrl(this.state.serverUrl) : null
    const hasExistingRegistration = !!this.state.registration?.agentId && !!this.state.registration?.encryptedAgentSecret
    this.state.serverUrl = nextServerUrl
    this.state.displayName = displayName?.trim() || null
    this.state.reportedBusinessAddress = reportedBusinessAddress?.trim() || null
    this.state.lastError = null
    await this.store.save(this.state)
    if (!hasExistingRegistration || previousServerUrl !== nextServerUrl) {
      await this.registerIfNeeded(true)
    }
    await this.syncPrinters()
    await this.refreshHostLocation()
    await this.heartbeatTick()
  }

  async setPrinterShared(localPrinterName: string, shared: boolean) {
    this.state.sharedPrinters[localPrinterName] = shared
    this.state.printers = this.state.printers.map((printer) =>
      printer.localPrinterName === localPrinterName ? { ...printer, shared } : printer,
    )
    await this.store.save(this.state)
    await this.reportPrinters()
    await this.refreshCloudState()
  }

  async refreshHostLocation() {
    try {
      const location = await detectHostLocation()
      if (!location) {
        const cachedLocation = this.state.hostLocation ?? null
        if (cachedLocation) {
          await this.heartbeatTick()
        }
        return cachedLocation
      }
      this.state.hostLocation = location
      this.state.lastError = null
      await this.store.save(this.state)
      await this.heartbeatTick()
      return location
    } catch (error) {
      this.state.lastError = error instanceof Error ? error.message : 'Host location detection failed'
      await this.store.save(this.state)
      return this.state.hostLocation ?? null
    }
  }

  async setBrowserLocation(input: {
    latitude: number
    longitude: number
    accuracyMeters?: number | null
    capturedAt?: string | null
  }) {
    this.state.hostLocation = normalizeLocationSnapshot({
      ...input,
      source: 'browser',
    })
    this.state.lastError = null
    await this.store.save(this.state)
    await this.heartbeatTick()
    return this.state.hostLocation
  }

  async upsertPlatformPrinter(input: PlatformPrinterUpsertInput) {
    const client = this.requireClient()
    const secret = this.requireAgentSecret()
    const hostLocation = await this.refreshHostLocation()
    const payload = {
      name: input.name.trim(),
      agentPrinterName: input.agentPrinterName.trim(),
      enabled: input.enabled,
      status: input.status,
      ...platformLocationPayload(hostLocation),
      glossyPaperSurchargeMinor: input.glossyPaperSurchargeMinor,
      baseJobPriceMinor: input.baseJobPriceMinor,
      monochromePagePriceMinor: input.monochromePagePriceMinor,
      colorPagePriceMinor: input.colorPagePriceMinor,
      duplexSheetSurchargeMinor: input.duplexSheetSurchargeMinor,
      a3PageSurchargeMinor: input.a3PageSurchargeMinor,
      documentConstraints: input.documentConstraints,
      pricingAdjustments: input.pricingAdjustments,
      supportedColorModes: input.supportedColorModes,
      supportedSidesModes: input.supportedSidesModes,
      supportedPageSizes: input.supportedPageSizes,
      supportedScalingModes: input.supportedScalingModes,
      supportsSecureCoverSheets: input.supportsSecureCoverSheets,
      secureCoverSheetPriceMinor: input.secureCoverSheetPriceMinor,
      secureCoverSheetColorName: input.secureCoverSheetColorName.trim(),
      secureCoverSheetLabel: input.secureCoverSheetLabel.trim(),
    }
    const saved = input.printerId
      ? await client.updatePlatformPrinter(secret, input.printerId, payload)
      : await client.createPlatformPrinter(secret, payload)
    this.state.platformPrinters = [
      saved,
      ...(this.state.platformPrinters ?? []).filter((printer) => printer.printerId !== saved.printerId),
    ].sort((left, right) => left.name.localeCompare(right.name))
    this.state.lastError = null
    await this.store.save(this.state)
    await this.refreshCloudState()
  }

  async removePlatformPrinter(printerId: string) {
    const client = this.requireClient()
    const secret = this.requireAgentSecret()
    const updated = await client.removePlatformPrinter(secret, printerId)
    this.state.platformPrinters = [
      updated,
      ...(this.state.platformPrinters ?? []).filter((printer) => printer.printerId !== updated.printerId),
    ].sort((left, right) => left.name.localeCompare(right.name))
    this.state.lastError = null
    await this.store.save(this.state)
    await this.refreshCloudState()
  }

  async repairPairingCode() {
    const client = this.requireClient()
    const secret = this.requireAgentSecret()
    const result = await client.repair(secret)
    this.state.registration = {
      ...this.requireRegistration(),
      pairingCode: result.pairingCode,
      pairingCodeExpiresAt: result.pairingCodeExpiresAt,
    }
    await this.store.save(this.state)
    await this.refreshCloudState()
  }

  async syncPrinters() {
    try {
      const printers = await discoverPrinters(this.state.sharedPrinters)
      this.state.printers = printers
      this.state.lastError = null
      await this.store.save(this.state)
      await this.registerIfNeeded(false)
      await this.reportPrinters()
      await this.refreshCloudState()
    } catch (error) {
      this.state.lastError = error instanceof Error ? error.message : 'Printer discovery failed'
      await this.store.save(this.state)
    }
  }

  private async ensureIdentity() {
    if (this.state.identity) return
    const machineId = await getMachineId()
    const rsaIdentity = generateRsaIdentity()
    this.state.identity = {
      machineId,
      publicKeyPem: rsaIdentity.publicKeyPem,
      encryptedPrivateKeyPem: encryptString(rsaIdentity.privateKeyPem, this.machineKey),
    }
    await this.store.save(this.state)
  }

  private async ensureUiToken() {
    if (this.state.uiToken) return
    this.state.uiToken = crypto.randomBytes(24).toString('hex')
    await this.store.save(this.state)
  }

  private async cleanupTempFiles() {
    await this.store.cleanupTempFiles()
  }

  private requireIdentity() {
    if (!this.state.identity) throw new Error('Agent identity is not initialized')
    return this.state.identity
  }

  private requireRegistration() {
    if (!this.state.registration) throw new Error('Agent registration is missing')
    return this.state.registration
  }

  private requireAgentSecret() {
    return decryptString(this.requireRegistration().encryptedAgentSecret, this.machineKey)
  }

  private requirePrivateKeyPem() {
    return decryptString(this.requireIdentity().encryptedPrivateKeyPem, this.machineKey)
  }

  private requireClient() {
    if (!this.state.serverUrl) throw new Error('Server URL is not configured')
    return new CloudApiClient(this.state.serverUrl)
  }

  private async registerIfNeeded(force = false) {
    if (!this.state.serverUrl) return
    if (this.state.registration && !force) return
    const client = this.requireClient()
    const identity = this.requireIdentity()
    const response = await client.register({
      machineId: identity.machineId,
      agentVersion: AGENT_VERSION,
      osVersion: `${os.platform()} ${os.release()}`,
      publicKey: identity.publicKeyPem,
      displayName: this.state.displayName,
    })
    this.state.registration = {
      agentId: response.agentId,
      encryptedAgentSecret: encryptString(response.agentSecret, this.machineKey),
      pairingCode: response.pairingCode,
      pairingCodeExpiresAt: response.pairingCodeExpiresAt,
      status: response.status,
    }
    this.state.lastError = null
    await this.store.save(this.state)
    await this.refreshCloudState()
  }

  private async reportPrinters() {
    if (!this.state.serverUrl || !this.state.registration) return
    const client = this.requireClient()
    await client.reportPrinters(this.requireAgentSecret(), this.state.printers)
  }

  private async refreshCloudState() {
    if (!this.state.serverUrl || !this.state.registration) return
    const client = this.requireClient()
    const secret = this.requireAgentSecret()
    const [profile, platformPrinters] = await Promise.all([
      client.profile(secret),
      client.listPlatformPrinters(secret),
    ])
    this.state.registration = {
      ...this.requireRegistration(),
      status: profile.registrationStatus,
    }
    this.state.profile = {
      ...profile,
      reportedPrinters: profile.reportedPrinters.map((printer) => ({
        localPrinterName: printer.localPrinterName,
        driverName: printer.driverName ?? null,
        connectionType: printer.connectionType as LocalPrinter['connectionType'],
        supportsColor: printer.supportsColor,
        supportsDuplex: printer.supportsDuplex,
        supportedPaperSizes: printer.supportedPaperSizes,
        isDefault: printer.defaultPrinter,
        status: printer.status as LocalPrinter['status'],
        shared: printer.shared,
      })),
    }
    this.state.platformPrinters = platformPrinters
    await this.store.save(this.state)
  }

  private async heartbeatTick() {
    if (!this.state.serverUrl || !this.state.registration) return
    try {
      this.resetStatsIfNeeded()
      const client = this.requireClient()
      const printerStatuses = Object.fromEntries(this.state.printers.map((printer) => [printer.localPrinterName, printer.status]))
      const stats = this.state.stats ?? defaultStats()
      const hostLocation = this.state.hostLocation ?? null
      const response = await client.heartbeat(this.requireAgentSecret(), {
        agentVersion: AGENT_VERSION,
        displayName: this.state.displayName ?? null,
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        printerStatuses,
        activeJobCount: stats.activeJobCount,
        completedJobsToday: stats.completedJobsToday,
        failedJobsToday: stats.failedJobsToday,
        memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        diskFreeGb: 0,
        reportedBusinessAddress: this.state.reportedBusinessAddress ?? null,
        ...platformLocationPayload(hostLocation),
      })
      this.state.lastHeartbeatAt = response.serverTime
      this.state.registration = {
        ...this.requireRegistration(),
        status: response.agentStatus,
      }
      this.state.lastError = null
      await this.store.save(this.state)
      await this.refreshCloudState()
    } catch (error) {
      this.state.lastError = error instanceof Error ? error.message : 'Heartbeat failed'
      await this.store.save(this.state)
    }
  }

  private async pollLoop() {
    while (this.running) {
      if (!this.state.serverUrl || !this.state.registration) {
        await sleep(2000)
        continue
      }
      if (this.state.registration.status === 'REVOKED') {
        await sleep(5000)
        continue
      }
      try {
        const client = this.requireClient()
        const sharedPrinterNames = this.state.printers.filter((printer) => printer.shared).map((printer) => printer.localPrinterName)
        const job = await client.poll(this.requireAgentSecret(), sharedPrinterNames, 30)
        if (!job) {
          continue
        }
        await this.processJob(client, job)
      } catch (error) {
        this.state.lastError = error instanceof Error ? error.message : 'Polling failed'
        await this.store.save(this.state)
        await sleep(5000)
      }
    }
  }

  private async processJob(client: CloudApiClient, job: PollJob) {
    const secret = this.requireAgentSecret()
    this.resetStatsIfNeeded()
    this.bumpActiveJobs(1)
    try {
      await client.updateStatus(secret, job.jobId, {
        leaseToken: job.leaseToken,
        status: 'DOWNLOADING',
        printerStatusAfterJob: 'READY',
      })
      const download = await client.download(secret, job.downloadUrl, job.leaseToken)
      await client.updateStatus(secret, job.jobId, {
        leaseToken: job.leaseToken,
        status: 'DECRYPTING',
        printerStatusAfterJob: 'READY',
      })
      const aesKey = unwrapJobKey(job.encryptedJobKey, this.requirePrivateKeyPem())
      const pdfBuffer = decryptJobPdf(download.ciphertext, aesKey, download.ivBase64, download.tagBase64)
      const simulatePrint =
        process.env.PRINTANYWHERE_AGENT_SIMULATE_PRINT === 'true' ||
        (!isWindows() && process.env.PRINTANYWHERE_AGENT_SIMULATE_PRINT !== 'false')
      const printStart = Date.now()
      await client.updateStatus(secret, job.jobId, {
        leaseToken: job.leaseToken,
        status: 'PRINTING',
        printerStatusAfterJob: 'READY',
      })
      const tempPath = await this.store.tempFilePath(job.jobId)
      await printPdf(tempPath, job.printerName, pdfBuffer, simulatePrint)
      await client.updateStatus(secret, job.jobId, {
        leaseToken: job.leaseToken,
        status: 'COMPLETED',
        printerStatusAfterJob: 'READY',
        printDurationMs: Date.now() - printStart,
      })
      this.bumpActiveJobs(-1)
      this.bumpCompletedJobs()
      this.state.lastJob = {
        jobId: job.jobId,
        printerName: job.printerName,
        status: 'COMPLETED',
        updatedAt: new Date().toISOString(),
      }
      this.pushRecentJob({
        jobId: job.jobId,
        printerName: job.printerName,
        status: 'COMPLETED',
        updatedAt: new Date().toISOString(),
        pickupCode: job.pickup?.code ?? null,
        displayName: job.pickup?.displayName ?? null,
        pageCount: job.pickup?.pageCount ?? null,
      })
      if (job.pickup?.code) {
        this.state.readyForPickup = [
          {
            jobId: job.jobId,
            printerName: job.printerName,
            pickupCode: job.pickup.code,
            displayName: job.pickup.displayName ?? null,
            pageCount: job.pickup.pageCount ?? null,
            completedAt: new Date().toISOString(),
          },
          ...(this.state.readyForPickup ?? []).filter((entry) => entry.jobId !== job.jobId),
        ].slice(0, 30)
      }
      this.state.lastError = null
      await this.store.save(this.state)
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : 'Print job failed'
      await client.updateStatus(secret, job.jobId, {
        leaseToken: job.leaseToken,
        status: 'FAILED',
        printerStatusAfterJob: 'ERROR',
        failureReason,
      }).catch(() => undefined)
      this.bumpActiveJobs(-1)
      this.bumpFailedJobs()
      this.state.lastJob = {
        jobId: job.jobId,
        printerName: job.printerName,
        status: 'FAILED',
        updatedAt: new Date().toISOString(),
        failureReason,
      }
      this.pushRecentJob({
        jobId: job.jobId,
        printerName: job.printerName,
        status: 'FAILED',
        updatedAt: new Date().toISOString(),
        pickupCode: job.pickup?.code ?? null,
        displayName: job.pickup?.displayName ?? null,
        pageCount: job.pickup?.pageCount ?? null,
        failureReason,
      })
      this.state.lastError = failureReason
      await this.store.save(this.state)
    }
  }

  async markCollected(jobId: string) {
    const secret = this.requireAgentSecret()
    const client = this.requireClient()
    await client.updateStatus(secret, jobId, {
      status: 'COLLECTED',
      printerStatusAfterJob: 'READY',
    })
    const now = new Date().toISOString()
    this.state.readyForPickup = (this.state.readyForPickup ?? []).filter((entry) => entry.jobId !== jobId)
    this.pushRecentJob({
      jobId,
      printerName:
        this.state.recentJobs?.find((entry) => entry.jobId === jobId)?.printerName ?? 'Unknown printer',
      status: 'COLLECTED',
      updatedAt: now,
    })
    this.state.lastJob = {
      jobId,
      printerName: this.state.lastJob?.jobId === jobId ? this.state.lastJob.printerName : 'Unknown printer',
      status: 'COLLECTED',
      updatedAt: now,
    }
    await this.store.save(this.state)
  }

  private resetStatsIfNeeded() {
    const today = new Date().toISOString().slice(0, 10)
    if (!this.state.stats || this.state.stats.statsDate !== today) {
      this.state.stats = {
        statsDate: today,
        activeJobCount: 0,
        completedJobsToday: 0,
        failedJobsToday: 0,
      }
    }
  }

  private bumpActiveJobs(delta: number) {
    this.resetStatsIfNeeded()
    const stats = this.state.stats ?? defaultStats()
    stats.activeJobCount = Math.max(0, stats.activeJobCount + delta)
    this.state.stats = stats
  }

  private bumpCompletedJobs() {
    this.resetStatsIfNeeded()
    const stats = this.state.stats ?? defaultStats()
    stats.completedJobsToday += 1
    this.state.stats = stats
  }

  private bumpFailedJobs() {
    this.resetStatsIfNeeded()
    const stats = this.state.stats ?? defaultStats()
    stats.failedJobsToday += 1
    this.state.stats = stats
  }

  private pushRecentJob(entry: NonNullable<AgentState['recentJobs']>[number]) {
    this.state.recentJobs = [entry, ...(this.state.recentJobs ?? []).filter((job) => job.jobId !== entry.jobId)].slice(0, 50)
  }
}

export interface PlatformPrinterUpsertInput {
  printerId?: string | null
  name: string
  agentPrinterName: string
  enabled: boolean
  status: PlatformPrinterStatus
  glossyPaperSurchargeMinor: number
  baseJobPriceMinor: number
  monochromePagePriceMinor: number
  colorPagePriceMinor: number
  duplexSheetSurchargeMinor: number
  a3PageSurchargeMinor: number
  documentConstraints: ConfiguredConstraint[]
  pricingAdjustments: ConfiguredConstraint[]
  supportedColorModes: PlatformColorMode[]
  supportedSidesModes: PlatformSidesMode[]
  supportedPageSizes: PlatformPageSize[]
  supportedScalingModes: PlatformScalingMode[]
  supportsSecureCoverSheets: boolean
  secureCoverSheetPriceMinor: number
  secureCoverSheetColorName: string
  secureCoverSheetLabel: string
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeServerUrl(raw: string) {
  const value = raw.trim().replace(/\/+$/, '')
  const url = new URL(value)
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  const allowInsecure = process.env.PRINTANYWHERE_AGENT_ALLOW_INSECURE_BACKEND === 'true'
  if (url.protocol !== 'https:' && !isLoopback && !allowInsecure) {
    throw new Error('PrintAnywhere backend URL must use HTTPS unless it is localhost or insecure mode is explicitly enabled')
  }
  return value
}

function defaultStats() {
  return {
    statsDate: new Date().toISOString().slice(0, 10),
    activeJobCount: 0,
    completedJobsToday: 0,
    failedJobsToday: 0,
  }
}

function platformLocationPayload(location: AgentLocationSnapshot | null) {
  if (!location) {
    return {}
  }

  return {
    reportedLatitude: location.latitude,
    reportedLongitude: location.longitude,
    reportedLocationAccuracyMeters: location.accuracyMeters ?? null,
    reportedLocationSource: location.source,
    reportedLocationCapturedAt: location.capturedAt,
  }
}
