import { describe, expect, it, vi } from "vitest";
import * as repositories from "../../src/db/repositories";
import { sanitizePublicComment } from "../../src/github/commands";
import {
  __contributorOpenPrMonitorInternals,
  buildContributorOpenPrMonitor,
  mapPendingClassToWorkClassification,
} from "../../src/signals/contributor-open-pr-monitor";
import { classifyOpenPullRequest } from "../../src/scoring/pending-pr-scenarios";
import type { PullRequestRecord, PullRequestReviewRecord } from "../../src/types";
import type { RoleContext } from "../../src/signals/engine";
import { createTestEnv } from "../helpers/d1";

const outsideContributorRole: RoleContext = {
  login: "miner-a",
  repoFullName: "entrius/allways-ui",
  generatedAt: "2026-05-28T00:00:00.000Z",
  role: "outside_contributor",
  maintainerLane: false,
  normalContributorEvidenceAllowed: true,
  source: "cache",
  association: "NONE",
  reasons: [],
  guidance: "contributor",
};

const maintainerRole: RoleContext = {
  ...outsideContributorRole,
  login: "repo-owner",
  role: "owner",
  maintainerLane: true,
  normalContributorEvidenceAllowed: false,
  source: "repo_owner_match",
  guidance: "maintainer",
};

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function pr(overrides: Partial<PullRequestRecord> & Pick<PullRequestRecord, "number">): PullRequestRecord {
  return {
    repoFullName: "entrius/allways-ui",
    title: `PR #${overrides.number}`,
    state: "open",
    authorLogin: "miner-a",
    labels: [],
    linkedIssues: [1],
    createdAt: daysAgo(3),
    updatedAt: daysAgo(2),
    ...overrides,
  };
}

function approvedReview(pullNumber: number): PullRequestReviewRecord {
  return {
    id: `review-${pullNumber}`,
    repoFullName: "entrius/allways-ui",
    pullNumber,
    state: "APPROVED",
    payload: {},
  };
}

