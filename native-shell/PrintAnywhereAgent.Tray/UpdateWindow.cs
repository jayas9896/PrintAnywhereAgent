using System;
using System.Drawing;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Dhruvanta.PrintAnywhere.AgentTray;

/// <summary>
/// Phase 2d — replaces the WinForms dialog inside
/// scripts/check-update.ps1. Same operator-facing flow ("checking
/// → available / up-to-date → install button → progress → done"),
/// but driven by <see cref="UpdateService"/> + native HttpClient
/// instead of PowerShell + Invoke-RestMethod.
/// </summary>
public sealed class UpdateWindow : Form
{
    private readonly UpdateService _updateService;
    private readonly NodeSidecar _sidecar;

    private readonly Label _statusLabel;
    private readonly ProgressBar _progress;
    private readonly TextBox _log;
    private readonly Button _installButton;
    private readonly Button _closeButton;
    private CancellationTokenSource? _cancel;
    private UpdateCheckResult? _check;

    public UpdateWindow(UpdateService updateService, NodeSidecar sidecar, bool autoInstall)
    {
        _updateService = updateService;
        _sidecar = sidecar;

        Text = "PrintAnywhere Agent — Updates";
        Width = 540;
        Height = 420;
        StartPosition = FormStartPosition.CenterScreen;
        MinimizeBox = false;
        MaximizeBox = false;
        FormBorderStyle = FormBorderStyle.FixedDialog;

        _statusLabel = new Label
        {
            Dock = DockStyle.Top,
            Height = 36,
            Padding = new Padding(12, 10, 12, 6),
            Text = "Checking for updates…",
        };
        _progress = new ProgressBar
        {
            Dock = DockStyle.Top,
            Height = 22,
            Style = ProgressBarStyle.Marquee,
            MarqueeAnimationSpeed = 30,
        };
        _log = new TextBox
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Vertical,
            Font = new Font(FontFamily.GenericMonospace, 9F),
        };

