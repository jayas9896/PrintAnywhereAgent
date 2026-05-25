using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace Dhruvanta.PrintAnywhere.AgentTray;

/// <summary>
/// The NotifyIcon + context menu. Mirrors the existing PowerShell
/// tray menu so an operator who upgrades from PS to native sees the
/// same actions in the same places.
/// </summary>
public sealed class AgentTray : IDisposable
{
    private readonly NotifyIcon _notifyIcon;
    private readonly NodeSidecar _sidecar;
    private readonly int _uiPort;
    private readonly InstallLayout _layout;
    private readonly ToolStripMenuItem _statusItem;
    private readonly System.Windows.Forms.Timer _healthTimer;

    public AgentTray(NodeSidecar sidecar, InstallLayout layout, int uiPort)
    {
        _sidecar = sidecar;
        _layout = layout;
        _uiPort = uiPort;

        _notifyIcon = new NotifyIcon
        {
            Icon = LoadIcon(layout),
            Text = "PrintAnywhere Agent",
            Visible = true,
        };
        _notifyIcon.DoubleClick += (_, _) => OpenAgentUi();

        var menu = new ContextMenuStrip();
        _statusItem = new ToolStripMenuItem("Status: Starting…") { Enabled = false };
        menu.Items.Add(_statusItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Open PrintAnywhere Agent", null, (_, _) => OpenAgentUi()));
        menu.Items.Add(new ToolStripMenuItem("Restart Agent", null, (_, _) => RestartAgent()));
        menu.Items.Add(new ToolStripMenuItem("Stop Agent", null, (_, _) => _sidecar.Stop()));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Check for Updates…", null, (_, _) => OpenUpdateWindow(install: false)));
        menu.Items.Add(new ToolStripMenuItem("Install Latest Update…", null, (_, _) => OpenUpdateWindow(install: true)));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem($"Version: {layout.VersionTag()}") { Enabled = false });
        menu.Items.Add(new ToolStripMenuItem("Exit Tray", null, (_, _) => Application.Exit()));
        _notifyIcon.ContextMenuStrip = menu;

        _sidecar.StateChanged += (_, state) =>
        {
            try
            {
                if (_notifyIcon.ContextMenuStrip!.InvokeRequired)
                {
                    _notifyIcon.ContextMenuStrip.BeginInvoke(() => UpdateStatusForSidecarState(state));
                }
                else
                {
                    UpdateStatusForSidecarState(state);
                }
            }
            catch { /* shutting down */ }
        };

        _healthTimer = new System.Windows.Forms.Timer { Interval = 30_000 };
        _healthTimer.Tick += async (_, _) =>
        {
            bool healthy = await _sidecar.ProbeHealthAsync().ConfigureAwait(true);
            _statusItem.Text = healthy
                ? "Status: Running · UI responding"
                : DescribeSidecarState(_sidecar.State);
            _notifyIcon.Text = healthy
                ? "PrintAnywhere Agent — Running"
                : "PrintAnywhere Agent — " + DescribeSidecarState(_sidecar.State);
        };
        _healthTimer.Start();
    }

    private void UpdateStatusForSidecarState(SidecarState state)
    {
        _statusItem.Text = "Status: " + DescribeSidecarState(state);
        if (state == SidecarState.CrashLoop)
        {
            _notifyIcon.ShowBalloonTip(
                4000,
                "PrintAnywhere Agent",
                "Agent has crashed repeatedly. Click Restart Agent to retry, or open the update window to reinstall.",
                ToolTipIcon.Warning);
        }
    }

    private static string DescribeSidecarState(SidecarState state) => state switch
    {
        SidecarState.Stopped => "Stopped",
        SidecarState.Starting => "Starting…",
        SidecarState.Running => "Running",
        SidecarState.Restarting => "Restarting…",
        SidecarState.CrashLoop => "Crash-loop (paused)",
        _ => state.ToString(),
    };

    private void OpenAgentUi()
    {
        string url = ResolveUiBaseUrl();
        try
        {
            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
        }
        catch (Exception ex)
        {
            _notifyIcon.ShowBalloonTip(4000, "PrintAnywhere Agent", $"Could not open {url}: {ex.Message}", ToolTipIcon.Error);
        }
    }

    private string ResolveUiBaseUrl()
    {
        // Mirror the PS tray's resolution: ui-launcher.json may have
        // flipped from the dhruvantasystems.com domain to 127.0.0.1;
        // ui-runtime.json carries the actual bound port if the agent
        // fell back past a busy one.
        string uiHost = "local.printanywhere.dhruvantasystems.com";
        int uiPort = _uiPort;
        string launcherPath = Path.Combine(_layout.DataDir, "ui-launcher.json");
        if (File.Exists(launcherPath))
        {
            try
            {
                using var stream = File.OpenRead(launcherPath);
                using var doc = System.Text.Json.JsonDocument.Parse(stream);
                if (doc.RootElement.TryGetProperty("uiHost", out var hostEl)
                    && hostEl.ValueKind == System.Text.Json.JsonValueKind.String
                    && string.Equals(hostEl.GetString(), "localhost", StringComparison.OrdinalIgnoreCase))
                {
                    uiHost = "127.0.0.1";
                }
            }
            catch { /* malformed config — keep the domain default */ }
        }
        string runtimePath = Path.Combine(_layout.DataDir, "ui-runtime.json");
        if (File.Exists(runtimePath))
        {
            try
            {
                using var stream = File.OpenRead(runtimePath);
                using var doc = System.Text.Json.JsonDocument.Parse(stream);
                if (doc.RootElement.TryGetProperty("port", out var portEl)
                    && portEl.TryGetInt32(out int port)
                    && port > 0)
                {
                    uiPort = port;
                }
            }
            catch { /* mid-write — keep the configured port */ }
        }
        return $"https://{uiHost}:{uiPort}/printanywhere/";
    }

    private void RestartAgent()
    {
        _sidecar.Restart();
        _notifyIcon.ShowBalloonTip(3000, "PrintAnywhere Agent", "Restart requested.", ToolTipIcon.Info);
    }

    private void OpenUpdateWindow(bool install)
    {
        // Phase 2d — native updater. Replaces the WinForms-in-PS
        // dialog scripts/check-update.ps1 spawned. The PS script
        // stays in the release bundle for one cycle so an operator
        // who upgrades from a pre-2d install can still hit it from
        // the legacy Start Menu shortcut while the native tray
        // takes over.
        try
        {
            string? raw = System.Reflection.Assembly.GetExecutingAssembly()
                .GetName().Version?.ToString(3);
            Version version = !string.IsNullOrWhiteSpace(raw) && Version.TryParse(raw, out var parsed)
                ? parsed : new Version(0, 0, 0);
            var service = new UpdateService(version);
            var window = new UpdateWindow(service, _sidecar, install);
            window.FormClosed += (_, _) => service.Dispose();
            window.Show();
            window.Activate();
        }
        catch (Exception ex)
        {
            _notifyIcon.ShowBalloonTip(4000, "PrintAnywhere Agent",
                $"Could not launch update window: {ex.Message}", ToolTipIcon.Error);
        }
    }

    private static Icon LoadIcon(InstallLayout layout)
    {
        string path = Path.Combine(layout.VersionDirectory, "assets", "dhruvanta-agent.ico");
        if (File.Exists(path))
        {
            try { return new Icon(path); } catch { /* fall through */ }
        }
        return SystemIcons.Application;
    }

    public void Dispose()
    {
        _healthTimer.Stop();
        _healthTimer.Dispose();
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
    }
}
