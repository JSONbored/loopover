import { describe, expect, it } from "vitest";
import { renameRepositoryIdentity } from "../../src/db/repo-identity-rename";
import {
  getAgentCommandAnswer,
  getBurdenForecast,
  getIssue,
  getLatestRepoGithubTotalsSnapshot,
  getNotificationDeliveryById,
  getPullRequest,
  getPullRequestDetailSyncState,
  getRepository,
  getRepositorySettings,
  getRepoQueueTrendSnapshot,
  getRepoSyncSegment,
  getRepoSyncState,
  insertNotificationDeliveryIfAbsent,
  listCollisionEdges,
  listContributorRepoStats,
  listProductUsageEvents,
  listPullRequests,
  listRecentMergedPullRequests,
  listRepoLabels,
  listSignalSnapshots,
  persistAdvisory,
  persistRepoGithubTotalsSnapshot,
  persistRepoSnapshot,
  persistSignalSnapshot,
  recordAuditEvent,
  recordGateBlockOutcome,
  recordGitHubRateLimitObservation,
  recordProductUsageEvent,
  replaceCollisionEdges,
  startActiveReviewTracking,
  upsertAgentCommandAnswer,
  upsertBurdenForecast,
  upsertCheckSummary,
  upsertContributorRepoStat,
  upsertIssueFromGitHub,
  upsertPullRequestDetailSyncState,
  upsertPullRequestFile,
  upsertPullRequestFromGitHub,
  upsertPullRequestReview,
  upsertRecentMergedPullRequest,
  upsertRepoLabel,
  upsertRepositoryFromGitHub,
  upsertRepositorySettings,
  upsertRepoQueueTrendSnapshot,
  upsertRepoSyncSegment,
  upsertRepoSyncState,
} from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const OLD = "owner/gittensory";
const NEW = "owner/loopover";

