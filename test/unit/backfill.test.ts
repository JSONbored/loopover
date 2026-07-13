import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getInstallationHealth,
  listCheckSummaries,
  listContributorRepoStats,
  listIssues,
  listLatestRepoGithubTotalsSnapshots,
  listPullRequestFiles,
  listPullRequestReviews,
  listPullRequests,
  listPullRequestDetailSyncStates,
  listRecentMergedPullRequests,
  upsertRecentMergedPullRequest,
  listLatestGitHubRateLimitObservations,
  listRepoLabels,
  listRepoSyncSegments,
  listRepoSyncStates,
  persistRepoGithubTotalsSnapshot,
  recordGitHubRateLimitObservation,
  upsertInstallation,
  upsertInstallationHealth,
  upsertRepoSyncSegment,
  upsertRepoSyncState,
  getPullRequest,
  upsertPullRequestFile,
  upsertPullRequestFromGitHub,
  upsertIssueFromGitHub,
  upsertRepoLabel,
  upsertRepositoryFromGitHub,
  upsertRepositorySettings,
} from "../../src/db/repositories";
import {
  backfillOpenPullRequestDetails,
  backfillRegisteredRepositories,
  backfillRepositorySegment,
  buildInstallationRepairDiagnostics,
  enqueueRepositoryOpenDataBackfill,
  enrichInstallationHealth,
  fetchAndStorePullRequestFilesForReview,
  fetchLinkedIssueClosedByPullRequest,
  fetchLinkedIssueFacts,
  fetchLiveBaseBranchAdvancedAt,
  fetchLiveCiAggregate,
  fetchLiveReviewThreadBlockers,
  fetchNamedCheckRunConclusion,
  fetchRequiredStatusContexts,
  isOwnReviewThreadAuthor,
  isRateLimitedGitHubFailure,
  mergeRequiredCiContexts,
  reconcileOpenPullRequests,
  refreshContributorActivity,
  refreshInstallationHealth,
  refreshPullRequestDetails,
} from "../../src/github/backfill";
import {
  clearGitHubResponseCacheForTest,
  githubRateLimitAdmissionKeyForInstallation,
  githubRateLimitAdmissionKeyForPublicToken,
  setGitHubResponseCache,
  type CachedGitHubResponse,
} from "../../src/github/client";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import { createTestEnv } from "../helpers/d1";

// #4682 incident (2026-07-10): the stored-body cap used to be 4000 chars -- well under what a compliant
// screenshot-evidence table (or any sufficiently detailed PR/issue) actually needs -- and every body-content
// check (screenshotTableGate's matrix parser included) reads the STORED copy, not a live GitHub fetch, so a
// silently truncated body produced a false "missing evidence" close for a PR that had genuinely complete
// evidence. The cap now matches GitHub's own issue/PR body limit (65536) so it can only ever bind on content
// GitHub itself was never going to accept.

describe("pull request / issue body storage cap (#4682 regression)", () => {
  it("stores a body well past the OLD 4000-char cap in full, unmangled", async () => {
    const env = createTestEnv();
    const longBody = "x".repeat(5160); // matches the real metagraphed#4682 body length that got truncated
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 4682,
      title: "Long body PR",
      state: "open",
      user: { login: "nickmopen" },
      head: { sha: "abc4682" },
      labels: [],
      body: longBody,
    });
    const stored = await getPullRequest(env, "JSONbored/gittensory", 4682);
    expect(stored?.body).toBe(longBody);
    expect(stored?.body?.length).toBe(5160);
  });

  it("still caps a body at GitHub's own 65536-char issue/PR body limit, not unboundedly", async () => {
    const env = createTestEnv();
    const oversizedBody = "y".repeat(70000);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 4683,
      title: "Oversized body PR",
      state: "open",
      user: { login: "nickmopen" },
      head: { sha: "abc4683" },
      labels: [],
      body: oversizedBody,
    });
    const stored = await getPullRequest(env, "JSONbored/gittensory", 4683);
    expect(stored?.body?.length).toBe(65536);
    expect(stored?.body).toBe(oversizedBody.slice(0, 65536));
  });

  it("stores an issue body well past the OLD 4000-char cap in full too (compactGitHubPayload is shared)", async () => {
    const env = createTestEnv();
    const longBody = "z".repeat(4500);
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", {
      number: 9001,
      title: "Long issue body",
      state: "open",
      user: { login: "nickmopen" },
      labels: [],
      body: longBody,
    });
    const stored = await listIssues(env, "JSONbored/gittensory");
    const issue = stored.find((i) => i.number === 9001);
    expect(issue?.body).toBe(longBody);
  });

  it("logs a structured, greppable trace the instant a PR body actually gets truncated -- the #4682 failure mode was total silence", async () => {
    const env = createTestEnv();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        number: 4684,
        title: "Body past the real GitHub limit",
        state: "open",
        user: { login: "nickmopen" },
        head: { sha: "abc4684" },
        labels: [],
        body: "w".repeat(70000),
      });
      const traceLine = logSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes("github_app.body_truncated_on_store"));
      expect(traceLine).toBeDefined();
      const parsed = JSON.parse(traceLine as string) as Record<string, unknown>;
      expect(parsed).toMatchObject({ event: "github_app.body_truncated_on_store", kind: "pull_request", repoFullName: "JSONbored/gittensory", number: 4684, originalLength: 70000, storedLength: 65536 });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("never logs the truncation trace for a body within the cap (the common case stays silent)", async () => {
    const env = createTestEnv();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        number: 4685,
        title: "Ordinary body",
        state: "open",
        user: { login: "nickmopen" },
        head: { sha: "abc4685" },
        labels: [],
        body: "normal PR body",
      });
      expect(logSpy.mock.calls.map((c) => String(c[0])).some((line) => line.includes("github_app.body_truncated_on_store"))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs the truncation trace for issue bodies too (compactGitHubPayload is shared)", async () => {
    const env = createTestEnv();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await upsertIssueFromGitHub(env, "JSONbored/gittensory", {
        number: 9002,
        title: "Oversized issue body",
        state: "open",
        user: { login: "nickmopen" },
        labels: [],
        body: "v".repeat(70000),
      });
      const traceLine = logSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes("github_app.body_truncated_on_store"));
      expect(traceLine).toBeDefined();
      expect(JSON.parse(traceLine as string)).toMatchObject({ kind: "issue", repoFullName: "JSONbored/gittensory", number: 9002 });
    } finally {
      logSpy.mockRestore();
    }
  });
});

async function seedRegisteredRepo(env: Env) {
  await persistRegistrySnapshot(
    env,
    normalizeRegistryPayload(
      {
        "JSONbored/gittensory": {
          emission_share: 0.01,
          issue_discovery_share: 0,
          trusted_label_pipeline: true,
          label_multipliers: { bug: 1.1, refactor: 0.5 },
        },
      },
      { kind: "raw-github", url: "https://example.test/master_repositories.json" },
      "2026-05-23T00:00:00.000Z",
    ),
  );
}

