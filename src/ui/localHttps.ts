/**
 * KAN-165: local HTTPS support for the PrintAnywhere Agent UI.
 *
 * The agent UI used to be served over plain HTTP at `http://localhost:<port>`.
 * To make the operator-facing console look genuine/professional, it is now
 * served over HTTPS at `https://local.printanywhere.dhruvantasystems.com:<port>`.
 *
 * Design (all decisions settled with the operator):
 *
 *  - **Per-host certificate.** Every install generates its OWN self-signed
 *    certificate + private key. There is NO shared private key — and the
 *    `PrintAnywhereAgent` repo is intentionally PUBLIC, so a key must never be
 *    committed. The key + cert live in the agent data directory (git-ignored)
 *    and are generated at install time (or lazily on first run).
 *
 *  - **SANs.** The certificate covers `local.printanywhere.dhruvantasystems.com`,
 *    `127.0.0.1`, and `localhost` so the loopback fallback URL also presents a
 *    valid certificate.
 *
 *  - **Name resolution.** The installer adds a hosts-file entry
 *    `127.0.0.1 local.printanywhere.dhruvantasystems.com`. The domain therefore
 *    resolves to loopback — one socket serves both the domain and the
 *    `127.0.0.1` / `localhost` fallback.
 *
 *  - **Trust.** The installer (elevated) imports the generated certificate into
 *    the Windows machine `Root` store so the browser shows no warning.
 *
 *  - **Long lifetime.** The cert is issued for 10 years. A per-host, local-only
 *    cert has no revocation needs, and a long lifetime means a non-elevated
 *    runtime never has to regenerate-and-fail-to-trust under normal use.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import path from 'node:path'
import selfsigned from 'selfsigned'

/** The domain the agent UI is served at. Resolves to 127.0.0.1 via the hosts file. */
export const LOCAL_UI_DOMAIN = 'local.printanywhere.dhruvantasystems.com'

/** Subject Alternative Names baked into the per-host certificate. */
export const LOCAL_UI_CERT_SANS = [LOCAL_UI_DOMAIN, 'localhost', '127.0.0.1'] as const

/** Certificate lifetime in days (10 years) — see module header. */
const CERT_VALIDITY_DAYS = 3650

/**
 * Regenerate when the cert has fewer than this many days of validity left, so
 * an install-time elevated regen happens well before expiry rather than a
 * non-elevated runtime regen that cannot re-trust itself.
 */
const CERT_RENEW_BEFORE_DAYS = 30

export interface LocalCertPaths {
  /** Directory holding the cert material (the agent data dir). */
  dir: string
  keyPath: string
  certPath: string
  /** Records the SHA-1 thumbprint so the uninstaller can untrust the cert. */
  thumbprintPath: string
}

export interface LocalCertMaterial {
  key: string
  cert: string
  /** Uppercase, colon-free SHA-1 fingerprint — the form `certutil -delstore` expects. */
  thumbprint: string
}

/** Resolve the on-disk paths for the per-host certificate inside a data dir. */
export function localCertPaths(dataDir: string): LocalCertPaths {
  const dir = path.join(dataDir, 'tls')
  return {
    dir,
    keyPath: path.join(dir, 'local-ui-key.pem'),
    certPath: path.join(dir, 'local-ui-cert.pem'),
    thumbprintPath: path.join(dir, 'local-ui-thumbprint.txt'),
  }
}

function sha1Thumbprint(certPem: string): string {
  // Node exposes the cert fingerprint as `AA:BB:...`; certutil wants `AABB...`.
  return new X509Certificate(certPem).fingerprint.replaceAll(':', '').toUpperCase()
}

function certNeedsRenewal(certPem: string): boolean {
  try {
    const cert = new X509Certificate(certPem)
    const expiresAt = new Date(cert.validTo).getTime()
    if (!Number.isFinite(expiresAt)) return true
    const renewThresholdMs = CERT_RENEW_BEFORE_DAYS * 24 * 60 * 60 * 1000
    return expiresAt - Date.now() < renewThresholdMs
  } catch {
    return true
  }
}

/** Generate a fresh self-signed certificate covering the local UI SANs. */
export async function generateLocalCert(): Promise<LocalCertMaterial> {
  const attrs = [{ name: 'commonName', value: LOCAL_UI_DOMAIN }]
  const notBeforeDate = new Date()
  const notAfterDate = new Date(notBeforeDate.getTime() + CERT_VALIDITY_DAYS * 24 * 60 * 60 * 1000)
  const pems = await selfsigned.generate(attrs, {
    notBeforeDate,
    notAfterDate,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
      },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          // type 2 = DNS name, type 7 = IP address
          { type: 2, value: LOCAL_UI_DOMAIN },
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  })
  return {
    key: pems.private,
    cert: pems.cert,
    thumbprint: sha1Thumbprint(pems.cert),
  }
}

/**
 * Load the per-host certificate from the data dir, generating (or regenerating
 * an expired one) if needed. The key + cert are written with 0600 permissions
 * and never leave the data dir. Returns the loaded material plus its paths so
 * the caller can hand the thumbprint to the installer for trust-store cleanup.
 */
export async function ensureLocalCert(
  dataDir: string,
): Promise<LocalCertMaterial & { paths: LocalCertPaths }> {
  const paths = localCertPaths(dataDir)

  if (existsSync(paths.keyPath) && existsSync(paths.certPath)) {
    try {
      const key = readFileSync(paths.keyPath, 'utf8')
      const cert = readFileSync(paths.certPath, 'utf8')
      if (!certNeedsRenewal(cert)) {
        return { key, cert, thumbprint: sha1Thumbprint(cert), paths }
      }
    } catch {
      // Fall through and regenerate on any read/parse failure.
    }
  }

  const material = await generateLocalCert()
  mkdirSync(paths.dir, { recursive: true })
  // 0600: the private key is as sensitive as the agent secret.
  writeFileSync(paths.keyPath, material.key, { encoding: 'utf8', mode: 0o600 })
  writeFileSync(paths.certPath, material.cert, { encoding: 'utf8', mode: 0o644 })
  writeFileSync(paths.thumbprintPath, `${material.thumbprint}\n`, { encoding: 'utf8', mode: 0o644 })
  // Re-assert 0600 in case the key file pre-existed with looser permissions
  // (the `mode` option on writeFileSync only applies when the file is created).
  try {
    chmodSync(paths.keyPath, 0o600)
  } catch {
    // POSIX modes are a no-op / unsupported on Windows — harmless.
  }
  return { ...material, paths }
}
