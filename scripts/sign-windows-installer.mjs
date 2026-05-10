#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { signWindowsExecutable } from './lib/windows-codesign.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const version = packageJson.version
const artifactName = `printanywhere-agent-v${version}`
const artifactsDir = path.join(repoRoot, 'artifacts')
const installerPath = path.join(artifactsDir, `${artifactName}-setup.exe`)
const sumsPath = path.join(artifactsDir, 'SHA256SUMS.txt')
const required = process.argv.includes('--required')

async function hashFile(filePath) {
  const file = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(file).digest('hex')
}

async function updateChecksum() {
  const installerHash = await hashFile(installerPath)
  let sums = ''
  try {
    sums = await fs.readFile(sumsPath, 'utf8')
  } catch {
    // Created below.
  }

  const installerLine = `${installerHash}  ${path.basename(installerPath)}`
  const nextSums = [
    ...sums
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.endsWith(`  ${path.basename(installerPath)}`)),
    installerLine,
  ].join('\n')

  await fs.writeFile(sumsPath, `${nextSums}\n`, 'utf8')
}

const result = await signWindowsExecutable(installerPath, { required })
if (!result.signed) {
  console.log(`Windows installer left unsigned: ${result.reason}`)
  process.exit(required ? 1 : 0)
}

await updateChecksum()
console.log(`Windows installer signed with ${result.tool} and SHA256SUMS.txt updated.`)
