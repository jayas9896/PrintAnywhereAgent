namespace Dhruvanta.PrintAnywhere.AgentTray;

/// <summary>
/// KAN-431 S4 — Centralised constants for values that were previously
/// hardcoded inside individual classes (most notably UpdateService).
///
/// The GitHub repo string in particular is the single source of truth
/// for the auto-updater's release-feed URL. Keeping it here means a
/// future org transfer (e.g. <c>Jayashanker-Padishala</c> →
/// <c>dhruvanta</c>) is a one-file change instead of a grep-and-pray
/// across the C# tree.
///
/// AGENT_PUBLISHER mirrors the Node side's <c>defaults.ts</c> contract
/// so any future C# code path that needs to render or compare the
/// publisher string doesn't reintroduce a string literal.
/// </summary>
internal static class AgentConstants
{
    /// <summary>
    /// GitHub owner/repo slug for the public PrintAnywhereAgent
    /// release feed. Update if the repo is transferred to a different
    /// owner or renamed.
    /// </summary>
    public const string GithubRepo = "Jayashanker-Padishala/PrintAnywhereAgent";

    /// <summary>
    /// Base URL for the public GitHub REST API. Lifted out of
    /// UpdateService alongside <see cref="GithubRepo"/> so the two
    /// pieces of the release-feed URL live in one place.
    /// </summary>
    public const string GithubApiBase = "https://api.github.com";

    /// <summary>
    /// Publisher / manufacturer string. Mirrors the
    /// <c>Company</c>/<c>Manufacturer</c> metadata in
    /// <c>PrintAnywhereAgent.Tray.csproj</c> and
    /// <c>Product.wxs</c>, and the Node side's AGENT_PUBLISHER
    /// contract in <c>src/config/defaults.ts</c>.
    /// </summary>
    public const string AgentPublisher = "Dhruvanta Systems";

    /// <summary>
    /// KAN-431 S1 — the EXACT Organization (<c>O=</c>) RDN that the
    /// auto-updater requires on the downloaded installer's Authenticode
    /// signing certificate. This is the company's full LEGAL name as it
    /// appears on the SSL.com code-signing certificate
    /// (<c>O=Dhruvanta Systems Private Limited</c>), which is deliberately
    /// DIFFERENT from <see cref="AgentPublisher"/> ("Dhruvanta Systems",
    /// the product/manufacturer display string used by Product.wxs and the
    /// Node defaults). Do NOT collapse the two — the cert O= must match
    /// this verbatim or the update is rejected before msiexec runs.
    /// </summary>
    public const string ExpectedSigningPublisherO = "Dhruvanta Systems Private Limited";
}
