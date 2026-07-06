import { describe, expect, it } from "vitest";
import {
  buildCollisionReport,
  buildConfigQuality,
  buildContributorIntakeHealth,
  buildLabelAudit,
  buildLaneAdvice,
  buildMaintainerCutReadiness,
  buildQueueHealth,
} from "../../src/signals/engine";
import { parseFocusManifest } from "../../src/signals/focus-manifest";
import { buildGittensorConfigRecommendation, buildRegistrationReadiness, type InstallationHealthSummary } from "../../src/signals/registration-readiness";
import type { IssueRecord, PullRequestRecord, RepoLabelRecord, RegistryRepoConfig, RepositoryRecord, RepositorySettings } from "../../src/types";

const FORBIDDEN_PUBLIC_LANGUAGE = /wallet|hotkey|payout|reward estimate|raw trust score|public score estimate|private reviewability|farming/i;

function repoFor(fullName: string, registryConfig: RegistryRepoConfig | null, overrides: Partial<RepositoryRecord> = {}): RepositoryRecord {
  const [owner, name] = fullName.split("/");
  return {
    fullName,
    owner: owner ?? fullName,
    name: name ?? fullName,
    installationId: 1,
    isInstalled: true,
    isRegistered: registryConfig !== null,
    isPrivate: false,
    registryConfig,
    ...overrides,
  };
}

function configFor(overrides: Partial<RegistryRepoConfig> = {}): RegistryRepoConfig {
  return { repo: "x/y", emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: { bug: 1.1 }, trustedLabelPipeline: true, maintainerCut: 0, raw: {}, ...overrides };
}

function settingsFor(repoFullName: string, overrides: Partial<RepositorySettings> = {}): RepositorySettings {
  return {
    repoFullName,
    commentMode: "detected_contributors_only",
    publicAudienceMode: "oss_maintainer",
    publicSignalLevel: "standard",
    checkRunMode: "enabled",
    checkRunDetailLevel: "standard",
    gateCheckMode: "off",
    regateSweepOrderMode: "staleness",
    reviewCheckMode: "disabled",
    gatePack: "gittensor",
    linkedIssueGateMode: "advisory",
    duplicatePrGateMode: "advisory",
    qualityGateMode: "advisory",
    slopGateMode: "off",
    mergeReadinessGateMode: "off",
    manifestPolicyGateMode: "off",
    selfAuthoredLinkedIssueGateMode: "advisory",
    firstTimeContributorGrace: false,
    slopAiAdvisory: false,
    qualityGateMinScore: null,
    autoLabelEnabled: true,
    gittensorLabel: "gittensor",
    createMissingLabel: true,
    publicSurface: "comment_and_label",
    includeMaintainerAuthors: false,
    requireLinkedIssue: false,
    backfillEnabled: true,
    privateTrustEnabled: true,
    aiReviewMode: "off",
    aiReviewByok: false,
    aiReviewAllAuthors: false, closeOwnerAuthors: false,
    ...overrides,
  };
}

const healthyInstall: InstallationHealthSummary = { status: "healthy", missingPermissions: [], missingEvents: [] };

function signalsFor(repo: RepositoryRecord, issues: IssueRecord[], pullRequests: PullRequestRecord[], labels: RepoLabelRecord[]) {
  const fullName = repo.fullName;
  const collisions = buildCollisionReport(fullName, issues, pullRequests);
  return {
    lane: buildLaneAdvice(repo, fullName),
    configQuality: buildConfigQuality(repo, issues, pullRequests, fullName),
    labelAudit: buildLabelAudit(repo, labels, issues, pullRequests, fullName),
    queueHealth: buildQueueHealth(repo, issues, pullRequests, collisions),
    maintainerCutReadiness: buildMaintainerCutReadiness(repo, issues, pullRequests, fullName, {}, collisions),
    contributorIntakeHealth: buildContributorIntakeHealth(repo, issues, pullRequests, fullName, collisions),
  };
}

function label(name: string): RepoLabelRecord {
  return { repoFullName: "x/y", name, isConfigured: true, observedCount: 3, payload: {} };
}

