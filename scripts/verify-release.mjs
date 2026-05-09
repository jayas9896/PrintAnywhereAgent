#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const version = packageJson.version
const artifactName = `printanywhere-agent-v${version}`
const artifactsDir = path.join(repoRoot, 'artifacts')
const bundleDir = path.join(artifactsDir, artifactName)
const requiredPaths = [
  'README.md',
  'config/agent.env.example',
  'dist/index.js',
  'docs/windows-setup.md',
  'docs/operator-approval-and-recovery.md',
  'install-agent.cmd',
  'node_modules',
  'package.json',
  'release-manifest.json',
  'runtime/node-win-x64/node.exe',
  'scripts/install-release.ps1',
  'scripts/run-agent.ps1',
  'start-agent.cmd',
]

const missing = []
for (const relativePath of requiredPaths) {
  try {
    await fs.access(path.join(bundleDir, relativePath))
  } catch {
    missing.push(relativePath)
  }
}

if (missing.length > 0) {
  console.error(`Release bundle ${artifactName} is missing required files:`)
  for (const relativePath of missing) {
    console.error(`- ${relativePath}`)
  }
  process.exit(1)
}

console.log(`Release bundle ${artifactName} looks complete.`)
