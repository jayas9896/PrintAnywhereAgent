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

## Agent Pairing Steps

1. Start the agent.
2. Open the local UI.
3. Enter the PrintAnywhere server URL.
4. Optionally set a display name for the machine.
5. Click `Save and register`.
6. Copy the pairing code shown in the UI.
7. In the PrintAnywhere admin portal, create a printer with routing mode `Print Agent`.
8. Enter the pairing code and choose the reported Windows printer.

Once the admin saves the printer pairing, the agent becomes active and starts polling for jobs.

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

### Jobs stay queued

- Confirm the agent is still running.
- Confirm the paired printer is still shared in the local UI.
- Confirm the backend can reach `/api/agent/*` routes.

### Printing works in simulation but not on Windows

- Set `PRINTANYWHERE_AGENT_SIMULATE_PRINT=false`.
- Confirm the local Windows printer accepts direct PDF printing through the installed driver.
- If needed, test with the exact printer name shown in the local UI.
