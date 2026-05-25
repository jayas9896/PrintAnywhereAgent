using System;
using System.IO;
using Dhruvanta.PrintAnywhere.AgentTray;
using Xunit;

namespace Dhruvanta.PrintAnywhere.AgentTray.Tests;

/// <summary>
/// KAN-425 regression fence for InstallLayout.Discover().
///
/// The v0.1.33 client install bug: InstallLayout looked for the
/// bundled Node at <c>&lt;versionDir&gt;/node-win-x64/node.exe</c> while
/// the actual release bundle vendors it under
/// <c>&lt;versionDir&gt;/runtime/node-win-x64/node.exe</c>. On every
/// dev / CI test PC Node is on PATH so the silent fallback to
/// <c>"node.exe"</c> worked; on a real client PC with no Node installed,
/// Process.Start threw Win32Exception and the tray crashed silently.
///
/// These tests pin the post-KAN-425 contract:
///   1. <c>runtime/node-win-x64/node.exe</c> is the canonical location.
///   2. <c>node-win-x64/node.exe</c> (no runtime/ prefix) is the legacy
///      fallback for older bundles still in the wild.
///   3. If NEITHER exists, Discover MUST throw, not silently fall
///      through to a PATH lookup that hides bundle bugs.
///
/// Each test stages a complete install layout under a TempDir and
/// points LOCALAPPDATA at it, so Discover() resolves the test fixture
/// instead of any pre-existing per-user install. Windows-only: the
/// project targets net8.0-windows and runs in the windows-latest CI
/// job; SpecialFolder.LocalApplicationData honours the
/// LOCALAPPDATA env var.
/// </summary>
public class InstallLayoutTests : IDisposable
{
    private readonly string _tempRoot;
    private readonly string? _previousLocalAppData;

