#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const version = packageJson.version
const artifactName = `printanywhere-agent-v${version}`
const artifactsDir = path.join(repoRoot, 'artifacts')
const bundleDir = path.join(artifactsDir, artifactName)
const archivePath = path.join(artifactsDir, `${artifactName}.tar.gz`)
const zipPath = path.join(artifactsDir, `${artifactName}.zip`)
const nodeRuntimeVersion = process.env.PRINTANYWHERE_AGENT_NODE_RUNTIME_VERSION || 'v22.22.2'
const nodeRuntimeArchiveName = `node-${nodeRuntimeVersion}-win-x64.zip`
const nodeRuntimeUrl = `https://nodejs.org/dist/${nodeRuntimeVersion}/${nodeRuntimeArchiveName}`
const cacheDir = path.join(artifactsDir, 'cache')
const nodeRuntimeArchivePath = path.join(cacheDir, nodeRuntimeArchiveName)
const nodeRuntimeExtractDir = path.join(cacheDir, `node-${nodeRuntimeVersion}-win-x64`)
const nodeRuntimeBundleDir = path.join(bundleDir, 'runtime', 'node-win-x64')

async function run(command, args, cwd = repoRoot) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`))
    })
  })
}

async function copy(source, destination) {
  await fs.cp(source, destination, { recursive: true })
}

function commandName(baseName) {
  return process.platform === 'win32' ? `${baseName}.cmd` : baseName
}

async function writeText(targetPath, value) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.writeFile(targetPath, value, 'utf8')
}

async function hashFile(filePath) {
  const file = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(file).digest('hex')
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function downloadFile(url, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status}`)
  }

  await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()))
}

