import { readFileSync } from 'node:fs'

type PackageMetadata = {
  version?: string
}

function readAgentVersion() {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as PackageMetadata

  if (!packageJson.version?.trim()) {
    throw new Error('PrintAnywhere Agent package.json is missing a version')
  }

  return packageJson.version.trim()
}

export const AGENT_VERSION = readAgentVersion()

export const PRODUCTION_PRINTANYWHERE_BACKEND_URL =
  'https://api.dhruvantasystems.net/printanywhere'

export function defaultPrintAnywhereBackendUrl() {
  return (
    process.env.PRINTANYWHERE_AGENT_DEFAULT_BACKEND_URL?.trim().replace(/\/+$/, '') ||
    PRODUCTION_PRINTANYWHERE_BACKEND_URL
  )
}
