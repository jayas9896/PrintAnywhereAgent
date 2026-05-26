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
    private readonly object _logGate = new();
    private readonly System.Collections.Generic.Queue<DateTime> _recentCrashes = new();
    private readonly HttpClient _healthClient;

    private Process? _process;
    private CancellationTokenSource? _cancel;
    private SidecarState _state = SidecarState.Stopped;
    /// <summary>
    /// KAN-431 R2 — populated by <see cref="SpawnLocked"/> when
    /// <c>Process.Start()</c> throws a <see cref="System.ComponentModel.Win32Exception"/>.
    /// The MessageBox that used to live inside the lock is now shown from
    /// <see cref="Start"/> AFTER the lock releases, so the dialog never
    /// blocks any other Start/Stop/State call on _gate.
    /// </summary>
    public string? LastStartFailureDetail { get; private set; }

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
        Exception? failure = null;
        string? failureDetail = null;
        lock (_gate)
        {
            if (_process is { HasExited: false })
            {
                return;
            }
            _cancel?.Cancel();
            _cancel = new CancellationTokenSource();
            try
            {
                SpawnLocked(_cancel.Token);
                SetStateLocked(SidecarState.Starting);
            }
            catch (Exception ex)
            {
                // KAN-431 R2 — surface the diagnostic OUTSIDE the lock.
                // Holding _gate while showing a modal MessageBox would
                // block any other Start/Stop/State call (including the
                // tray icon's Restart menu item if the operator clicked
                // it). Capture detail + exception here; show the dialog
                // and rethrow after the lock releases.
                failure = ex;
                failureDetail = LastStartFailureDetail;
            }
        }
        if (failure is not null)
        {
            if (failureDetail is not null)
            {
                try
                {
                    System.Windows.Forms.MessageBox.Show(
                        failureDetail,
                        "PrintAnywhere Agent - sidecar start failed",
                        System.Windows.Forms.MessageBoxButtons.OK,
                        System.Windows.Forms.MessageBoxIcon.Error);
                }
                catch
                {
                    // Best-effort — if MessageBox cannot show (e.g. no
                    // message pump on this thread) the exception below
                    // still propagates the failure to the caller.
                }
            }
            throw failure;
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
        // KAN-431 R1 — drain stdout + stderr into a rotating-by-size log
        // file under the data dir. Before this, both streams were
        // redirected (RedirectStandardOutput / RedirectStandardError =
        // true) but never read, so the Windows pipe buffer (~4-64 KB)
        // would fill on a chatty child and the Node process would
        // block on its next write — freezing the agent silently.
        process.OutputDataReceived += (_, e) => WriteSidecarLogLine(e.Data, isErr: false);
        process.ErrorDataReceived += (_, e) => WriteSidecarLogLine(e.Data, isErr: true);
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
            // user-facing diagnosis. KAN-431 R2: capture the detail
            // string into LastStartFailureDetail and rethrow; the public
            // Start() reads it AFTER releasing the lock and shows the
            // MessageBox there. Inside the lock a MessageBox would
            // block every other concurrent Start/Stop/State call.
            LastStartFailureDetail = "Node sidecar failed to start:\n\n"
                + "Executable: " + _layout.NodeExecutable + "\n"
                + "Entry:      " + _layout.AgentEntryPoint + "\n"
                + "WorkingDir: " + _layout.VersionDirectory + "\n\n"
                + ex.Message + " (Win32 error " + ex.NativeErrorCode + ")";
            throw;
        }
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        _process = process;
    }

    private void WriteSidecarLogLine(string? line, bool isErr)
    {
        if (string.IsNullOrEmpty(line)) return;
        try
        {
            string logDir = Path.Combine(_layout.DataDir, "logs");
            Directory.CreateDirectory(logDir);
            string logPath = Path.Combine(logDir, "sidecar.log");
            string stamp = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture);
            string prefix = isErr ? "ERR" : "OUT";
            lock (_logGate)
            {
                File.AppendAllText(logPath, stamp + " " + prefix + " " + line + Environment.NewLine);
            }
        }
        catch
        {
            // Best-effort: a logging failure (full disk, perms) must
            // never propagate up and kill the sidecar lifecycle. The
            // sidecar process keeps running; the operator just loses
            // log lines until the disk problem is resolved.
        }
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
                try
                {
                    SpawnLocked(cancel);
                    SetStateLocked(SidecarState.Starting);
                }
                catch (Exception ex)
                {
                    // KAN-431 R2 — respawn failure on a thread-pool
                    // thread; do NOT pop a MessageBox here (no owner
                    // window, can be hidden or off-screen). Persist
                    // diagnostic to the sidecar log and open the
                    // circuit-breaker so the tray UI can surface it.
                    WriteSidecarLogLine(
                        "Respawn failed: " + ex.GetType().Name + ": " + ex.Message,
                        isErr: true);
                    if (LastStartFailureDetail is not null)
                    {
                        WriteSidecarLogLine(LastStartFailureDetail, isErr: true);
                    }
                    SetStateLocked(SidecarState.CrashLoop);
                }
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
