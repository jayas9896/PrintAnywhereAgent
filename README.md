# PrintAnywhereAgent

`PrintAnywhereAgent` is the separate Windows-first printer bridge for PrintAnywhere. It is intended to be distributed to public print-shop owners who want to expose their local printers to the PrintAnywhere backend without running the backend on the same Windows machine.

The agent:

- registers itself with the PrintAnywhere backend
- discovers local Windows printers
- exposes a one-time pairing code to the platform admin
- polls the backend for queued jobs
- downloads encrypted print packets
- decrypts them locally
- prints them and reports status back

## Runtime model

Windows:

- printer discovery uses PowerShell
- printing uses `pdf-to-printer`

Non-Windows development:

- printer discovery falls back to mock printers
- print execution simulates success by default

Important implementation note:

- Decrypted PDFs are written to a short-lived temp file and deleted immediately after printing.
- That is the pragmatic JavaScript path for Windows printing today.
- If exact in-memory spool delivery is required later, that should move to a native Windows bridge.

## Quick start

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

Default local UI:

- `http://127.0.0.1:43100`

## Windows operator setup

For real Windows shop machines, use the provided PowerShell bootstrap:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-windows.ps1
```

To also register the agent to start automatically at Windows sign-in:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-windows.ps1 -RegisterStartupTask
```

Then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-agent.ps1
```

Detailed operator guide:

- [docs/windows-setup.md](./docs/windows-setup.md)

## Pairing flow

1. Open the local UI.
2. Enter the PrintAnywhere server URL.
3. Optionally set a display name for the machine.
4. Click `Save and register`.
5. Copy the pairing code.
6. Give the pairing code to the PrintAnywhere admin.
7. The admin creates a `Print Agent` printer and chooses one of the printers reported by this agent.

After pairing, the agent becomes active and starts polling for work.

## Environment variables

- `PRINTANYWHERE_AGENT_PORT`
  - local UI port
  - default: `43100`
- `PRINTANYWHERE_AGENT_DATA_DIR`
  - local state directory
  - default: `./data`
- `PRINTANYWHERE_AGENT_SIMULATE_PRINT`
  - force simulated print completion
  - default: `true` on non-Windows, `false` on Windows

## Security model

The agent stores:

- a generated RSA identity
- an encrypted private key
- an encrypted agent secret issued by the backend
- local printer sharing state

The backend queues print jobs as encrypted packets. The agent decrypts them locally and never needs raw backend database access or printer credentials from other integrations.

## Backend contract

This repo targets the backend Print Agent API exposed by the main `PrintAnywhere` backend:

- `POST /api/agent/register`
- `POST /api/agent/printers`
- `GET /api/agent/jobs/poll`
- `GET /api/agent/jobs/{jobId}/download`
- `PUT /api/agent/jobs/{jobId}/status`
- `POST /api/agent/heartbeat`
- `POST /api/agent/repair`

## Key files

- `src/index.ts` bootstrap entry
- `src/runtime/agentRuntime.ts` background runtime and polling loop
- `src/cloud/api.ts` backend API client
- `src/platform/printers.ts` local printer discovery and print execution
- `src/ui/server.ts` local operator UI
- `scripts/discover-printers.ps1` Windows printer discovery script
- `scripts/bootstrap-windows.ps1` Windows setup helper
- `scripts/run-agent.ps1` production-style local launcher