async function extractZip(source, destination) {
  await fs.mkdir(destination, { recursive: true })
  if (process.platform === 'win32') {
    await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath "${source}" -DestinationPath "${destination}" -Force`,
    ])
    return
  }

  await run('python3', ['-m', 'zipfile', '-e', source, destination])
}

async function includeWindowsNodeRuntime() {
  if (!(await pathExists(nodeRuntimeArchivePath))) {
    console.log(`Downloading Windows Node runtime ${nodeRuntimeVersion}...`)
    await downloadFile(nodeRuntimeUrl, nodeRuntimeArchivePath)
  }

  if (!(await pathExists(path.join(nodeRuntimeExtractDir, 'node.exe')))) {
    await fs.rm(nodeRuntimeExtractDir, { recursive: true, force: true })
    await extractZip(nodeRuntimeArchivePath, cacheDir)
  }

  await fs.rm(nodeRuntimeBundleDir, { recursive: true, force: true })
  await copy(nodeRuntimeExtractDir, nodeRuntimeBundleDir)
}

await run(commandName('npm'), ['run', 'build'])

await fs.rm(bundleDir, { recursive: true, force: true })
await fs.rm(archivePath, { force: true })
await fs.rm(zipPath, { force: true })
await fs.mkdir(bundleDir, { recursive: true })

await copy(path.join(repoRoot, 'dist'), path.join(bundleDir, 'dist'))
await copy(path.join(repoRoot, 'docs'), path.join(bundleDir, 'docs'))
await copy(path.join(repoRoot, 'config'), path.join(bundleDir, 'config'))
await copy(path.join(repoRoot, 'assets'), path.join(bundleDir, 'assets'))
await writeText(path.join(bundleDir, 'README.md'), await fs.readFile(path.join(repoRoot, 'README.md'), 'utf8'))
await writeText(path.join(bundleDir, 'package.json'), await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'))
await writeText(path.join(bundleDir, 'package-lock.json'), await fs.readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'))
await writeText(
  path.join(bundleDir, 'start-agent.cmd'),
  '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\\start-agent-background.ps1" -OpenUi %*\r\n',
)
await writeText(
  path.join(bundleDir, 'run-agent-console.cmd'),
  '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\run-agent.ps1" %*\r\n',
)
await writeText(
  path.join(bundleDir, 'agent-tray.cmd'),
  '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\\agent-tray.ps1" %*\r\n',
)
await writeText(
  path.join(bundleDir, 'update-agent.cmd'),
  '@echo off\r\npowershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0scripts\\check-update.ps1" -Install %*\r\n',
)
await writeText(
  path.join(bundleDir, 'uninstall-agent.cmd'),
  '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\uninstall-agent.ps1" %*\r\n',
)
await writeText(
  path.join(bundleDir, 'install-agent.cmd'),
  '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\install-release.ps1" %*\r\n',
)
await copy(path.join(repoRoot, 'scripts', 'run-agent.ps1'), path.join(bundleDir, 'scripts', 'run-agent.ps1'))
await copy(path.join(repoRoot, 'scripts', 'start-agent-background.ps1'), path.join(bundleDir, 'scripts', 'start-agent-background.ps1'))
await copy(path.join(repoRoot, 'scripts', 'stop-agent.ps1'), path.join(bundleDir, 'scripts', 'stop-agent.ps1'))
await copy(path.join(repoRoot, 'scripts', 'restart-agent.ps1'), path.join(bundleDir, 'scripts', 'restart-agent.ps1'))
await copy(path.join(repoRoot, 'scripts', 'agent-tray.ps1'), path.join(bundleDir, 'scripts', 'agent-tray.ps1'))
await copy(path.join(repoRoot, 'scripts', 'check-update.ps1'), path.join(bundleDir, 'scripts', 'check-update.ps1'))
await copy(path.join(repoRoot, 'scripts', 'uninstall-agent.ps1'), path.join(bundleDir, 'scripts', 'uninstall-agent.ps1'))
await copy(path.join(repoRoot, 'scripts', 'install-release.ps1'), path.join(bundleDir, 'scripts', 'install-release.ps1'))
await copy(path.join(repoRoot, 'scripts', 'discover-printers.ps1'), path.join(bundleDir, 'scripts', 'discover-printers.ps1'))
await includeWindowsNodeRuntime()

await run(commandName('npm'), ['ci', '--omit=dev'], bundleDir)

const manifestPath = path.join(bundleDir, 'release-manifest.json')
await writeText(
  manifestPath,
  `${JSON.stringify(
    {
      name: artifactName,
      version,
      builtAt: new Date().toISOString(),
      nodeVersion: process.version,
      contents: [
        'README.md',
        'assets/dhruvanta-agent.ico',
        'config/agent.env.example',
        'dist/',
        'docs/',
        'agent-tray.cmd',
        'install-agent.cmd',
        'node_modules/',
        'package.json',
        'run-agent-console.cmd',
        'runtime/node-win-x64/node.exe',
        'scripts/agent-tray.ps1',
        'scripts/check-update.ps1',
        'scripts/uninstall-agent.ps1',
        'scripts/install-release.ps1',
        'scripts/discover-printers.ps1',
        'scripts/restart-agent.ps1',
        'scripts/run-agent.ps1',
        'scripts/start-agent-background.ps1',
        'scripts/stop-agent.ps1',
        'start-agent.cmd',
        'update-agent.cmd',
        'uninstall-agent.cmd',
      ],
    },
    null,
    2,
  )}\n`,
)

let archiveHash = null
try {
  await run('tar', ['-czf', archivePath, '-C', artifactsDir, artifactName])
  archiveHash = await hashFile(archivePath)
} catch (error) {
  console.warn(`Skipping tar.gz archive creation: ${error instanceof Error ? error.message : String(error)}`)
}

let zipHash = null
try {
  if (process.platform === 'win32') {
    await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path "${bundleDir}\\*" -DestinationPath "${zipPath}" -Force`,
    ])
  } else {
    await run('python3', [
      '-c',
      [
        'import pathlib',
        'import zipfile',
        `bundle = pathlib.Path(${JSON.stringify(bundleDir)})`,
        `zip_path = pathlib.Path(${JSON.stringify(zipPath)})`,
        'with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:',
        '    for path in bundle.rglob("*"):',
        '        archive.write(path, path.relative_to(bundle.parent))',
      ].join('\n'),
    ])
  }
  zipHash = await hashFile(zipPath)
} catch (error) {
  console.warn(`Skipping zip archive creation: ${error instanceof Error ? error.message : String(error)}`)
}

const manifestHash = await hashFile(manifestPath)

await writeText(
  path.join(artifactsDir, 'SHA256SUMS.txt'),
  [
    archiveHash ? `${archiveHash}  ${path.basename(archivePath)}` : null,
    zipHash ? `${zipHash}  ${path.basename(zipPath)}` : null,
    `${manifestHash}  ${artifactName}/release-manifest.json`,
  ]
    .filter(Boolean)
    .join('\n')
    .concat('\n'),
)

console.log(`Release bundle ready at ${bundleDir}`)
if (archiveHash) {
  console.log(`Archive ready at ${archivePath}`)
}
if (zipHash) {
  console.log(`Zip bundle ready at ${zipPath}`)
}
