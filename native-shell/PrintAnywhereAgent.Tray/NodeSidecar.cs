using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Security;
using System.Threading;
using System.Threading.Tasks;

namespace Dhruvanta.PrintAnywhere.AgentTray;

/// <summary>
/// Owns the Node Express agent child process.
///
/// <para>Crash policy: a child exit during normal operation triggers
/// a restart with a back-off (250 ms, 500, 1 s, 2 s, 5 s, capped) so a
/// crash loop does not pin the CPU. After three crashes in 10 minutes
/// we open the circuit-breaker — the same threshold the PS tray uses
/// so behaviour is unchanged from the operator's perspective. The
/// tray menu surfaces the breaker state via <see cref="State"/>.</para>
///
/// <para>Process is launched without a window (UseShellExecute=false,
/// CreateNoWindow=true) so it never flashes a console box on
/// Windows.</para>
/// </summary>
public sealed class NodeSidecar : IDisposable
{
    private static readonly TimeSpan CircuitWindow = TimeSpan.FromMinutes(10);
    private const int CircuitThreshold = 3;

    private readonly InstallLayout _layout;
    private readonly int _port;
    private readonly object _gate = new();
    private readonly System.Collections.Generic.Queue<DateTime> _recentCrashes = new();
    private readonly HttpClient _healthClient;

    private Process? _process;
    private CancellationTokenSource? _cancel;
    private SidecarState _state = SidecarState.Stopped;

    public NodeSidecar(InstallLayout layout, int port)
    {
        _layout = layout;
        _port = port;
        var handler = new HttpClientHandler
        {
            // Loopback only — agent's local UI uses a self-signed cert.
            ServerCertificateCustomValidationCallback = (_, _, _, _) => true,
        };
        _healthClient = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(5) };
    }

    public SidecarState State
    {
        get
        {
            lock (_gate) return _state;
        }
    }

    public event EventHandler<SidecarState>? StateChanged;

    public void Start()
    {
        lock (_gate)
        {
            if (_process is { HasExited: false })
            {
                return;
            }
            _cancel?.Cancel();
            _cancel = new CancellationTokenSource();
            SpawnLocked(_cancel.Token);
            SetStateLocked(SidecarState.Starting);
        }
    }

    public void Stop()
    {
        Process? process;
        CancellationTokenSource? cancel;
        lock (_gate)
        {
            process = _process;
            cancel = _cancel;
            _process = null;
            _cancel = null;
            SetStateLocked(SidecarState.Stopped);
        }
        cancel?.Cancel();
        if (process is { HasExited: false })
        {
            try { process.Kill(entireProcessTree: true); } catch { /* best-effort */ }
        }
        process?.Dispose();
    }

    public void Restart()
    {
        Stop();
        Thread.Sleep(250);
        Start();
    }

    public async Task<bool> ProbeHealthAsync(CancellationToken cancel = default)
    {
        try
        {
            var response = await _healthClient.GetAsync(
                $"https://127.0.0.1:{_port}/printanywhere/health", cancel).ConfigureAwait(false);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private void SpawnLocked(CancellationToken cancel)
    {
        var psi = new ProcessStartInfo
        {
            FileName = _layout.NodeExecutable,
            WorkingDirectory = _layout.VersionDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.ArgumentList.Add(_layout.AgentEntryPoint);

        // Forward the data dir + env file via env vars the agent reads
        // (same names the PS scripts pass on the command line; the
        // Node loader normalises both).
        psi.Environment["PRINTANYWHERE_AGENT_DATA_DIR"] = _layout.DataDir;
        if (File.Exists(_layout.EnvFile))
        {
            psi.Environment["PRINTANYWHERE_AGENT_ENV_FILE"] = _layout.EnvFile;
        }
        psi.Environment["PRINTANYWHERE_AGENT_UI_PORT"] = _port.ToString(System.Globalization.CultureInfo.InvariantCulture);

        var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        process.Exited += (_, _) => OnProcessExited(process, cancel);
        try
        {
            process.Start();
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            // The v0.1.33 client install failure mode: NodeExecutable
            // resolved to a path that doesn't exist on disk (bundle
            // layout drift) so Process.Start throws Win32Exception 2.
            // Without this catch the exception unwound past Program.Main
            // and the tray died silently — operator saw "click does
            // nothing", Event Log saw "unhandled exception", but no
            // user-facing diagnosis. Surface it loudly with the actual
            // command line so the next layout drift is self-explaining.
            string detail = "Node sidecar failed to start:\n\n"
                + "Executable: " + _layout.NodeExecutable + "\n"
                + "Entry:      " + _layout.AgentEntryPoint + "\n"
                + "WorkingDir: " + _layout.VersionDirectory + "\n\n"
                + ex.Message + " (Win32 error " + ex.NativeErrorCode + ")";
            System.Windows.Forms.MessageBox.Show(
                detail,
                "PrintAnywhere Agent - sidecar start failed",
                System.Windows.Forms.MessageBoxButtons.OK,
                System.Windows.Forms.MessageBoxIcon.Error);
            throw;
        }
        _process = process;
    }

    private void OnProcessExited(Process exited, CancellationToken cancel)
    {
        if (cancel.IsCancellationRequested) return;

        DateTime now = DateTime.UtcNow;
        bool breakerOpen;
        lock (_gate)
        {
            _recentCrashes.Enqueue(now);
            while (_recentCrashes.Count > 0 && now - _recentCrashes.Peek() > CircuitWindow)
            {
                _recentCrashes.Dequeue();
            }
            breakerOpen = _recentCrashes.Count >= CircuitThreshold;
            SetStateLocked(breakerOpen ? SidecarState.CrashLoop : SidecarState.Restarting);
        }
        if (breakerOpen) return;

        int crashCount;
        lock (_gate) { crashCount = _recentCrashes.Count; }
        int delayMs = Math.Min(5000, 250 * (int)Math.Pow(2, Math.Max(0, crashCount - 1)));
        Task.Delay(delayMs, cancel).ContinueWith(_ =>
        {
            if (cancel.IsCancellationRequested) return;
            lock (_gate)
            {
                if (_cancel?.IsCancellationRequested ?? true) return;
                SpawnLocked(cancel);
                SetStateLocked(SidecarState.Starting);
            }
        }, TaskScheduler.Default);
    }

    private void SetStateLocked(SidecarState next)
    {
        if (_state == next) return;
        _state = next;
        var handler = StateChanged;
        if (handler is not null)
        {
            ThreadPool.QueueUserWorkItem(_ => handler(this, next));
        }
    }

    public void Dispose()
    {
        Stop();
        _healthClient.Dispose();
    }
}

public enum SidecarState
{
    Stopped,
    Starting,
    Running,
    Restarting,
    CrashLoop,
}
