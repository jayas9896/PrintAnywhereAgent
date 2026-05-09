export const AGENT_VERSION = '0.1.4'

export const PRODUCTION_PRINTANYWHERE_BACKEND_URL =
  'https://api.dhruvantasystems.net/printanywhere'

export function defaultPrintAnywhereBackendUrl() {
  return (
    process.env.PRINTANYWHERE_AGENT_DEFAULT_BACKEND_URL?.trim().replace(/\/+$/, '') ||
    PRODUCTION_PRINTANYWHERE_BACKEND_URL
  )
}
