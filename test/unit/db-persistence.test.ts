import { describe, expect, it } from "vitest";
import {
  getPullRequest,
  markPullRequestManualReviewLabelApplied,
  clearPullRequestManualReviewLabelProvenance,
  getActiveReviewStartedAt,
  getBounty,
  getContributorScoringProfile,
  getOpenUpstreamDriftReportByFingerprint,
  hasActiveReviewForHeadSha,
  hasReviewedForHeadSha,
  listContributorRepoStats,
  listLatestRepoGithubTotalsSnapshots,
  listLatestSignalSnapshotsForTargets,
  listRepoPullRequestFilePaths,
  listSignalSnapshots,
  listStaleActiveReviewTracking,
  persistBountyLifecycleEvent,
  persistRepoGithubTotalsSnapshot,
  persistSignalSnapshot,
  startActiveReviewTracking,
  loadOrphanRequeueContext,
  listMergedPullRequestsInWindow,
  upsertPullRequestFromGitHub,
  upsertRepositoryFromGitHub,
  terminalizeActiveReviewsFromBeforeBoot,
  terminalizeActiveReviewTracking,
  updateUpstreamDriftReportIssue,
  upsertBounty,
  upsertContributorRepoStat,
  upsertContributorScoringProfile,
  upsertPullRequestFile,
  upsertUpstreamDriftReport,
} from "../../src/db/repositories";
import { buildContributorEvidenceGraph } from "../../src/services/contributor-evidence-graph";
import type { PullRequestFileRecord, PullRequestRecord, RepositoryRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

describe("database persistence helpers", () => {
  it("round-trips drift, lifecycle, and scoring persistence helpers", async () => {
    const env = createTestEnv();
    await upsertUpstreamDriftReport(env, {
      id: "drift-1",
      fingerprint: "registry:abc",
      severity: "high",
      status: "open",
      summary: "Registry contract changed",
      affectedAreas: ["registry", "source"],
      previousRulesetId: null,
      currentRulesetId: "ruleset-2",
      payload: { changed: true },
      generatedAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:01:00.000Z",
    });

    expect(await getOpenUpstreamDriftReportByFingerprint(env, "registry:abc")).toMatchObject({
      fingerprint: "registry:abc",
      status: "open",
      affectedAreas: ["registry", "source"],
    });

    await updateUpstreamDriftReportIssue(env, "registry:abc", { number: 42, url: "https://github.com/JSONbored/loopover/issues/42" });
    expect(await getOpenUpstreamDriftReportByFingerprint(env, "registry:abc")).toMatchObject({
      issueNumber: 42,
      issueUrl: "https://github.com/JSONbored/loopover/issues/42",
    });

    await upsertContributorScoringProfile(env, {
      login: "JSONbored",
      scoringModelSnapshotId: "scoring-1",
      payload: { scoreability: "ready" },
      generatedAt: "2026-05-30T00:02:00.000Z",
    });
    expect(await getContributorScoringProfile(env, "JSONbored")).toMatchObject({
      login: "JSONbored",
      payload: { scoreability: "ready" },
    });

    await persistBountyLifecycleEvent(env, {
      id: "bounty-event-1",
      bountyId: "bounty-1",
      repoFullName: "JSONbored/loopover",
      issueNumber: 7,
      status: "Completed",
      payload: { target_alpha: "74.0000" },
      generatedAt: "2026-05-30T00:05:00.000Z",
    });

    await expect(env.DB.prepare("select count(*) as count from bounty_lifecycle_events").first<{ count: number }>()).resolves.toMatchObject({ count: 1 });
  });

  describe("upsertBounty (#9080)", () => {
    it("updates the existing row in place on a same-id re-import", async () => {
      const env = createTestEnv();
      await upsertBounty(env, {
        id: "bounty-1",
        repoFullName: "JSONbored/loopover",
        issueNumber: 7,
        status: "Open",
        amountText: "5.0000",
        payload: { bounty_alpha: "5.0000" },
      });
      await upsertBounty(env, {
        id: "bounty-1",
        repoFullName: "JSONbored/loopover",
        issueNumber: 7,
        status: "Completed",
        amountText: "5.0000",
        payload: { bounty_alpha: "5.0000" },
      });

      expect(await getBounty(env, "bounty-1")).toMatchObject({ id: "bounty-1", status: "Completed" });
      await expect(env.DB.prepare("select count(*) as count from bounties").first<{ count: number }>()).resolves.toMatchObject({ count: 1 });
    });

    it("reconciles onto the existing (repoFullName, issueNumber) row instead of throwing when upstream re-issues a bounty under a new id (#9080)", async () => {
      const env = createTestEnv();
      await upsertBounty(env, {
        id: "bounty-old",
        repoFullName: "JSONbored/loopover",
        issueNumber: 7,
        status: "Cancelled",
        amountText: "0.0000",
        payload: { bounty_alpha: "0.0000" },
      });

      // Upstream re-issues the bounty on the SAME issue under a brand-new id -- before #9080 this threw
      // (unhandled conflict on the (repo_full_name, issue_number) unique index), 500ing the whole import
      // batch and wedging every subsequent import on the same row.
      await expect(
        upsertBounty(env, {
          id: "bounty-new",
          repoFullName: "JSONbored/loopover",
          issueNumber: 7,
          status: "Open",
          amountText: "12.0000",
          payload: { bounty_alpha: "12.0000" },
        }),
      ).resolves.toBeUndefined();

      // Exactly one row survives for that (repo, issue) -- the id column is never part of the update, so
      // the surviving row keeps its ORIGINAL id (bounty_lifecycle_events rows already keyed to it are not
      // orphaned), but every other column reconciles onto the newly-imported values.
      await expect(env.DB.prepare("select count(*) as count from bounties").first<{ count: number }>()).resolves.toMatchObject({ count: 1 });
      expect(await getBounty(env, "bounty-old")).toMatchObject({
        id: "bounty-old",
        status: "Open",
        amountText: "12.0000",
      });
      expect(await getBounty(env, "bounty-new")).toBeNull();
    });
  });

  it("returns an empty array when no totals snapshots exist", async () => {
    const env = createTestEnv();
    expect(await listLatestRepoGithubTotalsSnapshots(env)).toEqual([]);
  });

  it("returns latest totals per repo and merges duplicate contributor stats case-insensitively", async () => {
    const env = createTestEnv();
    await persistRepoGithubTotalsSnapshot(env, totalsSnapshot("totals-old", "owner/b", "2026-05-29T00:00:00.000Z", 1));
    await persistRepoGithubTotalsSnapshot(env, totalsSnapshot("totals-new", "owner/b", "2026-05-30T00:00:00.000Z", 3));
    await persistRepoGithubTotalsSnapshot(env, totalsSnapshot("totals-a", "owner/a", "2026-05-30T00:00:00.000Z", 2));

    expect(await listLatestRepoGithubTotalsSnapshots(env)).toMatchObject([
      { repoFullName: "owner/a", openIssuesTotal: 2 },
      { repoFullName: "owner/b", openIssuesTotal: 3 },
    ]);

    await upsertContributorRepoStat(env, contributorStat("jsonbored", "owner/repo", 2, ["bug"], "2026-05-29T00:00:00.000Z"));
    await env.DB.prepare(
      "insert into contributor_repo_stats (id, login, repo_full_name, pull_requests, merged_pull_requests, open_pull_requests, issues, stale_pull_requests, unlinked_pull_requests, dominant_labels_json, last_activity_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("jsonbored#OWNER/REPO", "jsonbored", "OWNER/REPO", 5, 4, 1, 3, 2, 1, JSON.stringify(["docs", "bug"]), "2026-05-30T00:00:00.000Z", "2026-05-30T00:01:00.000Z")
      .run();

    expect(await listContributorRepoStats(env, "JSONbored")).toEqual([
      expect.objectContaining({
        repoFullName: "OWNER/REPO",
        pullRequests: 5,
        mergedPullRequests: 4,
        dominantLabels: ["bug", "docs"],
        lastActivityAt: "2026-05-30T00:00:00.000Z",
      }),
    ]);
  });

  it("loads latest totals for many repos without building an oversized OR predicate", async () => {
    const env = createTestEnv();
    const repoCount = 1200;
    for (let index = 0; index < repoCount; index += 1) {
      const repoFullName = `owner/repo-${String(index).padStart(4, "0")}`;
      await persistRepoGithubTotalsSnapshot(env, totalsSnapshot(`totals-${index}-old`, repoFullName, "2026-05-29T00:00:00.000Z", 1));
      await persistRepoGithubTotalsSnapshot(env, totalsSnapshot(`totals-${index}-new`, repoFullName, "2026-05-30T00:00:00.000Z", index));
    }

    const snapshots = await listLatestRepoGithubTotalsSnapshots(env);

    expect(snapshots).toHaveLength(repoCount);
    expect(snapshots[0]).toMatchObject({ repoFullName: "owner/repo-0000", openIssuesTotal: 0 });
    expect(snapshots.at(-1)).toMatchObject({ repoFullName: "owner/repo-1199", openIssuesTotal: 1199 });
  });

  it("caps contributor-graph file-path loading and still builds path edges from the capped set", async () => {
    const env = createTestEnv();
    const repoFullName = "owner/big-repo";
    // Seed more than the hard cap (500) of distinct file paths across several authored PRs.
    const seededPaths = 600;
    const pullNumbers = [1, 2, 3, 4, 5, 6];
    for (let index = 0; index < seededPaths; index += 1) {
      const pullNumber = pullNumbers[index % pullNumbers.length]!;
      await upsertPullRequestFile(env, pullRequestFile(repoFullName, pullNumber, `src/path-${String(index).padStart(4, "0")}.ts`));
    }

    // Hard cap: the path-only query never returns more than 500 rows even when more exist.
    const allPaths = await listRepoPullRequestFilePaths(env, repoFullName, { pullNumbers });
    expect(allPaths).toHaveLength(500);
    expect(allPaths.every((entry) => entry.repoFullName === repoFullName && pullNumbers.includes(entry.pullNumber) && entry.path.length > 0)).toBe(true);

    // A smaller requested limit is honored; a too-large limit is clamped down to the cap.
    const smallLimit = await listRepoPullRequestFilePaths(env, repoFullName, { pullNumbers, limit: 50 });
    expect(smallLimit).toHaveLength(50);
    const oversizedLimit = await listRepoPullRequestFilePaths(env, repoFullName, { pullNumbers, limit: 5000 });
    expect(oversizedLimit).toHaveLength(500);

    // Filtering by a subset of pull numbers still respects the cap and only returns matching PRs.
    const subset = await listRepoPullRequestFilePaths(env, repoFullName, { pullNumbers: [1, 2], limit: 500 });
    expect(subset.length).toBeGreaterThan(0);
    expect(subset.every((entry) => entry.pullNumber === 1 || entry.pullNumber === 2)).toBe(true);

    // The capped, path-only set still feeds buildPathEdges correctly via the evidence graph.
    const cappedPaths = await listRepoPullRequestFilePaths(env, repoFullName, { pullNumbers, limit: 500 });
    const graph = buildContributorEvidenceGraph({
      login: "dev",
      generatedAt: "2026-05-30T00:00:00.000Z",
      profile: graphProfile(repoFullName),
      outcomeHistory: graphHistory(),
      roleContexts: [],
      repositories: [graphRepo(repoFullName)],
      pullRequests: pullNumbers.map((number) => graphPr(repoFullName, number)),
      pullRequestFiles: cappedPaths,
    });

    expect(graph.paths.length).toBeGreaterThan(0);
    expect(graph.paths.every((entry) => entry.repoFullName === repoFullName)).toBe(true);
    // Every emitted path edge traces back to a path that survived the cap.
    const cappedPathSet = new Set(cappedPaths.map((entry) => entry.path));
    expect(graph.paths.every((entry) => cappedPathSet.has(entry.path))).toBe(true);
  });

  it("REGRESSION: upsertPullRequestFile targets the id PRIMARY KEY in its ON CONFLICT clause, not the secondary unique index", async () => {
    // `id` is a pure function of (repoFullName, pullNumber, path) — the exact same fields the secondary
    // unique index covers — so targeting that index instead of `id` leaves the primary key unprotected by
    // Postgres's upsert machinery on the self-host Postgres backend (see #977's pg-adapter): a genuinely
    // concurrent second writer can still raise a raw duplicate-key error on `pull_request_files_pkey` even
    // though the composite fields "agree." Asserting the generated SQL's conflict target pins the fix so a
    // future revert back to the composite target doesn't silently reopen the race.
    const env = createTestEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    const conflictClauses: string[] = [];
    env.DB.prepare = ((sql: string) => {
      if (/insert\s+into\s+["'`]?pull_request_files/i.test(sql)) {
        const match = /on\s+conflict\s*\(([^)]*)\)/i.exec(sql);
        if (match) conflictClauses.push(match[1]!.trim());
      }
      return realPrepare(sql);
    }) as typeof env.DB.prepare;

    await upsertPullRequestFile(env, pullRequestFile("owner/repo", 1, "src/a.ts"));

    expect(conflictClauses).toHaveLength(1);
    expect(conflictClauses[0]).toMatch(/^["'`]?(pull_request_files["'`]?\.["'`]?)?id["'`]?$/i);

    // Functional guard: a same-key upsert still updates the existing row in place rather than duplicating it.
    await upsertPullRequestFile(env, { ...pullRequestFile("owner/repo", 1, "src/a.ts"), additions: 99 });
    const rows = await listRepoPullRequestFilePaths(env, "owner/repo", { pullNumbers: [1] });
    expect(rows).toHaveLength(1);
  });
});

function pullRequestFile(repoFullName: string, pullNumber: number, path: string): PullRequestFileRecord {
  return { repoFullName, pullNumber, path, status: "modified", additions: 5, deletions: 1, changes: 6, payload: {} };
}

function graphProfile(repoFullName: string) {
  return {
    login: "dev",
    generatedAt: "2026-05-30T00:00:00.000Z",
    github: { login: "dev", topLanguages: ["TypeScript"], source: "github" },
    source: "github_cache",
    registeredRepoActivity: { pullRequests: 6, mergedPullRequests: 6, issues: 0, reposTouched: [repoFullName], dominantLabels: [] },
    trustSignals: { evidenceScore: 0, level: "new", unlinkedOpenPullRequests: 0, maintainerAssociatedPullRequests: 0 },
  } as unknown as Parameters<typeof buildContributorEvidenceGraph>[0]["profile"];
}

function graphHistory() {
  return {
    login: "dev",
    generatedAt: "2026-05-30T00:00:00.000Z",
    source: "github_cache",
    totals: {},
    repoOutcomes: [],
    successPatterns: [],
    failurePatterns: [],
    summary: "fixture",
  } as unknown as Parameters<typeof buildContributorEvidenceGraph>[0]["outcomeHistory"];
}

function graphRepo(fullName: string): RepositoryRecord {
  const [owner, name] = fullName.split("/") as [string, string];
  return {
    fullName,
    owner,
    name,
    isInstalled: true,
    isRegistered: true,
    isPrivate: false,
    defaultBranch: "main",
    registryConfig: { repo: fullName, emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: {}, trustedLabelPipeline: false, maintainerCut: 0, raw: {} },
  };
}

function graphPr(repoFullName: string, number: number): PullRequestRecord {
  return {
    repoFullName,
    number,
    title: `PR ${number}`,
    state: "merged",
    authorLogin: "dev",
    authorAssociation: "CONTRIBUTOR",
    labels: [],
    linkedIssues: [],
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    mergedAt: "2026-05-27T00:00:00.000Z",
  };
}

function totalsSnapshot(id: string, repoFullName: string, fetchedAt: string, openIssuesTotal: number) {
  return {
    id,
    repoFullName,
    openIssuesTotal,
    openPullRequestsTotal: 1,
    mergedPullRequestsTotal: 2,
    closedUnmergedPullRequestsTotal: 0,
    labelsTotal: 3,
    sourceKind: "test" as const,
    fetchedAt,
    rateLimitRemaining: null,
    rateLimitResetAt: null,
    payload: { repoFullName },
  };
}

function contributorStat(login: string, repoFullName: string, pullRequests: number, dominantLabels: string[], lastActivityAt: string) {
  return {
    login,
    repoFullName,
    pullRequests,
    mergedPullRequests: 1,
    openPullRequests: 1,
    issues: 1,
    stalePullRequests: 0,
    unlinkedPullRequests: 0,
    dominantLabels,
    lastActivityAt,
  };
}

describe("active-review tracking (#review-evasion-protection)", () => {
  async function rawRow(env: Env, repoFullName: string, pullNumber: number) {
    return env.DB.prepare("select head_sha, author_login, delivery_id, status, started_at from active_review_tracking where repo_full_name = ? and pull_number = ?")
      .bind(repoFullName, pullNumber)
      .first<{ head_sha: string; author_login: string | null; delivery_id: string; status: string; started_at: string }>();
  }

  it("hasActiveReviewForHeadSha is false when no row exists at all", async () => {
    const env = createTestEnv();
    expect(await hasActiveReviewForHeadSha(env, "owner/repo", 1, "sha1")).toBe(false);
  });

  it("starts tracking and reads it back for the exact head, but not a different head or PR", async () => {
    const env = createTestEnv();
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", authorLogin: "farmer99", deliveryId: "delivery-1" });
    expect(await hasActiveReviewForHeadSha(env, "owner/repo", 1, "sha1")).toBe(true);
    expect(await hasActiveReviewForHeadSha(env, "owner/repo", 1, "sha-different")).toBe(false);
    expect(await hasActiveReviewForHeadSha(env, "owner/repo", 2, "sha1")).toBe(false);
    const row = await rawRow(env, "owner/repo", 1);
    expect(row).toMatchObject({ head_sha: "sha1", author_login: "farmer99", delivery_id: "delivery-1", status: "active" });
  });

  it("is idempotent for a redelivery/retry of the SAME head while still active -- startedAt/deliveryId are preserved, not clobbered", async () => {
    const env = createTestEnv();
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", authorLogin: "farmer99", deliveryId: "delivery-1" });
    const firstRow = await rawRow(env, "owner/repo", 1);
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", authorLogin: "farmer99", deliveryId: "delivery-RETRY" });
    const secondRow = await rawRow(env, "owner/repo", 1);
    expect(secondRow?.delivery_id).toBe("delivery-1"); // NOT "delivery-RETRY" -- the original start wins.
    expect(secondRow?.started_at).toBe(firstRow?.started_at);
  });

  it("a NEW head restarts the active window -- overwrites the row and clears the old head's match", async () => {
    const env = createTestEnv();
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", deliveryId: "delivery-1" });
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha2", deliveryId: "delivery-2" });
    expect(await hasActiveReviewForHeadSha(env, "owner/repo", 1, "sha1")).toBe(false);
    expect(await hasActiveReviewForHeadSha(env, "owner/repo", 1, "sha2")).toBe(true);
    const row = await rawRow(env, "owner/repo", 1);
    expect(row).toMatchObject({ head_sha: "sha2", delivery_id: "delivery-2", status: "active" });
  });

  it("restarting on a PREVIOUSLY TERMINALIZED row for the SAME head still refreshes startedAt/deliveryId -- a terminal row is not treated as still-active", async () => {
    const env = createTestEnv();
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", deliveryId: "delivery-1" });
    await terminalizeActiveReviewTracking(env, "owner/repo", 1);
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", deliveryId: "delivery-2" });
    const row = await rawRow(env, "owner/repo", 1);
    expect(row).toMatchObject({ head_sha: "sha1", delivery_id: "delivery-2", status: "active" });
    expect(await hasActiveReviewForHeadSha(env, "owner/repo", 1, "sha1")).toBe(true);
  });

  it("terminalizeActiveReviewTracking clears an active row and reports true; a second call is a no-op reporting false", async () => {
    const env = createTestEnv();
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", deliveryId: "delivery-1" });
    expect(await terminalizeActiveReviewTracking(env, "owner/repo", 1)).toBe(true);
    expect(await hasActiveReviewForHeadSha(env, "owner/repo", 1, "sha1")).toBe(false);
    expect(await terminalizeActiveReviewTracking(env, "owner/repo", 1)).toBe(false);
  });

  it("terminalizeActiveReviewTracking on a nonexistent row is a no-op reporting false", async () => {
    const env = createTestEnv();
    expect(await terminalizeActiveReviewTracking(env, "owner/repo", 999)).toBe(false);
  });

  it("onlyIfHeadSha guards the terminalize: a mismatched head does not clear the row; a matching head does", async () => {
    const env = createTestEnv();
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", deliveryId: "delivery-1" });
    expect(await terminalizeActiveReviewTracking(env, "owner/repo", 1, { onlyIfHeadSha: "sha-wrong" })).toBe(false);
    expect(await hasActiveReviewForHeadSha(env, "owner/repo", 1, "sha1")).toBe(true); // still active -- guarded, not cleared.
    expect(await terminalizeActiveReviewTracking(env, "owner/repo", 1, { onlyIfHeadSha: "sha1" })).toBe(true);
    expect(await hasActiveReviewForHeadSha(env, "owner/repo", 1, "sha1")).toBe(false);
  });

  it("hasReviewedForHeadSha is false when no row exists at all", async () => {
    const env = createTestEnv();
    expect(await hasReviewedForHeadSha(env, "owner/repo", 1, "sha1")).toBe(false);
  });

  it("hasReviewedForHeadSha (#draft-evasion-post-review): true for the exact head whether the row is still active OR already terminal -- unlike hasActiveReviewForHeadSha, a terminalized (published) review still counts", async () => {
    const env = createTestEnv();
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", deliveryId: "delivery-1" });
    expect(await hasReviewedForHeadSha(env, "owner/repo", 1, "sha1")).toBe(true); // active
    expect(await hasActiveReviewForHeadSha(env, "owner/repo", 1, "sha1")).toBe(true);

    await terminalizeActiveReviewTracking(env, "owner/repo", 1);
    expect(await hasReviewedForHeadSha(env, "owner/repo", 1, "sha1")).toBe(true); // STILL true -- the key difference.
    expect(await hasActiveReviewForHeadSha(env, "owner/repo", 1, "sha1")).toBe(false); // narrower sibling flips to false.
  });

  it("hasReviewedForHeadSha is false for a different head or PR, even when the tracked row is active", async () => {
    const env = createTestEnv();
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", deliveryId: "delivery-1" });
    expect(await hasReviewedForHeadSha(env, "owner/repo", 1, "sha-different")).toBe(false);
    expect(await hasReviewedForHeadSha(env, "owner/repo", 2, "sha1")).toBe(false);
  });

  it("hasReviewedForHeadSha returns to false once a NEW head restarts tracking -- a fresh push earns a fresh shot", async () => {
    const env = createTestEnv();
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", deliveryId: "delivery-1" });
    await terminalizeActiveReviewTracking(env, "owner/repo", 1);
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha2", deliveryId: "delivery-2" });
    expect(await hasReviewedForHeadSha(env, "owner/repo", 1, "sha1")).toBe(false);
    expect(await hasReviewedForHeadSha(env, "owner/repo", 1, "sha2")).toBe(true);
  });

  it("startActiveReviewTracking without an authorLogin persists a null author (defensive -- a deleted-account PR yields a null login)", async () => {
    const env = createTestEnv();
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", deliveryId: "delivery-1" });
    const row = await rawRow(env, "owner/repo", 1);
    expect(row?.author_login).toBeNull();
  });

  describe("getActiveReviewStartedAt (#4446)", () => {
    it("returns null when no row exists at all", async () => {
      const env = createTestEnv();
      expect(await getActiveReviewStartedAt(env, "owner/repo", 1, "sha1")).toBeNull();
    });

    it("returns the row's startedAt for the exact matching headSha", async () => {
      const env = createTestEnv();
      await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", deliveryId: "delivery-1" });
      const row = await rawRow(env, "owner/repo", 1);
      expect(await getActiveReviewStartedAt(env, "owner/repo", 1, "sha1")).toBe(row?.started_at);
    });

    it("REGRESSION: returns null for a DIFFERENT headSha than the tracked row -- never measures the wrong pass's window", async () => {
      const env = createTestEnv();
      await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", deliveryId: "delivery-1" });
      expect(await getActiveReviewStartedAt(env, "owner/repo", 1, "sha-different")).toBeNull();
    });

    it("returns null for a different PR number, even under the same repo", async () => {
      const env = createTestEnv();
      await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", deliveryId: "delivery-1" });
      expect(await getActiveReviewStartedAt(env, "owner/repo", 2, "sha1")).toBeNull();
    });

    it("still returns startedAt for a matching headSha AFTER the row has been terminalized -- not gated on status === 'active'", async () => {
      const env = createTestEnv();
      await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", deliveryId: "delivery-1" });
      const row = await rawRow(env, "owner/repo", 1);
      await terminalizeActiveReviewTracking(env, "owner/repo", 1);
      expect(await getActiveReviewStartedAt(env, "owner/repo", 1, "sha1")).toBe(row?.started_at);
    });
  });

  describe("listStaleActiveReviewTracking (#webhook-reorder-clobber)", () => {
    it("returns nothing when no row exists at all", async () => {
      const env = createTestEnv();
      expect(await listStaleActiveReviewTracking(env, "2026-07-21T13:00:00.000Z")).toEqual([]);
    });

    it("returns an active row older than the cutoff", async () => {
      const env = createTestEnv();
      await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", deliveryId: "delivery-1" });
      const row = await rawRow(env, "owner/repo", 1);

      const stale = await listStaleActiveReviewTracking(env, new Date(Date.parse(row!.started_at) + 1000).toISOString());

      expect(stale).toEqual([{ repoFullName: "owner/repo", pullNumber: 1, startedAt: row!.started_at }]);
    });

    it("excludes a row NEWER than the cutoff -- a genuinely fresh review is never a candidate", async () => {
      const env = createTestEnv();
      await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", deliveryId: "delivery-1" });
      const row = await rawRow(env, "owner/repo", 1);

      const stale = await listStaleActiveReviewTracking(env, new Date(Date.parse(row!.started_at) - 1000).toISOString());

      expect(stale).toEqual([]);
    });

    it("excludes a TERMINAL row even when it's old -- only status='active' is a candidate", async () => {
      const env = createTestEnv();
      await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", deliveryId: "delivery-1" });
      await terminalizeActiveReviewTracking(env, "owner/repo", 1);

      const stale = await listStaleActiveReviewTracking(env, "2099-01-01T00:00:00.000Z");

      expect(stale).toEqual([]);
    });
  });

  // signal_snapshots' "latest" tiebreak (investigated per an out-of-scope-flagged follow-up): generatedAt is
  // millisecond-precision, so two writes for the same (signalType, targetKey) within one millisecond tie: SQLite
  // itself makes no guarantee about tie order ("the order ... is undefined" -- sqlite.org/lang_select.html), so
  // an id-string-based tiebreak (the desc(id) convention used elsewhere in this file, e.g. audit_events,
  // review_suppression) can't substitute for real insertion order -- id here is a random crypto.randomUUID(),
  // not a sortable sequence. rowid (SQLite's own monotonic per-insert counter) is the only value that actually
  // reflects insertion order, matching this table's own documented invariant in retention.ts's
  // dedupeSignalSnapshots ("'Latest' is the highest rowid per key ... rowid, unlike generated_at, can never
  // tie") and the same tiebreak orb/relay.ts already uses for its own "most recently inserted" read.
  describe("signal_snapshots: rowid tiebreak on a generatedAt tie", () => {
    async function seedTiedPair(env: Env, targetKey: string, firstId: string, secondId: string, generatedAt: string) {
      // Deliberately adversarial ids: `firstId` (inserted FIRST) sorts ALPHABETICALLY AFTER `secondId` (inserted
      // SECOND). A tiebreak that (wrongly) compared `id` strings instead of `rowid` would pick the WRONG row --
      // this is what actually discriminates "genuine insertion order" from "an id string happens to sort right".
      await persistSignalSnapshot(env, { id: firstId, signalType: "debug-signal", targetKey, repoFullName: null, payload: { marker: "first" }, generatedAt });
      await persistSignalSnapshot(env, { id: secondId, signalType: "debug-signal", targetKey, repoFullName: null, payload: { marker: "second" }, generatedAt });
    }

    it("listSignalSnapshots: the row inserted SECOND sorts first on a tie, even when its id sorts alphabetically BEFORE the first row's id", async () => {
      const env = createTestEnv();
      await seedTiedPair(env, "repo-a", "zzz-inserted-first", "aaa-inserted-second", "2026-01-01T00:00:00.000Z");

      const rows = await listSignalSnapshots(env, "debug-signal", "repo-a");
      expect(rows).toHaveLength(2);
      expect(rows[0]?.id).toBe("aaa-inserted-second");
      expect(rows[0]?.payload).toMatchObject({ marker: "second" });
      expect(rows[1]?.id).toBe("zzz-inserted-first");
    });

    it("REGRESSION: a THIRD write with an id that sorts alphabetically in the MIDDLE still slots by insertion order, not id order", async () => {
      const env = createTestEnv();
      await seedTiedPair(env, "repo-b", "zzz-first", "aaa-second", "2026-01-01T00:00:00.000Z");
      await persistSignalSnapshot(env, { id: "mmm-third", signalType: "debug-signal", targetKey: "repo-b", repoFullName: null, payload: { marker: "third" }, generatedAt: "2026-01-01T00:00:00.000Z" });

      const rows = await listSignalSnapshots(env, "debug-signal", "repo-b");
      expect(rows.map((r) => r.payload.marker)).toEqual(["third", "second", "first"]); // reverse insertion order
    });

    it("listLatestSignalSnapshotsForTargets: the row inserted SECOND wins the per-target 'latest' rank, even when its id sorts alphabetically BEFORE the first row's id", async () => {
      const env = createTestEnv();
      await seedTiedPair(env, "repo-c", "zzz-inserted-first", "aaa-inserted-second", "2026-01-01T00:00:00.000Z");

      const latest = await listLatestSignalSnapshotsForTargets(env, "debug-signal", ["repo-c"]);
      expect(latest.get("repo-c")?.id).toBe("aaa-inserted-second");
    });

    it("a genuinely later generatedAt still wins outright, tiebreak or not", async () => {
      const env = createTestEnv();
      await persistSignalSnapshot(env, { id: "old-row", signalType: "debug-signal", targetKey: "repo-d", repoFullName: null, payload: { marker: "old" }, generatedAt: "2026-01-01T00:00:00.000Z" });
      await persistSignalSnapshot(env, { id: "new-row", signalType: "debug-signal", targetKey: "repo-d", repoFullName: null, payload: { marker: "new" }, generatedAt: "2026-01-02T00:00:00.000Z" });

      const rows = await listSignalSnapshots(env, "debug-signal", "repo-d");
      expect(rows[0]?.id).toBe("new-row");
    });
  });
});

describe("manual-review label provenance (#9939)", () => {
  const seed = async (env: ReturnType<typeof createTestEnv>) => {
    await upsertRepositoryFromGitHub(env, { full_name: "owner/repo", name: "repo", id: 1, private: false } as never, 4242);
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 11, title: "t", state: "open", user: { login: "c" }, head: { sha: "head1" }, labels: [], created_at: "2026-07-05T10:00:00.000Z",
    } as never);
  };

  it("records the head and reason the PLANNER applied the label at", async () => {
    const env = createTestEnv();
    await seed(env);
    await markPullRequestManualReviewLabelApplied(env, "owner/repo", 11, "head1", "verdict=success; guarded path");
    const stored = await getPullRequest(env, "owner/repo", 11);
    expect(stored?.manualReviewLabelAppliedSha).toBe("head1");
    expect(stored?.manualReviewLabelAppliedReason).toBe("verdict=success; guarded path");
  });

  it("INVARIANT: the write is head-scoped -- a stale head does not stamp provenance", async () => {
    // A hold recorded against an older head must not license removing a label on a head nobody re-evaluated.
    const env = createTestEnv();
    await seed(env);
    await markPullRequestManualReviewLabelApplied(env, "owner/repo", 11, "some-other-head", "stale");
    expect((await getPullRequest(env, "owner/repo", 11))?.manualReviewLabelAppliedSha).toBeNull();
  });

  it("REGRESSION: clearing removes BOTH fields, so a later human-applied label cannot inherit the bot's provenance", async () => {
    // The subtle failure this prevents: leftover provenance would make a maintainer's own freeze look
    // bot-applied on the next pass, and therefore auto-removable -- the exact override it exists to prevent.
    const env = createTestEnv();
    await seed(env);
    await markPullRequestManualReviewLabelApplied(env, "owner/repo", 11, "head1", "why");
    await clearPullRequestManualReviewLabelProvenance(env, "owner/repo", 11);
    const stored = await getPullRequest(env, "owner/repo", 11);
    expect(stored?.manualReviewLabelAppliedSha).toBeNull();
    expect(stored?.manualReviewLabelAppliedReason).toBeNull();
  });

  it("INVARIANT: a PR with no provenance reads as null -- absent means \"not ours to lift\"", async () => {
    const env = createTestEnv();
    await seed(env);
    expect((await getPullRequest(env, "owner/repo", 11))?.manualReviewLabelAppliedSha).toBeNull();
  });
});

