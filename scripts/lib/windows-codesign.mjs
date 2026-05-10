import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const DEFAULT_TIMESTAMP_URL = 'http://timestamp.digicert.com'
const DEFAULT_DESCRIPTION = 'PrintAnywhere Agent Setup'
const DEFAULT_PRODUCT_URL = 'https://www.dhruvantasystems.com/products/print-anywhere'

function envFlag(name) {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').trim().toLowerCase())
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function commandAvailable(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { stdio: 'ignore', shell: false })
    child.on('error', () => resolve(false))
    child.on('exit', () => resolve(true))
  })
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

async function runCapture(command, args, redactedArgs = args) {
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

      reject(
        new Error(
          `${command} ${redactedArgs.join(' ')} exited with code ${code ?? 'unknown'}${stderr ? `\n${stderr}` : ''}`,
        ),
      )
    })
  })
}

async function readPassword() {
  const direct = process.env.PRINTANYWHERE_CODESIGN_PASSWORD?.trim()
  if (direct) return direct

  const passwordFile = process.env.PRINTANYWHERE_CODESIGN_PASSWORD_FILE?.trim()
  if (passwordFile) return (await fs.readFile(passwordFile, 'utf8')).trim()

  return ''
}

async function withPasswordFile(password, callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'printanywhere-codesign-'))
  const passwordPath = path.join(tempDir, 'password.txt')
  await fs.writeFile(passwordPath, password, { mode: 0o600 })
  try {
    return await callback(passwordPath)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

async function resolveSigningTool() {
  const signtool = process.env.PRINTANYWHERE_SIGNTOOL_PATH?.trim()
  if (signtool) return { kind: 'signtool', command: signtool }

  const osslsigncode = process.env.PRINTANYWHERE_OSSLSIGNCODE_PATH?.trim()
  if (osslsigncode) return { kind: 'osslsigncode', command: osslsigncode }

  if (process.platform === 'win32' && (await commandAvailable('signtool.exe'))) {
    return { kind: 'signtool', command: 'signtool.exe' }
  }

  if (await commandAvailable('osslsigncode')) {
    return { kind: 'osslsigncode', command: 'osslsigncode' }
  }

  if (await commandAvailable('signtool.exe')) {
    return { kind: 'signtool', command: 'signtool.exe' }
  }

  return null
}

async function loadCodesignConfig(required) {
  const certPath = process.env.PRINTANYWHERE_CODESIGN_PFX?.trim()
  const strict = required || envFlag('PRINTANYWHERE_CODESIGN_STRICT')

  if (!certPath && !strict) {
    return {
      enabled: false,
      reason: 'set PRINTANYWHERE_CODESIGN_PFX plus PRINTANYWHERE_CODESIGN_PASSWORD or PRINTANYWHERE_CODESIGN_PASSWORD_FILE to sign the installer',
    }
  }

  if (!certPath) {
    throw new Error('PRINTANYWHERE_CODESIGN_PFX is required for Authenticode signing.')
  }
  if (!(await pathExists(certPath))) {
    throw new Error(`PRINTANYWHERE_CODESIGN_PFX does not exist: ${certPath}`)
  }

  const password = await readPassword()
  if (!password) {
    throw new Error(
      'PRINTANYWHERE_CODESIGN_PASSWORD or PRINTANYWHERE_CODESIGN_PASSWORD_FILE is required for Authenticode signing.',
    )
  }

  return {
    enabled: true,
    certPath,
    password,
    timestampUrl: process.env.PRINTANYWHERE_CODESIGN_TIMESTAMP_URL?.trim() || DEFAULT_TIMESTAMP_URL,
    description: process.env.PRINTANYWHERE_CODESIGN_DESCRIPTION?.trim() || DEFAULT_DESCRIPTION,
    productUrl: process.env.PRINTANYWHERE_CODESIGN_URL?.trim() || DEFAULT_PRODUCT_URL,
  }
}

function shouldTimestamp(timestampUrl) {
  return !['', '0', 'false', 'none', 'off', 'disabled'].includes(timestampUrl.trim().toLowerCase())
}

async function sha256File(filePath) {
  const file = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(file).digest('hex')
}

async function updateSha256Sums(artifactsDir, relativePaths) {
  const sumsPath = path.join(artifactsDir, 'SHA256SUMS.txt')
  let sums = ''
  try {
    sums = await fs.readFile(sumsPath, 'utf8')
  } catch {
    // Created below.
  }

  const relativeSet = new Set(relativePaths)
  const preserved = sums
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.trim()) return false
      const relativePath = line.split(/\s\s+/).at(-1)
      return !relativeSet.has(relativePath)
    })

  const nextLines = [...preserved]
  for (const relativePath of relativePaths) {
    nextLines.push(`${await sha256File(path.join(artifactsDir, relativePath))}  ${relativePath}`)
  }

  await fs.writeFile(sumsPath, `${nextLines.join('\n')}\n`, 'utf8')
}