        var buttonRow = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = 48,
            Padding = new Padding(8),
            FlowDirection = FlowDirection.RightToLeft,
        };
        _closeButton = new Button { Text = "Close", Width = 100, Enabled = false };
        _closeButton.Click += (_, _) => Close();
        _installButton = new Button { Text = "Install update", Width = 140, Enabled = false };
        _installButton.Click += async (_, _) => await BeginInstallAsync().ConfigureAwait(true);
        buttonRow.Controls.Add(_installButton);
        buttonRow.Controls.Add(_closeButton);

        Controls.Add(_log);
        Controls.Add(_progress);
        Controls.Add(_statusLabel);
        Controls.Add(buttonRow);

        FormClosing += (_, _) => _cancel?.Cancel();

        Shown += async (_, _) => await BeginCheckAsync(autoInstall).ConfigureAwait(true);
    }

    private async Task BeginCheckAsync(bool autoInstallIfAvailable)
    {
        _cancel = new CancellationTokenSource();
        try
        {
            Append("Checking for updates…");
            var result = await _updateService.CheckAsync(_cancel.Token).ConfigureAwait(true);
            _check = result;
            HandleCheckResult(result);
            if (result.Availability == UpdateAvailability.UpdateAvailable && autoInstallIfAvailable)
            {
                await BeginInstallAsync().ConfigureAwait(true);
            }
        }
        catch (OperationCanceledException)
        {
            Append("Update check cancelled.");
            ResetUi("Cancelled.");
        }
        catch (Exception ex)
        {
            Append($"Update check failed: {ex.Message}");
            ResetUi("Update check failed.");
        }
    }

    private void HandleCheckResult(UpdateCheckResult result)
    {
        switch (result.Availability)
        {
            case UpdateAvailability.UpdateAvailable:
                Append($"Update available: {result.CurrentVersion} → {result.LatestVersion}.");
                _statusLabel.Text = $"Update available: v{result.LatestVersion}";
                _installButton.Text = "Download and install";
                _installButton.Enabled = true;
                _closeButton.Enabled = true;
                StopMarquee();
                break;
            case UpdateAvailability.UpToDate:
                Append($"PrintAnywhere Agent is up to date (v{result.CurrentVersion}).");
                _statusLabel.Text = "Up to date.";
                _installButton.Text = "Reinstall current";
                _installButton.Enabled = true;
                _closeButton.Enabled = true;
                StopMarquee();
                break;
            case UpdateAvailability.AlreadyAhead:
                Append($"Installed v{result.CurrentVersion} is newer than the latest release ({result.LatestVersion}). Nothing to do.");
                ResetUi("Already ahead of latest release.");
                break;
            case UpdateAvailability.AssetsMissing:
                Append("Latest release exists but is missing the setup asset or SHA256SUMS.txt. Contact support.");
                ResetUi("Release is incomplete.");
                break;
            case UpdateAvailability.NoReleaseFound:
                Append("No published releases found for this repository.");
                ResetUi("No releases.");
                break;
            case UpdateAvailability.MalformedTag:
                Append("Latest release tag could not be parsed as a version. Contact support.");
                ResetUi("Malformed release tag.");
                break;
        }
    }

    private async Task BeginInstallAsync()
    {
        if (_check?.SetupAsset is null) return;
        _installButton.Enabled = false;
        _closeButton.Enabled = false;
        _progress.Style = ProgressBarStyle.Continuous;
        _progress.Minimum = 0;
        _progress.Maximum = (int)Math.Max(1, _check.SetupAsset.Size);
        _progress.Value = 0;

        _cancel = new CancellationTokenSource();
        var progressReport = new Progress<long>(bytes =>
        {
            if (_progress.IsDisposed) return;
            int clamped = (int)Math.Clamp(bytes, 0, _progress.Maximum);
            _progress.Value = clamped;
            _statusLabel.Text = $"Downloading {_check.SetupAsset.Name} — " +
                $"{(bytes / (1024.0 * 1024)):F1} MB of {(_check.SetupAsset.Size / (1024.0 * 1024)):F1} MB";
        });

        try
        {
            Append("Downloading installer…");
            string setupPath = await _updateService.DownloadAndVerifyAsync(_check, progressReport, _cancel.Token)
                .ConfigureAwait(true);
            Append($"Download verified: SHA-256 matches SHA256SUMS.txt entry for {_check.SetupAsset.Name}.");

            _statusLabel.Text = "Stopping the running agent before install…";
            Append("Stopping the running Node sidecar before install…");
            _sidecar.Stop();

            _statusLabel.Text = "Installing — Windows will replace the running agent…";
            Append("Launching installer silently. The tray icon may disappear briefly while the new version takes over.");
            await _updateService.RunSilentInstallAsync(setupPath, _cancel.Token).ConfigureAwait(true);

            Append("Installer finished. Restarting the agent…");
            _sidecar.Start();

            _progress.Value = _progress.Maximum;
            _statusLabel.Text = "Update installed.";
            Append("Update complete.");
            _closeButton.Enabled = true;
        }
        catch (OperationCanceledException)
        {
            Append("Install cancelled by operator.");
            ResetUi("Cancelled.");
        }
        catch (Exception ex)
        {
            Append($"Install failed: {ex.Message}");
            ResetUi("Install failed.");
        }
    }

    private void ResetUi(string status)
    {
        StopMarquee();
        _statusLabel.Text = status;
        _installButton.Enabled = false;
        _closeButton.Enabled = true;
    }

    private void StopMarquee()
    {
        _progress.Style = ProgressBarStyle.Continuous;
        _progress.MarqueeAnimationSpeed = 0;
        _progress.Minimum = 0;
        _progress.Maximum = 1;
        _progress.Value = 0;
    }

    private void Append(string line)
    {
        if (_log.IsDisposed) return;
        string timestamp = DateTime.Now.ToString("HH:mm:ss");
        _log.AppendText($"[{timestamp}] {line}{Environment.NewLine}");
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _cancel?.Cancel();
            _cancel?.Dispose();
        }
        base.Dispose(disposing);
    }
}
