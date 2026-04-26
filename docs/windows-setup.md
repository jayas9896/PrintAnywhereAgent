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

1. Node.js 20 or newer
   - Download: https://nodejs.org/en/download
2. The local Windows printer drivers you want to share
3. Access to the PrintAnywhere backend URL

## Preferred Install: Release Bundle

If someone handed you a prebuilt `PrintAnywhereAgent` release bundle, use that folder instead of the source repo.

One-time setup from PowerShell inside the extracted bundle:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-release.ps1
```

If you want the agent to start automatically when the Windows user signs in:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-release.ps1 -RegisterStartupTask
```

That installer:

- checks that Node.js is installed
- verifies the prebuilt runtime files are present
- creates the local data directory
- copies `config\agent.env` from the example file if needed
- optionally registers a Windows Scheduled Task

Then start the agent:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-agent.ps1
```

The release bundle also includes `install-agent.cmd` and `start-agent.cmd` wrappers for the same actions.

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

The backend URL and display name are configured later in the local UI after the agent starts.

## Registration, approval, and first publish

1. Start the agent.
2. Open the local UI.
3. Enter the PrintAnywhere server URL.
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
- Run the agent in a console and inspect any PowerShell printer discovery errors.

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
