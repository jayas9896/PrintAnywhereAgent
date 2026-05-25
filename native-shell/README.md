# PrintAnywhereAgent — native Windows shell (Phase 2b)

A .NET 8 WinForms tray app that hosts the PrintAnywhere Agent on a
print-shop owner's Windows PC. Replaces the PowerShell-based tray
(`scripts/agent-tray.ps1`) with a real signed binary.

## Why

Operators reported that the tray icon disappears after a version
update (Phase 2a fixed the stable-launcher symptom; this is the
native rewrite). Operators also expected a "real application" rather
than `.ps1` scripts in the Start Menu.

## What it does today (Phase 2b — scaffold)

- Single-instance via `Local\DhruvantaPrintAnywhereAgentTray` mutex
- Discovers the active install at runtime by globbing
  `%LOCALAPPDATA%\Dhruvanta Systems\PrintAnywhereAgent\printanywhere-agent-v*`
  (matches the layout the install scripts already produce)
- Manages the Node Express agent as a child process:
  - starts `<install>\node-win-x64\node.exe <install>\dist\index.js`
  - restarts on crash with exponential back-off
  - opens the circuit-breaker after 3 crashes in 10 minutes (same
    threshold as the legacy PS tray)
- NotifyIcon menu: Status · Open UI · Restart · Stop · Check for
  Updates · Install Latest Update · Version · Exit
- "Open UI" honours the same `ui-launcher.json` /
  `ui-runtime.json` overrides the PS tray respects (operator
  may have flipped from the dhruvantasystems.com domain to
  `127.0.0.1`; agent may have fallen back past a busy port)
- "Check for Updates" still delegates to `scripts/check-update.ps1`
  while the native auto-updater is being designed (Phase 2d).

## What it does NOT do yet

- No code signing (the EXE + MSI will SmartScreen-warn until a real
  EV cert is purchased and wired into the build scripts).
- No WebView2 embed — "Open UI" still opens the system browser.

## Native auto-updater (Phase 2d)

`UpdateService.cs` + `UpdateWindow.cs` are the C# replacement for
`scripts/check-update.ps1`. Same operator-visible flow ("Checking…
→ Update available / Up to date → Install → progress → done") but
driven by native `HttpClient` + `SHA256.HashData` rather than
PowerShell + `Invoke-RestMethod`. The tray's "Check for Updates"
and "Install Latest Update" menu items launch this dialog directly
— the PS script stays in the release bundle one cycle as fallback
for operators upgrading from a pre-2d install.

Behaviour:

* `GET https://api.github.com/repos/Jayashanker-Padishala/PrintAnywhereAgent/releases/latest`
* Prefers a `.msi` asset (Phase 2c output); falls back to the legacy
  `*-setup.exe` until `release.yml` is updated to publish MSIs
* Downloads setup + `SHA256SUMS.txt` to a fresh `%TEMP%` dir
* Verifies SHA-256 against the matching `SHA256SUMS.txt` line
* Stops the Node sidecar (`NodeSidecar.Stop()`)
* Runs the installer silently:
  * MSI → `msiexec /i ... /quiet /norestart`
  * EXE → `<setup>.exe /quiet /nolaunch` (legacy)
* Restarts the sidecar
* All cancellable mid-download via a `CancellationTokenSource` the
  form holds; closing the window aborts in-flight work

## MSI installer (Phase 2c)

`PrintAnywhereAgent.Installer/` is a WiX 5 project that produces a
per-user MSI:

- Installs into `%LOCALAPPDATA%\Dhruvanta Systems\PrintAnywhereAgent\printanywhere-agent-vX.Y.Z\`
  (the same layout `scripts/install-release.ps1` produces, so the
  native tray's `InstallLayout.Discover()` finds it identically)
- Start Menu shortcut targeting `PrintAnywhereAgent.exe`
- Add/Remove Programs entry under "PrintAnywhere Agent"
- In-place upgrade via the stable `UpgradeCode` GUID +
  `MajorUpgrade` — v0.1.32 cleanly replaces v0.1.31
- Silent install today (operator double-clicks; install runs without
  UI; tray appears when the agent registers); WixUI wizard is a
  follow-up

**Build:** `node scripts/build-native-msi.mjs` chains the native-tray
build and the MSI build. WiX 5 only supports Windows builds — the
Linux command will fail at the wix step (the .NET tray compile still
runs). `.github/workflows/native-shell.yml` is the authoritative CI
gate; it runs on `windows-latest` and uploads the EXE + MSI as
workflow artifacts.

**MSI test plan (real Windows):**

1. Build via the `native-shell` workflow; download `printanywhere-agent-msi`.
2. Double-click the MSI on a clean Windows VM. Install completes silently.
3. Confirm Start Menu → Dhruvanta Systems → PrintAnywhere Agent launches the tray.
4. Confirm Settings → Apps → PrintAnywhere Agent shows the entry; uninstall via that path.
5. Re-install the same version → MSI repairs (no error).
6. Install v0.1.32 over v0.1.31 → upgrade-in-place; only one
   `printanywhere-agent-v*` dir remains; the v0.1.31 dir is removed.

## Build

The CI image needs the Microsoft-distributed .NET SDK (the Ubuntu
`dotnet-sdk-8.0` apt package omits `Microsoft.NET.Sdk.WindowsDesktop`
which WinForms requires). Local one-time install:

```bash
curl -sSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
bash /tmp/dotnet-install.sh --channel 8.0 --install-dir $HOME/.dotnet-ms
export PATH=$HOME/.dotnet-ms:$PATH DOTNET_ROOT=$HOME/.dotnet-ms
```

Then from `native-shell/PrintAnywhereAgent.Tray/`:

```bash
dotnet publish -c Release -r win-x64 --self-contained=true \
  -p:PublishSingleFile=true \
  -p:IncludeNativeLibrariesForSelfExtract=true \
  -p:EnableCompressionInSingleFile=true
```

Output: `bin/Release/net8.0-windows/win-x64/publish/PrintAnywhereAgent.exe`
(currently ~69 MB self-contained; operator does not need .NET
pre-installed).

## Validation

Linux build verification only covers compile-time correctness. The
tray icon, single-instance mutex, NotifyIcon menu wiring, NodeSidecar
process lifecycle, and crash-loop circuit breaker must all be
exercised on real Windows before this replaces `scripts/agent-tray.ps1`
in operator installs.

Suggested manual test plan:

1. Drop `PrintAnywhereAgent.exe` next to the version dir on a
   real install: `%LOCALAPPDATA%\Dhruvanta Systems\PrintAnywhereAgent\`
2. Launch — confirm a tray icon appears and the Node sidecar starts
   (check `https://127.0.0.1:43100/printanywhere/health`).
3. Right-click → Stop Agent → confirm the Node process exits.
4. Right-click → Open PrintAnywhere Agent → confirm browser opens.
5. Kill the node.exe externally → confirm tray restarts it (and
   that 3 quick crashes flip the menu status to `Crash-loop`).
6. Launch a second `PrintAnywhereAgent.exe` → confirm it exits
   silently without a second tray icon.
