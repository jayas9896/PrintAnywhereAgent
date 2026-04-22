# Release Build

This repo now ships with a release assembly step intended for public distribution to print-shop owners.

## Command

```bash
npm ci
npm run release:build
```

The release script runs the existing TypeScript build first, then assembles a clean artifact in `artifacts/`.

## Output

Expected output:

```text
artifacts/
├── SHA256SUMS.txt
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
│   ├── scripts/
│   │   ├── install-release.ps1
│   │   └── run-agent.ps1
│   └── start-agent.cmd
└── printanywhere-agent-v<version>.tar.gz
```

## What Goes Into The Bundle

The bundle intentionally excludes the development-only parts of the repo and keeps only what an operator needs:

- prebuilt runtime files from `dist/`
- production dependencies from `npm ci --omit=dev`
- operator docs
- sample env file
- install/start helpers
- a small release manifest for auditing the artifact contents

## Handoff Notes

When sharing the agent with a print-shop owner:

1. Prefer the versioned folder or the generated `.tar.gz`, not the full git checkout.
2. Point them to `README.md` and `docs/windows-setup.md`.
3. Ask them to run `install-agent.cmd` once, then `start-agent.cmd`.
4. If they need auto-start at sign-in, use `scripts/install-release.ps1 -RegisterStartupTask`.

## Validation

At minimum, validate:

```bash
npm run build
npm run release:build
```

If you are testing on Windows, also run the generated bundle with `scripts/run-agent.ps1` and confirm the local UI opens and real printers are listed.
