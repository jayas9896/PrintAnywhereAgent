#!/usr/bin/env node
// eSigner CKA Authenticode signing of the built MSI via SSL.com CodeSignTool.
//
// KAN-425: replaces the previous placeholder with the real eSigner CKA
// cloud-signing flow. Driven by repo secrets (configured on the repo):
//   ESIGNER_USERNAME       SSL.com / eSigner account username
//   ESIGNER_PASSWORD       account password
//   ESIGNER_TOTP_SECRET    base32 TOTP secret for unattended OTP
//   ESIGNER_CREDENTIAL_ID  signing credential id
//
// Input MSI path comes from PRINTANYWHERE_MSI_PATH (set by the release
// workflow). CodeSignTool is downloaded on demand into a temp dir; it is a
// self-contained Java app and requires a JRE on PATH (windows-latest CI
// runners ship one; if not, the step fails loudly with the reason).
//
// This is intentionally conservative: any missing prerequisite throws with
// a clear message rather than silently producing an unsigned MSI.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function fail(message) {
  console.error(`[sign-windows-installer] ${message}`);
  process.exit(1);
}

const msiPath = process.env.PRINTANYWHERE_MSI_PATH;
if (!msiPath || !existsSync(msiPath)) {
  fail(
    `MSI not found. Set PRINTANYWHERE_MSI_PATH to the built MSI (got: ${msiPath ?? "<unset>"}).`,
  );
}

const username = process.env.ESIGNER_USERNAME;
const password = process.env.ESIGNER_PASSWORD;
const totpSecret = process.env.ESIGNER_TOTP_SECRET;
const credentialId = process.env.ESIGNER_CREDENTIAL_ID;

const missing = [
  ["ESIGNER_USERNAME", username],
  ["ESIGNER_PASSWORD", password],
  ["ESIGNER_TOTP_SECRET", totpSecret],
  ["ESIGNER_CREDENTIAL_ID", credentialId],
]
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  fail(`Missing eSigner credentials: ${missing.join(", ")}.`);
}

// CodeSignTool release (pinned). SSL.com publishes a Windows zip bundle.
const CODESIGNTOOL_VERSION = "v1.3.0";
const CODESIGNTOOL_URL =
  `https://www.ssl.com/download/codesigntool-for-windows/`;

function run(cmd, args, opts = {}) {
  console.log(`[sign-windows-installer] $ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  return result.status ?? 1;
}

const workDir = mkdtempSync(path.join(os.tmpdir(), "codesigntool-"));
const zipPath = path.join(workDir, "CodeSignTool.zip");
const extractDir = path.join(workDir, "CodeSignTool");
mkdirSync(extractDir, { recursive: true });

console.log(
  `[sign-windows-installer] downloading CodeSignTool ${CODESIGNTOOL_VERSION}`,
);
// PowerShell is the most reliable downloader/unzipper on windows-latest.
const dl = run("powershell.exe", [
  "-NoProfile",
  "-Command",
  `Invoke-WebRequest -Uri '${CODESIGNTOOL_URL}' -OutFile '${zipPath}'; ` +
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`,
]);
if (dl !== 0) {
  fail("Failed to download/extract CodeSignTool.");
}

// Locate the CodeSignTool.bat the bundle ships.
function findBat(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findBat(full);
      if (found) return found;
    } else if (entry.name.toLowerCase() === "codesigntool.bat") {
      return full;
    }
  }
  return null;
}

const bat = findBat(extractDir);
if (!bat) {
  fail("CodeSignTool.bat not found in the downloaded bundle.");
}

console.log(`[sign-windows-installer] signing ${path.basename(msiPath)}`);
const signStatus = run(bat, [
  "sign",
  `-username=${username}`,
  `-password=${password}`,
  `-totp_secret=${totpSecret}`,
  `-credential_id=${credentialId}`,
  `-input_file_path=${msiPath}`,
  "-override",
]);

if (signStatus !== 0) {
  fail("CodeSignTool sign failed.");
}

console.log("[sign-windows-installer] MSI signed successfully.");
