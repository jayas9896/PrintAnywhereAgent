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
│   ├── agent-tray.cmd
│   ├── assets/
│   │   └── dhruvanta-agent.ico
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
│   │   ├── agent-tray.ps1
│   │   ├── check-update.ps1
│   │   ├── install-release.ps1
│   │   ├── restart-agent.ps1
│   │   ├── run-agent.ps1
│   │   ├── start-agent-background.ps1
│   │   └── stop-agent.ps1
│   └── start-agent.cmd
│   └── update-agent.cmd
└── printanywhere-agent-v<version>.tar.gz
└── printanywhere-agent-v<version>.zip
```

## What Goes Into The Bundle

The bundle intentionally excludes the development-only parts of the repo and keeps only what an operator needs:

- prebuilt runtime files from `dist/`
- production dependencies from `npm ci --omit=dev`
- bundled Windows Node runtime from the official Node.js distribution
- Dhruvanta icon assets for setup, shortcuts, and tray
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
5. If they need auto-start at sign-in from a zip bundle, use `scripts/install-release.ps1 -RegisterStartupTask -CreateShortcuts -StartTray`.

The setup executable installs hidden startup and Dhruvanta-branded shortcuts by default. Runtime state lives in `%LOCALAPPDATA%\Dhruvanta Systems\PrintAnywhereAgent\data` so versioned program-folder updates preserve pairing, backend URL, printer sharing, and health history. The Start Menu also includes one uninstall shortcut that asks whether to keep or remove local data.

During install, `scripts/install-release.ps1` hardens the managed `%LOCALAPPDATA%\Dhruvanta Systems\PrintAnywhereAgent` install root, versioned program folder, `config`, and `data` folders with NTFS ACLs. Only the signed-in Windows user, `SYSTEM`, and local Administrators keep full access. The default remains a per-user hidden background task so Windows printer discovery runs in the same user session as the shop owner.

## Release Integrity

The updater downloads `SHA256SUMS.txt` from the same GitHub release and verifies
the setup executable's SHA-256 before running it. A missing checksum file,
missing setup-exe entry, or checksum mismatch fails closed and leaves the
existing local install untouched.

This checksum protects against corrupt or swapped release downloads, but it is
not a replacement for Windows Authenticode signing. Public end-user releases
should be signed with an OV/EV code-signing certificate before broader
distribution so Windows can validate publisher identity and SmartScreen can
build reputation. A self-signed certificate is acceptable only for internal lab
testing because customer machines will not trust it by default.

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
- Dhruvanta icon assets
- prebuilt runtime files and launch scripts