describe("renameRepositoryIdentity", () => {
  it("is a no-op when oldFullName and newFullName are identical", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: OLD, private: false, owner: { login: "owner" } }, 1);
    await renameRepositoryIdentity(env, OLD, OLD);
    const repo = await getRepository(env, OLD);
    expect(repo?.fullName).toBe(OLD);
  });

  it("is a safe no-op when nothing exists yet under the old name", async () => {
    const env = createTestEnv();
    await expect(renameRepositoryIdentity(env, OLD, NEW)).resolves.toBeUndefined();
    expect(await getRepository(env, NEW)).toBeNull();
  });

  describe("repositories", () => {
    it("renames the anchor row's full_name, owner, name, and html_url", async () => {
      const env = createTestEnv();
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: OLD, private: false, html_url: `https://github.com/${OLD}`, owner: { login: "owner" } }, 42);
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getRepository(env, OLD)).toBeNull();
      const renamed = await getRepository(env, NEW);
      expect(renamed).toMatchObject({ fullName: NEW, owner: "owner", name: "loopover", installationId: 42, htmlUrl: `https://github.com/${NEW}` });
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name row (already created by a webhook that slipped in under the new name) rather than colliding, keeping the old row's richer state", async () => {
      const env = createTestEnv();
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: OLD, private: false, owner: { login: "owner" } }, 42);
      // Simulate the exact drift this module exists to fix: a webhook already created a fresh row under the
      // new name (installationId set, but none of the old row's accumulated state).
      await upsertRepositoryFromGitHub(env, { name: "loopover", full_name: NEW, private: false, owner: { login: "owner" } }, 42);
      await renameRepositoryIdentity(env, OLD, NEW);
      const renamed = await getRepository(env, NEW);
      expect(renamed?.installationId).toBe(42);
      // Exactly one row survives -- the fold, not a second insert.
      expect(await getRepository(env, OLD)).toBeNull();
    });
  });

  describe("repository_settings", () => {
    // getRepositorySettings always returns a (possibly all-default) RepositorySettings, never null, so
    // these assert on the raw row directly to distinguish "no row" / "renamed row" / "folded row".
    it("renames the settings row's repo_full_name", async () => {
      const env = createTestEnv();
      await upsertRepositorySettings(env, { repoFullName: OLD, commentMode: "off" });
      await renameRepositoryIdentity(env, OLD, NEW);
      const oldRow = await env.DB.prepare("select count(*) as n from repository_settings where repo_full_name = ?").bind(OLD).first<{ n: number }>();
      expect(oldRow?.n).toBe(0);
      const settings = await getRepositorySettings(env, NEW);
      expect(settings.commentMode).toBe("off");
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name settings row, keeping the pre-existing configured settings", async () => {
      const env = createTestEnv();
      await upsertRepositorySettings(env, { repoFullName: OLD, commentMode: "detected_contributors_only" });
      await upsertRepositorySettings(env, { repoFullName: NEW, commentMode: "off" }); // stray, should be discarded
      await renameRepositoryIdentity(env, OLD, NEW);
      const settings = await getRepositorySettings(env, NEW);
      expect(settings.commentMode).toBe("detected_contributors_only");
      const newRowCount = await env.DB.prepare("select count(*) as n from repository_settings where repo_full_name = ?").bind(NEW).first<{ n: number }>();
      expect(newRowCount?.n).toBe(1); // exactly one surviving row, not two
    });
  });

  describe("pull_requests", () => {
    it("renames repo_full_name, id, and html_url for every PR under the old name", async () => {
      const env = createTestEnv();
      await upsertPullRequestFromGitHub(env, OLD, { number: 1, title: "PR one", state: "open", html_url: `https://github.com/${OLD}/pull/1`, labels: [] });
      await upsertPullRequestFromGitHub(env, OLD, { number: 2, title: "PR two", state: "closed", labels: [] });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getPullRequest(env, OLD, 1)).toBeNull();
      const pr1 = await getPullRequest(env, NEW, 1);
      expect(pr1).toMatchObject({ repoFullName: NEW, title: "PR one", htmlUrl: `https://github.com/${NEW}/pull/1` });
      const pr2 = await getPullRequest(env, NEW, 2);
      expect(pr2?.title).toBe("PR two");
    });

    it("REGRESSION (#repo-rename-migration): a colliding PR number under the new name is folded away, preserving the pre-existing PR's history instead of the sparse post-rename duplicate", async () => {
      const env = createTestEnv();
      await upsertPullRequestFromGitHub(env, OLD, { number: 5, title: "Original, full history", state: "open", labels: [], body: "the real one" });
      // The sparse duplicate a webhook could have created under the new name before this migration ran.
      await upsertPullRequestFromGitHub(env, NEW, { number: 5, title: "Fragment", state: "open", labels: [] });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await listPullRequests(env, NEW);
      expect(rows.filter((pr) => pr.number === 5)).toHaveLength(1);
      expect(rows.find((pr) => pr.number === 5)?.title).toBe("Original, full history");
    });

    it("does not disturb a PR that only ever existed under the new name (no matching number under the old name)", async () => {
      const env = createTestEnv();
      await upsertPullRequestFromGitHub(env, OLD, { number: 1, title: "old-name PR", state: "open", labels: [] });
      await upsertPullRequestFromGitHub(env, NEW, { number: 99, title: "genuinely new PR", state: "open", labels: [] });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getPullRequest(env, NEW, 99)).toMatchObject({ title: "genuinely new PR" });
      expect(await getPullRequest(env, NEW, 1)).toMatchObject({ title: "old-name PR" });
    });
  });

  describe("issues", () => {
    it("renames repo_full_name, id, and html_url for every issue under the old name", async () => {
      const env = createTestEnv();
      await upsertIssueFromGitHub(env, OLD, { number: 7, title: "Issue seven", state: "open", html_url: `https://github.com/${OLD}/issues/7`, labels: [] });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getIssue(env, OLD, 7)).toBeNull();
      expect(await getIssue(env, NEW, 7)).toMatchObject({ repoFullName: NEW, title: "Issue seven", htmlUrl: `https://github.com/${NEW}/issues/7` });
    });

    it("REGRESSION (#repo-rename-migration): a colliding issue number under the new name is folded away, keeping the pre-existing issue", async () => {
      const env = createTestEnv();
      await upsertIssueFromGitHub(env, OLD, { number: 3, title: "Original issue", state: "open", labels: [] });
      await upsertIssueFromGitHub(env, NEW, { number: 3, title: "Fragment issue", state: "open", labels: [] });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getIssue(env, NEW, 3)).toMatchObject({ title: "Original issue" });
    });
  });

  describe("gate_outcomes", () => {
    it("renames repo_full_name and id for the PR's gate-block row", async () => {
      const env = createTestEnv();
      await recordGateBlockOutcome(env, { repoFullName: OLD, pullNumber: 5, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });
      await renameRepositoryIdentity(env, OLD, NEW);
      const oldRow = await env.DB.prepare("select count(*) as n from gate_outcomes where repo_full_name = ?").bind(OLD).first<{ n: number }>();
      expect(oldRow?.n).toBe(0);
      const renamed = await env.DB.prepare("select id, blocker_codes_json as blockerCodesJson from gate_outcomes where repo_full_name = ? and pull_number = ?").bind(NEW, 5).first<{ id: string; blockerCodesJson: string }>();
      expect(renamed?.id).toBe(`gate:${NEW}#5`);
      expect(renamed?.blockerCodesJson).toContain("missing_linked_issue");
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name gate-block row on the same PR number", async () => {
      const env = createTestEnv();
      await recordGateBlockOutcome(env, { repoFullName: OLD, pullNumber: 5, blockerCodes: ["slop_risk"] });
      await recordGateBlockOutcome(env, { repoFullName: NEW, pullNumber: 5, blockerCodes: ["duplicate_pr_risk"] });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await env.DB.prepare("select blocker_codes_json as blockerCodesJson from gate_outcomes where repo_full_name = ? and pull_number = ?").bind(NEW, 5).all<{ blockerCodesJson: string }>();
      expect(rows.results).toHaveLength(1);
      expect(rows.results[0]?.blockerCodesJson).toContain("slop_risk");
    });
  });

  describe("active_review_tracking", () => {
    it("renames repo_full_name and id for the PR's active-review row", async () => {
      const env = createTestEnv();
      await startActiveReviewTracking(env, { repoFullName: OLD, pullNumber: 9, headSha: "def456", deliveryId: "delivery-1" });
      await renameRepositoryIdentity(env, OLD, NEW);
      const oldRow = await env.DB.prepare("select count(*) as n from active_review_tracking where repo_full_name = ?").bind(OLD).first<{ n: number }>();
      expect(oldRow?.n).toBe(0);
      const renamed = await env.DB.prepare("select id, head_sha as headSha from active_review_tracking where repo_full_name = ? and pull_number = ?").bind(NEW, 9).first<{ id: string; headSha: string }>();
      expect(renamed?.id).toBe(`active-review:${NEW}#9`);
      expect(renamed?.headSha).toBe("def456");
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name active-review row on the same PR number", async () => {
      const env = createTestEnv();
      await startActiveReviewTracking(env, { repoFullName: OLD, pullNumber: 9, headSha: "old-head", deliveryId: "delivery-old" });
      await startActiveReviewTracking(env, { repoFullName: NEW, pullNumber: 9, headSha: "stray-head", deliveryId: "delivery-stray" });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await env.DB.prepare("select head_sha as headSha from active_review_tracking where repo_full_name = ? and pull_number = ?").bind(NEW, 9).all<{ headSha: string }>();
      expect(rows.results).toHaveLength(1);
      expect(rows.results[0]?.headSha).toBe("old-head");
    });
  });

  describe("pull_request_detail_sync_state", () => {
    it("renames repo_full_name and id for the PR's sync-state row", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, { repoFullName: OLD, pullNumber: 3, status: "complete", headSha: "sha-old" });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getPullRequestDetailSyncState(env, OLD, 3)).toBeNull();
      const renamed = await getPullRequestDetailSyncState(env, NEW, 3);
      expect(renamed).toMatchObject({ repoFullName: NEW, status: "complete", headSha: "sha-old" });
      const idRow = await env.DB.prepare("select id from pull_request_detail_sync_state where repo_full_name = ? and pull_number = ?").bind(NEW, 3).first<{ id: string }>();
      expect(idRow?.id).toBe(`${NEW}#3`);
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name sync-state row on the same PR number", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, { repoFullName: OLD, pullNumber: 3, status: "complete" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: NEW, pullNumber: 3, status: "never_synced" });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await env.DB.prepare("select status from pull_request_detail_sync_state where repo_full_name = ? and pull_number = ?").bind(NEW, 3).all<{ status: string }>();
      expect(rows.results).toHaveLength(1);
      expect(rows.results[0]?.status).toBe("complete");
    });
  });

  describe("recent_merged_pull_requests", () => {
    it("renames repo_full_name, id, and html_url for a merged-PR row", async () => {
      const env = createTestEnv();
      await upsertRecentMergedPullRequest(env, { repoFullName: OLD, number: 11, title: "Merged PR", htmlUrl: `https://github.com/${OLD}/pull/11`, labels: [], linkedIssues: [], changedFiles: [], payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await listRecentMergedPullRequests(env, NEW);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ title: "Merged PR", htmlUrl: `https://github.com/${NEW}/pull/11` });
      expect(await listRecentMergedPullRequests(env, OLD)).toHaveLength(0);
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name row on the same PR number", async () => {
      const env = createTestEnv();
      await upsertRecentMergedPullRequest(env, { repoFullName: OLD, number: 11, title: "Original", labels: [], linkedIssues: [], changedFiles: [], payload: {} });
      await upsertRecentMergedPullRequest(env, { repoFullName: NEW, number: 11, title: "Fragment", labels: [], linkedIssues: [], changedFiles: [], payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await listRecentMergedPullRequests(env, NEW);
      expect(rows.filter((pr) => pr.number === 11)).toHaveLength(1);
      expect(rows.find((pr) => pr.number === 11)?.title).toBe("Original");
    });
  });

  describe("pull_request_files", () => {
    it("renames repo_full_name and id for every file row under the old name", async () => {
      const env = createTestEnv();
      await upsertPullRequestFile(env, { repoFullName: OLD, pullNumber: 4, path: "src/a.ts", additions: 1, deletions: 0, changes: 1, payload: {} });
      await upsertPullRequestFile(env, { repoFullName: OLD, pullNumber: 4, path: "src/b.ts", additions: 2, deletions: 1, changes: 3, payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const oldRows = await env.DB.prepare("select count(*) as n from pull_request_files where repo_full_name = ?").bind(OLD).first<{ n: number }>();
      expect(oldRows?.n).toBe(0);
      const renamed = await env.DB.prepare("select id, path from pull_request_files where repo_full_name = ? order by path").bind(NEW).all<{ id: string; path: string }>();
      expect(renamed.results).toEqual([
        { id: `${NEW}#4#src/a.ts`, path: "src/a.ts" },
        { id: `${NEW}#4#src/b.ts`, path: "src/b.ts" },
      ]);
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name row that collides on the same (pull_number, path) pair", async () => {
      const env = createTestEnv();
      await upsertPullRequestFile(env, { repoFullName: OLD, pullNumber: 4, path: "src/a.ts", additions: 10, deletions: 0, changes: 10, payload: {} });
      await upsertPullRequestFile(env, { repoFullName: NEW, pullNumber: 4, path: "src/a.ts", additions: 1, deletions: 1, changes: 2, payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await env.DB.prepare("select additions from pull_request_files where repo_full_name = ? and pull_number = ? and path = ?").bind(NEW, 4, "src/a.ts").all<{ additions: number }>();
      expect(rows.results).toHaveLength(1);
      expect(rows.results[0]?.additions).toBe(10);
    });

    it("does not disturb a same-numbered PR's file at a DIFFERENT path (pair, not just pull_number, must match to fold)", async () => {
      const env = createTestEnv();
      await upsertPullRequestFile(env, { repoFullName: OLD, pullNumber: 4, path: "src/a.ts", additions: 1, deletions: 0, changes: 1, payload: {} });
      await upsertPullRequestFile(env, { repoFullName: NEW, pullNumber: 4, path: "src/other.ts", additions: 5, deletions: 0, changes: 5, payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await env.DB.prepare("select path from pull_request_files where repo_full_name = ? and pull_number = ? order by path").bind(NEW, 4).all<{ path: string }>();
      expect(rows.results.map((r) => r.path)).toEqual(["src/a.ts", "src/other.ts"]);
    });
  });

  describe("check_summaries", () => {
    it("renames repo_full_name and a repo-embedded id", async () => {
      const env = createTestEnv();
      await upsertCheckSummary(env, { id: `${OLD}#sha1#build`, repoFullName: OLD, pullNumber: 6, headSha: "sha1", name: "build", status: "completed", conclusion: "success", payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const renamed = await env.DB.prepare("select id from check_summaries where repo_full_name = ? and head_sha = ? and name = ?").bind(NEW, "sha1", "build").first<{ id: string }>();
      expect(renamed?.id).toBe(`${NEW}#sha1#build`);
    });

    it("leaves a non-repo-embedded id (e.g. a raw check-run id) untouched aside from repo_full_name", async () => {
      const env = createTestEnv();
      await upsertCheckSummary(env, { id: "998877", repoFullName: OLD, pullNumber: 6, headSha: "sha2", name: "LoopOver Orb Review Agent", status: "completed", payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const renamed = await env.DB.prepare("select id from check_summaries where repo_full_name = ? and head_sha = ? and name = ?").bind(NEW, "sha2", "LoopOver Orb Review Agent").first<{ id: string }>();
      expect(renamed?.id).toBe("998877"); // replace() on a non-matching id is a no-op -- id stable, repo_full_name still renamed
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name row colliding on (head_sha, name)", async () => {
      const env = createTestEnv();
      await upsertCheckSummary(env, { id: "1", repoFullName: OLD, pullNumber: 6, headSha: "sha1", name: "build", status: "completed", conclusion: "success", payload: {} });
      await upsertCheckSummary(env, { id: "2", repoFullName: NEW, pullNumber: 6, headSha: "sha1", name: "build", status: "in_progress", payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await env.DB.prepare("select conclusion from check_summaries where repo_full_name = ? and head_sha = ? and name = ?").bind(NEW, "sha1", "build").all<{ conclusion: string | null }>();
      expect(rows.results).toHaveLength(1);
      expect(rows.results[0]?.conclusion).toBe("success");
    });

    it("REGRESSION (#repo-rename-migration): a NULL head_sha row folds correctly (SQL NULL never equals NULL via '=')", async () => {
      const env = createTestEnv();
      await upsertCheckSummary(env, { id: "3", repoFullName: OLD, pullNumber: null, headSha: null, name: "queued-check", status: "queued", payload: {} });
      await upsertCheckSummary(env, { id: "4", repoFullName: NEW, pullNumber: null, headSha: null, name: "queued-check", status: "stale-stray", payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await env.DB.prepare("select status from check_summaries where repo_full_name = ? and head_sha is null and name = ?").bind(NEW, "queued-check").all<{ status: string }>();
      expect(rows.results).toHaveLength(1);
      expect(rows.results[0]?.status).toBe("queued");
    });
  });

  describe("pull_request_reviews", () => {
    it("renames repo_full_name and a repo-embedded id", async () => {
      const env = createTestEnv();
      await upsertPullRequestReview(env, { id: `${OLD}#8#555`, repoFullName: OLD, pullNumber: 8, state: "APPROVED", payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const oldRows = await env.DB.prepare("select count(*) as n from pull_request_reviews where repo_full_name = ?").bind(OLD).first<{ n: number }>();
      expect(oldRows?.n).toBe(0);
      const renamed = await env.DB.prepare("select id, state from pull_request_reviews where repo_full_name = ?").bind(NEW).first<{ id: string; state: string }>();
      expect(renamed).toMatchObject({ id: `${NEW}#8#555`, state: "APPROVED" });
    });

    it("does not disturb a review row that only ever existed under the new name", async () => {
      const env = createTestEnv();
      await upsertPullRequestReview(env, { id: `${OLD}#8#555`, repoFullName: OLD, pullNumber: 8, state: "APPROVED", payload: {} });
      await upsertPullRequestReview(env, { id: `${NEW}#8#556`, repoFullName: NEW, pullNumber: 8, state: "COMMENTED", payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await env.DB.prepare("select id from pull_request_reviews where repo_full_name = ? order by id").bind(NEW).all<{ id: string }>();
      expect(rows.results.map((r) => r.id)).toEqual([`${NEW}#8#555`, `${NEW}#8#556`]);
    });
  });

  describe("advisories", () => {
    it("renames repo_full_name and the repo-embedded target_key, leaving the random-UUID id untouched", async () => {
      const env = createTestEnv();
      const advisoryId = "11111111-1111-1111-1111-111111111111";
      await persistAdvisory(env, {
        id: advisoryId,
        targetType: "pull_request",
        targetKey: `${OLD}#12`,
        repoFullName: OLD,
        pullNumber: 12,
        conclusion: "neutral",
        severity: "info",
        title: "LoopOver advisory available",
        summary: "1 advisory finding generated.",
        findings: [],
        generatedAt: "2026-07-14T00:00:00.000Z",
      });
      await renameRepositoryIdentity(env, OLD, NEW);
      const renamed = await env.DB.prepare("select id, target_key as targetKey from advisories where repo_full_name = ?").bind(NEW).first<{ id: string; targetKey: string }>();
      expect(renamed).toEqual({ id: advisoryId, targetKey: `${NEW}#12` });
      const oldRows = await env.DB.prepare("select count(*) as n from advisories where repo_full_name = ?").bind(OLD).first<{ n: number }>();
      expect(oldRows?.n).toBe(0);
    });
  });

  describe("burden_forecasts", () => {
    it("renames the forecast row's repo_full_name", async () => {
      const env = createTestEnv();
      await upsertBurdenForecast(env, { repoFullName: OLD, payload: { level: "critical", summary: "original forecast" }, generatedAt: "2026-07-14T00:00:00.000Z" });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getBurdenForecast(env, OLD)).toBeNull();
      const renamed = await getBurdenForecast(env, NEW);
      expect(renamed).toMatchObject({ repoFullName: NEW, payload: { level: "critical", summary: "original forecast" } });
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name forecast row, keeping the pre-existing forecast", async () => {
      const env = createTestEnv();
      await upsertBurdenForecast(env, { repoFullName: OLD, payload: { level: "critical", summary: "original forecast" }, generatedAt: "2026-07-14T00:00:00.000Z" });
      await upsertBurdenForecast(env, { repoFullName: NEW, payload: { level: "low", summary: "stray fragment" }, generatedAt: "2026-07-14T00:00:00.000Z" }); // stray, should be discarded
      await renameRepositoryIdentity(env, OLD, NEW);
      const renamed = await getBurdenForecast(env, NEW);
      expect(renamed?.payload).toMatchObject({ level: "critical", summary: "original forecast" });
      const newRowCount = await env.DB.prepare("select count(*) as n from burden_forecasts where repo_full_name = ?").bind(NEW).first<{ n: number }>();
      expect(newRowCount?.n).toBe(1); // exactly one surviving row, not two
    });
  });

  describe("repo_queue_trend_snapshots", () => {
    it("renames the trend-snapshot row's repo_full_name", async () => {
      const env = createTestEnv();
      await upsertRepoQueueTrendSnapshot(env, { repoFullName: OLD, payload: { trend: "rising" }, generatedAt: "2026-07-14T00:00:00.000Z" });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getRepoQueueTrendSnapshot(env, OLD)).toBeNull();
      const renamed = await getRepoQueueTrendSnapshot(env, NEW);
      expect(renamed).toMatchObject({ repoFullName: NEW, payload: { trend: "rising" } });
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name trend-snapshot row, keeping the pre-existing snapshot", async () => {
      const env = createTestEnv();
      await upsertRepoQueueTrendSnapshot(env, { repoFullName: OLD, payload: { trend: "rising" }, generatedAt: "2026-07-14T00:00:00.000Z" });
      await upsertRepoQueueTrendSnapshot(env, { repoFullName: NEW, payload: { trend: "stray" }, generatedAt: "2026-07-14T00:00:00.000Z" }); // stray, should be discarded
      await renameRepositoryIdentity(env, OLD, NEW);
      const renamed = await getRepoQueueTrendSnapshot(env, NEW);
      expect(renamed?.payload).toMatchObject({ trend: "rising" });
      const newRowCount = await env.DB.prepare("select count(*) as n from repo_queue_trend_snapshots where repo_full_name = ?").bind(NEW).first<{ n: number }>();
      expect(newRowCount?.n).toBe(1); // exactly one surviving row, not two
    });
  });

  describe("repo_sync_state", () => {
    it("renames the sync-state row's repo_full_name", async () => {
      const env = createTestEnv();
      await upsertRepoSyncState(env, {
        repoFullName: OLD,
        status: "partial",
        sourceKind: "github",
        openIssuesCount: 3,
        openPullRequestsCount: 2,
        recentMergedPullRequestsCount: 1,
        warnings: ["truncated"],
      });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getRepoSyncState(env, OLD)).toBeNull();
      const renamed = await getRepoSyncState(env, NEW);
      expect(renamed).toMatchObject({ repoFullName: NEW, status: "partial", warnings: ["truncated"] });
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name sync-state row, keeping the pre-existing state", async () => {
      const env = createTestEnv();
      await upsertRepoSyncState(env, {
        repoFullName: OLD,
        status: "success",
        sourceKind: "github",
        openIssuesCount: 3,
        openPullRequestsCount: 2,
        recentMergedPullRequestsCount: 1,
        warnings: [],
      });
      await upsertRepoSyncState(env, {
        repoFullName: NEW,
        status: "never_synced",
        sourceKind: "github",
        openIssuesCount: 0,
        openPullRequestsCount: 0,
        recentMergedPullRequestsCount: 0,
        warnings: [],
      }); // stray, should be discarded
      await renameRepositoryIdentity(env, OLD, NEW);
      const renamed = await getRepoSyncState(env, NEW);
      expect(renamed?.status).toBe("success");
      const newRowCount = await env.DB.prepare("select count(*) as n from repo_sync_state where repo_full_name = ?").bind(NEW).first<{ n: number }>();
      expect(newRowCount?.n).toBe(1); // exactly one surviving row, not two
    });
  });

  describe("repo_sync_segments", () => {
    it("renames repo_full_name and id for a sync-segment row", async () => {
      const env = createTestEnv();
      await upsertRepoSyncSegment(env, { repoFullName: OLD, segment: "labels", status: "complete", sourceKind: "github", mode: "full", fetchedCount: 5, pageCount: 1, warnings: [] });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getRepoSyncSegment(env, OLD, "labels")).toBeNull();
      const renamed = await getRepoSyncSegment(env, NEW, "labels");
      expect(renamed).toMatchObject({ repoFullName: NEW, status: "complete" });
      const idRow = await env.DB.prepare("select id from repo_sync_segments where repo_full_name = ? and segment = ?").bind(NEW, "labels").first<{ id: string }>();
      expect(idRow?.id).toBe(`${NEW}#labels`);
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name row on the same segment", async () => {
      const env = createTestEnv();
      await upsertRepoSyncSegment(env, { repoFullName: OLD, segment: "labels", status: "complete", sourceKind: "github", mode: "full", fetchedCount: 5, pageCount: 1, warnings: [] });
      await upsertRepoSyncSegment(env, { repoFullName: NEW, segment: "labels", status: "never_synced", sourceKind: "github", mode: "light", fetchedCount: 0, pageCount: 0, warnings: [] }); // stray, should be discarded
      await renameRepositoryIdentity(env, OLD, NEW);
      const renamed = await getRepoSyncSegment(env, NEW, "labels");
      expect(renamed?.status).toBe("complete");
      const rows = await env.DB.prepare("select status from repo_sync_segments where repo_full_name = ? and segment = ?").bind(NEW, "labels").all<{ status: string }>();
      expect(rows.results).toHaveLength(1); // exactly one surviving row, not two
    });
  });

  describe("contributor_repo_stats", () => {
    it("renames repo_full_name and id for a contributor's stat row", async () => {
      const env = createTestEnv();
      await upsertContributorRepoStat(env, {
        login: "miner1",
        repoFullName: OLD,
        pullRequests: 2,
        mergedPullRequests: 1,
        openPullRequests: 1,
        issues: 3,
        stalePullRequests: 0,
        unlinkedPullRequests: 0,
        dominantLabels: ["bug"],
      });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await listContributorRepoStats(env, "miner1");
      expect(rows).toMatchObject([{ repoFullName: NEW, dominantLabels: ["bug"] }]);
      const idRow = await env.DB.prepare("select id from contributor_repo_stats where repo_full_name = ? and login = ?").bind(NEW, "miner1").first<{ id: string }>();
      expect(idRow?.id).toBe(`miner1#${NEW}`);
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name row for the same login", async () => {
      const env = createTestEnv();
      await upsertContributorRepoStat(env, {
        login: "miner1",
        repoFullName: OLD,
        pullRequests: 5,
        mergedPullRequests: 4,
        openPullRequests: 1,
        issues: 2,
        stalePullRequests: 0,
        unlinkedPullRequests: 0,
        dominantLabels: ["bug"],
      });
      await upsertContributorRepoStat(env, {
        login: "miner1",
        repoFullName: NEW,
        pullRequests: 1,
        mergedPullRequests: 0,
        openPullRequests: 1,
        issues: 0,
        stalePullRequests: 0,
        unlinkedPullRequests: 0,
        dominantLabels: ["stray"],
      }); // stray, should be discarded
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await listContributorRepoStats(env, "miner1");
      expect(rows.filter((row) => row.repoFullName === NEW)).toHaveLength(1); // exactly one surviving row, not two
      expect(rows.find((row) => row.repoFullName === NEW)?.pullRequests).toBe(5);
    });
  });

  describe("repo_labels", () => {
    it("renames repo_full_name and id for a label row", async () => {
      const env = createTestEnv();
      await upsertRepoLabel(env, { repoFullName: OLD, name: "bug", color: "cc0000", description: "Bug", isConfigured: true, observedCount: 4, payload: { name: "bug" } });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await listRepoLabels(env, OLD)).toEqual([]);
      const renamed = await listRepoLabels(env, NEW);
      expect(renamed).toMatchObject([{ name: "bug", isConfigured: true, observedCount: 4 }]);
      const idRow = await env.DB.prepare("select id from repo_labels where repo_full_name = ? and name = ?").bind(NEW, "bug").first<{ id: string }>();
      expect(idRow?.id).toBe(`${NEW}#bug`);
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name row with the same label name", async () => {
      const env = createTestEnv();
      await upsertRepoLabel(env, { repoFullName: OLD, name: "bug", color: "cc0000", description: "Original", isConfigured: true, observedCount: 4, payload: {} });
      await upsertRepoLabel(env, { repoFullName: NEW, name: "bug", color: "ffffff", description: "Stray", isConfigured: false, observedCount: 0, payload: {} }); // stray, should be discarded
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await listRepoLabels(env, NEW);
      expect(rows).toHaveLength(1); // exactly one surviving row, not two
      expect(rows[0]).toMatchObject({ description: "Original", observedCount: 4 });
    });
  });

  describe("collision_edges", () => {
    it("renames repo_full_name and id for a collision-edge row", async () => {
      const env = createTestEnv();
      await replaceCollisionEdges(env, OLD, [
        {
          id: `${OLD}#c1`,
          repoFullName: OLD,
          leftType: "issue",
          leftNumber: 2,
          leftTitle: "Fix index handler",
          rightType: "pull_request",
          rightNumber: 5,
          rightTitle: "Fix index handler",
          risk: "high",
          reason: "Same issue.",
          sharedTerms: ["index", "handler"],
        },
      ]);
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await listCollisionEdges(env, OLD)).toEqual([]);
      const renamed = await listCollisionEdges(env, NEW);
      expect(renamed).toMatchObject([{ id: `${NEW}#c1`, risk: "high", sharedTerms: ["index", "handler"] }]);
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name row with the same computed id", async () => {
      const env = createTestEnv();
      await replaceCollisionEdges(env, OLD, [
        {
          id: `${OLD}#c1`,
          repoFullName: OLD,
          leftType: "issue",
          leftNumber: 2,
          leftTitle: "Original left",
          rightType: "pull_request",
          rightNumber: 5,
          rightTitle: "Original right",
          risk: "high",
          reason: "Original reason.",
          sharedTerms: ["index"],
        },
      ]);
      await replaceCollisionEdges(env, NEW, [
        {
          id: `${NEW}#c1`,
          repoFullName: NEW,
          leftType: "issue",
          leftNumber: 9,
          leftTitle: "Stray left",
          rightType: "pull_request",
          rightNumber: 10,
          rightTitle: "Stray right",
          risk: "low",
          reason: "Stray reason.",
          sharedTerms: ["stray"],
        },
      ]); // stray, should be discarded -- collides on the id the rename would PRODUCE
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await listCollisionEdges(env, NEW);
      expect(rows).toHaveLength(1); // exactly one surviving row, not two
      expect(rows[0]).toMatchObject({ id: `${NEW}#c1`, reason: "Original reason.", risk: "high" });
    });
  });

  describe("notification_deliveries", () => {
    it("renames repo_full_name and rewrites the deeplink for a delivery row", async () => {
      const env = createTestEnv();
      const { delivery } = await insertNotificationDeliveryIfAbsent(env, {
        dedupKey: "dedup-1",
        channel: "badge",
        recipientLogin: "miner",
        eventType: "pull_request_changes_requested",
        repoFullName: OLD,
        pullNumber: 7,
        title: `Changes requested on ${OLD}#7`,
        body: "A reviewer requested changes on your pull request.",
        deeplink: `https://github.com/${OLD}/pull/7`,
        actorLogin: "reviewer",
      });
      await renameRepositoryIdentity(env, OLD, NEW);
      const renamed = await getNotificationDeliveryById(env, delivery.id);
      expect(renamed).toMatchObject({ repoFullName: NEW, deeplink: `https://github.com/${NEW}/pull/7` });
    });
  });

  describe("github_agent_command_answers", () => {
    it("renames repo_full_name and rewrites the response URL for a command-answer row", async () => {
      const env = createTestEnv();
      await upsertAgentCommandAnswer(env, {
        id: "answer-1",
        repoFullName: OLD,
        issueNumber: 12,
        command: "preflight",
        responseUrl: `https://github.com/${OLD}/issues/12#issuecomment-1`,
        actorKind: "author",
        metadata: {},
      });
      await renameRepositoryIdentity(env, OLD, NEW);
      const renamed = await getAgentCommandAnswer(env, "answer-1");
      expect(renamed).toMatchObject({ repoFullName: NEW, responseUrl: `https://github.com/${NEW}/issues/12#issuecomment-1` });
    });
  });

  describe("repo_snapshots", () => {
    it("renames repo_full_name for a repo-snapshot row", async () => {
      const env = createTestEnv();
      await persistRepoSnapshot(env, {
        id: "snapshot-1",
        repoFullName: OLD,
        snapshotKind: "github-backfill",
        sourceKind: "github",
        fetchedAt: "2026-07-14T00:00:00.000Z",
        primaryLanguage: "TypeScript",
        defaultBranch: "main",
        openIssuesCount: 3,
        openPullRequestsCount: 2,
        recentMergedPullRequestsCount: 1,
        payload: { ok: true },
      });
      await renameRepositoryIdentity(env, OLD, NEW);
      const oldRow = await env.DB.prepare("select count(*) as n from repo_snapshots where repo_full_name = ?").bind(OLD).first<{ n: number }>();
      expect(oldRow?.n).toBe(0);
      const renamed = await env.DB.prepare("select repo_full_name as repoFullName from repo_snapshots where id = ?").bind("snapshot-1").first<{ repoFullName: string }>();
      expect(renamed?.repoFullName).toBe(NEW);
    });
  });

  describe("repo_github_totals_snapshots", () => {
    it("renames repo_full_name for a totals-snapshot row", async () => {
      const env = createTestEnv();
      await persistRepoGithubTotalsSnapshot(env, {
        id: "totals-1",
        repoFullName: OLD,
        openIssuesTotal: 3,
        openPullRequestsTotal: 2,
        mergedPullRequestsTotal: 5,
        closedUnmergedPullRequestsTotal: 1,
        labelsTotal: 4,
        sourceKind: "github",
        fetchedAt: "2026-07-14T00:00:00.000Z",
        payload: {},
      });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getLatestRepoGithubTotalsSnapshot(env, OLD)).toBeNull();
      const renamed = await getLatestRepoGithubTotalsSnapshot(env, NEW);
      expect(renamed).toMatchObject({ repoFullName: NEW, openIssuesTotal: 3 });
    });
  });

  describe("github_rate_limit_observations", () => {
    it("renames repo_full_name for a rate-limit observation row", async () => {
      const env = createTestEnv();
      await recordGitHubRateLimitObservation(env, {
        id: "obs-1",
        repoFullName: OLD,
        resource: "rest",
        path: "/x",
        statusCode: 200,
        limitValue: 5000,
        remaining: 10,
        resetAt: "2026-07-14T01:00:00.000Z",
      });
      await renameRepositoryIdentity(env, OLD, NEW);
      const oldRow = await env.DB.prepare("select count(*) as n from github_rate_limit_observations where repo_full_name = ?").bind(OLD).first<{ n: number }>();
      expect(oldRow?.n).toBe(0);
      const renamed = await env.DB.prepare("select repo_full_name as repoFullName from github_rate_limit_observations where id = ?").bind("obs-1").first<{ repoFullName: string }>();
      expect(renamed?.repoFullName).toBe(NEW);
    });

    it("leaves a NULL repo_full_name observation (an installation-level, not repo-scoped, event) untouched", async () => {
      const env = createTestEnv();
      await recordGitHubRateLimitObservation(env, {
        id: "obs-null",
        repoFullName: null,
        admissionKey: "installation:1",
        resource: "rest",
        path: "/app/installations/1",
        statusCode: 200,
        limitValue: 5000,
        remaining: 5,
        resetAt: "2026-07-14T01:00:00.000Z",
      });
      await renameRepositoryIdentity(env, OLD, NEW);
      const row = await env.DB.prepare("select repo_full_name as repoFullName from github_rate_limit_observations where id = ?").bind("obs-null").first<{ repoFullName: string | null }>();
      expect(row?.repoFullName).toBeNull();
    });
  });

  describe("product_usage_events", () => {
    it("renames repo_full_name for a product-usage-event row", async () => {
      const env = createTestEnv();
      const recorded = await recordProductUsageEvent(env, { surface: "api", eventName: "rename.test", repoFullName: OLD, outcome: "success" });
      await renameRepositoryIdentity(env, OLD, NEW);
      const events = await listProductUsageEvents(env);
      expect(events.find((event) => event.id === recorded.id)?.repoFullName).toBe(NEW);
    });

    it("leaves a NULL repo_full_name event (not associated with any repo) untouched", async () => {
      const env = createTestEnv();
      const recorded = await recordProductUsageEvent(env, { surface: "mcp", eventName: "generic.event", outcome: "success" });
      await renameRepositoryIdentity(env, OLD, NEW);
      const events = await listProductUsageEvents(env);
      expect(events.find((event) => event.id === recorded.id)?.repoFullName).toBeNull();
    });
  });

  describe("signal_snapshots", () => {
    it("renames repo_full_name for a signal-snapshot row", async () => {
      const env = createTestEnv();
      await persistSignalSnapshot(env, { id: "signal-1", signalType: "queue-health", targetKey: OLD, repoFullName: OLD, payload: { ok: true } });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await listSignalSnapshots(env, "queue-health", OLD);
      expect(rows.find((row) => row.id === "signal-1")?.repoFullName).toBe(NEW);
    });

    it("leaves a NULL repo_full_name snapshot (a contributor/global-scoped signal) untouched", async () => {
      const env = createTestEnv();
      await persistSignalSnapshot(env, { id: "signal-2", signalType: "contributor-trust", targetKey: "miner1", repoFullName: null, payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await listSignalSnapshots(env, "contributor-trust", "miner1");
      expect(rows.find((row) => row.id === "signal-2")?.repoFullName).toBeNull();
    });
  });

  describe("audit_events", () => {
    it("renames every target_key containing the old full name, including composite repo#number keys, leaving unrelated keys untouched", async () => {
      const env = createTestEnv();
      await recordAuditEvent(env, { eventType: "test.event", actor: "loopover", targetKey: OLD, outcome: "completed", detail: "repo-level" });
      await recordAuditEvent(env, { eventType: "test.event", actor: "loopover", targetKey: `${OLD}#42`, outcome: "completed", detail: "pr-level" });
      await recordAuditEvent(env, { eventType: "test.event", actor: "loopover", targetKey: `${OLD}#42`, outcome: "completed", detail: "pr-level, second event, same target_key" });
      await recordAuditEvent(env, { eventType: "test.event", actor: "loopover", targetKey: "some/other-repo#1", outcome: "completed", detail: "unrelated" });

      await renameRepositoryIdentity(env, OLD, NEW);

      const oldRepoLevel = await env.DB.prepare("select count(*) as n from audit_events where target_key = ?").bind(OLD).first<{ n: number }>();
      expect(oldRepoLevel?.n).toBe(0);
      const newRepoLevel = await env.DB.prepare("select count(*) as n from audit_events where target_key = ?").bind(NEW).first<{ n: number }>();
      expect(newRepoLevel?.n).toBe(1);
      const newPrLevel = await env.DB.prepare("select count(*) as n from audit_events where target_key = ?").bind(`${NEW}#42`).first<{ n: number }>();
      expect(newPrLevel?.n).toBe(2); // both rows sharing the same target_key survive -- no uniqueness on this column
      const unrelated = await env.DB.prepare("select count(*) as n from audit_events where target_key = ?").bind("some/other-repo#1").first<{ n: number }>();
      expect(unrelated?.n).toBe(1);
    });
  });
});
