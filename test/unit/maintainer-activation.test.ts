import { describe, expect, it } from "vitest";
import { buildMaintainerActivationPreview, recommendedAdvisoryActivationSettings } from "../../src/services/maintainer-activation";
import type { PullRequestRecord, RepositoryRecord, RepositorySettings } from "../../src/types";

const repo: RepositoryRecord = {
  fullName: "owner/repo",
  owner: "owner",
  name: "repo",
  isInstalled: true,
  isRegistered: true,
  isPrivate: false,
  registryConfig: {
    repo: "owner/repo",
    emissionShare: 0.02,
    issueDiscoveryShare: 0.5,
    maintainerCut: 0,
    labelMultipliers: {},
    raw: {},
  },
};

function settings(overrides: Partial<RepositorySettings> = {}): RepositorySettings {
  return {
    repoFullName: repo.fullName,
    commentMode: "detected_contributors_only",
    publicAudienceMode: "oss_maintainer",
    publicSignalLevel: "standard",
    checkRunMode: "off",
    checkRunDetailLevel: "standard",
    gateCheckMode: "off",
    gatePack: "gittensor",
    linkedIssueGateMode: "advisory",
    duplicatePrGateMode: "advisory",
    qualityGateMode: "advisory",
    slopGateMode: "off",
    mergeReadinessGateMode: "off",
    manifestPolicyGateMode: "off",
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
    ...overrides,
  };
}

function pr(number: number, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    repoFullName: repo.fullName,
    number,
    title: `PR ${number}`,
    state: "open",
    authorLogin: "contributor",
    authorAssociation: "NONE",
    labels: [],
    linkedIssues: [number + 100],
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildMaintainerActivationPreview", () => {
  it("summarizes advisory findings across recent PRs and recommends advisory enable when the gate is off", () => {
    const preview = buildMaintainerActivationPreview({
      repoFullName: repo.fullName,
      repo,
      settings: settings({ requireLinkedIssue: true }),
      pullRequests: [pr(1, { linkedIssues: [] }), pr(2, { linkedIssues: [5] })],
      generatedAt: "2026-06-14T00:00:00.000Z",
    });

    expect(preview.evaluatedCount).toBe(2);
    expect(preview.withFindingsCount).toBe(1);
    expect(preview.recommendedAction).toBe("enable_advisory");
    expect(preview.aiReviewConfigured).toBe(false);
    expect(preview.currentGateMode).toBe("off");
    expect(preview.findingCodeCounts).toContainEqual({ code: "missing_linked_issue", count: 1 });

    const flagged = preview.samples.find((sample) => sample.number === 1)!;
    expect(flagged.findingCount).toBeGreaterThanOrEqual(1);
    expect(flagged.findings.map((finding) => finding.code)).toContain("missing_linked_issue");

    const clean = preview.samples.find((sample) => sample.number === 2)!;
    expect(clean.findingCount).toBe(0);
    expect(preview.summary).toContain("would have surfaced guidance on 1");
  });

  it("orders finding codes by count, breaking ties by code name", () => {
    const preview = buildMaintainerActivationPreview({
      repoFullName: repo.fullName,
      repo,
      settings: settings(),
      // PR 1 → missing_linked_issue; PR 2 (maintainer-authored, linked) → maintainer_authored_pr. Both count 1.
      pullRequests: [pr(1, { linkedIssues: [] }), pr(2, { authorAssociation: "OWNER", linkedIssues: [5] })],
      generatedAt: "2026-06-14T00:00:00.000Z",
    });
    expect(preview.findingCodeCounts).toEqual([
      { code: "maintainer_authored_pr", count: 1 },
      { code: "missing_linked_issue", count: 1 },
    ]);
  });

  it("recommends no action and reflects AI config when the gate is already enabled", () => {
    const preview = buildMaintainerActivationPreview({
      repoFullName: repo.fullName,
      repo,
      settings: settings({ gateCheckMode: "enabled", aiReviewMode: "advisory" }),
      pullRequests: [pr(1, { linkedIssues: [] })],
      generatedAt: "2026-06-14T00:00:00.000Z",
    });
    expect(preview.recommendedAction).toBeNull();
    expect(preview.aiReviewConfigured).toBe(true);
    expect(preview.currentGateMode).toBe("enabled");
    expect(preview.summary).toContain("already enabled");
  });

  it("handles a repo with no cached PRs", () => {
    const preview = buildMaintainerActivationPreview({
      repoFullName: repo.fullName,
      repo,
      settings: settings(),
      pullRequests: [],
      generatedAt: "2026-06-14T00:00:00.000Z",
    });
    expect(preview.evaluatedCount).toBe(0);
    expect(preview.withFindingsCount).toBe(0);
    expect(preview.samples).toEqual([]);
    expect(preview.recommendedAction).toBe("enable_advisory");
    expect(preview.summary).toContain("No recent pull requests");
  });

  it("caps and orders the sample by recency", () => {
    const many = Array.from({ length: 30 }, (_, index) => pr(index + 1, { updatedAt: `2026-06-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z` }));
    const capped = buildMaintainerActivationPreview({ repoFullName: repo.fullName, repo, settings: settings(), pullRequests: many, generatedAt: "2026-06-14T00:00:00.000Z" });
    expect(capped.evaluatedCount).toBe(10);
    // Most recent updatedAt first.
    expect(capped.samples[0]!.number).toBe(28);

    const small = buildMaintainerActivationPreview({ repoFullName: repo.fullName, repo, settings: settings(), pullRequests: many, generatedAt: "2026-06-14T00:00:00.000Z", sampleSize: 3 });
    expect(small.evaluatedCount).toBe(3);
  });

  it("clamps the sample size to its bounds and falls back to createdAt (or nothing) for recency", () => {
    const dated = Array.from({ length: 30 }, (_, index) => pr(index + 1, { updatedAt: undefined, createdAt: `2026-05-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z` }));
    expect(buildMaintainerActivationPreview({ repoFullName: repo.fullName, repo, settings: settings(), pullRequests: dated, generatedAt: "2026-06-14T00:00:00.000Z", sampleSize: 50 }).evaluatedCount).toBe(25);
    expect(buildMaintainerActivationPreview({ repoFullName: repo.fullName, repo, settings: settings(), pullRequests: dated, generatedAt: "2026-06-14T00:00:00.000Z", sampleSize: 0 }).evaluatedCount).toBe(1);

    // PRs with no cached timestamps at all still sort/evaluate without throwing.
    const undatedPreview = buildMaintainerActivationPreview({
      repoFullName: repo.fullName,
      repo,
      settings: settings(),
      pullRequests: [pr(1, { updatedAt: undefined, createdAt: undefined }), pr(2, { updatedAt: undefined, createdAt: undefined })],
      generatedAt: "2026-06-14T00:00:00.000Z",
    });
    expect(undatedPreview.evaluatedCount).toBe(2);
  });
});

describe("recommendedAdvisoryActivationSettings", () => {
  it("enables the gate + deterministic rules in advisory (non-blocking) mode", () => {
    expect(recommendedAdvisoryActivationSettings()).toEqual({
      gateCheckMode: "enabled",
      checkRunMode: "enabled",
      linkedIssueGateMode: "advisory",
      duplicatePrGateMode: "advisory",
      qualityGateMode: "advisory",
    });
  });
});
