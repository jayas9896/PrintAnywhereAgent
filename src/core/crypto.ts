import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'

export function generateRsaIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return { publicKeyPem: publicKey, privateKeyPem: privateKey }
}

export function encryptString(plainText: string, machineKey: Buffer) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', machineKey, iv)
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

export function decryptString(encryptedValue: string, machineKey: Buffer) {
  const payload = Buffer.from(encryptedValue, 'base64')
  const iv = payload.subarray(0, 12)
  const tag = payload.subarray(12, 28)
  const ciphertext = payload.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', machineKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/**
 * KAN-60 AG-M1 migration helper.
 *
 * Decrypts a value that may have been encrypted under either the new
 * salt-derived machine key or the legacy public-identifier-only key. Tries the
 * primary key first; on an AES-GCM auth failure falls back to the legacy key.
 * Returns the plaintext plus whether the legacy key was used, so the caller
 * can re-encrypt and persist under the new key.
 */
export function decryptStringMigrating(
  encryptedValue: string,
  primaryKey: Buffer,
  legacyKey: Buffer,
): { value: string; usedLegacyKey: boolean } {
  try {
    return { value: decryptString(encryptedValue, primaryKey), usedLegacyKey: false }
  } catch {
    return { value: decryptString(encryptedValue, legacyKey), usedLegacyKey: true }
  }
}

export function unwrapJobKey(encryptedJobKeyBase64: string, privateKeyPem: string) {
  return crypto.privateDecrypt(
    {
      key: privateKeyPem,
      oaepHash: 'sha256',
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    },
    Buffer.from(encryptedJobKeyBase64, 'base64'),
  )
}

export function decryptJobPdf(
  ciphertext: Buffer,
  aesKey: Buffer,
  ivBase64: string,
  tagBase64: string,
) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    aesKey,
    Buffer.from(ivBase64, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(tagBase64, 'base64'))
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** Signature scheme version sent in the X-Agent-Sig-Version header. */
export const AGENT_SIG_VERSION = '2'

/**
 * Signs a request for the X-Agent-Signature header (KAN-92, scheme v2).
 *
 * The signing input covers timestamp, HTTP method, path AND a SHA-256
 * digest of the exact request body bytes:
 *
 *   `{timestampMs}\n{METHOD}\n{path}\n{sha256hex(body)}`
 *
 * Covering the body closes the v1 gap where a man-in-the-middle could
 * swap the JSON payload while keeping a captured signature valid. The
 * timestamp still bounds replays to the backend's 5-minute skew window.
 *
 * The body MUST be the exact string passed to `fetch(..., { body })`;
 * for bodyless requests (GET/DELETE) pass an empty string so the hash is
 * `sha256("")` — the backend signs the same uniform shape.
 */
export function signRequest(
  timestampMs: number,
  method: string,
  path: string,
  signingSecretHex: string,
  body: string = '',
): string {
  const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex')
  const signingInput = `${timestampMs}\n${method.toUpperCase()}\n${path}\n${bodyHash}`
  const key = Buffer.from(signingSecretHex, 'hex')
  return crypto.createHmac('sha256', key).update(signingInput, 'utf8').digest('hex')
}

/** SHA-256 hash of a file's bytes — reported in heartbeat for binary integrity auditing. */
export function hashFile(filePath: string): string {
  const data = readFileSync(filePath)
  return crypto.createHash('sha256').update(data).digest('hex')
}
