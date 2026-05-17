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
import {
  decryptJobPdf,
  decryptStringMigrating,
  encryptString,
  generateRsaIdentity,
  hashFile,
  unwrapJobKey,
} from '../core/crypto.js'
import { deriveLegacyMachineKey, deriveMachineKey, getMachineId, isWindows } from '../core/machine.js'
import { CloudApiClient } from '../cloud/api.js'
import { detectHostLocation, normalizeLocationSnapshot } from '../platform/location.js'
import { discoverPrinters, printPdf } from '../platform/printers.js'
import { prependCoverPage } from '../core/coverPage.js'

export class AgentRuntime {
  private state: AgentState = { sharedPrinters: {}, printers: [] }
  private startedAt = Date.now()
  private machineKey!: Buffer
  /** KAN-60 AG-M1: legacy key, kept only to decrypt material written by older agents. */
  private legacyMachineKey!: Buffer
  private running = false
  private heartbeatTimer?: NodeJS.Timeout
  private pollPromise?: Promise<void>
  private pollBackoffMs = 5_000
  private lastHeartbeatMs = 0

  constructor(private readonly store: AgentStore) {}

  /**
   * KAN-165: the agent data directory. The local-UI HTTPS layer needs it to
   * locate the per-host TLS certificate and the launcher config file.
   */
  get dataDir(): string {
    return this.store.dataDir
  }

  async start() {
    this.machineKey = await deriveMachineKey(this.store.dataDir)
    this.legacyMachineKey = await deriveLegacyMachineKey()
    this.state = await this.store.load()
    await this.migrateEncryptedMaterial()
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
    return decryptStringMigrating(
      this.requireRegistration().encryptedAgentSecret,
      this.machineKey,
      this.legacyMachineKey,
    ).value
  }

  private requirePrivateKeyPem() {
    return decryptStringMigrating(
      this.requireIdentity().encryptedPrivateKeyPem,
      this.machineKey,
      this.legacyMachineKey,
    ).value
  }

  private requireClient() {
    if (!this.state.serverUrl) throw new Error('Server URL is not configured')
    return new CloudApiClient(this.state.serverUrl, () => this.resolveSigningSecret())
  }

  private resolveSigningSecret(): string | null {
    const reg = this.state.registration
    if (!reg?.encryptedSigningSecret) return null
    try {
      return decryptStringMigrating(reg.encryptedSigningSecret, this.machineKey, this.legacyMachineKey).value
    } catch {
      return null
    }
  }

