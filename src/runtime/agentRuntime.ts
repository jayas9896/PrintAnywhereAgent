import os from 'node:os'
import path from 'node:path'
import type { AgentState, LocalPrinter, PollJob } from '../config/types.js'
import { AgentStore } from '../config/store.js'
import { decryptJobPdf, decryptString, encryptString, generateRsaIdentity, unwrapJobKey } from '../core/crypto.js'
import { deriveMachineKey, getMachineId, isWindows } from '../core/machine.js'
import { CloudApiClient } from '../cloud/api.js'
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

  async configure(serverUrl: string, displayName?: string | null) {
    this.state.serverUrl = serverUrl.replace(/\/+$/, '')
    this.state.displayName = displayName?.trim() || null
    this.state.lastError = null
    await this.store.save(this.state)
    await this.registerIfNeeded(true)
    await this.syncPrinters()
  }

  async setPrinterShared(localPrinterName: string, shared: boolean) {
    this.state.sharedPrinters[localPrinterName] = shared
    this.state.printers = this.state.printers.map((printer) =>
      printer.localPrinterName === localPrinterName ? { ...printer, shared } : printer,
    )
    await this.store.save(this.state)
    await this.reportPrinters()
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
  }

  async syncPrinters() {
    try {
      const printers = await discoverPrinters(this.state.sharedPrinters)
      this.state.printers = printers
      await this.store.save(this.state)
      await this.registerIfNeeded(false)
      await this.reportPrinters()
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
      agentVersion: '0.1.0',
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
  }

  private async reportPrinters() {
    if (!this.state.serverUrl || !this.state.registration) return
    const client = this.requireClient()
    await client.reportPrinters(this.requireAgentSecret(), this.state.printers)
  }

  private async heartbeatTick() {
    if (!this.state.serverUrl || !this.state.registration) return
    try {
      const client = this.requireClient()
      const printerStatuses = Object.fromEntries(this.state.printers.map((printer) => [printer.localPrinterName, printer.status]))
      const response = await client.heartbeat(this.requireAgentSecret(), {
        agentVersion: '0.1.0',
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        printerStatuses,
        activeJobCount: 0,
        completedJobsToday: 0,
        failedJobsToday: 0,
        memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        diskFreeGb: 0,
      })
      this.state.lastHeartbeatAt = response.serverTime
      this.state.registration = {
        ...this.requireRegistration(),
        status: response.agentStatus,
      }
      await this.store.save(this.state)
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
    try {
      await client.updateStatus(secret, job.jobId, {
        status: 'DOWNLOADING',
        printerStatusAfterJob: 'READY',
      })
      const download = await client.download(job.downloadUrl)
      await client.updateStatus(secret, job.jobId, {
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
        status: 'PRINTING',
        printerStatusAfterJob: 'READY',
      })
      await printPdf(job.jobId, job.printerName, pdfBuffer, simulatePrint)
      await client.updateStatus(secret, job.jobId, {
        status: 'COMPLETED',
        printerStatusAfterJob: 'READY',
        printDurationMs: Date.now() - printStart,
      })
      this.state.lastJob = {
        jobId: job.jobId,
        printerName: job.printerName,
        status: 'COMPLETED',
        updatedAt: new Date().toISOString(),
      }
      this.state.lastError = null
      await this.store.save(this.state)
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : 'Print job failed'
      await client.updateStatus(secret, job.jobId, {
        status: 'FAILED',
        printerStatusAfterJob: 'ERROR',
        failureReason,
      }).catch(() => undefined)
      this.state.lastJob = {
        jobId: job.jobId,
        printerName: job.printerName,
        status: 'FAILED',
        updatedAt: new Date().toISOString(),
        failureReason,
      }
      this.state.lastError = failureReason
      await this.store.save(this.state)
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
