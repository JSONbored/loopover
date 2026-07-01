import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
  upsertRepoSyncSegment,
  upsertRepoSyncState,
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
  fetchLiveCiAggregate,
  fetchLiveReviewThreadBlockers,
  fetchRequiredStatusContexts,
  isOwnReviewThreadAuthor,
  isRateLimitedGitHubFailure,
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
import { createTestEnv } from "../helpers/d1";

describe("GitHub backfill", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearGitHubResponseCacheForTest();
    vi.unstubAllGlobals();
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
            issueCount: 2,
            nodes: [{ __typename: "PullRequest", updatedAt: "2026-04-01T00:00:00Z", labels: { nodes: [{ name: "ci" }] }, body: "" }],
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
      { repoFullName: "JSONbored/gittensory", pullRequests: 50, mergedPullRequests: 47, openPullRequests: 2, issues: 12, unlinkedPullRequests: 1 },
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
    });

    expect(repair.repairSteps).toEqual(["No repair needed."]);
    expect(repair.requiredPermissions).not.toHaveProperty("checks");
    expect(repair.requiredPermissions.pull_requests).toBe("read"); // non-acting → baseline read, NOT upgraded to write
    expect(repair.modeImpacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mode: "comment", enabled: false, affectedRepoCount: 0, action: "No change needed." }),
        expect.objectContaining({ mode: "label", enabled: false, affectedRepoCount: 0, action: "No change needed." }),
        expect.objectContaining({ mode: "check_run", enabled: false, affectedRepoCount: 0, requiredPermissions: [expect.objectContaining({ optional: true })] }),
      ]),
    );
  });

  it("repair diagnostics upgrade pull_requests to write for an acting autonomy (#audit-install-health display)", async () => {
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
      missingPermissions: ["pull_requests"],
      missingEvents: [],
      permissions: { metadata: "read", pull_requests: "read", issues: "write" },
      events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
      checkedAt: "2026-05-28T00:00:00.000Z",
    });

    expect(repair.requiredPermissions.pull_requests).toBe("write");
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
      privateTrustEnabled: true,
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
      privateTrustEnabled: true,
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
      privateTrustEnabled: true,
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
  describe("fetchAndStorePullRequestFilesForReview", () => {
    it("fetches the PR's files from GitHub, persists them, and returns the records", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/pulls/42/files")) {
          return Response.json([
            { filename: "src/foo.ts", status: "modified", additions: 9, deletions: 2, changes: 11, patch: "@@ -1 +1 @@\n-old\n+new" },
            { filename: "README.md", status: "added", additions: 1, deletions: 0, changes: 1 },
          ]);
        }
        return new Response("not found", { status: 404 });
      });

      const records = await fetchAndStorePullRequestFilesForReview(env, "JSONbored/gittensory", 42, "public-token");
      expect(records.map((r) => r.path)).toEqual(["src/foo.ts", "README.md"]);
      expect(records[0]).toMatchObject({ path: "src/foo.ts", additions: 9, deletions: 2, status: "modified" });
      // Persisted: a subsequent stored read returns them (so the rest of the review run reuses them).
      const stored = await listPullRequestFiles(env, "JSONbored/gittensory", 42);
      expect(stored.map((r) => r.path).sort()).toEqual(["README.md", "src/foo.ts"]);
    });

    it("returns [] (and persists nothing) when GitHub returns no files — never throws", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async () => Response.json([]));
      const records = await fetchAndStorePullRequestFilesForReview(env, "JSONbored/gittensory", 7, "public-token");
      expect(records).toEqual([]);
      expect(await listPullRequestFiles(env, "JSONbored/gittensory", 7)).toEqual([]);
    });

    it("is fail-safe: a failed REST+GraphQL fetch returns [] rather than throwing", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
      await expect(fetchAndStorePullRequestFilesForReview(env, "JSONbored/gittensory", 99, "public-token")).resolves.toEqual([]);
    });
  });

  describe("fetchLiveCiAggregate", () => {
    it("reports unverified without fetching when the head SHA is missing", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", null, "public-token", null);

      expect(aggregate).toEqual({ ciState: "unverified", hasPending: false, hasVisiblePending: false, failingDetails: [], nonRequiredFailingDetails: [] });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("fails completed non-required red checks while still reporting optional pending visibility", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({
            check_runs: [
              { name: "trusted-required-ci", status: "completed", conclusion: "success" },
              { name: "attacker/non-required-check", status: "completed", conclusion: "failure", output: { title: "Injected failure" } },
              { name: "attacker/non-required-pending-check", status: "queued", conclusion: null },
            ],
          });
        }
        if (url.includes("/status?")) {
          return Response.json({
            statuses: [
              { context: "trusted-required-ci", state: "success" },
              { context: "attacker/non-required-status", state: "failure", description: "Injected failure" },
              { context: "attacker/non-required-pending", state: "pending", description: "Never settles" },
            ],
          });
        }
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", new Set(["trusted-required-ci"]));

      expect(aggregate.ciState).toBe("failed");
      expect(aggregate.hasPending).toBe(true);
      expect(aggregate.hasVisiblePending).toBe(true);
      expect(aggregate.failingDetails.map((detail) => detail.name).sort()).toEqual(["attacker/non-required-check", "attacker/non-required-status"]);
      expect(aggregate.nonRequiredFailingDetails).toEqual([]);
    });

    it("treats a visible required classic status that is still pending as pending CI", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({
            check_runs: [
              { name: "lint", status: "completed", conclusion: "success" },
            ],
          });
        }
        if (url.includes("/status?")) {
          return Response.json({
            statuses: [
              { context: "codecov/patch", state: "pending", description: "Waiting for report" },
              { context: "lint", state: "success" },
            ],
          });
        }
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(
        env,
        "JSONbored/gittensory",
        "abc123",
        "public-token",
        new Set(["codecov/patch", "lint"]),
      );

      expect(aggregate.ciState).toBe("pending");
      expect(aggregate.hasPending).toBe(true);
      expect(aggregate.hasVisiblePending).toBe(true);
      expect(aggregate.failingDetails).toEqual([]);
    });

    it("keeps an observed failure failed while still reporting pending CI separately", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({
            check_runs: [
              { name: "test", status: "completed", conclusion: "failure", output: { title: "Test failed" } },
              { name: "coverage", status: "in_progress", conclusion: null },
            ],
          });
        }
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);

      expect(aggregate.ciState).toBe("failed");
      expect(aggregate.hasPending).toBe(true);
      expect(aggregate.failingDetails).toEqual([expect.objectContaining({ name: "test" })]);
    });

    it("falls back to gating all contexts when required contexts are unavailable", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [] });
        if (url.includes("/status?")) return Response.json({ statuses: [{ context: "unknown-required-status", state: "failure", description: "Could be required" }] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);

      expect(aggregate.ciState).toBe("failed");
      expect(aggregate.failingDetails).toEqual([expect.objectContaining({ name: "unknown-required-status" })]);
      expect(aggregate.nonRequiredFailingDetails).toEqual([]);
    });

    it("ignores ALL of the bot's OWN checks (Gate + Context) so it never self-deadlocks (#gate-self-deadlock)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({
            check_runs: [
              { name: "test", status: "completed", conclusion: "success" },
              // BOTH bot-posted checks, still in_progress (posted but not yet concluded). Counting EITHER would
              // defer the very review that concludes it — the self-deadlock that froze green-CI PRs as "CI pending".
              { name: "Gittensory Orb Review Agent", status: "in_progress", conclusion: null, app: { slug: "gittensory" } },
              { name: "Gittensory Gate", status: "in_progress", conclusion: null, app: { slug: "gittensory" } },
              { name: "Gittensory Context", status: "in_progress", conclusion: null, app: { slug: "gittensory" } },
            ],
          });
        }
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        return new Response("not found", { status: 404 });
      });

      // Both bot checks are excluded from the CI wait even if listed among the required contexts.
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/metagraphed", "headsha", "public-token", new Set(["test", "Gittensory Orb Review Agent", "Gittensory Gate", "Gittensory Context"]));

      expect(aggregate.ciState).toBe("passed"); // would be "pending" if either in_progress bot check were counted
      expect(aggregate.failingDetails).toEqual([]);
    });

    it("does not ignore same-named Gate check-runs from a different GitHub App", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({
            check_runs: [
              { name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
              { name: "Gittensory Orb Review Agent", status: "completed", conclusion: "failure", output: { title: "External gate failed" }, app: { slug: "external-ci" } },
            ],
          });
        }
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", new Set(["test", "Gittensory Orb Review Agent"]));

      expect(aggregate.ciState).toBe("failed");
      expect(aggregate.failingDetails).toEqual([expect.objectContaining({ name: "Gittensory Orb Review Agent", summary: "External gate failed" })]);
    });

    it("does not ignore classic statuses named like the Gate", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
        if (url.includes("/status?")) return Response.json({ statuses: [{ context: "Gittensory Orb Review Agent", state: "failure", description: "External status failed" }] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);

      expect(aggregate.ciState).toBe("failed");
      expect(aggregate.failingDetails).toEqual([expect.objectContaining({ name: "Gittensory Orb Review Agent", summary: "External status failed" })]);
    });

    it("treats a required context that never ran (absent from results) as pending, not passed", async () => {
      // Bypass: requiredContexts = {"validate"}, but CI only returns non-required checks (e.g. CodeQL). The
      // "validate" job never triggered (fork workflow skipped, matrix split, etc.). Without the absent-check
      // guard, total > 0 (CodeQL passed) → ciState = "passed" even though the required check never ran.
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({
            check_runs: [
              // Only non-required checks ran — "validate" is absent.
              { name: "CodeQL", status: "completed", conclusion: "success", app: { slug: "github-advanced-security" } },
              { name: "Superagent Security Scan", status: "completed", conclusion: "success", app: { slug: "superagent" } },
            ],
          });
        }
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", new Set(["validate"]));

      expect(aggregate.ciState).toBe("pending"); // required "validate" never ran — must not be "passed"
      expect(aggregate.failingDetails).toEqual([]);
    });

    it("keeps bot-owned required contexts as seen (not absent) even though they are excluded from gate logic", async () => {
      // The existing deadlock-avoidance test: bot-owned required contexts (Gate, Context) in in_progress are
      // skipped from gate logic, but seenContextNames must still mark them to avoid the absent-check guard
      // treating them as missing and re-introducing a false anyPending.
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({
            check_runs: [
              { name: "validate", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
              { name: "Gittensory Orb Review Agent", status: "in_progress", conclusion: null, app: { slug: "gittensory" } },
            ],
          });
        }
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "sha", "tok", new Set(["validate", "Gittensory Orb Review Agent"]));

      // "Gittensory Orb Review Agent" is a bot check: present in results (so not absent), excluded from gate logic → passed
      expect(aggregate.ciState).toBe("passed");
    });

    it("fold-all: a failed check-runs fetch with an otherwise-green status reads PENDING, not passed (fail-closed)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        // Transient check-runs fetch failure → githubJsonWithHeaders throws → caught → check set unread.
        if (url.includes("/check-runs?")) return new Response("upstream error", { status: 500 });
        if (url.includes("/status?")) return Response.json({ statuses: [{ context: "ci/green", state: "success" }] });
        return new Response("not found", { status: 404 });
      });
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);
      // Without the fail-closed degrade this would be "passed" (one green status, no failing) — the seam.
      expect(aggregate.ciState).toBe("pending");
      expect(aggregate.failingDetails).toEqual([]);
    });

    it("fold-all: a failed status fetch with an otherwise-green check-run reads PENDING, not passed (fail-closed)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "build", status: "completed", conclusion: "success" }] });
        if (url.includes("/status?")) return new Response("upstream error", { status: 500 });
        return new Response("not found", { status: 404 });
      });
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);
      expect(aggregate.ciState).toBe("pending");
    });

    it("fold-all: a GitHub-Actions workflow AWAITING APPROVAL (suite not completed) reads PENDING, not passed (#ci-foldall-checksuites / #1799)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        // A fork PR awaiting CI approval: the required workflow never ran → no check-RUNS for it; only the
        // always-on third-party checks posted (both pass) — the false-green seam.
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "Contributor trust", status: "completed", conclusion: "success", app: { slug: "superagent" } }] });
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        // …but the check-SUITES show the GitHub-Actions workflow as `requested` (queued, awaiting approval).
        if (url.includes("/check-suites?"))
          return Response.json({
            check_suites: [
              { status: "requested", app: { slug: "github-actions" } },
              { status: "completed", app: { slug: "superagent" } },
            ],
          });
        return new Response("not found", { status: 404 });
      });
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/metagraphed", "forksha", "public-token", null);
      // Without this hardening the always-on passes alone read "passed" → a false-green approve. Now: pending → held.
      expect(aggregate.ciState).toBe("pending");
    });

    it("fold-all: all GitHub-Actions suites COMPLETED → still passed (no false-pending)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "completed", app: { slug: "github-actions" } }] });
        return new Response("not found", { status: 404 });
      });
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);
      expect(aggregate.ciState).toBe("passed");
    });

    it("fold-all: waits for the required validate aggregate after its prerequisites settle", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?"))
          return Response.json({
            check_runs: [
              { name: "CI / changes", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
              { name: "CI / validate-code", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
              { name: "CI / security", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
            ],
          });
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "completed", app: { slug: "github-actions" } }] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);

      expect(aggregate.ciState).toBe("pending");
      expect(aggregate.hasPending).toBe(true);
      expect(aggregate.hasVisiblePending).toBe(false);
      expect(aggregate.failingDetails).toEqual([]);
    });

    it("fold-all: passes once the validate aggregate check exists", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?"))
          return Response.json({
            check_runs: [
              { name: "changes", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
              { name: "validate-code", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
              { name: "security", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
              { name: "validate", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
            ],
          });
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "completed", app: { slug: "github-actions" } }] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);

      expect(aggregate.ciState).toBe("passed");
      expect(aggregate.hasPending).toBe(false);
      expect(aggregate.hasVisiblePending).toBe(false);
    });

    it("fold-all: an UNREADABLE check-suites read with NO first-party check-run reads PENDING, not passed (#review-audit / #1799)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        // Fork PR awaiting approval: only an always-on third-party status; NO first-party GitHub-Actions check-run.
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "license/cla", status: "completed", conclusion: "success", app: { slug: "cla-bot" } }] });
        if (url.includes("/status?")) return Response.json({ statuses: [{ context: "license/cla", state: "success" }] });
        if (url.includes("/check-suites?")) return new Response("forbidden", { status: 403 }); // same missing admin:read that forced fold-all
        return new Response("not found", { status: 404 });
      });
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/metagraphed", "forksha", "public-token", null);
      // The suites backstop is unreadable AND no first-party run was seen → cannot confirm CI ran → fail closed.
      expect(aggregate.ciState).toBe("pending");
    });

    it("fold-all: an UNREADABLE check-suites read still reads PASSED when a first-party check-run was seen (no over-pending)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        // A real (non-fork) PR: the GitHub-Actions workflow ran and passed (a first-party check-run is present).
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        if (url.includes("/check-suites?")) return new Response("forbidden", { status: 403 });
        return new Response("not found", { status: 404 });
      });
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);
      expect(aggregate.ciState).toBe("passed"); // a first-party run was observed and passed; do not over-pend
    });

    it("fold-all: a non-completed THIRD-PARTY suite is ignored (only first-party GitHub-Actions suites gate)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        // A third-party app's suite is perpetually "queued" — must NOT pend the gate (only github-actions counts).
        if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "completed", app: { slug: "github-actions" } }, { status: "queued", app: { slug: "some-other-app" } }] });
        return new Response("not found", { status: 404 });
      });
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);
      expect(aggregate.ciState).toBe("passed");
    });

    it("ENFORCE-required mode waits when the GitHub Actions suite is still materializing downstream jobs", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      let suitesFetched = false;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-suites?")) {
          suitesFetched = true;
          return Response.json({ check_suites: [{ status: "in_progress", app: { slug: "github-actions" } }] });
        }
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "test", status: "completed", conclusion: "success" }] });
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        return new Response("not found", { status: 404 });
      });
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", new Set(["test"]));
      expect(aggregate.ciState).toBe("pending");
      expect(aggregate.hasPending).toBe(true);
      expect(suitesFetched).toBe(true);
    });

    it("ENFORCE-required mode does not over-pend when check-suites are unreadable after required checks passed", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        if (url.includes("/check-suites?")) return new Response("forbidden", { status: 403 });
        return new Response("not found", { status: 404 });
      });
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", new Set(["test"]));
      expect(aggregate.ciState).toBe("passed");
      expect(aggregate.hasPending).toBe(false);
    });

    it("fold-all: tolerates malformed check-suites (missing app / missing status) without throwing", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "ci", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        if (url.includes("/check-suites?"))
          return Response.json({
            check_suites: [
              { status: "completed" }, // no app → app?.slug ?? "" = "" → not github-actions → ignored
              { app: { slug: "github-actions" } }, // no status → status ?? "" = "" → not "completed" → pending
            ],
          });
        return new Response("not found", { status: 404 });
      });
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);
      // The status-less github-actions suite is treated as not-completed (safe direction) → pending.
      expect(aggregate.ciState).toBe("pending");
    });

    it("an observed required failure stays FAILED even when a later check-runs page fetch fails", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?") && url.includes("&page=1")) {
          return Response.json(
            { check_runs: [{ name: "build", status: "completed", conclusion: "failure", output: { title: "boom" } }] },
            { headers: { link: '<https://api.github.com/repos/x/y/commits/abc/check-runs?page=2>; rel="next"' } },
          );
        }
        if (url.includes("/check-runs?")) return new Response("upstream error", { status: 500 }); // page 2 fails → incomplete
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        return new Response("not found", { status: 404 });
      });
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);
      // Incomplete visibility does NOT override an authoritative observed failure.
      expect(aggregate.ciState).toBe("failed");
      expect(aggregate.failingDetails).toEqual([expect.objectContaining({ name: "build" })]);
    });

    it("reports unverified when both CI sources succeed but return no checks at all", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [] });
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        return new Response("not found", { status: 404 });
      });
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);
      expect(aggregate.ciState).toBe("unverified");
    });

    it("treats a status response with no statuses field as empty (nullish-coalesce branch)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "build", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
        if (url.includes("/status?")) return Response.json({}); // no `statuses` key → exercises `?? []`
        if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "completed", app: { slug: "github-actions" } }] });
        return new Response("not found", { status: 404 });
      });
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);
      expect(aggregate.ciState).toBe("passed");
    });

    it("paginates commit-statuses so a failing status beyond page 1 is not silently dropped", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [] });
        if (url.includes("/status?") && url.includes("&page=1")) {
          return Response.json(
            { statuses: [{ context: "ci/green", state: "success" }] },
            { headers: { link: '<https://api.github.com/repos/x/y/commits/abc/status?page=2>; rel="next"' } },
          );
        }
        if (url.includes("/status?")) return Response.json({ statuses: [{ context: "ci/overflow", state: "failure", description: "page-2 failure" }] });
        return new Response("not found", { status: 404 });
      });
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);
      expect(aggregate.ciState).toBe("failed");
      expect(aggregate.failingDetails).toEqual([expect.objectContaining({ name: "ci/overflow" })]);
    });

  });

  describe("fetchLiveReviewThreadBlockers", () => {
    it("returns unresolved non-outdated scanner review threads as blockers", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (input.toString() === "https://api.github.com/graphql") {
          return Response.json({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        isResolved: false,
                        isOutdated: false,
                        path: "src/signals/redaction.ts",
                        line: 30,
                        comments: {
                          nodes: [
                            {
                              body: "<!-- brin-pr-finding -->\n**P1:** PUBLIC_LOCAL_PATH_INLINE regex fails to match Windows backslash paths",
                              url: "https://github.example/thread",
                              author: { login: "superagent-security[bot]" },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          });
        }
        return new Response("not found", { status: 404 });
      });

      const blockers = await fetchLiveReviewThreadBlockers(env, "JSONbored/gittensory", 1748, "public-token");

      expect(blockers).toEqual([
        expect.objectContaining({
          title: "PUBLIC_LOCAL_PATH_INLINE regex fails to match Windows backslash paths",
          priority: "P1",
          path: "src/signals/redaction.ts",
          line: 30,
          authorLogin: "superagent-security[bot]",
          url: "https://github.example/thread",
          scannerFinding: true,
        }),
      ]);
    });

    it("only trusts exact scanner bot logins for scanner-authored review thread blockers", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (input.toString() !== "https://api.github.com/graphql") return new Response("not found", { status: 404 });
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/superagent.ts",
                      line: 10,
                      comments: { nodes: [{ body: "**P1:** Canonical Superagent blocker", author: { login: "superagent[bot]" }, authorAssociation: "NONE" }] },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/superagent-security.ts",
                      line: 20,
                      comments: { nodes: [{ body: "**P1:** Canonical Superagent Security blocker", author: { login: "superagent-security[bot]" }, authorAssociation: "NONE" }] },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/superagent-security-dev.ts",
                      line: 30,
                      comments: { nodes: [{ body: "**P1:** Canonical Superagent Security Dev blocker", author: { login: "SUPERAGENT-SECURITY-DEV[bot]" }, authorAssociation: "NONE" }] },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/brin.ts",
                      line: 40,
                      comments: { nodes: [{ body: "<!-- brin-pr-finding -->\n**P1:** Canonical Brin blocker", author: { login: "brin[bot]" }, authorAssociation: "NONE" }] },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/superagentsecurity.ts",
                      line: 50,
                      comments: { nodes: [{ body: "**P1:** Typosquat without separator", author: { login: "superagentsecurity[bot]" }, authorAssociation: "NONE" }] },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/superagent-evil.ts",
                      line: 60,
                      comments: { nodes: [{ body: "**P1:** Typosquat suffix", author: { login: "superagent-evil[bot]" }, authorAssociation: "NONE" }] },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/brin-security.ts",
                      line: 70,
                      comments: { nodes: [{ body: "<!-- brin-pr-finding -->\n**P1:** Brin suffix typosquat", author: { login: "brin-security[bot]" }, authorAssociation: "NONE" }] },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/missing-author.ts",
                      line: 80,
                      comments: { nodes: [{ body: "**P1:** Missing author cannot authorize", author: null }] },
                    },
                  ],
                },
              },
            },
          },
        });
      });

      const blockers = await fetchLiveReviewThreadBlockers(env, "JSONbored/gittensory", 1781, "public-token");

      expect(blockers.map((blocker) => blocker.title)).toEqual([
        "Canonical Superagent blocker",
        "Canonical Superagent Security blocker",
        "Canonical Superagent Security Dev blocker",
        "Canonical Brin blocker",
      ]);
      expect(blockers.map((blocker) => blocker.authorLogin)).toEqual(["superagent[bot]", "superagent-security[bot]", "SUPERAGENT-SECURITY-DEV[bot]", "brin[bot]"]);
      expect(blockers.map((blocker) => blocker.path)).toEqual(["src/superagent.ts", "src/superagent-security.ts", "src/superagent-security-dev.ts", "src/brin.ts"]);
    });

    it("paginates review threads so blockers beyond the first page cannot hide", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      const queries: string[] = [];
      const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input.toString() !== "https://api.github.com/graphql") return new Response("not found", { status: 404 });
        const query = JSON.parse(String(init?.body)).query as string;
        queries.push(query);
        if (!query.includes("after:")) {
          return Response.json({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [{ isResolved: true, isOutdated: false, path: "resolved.ts", line: 1, comments: { nodes: [{ body: "already resolved", author: { login: "superagent-security[bot]" } }] } }],
                    pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                  },
                },
              },
            },
          });
        }
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/hidden.ts",
                      line: 77,
                      comments: {
                        nodes: [
                          {
                            body: "**P0:** Hidden second-page review thread must block",
                            url: "https://github.example/thread/second-page",
                            author: { login: "superagent-security[bot]" },
                          },
                        ],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
                },
              },
            },
          },
        });
      });
      vi.stubGlobal("fetch", fetchSpy);

      const blockers = await fetchLiveReviewThreadBlockers(env, "JSONbored/gittensory", 1781, "public-token");

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(queries[0]).toContain("reviewThreads(first: 50)");
      expect(queries[1]).toContain('reviewThreads(first: 50, after: "cursor-1")');
      expect(blockers).toEqual([
        expect.objectContaining({
          title: "Hidden second-page review thread must block",
          priority: "P0",
          path: "src/hidden.ts",
          line: 77,
          url: "https://github.example/thread/second-page",
        }),
      ]);
    });

    it("stops review-thread pagination on a repeated cursor without dropping fetched blockers", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      let calls = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (input.toString() !== "https://api.github.com/graphql") return new Response("not found", { status: 404 });
        calls += 1;
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes:
                    calls === 1
                      ? []
                      : [
                          {
                            isResolved: false,
                            isOutdated: false,
                            path: "src/repeated-cursor.ts",
                            line: 9,
                            comments: { nodes: [{ body: "**P1:** Repeated cursor blocker", author: { login: "superagent-security[bot]" } }] },
                          },
                        ],
                  pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                },
              },
            },
          },
        });
      });

      const blockers = await fetchLiveReviewThreadBlockers(env, "JSONbored/gittensory", 1781, "public-token");

      expect(calls).toBe(2);
      expect(blockers).toEqual([
        expect.objectContaining({
          title: "Repeated cursor blocker",
          path: "src/repeated-cursor.ts",
          line: 9,
        }),
      ]);
    });

    it("keeps fetched review-thread blockers when a later page is malformed", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      let calls = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (input.toString() !== "https://api.github.com/graphql") return new Response("not found", { status: 404 });
        calls += 1;
        if (calls === 2) {
          return Response.json({ data: { repository: { pullRequest: { reviewThreads: null } } } });
        }
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/fetched-before-malformed-page.ts",
                      line: 14,
                      comments: { nodes: [{ body: "**P1:** Fetched blocker before malformed page", author: { login: "superagent-security[bot]" } }] },
                    },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                },
              },
            },
          },
        });
      });

      const blockers = await fetchLiveReviewThreadBlockers(env, "JSONbored/gittensory", 1781, "public-token");

      expect(calls).toBe(2);
      expect(blockers).toEqual([
        expect.objectContaining({
          title: "Fetched blocker before malformed page",
          path: "src/fetched-before-malformed-page.ts",
          line: 14,
        }),
      ]);
    });

    it("stops review-thread pagination when GitHub omits the next cursor", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        if (input.toString() !== "https://api.github.com/graphql") return new Response("not found", { status: 404 });
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/missing-cursor.ts",
                      line: 12,
                      comments: { nodes: [{ body: "**P2:** Missing cursor blocker", author: { login: "superagent-security[bot]" } }] },
                    },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: null },
                },
              },
            },
          },
        });
      });
      vi.stubGlobal("fetch", fetchSpy);

      const blockers = await fetchLiveReviewThreadBlockers(env, "JSONbored/gittensory", 1781, "public-token");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(blockers).toEqual([
        expect.objectContaining({
          title: "Missing cursor blocker",
          path: "src/missing-cursor.ts",
          line: 12,
        }),
      ]);
    });

    it("ignores unresolved review threads from untrusted public commenters", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (input.toString() !== "https://api.github.com/graphql") return new Response("not found", { status: 404 });
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/security.ts",
                      line: 42,
                      comments: {
                        nodes: [
                          {
                            body: "<!-- brin-pr-finding -->\n**P0:** Forged public blocker",
                            url: "https://github.example/thread/untrusted",
                            author: { login: "random-outsider" },
                            authorAssociation: "NONE",
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      });

      await expect(fetchLiveReviewThreadBlockers(env, "JSONbored/gittensory", 1781, "public-token")).resolves.toEqual([]);
    });

    it("verifies member review thread authors against live repository permissions", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      const permissionRequests: string[] = [];
      const permissionUrl = (login: string) => `https://api.github.com/repos/JSONbored/gittensory/collaborators/${login}/permission`;
      const permissionResponses = new Map<string, () => Response>([
        [permissionUrl("repo-maintainer"), () => Response.json({ permission: "maintain" })],
        [permissionUrl("repo-admin"), () => Response.json({ permission: "admin" })],
        [permissionUrl("repo-writer"), () => Response.json({ permission: "write" })],
        [permissionUrl("org-member"), () => Response.json({ permission: "read" })],
        [permissionUrl("member-lookup-fails"), () => new Response("permission unavailable", { status: 403 })],
      ]);
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        const permissionResponse = permissionResponses.get(url);
        if (permissionResponse) {
          permissionRequests.push(url);
          return permissionResponse();
        }
        if (url !== "https://api.github.com/graphql") return new Response("not found", { status: 404 });
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/maintainer-owner.ts",
                      line: 7,
                      comments: {
                        nodes: [
                          {
                            body: "Owner requested change",
                            url: "https://github.example/thread/owner",
                            author: { login: "repo-owner" },
                            authorAssociation: "OWNER",
                          },
                        ],
                      },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/maintainer-member.ts",
                      line: 8,
                      comments: {
                        nodes: [
                          {
                            body: "Maintainer requested change",
                            url: "https://github.example/thread/maintainer",
                            author: { login: "repo-maintainer" },
                            authorAssociation: "MEMBER",
                          },
                        ],
                      },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/maintainer-collaborator.ts",
                      line: 9,
                      comments: {
                        nodes: [
                          {
                            body: "Collaborator requested change",
                            url: "https://github.example/thread/collaborator",
                            author: { login: "repo-collaborator" },
                            authorAssociation: "COLLABORATOR",
                          },
                        ],
                      },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/scanner.ts",
                      line: 10,
                      comments: {
                        nodes: [
                          {
                            body: "Scanner requested change",
                            url: "https://github.example/thread/scanner",
                            author: { login: "superagent-security[bot]" },
                            authorAssociation: "NONE",
                          },
                        ],
                      },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/admin-member.ts",
                      line: 11,
                      comments: {
                        nodes: [
                          {
                            body: "Admin requested change",
                            url: "https://github.example/thread/admin",
                            author: { login: "repo-admin" },
                            authorAssociation: "MEMBER",
                          },
                        ],
                      },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/writer-member.ts",
                      line: 12,
                      comments: {
                        nodes: [
                          {
                            body: "Writer requested change",
                            url: "https://github.example/thread/writer",
                            author: { login: "repo-writer" },
                            authorAssociation: "MEMBER",
                          },
                        ],
                      },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/own-member.ts",
                      line: 13,
                      comments: {
                        nodes: [
                          {
                            body: "Own bot requested change",
                            url: "https://github.example/thread/own-member",
                            author: { login: "gittensory-orb[bot]" },
                            authorAssociation: "MEMBER",
                          },
                        ],
                      },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/maintainer-member-repeat.ts",
                      line: 14,
                      comments: {
                        nodes: [
                          {
                            body: "Maintainer repeated change",
                            url: "https://github.example/thread/maintainer-repeat",
                            author: { login: "repo-maintainer" },
                            authorAssociation: "MEMBER",
                          },
                        ],
                      },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/org-member.ts",
                      line: 15,
                      comments: {
                        nodes: [
                          {
                            body: "Org member requested change",
                            url: "https://github.example/thread/org-member",
                            author: { login: "org-member" },
                            authorAssociation: "MEMBER",
                          },
                        ],
                      },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/member-lookup-fails.ts",
                      line: 16,
                      comments: {
                        nodes: [
                          {
                            body: "Unverified member requested change",
                            url: "https://github.example/thread/member-lookup-fails",
                            author: { login: "member-lookup-fails" },
                            authorAssociation: "MEMBER",
                          },
                        ],
                      },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/member-missing-author.ts",
                      line: 17,
                      comments: {
                        nodes: [
                          {
                            body: "Member association with missing author",
                            url: "https://github.example/thread/member-missing-author",
                            author: null,
                            authorAssociation: "MEMBER",
                          },
                        ],
                      },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/member-blank-author.ts",
                      line: 18,
                      comments: {
                        nodes: [
                          {
                            body: "Member association with blank author",
                            url: "https://github.example/thread/member-blank-author",
                            author: { login: "   " },
                            authorAssociation: "MEMBER",
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      });

      await expect(fetchLiveReviewThreadBlockers(env, "JSONbored/gittensory", 1781, "public-token")).resolves.toEqual([
        expect.objectContaining({
          title: "Owner requested change",
          authorLogin: "repo-owner",
          scannerFinding: false,
        }),
        expect.objectContaining({
          title: "Maintainer requested change",
          authorLogin: "repo-maintainer",
          scannerFinding: false,
        }),
        expect.objectContaining({
          title: "Collaborator requested change",
          authorLogin: "repo-collaborator",
          scannerFinding: false,
        }),
        expect.objectContaining({
          title: "Scanner requested change",
          authorLogin: "superagent-security[bot]",
          scannerFinding: false,
        }),
        expect.objectContaining({
          title: "Admin requested change",
          authorLogin: "repo-admin",
          scannerFinding: false,
        }),
        expect.objectContaining({
          title: "Writer requested change",
          authorLogin: "repo-writer",
          scannerFinding: false,
        }),
        expect.objectContaining({
          title: "Maintainer repeated change",
          authorLogin: "repo-maintainer",
          scannerFinding: false,
        }),
      ]);
      expect(permissionRequests).toEqual([
        permissionUrl("repo-maintainer"),
        permissionUrl("repo-admin"),
        permissionUrl("repo-writer"),
        permissionUrl("org-member"),
        permissionUrl("member-lookup-fails"),
      ]);
    });

    it("ignores resolved, outdated, own-bot, and empty review threads", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (input.toString() === "https://api.github.com/graphql") {
          return Response.json({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      { isResolved: true, isOutdated: false, path: "a.ts", line: 1, comments: { nodes: [{ body: "resolved", author: { login: "superagent-security[bot]" } }] } },
                      { isResolved: false, isOutdated: true, path: "b.ts", line: 2, comments: { nodes: [{ body: "outdated", author: { login: "superagent-security[bot]" } }] } },
                      { isResolved: false, isOutdated: false, path: "c.ts", line: 3, comments: { nodes: [{ body: "own bot", author: { login: "gittensory-orb[bot]" }, authorAssociation: "OWNER" }] } },
                      { isResolved: false, isOutdated: false, path: "own-collaborator.ts", line: 5, comments: { nodes: [{ body: "own bot with collaborator association", author: { login: "gittensory[bot]" }, authorAssociation: "COLLABORATOR" }] } },
                      { isResolved: false, isOutdated: false, path: "no-comments.ts", line: 6, comments: null },
                      { isResolved: false, isOutdated: false, path: "d.ts", line: 4, comments: { nodes: [{ body: "   ", author: { login: "superagent-security[bot]" } }, null] } },
                      null,
                    ],
                  },
                },
              },
            },
          });
        }
        return new Response("not found", { status: 404 });
      });

      await expect(fetchLiveReviewThreadBlockers(env, "JSONbored/gittensory", 1, "public-token")).resolves.toEqual([]);
    });

    it("fails open without a token, malformed repo name, or GraphQL response", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      const fetchSpy = vi.fn(async () => new Response("boom", { status: 500 }));
      vi.stubGlobal("fetch", fetchSpy);

      await expect(fetchLiveReviewThreadBlockers(env, "JSONbored/gittensory", 1, undefined)).resolves.toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(fetchLiveReviewThreadBlockers(env, "malformed", 1, "public-token")).resolves.toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(fetchLiveReviewThreadBlockers(env, "JSONbored/gittensory", 1, "public-token")).resolves.toEqual([]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("fetchRequiredStatusContexts", () => {
    it("returns null without fetching when baseRef is missing", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      expect(await fetchRequiredStatusContexts(env, "JSONbored/gittensory", null, "public-token")).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns the live required set when branch protection is readable (both contexts and checks shapes)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (input.toString().includes("/protection/required_status_checks")) {
          return Response.json({ contexts: ["validate", "", null], checks: [{ context: "Superagent Security Scan" }, { context: "  " }] });
        }
        return new Response("not found", { status: 404 });
      });
      const required = await fetchRequiredStatusContexts(env, "JSONbored/gittensory", "main", "public-token");
      expect([...(required as Set<string>)].sort()).toEqual(["Superagent Security Scan", "validate"]);
    });

    it("uses the shared GitHub GET cache for raw branch-protection reads without double-counting rate-limit observations", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      const store = new Map<string, CachedGitHubResponse>();
      setGitHubResponseCache({
        get: async (key) => store.get(key) ?? null,
        set: async (key, value) => void store.set(key, value),
      });
      let fetches = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        fetches += 1;
        expect(input.toString()).toContain("/branches/main/protection/required_status_checks");
        return Response.json(
          { contexts: ["validate"], checks: [] },
          { headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "1782802800" } },
        );
      });

      const first = await fetchRequiredStatusContexts(env, "JSONbored/gittensory", "main", "public-token");
      const second = await fetchRequiredStatusContexts(env, "JSONbored/gittensory", "main", "public-token");

      expect([...(first as Set<string>)]).toEqual(["validate"]);
      expect([...(second as Set<string>)]).toEqual(["validate"]);
      expect(fetches).toBe(1);
      expect([...store.keys()].some((key) => key.includes("/branches/main/protection/required_status_checks"))).toBe(true);
      const observations = await listLatestGitHubRateLimitObservations(env);
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({
        repoFullName: "JSONbored/gittensory",
        resource: "rest",
        path: "/branches/main/protection/required_status_checks",
        statusCode: 200,
        remaining: 4999,
      });
    });

    it("returns null when the live read fails, even if a stale global fallback is configured (conservative fold-all)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      (env as Env & { GITTENSORY_REQUIRED_CI_CONTEXTS?: string }).GITTENSORY_REQUIRED_CI_CONTEXTS = "stale-required-context";
      vi.stubGlobal("fetch", async () => new Response("forbidden", { status: 403 }));
      expect(await fetchRequiredStatusContexts(env, "JSONbored/gittensory", "main", "public-token")).toBeNull();
    });
  });

  describe("isRateLimitedGitHubFailure", () => {
    it("does not treat a bare permission 403 (remaining > 0, no Retry-After, no secondary body) as a rate limit", () => {
      expect(
        isRateLimitedGitHubFailure({ statusCode: 403, retryAfter: null, remaining: "4999", body: "Resource not accessible by integration" }),
      ).toBe(false);
    });

    it("treats a 403 with an exhausted x-ratelimit-remaining as a rate limit", () => {
      expect(isRateLimitedGitHubFailure({ statusCode: 403, retryAfter: null, remaining: "0", body: "" })).toBe(true);
    });

    it("treats a 403 or 429 carrying a Retry-After header as a rate limit", () => {
      expect(isRateLimitedGitHubFailure({ statusCode: 403, retryAfter: "60", remaining: "100", body: "" })).toBe(true);
      expect(isRateLimitedGitHubFailure({ statusCode: 429, retryAfter: "1", remaining: null, body: "" })).toBe(true);
    });

    it("treats a secondary-limit / abuse body as a rate limit", () => {
      expect(
        isRateLimitedGitHubFailure({ statusCode: 403, retryAfter: null, remaining: "100", body: "You have exceeded a secondary rate limit" }),
      ).toBe(true);
    });

    it("does not treat a 429 without any rate-limit signal as a rate limit", () => {
      expect(isRateLimitedGitHubFailure({ statusCode: 429, retryAfter: null, remaining: "100", body: "" })).toBe(false);
    });

    it("does not treat a non-403/429 failure as a rate limit even with a matching body", () => {
      expect(isRateLimitedGitHubFailure({ statusCode: 500, retryAfter: null, remaining: null, body: "secondary rate limit" })).toBe(false);
    });
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

describe("isOwnReviewThreadAuthor", () => {
  it("matches our own gittensory app bot logins by prefix", () => {
    for (const login of ["gittensory[bot]", "gittensory-orb[bot]", "gittensory-review[bot]", "GITTENSORY[bot]", "gittensory", "gittensory-orb"]) {
      expect(isOwnReviewThreadAuthor(login)).toBe(true);
    }
  });

  it("does not match a third-party bot whose slug only ends in -gittensory[bot] (regression)", () => {
    // A `\b` boundary also fires after a hyphen, so the unanchored regex misclassified these external bots as
    // our own author and dropped their review-thread comments as self-authored non-blockers (fail-open).
    for (const login of ["evil-gittensory[bot]", "x-gittensory[bot]", "not-gittensory", "gittensory-fork"]) {
      expect(isOwnReviewThreadAuthor(login)).toBe(false);
    }
  });

  it("treats an absent login as not our own author", () => {
    expect(isOwnReviewThreadAuthor(null)).toBe(false);
    expect(isOwnReviewThreadAuthor(undefined)).toBe(false);
    expect(isOwnReviewThreadAuthor("")).toBe(false);
  });
});