describe("buildRegistrationReadiness", () => {
  it("marks a clean, registered, direct-PR repo as ready across every evaluated dimension", () => {
    const repo = repoFor("octo/ready", configFor({ repo: "octo/ready" }));
    const issues: IssueRecord[] = [{ repoFullName: repo.fullName, number: 4, title: "Fix flaky cache test", state: "open", labels: ["bug"], linkedPrs: [] }];
    const settings = settingsFor(repo.fullName);
    const report = buildRegistrationReadiness({ repoFullName: repo.fullName, repo, settings, installation: healthyInstall, ...signalsFor(repo, issues, [], [label("bug")]) });

    expect(report).toMatchObject({
      ready: true,
      recommendedRegistrationMode: "direct_pr",
      issuePolicy: "direct_pr_no_issue_required",
      directPrReadiness: { ready: true },
      issueDiscoveryReadiness: { ready: true, recommendation: "recommended" },
      testCoverageHealth: { status: "gate_ready", trustedLabelPipelineReady: true, checkRunMode: "enabled" },
      githubApp: { installed: true, quietByDefault: true },
    });
    expect(report.queueHealth.level).toBe("low");
    expect(report.testCoverageHealth.requiredGate).toContain("npm run test:ci");
    expect(report.blockers).toHaveLength(0);
    expect(report.githubApp.warnings).toHaveLength(0);
    expect(report.labelPolicy.trustedPipelineReady).toBe(true);
  });

  it("blocks an unregistered repo and recommends direct-PR mode", () => {
    const repo = repoFor("octo/unregistered", null);
    const settings = settingsFor(repo.fullName, { publicSurface: "off" });
    const report = buildRegistrationReadiness({ repoFullName: repo.fullName, repo, settings, installation: null, ...signalsFor(repo, [], [], []) });

    expect(report.ready).toBe(false);
    expect(report.recommendedRegistrationMode).toBe("direct_pr");
    expect(report.blockers).toContain("Repository is not registered in the latest Gittensory registry snapshot.");
    expect(report.directPrReadiness.ready).toBe(false);
    expect(report.issueDiscoveryReadiness.recommendation).toBe("not_recommended");
    expect(report.warnings).toContain("GitHub App public surface is disabled; maintainers will not get comment/label assistance.");
  });

  it("warns when configured labels are missing and the per-PR test gate is unknown", () => {
    const repo = repoFor("octo/labels", configFor({ repo: "octo/labels", labelMultipliers: { bug: 1.1, feature: 2 } }));
    const issues: IssueRecord[] = [{ repoFullName: repo.fullName, number: 1, title: "Bug", state: "open", labels: ["bug"], linkedPrs: [] }];
    const settings = settingsFor(repo.fullName, { checkRunMode: "off" });
    const report = buildRegistrationReadiness({ repoFullName: repo.fullName, repo, settings, installation: healthyInstall, ...signalsFor(repo, issues, [], [label("bug")]) });

    expect(report.testCoverageHealth.status).toBe("gate_unknown");
    expect(report.testCoverageHealth.warnings).toEqual(["No trusted label pipeline is verified; trusted-label scoring should stay off until labels are validated."]);
    // Disabled check runs are intentional repo policy and must not produce a readiness warning.
    expect(report.warnings).not.toContain("Check runs are disabled, so Gittensory cannot surface a per-PR quality gate to maintainers.");
    expect(report.warnings).toContain('Configured registry label "feature" is missing from live GitHub labels.');
  });

  it("surfaces missing GitHub App permissions and events when a public surface is enabled", () => {
    const repo = repoFor("octo/perms", configFor({ repo: "octo/perms" }));
    const settings = settingsFor(repo.fullName);
    const installation: InstallationHealthSummary = { status: "needs_attention", missingPermissions: ["issues"], missingEvents: ["pull_request"] };
    const report = buildRegistrationReadiness({ repoFullName: repo.fullName, repo, settings, installation, ...signalsFor(repo, [], [], [label("bug")]) });

    expect(report.githubApp.warnings).toEqual(
      expect.arrayContaining(["GitHub App is missing permission(s) for the enabled public surface: issues.", "GitHub App is not subscribed to webhook event(s): pull_request."]),
    );
  });

  it("reports issue-discovery and split lanes from the registry config", () => {
    const splitRepo = repoFor("octo/split", configFor({ repo: "octo/split", emissionShare: 0.05, issueDiscoveryShare: 0.4 }));
    const split = buildRegistrationReadiness({ repoFullName: splitRepo.fullName, repo: splitRepo, settings: settingsFor(splitRepo.fullName), installation: healthyInstall, ...signalsFor(splitRepo, [], [], [label("bug")]) });
    expect(split).toMatchObject({ recommendedRegistrationMode: "split", issuePolicy: "split_pr_and_issue_discovery_enabled", issueDiscoveryReadiness: { recommendation: "enabled" } });

    const idRepo = repoFor("octo/id", configFor({ repo: "octo/id", emissionShare: 0.05, issueDiscoveryShare: 1 }));
    const idReport = buildRegistrationReadiness({ repoFullName: idRepo.fullName, repo: idRepo, settings: settingsFor(idRepo.fullName), installation: healthyInstall, ...signalsFor(idRepo, [], [], [label("bug")]) });
    expect(idReport).toMatchObject({ recommendedRegistrationMode: "issue_discovery", issuePolicy: "issue_discovery_enabled" });
  });

  it("keeps disabled check runs out of readiness warnings and reports all-PR GitHub App behavior", () => {
    const repo = repoFor("octo/all-prs", configFor({ repo: "octo/all-prs" }));
    const settings = settingsFor(repo.fullName, { checkRunMode: "off", commentMode: "all_prs", publicSurface: "comment_and_label" });
    const report = buildRegistrationReadiness({ repoFullName: repo.fullName, repo, settings, installation: healthyInstall, ...signalsFor(repo, [], [], [label("bug")]) });

    // Check runs are intentionally off by default; that must not produce a readiness penalty.
    expect(report.testCoverageHealth.status).toBe("gate_ready");
    expect(report.testCoverageHealth.checkRunMode).toBe("off");
    expect(report.testCoverageHealth.warnings).toEqual([]);
    expect(report.warnings).not.toContain("Check runs are disabled, so Gittensory cannot surface a per-PR quality gate to maintainers.");
    expect(report.githubApp.quietByDefault).toBe(false);
    expect(report.githubApp.behavior).toContain("for all PRs");
  });

  it("describes a quiet public surface while keeping the opt-in gate check enabled", () => {
    const repo = repoFor("octo/quiet-gate", configFor({ repo: "octo/quiet-gate" }));
    const settings = settingsFor(repo.fullName, { publicSurface: "off", gateCheckMode: "enabled", reviewCheckMode: "required" });
    const report = buildRegistrationReadiness({
      repoFullName: repo.fullName,
      repo,
      settings,
      installation: healthyInstall,
      ...signalsFor(repo, [], [], [label("bug")]),
    });

    expect(report.githubApp.behavior).toContain("stays quiet");
    expect(report.githubApp.behavior).toContain("opt-in gate check still enabled");
  });

  it("notes when the GitHub App is not installed", () => {
    const repo = repoFor("octo/uninstalled", configFor({ repo: "octo/uninstalled" }), { isInstalled: false, installationId: null });
    const report = buildRegistrationReadiness({ repoFullName: repo.fullName, repo, settings: settingsFor(repo.fullName), installation: null, ...signalsFor(repo, [], [], [label("bug")]) });

    expect(report.githubApp.installed).toBe(false);
    expect(report.githubApp.behavior).toBe("Gittensory would stay silent because the GitHub App is not installed.");
    expect(report.githubApp.warnings).toContain("GitHub App is not installed on this repo; maintainers will not get any automated assistance.");
  });

  it("warns about config attention and strained intake", () => {
    const repo = repoFor("octo/strained", configFor({ repo: "octo/strained" }));
    const base = signalsFor(repo, [], [], [label("bug")]);
    const report = buildRegistrationReadiness({
      repoFullName: repo.fullName,
      repo,
      settings: settingsFor(repo.fullName),
      installation: healthyInstall,
      ...base,
      configQuality: { ...base.configQuality, level: "needs_attention" },
      contributorIntakeHealth: { ...base.contributorIntakeHealth, level: "strained" },
    });

    expect(report.ready).toBe(false);
    expect(report.warnings).toEqual(
      expect.arrayContaining(["Repository config quality needs attention before registration promotion.", "Contributor intake is strained; expect more maintainer triage."]),
    );
  });

  it("keeps the report free of forbidden public language", () => {
    const repo = repoFor("octo/ready", configFor({ repo: "octo/ready" }));
    const report = buildRegistrationReadiness({ repoFullName: repo.fullName, repo, settings: settingsFor(repo.fullName), installation: healthyInstall, ...signalsFor(repo, [], [], [label("bug")]) });
    expect(JSON.stringify(report)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });

  it("threads focus-manifest policy warnings into owner readiness", () => {
    const repo = repoFor("octo/policy", configFor({ repo: "octo/policy" }));
    const report = buildRegistrationReadiness({
      repoFullName: repo.fullName,
      repo,
      settings: settingsFor(repo.fullName, { requireLinkedIssue: false }),
      installation: healthyInstall,
      ...signalsFor(repo, [], [], [label("bug")]),
      focusManifest: parseFocusManifest({
        wantedPaths: ["src/"],
        linkedIssuePolicy: "optional",
        testExpectations: ["Run npm run test:ci."],
      }),
    });

    expect(report.policyReadiness?.publicWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "direct_pr_policy_unclear" }),
      ]),
    );
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Direct PR entry policy is loose"),
      ]),
    );
  });

  it("produces a null onboardingPackPreview when no focusManifest is provided", () => {
    const repo = repoFor("octo/nomanifest", configFor({ repo: "octo/nomanifest" }));
    const report = buildRegistrationReadiness({
      repoFullName: repo.fullName,
      repo,
      settings: settingsFor(repo.fullName),
      installation: healthyInstall,
      ...signalsFor(repo, [], [], [label("bug")]),
    });

    expect(report.onboardingPackPreview).toBeNull();
  });

  it("produces an onboardingPackPreview with public-safe lanes when a focusManifest is provided", () => {
    const repo = repoFor("octo/manifest", configFor({ repo: "octo/manifest" }));
    const report = buildRegistrationReadiness({
      repoFullName: repo.fullName,
      repo,
      settings: settingsFor(repo.fullName),
      installation: healthyInstall,
      ...signalsFor(repo, [], [], [label("bug")]),
      focusManifest: parseFocusManifest({
        wantedPaths: ["src/signals/"],
        testExpectations: ["npm run test:ci"],
        linkedIssuePolicy: "required",
        preferredLabels: ["feature"],
        publicNotes: ["Keep PRs focused and tied to accepted scope."],
      }),
    });

    expect(report.onboardingPackPreview).not.toBeNull();
    expect(report.onboardingPackPreview?.source).toBe("policy_compiler");
    expect(report.onboardingPackPreview?.publicSafe).toBe(true);
    expect(report.onboardingPackPreview?.previewOnly).toBe(true);
    expect(report.onboardingPackPreview?.repoFullName).toBe("octo/manifest");
    expect(report.onboardingPackPreview?.contributionLanes.length).toBeGreaterThan(0);
    expect(JSON.stringify(report.onboardingPackPreview)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });

  it("onboardingPackPreview strips unsafe public notes via the policy compiler pipeline", () => {
    const repo = repoFor("octo/unsafe", configFor({ repo: "octo/unsafe" }));
    const report = buildRegistrationReadiness({
      repoFullName: repo.fullName,
      repo,
      settings: settingsFor(repo.fullName),
      installation: healthyInstall,
      ...signalsFor(repo, [], [], [label("bug")]),
      focusManifest: parseFocusManifest({
        wantedPaths: ["src/"],
        publicNotes: ["Maximize payout by contributing to wanted areas.", "Keep PRs focused."],
      }),
    });

    const preview = report.onboardingPackPreview;
    expect(preview).not.toBeNull();
    expect(JSON.stringify(preview)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
    expect(JSON.stringify(preview)).not.toContain("Maximize payout");
  });
});

