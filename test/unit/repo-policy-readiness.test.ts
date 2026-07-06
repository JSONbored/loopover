import { describe, expect, it } from "vitest";
import { isFocusManifestPublicSafe, parseFocusManifest } from "../../src/signals/focus-manifest";
import {
  buildRepoPolicyReadiness,
  policyReadinessWarningText,
  type RepoPolicyReadinessInput,
} from "../../src/signals/repo-policy-readiness";
import type { ConfigQuality, ContributorIntakeHealth, LabelAudit, LaneAdvice, QueueHealth } from "../../src/signals/engine";
import type { RepositorySettings } from "../../src/types";

const FORBIDDEN_PUBLIC_LANGUAGE =
  /wallet|hotkey|coldkey|mnemonic|payout|reward estimate|raw trust|trust score|public score|private reviewability|private scoreability|farming/i;

function settings(overrides: Partial<RepositorySettings> = {}): RepositorySettings {
  return {
    repoFullName: "owner/repo",
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

function lane(overrides: Partial<LaneAdvice> = {}): LaneAdvice {
  return {
    lane: "direct_pr",
    repoFullName: "owner/repo",
    summary: "Direct PR lane.",
    contributorGuidance: "Open focused pull requests.",
    maintainerGuidance: "Review focused pull requests.",
    ...overrides,
  };
}

function queue(overrides: Partial<QueueHealth> = {}): QueueHealth {
  return {
    repoFullName: "owner/repo",
    generatedAt: "2026-06-03T00:00:00.000Z",
    burdenScore: 10,
    level: "low",
    summary: "Queue burden is low.",
    signals: {
      openIssues: 1,
      openPullRequests: 1,
      unlinkedPullRequests: 0,
      stalePullRequests: 0,
      draftPullRequests: 0,
      maintainerAuthoredPullRequests: 0,
      collisionClusters: 0,
      ageBuckets: { under7Days: 1, days7To30: 0, over30Days: 0 },
      likelyReviewablePullRequests: 1,
    },
    findings: [],
    ...overrides,
  };
}

function config(overrides: Partial<ConfigQuality> = {}): ConfigQuality {
  return {
    repoFullName: "owner/repo",
    generatedAt: "2026-06-03T00:00:00.000Z",
    score: 100,
    level: "excellent",
    lane: lane(),
    configuredLabels: ["bug"],
    observedLabels: ["bug"],
    notObservedConfiguredLabels: [],
    findings: [],
    ...overrides,
  };
}

function labels(overrides: Partial<LabelAudit> = {}): LabelAudit {
  return {
    repoFullName: "owner/repo",
    generatedAt: "2026-06-03T00:00:00.000Z",
    configuredLabels: ["bug"],
    liveLabels: ["bug"],
    observedLabels: [{ name: "bug", count: 2, configured: true, existsOnGitHub: true }],
    missingConfiguredLabels: [],
    suspiciousConfiguredLabels: [],
    trustedPipelineReady: true,
    findings: [],
    ...overrides,
  };
}

function intake(overrides: Partial<ContributorIntakeHealth> = {}): ContributorIntakeHealth {
  const queueHealth = queue();
  return {
    repoFullName: "owner/repo",
    generatedAt: "2026-06-03T00:00:00.000Z",
    level: "healthy",
    score: 90,
    queueHealth: {
      burdenScore: queueHealth.burdenScore,
      level: queueHealth.level,
      signals: queueHealth.signals,
    },
    configLevel: "excellent",
    duplicateClusters: 0,
    reviewablePullRequests: 1,
    summary: "Contributor intake is healthy.",
    findings: [],
    ...overrides,
  };
}

function input(overrides: Partial<RepoPolicyReadinessInput> = {}): RepoPolicyReadinessInput {
  return {
    repoFullName: "owner/repo",
    focusManifest: parseFocusManifest({
      wantedPaths: ["src/"],
      linkedIssuePolicy: "required",
      testExpectations: ["Run npm run test:ci."],
      publicNotes: ["Prefer small, focused pull requests."],
    }),
    settings: settings({ requireLinkedIssue: true }),
    lane: lane(),
    configQuality: config(),
    labelAudit: labels(),
    queueHealth: queue(),
    contributorIntakeHealth: intake(),
    ...overrides,
  };
}

describe("buildRepoPolicyReadiness", () => {
  it("summarizes a clean policy when no warnings are present", () => {
    const report = buildRepoPolicyReadiness(input());

    expect(report.publicWarnings).toEqual([]);
    expect(report.droppedPublicWarnings).toEqual([]);
    expect(report.summary).toBe("Policy readiness has no public-safe warnings for owner review.");
  });

  it("warns when direct-PR policy is loose", () => {
    const report = buildRepoPolicyReadiness(
      input({
        settings: settings({ requireLinkedIssue: false }),
        focusManifest: parseFocusManifest({
          wantedPaths: ["src/"],
          linkedIssuePolicy: "optional",
          testExpectations: ["Run npm run test:ci."],
        }),
      }),
    );

    expect(report.publicWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "direct_pr_policy_unclear",
          category: "direct_pr_policy",
          severity: "warning",
        }),
      ]),
    );
    expect(report.publicWarnings.flatMap((warning) => [warning.title, warning.detail, warning.action]).every(isFocusManifestPublicSafe)).toBe(true);
  });

  it("warns when contribution scope is unclear", () => {
    const report = buildRepoPolicyReadiness(
      input({
        settings: settings({ requireLinkedIssue: true }),
        focusManifest: parseFocusManifest({
          linkedIssuePolicy: "optional",
          testExpectations: ["Run npm run test:ci."],
        }),
      }),
    );

    expect(report.ownerContext).toMatchObject({
      wantedPathCount: 0,
      issuePolicy: "direct_pr_requires_linked_issue",
    });
    expect(report.publicWarnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        "contribution_scope_unclear",
        "linked_issue_policy_mismatch",
      ]),
    );
  });

  it("warns about issue-discovery policy conflicts and intake gaps", () => {
    const report = buildRepoPolicyReadiness(
      input({
        lane: lane({ lane: "split", issueDiscoveryShare: 0.25, directPrShare: 0.75 }),
        focusManifest: parseFocusManifest({
          wantedPaths: ["src/"],
          linkedIssuePolicy: "required",
          issueDiscoveryPolicy: "discouraged",
          testExpectations: ["Run npm run test:ci."],
        }),
        contributorIntakeHealth: intake({ level: "strained" }),
      }),
    );

    expect(report.publicWarnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        "issue_discovery_policy_mismatch",
        "issue_discovery_intake_not_ready",
        "maintainer_burden_high",
      ]),
    );
  });

  it("marks blocked issue-discovery intake as critical", () => {
    const report = buildRepoPolicyReadiness(
      input({
        lane: lane({ lane: "issue_discovery", issueDiscoveryShare: 1, directPrShare: 0 }),
        focusManifest: parseFocusManifest({
          wantedPaths: ["src/"],
          linkedIssuePolicy: "required",
          issueDiscoveryPolicy: "neutral",
          testExpectations: ["Run npm run test:ci."],
        }),
        contributorIntakeHealth: intake({ level: "blocked" }),
      }),
    );

    expect(report.ownerContext.issuePolicy).toBe("issue_discovery_enabled");
    expect(report.publicWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "issue_discovery_intake_not_ready",
          severity: "critical",
        }),
      ]),
    );
  });

  it("warns when a direct-PR repo has issue-discovery encouraged in focus policy", () => {
    const report = buildRepoPolicyReadiness(
      input({
        lane: lane({ lane: "direct_pr" }),
        focusManifest: parseFocusManifest({
          wantedPaths: ["src/"],
          linkedIssuePolicy: "required",
          issueDiscoveryPolicy: "encouraged",
          testExpectations: ["Run npm run test:ci."],
        }),
      }),
    );

    expect(report.publicWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "issue_discovery_policy_mismatch",
          severity: "info",
        }),
      ]),
    );
  });

  it("warns about missing validation expectations and uncertain validation gates", () => {
    const report = buildRepoPolicyReadiness(
      input({
        focusManifest: parseFocusManifest({
          wantedPaths: ["src/"],
          linkedIssuePolicy: "required",
        }),
        labelAudit: labels({ trustedPipelineReady: false }),
      }),
    );

    expect(report.publicWarnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["validation_expectations_missing", "validation_gate_uncertain"]),
    );
  });

  it("warns about maintainer burden before broader contributor traffic", () => {
    const highQueue = queue({ level: "critical", burdenScore: 90 });
    const report = buildRepoPolicyReadiness(
      input({
        queueHealth: highQueue,
        contributorIntakeHealth: intake({
          level: "blocked",
          queueHealth: {
            burdenScore: highQueue.burdenScore,
            level: highQueue.level,
            signals: highQueue.signals,
          },
        }),
      }),
    );

    expect(report.publicWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "maintainer_burden_high",
          category: "maintainer_burden",
          severity: "critical",
        }),
      ]),
    );
  });

  it("separates private owner context and keeps public warning text sanitized", () => {
    const report = buildRepoPolicyReadiness(
      input({
        focusManifest: parseFocusManifest({
          wantedPaths: ["src/"],
          linkedIssuePolicy: "required",
          testExpectations: ["Run npm run test:ci."],
          maintainerNotes: [
            "Private reviewability note with wallet, hotkey, raw trust, and farming details.",
          ],
          publicNotes: ["Mention the reward estimate.", "Keep pull requests focused."],
        }),
      }),
    );

    expect(report.ownerContext).toMatchObject({
      privateNoteCount: 1,
      manifestPresent: true,
    });
    expect(JSON.stringify(report.publicWarnings)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
    expect(JSON.stringify(report.ownerContext)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
    expect(report.publicWarnings.map(policyReadinessWarningText).every(isFocusManifestPublicSafe)).toBe(true);
  });

  it("surfaces manifest normalization warnings without echoing raw warning text", () => {
    const report = buildRepoPolicyReadiness(
      input({
        focusManifest: parseFocusManifest({
          wantedPaths: "src/",
          linkedIssuePolicy: "required",
          testExpectations: ["Run npm run test:ci."],
        }),
      }),
    );

    expect(report.ownerContext.manifestWarningCount).toBeGreaterThan(0);
    expect(report.publicWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "focus_policy_needs_review" }),
      ]),
    );
    const firstWarning = report.publicWarnings[0];
    expect(firstWarning).toBeDefined();
    expect(policyReadinessWarningText(firstWarning!)).not.toMatch(/wantedPaths must be a list/);
  });

  it("drops public warnings when dynamic signal text is unsafe", () => {
    const report = buildRepoPolicyReadiness(
      input({
        lane: lane({ lane: "split" }),
        contributorIntakeHealth: intake({ level: "wallet" as ContributorIntakeHealth["level"] }),
      }),
    );

    expect(report.publicWarnings.map((warning) => warning.code)).not.toContain("issue_discovery_intake_not_ready");
    expect(report.droppedPublicWarnings).toEqual(
      expect.arrayContaining([
        { code: "issue_discovery_intake_not_ready", reason: "unsafe_public_text" },
      ]),
    );
  });

  it("emits a preview-only missing-policy warning when no focus manifest is cached", () => {
    const report = buildRepoPolicyReadiness(input({ focusManifest: parseFocusManifest(null) }));

    expect(report).toMatchObject({
      source: "focus_manifest_policy",
      previewOnly: true,
      present: false,
      ownerContext: { manifestPresent: false, manifestSource: "none" },
    });
    expect(report.publicWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "focus_policy_missing" }),
      ]),
    );
  });

  it("handles absent optional policy data and clean policy summaries", () => {
    const missing = buildRepoPolicyReadiness(input({ focusManifest: undefined }));
    expect(missing).toMatchObject({
      present: false,
      ownerContext: {
        manifestPresent: false,
        manifestSource: "none",
        privateNoteCount: 0,
        manifestWarningCount: 0,
        wantedPathCount: 0,
        validationExpectationCount: 0,
        issueDiscoveryPolicy: "neutral",
      },
    });
    expect(missing.publicWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "focus_policy_missing" }),
      ]),
    );

    const clean = buildRepoPolicyReadiness(input());
    expect(clean.publicWarnings).toEqual([]);
    expect(clean.droppedPublicWarnings).toEqual([]);
    expect(clean.summary).toBe("Policy readiness has no public-safe warnings for owner review.");
  });
});
