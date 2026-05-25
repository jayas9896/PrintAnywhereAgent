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
/// Test layout note: InstallLayout reads
/// <c>Environment.SpecialFolder.LocalApplicationData</c>, which on
/// Windows is resolved by SHGetKnownFolderPath — the LOCALAPPDATA env
/// var is ignored. So each test stages its fixture at the REAL
/// %LOCALAPPDATA%/Dhruvanta Systems/PrintAnywhereAgent/ directory and
/// scrubs it on teardown. A live agent install on the CI runner would
/// fail these tests, but the GitHub Actions windows-latest runner
/// starts every job with a clean profile — there is none.
/// </summary>
public class InstallLayoutTests : IDisposable
{
    private readonly string _realInstallRoot;
    private readonly bool _preExisted;

    public InstallLayoutTests()
    {
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        _realInstallRoot = Path.Combine(localAppData, "Dhruvanta Systems", "PrintAnywhereAgent");
        _preExisted = Directory.Exists(_realInstallRoot);
        // Pre-condition: the install root must NOT exist when the test starts.
        // On a real developer / client PC this would be present (a live agent
        // install); these tests are intended for the windows-latest CI runner
        // which always starts clean. If the pre-condition fails we abort the
        // test rather than risk clobbering an operator's install.
        if (_preExisted)
        {
            throw new InvalidOperationException(
                "InstallLayoutTests refuses to run against a real PrintAnywhereAgent install at "
                + _realInstallRoot + ". Uninstall it first or run these tests on a clean runner.");
        }
    }

    public void Dispose()
    {
        // Clean up everything we created under the parent "Dhruvanta Systems"
        // directory — that whole subtree was empty when we started.
        try
        {
            string parent = Path.GetDirectoryName(_realInstallRoot)!;
            if (!_preExisted && Directory.Exists(parent))
            {
                Directory.Delete(parent, recursive: true);
            }
        }
        catch
        {
            // best-effort cleanup; xUnit will report any test failure separately.
        }
    }

    [Fact]
    public void DiscoverPrefersCanonicalRuntimeSubdirectoryForNode_KAN425()
    {
        var version = StageVersionDirectory("0.1.34");
        StageBundledNode(version, withRuntimePrefix: true);
        StageDistIndex(version);

        var layout = InstallLayout.Discover();

        Assert.Equal(Path.Combine(version, "runtime", "node-win-x64", "node.exe"),
                     layout.NodeExecutable);
        Assert.NotEqual("node.exe", layout.NodeExecutable);
    }

    [Fact]
    public void DiscoverFallsBackToLegacyNodePathWhenRuntimePrefixAbsent()
    {
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
        // through to a PATH "node.exe" lookup; the fix throws explicitly.
        var version = StageVersionDirectory("0.1.34");
        StageDistIndex(version);

        var ex = Assert.Throws<FileNotFoundException>(() => InstallLayout.Discover());

        Assert.Contains("Bundled Node runtime not found", ex.Message);
        Assert.Contains(Path.Combine("runtime", "node-win-x64", "node.exe"), ex.Message);
        Assert.Contains(Path.Combine("node-win-x64", "node.exe"), ex.Message);
    }

    [Fact]
    public void DiscoverPicksHighestSortingVersionWhenMultiplePresent()
    {
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
        // Default test-fixture state — _realInstallRoot does NOT exist.
        var ex = Assert.Throws<DirectoryNotFoundException>(() => InstallLayout.Discover());
        Assert.Contains("install root not found", ex.Message);
    }

    [Fact]
    public void DiscoverThrowsWhenVersionDirMissingFromInstallRoot()
    {
        Directory.CreateDirectory(_realInstallRoot);

        var ex = Assert.Throws<DirectoryNotFoundException>(() => InstallLayout.Discover());
        Assert.Contains("No printanywhere-agent-v* version directory", ex.Message);
    }

    [Fact]
    public void DiscoverThrowsWhenDistIndexJsMissing()
    {
        var version = StageVersionDirectory("0.1.34");
        StageBundledNode(version, withRuntimePrefix: true);
        // intentionally NO dist/index.js

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
        string path = Path.Combine(_realInstallRoot, "printanywhere-agent-v" + version);
        Directory.CreateDirectory(path);
        return path;
    }

    private static void StageBundledNode(string versionDir, bool withRuntimePrefix)
    {
        string nodeDir = withRuntimePrefix
            ? Path.Combine(versionDir, "runtime", "node-win-x64")
            : Path.Combine(versionDir, "node-win-x64");
        Directory.CreateDirectory(nodeDir);
        File.WriteAllText(Path.Combine(nodeDir, "node.exe"), "");
    }

    private static void StageDistIndex(string versionDir)
    {
        string distDir = Path.Combine(versionDir, "dist");
        Directory.CreateDirectory(distDir);
        File.WriteAllText(Path.Combine(distDir, "index.js"), "// stub");
    }
}
