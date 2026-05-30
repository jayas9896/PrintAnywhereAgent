# PrintAnywhereAgent

`PrintAnywhereAgent` is the separate Windows-first printer bridge for PrintAnywhere. It is meant to be handed to a public print-shop owner as a prebuilt local agent that exposes that shop's Windows printers to the PrintAnywhere backend.

The agent:

- registers itself with the PrintAnywhere backend
- discovers local Windows printers
- exposes a one-time pairing code to the platform admin
- polls the backend for queued jobs
- downloads encrypted print packets
- decrypts them locally
- prints them and reports status back
- lets the approved shop owner publish and manage customer-facing platform printers from the local UI

## Release Bundle

Preferred distribution flow for production handoff:

```bash
npm ci
npm run release:build
```

That command builds the app and creates a versioned release bundle in `artifacts/`:

- `artifacts/printanywhere-agent-v<version>/`
- `artifacts/printanywhere-agent-v<version>.tar.gz`
- `artifacts/printanywhere-agent-v<version>.zip`
- `artifacts/SHA256SUMS.txt`

For end-user Windows installs, build the self-extracting setup executable:

```bash
npm run release:windows-installer
```

That adds:

- `artifacts/printanywhere-agent-v<version>-setup.exe`

For public customer installs, sign the setup executable with the
Dhruvanta Systems OV/EV Windows code-signing certificate so Windows
shows Dhruvanta Systems instead of `Unknown publisher`. See
`docs/code-signing.md`.

For internal testing before the OV/EV certificate is available, the
release can be signed with the host-local Dhruvanta self-signed
certificate. In that mode, upload the generated public cert,
fingerprint, `RELEASE-INTEGRITY.txt`, and `SHA256SUMS.txt` beside the
installer so the operator can manually verify the Authenticode signer.

The release build now also verifies that the operator docs and runtime files are present in the assembled bundle.

Each bundle contains only the operator-facing runtime assets:

- prebuilt `dist/`
- production-only `node_modules/`
- bundled Windows Node runtime under `runtime/node-win-x64/`
- Dhruvanta-branded icon assets for setup, shortcuts, and tray
- `config/agent.env.example`
- Windows install/start helpers
- operator docs

## Windows Operator Quick Start

On the shop PC, use the release bundle rather than the full source repo:

1. Prefer `printanywhere-agent-v<version>-setup.exe`.
2. Run the setup executable. It installs into your Windows user profile, creates Desktop and Start Menu shortcuts, registers hidden startup at sign-in, and can start the tray icon immediately.
3. If you use the zip instead, extract `printanywhere-agent-v<version>.zip` and run `install-agent.cmd` once.
4. If you want the agent to start automatically at sign-in, run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\install-release.ps1 -RegisterStartupTask -CreateShortcuts -StartTray
   ```

5. Review `config\agent.env` if you want to change the local UI port, data directory, or simulation mode.
6. Start the agent with the Desktop shortcut, Start Menu shortcut, tray menu, or `start-agent.cmd`. These start the runtime hidden instead of keeping a terminal window on top.
7. Open `https://local.printanywhere.dhruvantasystems.com:43100` (the loopback fallback `https://127.0.0.1:43100` also works).
8. The production backend URL is prefilled as `https://api.dhruvantasystems.net/printanywhere`; change it only for local testing or support-directed override.
9. Click `Save and register`; allow the browser location prompt when the machine can share device location for admin verification.
10. Give the pairing code to the PrintAnywhere admin.
11. Wait for the admin to verify the business, set the official fallback location, and approve the machine.
12. After approval, publish customer-facing platform printers from the local Agent UI.
13. Use the Host location panel later if the location needs to be refreshed. Published printers report the latest device location first and fall back to the admin-approved coordinates when capture is unavailable.

The production backend URL is prefilled in the local UI. `PRINTANYWHERE_AGENT_DEFAULT_BACKEND_URL` is available only for local testing or support-directed override.

