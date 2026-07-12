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
import { GITTENSORY_CONTEXT_CHECK_NAME, GITTENSORY_GATE_CHECK_NAME, GITTENSORY_LEGACY_GATE_CHECK_NAME } from "../../src/review/check-names";
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

      expect(aggregate).toEqual({ ciState: "unverified", hasPending: false, hasVisiblePending: false, hasMissingRequiredContext: false, failingDetails: [], nonRequiredFailingDetails: [], ciCompletenessWarning: null });
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
      expect(aggregate.hasVisiblePending).toBe(false);
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

    it("a third-party app's COMPLETED action_required check-run fails closed as a manual-hold verdict", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({
            check_runs: [
              { name: "coverage", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
              { name: "Contributor trust", status: "completed", conclusion: "action_required", app: { slug: "superagent-security" } },
            ],
          });
        }
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "completed", app: { slug: "github-actions" } }] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/awesome-claude", "sha4728", "public-token", new Set(["coverage", "Contributor trust"]));

      expect(aggregate.ciState).toBe("failed");
      expect(aggregate.hasPending).toBe(false);
      expect(aggregate.hasVisiblePending).toBe(false);
      expect(aggregate.hasMissingRequiredContext).toBe(false);
      expect(aggregate.failingDetails).toEqual([{ name: "Contributor trust" }]);
    });

    it("a third-party app's COMPLETED action_required check-run that IS a required context carries its summary/detailsUrl into failingDetails", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({
            check_runs: [
              { name: "coverage", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
              {
                name: "Contributor trust",
                status: "completed",
                conclusion: "action_required",
                app: { slug: "superagent-security" },
                output: { title: "Manual review needed" },
                details_url: "https://superagent.example/checks/contributor-trust",
              },
            ],
          });
        }
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "completed", app: { slug: "github-actions" } }] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/awesome-claude", "sha4729", "public-token", new Set(["coverage", "Contributor trust"]));

      expect(aggregate.ciState).toBe("failed");
      expect(aggregate.failingDetails).toEqual([
        { name: "Contributor trust", summary: "Manual review needed", detailsUrl: "https://superagent.example/checks/contributor-trust" },
      ]);
    });

    it("a third-party app's COMPLETED action_required check-run that is NOT a required context is held as a non-blocking advisory, never auto-closing the PR (#4414-regression)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({
            check_runs: [
              { name: "validate", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
              { name: "Superagent Security Scan", status: "completed", conclusion: "success", app: { slug: "superagent-security" } },
              {
                name: "Contributor trust",
                status: "completed",
                conclusion: "action_required",
                app: { slug: "superagent-security" },
                output: { title: "Manual review needed" },
                details_url: "https://superagent.example/checks/contributor-trust",
              },
            ],
          });
        }
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "completed", app: { slug: "github-actions" } }] });
        return new Response("not found", { status: 404 });
      });

      // Matches real branch protection: only "validate" + "Superagent Security Scan" are required contexts --
      // "Contributor trust" is a SEPARATE, never-required check-run posted by the same app.
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "sha9001", "public-token", new Set(["validate", "Superagent Security Scan"]));

      expect(aggregate.ciState).toBe("passed");
      expect(aggregate.hasPending).toBe(false);
      expect(aggregate.failingDetails).toEqual([]);
      expect(aggregate.nonRequiredFailingDetails).toEqual([
        { name: "Contributor trust", summary: "Manual review needed", detailsUrl: "https://superagent.example/checks/contributor-trust" },
      ]);
    });

    it("REGRESSION (#4812): a third-party action_required check-run on a repo with NO branch-protection required contexts configured at all is still non-blocking, not folded into failingDetails by the 'assume required when unknown' fallback", async () => {
      // Reproduces PR #4812 (JSONbored/metagraphed) exactly: the repo's real branch protection returns
      // required_status_checks.contexts: [] (confirmed via the live GitHub API) -- fetchRequiredStatusContexts
      // maps that to an EMPTY Set, not null, so enforceRequiredOnly is false. Before this fix, isRequired()'s
      // "!enforceRequiredOnly || ..." made every name "required" in that mode, silently reopening #4414 for
      // any repo that simply never configured GitHub-native required status checks -- Contributor trust
      // (Superagent's advisory, never-should-block signal) got folded into failingDetails and auto-closed a
      // real contributor's PR with every actual CI check (tests, coverage, ui) green.
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({
            check_runs: [
              { name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
              { name: "ui", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
              {
                name: "Contributor trust",
                status: "completed",
                conclusion: "action_required",
                app: { slug: "superagent-security" },
                output: { title: "Contributor flagged for review" },
              },
            ],
          });
        }
        if (url.includes("/status?")) return Response.json({ statuses: [{ context: "codecov/patch", state: "success" }] });
        if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "completed", app: { slug: "github-actions" } }] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/metagraphed", "sha4812", "public-token", new Set());

      expect(aggregate.ciState).toBe("passed");
      expect(aggregate.failingDetails).toEqual([]);
      expect(aggregate.nonRequiredFailingDetails).toEqual([{ name: "Contributor trust", summary: "Contributor flagged for review" }]);
    });

    it("REGRESSION (#4812): the same holds when required-status-context fetch outright failed (null), not just when it confirmed an empty list", async () => {
      // A distinct origin from the empty-Set case above (a 403/fetch error rather than a confirmed-empty
      // response), but must resolve the same way: no POSITIVE confirmation that Contributor trust is required
      // means it stays advisory, never a close reason.
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({
            check_runs: [
              { name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
              { name: "Contributor trust", status: "completed", conclusion: "action_required", app: { slug: "superagent-security" } },
            ],
          });
        }
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "completed", app: { slug: "github-actions" } }] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/metagraphed", "sha4812b", "public-token", null);

      expect(aggregate.ciState).toBe("passed");
      expect(aggregate.failingDetails).toEqual([]);
      expect(aggregate.nonRequiredFailingDetails).toEqual([{ name: "Contributor trust" }]);
    });

    it("a non-required third-party action_required check-run with no output/details_url still lands in nonRequiredFailingDetails, bare (name-only)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({
            check_runs: [
              { name: "validate", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
              { name: "Contributor trust", status: "completed", conclusion: "action_required", app: { slug: "superagent-security" } },
            ],
          });
        }
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "completed", app: { slug: "github-actions" } }] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "sha9002", "public-token", new Set(["validate"]));

      expect(aggregate.ciState).toBe("passed");
      expect(aggregate.failingDetails).toEqual([]);
      expect(aggregate.nonRequiredFailingDetails).toEqual([{ name: "Contributor trust" }]);
    });

    it("a github-actions workflow awaiting 'Approve and run' (action_required) is still treated as pending, not settled (#fork-action-required)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({
            check_runs: [{ name: "build", status: "completed", conclusion: "action_required", app: { slug: "github-actions" } }],
          });
        }
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/metagraphed", "forksha", "public-token", new Set(["build"]));

      expect(aggregate.ciState).toBe("pending");
      expect(aggregate.hasPending).toBe(true);
      expect(aggregate.hasVisiblePending).toBe(true);
      expect(aggregate.failingDetails).toEqual([]);
    });

    it("an app-less check-run reporting action_required is conservatively treated as pending (unconfirmed app, not settled)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({ check_runs: [{ name: "legacy-status-check", status: "completed", conclusion: "action_required" }] });
        }
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", new Set(["legacy-status-check"]));

      expect(aggregate.hasPending).toBe(true);
      expect(aggregate.hasVisiblePending).toBe(true);
    });

    it("a third-party app's action_required check-run that hasn't completed yet is still pending (not yet a settled verdict)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({
            check_runs: [{ name: "Contributor trust", status: "in_progress", conclusion: "action_required", app: { slug: "superagent-security" } }],
          });
        }
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/awesome-claude", "sha", "public-token", new Set(["Contributor trust"]));

      expect(aggregate.hasPending).toBe(true);
      expect(aggregate.hasVisiblePending).toBe(true);
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

    it("does not skip a same-slug bot-owned-named check-run when GITHUB_APP_SLUG is unset (no self-hoster crash)", async () => {
      // GITHUB_APP_SLUG is optional now (the retired review App was deleted) -- isOwnGitHubAppCheckRun must
      // degrade to "never matches" instead of throwing on `env.GITHUB_APP_SLUG.trim()` when it's absent.
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      delete (env as Partial<Env>).GITHUB_APP_SLUG;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) {
          return Response.json({
            check_runs: [{ name: "Gittensory Orb Review Agent", status: "completed", conclusion: "failure", output: { title: "Real gate failure" }, app: { slug: "gittensory" } }],
          });
        }
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", new Set(["Gittensory Orb Review Agent"]));

      expect(aggregate.ciState).toBe("failed");
      expect(aggregate.failingDetails).toEqual([expect.objectContaining({ name: "Gittensory Orb Review Agent", summary: "Real gate failure" })]);
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

    it("surfaces a completeness warning when CI resolves to passed with no branch-protection required contexts, without changing ciState (#2137)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        // Workflow A ("test") ran and passed; workflow B (e.g. a path-filtered e2e-tests job) never triggered at
        // all — no check-run, no check-suite entry, indistinguishable from a workflow that doesn't exist.
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "completed", app: { slug: "github-actions" } }] });
        return new Response("not found", { status: 404 });
      });
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);
      // Disposition is UNCHANGED (interim mitigation, not the full fix): a self-hosted repo with no
      // expected-checks config would otherwise get stuck "pending" forever on a workflow that can structurally
      // never complete. The gap is surfaced as an informational warning instead.
      expect(aggregate.ciState).toBe("passed");
      expect(aggregate.ciCompletenessWarning).toMatch(/branch-protection required checks/i);
    });

    it("does NOT surface a completeness warning when branch-protection required contexts ARE configured", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "completed", app: { slug: "github-actions" } }] });
        return new Response("not found", { status: 404 });
      });
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", new Set(["test"]));
      expect(aggregate.ciState).toBe("passed");
      expect(aggregate.ciCompletenessWarning).toBeNull();
    });

    it("does NOT surface a completeness warning when ciState is anything other than passed", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "test", status: "completed", conclusion: "failure", app: { slug: "github-actions" } }] });
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        return new Response("not found", { status: 404 });
      });
      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);
      expect(aggregate.ciState).toBe("failed");
      expect(aggregate.ciCompletenessWarning).toBeNull();
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

    it("ENFORCE-required mode treats suite-only optional pending as stale-cap eligible, not required-visible", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "in_progress", app: { slug: "github-actions" } }] });
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "test", status: "completed", conclusion: "success" }] });
        if (url.includes("/status?")) return Response.json({ statuses: [] });
        return new Response("not found", { status: 404 });
      });

      const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", new Set(["test"]));

      expect(aggregate.ciState).toBe("pending");
      expect(aggregate.hasPending).toBe(true);
      expect(aggregate.hasVisiblePending).toBe(false);
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

    describe("expectedCiContexts fallback (#selfhost-ci-verification)", () => {
      it("passes with no completeness warning when branch protection is unreadable but an expected context settles clean", async () => {
        const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = input.toString();
          if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "build", status: "completed", conclusion: "success" }] });
          if (url.includes("/status?")) return Response.json({ statuses: [] });
          return new Response("not found", { status: 404 });
        });

        const requiredContexts = mergeRequiredCiContexts(null, ["build"]);
        const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", requiredContexts);

        // The key regression: an expectedCiContexts fallback (used when branch protection can't be read)
        // resolves to enforce-required mode, so a clean settle is "passed" with NO completeness warning —
        // unlike the fold-all path, which would warn (#2137).
        expect(aggregate.ciState).toBe("passed");
        expect(aggregate.ciCompletenessWarning).toBeNull();
      });

      it("stays pending when branch protection is unreadable and the expected context never appears on the commit", async () => {
        const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = input.toString();
          if (url.includes("/check-runs?")) return Response.json({ check_runs: [] });
          if (url.includes("/status?")) return Response.json({ statuses: [] });
          return new Response("not found", { status: 404 });
        });

        const requiredContexts = mergeRequiredCiContexts(null, ["build"]);
        const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", requiredContexts);

        expect(aggregate.ciState).toBe("pending");
        // #selfhost-ci-deferral-staleness: a required context that never appeared is an INFERRED absence, not
        // observed activity — distinct from hasVisiblePending, which stays false here (nothing is actively
        // queued/in_progress; the context simply never posted at all).
        expect(aggregate.hasMissingRequiredContext).toBe(true);
        expect(aggregate.hasVisiblePending).toBe(false);
      });

      it("does not wait for absent bot-owned required contexts before the app can publish them", async () => {
        const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = input.toString();
          if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "build", status: "completed", conclusion: "success" }] });
          if (url.includes("/status?")) return Response.json({ statuses: [] });
          return new Response("not found", { status: 404 });
        });

        const requiredContexts = mergeRequiredCiContexts(null, [
          "build",
          GITTENSORY_GATE_CHECK_NAME,
          GITTENSORY_LEGACY_GATE_CHECK_NAME,
          GITTENSORY_CONTEXT_CHECK_NAME,
        ]);
        const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", requiredContexts);

        expect(aggregate.ciState).toBe("passed");
        expect(aggregate.hasPending).toBe(false);
        expect(aggregate.hasMissingRequiredContext).toBe(false);
        expect(aggregate.hasVisiblePending).toBe(false);
      });

      it("does NOT flag a missing required context as confidently absent when the check-runs page read was incomplete", async () => {
        const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = input.toString();
          if (url.includes("/check-runs?") && url.includes("&page=1")) {
            return Response.json(
              { check_runs: [] },
              { headers: { link: '<https://api.github.com/repos/x/y/commits/abc/check-runs?page=2>; rel="next"' } },
            );
          }
          if (url.includes("/check-runs?")) return new Response("upstream error", { status: 500 }); // page 2 fails → incomplete
          if (url.includes("/status?")) return Response.json({ statuses: [] });
          return new Response("not found", { status: 404 });
        });

        const requiredContexts = mergeRequiredCiContexts(null, ["build"]);
        const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", requiredContexts);

        // "build" never appeared on the pages read, but the read did not COMPLETE — a partial page can't tell
        // "never appears" from "appears on a page we didn't fetch", so this must NOT be a confident absence.
        expect(aggregate.ciState).toBe("pending");
        expect(aggregate.hasMissingRequiredContext).toBe(false);
      });

      it("does not flag a missing NON-required context in fold-all mode (no branch protection, no expectedCiContexts)", async () => {
        const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = input.toString();
          if (url.includes("/check-runs?")) return Response.json({ check_runs: [] });
          if (url.includes("/status?")) return Response.json({ statuses: [] });
          return new Response("not found", { status: 404 });
        });

        // No requiredContexts configured at all → fold-all mode (enforceRequiredOnly false); the
        // missing-required-context signal only ever applies under enforceRequiredOnly.
        const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", null);

        expect(aggregate.hasMissingRequiredContext).toBe(false);
      });

      it("keeps hasVisiblePending authoritative when one required context is missing and another is actively queued", async () => {
        const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = input.toString();
          if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "build", status: "in_progress", conclusion: null }] });
          if (url.includes("/status?")) return Response.json({ statuses: [] });
          return new Response("not found", { status: 404 });
        });

        // "build" is actively queued (Class A); "deploy" is required but never appears (Class B) — both true at once.
        const requiredContexts = mergeRequiredCiContexts(null, ["build", "deploy"]);
        const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", requiredContexts);

        expect(aggregate.hasVisiblePending).toBe(true);
        expect(aggregate.hasMissingRequiredContext).toBe(true);
      });

      it("fails when branch protection is unreadable and the expected context completes red", async () => {
        const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = input.toString();
          if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "build", status: "completed", conclusion: "failure" }] });
          if (url.includes("/status?")) return Response.json({ statuses: [] });
          return new Response("not found", { status: 404 });
        });

        const requiredContexts = mergeRequiredCiContexts(null, ["build"]);
        const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", requiredContexts);

        expect(aggregate.ciState).toBe("failed");
        expect(aggregate.failingDetails).toEqual([expect.objectContaining({ name: "build" })]);
      });

      it("does not regress the no-config case: no branch protection and no expected contexts still fold-all warns on pass", async () => {
        const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = input.toString();
          if (url.includes("/check-runs?")) return Response.json({ check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
          if (url.includes("/status?")) return Response.json({ statuses: [] });
          if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "completed", app: { slug: "github-actions" } }] });
          return new Response("not found", { status: 404 });
        });

        const requiredContexts = mergeRequiredCiContexts(null, undefined);
        const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", requiredContexts);

        expect(aggregate.ciState).toBe("passed");
        expect(aggregate.ciCompletenessWarning).toMatch(/branch-protection required checks/i);
      });
    });

    describe("duplicate-named check-runs from a re-run (dedupeLatestCheckRunsByName)", () => {
      // Reproduces a real commit's shape: GitHub's /check-runs endpoint returned "Deploy UI preview version" TWICE
      // after a "Re-run failed jobs" — id 85478132562 (conclusion: failure, started_at 2026-07-06T20:56:33Z, the
      // STALE original run) and id 85485221438 (conclusion: skipped, started_at 2026-07-06T21:34:29Z, the CURRENT
      // re-run). Without dedup, the stale failure alone flipped ciState to "failed" even though the check now
      // passes — which fed a TERMINAL close signal into planAgentMaintenanceActions for a contributor PR whose CI
      // had legitimately gone green on re-run.
      it("keeps the NEWER (passing) conclusion when a re-run leaves a stale failing duplicate by name", async () => {
        const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = input.toString();
          if (url.includes("/check-runs?")) {
            return Response.json({
              check_runs: [
                { id: 85478132562, name: "Deploy UI preview version", status: "completed", conclusion: "failure", started_at: "2026-07-06T20:56:33Z", check_suite: { id: 4401 } },
                { id: 85485221438, name: "Deploy UI preview version", status: "completed", conclusion: "skipped", started_at: "2026-07-06T21:34:29Z", check_suite: { id: 4401 } },
              ],
            });
          }
          if (url.includes("/status?")) return Response.json({ statuses: [] });
          if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "completed", app: { slug: "github-actions" } }] });
          return new Response("not found", { status: 404 });
        });

        const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "7d145f032eb3b03b5ac5868aa3cecf3e002bb6e2", "public-token", new Set(["Deploy UI preview version"]));

        expect(aggregate.ciState).toBe("passed");
        expect(aggregate.failingDetails).toEqual([]);
      });

      it("still fails when the NEWER duplicate-named check-run is the one that failed (recency-aware, not duplicate-blind)", async () => {
        const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = input.toString();
          if (url.includes("/check-runs?")) {
            return Response.json({
              check_runs: [
                { id: 1, name: "Deploy UI preview version", status: "completed", conclusion: "success", started_at: "2026-07-06T20:56:33Z", check_suite: { id: 4401 } },
                { id: 2, name: "Deploy UI preview version", status: "completed", conclusion: "failure", started_at: "2026-07-06T21:34:29Z", check_suite: { id: 4401 } },
              ],
            });
          }
          if (url.includes("/status?")) return Response.json({ statuses: [] });
          return new Response("not found", { status: 404 });
        });

        const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", new Set(["Deploy UI preview version"]));

        expect(aggregate.ciState).toBe("failed");
        expect(aggregate.failingDetails).toEqual([expect.objectContaining({ name: "Deploy UI preview version" })]);
      });

      it("keeps the already-latest entry when a stale duplicate is listed OUT OF ORDER (appears second but started EARLIER)", async () => {
        // GitHub does not document a stable ordering contract for /check-runs, so the comparison must genuinely
        // compare timestamps rather than assume "later in the array is newer" — this fixture puts the STALE
        // (older, failing) run SECOND to prove the earlier-started duplicate does not override the real latest.
        const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = input.toString();
          if (url.includes("/check-runs?")) {
            return Response.json({
              check_runs: [
                { id: 2, name: "Deploy UI preview version", status: "completed", conclusion: "skipped", started_at: "2026-07-06T21:34:29Z", check_suite: { id: 4401 } },
                { id: 1, name: "Deploy UI preview version", status: "completed", conclusion: "failure", started_at: "2026-07-06T20:56:33Z", check_suite: { id: 4401 } },
              ],
            });
          }
          if (url.includes("/status?")) return Response.json({ statuses: [] });
          if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "completed", app: { slug: "github-actions" } }] });
          return new Response("not found", { status: 404 });
        });

        const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", new Set(["Deploy UI preview version"]));

        expect(aggregate.ciState).toBe("passed");
        expect(aggregate.failingDetails).toEqual([]);
      });

      it("does not discard failing same-name check-runs from a different suite", async () => {
        const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = input.toString();
          if (url.includes("/check-runs?")) {
            return Response.json({
              check_runs: [
                { id: 1, name: "security", status: "completed", conclusion: "failure", started_at: "2026-07-06T20:56:33Z", app: { slug: "required-security-ci" }, check_suite: { id: 9001 } },
                { id: 2, name: "security", status: "completed", conclusion: "success", started_at: "2026-07-06T21:34:29Z", app: { slug: "colliding-helper-ci" }, check_suite: { id: 9002 } },
              ],
            });
          }
          if (url.includes("/status?")) return Response.json({ statuses: [] });
          return new Response("not found", { status: 404 });
        });

        const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", new Set(["security"]));

        expect(aggregate.ciState).toBe("failed");
        expect(aggregate.failingDetails).toEqual([expect.objectContaining({ name: "security" })]);
      });

      it("falls back to array order when neither duplicate has a started_at (queued runs have none)", async () => {
        const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = input.toString();
          if (url.includes("/check-runs?")) {
            return Response.json({
              check_runs: [
                { id: 1, name: "flaky", status: "completed", conclusion: "failure", started_at: null, check_suite: { id: 4401 } },
                { id: 2, name: "flaky", status: "completed", conclusion: "success", started_at: null, check_suite: { id: 4401 } },
              ],
            });
          }
          if (url.includes("/status?")) return Response.json({ statuses: [] });
          if (url.includes("/check-suites?")) return Response.json({ check_suites: [{ status: "completed", app: { slug: "github-actions" } }] });
          return new Response("not found", { status: 404 });
        });

        const aggregate = await fetchLiveCiAggregate(env, "JSONbored/gittensory", "abc123", "public-token", new Set(["flaky"]));

        // No timestamp to compare on either side → the later array entry wins (the documented tiebreak fallback).
        expect(aggregate.ciState).toBe("passed");
        expect(aggregate.failingDetails).toEqual([]);
      });
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

    it("trusts self-host-configured TRUSTED_SCANNER_BOT_LOGINS additively alongside the built-in defaults (#4614)", async () => {
      // Whitespace + case variation + an empty entry between commas -- exercises the trim/lowercase/filter
      // handling, not just a bare exact match.
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token", TRUSTED_SCANNER_BOT_LOGINS: " CodeQL[bot] ,,Snyk-Security[bot]" });
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
                      path: "src/codeql-finding.ts",
                      line: 5,
                      comments: { nodes: [{ body: "**P1:** Configured CodeQL blocker", author: { login: "codeql[bot]" }, authorAssociation: "NONE" }] },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/snyk-finding.ts",
                      line: 15,
                      comments: { nodes: [{ body: "**P1:** Configured Snyk blocker", author: { login: "snyk-security[bot]" }, authorAssociation: "NONE" }] },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/superagent-still-trusted.ts",
                      line: 25,
                      comments: { nodes: [{ body: "**P1:** Built-in default still trusted", author: { login: "superagent-security[bot]" }, authorAssociation: "NONE" }] },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/unconfigured-scanner.ts",
                      line: 35,
                      comments: { nodes: [{ body: "**P1:** Unconfigured scanner stays untrusted", author: { login: "semgrep[bot]" }, authorAssociation: "NONE" }] },
                    },
                  ],
                },
              },
            },
          },
        });
      });

      const blockers = await fetchLiveReviewThreadBlockers(env, "JSONbored/gittensory", 1900, "public-token");

      expect(blockers.map((blocker) => blocker.title)).toEqual(["Configured CodeQL blocker", "Configured Snyk blocker", "Built-in default still trusted"]);
      expect(blockers.map((blocker) => blocker.authorLogin)).toEqual(["codeql[bot]", "snyk-security[bot]", "superagent-security[bot]"]);
    });

    it("ignores a whitespace-only TRUSTED_SCANNER_BOT_LOGINS override and keeps only the built-in defaults trusted", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token", TRUSTED_SCANNER_BOT_LOGINS: "   " });
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
                      path: "src/codeql-finding.ts",
                      line: 5,
                      comments: { nodes: [{ body: "**P1:** Not configured, must not block", author: { login: "codeql[bot]" }, authorAssociation: "NONE" }] },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/superagent-still-trusted.ts",
                      line: 25,
                      comments: { nodes: [{ body: "**P1:** Built-in default still trusted", author: { login: "superagent-security[bot]" }, authorAssociation: "NONE" }] },
                    },
                  ],
                },
              },
            },
          },
        });
      });

      const blockers = await fetchLiveReviewThreadBlockers(env, "JSONbored/gittensory", 1901, "public-token");

      expect(blockers.map((blocker) => blocker.authorLogin)).toEqual(["superagent-security[bot]"]);
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

  describe("mergeRequiredCiContexts", () => {
    it("unions branch-protection contexts with expectedCiContexts when both have entries", () => {
      const merged = mergeRequiredCiContexts(new Set(["build"]), ["test", "lint"]);
      expect([...(merged as Set<string>)].sort()).toEqual(["build", "lint", "test"]);
    });

    it("returns branch-protection contexts unchanged when expectedCiContexts is undefined", () => {
      const merged = mergeRequiredCiContexts(new Set(["build", "test"]), undefined);
      expect(merged).toBeInstanceOf(Set);
      expect([...(merged as Set<string>)].sort()).toEqual(["build", "test"]);
    });

    it("returns branch-protection contexts unchanged when expectedCiContexts is an empty array", () => {
      const merged = mergeRequiredCiContexts(new Set(["build", "test"]), []);
      expect([...(merged as Set<string>)].sort()).toEqual(["build", "test"]);
    });

    it("returns branch-protection contexts unchanged when expectedCiContexts is null", () => {
      const merged = mergeRequiredCiContexts(new Set(["build", "test"]), null);
      expect([...(merged as Set<string>)].sort()).toEqual(["build", "test"]);
    });

    it("returns just the expected set when branch protection is null and expectedCiContexts has entries", () => {
      const merged = mergeRequiredCiContexts(null, ["build"]);
      expect([...(merged as Set<string>)]).toEqual(["build"]);
    });

    it("returns null when branch protection is null and expectedCiContexts is undefined", () => {
      expect(mergeRequiredCiContexts(null, undefined)).toBeNull();
    });

    it("returns null when branch protection is null and expectedCiContexts is null", () => {
      expect(mergeRequiredCiContexts(null, null)).toBeNull();
    });

    it("returns null when branch protection is null and expectedCiContexts is an empty array", () => {
      expect(mergeRequiredCiContexts(null, [])).toBeNull();
    });

    it("returns just the expected set when branch protection is an empty (non-null) Set and expectedCiContexts has entries", () => {
      const merged = mergeRequiredCiContexts(new Set(), ["build"]);
      expect([...(merged as Set<string>)]).toEqual(["build"]);
    });

    it("drops blank/whitespace-only expectedCiContexts entries while keeping real entries", () => {
      const merged = mergeRequiredCiContexts(null, ["  ", "", "build"]);
      expect([...(merged as Set<string>)]).toEqual(["build"]);
    });

    it("trims leading/trailing whitespace from expectedCiContexts entries in the result", () => {
      const merged = mergeRequiredCiContexts(null, [" build "]);
      expect([...(merged as Set<string>)]).toEqual(["build"]);
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

      // admissionKey mirrors the real caller (processors.ts), which always resolves + passes its own admission
      // key -- omitting it here would exercise the (deliberately unpersisted) no-attribution path instead of
      // this test's actual point: that a cache hit does not double-record telemetry for the SAME bucket.
      const admissionKey = githubRateLimitAdmissionKeyForPublicToken();
      const first = await fetchRequiredStatusContexts(env, "JSONbored/gittensory", "main", "public-token", admissionKey);
      const second = await fetchRequiredStatusContexts(env, "JSONbored/gittensory", "main", "public-token", admissionKey);

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
        admissionKey,
      });
    });

    it("returns null when the live read fails, even if a stale global fallback is configured (conservative fold-all)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      (env as Env & { GITTENSORY_REQUIRED_CI_CONTEXTS?: string }).GITTENSORY_REQUIRED_CI_CONTEXTS = "stale-required-context";
      vi.stubGlobal("fetch", async () => new Response("forbidden", { status: 403 }));
      expect(await fetchRequiredStatusContexts(env, "JSONbored/gittensory", "main", "public-token")).toBeNull();
    });

    it("classifies a bare 403 (no admin:read) as permission-denied, not a rate limit (#selfhost-runtime-pressure)", async () => {
      resetMetrics();
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async () => new Response("forbidden", { status: 403 }));
      expect(await fetchRequiredStatusContexts(env, "JSONbored/gittensory", "main", "public-token")).toBeNull();
      expect(await renderMetrics()).toContain("gittensory_github_branch_protection_permission_denied_total 1");
    });

    it("does not count a 404 (no branch protection configured) as permission-denied", async () => {
      resetMetrics();
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
      expect(await fetchRequiredStatusContexts(env, "JSONbored/gittensory", "main", "public-token")).toBeNull();
      expect(await renderMetrics()).not.toContain("gittensory_github_branch_protection_permission_denied_total");
    });

    it("does not count a genuinely rate-limited 403 (x-ratelimit-remaining: 0) as permission-denied", async () => {
      resetMetrics();
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response("secondary rate limit", {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1780000000" },
          }),
      );
      expect(await fetchRequiredStatusContexts(env, "JSONbored/gittensory", "main", "public-token")).toBeNull();
      expect(await renderMetrics()).not.toContain("gittensory_github_branch_protection_permission_denied_total");
    }, 15_000);
  });

  describe("fetchNamedCheckRunConclusion (#2564)", () => {
    it("returns undefined without fetching when headSha is missing", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      expect(await fetchNamedCheckRunConclusion(env, "JSONbored/gittensory", null, "CLA Assistant Lite", "cla-assistant", "public-token")).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns the lowercased conclusion for a matching check-run (case-insensitive name match)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        expect(input.toString()).toContain("/commits/sha1/check-runs");
        return Response.json({ total_count: 1, check_runs: [{ id: 1, name: "cla assistant lite", status: "completed", conclusion: "SUCCESS", app: { slug: "cla-assistant" } }] });
      });
      expect(await fetchNamedCheckRunConclusion(env, "JSONbored/gittensory", "sha1", "CLA Assistant Lite", "cla-assistant", "public-token")).toBe("success");
    });

    it("REGRESSION (gate finding): returns null (deterministic missing), not undefined (transient), without fetching when no trusted app slug is configured — a check-run-only config with no slug must still BLOCK, not silently hold forever", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      expect(await fetchNamedCheckRunConclusion(env, "JSONbored/gittensory", "sha1", "CLA Assistant Lite", null, "public-token")).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("ignores a completed same-name check-run from an untrusted app slug", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async () =>
        Response.json({
          total_count: 1,
          check_runs: [{ id: 1, name: "CLA Assistant Lite", status: "completed", conclusion: "success", app: { slug: "github-actions" } }],
        }),
      );
      expect(await fetchNamedCheckRunConclusion(env, "JSONbored/gittensory", "sha1", "CLA Assistant Lite", "cla-assistant", "public-token")).toBeNull();
    });

    it("uses the trusted producer when spoofed and trusted same-name runs both exist", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async () =>
        Response.json({
          total_count: 2,
          check_runs: [
            { id: 1, name: "CLA Assistant Lite", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
            { id: 2, name: "CLA Assistant Lite", status: "completed", conclusion: "failure", app: { slug: "cla-assistant" } },
          ],
        }),
      );
      expect(await fetchNamedCheckRunConclusion(env, "JSONbored/gittensory", "sha1", "CLA Assistant Lite", "cla-assistant", "public-token")).toBe("failure");
    });

    it("returns null (resolved: not found) when the head SHA has no check-run with that name", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async () => Response.json({ total_count: 1, check_runs: [{ id: 1, name: "Some Other Check", status: "completed", conclusion: "success", app: { slug: "cla-assistant" } }] }));
      expect(await fetchNamedCheckRunConclusion(env, "JSONbored/gittensory", "sha1", "CLA Assistant Lite", "cla-assistant", "public-token")).toBeNull();
    });

    it("returns null (resolved: not found) when the response omits check_runs entirely (nullish fallback)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async () => Response.json({ total_count: 0 }));
      expect(await fetchNamedCheckRunConclusion(env, "JSONbored/gittensory", "sha1", "CLA Assistant Lite", "cla-assistant", "public-token")).toBeNull();
    });

    // #2564 gate-review finding: a matching check-run that has NOT finished yet must resolve to undefined
    // (unresolved), not "" — an in-progress run's conclusion:null means "not decided yet," not "resolved with
    // an empty conclusion." Coercing it to "" made claMode: block hard-fail a PR before the named check had
    // actually finished running.
    it("returns undefined (unresolved) for a matching but still-in-progress check-run (status !== completed, conclusion: null)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async () => Response.json({ total_count: 1, check_runs: [{ id: 1, name: "CLA Assistant Lite", status: "in_progress", conclusion: null, app: { slug: "cla-assistant" } }] }));
      expect(await fetchNamedCheckRunConclusion(env, "JSONbored/gittensory", "sha1", "CLA Assistant Lite", "cla-assistant", "public-token")).toBeUndefined();
    });

    it("returns an empty string for a matching, COMPLETED check-run with an unexpected empty conclusion (genuine edge case, not the in-progress case)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async () => Response.json({ total_count: 1, check_runs: [{ id: 1, name: "CLA Assistant Lite", status: "completed", conclusion: null, app: { slug: "cla-assistant" } }] }));
      expect(await fetchNamedCheckRunConclusion(env, "JSONbored/gittensory", "sha1", "CLA Assistant Lite", "cla-assistant", "public-token")).toBe("");
    });

    it("returns undefined (not evaluated) when the fetch fails, never a false 'missing'", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      vi.stubGlobal("fetch", async () => new Response("forbidden", { status: 403 }));
      expect(await fetchNamedCheckRunConclusion(env, "JSONbored/gittensory", "sha1", "CLA Assistant Lite", "cla-assistant", "public-token")).toBeUndefined();
    });
  });

  describe("fetchLinkedIssueFacts (#2136)", () => {
    it("returns a found result with the extracted facts, falling back to the requested number and open state when the payload omits them", async () => {
      const env = createTestEnv({});
      // Sparse payload: no `number`, no `state` — exercises the `data.number ?? issueNumber` and
      // `data.state ?? "open"` defensive fallbacks.
      vi.stubGlobal("fetch", async () => Response.json({ labels: [{ name: "bug" }, "manual-string-label"], assignees: [{ login: "maintainer" }], user: { login: "reporter" } }));
      const result = await fetchLinkedIssueFacts(env, "JSONbored/gittensory", 42, "tok");
      expect(result).toEqual({
        status: "found",
        facts: { number: 42, labels: ["bug", "manual-string-label"], assignees: ["maintainer"], state: "open", authorLogin: "reporter", title: null, body: null, closedAt: null },
      });
    });

    it("extracts title + body (#1961/#3906, linked-issue satisfaction assessment) from the same REST payload — no second fetch", async () => {
      const env = createTestEnv({});
      vi.stubGlobal("fetch", async () =>
        Response.json({
          number: 1275,
          state: "open",
          labels: [],
          assignees: [],
          user: { login: "reporter" },
          title: "Enrich SN74 Gittensor — add SSE stream",
          body: "We need a live SSE stream surface for SN74 Gittensor.",
        }),
      );
      const result = await fetchLinkedIssueFacts(env, "JSONbored/metagraphed", 1275, "tok");
      expect(result).toEqual({
        status: "found",
        facts: {
          number: 1275,
          labels: [],
          assignees: [],
          state: "open",
          authorLogin: "reporter",
          title: "Enrich SN74 Gittensor — add SSE stream",
          body: "We need a live SSE stream surface for SN74 Gittensor.",
          closedAt: null,
        },
      });
    });

    it("extracts closedAt (#4528) from the same REST payload when the issue is closed", async () => {
      const env = createTestEnv({});
      vi.stubGlobal("fetch", async () =>
        Response.json({ number: 4279, state: "closed", closed_at: "2026-07-09T22:15:14Z" }),
      );
      const result = await fetchLinkedIssueFacts(env, "JSONbored/gittensory", 4279, "tok");
      expect(result.status === "found" && result.facts.closedAt).toBe("2026-07-09T22:15:14Z");
    });

    it("falls back to null for closedAt (#4528) when the payload omits it or it isn't a string", async () => {
      const env = createTestEnv({});
      vi.stubGlobal("fetch", async () => Response.json({ number: 4279, state: "open", closed_at: null }));
      const result = await fetchLinkedIssueFacts(env, "JSONbored/gittensory", 4279, "tok");
      expect(result.status === "found" && result.facts.closedAt).toBeNull();
    });

    it("falls back to null for title/body when the payload omits them or they are empty strings", async () => {
      const env = createTestEnv({});
      vi.stubGlobal("fetch", async () => Response.json({ number: 7, state: "open", title: "", body: "" }));
      const result = await fetchLinkedIssueFacts(env, "JSONbored/gittensory", 7, "tok");
      expect(result.status).toBe("found");
      expect(result.status === "found" && result.facts.title).toBeNull();
      expect(result.status === "found" && result.facts.body).toBeNull();
    });

    it("returns not_found on a confirmed 404, distinct from a transient fetch error", async () => {
      const env = createTestEnv({});
      vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
      expect(await fetchLinkedIssueFacts(env, "JSONbored/gittensory", 999999, "tok")).toEqual({ status: "not_found" });
    });

    it("REGRESSION: treats a 404 seen with the public/anonymous token as fetch_error, not not_found — GitHub also returns 404 for a real but inaccessible private issue", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-tok" });
      vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
      // The public token proves nothing about repo access, so a 404 here could just as easily mean "this issue
      // is real but private and this token can't see it" -- treating it as CONFIRMED absence risks closing a PR
      // over a genuinely-linked issue.
      expect(await fetchLinkedIssueFacts(env, "JSONbored/gittensory", 42, env.GITHUB_PUBLIC_TOKEN)).toEqual({ status: "fetch_error" });
    });

    it("REGRESSION: treats a 404 seen with no token at all as fetch_error, not not_found", async () => {
      const env = createTestEnv({});
      vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
      expect(await fetchLinkedIssueFacts(env, "JSONbored/gittensory", 42, undefined)).toEqual({ status: "fetch_error" });
    });

    it("returns fetch_error on a transient failure (5xx), never conflating it with not_found", async () => {
      const env = createTestEnv({});
      vi.stubGlobal("fetch", async () => new Response("server error", { status: 500 }));
      expect(await fetchLinkedIssueFacts(env, "JSONbored/gittensory", 42, "tok")).toEqual({ status: "fetch_error" });
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

  describe("reconcileOpenPullRequests (#audit-open-pr-reconciliation)", () => {
    it("returns an all-zero result for a repo that does not exist", async () => {
      const env = createTestEnv();
      expect(await reconcileOpenPullRequests(env, "owner/missing")).toEqual({ repoFullName: "owner/missing", remoteOpenCount: 0, localOpenCount: 0, missingNumbers: [] });
    });

    it("reports no missing numbers when the local table already has every remote-open PR", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      await seedRegisteredRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/pulls?")) return Response.json([{ number: 1 }]);
        return Response.json([]);
      });

      const result = await reconcileOpenPullRequests(env, "JSONbored/gittensory");

      expect(result).toEqual({ repoFullName: "JSONbored/gittensory", remoteOpenCount: 1, localOpenCount: 1, missingNumbers: [] });
    });

    it("REGRESSION (#3782/#3793): reports a PR number GitHub has open that has no local row at all", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      await seedRegisteredRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/pulls?")) return Response.json([{ number: 1 }, { number: 7 }]); // #7 opened but never made it into the local table
        return Response.json([]);
      });

      const result = await reconcileOpenPullRequests(env, "JSONbored/gittensory");

      expect(result).toEqual({ repoFullName: "JSONbored/gittensory", remoteOpenCount: 2, localOpenCount: 1, missingNumbers: [7] });
    });

    it("paginates the open-PR list past the first 100 via the Link header", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      await seedRegisteredRepo(env);
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/pulls?")) {
          const page = Number(new URL(url).searchParams.get("page") ?? "1");
          if (page === 1) {
            return Response.json(
              Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })),
              { headers: { link: '<https://api.github.com/repositories/1/pulls?state=open&per_page=100&page=2>; rel="next"' } },
            );
          }
          return Response.json([{ number: 101 }]);
        }
        return Response.json([]);
      });

      const result = await reconcileOpenPullRequests(env, "JSONbored/gittensory");

      expect(result.remoteOpenCount).toBe(101);
      expect(result.missingNumbers).toEqual(expect.arrayContaining([1, 101]));
    });

    it("fails open (all-zero result) when the FIRST page fails, so a GitHub hiccup never falsely reports every local PR as missing", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      await seedRegisteredRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
      vi.stubGlobal("fetch", async () => new Response("down", { status: 500 }));

      expect(await reconcileOpenPullRequests(env, "JSONbored/gittensory")).toEqual({ repoFullName: "JSONbored/gittensory", remoteOpenCount: 0, localOpenCount: 0, missingNumbers: [] });
    });

    it("keeps the pages already fetched when a LATER page fails mid-crawl (a partial remote list can only under-report, never falsely flag a real local PR)", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      await seedRegisteredRepo(env);
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/pulls?")) {
          const page = Number(new URL(url).searchParams.get("page") ?? "1");
          if (page === 1) {
            return Response.json(
              Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })),
              { headers: { link: '<https://api.github.com/repositories/1/pulls?state=open&per_page=100&page=2>; rel="next"' } },
            );
          }
          return new Response("down", { status: 500 });
        }
        return Response.json([]);
      });

      const result = await reconcileOpenPullRequests(env, "JSONbored/gittensory");

      expect(result.remoteOpenCount).toBe(100); // page 1's 100 items are kept despite page 2 failing
    });
  });

});

