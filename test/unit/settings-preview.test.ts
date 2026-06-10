import { describe, expect, it } from "vitest";
import { buildRepoSettingsPreview, decidePublicSurface, type InstallationHealthSummary } from "../../src/signals/settings-preview";
import { REQUIRED_INSTALLATION_PERMISSIONS } from "../../src/github/backfill";
import type { IssueRecord, PullRequestRecord, RepositoryRecord, RepositorySettings } from "../../src/types";

const FORBIDDEN_INSTALL_PREVIEW_PUBLIC_LANGUAGE =
  /\b(wallet|hotkey|coldkey|raw[-\s]?trust|trust[-\s]?score|reward[-\s]?estimate|payout|farming(?:[-\s]?language)?|private[-\s]?reviewability|private[-\s]?scoreability|scoreability|public[-\s]?score[-\s]?(?:estimate|prediction)|estimated[-\s]?score|score[-\s]?estimate)\b/i;

const repo: RepositoryRecord = {
  fullName: "entrius/allways-ui",
  owner: "entrius",
  name: "allways-ui",
  installationId: 1,
  isInstalled: true,
  isRegistered: true,
  isPrivate: false,
  registryConfig: {
    repo: "entrius/allways-ui",
    emissionShare: 0.01,
    issueDiscoveryShare: 0,
    labelMultipliers: { bug: 1.1 },
    trustedLabelPipeline: true,
    maintainerCut: 0,
    raw: {},
  },
};

const issues: IssueRecord[] = [
  { repoFullName: repo.fullName, number: 7, title: "Cache refresh fails", state: "open", authorLogin: "reporter", labels: ["bug"], linkedPrs: [] },
];
const pullRequests: PullRequestRecord[] = [];

function settings(overrides: Partial<RepositorySettings> = {}): RepositorySettings {
  return {
    repoFullName: repo.fullName,
    commentMode: "detected_contributors_only",
    publicAudienceMode: "oss_maintainer",
    publicSignalLevel: "standard",
    checkRunMode: "off",
    checkRunDetailLevel: "standard",
    gateCheckMode: "off",
    linkedIssueGateMode: "advisory",
    duplicatePrGateMode: "advisory",
    qualityGateMode: "advisory",
    qualityGateMinScore: null,
    autoLabelEnabled: true,
    gittensorLabel: "gittensor",
    createMissingLabel: true,
    publicSurface: "comment_and_label",
    includeMaintainerAuthors: false,
    requireLinkedIssue: false,
    backfillEnabled: true,
    privateTrustEnabled: true,
    ...overrides,
  };
}

const healthyInstall: InstallationHealthSummary = {
  installationId: 1,
  status: "healthy",
  missingPermissions: [],
  missingEvents: [],
  permissionRemediation: [{ permission: "issues", requiredAccess: "write", currentAccess: "write", ok: true, action: "No change needed." }],
};