describe("loadOrphanRequeueContext (#9870)", () => {
  it("returns the installation id AND the PR's real creation time", async () => {
    // The boot sweep heals the tracking row, but re-queueing the pass needs both — and the tracking row
    // carries neither. Without this the placeholder comment stays published forever.
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { full_name: "owner/repo", name: "repo", id: 1, private: false } as never, 4242);
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 7, title: "t", state: "open", user: { login: "c" }, head: { sha: "s7" }, labels: [], created_at: "2026-07-05T10:00:00.000Z",
    } as never);
    expect(await loadOrphanRequeueContext(env, "owner/repo", 7)).toEqual({ installationId: 4242, prCreatedAt: "2026-07-05T10:00:00.000Z" });
  });

  it("INVARIANT (#9499): prCreatedAt is carried so the re-queue does NOT jump the backlog", async () => {
    // Omitting it inverts the order: jobClaimSortKey falls back to a ~9.5e11 base that sorts ahead of every
    // real 2026 PR (~1.78e12). A restart-orphaned review should be re-driven, not prioritised over work
    // that has waited longer. The repo-wide regate-sort-key check enforces the same rule at the call site.
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { full_name: "owner/repo", name: "repo", id: 1, private: false } as never, 4242);
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 8, title: "t", state: "open", user: { login: "c" }, head: { sha: "s8" }, labels: [], created_at: "2026-07-06T09:00:00.000Z",
    } as never);
    const context = await loadOrphanRequeueContext(env, "owner/repo", 8);
    expect(context?.prCreatedAt).toBe("2026-07-06T09:00:00.000Z");
  });

  it("INVARIANT: an unregistered repo yields null rather than a bogus id", async () => {
    // A wrong id would enqueue a job that cannot act; null lets the caller log a skip an operator can see.
    const env = createTestEnv();
    expect(await loadOrphanRequeueContext(env, "owner/never-registered", 1)).toBeNull();
  });

  it("a registered repo with no stored PR row still resolves, with a null creation time", async () => {
    // Better to re-drive with an unknown position than not at all; the sort key falls back and the pass runs.
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { full_name: "owner/repo", name: "repo", id: 1, private: false } as never, 4242);
    expect(await loadOrphanRequeueContext(env, "owner/repo", 999)).toEqual({ installationId: 4242, prCreatedAt: null });
  });
});

