import fs from 'node:fs/promises'
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

async function readPassword() {
  const direct = process.env.PRINTANYWHERE_CODESIGN_PASSWORD?.trim()
  if (direct) return direct

  const passwordFile = process.env.PRINTANYWHERE_CODESIGN_PASSWORD_FILE?.trim()
  if (passwordFile) return (await fs.readFile(passwordFile, 'utf8')).trim()

  return ''
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
      '/tr',
      config.timestampUrl,
      '/td',
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
    '-t',
    config.timestampUrl,
    '-in',
    executablePath,
    '-out',
    signedPath,
  ]
  const redactedArgs = args.map((arg, index) => (args[index - 1] === '-pass' ? '<redacted>' : arg))
  await run(tool.command, args, redactedArgs)
  await fs.rename(signedPath, executablePath)
  return { signed: true, tool: tool.kind }
}