describe("decidePublicSurface", () => {
  it("comments and labels for a confirmed miner when the surface is enabled", () => {
    const decision = decidePublicSurface({ settings: settings(), authorLogin: "miner", authorType: "User", authorAssociation: "NONE", minerStatus: "confirmed" });
    expect(decision).toMatchObject({ skipped: false, willComment: true, willLabel: true, willCheckRun: false });
    expect(decision.actions).toEqual(["comment", "label"]);
  });

  it("skips disabled surfaces, bots, maintainer authors, non-miners, and unavailable detection", () => {
    expect(decidePublicSurface({ settings: settings({ publicSurface: "off", checkRunMode: "off" }), authorLogin: "miner", minerStatus: "confirmed" }).skipReason).toBe("surface_off");
    expect(decidePublicSurface({ settings: settings(), authorLogin: null, minerStatus: "confirmed" }).skipReason).toBe("missing_author");
    expect(decidePublicSurface({ settings: settings(), authorLogin: "robot", authorType: "Bot", minerStatus: "confirmed" }).skipReason).toBe("bot_author");
    expect(decidePublicSurface({ settings: settings(), authorLogin: "app[bot]", minerStatus: "confirmed" }).skipReason).toBe("bot_author");
    expect(decidePublicSurface({ settings: settings(), authorLogin: "owner", authorAssociation: "OWNER", minerStatus: "confirmed" }).skipReason).toBe("maintainer_author");
    expect(decidePublicSurface({ settings: settings({ publicAudienceMode: "gittensor_only" }), authorLogin: "x", minerStatus: "not_found" }).skipReason).toBe("not_official_gittensor_miner");
    expect(decidePublicSurface({ settings: settings({ publicAudienceMode: "gittensor_only" }), authorLogin: "x", minerStatus: "unavailable" }).skipReason).toBe("miner_detection_unavailable");
    expect(decidePublicSurface({ settings: settings(), authorLogin: "x", minerStatus: "not_found" })).toMatchObject({ skipped: false, willComment: false, willLabel: false });
    expect(decidePublicSurface({ settings: settings({ commentMode: "all_prs" }), authorLogin: "x", minerStatus: "not_found" })).toMatchObject({ skipped: false, willComment: true, willLabel: false });
  });

  it("includes maintainer authors when configured", () => {
    const decision = decidePublicSurface({ settings: settings({ includeMaintainerAuthors: true }), authorLogin: "owner", authorAssociation: "OWNER", minerStatus: "confirmed" });
    expect(decision.skipped).toBe(false);
  });

  it("supports a check-run-only surface even when public comments are off", () => {
    const decision = decidePublicSurface({ settings: settings({ publicSurface: "off", checkRunMode: "enabled" }), authorLogin: "miner", minerStatus: "confirmed" });
    expect(decision).toMatchObject({ skipped: false, willComment: false, willLabel: false, willCheckRun: true });
    expect(decision.actions).toEqual(["check_run"]);
  });

  it("reports no action when the surface is visible but every action is disabled", () => {
    const decision = decidePublicSurface({
      settings: settings({ publicSurface: "label_only", autoLabelEnabled: false, commentMode: "off", checkRunMode: "off" }),
      authorLogin: "miner",
      minerStatus: "confirmed",
    });
    expect(decision).toMatchObject({ skipped: false, willComment: false, willLabel: false, willCheckRun: false, actions: ["none"] });
    expect(decision.summary).toMatch(/no surface action is enabled/);
  });
});

