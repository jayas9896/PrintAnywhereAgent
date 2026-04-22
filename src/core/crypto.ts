import crypto from 'node:crypto'

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
