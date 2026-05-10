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
const installerPath = path.join(artifactsDir, `${artifactName}-setup.exe`)
const verifySignedArtifacts =
  process.argv.includes('--signed-artifacts') ||
  ['1', 'true', 'yes', 'on'].includes((process.env.PRINTANYWHERE_VERIFY_SIGNED_ARTIFACTS ?? '').trim().toLowerCase())
const requiredPaths = [
  'README.md',
  'assets/dhruvanta-agent.ico',
  'agent-tray.cmd',
  'config/agent.env.example',
  'dist/index.js',
  'docs/windows-setup.md',
  'docs/code-signing.md',
  'docs/operator-approval-and-recovery.md',
  'install-agent.cmd',
  'node_modules',
  'package.json',
  'release-manifest.json',
  'run-agent-console.cmd',
  'runtime/node-win-x64/node.exe',
  'scripts/agent-tray.ps1',
  'scripts/check-update.ps1',
  'scripts/uninstall-agent.ps1',
  'scripts/discover-printers.ps1',
  'scripts/install-release.ps1',
  'scripts/restart-agent.ps1',
  'scripts/run-agent.ps1',
  'scripts/start-agent-background.ps1',
  'scripts/stop-agent.ps1',
  'start-agent.cmd',
  'update-agent.cmd',
  'uninstall-agent.cmd',
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

const textChecks = [
  {
    file: 'update-agent.cmd',
    mustInclude: ['scripts\\check-update.ps1" -Install', '-STA'],
    mustNotInclude: ['-WindowStyle Hidden'],
  },
  {
    file: 'scripts/agent-tray.ps1',
    mustInclude: ['Invoke-AgentScript -ScriptName "check-update.ps1" -ExtraArguments @() -VisibleWindow'],
    mustNotInclude: [],
  },
  {
    file: 'scripts/check-update.ps1',
    mustInclude: ['Download and install', 'Bring-UpdateWindowToFront', 'Update window opened.', 'Invoke-SetupExecutable', 'Stop-AgentTrayProcesses'],
    mustNotInclude: ['Start-Process -FilePath $downloadPath -ArgumentList "/quiet" -Wait'],
  },
  {
    file: 'scripts/install-release.ps1',
    mustInclude: [
      '"/reset"',
      'repair inherited Windows ACLs',
      'Stop-ExistingTrayControllers',
      'Stop-ExistingAgentRuntime',
      'Remove-OlderManagedVersions',
      'older managed PrintAnywhere Agent install artifact',
    ],
    mustNotInclude: ['$icaclsArgs += "/T"'],
  },
  {
    file: 'docs/windows-setup.md',
    mustInclude: ['Quiet update setup starts the refreshed background agent and tray through the registered Windows Scheduled Tasks'],
    mustNotInclude: [],
  },
]

for (const check of textChecks) {
  const contents = await fs.readFile(path.join(bundleDir, check.file), 'utf8')
  for (const needle of check.mustInclude) {
    if (!contents.includes(needle)) {
      console.error(`Release bundle ${artifactName} ${check.file} is missing required text: ${needle}`)
      process.exit(1)
    }
  }
  for (const needle of check.mustNotInclude) {
    if (contents.includes(needle)) {
      console.error(`Release bundle ${artifactName} ${check.file} still includes forbidden text: ${needle}`)
      process.exit(1)
    }
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

if (verifySignedArtifacts) {
  const integrityArtifacts = [
    'SHA256SUMS.txt',
    'dhruvanta-systems-codesign-public.pem',
    'dhruvanta-systems-codesign-public.cer',
    'dhruvanta-systems-codesign-fingerprint.txt',
    'RELEASE-INTEGRITY.txt',
  ]
  const hasAnyIntegrityArtifact = (
    await Promise.all(integrityArtifacts.slice(1).map((relativePath) => exists(path.join(artifactsDir, relativePath))))
  ).some(Boolean)

  if (hasAnyIntegrityArtifact) {
    const missingIntegrityArtifacts = []
    for (const relativePath of integrityArtifacts) {
      if (!(await exists(path.join(artifactsDir, relativePath)))) {
        missingIntegrityArtifacts.push(relativePath)
      }
    }
    if (missingIntegrityArtifacts.length > 0) {
      console.error(`Signed release artifacts are incomplete for ${artifactName}:`)
      for (const relativePath of missingIntegrityArtifacts) {
        console.error(`- ${relativePath}`)
      }
      process.exit(1)
    }

    const sums = await fs.readFile(path.join(artifactsDir, 'SHA256SUMS.txt'), 'utf8')
    for (const relativePath of [
      `${artifactName}-setup.exe`,
      'dhruvanta-systems-codesign-public.pem',
      'dhruvanta-systems-codesign-public.cer',
      'dhruvanta-systems-codesign-fingerprint.txt',
      'RELEASE-INTEGRITY.txt',
    ]) {
      if (!sums.includes(`  ${relativePath}`)) {
        console.error(`SHA256SUMS.txt is missing signed-release entry: ${relativePath}`)
        process.exit(1)
      }
    }
  }
}

console.log(`Release bundle ${artifactName} looks complete.`)
