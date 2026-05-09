# Release Build

This repo now ships with a release assembly step intended for public distribution to print-shop owners.

## Command

```bash
npm ci
npm run release:build
npm run release:windows-installer
```

The release script runs the existing TypeScript build first, then assembles a clean artifact in `artifacts/`.
The Windows installer script wraps that bundle in a self-extracting setup executable for non-technical shop owners.

## Output

Expected output:

```text
artifacts/
├── SHA256SUMS.txt
├── printanywhere-agent-v<version>-setup.exe
├── printanywhere-agent-v<version>/
│   ├── README.md
│   ├── config/
│   │   └── agent.env.example
│   ├── dist/
│   ├── docs/
│   ├── install-agent.cmd
│   ├── node_modules/
│   ├── package-lock.json
│   ├── package.json
│   ├── release-manifest.json
│   ├── runtime/
│   │   └── node-win-x64/
│   ├── scripts/
│   │   ├── install-release.ps1
│   │   └── run-agent.ps1
│   └── start-agent.cmd
└── printanywhere-agent-v<version>.tar.gz
└── printanywhere-agent-v<version>.zip
```

## What Goes Into The Bundle

The bundle intentionally excludes the development-only parts of the repo and keeps only what an operator needs:

- prebuilt runtime files from `dist/`
- production dependencies from `npm ci --omit=dev`
- bundled Windows Node runtime from the official Node.js distribution
- operator docs
- sample env file
- install/start helpers
- a small release manifest for auditing the artifact contents

## Handoff Notes

When sharing the agent with a print-shop owner:

1. Prefer `printanywhere-agent-v<version>-setup.exe` for non-technical Windows users.
2. Use the generated `.zip` only when the operator wants to inspect the bundle before install.
3. Point them to `README.md` and `docs/windows-setup.md`.
4. If they use the zip, ask them to run `install-agent.cmd` once, then `start-agent.cmd`.
5. If they need auto-start at sign-in, use `scripts/install-release.ps1 -RegisterStartupTask`.

## Validation

At minimum, validate:

```bash
npm run build
npm run release:build
npm run release:windows-installer
npm run release:verify
```

If you are testing on Windows, also run the generated bundle with `scripts/run-agent.ps1` and confirm the local UI opens and real printers are listed.

## Operator-facing docs that must ship in the bundle

The release bundle is expected to include the approval-first operator guidance, not just the runtime files. The verification script checks for:

- `README.md`
- `docs/windows-setup.md`
- `docs/operator-approval-and-recovery.md`
- `config/agent.env.example`
- bundled Windows Node runtime
- prebuilt runtime files and launch scripts