describe("isOwnReviewThreadAuthor", () => {
  const env = createTestEnv(); // GITHUB_APP_SLUG defaults to "gittensory" (test/helpers/d1.ts)

  it("matches our own gittensory app bot logins by prefix", () => {
    for (const login of ["gittensory[bot]", "gittensory-orb[bot]", "gittensory-review[bot]", "GITTENSORY[bot]", "gittensory", "gittensory-orb"]) {
      expect(isOwnReviewThreadAuthor(env, login)).toBe(true);
    }
  });

  it("does not match a third-party bot whose slug only ends in -gittensory[bot] (regression)", () => {
    // A `\b` boundary also fires after a hyphen, so the unanchored regex misclassified these external bots as
    // our own author and dropped their review-thread comments as self-authored non-blockers (fail-open).
    for (const login of ["evil-gittensory[bot]", "x-gittensory[bot]", "not-gittensory", "gittensory-fork"]) {
      expect(isOwnReviewThreadAuthor(env, login)).toBe(false);
    }
  });

  it("treats an absent login as not our own author", () => {
    expect(isOwnReviewThreadAuthor(env, null)).toBe(false);
    expect(isOwnReviewThreadAuthor(env, undefined)).toBe(false);
    expect(isOwnReviewThreadAuthor(env, "")).toBe(false);
  });

  it("derives the match from GITHUB_APP_SLUG (#4615), not a hardcoded literal", () => {
    const renamed = createTestEnv({ GITHUB_APP_SLUG: "acme-review" });
    expect(isOwnReviewThreadAuthor(renamed, "acme-review[bot]")).toBe(true);
    expect(isOwnReviewThreadAuthor(renamed, "acme-review-orb[bot]")).toBe(true);
    expect(isOwnReviewThreadAuthor(renamed, "acme-review")).toBe(true);
    // The OLD slug no longer matches once an operator renames their App -- proves the literal is gone.
    expect(isOwnReviewThreadAuthor(renamed, "gittensory[bot]")).toBe(false);
  });

  it("a slug containing regex metacharacters is escaped, not interpreted (defensive)", () => {
    const weird = createTestEnv({ GITHUB_APP_SLUG: "acme.bot" });
    expect(isOwnReviewThreadAuthor(weird, "acme.bot[bot]")).toBe(true);
    expect(isOwnReviewThreadAuthor(weird, "acmexbot[bot]")).toBe(false); // "." must not act as a wildcard
  });

  it("fails closed when GITHUB_APP_SLUG is blank (misconfiguration)", () => {
    const blank = createTestEnv({ GITHUB_APP_SLUG: "" });
    expect(isOwnReviewThreadAuthor(blank, "gittensory[bot]")).toBe(false);
    expect(isOwnReviewThreadAuthor(blank, "")).toBe(false);
  });

  it("fails closed when GITHUB_APP_SLUG is unset (the retired review App was deleted)", () => {
    const unset = createTestEnv();
    delete (unset as Partial<Env>).GITHUB_APP_SLUG;
    expect(isOwnReviewThreadAuthor(unset, "gittensory[bot]")).toBe(false);
    expect(isOwnReviewThreadAuthor(unset, "")).toBe(false);
  });
});

