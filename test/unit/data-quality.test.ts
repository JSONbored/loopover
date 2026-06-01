import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCoreSignalFidelity, buildFreshnessSloReport, buildRepoDataQuality, buildSignalFidelity, freshnessAuditMetadata } from "../../src/signals/data-quality";
import type { PullRequestDetailSyncStateRecord, RepoGithubTotalsSnapshotRecord, RepoSyncSegmentRecord, RepoSyncStateRecord } from "../../src/types";

const TEST_NOW_MS = Date.parse("2026-05-25T01:00:00.000Z");

describe("sync data quality", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks capped and partial segments as degraded instead of complete", () => {
    const state = repoState({ status: "capped", warnings: ["GitHub sync reached local cap of 100 item(s)."] });
    const quality = buildRepoDataQuality("owner/repo", state, [
      segment({ segment: "open_pull_requests", status: "capped", fetchedCount: 100, nextCursor: "2" }),
      segment({ segment: "labels", status: "complete", fetchedCount: 12 }),
    ]);

    expect(quality).toMatchObject({
      status: "degraded",
      capped: true,
      partial: true,
      cappedSegments: ["open_pull_requests"],
      warnings: expect.arrayContaining([expect.stringContaining("pagination cap")]),
    });
  });

  it("distinguishes blocked rate-limited repo fidelity from global service readiness", () => {
    const states = [repoState({ repoFullName: "owner/repo", status: "rate_limited" })];
    const segments = [segment({ repoFullName: "owner/repo", segment: "open_issues", status: "rate_limited", rateLimitResetAt: "2026-05-27T00:00:00.000Z" })];

    expect(buildSignalFidelity(1, states, segments)).toMatchObject({
      status: "blocked",
      repoCount: 1,
      blockedRepos: 1,
      rateLimitedRepos: ["owner/repo"],
      nextRecoverableAt: "2026-05-27T00:00:00.000Z",
    });
  });

  it("reports missing registered repo sync state as degraded fidelity", () => {
    expect(buildSignalFidelity(2, [repoState({ repoFullName: "owner/synced", status: "success" })], [])).toMatchObject({
      status: "degraded",
      completeRepos: 1,
      degradedRepos: 1,
    });
  });

  it("marks missing repo sync state as unknown at repo level", () => {
    expect(buildRepoDataQuality("owner/missing", null, [])).toMatchObject({
      status: "unknown",
      partial: false,
      capped: false,
      rateLimited: false,
      warnings: ["No repository sync state is available for owner/missing."],
    });
  });

  it("keeps complete and not-modified segments as complete freshness", () => {
    const quality = buildRepoDataQuality("owner/repo", repoState(), [
      segment({ segment: "metadata", status: "not_modified", fetchedCount: 1 }),
      segment({ segment: "labels", status: "complete", fetchedCount: 8 }),
    ]);

    expect(quality).toMatchObject({
      status: "complete",
      partial: false,
      stale: false,
      incompleteSegments: [],
      segmentCount: 2,
    });
  });

  it("does not carry historical sync errors into complete repo warnings", () => {
    const quality = buildRepoDataQuality("owner/repo", repoState({ status: "success", errorSummary: "old rate limit", warnings: ["old rate limit warning"] }), [
      segment({ segment: "metadata", status: "complete", fetchedCount: 1, expectedCount: 1 }),
      segment({ segment: "open_issues", status: "complete", fetchedCount: 10, expectedCount: 10 }),
    ]);

    expect(quality.status).toBe("complete");
    expect(quality.warnings).toEqual([]);
  });

  it("marks old sync completion timestamps as stale", () => {
    const quality = buildRepoDataQuality(
      "owner/repo",
      repoState({ lastCompletedAt: "2026-05-01T00:00:00.000Z" }),
      [segment({ segment: "open_issues", completedAt: "2026-05-01T00:00:00.000Z" })],
      { nowMs: Date.parse("2026-05-25T00:00:00.000Z") },
    );

    expect(quality).toMatchObject({
      status: "degraded",
      stale: true,
      staleSegments: ["open_issues"],
      warnings: expect.arrayContaining([expect.stringContaining("stale")]),
    });
  });

  it("falls back to repo sync completion time when segment completion is missing", () => {
    const quality = buildRepoDataQuality(
      "owner/repo",
      repoState({ lastCompletedAt: "2026-05-01T00:00:00.000Z" }),
      [segment({ segment: "open_issues", completedAt: undefined })],
      { nowMs: Date.parse("2026-05-25T00:00:00.000Z") },
    );

    expect(quality).toMatchObject({
      status: "degraded",
      stale: true,
      staleSegments: ["open_issues"],
    });
  });

  it("treats explicit stale segment status as stale even without an old timestamp", () => {
    const quality = buildRepoDataQuality(
      "owner/repo",
      repoState(),
      [segment({ segment: "open_pull_requests", status: "stale", completedAt: "2026-05-25T00:00:00.000Z" })],
      { nowMs: Date.parse("2026-05-25T00:01:00.000Z") },
    );

    expect(quality).toMatchObject({
      status: "degraded",
      stale: true,
      staleSegments: ["open_pull_requests"],
    });
  });

  it("uses state warnings to expose cap and rate-limit risk even without segment rows", () => {
    const quality = buildRepoDataQuality(
      "owner/repo",
      repoState({ warnings: ["GitHub sync reached local cap.", "GitHub secondary rate limit observed."] }),
      [],
    );

    expect(quality).toMatchObject({
      status: "degraded",
      capped: true,
      rateLimited: true,
      warnings: expect.arrayContaining([
        "GitHub sync reached local cap.",
        "GitHub secondary rate limit observed.",
        expect.stringContaining("GitHub rate limiting"),
      ]),
    });
  });

  it("returns unknown signal fidelity when no registered repo data exists yet", () => {
    expect(buildSignalFidelity(0, [], [])).toMatchObject({
      status: "unknown",
      repoCount: 0,
      completeRepos: 0,
      degradedRepos: 0,
      blockedRepos: 0,
    });
  });

  it("uses the earliest recoverable rate-limit reset across segments", () => {
    expect(
      buildSignalFidelity(
        2,
        [repoState({ repoFullName: "owner/a", status: "rate_limited" }), repoState({ repoFullName: "owner/b", status: "rate_limited" })],
        [
          segment({ repoFullName: "owner/a", status: "rate_limited", rateLimitResetAt: "2026-05-27T12:00:00.000Z" }),
          segment({ repoFullName: "owner/b", status: "rate_limited", rateLimitResetAt: "2026-05-27T06:00:00.000Z" }),
        ],
      ),
    ).toMatchObject({
      status: "blocked",
      nextRecoverableAt: "2026-05-27T06:00:00.000Z",
      rateLimitedRepos: ["owner/a", "owner/b"],
    });
  });

  it("does not report stale recoverable times from completed segments", () => {
    const fidelity = buildSignalFidelity(
      1,
      [repoState({ repoFullName: "owner/recovered", status: "success" })],
      [segment({ repoFullName: "owner/recovered", status: "complete", rateLimitResetAt: "2026-05-27T00:00:00.000Z" })],
    );

    expect(fidelity.status).toBe("complete");
    expect(fidelity.nextRecoverableAt).toBeUndefined();
  });

  it("summarizes freshness SLOs and redacts audit metadata to counts and areas", () => {
    const report = buildFreshnessSloReport({
      registrySnapshot: { id: "registry", fetchedAt: "2026-05-20T00:00:00.000Z", generatedAt: "2026-05-20T00:00:00.000Z", source: { kind: "raw-github", url: "fixture://registry" }, repoCount: 1, totalEmissionShare: 0.01, warnings: [], repositories: [] },
      scoringSnapshot: null,
      repoCount: 1,
      totals: [{ id: "totals", repoFullName: "owner/repo", openIssuesTotal: 1, openPullRequestsTotal: 1, mergedPullRequestsTotal: 0, closedUnmergedPullRequestsTotal: 0, labelsTotal: 1, sourceKind: "test", fetchedAt: "2026-05-25T00:00:00.000Z", payload: {} }],
      segments: [segment({ repoFullName: "owner/repo", segment: "open_issues", status: "rate_limited", completedAt: "2026-05-25T00:00:00.000Z" })],
      signalSnapshots: [{ id: "pack", signalType: "contributor-decision-pack", targetKey: "alice", payload: {}, generatedAt: "2026-05-24T00:00:00.000Z" }],
      nowMs: Date.parse("2026-05-28T00:00:00.000Z"),
    });

    expect(report).toMatchObject({
      status: "blocked",
      repairRecommended: true,
      staleCount: expect.any(Number),
      blockedCount: 1,
      missingCount: 1,
      warnings: expect.arrayContaining([expect.stringContaining("registry"), expect.stringContaining("repo_segments")]),
    });
    expect(freshnessAuditMetadata(report)).toEqual({
      status: "blocked",
      staleCount: report.staleCount,
      degradedCount: report.degradedCount,
      blockedCount: report.blockedCount,
      missingCount: report.missingCount,
      launchBlockingCount: 3,
      repairRecommended: true,
      affectedAreas: expect.arrayContaining(["registry", "repo_segments", "decision_pack", "scoring_model"]),
    });
  });

  it("marks supplied freshness sources fresh when observations are inside their SLOs", () => {
    const report = buildFreshnessSloReport({
      registrySnapshot: { id: "registry", fetchedAt: "2026-05-25T00:00:00.000Z", generatedAt: "2026-05-25T00:00:00.000Z", source: { kind: "raw-github", url: "fixture://registry" }, repoCount: 1, totalEmissionShare: 0.01, warnings: [], repositories: [] },
      scoringSnapshot: { id: "scoring", sourceKind: "test", sourceUrl: "fixture://scoring", fetchedAt: "2026-05-25T00:00:00.000Z", activeModel: "current_density_model", constants: {}, programmingLanguages: {}, warnings: [], payload: {} },
      repoCount: 1,
      syncStates: [repoState()],
      totals: [totals()],
      segments: [segment()],
      signalSnapshots: [
        { id: "decision", signalType: "contributor-decision-pack", targetKey: "oktofeesh1", payload: {}, generatedAt: "2026-05-25T00:00:00.000Z" },
        { id: "queue", signalType: "queue-health", targetKey: "owner/repo", payload: {}, generatedAt: "2026-05-25T00:00:00.000Z" },
      ],
      bounties: [{ id: "bounty", repoFullName: "owner/repo", issueNumber: 1, status: "open", payload: {}, discoveredAt: "2026-05-25T00:00:00.000Z", updatedAt: "2026-05-25T00:00:00.000Z" }],
      expectedDecisionPackKeys: ["oktofeesh1"],
      nowMs: Date.parse("2026-05-25T01:00:00.000Z"),
    });

    expect(report).toMatchObject({
      status: "fresh",
      staleCount: 0,
      degradedCount: 0,
      blockedCount: 0,
      missingCount: 0,
      launchBlockingCount: 0,
      repairRecommended: false,
      warnings: [],
    });
    expect(report.items.map((item) => item.area).sort()).toEqual(["bounty_data", "decision_pack", "github_totals", "registry", "repo_segments", "scoring_model", "signal_snapshot"]);
  });

  it("degrades freshness when repo segments are active and totals are missing", () => {
    const report = buildFreshnessSloReport({
      repoCount: 1,
      syncStates: [repoState({ status: "partial" })],
      totals: [],
      segments: [segment()],
      nowMs: Date.parse("2026-05-25T01:00:00.000Z"),
    });

    expect(report).toMatchObject({
      status: "degraded",
      degradedCount: 1,
      missingCount: 1,
      warnings: expect.arrayContaining(["github_totals:registered_repos is missing", "repo_segments:registered_repos is degraded"]),
    });
  });

  it("treats malformed freshness timestamps as missing observations", () => {
    const report = buildFreshnessSloReport({
      signalSnapshots: [{ id: "queue", signalType: "queue-health", targetKey: "owner/repo", payload: {}, generatedAt: "not-a-date" }],
      nowMs: Date.parse("2026-05-25T01:00:00.000Z"),
    });

    expect(report).toMatchObject({
      status: "degraded",
      missingCount: 1,
      launchBlockingCount: 0,
      warnings: ["signal_snapshot:owner/repo is missing"],
    });
    expect(report.items[0]).toMatchObject({ area: "signal_snapshot", observedAt: null, status: "missing" });
  });

  it("does not degrade when optional bounties and decision packs are absent without expected targets", () => {
    expect(
      buildFreshnessSloReport({
        signalSnapshots: [],
        bounties: [],
        nowMs: Date.parse("2026-05-25T01:00:00.000Z"),
      }),
    ).toMatchObject({
      status: "fresh",
      missingCount: 0,
      launchBlockingCount: 0,
      repairRecommended: false,
      items: [],
      warnings: [],
    });
  });

  it("tracks signal freshness per target and uses each target's latest observation", () => {
    const report = buildFreshnessSloReport({
      signalSnapshots: [
        { id: "old-a", signalType: "queue-health", targetKey: "owner/a", payload: {}, generatedAt: "2026-05-24T00:00:00.000Z" },
        { id: "new-a", signalType: "queue-health", targetKey: "owner/a", payload: {}, generatedAt: "2026-05-25T00:30:00.000Z" },
        { id: "old-b", signalType: "queue-health", targetKey: "owner/b", payload: {}, generatedAt: "2026-05-24T00:00:00.000Z" },
      ],
      nowMs: Date.parse("2026-05-25T01:00:00.000Z"),
    });

    expect(report).toMatchObject({
      status: "degraded",
      staleCount: 1,
      launchBlockingCount: 0,
      repairRecommended: true,
    });
    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ area: "signal_snapshot", targetKey: "owner/a", status: "fresh", observedAt: "2026-05-25T00:30:00.000Z", launchBlocking: false }),
        expect.objectContaining({ area: "signal_snapshot", targetKey: "owner/b", status: "stale", observedAt: "2026-05-24T00:00:00.000Z", launchBlocking: false }),
      ]),
    );
  });

  it("keeps sparse freshness inputs scoped to explicitly observed sources", () => {
    const totalsOnly = buildFreshnessSloReport({
      totals: [totals()],
      nowMs: Date.parse("2026-05-25T01:00:00.000Z"),
    });
    const missingSegments = buildFreshnessSloReport({
      repoCount: 1,
      syncStates: [repoState({ status: "never_synced" })],
      segments: [],
      nowMs: Date.parse("2026-05-25T01:00:00.000Z"),
    });
    const discoveredBounty = buildFreshnessSloReport({
      bounties: [{ id: "bounty", repoFullName: "owner/repo", issueNumber: 1, status: "open", payload: {}, discoveredAt: "2026-05-25T00:30:00.000Z" }],
      nowMs: Date.parse("2026-05-25T01:00:00.000Z"),
    });

    expect(totalsOnly.items).toEqual([]);
    expect(missingSegments).toMatchObject({
      status: "degraded",
      missingCount: 1,
      warnings: ["repo_segments:registered_repos is missing"],
    });
    expect(discoveredBounty).toMatchObject({ status: "fresh", repairRecommended: false });
    expect(discoveredBounty.items[0]).toMatchObject({ area: "bounty_data", ageSeconds: 1800, observedAt: "2026-05-25T00:30:00.000Z" });
  });

  it("degrades core fidelity when a registered repo has no segment coverage yet", () => {
    expect(buildCoreSignalFidelity(1, [repoState()], [], [], [])).toMatchObject({
      status: "degraded",
      incompleteRepos: ["owner/repo"],
      degradedRepos: 1,
    });
  });

  it("uses segment expected counts for rate-limited core checks before totals exist", () => {
    expect(
      buildCoreSignalFidelity(
        1,
        [repoState({ status: "rate_limited" })],
        [segment({ segment: "open_issues", status: "waiting_rate_limit", fetchedCount: 1, expectedCount: 2, rateLimitResetAt: "2026-05-27T00:00:00.000Z" })],
        [],
        [],
      ),
    ).toMatchObject({
      status: "blocked",
      incompleteRepos: ["owner/repo"],
      waitingForRateLimitRepos: ["owner/repo"],
    });
  });

  it("does not block repo fidelity when a rate-limited segment already has complete stored coverage", () => {
    const recoveredSegment = segment({
      repoFullName: "owner/recovered",
      segment: "recent_merged_pull_requests",
      status: "waiting_rate_limit",
      fetchedCount: 33,
      expectedCount: 33,
      rateLimitResetAt: "2026-05-27T00:00:00.000Z",
    });

    expect(buildRepoDataQuality("owner/recovered", repoState({ repoFullName: "owner/recovered" }), [recoveredSegment])).toMatchObject({
      status: "complete",
      partial: false,
      rateLimited: false,
      incompleteSegments: [],
      rateLimitedSegments: [],
    });
    expect(buildSignalFidelity(1, [repoState({ repoFullName: "owner/recovered" })], [recoveredSegment])).toMatchObject({
      status: "complete",
      blockedRepos: 0,
      rateLimitedRepos: [],
      nextRecoverableAt: undefined,
    });
  });

  it("keeps incomplete waiting-rate-limit segments blocked until coverage catches up", () => {
    const waitingSegment = segment({
      repoFullName: "owner/waiting",
      segment: "open_issues",
      status: "waiting_rate_limit",
      fetchedCount: 9,
      expectedCount: 10,
      rateLimitResetAt: "2026-05-27T00:00:00.000Z",
    });

    expect(buildRepoDataQuality("owner/waiting", repoState({ repoFullName: "owner/waiting" }), [waitingSegment])).toMatchObject({
      status: "blocked",
      partial: true,
      rateLimited: true,
      incompleteSegments: ["open_issues"],
      rateLimitedSegments: ["open_issues"],
    });
    expect(buildSignalFidelity(1, [repoState({ repoFullName: "owner/waiting" })], [waitingSegment])).toMatchObject({
      status: "blocked",
      blockedRepos: 1,
      rateLimitedRepos: ["owner/waiting"],
      nextRecoverableAt: "2026-05-27T00:00:00.000Z",
    });
  });

  it("normalizes malformed persisted freshness snapshots without crashing report generation", () => {
    const report = buildFreshnessSloReport({
      signalSnapshots: [
        { id: "malformed", payload: {}, generatedAt: "2026-05-25T00:00:00.000Z" } as never,
        { id: "decision", signalType: "contributor-decision-pack", targetKey: undefined, payload: {}, generatedAt: "2026-05-25T00:30:00.000Z" } as never,
      ],
      expectedDecisionPackKeys: ["jsonbored"],
      bounties: [{ id: "bounty", repoFullName: "owner/repo", issueNumber: 1, status: "open", payload: {}, discoveredAt: "2026-05-25T00:30:00.000Z", updatedAt: undefined }],
      nowMs: Date.parse("2026-05-25T01:00:00.000Z"),
    });

    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ area: "signal_snapshot", targetKey: "undefined\u0000undefined", status: "fresh" }),
        expect.objectContaining({ area: "decision_pack", targetKey: "contributor-decision-pack", status: "fresh" }),
        expect.objectContaining({ area: "decision_pack", targetKey: "jsonbored", status: "missing" }),
        expect.objectContaining({ area: "bounty_data", targetKey: "all_bounties", observedAt: "2026-05-25T00:30:00.000Z" }),
      ]),
    );
  });

  it("requires authoritative open-data totals for core fidelity and treats history as sampled", () => {
    const segments = [
      segment({ segment: "metadata", fetchedCount: 1, expectedCount: 1 }),
      segment({ segment: "labels", fetchedCount: 2, expectedCount: 2 }),
      segment({ segment: "open_issues", fetchedCount: 2911, expectedCount: 2911 }),
      segment({ segment: "open_pull_requests", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_files", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_reviews", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "check_summaries", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "recent_merged_pull_requests", status: "sampled", fetchedCount: 200, expectedCount: 6411 }),
    ];
    const detailStates = Array.from({ length: 167 }, (_, index) => detailState(index + 1));

    expect(buildCoreSignalFidelity(1, [repoState()], segments, [totals()], detailStates)).toMatchObject({
      status: "complete",
      completeRepos: 1,
      incompleteRepos: [],
      historyCoverage: "sampled",
    });
  });

  it("does not count a refreshing segment as degraded when last complete coverage is still usable", () => {
    const segments = [
      segment({ segment: "metadata", fetchedCount: 1, expectedCount: 1 }),
      segment({ segment: "labels", fetchedCount: 2, expectedCount: 2 }),
      segment({ segment: "open_issues", status: "running", fetchedCount: 2911, expectedCount: 2911, completedAt: "2026-05-25T00:00:00.000Z" }),
      segment({ segment: "open_pull_requests", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_files", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_reviews", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "check_summaries", fetchedCount: 167, expectedCount: 167 }),
    ];
    const detailStates = Array.from({ length: 167 }, (_, index) => detailState(index + 1));

    expect(buildCoreSignalFidelity(1, [repoState({ status: "running" })], segments, [totals()], detailStates)).toMatchObject({
      status: "complete",
      completeRepos: 1,
      refreshingRepos: ["owner/repo"],
      incompleteRepos: [],
    });
  });

  it("marks core fidelity degraded when open issue fetch count is below GitHub totals", () => {
    const segments = [
      segment({ segment: "metadata", fetchedCount: 1, expectedCount: 1 }),
      segment({ segment: "labels", fetchedCount: 2, expectedCount: 2 }),
      segment({ segment: "open_issues", fetchedCount: 1100, expectedCount: 2911 }),
      segment({ segment: "open_pull_requests", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_files", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_reviews", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "check_summaries", fetchedCount: 167, expectedCount: 167 }),
    ];
    const detailStates = Array.from({ length: 167 }, (_, index) => detailState(index + 1));

    expect(buildCoreSignalFidelity(1, [repoState()], segments, [totals()], detailStates)).toMatchObject({
      status: "degraded",
      incompleteRepos: ["owner/repo"],
      degradedRepos: 1,
    });
  });

  it("separates blocked core fidelity from full historical coverage", () => {
    const segments = [
      segment({ segment: "metadata", fetchedCount: 1, expectedCount: 1 }),
      segment({ segment: "labels", fetchedCount: 2, expectedCount: 2 }),
      segment({ segment: "open_issues", status: "waiting_rate_limit", fetchedCount: 2900, expectedCount: 2911, rateLimitResetAt: "2026-05-25T14:25:55.000Z" }),
      segment({ segment: "open_pull_requests", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_files", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_reviews", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "check_summaries", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "recent_merged_pull_requests", fetchedCount: 6411, expectedCount: 6411 }),
    ];

    expect(buildCoreSignalFidelity(1, [repoState({ status: "rate_limited" })], segments, [totals()], [])).toMatchObject({
      status: "blocked",
      blockedRepos: 1,
      waitingForRateLimitRepos: ["owner/repo"],
      incompleteRepos: ["owner/repo"],
      historyCoverage: "full",
    });
  });

  it("keeps core fidelity complete when rate-limited required segments have last complete coverage", () => {
    const segments = [
      segment({ segment: "metadata", fetchedCount: 1, expectedCount: 1 }),
      segment({ segment: "labels", fetchedCount: 2, expectedCount: 2 }),
      segment({
        segment: "open_issues",
        status: "waiting_rate_limit",
        fetchedCount: 2911,
        expectedCount: 2911,
        completedAt: "2026-05-25T00:00:00.000Z",
        rateLimitResetAt: "2026-05-25T14:25:55.000Z",
      }),
      segment({ segment: "open_pull_requests", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_files", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_reviews", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "check_summaries", fetchedCount: 167, expectedCount: 167 }),
    ];
    const detailStates = Array.from({ length: 167 }, (_, index) => detailState(index + 1));

    expect(buildCoreSignalFidelity(1, [repoState({ status: "rate_limited" })], segments, [totals()], detailStates)).toMatchObject({
      status: "complete",
      completeRepos: 1,
      blockedRepos: 0,
      incompleteRepos: [],
      waitingForRateLimitRepos: [],
    });
  });

  it("returns unknown core fidelity before any repo signal exists", () => {
    expect(buildCoreSignalFidelity(0, [], [], [], [])).toMatchObject({
      status: "unknown",
      repoCount: 0,
      completeRepos: 0,
      historyCoverage: "counts_only",
    });
  });
});

