using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace Dhruvanta.PrintAnywhere.AgentTray;

/// <summary>
/// Phase 2d — native auto-updater. Mirrors the contract that
/// scripts/check-update.ps1 has used in production:
///
/// <list type="number">
///   <item>Hit <c>https://api.github.com/repos/{owner}/{repo}/releases/latest</c></item>
///   <item>Compare returned <c>tag_name</c> against the running version</item>
///   <item>Find the setup asset (preferred: <c>*.msi</c> produced by
///     Phase 2c; fallback: legacy <c>*-setup.exe</c>) + the matching
///     <c>SHA256SUMS.txt</c></item>
///   <item>Download both to a fresh temp dir</item>
///   <item>Verify the downloaded setup's SHA-256 matches the entry in
///     <c>SHA256SUMS.txt</c></item>
///   <item>Stop the running Node sidecar</item>
///   <item>Execute the installer silently — <c>msiexec /i ... /quiet /norestart</c>
///     for MSI, <c>setup.exe /quiet /nolaunch</c> for legacy EXE</item>
///   <item>Restart the sidecar (the tray itself is replaced by the new
///     install once Phase 2c MSIs ship; for the legacy EXE path the
///     installer triggers its own scheduled-task restart)</item>
/// </list>
///
/// All network I/O is async; the UpdateWindow consumes the same
/// service via a CancellationToken so the operator can abort mid-
/// download.
/// </summary>
public sealed class UpdateService : IDisposable
{
    // KAN-431 S4 — repo + API base now live on AgentConstants so a
    // future org transfer is a single-file change. See AgentConstants.cs.
    private readonly HttpClient _http;
    private readonly Version _currentVersion;

    public UpdateService(Version currentVersion)
    {
        _currentVersion = currentVersion;
        _http = new HttpClient
        {
            DefaultRequestHeaders =
            {
                { "User-Agent", "PrintAnywhereAgentUpdater" },
                { "Accept", "application/vnd.github+json" },
            },
            Timeout = TimeSpan.FromMinutes(2),
        };
    }

    public async Task<UpdateCheckResult> CheckAsync(CancellationToken cancel = default)
    {
        var release = await FetchLatestReleaseAsync(cancel).ConfigureAwait(false);
        if (release is null)
        {
            return new UpdateCheckResult(_currentVersion, null, null, null, UpdateAvailability.NoReleaseFound);
        }

        Version latest;
        try { latest = ParseVersionTag(release.TagName); }
        catch
        {
            return new UpdateCheckResult(_currentVersion, null, null, null, UpdateAvailability.MalformedTag);
        }

        ReleaseAsset? setup = FindSetupAsset(release);
        ReleaseAsset? checksums = FindChecksumAsset(release);
        if (setup is null || checksums is null)
        {
            return new UpdateCheckResult(_currentVersion, latest, setup, checksums, UpdateAvailability.AssetsMissing);
        }

        UpdateAvailability avail = latest > _currentVersion
            ? UpdateAvailability.UpdateAvailable
            : (latest == _currentVersion
                ? UpdateAvailability.UpToDate
                : UpdateAvailability.AlreadyAhead);

        return new UpdateCheckResult(_currentVersion, latest, setup, checksums, avail);
    }

