using System;
using System.IO;
using System.Linq;

namespace Dhruvanta.PrintAnywhere.AgentTray;

/// <summary>
/// Resolves the installed-version directory + the path to the bundled
/// Node runtime + the path to dist/index.js. Mirrors the same
/// "%LOCALAPPDATA%\Dhruvanta Systems\PrintAnywhereAgent\printanywhere-agent-vX.Y.Z\"
/// layout the PowerShell scripts already use. The .exe lives at the
/// install root (<see cref="InstallRoot"/>), so a version update only
/// has to swap the printanywhere-agent-v* directory — the EXE path
/// stays valid and Windows keeps the tray icon registration.
/// </summary>
public sealed record InstallLayout(string InstallRoot, string VersionDirectory, string NodeExecutable, string AgentEntryPoint, string DataDir, string EnvFile)
{
    private const string InstallRootRelative = @"Dhruvanta Systems\PrintAnywhereAgent";

    public static InstallLayout Discover(string? overrideDataDir = null, string? overrideEnvFile = null)
    {
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localAppData))
        {
            throw new InvalidOperationException("LOCALAPPDATA is unset — cannot resolve PrintAnywhereAgent install root.");
        }

        string installRoot = Path.Combine(localAppData, InstallRootRelative);
        if (!Directory.Exists(installRoot))
        {
            throw new DirectoryNotFoundException($"PrintAnywhereAgent install root not found at {installRoot}. Was the agent installed?");
        }

        string? versionDir = Directory.EnumerateDirectories(installRoot, "printanywhere-agent-v*")
            .OrderByDescending(d => d, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();
        if (versionDir is null)
        {
            throw new DirectoryNotFoundException($"No printanywhere-agent-v* version directory under {installRoot}. The release bundle may not be extracted yet.");
        }

        // Bundled Node runtime — release:build (scripts/build-release.mjs)
        // vendors win-x64 node under <version>/runtime/node-win-x64/.
        // The legacy <version>/node-win-x64/ layout (no `runtime/`
        // parent) is checked as a fallback for any old bundle still in
        // the wild. If neither exists we throw rather than silently
        // falling through to a PATH `node.exe`: on a client PC with no
        // Node installed (the v0.1.33 install failure mode) the PATH
        // fallback made Process.Start in NodeSidecar throw an
        // UNHANDLED Win32Exception that killed the tray before the
        // icon painted. Every dev / CI test PC has Node, so the path
        // mismatch was invisible until the first real client install.
        string runtimeNodeExe = Path.Combine(versionDir, "runtime", "node-win-x64", "node.exe");
        string legacyNodeExe = Path.Combine(versionDir, "node-win-x64", "node.exe");
        string nodeExe;
        if (File.Exists(runtimeNodeExe))
        {
            nodeExe = runtimeNodeExe;
        }
        else if (File.Exists(legacyNodeExe))
        {
            nodeExe = legacyNodeExe;
        }
        else
        {
            throw new FileNotFoundException(
                "Bundled Node runtime not found. Looked at:\n"
                + "  " + runtimeNodeExe + "\n"
                + "  " + legacyNodeExe + "\n"
                + "The release bundle is incomplete — reinstall from the latest MSI.",
                runtimeNodeExe);
        }

        string agentEntry = Path.Combine(versionDir, "dist", "index.js");
        if (!File.Exists(agentEntry))
        {
            throw new FileNotFoundException($"Agent entry point missing: {agentEntry}. The release bundle is incomplete.", agentEntry);
        }

        string dataDir = overrideDataDir ?? Path.Combine(installRoot, "data");
        Directory.CreateDirectory(dataDir);

        string envFile = overrideEnvFile ?? Path.Combine(versionDir, "config", "agent.env");

        return new InstallLayout(installRoot, versionDir, nodeExe, agentEntry, dataDir, envFile);
    }

    public string VersionTag()
    {
        // "printanywhere-agent-v0.1.31" -> "v0.1.31"
        string name = Path.GetFileName(VersionDirectory);
        int idx = name.LastIndexOf('v');
        return idx >= 0 ? name[idx..] : name;
    }
}
