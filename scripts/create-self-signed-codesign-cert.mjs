#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

const defaultSecretDir =
  process.env.PRINTANYWHERE_SELF_SIGNED_CODESIGN_DIR?.trim() ||
  '/home/jayas/.secrets/dhruvanta-code-signing/self-signed'
const subject =
  process.env.PRINTANYWHERE_SELF_SIGNED_CODESIGN_SUBJECT?.trim() ||
  '/C=IN/O=Dhruvanta Systems/OU=PrintAnywhere/CN=Dhruvanta Systems Self-Signed Code Signing'
const days = process.env.PRINTANYWHERE_SELF_SIGNED_CODESIGN_DAYS?.trim() || '365'
const rotate = process.argv.includes('--rotate')

const keyPath = path.join(defaultSecretDir, 'dhruvanta-systems-selfsigned-codesign.key.pem')
const certPath = path.join(defaultSecretDir, 'dhruvanta-systems-selfsigned-codesign.cert.pem')
const pfxPath = path.join(defaultSecretDir, 'dhruvanta-systems-selfsigned-codesign.pfx')
const passwordPath = path.join(defaultSecretDir, 'dhruvanta-systems-selfsigned-codesign-password.txt')
const envPath = path.join(defaultSecretDir, 'printanywhere-selfsigned-codesign.env')

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function run(command, args, redactedArgs = args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`${command} ${redactedArgs.join(' ')} exited with code ${code ?? 'unknown'}`))
    })
  })
}

async function runCapture(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }

      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}${stderr ? `\n${stderr}` : ''}`))
    })
  })
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

async function ensureSecretDir() {
  await fs.mkdir(defaultSecretDir, { recursive: true, mode: 0o700 })
  await fs.chmod(defaultSecretDir, 0o700)
}

async function writePassword() {
  const password = crypto.randomBytes(32).toString('base64url')
  await fs.writeFile(passwordPath, `${password}\n`, { mode: 0o600 })
  await fs.chmod(passwordPath, 0o600)
  return password
}

async function createCertificate() {
  const password = await writePassword()
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:4096',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    days,
    '-sha256',
    '-nodes',
    '-subj',
    subject,
    '-addext',
    'basicConstraints=critical,CA:FALSE',
    '-addext',
    'keyUsage=critical,digitalSignature',
    '-addext',
    'extendedKeyUsage=codeSigning',
  ])
  await fs.chmod(keyPath, 0o600)
  await fs.chmod(certPath, 0o644)

  await run(
    'openssl',
    [
      'pkcs12',
      '-export',
      '-inkey',
      keyPath,
      '-in',
      certPath,
      '-out',
      pfxPath,
      '-name',
      'Dhruvanta Systems Self-Signed Code Signing',
      '-passout',
      `pass:${password}`,
    ],
    [
      'pkcs12',
      '-export',
      '-inkey',
      keyPath,
      '-in',
      certPath,
      '-out',
      pfxPath,
      '-name',
      'Dhruvanta Systems Self-Signed Code Signing',
      '-passout',
      'pass:<redacted>',
    ],
  )
  await fs.chmod(pfxPath, 0o600)
}

async function writeEnvFile() {
  await fs.writeFile(
    envPath,
    [
      `export PRINTANYWHERE_CODESIGN_PFX=${shellQuote(pfxPath)}`,
      `export PRINTANYWHERE_CODESIGN_PASSWORD_FILE=${shellQuote(passwordPath)}`,
      'export PRINTANYWHERE_CODESIGN_STRICT=1',
      'export PRINTANYWHERE_CODESIGN_TIMESTAMP_URL=none',
      'export PRINTANYWHERE_CODESIGN_DESCRIPTION="PrintAnywhere Agent Setup"',
      'export PRINTANYWHERE_CODESIGN_URL="https://www.dhruvantasystems.com/products/print-anywhere"',
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
  await fs.chmod(envPath, 0o600)
}

await ensureSecretDir()
const alreadyExists = (await exists(keyPath)) && (await exists(certPath)) && (await exists(pfxPath)) && (await exists(passwordPath))
if (alreadyExists && !rotate) {
  console.log(`Self-signed code-signing certificate already exists: ${certPath}`)
} else {
  if (alreadyExists && rotate) {
    await fs.rm(keyPath, { force: true })
    await fs.rm(certPath, { force: true })
    await fs.rm(pfxPath, { force: true })
    await fs.rm(passwordPath, { force: true })
  }
  await createCertificate()
}
await writeEnvFile()

const details = await runCapture('openssl', [
  'x509',
  '-in',
  certPath,
  '-noout',
  '-subject',
  '-issuer',
  '-dates',
  '-sha256',
  '-fingerprint',
  '-ext',
  'extendedKeyUsage',
])

console.log(details.trim())
console.log('')
console.log(`Use this before building a self-signed internal release:`)
console.log(`. ${envPath}`)
