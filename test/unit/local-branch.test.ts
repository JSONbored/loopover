import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLocalBranchAnalysis } from "../../src/signals/local-branch";
import type { ContributorOutcomeHistory, ContributorProfile, ContributorScoringProfile } from "../../src/signals/engine";
import type { RepositoryRecord, ScoringModelSnapshotRecord } from "../../src/types";

describe("local branch analysis", () => {
  it("combines local preflight, private score preview, reward/risk, and a public-safe PR packet", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: "entrius/allways-ui",
        baseRef: "origin/main",
        headRef: "fix-cache",
        branchName: "fix-cache-reconnect",
        title: "Fix dashboard cache refresh after reconnect",
        body: "Fixes #7",
        labels: ["bug"],
        changedFiles: [
          { path: "src/cache.ts", additions: 42, deletions: 4, status: "modified" },
          { path: "test/cache.test.ts", additions: 30, deletions: 0, status: "added" },
        ],
        validation: [{ command: "npm test -- cache", status: "passed", summary: "cache regression passed" }],
        localScorer: {
          mode: "external_command",
          sourceTokenScore: 48,
          totalTokenScore: 80,
          sourceLines: 46,
          testTokenScore: 30,
        },
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Dashboard cache refresh fails after reconnect", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.preflight.status).toBe("ready");
    expect(analysis.preflight.localDiff).toMatchObject({ changedFileCount: 2, codeFileCount: 1, testFileCount: 1, inferredLinkedIssues: [7] });
    expect(analysis.scorePreview.privateOnly).toBe(true);
    expect(analysis.rewardRisk.rewardUpside.relevantLane).toBe("direct_pr");
    expect(analysis.nextActions.map((action) => action.actionKind)).toContain("open_new_direct_pr");
    expect(analysis.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "source_upload_disabled" })]));
    expect(JSON.stringify(analysis.prPacket)).not.toMatch(/reward|score|wallet|hotkey|farming|payout|ranking|trust score/i);
  });

  it("projects a blocked local branch into a useful after-pending-merge scenario", () => {
    const pressuredHistory: ContributorOutcomeHistory = {
      ...outcomeHistory,
      totals: { ...outcomeHistory.totals, openPullRequests: 3, credibility: 0 },
      repoOutcomes: [
        {
          ...outcomeHistory.repoOutcomes[0]!,
          openPullRequests: 3,
          credibility: 0,
          closedPullRequestRate: 0,
          closedPullRequests: 0,
        },
      ],
    };
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        baseRef: "upstream/main",
        branchName: "fix-15233-entity-model",
        body: "Fixes #15233",
        changedFiles: [
          { path: "internal/entity/model.go", additions: 30, deletions: 4, status: "modified" },
          { path: "internal/entity/model_test.go", additions: 44, deletions: 0, status: "modified" },
          { path: "internal/service/entity.go", additions: 12, deletions: 2, status: "modified" },
          { path: "docs/entity.md", additions: 8, deletions: 1, status: "modified" },
        ],
        validation: [{ command: "go test ./internal/entity ./internal/service", status: "passed", summary: "focused Go tests passed" }],
        pendingMergedPrCount: 3,
        projectedCredibility: 0.8,
        scenarioNotes: ["three approved PRs are expected to merge"],
        localScorer: {
          mode: "external_command",
          sourceTokenScore: 60,
          totalTokenScore: 100,
          sourceLines: 80,
          testTokenScore: 44,
        },
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 15233, title: "Entity model edge case", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory: pressuredHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.preflight.localDiff).toMatchObject({ changedFileCount: 4, testFileCount: 1, codeFileCount: 2, inferredLinkedIssues: [15233] });
    expect(analysis.scorePreview.effectiveEstimatedScore).toBe(0);
    expect(analysis.scorePreview.underlyingPotentialScore).toBeGreaterThan(0);
    expect(analysis.scenarioScorePreview.afterPendingMerges?.source).toBe("user_supplied");
    expect(analysis.scenarioScorePreview.afterPendingMerges?.effectiveEstimatedScore).toBeGreaterThan(0);
    expect(analysis.accountStateBlockers.join(" ")).toMatch(/Open PR count|Credibility/i);
    expect(analysis.branchQualityBlockers.join(" ")).not.toMatch(/test/i);
    expect(analysis.recommendedRerunCondition).toMatch(/pending PRs merge\/close|open PR count/i);
    expect(analysis.nextActions[0]?.whyThisHelps.join(" ")).toMatch(/waiting for pending PRs/i);
  });

  it("classifies stale base state and treats passed validation as test evidence", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        baseRef: "origin/main",
        baseSha: "old-base",
        headSha: "head",
        mergeBaseSha: "old-base",
        remoteTrackingSha: "new-base",
        body: "Fixes #7",
        changedFiles: [{ path: "internal/entity/model.go", additions: 10, deletions: 2, status: "modified" }],
        validation: [{ command: "go test ./internal/entity", status: "passed", summary: "focused regression passed" }],
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Entity model edge case", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.baseFreshness.status).toBe("stale");
    expect(analysis.baseFreshness.warnings.join(" ")).toMatch(/behind remote tracking SHA/i);
    expect(analysis.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "stale_base_ref" })]));
    expect(analysis.preflight.findings.map((finding) => finding.code)).not.toContain("missing_test_evidence");
    expect(analysis.preflight.findings.map((finding) => finding.code)).not.toContain("local_diff_missing_tests");
    expect(analysis.recommendedRerunCondition).toMatch(/git fetch origin/i);
  });

  it("distinguishes fresh, merge-base-stale, and large unverified base states", () => {
    const fresh = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        baseRef: "origin/main",
        baseSha: "base",
        remoteTrackingSha: "base",
        branchName: "docs-polish",
        body: "Fixes #7",
        changedFiles: [{ path: "README.md", additions: 1, deletions: 0, status: "modified" }],
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Docs polish", state: "open", labels: [], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });
    expect(fresh.baseFreshness.status).toBe("fresh");
    expect(fresh.recommendedRerunCondition).toBe("Rerun after any branch, base, or PR state changes before opening/submitting.");

    const mergeBaseStale = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        baseRef: "origin/main",
        baseSha: "base",
        mergeBaseSha: "older-base",
        remoteTrackingSha: "base",
        changedFiles: [{ path: "src/cache.ts", additions: 2, deletions: 1, status: "modified" }],
      },
      repo,
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });
    expect(mergeBaseStale.baseFreshness.status).toBe("stale");
    expect(mergeBaseStale.baseFreshness.warnings.join(" ")).toMatch(/Merge-base does not match/i);

    const largeUnverified = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        changedFiles: Array.from({ length: 50 }, (_, index) => ({ path: `src/file-${index}.ts`, additions: Number.NaN, deletions: undefined, status: "modified" as const })),
      },
      repo,
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });
    expect(largeUnverified.baseFreshness.status).toBe("possibly_stale");
    expect(largeUnverified.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "stale_base_ref" })]));
    expect(largeUnverified.preflight.localDiff.changedLineCount).toBe(0);
  });

  it("keeps unregistered gittensory work in product/maintainer context instead of miner target context", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "jsonbored",
        repoFullName: "JSONbored/gittensory",
        branchName: "miner-mcp-upgrade",
        changedFiles: [{ path: "src/api/routes.ts", additions: 90, deletions: 2, status: "modified" }],
        validation: [{ command: "npm run test:ci", status: "not_run" }],
      },
      repo: null,
      issues: [],
      pullRequests: [],
      profile: { ...profile, login: "jsonbored" },
      outcomeHistory: { ...outcomeHistory, login: "jsonbored", repoOutcomes: [] },
      scoringSnapshot,
    });

    expect(analysis.lane.lane).toBe("unknown");
    expect(analysis.scoreBlockers).toEqual(expect.arrayContaining(["Repository is not registered in the local snapshot."]));
    expect(analysis.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "gittensory_not_registered" })]));
    expect(analysis.rewardRisk.rewardUpside.relevantLane).toBe("maintainer_lane");
    expect(analysis.rewardRisk.scoreBlockers).toEqual(expect.arrayContaining(["Maintainer-lane work is not normal outside-contributor reward evidence."]));
  });

  it("separates account maturity blockers from clean branch metadata when no pending scenario is supplied", () => {
    const pressuredHistory: ContributorOutcomeHistory = {
      ...outcomeHistory,
      totals: { ...outcomeHistory.totals, openPullRequests: 4, credibility: 0.2 },
      repoOutcomes: [{ ...outcomeHistory.repoOutcomes[0]!, openPullRequests: 4, credibility: 0.2, closedPullRequestRate: 0 }],
    };

    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        body: "Fixes #7",
        changedFiles: [
          { path: "src/cache.ts", additions: 12, deletions: 1, status: "modified" },
          { path: "src/cache.test.ts", additions: 20, deletions: 0, status: "added" },
        ],
        validation: [{ command: "npm test -- cache", status: "passed" }],
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Cache edge", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory: pressuredHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.branchQualityBlockers).toEqual([]);
    expect(analysis.accountStateBlockers.join(" ")).toMatch(/Open PR count|Credibility/i);
    expect(analysis.recommendedRerunCondition).toBe("Rerun after account/queue maturity blockers clear.");
    expect(analysis.nextActions[0]?.actionKind).not.toBe("land_existing_prs");
  });

  it("handles sparse metadata, failed validation, binary changes, and commit-title fallback", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: "entrius/allways-ui",
        commitMessages: ["Fix reconnect binary asset handling\n\nNo public scoring text."],
        changedFiles: [{ path: "assets/cache.bin", additions: 0, deletions: 0, binary: true, status: "modified" }],
        validation: [{ command: "npm test -- cache", status: "failed", summary: "regression failed" }],
      },
      repo,
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.prPacket.titleSuggestion).toBe("Fix reconnect binary asset handling");
    expect(analysis.localFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "failed_local_validation" }),
        expect.objectContaining({ code: "binary_diff_present" }),
      ]),
    );
    expect(analysis.prPacket.bodySections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ heading: "Linked Context", lines: ["- No linked issue detected; explain why this is a no-issue PR."] }),
        expect.objectContaining({ heading: "Validation", lines: [expect.stringContaining("failed: npm test -- cache")] }),
      ]),
    );
    expect(JSON.stringify(analysis.prPacket)).not.toMatch(/reward|score|wallet|hotkey|farming|payout|ranking|trust score/i);
  });

  it("uses safe defaults when local metadata has no title, files, or validation", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: "entrius/allways-ui",
      },
      repo,
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.prPacket.titleSuggestion).toBe("Local branch preflight");
    expect(analysis.prPacket.bodySections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ heading: "Changed Paths", lines: ["- No changed paths were detected from local metadata."] }),
        expect.objectContaining({ heading: "Validation", lines: ["- Not supplied yet."] }),
      ]),
    );
    expect(analysis.summary).toContain("is the top private next action");
    expect(JSON.stringify(analysis.prPacket)).not.toMatch(/reward|score|wallet|hotkey|farming|payout|ranking|trust score/i);
  });
});