async function generatePrivateKeyPem(): Promise<string> {
  const key = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const base64 = Buffer.from(exported as ArrayBuffer).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

async function persistTotalsSnapshot(
  env: Env,
  overrides: {
    fetchedAt?: string;
    sourceKind?: "github" | "installation";
    openIssuesTotal?: number;
    openPullRequestsTotal?: number;
    mergedPullRequestsTotal?: number;
    closedUnmergedPullRequestsTotal?: number;
    labelsTotal?: number;
  } = {},
) {
  await persistRepoGithubTotalsSnapshot(env, {
    id: crypto.randomUUID(),
    repoFullName: "JSONbored/gittensory",
    openIssuesTotal: overrides.openIssuesTotal ?? 0,
    openPullRequestsTotal: overrides.openPullRequestsTotal ?? 0,
    mergedPullRequestsTotal: overrides.mergedPullRequestsTotal ?? 0,
    closedUnmergedPullRequestsTotal: overrides.closedUnmergedPullRequestsTotal ?? 0,
    labelsTotal: overrides.labelsTotal ?? 0,
    sourceKind: overrides.sourceKind ?? "github",
    fetchedAt: overrides.fetchedAt ?? "2026-05-25T00:00:00.000Z",
    payload: {},
  });
}

function githubTotalsResponse(counts: { openIssues: number; openPullRequests: number; mergedPullRequests: number; closedPullRequests: number; labels: number }) {
  return Response.json({
    data: {
      rateLimit: { remaining: 4999, resetAt: "2026-05-25T01:00:00.000Z" },
      repository: {
        issues: { totalCount: counts.openIssues },
        openPullRequests: { totalCount: counts.openPullRequests },
        mergedPullRequests: { totalCount: counts.mergedPullRequests },
        closedPullRequests: { totalCount: counts.closedPullRequests },
        labels: { totalCount: counts.labels },
      },
    },
  });
}

describe("GitHub backfill", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearGitHubResponseCacheForTest();
    vi.unstubAllGlobals();
  });


  it("fetches the fresh base branch tip timestamp without replaying the commit response cache", async () => {
    const env = createTestEnv();
    const cacheGet = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ commit: { committer: { date: "2024-01-01T00:00:00Z" } } }),
      contentType: "application/json",
    }));
    const cacheSet = vi.fn(async () => undefined);
    setGitHubResponseCache({ get: cacheGet, set: cacheSet });
    let getFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      getFetches += 1;
      expect(String(input)).toBe("https://api.github.com/repos/JSONbored/gittensory/commits/main");
      return Response.json({ commit: { committer: { date: "2026-07-02T23:32:36.181Z" } } });
    });

    await expect(
      fetchLiveBaseBranchAdvancedAt(env, "JSONbored/gittensory", "main", "tok", githubRateLimitAdmissionKeyForInstallation(123)),
    ).resolves.toBe("2026-07-02T23:32:36.181Z");

    expect(getFetches).toBe(1);
    expect(cacheGet).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
    // The bypass contract is neither READ nor WRITE: a live-freshness read must not land in the
    // persistent rate-limit-observation state either (#2762 gate finding).
    expect(await listLatestGitHubRateLimitObservations(env)).toEqual([]);
  });

  it("stores bounded repo metadata, labels, issues, PR details, recent merges, and contributor stats", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    const authHeaders: Array<string | null> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      authHeaders.push(new Headers(init?.headers).get("authorization"));
      if (url.endsWith("/repos/JSONbored/gittensory")) {
        return Response.json({
          name: "gittensory",
          full_name: "JSONbored/gittensory",
          private: true,
          html_url: "https://github.com/JSONbored/gittensory",
          default_branch: "main",
          language: "TypeScript",
          open_issues_count: 3,
          owner: { login: "JSONbored" },
        });
      }
      if (url.includes("/labels?")) {
        return Response.json([{ name: "bug", color: "cc0000", description: "Bug" }]);
      }
      if (url.includes("/issues?")) {
        return Response.json([
          {
            number: 1,
            title: "Fix webhook processing",
            state: "open",
            user: { login: "reporter" },
            labels: [{ name: "bug" }],
            body: "Webhook processing should be stable.",
            created_at: "2026-05-20T00:00:00.000Z",
            updated_at: "2026-05-21T00:00:00.000Z",
          },
        ]);
      }
      if (url.includes("/pulls?state=open")) {
        return Response.json([
          {
            number: 10,
            title: "Fix webhook processing",
            state: "open",
            user: { login: "oktofeesh1" },
            author_association: "NONE",
            head: { sha: "abc", ref: "fix-webhook" },
            base: { ref: "main" },
            labels: [{ name: "bug" }],
            body: "Fixes #1",
            created_at: "2026-05-22T00:00:00.000Z",
            updated_at: "2026-05-23T00:00:00.000Z",
          },
        ]);
      }
      if (url.includes("/pulls?state=closed")) {
        return Response.json([
          {
            number: 9,
            title: "Fix webhook processing",
            state: "closed",
            merged_at: "2026-05-22T00:00:00.000Z",
            user: { login: "oktofeesh1" },
            labels: [{ name: "bug" }],
            body: "Fixes #1",
          },
        ]);
      }
      if (url.includes("/pulls/10/files") || url.includes("/pulls/9/files")) {
        return Response.json([
          { filename: "src/github/webhook.ts", status: "modified", additions: 12, deletions: 3, changes: 15 },
          { filename: "README.md" },
        ]);
      }
      if (url.includes("/pulls/10/reviews")) {
        return Response.json([
          { id: 1, user: { login: "maintainer" }, state: "APPROVED", submitted_at: "2026-05-23T00:00:00.000Z" },
          { id: 2 },
        ]);
      }
      if (url.includes("/commits/abc/check-runs")) {
        return Response.json({
          check_runs: [
            { id: 2, name: "test", status: "completed", conclusion: "success" },
            { id: 3, name: "lint", status: "completed", conclusion: null, html_url: "https://github.com/checks/3" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRegisteredRepositories(env, { limits: { issues: 10, pullRequests: 10, recentMergedPullRequests: 10 } });
    expect(result).toMatchObject({ repoCount: 1, repos: [{ status: "success", openIssues: 1, openPullRequests: 1 }] });
    expect(await listIssues(env, "JSONbored/gittensory")).toMatchObject([{ number: 1, labels: ["bug"] }]);
    expect(await listPullRequests(env, "JSONbored/gittensory")).toMatchObject([{ number: 10, linkedIssues: [1] }]);
    expect(await listRepoLabels(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "bug", isConfigured: true, observedCount: 3 })]),
    );
    expect(await listPullRequestFiles(env, "JSONbored/gittensory", 10)).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/github/webhook.ts" })]));
    expect(await listPullRequestReviews(env, "JSONbored/gittensory", 10)).toEqual(expect.arrayContaining([expect.objectContaining({ reviewerLogin: "maintainer" })]));
    expect(await listCheckSummaries(env, "JSONbored/gittensory", 10)).toEqual(expect.arrayContaining([expect.objectContaining({ name: "test", conclusion: "success" })]));
    expect(await listRecentMergedPullRequests(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ number: 9, changedFiles: expect.arrayContaining(["src/github/webhook.ts"]) })]),
    );
    expect(await listContributorRepoStats(env, "oktofeesh1")).toMatchObject([{ mergedPullRequests: 1, pullRequests: 2 }]);
    expect(await listRepoSyncStates(env)).toMatchObject([{ repoFullName: "JSONbored/gittensory", status: "success", primaryLanguage: "TypeScript" }]);
    expect(authHeaders).toContain("Bearer public-token");
  });

  it("paginates past the first 100 labels in the monolithic backfill path", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 150 });
      if (url.endsWith("/repos/JSONbored/gittensory")) {
        return Response.json({ name: "gittensory", full_name: "JSONbored/gittensory", private: false, default_branch: "main", owner: { login: "JSONbored" } });
      }
      if (url.includes("/labels?")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        if (page === 1) {
          return Response.json(
            Array.from({ length: 100 }, (_, i) => ({ name: `label-p1-${i}`, color: "aaaaaa" })),
            { headers: { link: '<https://api.github.com/repositories/1/labels?page=2>; rel="next"' } },
          );
        }
        return Response.json(Array.from({ length: 50 }, (_, i) => ({ name: `label-p2-${i}`, color: "bbbbbb" })));
      }
      return Response.json([]);
    });

    await backfillRegisteredRepositories(env);

    const stored = await listRepoLabels(env, "JSONbored/gittensory");
    // 150 labels from GitHub (100 page-1 + 50 page-2) plus configured labels not present on GitHub
    expect(stored.length).toBeGreaterThanOrEqual(150);
    expect(stored.some((l) => l.name === "label-p1-0")).toBe(true);
    expect(stored.some((l) => l.name === "label-p2-0")).toBe(true);
  });

  it("refreshes contributor activity from GitHub search counts for registered repos", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    const authHeaders: Array<string | null> = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      authHeaders.push(new Headers(init?.headers).get("authorization"));
      const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
      expect(body.query).toContain("repo:JSONbored/gittensory author:jsonbored type:pr");
      return Response.json({
        data: {
          r_JSONbored_gittensory_all: {
            issueCount: 50,
            nodes: [{ __typename: "PullRequest", updatedAt: "2026-05-25T00:00:00Z", labels: { nodes: [{ name: "bug" }] }, body: "Fixes #1" }],
          },
          r_JSONbored_gittensory_merged: {
            issueCount: 47,
            nodes: [{ __typename: "PullRequest", mergedAt: "2026-05-24T00:00:00Z", labels: { nodes: [{ name: "bug" }] }, body: "Fixes #1" }],
          },
          r_JSONbored_gittensory_open: {
            issueCount: 3,
            nodes: [
              { __typename: "PullRequest", updatedAt: "2026-04-01T00:00:00Z", labels: { nodes: [{ name: "ci" }] }, body: "" },
              { __typename: "PullRequest", updatedAt: "2026-04-02T00:00:00Z", labels: { nodes: [{ name: "ci" }] }, body: "Fixes #2" },
              // REGRESSION: no `body` field at all (GitHub omits it, not just an empty string) -- exercises
              // the `node.body ?? ""` nullish fallback the unlinkedPullRequests count feeds into.
              { __typename: "PullRequest", updatedAt: "2026-04-03T00:00:00Z", labels: { nodes: [{ name: "ci" }] } },
            ],
          },
          r_JSONbored_gittensory_issues: {
            issueCount: 12,
            nodes: [{ __typename: "Issue", updatedAt: "2026-05-20T00:00:00Z", labels: { nodes: [{ name: "bug" }] }, body: "Report" }],
          },
        },
      });
    });

    const result = await refreshContributorActivity(env, "jsonbored");

    expect(result).toMatchObject({ repoCount: 1, updatedRepoStats: 1, warnings: [] });
    expect(authHeaders).toContain("Bearer public-token");
    expect(await listContributorRepoStats(env, "JSONbored")).toMatchObject([
      { repoFullName: "JSONbored/gittensory", pullRequests: 50, mergedPullRequests: 47, openPullRequests: 3, issues: 12, unlinkedPullRequests: 2 },
    ]);
  });

  it("skips contributor activity refresh without a public GitHub token", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env);
    const result = await refreshContributorActivity(env, "jsonbored");
    expect(result).toMatchObject({
      repoCount: 0,
      updatedRepoStats: 0,
      warnings: ["GITHUB_PUBLIC_TOKEN is not configured; contributor activity refresh was skipped."],
    });
  });

  it("records contributor activity refresh GraphQL errors without mutating stats", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async () => new Response("rate limited", { status: 403 }));

    const result = await refreshContributorActivity(env, "jsonbored");

    expect(result.updatedRepoStats).toBe(0);
    expect(result.warnings[0]).toContain("GitHub GraphQL failed (403)");
    expect(await listContributorRepoStats(env, "jsonbored")).toEqual([]);
  });

  it("records unknown contributor activity failures and deterministic dominant label ties", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls === 1) throw "network vanished";
      return Response.json({
        data: {
          r_JSONbored_gittensory_all: {
            issueCount: 2,
            nodes: [
              { __typename: "PullRequest", updatedAt: "bad-date", labels: { nodes: [{ name: "zeta" }] }, body: "" },
              { __typename: "PullRequest", updatedAt: "2026-05-24T00:00:00Z", labels: { nodes: [{ name: "alpha" }] }, body: "Fixes #1" },
            ],
          },
          r_JSONbored_gittensory_merged: { issueCount: 0, nodes: [] },
          r_JSONbored_gittensory_open: {
            issueCount: 2,
            nodes: [
              { __typename: "PullRequest", updatedAt: "bad-date", labels: { nodes: [{ name: "zeta" }] }, body: "" },
              { __typename: "PullRequest", updatedAt: "2026-05-23T00:00:00Z", labels: { nodes: [{ name: "alpha" }] }, body: "Fixes #1" },
            ],
          },
          r_JSONbored_gittensory_issues: {
            issueCount: 1,
            nodes: [{ __typename: "Issue", updatedAt: "2026-05-22T00:00:00Z", labels: { nodes: [null, { name: "alpha" }, { name: "zeta" }] }, body: "" }],
          },
        },
      });
    });

    const failed = await refreshContributorActivity(env, "jsonbored");
    const recovered = await refreshContributorActivity(env, "jsonbored");

    expect(failed).toMatchObject({ updatedRepoStats: 0, warnings: ["Contributor activity refresh failed for JSONbored/gittensory: unknown error"] });
    expect(recovered).toMatchObject({ updatedRepoStats: 1, warnings: [] });
    expect(await listContributorRepoStats(env, "jsonbored")).toEqual([
      expect.objectContaining({
        dominantLabels: ["alpha", "zeta"],
        lastActivityAt: "2026-05-24T00:00:00Z",
        unlinkedPullRequests: 1,
      }),
    ]);
  });

  it("does not double-count labels appearing in overlapping PR buckets (all/merged/open regression)", async () => {
    // Regression: allPullRequests, mergedPullRequests, and openPullRequests are overlapping views of
    // the same PR set. A label on a PR that appears in all three buckets was previously counted three
    // times, biasing dominantLabels toward labels on frequently-bucketed PRs over labels that only
    // appear once per PR but on many distinct PRs.
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    const sharedPrUrl = "https://github.com/JSONbored/gittensory/pull/10";
    vi.stubGlobal("fetch", async () =>
      Response.json({
        data: {
          // One PR with label "shared-label" appears in all three overlapping buckets.
          // Two distinct issue records each have label "issue-label" once.
          r_JSONbored_gittensory_all: {
            issueCount: 1,
            nodes: [{ __typename: "PullRequest", url: sharedPrUrl, updatedAt: "2026-05-24T00:00:00Z", labels: { nodes: [{ name: "shared-label" }] }, body: "" }],
          },
          r_JSONbored_gittensory_merged: {
            issueCount: 1,
            nodes: [{ __typename: "PullRequest", url: sharedPrUrl, updatedAt: "2026-05-24T00:00:00Z", labels: { nodes: [{ name: "shared-label" }] }, body: "" }],
          },
          r_JSONbored_gittensory_open: {
            issueCount: 1,
            nodes: [{ __typename: "PullRequest", url: sharedPrUrl, updatedAt: "2026-05-24T00:00:00Z", labels: { nodes: [{ name: "shared-label" }] }, body: "" }],
          },
          r_JSONbored_gittensory_issues: {
            issueCount: 2,
            nodes: [
              { __typename: "Issue", updatedAt: "2026-05-23T00:00:00Z", labels: { nodes: [{ name: "issue-label" }] }, body: "" },
              { __typename: "Issue", updatedAt: "2026-05-22T00:00:00Z", labels: { nodes: [{ name: "issue-label" }] }, body: "" },
            ],
          },
        },
      }),
    );

    await refreshContributorActivity(env, "jsonbored");
    const [stat] = await listContributorRepoStats(env, "jsonbored");

    // Without deduplication: shared-label count=3, issue-label count=2 → ["shared-label", "issue-label"]
    // With deduplication:    shared-label count=1, issue-label count=2 → ["issue-label", "shared-label"]
    expect(stat?.dominantLabels).toEqual(["issue-label", "shared-label"]);
  });

  it("carries GraphQL warnings and ignores repos with no contributor activity", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async () =>
      Response.json({
        errors: [{ message: "partial search warning" }, {}],
        data: {
          r_JSONbored_gittensory_all: { issueCount: 0, nodes: null },
          r_JSONbored_gittensory_merged: { issueCount: 0, nodes: null },
          r_JSONbored_gittensory_open: { issueCount: 0, nodes: null },
          r_JSONbored_gittensory_issues: { issueCount: 0, nodes: null },
        },
      }),
    );

    const result = await refreshContributorActivity(env, "jsonbored");

    expect(result).toMatchObject({ updatedRepoStats: 0, warnings: ["partial search warning"] });
    expect(await listContributorRepoStats(env, "jsonbored")).toEqual([]);
  });

  it("reports installation health from stored permissions and events", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedRegisteredRepo(env);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { checks: "write", metadata: "read" },
        events: ["pull_request"],
      },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/app/installations/123")) {
        return Response.json({
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: { checks: "write", metadata: "read" },
          events: ["pull_request"],
        });
      }
      if (url.endsWith("/app/installations/124")) {
        return Response.json({
          id: 124,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: { checks: "write", metadata: "read", pull_requests: "write", issues: "write" },
          events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await refreshInstallationHealth(env);
    expect(result.installations[0]).toMatchObject({
      status: "needs_attention",
      missingPermissions: ["pull_requests", "issues"],
      missingEvents: ["issues", "issue_comment", "repository"],
      repairSteps: expect.arrayContaining(["Update the GitHub App permissions and subscribed events."]),
    });

    await upsertInstallation(env, {
      installation: {
        id: 124,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { checks: "write", metadata: "read", pull_requests: "write", issues: "write" },
        events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
      },
    });
    const refreshed = await refreshInstallationHealth(env);
    expect(refreshed.installations).toEqual(expect.arrayContaining([expect.objectContaining({ installationId: 124, status: "healthy" })]));
    // The persisted authMode round-trips as "local" through the repository read path (getInstallationHealth),
    // not just the in-memory refresh result — the same mapper the broker-mode test below exercises for "broker".
    expect(await getInstallationHealth(env, 124)).toMatchObject({ authMode: "local" });
  });

  describe("installation health — Orb broker mode (#selfhost-runtime-drift)", () => {
    it("reports healthy with authMode 'broker' and no fabricated missing permissions when the token broker mints successfully", async () => {
      const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_test" }); // broker mode — no GITHUB_APP_PRIVATE_KEY
      await upsertInstallation(env, {
        installation: {
          id: 900,
          account: { login: "brokered-owner", id: 9, type: "User" },
          repository_selection: "selected",
        },
      });
      const calls: string[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        calls.push(url);
        if (url.endsWith("/v1/orb/token")) return Response.json({ token: "ghs_brokered", installationId: 900 });
        return new Response("not found", { status: 404 });
      });

      const result = await refreshInstallationHealth(env);

      expect(result.installations[0]).toMatchObject({
        status: "healthy",
        authMode: "broker",
        missingPermissions: [],
        missingEvents: [],
        errorSummary: undefined,
      });
      // Never takes the local App-JWT path (which would 404 here and throw "credentials not configured").
      expect(calls.some((url) => url.includes("/app/installations/"))).toBe(false);
      expect(await renderMetrics()).toContain('loopover_installation_health_broker_probe_total{result="ok"} 1');
      // The persisted authMode round-trips as "broker" through the repository read path (getInstallationHealth),
      // not just the in-memory refresh result — mirrors the "local" round-trip check above.
      expect(await getInstallationHealth(env, 900)).toMatchObject({ authMode: "broker" });
    });

    it("REGRESSION: broker-mode refresh replaces stale local permissions with the broker token permission snapshot", async () => {
      const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_test" });
      await upsertInstallation(env, {
        installation: {
          id: 912,
          account: { login: "brokered-owner", id: 9, type: "User" },
          repository_selection: "selected",
          permissions: { metadata: "read", pull_requests: "read", issues: "write", contents: "read" },
        },
      });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } }, 912);
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto" } });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith("/v1/orb/token")) {
          return Response.json({
            token: "ghs_brokered",
            installationId: 912,
            permissions: { metadata: "read", pull_requests: "read", issues: "write", contents: "write" },
          });
        }
        return new Response("not found", { status: 404 });
      });

      const result = await refreshInstallationHealth(env);

      expect(result.installations[0]).toMatchObject({
        status: "healthy",
        authMode: "broker",
        missingPermissions: [],
      });
      expect(await getInstallationHealth(env, 912)).toMatchObject({
        permissions: { metadata: "read", pull_requests: "read", issues: "write", contents: "write" },
        missingPermissions: [],
      });
    });

    it("REGRESSION (gate finding): never reports healthy when the broker mints a token for a DIFFERENT installation than the one being refreshed", async () => {
      const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_test" });
      // Two local rows exist (e.g. a stale row left over from a prior re-registration), but a brokered
      // self-host is bound to exactly ONE real installation — the broker always mints for that ONE install
      // regardless of which local row's refresh triggered the call.
      await upsertInstallation(env, {
        installation: { id: 910, account: { login: "brokered-owner", id: 9, type: "User" }, repository_selection: "selected" },
      });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith("/v1/orb/token")) return Response.json({ token: "ghs_brokered", installationId: 999 }); // NOT 910
        return new Response("not found", { status: 404 });
      });

      const result = await refreshInstallationHealth(env);

      expect(result.installations[0]?.status).toBe("needs_attention");
      expect(result.installations[0]?.authMode).toBe("broker");
      expect(result.installations[0]?.errorSummary).toMatch(/910/);
      expect(await renderMetrics()).toContain('loopover_installation_health_broker_probe_total{result="mismatched_installation"} 1');
    });

    it("REGRESSION (gate finding): a broker-mode refresh preserves the previously-persisted missingPermissions/missingEvents instead of fabricating a clean []", async () => {
      const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_test" });
      await upsertInstallation(env, {
        installation: { id: 911, account: { login: "brokered-owner", id: 9, type: "User" }, repository_selection: "selected" },
      });
      // A prior refresh (e.g. before this install switched into broker mode, or an earlier probe) left a
      // REAL, non-empty missing-permissions/events record — that's genuine last-known information, not a
      // fabricated broker-mode guess, so a later broker-mode refresh must not silently erase it back to [].
      await upsertInstallationHealth(env, {
        installationId: 911,
        accountLogin: "brokered-owner",
        repositorySelection: "selected",
        installedReposCount: 1,
        registeredInstalledCount: 1,
        status: "needs_attention",
        missingPermissions: ["pull_requests"],
        missingEvents: ["issues"],
        permissions: {},
        events: [],
        checkedAt: "2026-07-01T00:00:00.000Z",
        authMode: "local",
      });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith("/v1/orb/token")) return Response.json({ token: "ghs_brokered", installationId: 911 });
        return new Response("not found", { status: 404 });
      });

      const result = await refreshInstallationHealth(env);

      expect(result.installations[0]).toMatchObject({
        authMode: "broker",
        missingPermissions: ["pull_requests"],
        missingEvents: ["issues"],
      });
    });

    it("reports needs_attention with a broker-specific errorSummary (not the local App-key message) when the token broker fails to mint", async () => {
      const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_test" });
      await upsertInstallation(env, {
        installation: { id: 901, account: { login: "brokered-owner", id: 9, type: "User" }, repository_selection: "selected" },
      });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith("/v1/orb/token")) return new Response("broker down", { status: 500 });
        return new Response("not found", { status: 404 });
      });

      const result = await refreshInstallationHealth(env);

      expect(result.installations[0]?.status).toBe("needs_attention");
      expect(result.installations[0]?.authMode).toBe("broker");
      expect(result.installations[0]?.errorSummary).toMatch(/token/i);
      expect(result.installations[0]?.errorSummary).not.toMatch(/GitHub App credentials are not configured/);
      expect(await renderMetrics()).toContain('loopover_installation_health_broker_probe_total{result="failed"} 1');
    });

    it("enrichInstallationHealth's broker branch reports introspection-unavailable remediation, not fabricated grants or gaps", () => {
      const healthy = enrichInstallationHealth({
        installationId: 902,
        accountLogin: "brokered-owner",
        repositorySelection: "selected",
        installedReposCount: 1,
        registeredInstalledCount: 1,
        status: "healthy",
        missingPermissions: [],
        missingEvents: [],
        permissions: {},
        events: [],
        checkedAt: "2026-07-03T00:00:00.000Z",
        authMode: "broker",
      });
      // ok is false even on a HEALTHY broker: the broker minting tokens proves reachability, never that any
      // specific permission/event is actually granted -- there is no introspection API to confirm that today.
      expect(healthy.permissionRemediation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ permission: "pull_requests", currentAccess: "unavailable_in_broker_mode", ok: false }),
        ]),
      );
      expect(healthy.eventRemediation).toEqual(
        expect.arrayContaining([expect.objectContaining({ event: "issues", ok: false })]),
      );
      expect(healthy.repairSteps.join(" ")).toMatch(/token broker is reachable/i);

      const staleSnapshot = enrichInstallationHealth({
        installationId: 905,
        accountLogin: "brokered-owner",
        repositorySelection: "selected",
        installedReposCount: 1,
        registeredInstalledCount: 1,
        status: "needs_attention",
        missingPermissions: ["contents"],
        missingEvents: [],
        permissions: { metadata: "read", pull_requests: "read", issues: "write", contents: "read" },
        events: [],
        checkedAt: "2026-07-03T00:00:00.000Z",
        authMode: "broker",
      });
      expect(staleSnapshot.requiredPermissions).toMatchObject({ contents: "write" });
      expect(staleSnapshot.permissionRemediation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ permission: "contents", requiredAccess: "write", currentAccess: "read", ok: false }),
        ]),
      );

      const degraded = enrichInstallationHealth({
        installationId: 903,
        accountLogin: "brokered-owner",
        repositorySelection: "selected",
        installedReposCount: 1,
        registeredInstalledCount: 1,
        status: "needs_attention",
        missingPermissions: [],
        missingEvents: [],
        permissions: {},
        events: [],
        checkedAt: "2026-07-03T00:00:00.000Z",
        errorSummary: "Token broker did not mint an installation token: 500.",
        authMode: "broker",
      });
      expect(degraded.permissionRemediation.every((entry) => entry.ok === false)).toBe(true);
      expect(degraded.repairSteps.join(" ")).toContain("Token broker did not mint an installation token: 500.");

      // No errorSummary at all (e.g. the broker call itself never completed) — repairSteps still reads as a
      // plain sentence instead of dangling on a missing colon-suffix.
      const degradedNoSummary = enrichInstallationHealth({
        installationId: 904,
        accountLogin: "brokered-owner",
        repositorySelection: "selected",
        installedReposCount: 1,
        registeredInstalledCount: 1,
        status: "needs_attention",
        missingPermissions: [],
        missingEvents: [],
        permissions: {},
        events: [],
        checkedAt: "2026-07-03T00:00:00.000Z",
        authMode: "broker",
      });
      expect(degradedNoSummary.repairSteps.join(" ")).toContain("The token broker is unreachable or failing to mint installation tokens.");
    });
  });

  it("normalizes stale automatic installation repository event health", () => {
    const health = enrichInstallationHealth({
      installationId: 125,
      accountLogin: "JSONbored",
      repositorySelection: "selected",
      installedReposCount: 2,
      registeredInstalledCount: 2,
      status: "needs_attention",
      missingPermissions: [],
      missingEvents: ["installation_repositories"],
      permissions: { metadata: "read", pull_requests: "write", issues: "write" },
      events: ["issues", "issue_comment", "pull_request", "repository"],
      checkedAt: "2026-06-05T00:00:00.000Z",
      authMode: "local",
    });

    expect(health).toMatchObject({
      status: "healthy",
      missingEvents: [],
      optionalVisibleEvents: expect.arrayContaining(["installation_repositories"]),
    });
  });

  it("surfaces pull_requests:write in the remediation when it is the missing permission (#audit-install-health display)", () => {
    const health = enrichInstallationHealth({
      installationId: 126,
      accountLogin: "JSONbored",
      repositorySelection: "selected",
      installedReposCount: 1,
      registeredInstalledCount: 1,
      status: "needs_attention",
      missingPermissions: ["pull_requests"],
      missingEvents: [],
      permissions: { metadata: "read", pull_requests: "read", issues: "write" },
      events: ["issues", "issue_comment", "pull_request", "repository"],
      checkedAt: "2026-06-05T00:00:00.000Z",
      authMode: "local",
    });

    expect(health.requiredPermissions).toMatchObject({ pull_requests: "write" }); // not the baseline read
    expect(health.permissionRemediation).toEqual(
      expect.arrayContaining([expect.objectContaining({ permission: "pull_requests", requiredAccess: "write", ok: false, action: "Set repository permission pull_requests to write." })]),
    );
  });

  it("keeps baseline pull_requests:read remediation when the permission is absent (#audit-install-health least privilege)", () => {
    const health = enrichInstallationHealth({
      installationId: 127,
      accountLogin: "JSONbored",
      repositorySelection: "selected",
      installedReposCount: 1,
      registeredInstalledCount: 1,
      status: "needs_attention",
      missingPermissions: ["pull_requests"],
      missingEvents: [],
      permissions: { metadata: "read", issues: "write" },
      events: ["issues", "issue_comment", "pull_request", "repository"],
      checkedAt: "2026-06-05T00:00:00.000Z",
      authMode: "local",
    });

    expect(health.requiredPermissions).toMatchObject({ pull_requests: "read" });
    expect(health.permissionRemediation).toEqual(
      expect.arrayContaining([expect.objectContaining({ permission: "pull_requests", requiredAccess: "read", ok: false, action: "Set repository permission pull_requests to read." })]),
    );
  });

  it("requires Checks write only for repos with check runs enabled", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedRegisteredRepo(env);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
      },
    });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      checkRunMode: "enabled",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/app/installations/123")) {
        return Response.json({
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: { metadata: "read", pull_requests: "write", issues: "write" },
          events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const refreshed = await refreshInstallationHealth(env);

    expect(refreshed.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          installationId: 123,
          status: "needs_attention",
          missingPermissions: ["checks"],
          requiredPermissions: expect.objectContaining({ checks: "write" }),
        }),
      ]),
    );
  });

  it("REGRESSION (#5355): requires Checks write for a repo with only reviewCheckMode (the Orb Review Agent check) set, not checkRunMode", async () => {
    // Before the fix, requiresChecks only looked at checkRunMode ("LoopOver Context" check) and missed
    // the separate reviewCheckMode axis ("LoopOver Orb Review Agent" check) entirely -- so an installation
    // whose repos only ever published the review-agent check (true for JSONbored's own 3 production repos,
    // none of which set checkRunMode) was never flagged as needing the Checks permission.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedRegisteredRepo(env);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
      },
    });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      reviewCheckMode: "required", // checkRunMode left at its default ("off")
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/app/installations/123")) {
        return Response.json({
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: { metadata: "read", pull_requests: "write", issues: "write" },
          events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const refreshed = await refreshInstallationHealth(env);

    expect(refreshed.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          installationId: 123,
          status: "needs_attention", // was falsely "healthy" before the fix
          missingPermissions: ["checks"],
          requiredPermissions: expect.objectContaining({ checks: "write" }),
        }),
      ]),
    );
  });

  it("REGRESSION (#audit-install-health): an acting autonomy requires pull_requests:write, so read-only is needs_attention not healthy", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedRegisteredRepo(env);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "read", issues: "write" },
        events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
      },
    });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } }, 123);
    // close:auto ACTS on PR state → the App needs pull_requests:write, not the baseline read.
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/app/installations/123")) {
        return Response.json({
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: { metadata: "read", pull_requests: "read", issues: "write" }, // only READ granted
          events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const refreshed = await refreshInstallationHealth(env);

    expect(refreshed.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          installationId: 123,
          status: "needs_attention", // was falsely "healthy" before the fix
          missingPermissions: ["pull_requests"],
          requiredPermissions: expect.objectContaining({ pull_requests: "write" }),
        }),
      ]),
    );
  });

  it("REGRESSION: merge autonomy requires contents:write, so contents:read is needs_attention before merge 403s", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedRegisteredRepo(env);
    await upsertInstallation(env, {
      installation: {
        id: 125,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "read", issues: "write", contents: "read" },
        events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
      },
    });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } }, 125);
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/app/installations/125")) {
        return Response.json({
          id: 125,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: { metadata: "read", pull_requests: "read", issues: "write", contents: "read" },
          events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const refreshed = await refreshInstallationHealth(env);

    expect(refreshed.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          installationId: 125,
          status: "needs_attention",
          missingPermissions: ["contents"],
          requiredPermissions: expect.objectContaining({ pull_requests: "read", contents: "write" }),
        }),
      ]),
    );
  });

  it("marks comment, label, and check repair impacts disabled by repo settings", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
    });

    const repair = await buildInstallationRepairDiagnostics(env, {
      installationId: 123,
      accountLogin: "JSONbored",
      repositorySelection: "selected",
      installedReposCount: 1,
      registeredInstalledCount: 0,
      status: "healthy",
      missingPermissions: [],
      missingEvents: [],
      permissions: { metadata: "read", pull_requests: "read", issues: "write" },
      events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
      checkedAt: "2026-05-28T00:00:00.000Z",
      authMode: "local",
    });

    expect(repair.repairSteps).toEqual(["No repair needed."]);
    expect(repair.requiredPermissions).not.toHaveProperty("checks");
    expect(repair.requiredPermissions).not.toHaveProperty("contents");
    expect(repair.requiredPermissions.pull_requests).toBe("read"); // non-acting → baseline read, NOT upgraded to write
    expect(repair.modeImpacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mode: "comment", enabled: false, affectedRepoCount: 0, action: "No change needed." }),
        expect.objectContaining({ mode: "label", enabled: false, affectedRepoCount: 0, action: "No change needed." }),
        expect.objectContaining({ mode: "check_run", enabled: false, affectedRepoCount: 0, requiredPermissions: [expect.objectContaining({ optional: true })] }),
      ]),
    );
  });

  it("REGRESSION (#2912): repair diagnostics honor a .gittensory.yml-only checkRunMode: enabled override (DB row left at off)", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } }, 123);
    // DB row explicitly says checkRunMode: off; only the yml manifest turns it on, so this only passes if the
    // resolver (not the raw DB accessor) is consulted for the installed-repo settings scan.
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", checkRunMode: "off" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/.gittensory.yml")) return new Response("settings:\n  checkRunMode: enabled\n", { status: 200 });
      return new Response("Not Found", { status: 404 });
    });

    const repair = await buildInstallationRepairDiagnostics(env, {
      installationId: 123,
      accountLogin: "JSONbored",
      repositorySelection: "selected",
      installedReposCount: 1,
      registeredInstalledCount: 0,
      status: "healthy",
      missingPermissions: [],
      missingEvents: [],
      permissions: { metadata: "read", pull_requests: "read", issues: "write" },
      events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
      checkedAt: "2026-05-28T00:00:00.000Z",
      authMode: "local",
    });

    expect(repair.requiredPermissions).toHaveProperty("checks");
    expect(repair.modeImpacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ mode: "check_run", enabled: true, affectedRepoCount: 1 })]),
    );
  });

  it("repair diagnostics require contents:write for merge autonomy (#audit-install-health display)", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto" } });

    const repair = await buildInstallationRepairDiagnostics(env, {
      installationId: 123,
      accountLogin: "JSONbored",
      repositorySelection: "selected",
      installedReposCount: 1,
      registeredInstalledCount: 0,
      status: "needs_attention",
      missingPermissions: ["contents"],
      missingEvents: [],
      permissions: { metadata: "read", pull_requests: "read", issues: "write", contents: "read" },
      events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
      checkedAt: "2026-05-28T00:00:00.000Z",
      authMode: "local",
    });

    expect(repair.requiredPermissions.pull_requests).toBe("read");
    expect(repair.requiredPermissions.contents).toBe("write");
    expect(repair.modeImpacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mode: "agent_merge", enabled: true, requiredPermissions: [expect.objectContaining({ permission: "contents", missing: true })] }),
      ]),
    );
  });

  it("counts comment-only and label-only repair surfaces separately", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "comments", full_name: "JSONbored/comments", private: true, owner: { login: "JSONbored" } }, 124);
    await upsertRepositoryFromGitHub(env, { name: "labels", full_name: "JSONbored/labels", private: true, owner: { login: "JSONbored" } }, 124);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/comments",
      commentMode: "detected_contributors_only",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/labels",
      commentMode: "off",
      publicSurface: "label_only",
      autoLabelEnabled: true,
      checkRunMode: "off",
    });

    const repair = await buildInstallationRepairDiagnostics(env, {
      installationId: 124,
      accountLogin: "JSONbored",
      repositorySelection: "selected",
      installedReposCount: 2,
      registeredInstalledCount: 0,
      status: "needs_attention",
      missingPermissions: ["issues"],
      missingEvents: [],
      permissions: { metadata: "read", pull_requests: "read", issues: "read" },
      events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
      checkedAt: "2026-05-28T00:00:00.000Z",
      authMode: "local",
    });

    expect(repair.modeImpacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mode: "comment", enabled: true, affectedRepoCount: 1, requiredPermissions: [expect.objectContaining({ permission: "issues", missing: true })] }),
        expect.objectContaining({ mode: "label", enabled: true, affectedRepoCount: 1, requiredPermissions: [expect.objectContaining({ permission: "issues", missing: true })] }),
      ]),
    );
  });

  it("refreshes installation health from live GitHub App metadata", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedRegisteredRepo(env);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "unknown", id: 0, type: "unknown" },
        repository_selection: "selected",
        permissions: {},
        events: [],
      },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/app/installations/123")) {
        return Response.json({
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          target_type: "User",
          repository_selection: "selected",
          permissions: { checks: "write", metadata: "read", pull_requests: "write", issues: "write" },
          events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const refreshed = await refreshInstallationHealth(env);

    expect(refreshed.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          installationId: 123,
          accountLogin: "JSONbored",
          status: "healthy",
          missingPermissions: [],
          missingEvents: [],
        }),
      ]),
    );

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/app/installations/123")) {
        return Response.json({
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: { metadata: "read", pull_requests: "write", issues: "write" },
          events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const recovered = await refreshInstallationHealth(env);
    expect(recovered.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          installationId: 123,
          status: "healthy",
          missingPermissions: [],
        }),
      ]),
    );
  });

  it("surfaces installation metadata refresh failures in health diagnostics", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedRegisteredRepo(env);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "read", issues: "write" },
        events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
      },
    });
    vi.stubGlobal("fetch", async () => new Response("installation unavailable", { status: 503 }));

    const refreshed = await refreshInstallationHealth(env);

    expect(refreshed.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          installationId: 123,
          status: "needs_attention",
          errorSummary: expect.stringContaining("Failed to fetch GitHub App installation"),
        }),
      ]),
    );
  });

  it("skips repositories with backfill disabled", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSignalLevel: "standard",
      checkRunMode: "enabled",
      checkRunDetailLevel: "standard",
      backfillEnabled: false,
    });

    const result = await backfillRegisteredRepositories(env);

    expect(result.repos[0]).toMatchObject({ status: "skipped", warnings: ["Backfill is disabled for this repository."] });
  });

  it("REGRESSION (#2912): honors a .gittensory.yml-only backfillEnabled: false override (DB row left at its true default)", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env);
    // No upsertRepositorySettings call: the DB row stays at its default (backfillEnabled: true). Only the
    // yml manifest disables it, so this only passes if the resolver (not the raw DB accessor) is consulted.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/.gittensory.yml")) return new Response("settings:\n  backfillEnabled: false\n", { status: 200 });
      return new Response("Not Found", { status: 404 });
    });

    const result = await backfillRegisteredRepositories(env);

    expect(result.repos[0]).toMatchObject({ status: "skipped", warnings: ["Backfill is disabled for this repository."] });
  });

  it("skips public repo backfill without a service token and backs off fresh sync states", async () => {
    const missingTokenEnv = createTestEnv();
    await seedRegisteredRepo(missingTokenEnv);
    const missingToken = await backfillRegisteredRepositories(missingTokenEnv);
    expect(missingToken.repos[0]).toMatchObject({
      status: "skipped",
      warnings: [expect.stringContaining("GITHUB_PUBLIC_TOKEN")],
    });
    expect(await listRepoSyncStates(missingTokenEnv)).toMatchObject([{ repoFullName: "JSONbored/gittensory", status: "skipped" }]);

    const freshEnv = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(freshEnv);
    await upsertRepoSyncState(freshEnv, {
      repoFullName: "JSONbored/gittensory",
      status: "success",
      sourceKind: "github",
      openIssuesCount: 2,
      openPullRequestsCount: 1,
      recentMergedPullRequestsCount: 0,
      lastCompletedAt: new Date().toISOString(),
      warnings: [],
    });
    const fresh = await backfillRegisteredRepositories(freshEnv);
    expect(fresh.repos[0]).toMatchObject({ status: "skipped", openIssues: 2, warnings: [expect.stringContaining("Recent GitHub sync completed")] });

    await upsertRepoSyncState(freshEnv, {
      repoFullName: "JSONbored/gittensory",
      status: "error",
      sourceKind: "github",
      openIssuesCount: 0,
      openPullRequestsCount: 0,
      recentMergedPullRequestsCount: 0,
      lastCompletedAt: new Date().toISOString(),
      errorSummary: "rate limited",
      warnings: [],
    });
    const backedOff = await backfillRegisteredRepositories(freshEnv);
    expect(backedOff.repos[0]).toMatchObject({ status: "skipped", errorSummary: "rate limited", warnings: [expect.stringContaining("backing off")] });
  });

  it("records partial sync warnings from caps and GitHub detail failures", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/repos/JSONbored/gittensory")) {
        return Response.json({
          name: "gittensory",
          full_name: "JSONbored/gittensory",
          private: false,
          default_branch: "main",
          language: null,
          owner: { login: "JSONbored" },
        });
      }
      if (url.includes("/labels?")) return new Response("label failure", { status: 500 });
      // Genuine overflow: GitHub advertises a real next page (rel="next"), so fetching only `limit`
      // item(s) truncates the set and the segment is correctly capped with a live resume cursor.
      if (url.includes("/issues?")) {
        return Response.json([{ number: 1, title: "Open issue", state: "open", user: {}, labels: [{}], body: "body" }], {
          headers: { link: '<https://api.github.com/repositories/1/issues?page=2>; rel="next"' },
        });
      }
      if (url.includes("/pulls?state=open")) {
        return Response.json([{ number: 10, title: "No head sha PR", state: "open", user: {}, labels: [{}], body: "", head: { sha: "badsha" }, updated_at: "not-a-date" }], {
          headers: { link: '<https://api.github.com/repositories/1/pulls?page=2>; rel="next"' },
        });
      }
      if (url.includes("/pulls?state=closed")) {
        return Response.json([
          { number: 9, title: "Merged PR", state: "closed", merged_at: "2026-05-22T00:00:00.000Z", user: {}, labels: [{}], body: "" },
        ]);
      }
      if (url.includes("/pulls/")) return new Response("detail failure", { status: 503 });
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRegisteredRepositories(env, { limits: { issues: 1, pullRequests: 1, recentMergedPullRequests: 1, pullRequestDetails: 1 } });

    expect(result.repos[0]?.status).toBe("capped");
    expect(result.repos[0]?.dataQuality).toMatchObject({ capped: true, partial: true });
    expect(result.repos[0]?.warnings.join("\n")).toMatch(/Label sync failed|local cap|File sync failed|Review sync failed/);
    expect(await listRepoSyncStates(env)).toMatchObject([{ status: "capped", openIssuesCount: 1, openPullRequestsCount: 1 }]);
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ segment: "open_issues", status: "capped", nextCursor: expect.any(String) }),
        expect.objectContaining({ segment: "open_pull_requests", status: "capped", nextCursor: expect.any(String) }),
        expect.objectContaining({ segment: "labels", status: "partial" }),
      ]),
    );
  });

  it("reports a repo with exactly the page limit and no next page as complete, not capped", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/repos/JSONbored/gittensory")) {
        return Response.json({
          name: "gittensory",
          full_name: "JSONbored/gittensory",
          private: false,
          default_branch: "main",
          language: null,
          owner: { login: "JSONbored" },
        });
      }
      if (url.includes("/labels?")) return Response.json([]);
      // Exactly `limit` item(s) returned in a full final page with NO rel="next" link: the entire set
      // was fetched, so the segment must stay "complete" without a fabricated resume cursor.
      if (url.includes("/issues?")) {
        return Response.json([{ number: 1, title: "Only open issue", state: "open", user: { login: "reporter" }, labels: [], body: "" }]);
      }
      if (url.includes("/pulls?state=open")) {
        return Response.json([{ number: 2, title: "Only open PR", state: "open", user: { login: "reporter" }, labels: [], body: "", head: { sha: "sha2" }, updated_at: "2026-05-22T00:00:00.000Z" }]);
      }
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRegisteredRepositories(env, { limits: { issues: 1, pullRequests: 1, recentMergedPullRequests: 0, pullRequestDetails: 0 } });

    expect(result.repos[0]?.status).toBe("success");
    expect(result.repos[0]?.dataQuality).toMatchObject({ capped: false, partial: false });
    expect(result.repos[0]?.warnings).toEqual([]);
    expect(await listRepoSyncStates(env)).toMatchObject([{ status: "success", openIssuesCount: 1, openPullRequestsCount: 1 }]);
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ segment: "open_issues", status: "complete", nextCursor: null }),
        expect.objectContaining({ segment: "open_pull_requests", status: "complete", nextCursor: null }),
      ]),
    );
  });

  it("uses installation tokens when available and records hard sync errors", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedRegisteredRepo(env);
    await upsertRepositoryFromGitHub(
      env,
      {
        name: "gittensory",
        full_name: "JSONbored/gittensory",
        private: true,
        default_branch: "main",
        owner: { login: "JSONbored" },
      },
      123,
    );
    const authHeaders: Array<string | null> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      authHeaders.push(new Headers(init?.headers).get("authorization"));
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/repos/JSONbored/gittensory")) {
        return Response.json({
          name: "gittensory",
          full_name: "JSONbored/gittensory",
          private: true,
          default_branch: "main",
          language: "TypeScript",
          owner: { login: "JSONbored" },
        });
      }
      if (url.includes("/labels?") || url.includes("/issues?") || url.includes("/pulls?")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });

    const installed = await backfillRegisteredRepositories(env);
    expect(installed.repos[0]).toMatchObject({ status: "success" });
    expect(authHeaders).toContain("Bearer installation-token");

    vi.stubGlobal("fetch", async () => new Response("repo missing", { status: 404 }));
    const failed = await backfillRegisteredRepositories(env, { repoFullName: "JSONbored/gittensory", force: true });
    expect(failed.repos[0]).toMatchObject({ status: "error", errorSummary: expect.stringContaining("GitHub API failed") });
  });

  it("falls back to unauthenticated REST when the public token receives a scoped 404", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await upsertRepositoryFromGitHub(env, {
      name: "gittensory",
      full_name: "JSONbored/gittensory",
      private: false,
      default_branch: "main",
      owner: { login: "JSONbored" },
    });
    const labelAuthHeaders: Array<string | null> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const auth = new Headers(init?.headers).get("authorization");
      if (url === "https://api.github.com/graphql") {
        return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 1 });
      }
      if (url.includes("/labels?")) {
        labelAuthHeaders.push(auth);
        if (auth === "Bearer public-token") return new Response("", { status: 404 });
        return Response.json([{ name: "signal", color: "00ff00", description: "Signal" }]);
      }
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "full" });

    expect(result).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
    expect(labelAuthHeaders).toEqual(["Bearer public-token", null]);
    expect(await listRepoLabels(env, "JSONbored/gittensory")).toEqual([expect.objectContaining({ name: "signal" })]);
  });

  it("hydrates merged PR changed files in the recent-merged segment backfill", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 1, closedPullRequests: 1, labels: 0 });
      }
      if (url.includes("/pulls?state=closed")) {
        return Response.json([
          { number: 9, title: "Fix webhook processing", state: "closed", merged_at: "2026-05-22T00:00:00.000Z", user: { login: "oktofeesh1" }, labels: [{ name: "bug" }], body: "Fixes #1" },
        ]);
      }
      if (url.includes("/pulls/9/files")) {
        return Response.json([{ filename: "src/github/webhook.ts", status: "modified", additions: 12, deletions: 3, changes: 15 }]);
      }
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "recent_merged_pull_requests", mode: "full" });

    expect(result).toMatchObject({ status: "complete" });
    // The segment path must hydrate changed files like the monolithic path (previously stored []).
    expect(await listRecentMergedPullRequests(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ number: 9, changedFiles: expect.arrayContaining(["src/github/webhook.ts"]) })]),
    );
  });

  it("skips the /files fetch for a merged PR whose changed files are already stored (#1941)", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    // PR 9 was hydrated with files by a prior sync; a merged PR is immutable, so its files can never change.
    await upsertRecentMergedPullRequest(env, {
      repoFullName: "JSONbored/gittensory",
      number: 9,
      title: "Fix webhook",
      authorLogin: "oktofeesh1",
      mergedAt: "2026-05-22T00:00:00.000Z",
      labels: ["bug"],
      linkedIssues: [1],
      changedFiles: ["src/github/webhook.ts"],
      payload: {},
    });
    let fileFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 1, closedPullRequests: 1, labels: 0 });
      if (url.includes("/pulls?state=closed")) {
        return Response.json([{ number: 9, title: "Fix webhook processing (edited)", state: "closed", merged_at: "2026-05-22T00:00:00.000Z", user: { login: "oktofeesh1" }, labels: [{ name: "bug" }], body: "Fixes #1" }]);
      }
      if (url.includes("/pulls/9/files")) {
        fileFetches += 1;
        return Response.json([{ filename: "src/github/webhook.ts", status: "modified", additions: 12, deletions: 3, changes: 15 }]);
      }
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "recent_merged_pull_requests", mode: "full" });

    expect(result).toMatchObject({ status: "complete" });
    expect(fileFetches).toBe(0); // already hydrated → the per-PR /files fetch (the N+1) is skipped
    // The cheap metadata is still refreshed (title updated) and the stored files are preserved.
    expect(await listRecentMergedPullRequests(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ number: 9, title: "Fix webhook processing (edited)", changedFiles: ["src/github/webhook.ts"] })]),
    );
  });

  it("preserves previously-hydrated merged PR files when a later upsert has none", async () => {
    const env = createTestEnv();
    await upsertRecentMergedPullRequest(env, {
      repoFullName: "JSONbored/gittensory",
      number: 9,
      title: "Fix webhook",
      authorLogin: "dev",
      mergedAt: "2026-05-22T00:00:00.000Z",
      labels: ["bug"],
      linkedIssues: [1],
      changedFiles: ["src/a.ts", "src/b.ts"],
      payload: {},
    });
    // A later files-less upsert (e.g. a failed file fetch) must not erase the stored files.
    await upsertRecentMergedPullRequest(env, {
      repoFullName: "JSONbored/gittensory",
      number: 9,
      title: "Fix webhook (reconciled)",
      authorLogin: "dev",
      mergedAt: "2026-05-22T00:00:00.000Z",
      labels: ["bug"],
      linkedIssues: [1],
      changedFiles: [],
      payload: {},
    });
    expect(await listRecentMergedPullRequests(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ number: 9, title: "Fix webhook (reconciled)", changedFiles: ["src/a.ts", "src/b.ts"] })]),
    );
    // A later upsert that does carry files updates the stored list.
    await upsertRecentMergedPullRequest(env, {
      repoFullName: "JSONbored/gittensory",
      number: 9,
      title: "Fix webhook",
      authorLogin: "dev",
      mergedAt: "2026-05-22T00:00:00.000Z",
      labels: ["bug"],
      linkedIssues: [1],
      changedFiles: ["src/c.ts"],
      payload: {},
    });
    expect(await listRecentMergedPullRequests(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ number: 9, changedFiles: ["src/c.ts"] })]),
    );
  });

  it("does not let unauthenticated fallback rate limits poison the authenticated REST backoff", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await upsertRepositoryFromGitHub(env, {
      name: "gittensory",
      full_name: "JSONbored/gittensory",
      private: false,
      default_branch: "main",
      owner: { login: "JSONbored" },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const auth = new Headers(init?.headers).get("authorization");
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 1 });
      if (url.includes("/labels?") && auth === "Bearer public-token") return new Response("", { status: 404 });
      if (url.includes("/labels?")) return new Response("limited", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1779976046" } });
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "full" });

    expect(result).toMatchObject({ status: "waiting_rate_limit", fetchedCount: 0 });
    expect(await listLatestGitHubRateLimitObservations(env)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: expect.stringContaining("/labels?"), statusCode: 403, remaining: 0 })]),
    );
  });

  it("keeps successful unauthenticated fallback responses out of the shared REST backoff", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await upsertRepositoryFromGitHub(env, {
      name: "gittensory",
      full_name: "JSONbored/gittensory",
      private: false,
      default_branch: "main",
      owner: { login: "JSONbored" },
    });
    const fallbackAuthHeaders: Array<string | null> = [];
    let openIssueFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const auth = new Headers(init?.headers).get("authorization");
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 1 });
      if (url.includes("/labels?") && auth === "Bearer public-token") return new Response("", { status: 404 });
      if (url.includes("/labels?")) {
        fallbackAuthHeaders.push(auth);
        return Response.json([{ name: "bug", color: "cc0000", description: "Bug" }], {
          headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "59", "x-ratelimit-reset": "1779976046" },
        });
      }
      if (url.includes("/issues?")) {
        openIssueFetches += 1;
        expect(auth).toBe("Bearer public-token");
        return Response.json([]);
      }
      return new Response("not found", { status: 404 });
    });

    const labelsResult = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "full" });
    const openIssuesResult = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_issues", mode: "light" });

    expect(labelsResult).toMatchObject({ status: "complete", fetchedCount: 1 });
    expect(fallbackAuthHeaders).toEqual([null]);
    expect(openIssuesResult).toMatchObject({ status: "complete", fetchedCount: 0 });
    expect(openIssueFetches).toBe(1);
    expect(await listLatestGitHubRateLimitObservations(env)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: expect.stringContaining("/labels?"), statusCode: 200, limitValue: 60, remaining: 59 })]),
    );
  });

  it("rolls an unfinished recent-merged crawl into the repo sync status instead of success", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const auth = new Headers(init?.headers).get("authorization");
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 1, closedPullRequests: 1, labels: 0 });
      if (url.includes("/pulls?state=closed") && auth === "Bearer public-token") return new Response("", { status: 404 });
      if (url.includes("/pulls?state=closed")) return new Response("limited", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1779976046" } });
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "recent_merged_pull_requests", mode: "full" });

    expect(result).toMatchObject({ status: "waiting_rate_limit" });
    // The repo status must reflect the unfinished merged-history segment, not roll up to "success".
    expect(await listRepoSyncStates(env)).toEqual(
      expect.arrayContaining([expect.objectContaining({ repoFullName: "JSONbored/gittensory", status: "rate_limited" })]),
    );
  });

  it("paginates beyond the first GitHub page and stores complete segment fidelity", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/repos/JSONbored/gittensory")) {
        return Response.json({
          name: "gittensory",
          full_name: "JSONbored/gittensory",
          private: false,
          default_branch: "main",
          language: "TypeScript",
          owner: { login: "JSONbored" },
        });
      }
      if (url.includes("/labels?")) return Response.json([]);
      if (url.includes("/issues?") && new URL(url).searchParams.get("page") === "1") {
        return Response.json(
          Array.from({ length: 100 }, (_, index) => ({ number: index + 1, title: `Issue ${index + 1}`, state: "open", user: { login: "reporter" }, labels: [], body: "" })),
          { headers: { link: '<https://api.github.com/repositories/1/issues?page=2>; rel="next"' } },
        );
      }
      if (url.includes("/issues?") && url.includes("page=2")) {
        return Response.json([{ number: 101, title: "Issue 101", state: "open", user: { login: "reporter" }, labels: [], body: "" }]);
      }
      if (url.includes("/pulls?")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRegisteredRepositories(env, {
      mode: "full",
      limits: { issues: 150, pullRequests: 0, recentMergedPullRequests: 0, pullRequestDetails: 0 },
    });

    expect(result.repos[0]).toMatchObject({ status: "success", openIssues: 101 });
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ segment: "open_issues", status: "complete", fetchedCount: 101, pageCount: 2 })]),
    );
  });

  // A fetch mock that models GitHub's real pagination: `page` is an offset of `(page-1)*per_page`, and each
  // page returns at most `per_page` items. If a crawl shrinks per_page mid-way, `page` points at an
  // already-consumed slice; a stable per_page reads the next slice.
  function issuesOffsetFetch(total: number) {
    return async (input: RequestInfo | URL): Promise<Response> => {
      const url = input.toString();
      if (url.endsWith("/repos/JSONbored/gittensory")) {
        return Response.json({ name: "gittensory", full_name: "JSONbored/gittensory", private: false, default_branch: "main", language: "TypeScript", owner: { login: "JSONbored" } });
      }
      if (url.includes("/labels?")) return Response.json([]);
      if (url.includes("/pulls?")) return Response.json([]);
      if (url.includes("/issues?")) {
        const params = new URL(url).searchParams;
        const perPage = Number(params.get("per_page"));
        const page = Number(params.get("page"));
        const start = (page - 1) * perPage;
        const slice = Array.from({ length: Math.max(0, Math.min(start + perPage, total) - start) }, (_, i) => ({
          number: start + i + 1,
          title: `Issue ${start + i + 1}`,
          state: "open",
          user: { login: "reporter" },
          labels: [],
          body: "",
        }));
        const hasNext = start + perPage < total;
        return Response.json(slice, hasNext ? { headers: { link: `<https://api.github.com/repositories/1/issues?page=${page + 1}>; rel="next"` } } : undefined);
      }
      return new Response("not found", { status: 404 });
    };
  }

  it("fetches every page when the limit is not a multiple of 100 (stable per_page offsets)", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", issuesOffsetFetch(150));

    const result = await backfillRegisteredRepositories(env, {
      mode: "full",
      limits: { issues: 150, pullRequests: 0, recentMergedPullRequests: 0, pullRequestDetails: 0 },
    });

    // All 150 unique issues must be stored — a shrinking-per_page crawl re-reads page 1's tail and stores 100.
    expect(result.repos[0]).toMatchObject({ status: "success", openIssues: 150 });
  });

  it("advances the resume cursor for a sub-100 cap instead of replaying the first page", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", issuesOffsetFetch(5));

    // Cap at 2 (< 100) against a repo with 5 issues. The segment must resume from the NEXT page (cursor "2"),
    // not the page it just consumed (cursor "1") — a same-page cursor would replay issues 1-2 forever and
    // never reach 3-5. With per_page held at min(100, limit)=2, page 2 is offset 2 → the unread rows.
    const result = await backfillRegisteredRepositories(env, {
      mode: "full",
      limits: { issues: 2, pullRequests: 0, recentMergedPullRequests: 0, pullRequestDetails: 0 },
    });

    expect(result.repos[0]).toMatchObject({ openIssues: 2 });
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ segment: "open_issues", status: "capped", nextCursor: "2" })]),
    );
  });

  it("consumes a whole final page instead of saving a same-page resume cursor", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", issuesOffsetFetch(200));

    // Cap at 150 against a repo with 200 issues: page 1 (per_page=100) yields 1-100, page 2 yields 101-200.
    // Because the cursor has only page precision, page 2 must be consumed atomically; saving cursor "2" after
    // only 50 entries would replay issues 101-150 on resume and inflate the persisted fetched count.
    const result = await backfillRegisteredRepositories(env, {
      mode: "full",
      limits: { issues: 150, pullRequests: 0, recentMergedPullRequests: 0, pullRequestDetails: 0 },
    });

    expect(result.repos[0]).toMatchObject({ openIssues: 200 });
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ segment: "open_issues", status: "complete", fetchedCount: 200, nextCursor: null })]),
    );
  });

  it("advances to the next page when a whole-page cap still has more results", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", issuesOffsetFetch(250));

    const result = await backfillRegisteredRepositories(env, {
      mode: "full",
      limits: { issues: 150, pullRequests: 0, recentMergedPullRequests: 0, pullRequestDetails: 0 },
    });

    expect(result.repos[0]).toMatchObject({ openIssues: 200 });
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ segment: "open_issues", status: "capped", fetchedCount: 200, nextCursor: "3" })]),
    );
  });

  it("REGRESSION: resuming from a whole-page cap fetches exactly the remaining items, never replaying an already-consumed page", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", issuesOffsetFetch(250));

    // First pass caps mid-crawl at cursor "3" (see the previous test) having consumed pages 1-2 (issues 1-200).
    const first = await backfillRegisteredRepositories(env, {
      mode: "full",
      limits: { issues: 150, pullRequests: 0, recentMergedPullRequests: 0, pullRequestDetails: 0 },
    });
    expect(first.repos[0]).toMatchObject({ openIssues: 200 });

    // Resume: the old (buggy) code saved a SAME-page cursor on a truncated final page, so a resume would
    // re-fetch that same page and re-count its already-stored prefix, inflating fetchedCount past the true
    // total. The fix consumes pages atomically and only advances the cursor to the NEXT page, so resuming
    // must fetch exactly the 50 remaining issues (201-250) and land on the true total with no overcount.
    const second = await backfillRegisteredRepositories(env, {
      mode: "resume",
      force: true,
      limits: { issues: 100, pullRequests: 0, recentMergedPullRequests: 0, pullRequestDetails: 0 },
    });

    expect(second.repos[0]).toMatchObject({ openIssues: 250 });
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ segment: "open_issues", status: "complete", fetchedCount: 250, nextCursor: null })]),
    );
  });

  it("runs a targeted labels segment refresh", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/graphql")) {
        return Response.json({
          data: {
            repository: {
              issues: { totalCount: 0 },
              openPullRequests: { totalCount: 0 },
              mergedPullRequests: { totalCount: 0 },
              closedPullRequests: { totalCount: 0 },
              labels: { totalCount: 1 },
            },
          },
        });
      }
      if (url.includes("/labels?")) return Response.json([{ name: "bug", color: "cc0000", description: "Bug" }]);
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "resume", force: true });

    expect(result).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
    expect(await listRepoLabels(env, "JSONbored/gittensory")).toEqual(expect.arrayContaining([expect.objectContaining({ name: "bug" })]));
  });

  it("validates unchanged single-page label segments with conditional REST requests", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    const labelHeaders: Array<{ ifNoneMatch: string | null; ifModifiedSince: string | null }> = [];
    let labelFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 1 });
      if (url.includes("/labels?")) {
        const headers = new Headers(init?.headers);
        labelHeaders.push({ ifNoneMatch: headers.get("if-none-match"), ifModifiedSince: headers.get("if-modified-since") });
        labelFetches += 1;
        if (labelFetches === 1) {
          return Response.json([{ name: "bug", color: "cc0000", description: "Bug" }], {
            headers: { etag: '"labels-v1"', "last-modified": "Tue, 26 May 2026 00:00:00 GMT" },
          });
        }
        if (labelFetches === 2) {
          return new Response(null, { status: 304, headers: { etag: '"labels-v1"', "last-modified": "Tue, 26 May 2026 00:00:00 GMT" } });
        }
        return Response.json([{ name: "bug", color: "00cc00", description: "Bug" }], {
          headers: { etag: '"labels-v2"', "last-modified": "Tue, 26 May 2026 00:05:00 GMT" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const first = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "resume", force: true });
    const second = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "resume", force: true });
    const third = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "resume", force: true });

    expect(first).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
    expect(second).toMatchObject({ status: "not_modified", fetchedCount: 1, expectedCount: 1 });
    expect(third).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
    expect(labelHeaders).toEqual([
      { ifNoneMatch: null, ifModifiedSince: null },
      { ifNoneMatch: '"labels-v1"', ifModifiedSince: "Tue, 26 May 2026 00:00:00 GMT" },
      { ifNoneMatch: '"labels-v1"', ifModifiedSince: "Tue, 26 May 2026 00:00:00 GMT" },
    ]);
    expect(await listRepoLabels(env, "JSONbored/gittensory")).toEqual(expect.arrayContaining([expect.objectContaining({ name: "bug", color: "00cc00" })]));
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          segment: "labels",
          status: "complete",
          fetchedCount: 1,
          pageCount: 1,
          lastCursor: "1",
          etag: '"labels-v2"',
          lastModified: "Tue, 26 May 2026 00:05:00 GMT",
        }),
      ]),
    );
    expect(await listRepoSyncStates(env)).toEqual(
      expect.arrayContaining([expect.objectContaining({ repoFullName: "JSONbored/gittensory", status: "success", labelsSyncedAt: expect.any(String) })]),
    );
  });

  it("validates unchanged single-page segments on the scheduled light cadence, not just resume (#1942)", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    const labelHeaders: Array<{ ifNoneMatch: string | null; ifModifiedSince: string | null }> = [];
    let labelFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 1 });
      if (url.includes("/labels?")) {
        const headers = new Headers(init?.headers);
        labelHeaders.push({ ifNoneMatch: headers.get("if-none-match"), ifModifiedSince: headers.get("if-modified-since") });
        labelFetches += 1;
        if (labelFetches === 1) {
          return Response.json([{ name: "bug", color: "cc0000", description: "Bug" }], {
            headers: { etag: '"labels-v1"', "last-modified": "Tue, 26 May 2026 00:00:00 GMT" },
          });
        }
        return new Response(null, { status: 304, headers: { etag: '"labels-v1"', "last-modified": "Tue, 26 May 2026 00:00:00 GMT" } });
      }
      return new Response("not found", { status: 404 });
    });

    const first = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "light", force: true });
    const second = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "light", force: true });

    expect(first).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
    // Before the fix, a light crawl loaded no prior segment, so the second pass sent no validators and re-listed in
    // full ("complete"). The scheduled cadence now sends If-None-Match, and a 304 short-circuits to not_modified.
    expect(second).toMatchObject({ status: "not_modified", fetchedCount: 1, expectedCount: 1 });
    expect(labelHeaders).toEqual([
      { ifNoneMatch: null, ifModifiedSince: null },
      { ifNoneMatch: '"labels-v1"', ifModifiedSince: "Tue, 26 May 2026 00:00:00 GMT" },
    ]);
  });

  it("preserves stored validators when an unauthenticated fallback returns not modified without validators", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertRepoLabel(env, {
      repoFullName: "JSONbored/gittensory",
      name: "bug",
      color: "cc0000",
      description: "Bug",
      isConfigured: true,
      observedCount: 0,
      payload: {},
      lastSeenAt: "2026-05-26T00:00:00.000Z",
    });
    await upsertRepoSyncSegment(env, {
      repoFullName: "JSONbored/gittensory",
      segment: "labels",
      status: "complete",
      sourceKind: "github",
      mode: "resume",
      fetchedCount: 1,
      expectedCount: 1,
      pageCount: 1,
      lastCursor: "1",
      etag: '"labels-v1"',
      lastModified: "Tue, 26 May 2026 00:00:00 GMT",
      warnings: [],
    });
    const labelRequests: Array<{ auth: string | null; ifNoneMatch: string | null; ifModifiedSince: string | null }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const headers = new Headers(init?.headers);
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 1 });
      if (url.includes("/labels?")) {
        labelRequests.push({
          auth: headers.get("authorization"),
          ifNoneMatch: headers.get("if-none-match"),
          ifModifiedSince: headers.get("if-modified-since"),
        });
        if (headers.get("authorization") === "Bearer public-token") return new Response("", { status: 404 });
        return new Response(null, { status: 304 });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "resume", force: true });

    expect(result).toMatchObject({ status: "not_modified", fetchedCount: 1, expectedCount: 1 });
    expect(labelRequests).toEqual([
      { auth: "Bearer public-token", ifNoneMatch: '"labels-v1"', ifModifiedSince: "Tue, 26 May 2026 00:00:00 GMT" },
      { auth: null, ifNoneMatch: '"labels-v1"', ifModifiedSince: "Tue, 26 May 2026 00:00:00 GMT" },
    ]);
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          segment: "labels",
          status: "not_modified",
          etag: '"labels-v1"',
          lastModified: "Tue, 26 May 2026 00:00:00 GMT",
        }),
      ]),
    );
  });

  it("uses last-modified validators for unchanged current open PR scans while preserving the resume marker", async () => {
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(env);
    const prHeaders: Array<{ ifNoneMatch: string | null; ifModifiedSince: string | null }> = [];
    let prFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 0, openPullRequests: 1, mergedPullRequests: 0, closedPullRequests: 0, labels: 0 });
      if (url.includes("/pulls?state=open")) {
        const headers = new Headers(init?.headers);
        prHeaders.push({ ifNoneMatch: headers.get("if-none-match"), ifModifiedSince: headers.get("if-modified-since") });
        prFetches += 1;
        if (prFetches === 1) {
          return Response.json(
            [{ number: 7, title: "Current PR", state: "open", user: { login: "oktofeesh1" }, head: { sha: "sha7" }, labels: [], body: "" }],
            { headers: { etag: '"open-prs-v1"', "last-modified": "Tue, 26 May 2026 01:00:00 GMT" } },
          );
        }
        return new Response(null, { status: 304, headers: { "last-modified": "Tue, 26 May 2026 01:00:00 GMT" } });
      }
      return Response.json([]);
    });

    const first = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_pull_requests", mode: "resume", force: true });
    const second = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_pull_requests", mode: "resume", force: true });

    expect(first).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
    expect(second).toMatchObject({ status: "not_modified", fetchedCount: 1, expectedCount: 1 });
    expect(prHeaders).toEqual([
      { ifNoneMatch: null, ifModifiedSince: null },
      { ifNoneMatch: null, ifModifiedSince: "Tue, 26 May 2026 01:00:00 GMT" },
    ]);
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          segment: "open_pull_requests",
          status: "not_modified",
          etag: "gittensory-current-open-scan-v1",
          lastModified: "Tue, 26 May 2026 01:00:00 GMT",
        }),
      ]),
    );
    expect(sent.filter((item) => item.message.type === "backfill-pr-details")).toHaveLength(2);
  });

  it("bypasses conditional validators when segment totals change", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertRepoSyncSegment(env, {
      repoFullName: "JSONbored/gittensory",
      segment: "labels",
      status: "complete",
      sourceKind: "github",
      mode: "resume",
      fetchedCount: 1,
      expectedCount: 1,
      pageCount: 1,
      lastCursor: "1",
      etag: '"labels-v1"',
      lastModified: "Tue, 26 May 2026 00:00:00 GMT",
      warnings: [],
    });
    const labelHeaders: Array<{ ifNoneMatch: string | null; ifModifiedSince: string | null }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 2 });
      if (url.includes("/labels?")) {
        const headers = new Headers(init?.headers);
        labelHeaders.push({ ifNoneMatch: headers.get("if-none-match"), ifModifiedSince: headers.get("if-modified-since") });
        return Response.json([
          { name: "bug", color: "cc0000", description: "Bug" },
          { name: "feature", color: "00cc00", description: "Feature" },
        ]);
      }
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "resume", force: true });

    expect(result).toMatchObject({ status: "complete", fetchedCount: 2, expectedCount: 2 });
    expect(labelHeaders).toEqual([{ ifNoneMatch: null, ifModifiedSince: null }]);
  });

  it("bypasses conditional validators for prior segment rows that are not a complete single page", async () => {
    for (const previous of [
      { lastCursor: "2", nextCursor: undefined },
      { lastCursor: "1", nextCursor: "2" },
    ]) {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      await seedRegisteredRepo(env);
      await upsertRepoSyncSegment(env, {
        repoFullName: "JSONbored/gittensory",
        segment: "labels",
        status: "complete",
        sourceKind: "github",
        mode: "resume",
        fetchedCount: 2,
        expectedCount: 2,
        pageCount: 2,
        lastCursor: previous.lastCursor,
        nextCursor: previous.nextCursor,
        etag: '"labels-v1"',
        lastModified: "Tue, 26 May 2026 00:00:00 GMT",
        warnings: [],
      });
      const labelHeaders: Array<{ ifNoneMatch: string | null; ifModifiedSince: string | null }> = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 2 });
        if (url.includes("/labels?")) {
          const headers = new Headers(init?.headers);
          labelHeaders.push({ ifNoneMatch: headers.get("if-none-match"), ifModifiedSince: headers.get("if-modified-since") });
          return Response.json([
            { name: "bug", color: "cc0000", description: "Bug" },
            { name: "feature", color: "00cc00", description: "Feature" },
          ]);
        }
        return new Response("not found", { status: 404 });
      });

      const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "resume", force: true });

      expect(result).toMatchObject({ status: "complete", fetchedCount: 2, expectedCount: 2 });
      expect(labelHeaders).toEqual([{ ifNoneMatch: null, ifModifiedSince: null }]);
      vi.unstubAllGlobals();
    }
  });

  it("resumes paginated segments from stored cursors instead of restarting from page one", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertRepoSyncSegment(env, {
      repoFullName: "JSONbored/gittensory",
      segment: "open_issues",
      status: "capped",
      sourceKind: "github",
      mode: "full",
      nextCursor: "3",
      fetchedCount: 200,
      pageCount: 2,
      completedAt: "2026-05-24T00:00:00.000Z",
      warnings: ["previous cap"],
    });
    const requestedIssuePages: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/repos/JSONbored/gittensory")) {
        return Response.json({
          name: "gittensory",
          full_name: "JSONbored/gittensory",
          private: false,
          default_branch: "main",
          language: "TypeScript",
          owner: { login: "JSONbored" },
        });
      }
      if (url.includes("/labels?") || url.includes("/pulls?")) return Response.json([]);
      if (url.includes("/issues?")) {
        requestedIssuePages.push(url);
        if (url.includes("page=3")) return Response.json([{ number: 201, title: "Issue 201", state: "open", user: { login: "reporter" }, labels: [], body: "" }]);
        return new Response("unexpected page", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRegisteredRepositories(env, {
      mode: "resume",
      force: true,
      limits: { issues: 300, pullRequests: 0, recentMergedPullRequests: 0, pullRequestDetails: 0 },
    });

    expect(result.repos[0]).toMatchObject({ status: "success", openIssues: 201 });
    expect(requestedIssuePages).toHaveLength(1);
    expect(requestedIssuePages[0]).toContain("page=3");
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ segment: "open_issues", status: "complete", fetchedCount: 201, lastCursor: "3" })]),
    );
  });

  it("records rate-limited segments and sanitized rate-limit observations", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/repos/JSONbored/gittensory")) {
        return Response.json({
          name: "gittensory",
          full_name: "JSONbored/gittensory",
          private: false,
          default_branch: "main",
          language: "TypeScript",
          owner: { login: "JSONbored" },
        });
      }
      if (url.includes("/labels?") || url.includes("/pulls?")) return Response.json([]);
      if (url.includes("/issues?")) {
        return new Response("secondary rate limit", {
          status: 403,
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1780000000",
          },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRegisteredRepositories(env, { force: true });

    expect(result.repos[0]).toMatchObject({ status: "rate_limited", dataQuality: { rateLimited: true } });
    expect(await listRepoSyncStates(env)).toMatchObject([{ status: "rate_limited" }]);
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ segment: "open_issues", status: "rate_limited", rateLimitResetAt: "2026-05-28T20:26:40.000Z" })]),
    );
    expect(await listLatestGitHubRateLimitObservations(env)).toEqual(
      expect.arrayContaining([expect.objectContaining({ repoFullName: "JSONbored/gittensory", resource: "rest", remaining: 0, statusCode: 403 })]),
    );
  });

  it("treats a permission 403 (x-ratelimit-remaining > 0, no Retry-After) as an error, not a rate-limit wait (#1746)", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/repos/JSONbored/gittensory")) {
        return Response.json({
          name: "gittensory",
          full_name: "JSONbored/gittensory",
          private: false,
          default_branch: "main",
          language: "TypeScript",
          owner: { login: "JSONbored" },
        });
      }
      if (url.includes("/labels?") || url.includes("/pulls?")) return Response.json([]);
      if (url.includes("/issues?")) {
        // A genuine permission failure: the bucket is NOT exhausted and there is no Retry-After or
        // secondary-limit body, so it must NOT be misclassified as a rate limit (previously every 403 was).
        return new Response("Resource not accessible by integration", {
          status: 403,
          headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRegisteredRepositories(env, { force: true });

    const [repoResult] = result.repos;
    expect(repoResult?.status).not.toBe("rate_limited");
    expect(repoResult?.dataQuality?.rateLimited).toBe(false);
    const segments = await listRepoSyncSegments(env, "JSONbored/gittensory");
    expect(segments.find((segment) => segment.segment === "open_issues")?.status).toBe("error");
    expect(segments.every((segment) => segment.status !== "rate_limited")).toBe(true);
  });

  it("queues resumable repo segments without wiping previous usable counts", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(env);
    await upsertRepoSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      status: "success",
      sourceKind: "github",
      openIssuesCount: 1100,
      openPullRequestsCount: 167,
      recentMergedPullRequestsCount: 200,
      lastCompletedAt: "2026-05-24T00:00:00.000Z",
      warnings: [],
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString() === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 2911, openPullRequests: 167, mergedPullRequests: 6411, closedPullRequests: 776, labels: 2 });
      return new Response("unexpected", { status: 500 });
    });

    const result = await enqueueRepositoryOpenDataBackfill(env, { repoFullName: "JSONbored/gittensory", requestedBy: "api", mode: "resume", force: true });

    expect(result).toMatchObject({ status: "queued", totals: { openIssuesTotal: 2911, openPullRequestsTotal: 167 } });
    expect(await listRepoSyncStates(env)).toMatchObject([{ status: "running", openIssuesCount: 1100, openPullRequestsCount: 167, lastCompletedAt: "2026-05-24T00:00:00.000Z" }]);
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "backfill-repo-segment", repoFullName: "JSONbored/gittensory", segment: "open_issues", mode: "resume", force: true }),
        expect.objectContaining({ type: "backfill-repo-segment", repoFullName: "JSONbored/gittensory", segment: "open_pull_requests", mode: "resume", force: true }),
      ]),
    );
  });

  it("INVARIANT (#4497): skips the scheduled per-repo backfill when the prior sync is a fresh success, without touching GitHub or writing any sync-state/segment jobs", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(env);
    await upsertRepoSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      status: "success",
      sourceKind: "github",
      openIssuesCount: 5,
      openPullRequestsCount: 3,
      recentMergedPullRequestsCount: 10,
      lastCompletedAt: new Date().toISOString(),
      warnings: [],
    });
    vi.stubGlobal("fetch", async () => new Response("must not be called", { status: 500 }));

    const result = await enqueueRepositoryOpenDataBackfill(env, { repoFullName: "JSONbored/gittensory", requestedBy: "schedule", mode: "light" });

    expect(result).toMatchObject({ status: "skipped", warnings: [expect.stringContaining("Recent GitHub sync completed")] });
    expect(sent).toEqual([]);
    // Status stays "success" (unchanged) -- the scheduled path must not stamp "running" over a fresh state.
    expect(await listRepoSyncStates(env)).toMatchObject([{ status: "success" }]);
  });

  it("INVARIANT (#4497): a syncState row stamped never_synced (distinct from no row at all) still proceeds with a real sync on the scheduled path", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(env);
    // A row EXISTS (unlike the "no prior state at all" case above) but its status is the placeholder
    // "never_synced" -- e.g. stamped by an unrelated write that only carries over display fields (see
    // fetchAndCachePrStateFields-style callers) before any real sync ever completed. This must never be
    // mistaken for "a completed sync just happened."
    await upsertRepoSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      status: "never_synced",
      sourceKind: "github",
      openIssuesCount: 0,
      openPullRequestsCount: 0,
      recentMergedPullRequestsCount: 0,
      lastCompletedAt: new Date().toISOString(),
      warnings: [],
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString() === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 1, openPullRequests: 1, mergedPullRequests: 1, closedPullRequests: 0, labels: 0 });
      return Response.json([]);
    });

    const result = await enqueueRepositoryOpenDataBackfill(env, { repoFullName: "JSONbored/gittensory", requestedBy: "schedule", mode: "light" });

    expect(result.status).toBe("queued");
    expect(sent.filter((message) => message.type === "backfill-repo-segment").length).toBeGreaterThan(0);
  });

  it("INVARIANT (#4497): a syncState past BOTH the fresh-success and error-backoff windows proceeds with a real sync, not a skip", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(env);
    // 7 hours ago: past FRESH_SYNC_MS (6h) for a success AND past ERROR_BACKOFF_MS (1h) were this an error --
    // stale enough that the backfill must proceed normally rather than skip.
    await upsertRepoSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      status: "success",
      sourceKind: "github",
      openIssuesCount: 2,
      openPullRequestsCount: 1,
      recentMergedPullRequestsCount: 3,
      lastCompletedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
      warnings: [],
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString() === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 2, openPullRequests: 1, mergedPullRequests: 3, closedPullRequests: 0, labels: 0 });
      return Response.json([]);
    });

    const result = await enqueueRepositoryOpenDataBackfill(env, { repoFullName: "JSONbored/gittensory", requestedBy: "schedule", mode: "light" });

    expect(result.status).toBe("queued");
    expect(sent.filter((message) => message.type === "backfill-repo-segment").length).toBeGreaterThan(0);
  });

  it("INVARIANT (#4497): backs off the scheduled per-repo backfill when the prior sync errored recently, instead of retrying every tick", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(env);
    await upsertRepoSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      status: "error",
      sourceKind: "github",
      openIssuesCount: 0,
      openPullRequestsCount: 0,
      recentMergedPullRequestsCount: 0,
      lastCompletedAt: new Date().toISOString(),
      errorSummary: "rate limited",
      warnings: [],
    });
    vi.stubGlobal("fetch", async () => new Response("must not be called", { status: 500 }));

    const result = await enqueueRepositoryOpenDataBackfill(env, { repoFullName: "JSONbored/gittensory", requestedBy: "schedule", mode: "light" });

    expect(result).toMatchObject({ status: "skipped", warnings: [expect.stringContaining("backing off")] });
    expect(sent).toEqual([]);
  });

  it("REGRESSION (#4497, endless-scheduled-resync incident): two scheduled dispatches within the freshness window only sync once -- previously every registered repo was re-synced every 30 min forever regardless of freshness or a permanent error state", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString() === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 4, openPullRequests: 2, mergedPullRequests: 9, closedPullRequests: 1, labels: 1 });
      return Response.json([]);
    });

    // First scheduled tick: no prior sync state -> a real sync proceeds and stamps a fresh success.
    const first = await enqueueRepositoryOpenDataBackfill(env, { repoFullName: "JSONbored/gittensory", requestedBy: "schedule", mode: "light" });
    expect(first.status).toBe("queued");
    const segmentJobsAfterFirst = sent.filter((message) => message.type === "backfill-repo-segment").length;
    expect(segmentJobsAfterFirst).toBeGreaterThan(0);
    await upsertRepoSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      status: "success",
      sourceKind: "github",
      openIssuesCount: 4,
      openPullRequestsCount: 2,
      recentMergedPullRequestsCount: 9,
      lastCompletedAt: new Date().toISOString(),
      warnings: [],
    });

    // Second scheduled tick, simulating the next ~30-min cron cadence while still fresh: must be skipped, not
    // re-synced -- this is the exact incident shape (the scheduled path previously had no freshness check at
    // all, so this second tick would have unconditionally re-fetched totals and re-enqueued all 4 segments).
    const second = await enqueueRepositoryOpenDataBackfill(env, { repoFullName: "JSONbored/gittensory", requestedBy: "schedule", mode: "light" });
    expect(second.status).toBe("skipped");
    expect(sent.filter((message) => message.type === "backfill-repo-segment").length).toBe(segmentJobsAfterFirst);

    // An explicit force still bypasses the freshness gate -- the override path is preserved.
    const forced = await enqueueRepositoryOpenDataBackfill(env, { repoFullName: "JSONbored/gittensory", requestedBy: "schedule", mode: "light", force: true });
    expect(forced.status).toBe("queued");
    expect(sent.filter((message) => message.type === "backfill-repo-segment").length).toBeGreaterThan(segmentJobsAfterFirst);
  });

  it("reuses a fresh repo totals snapshot when queueing segmented backfills", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:05:00.000Z"));
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(env);
    await persistTotalsSnapshot(env, {
      fetchedAt: "2026-05-25T00:00:00.000Z",
      openIssuesTotal: 3,
      openPullRequestsTotal: 2,
      mergedPullRequestsTotal: 5,
      labelsTotal: 7,
    });
    let graphQlFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString() === "https://api.github.com/graphql") {
        graphQlFetches += 1;
        return githubTotalsResponse({ openIssues: 99, openPullRequests: 99, mergedPullRequests: 99, closedPullRequests: 99, labels: 99 });
      }
      return new Response("unexpected", { status: 500 });
    });

    const result = await enqueueRepositoryOpenDataBackfill(env, { repoFullName: "JSONbored/gittensory", requestedBy: "api", mode: "resume", force: true });

    expect(result).toMatchObject({
      status: "queued",
      totals: { openIssuesTotal: 3, openPullRequestsTotal: 2, mergedPullRequestsTotal: 5, labelsTotal: 7 },
      warnings: [],
    });
    expect(graphQlFetches).toBe(0);
    expect(await listRepoSyncStates(env)).toMatchObject([{ status: "running", openIssuesCount: 3, openPullRequestsCount: 2 }]);
    expect(sent).toHaveLength(4);
  });

  it("refreshes stale queue totals before segment fan-out but keeps stale same-source totals if refresh fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:30:00.000Z"));
    const cases = [
      { name: "refresh succeeds", graphql: "ok" as const, expectedIssues: 11, expectedWarnings: [] as string[] },
      { name: "refresh fails", graphql: "fail" as const, expectedIssues: 4, expectedWarnings: [] as string[] },
    ];
    for (const scenario of cases) {
      const sent: import("../../src/types").JobMessage[] = [];
      const env = createTestEnv({
        GITHUB_PUBLIC_TOKEN: "public-token",
        JOBS: {
          async send(message: import("../../src/types").JobMessage) {
            sent.push(message);
          },
        } as unknown as Queue,
      });
      await seedRegisteredRepo(env);
      await persistTotalsSnapshot(env, { fetchedAt: "2026-05-25T00:00:00.000Z", openIssuesTotal: 4, openPullRequestsTotal: 1 });
      let graphQlFetches = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (input.toString() === "https://api.github.com/graphql") {
          graphQlFetches += 1;
          if (scenario.graphql === "fail") return new Response(`graphql unavailable for ${scenario.name}`, { status: 500 });
          return githubTotalsResponse({ openIssues: 11, openPullRequests: 6, mergedPullRequests: 5, closedPullRequests: 2, labels: 3 });
        }
        return new Response("unexpected", { status: 500 });
      });

      const result = await enqueueRepositoryOpenDataBackfill(env, { repoFullName: "JSONbored/gittensory", requestedBy: "api", mode: "resume", force: true });

      expect(result).toMatchObject({ status: "queued", totals: { openIssuesTotal: scenario.expectedIssues }, warnings: scenario.expectedWarnings });
      expect(graphQlFetches).toBe(1);
      expect(await listRepoSyncStates(env)).toMatchObject([{ status: "running", openIssuesCount: scenario.expectedIssues }]);
      expect(sent).toHaveLength(4);
    }
  });

  it("uses an older valid same-source totals snapshot when the latest row is unusable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:05:00.000Z"));
    const cases = [
      { name: "malformed latest", fetchedAt: "not-a-date", sourceKind: "github" as const },
      { name: "future latest", fetchedAt: "2026-05-25T00:06:00.000Z", sourceKind: "github" as const },
      { name: "source-mismatched latest", fetchedAt: "2026-05-25T00:04:00.000Z", sourceKind: "installation" as const },
    ];
    for (const snapshot of cases) {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      await seedRegisteredRepo(env);
      await persistTotalsSnapshot(env, { fetchedAt: "2026-05-25T00:00:00.000Z", openIssuesTotal: 3, labelsTotal: 1 });
      await persistTotalsSnapshot(env, { fetchedAt: snapshot.fetchedAt, sourceKind: snapshot.sourceKind, openIssuesTotal: 99, labelsTotal: 99 });
      let graphQlFetches = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url === "https://api.github.com/graphql") {
          graphQlFetches += 1;
          return new Response(`unexpected graphql for ${snapshot.name}`, { status: 500 });
        }
        if (url.includes("/labels?")) return Response.json([{ name: "bug", color: "cc0000", description: "Bug" }]);
        return new Response("not found", { status: 404 });
      });

      const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "resume", force: true });

      expect(result).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
      expect(graphQlFetches).toBe(0);
      expect(await listRepoSyncStates(env)).toMatchObject([{ repoFullName: "JSONbored/gittensory", status: "success", openIssuesCount: 3 }]);
    }
  });

  it("coalesces concurrent queue totals refreshes for the same repo and source", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(env);
    let releaseGraphQl!: () => void;
    const graphQlGate = new Promise<void>((resolve) => {
      releaseGraphQl = resolve;
    });
    let graphQlFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString() === "https://api.github.com/graphql") {
        graphQlFetches += 1;
        await graphQlGate;
        return githubTotalsResponse({ openIssues: 8, openPullRequests: 5, mergedPullRequests: 3, closedPullRequests: 2, labels: 1 });
      }
      return new Response("unexpected", { status: 500 });
    });

    const first = enqueueRepositoryOpenDataBackfill(env, { repoFullName: "JSONbored/gittensory", requestedBy: "api", mode: "resume", force: true });
    const second = enqueueRepositoryOpenDataBackfill(env, { repoFullName: "JSONbored/gittensory", requestedBy: "schedule", mode: "resume", force: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(graphQlFetches).toBe(1);
    releaseGraphQl();
    const results = await Promise.all([first, second]);

    expect(results).toEqual([
      expect.objectContaining({ status: "queued", totals: expect.objectContaining({ openIssuesTotal: 8, openPullRequestsTotal: 5 }) }),
      expect.objectContaining({ status: "queued", totals: expect.objectContaining({ openIssuesTotal: 8, openPullRequestsTotal: 5 }) }),
    ]);
    expect(graphQlFetches).toBe(1);
    expect(sent).toHaveLength(8);
  });

  it("uses valid stale totals without a token and warns only when no usable snapshot exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:30:00.000Z"));
    const noSnapshotJobs: import("../../src/types").JobMessage[] = [];
    const noSnapshotEnv = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          noSnapshotJobs.push(message);
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(noSnapshotEnv);
    vi.stubGlobal("fetch", async () => new Response("network should not be used without a token", { status: 500 }));

    const noSnapshot = await enqueueRepositoryOpenDataBackfill(noSnapshotEnv, { repoFullName: "JSONbored/gittensory", requestedBy: "api", mode: "resume", force: true });

    expect(noSnapshot).toMatchObject({
      status: "queued",
      warnings: ["GitHub totals snapshot could not be refreshed before segment queueing."],
    });
    expect(noSnapshot).not.toHaveProperty("totals");
    expect(noSnapshotJobs).toHaveLength(4);

    const staleSnapshotJobs: import("../../src/types").JobMessage[] = [];
    const staleSnapshotEnv = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          staleSnapshotJobs.push(message);
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(staleSnapshotEnv);
    await persistTotalsSnapshot(staleSnapshotEnv, { fetchedAt: "2026-05-25T00:00:00.000Z", openIssuesTotal: 6, openPullRequestsTotal: 4 });

    const staleSnapshot = await enqueueRepositoryOpenDataBackfill(staleSnapshotEnv, { repoFullName: "JSONbored/gittensory", requestedBy: "api", mode: "resume", force: true });

    expect(staleSnapshot).toMatchObject({ status: "queued", totals: { openIssuesTotal: 6, openPullRequestsTotal: 4 }, warnings: [] });
    expect(staleSnapshotJobs).toHaveLength(4);
  });

  it("reuses a fresh repo totals snapshot for queued segment backfills without repeating GraphQL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:05:00.000Z"));
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await persistTotalsSnapshot(env, { fetchedAt: "2026-05-25T00:00:00.000Z", labelsTotal: 1 });
    let graphQlFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        graphQlFetches += 1;
        return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 99 });
      }
      if (url.includes("/labels?")) return Response.json([{ name: "bug", color: "cc0000", description: "Bug" }]);
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "resume", force: true });

    expect(result).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
    expect(graphQlFetches).toBe(0);
  });

  it("refreshes live totals when a segment snapshot is stale, malformed, future-dated, or from another source", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:05:00.000Z"));
    const cases = [
      { name: "stale", fetchedAt: "2026-05-24T23:40:00.000Z", sourceKind: "github" as const },
      { name: "malformed", fetchedAt: "not-a-date", sourceKind: "github" as const },
      { name: "future", fetchedAt: "2026-05-25T00:06:00.000Z", sourceKind: "github" as const },
      { name: "source mismatch", fetchedAt: "2026-05-25T00:00:00.000Z", sourceKind: "installation" as const },
    ];
    for (const snapshot of cases) {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      await seedRegisteredRepo(env);
      await persistTotalsSnapshot(env, { fetchedAt: snapshot.fetchedAt, sourceKind: snapshot.sourceKind, labelsTotal: 1 });
      let graphQlFetches = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url === "https://api.github.com/graphql") {
          graphQlFetches += 1;
          return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 2 });
        }
        if (url.includes("/labels?"))
          return Response.json([
            { name: "bug", color: "cc0000", description: "Bug" },
            { name: "enhancement", color: "00cc00", description: "Enhancement" },
          ]);
        return new Response(`not found for ${snapshot.name}`, { status: 404 });
      });

      const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "resume", force: true });

      expect(result).toMatchObject({ status: "complete", fetchedCount: 2, expectedCount: 2 });
      expect(graphQlFetches).toBe(1);
    }
  });

  it("falls back to the latest stale totals snapshot when the live segment refresh fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:30:00.000Z"));
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await persistTotalsSnapshot(env, { fetchedAt: "2026-05-25T00:00:00.000Z", labelsTotal: 1 });
    let graphQlFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        graphQlFetches += 1;
        return new Response("graphql unavailable", { status: 500 });
      }
      if (url.includes("/labels?")) return Response.json([{ name: "bug", color: "cc0000", description: "Bug" }]);
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "resume", force: true });

    expect(result).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
    expect(graphQlFetches).toBe(1);
  });

  it("does not fall back to invalid or mismatched totals snapshots after a live refresh failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:05:00.000Z"));
    const cases = [
      { name: "malformed", fetchedAt: "not-a-date", sourceKind: "github" as const },
      { name: "future", fetchedAt: "2026-05-25T00:06:00.000Z", sourceKind: "github" as const },
      { name: "source mismatch", fetchedAt: "2026-05-25T00:00:00.000Z", sourceKind: "installation" as const },
    ];
    for (const snapshot of cases) {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      await seedRegisteredRepo(env);
      await persistTotalsSnapshot(env, { fetchedAt: snapshot.fetchedAt, sourceKind: snapshot.sourceKind, labelsTotal: 99 });
      let graphQlFetches = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url === "https://api.github.com/graphql") {
          graphQlFetches += 1;
          return new Response(`graphql unavailable for ${snapshot.name}`, { status: 500 });
        }
        if (url.includes("/labels?")) return Response.json([{ name: "bug", color: "cc0000", description: "Bug" }]);
        return new Response("not found", { status: 404 });
      });

      const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "resume", force: true });

      expect(result).toMatchObject({ status: "complete", fetchedCount: 1 });
      expect(result).not.toHaveProperty("expectedCount");
      expect(graphQlFetches).toBe(1);
    }
  });

  it("drains open issue segments against GitHub totals without counting PR rows from /issues", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 2, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 0 });
      if (url.includes("/issues?") && new URL(url).searchParams.get("page") === "1") {
        return Response.json(
          [
            { number: 1, title: "Real issue", state: "open", user: { login: "reporter" }, labels: [], body: "" },
            { number: 10, title: "PR surfaced through issues API", state: "open", user: { login: "contributor" }, labels: [], body: "", pull_request: {} },
          ],
          { headers: { link: '<https://api.github.com/repositories/1/issues?page=2>; rel="next"' } },
        );
      }
      if (url.includes("/issues?") && new URL(url).searchParams.get("page") === "2") {
        return Response.json([{ number: 2, title: "Second real issue", state: "open", user: { login: "reporter" }, labels: [], body: "" }]);
      }
      return new Response("not found", { status: 404 });
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_issues", mode: "full", force: true });

    expect(result).toMatchObject({ status: "complete", fetchedCount: 2, expectedCount: 2 });
    expect((await listIssues(env, "JSONbored/gittensory")).map((issue) => issue.number)).toEqual([1, 2]);
    expect(await listLatestRepoGithubTotalsSnapshots(env)).toMatchObject([{ repoFullName: "JSONbored/gittensory", openIssuesTotal: 2 }]);
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ segment: "open_issues", status: "complete", fetchedCount: 2, expectedCount: 2 })]),
    );
  });

  it("supplements REST open issue undercounts from GitHub GraphQL before marking completeness", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        const query = JSON.parse(String(init?.body ?? "{}")).query as string;
        if (query.includes("GittensoryOpenIssuesSupplement")) {
          if (query.includes("after:")) {
            return Response.json({
              data: {
                repository: {
                  issues: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ number: 3, state: "OPEN", labels: { nodes: [null] } }, { number: 4 }, null],
                  },
                },
              },
            });
          }
          return Response.json({
            data: {
              repository: {
                issues: {
                  pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                  nodes: [
                    { number: 1, title: "REST issue", state: "OPEN", url: "https://github.com/owner/repo/issues/1", labels: { nodes: [] } },
                    { title: "No number", state: "OPEN", labels: { nodes: [] } },
                    {
                      number: 2,
                      title: "GraphQL-only issue",
                      state: "OPEN",
                      url: "https://github.com/owner/repo/issues/2",
                      body: "GraphQL supplement",
                      author: { login: "reporter" },
                      authorAssociation: "NONE",
                      labels: { nodes: [{ name: "bug" }] },
                    },
                  ],
                },
              },
              rateLimit: { remaining: 4999, resetAt: "2026-05-25T16:00:00Z" },
            },
          });
        }
        return githubTotalsResponse({ openIssues: 4, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 0 });
      }
      if (url.includes("/issues?")) return Response.json([{ number: 1, title: "REST issue", state: "open", user: { login: "reporter" }, labels: [], body: "" }]);
      return Response.json([]);
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_issues", mode: "full", force: true });

    expect(result).toMatchObject({ status: "complete", fetchedCount: 4, expectedCount: 4 });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Supplemented 3 open issue")]));
    expect(await listIssues(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ number: 2, title: "GraphQL-only issue", labels: ["bug"] }),
        expect.objectContaining({ number: 3, title: "Issue #3", labels: [] }),
        expect.objectContaining({ number: 4, title: "Issue #4", state: "open" }),
      ]),
    );
  });

  it("keeps open issue segment partial when the GraphQL supplement fails", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        const query = JSON.parse(String(init?.body ?? "{}")).query as string;
        if (query.includes("GittensoryOpenIssuesSupplement")) return new Response("graphql down", { status: 502 });
        return githubTotalsResponse({ openIssues: 2, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 0 });
      }
      if (url.includes("/issues?")) return Response.json([{ number: 1, title: "REST issue", state: "open", user: { login: "reporter" }, labels: [], body: "" }]);
      return Response.json([]);
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_issues", mode: "full", force: true });

    expect(result).toMatchObject({ status: "partial", fetchedCount: 1, expectedCount: 2 });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("GitHub GraphQL supplement failed")]));
  });

  it("keeps open issue segment partial when GraphQL supplement has no missing nodes", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        const query = JSON.parse(String(init?.body ?? "{}")).query as string;
        if (query.includes("GittensoryOpenIssuesSupplement")) {
          return Response.json({
            data: {
              repository: {
                issues: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ number: 1, title: "REST issue", state: "OPEN", labels: { nodes: [] } }],
                },
              },
            },
          });
        }
        return githubTotalsResponse({ openIssues: 2, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 0 });
      }
      if (url.includes("/issues?")) return Response.json([{ number: 1, title: "REST issue", state: "open", user: { login: "reporter" }, labels: [], body: "" }]);
      return Response.json([]);
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_issues", mode: "full", force: true });

    expect(result).toMatchObject({ status: "partial", fetchedCount: 1, expectedCount: 2 });
    expect(result.warnings.join("\n")).not.toContain("Supplemented");
  });

  it("supplements REST open PR undercounts from GitHub GraphQL before marking completeness", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        const query = JSON.parse(String(init?.body ?? "{}")).query as string;
        if (query.includes("GittensoryOpenPullRequestsSupplement")) {
          expect(query).toContain("isDraft");
          expect(query).toContain("mergeable");
          expect(query).toContain("reviewDecision");
          if (query.includes("after:")) {
            return Response.json({
              data: {
                repository: {
                  pullRequests: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ number: 12 }],
                  },
                },
              },
            });
          }
          return Response.json({
            data: {
              repository: {
                pullRequests: {
                  pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                  nodes: [
                    { number: 10, title: "REST PR", state: "OPEN", labels: { nodes: [] } },
                    {
                      number: 11,
                      title: "GraphQL-only PR",
                      state: "OPEN",
                      url: "https://github.com/JSONbored/gittensory/pull/11",
                      body: "GraphQL supplement",
                      isDraft: false,
                      mergeable: "CLEAN",
                      reviewDecision: "APPROVED",
                      author: { login: "oktofeesh1" },
                      authorAssociation: "NONE",
                      headRefName: "feature",
                      baseRefName: "main",
                      headRefOid: "abc123",
                      labels: { nodes: [{ name: "bug" }] },
                    },
                  ],
                },
              },
              rateLimit: { remaining: 4999, resetAt: "2026-05-25T16:00:00Z" },
            },
          });
        }
        return githubTotalsResponse({ openIssues: 0, openPullRequests: 3, mergedPullRequests: 0, closedPullRequests: 0, labels: 0 });
      }
      if (url.includes("/pulls?state=open")) return Response.json([{ number: 10, title: "REST PR", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "" }]);
      return Response.json([]);
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_pull_requests", mode: "full", force: true });

    expect(result).toMatchObject({ status: "complete", fetchedCount: 3, expectedCount: 3 });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Supplemented 2 open pull request")]));
    expect(await listPullRequests(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          number: 11,
          title: "GraphQL-only PR",
          isDraft: false,
          mergeableState: "CLEAN",
          reviewDecision: "APPROVED",
          labels: ["bug"],
          headSha: "abc123",
          headRef: "feature",
          baseRef: "main",
        }),
      ]),
    );
  });

  it("reports fetched open issue count from persisted rows so repeated segment jobs cannot double count", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 1, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 0 });
      if (url.includes("/issues?")) return Response.json([{ number: 1, title: "Stable issue", state: "open", user: { login: "reporter" }, labels: [], body: "" }]);
      return Response.json([]);
    });

    await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_issues", mode: "full", force: true });
    const repeated = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_issues", mode: "resume", cursor: "1", force: true });

    expect(repeated).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
    expect(await listIssues(env, "JSONbored/gittensory")).toHaveLength(1);
  });

  it("keeps a segment complete when a late pagination error happens after expected coverage is already persisted", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 1 });
      if (url.includes("/labels?") && new URL(url).searchParams.get("page") === "1") {
        return Response.json([{ name: "signal", color: "00ff00", description: "Signal" }], {
          headers: { link: '<https://api.github.com/repositories/1/labels?page=2>; rel="next"' },
        });
      }
      if (url.includes("/labels?") && new URL(url).searchParams.get("page") === "2") return new Response("late failure", { status: 500 });
      return Response.json([]);
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "full", force: true });

    expect(result).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("met the expected total after a late page error")]));
  });

  it("marks a current open-data segment partial when reconciliation removes stale rows below expected totals", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertIssueFromGitHub(
      env,
      "JSONbored/gittensory",
      {
        number: 99,
        title: "Stale issue",
        state: "open",
        user: { login: "reporter" },
        labels: [],
        body: "",
      },
      { seenOpenAt: "2026-01-01T00:00:00.000Z" },
    );
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        const query = JSON.parse(String(init?.body ?? "{}")).query as string;
        if (query.includes("GittensoryOpenIssuesSupplement")) {
          return Response.json({
            data: {
              repository: {
                issues: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ number: 1, title: "Fresh issue", state: "OPEN", labels: { nodes: [] } }],
                },
              },
            },
          });
        }
        return githubTotalsResponse({ openIssues: 2, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 0 });
      }
      if (url.includes("/issues?")) return Response.json([{ number: 1, title: "Fresh issue", state: "open", user: { login: "reporter" }, labels: [], body: "" }]);
      return Response.json([]);
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_issues", mode: "full", force: true });

    expect(result).toMatchObject({ status: "partial", fetchedCount: 1, expectedCount: 2 });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Marked 1 stale open issue"), expect.stringContaining("below expected total 2")]));
  });

  it("reconciles stale open rows after a complete current open-data crawl", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(
      env,
      "JSONbored/gittensory",
      {
        number: 99,
        title: "Stale open PR",
        state: "open",
        user: { login: "oktofeesh1" },
        head: { sha: "stale" },
        labels: [],
        body: "",
      },
      { seenOpenAt: "2026-01-01T00:00:00.000Z" },
    );
    await upsertIssueFromGitHub(
      env,
      "JSONbored/gittensory",
      {
        number: 88,
        title: "Stale open issue",
        state: "open",
        user: { login: "reporter" },
        labels: [],
        body: "",
      },
      { seenOpenAt: "2026-01-01T00:00:00.000Z" },
    );
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 1, openPullRequests: 1, mergedPullRequests: 0, closedPullRequests: 0, labels: 0 });
      if (url.includes("/pulls?state=open")) {
        expect(new URL(url).searchParams.get("sort")).toBe("created");
        return Response.json([{ number: 1, title: "Current PR", state: "open", user: { login: "oktofeesh1" }, head: { sha: "current" }, labels: [], body: "" }]);
      }
      if (url.includes("/issues?")) {
        expect(new URL(url).searchParams.get("sort")).toBe("created");
        return Response.json([{ number: 2, title: "Current issue", state: "open", user: { login: "reporter" }, labels: [], body: "" }]);
      }
      return Response.json([]);
    });

    const prs = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_pull_requests", mode: "full", force: true });
    const issues = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_issues", mode: "full", force: true });

    expect(prs).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
    expect(issues).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
    expect(await listPullRequests(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ number: 1, state: "open" }),
        expect.objectContaining({ number: 99, state: "closed" }),
      ]),
    );
    expect(await listIssues(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ number: 2, state: "open" }),
        expect.objectContaining({ number: 88, state: "closed" }),
      ]),
    );
  });

  it("restarts old unmarked open-data resumes before current-open reconciliation", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertRepoSyncSegment(env, {
      repoFullName: "JSONbored/gittensory",
      segment: "open_issues",
      status: "waiting_rate_limit",
      sourceKind: "github",
      mode: "resume",
      fetchedCount: 2911,
      expectedCount: 2912,
      pageCount: 10,
      lastCursor: "20",
      nextCursor: "21",
      startedAt: "2026-05-25T14:00:00.000Z",
      warnings: [],
    });
    const seenPages: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 1, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 0 });
      if (url.includes("/issues?")) {
        seenPages.push(new URL(url).searchParams.get("page") ?? "");
        return Response.json([{ number: 1, title: "Current issue", state: "open", user: { login: "reporter" }, labels: [], body: "" }]);
      }
      return Response.json([]);
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_issues", mode: "resume", force: true });

    expect(seenPages).toEqual(["1"]);
    expect(result).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
  });

  it("resumes marked current-open scans from the stored or explicit cursor", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertRepoSyncSegment(env, {
      repoFullName: "JSONbored/gittensory",
      segment: "open_issues",
      status: "running",
      sourceKind: "github",
      mode: "resume",
      fetchedCount: 0,
      expectedCount: 1,
      pageCount: 1,
      lastCursor: "1",
      nextCursor: "2",
      startedAt: "2026-05-25T14:00:00.000Z",
      etag: "gittensory-current-open-scan-v1",
      warnings: [],
    });
    const seenPages: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 1, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 0 });
      if (url.includes("/issues?")) {
        seenPages.push(new URL(url).searchParams.get("page") ?? "");
        return Response.json([{ number: 2, title: "Current issue", state: "open", user: { login: "reporter" }, labels: [], body: "" }]);
      }
      return Response.json([]);
    });

    const storedCursor = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_issues", mode: "resume", force: true });
    await upsertRepoSyncSegment(env, {
      repoFullName: "JSONbored/gittensory",
      segment: "open_issues",
      status: "running",
      sourceKind: "github",
      mode: "resume",
      fetchedCount: 0,
      expectedCount: 1,
      pageCount: 1,
      nextCursor: "2",
      startedAt: "2026-05-25T14:00:00.000Z",
      etag: "gittensory-current-open-scan-v1",
      warnings: [],
    });
    const explicitCursor = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_issues", mode: "resume", cursor: "3", force: true });

    expect(seenPages).toEqual(["2", "3"]);
    expect(storedCursor).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
    expect(explicitCursor).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
  });

  it("handles segment skips, disabled repo settings, and low rate-limit requeue without discarding prior cursors", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(env);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSignalLevel: "standard",
      checkRunMode: "enabled",
      checkRunDetailLevel: "standard",
      backfillEnabled: false,
    });

    await expect(enqueueRepositoryOpenDataBackfill(env, { repoFullName: "missing/repo", requestedBy: "api" })).resolves.toMatchObject({ status: "skipped" });
    await expect(enqueueRepositoryOpenDataBackfill(env, { repoFullName: "JSONbored/gittensory", requestedBy: "api" })).resolves.toMatchObject({ status: "skipped" });

    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSignalLevel: "standard",
      checkRunMode: "enabled",
      checkRunDetailLevel: "standard",
      backfillEnabled: true,
    });
    await upsertRepoSyncSegment(env, {
      repoFullName: "JSONbored/gittensory",
      segment: "open_issues",
      status: "complete",
      sourceKind: "github",
      mode: "full",
      fetchedCount: 2911,
      expectedCount: 2911,
      pageCount: 30,
      lastCursor: "30",
      completedAt: "2026-05-24T00:00:00.000Z",
      warnings: [],
    });
    await recordGitHubRateLimitObservation(env, {
      repoFullName: "JSONbored/gittensory",
      // Registry-only repo (no installation), so tokenForRepo resolves to the shared public token and
      // repoAdmissionKeyForToken scopes to that bucket (#audit-rate-scoping).
      admissionKey: "public-token",
      resource: "rest",
      path: "/issues",
      statusCode: 200,
      remaining: 1,
      resetAt: "2999-01-01T00:00:00.000Z",
    });

    const waiting = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_issues", requestedBy: "schedule", mode: "resume", cursor: "31" });

    expect(waiting).toMatchObject({ status: "waiting_rate_limit", fetchedCount: 2911, expectedCount: 2911, nextCursor: "31" });
    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: "backfill-repo-segment", requestedBy: "schedule", segment: "open_issues", mode: "resume" })]));
  });

  it("requeues incomplete required segments and starts PR detail hydration after open PR coverage completes", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 0, openPullRequests: 1, mergedPullRequests: 0, closedPullRequests: 0, labels: 300 });
      if (url.includes("/labels?") && ["1", "2"].includes(new URL(url).searchParams.get("page") ?? "")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        return Response.json(
          Array.from({ length: 100 }, (_, index) => ({ name: `label-${page}-${index}`, color: "cccccc" })),
          { headers: { link: `<https://api.github.com/repositories/1/labels?page=${page + 1}>; rel="next"` } },
        );
      }
      if (url.includes("/pulls?state=open")) {
        return Response.json([{ number: 10, title: "Open PR", state: "open", user: { login: "oktofeesh1" }, head: { sha: "abc" }, labels: [], body: "" }]);
      }
      return Response.json([]);
    });

    const labels = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", requestedBy: "test", mode: "light" });
    const openPrs = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_pull_requests", requestedBy: "api", mode: "full" });

    expect(labels).toMatchObject({ status: "running", fetchedCount: 200, expectedCount: 300 });
    expect(openPrs).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "backfill-repo-segment", requestedBy: "test", segment: "labels", mode: "resume" }),
        expect.objectContaining({ type: "backfill-pr-details", repoFullName: "JSONbored/gittensory", mode: "resume", cursor: 0 }),
      ]),
    );
  });

  it("treats large historical merged PR segments as sampled instead of blocking open-data readiness", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 2000, closedPullRequests: 0, labels: 0 });
      if (/\/pulls\/\d+\/files/.test(url)) return Response.json([]);
      if (url.includes("/pulls?state=closed")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        return Response.json(
          [{ number: page, title: `Merged ${page}`, state: "closed", merged_at: "2026-05-20T00:00:00.000Z", user: { login: "oktofeesh1" }, labels: [], body: "" }],
          { headers: { link: `<https://api.github.com/repositories/1/pulls?page=${page + 1}>; rel="next"` } },
        );
      }
      return Response.json([]);
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "recent_merged_pull_requests", mode: "full" });

    expect(result).toMatchObject({ status: "sampled", fetchedCount: 10, expectedCount: 2000 });
    expect(await listRecentMergedPullRequests(env, "JSONbored/gittensory")).toHaveLength(10);
  });

  it("hydrates PR files and reviews through GraphQL when public-token REST detail endpoints are hidden", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 10,
      title: "Open PR",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "abc" },
      labels: [],
      body: "",
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 11,
      title: "Open PR without head SHA",
      state: "open",
      user: { login: "oktofeesh1" },
      labels: [],
      body: "",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        const query = JSON.parse(String(init?.body ?? "{}")).query as string;
        if (query.includes("GittensoryPullRequestDetails")) {
          return Response.json({
            data: {
              repository: {
                pullRequest: {
                  files: { nodes: [{ path: "src/signal.ts", additions: 3, deletions: 1, changeType: "MODIFIED" }, { path: "README.md" }, { additions: 1 }, null] },
                  reviews: { nodes: [{ databaseId: 44, author: { login: "maintainer" }, state: "APPROVED", authorAssociation: "MEMBER", submittedAt: "2026-05-25T00:00:00Z" }, { databaseId: 45 }, {}, null] },
                },
              },
              rateLimit: { remaining: 4999, resetAt: "2026-05-25T16:00:00Z" },
            },
          });
        }
      }
      if (url.includes("/pulls/10/files") || url.includes("/pulls/10/reviews")) return new Response("", { status: 404 });
      if (url.includes("/pulls/11/files") || url.includes("/pulls/11/reviews")) return Response.json([]);
      if (url.includes("/commits/abc/check-runs")) return Response.json({});
      return Response.json([]);
    });

    const result = await backfillOpenPullRequestDetails(env, { repoFullName: "JSONbored/gittensory", mode: "full", cursor: 0 });

    expect(result).toMatchObject({ status: "complete", processed: 2, warnings: [] });
    expect(await listPullRequestFiles(env, "JSONbored/gittensory", 10)).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "src/signal.ts", additions: 3, deletions: 1, changes: 4 }), expect.objectContaining({ path: "README.md", status: "modified", changes: 0 })]),
    );
    expect(await listPullRequestReviews(env, "JSONbored/gittensory", 10)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "JSONbored/gittensory#10#44", reviewerLogin: "maintainer", state: "APPROVED" }), expect.objectContaining({ id: "JSONbored/gittensory#10#45", state: "UNKNOWN" })]),
    );
  });

  it("refreshes one pull request's files before gate evaluation and drops stale cached paths", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 12,
      title: "Refresh files",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "new-head" },
      labels: [],
      body: "",
    });
    await upsertPullRequestFile(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 12,
      path: "stale/old-secret.txt",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: { filename: "stale/old-secret.txt" },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/pulls/12/files")) return Response.json([{ filename: "src/current.ts", status: "modified", additions: 2, deletions: 1, changes: 3 }]);
      if (url.includes("/pulls/12/reviews")) return Response.json([]);
      if (url.includes("/commits/new-head/check-runs")) return Response.json({ check_runs: [] });
      return Response.json([]);
    });

    const result = await refreshPullRequestDetails(env, "JSONbored/gittensory", 12);

    expect(result).toMatchObject({ status: "complete", pullNumber: 12 });
    expect(await listPullRequestFiles(env, "JSONbored/gittensory", 12)).toEqual([expect.objectContaining({ path: "src/current.ts", changes: 3 })]);
  });

  it("preserves cached pull request files when refresh cannot reload the current file list", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 12,
      title: "Refresh unavailable",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "new-head" },
      labels: [],
      body: "",
    });
    await upsertPullRequestFile(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 12,
      path: "src/cached.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: { filename: "src/cached.ts" },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        const query = JSON.parse(String(init?.body ?? "{}")).query as string;
        if (query.includes("GittensoryPullRequestDetails")) return Response.json({ data: { repository: { pullRequest: null } } });
      }
      if (url.includes("/pulls/12/files")) return new Response("files unavailable", { status: 503 });
      if (url.includes("/pulls/12/reviews")) return Response.json([]);
      if (url.includes("/commits/new-head/check-runs")) return Response.json({ check_runs: [] });
      return Response.json([]);
    });

    const result = await refreshPullRequestDetails(env, "JSONbored/gittensory", 12);

    expect(result).toMatchObject({ status: "partial", pullNumber: 12 });
    expect(result.warnings).toEqual([expect.stringContaining("File sync failed for #12")]);
    expect(await listPullRequestFiles(env, "JSONbored/gittensory", 12)).toEqual([expect.objectContaining({ path: "src/cached.ts", changes: 1 })]);
  });

  it("paginates PR files, reviews, and check-runs across Link-header pages so large PRs are not truncated", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 20,
      title: "Large PR",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "bigsha" },
      labels: [],
      body: "",
    });
    const nextLink = (resource: string) => ({ headers: { link: `<https://api.github.com/repositories/1/${resource}?page=2>; rel="next"` } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/pulls/20/files")) {
        return url.includes("page=2")
          ? Response.json([{ filename: "src/b.ts", status: "modified", additions: 2, deletions: 0, changes: 2 }])
          : Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }], nextLink("files"));
      }
      if (url.includes("/pulls/20/reviews")) {
        return url.includes("page=2")
          ? Response.json([{ id: 91, user: { login: "rev2" }, state: "COMMENTED", submitted_at: "2026-05-25T00:00:00Z" }])
          : Response.json([{ id: 90, user: { login: "rev1" }, state: "APPROVED", submitted_at: "2026-05-24T00:00:00Z" }], nextLink("reviews"));
      }
      if (url.includes("/commits/bigsha/check-runs")) {
        return url.includes("page=2")
          ? Response.json({ check_runs: [{ id: 71, name: "lint", status: "completed", conclusion: "success" }] })
          : Response.json({ check_runs: [{ id: 70, name: "test", status: "completed", conclusion: "success" }] }, nextLink("commits/bigsha/check-runs"));
      }
      return Response.json([]);
    });

    const result = await backfillOpenPullRequestDetails(env, { repoFullName: "JSONbored/gittensory", mode: "full", cursor: 0 });
    expect(result).toMatchObject({ status: "complete", processed: 1, warnings: [] });

    // Both pages of each list must be persisted — page 1 alone would silently drop the second page.
    expect((await listPullRequestFiles(env, "JSONbored/gittensory", 20)).map((file) => file.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect((await listPullRequestReviews(env, "JSONbored/gittensory", 20)).map((review) => review.reviewerLogin).sort()).toEqual(["rev1", "rev2"]);
    expect((await listCheckSummaries(env, "JSONbored/gittensory", 20)).map((check) => check.name).sort()).toEqual(["lint", "test"]);
  });

  it("keeps the pages already fetched when a later PR-files page fails", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 21,
      title: "Partial pages",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "psha" },
      labels: [],
      body: "",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/pulls/21/files")) {
        return url.includes("page=2")
          ? new Response("rate limited", { status: 503 })
          : Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }], {
              headers: { link: '<https://api.github.com/repositories/1/files?page=2>; rel="next"' },
            });
      }
      if (url.includes("/pulls/21/reviews")) return Response.json([]);
      if (url.includes("/commits/psha/check-runs")) {
        // Same partial-page behavior for the check-runs envelope: page 1 ok, page 2 fails.
        return url.includes("page=2")
          ? new Response("rate limited", { status: 503 })
          : Response.json({ check_runs: [{ id: 80, name: "build", status: "completed", conclusion: "success" }] }, {
              headers: { link: '<https://api.github.com/repositories/1/commits/psha/check-runs?page=2>; rel="next"' },
            });
      }
      return Response.json([]);
    });

    await backfillOpenPullRequestDetails(env, { repoFullName: "JSONbored/gittensory", mode: "full", cursor: 0 });
    // Page 1 succeeded; a page-2 failure must keep it rather than dropping a good first page (files and checks).
    expect((await listPullRequestFiles(env, "JSONbored/gittensory", 21)).map((file) => file.path)).toEqual(["src/a.ts"]);
    expect((await listCheckSummaries(env, "JSONbored/gittensory", 21)).map((check) => check.name)).toEqual(["build"]);
  });

  it("records partial PR detail state and check summary segment when check-run fetches fail", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 12,
      title: "Checks unavailable",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "missing-checks" },
      labels: [],
      body: "",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/pulls/12/files")) return Response.json([{ filename: "src/signal.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }]);
      if (url.includes("/pulls/12/reviews")) return Response.json([]);
      if (url.includes("/commits/missing-checks/check-runs")) return new Response("checks unavailable", { status: 503 });
      return Response.json([]);
    });

    const result = await backfillOpenPullRequestDetails(env, { repoFullName: "JSONbored/gittensory", mode: "full", cursor: 0 });

    expect(result).toMatchObject({ status: "partial", processed: 1 });
    expect(result.warnings).toEqual([expect.stringContaining("Check sync failed for #12")]);
    expect(await listPullRequestDetailSyncStates(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ pullNumber: 12, status: "partial", errorSummary: expect.stringContaining("Check sync failed") })]),
    );
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ segment: "check_summaries", status: "partial", warnings: [expect.stringContaining("Check sync failed for #12")] })]),
    );
  });

  it("records partial PR detail state when REST and GraphQL cannot load a pull request", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 12,
      title: "Unavailable PR",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "missing" },
      labels: [],
      body: "",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        const query = JSON.parse(String(init?.body ?? "{}")).query as string;
        if (query.includes("GittensoryPullRequestDetails")) return Response.json({ data: { repository: { pullRequest: null } } });
      }
      if (url.includes("/pulls/12/files") || url.includes("/pulls/12/reviews")) return new Response("", { status: 404 });
      if (url.includes("/commits/missing/check-runs")) return Response.json({});
      return Response.json([]);
    });

    const result = await backfillOpenPullRequestDetails(env, { repoFullName: "JSONbored/gittensory", mode: "full", cursor: 0 });

    expect(result).toMatchObject({ status: "partial", processed: 1 });
    expect(result.warnings.join("\n")).toMatch(/File sync failed|Review sync failed/);
  });

  it("does not attempt GraphQL PR detail fallbacks without any GitHub token", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 32,
      title: "Unavailable without token",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "missing-token" },
      labels: [],
      body: "",
    });
    let graphqlCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        graphqlCalls += 1;
        return Response.json({ data: { repository: { pullRequest: null } } });
      }
      if (url.includes("/pulls/32/files") || url.includes("/pulls/32/reviews")) return new Response("", { status: 404 });
      if (url.includes("/commits/missing-token/check-runs")) return Response.json({});
      return Response.json([]);
    });

    const result = await backfillOpenPullRequestDetails(env, { repoFullName: "JSONbored/gittensory", mode: "full", cursor: 0 });

    expect(result).toMatchObject({ status: "partial", processed: 1 });
    expect(result.warnings.join("\n")).toMatch(/File sync failed|Review sync failed/);
    expect(graphqlCalls).toBe(0);
  });

  it("hydrates open PR details in small batches and records partial detail failures", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(env);
    for (let number = 1; number <= 13; number += 1) {
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        number,
        title: `PR ${number}`,
        state: "open",
        user: { login: "oktofeesh1" },
        head: { sha: `sha-${number}` },
        labels: [],
        body: "",
      });
    }
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/pulls/5/reviews")) return new Response("review failure", { status: 503 });
      if (url.includes("/pulls/") && url.includes("/files")) return Response.json([{ filename: "src/file.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }]);
      if (url.includes("/pulls/") && url.includes("/reviews")) return Response.json([]);
      if (url.includes("/commits/") && url.includes("/check-runs")) return Response.json({ check_runs: [] });
      return new Response("not found", { status: 404 });
    });

    const firstBatch = await backfillOpenPullRequestDetails(env, { repoFullName: "JSONbored/gittensory", mode: "light", cursor: 0 });
    const secondBatch = await backfillOpenPullRequestDetails(env, { repoFullName: "JSONbored/gittensory", mode: "light", cursor: 12 });

    expect(firstBatch).toMatchObject({ status: "running", processed: 12, nextCursor: 0 });
    expect(secondBatch.status).toBe("partial");
    expect(secondBatch.processed).toBeGreaterThanOrEqual(2);
    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: "backfill-pr-details", cursor: 0 })]));
    expect(await listPullRequestDetailSyncStates(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pullNumber: 1, status: "complete" }),
        expect.objectContaining({ pullNumber: 5, status: "partial", errorSummary: expect.stringContaining("Review sync failed") }),
        expect.objectContaining({ pullNumber: 13, status: "complete" }),
      ]),
    );
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ segment: "pull_request_files", status: "partial", expectedCount: 13 })]),
    );
  });

  it("stops PR detail backfill instead of re-queuing forever when a full batch makes no progress", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(env);
    for (let number = 1; number <= 13; number += 1) {
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        number,
        title: `PR ${number}`,
        state: "open",
        user: { login: "oktofeesh1" },
        head: { sha: `sha-${number}` },
        labels: [],
        body: "",
      });
    }
    // Every PR's file sync fails on both GraphQL and REST, so all 13 stay "partial" and the front-12
    // batch never completes. Without a progress guard nextCursor would stay 0 and re-queue forever.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") return new Response("graphql failure", { status: 503 });
      if (url.includes("/pulls/") && url.includes("/files")) return new Response("file failure", { status: 503 });
      if (url.includes("/pulls/") && url.includes("/reviews")) return Response.json([]);
      if (url.includes("/commits/") && url.includes("/check-runs")) return Response.json({ check_runs: [] });
      return new Response("not found", { status: 404 });
    });

    const firstBatch = await backfillOpenPullRequestDetails(env, { repoFullName: "JSONbored/gittensory", mode: "light", cursor: 0 });

    expect(firstBatch.status).toBe("partial");
    expect(firstBatch.nextCursor).toBeUndefined();
    expect(sent).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "backfill-pr-details" })]));
  });

  it("records segment partial, hard error, and GitHub rate-limit states from paged fetches", async () => {
    for (const [mode, responseStatus] of [
      ["partial-after-page", 500],
      ["hard-error", 500],
      ["github-rate-limit", 403],
    ] as const) {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      await seedRegisteredRepo(env);
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 2, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 0 });
        if (url.includes("/issues?") && mode === "partial-after-page" && new URL(url).searchParams.get("page") === "1") {
          return Response.json([{ number: 1, title: "Issue 1", state: "open", user: { login: "reporter" }, labels: [], body: "" }], {
            headers: { link: '<https://api.github.com/repositories/1/issues?page=2>; rel="next"' },
          });
        }
        if (url.includes("/issues?")) {
          return new Response(mode, {
            status: responseStatus,
            headers:
              responseStatus === 403
                ? {
                    "x-ratelimit-limit": "5000",
                    "x-ratelimit-remaining": "0",
                    "x-ratelimit-reset": "1780000000",
                  }
                : {},
          });
        }
        return new Response("not found", { status: 404 });
      });

      const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_issues", mode: "full", force: true });

      if (mode === "partial-after-page") expect(result).toMatchObject({ status: "partial", fetchedCount: 1 });
      if (mode === "hard-error") expect(result).toMatchObject({ status: "error", fetchedCount: 0 });
      if (mode === "github-rate-limit") expect(result).toMatchObject({ status: "waiting_rate_limit", fetchedCount: 0 });
    }
  });

  it("supplements REST undercounts from sparse GraphQL open-data payloads", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        const query = JSON.parse(String(init?.body ?? "{}")).query as string;
        if (query.includes("GittensoryRepoTotals")) {
          return githubTotalsResponse({ openIssues: 2, openPullRequests: 2, mergedPullRequests: 0, closedPullRequests: 0, labels: 0 });
        }
        if (query.includes("GittensoryOpenIssuesSupplement") && query.includes("after:")) {
          return Response.json({ data: { repository: { issues: undefined } } });
        }
        if (query.includes("GittensoryOpenIssuesSupplement")) {
          return Response.json({
            data: {
              repository: {
                issues: {
                  pageInfo: { hasNextPage: true, endCursor: "issue-cursor" },
                  nodes: [
                    null,
                    {
                      number: 201,
                      title: null,
                      state: null,
                      url: null,
                      createdAt: undefined,
                      updatedAt: undefined,
                      author: null,
                      body: undefined,
                      labels: { nodes: [null, { name: "bug" }] },
                    },
                  ],
                },
              },
            },
          });
        }
        if (query.includes("GittensoryOpenPullRequestsSupplement") && query.includes("after:")) {
          return Response.json({ data: { repository: { pullRequests: undefined } } });
        }
        if (query.includes("GittensoryOpenPullRequestsSupplement")) {
          return Response.json({
            data: {
              repository: {
                pullRequests: {
                  pageInfo: { hasNextPage: true, endCursor: "pr-cursor" },
                  nodes: [
                    null,
                    {
                      number: 301,
                      title: null,
                      state: null,
                      url: null,
                      createdAt: undefined,
                      updatedAt: undefined,
                      body: undefined,
                      isDraft: undefined,
                      mergeable: undefined,
                      reviewDecision: undefined,
                      author: null,
                      authorAssociation: null,
                      headRefOid: undefined,
                      headRefName: undefined,
                      baseRefName: undefined,
                      labels: { nodes: [null, { name: "bug" }] },
                    },
                  ],
                },
              },
            },
          });
        }
      }
      if (url.includes("/issues?") || url.includes("/pulls?state=open")) return Response.json([]);
      return Response.json([]);
    });

    const issuesResult = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_issues", mode: "full", force: true });
    const pullRequestsResult = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_pull_requests", mode: "full", force: true });

    expect(issuesResult).toMatchObject({ status: "partial", fetchedCount: 1, expectedCount: 2 });
    expect(pullRequestsResult).toMatchObject({ status: "partial", fetchedCount: 1, expectedCount: 2 });
    expect(await listIssues(env, "JSONbored/gittensory")).toEqual(expect.arrayContaining([expect.objectContaining({ number: 201, title: "Issue #201", labels: ["bug"] })]));
    expect(await listPullRequests(env, "JSONbored/gittensory")).toEqual(expect.arrayContaining([expect.objectContaining({ number: 301, title: "Pull request #301", labels: ["bug"] })]));
  });

  it("keeps unauthenticated open-data undercounts partial when GraphQL supplements are unavailable", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env);
    await env.DB.prepare(
      `insert into repo_github_totals_snapshots (
        id, repo_full_name, open_issues_total, open_pull_requests_total, merged_pull_requests_total,
        closed_unmerged_pull_requests_total, labels_total, source_kind, fetched_at, payload_json
      ) values ('totals-unauth', 'JSONbored/gittensory', 1, 1, 0, 0, 0, 'github', '2026-05-25T00:00:00.000Z', '{}')`,
    ).run();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      expect(url).not.toBe("https://api.github.com/graphql");
      if (url.includes("/issues?") || url.includes("/pulls?state=open")) return Response.json([]);
      return Response.json([]);
    });

    const issuesResult = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_issues", mode: "full", force: true });
    const pullRequestsResult = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_pull_requests", mode: "full", force: true });

    expect(issuesResult).toMatchObject({ status: "partial", fetchedCount: 0, expectedCount: 1 });
    expect(pullRequestsResult).toMatchObject({ status: "partial", fetchedCount: 0, expectedCount: 1 });
    expect(issuesResult.warnings.join("\n")).toContain("below expected total");
    expect(pullRequestsResult.warnings.join("\n")).toContain("below expected total");
  });

  it("skips missing repositories and preserves segment progress while waiting for rate-limit recovery", async () => {
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });

    await expect(backfillRepositorySegment(env, { repoFullName: "missing/repo", segment: "labels" })).resolves.toMatchObject({
      status: "skipped",
      fetchedCount: 0,
      warnings: ["Repository was not found."],
    });
    await expect(backfillOpenPullRequestDetails(env, { repoFullName: "missing/repo" })).resolves.toMatchObject({
      status: "skipped",
      processed: 0,
      warnings: ["Repository was not found."],
    });

    await seedRegisteredRepo(env);
    await upsertRepoSyncSegment(env, {
      repoFullName: "JSONbored/gittensory",
      segment: "labels",
      status: "partial",
      sourceKind: "github",
      mode: "resume",
      fetchedCount: 7,
      expectedCount: 20,
      pageCount: 2,
      nextCursor: "3",
      completedAt: "2026-05-24T00:00:00.000Z",
      warnings: ["previous partial"],
    });
    await recordGitHubRateLimitObservation(env, {
      repoFullName: "JSONbored/gittensory",
      // Registry-only repo (no installation), so tokenForRepo resolves to the shared public token and
      // repoAdmissionKeyForToken scopes to that bucket (#audit-rate-scoping).
      admissionKey: "public-token",
      resource: "rest",
      path: "/labels",
      statusCode: 200,
      remaining: 0,
      resetAt: "2999-01-01T00:00:00.000Z",
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", requestedBy: "schedule", mode: "resume", cursor: "4" });

    expect(result).toMatchObject({ status: "waiting_rate_limit", fetchedCount: 7, expectedCount: 20, nextCursor: "3" });
    expect(sent).toEqual([
      {
        message: expect.objectContaining({ type: "backfill-repo-segment", requestedBy: "schedule", repoFullName: "JSONbored/gittensory", segment: "labels", mode: "resume", force: true }),
        options: { delaySeconds: 900 },
      },
    ]);
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ segment: "labels", status: "waiting_rate_limit", fetchedCount: 7, expectedCount: 20, pageCount: 2, nextCursor: "3" }),
      ]),
    );

    const freshWaitEnv = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(freshWaitEnv);
    await recordGitHubRateLimitObservation(freshWaitEnv, {
      repoFullName: "JSONbored/gittensory",
      // Registry-only repo (no installation), so tokenForRepo resolves to the shared public token and
      // repoAdmissionKeyForToken scopes to that bucket (#audit-rate-scoping).
      admissionKey: "public-token",
      resource: "rest",
      path: "/labels",
      statusCode: 200,
      remaining: 0,
      resetAt: "2999-01-01T00:00:00.000Z",
    });
    const freshWait = await backfillRepositorySegment(freshWaitEnv, { repoFullName: "JSONbored/gittensory", segment: "open_pull_requests", mode: "light" });
    expect(freshWait).toMatchObject({ status: "waiting_rate_limit", fetchedCount: 0 });
    expect(await listRepoSyncSegments(freshWaitEnv, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ segment: "open_pull_requests", status: "waiting_rate_limit", fetchedCount: 0, pageCount: 0 })]),
    );
  });

  it("uses cached totals and unauthenticated segment fallback when no GitHub token is available", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env);
    await env.DB.prepare(
      `insert into repo_github_totals_snapshots (
        id, repo_full_name, open_issues_total, open_pull_requests_total, merged_pull_requests_total,
        closed_unmerged_pull_requests_total, labels_total, source_kind, fetched_at, payload_json
      ) values ('totals-1', 'JSONbored/gittensory', 0, 0, 0, 0, 0, 'github', '2026-05-25T00:00:00.000Z', '{}')`,
    ).run();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      expect(url).toContain("/labels?");
      return Response.json([]);
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "light" });

    expect(result).toMatchObject({ status: "complete", fetchedCount: 0, expectedCount: 0 });
  });

  it("reconciles stale open issue rows after complete open-data crawls", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertIssueFromGitHub(
      env,
      "JSONbored/gittensory",
      { number: 99, title: "Previously open", state: "open", user: { login: "reporter" }, labels: [], body: "" },
      { seenOpenAt: "2026-05-20T00:00:00.000Z" },
    );
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 0 });
      if (url.includes("/issues?")) return Response.json([]);
      return Response.json([]);
    });

    const result = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_issues", mode: "full", force: true });

    expect(result).toMatchObject({ status: "complete", fetchedCount: 0 });
    expect(result.warnings.join(" ")).toMatch(/Marked 1 stale open issue row/);
    expect(await listIssues(env, "JSONbored/gittensory")).toEqual([expect.objectContaining({ number: 99, state: "closed" })]);
  });

  it("backs off PR detail hydration under low REST rate limit", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(env);
    await recordGitHubRateLimitObservation(env, {
      repoFullName: "JSONbored/gittensory",
      // Registry-only repo (no installation), so tokenForRepo resolves to the shared public token and
      // repoAdmissionKeyForToken scopes to that bucket (#audit-rate-scoping).
      admissionKey: "public-token",
      resource: "rest",
      path: "/pulls/1/files",
      statusCode: 200,
      remaining: 0,
      resetAt: "2999-01-01T00:00:00.000Z",
    });

    const result = await backfillOpenPullRequestDetails(env, { repoFullName: "JSONbored/gittensory", mode: "resume", cursor: 4 });

    expect(result).toMatchObject({ status: "waiting_rate_limit", processed: 0 });
    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: "backfill-pr-details", mode: "resume", cursor: 4 })]));
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ segment: "pull_request_files", status: "waiting_rate_limit" })]),
    );
  });

  it("defaults PR detail retry cursors when rate-limit recovery starts without prior state", async () => {
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(env);
    await recordGitHubRateLimitObservation(env, {
      repoFullName: "JSONbored/gittensory",
      // Registry-only repo (no installation), so tokenForRepo resolves to the shared public token and
      // repoAdmissionKeyForToken scopes to that bucket (#audit-rate-scoping).
      admissionKey: "public-token",
      resource: "rest",
      path: "/pulls",
      statusCode: 200,
      remaining: 0,
      resetAt: "2999-01-01T00:00:00.000Z",
    });

    const result = await backfillOpenPullRequestDetails(env, { repoFullName: "JSONbored/gittensory", mode: "light" });

    expect(result).toMatchObject({ status: "waiting_rate_limit", processed: 0 });
    expect(sent).toEqual([{ message: expect.objectContaining({ type: "backfill-pr-details", repoFullName: "JSONbored/gittensory", mode: "light", cursor: 0 }), options: { delaySeconds: 900 } }]);
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ segment: "pull_request_files", status: "waiting_rate_limit", fetchedCount: 0, pageCount: 0 })]),
    );
  });

  it("uses installation source for queued segment jobs and sparse live installation fallback metadata", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await seedRegisteredRepo(env);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "read", issues: "write" },
        events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
      },
    });
    await upsertRepositoryFromGitHub(
      env,
      { name: "gittensory", full_name: "JSONbored/gittensory", private: true, default_branch: "main", owner: { login: "JSONbored" } },
      123,
    );
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/app/installations/123")) return Response.json({ id: 123 });
      if (url === "https://api.github.com/graphql") {
        return Response.json({
          data: {
            rateLimit: {},
            repository: {
              issues: {},
              openPullRequests: {},
              mergedPullRequests: {},
              closedPullRequests: {},
              labels: {},
            },
          },
        });
      }
      if (url.includes("/labels?")) return Response.json([]);
      return Response.json([]);
    });

    const queued = await enqueueRepositoryOpenDataBackfill(env, { repoFullName: "JSONbored/gittensory", requestedBy: "api", mode: "resume" });
    const segment = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "resume", force: true });
    const details = await backfillOpenPullRequestDetails(env, { repoFullName: "JSONbored/gittensory", mode: "resume" });
    const health = await refreshInstallationHealth(env);

    expect(queued).toMatchObject({ status: "queued", totals: { sourceKind: "installation", openIssuesTotal: 0, openPullRequestsTotal: 0, labelsTotal: 0 } });
    expect(segment).toMatchObject({ status: "complete", fetchedCount: 0, expectedCount: 0 });
    expect(details).toMatchObject({ status: "complete", processed: 0 });
    expect(health.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          installationId: 123,
          accountLogin: "JSONbored",
          repositorySelection: "selected",
          status: "needs_attention",
          permissions: {},
          events: [],
          missingPermissions: ["metadata", "pull_requests", "issues"],
          missingEvents: ["issues", "issue_comment", "pull_request", "repository"],
        }),
      ]),
    );
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([expect.objectContaining({ segment: "labels", sourceKind: "installation" })]),
    );
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "backfill-repo-segment",
          segment: "labels",
          installationId: 123,
        }),
      ]),
    );
    const observations = await listLatestGitHubRateLimitObservations(env, 20);
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: "graphql",
          path: "/graphql",
          admissionKey: githubRateLimitAdmissionKeyForInstallation(123),
        }),
        expect.objectContaining({
          resource: "rest",
          path: "/labels?per_page=100&page=1",
          admissionKey: githubRateLimitAdmissionKeyForInstallation(123),
        }),
      ]),
    );
  });

  it("persists public-token admission keys for public backfill REST and GraphQL reads", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        return Response.json({
          data: {
            rateLimit: { remaining: 4999, resetAt: "2026-06-24T12:30:00.000Z" },
            repository: {
              issues: { totalCount: 0 },
              openPullRequests: { totalCount: 0 },
              mergedPullRequests: { totalCount: 0 },
              closedPullRequests: { totalCount: 0 },
              labels: { totalCount: 0 },
            },
          },
        });
      }
      if (url.includes("/labels?")) return Response.json([]);
      return Response.json([]);
    });

    await expect(backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "light" })).resolves.toMatchObject({
      status: "complete",
      fetchedCount: 0,
    });

    expect(await listLatestGitHubRateLimitObservations(env, 20)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: "graphql",
          path: "/graphql",
          admissionKey: githubRateLimitAdmissionKeyForPublicToken(),
        }),
        expect.objectContaining({
          resource: "rest",
          path: "/labels?per_page=100&page=1",
          admissionKey: githubRateLimitAdmissionKeyForPublicToken(),
        }),
      ]),
    );
  });

  it("uses the shared GraphQL cache for allowlisted totals reads without double-counting rate-limit observations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:05:00.000Z"));
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    const store = new Map<string, CachedGitHubResponse>();
    setGitHubResponseCache({
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => void store.set(key, value),
    });
    let graphQlFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        graphQlFetches += 1;
        return githubTotalsResponse({ openIssues: 0, openPullRequests: 0, mergedPullRequests: 0, closedPullRequests: 0, labels: 0 });
      }
      if (url.includes("/labels?")) return Response.json([]);
      return Response.json([]);
    });

    await persistTotalsSnapshot(env, { fetchedAt: "2026-05-24T23:40:00.000Z", labelsTotal: 0 });
    await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "light", force: true });
    await env.DB.prepare(`update repo_github_totals_snapshots set fetched_at = '2026-05-24T23:40:00.000Z' where repo_full_name = 'JSONbored/gittensory'`).run();
    await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", mode: "light", force: true });

    expect(graphQlFetches).toBe(1);
    expect([...store.keys()].some((key) => key.startsWith("gql:v1:"))).toBe(true);
    expect((await listLatestGitHubRateLimitObservations(env)).filter((observation) => observation.resource === "graphql")).toHaveLength(1);
  });

  it("records label rate limits, in-loop page caps, and expired rate observations", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await recordGitHubRateLimitObservation(env, {
      repoFullName: "JSONbored/gittensory",
      resource: "rest",
      path: "/old",
      statusCode: 200,
      remaining: 1,
      resetAt: "2020-01-01T00:00:00.000Z",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/repos/JSONbored/gittensory")) {
        return Response.json({ name: "gittensory", full_name: "JSONbored/gittensory", private: false, default_branch: "main", owner: { login: "JSONbored" } });
      }
      if (url.includes("/labels?")) {
        return new Response("label secondary limit", {
          status: 403,
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1780000000",
          },
        });
      }
      if (url.includes("/issues?") && new URL(url).searchParams.get("page") === "1") {
        return Response.json(
          Array.from({ length: 100 }, (_, index) => ({ number: index + 1, title: `Issue ${index + 1}`, state: "open", user: { login: "reporter" }, labels: [], body: "" })),
          { headers: { link: '<https://api.github.com/repositories/1/issues?page=2>; rel="next"', "x-ratelimit-remaining": "not-a-number" } },
        );
      }
      if (url.includes("/pulls?")) return Response.json([]);
      return Response.json([]);
    });

    const result = await backfillRegisteredRepositories(env, { force: true, limits: { issues: 100, pullRequests: 0, recentMergedPullRequests: 0, pullRequestDetails: 0 } });

    expect(result.repos[0]).toMatchObject({ status: "rate_limited", dataQuality: { capped: true, rateLimited: true, partial: true } });
    expect(result.repos[0]?.warnings.join("\n")).toMatch(/Label sync failed|local cap/);
    expect(await listRepoSyncSegments(env, "JSONbored/gittensory")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ segment: "labels", status: "rate_limited", rateLimitResetAt: "2026-05-28T20:26:40.000Z" }),
        expect.objectContaining({ segment: "open_issues", status: "capped", nextCursor: "2" }),
      ]),
    );
  });

  // FIX B: the review path uses this to fetch + persist a PR's files inline when the stored rows are still
  // empty (the PR-opened webhook beat the async detail-sync), so the FIRST AI review/grounding/comment sees
  // the real diff instead of "0 files".
});

