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

The release build now also verifies that the operator docs and runtime files are present in the assembled bundle.

Each bundle contains only the operator-facing runtime assets:

- prebuilt `dist/`
- production-only `node_modules/`
- `config/agent.env.example`
- Windows install/start helpers
- operator docs

## Windows Operator Quick Start

On the shop PC, use the release bundle rather than the full source repo:

1. Extract `printanywhere-agent-v<version>`.
2. Run `install-agent.cmd` once.
3. If you want the agent to start automatically at sign-in, run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\install-release.ps1 -RegisterStartupTask
   ```

4. Review `config\agent.env` if you want to change the local UI port, data directory, or simulation mode.
5. Start the agent with `start-agent.cmd`.
6. Open `http://127.0.0.1:43100`.
7. Enter the PrintAnywhere backend URL and save the registration.
8. Give the pairing code to the PrintAnywhere admin.
9. Wait for the admin to verify the business, set the official location, and approve the machine.
10. After approval, publish customer-facing platform printers from the local Agent UI.

The backend URL and display name are configured in the local UI, not in the env file.

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

- `http://127.0.0.1:43100`

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

## Security Model

The agent stores:

- a generated RSA identity
- an encrypted private key
- an encrypted agent secret issued by the backend
- local printer sharing state

The backend queues print jobs as encrypted packets. The agent decrypts them locally and never needs raw backend database access or printer credentials from other integrations.

## Docs

- [docs/windows-setup.md](./docs/windows-setup.md) operator setup and pairing guide
- [docs/operator-approval-and-recovery.md](./docs/operator-approval-and-recovery.md) approval-first onboarding, ownership boundaries, soft disable, and recovery flows
- [docs/release-build.md](./docs/release-build.md) release bundle build process and artifact layout

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
- `scripts/build-release.mjs` release artifact assembler
- `scripts/install-release.ps1` Windows install helper for prebuilt bundles
- `scripts/bootstrap-windows.ps1` Windows setup helper for source checkouts
- `scripts/run-agent.ps1` production-style launcher with optional env-file support
