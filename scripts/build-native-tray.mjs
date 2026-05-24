#!/usr/bin/env node
// Phase 2b — Wraps the `dotnet publish` invocation for the native
// Windows tray app so the release-bundle script + CI can call one
// command and get bin/Release/net8.0-windows/win-x64/publish/
// PrintAnywhereAgent.exe.
//
// Linux + macOS hosts must use the Microsoft-distributed .NET SDK
// (the Ubuntu apt package omits Microsoft.NET.Sdk.WindowsDesktop
// which WinForms requires). Detects $DOTNET_ROOT, falls back to a
// `dotnet` on PATH; errors out if the SDK does not look usable.

import { spawnSync } from 'node:child_process'
import { mkdirSync, existsSync, copyFileSync, statSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const projectDir = join(repoRoot, 'native-shell', 'PrintAnywhereAgent.Tray')
const projectFile = join(projectDir, 'PrintAnywhereAgent.Tray.csproj')

if (!existsSync(projectFile)) {
  console.error(`build-native-tray: project file not found at ${projectFile}`)
  process.exit(2)
}

const dotnet = resolveDotnet()
console.error(`build-native-tray: using ${dotnet}`)

const publishArgs = [
  'publish',
  projectFile,
  '-c', 'Release',
  '-r', 'win-x64',
  '--self-contained=true',
  '-p:PublishSingleFile=true',
  '-p:IncludeNativeLibrariesForSelfExtract=true',
  '-p:EnableCompressionInSingleFile=true',
  '-v', 'minimal',
]

const result = spawnSync(dotnet, publishArgs, { stdio: 'inherit', cwd: projectDir })
if (result.status !== 0) {
  console.error(`build-native-tray: dotnet publish exited ${result.status}`)
  process.exit(result.status ?? 1)
}

const publishedExe = join(
  projectDir,
  'bin', 'Release', 'net8.0-windows', 'win-x64', 'publish',
  'PrintAnywhereAgent.exe',
)
if (!existsSync(publishedExe)) {
  console.error(`build-native-tray: expected output not produced at ${publishedExe}`)
  process.exit(3)
}
const size = statSync(publishedExe).size
console.error(`build-native-tray: produced ${publishedExe} (${(size / (1024 * 1024)).toFixed(1)} MB)`)

// Optional: copy into a stable artifacts/ slot so the release-bundle
// script can pick it up without knowing the dotnet output path.
const artifactsDir = join(repoRoot, 'artifacts', 'native-shell')
mkdirSync(artifactsDir, { recursive: true })
const stagedExe = join(artifactsDir, 'PrintAnywhereAgent.exe')
copyFileSync(publishedExe, stagedExe)
console.error(`build-native-tray: staged ${stagedExe}`)

function resolveDotnet() {
  const root = process.env.DOTNET_ROOT
  if (root) {
    const candidate = join(root, 'dotnet')
    if (existsSync(candidate)) return candidate
  }
  // Fall back to PATH.
  return 'dotnet'
}
