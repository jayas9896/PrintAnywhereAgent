# Security Policy

PrintAnywhere Agent runs on print-shop owners' Windows machines and talks to the
PrintAnywhere backend, so we take its integrity seriously. This document explains
how releases are protected and how to report a vulnerability.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's **private vulnerability reporting**:

1. Go to the repository's **Security** tab → **Report a vulnerability**.
2. Describe the issue, affected version (see the installer's `About`/version), and
   reproduction steps.

We aim to acknowledge a report within 3 business days and to keep you updated as we
investigate and ship a fix. Please give us reasonable time to remediate before any
public disclosure.

## Supported versions

The latest published release receives security fixes. Because the agent ships an
auto-updater, keeping it on the latest version is the supported configuration.

## Release integrity — what we guarantee

Every published Windows release is:

- **Authenticode code-signed** — `setup.exe`, the inner native tray EXE
  (`PrintAnywhereAgent.exe`), and the MSI are all signed by the Dhruvanta Systems
  code-signing certificate. Windows shows the verified publisher rather than
  `Unknown publisher`.
- **RFC3161 timestamped** — so the signatures stay valid after the certificate
  expires.
- **Self-verified in CI** — the release pipeline asserts a valid signature **and**
  a timestamp on each binary and **blocks the release** if any check fails. An
  unsigned release cannot be published.
- **Checksummed** — `SHA256SUMS.txt` is published alongside the installers and is
  computed against the *signed* bytes.

See [`docs/download-and-verify.md`](docs/download-and-verify.md) for the exact
commands to verify a download yourself, and [`docs/code-signing.md`](docs/code-signing.md)
for how signing works in the pipeline.
