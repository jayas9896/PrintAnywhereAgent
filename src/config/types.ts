export type AgentPrinterConnectionType = 'USB' | 'NETWORK' | 'WIFI' | 'BLUETOOTH' | 'VIRTUAL'
export type AgentPrinterStatus = 'READY' | 'OFFLINE' | 'ERROR' | 'PAPER_JAM' | 'OUT_OF_PAPER' | 'OUT_OF_TONER'
export type AgentJobQueueStatus =
  | 'QUEUED'
  | 'DOWNLOADING'
  | 'DECRYPTING'
  | 'PRINTING'
  | 'COMPLETED'
  | 'COLLECTED'
  | 'FAILED'

export interface LocalPrinter {
  localPrinterName: string
  driverName?: string | null
  connectionType: AgentPrinterConnectionType
  supportsColor: boolean
  supportsDuplex: boolean
  supportedPaperSizes: string[]
  isDefault: boolean
  status: AgentPrinterStatus
  shared: boolean
}

export interface StoredIdentity {
  machineId: string
  publicKeyPem: string
  encryptedPrivateKeyPem: string
}

export interface AgentRegistrationState {
  agentId: string
  encryptedAgentSecret: string
  pairingCode?: string | null
  pairingCodeExpiresAt?: string | null
  status?: string | null
}

export interface LastJobSnapshot {
  jobId: string
  printerName: string
  status: AgentJobQueueStatus
  updatedAt: string
  failureReason?: string | null
}

export interface AgentState {
  serverUrl?: string | null
  displayName?: string | null
  identity?: StoredIdentity | null
  registration?: AgentRegistrationState | null
  sharedPrinters: Record<string, boolean>
  printers: LocalPrinter[]
  lastHeartbeatAt?: string | null
  lastError?: string | null
  lastJob?: LastJobSnapshot | null
}

export interface PollJob {
  jobId: string
  printerName: string
  downloadUrl: string
  downloadUrlExpiresAt: string
  encryptedJobKey: string
  settings: Record<string, unknown>
  pickup?: {
    code?: string | null
    displayName?: string | null
    pageCount?: number | null
  } | null
}