describe("contributor open PR monitor", () => {
  it("maps issue #36 classifications from cached review/check metadata", () => {
    const approved = classifyOpenPullRequest({
      pr: pr({ number: 1 }),
      roleContext: outsideContributorRole,
      reviews: [approvedReview(1)],
      checks: [],
    });
    expect(mapPendingClassToWorkClassification(approved, { changeRequestCount: 0, checkFailureCount: 0, duplicateProne: false, missingTests: false })).toBe("approved");

    const failing = classifyOpenPullRequest({
      pr: pr({ number: 2 }),
      roleContext: outsideContributorRole,
      reviews: [approvedReview(2)],
      checks: [{ id: "c1", repoFullName: "entrius/allways-ui", pullNumber: 2, name: "ci", status: "completed", conclusion: "failure", payload: {} }],
    });
    expect(mapPendingClassToWorkClassification(failing, { changeRequestCount: 0, checkFailureCount: 1, duplicateProne: false, missingTests: false })).toBe("failing_checks");

    const needsAuthor = classifyOpenPullRequest({
      pr: pr({ number: 3 }),
      roleContext: outsideContributorRole,
      reviews: [{ ...approvedReview(3), state: "CHANGES_REQUESTED" }],
      checks: [],
    });
    expect(mapPendingClassToWorkClassification(needsAuthor, { changeRequestCount: 1, checkFailureCount: 0, duplicateProne: false, missingTests: false })).toBe("needs_author");

    const staleDate = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const stale = classifyOpenPullRequest({
      pr: pr({ number: 4, updatedAt: staleDate, createdAt: staleDate }),
      roleContext: outsideContributorRole,
      reviews: [approvedReview(4)],
      checks: [],
    });
    expect(mapPendingClassToWorkClassification(stale, { changeRequestCount: 0, checkFailureCount: 0, duplicateProne: false, missingTests: false })).toBe("should_close_or_withdraw");

    expect(
      mapPendingClassToWorkClassification(
        classifyOpenPullRequest({ pr: pr({ number: 5, title: "fix overlap" }), roleContext: outsideContributorRole, reviews: [approvedReview(5)], checks: [] }),
        { changeRequestCount: 0, checkFailureCount: 0, duplicateProne: true, missingTests: false },
      ),
    ).toBe("duplicate_prone");

    expect(
      mapPendingClassToWorkClassification(
        classifyOpenPullRequest({ pr: pr({ number: 6 }), roleContext: outsideContributorRole, reviews: [approvedReview(6)], checks: [] }),
        { changeRequestCount: 0, checkFailureCount: 0, duplicateProne: false, missingTests: true },
      ),
    ).toBe("missing_tests");

    expect(
      mapPendingClassToWorkClassification(
        classifyOpenPullRequest({ pr: pr({ number: 7, authorAssociation: "OWNER" }), roleContext: outsideContributorRole, reviews: [approvedReview(7)], checks: [] }),
        { changeRequestCount: 0, checkFailureCount: 0, duplicateProne: false, missingTests: false },
      ),
    ).toBe("maintainer_lane");

    expect(
      mapPendingClassToWorkClassification(
        classifyOpenPullRequest({ pr: pr({ number: 8 }), roleContext: maintainerRole, reviews: [approvedReview(8)], checks: [] }),
        { changeRequestCount: 0, checkFailureCount: 0, duplicateProne: false, missingTests: false },
      ),
    ).toBe("maintainer_lane");

    const draft = classifyOpenPullRequest({
      pr: pr({ number: 9, title: "Draft: wip feature" }),
      roleContext: outsideContributorRole,
      reviews: [],
      checks: [],
    });
    expect(mapPendingClassToWorkClassification(draft, { changeRequestCount: 0, checkFailureCount: 0, duplicateProne: false, missingTests: false })).toBe("draft");

    const blocked = classifyOpenPullRequest({ pr: pr({ number: 12 }), roleContext: outsideContributorRole, reviews: [], checks: [] });
    expect(mapPendingClassToWorkClassification(blocked, { changeRequestCount: 0, checkFailureCount: 0, duplicateProne: false, missingTests: false })).toBe("blocked");

    expect(
      mapPendingClassToWorkClassification(
        { repoFullName: "entrius/allways-ui", number: 13, title: "mystery", classification: "unknown" as never, reasons: [] },
        { changeRequestCount: 0, checkFailureCount: 0, duplicateProne: false, missingTests: false },
      ),
    ).toBe("reviewable");
  });

  it("classifies a GitHub-native draft PR as draft even without draft in title or labels", () => {
    const nativeDraft = classifyOpenPullRequest({
      pr: pr({ number: 20, title: "Add cursor pagination", isDraft: true, labels: [] }),
      roleContext: outsideContributorRole,
      reviews: [],
      checks: [],
    });
    expect(mapPendingClassToWorkClassification(nativeDraft, { changeRequestCount: 0, checkFailureCount: 0, duplicateProne: false, missingTests: false })).toBe("draft");
  });

  it("builds contributor-wide monitor answer from registered repos only", async () => {
    const env = createTestEnv();
    vi.spyOn(repositories, "listRepositories").mockResolvedValue([
      { fullName: "entrius/allways-ui", owner: "entrius", name: "allways-ui", isInstalled: true, isRegistered: true, isPrivate: false },
      { fullName: "other/unregistered", owner: "other", name: "unregistered", isInstalled: true, isRegistered: false, isPrivate: true },
    ] as Awaited<ReturnType<typeof repositories.listRepositories>>);
    vi.spyOn(repositories, "listContributorPullRequests").mockResolvedValue([
      pr({ number: 10 }),
      pr({ number: 11, repoFullName: "other/unregistered", authorLogin: "miner-a" }),
    ]);
    vi.spyOn(repositories, "listPullRequests").mockResolvedValue([pr({ number: 10 }), pr({ number: 11 })]);
    vi.spyOn(repositories, "listPullRequestReviews").mockImplementation(async (_env, _repo, pullNumber) =>
      pullNumber === 10 ? [approvedReview(10)] : [{ ...approvedReview(11), state: "CHANGES_REQUESTED" }],
    );
    vi.spyOn(repositories, "listCheckSummaries").mockResolvedValue([]);
    vi.spyOn(repositories, "listPullRequestFiles").mockResolvedValue([
      { repoFullName: "entrius/allways-ui", pullNumber: 10, path: "src/a.ts", additions: 3, deletions: 0, changes: 3, status: "modified", payload: {} },
      { repoFullName: "entrius/allways-ui", pullNumber: 10, path: "src/a.test.ts", additions: 5, deletions: 0, changes: 5, status: "added", payload: {} },
    ]);

    const monitor = await buildContributorOpenPrMonitor(env, "miner-a");
    expect(monitor.openPrCount).toBe(1);
    expect(monitor.registeredRepoCount).toBe(1);
    expect(monitor.pullRequests).toHaveLength(1);
    expect(monitor.pullRequests[0]).toMatchObject({ number: 10, classification: "approved" });
    expect(monitor.pendingScenarios[0]?.detection.pendingMergedPrCount).toBe(1);
    expect(monitor.summary).toContain("open PR");
    expect(monitor.guidance.length).toBeGreaterThan(0);
  });

  it("groups case-variant repoFullName for one repo into a single open-PR set", async () => {
    const env = createTestEnv();
    vi.spyOn(repositories, "listRepositories").mockResolvedValue([
      { fullName: "entrius/allways-ui", owner: "entrius", name: "allways-ui", isInstalled: true, isRegistered: true, isPrivate: false },
    ] as Awaited<ReturnType<typeof repositories.listRepositories>>);
    // The same repo arrives under two casings — these must be one group, not two.
    vi.spyOn(repositories, "listContributorPullRequests").mockResolvedValue([
      pr({ number: 30, repoFullName: "entrius/allways-ui" }),
      pr({ number: 31, repoFullName: "Entrius/Allways-UI" }),
    ]);
    const listPrSpy = vi.spyOn(repositories, "listPullRequests").mockResolvedValue([pr({ number: 30 }), pr({ number: 31 })]);
    vi.spyOn(repositories, "listPullRequestReviews").mockResolvedValue([]);
    vi.spyOn(repositories, "listCheckSummaries").mockResolvedValue([]);
    vi.spyOn(repositories, "listPullRequestFiles").mockResolvedValue([]);

    const monitor = await buildContributorOpenPrMonitor(env, "miner-a");
    expect(monitor.openPrCount).toBe(2);
    // One merged group → the case-sensitive per-repo query runs only against a real repo casing, never the
    // case-variant. Before the fix the two casings split into two groups and queried both.
    expect(listPrSpy).toHaveBeenCalledWith(env, "entrius/allways-ui");
    expect(listPrSpy).not.toHaveBeenCalledWith(env, "Entrius/Allways-UI");
  });

  it("keeps public monitor output free of forbidden private language", async () => {
    const env = createTestEnv();
    vi.spyOn(repositories, "listRepositories").mockResolvedValue([
      { fullName: "entrius/allways-ui", owner: "entrius", name: "allways-ui", isInstalled: true, isRegistered: true, isPrivate: false },
    ] as Awaited<ReturnType<typeof repositories.listRepositories>>);
    vi.spyOn(repositories, "listContributorPullRequests").mockResolvedValue([pr({ number: 20 })]);
    vi.spyOn(repositories, "listPullRequests").mockResolvedValue([pr({ number: 20 })]);
    vi.spyOn(repositories, "listPullRequestReviews").mockResolvedValue([approvedReview(20)]);
    vi.spyOn(repositories, "listCheckSummaries").mockResolvedValue([]);
    vi.spyOn(repositories, "listPullRequestFiles").mockResolvedValue([]);

    const monitor = await buildContributorOpenPrMonitor(env, "miner-a");
    const blob = JSON.stringify(monitor);
    expect(blob).not.toMatch(/\b(wallet|hotkey|coldkey|payout|reward estimate|farming)\b/i);
    expect(sanitizePublicComment(monitor.summary)).toBe(monitor.summary);
  });

  it("does not require source upload paths in next-step packets", () => {
    const packet = __contributorOpenPrMonitorInternals.buildNextStepPacket(
      classifyOpenPullRequest({ pr: pr({ number: 30 }), roleContext: outsideContributorRole, reviews: [], checks: [] }),
      [],
      [],
      false,
      false,
    );
    expect(packet.nextSteps.join(" ")).not.toMatch(/\/Users\/|\/home\/|upload source/i);
  });

  it("flags duplicate-prone titles across open PRs in the same repo", () => {
    const open = [pr({ number: 40, title: "fix parser bug" }), pr({ number: 41, title: "fix parser bug" })];
    const flagged = __contributorOpenPrMonitorInternals.duplicatePronePullNumbers(open);
    expect(flagged.has(40)).toBe(true);
    expect(flagged.has(41)).toBe(true);
    expect(__contributorOpenPrMonitorInternals.duplicatePronePullNumbers([pr({ number: 42, labels: ["wip"] })]).has(42)).toBe(true);
  });

  it("strips only genuine draft markers when normalizing titles for dedup (regression)", () => {
    const { duplicatePronePullNumbers } = __contributorOpenPrMonitorInternals;

    // "[draft] X" and "X" are the same work, so stripping the marker collapses them into one cluster.
    const clustered = duplicatePronePullNumbers([
      pr({ number: 60, title: "[draft] fix parser bug" }),
      pr({ number: 61, title: "fix parser bug" }),
    ]);
    expect(clustered.has(60)).toBe(true);
    expect(clustered.has(61)).toBe(true);

    // A title that merely starts with the word "draft" keeps it, so it is not mistaken for "tooling".
    const distinct = duplicatePronePullNumbers([
      pr({ number: 62, title: "Draft tooling" }),
      pr({ number: 63, title: "tooling" }),
    ]);
    expect(distinct.has(62)).toBe(false);
    expect(distinct.has(63)).toBe(false);
  });

  it("covers monitor summaries, guidance, next steps, and file heuristics", () => {
    const { nextStepsForClassification, summarizeMonitor, buildMonitorGuidance, missingTestsFromFiles, priorityRank } =
      __contributorOpenPrMonitorInternals;

    expect(summarizeMonitor(0, 0, false)).toContain("No open pull requests");
    expect(summarizeMonitor(2, 1, true)).toContain("clean up existing work");
    expect(summarizeMonitor(2, 1, false)).toContain("merge-ready from cached metadata");

    expect(buildMonitorGuidance([], false)).toEqual(["Queue looks manageable from cached metadata; still run preflight before new PRs."]);
    expect(buildMonitorGuidance([{ classification: "approved" } as never], false)).toContain(
      "Merge-ready PRs can improve pending-merge score projections after they land.",
    );
    expect(
      buildMonitorGuidance(
        [
          { classification: "failing_checks" } as never,
          { classification: "needs_author" } as never,
          { classification: "duplicate_prone" } as never,
        ],
        true,
      ),
    ).toEqual(
      expect.arrayContaining([
        "Prioritize existing open PRs before starting new issues or branches.",
        "1 PR(s) need failing checks addressed first.",
        "1 PR(s) need author follow-up on review comments.",
        "1 PR(s) look duplicate-prone; consolidate before adding more queue load.",
      ]),
    );

    for (const classification of [
      "reviewable",
      "blocked",
      "stale",
      "draft",
      "maintainer_lane",
      "missing_tests",
      "duplicate_prone",
      "failing_checks",
      "needs_author",
      "approved",
      "should_close_or_withdraw",
    ] as const) {
      expect(nextStepsForClassification(classification, "entrius/allways-ui", 99).length).toBeGreaterThan(0);
    }
    expect(priorityRank("approved")).toBeLessThan(priorityRank("unknown" as never));

    expect(missingTestsFromFiles([])).toBe(false);
    expect(missingTestsFromFiles([{ path: "pkg/foo_test.go" } as never])).toBe(false);
    expect(missingTestsFromFiles([{ path: "pkg/foo.go" } as never])).toBe(true);
    expect(missingTestsFromFiles([{ path: "tests/integration.spec.ts" } as never])).toBe(false);

    // Python/Ruby test conventions outside a test/ or spec/ directory are real test evidence
    // and must not be classified as missing_tests (regression: the local matcher only knew _test.go).
    expect(missingTestsFromFiles([{ path: "service.py" } as never, { path: "service_test.py" } as never])).toBe(false);
    expect(missingTestsFromFiles([{ path: "lib/widget.rb" } as never, { path: "models/widget_test.rb" } as never])).toBe(false);
    expect(missingTestsFromFiles([{ path: "lib/widget.rb" } as never, { path: "widget_spec.rb" } as never])).toBe(false);
  });

  it("returns an empty monitor when the contributor has no cached open PRs", async () => {
    const env = createTestEnv();
    vi.spyOn(repositories, "listRepositories").mockResolvedValue([]);
    vi.spyOn(repositories, "listContributorPullRequests").mockResolvedValue([]);

    const monitor = await buildContributorOpenPrMonitor(env, "miner-a");
    expect(monitor.openPrCount).toBe(0);
    expect(monitor.pullRequests).toEqual([]);
    expect(monitor.summary).toContain("No open pull requests");
  });

  it("omits pending scenarios when nothing is merge-ready or stale-close", async () => {
    const env = createTestEnv();
    vi.spyOn(repositories, "listRepositories").mockResolvedValue([
      { fullName: "entrius/allways-ui", owner: "entrius", name: "allways-ui", isInstalled: true, isRegistered: true, isPrivate: false },
    ] as Awaited<ReturnType<typeof repositories.listRepositories>>);
    vi.spyOn(repositories, "listContributorPullRequests").mockResolvedValue([pr({ number: 55 })]);
    vi.spyOn(repositories, "listPullRequests").mockResolvedValue([pr({ number: 55 })]);
    vi.spyOn(repositories, "listPullRequestReviews").mockResolvedValue([]);
    vi.spyOn(repositories, "listCheckSummaries").mockResolvedValue([]);
    vi.spyOn(repositories, "listPullRequestFiles").mockResolvedValue([]);

    const monitor = await buildContributorOpenPrMonitor(env, "miner-a");
    expect(monitor.pendingScenarios).toEqual([]);
    expect(monitor.pullRequests[0]?.classification).toBe("blocked");
  });

  it("classifies cancelled checks as failing work", async () => {
    const env = createTestEnv();
    vi.spyOn(repositories, "listRepositories").mockResolvedValue([
      { fullName: "entrius/allways-ui", owner: "entrius", name: "allways-ui", isInstalled: true, isRegistered: true, isPrivate: false },
    ] as Awaited<ReturnType<typeof repositories.listRepositories>>);
    vi.spyOn(repositories, "listContributorPullRequests").mockResolvedValue([pr({ number: 56 })]);
    vi.spyOn(repositories, "listPullRequests").mockResolvedValue([pr({ number: 56 })]);
    vi.spyOn(repositories, "listPullRequestReviews").mockResolvedValue([approvedReview(56)]);
    vi.spyOn(repositories, "listCheckSummaries").mockResolvedValue([
      { id: "c56", repoFullName: "entrius/allways-ui", pullNumber: 56, name: "ci", status: "completed", conclusion: "cancelled", payload: {} },
    ]);
    vi.spyOn(repositories, "listPullRequestFiles").mockResolvedValue([
      { repoFullName: "entrius/allways-ui", pullNumber: 56, path: "src/x.ts", additions: 1, deletions: 0, changes: 1, payload: {} },
      { repoFullName: "entrius/allways-ui", pullNumber: 56, path: "src/x.test.ts", additions: 1, deletions: 0, changes: 1, payload: {} },
    ]);

    const monitor = await buildContributorOpenPrMonitor(env, "miner-a");
    expect(monitor.pullRequests[0]?.classification).toBe("failing_checks");
  });

  it("aggregates open PRs across multiple registered repos", async () => {
    const env = createTestEnv();
    vi.spyOn(repositories, "listRepositories").mockResolvedValue([
      { fullName: "entrius/allways-ui", owner: "entrius", name: "allways-ui", isInstalled: true, isRegistered: true, isPrivate: false },
      { fullName: "other/registered", owner: "other", name: "registered", isInstalled: true, isRegistered: true, isPrivate: false },
    ] as Awaited<ReturnType<typeof repositories.listRepositories>>);
    vi.spyOn(repositories, "listContributorPullRequests").mockResolvedValue([
      pr({ number: 57, repoFullName: "entrius/allways-ui" }),
      pr({ number: 58, repoFullName: "other/registered" }),
    ]);
    vi.spyOn(repositories, "listPullRequests").mockImplementation(async (_env, repo) =>
      repo === "entrius/allways-ui" ? [pr({ number: 57 })] : [pr({ number: 58, repoFullName: "other/registered" })],
    );
    vi.spyOn(repositories, "listPullRequestReviews").mockResolvedValue([]);
    vi.spyOn(repositories, "listCheckSummaries").mockResolvedValue([]);
    vi.spyOn(repositories, "listPullRequestFiles").mockResolvedValue([]);

    const monitor = await buildContributorOpenPrMonitor(env, "miner-a");
    expect(monitor.openPrCount).toBe(2);
    expect(monitor.pendingScenarios).toHaveLength(0);
  });

  it("sorts cleanup-first PRs ahead of merge-ready work", async () => {
    const env = createTestEnv();
    vi.spyOn(repositories, "listRepositories").mockResolvedValue([
      { fullName: "entrius/allways-ui", owner: "entrius", name: "allways-ui", isInstalled: true, isRegistered: true, isPrivate: false },
    ] as Awaited<ReturnType<typeof repositories.listRepositories>>);
    vi.spyOn(repositories, "listContributorPullRequests").mockResolvedValue([pr({ number: 50 }), pr({ number: 51 })]);
    vi.spyOn(repositories, "listPullRequests").mockResolvedValue([pr({ number: 50 }), pr({ number: 51 })]);
    vi.spyOn(repositories, "listPullRequestReviews").mockImplementation(async (_env, _repo, pullNumber) =>
      pullNumber === 50
        ? [{ ...approvedReview(50), state: "CHANGES_REQUESTED" }]
        : [approvedReview(51)],
    );
    vi.spyOn(repositories, "listCheckSummaries").mockResolvedValue([]);
    vi.spyOn(repositories, "listPullRequestFiles").mockResolvedValue([
      { repoFullName: "entrius/allways-ui", pullNumber: 50, path: "src/a.ts", additions: 1, deletions: 0, changes: 1, payload: {} },
      { repoFullName: "entrius/allways-ui", pullNumber: 50, path: "src/a.test.ts", additions: 1, deletions: 0, changes: 1, payload: {} },
      { repoFullName: "entrius/allways-ui", pullNumber: 51, path: "src/b.ts", additions: 1, deletions: 0, changes: 1, payload: {} },
      { repoFullName: "entrius/allways-ui", pullNumber: 51, path: "src/b.test.ts", additions: 1, deletions: 0, changes: 1, payload: {} },
    ]);

    const monitor = await buildContributorOpenPrMonitor(env, "miner-a");
    expect(monitor.cleanupFirst).toBe(true);
    expect(monitor.pullRequests[0]?.classification).toBe("needs_author");
    expect(monitor.pullRequests[1]?.classification).toBe("approved");
  });
});
