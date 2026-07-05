import { describe, expect, it } from "vitest";
import {
  getContributorScoringProfile,
  getOpenUpstreamDriftReportByFingerprint,
  hasActiveReviewForHeadSha,
  listContributorRepoStats,
  listLatestRepoGithubTotalsSnapshots,
  listRepoPullRequestFilePaths,
  persistBountyLifecycleEvent,
  persistRegistryDriftEvents,
  persistRepoGithubTotalsSnapshot,
  startActiveReviewTracking,
  terminalizeActiveReviewTracking,
  updateUpstreamDriftReportIssue,
  upsertContributorRepoStat,
  upsertContributorScoringProfile,
  upsertIssueQualityReport,
  upsertPullRequestFile,
  upsertUpstreamDriftReport,
} from "../../src/db/repositories";
import { buildContributorEvidenceGraph } from "../../src/services/contributor-evidence-graph";
import type { PullRequestFileRecord, PullRequestRecord, RepositoryRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

describe("database persistence helpers", () => {
  it("round-trips drift, quality, lifecycle, and scoring persistence helpers", async () => {
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

    await updateUpstreamDriftReportIssue(env, "registry:abc", { number: 42, url: "https://github.com/JSONbored/gittensory/issues/42" });
    expect(await getOpenUpstreamDriftReportByFingerprint(env, "registry:abc")).toMatchObject({
      issueNumber: 42,
      issueUrl: "https://github.com/JSONbored/gittensory/issues/42",
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

    await upsertIssueQualityReport(env, {
      id: "quality-1",
      repoFullName: "JSONbored/gittensory",
      issueNumber: 7,
      payload: { score: 92 },
      generatedAt: "2026-05-30T00:03:00.000Z",
    });
    await persistRegistryDriftEvents(env, [
      {
        id: "registry-event-1",
        repoFullName: "JSONbored/gittensory",
        driftType: "changed",
        detail: "Emission changed",
        previousSnapshotId: "old",
        currentSnapshotId: "new",
        payload: { emissionShare: 0.01 },
        generatedAt: "2026-05-30T00:04:00.000Z",
      },
    ]);
    await persistBountyLifecycleEvent(env, {
      id: "bounty-event-1",
      bountyId: "bounty-1",
      repoFullName: "JSONbored/gittensory",
      issueNumber: 7,
      status: "Completed",
      payload: { target_alpha: "74.0000" },
      generatedAt: "2026-05-30T00:05:00.000Z",
    });

    await expect(
      env.DB.prepare("select payload_json from issue_quality_reports where repo_full_name = ? and issue_number = ?")
        .bind("JSONbored/gittensory", 7)
        .first<{ payload_json: string }>(),
    ).resolves.toMatchObject({ payload_json: JSON.stringify({ score: 92 }) });
    await expect(env.DB.prepare("select count(*) as count from registry_drift_events").first<{ count: number }>()).resolves.toMatchObject({ count: 1 });
    await expect(env.DB.prepare("select count(*) as count from bounty_lifecycle_events").first<{ count: number }>()).resolves.toMatchObject({ count: 1 });
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

  it("startActiveReviewTracking without an authorLogin persists a null author (defensive -- a deleted-account PR yields a null login)", async () => {
    const env = createTestEnv();
    await startActiveReviewTracking(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", deliveryId: "delivery-1" });
    const row = await rawRow(env, "owner/repo", 1);
    expect(row?.author_login).toBeNull();
  });
});
