using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
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
    // KAN-431 R4 — a dedicated client for the (potentially 50 MB) asset
    // download. HttpClient.Timeout is a TOTAL-operation ceiling that keeps
    // running while the body stream is read under ResponseHeadersRead, so
    // the 2-min check client would kill a large download mid-stream no
    // matter what CancellationToken we layer on. A separate 10-min client
    // raises that ceiling for the download path only, leaving the check
    // path's tight 2-min timeout intact.
    private readonly HttpClient _downloadHttp;
    private readonly Version _currentVersion;

    // KAN-431 R4 — number of full download attempts before giving up, and
    // the suffix used for the resumable partial file.
    private const int MaxDownloadAttempts = 3;
    private const string PartialSuffix = ".partial";

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
        _downloadHttp = new HttpClient
        {
            DefaultRequestHeaders =
            {
                { "User-Agent", "PrintAnywhereAgentUpdater" },
            },
            // Generous ceiling for a large MSI on flaky shop wifi.
            Timeout = TimeSpan.FromMinutes(10),
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

        await DownloadAsync(result.SetupAsset.BrowserDownloadUrl, setupPath, result.SetupAsset.Size, bytes, cancel).ConfigureAwait(false);
        await DownloadAsync(result.ChecksumAsset.BrowserDownloadUrl, checksumPath, null, null, cancel).ConfigureAwait(false);

        VerifyChecksum(setupPath, checksumPath, result.SetupAsset.Name);

        // KAN-431 S1 — Authenticode publisher gate. The SHA-256 check above
        // only proves the download matches the SHA256SUMS.txt that came from
        // the SAME release; it does not prove WHO produced the release. This
        // layered check requires the installer to carry a valid, fully
        // chained Authenticode signature whose certificate Organization is
        // our exact legal name. It runs AFTER (never instead of) the SHA-256
        // check and BEFORE the path is returned to the caller that hands it
        // to msiexec — so a tampered/unsigned/foreign-signed installer aborts
        // the update before any code runs.
        //
        // FAIL-CLOSED posture: if a future release is ever published UNSIGNED
        // (e.g. the eSigner ES_* secrets are removed and release.yml takes its
        // graceful-skip path), WinVerifyTrust returns TRUST_E_NOSIGNATURE and
        // this gate REJECTS the update. S1 clients then correctly refuse to
        // auto-update until a properly signed release is cut again. That is
        // the intended, safe behaviour.
        VerifyAuthenticodePublisher(setupPath);

        return setupPath;
    }

    /// <summary>
    /// KAN-431 S1 — requires the installer at <paramref name="setupPath"/>
    /// to be Authenticode-signed with (1) a valid signature chained to a
    /// trusted root with whole-chain revocation checking, AND (2) a signing
    /// certificate whose Organization (<c>O=</c>) RDN equals
    /// <see cref="AgentConstants.ExpectedSigningPublisherO"/> verbatim.
    /// Throws <see cref="InvalidOperationException"/> if either fails.
    ///
    /// A timestamped signature stays valid past the signing certificate's
    /// expiry, so there is deliberately NO manual expiry rejection here —
    /// WinVerifyTrust + the embedded timestamp handle lifetime correctly.
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static void VerifyAuthenticodePublisher(string setupPath)
    {
        // (1) Signature + chain validity via WinVerifyTrust.
        int trust = WinVerifyTrustFile(setupPath);
        if (trust != 0)
        {
            throw new InvalidOperationException(
                "Update rejected: installer is not signed by "
                + $"{AgentConstants.ExpectedSigningPublisherO} "
                + $"(Authenticode chain verification failed, WinVerifyTrust=0x{trust:X8}).");
        }

        // (2) Publisher Organization (O=) RDN must match our legal name.
        string organization;
        try
        {
            using var basic = X509Certificate.CreateFromSignedFile(setupPath);
            using var cert = new X509Certificate2(basic);
            organization = ExtractOrganization(cert);
        }
        catch (Exception ex) when (ex is not InvalidOperationException)
        {
            // No embedded cert / unreadable signature — treat as unsigned.
            throw new InvalidOperationException(
                "Update rejected: installer is not signed by "
                + $"{AgentConstants.ExpectedSigningPublisherO} "
                + "(publisher certificate could not be read).", ex);
        }

        if (!string.Equals(organization, AgentConstants.ExpectedSigningPublisherO, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "Update rejected: installer is not signed by "
                + $"{AgentConstants.ExpectedSigningPublisherO} "
                + $"(publisher Organization was '{organization}').");
        }
    }

    /// <summary>
    /// Extracts the Organization (<c>O=</c>) RDN from the certificate
    /// subject. The subject is a single DN string whose RDN values can in
    /// principle contain commas, so we do NOT naively split on ','; we match
    /// the <c>O=</c> component specifically. Returns an empty string if no
    /// <c>O=</c> RDN is present (which then fails the exact-match gate).
    /// </summary>
    private static string ExtractOrganization(X509Certificate2 cert)
    {
        // Subject is e.g.
        //   "CN=Dhruvanta Systems Private Limited, O=Dhruvanta Systems Private Limited, L=Warangal, S=Telangana, C=IN"
        // Match the O= RDN at string start or after a comma+optional space.
        var match = Regex.Match(
            cert.Subject,
            @"(?:^|,\s*)O=(?<org>[^,]+)",
            RegexOptions.IgnoreCase);
        return match.Success ? match.Groups["org"].Value.Trim() : string.Empty;
    }

    // ---- WinVerifyTrust P/Invoke (KAN-431 S1) -------------------------------

    private static readonly Guid WINTRUST_ACTION_GENERIC_VERIFY_V2 =
        new("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");

    private const uint WTD_UI_NONE = 2;
    private const uint WTD_REVOKE_WHOLECHAIN = 1;
    private const uint WTD_CHOICE_FILE = 1;
    private const uint WTD_STATEACTION_VERIFY = 1;
    private const uint WTD_STATEACTION_CLOSE = 2;

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    private struct WINTRUST_FILE_INFO
    {
        public uint cbStruct;
        [MarshalAs(UnmanagedType.LPWStr)] public string pcwszFilePath;
        public IntPtr hFile;
        public IntPtr pgKnownSubject;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    private struct WINTRUST_DATA
    {
        public uint cbStruct;
        public IntPtr pPolicyCallbackData;
        public IntPtr pSIPClientData;
        public uint dwUIChoice;
        public uint fdwRevocationChecks;
        public uint dwUnionChoice;
        public IntPtr pFile;
        public uint dwStateAction;
        public IntPtr hWVTStateData;
        [MarshalAs(UnmanagedType.LPWStr)] public string pwszURLReference;
        public uint dwProvFlags;
        public uint dwUIContext;
        public IntPtr pSignatureSettings;
    }

    [DllImport("wintrust.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = false)]
    private static extern int WinVerifyTrust(IntPtr hwnd, ref Guid pgActionID, ref WINTRUST_DATA pWVTData);

    /// <summary>
    /// Runs <c>WinVerifyTrust</c> with
    /// <c>WINTRUST_ACTION_GENERIC_VERIFY_V2</c> over the file. Returns the
    /// trust verdict from the VERIFY call (0 = ERROR_SUCCESS = trusted; any
    /// other value is a HRESULT such as TRUST_E_NOSIGNATURE 0x800B0100 or
    /// CERT_E_UNTRUSTEDROOT 0x800B0111). The state allocated by the VERIFY
    /// call is always freed by a paired CLOSE call.
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static int WinVerifyTrustFile(string filePath)
    {
        var fileInfo = new WINTRUST_FILE_INFO
        {
            cbStruct = (uint)Marshal.SizeOf<WINTRUST_FILE_INFO>(),
            pcwszFilePath = filePath,
            hFile = IntPtr.Zero,
            pgKnownSubject = IntPtr.Zero,
        };

        IntPtr pFile = Marshal.AllocHGlobal(Marshal.SizeOf<WINTRUST_FILE_INFO>());
        Marshal.StructureToPtr(fileInfo, pFile, false);

        var data = new WINTRUST_DATA
        {
            cbStruct = (uint)Marshal.SizeOf<WINTRUST_DATA>(),
            pPolicyCallbackData = IntPtr.Zero,
            pSIPClientData = IntPtr.Zero,
            dwUIChoice = WTD_UI_NONE,
            fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN,
            dwUnionChoice = WTD_CHOICE_FILE,
            pFile = pFile,
            dwStateAction = WTD_STATEACTION_VERIFY,
            hWVTStateData = IntPtr.Zero,
            pwszURLReference = null!,
            dwProvFlags = 0,
            dwUIContext = 0,
            pSignatureSettings = IntPtr.Zero,
        };

        Guid action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        try
        {
            int verdict = WinVerifyTrust(IntPtr.Zero, ref action, ref data);
            return verdict;
        }
        finally
        {
            // Free the state allocated by the VERIFY call — same struct,
            // CLOSE action — then release the unmanaged file-info block.
            data.dwStateAction = WTD_STATEACTION_CLOSE;
            WinVerifyTrust(IntPtr.Zero, ref action, ref data);
            Marshal.DestroyStructure<WINTRUST_FILE_INFO>(pFile);
            Marshal.FreeHGlobal(pFile);
        }
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

    /// <summary>
    /// KAN-431 R4 — resumable, retrying download. Streams to
    /// <c>targetPath + ".partial"</c>; on a transient
    /// <see cref="IOException"/>/<see cref="HttpRequestException"/> it
    /// retries (up to <see cref="MaxDownloadAttempts"/>) sending a
    /// <c>Range</c> header to resume from the bytes already on disk.
    /// GitHub release assets honour Range and reply 206; if a server
    /// ignores Range and replies 200 (whole file from byte 0) we restart
    /// the partial file cleanly so it is never corrupted by appending.
    /// On full completion the partial is renamed to the final path. The
    /// SHA-256 verification in <see cref="VerifyChecksum"/> still runs
    /// AFTER this returns — unchanged.
    /// </summary>
    private async Task DownloadAsync(string url, string targetPath, long? expectedSize, IProgress<long>? bytes, CancellationToken cancel)
    {
        string partialPath = targetPath + PartialSuffix;
        Exception? lastTransient = null;

        for (int attempt = 1; attempt <= MaxDownloadAttempts; attempt++)
        {
            cancel.ThrowIfCancellationRequested();

            long existing = 0;
            if (File.Exists(partialPath))
            {
                existing = new FileInfo(partialPath).Length;
                // A stale partial at/over the expected size can't be
                // resumed (Range would 416) — start clean.
                if (expectedSize is long size && existing >= size && size > 0)
                {
                    File.Delete(partialPath);
                    existing = 0;
                }
            }

            // Each attempt gets its own request so the Range offset
            // reflects what is currently on disk.
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            if (existing > 0)
            {
                request.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(existing, null);
            }

            try
            {
                using var response = await _downloadHttp
                    .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancel)
                    .ConfigureAwait(false);
                response.EnsureSuccessStatusCode();

                // 206 Partial Content → server honoured Range, append.
                // Anything else (notably 200) → server sent the WHOLE
                // file from byte 0, so we must overwrite, not append, or
                // the file is corrupted. This is the clean-restart path.
                bool resumed = response.StatusCode == System.Net.HttpStatusCode.PartialContent;
                long total = resumed ? existing : 0;
                FileMode mode = resumed ? FileMode.Append : FileMode.Create;

                await using (var source = await response.Content.ReadAsStreamAsync(cancel).ConfigureAwait(false))
                await using (var dest = new FileStream(partialPath, mode, FileAccess.Write, FileShare.None))
                {
                    var buffer = new byte[81920];
                    int read;
                    bytes?.Report(total);
                    while ((read = await source.ReadAsync(buffer, cancel).ConfigureAwait(false)) > 0)
                    {
                        await dest.WriteAsync(buffer.AsMemory(0, read), cancel).ConfigureAwait(false);
                        total += read;
                        bytes?.Report(total);
                    }
                }

                // Success — promote the partial to the final path.
                File.Move(partialPath, targetPath, overwrite: true);
                return;
            }
            catch (OperationCanceledException)
            {
                // User abort or a fired per-download timeout — never
                // retry; let the caller see the cancellation.
                throw;
            }
            catch (Exception ex) when (ex is IOException or HttpRequestException)
            {
                // Transient network/disk blip — keep the partial file so
                // the next attempt resumes from where this one stopped.
                lastTransient = ex;
                cancel.ThrowIfCancellationRequested();
            }
        }

        throw new IOException(
            $"Download of {url} failed after {MaxDownloadAttempts} attempts.", lastTransient);
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

    public void Dispose()
    {
        _http.Dispose();
        _downloadHttp.Dispose();
    }
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
