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

await run(commandName('npm'), ['run', 'build'])

await fs.rm(bundleDir, { recursive: true, force: true })
await fs.rm(archivePath, { force: true })
await fs.mkdir(bundleDir, { recursive: true })

await copy(path.join(repoRoot, 'dist'), path.join(bundleDir, 'dist'))
await copy(path.join(repoRoot, 'docs'), path.join(bundleDir, 'docs'))
await copy(path.join(repoRoot, 'config'), path.join(bundleDir, 'config'))
await writeText(path.join(bundleDir, 'README.md'), await fs.readFile(path.join(repoRoot, 'README.md'), 'utf8'))
await writeText(path.join(bundleDir, 'package.json'), await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'))
await writeText(path.join(bundleDir, 'package-lock.json'), await fs.readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'))
await writeText(
  path.join(bundleDir, 'start-agent.cmd'),
  '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\run-agent.ps1" %*\r\n',
)
await writeText(
  path.join(bundleDir, 'install-agent.cmd'),
  '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\install-release.ps1" %*\r\n',
)
await copy(path.join(repoRoot, 'scripts', 'run-agent.ps1'), path.join(bundleDir, 'scripts', 'run-agent.ps1'))
await copy(path.join(repoRoot, 'scripts', 'install-release.ps1'), path.join(bundleDir, 'scripts', 'install-release.ps1'))

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
        'config/agent.env.example',
        'dist/',
        'docs/',
        'install-agent.cmd',
        'node_modules/',
        'package.json',
        'scripts/install-release.ps1',
        'scripts/run-agent.ps1',
        'start-agent.cmd',
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

const manifestHash = await hashFile(manifestPath)

await writeText(
  path.join(artifactsDir, 'SHA256SUMS.txt'),
  [
    archiveHash ? `${archiveHash}  ${path.basename(archivePath)}` : null,
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