describe("buildGittensorConfigRecommendation", () => {
  it("recommends a small issue-discovery slice and maintainer cut for a clean, registered repo", () => {
    const repo = repoFor("octo/ready", configFor({ repo: "octo/ready", emissionShare: 0.2 }));
    const issues: IssueRecord[] = [{ repoFullName: repo.fullName, number: 4, title: "Fix flaky cache test", state: "open", labels: ["bug"], linkedPrs: [] }];
    const signals = signalsFor(repo, issues, [], [label("bug")]);
    const recommendation = buildGittensorConfigRecommendation({ repoFullName: repo.fullName, repo, settings: settingsFor(repo.fullName), lane: signals.lane, configQuality: signals.configQuality, contributorIntakeHealth: signals.contributorIntakeHealth, maintainerCutReadiness: signals.maintainerCutReadiness });

    expect(recommendation).toMatchObject({
      privateOnly: true,
      recommended: { participationMode: "split", issueDiscoveryShare: 0.1, directPrShare: 0.9, maintainerCut: 0.3 },
    });
    expect(recommendation.reasons).toEqual(
      expect.arrayContaining(["Config and intake signals are strong enough to consider a small issue-discovery slice.", "Maintainer cut can be considered because config and queue signals are clean."]),
    );
    expect(recommendation.tradeoffs.length).toBeGreaterThanOrEqual(3);
  });

  it("acknowledges an existing issue-discovery lane and a linked-issue requirement in tradeoffs", () => {
    const repo = repoFor("octo/idlane", configFor({ repo: "octo/idlane", emissionShare: 0.05, issueDiscoveryShare: 1 }));
    const signals = signalsFor(repo, [], [], [label("bug")]);
    const recommendation = buildGittensorConfigRecommendation({ repoFullName: repo.fullName, repo, settings: settingsFor(repo.fullName, { requireLinkedIssue: true }), lane: signals.lane, configQuality: signals.configQuality, contributorIntakeHealth: signals.contributorIntakeHealth, maintainerCutReadiness: signals.maintainerCutReadiness });

    expect(recommendation.reasons).toContain("The current registry lane already routes meaningful work through issue discovery.");
    expect(recommendation.tradeoffs).toEqual(expect.arrayContaining([expect.stringContaining("Requiring a linked issue improves traceability")]));
  });

  it("preserves an existing maintainer cut and warns when intake is blocked", () => {
    const repo = repoFor("octo/existingcut", configFor({ repo: "octo/existingcut", emissionShare: 0.05, maintainerCut: 0.03 }));
    const base = signalsFor(repo, [], [], [label("bug")]);
    const recommendation = buildGittensorConfigRecommendation({
      repoFullName: repo.fullName,
      repo,
      settings: settingsFor(repo.fullName),
      lane: base.lane,
      configQuality: base.configQuality,
      contributorIntakeHealth: { ...base.contributorIntakeHealth, level: "blocked" },
      maintainerCutReadiness: { ...base.maintainerCutReadiness, ready: false },
    });

    expect(recommendation.recommended.maintainerCut).toBe(0.03);
    expect(recommendation.warnings).toContain("Contributor intake is blocked; avoid increasing noisy lanes yet.");
  });

  it("keeps issue discovery disabled and maintainer cut unchanged for a not-ready repo", () => {
    const repo = repoFor("octo/unregistered", null);
    const signals = signalsFor(repo, [], [], []);
    const recommendation = buildGittensorConfigRecommendation({ repoFullName: repo.fullName, repo, settings: settingsFor(repo.fullName), lane: signals.lane, configQuality: signals.configQuality, contributorIntakeHealth: signals.contributorIntakeHealth, maintainerCutReadiness: signals.maintainerCutReadiness });

    expect(recommendation.recommended.participationMode).toBe("direct_pr");
    expect(recommendation.recommended.issueDiscoveryShare).toBe(0);
    expect(recommendation.recommended.maintainerCut).toBe(0);
    expect(recommendation.current).toBeNull();
    expect(recommendation.reasons).toContain("Issue discovery should stay disabled until config quality and intake health are excellent.");
    expect(JSON.stringify(recommendation)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });
});
