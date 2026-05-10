# Windows Code Signing

Windows shows `Publisher: Unknown` when the setup executable is not
Authenticode-signed. The version-resource `CompanyName` is already
`Dhruvanta Systems`, but Windows installer trust uses the signing
certificate, not that resource metadata.

To show `Dhruvanta Systems` as the publisher on customer machines, sign
`printanywhere-agent-v<version>-setup.exe` with an OV or EV Windows
code-signing certificate issued to Dhruvanta Systems. A self-signed
certificate is acceptable only for an internal lab machine where the
certificate is manually trusted; it does not give public customers a
trusted publisher or SmartScreen reputation.

For the current internal-testing release path, we also publish the
self-signed public certificate and SHA-256 fingerprint beside the setup
executable. This lets an operator verify that the `.exe` is signed by
the same Dhruvanta-held self-signed key even though Windows still shows
an untrusted or unknown publisher.

## Secret Placement

Do not commit signing material. On this host, use:

```bash
mkdir -p /home/jayas/.secrets/dhruvanta-code-signing
chmod 700 /home/jayas/.secrets/dhruvanta-code-signing
```

Place the certificate and password here:

```text
/home/jayas/.secrets/dhruvanta-code-signing/dhruvanta-systems-codesign.pfx
/home/jayas/.secrets/dhruvanta-code-signing/dhruvanta-systems-codesign-password.txt
```

Then restrict both files:

```bash
chmod 600 /home/jayas/.secrets/dhruvanta-code-signing/dhruvanta-systems-codesign.pfx
chmod 600 /home/jayas/.secrets/dhruvanta-code-signing/dhruvanta-systems-codesign-password.txt
```

## Release Build With Signing

Set these env vars before building the Windows installer:

```bash
export PRINTANYWHERE_CODESIGN_PFX=/home/jayas/.secrets/dhruvanta-code-signing/dhruvanta-systems-codesign.pfx
export PRINTANYWHERE_CODESIGN_PASSWORD_FILE=/home/jayas/.secrets/dhruvanta-code-signing/dhruvanta-systems-codesign-password.txt
export PRINTANYWHERE_CODESIGN_STRICT=1
export PRINTANYWHERE_CODESIGN_TIMESTAMP_URL=http://timestamp.digicert.com
```

Build:

```bash
npm run release:windows-installer
```

If the setup executable was already built, sign it and refresh the
checksum manifest:

```bash
npm run release:sign-windows-installer
```

The signing script uses `osslsigncode` in WSL when available. On
Windows, or when using the Windows SDK, set:

```bash
export PRINTANYWHERE_SIGNTOOL_PATH='/mnt/c/Program Files (x86)/Windows Kits/10/bin/<version>/x64/signtool.exe'
```

## Internal Self-Signed Certificate

Use this only until an OV/EV certificate issued to Dhruvanta Systems is
available.

Generate or reuse the host-local self-signed key material:

```bash
npm run codesign:create-self-signed
```

The private key and PFX stay outside git under:

```text
/home/jayas/.secrets/dhruvanta-code-signing/self-signed/
```

Load the generated signing environment and build:

```bash
. /home/jayas/.secrets/dhruvanta-code-signing/self-signed/printanywhere-selfsigned-codesign.env
npm run release:windows-installer
```

When a self-signed release is built successfully, `artifacts/` also
contains:

```text
dhruvanta-systems-codesign-public.cer
dhruvanta-systems-codesign-public.pem
dhruvanta-systems-codesign-fingerprint.txt
RELEASE-INTEGRITY.txt
SHA256SUMS.txt
```

Upload those files with the setup executable. They are public
verification material only; do not upload the PFX, private key, password
file, or generated secret env file.

## Verification

On Windows:

```powershell
Get-AuthenticodeSignature .\artifacts\printanywhere-agent-v<version>-setup.exe | Format-List
```

For a self-signed release, compare the `SignerCertificate.Thumbprint`
shown by PowerShell with the SHA-256 fingerprint published in
`dhruvanta-systems-codesign-fingerprint.txt`. Also verify the setup
executable hash against `SHA256SUMS.txt`.

With Windows SDK:

```powershell
signtool verify /pa /v .\artifacts\printanywhere-agent-v<version>-setup.exe
```

Expected result after a real OV/EV certificate is used:

- the signature status is valid
- the signer certificate subject is Dhruvanta Systems
- Windows UAC/SmartScreen no longer shows `Unknown publisher`