// #5385: fetchLinkedIssueClosedByPullRequest was rewritten from a REST /issues/{n}/timeline read (which could
// never actually succeed -- GitHub's real "closed" timeline event carries no source.issue field, only
// cross-referenced events do) to GraphQL's Issue.timelineItems -> ClosedEvent.closer. These tests pin every
// branch of the new implementation, including the guard clauses and malformed-response shapes that didn't
// exist in the old REST version at all.
describe("fetchLinkedIssueClosedByPullRequest (#5385)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function closerBody(closer: { typename: string; number?: number } | null): unknown {
    return {
      data: {
        repository: {
          issue: {
            timelineItems: {
              nodes: closer === null ? [] : [{ __typename: "ClosedEvent", closer: { __typename: closer.typename, ...(closer.number !== undefined ? { number: closer.number } : {}) } }],
            },
          },
        },
      },
    };
  }

  it("returns fetch_error without ever calling fetch when no token is available", async () => {
    const env = createTestEnv({});
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchLinkedIssueClosedByPullRequest(env, "owner/repo", 100, 200, undefined);
    expect(result).toBe("fetch_error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns fetch_error without ever calling fetch for a malformed repoFullName (no owner/name split)", async () => {
    const env = createTestEnv({});
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await fetchLinkedIssueClosedByPullRequest(env, "", 100, 200, "test-token")).toBe("fetch_error");
    expect(await fetchLinkedIssueClosedByPullRequest(env, "no-slash-repo", 100, 200, "test-token")).toBe("fetch_error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns fetch_error when GraphQL responds 200 OK with a top-level errors array (GitHub's REAL response shape for an unresolvable issue number, confirmed via gh api graphql)", async () => {
    const env = createTestEnv({});
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      input.toString() === "https://api.github.com/graphql"
        ? Response.json({ data: { repository: { issue: null } }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to an issue." }] })
        : new Response("not found", { status: 404 }),
    );
    const result = await fetchLinkedIssueClosedByPullRequest(env, "owner/repo", 999999, 200, "test-token");
    expect(result).toBe("fetch_error");
  });

  it("returns fetch_error when timelineItems.nodes is missing/non-array (malformed response, no top-level errors)", async () => {
    const env = createTestEnv({});
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      input.toString() === "https://api.github.com/graphql"
        ? Response.json({ data: { repository: { issue: { timelineItems: {} } } } })
        : new Response("not found", { status: 404 }),
    );
    const result = await fetchLinkedIssueClosedByPullRequest(env, "owner/repo", 100, 200, "test-token");
    expect(result).toBe("fetch_error");
  });

  it("returns fetch_error when the GraphQL request itself throws (network failure)", async () => {
    const env = createTestEnv({});
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const result = await fetchLinkedIssueClosedByPullRequest(env, "owner/repo", 100, 200, "test-token");
    expect(result).toBe("fetch_error");
  });

  it("returns closed_by_pull_request when the closer is a matching PullRequest", async () => {
    const env = createTestEnv({});
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      input.toString() === "https://api.github.com/graphql" ? Response.json(closerBody({ typename: "PullRequest", number: 200 })) : new Response("not found", { status: 404 }),
    );
    expect(await fetchLinkedIssueClosedByPullRequest(env, "owner/repo", 100, 200, "test-token")).toBe("closed_by_pull_request");
  });

  it("returns not_closed_by_pull_request when the closer is a DIFFERENT PullRequest (anti-spoofing)", async () => {
    const env = createTestEnv({});
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      input.toString() === "https://api.github.com/graphql" ? Response.json(closerBody({ typename: "PullRequest", number: 999 })) : new Response("not found", { status: 404 }),
    );
    expect(await fetchLinkedIssueClosedByPullRequest(env, "owner/repo", 100, 200, "test-token")).toBe("not_closed_by_pull_request");
  });

  it("returns not_closed_by_pull_request when the issue was closed manually with no closer at all (confirmed live shape via gh api graphql against JSONbored/gittensory#5130: closer: null)", async () => {
    const env = createTestEnv({});
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      input.toString() === "https://api.github.com/graphql"
        ? Response.json({ data: { repository: { issue: { timelineItems: { nodes: [{ __typename: "ClosedEvent", closer: null }] } } } } })
        : new Response("not found", { status: 404 }),
    );
    expect(await fetchLinkedIssueClosedByPullRequest(env, "owner/repo", 100, 200, "test-token")).toBe("not_closed_by_pull_request");
  });

  it("returns not_closed_by_pull_request when the closer is a Commit, not a PullRequest (issue closed via a commit message reference)", async () => {
    const env = createTestEnv({});
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      input.toString() === "https://api.github.com/graphql" ? Response.json(closerBody({ typename: "Commit" })) : new Response("not found", { status: 404 }),
    );
    expect(await fetchLinkedIssueClosedByPullRequest(env, "owner/repo", 100, 200, "test-token")).toBe("not_closed_by_pull_request");
  });

  it("returns not_closed_by_pull_request when there is no CLOSED_EVENT at all (nodes is an empty array)", async () => {
    const env = createTestEnv({});
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      input.toString() === "https://api.github.com/graphql" ? Response.json(closerBody(null)) : new Response("not found", { status: 404 }),
    );
    expect(await fetchLinkedIssueClosedByPullRequest(env, "owner/repo", 100, 200, "test-token")).toBe("not_closed_by_pull_request");
  });
});