Production backend URL:

- `https://api.dhruvantasystems.net/printanywhere`

## Development From Source

Development:

```bash
npm install
npm run dev
```

Production-style local run:

```bash
npm install
npm run build
npm start
```

Source-repo Windows setup:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-windows.ps1
```

Default local UI:

- `https://local.printanywhere.dhruvantasystems.com:43100`
- Loopback fallback: `https://127.0.0.1:43100`

## Local UI Address (KAN-165)

The local console is served over HTTPS at
`https://local.printanywhere.dhruvantasystems.com:<port>` for a professional,
genuine-looking address. The mechanics:

- **Per-host certificate.** Every install generates its **own** self-signed
  TLS certificate + private key (no shared key — this repo is public, so no key
  is ever committed). The key + cert live in the agent data directory under
  `tls\`. The installer trusts the certificate in the Windows machine `Root`
  store so the browser shows no warning.
- **Name resolution.** The installer adds a hosts-file entry
  `127.0.0.1 local.printanywhere.dhruvantasystems.com`. The domain therefore
  always resolves to loopback — the UI never leaves the machine.
- **Loopback fallback.** The certificate also covers `127.0.0.1` and
  `localhost`, so `https://127.0.0.1:<port>` keeps working as a fallback.
- **Launcher config.** A small, user-editable file `ui-launcher.json` lives in
  the agent data directory:

  ```json
  {
    "uiHost": "domain",
    "port": 43100
  }
  ```

  Set `"uiHost"` to `"localhost"` (with support's help) if the domain address
  has trouble on a particular network — the launcher will then open
  `https://127.0.0.1:<port>` instead. The file carries a comment header
  explaining each field. If port `43100` is occupied the agent automatically
  picks the next free port and the launcher reads the actual port from
  `ui-runtime.json`.

## Runtime Model

Windows:

- printer discovery uses PowerShell
- printing uses `pdf-to-printer`

Non-Windows development:

- printer discovery falls back to mock printers
- print execution simulates success by default

Important implementation note:

- Decrypted PDFs are written to a short-lived temp file inside the configured data directory and deleted immediately after printing.
- That is the pragmatic JavaScript path for Windows printing today.
- If exact in-memory spool delivery is required later, that should move to a native Windows bridge.

## Local Configuration

Sample env file:

- `config/agent.env.example`

Supported runtime variables:

- `PRINTANYWHERE_AGENT_PORT`
  - local UI port
  - default: `43100`
- `PRINTANYWHERE_AGENT_DATA_DIR`
  - local state directory
  - default: `./data`
- `PRINTANYWHERE_AGENT_SIMULATE_PRINT`
  - force simulated print completion
  - default: `false` on Windows, `true` on non-Windows

## Background, Tray, And Updates

Release installs use a stable data directory:

- `%LOCALAPPDATA%\Dhruvanta Systems\PrintAnywhereAgent\data`

The versioned program folder can change during updates, but pairing state, backend URL, printer sharing choices, and local health data stay in that stable data folder.

The Windows installer hardens the managed `%LOCALAPPDATA%\Dhruvanta Systems\PrintAnywhereAgent` install, config, and data paths with NTFS ACLs. Only the signed-in Windows user running the agent, `SYSTEM`, and local Administrators keep full access. The installer stops older agent/tray processes, points startup tasks and shortcuts at the refreshed bundle, and prunes older managed program folders while preserving the stable `data` folder. The hidden background launcher also replaces a stale older PrintAnywhere runtime if that old runtime still owns the local UI port after an update. The tray controller enforces one tray icon per Windows user and closes older managed tray controllers during startup. The agent stays per-user instead of using a separate service account because Windows printer discovery and user-session printers are usually only reliable in the signed-in user's session.

The installer creates Dhruvanta-branded shortcuts for opening the local UI, starting the tray controller, stopping the background agent, checking for updates, installing the latest update, and uninstalling the agent. The update shortcuts open a progress window that shows checking, download percentage, checksum verification, agent stop, and installer status. The uninstall shortcut asks whether to keep or remove local data.

The tray menu can open the UI, refresh printer discovery, restart/stop the agent, check for updates, and install the latest GitHub release setup executable. `Check for Updates` offers a `Download and install` button in the same window when a newer release exists, and offers `Reinstall latest` when the installed version is already current and support asks the owner to repair the install. Update setup installs the refreshed bundle without launching long-running children; the updater starts the refreshed scheduled tasks after setup exits so the progress window can close cleanly. Uninstall is intentionally kept in the Start Menu, not the tray, so it is not clicked accidentally.

## Security Model

The agent stores:

- a generated RSA identity
- an encrypted private key
- an encrypted agent secret issued by the backend
- local printer sharing state

The backend queues print jobs as encrypted packets. The agent decrypts them locally and never needs raw backend database access or printer credentials from other integrations.

Release installs also restrict the local install/config/data folders to the current Windows user, `SYSTEM`, and local Administrators. This prevents other Windows users on the same PC from reading the encrypted private key file or modifying the agent program files. It does not protect against malware already running as the same Windows user, so Windows account hygiene, code-signed updates, and backend rate limits remain part of the production security model.

## Docs

- [docs/download-and-verify.md](./docs/download-and-verify.md) where to download and how to verify the checksum + Authenticode signature before installing
- [docs/windows-setup.md](./docs/windows-setup.md) operator setup and pairing guide
- [docs/operator-approval-and-recovery.md](./docs/operator-approval-and-recovery.md) approval-first onboarding, ownership boundaries, soft disable, and recovery flows
- [docs/release-build.md](./docs/release-build.md) release bundle build process and artifact layout
- [docs/code-signing.md](./docs/code-signing.md) how releases are code-signed, timestamped, and verified in CI
- [SECURITY.md](./SECURITY.md) release-integrity guarantees and how to report a vulnerability

## Backend Contract

This repo targets the backend Print Agent API exposed by the main `PrintAnywhere` backend:

- `POST /api/agent/register`
- `POST /api/agent/printers`
- `GET /api/agent/jobs/poll`
- `GET /api/agent/jobs/{jobId}/download`
- `PUT /api/agent/jobs/{jobId}/status`
- `POST /api/agent/heartbeat`
- `POST /api/agent/repair`

## Key Files

- `src/index.ts` bootstrap entry
- `src/runtime/agentRuntime.ts` background runtime and polling loop
- `src/cloud/api.ts` backend API client
- `src/platform/printers.ts` local printer discovery and print execution
- `src/ui/server.ts` local operator UI
- `scripts/agent-tray.ps1` Windows tray controller
- `scripts/check-update.ps1` GitHub release updater
- `scripts/build-release.mjs` release artifact assembler
- `scripts/build-windows-installer.mjs` Windows setup executable builder
- `scripts/install-release.ps1` Windows install helper for prebuilt bundles
- `scripts/bootstrap-windows.ps1` Windows setup helper for source checkouts
- `scripts/run-agent.ps1` production-style launcher with optional env-file support

---

## ⚠️ HUMAN REVIEW REQUIRED

The following items were reviewed by an AI agent audit pass:

### Security Audit Result
- **No issues found.** The agent's crypto (AES-256-GCM, RSA-OAEP), loopback-only UI binding, HTML escaping, Zod input validation, and secret management were all verified as sound.
- **No code changes were made** to this repository during the audit.

### Operator Reminder
- The agent stores encrypted secrets in `data/agent-state.json`. Ensure this directory has appropriate filesystem permissions (owner-only read/write) on production Windows machines.
- The `PRINTANYWHERE_AGENT_SIMULATE_PRINT` env var defaults to `false` on Windows. Verify it is not accidentally set to `true` in production.
