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
  recordGitHubRateLimitObservation,
  upsertInstallation,
  upsertRepoSyncSegment,
  upsertRepoSyncState,
  upsertPullRequestFile,
  upsertPullRequestFromGitHub,
  upsertIssueFromGitHub,
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
  configuredRequiredCiContexts,
  fetchAndStorePullRequestFilesForReview,
  fetchLiveCiAggregate,
  fetchRequiredStatusContexts,
  refreshContributorActivity,
  refreshInstallationHealth,
  refreshPullRequestDetails,
} from "../../src/github/backfill";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { createTestEnv } from "../helpers/d1";

describe("GitHub backfill", () => {
  afterEach(() => {
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
        lastActivityAt: "bad-date",
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
    expect(repair.modeImpacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mode: "comment", enabled: false, affectedRepoCount: 0, action: "No change needed." }),
        expect.objectContaining({ mode: "label", enabled: false, affectedRepoCount: 0, action: "No change needed." }),
        expect.objectContaining({ mode: "check_run", enabled: false, affectedRepoCount: 0, requiredPermissions: [expect.objectContaining({ optional: true })] }),
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
      if (url.includes("/issues?")) {
        return Response.json([
          { number: 1, title: "Open issue", state: "open", user: {}, labels: [{}], body: "body" },
        ]);
      }
      if (url.includes("/pulls?state=open")) {
        return Response.json([
          { number: 10, title: "No head sha PR", state: "open", user: {}, labels: [{}], body: "", head: { sha: "badsha" }, updated_at: "not-a-date" },
        ]);
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

    const labels = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "labels", requestedBy: "api", mode: "light" });
    const openPrs = await backfillRepositorySegment(env, { repoFullName: "JSONbored/gittensory", segment: "open_pull_requests", requestedBy: "api", mode: "full" });

    expect(labels).toMatchObject({ status: "running", fetchedCount: 200, expectedCount: 300 });
    expect(openPrs).toMatchObject({ status: "complete", fetchedCount: 1, expectedCount: 1 });
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "backfill-repo-segment", segment: "labels", mode: "resume" }),
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
    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: "backfill-repo-segment", segment: "labels" })]));
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
    it("keeps non-required failing and pending statuses advisory when required contexts are known", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({
            check_runs: [
              { name: "trusted-required-ci", status: "completed", conclusion: "success" },
              { name: "attacker/non-required-check", status: "completed", conclusion: "failure", output: { title: "Injected failure" } },
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

      expect(aggregate.ciState).toBe("passed");
      expect(aggregate.failingDetails).toEqual([]);
      expect(aggregate.nonRequiredFailingDetails.map((detail) => detail.name).sort()).toEqual(["attacker/non-required-check", "attacker/non-required-status"]);
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
              { name: "Gittensory Gate", status: "in_progress", conclusion: null, app: { slug: "gittensory" } },
              { name: "Gittensory Context", status: "in_progress", conclusion: null, app: { slug: "gittensory" } },
            ],
          });
        }
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        return new Response("not found", { status: 404 });
      });

      // Both bot checks are excluded from the CI wait even if listed among the required contexts.
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/metagraphed", "headsha", "public-token", new Set(["test", "Gittensory Gate", "Gittensory Context"]));

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
              { name: "Gittensory Gate", status: "completed", conclusion: "failure", output: { title: "External gate failed" }, app: { slug: "external-ci" } },
            ],
          });
        }
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", new Set(["test", "Gittensory Gate"]));

      expect(aggregate.ciState).toBe("failed");
      expect(aggregate.failingDetails).toEqual([expect.objectContaining({ name: "Gittensory Gate", summary: "External gate failed" })]);
    });

    it("does not ignore classic statuses named like the Gate", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
        if (url.includes("/status?")) return Response.json({ statuses: [{ context: "Gittensory Gate", state: "failure", description: "External status failed" }] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);

      expect(aggregate.ciState).toBe("failed");
      expect(aggregate.failingDetails).toEqual([expect.objectContaining({ name: "Gittensory Gate", summary: "External status failed" })]);
    });

  });

  describe("configuredRequiredCiContexts", () => {
    it("returns null when the var is unset (preserves the fold-all default)", () => {
      expect(configuredRequiredCiContexts({})).toBeNull();
    });

    it("returns null when the var is empty or only separators/whitespace", () => {
      expect(configuredRequiredCiContexts({ GITTENSORY_REQUIRED_CI_CONTEXTS: "" })).toBeNull();
      expect(configuredRequiredCiContexts({ GITTENSORY_REQUIRED_CI_CONTEXTS: "  , ,, " })).toBeNull();
    });

    it("parses a comma-separated set, trimming whitespace and dropping empty entries", () => {
      const parsed = configuredRequiredCiContexts({ GITTENSORY_REQUIRED_CI_CONTEXTS: "Superagent Security Scan, validate ,,Gittensory Gate" });
      expect(parsed).not.toBeNull();
      expect([...(parsed as Set<string>)].sort()).toEqual(["Gittensory Gate", "Superagent Security Scan", "validate"]);
    });
  });

  describe("fetchRequiredStatusContexts", () => {
    it("returns null without fetching when baseRef is missing", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token", GITTENSORY_REQUIRED_CI_CONTEXTS: "validate" });
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      expect(await fetchRequiredStatusContexts(env, "JSONbored/gittensory", null, "public-token")).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns the live required set when branch protection is readable (both contexts and checks shapes)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token", GITTENSORY_REQUIRED_CI_CONTEXTS: "ignored-when-live-read-works" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (input.toString().includes("/protection/required_status_checks")) {
          return Response.json({ contexts: ["validate", "", null], checks: [{ context: "Superagent Security Scan" }, { context: "  " }] });
        }
        return new Response("not found", { status: 404 });
      });
      const required = await fetchRequiredStatusContexts(env, "JSONbored/gittensory", "main", "public-token");
      expect([...(required as Set<string>)].sort()).toEqual(["Superagent Security Scan", "validate"]);
    });

    it("falls back to the configured set when the live read fails (e.g. 403, no admin:read)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token", GITTENSORY_REQUIRED_CI_CONTEXTS: "Superagent Security Scan,validate,Gittensory Gate" });
      vi.stubGlobal("fetch", async () => new Response("forbidden", { status: 403 }));
      const required = await fetchRequiredStatusContexts(env, "JSONbored/gittensory", "main", "public-token");
      expect([...(required as Set<string>)].sort()).toEqual(["Gittensory Gate", "Superagent Security Scan", "validate"]);
    });

    it("returns null when the live read fails and no fallback is configured (conservative fold-all)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async () => new Response("forbidden", { status: 403 }));
      expect(await fetchRequiredStatusContexts(env, "JSONbored/gittensory", "main", "public-token")).toBeNull();
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
