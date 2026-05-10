# Windows Setup

This guide is for a print-shop owner machine that already has Windows printers installed.

## What This Agent Does

The agent runs on the Windows PC connected to the shop printers. It:

- discovers local printers
- registers with the PrintAnywhere backend
- shows a pairing code to the platform admin
- receives encrypted print jobs
- decrypts them locally
- prints them and reports status back
- lets the approved shop owner publish and manage customer-facing platform printers from the local UI

## Prerequisites

Install these on the Windows machine first:

1. The local Windows printer drivers you want to share
2. Network access to the Dhruvanta PrintAnywhere backend

The `.exe` installer and current release bundle include a Windows Node runtime. A system Node.js install is only needed for source-checkout development.

## Preferred Install: Release Bundle

If someone handed you `printanywhere-agent-v<version>-setup.exe`, run that installer first. It extracts the release bundle into your per-user local app data folder, stops any older PrintAnywhere Agent listener and tray controller for this Windows user, runs the bundle installer, creates Dhruvanta-branded shortcuts, registers hidden startup at Windows sign-in, starts one refreshed tray controller, and can open the local agent UI when it finishes.

For public customer installs, the Windows security prompt should show
Dhruvanta Systems as the verified publisher. If it shows `Unknown
publisher`, the setup executable was not Authenticode-signed with the
Dhruvanta Systems code-signing certificate and should be treated as a
test build.

During internal testing, Dhruvanta may publish a self-signed build. In
that case, download `SHA256SUMS.txt`,
`dhruvanta-systems-codesign-fingerprint.txt`, and
`dhruvanta-systems-codesign-public.cer` from the same release, verify
the setup executable hash, and compare the Authenticode signer
thumbprint with the published fingerprint.

If someone handed you a prebuilt `PrintAnywhereAgent` zip release bundle instead, use that folder instead of the source repo.

One-time setup from PowerShell inside the extracted bundle:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-release.ps1
```

If you want the agent to start automatically when the Windows user signs in:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-release.ps1 -RegisterStartupTask -CreateShortcuts -StartTray
```

That installer:

- checks that the bundled Windows Node runtime or system Node.js is available
- verifies the prebuilt runtime files are present
- stops any older PrintAnywhere Agent listener on the local UI port and closes older tray controllers
- creates the local data directory
- copies `config\agent.env` from the example file if needed
- optionally registers a Windows Scheduled Task
- optionally creates Desktop and Start Menu shortcuts
- optionally starts the tray controller

Then start the agent:

```powershell
powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File .\scripts\start-agent-background.ps1 -OpenUi
```

The release bundle also includes `install-agent.cmd`, `start-agent.cmd`, `agent-tray.cmd`, `update-agent.cmd`, and `run-agent-console.cmd` wrappers. Use `run-agent-console.cmd` only for diagnostics when support asks for visible logs.

## Alternative: Run From Source Repo

If you are working directly from the git checkout instead of a release bundle:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-windows.ps1
```

If you want the source checkout to start automatically at Windows sign-in:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-windows.ps1 -RegisterStartupTask
```

That script:

- checks that Node.js is installed
- installs npm dependencies with the lockfile
- builds the agent
- creates the local data directory
- optionally registers a Windows Scheduled Task

## Local Configuration

Default local UI:

- `http://127.0.0.1:43100`

Optional local overrides live in:

- `config\agent.env`

Supported settings:

- `PRINTANYWHERE_AGENT_PORT`
- `PRINTANYWHERE_AGENT_DATA_DIR`
- `PRINTANYWHERE_AGENT_SIMULATE_PRINT`
- `PRINTANYWHERE_AGENT_DEFAULT_BACKEND_URL`

The production backend URL is prefilled as `https://api.dhruvantasystems.net/printanywhere`.
Use `PRINTANYWHERE_AGENT_DEFAULT_BACKEND_URL` only for local testing or a support-directed override.

Production backend URL:

- `https://api.dhruvantasystems.net/printanywhere`

Release installs keep runtime state in a stable folder across updates:

- `%LOCALAPPDATA%\Dhruvanta Systems\PrintAnywhereAgent\data`

