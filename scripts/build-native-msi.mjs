#!/usr/bin/env node
// Phase 2c — chains scripts/build-native-tray.mjs + `dotnet build`
// of the WiX installer so a single command produces the MSI.
//
// NB: WiX 5 explicitly does not support non-Windows builds. This
// script will run end-to-end on a Windows host (PowerShell or CMD)
// and produces native-shell/PrintAnywhereAgent.Installer/bin/
// Release/PrintAnywhereAgent-<version>.msi.
//
// On Linux / macOS it runs the native-tray compile (which IS
// cross-platform), then surfaces the "wix only supports Windows"
// failure when it gets to the .wixproj build. CI uses
// .github/workflows/native-shell.yml on a real windows-latest
// runner — that is the authoritative gate.

import { spawnSync } from 'node:child_process'
import { mkdirSync, existsSync, copyFileSync, readFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const version = pkg.version
console.error(`build-native-msi: PA version ${version}`)

// 1) Build the native tray EXE.
const trayResult = spawnSync(process.execPath, [join(__dirname, 'build-native-tray.mjs')], {
  stdio: 'inherit',
  cwd: repoRoot,
})
if (trayResult.status !== 0) {
  console.error('build-native-msi: native tray build failed')
  process.exit(trayResult.status ?? 1)
}

// 2) Stage MSI payload — at minimum the native EXE. The release-
//    bundle pipeline (release:build) supplies dist/, node-win-x64/,
//    scripts/, config/, assets/ into the same payload dir before
//    invoking this script in CI.
const payload = join(repoRoot, 'native-shell', 'PrintAnywhereAgent.Installer', 'payload')
mkdirSync(payload, { recursive: true })
const stagedExe = join(repoRoot, 'artifacts', 'native-shell', 'PrintAnywhereAgent.exe')
if (!existsSync(stagedExe)) {
  console.error(`build-native-msi: tray EXE missing at ${stagedExe}`)
  process.exit(2)
}
copyFileSync(stagedExe, join(payload, 'PrintAnywhereAgent.exe'))
console.error(`build-native-msi: payload staged at ${payload}`)

// 3) Build the MSI.
const dotnet = resolveDotnet()
const wixproj = join(repoRoot, 'native-shell', 'PrintAnywhereAgent.Installer', 'PrintAnywhereAgent.Installer.wixproj')
const msiResult = spawnSync(dotnet, [
  'build', wixproj,
  '-c', 'Release',
  `-p:PrintAnywhereAgentVersion=${version}`,
  `-p:PayloadSource=${payload}`,
  '-v', 'minimal',
], { stdio: 'inherit', cwd: dirname(wixproj) })
if (msiResult.status !== 0) {
  console.error(`build-native-msi: wix build exited ${msiResult.status}`)
  if (process.platform !== 'win32') {
    console.error('build-native-msi: WiX 5 only supports Windows builds.')
    console.error('build-native-msi: run this script on the .github/workflows/native-shell.yml CI workflow,')
    console.error('build-native-msi: or on a Windows dev box with the .NET SDK installed.')
  }
  process.exit(msiResult.status ?? 1)
}

console.error('build-native-msi: MSI build succeeded.')
console.error(`build-native-msi: artifact at native-shell/PrintAnywhereAgent.Installer/bin/Release/en-US/PrintAnywhereAgent-${version}.msi`)

function resolveDotnet() {
  const root = process.env.DOTNET_ROOT
  if (root) {
    const candidate = join(root, 'dotnet')
    if (existsSync(candidate)) return candidate
  }
  return 'dotnet'
}