    /// <summary>
    /// Downloads the setup + checksums, verifies SHA-256, and returns
    /// the local setup file path. The caller is responsible for
    /// running it (so the call site can wrap with a "stop sidecar
    /// first" step that's UI-visible).
    /// </summary>
    public async Task<string> DownloadAndVerifyAsync(UpdateCheckResult result, IProgress<long>? bytes, CancellationToken cancel = default)
    {
        if (result.SetupAsset is null || result.ChecksumAsset is null)
        {
            throw new InvalidOperationException("Update check did not surface both a setup and a checksum asset.");
        }
        string tempDir = Path.Combine(Path.GetTempPath(), "PrintAnywhereAgentUpdate-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        string setupPath = Path.Combine(tempDir, result.SetupAsset.Name);
        string checksumPath = Path.Combine(tempDir, "SHA256SUMS.txt");

        await DownloadAsync(result.SetupAsset.BrowserDownloadUrl, setupPath, bytes, cancel).ConfigureAwait(false);
        await DownloadAsync(result.ChecksumAsset.BrowserDownloadUrl, checksumPath, null, cancel).ConfigureAwait(false);

        VerifyChecksum(setupPath, checksumPath, result.SetupAsset.Name);
        return setupPath;
    }

    public Task RunSilentInstallAsync(string setupPath, CancellationToken cancel = default)
    {
        var psi = new System.Diagnostics.ProcessStartInfo
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(setupPath) ?? Path.GetTempPath(),
        };
        // Phase 2c MSIs vs legacy Inno Setup EXEs need different
        // invocations. The release artifact extension dictates the
        // command line so we never need a flag baked into release.yml.
        if (Path.GetExtension(setupPath).Equals(".msi", StringComparison.OrdinalIgnoreCase))
        {
            psi.FileName = "msiexec.exe";
            psi.ArgumentList.Add("/i");
            psi.ArgumentList.Add(setupPath);
            psi.ArgumentList.Add("/quiet");
            psi.ArgumentList.Add("/norestart");
        }
        else
        {
            psi.FileName = setupPath;
            psi.ArgumentList.Add("/quiet");
            psi.ArgumentList.Add("/nolaunch");
        }

        var tcs = new TaskCompletionSource<int>();
        var process = new System.Diagnostics.Process { StartInfo = psi, EnableRaisingEvents = true };
        process.Exited += (_, _) => tcs.TrySetResult(process.ExitCode);
        if (!process.Start())
        {
            throw new InvalidOperationException($"Could not launch installer: {setupPath}");
        }
        cancel.Register(() =>
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { }
            tcs.TrySetCanceled();
        });
        return tcs.Task.ContinueWith(t =>
        {
            int code = t.Result;
            if (code != 0)
            {
                throw new InvalidOperationException($"Installer exited with code {code}.");
            }
        }, TaskScheduler.Default);
    }

    private async Task<GithubRelease?> FetchLatestReleaseAsync(CancellationToken cancel)
    {
        string url = $"{AgentConstants.GithubApiBase}/repos/{AgentConstants.GithubRepo}/releases/latest";
        var response = await _http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancel).ConfigureAwait(false);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<GithubRelease>(GithubReleaseJsonContext.Default.GithubRelease, cancel).ConfigureAwait(false);
    }

    private static ReleaseAsset? FindSetupAsset(GithubRelease release)
    {
        // Prefer MSI (Phase 2c output); fall back to the legacy
        // -setup.exe artifact still produced by the existing
        // release.yml until that workflow is updated to emit MSIs.
        foreach (var a in release.Assets)
        {
            if (a.Name.EndsWith(".msi", StringComparison.OrdinalIgnoreCase)) return a;
        }
        foreach (var a in release.Assets)
        {
            if (a.Name.EndsWith("-setup.exe", StringComparison.OrdinalIgnoreCase)) return a;
        }
        return null;
    }

    private static ReleaseAsset? FindChecksumAsset(GithubRelease release)
    {
        foreach (var a in release.Assets)
        {
            if (string.Equals(a.Name, "SHA256SUMS.txt", StringComparison.OrdinalIgnoreCase)) return a;
        }
        return null;
    }

    private static Version ParseVersionTag(string tag)
    {
        string trimmed = tag.TrimStart('v', 'V').Trim();
        return Version.Parse(trimmed);
    }

    private async Task DownloadAsync(string url, string targetPath, IProgress<long>? bytes, CancellationToken cancel)
    {
        using var response = await _http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancel).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        await using var source = await response.Content.ReadAsStreamAsync(cancel).ConfigureAwait(false);
        await using var dest = File.Create(targetPath);
        var buffer = new byte[81920];
        long total = 0;
        int read;
        while ((read = await source.ReadAsync(buffer, cancel).ConfigureAwait(false)) > 0)
        {
            await dest.WriteAsync(buffer.AsMemory(0, read), cancel).ConfigureAwait(false);
            total += read;
            bytes?.Report(total);
        }
    }

    private static void VerifyChecksum(string setupPath, string checksumPath, string setupName)
    {
        string expected = ResolveExpectedHash(checksumPath, setupName)
            ?? throw new InvalidOperationException($"SHA256SUMS.txt does not include {setupName}.");
        using var stream = File.OpenRead(setupPath);
        byte[] hash = SHA256.HashData(stream);
        string actual = Convert.ToHexString(hash).ToLowerInvariant();
        if (!string.Equals(expected, actual, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"Downloaded {setupName} failed SHA-256 verification. Expected {expected}, got {actual}.");
        }
    }

    private static string? ResolveExpectedHash(string checksumPath, string setupName)
    {
        // Format: "<64 hex> [*]<filename>" — same convention as
        // sha256sum(1) output. The file might include a "*" between
        // hash and filename (binary mode) or a plain space.
        foreach (string raw in File.ReadAllLines(checksumPath))
        {
            string line = raw.Trim();
            if (line.Length == 0) continue;
            int space = line.IndexOf(' ');
            if (space != 64) continue;
            string hash = line[..64];
            string filename = line[(space + 1)..].TrimStart('*').Trim();
            if (filename.EndsWith("/" + setupName, StringComparison.OrdinalIgnoreCase)
                || filename.EndsWith("\\" + setupName, StringComparison.OrdinalIgnoreCase)
                || string.Equals(filename, setupName, StringComparison.OrdinalIgnoreCase))
            {
                return hash.ToLowerInvariant();
            }
        }
        return null;
    }

    public void Dispose() => _http.Dispose();
}

public enum UpdateAvailability
{
    UpdateAvailable,
    UpToDate,
    AlreadyAhead,
    NoReleaseFound,
    AssetsMissing,
    MalformedTag,
}

public sealed record UpdateCheckResult(
    Version CurrentVersion,
    Version? LatestVersion,
    ReleaseAsset? SetupAsset,
    ReleaseAsset? ChecksumAsset,
    UpdateAvailability Availability);

public sealed record ReleaseAsset(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("browser_download_url")] string BrowserDownloadUrl,
    [property: JsonPropertyName("size")] long Size);

public sealed record GithubRelease(
    [property: JsonPropertyName("tag_name")] string TagName,
    [property: JsonPropertyName("html_url")] string HtmlUrl,
    [property: JsonPropertyName("assets")] List<ReleaseAsset> Assets);

// JsonSerializerContext for trim-safe System.Text.Json (lets the
// project enable trimming later without losing GitHub parsing).
[JsonSerializable(typeof(GithubRelease))]
[JsonSerializable(typeof(ReleaseAsset))]
[JsonSerializable(typeof(List<ReleaseAsset>))]
internal partial class GithubReleaseJsonContext : JsonSerializerContext { }
