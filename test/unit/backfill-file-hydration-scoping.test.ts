import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPullRequestDetailSyncState,
  listPullRequestFiles,
  listRecentMergedPullRequests,
  recordGitHubRateLimitObservation,
  upsertPullRequestDetailSyncState,
  upsertPullRequestFile,
  upsertPullRequestFromGitHub,
} from "../../src/db/repositories";
import { backfillOpenPullRequestDetails, backfillRegisteredRepositories, backfillRepositorySegment, refreshPullRequestDetails } from "../../src/github/backfill";
import { clearGitHubResponseCacheForTest } from "../../src/github/client";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { createTestEnv } from "../helpers/d1";

describe("GitHub PR file hydration scoping (#audit-rate-headroom)", () => {
  afterEach(() => {
    clearGitHubResponseCacheForTest();
    resetMetrics();
    vi.unstubAllGlobals();
  });

  async function seedRegisteredRepo(env: Env) {
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, trusted_label_pipeline: true, label_multipliers: {} } },
        { kind: "raw-github", url: "https://example.test/master_repositories.json" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
  }

  function stubFetchTracking(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): string[] {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      urls.push(url);
      return handler(url, init);
    });
    return urls;
  }

  it("does not fetch PR files for a pull request missing from pull_requests", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    const urls = stubFetchTracking(() => Response.json([]));

    const result = await refreshPullRequestDetails(env, "JSONbored/gittensory", 404);

    expect(result).toMatchObject({ status: "partial", warnings: ["Repository or pull request was not found."] });
    expect(urls.some((url) => url.includes("/files"))).toBe(false);
  });

  it("does not re-fetch files for a closed PR that already has complete stored telemetry, but does when forced", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 20,
      title: "Closed PR",
      state: "closed",
      user: { login: "oktofeesh1" },
      head: { sha: "closed-sha" },
      labels: [],
      body: "",
    });
    await upsertPullRequestDetailSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 20,
      status: "complete",
      headSha: "closed-sha",
      filesSyncedAt: "2026-05-20T00:00:00.000Z",
    });
    const urls = stubFetchTracking((url) => (url.includes("/files") ? new Response("must not be called", { status: 500 }) : Response.json([])));

    const unforced = await refreshPullRequestDetails(env, "JSONbored/gittensory", 20);
    expect(unforced).toMatchObject({ status: "complete", warnings: [] });
    expect(urls.some((url) => url.includes("/files"))).toBe(false);

    urls.length = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      urls.push(url);
      return url.includes("/pulls/20/files") ? Response.json([{ filename: "src/final.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }]) : Response.json([]);
    });
    const forced = await refreshPullRequestDetails(env, "JSONbored/gittensory", 20, { force: true });
    expect(forced).toMatchObject({ status: "complete" });
    expect(urls.some((url) => url.includes("/pulls/20/files"))).toBe(true);
  });

  it("still fetches a closed PR without a complete sync state (no stored telemetry yet to rely on)", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 21,
      title: "Closed PR, never synced",
      state: "closed",
      user: { login: "oktofeesh1" },
      head: { sha: "closed-sha-2" },
      labels: [],
      body: "",
    });
    const urls = stubFetchTracking(() => Response.json([]));

    const result = await refreshPullRequestDetails(env, "JSONbored/gittensory", 21);

    expect(result).toMatchObject({ status: "complete" });
    expect(urls.some((url) => url.includes("/pulls/21/files"))).toBe(true);
  });

  it("fetches PR files for a current open PR when no repo+PR+head snapshot exists", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 30,
      title: "Open PR, never synced",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "head-1" },
      labels: [],
      body: "",
    });
    const urls = stubFetchTracking((url) =>
      url.includes("/pulls/30/files") ? Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }]) : Response.json([]),
    );

    const result = await refreshPullRequestDetails(env, "JSONbored/gittensory", 30);

    expect(result).toMatchObject({ status: "complete" });
    expect(urls.some((url) => url.includes("/pulls/30/files"))).toBe(true);
    expect(await listPullRequestFiles(env, "JSONbored/gittensory", 30)).toEqual([expect.objectContaining({ path: "src/a.ts" })]);
    expect(await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 30)).toMatchObject({ headSha: "head-1", status: "complete" });
  });

  it("reuses the repo+PR+head file snapshot without calling GitHub when the head is unchanged", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 31,
      title: "Open PR, already synced",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "head-1" },
      labels: [],
      body: "",
    });
    await upsertPullRequestFile(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 31,
      path: "src/cached.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      changes: 3,
      payload: { filename: "src/cached.ts" },
    });
    await upsertPullRequestDetailSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 31,
      status: "complete",
      headSha: "head-1",
      filesSyncedAt: "2026-05-20T00:00:00.000Z",
    });
    const urls = stubFetchTracking((url) => (url.includes("/files") ? new Response("must not be called", { status: 500 }) : Response.json([])));

    const result = await refreshPullRequestDetails(env, "JSONbored/gittensory", 31);

    expect(result).toMatchObject({ status: "complete", warnings: [] });
    expect(urls.some((url) => url.includes("/pulls/31/files"))).toBe(false);
    expect(await listPullRequestFiles(env, "JSONbored/gittensory", 31)).toEqual([expect.objectContaining({ path: "src/cached.ts", changes: 3 })]);
  });

  it("fetches fresh files and does not reuse the previous snapshot when the head SHA changes", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 32,
      title: "Open PR, new push",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "head-2" },
      labels: [],
      body: "",
    });
    await upsertPullRequestFile(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 32,
      path: "src/old.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: { filename: "src/old.ts" },
    });
    await upsertPullRequestDetailSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 32,
      status: "complete",
      headSha: "head-1",
      filesSyncedAt: "2026-05-20T00:00:00.000Z",
    });
    const urls = stubFetchTracking((url) =>
      url.includes("/pulls/32/files") ? Response.json([{ filename: "src/new.ts", status: "added", additions: 5, deletions: 0, changes: 5 }]) : Response.json([]),
    );

    const result = await refreshPullRequestDetails(env, "JSONbored/gittensory", 32);

    expect(result).toMatchObject({ status: "complete" });
    expect(urls.some((url) => url.includes("/pulls/32/files"))).toBe(true);
    expect(await listPullRequestFiles(env, "JSONbored/gittensory", 32)).toEqual([expect.objectContaining({ path: "src/new.ts" })]);
    expect(await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 32)).toMatchObject({ headSha: "head-2" });
  });

  it("does not stamp a new head-SHA file snapshot when the changed-head file fetch fails", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 33,
      title: "Open PR, new push with transient file failure",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "head-2" },
      labels: [],
      body: "",
    });
    await upsertPullRequestFile(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 33,
      path: "src/old.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: { filename: "src/old.ts" },
    });
    await upsertPullRequestDetailSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 33,
      status: "complete",
      headSha: "head-1",
      filesSyncedAt: "2026-05-20T00:00:00.000Z",
    });
    let failFiles = true;
    const urls = stubFetchTracking((url) => {
      if (url.includes("/pulls/33/files")) {
        return failFiles ? new Response("transient REST failure", { status: 503 }) : Response.json([{ filename: "src/new.ts", status: "added", additions: 5, deletions: 0, changes: 5 }]);
      }
      if (url.includes("/graphql")) return new Response("transient GraphQL failure", { status: 503 });
      return Response.json([]);
    });

    const failed = await refreshPullRequestDetails(env, "JSONbored/gittensory", 33);

    expect(failed).toMatchObject({ status: "partial", warnings: [expect.stringContaining("File sync failed for #33")] });
    expect(await listPullRequestFiles(env, "JSONbored/gittensory", 33)).toEqual([expect.objectContaining({ path: "src/old.ts" })]);
    expect(await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 33)).toMatchObject({
      headSha: "head-1",
      filesSyncedAt: "2026-05-20T00:00:00.000Z",
    });

    failFiles = false;
    urls.length = 0;
    const retried = await refreshPullRequestDetails(env, "JSONbored/gittensory", 33);

    expect(retried).toMatchObject({ status: "complete", warnings: [] });
    expect(urls.some((url) => url.includes("/pulls/33/files"))).toBe(true);
    expect(await listPullRequestFiles(env, "JSONbored/gittensory", 33)).toEqual([expect.objectContaining({ path: "src/new.ts" })]);
    expect(await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 33)).toMatchObject({ headSha: "head-2" });
  });

  it("a failed file sync never regresses a marker a concurrent successful sync already advanced past it (gate review finding)", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 34,
      title: "Open PR, racing concurrent refresh",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "head-2" },
      labels: [],
      body: "",
    });
    // This call's own initial state read (TOCTOU snapshot): stale head-1.
    await upsertPullRequestDetailSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 34,
      status: "complete",
      headSha: "head-1",
      filesSyncedAt: "2026-05-20T00:00:00.000Z",
    });
    stubFetchTracking((url) => {
      if (url.includes("/pulls/34/files")) {
        // Simulate a DIFFERENT concurrent call successfully syncing to an even newer head and persisting
        // its own (correct, newer) marker BETWEEN this call's initial state read and this call's own
        // failed-fetch persist below -- the exact interleaving the gate review flagged.
        void upsertPullRequestDetailSyncState(env, {
          repoFullName: "JSONbored/gittensory",
          pullNumber: 34,
          status: "complete",
          headSha: "head-3",
          filesSyncedAt: "2026-05-25T00:00:00.000Z",
        });
        return new Response("transient REST failure", { status: 503 });
      }
      if (url.includes("/graphql")) return new Response("transient GraphQL failure", { status: 503 });
      return Response.json([]);
    });

    const failed = await refreshPullRequestDetails(env, "JSONbored/gittensory", 34);

    expect(failed).toMatchObject({ status: "partial", warnings: [expect.stringContaining("File sync failed for #34")] });
    // The failed call must not stomp the concurrently-written newer marker back to its own stale head-1
    // snapshot -- it must leave the column untouched (undefined-omit), so the concurrent success's head-3
    // marker survives.
    expect(await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 34)).toMatchObject({
      headSha: "head-3",
      filesSyncedAt: "2026-05-25T00:00:00.000Z",
    });
  });

  it("defers historical merged-PR file hydration when the REST budget is below the historical-backfill floor, while cheap metadata still syncs", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    // Below HISTORICAL_BACKFILL_RESERVED_HEADROOM (300) but above MAINTENANCE_RESERVED_HEADROOM (150) and
    // LOW_REST_RATE_LIMIT_REMAINING (75) — healthy enough for the segment's own entry check and for current-PR
    // convergence, but not for the least-urgent historical hydration path.
    // Registry-only repo (no installation), so tokenForRepo resolves to the shared public token and
    // repoAdmissionKeyForToken scopes to that bucket (#audit-rate-scoping).
    await recordGitHubRateLimitObservation(env, {
      repoFullName: "JSONbored/gittensory",
      admissionKey: "public-token",
      resource: "rest",
      path: "/pulls",
      statusCode: 200,
      remaining: 200,
      resetAt: "2999-01-01T00:00:00.000Z",
    });
    const urls = stubFetchTracking((url) => {
      if (url.includes("/pulls?state=closed")) {
        return Response.json([
          { number: 501, title: "Merged 501", state: "closed", merged_at: "2026-05-20T00:00:00.000Z", user: { login: "a" }, labels: [], body: "" },
          { number: 502, title: "Merged 502", state: "closed", merged_at: "2026-05-20T00:00:00.000Z", user: { login: "a" }, labels: [], body: "" },
        ]);
      }
      return Response.json([]);
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "recent_merged_pull_requests", mode: "full" });

    // Not throttled at the segment's own entry check (default LOW_REST_RATE_LIMIT_REMAINING floor) — only the
    // historical file hydration inside it yields, at the stricter HISTORICAL_BACKFILL_RESERVED_HEADROOM floor.
    expect(result.status).not.toBe("waiting_rate_limit");
    expect(urls.some((url) => url.includes("/files"))).toBe(false);
    const stored = await listRecentMergedPullRequests(env, "JSONbored/gittensory");
    expect(stored.map((row) => row.number).sort()).toEqual([501, 502]);
    expect(stored.every((row) => row.changedFiles.length === 0)).toBe(true);
  });

  it("still allows current open PR convergence within its small batch cap at the same reduced budget", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await recordGitHubRateLimitObservation(env, {
      repoFullName: "JSONbored/gittensory",
      resource: "rest",
      path: "/pulls",
      statusCode: 200,
      remaining: 200,
      resetAt: "2999-01-01T00:00:00.000Z",
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 40,
      title: "Open PR under reduced budget",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "head-40" },
      labels: [],
      body: "",
    });
    const urls = stubFetchTracking((url) => (url.includes("/pulls/40/files") ? Response.json([{ filename: "src/x.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }]) : Response.json([])));

    const result = await backfillOpenPullRequestDetails(env, { repoFullName: "JSONbored/gittensory", mode: "light", cursor: 0 });

    expect(result.status).toBe("complete");
    expect(urls.some((url) => url.includes("/pulls/40/files"))).toBe(true);
  });

  it("caps historical merged-PR file hydration per page even when the REST budget is healthy", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    const mergedPage = Array.from({ length: 25 }, (_, index) => ({
      number: 600 + index,
      title: `Merged ${600 + index}`,
      state: "closed" as const,
      merged_at: "2026-05-20T00:00:00.000Z",
      user: { login: "a" },
      labels: [],
      body: "",
    }));
    const fetchedFileNumbers: number[] = [];
    stubFetchTracking((url) => {
      if (url.includes("/pulls?state=closed")) return Response.json(mergedPage);
      const match = /\/pulls\/(\d+)\/files/.exec(url);
      if (match) {
        fetchedFileNumbers.push(Number(match[1]));
        return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }]);
      }
      return Response.json([]);
    });

    await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "recent_merged_pull_requests", mode: "light" });

    // MERGED_PR_FILE_HYDRATION_BATCH_SIZE.light === 10, far under the 25 un-hydrated candidates in this page.
    expect(fetchedFileNumbers.length).toBe(10);
    const stored = await listRecentMergedPullRequests(env, "JSONbored/gittensory");
    expect(stored).toHaveLength(25);
    expect(stored.filter((row) => row.changedFiles.length > 0)).toHaveLength(10);
  });

  it("records bounded caller labels on the PR files fetch metric for backfill, historical, and live-review callers", async () => {
    resetMetrics();
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 50,
      title: "Open PR (backfill caller)",
      state: "open",
      user: { login: "a" },
      head: { sha: "head-50" },
      labels: [],
      body: "",
    });
    stubFetchTracking((url) => {
      if (url.includes("/pulls?state=closed")) return Response.json([{ number: 700, title: "Merged", state: "closed", merged_at: "2026-05-20T00:00:00.000Z", user: { login: "a" }, labels: [], body: "" }]);
      return Response.json([]);
    });

    // #50 is the only open PR at this point, so this call attributes exactly one fetch to "backfill_open_pr_details".
    await backfillOpenPullRequestDetails(env, { repoFullName: "JSONbored/gittensory", mode: "light", cursor: 0 });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 51,
      title: "Open PR (live review caller)",
      state: "open",
      user: { login: "a" },
      head: { sha: "head-51" },
      labels: [],
      body: "",
    });
    await refreshPullRequestDetails(env, "JSONbored/gittensory", 51);
    await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "recent_merged_pull_requests", mode: "light" });

    const metrics = await renderMetrics();
    expect(metrics).toContain('loopover_github_pull_request_files_fetch_total{caller="backfill_open_pr_details"} 1');
    expect(metrics).toContain('loopover_github_pull_request_files_fetch_total{caller="live_review"} 1');
    expect(metrics).toContain('loopover_github_pull_request_files_fetch_total{caller="backfill_merged_history"} 1');
    // Bounded: only the 3 known caller values appear, never a per-PR-number label.
    const callerLines = metrics.split("\n").filter((line) => line.startsWith("loopover_github_pull_request_files_fetch_total{"));
    expect(callerLines).toHaveLength(3);
  });

  it("populates the head-SHA snapshot from the monolithic backfillRegisteredRepositories path so a later run reuses it (regression: the /run admin endpoint's PR-detail loop must WRITE the cache it reads)", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    let filesCallCount = 0;
    stubFetchTracking((url) => {
      if (url.endsWith("/repos/JSONbored/gittensory")) return Response.json({ name: "gittensory", full_name: "JSONbored/gittensory", default_branch: "main", owner: { login: "JSONbored" } });
      if (url.includes("/pulls?state=open")) {
        return Response.json([{ number: 60, title: "Open PR", state: "open", user: { login: "a" }, head: { sha: "head-60" }, labels: [], body: "" }]);
      }
      if (url.includes("/pulls/60/files")) {
        filesCallCount += 1;
        return Response.json([{ filename: "src/x.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }]);
      }
      return Response.json([]);
    });

    // First run: cold cache, must fetch and then WRITE the snapshot marker.
    await backfillRegisteredRepositories(env, { repoFullName: "JSONbored/gittensory", limits: { issues: 10, pullRequests: 10, recentMergedPullRequests: 10, pullRequestDetails: 10 } });
    expect(filesCallCount).toBe(1);
    expect(await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 60)).toMatchObject({ headSha: "head-60", status: "complete" });

    // Second run, same head: the cache this path itself just wrote must be reused, not re-fetched.
    await backfillRegisteredRepositories(env, { repoFullName: "JSONbored/gittensory", force: true, limits: { issues: 10, pullRequests: 10, recentMergedPullRequests: 10, pullRequestDetails: 10 } });
    expect(filesCallCount).toBe(1);
  });

  describe("upsertPullRequestDetailSyncState partial-update contract", () => {
    it("preserves an existing headSha (and other fields) when a later upsert omits them, as every 'running' pre-fetch stamp does", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, {
        repoFullName: "JSONbored/gittensory",
        pullNumber: 90,
        status: "complete",
        headSha: "sha-a",
        filesSyncedAt: "2026-05-20T00:00:00.000Z",
        errorSummary: "prior warning",
      });

      // The "running" pre-fetch stamp every backfill path sends touches ONLY status — headSha/filesSyncedAt/
      // errorSummary are omitted (undefined), not explicitly cleared. The file cache depends on this NOT
      // wiping the row it is about to read.
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 90, status: "running" });

      expect(await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 90)).toMatchObject({
        status: "running",
        headSha: "sha-a",
        filesSyncedAt: "2026-05-20T00:00:00.000Z",
        errorSummary: "prior warning",
      });
    });

    it("clears headSha when a caller explicitly passes null, distinguishing 'omitted' from 'cleared'", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 91, status: "complete", headSha: "sha-b" });

      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 91, status: "complete", headSha: null });

      expect(await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 91)).toMatchObject({ headSha: null });
    });
  });

  describe("listPullRequestFiles ordering (#linked-issue-satisfaction-cache-fingerprint-stability)", () => {
    it("REGRESSION: returns files in a stable path order regardless of write order, so a downstream content fingerprint never flips for an unchanged PR", async () => {
      const env = createTestEnv();
      // Written deliberately out of path order -- without an explicit ORDER BY, a query planner is free to
      // return rows in ITS OWN order, which is not guaranteed to match write order or stay stable call to
      // call. buildUnifiedReviewDiff only fully orders by (priority bucket, added-line count); files tied on
      // both (as these three are: all source, all 0 additions/0 deletions) fall through to this function's
      // own order, so an unstable order here silently reorders the diff string and flips any hash built from
      // it (e.g. linkedIssueSatisfactionCacheInputFingerprint) even though nothing about the diff changed.
      const paths = ["src/z.ts", "src/a.ts", "src/m.ts"];
      for (const path of paths) {
        await upsertPullRequestFile(env, {
          repoFullName: "JSONbored/gittensory",
          pullNumber: 200,
          path,
          status: "modified",
          additions: 0,
          deletions: 0,
          changes: 0,
          payload: {},
        });
      }
      const first = await listPullRequestFiles(env, "JSONbored/gittensory", 200);
      const second = await listPullRequestFiles(env, "JSONbored/gittensory", 200);
      expect(first.map((file) => file.path)).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
      expect(second.map((file) => file.path)).toEqual(first.map((file) => file.path));
    });
  });
});
