# Code signing

PrintAnywhere Agent ships two Windows release artifacts that are Authenticode
signed before publication:

- `artifacts/printanywhere-agent-v<ver>-setup.exe` (built in the `release` job)
- `PrintAnywhereAgent-<ver>.msi` (built in the `windows-installer` job)

Signing happens **before** `SHA256SUMS.txt` is finalized and before the artifacts
are uploaded to the GitHub release, so the published checksum always matches the
signed bytes.

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
signed release. The signing steps are gated on `env.ES_USERNAME != ''`, so:

- **Secrets present** → both artifacts are signed; `SHA256SUMS.txt` is recomputed
  to reflect the signed `setup.exe`; release shows a `SIGNED` notice in the log.
- **Secrets absent** → the signing steps skip cleanly and the release is published
  unsigned (current pre-cert behavior). The build does **not** fail.

The workflow log emits a clear `SIGNED` / `UNSIGNED` annotation for each artifact.

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