describe("terminalizeActiveReviewsFromBeforeBoot (#deploy-orphaned-reviews)", () => {
  it("REGRESSION: terminalizes a row orphaned by a restart, so the head is not wedged for 15-25 minutes", async () => {
    // Observed live on the ORB (2026-07-29): a container recreation 3 seconds after a review pass started
    // left its tracking row 'active'; every later pass for that head -- including the maintainer's forced
    // re-runs -- skipped with "AI review already in progress" until the 10-minute sweep's 15-minute age
    // floor finally cleared it. At boot, started_at < boot time is exact: no review survives a restart.
    const env = createTestEnv();
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 7, headSha: "sha7", authorLogin: "alice", deliveryId: "d-7" });
    // The process "boots" strictly after the row was written.
    const bootIso = new Date(Date.now() + 1000).toISOString();
    const healed = await terminalizeActiveReviewsFromBeforeBoot(env, bootIso);
    expect(healed).toEqual([{ repoFullName: "owner/repo", pullNumber: 7 }]);
    const row = await env.DB.prepare("select status from active_review_tracking where repo_full_name = ? and pull_number = ?").bind("owner/repo", 7).first<{ status: string }>();
    expect(row?.status).toBe("terminal");
  });

  it("INVARIANT: never touches a review that started AFTER boot — a live pass is not an orphan", async () => {
    const env = createTestEnv();
    const bootIso = new Date(Date.now() - 60_000).toISOString();
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 8, headSha: "sha8", authorLogin: "bob", deliveryId: "d-8" });
    expect(await terminalizeActiveReviewsFromBeforeBoot(env, bootIso)).toEqual([]);
    const row = await env.DB.prepare("select status from active_review_tracking where repo_full_name = ? and pull_number = ?").bind("owner/repo", 8).first<{ status: string }>();
    expect(row?.status).toBe("active");
  });

  it("INVARIANT: already-terminal rows are untouched (no resurrect, no double-report)", async () => {
    const env = createTestEnv();
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 9, headSha: "sha9", authorLogin: "carol", deliveryId: "d-9" });
    const boot = new Date(Date.now() + 1000).toISOString();
    expect(await terminalizeActiveReviewsFromBeforeBoot(env, boot)).toHaveLength(1);
    // Second boot sweep: nothing left to heal, and nothing re-reported.
    expect(await terminalizeActiveReviewsFromBeforeBoot(env, boot)).toEqual([]);
  });
});

