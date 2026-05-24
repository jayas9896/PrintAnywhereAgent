using System;
using System.Threading;
using System.Windows.Forms;

namespace Dhruvanta.PrintAnywhere.AgentTray;

/// <summary>
/// Entry point for the native tray. Single-instance via a named
/// mutex (matches the PS tray's "Local\DhruvantaPrintAnywhereAgentTray"
/// scope) so a stray second launch silently exits instead of stacking
/// two tray icons.
/// </summary>
public static class Program
{
    private const string SingleInstanceMutex = "Local\\DhruvantaPrintAnywhereAgentTray";
    private const int DefaultUiPort = 43100;

    [STAThread]
    public static int Main(string[] args)
    {
        using var mutex = new Mutex(initiallyOwned: true, SingleInstanceMutex, out bool created);
        if (!created)
        {
            // Another tray instance is already running.
            return 0;
        }

        ApplicationConfiguration.Initialize();

        InstallLayout layout;
        try
        {
            layout = InstallLayout.Discover();
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"PrintAnywhere Agent failed to start the tray:\n\n{ex.Message}\n\n" +
                "Reinstall from the latest release bundle if this keeps happening.",
                "PrintAnywhere Agent",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 2;
        }

        int port = ResolveUiPort(args, DefaultUiPort);
        using var sidecar = new NodeSidecar(layout, port);
        using var tray = new AgentTray(sidecar, layout, port);

        sidecar.Start();
        try
        {
            Application.Run();
            return 0;
        }
        finally
        {
            sidecar.Stop();
        }
    }

    private static int ResolveUiPort(string[] args, int fallback)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], "-Port", StringComparison.OrdinalIgnoreCase)
                || string.Equals(args[i], "--port", StringComparison.OrdinalIgnoreCase))
            {
                if (int.TryParse(args[i + 1], out int parsed) && parsed > 0) return parsed;
            }
        }
        string? envPort = Environment.GetEnvironmentVariable("PRINTANYWHERE_AGENT_UI_PORT");
        if (!string.IsNullOrWhiteSpace(envPort) && int.TryParse(envPort, out int fromEnv) && fromEnv > 0)
        {
            return fromEnv;
        }
        return fallback;
    }
}
