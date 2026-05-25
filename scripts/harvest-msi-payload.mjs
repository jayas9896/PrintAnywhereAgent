#!/usr/bin/env node
// Phase 2c follow-up — walk the staged MSI payload and write a
// per-user-compatible Harvested.wxs fragment. Replaces the
// HarvestDirectory MSBuild item that produced a ComponentGroup
// WiX 5's linker couldn't resolve; this script is deterministic and
// easy to debug because it just emits XML.
//
// Per-user install rules the script honours:
//   * Every Component carries an HKCU RegistryValue with
//     KeyPath="yes" (ICE38).
//   * Every directory it creates has a RemoveFolder so uninstall
//     takes it out of %LOCALAPPDATA% (ICE64).
//   * Component GUIDs are derived deterministically from the file
//     path so a re-build of the same payload produces the same
//     GUIDs (MSI engine reference counting stays consistent across
//     versions).
//   * Component / Directory / File ids are MSI-safe (alphanumeric +
//     underscore, max 72 chars, hash-suffixed if collision risk).
//
// Run after staging the bundle:
//   node scripts/harvest-msi-payload.mjs \
//     --payload <abs path to payload> \
//     --output <abs path to Harvested.wxs>
//
// Then the wixproj compiles Harvested.wxs alongside Product.wxs and
// Product.wxs references the generated ComponentGroup via
// <ComponentGroupRef Id="PayloadComponents" />.

import { createHash } from 'node:crypto'
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

const args = parseArgs(process.argv.slice(2))
if (!args.payload || !args.output) {
  console.error('Usage: harvest-msi-payload.mjs --payload <dir> --output <Harvested.wxs>')
  process.exit(2)
}

// GUID namespace pinned forever. Changing it would invalidate every
// component GUID and break upgrade reference counting on existing
// installs. Generated once via uuidgen; treat as a constant.
const GUID_NAMESPACE = '6FA53F8B-9C1E-4D2A-B5F3-7E8A2D6B4C19'

const payloadRoot = args.payload
const outputPath = args.output

const usedIds = new Set()
const components = []   // [{ componentId, guid, dirId, fileSource, fileName, relativeUnix }]
const directories = new Map() // dirId -> { name, parentId, removeAnchor: componentId|null }

walk(payloadRoot, 'INSTALLDIR')
emitWxs()
console.error(`harvest-msi-payload: ${components.length} components / ${directories.size + 1} dirs / wxs ${outputPath}`)

