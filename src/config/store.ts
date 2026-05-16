import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentState } from './types.js'
import {
  SECURE_DIR_MODE,
  SECURE_FILE_MODE,
  chmodIfExists,
  migrateLegacyDataDir,
  resolveDataDir,
} from '../core/machine.js'

const EMPTY_STATE: AgentState = {
  sharedPrinters: {},
  printers: [],
}

export class AgentStore {
  readonly dataDir = resolveDataDir()
  readonly statePath = path.join(this.dataDir, 'agent-state.json')

  constructor() {
    // KAN-60 AG-M2: migrate any pre-existing legacy `<cwd>/data` install into
    // the new per-user data directory so the agent keeps its identity.
    migrateLegacyDataDir(this.dataDir)
  }

  /** KAN-60 AG-M2: the data dir holds the agent secret + plaintext uiToken — keep it 0700. */
  private async ensureSecureDataDir() {
    await fs.mkdir(this.dataDir, { recursive: true })
    await chmodIfExists(this.dataDir, SECURE_DIR_MODE)
  }

  async load(): Promise<AgentState> {
    await this.ensureSecureDataDir()
    try {
      const raw = await fs.readFile(this.statePath, 'utf8')
      // Re-assert perms in case the file was created by an older agent version.
      await chmodIfExists(this.statePath, SECURE_FILE_MODE)
      return { ...EMPTY_STATE, ...JSON.parse(raw) }
    } catch {
      return { ...EMPTY_STATE }
    }
  }

  async save(state: AgentState) {
    await this.ensureSecureDataDir()
    // KAN-60 AG-M2: write the secret-bearing state file 0600. The `mode` option
    // only applies on creation, so chmod afterwards to also fix existing files.
    await fs.writeFile(this.statePath, JSON.stringify(state, null, 2), {
      encoding: 'utf8',
      mode: SECURE_FILE_MODE,
    })
    await chmodIfExists(this.statePath, SECURE_FILE_MODE)
  }

  async tempFilePath(jobId: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
      throw new Error(`Invalid jobId format: ${jobId}`)
    }
    const dir = path.join(this.dataDir, 'tmp')
    await fs.mkdir(dir, { recursive: true })
    await chmodIfExists(dir, SECURE_DIR_MODE)
    return path.join(dir, `${jobId}.pdf`)
  }

  async cleanupTempFiles() {
    const dir = path.join(this.dataDir, 'tmp')
    try {
      const entries = await fs.readdir(dir)
      await Promise.all(entries.map((entry) => fs.rm(path.join(dir, entry), { force: true })))
    } catch {
      return
    }
  }
}