// #10168: the candidate-rival read behind the supersession check. Deliberately reads `pull_requests` and not
// `recent_merged_pull_requests` -- that table stopped being written, so a rival that merged minutes ago is
// absent from it entirely and the check would silently never fire.
describe("listMergedPullRequestsInWindow (#10168)", () => {
  const seedPr = async (
    env: ReturnType<typeof createTestEnv>,
    pr: { number: number; mergedAt?: string | null; linkedIssues: number[]; state?: string },
  ) => {
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: pr.number,
      title: `#${pr.number}`,
      state: pr.state ?? "closed",
      user: { login: "c" },
      head: { sha: `h${pr.number}` },
      labels: [],
      created_at: "2026-07-31T09:00:00Z",
      merged_at: pr.mergedAt ?? null,
      body: pr.linkedIssues.map((n) => `Closes #${n}`).join(" "),
    } as never);
  };

  const seedAll = async (env: ReturnType<typeof createTestEnv>) => {
    await upsertRepositoryFromGitHub(env, { full_name: "owner/repo", name: "repo", id: 1, private: false } as never, 4242);
    await seedPr(env, { number: 8881, mergedAt: "2026-07-31T09:30:24Z", linkedIssues: [8829] });
    await seedPr(env, { number: 8870, mergedAt: "2026-07-31T08:00:00Z", linkedIssues: [8829] }); // before the window
    await seedPr(env, { number: 8899, mergedAt: "2026-07-31T11:00:00Z", linkedIssues: [8829] }); // after the window
    await seedPr(env, { number: 8886, mergedAt: null, linkedIssues: [8829], state: "open" }); // never merged
  };

  it("returns only the merges inside the window, with their linked issues", async () => {
    const env = createTestEnv();
    await seedAll(env);
    const rows = await listMergedPullRequestsInWindow(env, "owner/repo", "2026-07-31T09:22:36Z", "2026-07-31T09:35:25Z");
    expect(rows).toEqual([{ number: 8881, mergedAt: "2026-07-31T09:30:24Z", linkedIssues: [8829] }]);
  });

  it("excludes an unmerged PR even when it cites the same issue", async () => {
    const env = createTestEnv();
    await seedAll(env);
    const rows = await listMergedPullRequestsInWindow(env, "owner/repo", "2026-07-31T00:00:00Z", "2026-07-31T23:59:59Z");
    expect(rows.map((row) => row.number)).not.toContain(8886);
  });

  it("orders by ascending merge time, so a capped result keeps the EARLIEST rivals", async () => {
    const env = createTestEnv();
    await seedAll(env);
    const rows = await listMergedPullRequestsInWindow(env, "owner/repo", "2026-07-31T00:00:00Z", "2026-07-31T23:59:59Z");
    expect(rows.map((row) => row.mergedAt)).toEqual([...rows.map((row) => row.mergedAt)].sort());
    expect(rows.map((row) => row.number)).toEqual([8870, 8881, 8899]);
  });

  it("is scoped to the repo and yields nothing when no merge lands in the window", async () => {
    const env = createTestEnv();
    await seedAll(env);
    expect(await listMergedPullRequestsInWindow(env, "other/repo", "2026-07-31T00:00:00Z", "2026-07-31T23:59:59Z")).toEqual([]);
    expect(await listMergedPullRequestsInWindow(env, "owner/repo", "2026-07-30T00:00:00Z", "2026-07-30T23:59:59Z")).toEqual([]);
  });
});
