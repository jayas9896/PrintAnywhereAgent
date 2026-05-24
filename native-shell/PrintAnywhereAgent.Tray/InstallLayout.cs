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

        // Bundled Node runtime — release:build vendors win-x64 node.
        string nodeExe = Path.Combine(versionDir, "node-win-x64", "node.exe");
        if (!File.Exists(nodeExe))
        {
            // Fall back to PATH node, same way the PS scripts do.
            nodeExe = "node.exe";
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
