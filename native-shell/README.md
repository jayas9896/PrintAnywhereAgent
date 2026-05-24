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

- No native auto-updater (defer to Phase 2d).
- No MSI / MSIX installer (defer to Phase 2c — WiX likely).
- No code signing (the EXE will SmartScreen-warn until a real
  EV cert is purchased and wired into the build script).
- No WebView2 embed — "Open UI" still opens the system browser.

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