The program folder is versioned, but pairing state, backend URL, printer sharing choices, and local health history stay in that stable data folder.

The installer locks the managed install, config, and data folders with Windows NTFS ACLs. Access is limited to the signed-in Windows user running the agent, `SYSTEM`, and local Administrators. A separate Windows service account is not used by default because many printers are only visible in the interactive user session.

## Registration, approval, and first publish

1. Start the agent.
2. Open the local UI.
3. Keep the prefilled production backend URL unless support tells you otherwise.
4. Optionally set a display name for the machine.
5. Click `Save and register`.
6. Copy the pairing code shown in the UI.
7. Share the pairing code with the PrintAnywhere admin.
8. Wait for the admin to verify the business manually, set the official business name and fallback location, and approve the machine.
9. Once the local UI shows the machine is approved, mark the Windows printers you want as shared.
10. In the `Published platform printers` section, publish one or more customer-facing platform printers backed by those shared Windows printers.
11. Use the local UI Host location panel when Windows or the browser can provide device location. The backend uses that location first and falls back to the admin-approved coordinates when unavailable.

Admin-side direct pairing in the main admin portal still exists as a break-glass or migration path, but it is not the normal owner onboarding flow anymore.

## Local Data And Security

Default data directory:

- `.\data`

The agent stores:

- generated machine identity
- encrypted private key
- encrypted agent secret
- registered backend URL
- local printer share state

Print packets are downloaded encrypted. The current implementation writes the decrypted PDF to a short-lived temp file only for the local print handoff, then removes it immediately after printing.

## Troubleshooting

### The UI opens but no printers are listed

- Confirm the Windows printer is installed and visible in normal Windows print dialogs.
- Use the tray menu or local UI to refresh printers.
- Run `run-agent-console.cmd` only when support needs visible logs.

### A terminal window is visible

- Close the visible terminal window.
- Start the agent again from the Desktop shortcut, Start Menu shortcut, or tray menu. Those use the hidden background launcher.
- New installs and updates register hidden startup at Windows sign-in.

### How do I update the agent?

- Use the tray icon and choose `Check for Updates` or `Install Latest Update`.
- Or use the Start Menu shortcuts under `Dhruvanta Systems`.
- `Check for Updates` opens a Dhruvanta update window. If a newer release exists, click `Download and install` in that window.
- `Install Latest Update` opens the same window and starts the download/install flow immediately.
- The window shows each step: checking GitHub, downloading the setup executable with progress, downloading checksums, verifying SHA-256, stopping the background agent and old tray controller, and running setup.
- The updater waits only for the setup executable to exit, not for the new background agent or tray processes it launches.
- Quiet update setup starts the refreshed background agent and tray through the registered Windows Scheduled Tasks, so older updater windows do not keep waiting on long-running child processes.
- If the installed version is already current, `Check for Updates` shows a `Reinstall latest` option for support-directed repair installs.

### How do I uninstall the agent?

- Use Start Menu > `Dhruvanta Systems` > `Uninstall PrintAnywhere Agent`.
- The uninstall dialog asks whether to keep local data or remove it too.
- Keeping data preserves pairing state, backend URL, printer sharing choices, and local health history for reinstall.
- Removing all data deletes those local settings as well as the program files.

### Pairing code is rejected

- Pairing codes are one-time and expire.
- Use `Generate new pairing code` in the local UI and retry.
- Ask the platform admin to use the new code and continue the approval flow.

### Jobs stay queued

- Confirm the agent is still running.
- Confirm the machine is still approved in the local UI.
- Confirm the paired printer is still shared in the local UI.
- Confirm the published platform printer is still enabled in the local UI.
- Confirm the backend can reach `/api/agent/*` routes.

### Printing works in simulation but not on Windows

- Set `PRINTANYWHERE_AGENT_SIMULATE_PRINT=false`.
- Confirm the local Windows printer accepts direct PDF printing through the installed driver.
- If needed, test with the exact printer name shown in the local UI.

## Related docs

- [operator-approval-and-recovery.md](./operator-approval-and-recovery.md)
- [release-build.md](./release-build.md)