    public InstallLayoutTests()
    {
        _tempRoot = Path.Combine(Path.GetTempPath(), "kan425-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_tempRoot);
        _previousLocalAppData = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        Environment.SetEnvironmentVariable("LOCALAPPDATA", _tempRoot);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("LOCALAPPDATA", _previousLocalAppData);
        try { Directory.Delete(_tempRoot, recursive: true); } catch { /* best-effort */ }
    }

    [Fact]
    public void DiscoverPrefersCanonicalRuntimeSubdirectoryForNode_KAN425()
    {
        // Stage the post-KAN-425 canonical layout: runtime/node-win-x64/node.exe
        // PLUS dist/index.js so Discover gets past every guard.
        var version = StageVersionDirectory("0.1.34");
        StageBundledNode(version, withRuntimePrefix: true);
        StageDistIndex(version);

        var layout = InstallLayout.Discover();

        Assert.Equal(Path.Combine(version, "runtime", "node-win-x64", "node.exe"),
                     layout.NodeExecutable);
        // Explicit guard against the v0.1.33 silent fallback:
        Assert.NotEqual("node.exe", layout.NodeExecutable);
    }

    [Fact]
    public void DiscoverFallsBackToLegacyNodePathWhenRuntimePrefixAbsent()
    {
        // Older bundles (pre-runtime/ layout) put node at <version>/node-win-x64/.
        // The Discover contract still accepts these so an in-place upgrade
        // doesn't strand operators on the legacy layout.
        var version = StageVersionDirectory("0.1.32");
        StageBundledNode(version, withRuntimePrefix: false);
        StageDistIndex(version);

        var layout = InstallLayout.Discover();

        Assert.Equal(Path.Combine(version, "node-win-x64", "node.exe"), layout.NodeExecutable);
    }

    [Fact]
    public void DiscoverThrowsWhenNeitherBundledNodePathExists_KAN425()
    {
        // THE KAN-425 regression fence. The buggy v0.1.33 silently fell
        // through to a PATH "node.exe" lookup; that hid the bundle bug
        // until a client PC without Node installed crashed the tray.
        // The fix throws FileNotFoundException with both attempted paths
        // in the message — this test pins that behaviour.
        var version = StageVersionDirectory("0.1.34");
        StageDistIndex(version);
        // intentionally NOT calling StageBundledNode → no node.exe anywhere.

        var ex = Assert.Throws<FileNotFoundException>(() => InstallLayout.Discover());

        Assert.Contains("Bundled Node runtime not found", ex.Message);
        Assert.Contains(Path.Combine("runtime", "node-win-x64", "node.exe"), ex.Message);
        Assert.Contains(Path.Combine("node-win-x64", "node.exe"), ex.Message);
        Assert.DoesNotContain("Process.Start", ex.Message);
    }

    [Fact]
    public void DiscoverPicksHighestSortingVersionWhenMultiplePresent()
    {
        // The version directory enumeration uses OrderByDescending on the
        // directory name — newer versions sort after older ones. Lock the
        // contract so a future LINQ tweak can't silently pick the oldest.
        var oldVersion = StageVersionDirectory("0.1.30");
        StageBundledNode(oldVersion, withRuntimePrefix: true);
        StageDistIndex(oldVersion);
        var newVersion = StageVersionDirectory("0.1.34");
        StageBundledNode(newVersion, withRuntimePrefix: true);
        StageDistIndex(newVersion);

        var layout = InstallLayout.Discover();

        Assert.Equal(newVersion, layout.VersionDirectory);
        Assert.Equal("v0.1.34", layout.VersionTag());
    }

    [Fact]
    public void DiscoverThrowsWhenInstallRootMissing()
    {
        // No printanywhere-agent-* directory at all — Discover must
        // surface a clear DirectoryNotFoundException, not crash silently.
        var ex = Assert.Throws<DirectoryNotFoundException>(() => InstallLayout.Discover());
        Assert.Contains("install root not found", ex.Message);
    }

    [Fact]
    public void DiscoverThrowsWhenVersionDirMissingFromInstallRoot()
    {
        // Install root exists but no version directory has been laid down.
        Directory.CreateDirectory(Path.Combine(_tempRoot, "Dhruvanta Systems", "PrintAnywhereAgent"));

        var ex = Assert.Throws<DirectoryNotFoundException>(() => InstallLayout.Discover());
        Assert.Contains("No printanywhere-agent-v* version directory", ex.Message);
    }

    [Fact]
    public void DiscoverThrowsWhenDistIndexJsMissing()
    {
        // Bundled Node present but the Node entry point isn't — partial
        // extract / corrupted install. Discover surfaces it as
        // FileNotFoundException so the operator's first symptom is the
        // tray's pre-paint MessageBox, not a crashloop.
        var version = StageVersionDirectory("0.1.34");
        StageBundledNode(version, withRuntimePrefix: true);

        var ex = Assert.Throws<FileNotFoundException>(() => InstallLayout.Discover());
        Assert.Contains("Agent entry point missing", ex.Message);
    }

    [Fact]
    public void DiscoverCreatesDataDirIfMissing()
    {
        var version = StageVersionDirectory("0.1.34");
        StageBundledNode(version, withRuntimePrefix: true);
        StageDistIndex(version);

        var layout = InstallLayout.Discover();

        Assert.True(Directory.Exists(layout.DataDir));
        Assert.EndsWith(Path.Combine("PrintAnywhereAgent", "data"), layout.DataDir);
    }

    // --- helpers ---

    private string StageVersionDirectory(string version)
    {
        string path = Path.Combine(_tempRoot, "Dhruvanta Systems", "PrintAnywhereAgent",
                                   "printanywhere-agent-v" + version);
        Directory.CreateDirectory(path);
        return path;
    }

    private static void StageBundledNode(string versionDir, bool withRuntimePrefix)
    {
        string nodeDir = withRuntimePrefix
            ? Path.Combine(versionDir, "runtime", "node-win-x64")
            : Path.Combine(versionDir, "node-win-x64");
        Directory.CreateDirectory(nodeDir);
        // Empty file is enough — Discover only checks File.Exists.
        File.WriteAllText(Path.Combine(nodeDir, "node.exe"), "");
    }

    private static void StageDistIndex(string versionDir)
    {
        string distDir = Path.Combine(versionDir, "dist");
        Directory.CreateDirectory(distDir);
        File.WriteAllText(Path.Combine(distDir, "index.js"), "// stub");
    }
}
