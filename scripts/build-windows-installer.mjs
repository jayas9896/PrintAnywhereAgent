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
const zipPath = path.join(artifactsDir, `${artifactName}.zip`)
const installerPath = path.join(artifactsDir, `${artifactName}-setup.exe`)
const tempDir = path.join(repoRoot, 'tmp', 'windows-installer')
const resourcePath = path.join(tempDir, 'printanywhere-agent-installer.rc')
const resourceObjectPath = path.join(tempDir, 'printanywhere-agent-installer.res.o')
const installerSource = path.join(
  repoRoot,
  'packaging',
  'windows-installer',
  'printanywhere_agent_installer.c',
)

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

async function requireFile(filePath, hint) {
  try {
    await fs.access(filePath)
  } catch {
    throw new Error(`${hint}: ${filePath}`)
  }
}

async function hashFile(filePath) {
  const file = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(file).digest('hex')
}

function rcString(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

await requireFile(zipPath, 'Release zip is missing; run npm run release:build first')
await requireFile(installerSource, 'Installer source is missing')
await fs.mkdir(tempDir, { recursive: true })

await fs.writeFile(
  resourcePath,
  [
    '#include <windows.h>',
    `101 RCDATA "${rcString(zipPath)}"`,
    '1 VERSIONINFO',
    'FILEVERSION 0,1,0,0',
    'PRODUCTVERSION 0,1,0,0',
    'FILEOS 0x40004L',
    'FILETYPE 0x1L',
    'BEGIN',
    '  BLOCK "StringFileInfo"',
    '  BEGIN',
    '    BLOCK "040904b0"',
    '    BEGIN',
    '      VALUE "CompanyName", "Dhruvanta Systems"',
    '      VALUE "FileDescription", "PrintAnywhere Agent Setup"',
    `      VALUE "FileVersion", "${version}"`,
    '      VALUE "InternalName", "PrintAnywhereAgentSetup"',
    '      VALUE "OriginalFilename", "printanywhere-agent-setup.exe"',
    '      VALUE "ProductName", "PrintAnywhere Agent"',
    `      VALUE "ProductVersion", "${version}"`,
    '    END',
    '  END',
    '  BLOCK "VarFileInfo"',
    '  BEGIN',
    '    VALUE "Translation", 0x409, 1200',
    '  END',
    'END',
    '',
  ].join('\n'),
  'utf8',
)

await run('x86_64-w64-mingw32-windres', ['-O', 'coff', resourcePath, resourceObjectPath])
await run('x86_64-w64-mingw32-gcc', [
  '-Os',
  '-municode',
  '-mwindows',
  '-static',
  '-static-libgcc',
  `-DAGENT_BUNDLE_NAME=L"${artifactName}"`,
  `-DAGENT_VERSION=L"${version}"`,
  installerSource,
  resourceObjectPath,
  '-o',
  installerPath,
  '-lshell32',
])

const installerHash = await hashFile(installerPath)
const sumsPath = path.join(artifactsDir, 'SHA256SUMS.txt')
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

console.log(`Windows installer ready at ${installerPath}`)
