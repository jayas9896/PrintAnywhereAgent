# AGENTS.md — PrintAnywhere Agent

## Central Agentic Rules

Read first:

- `/home/jayas/dhruvanta-platform-governance/agentic/steering/README.md`
- `/home/jayas/dhruvanta-platform-governance/agentic/skills/README.md`
- `/home/jayas/dhruvanta-platform-governance/agentic/repos/printanywhere-agent.md`
- `/home/jayas/dhruvanta-platform-governance/docs/standards/dhruvanta-production-readiness.md`

This local `AGENTS.md` may only add repo-local details or stricter rules.

## Project Overview

Windows-first printer bridge for PrintAnywhere. Handed to print-shop owners as a prebuilt local agent that exposes their Windows printers to the PrintAnywhere cloud backend. Polls for encrypted print jobs, decrypts locally, prints, and reports status.

## Repository Structure

```
src/
├── index.ts              # Bootstrap entry — starts runtime + UI server, handles SIGINT/SIGTERM
├── cloud/
│   └── api.ts            # Backend API client with Zod schema validation on all responses
├── config/
│   ├── store.ts          # AgentStore — JSON file persistence for agent state
│   └── types.ts          # All TypeScript types (agent state, printers, jobs, platform printers)
├── core/
│   ├── crypto.ts         # RSA-2048 key generation, AES-256-GCM encrypt/decrypt, RSA-OAEP unwrap
│   └── machine.ts        # Hardware fingerprint (Windows/Unix), machine key derivation, data dir
├── platform/
│   └── printers.ts       # Local printer discovery (PowerShell on Windows, mock on others)
├── runtime/
│   └── agentRuntime.ts   # Background runtime: registration, polling, job processing, heartbeat
└── ui/
    └── server.ts         # Express 5 local operator UI (HTML forms, loopback-only, CSRF via token)
```

## Key Technical Decisions

- **Crypto**: RSA-2048 identity keypair generated on first run. AES-256-GCM for secrets at rest. RSA-OAEP for job key unwrapping. Machine key derived from hardware fingerprint via SHA-256.
- **Security**: UI binds to `127.0.0.1` only. Loopback origin check on all POST requests. HTML escaping on all rendered values. UI token verification on all mutations.
- **State**: JSON file at `data/agent-state.json`. Encrypted private key and agent secret stored with machine-derived AES key.
- **Printing**: `pdf-to-printer` on Windows. Decrypted PDF written to temp file, deleted immediately after print.
- **Validation**: Zod schemas on all backend API responses. `parseRequiredText`/`parseRequiredNumber` on all form inputs.
- **Platform printers**: Self-service publishing — approved shop owners can create/update/remove customer-facing platform printers from the local UI.

## Backend API Contract

| Endpoint | Purpose |
|----------|---------|
| `POST /api/agent/register` | Register agent with machine ID + RSA public key |
| `POST /api/agent/printers` | Report local printer inventory |
| `GET /api/agent/jobs/poll` | Long-poll for print jobs (30s timeout) |
| `GET /api/agent/jobs/{id}/download` | Download encrypted PDF (signed URL) |
| `PUT /api/agent/jobs/{id}/status` | Report job status (DOWNLOADING → PRINTING → COMPLETED/FAILED) |
| `POST /api/agent/heartbeat` | 60-second heartbeat with system metrics |
| `POST /api/agent/repair` | Generate new pairing code |
| `GET /api/agent/profile` | Fetch agent profile + approval status |
| `GET/POST/PUT/DELETE /api/agent/platform-printers` | Manage customer-facing platform printers |

## Security Audit Result (2026-04-22)

- **No issues found.** Crypto, loopback binding, HTML escaping, Zod validation, and secret management all verified as sound.
- **No code changes were made** to this repository during the audit.

## Running

```bash
npm install
npm run dev              # Development with tsx hot reload
npm run build && npm start  # Production-style local run
npm run release:build    # Build distributable release bundle
```

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `PRINTANYWHERE_AGENT_PORT` | `43100` | Local UI port |
| `PRINTANYWHERE_AGENT_DATA_DIR` | `./data` | State directory |
| `PRINTANYWHERE_AGENT_SIMULATE_PRINT` | `false` (Windows) / `true` (other) | Simulate print completion |

## Documentation

- [docs/windows-setup.md](docs/windows-setup.md) — Operator setup and pairing
- [docs/operator-approval-and-recovery.md](docs/operator-approval-and-recovery.md) — Approval flows, soft disable, recovery
- [docs/release-build.md](docs/release-build.md) — Release bundle build process

## Platform Standards Reference

Before changing code, deployment, monitoring, audit logging, or security behavior, apply the shared Dhruvanta standards in `/home/jayas/dhruvanta-platform-governance/docs/standards/README.md`.

Use the specific standards for the work type:
- Frontend: `/home/jayas/dhruvanta-platform-governance/docs/standards/frontend-react.md`
- Java/Spring backend: `/home/jayas/dhruvanta-platform-governance/docs/standards/backend-java-spring.md`
- Node/TypeScript backend: `/home/jayas/dhruvanta-platform-governance/docs/standards/backend-node-typescript.md`
- Ruby/Rails backend: `/home/jayas/dhruvanta-platform-governance/docs/standards/backend-ruby-rails.md`
- Deployment, scaling, and zero downtime: `/home/jayas/dhruvanta-platform-governance/docs/standards/deployment-zero-downtime.md`
- Monitoring and alerting: `/home/jayas/dhruvanta-platform-governance/docs/standards/monitoring-alerting.md`
- Audit logging: `/home/jayas/dhruvanta-platform-governance/docs/standards/audit-logging.md`
- Security and configuration: `/home/jayas/dhruvanta-platform-governance/docs/standards/security.md` and `/home/jayas/dhruvanta-platform-governance/docs/standards/configuration.md`

Frontend Vercel linking and recommended subdomains are documented in `/home/jayas/dhruvanta-platform-governance/docs/deployment/vercel-frontend-linking.md`.

Repo-local rules in this file remain authoritative when they are stricter than the shared standards.
