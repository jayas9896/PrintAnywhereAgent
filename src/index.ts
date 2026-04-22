import { AgentStore } from './config/store.js'
import { AgentRuntime } from './runtime/agentRuntime.js'
import { startUiServer } from './ui/server.js'

async function main() {
  const store = new AgentStore()
  const runtime = new AgentRuntime(store)
  await runtime.start()
  const uiServer = await startUiServer(runtime)

  const shutdown = async () => {
    await uiServer.close()
    await runtime.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