function repoState(overrides: Partial<RepoSyncStateRecord> = {}): RepoSyncStateRecord {
  return {
    repoFullName: "owner/repo",
    status: "success",
    sourceKind: "github",
    openIssuesCount: 0,
    openPullRequestsCount: 0,
    recentMergedPullRequestsCount: 0,
    lastCompletedAt: "2026-05-25T00:00:00.000Z",
    warnings: [],
    ...overrides,
  };
}

function segment(overrides: Partial<RepoSyncSegmentRecord> = {}): RepoSyncSegmentRecord {
  return {
    repoFullName: "owner/repo",
    segment: "metadata",
    status: "complete",
    sourceKind: "github",
    mode: "light",
    fetchedCount: 1,
    pageCount: 1,
    completedAt: "2026-05-25T00:00:00.000Z",
    warnings: [],
    ...overrides,
  };
}

function totals(overrides: Partial<RepoGithubTotalsSnapshotRecord> = {}): RepoGithubTotalsSnapshotRecord {
  return {
    id: "totals-owner-repo",
    repoFullName: "owner/repo",
    openIssuesTotal: 2911,
    openPullRequestsTotal: 167,
    mergedPullRequestsTotal: 6411,
    closedUnmergedPullRequestsTotal: 776,
    labelsTotal: 2,
    sourceKind: "github",
    fetchedAt: "2026-05-25T00:00:00.000Z",
    payload: {},
    ...overrides,
  };
}

function detailState(pullNumber: number, overrides: Partial<PullRequestDetailSyncStateRecord> = {}): PullRequestDetailSyncStateRecord {
  return {
    repoFullName: "owner/repo",
    pullNumber,
    status: "complete",
    lastSyncedAt: "2026-05-25T00:00:00.000Z",
    updatedAt: "2026-05-25T00:00:00.000Z",
    ...overrides,
  };
}
