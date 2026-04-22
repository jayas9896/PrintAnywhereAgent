import { z } from 'zod'
import type { AgentJobQueueStatus, AgentPrinterStatus, LocalPrinter, PollJob } from '../config/types.js'

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
  downloadUrlExpiresAt: z.string(),
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
      throw new Error(await response.text())
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
      throw new Error(await response.text())
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
    if (!response.ok) throw new Error(await response.text())
    return pollResponseSchema.parse(await response.json())
  }

  async download(downloadUrl: string) {
    const response = await fetch(downloadUrl)
    if (!response.ok) throw new Error(await response.text())
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
      throw new Error(await response.text())
    }
    return response.json()
  }

  async heartbeat(
    agentSecret: string,
    payload: {
      agentVersion: string
      uptimeSeconds: number
      printerStatuses: Record<string, AgentPrinterStatus>
      activeJobCount: number
      completedJobsToday: number
      failedJobsToday: number
      memoryUsageMb: number
      diskFreeGb: number
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
    if (!response.ok) throw new Error(await response.text())
    return response.json()
  }

  async repair(agentSecret: string) {
    const response = await fetch(`${this.serverUrl}/api/agent/repair`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentSecret}` },
    })
    if (!response.ok) throw new Error(await response.text())
    return z
      .object({
        pairingCode: z.string(),
        pairingCodeExpiresAt: z.string(),
      })
      .parse(await response.json())
  }
}