describe("buildRepoSettingsPreview", () => {
  const base = { repoFullName: repo.fullName, repo, issues, pullRequests };

  it("previews a confirmed-miner PR on a healthy install with no warnings", () => {
    const preview = buildRepoSettingsPreview({ ...base, settings: settings(), installation: healthyInstall, sample: { authorLogin: "miner", minerStatus: "confirmed" } });
    expect(preview.decision.willComment).toBe(true);
    expect(preview.appliedLabel).toBe("gittensor");
    expect(preview.previewComment).toContain("<!-- gittensory-pr-panel:v1 -->");
    expect(preview.previewComment).toContain("Gittensory");
    expect(preview.previewComment).toContain("Confirmed Gittensor contributor");
    expect(preview.warnings).toHaveLength(0);
    expect(preview.installPreview).toMatchObject({
      status: "ready",
      permissions: { status: "ready", required: expect.arrayContaining(["metadata: read", "pull_requests: read", "issues: write"]) },
      publicOutputs: expect.arrayContaining(["One sanitized sticky PR comment.", 'Configured label "gittensor".']),
      checklist: expect.arrayContaining([
        expect.objectContaining({ id: "permissions", status: "ready" }),
        expect.objectContaining({ id: "public-outputs", status: "ready" }),
        expect.objectContaining({ id: "private-context", status: "ready" }),
        expect.objectContaining({ id: "command-authorization", status: "ready" }),
        expect.objectContaining({ id: "audit-behavior", status: "ready" }),
        expect.objectContaining({ id: "sanitizer-boundaries", status: "ready" }),
        expect.objectContaining({ id: "manual-controls", status: "ready" }),
      ]),
    });
    expect(preview.installPreview.readScope.join(" ")).toMatch(/repository metadata/i);
    expect(preview.installPreview.computedContext.join(" ")).toMatch(/Public surface decision/i);
    expect(preview.installPreview.privateOnlyContext.join(" ")).toMatch(/authenticated-only/i);
    expect(preview.installPreview.commandAuthorization.join(" ")).toMatch(/Maintainer-only commands/i);
    expect(preview.installPreview.auditBehavior.join(" ")).toMatch(/read-only/i);
    expect(preview.installPreview.manualControls.join(" ")).toMatch(/repo settings/i);
    expect(
      JSON.stringify([
        preview.installPreview.publicOutputs,
        preview.installPreview.sanitizerBoundaries,
        preview.installPreview.manualControls,
        preview.installPreview.checklist.map((item) => [item.summary, item.action]),
      ]),
    ).not.toMatch(FORBIDDEN_INSTALL_PREVIEW_PUBLIC_LANGUAGE);
  });

  it("uses safe defaults for an empty sample preview", () => {
    const preview = buildRepoSettingsPreview({ ...base, settings: settings(), installation: healthyInstall, sample: {} });
    expect(preview.sample).toMatchObject({ authorLogin: "sample-contributor", authorType: "User", authorAssociation: "NONE", minerStatus: "confirmed", title: "Sample pull request" });
    expect(preview.decision.skipped).toBe(false);
  });

  it("explains a missing Issues: write permission", () => {
    const preview = buildRepoSettingsPreview({
      ...base,
      settings: settings(),
      installation: { ...healthyInstall, status: "needs_attention", missingPermissions: ["issues"] },
      sample: { authorLogin: "miner", minerStatus: "confirmed" },
    });
    expect(preview.warnings.some((warning) => /Issues: write/.test(warning))).toBe(true);
    expect(preview.installPreview.status).toBe("needs_attention");
    expect(preview.installPreview.permissions).toMatchObject({ status: "needs_attention", missing: ["issues"] });
    expect(preview.installPreview.checklist.find((item) => item.id === "permissions")).toMatchObject({
      status: "needs_attention",
      action: expect.stringContaining("approve the missing permission"),
    });
  });

  it("requires only pull_requests:read for PR comment/label output (no PR write overprivilege)", () => {
    // Installation grants issues:write (everything comment/label output actually needs) but is missing
    // pull_requests; the app only reads PRs, so this must NOT be flagged as a comment/label blocker.
    const preview = buildRepoSettingsPreview({
      ...base,
      settings: settings(),
      installation: { ...healthyInstall, missingPermissions: ["pull_requests"] },
      sample: { authorLogin: "miner", minerStatus: "confirmed" },
    });
    expect(preview.installPreview.permissions.required).toContain("pull_requests: read");
    expect(preview.installPreview.permissions.required).not.toContain("pull_requests: write");
    expect(preview.installPreview.permissions.missing).not.toContain("pull_requests");
  });

  it("explains a missing optional Checks: write permission only when check runs are enabled", () => {
    const withChecks = buildRepoSettingsPreview({
      ...base,
      settings: settings({ checkRunMode: "enabled" }),
      installation: { ...healthyInstall, status: "needs_attention", missingPermissions: ["checks"] },
      sample: { authorLogin: "miner", minerStatus: "confirmed" },
    });
    expect(withChecks.checkRun).toMatchObject({ willCreate: true });
    expect(withChecks.warnings.some((warning) => /Checks: write/.test(warning))).toBe(true);

    const withoutChecks = buildRepoSettingsPreview({
      ...base,
      settings: settings({ checkRunMode: "off" }),
      installation: { ...healthyInstall, missingPermissions: ["checks"] },
      sample: { authorLogin: "miner", minerStatus: "confirmed" },
    });
    expect(withoutChecks.checkRun).toBeNull();
    expect(withoutChecks.warnings.some((warning) => /Checks: write/.test(warning))).toBe(false);
  });

  it("requires Issues: write for detected-contributors comment mode even when previewing a non-confirmed sample", () => {
    // detected_contributors_only + comment_only comments for confirmed miners, so the repo needs
    // issues:write regardless of the previewed sample's miner status. Previewing a non-confirmed
    // author must not drop the required (and missing) issues permission.
    const preview = buildRepoSettingsPreview({
      ...base,
      settings: settings({ publicSurface: "comment_only", commentMode: "detected_contributors_only", autoLabelEnabled: false, publicAudienceMode: "oss_maintainer" }),
      installation: { ...healthyInstall, status: "needs_attention", missingPermissions: ["issues"] },
      sample: { authorLogin: "contributor", minerStatus: "not_found" },
    });
    expect(preview.decision).toMatchObject({ skipped: false, willComment: false, willLabel: false });
    expect(preview.installPreview.permissions.required).toContain("issues: write");
    expect(preview.installPreview.permissions.missing).toContain("issues");
  });

  it("explains a missing Checks: write permission when the opt-in gate is enabled", () => {
    const preview = buildRepoSettingsPreview({
      ...base,
      settings: settings({ publicSurface: "off", commentMode: "off", autoLabelEnabled: false, gateCheckMode: "enabled" }),
      installation: { ...healthyInstall, status: "needs_attention", missingPermissions: ["checks"] },
      sample: { authorLogin: "contributor", minerStatus: "not_found" },
    });

    expect(preview.decision).toMatchObject({ skipped: false, actions: ["none"] });
    expect(preview.warnings.some((warning) => /Gate checks are enabled.*Checks: write/.test(warning))).toBe(true);
    expect(preview.installPreview.permissions).toMatchObject({ status: "needs_attention", missing: ["checks"] });
    expect(preview.installPreview.publicOutputs).toEqual(expect.arrayContaining(["Opt-in Gittensory Gate check run."]));
  });

  it("shows a quiet skip for a non-miner author with no rendered comment", () => {
    const preview = buildRepoSettingsPreview({ ...base, settings: settings({ publicAudienceMode: "gittensor_only" }), installation: healthyInstall, sample: { authorLogin: "drive-by", minerStatus: "not_found" } });
    expect(preview.decision).toMatchObject({ skipped: true, skipReason: "not_official_gittensor_miner" });
    expect(preview.previewComment).toBeNull();
    expect(preview.appliedLabel).toBeNull();
  });

  it("warns that label-only mode still needs Issues: write", () => {
    const preview = buildRepoSettingsPreview({
      ...base,
      settings: settings({ publicSurface: "label_only", autoLabelEnabled: true, commentMode: "off" }),
      installation: { ...healthyInstall, status: "needs_attention", missingPermissions: ["issues"] },
      sample: { authorLogin: "miner", minerStatus: "confirmed" },
    });
    // Labels are applied through the GitHub Issues API, so label-only mode still requires Issues: write.
    expect(preview.decision).toMatchObject({ willComment: false, willLabel: true });
    expect(preview.appliedLabel).toBe("gittensor");
    expect(preview.warnings.some((warning) => /Issues: write/.test(warning))).toBe(true);
  });

  it("shows the default maintainer-author skip", () => {
    const preview = buildRepoSettingsPreview({ ...base, settings: settings(), installation: healthyInstall, sample: { authorLogin: "owner", authorAssociation: "OWNER", minerStatus: "confirmed" } });
    expect(preview.decision.skipReason).toBe("maintainer_author");
    expect(preview.previewComment).toBeNull();
  });

  it("warns when installation health is unknown", () => {
    const preview = buildRepoSettingsPreview({ ...base, settings: settings(), installation: null, sample: { authorLogin: "miner", minerStatus: "confirmed" } });
    expect(preview.warnings.some((warning) => /Installation health is unknown/.test(warning))).toBe(true);
    expect(preview.installPreview).toMatchObject({
      status: "blocked",
      permissions: { status: "blocked", required: expect.arrayContaining(["issues: write"]), missing: [], missingEvents: [] },
    });
    expect(preview.installPreview.checklist.find((item) => item.id === "permissions")).toMatchObject({ status: "blocked" });
  });

  it("explains missing webhook event subscriptions", () => {
    const preview = buildRepoSettingsPreview({
      ...base,
      settings: settings(),
      installation: { ...healthyInstall, status: "needs_attention", missingEvents: ["pull_request"] },
      sample: { authorLogin: "miner", minerStatus: "confirmed" },
    });
    expect(preview.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/pull_request webhook event/)]));
    expect(preview.installPreview.permissions).toMatchObject({ status: "needs_attention", missingEvents: ["pull_request"] });
  });

  it("falls back to the installation status warning when no specific remediation is available", () => {
    const preview = buildRepoSettingsPreview({
      ...base,
      settings: settings(),
      installation: { ...healthyInstall, status: "broken" },
      sample: { authorLogin: "miner", minerStatus: "confirmed" },
    });
    expect(preview.warnings).toEqual(["Installation status is broken; review the installation health endpoint for remediation steps."]);
    expect(preview.installPreview.status).toBe("blocked");
    expect(preview.installPreview.permissions.summary).toMatch(/broken/i);
  });

  it("marks broad all-PR output as needing maintainer attention before enablement", () => {
    const preview = buildRepoSettingsPreview({
      ...base,
      settings: settings({ commentMode: "all_prs" }),
      installation: healthyInstall,
      sample: { authorLogin: "miner", minerStatus: "confirmed" },
    });
    expect(preview.installPreview.status).toBe("needs_attention");
    expect(preview.installPreview.checklist.find((item) => item.id === "public-outputs")).toMatchObject({
      status: "needs_attention",
      action: expect.stringContaining("advisory-only"),
    });
    expect(preview.installPreview.checklist.find((item) => item.id === "manual-controls")).toMatchObject({
      status: "needs_attention",
      action: expect.stringContaining("all-PR mode"),
    });
  });

  it("never leaks private scoring/trust terms into the preview comment (sanitizer regression)", () => {
    const preview = buildRepoSettingsPreview({
      ...base,
      settings: settings(),
      installation: healthyInstall,
      sample: { authorLogin: "miner", minerStatus: "confirmed", title: "Improve wallet hotkey trust score payout", body: "raw trust and scoreability /100 reviewability 5", labels: ["bug"], linkedIssues: [7] },
    });
    expect(preview.previewComment).not.toBeNull();
    expect(preview.previewComment ?? "").toMatch(/Readiness score: \d+\/100/);
    expect(preview.previewComment ?? "").not.toMatch(/wallet|hotkey|trust score|raw trust|scoreability|payout|reward|farming|reviewability\s*\d/i);
  });

  it("reports a generic needs-attention summary when health is degraded but no permission or event is missing", () => {
    const preview = buildRepoSettingsPreview({
      ...base,
      settings: settings(),
      installation: { ...healthyInstall, status: "needs_attention", missingPermissions: [], missingEvents: [] },
      sample: { authorLogin: "miner", minerStatus: "confirmed" },
    });
    expect(preview.installPreview.status).toBe("needs_attention");
    expect(preview.installPreview.permissions.summary).toMatch(/needs attention; review remediation/i);
    expect(preview.installPreview.permissions.missing).toEqual([]);
  });

  it("requires no issues/checks write scope and lists a no-output sample when every public action is disabled", () => {
    const preview = buildRepoSettingsPreview({
      ...base,
      settings: settings({ publicSurface: "label_only", autoLabelEnabled: false, commentMode: "off", checkRunMode: "off" }),
      installation: healthyInstall,
      sample: { authorLogin: "miner", minerStatus: "confirmed" },
    });
    expect(preview.decision).toMatchObject({ skipped: false, willComment: false, willLabel: false, willCheckRun: false, actions: ["none"] });
    // requiredInstallPermissions keeps only read scopes when no public write action is enabled.
    expect(preview.installPreview.permissions.required).toEqual(["metadata: read", "pull_requests: read"]);
    expect(preview.installPreview.publicOutputs).toEqual(["No public comment, label, or check run for this sample."]);
    expect(preview.installPreview.checklist.find((item) => item.id === "public-outputs")?.summary).toMatch(/no public output action is enabled/i);
  });

  it("derives read-only base permissions from REQUIRED_INSTALLATION_PERMISSIONS so the preview stays in sync with the canonical constant", () => {
    // Regression: settings-preview previously hardcoded ["metadata: read", "pull_requests: read"] instead
    // of reading from REQUIRED_INSTALLATION_PERMISSIONS, so any change to the constant would leave the
    // preview silently stale (issue #419/#420 pattern).
    const readEntries = Object.entries(REQUIRED_INSTALLATION_PERMISSIONS).filter(([, v]) => v === "read");
    const expectedReadPerms = readEntries.map(([k, v]) => `${k}: ${v}`).sort();

    const preview = buildRepoSettingsPreview({
      ...base,
      settings: settings({ publicSurface: "label_only", autoLabelEnabled: false, commentMode: "off", checkRunMode: "off" }),
      installation: healthyInstall,
      sample: { authorLogin: "miner", minerStatus: "confirmed" },
    });

    const actualReadPerms = (preview.installPreview.permissions.required as string[]).filter((p) => p.endsWith(": read")).sort();
    expect(actualReadPerms).toEqual(expectedReadPerms);
  });
});
