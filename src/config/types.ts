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

export type AgentApprovalStatus = 'PENDING_REVIEW' | 'APPROVED' | 'SUSPENDED' | 'REJECTED'
export type PlatformPrinterStatus = 'ONLINE' | 'BUSY' | 'OFFLINE' | 'MAINTENANCE'
export type PlatformColorMode = 'MONOCHROME' | 'COLOR'
export type PlatformSidesMode = 'SINGLE_SIDED' | 'DOUBLE_SIDED'
export type PlatformPageSize = 'A4' | 'A3'
export type PlatformScalingMode = 'ACTUAL_SIZE' | 'FIT_TO_PAGE' | 'SHRINK_TO_FIT'

export interface ConfiguredConstraint {
  id?: string | null
  type: string
  displayOrder?: number | null
  configuration: Record<string, string>
  summary?: string | null
}

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

export interface RecentJobSnapshot {
  jobId: string
  printerName: string
  status: AgentJobQueueStatus
  updatedAt: string
  pickupCode?: string | null
  displayName?: string | null
  pageCount?: number | null
  failureReason?: string | null
}

export interface PickupJobSnapshot {
  jobId: string
  printerName: string
  pickupCode: string
  displayName?: string | null
  pageCount?: number | null
  completedAt: string
}

export interface AgentStats {
  statsDate: string
  activeJobCount: number
  completedJobsToday: number
  failedJobsToday: number
}

export interface AgentProfile {
  agentId: string
  machineId: string
  registrationStatus: string
  approvalStatus: AgentApprovalStatus
  selfServiceEnabled: boolean
  displayName?: string | null
  businessName?: string | null
  businessAddress?: string | null
  businessLatitude?: number | null
  businessLongitude?: number | null
  approvedAt?: string | null
  approvedByUserId?: string | null
  agentVersion?: string | null
  osVersion?: string | null
  lastHeartbeatAt?: string | null
  activeJobCount: number
  completedJobsToday: number
  failedJobsToday: number
  reportedPrinters: LocalPrinter[]
}

export interface PlatformPrinter {
  printerId: string
  name: string
  agentPrinterName: string
  routingMode: string
  enabled: boolean
  status: PlatformPrinterStatus
  latitude?: number | null
  longitude?: number | null
  glossyPaperSurchargeMinor: number
  baseJobPriceMinor: number
  monochromePagePriceMinor: number
  colorPagePriceMinor: number
  duplexSheetSurchargeMinor: number
  a3PageSurchargeMinor: number
  supportedColorModes: PlatformColorMode[]
  supportedSidesModes: PlatformSidesMode[]
  supportedPageSizes: PlatformPageSize[]
  supportedScalingModes: PlatformScalingMode[]
  supportsSecureCoverSheets: boolean
  secureCoverSheetPriceMinor: number
  secureCoverSheetColorName: string
  secureCoverSheetLabel: string
  documentConstraints: ConfiguredConstraint[]
  pricingAdjustments: ConfiguredConstraint[]
  createdAt?: string | null
  updatedAt?: string | null
}

export interface AgentState {
  serverUrl?: string | null
  displayName?: string | null
  identity?: StoredIdentity | null
  registration?: AgentRegistrationState | null
  uiToken?: string | null
  sharedPrinters: Record<string, boolean>
  printers: LocalPrinter[]
  lastHeartbeatAt?: string | null
  lastError?: string | null
  lastJob?: LastJobSnapshot | null
  recentJobs?: RecentJobSnapshot[]
  readyForPickup?: PickupJobSnapshot[]
  stats?: AgentStats | null
  profile?: AgentProfile | null
  platformPrinters?: PlatformPrinter[]
}

export interface PollJob {
  jobId: string
  printerName: string
  downloadUrl: string
  leaseExpiresAt: string
  leaseToken: string
  encryptedJobKey: string
  settings: Record<string, unknown>
  pickup?: {
    code?: string | null
    displayName?: string | null
    pageCount?: number | null
  } | null
}