describe("local MCP git metadata collection", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
    delete process.env.GITTENSORY_UPLOAD_SOURCE;
  });

  it("parses remotes, changed-file stats, linked issues, and refuses source upload mode", async () => {
    // @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
    const { collectLocalBranchMetadata, parseGitRemote } = await import("../../packages/gittensory-mcp/lib/local-branch.js");
    expect(parseGitRemote("git@github.com:entrius/allways-ui.git")).toBe("entrius/allways-ui");
    expect(parseGitRemote("https://github.com/JSONbored/gittensory.git")).toBe("JSONbored/gittensory");

    tempDir = mkdtempSync(join(tmpdir(), "gittensory-local-"));
    git(tempDir, "init");
    git(tempDir, "config", "user.email", "test@example.com");
    git(tempDir, "config", "user.name", "Gittensory Test");
    git(tempDir, "config", "commit.gpgsign", "false");
    git(tempDir, "remote", "add", "origin", "git@github.com:entrius/allways-ui.git");
    writeFileSync(join(tempDir, "README.md"), "fixture\n");
    git(tempDir, "add", "README.md");
    git(tempDir, "commit", "-m", "initial commit");
    git(tempDir, "checkout", "-b", "fix-cache-7");
    mkdirSync(join(tempDir, "src"));
    mkdirSync(join(tempDir, "test"));
    writeFileSync(join(tempDir, "src/cache.ts"), "export const cache = 1;\n");
    writeFileSync(join(tempDir, "test/cache.test.ts"), "expect(1).toBe(1);\n");
    git(tempDir, "add", "src/cache.ts", "test/cache.test.ts");

    const metadata = collectLocalBranchMetadata({ cwd: tempDir, baseRef: "HEAD", login: "oktofeesh1", body: "Fixes #7" });
    expect(metadata).toMatchObject({
      login: "oktofeesh1",
      repoFullName: "entrius/allways-ui",
      branchName: "fix-cache-7",
      linkedIssues: [7],
    });
    expect(metadata.changedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/cache.ts", additions: 1, status: "added" }),
        expect.objectContaining({ path: "test/cache.test.ts", additions: 1, status: "added" }),
      ]),
    );
    expect(JSON.stringify(metadata)).not.toMatch(/export const cache/);

    process.env.GITTENSORY_UPLOAD_SOURCE = "true";
    expect(() => collectLocalBranchMetadata({ cwd: tempDir, baseRef: "HEAD", login: "oktofeesh1" })).toThrow(/not supported/);
  });
});

