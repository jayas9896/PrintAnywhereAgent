import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentState } from './types.js'
import { resolveDataDir } from '../core/machine.js'

const EMPTY_STATE: AgentState = {
  sharedPrinters: {},
  printers: [],
}

export class AgentStore {
  readonly dataDir = resolveDataDir()
  readonly statePath = path.join(this.dataDir, 'agent-state.json')

  async load(): Promise<AgentState> {
    await fs.mkdir(this.dataDir, { recursive: true })
    try {
      const raw = await fs.readFile(this.statePath, 'utf8')
      return { ...EMPTY_STATE, ...JSON.parse(raw) }
    } catch {
      return { ...EMPTY_STATE }
    }
  }

  async save(state: AgentState) {
    await fs.mkdir(this.dataDir, { recursive: true })
    await fs.writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf8')
  }

  async tempFilePath(jobId: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
      throw new Error(`Invalid jobId format: ${jobId}`)
    }
    const dir = path.join(this.dataDir, 'tmp')
    await fs.mkdir(dir, { recursive: true })
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