  /**
   * KAN-60 AG-M1: on startup, re-encrypt any at-rest material that was written
   * under the legacy public-identifier-only key so it is stored under the new
   * salt-derived key. Prevents existing installs from silently re-pairing when
   * the key-derivation scheme changes.
   */
  private async migrateEncryptedMaterial() {
    let changed = false
    const reEncrypt = (encrypted: string): string => {
      const { value, usedLegacyKey } = decryptStringMigrating(
        encrypted,
        this.machineKey,
        this.legacyMachineKey,
      )
      if (!usedLegacyKey) return encrypted
      changed = true
      return encryptString(value, this.machineKey)
    }
    try {
      if (this.state.identity?.encryptedPrivateKeyPem) {
        this.state.identity = {
          ...this.state.identity,
          encryptedPrivateKeyPem: reEncrypt(this.state.identity.encryptedPrivateKeyPem),
        }
      }
      if (this.state.registration) {
        const reg = this.state.registration
        this.state.registration = {
          ...reg,
          encryptedAgentSecret: reEncrypt(reg.encryptedAgentSecret),
          encryptedSigningSecret: reg.encryptedSigningSecret
            ? reEncrypt(reg.encryptedSigningSecret)
            : reg.encryptedSigningSecret,
        }
      }
    } catch {
      // Material is unreadable under both keys — leave it; the agent will
      // re-register rather than crash.
      return
    }
    if (changed) await this.store.save(this.state)
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
      encryptedSigningSecret: response.signingSecret
        ? encryptString(response.signingSecret, this.machineKey)
        : null,
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
      const binaryHash = computeBinaryHash()
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
        binaryHash,
        ...platformLocationPayload(hostLocation),
      })
      this.state.lastHeartbeatAt = response.serverTime
      this.state.registration = {
        ...this.requireRegistration(),
        status: response.agentStatus,
      }
      this.state.lastError = null
      this.lastHeartbeatMs = Date.now()
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
      // Watchdog: if heartbeat interval has been silent for >3 min, kick it manually.
      if (this.lastHeartbeatMs > 0 && Date.now() - this.lastHeartbeatMs > 180_000) {
        void this.heartbeatTick()
      }
      try {
        const client = this.requireClient()
        const sharedPrinterNames = this.state.printers.filter((printer) => printer.shared).map((printer) => printer.localPrinterName)
        const job = await withTimeout(
          45_000,
          client.poll(this.requireAgentSecret(), sharedPrinterNames, 30),
          'Poll',
        )
        this.pollBackoffMs = 5_000
        if (!job) {
          continue
        }
        await this.processJob(client, job)
      } catch (error) {
        this.state.lastError = error instanceof Error ? error.message : 'Polling failed'
        await this.store.save(this.state)
        await sleep(this.pollBackoffMs)
        this.pollBackoffMs = Math.min(this.pollBackoffMs * 2, 60_000)
      }
    }
  }

  private async processJob(client: CloudApiClient, job: PollJob) {
    const secret = this.requireAgentSecret()
    this.resetStatsIfNeeded()
    // KAN-60 AG-M3: the shared-printer set is only a poll filter — the backend
    // can still name any printer in the job. Before touching the printer (or
    // even consuming the lease) assert the target is in the shop's shared/
    // allow-listed set, and fail the job clearly otherwise.
    const allowError = checkPrinterAllowed(job.printerName, this.state.printers)
    if (allowError) {
      this.bumpFailedJobs()
      await client
        .updateStatus(secret, job.jobId, {
          leaseToken: job.leaseToken,
          status: 'FAILED',
          printerStatusAfterJob: 'ERROR',
          failureReason: allowError,
        })
        .catch(() => undefined)
      this.state.lastJob = {
        jobId: job.jobId,
        printerName: job.printerName,
        status: 'FAILED',
        updatedAt: new Date().toISOString(),
        failureReason: allowError,
      }
      this.pushRecentJob({
        jobId: job.jobId,
        printerName: job.printerName,
        status: 'FAILED',
        updatedAt: new Date().toISOString(),
        pickupCode: job.pickup?.code ?? null,
        displayName: job.pickup?.displayName ?? null,
        pageCount: job.pickup?.pageCount ?? null,
        failureReason: allowError,
      })
      this.state.lastError = allowError
      await this.store.save(this.state)
      return
    }
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
      let pdfBuffer: Buffer = decryptJobPdf(download.ciphertext, aesKey, download.ivBase64, download.tagBase64)
      if (this.state.brandName) {
        pdfBuffer = await prependCoverPage(pdfBuffer, {
          businessName: this.state.brandName,
          logoUrl: this.state.brandLogoUrl,
        })
      }
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

  async listOrders() {
    const client = this.requireClient()
    const secret = this.requireAgentSecret()
    return client.listOrders(secret)
  }

  async listCoupons() {
    const client = this.requireClient()
    const secret = this.requireAgentSecret()
    return client.listCoupons(secret)
  }

  async createCoupon(payload: import('../cloud/api.js').AgentCouponUpsertPayload) {
    const client = this.requireClient()
    const secret = this.requireAgentSecret()
    return client.createCoupon(secret, payload)
  }

  async updateCoupon(couponId: string, payload: import('../cloud/api.js').AgentCouponUpsertPayload) {
    const client = this.requireClient()
    const secret = this.requireAgentSecret()
    return client.updateCoupon(secret, couponId, payload)
  }

  async setCouponActive(couponId: string, active: boolean) {
    const client = this.requireClient()
    const secret = this.requireAgentSecret()
    return client.setCouponActive(secret, couponId, active)
  }

  async updateBranding(brandName: string | null, brandLogoUrl: string | null, supportContactEmail: string | null) {
    this.state.brandName = brandName?.trim() || null
    this.state.brandLogoUrl = brandLogoUrl?.trim() || null
    this.state.supportContactEmail = supportContactEmail?.trim() || null
    await this.store.save(this.state)
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

/**
 * KAN-60 AG-M3: verifies a backend-supplied `job.printerName` targets a printer
 * that the shop owner has actually marked shared/allow-listed. The shared-printer
 * set is only used as a poll filter — it is NOT enforced when a job arrives, so
 * a malicious/buggy backend could name any local printer. Returns a failure
 * reason string when the printer is not allowed, or `null` when it is allowed.
 * Pure and exported so it can be unit-tested directly.
 */
export function checkPrinterAllowed(printerName: string, printers: LocalPrinter[]): string | null {
  const target = (printerName ?? '').trim()
  if (!target) {
    return 'Print job rejected: the backend did not specify a printer name.'
  }
  const allowed = printers.some(
    (printer) => printer.shared && printer.localPrinterName === target,
  )
  if (!allowed) {
    return `Print job rejected: "${target}" is not in this shop's shared/allow-listed printer set.`
  }
  return null
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(ms: number, promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
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

function computeBinaryHash(): string | null {
  try {
    // Hash the main entry point so the backend can audit binary integrity.
    return hashFile(process.argv[1])
  } catch {
    return null
  }
}
