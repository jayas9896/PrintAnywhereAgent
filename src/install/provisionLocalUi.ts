/**
 * KAN-165: install-time provisioning entry point for the local HTTPS UI.
 *
 * Run by `scripts/lib/local-https-setup.ps1` during install:
 *
 *   node dist/install/provisionLocalUi.js <dataDir>
 *
 * It is a dedicated, *built* entry point (rather than an inline Node `-e`
 * snippet from PowerShell) so the installer can invoke it by a plain file path
 * — no temp file, no absolute-path ESM import specifier, no path-escaping
 * traps on Windows install directories that contain spaces.
 *
 * It performs two idempotent steps inside the agent data directory:
 *   1. `ensureLocalCert`      — generate (or reuse) the per-host TLS cert+key.
 *   2. `ensureLauncherConfig` — write the documented launcher config file.
 *
 * On success it prints a single JSON line to stdout describing the cert paths
 * and SHA-1 thumbprint, which the PowerShell caller parses to trust the cert
 * in the Windows machine Root store.
 */

import { ensureLocalCert } from '../ui/localHttps.js'
import { ensureLauncherConfig } from '../ui/launcherConfig.js'

async function main() {
  const dataDir = process.argv[2]
  if (!dataDir) {
    console.error('provisionLocalUi: missing required <dataDir> argument')
    process.exit(2)
  }

  const cert = await ensureLocalCert(dataDir)
  ensureLauncherConfig(dataDir)

  // A single JSON line on stdout — consumed by ConvertFrom-Json in PowerShell.
  process.stdout.write(
    `${JSON.stringify({
      certPath: cert.paths.certPath,
      keyPath: cert.paths.keyPath,
      thumbprintPath: cert.paths.thumbprintPath,
      thumbprint: cert.thumbprint,
    })}\n`,
  )
}

main().catch((error) => {
  console.error('provisionLocalUi failed:', error)
  process.exit(1)
})
