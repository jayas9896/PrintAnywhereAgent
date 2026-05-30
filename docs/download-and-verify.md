# Download & verify PrintAnywhere Agent

PrintAnywhere Agent is a signed Windows installer. This page shows where to get it
and how to confirm the download is genuine before you install.

## Where to download

- **GitHub Releases** — https://github.com/Jayashanker-Padishala/PrintAnywhereAgent/releases
  (each release has `…-setup.exe`, the `.msi`, and `SHA256SUMS.txt`).
- **Official download page** — `https://download.dhruvantasystems.com` *(coming soon;
  the canonical stable URL will live here).*

Only install builds from these official sources.

## 1. Verify the checksum

Download `SHA256SUMS.txt` from the same release, then in PowerShell:

```powershell
# from the folder containing the installer + SHA256SUMS.txt
$file = "printanywhere-agent-vX.Y.Z-setup.exe"   # or the .msi
(Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
Select-String -Path SHA256SUMS.txt -Pattern $file
```

The hash printed by `Get-FileHash` must match the line for that file in
`SHA256SUMS.txt`.

## 2. Verify the code signature (publisher)

```powershell
Get-AuthenticodeSignature "printanywhere-agent-vX.Y.Z-setup.exe" |
  Format-List Status, SignerCertificate, TimeStamperCertificate
```

- `Status` should be **`Valid`**.
- `SignerCertificate` subject should be **Dhruvanta Systems** (the verified publisher).
- `TimeStamperCertificate` should be present (the signature is timestamped).

You can also right-click the installer → **Properties** → **Digital Signatures** and
confirm the signer is Dhruvanta Systems.

## 3. (Optional) Check VirusTotal

We scan each signed release on VirusTotal before publishing and aim for **0
detections**. You can independently look up the file by its SHA-256 hash at
`https://www.virustotal.com/gui/file/<sha256>`.

## "Windows protected your PC" (SmartScreen)

A brand-new code-signing certificate has not yet built up Microsoft SmartScreen
*reputation*, so for early downloads Windows may still show a SmartScreen prompt
**even though the installer is correctly signed**. This is expected and fades as the
download base grows.

If you have verified the signature (step 2) and checksum (step 1), you can proceed:
click **More info → Run anyway**. The verified **Dhruvanta Systems** publisher name
in the prompt is your assurance the file is genuine.

### If you believe a detection is a false positive (operator runbook)

If SmartScreen or Microsoft Defender flags a signed release as malicious, submit it
for review at the **Microsoft Security Intelligence submission portal**:
https://www.microsoft.com/en-us/wdsi/filesubmission — choose "Software developer",
attach the signed installer, and reference the publisher (Dhruvanta Systems) and the
VirusTotal report. This corrects incorrect "unknown/unwanted" classifications and
helps reputation recover.
