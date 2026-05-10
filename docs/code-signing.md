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

## Verification

On Windows:

```powershell
Get-AuthenticodeSignature .\artifacts\printanywhere-agent-v<version>-setup.exe | Format-List
```

With Windows SDK:

```powershell
signtool verify /pa /v .\artifacts\printanywhere-agent-v<version>-setup.exe
```

Expected result after a real OV/EV certificate is used:

- the signature status is valid
- the signer certificate subject is Dhruvanta Systems
- Windows UAC/SmartScreen no longer shows `Unknown publisher`
