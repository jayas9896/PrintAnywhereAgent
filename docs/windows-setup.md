# Windows Setup

This guide is for a print-shop owner machine that already has Windows printers installed.

## What this agent does

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

## One-time setup

From the `PrintAnywhereAgent` repo root in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-windows.ps1
```

If you want the agent to start automatically when the user signs in:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-windows.ps1 -RegisterStartupTask
```

That script:

- checks that Node.js is installed
- installs npm dependencies
- builds the agent
- creates the local data directory
- optionally registers a Windows Scheduled Task

## Running the agent

Manual start:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-agent.ps1
```

Default local UI:

- `http://127.0.0.1:43100`

## Agent pairing steps

1. Open the local UI.
2. Enter the PrintAnywhere server URL.
3. Optionally set a display name for the machine.
4. Click `Save and register`.
5. Copy the pairing code shown in the UI.
6. In the PrintAnywhere admin portal, create a printer with routing mode `Print Agent`.
7. Enter the pairing code and choose the reported Windows printer.

Once the admin saves the printer pairing, the agent becomes active and starts polling for jobs.

## Local data and security

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