export async function exportCodesignPublicArtifacts(artifactsDir, options = {}) {
  const config = await loadCodesignConfig(Boolean(options.required))
  if (!config.enabled) {
    return { exported: false, reason: config.reason }
  }
  if (!(await commandAvailable('openssl'))) {
    throw new Error('openssl is required to export code-signing public certificate artifacts.')
  }

  await fs.mkdir(artifactsDir, { recursive: true })
  const publicPemName = 'dhruvanta-systems-codesign-public.pem'
  const publicCerName = 'dhruvanta-systems-codesign-public.cer'
  const fingerprintName = 'dhruvanta-systems-codesign-fingerprint.txt'
  const integrityName = 'RELEASE-INTEGRITY.txt'
  const publicPemPath = path.join(artifactsDir, publicPemName)
  const publicCerPath = path.join(artifactsDir, publicCerName)
  const fingerprintPath = path.join(artifactsDir, fingerprintName)
  const integrityPath = path.join(artifactsDir, integrityName)

  await withPasswordFile(config.password, async (passwordPath) => {
    await run(
      'openssl',
      [
        'pkcs12',
        '-in',
        config.certPath,
        '-clcerts',
        '-nokeys',
        '-passin',
        `file:${passwordPath}`,
        '-out',
        publicPemPath,
      ],
      ['pkcs12', '-in', config.certPath, '-clcerts', '-nokeys', '-passin', 'file:<redacted>', '-out', publicPemPath],
    )
  })

  await run('openssl', ['x509', '-in', publicPemPath, '-outform', 'DER', '-out', publicCerPath])
  const certDetails = await runCapture('openssl', [
    'x509',
    '-in',
    publicPemPath,
    '-noout',
    '-subject',
    '-issuer',
    '-serial',
    '-dates',
    '-sha256',
    '-fingerprint',
    '-ext',
    'keyUsage',
    '-ext',
    'extendedKeyUsage',
  ])

  const installerPath = options.installerPath ? path.resolve(options.installerPath) : null
  const installerLine =
    installerPath && (await pathExists(installerPath))
      ? `installer_sha256=${await sha256File(installerPath)}\ninstaller_file=${path.basename(installerPath)}\n`
      : ''

  await fs.writeFile(
    fingerprintPath,
    [
      '# Dhruvanta Systems self-signed code-signing public certificate',
      '# This certificate lets operators verify the installer signature manually.',
      '# It does not make Windows trust the publisher on customer machines.',
      certDetails.trim(),
      '',
      `public_pem_sha256=${await sha256File(publicPemPath)}`,
      `public_cer_sha256=${await sha256File(publicCerPath)}`,
      installerLine.trim(),
      '',
    ]
      .filter(Boolean)
      .join('\n'),
    'utf8',
  )

  await fs.writeFile(
    integrityPath,
    [
      '# PrintAnywhere Agent release integrity',
      `version=${options.version ?? 'unknown'}`,
      `generated_at=${new Date().toISOString()}`,
      'publisher=Dhruvanta Systems',
      'certificate_mode=self-signed',
      'windows_publisher_trust=unknown_until_an_ov_or_ev_certificate_is_used',
      '',
      'Verification files:',
      `- ${publicPemName}`,
      `- ${publicCerName}`,
      `- ${fingerprintName}`,
      `- ${integrityName}`,
      '- SHA256SUMS.txt',
      '',
      'Windows manual verification:',
      '1. Download the setup exe, SHA256SUMS.txt, and dhruvanta-systems-codesign-public.cer from the same release.',
      '2. Check the setup exe hash against SHA256SUMS.txt.',
      '3. Run: Get-AuthenticodeSignature .\\printanywhere-agent-v<version>-setup.exe | Format-List',
      '4. Compare the signer certificate thumbprint with dhruvanta-systems-codesign-fingerprint.txt.',
      '',
      'Linux/WSL verification:',
      'osslsigncode verify -CAfile artifacts/dhruvanta-systems-codesign-public.pem -in artifacts/printanywhere-agent-v<version>-setup.exe',
      'sha256sum -c artifacts/SHA256SUMS.txt',
      '',
    ].join('\n'),
    'utf8',
  )

  await updateSha256Sums(artifactsDir, [publicPemName, publicCerName, fingerprintName, integrityName])
  return {
    exported: true,
    publicPemPath,
    publicCerPath,
    fingerprintPath,
    integrityPath,
  }
}

export async function signWindowsExecutable(executablePath, options = {}) {
  const config = await loadCodesignConfig(Boolean(options.required))
  if (!config.enabled) {
    return { signed: false, reason: config.reason }
  }

  const tool = await resolveSigningTool()
  if (!tool) {
    throw new Error(
      'No Windows Authenticode signing tool found. Install osslsigncode in WSL or set PRINTANYWHERE_SIGNTOOL_PATH to signtool.exe.',
    )
  }

  if (tool.kind === 'signtool') {
    const args = [
      'sign',
      '/fd',
      'SHA256',
      '/f',
      config.certPath,
      '/p',
      config.password,
      '/d',
      config.description,
      '/du',
      config.productUrl,
      executablePath,
    ]
    if (shouldTimestamp(config.timestampUrl)) {
      args.splice(3, 0, '/tr', config.timestampUrl, '/td', 'SHA256')
    }
    const redactedArgs = args.map((arg, index) => (args[index - 1] === '/p' ? '<redacted>' : arg))
    await run(tool.command, args, redactedArgs)
    return { signed: true, tool: tool.kind }
  }

  const signedPath = `${executablePath}.signed`
  await fs.rm(signedPath, { force: true })
  const args = [
    'sign',
    '-pkcs12',
    config.certPath,
    '-pass',
    config.password,
    '-n',
    config.description,
    '-i',
    config.productUrl,
    '-in',
    executablePath,
    '-out',
    signedPath,
  ]
  if (shouldTimestamp(config.timestampUrl)) {
    args.splice(args.indexOf('-in'), 0, '-t', config.timestampUrl)
  }
  const redactedArgs = args.map((arg, index) => (args[index - 1] === '-pass' ? '<redacted>' : arg))
  await run(tool.command, args, redactedArgs)
  await fs.rename(signedPath, executablePath)
  return { signed: true, tool: tool.kind }
}