function walk(absDir, parentDirId) {
  const entries = readdirSync(absDir).sort()
  for (const name of entries) {
    if (name === '.gitkeep') continue
    const abs = join(absDir, name)
    const rel = relative(payloadRoot, abs)
    const s = statSync(abs)
    if (s.isDirectory()) {
      const dirId = stableId('d_' + rel.replace(/[\\/]/g, '_'))
      directories.set(dirId, { name, parentId: parentDirId, removeAnchor: null })
      walk(abs, dirId)
    } else if (s.isFile()) {
      const componentId = stableId('c_' + rel.replace(/[\\/]/g, '_').replace(/[^A-Za-z0-9_]/g, '_'))
      const guid = deterministicGuid(rel)
      const fileSource = rel.replace(/\//g, '\\')
      components.push({
        componentId,
        guid,
        dirId: parentDirId,
        fileSource: '$(var.PayloadSource)\\' + fileSource,
        fileName: name,
        relativeUnix: rel,
      })
      // Anchor RemoveFolder for this dir on the FIRST component in it.
      // Each parent dir up to INSTALLDIR needs exactly one anchor.
      anchorRemoveFoldersUpwards(parentDirId, componentId)
    }
  }
}

function anchorRemoveFoldersUpwards(dirId, componentId) {
  if (dirId === 'INSTALLDIR') return
  const dir = directories.get(dirId)
  if (!dir || dir.removeAnchor) return
  dir.removeAnchor = componentId
  anchorRemoveFoldersUpwards(dir.parentId, componentId)
}

function emitWxs() {
  // Emit nested Directory tree.
  const dirChildren = new Map()
  for (const [id, info] of directories) {
    if (!dirChildren.has(info.parentId)) dirChildren.set(info.parentId, [])
    dirChildren.get(info.parentId).push({ id, ...info })
  }

  let directoryRefBody = ''
  function emitDir(parentId, indent) {
    const kids = (dirChildren.get(parentId) || []).sort((a, b) => a.name.localeCompare(b.name))
    let out = ''
    for (const k of kids) {
      out += `${indent}<Directory Id="${k.id}" Name="${escapeAttr(k.name)}">\n`
      out += emitDir(k.id, indent + '  ')
      out += `${indent}</Directory>\n`
    }
    return out
  }
  directoryRefBody = emitDir('INSTALLDIR', '    ')

  let componentBody = ''
  // Group RemoveFolder entries per anchor component.
  const removeFoldersByComponent = new Map()
  for (const [dirId, info] of directories) {
    if (!info.removeAnchor) continue
    if (!removeFoldersByComponent.has(info.removeAnchor)) {
      removeFoldersByComponent.set(info.removeAnchor, [])
    }
    removeFoldersByComponent.get(info.removeAnchor).push(dirId)
  }

  for (const c of components) {
    const removes = removeFoldersByComponent.get(c.componentId) || []
    componentBody += `    <Component Id="${c.componentId}" Directory="${c.dirId}" Guid="${c.guid}">\n`
    componentBody += `      <RegistryValue Root="HKCU" Key="Software\\Dhruvanta Systems\\PrintAnywhereAgent\\Files" Name="${c.componentId}" Type="integer" Value="1" KeyPath="yes" />\n`
    componentBody += `      <File Source="${escapeAttr(c.fileSource)}" />\n`
    for (const dirId of removes) {
      componentBody += `      <RemoveFolder Id="rf_${c.componentId}_${dirId}" Directory="${dirId}" On="uninstall" />\n`
    }
    componentBody += `    </Component>\n`
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Harvested.wxs — auto-generated by scripts/harvest-msi-payload.mjs.
  Do NOT edit by hand; the next harvest run will overwrite it.

  ${components.length} files / ${directories.size + 1} directories
  staged from \${PAYLOAD_SOURCE} into INSTALLDIR.

  Per-user MSI semantics: every Component carries an HKCU registry
  KeyPath (ICE38) and every per-user directory has a RemoveFolder
  anchored on its first child component (ICE64).
-->
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Fragment>
    <DirectoryRef Id="INSTALLDIR">
${directoryRefBody}    </DirectoryRef>

    <ComponentGroup Id="PayloadComponents">
${componentBody}    </ComponentGroup>
  </Fragment>
</Wix>
`
  writeFileSync(outputPath, xml)
}

function stableId(base) {
  let id = base.replace(/[^A-Za-z0-9_]/g, '_')
  if (id.length > 60) {
    const tail = createHash('sha1').update(base).digest('hex').slice(0, 8)
    id = id.slice(0, 51) + '_' + tail
  }
  if (/^[0-9]/.test(id)) id = '_' + id
  let candidate = id
  let n = 0
  while (usedIds.has(candidate)) {
    n += 1
    candidate = id.slice(0, 60) + '_' + n
  }
  usedIds.add(candidate)
  return candidate
}

function deterministicGuid(relativePath) {
  // Synthesise a UUID v5-style guid from the namespace + the relative
  // file path. Pure SHA-1 hashing — the MSI engine just needs a stable
  // 128-bit identifier per Component across builds.
  const h = createHash('sha1')
  h.update(GUID_NAMESPACE)
  h.update(relativePath.replace(/\\/g, '/'))
  const hex = h.digest('hex').slice(0, 32)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    // Set the version nibble to 5 (name-based SHA1 UUID).
    '5' + hex.slice(13, 16),
    // Set the variant bits (top two bits 10).
    ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + hex.slice(18, 20),
    hex.slice(20, 32),
  ].join('-').toUpperCase()
}

function escapeAttr(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--payload') out.payload = argv[++i]
    else if (a === '--output') out.output = argv[++i]
  }
  return out
}
