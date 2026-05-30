# Code signing

PrintAnywhere Agent Authenticode-signs **every** Windows binary it ships, before
publication:

- `artifacts/printanywhere-agent-v<ver>-setup.exe` — the zip-path installer (`release` job)
- `artifacts/native-shell/PrintAnywhereAgent.exe` — the native tray EXE the user
  actually runs, signed **before** it is harvested into the MSI (`windows-installer` job)
- `PrintAnywhereAgent-<ver>.msi` — the MSI installer (`windows-installer` job)

Signing happens **before** `SHA256SUMS.txt` is finalized and before the artifacts
are uploaded to the GitHub release, so the published checksum always matches the
signed bytes.

Every signed artifact is then **verified in CI** — the workflow asserts a valid
Authenticode signature **and** an RFC3161 timestamp (`Get-AuthenticodeSignature`
on Windows; `osslsigncode verify` for the Linux-built `setup.exe`). RFC3161
timestamping is what preserves trust after the certificate expires, so an
un-timestamped signature is treated as a failure. If any binary fails to verify,
the release is **blocked** (not published).

## eSigner cloud signing (production, CI)

Releases are signed automatically by GitHub Actions using SSL.com's
[eSigner cloud code signing](https://www.ssl.com/how-to/cloud-code-signing-integration-with-github-actions/)
via the official [`sslcom/esigner-codesign`](https://github.com/SSLcom/esigner-codesign)
action (CodeSignTool, `command: sign`). No certificate or private key material
lives in the repo or on the runner — signing is performed in SSL.com's cloud HSM.

### Required GitHub Actions secrets

Add these four repository secrets (Settings → Secrets and variables → Actions).
Values come from your SSL.com account / eSigner enrollment:

| Secret              | Source                                                        |
| ------------------- | ------------------------------------------------------------ |
| `ES_USERNAME`       | SSL.com account username                                     |
| `ES_PASSWORD`       | SSL.com account password                                     |
| `ES_CREDENTIAL_ID`  | eSigner credential ID for the OV code-signing certificate    |
| `ES_TOTP_SECRET`    | eSigner TOTP/automation secret (base32 string from SSL.com)  |

Once all four secrets are present, every tag push matching `v*` produces a fully
signed release. A tagged release is a **trust release**, so signing is mandatory:

- **Secrets present** → setup.exe, the inner native EXE, and the MSI are all
  signed + timestamped; each is verified in CI; `SHA256SUMS.txt` is recomputed to
  reflect the signed `setup.exe`; the release is published.
- **Secrets absent** → the **`Require code-signing secrets` guard fails the
  release immediately** (fail-fast, before the build). An unsigned installer is
  never published. This replaced the previous warn-and-publish-unsigned behavior.

The workflow log emits a `SIGNED + TIMESTAMPED` notice (with the signer + timestamp
authority subjects) for each artifact, or a hard error that blocks the release.

Secret values are never echoed; the eSigner action masks its own inputs and the
summary step only reports the signed/unsigned state.

## Local / lab PFX signing

For local or lab builds where the eSigner cloud path is not available, the
`scripts/sign-windows-installer.mjs` helper signs the `setup.exe` with a PFX
file using `osslsigncode` / `signtool`. Point it at the certificate via the
`PA_SIGN_PFX` environment variable:

```sh
PA_SIGN_PFX=/path/to/codesign.pfx node scripts/sign-windows-installer.mjs
```

The helper re-computes `artifacts/SHA256SUMS.txt` after signing so the local
checksum matches the signed binary, mirroring the CI behavior. This path is for
local/lab use only — production releases are signed by the eSigner CI flow above.