const repo: RepositoryRecord = {
  fullName: "entrius/allways-ui",
  owner: "entrius",
  name: "allways-ui",
  isInstalled: true,
  isRegistered: true,
  isPrivate: false,
  defaultBranch: "test",
  registryConfig: {
    repo: "entrius/allways-ui",
    emissionShare: 0.01107,
    issueDiscoveryShare: 0,
    labelMultipliers: { bug: 1.1 },
    trustedLabelPipeline: true,
    maintainerCut: 0,
    raw: {},
  },
};

const profile: ContributorProfile = {
  login: "oktofeesh1",
  generatedAt: "2026-05-25T00:00:00.000Z",
  github: { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" },
  source: "gittensor_api",
  registeredRepoActivity: {
    pullRequests: 2,
    mergedPullRequests: 1,
    issues: 0,
    reposTouched: [repo.fullName],
    dominantLabels: ["bug"],
  },
  trustSignals: {
    evidenceScore: 80,
    level: "emerging",
    unlinkedOpenPullRequests: 0,
    maintainerAssociatedPullRequests: 0,
  },
};

const outcomeHistory: ContributorOutcomeHistory = {
  login: "oktofeesh1",
  generatedAt: "2026-05-25T00:00:00.000Z",
  source: "gittensor_api",
  totals: {
    pullRequests: 2,
    mergedPullRequests: 1,
    openPullRequests: 0,
    closedPullRequests: 1,
    closedPullRequestRate: 0.5,
    issues: 0,
    openIssues: 0,
    closedIssues: 0,
    solvedIssues: 0,
    validSolvedIssues: 0,
    credibility: 0.92,
    issueCredibility: 1,
  },
  repoOutcomes: [
    {
      repoFullName: repo.fullName,
      role: "outside_contributor",
      lane: "direct_pr",
      maintainerLane: false,
      pullRequests: 2,
      mergedPullRequests: 1,
      openPullRequests: 0,
      closedPullRequests: 1,
      closedPullRequestRate: 0.5,
      issues: 0,
      openIssues: 0,
      closedIssues: 0,
      solvedIssues: 0,
      validSolvedIssues: 0,
      credibility: 0.92,
      issueCredibility: 1,
      isEligible: true,
      successLevel: "emerging",
      strengths: ["Merged prior PRs."],
      risks: ["Closed PR risk exists."],
    },
  ],
  successPatterns: [],
  failurePatterns: [],
  summary: "fixture history",
};

const scoringSnapshot: ScoringModelSnapshotRecord = {
  id: "scoring-test",
  sourceKind: "test",
  sourceUrl: "fixture://scoring",
  fetchedAt: "2026-05-25T00:00:00.000Z",
  activeModel: "current_density_model",
  constants: {
    OSS_EMISSION_SHARE: 0.9,
    MERGED_PR_BASE_SCORE: 25,
    MIN_TOKEN_SCORE_FOR_BASE_SCORE: 5,
    MAX_CODE_DENSITY_MULTIPLIER: 1.15,
    MAX_CONTRIBUTION_BONUS: 25,
    CONTRIBUTION_SCORE_FOR_FULL_BONUS: 1500,
    STANDARD_ISSUE_MULTIPLIER: 1.33,
    MAINTAINER_ISSUE_MULTIPLIER: 1.66,
    MIN_CREDIBILITY: 0.8,
    REVIEW_PENALTY_RATE: 0.15,
    EXCESSIVE_PR_PENALTY_BASE_THRESHOLD: 2,
    OPEN_PR_THRESHOLD_TOKEN_SCORE: 300,
    MAX_OPEN_PR_THRESHOLD: 30,
    OPEN_PR_COLLATERAL_PERCENT: 0.2,
    SRC_TOK_SATURATION_SCALE: 58,
  },
  programmingLanguages: { TypeScript: 1 },
  warnings: [],
  payload: {},
};

const scoringProfile: ContributorScoringProfile = {
  login: "oktofeesh1",
  generatedAt: "2026-05-25T00:00:00.000Z",
  scoringModelSnapshotId: "scoring-test",
  evidence: {
    registeredRepoPullRequests: 2,
    mergedPullRequests: 1,
    openPullRequests: 0,
    stalePullRequests: 0,
    unlinkedPullRequests: 0,
    issueDiscoveryReports: 0,
    languageMatches: 1,
    credibilityAssumption: 0.92,
  },
  privateSignals: ["fixture scoring profile"],
};

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
