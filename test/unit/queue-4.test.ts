import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { clearInstallationTokenCacheForTest } from "../../src/github/app";
import { clearReviewSuppressionCacheForTest } from "../../src/review/review-memory-wire";
import { PR_PANEL_COMMENT_MARKER } from "../../src/github/comments";
import * as backfillModule from "../../src/github/backfill";
import * as rateLimitModule from "../../src/github/rate-limit";
import * as repositoriesModule from "../../src/db/repositories";
import * as reviewEffortModule from "../../src/review/review-effort";
import * as repositorySettingsModule from "../../src/settings/repository-settings";
import * as sentryModule from "../../src/selfhost/sentry";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import { jobCoalesceKey } from "../../src/selfhost/queue-common";
import {
  listCollisionEdges,
  createAgentRun,
  getCommandUsefulnessSummary,
  getBurdenForecast,
  getContributorEvidence,
  getAgentRun,
  getContributorScoringProfile,
  getWebhookEvent,
  getInstallation,
  getLatestUpstreamRulesetSnapshot,
  getPullRequest,
  getPullRequestDetailSyncState,
  upsertPullRequestDetailSyncState,
  getRepository,
  listUpstreamDriftReports,
  listInstallationHealth,
  listProductUsageDailyRollups,
  listProductUsageEvents,
  listPullRequests,
  listPullRequestFiles,
  listRepoSyncStates,
  listSignalSnapshots,
  persistSignalSnapshot,
  recordGateBlockOutcome,
  markGateOutcomeOverridden,
  recordProductUsageEvent,
  upsertAgentCommandAnswer,
  upsertCheckSummary,
  upsertIssueFromGitHub,
  upsertRepoSyncSegment,
  upsertInstallation,
  updatePullRequestSlopAssessment,
  upsertOfficialMinerDetection,
  upsertPullRequestFile,
  upsertPullRequestFromGitHub,
  upsertIssueWatchSubscription,
  upsertRepositoryAiKey,
  upsertRepositorySettings,
  upsertRepositoryFromGitHub,
  putCachedAiReview,
  markAiReviewPublished,
  putCachedAiSlopAdvisory,
  putCachedLinkedIssueSatisfaction,
  recordReviewSuppression,
  listReviewSuppressions,
  setGlobalAgentFrozen,
} from "../../src/db/repositories";
import { agentMaintenanceHeadMatchesGate, changedPathsForGuardrail, claimAiReviewLock, claimPrActuationLock, contributorEvidenceBatchSize, enrichOpenPullRequestsWithChangedFiles, processJob, reconcileLiveDuplicateSiblings, releaseAiReviewLock, releasePrActuationLock, reviewDurationMsSince, SWEEP_FANOUT_RESOLUTION_CONCURRENCY } from "../../src/queue/processors";
import type { PullRequestRecord } from "../../src/types";
import { aiReviewCacheInputFingerprint } from "../../src/review/ai-review-cache-input";
import { fingerprint as reviewMemoryFingerprint } from "../../src/review/review-memory-match";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import * as focusManifestLoaderModule from "../../src/signals/focus-manifest-loader";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import {
  classifyPullRequestFreshness,
  fetchPullRequestFreshness,
} from "../../src/github/pr-freshness";
import { createTestEnv } from "../helpers/d1";
import { ISSUE_WAKE_MAX_PRS, MERGE_WAKE_MAX_PRS, SWEEP_MAX_PRS } from "../../src/settings/agent-sweep";
import { AGENT_LABEL_PENDING_CLOSURE, DEFAULT_LINKED_ISSUE_HARD_RULES } from "../../src/review/linked-issue-hard-rules";

vi.mock("../../src/github/pr-freshness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/github/pr-freshness")>();
  return {
    ...actual,
    fetchPullRequestFreshness: vi.fn(async (_env: Env, args: { expectedHeadSha?: string | null }) => ({
      status: "current" as const,
      liveHeadSha: args.expectedHeadSha ?? null,
      liveState: "open",
      liveLabels: [] as string[],
    })),
  };
});

// The re-gate sweep now FANS OUT the heavy re-review + marker stamp into per-PR `agent-regate-pr` jobs
// (#audit-sweep-fanout). A test asserting the re-review/stamp side effects must run the sweep AND drain the
// per-PR jobs it enqueues. Returns the captured agent-regate-pr jobs for assertions.
async function sweepAndDrainPerPr(env: Env, repoFullName: string): Promise<import("../../src/types").JobMessage[]> {
  const fanned: import("../../src/types").JobMessage[] = [];
  const send = env.JOBS.send.bind(env.JOBS);
  env.JOBS.send = (async (message: import("../../src/types").JobMessage, options?: QueueSendOptions) => {
    if (message.type === "agent-regate-pr") fanned.push(message);
    return send(message, options);
  }) as typeof env.JOBS.send;
  await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName });
  env.JOBS.send = send;
  for (const job of fanned) await processJob(env, job);
  return fanned;
}


function completeSegment(repoFullName: string, segment: "labels" | "open_issues" | "open_pull_requests") {
  return {
    repoFullName,
    segment,
    status: "complete" as const,
    sourceKind: "test" as const,
    mode: "resume" as const,
    fetchedCount: 1,
    expectedCount: 1,
    pageCount: 1,
    completedAt: "2026-05-25T00:00:00.000Z",
    warnings: [],
  };
}

type CommandAnswerFixture = Parameters<typeof upsertAgentCommandAnswer>[1];

function commandAnswer(id: string, command: string, overrides: Partial<CommandAnswerFixture> = {}): CommandAnswerFixture {
  return {
    id,
    repoFullName: "JSONbored/gittensory",
    issueNumber: 77,
    command,
    requestCommentId: 7,
    responseCommentId: 9001,
    responseUrl: "https://github.com/JSONbored/gittensory/pull/77#issuecomment-9001",
    actorKind: "maintainer" as const,
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

function commandAnswerBody(answerId: string, command: string): string {
  return [
    "<!-- gittensory-agent-command -->",
    `<!-- gittensory-agent-command-answer:${answerId} -->`,
    `Command: \`@gittensory ${command}\``,
    "Feedback is aggregate-only.",
  ].join("\n");
}

function queueMinerSnapshot(login: string) {
  return {
    source: "gittensor_api" as const,
    githubId: "123",
    githubUsername: login,
    isEligible: true,
    credibility: 1,
    eligibleRepoCount: 1,
    issueDiscoveryScore: 0,
    issueTokenScore: 0,
    issueCredibility: 1,
    isIssueEligible: false,
    issueEligibleRepoCount: 0,
    alphaPerDay: 0,
    taoPerDay: 0,
    usdPerDay: 0,
    totals: {
      pullRequests: 3,
      mergedPullRequests: 2,
      openPullRequests: 1,
      closedPullRequests: 0,
      openIssues: 0,
      closedIssues: 0,
      solvedIssues: 0,
      validSolvedIssues: 0,
    },
    repositories: [],
    pullRequests: [],
    issueLabels: [],
  };
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function withProductUsageInsertFailure(env: Env): Env {
  const db = env.DB as unknown as { prepare(sql: string): unknown; batch(statements: unknown[]): Promise<unknown> };
  return {
    ...env,
    DB: {
      prepare(sql: string) {
        if (sql.includes("product_usage_events")) throw new Error("product usage insert failed");
        return db.prepare.call(db, sql);
      },
      batch(statements: unknown[]) {
        return db.batch.call(db, statements);
      },
    } as unknown as D1Database,
  };
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

describe("queue processors", () => {
  // Freshness-SLO fixtures are dated relative to late May 2026; pin the clock so staleness windows
  // stay deterministic regardless of when CI runs.
  beforeEach(() => {
    clearInstallationTokenCacheForTest();
    clearReviewSuppressionCacheForTest();
    vi.mocked(fetchPullRequestFreshness).mockReset();
    vi.mocked(fetchPullRequestFreshness).mockImplementation(async (_env, args) => ({
      status: "current",
      liveHeadSha: args.expectedHeadSha ?? null,
      liveState: "open",
      liveLabels: [],
    }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-28T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function seedBehindRepo(env: Env, over: { autonomy?: Record<string, string>; agentPaused?: boolean; perms?: Record<string, string>; noInstall?: boolean } = {}) {
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    if (!over.noInstall) {
      await upsertInstallation(env, {
        installation: {
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: over.perms ?? { metadata: "read", pull_requests: "write", issues: "write" },
          events: ["pull_request"],
        },
        repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
      });
    }
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      autonomy: over.autonomy ?? { merge: "auto", update_branch: "auto" },
      agentPaused: over.agentPaused ?? false,
    });
  }

  function behindWebhook() {
    return {
      type: "github-webhook" as const,
      deliveryId: "behind-update-branch",
      eventName: "pull_request" as const,
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 48, title: "Behind base", state: "open", user: { login: "contributor" }, head: { sha: "behindsha" }, labels: [], body: "x" },
      },
    };
  }

  it("auto-maintain (#1092): a BEHIND-base PR routes update-branch through the executor, then defers review", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedBehindRepo(env);
    let updateBranchCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/48/update-branch")) {
        updateBranchCalls += 1;
        return Response.json({ message: "Updating pull request branch." }, { status: 202 });
      }
      if (/\/pulls\/48(?:\?|$)/.test(url)) return Response.json({ number: 48, state: "open", head: { sha: "behindsha" }, mergeable_state: "behind" });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, behindWebhook());

    expect(updateBranchCalls).toBe(1); // the rebase was issued before review
    const ub = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.action.update_branch").first<{ outcome: string }>();
    expect(ub?.outcome).toBe("completed");
    // Deferred for the rebase → no gate verdict published on the stale head.
    const merge = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("agent.action.merge").first<{ n: number }>();
    expect(merge?.n).toBe(0);
  });

  it("auto-maintain (#1092): a behind PR is not rebased when the installation lacks pull_requests:write (falls through)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedBehindRepo(env, { noInstall: true });
    // A stored open PR + the recapture-preview job drive reReviewStoredPullRequest directly (no webhook
    // installation upsert), so getInstallation(...) is null → installation?.permissions ?? null hits the null arm.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 48, title: "Behind base", state: "open", user: { login: "contributor" }, head: { sha: "behindsha" }, labels: [], body: "x" });
    let updateBranchCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/48/update-branch")) {
        updateBranchCalls += 1;
        return Response.json({}, { status: 202 });
      }
      if (/\/pulls\/48(?:\?|$)/.test(url)) return Response.json({ number: 48, mergeable_state: "behind" });
      // CI still running on the (un-rebased) head → prReadyForReview defers at the CI gate, cleanly.
      if (url.includes("/commits/behindsha/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "CI build", status: "in_progress", conclusion: null }] });
      if (url.includes("/commits/behindsha/status")) return Response.json({ state: "pending", statuses: [] });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, { type: "recapture-preview", deliveryId: "rp-48", installationId: 123, repoFullName: "JSONbored/gittensory", prNumber: 48, attempt: 1 });

    expect(updateBranchCalls).toBe(0); // no installation perms → the executor denies the write; the block falls through
  });

  it("recapture-preview (#1158): a clean PR re-review threads previewPollAttempt into the public-surface publish", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9101, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "preview-repo", full_name: "owner/preview-repo", private: false, owner: { login: "owner" } }, 9101);
    await upsertRepositorySettings(env, { repoFullName: "owner/preview-repo", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/preview-repo", { number: 9, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "c9" }, labels: [], body: "x" });
    await upsertPullRequestFile(env, { repoFullName: "owner/preview-repo", pullNumber: 9, path: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, payload: { patch: "@@\n+export const ok = true;" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/9/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (/\/pulls\/9(?:\?|$)/.test(url)) return Response.json({ number: 9, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "c9" }, labels: [], body: "x" });
      if (url.includes("/commits/c9/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/c9/status")) return Response.json({ state: "success", statuses: [] });
      return new Response("not found", { status: 404 });
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    // attempt:2 → previewPollAttempt is defined, so the conditional spread at the publish call takes the
    // `{ previewPollAttempt }` arm (the recapture-preview poll path; the sweep/webhook callers omit it).
    await expect(
      processJob(env, { type: "recapture-preview", deliveryId: "rp-9", installationId: 9101, repoFullName: "owner/preview-repo", prNumber: 9, attempt: 2 }),
    ).resolves.toBeUndefined();
  });

  it("recapture-preview (#review-pre-merge-checks): a slop-gated re-review refreshes the PR's files before publishing", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9102, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "slop-repo", full_name: "owner/slop-repo", private: false, owner: { login: "owner" } }, 9102);
    // slopGateMode != "off" ⇒ shouldCollectSlopEvidence(settings) is true ⇒ reReviewStoredPullRequest enters the
    // refresh branch (the file-refresh body), so the stored files reflect the PR's current head before publishing.
    await upsertRepositorySettings(env, { repoFullName: "owner/slop-repo", checkRunMode: "off", commentMode: "off", publicSurface: "off", slopGateMode: "advisory" });
    await upsertPullRequestFromGitHub(env, "owner/slop-repo", { number: 11, title: "Slop PR", state: "open", user: { login: "contributor" }, head: { sha: "s11" }, labels: [], body: "x" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/11/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (/\/pulls\/11(?:\?|$)/.test(url)) return Response.json({ number: 11, title: "Slop PR", state: "open", user: { login: "contributor" }, head: { sha: "s11" }, labels: [], body: "x" });
      if (url.includes("/commits/s11/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/s11/status")) return Response.json({ state: "success", statuses: [] });
      return new Response("not found", { status: 404 });
    });

    await expect(
      processJob(env, { type: "recapture-preview", deliveryId: "rp-11", installationId: 9102, repoFullName: "owner/slop-repo", prNumber: 11, attempt: 1 }),
    ).resolves.toBeUndefined();

    // refreshPullRequestDetails ran ⇒ a detail-sync-state row was written for this PR (the if-body executed).
    const sync = await env.DB.prepare("select status from pull_request_detail_sync_state where repo_full_name = ? and pull_number = ?").bind("owner/slop-repo", 11).first<{ status: string }>();
    expect(sync?.status).toMatch(/^(complete|partial)$/);
  });

  it("auto-maintain (#778): a repo with no acting autonomy takes no agent action", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "block",
      requireLinkedIssue: true,
      autonomy: { label: "observe" }, // not acting → agent never runs
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/gate123/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) return Response.json({ id: 900 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "no-autonomy",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 43, title: "No issue", state: "open", user: { login: "contributor" }, head: { sha: "gate123" }, labels: [], body: "No issue link." },
      },
    });

    const count = await env.DB.prepare("select count(*) as n from audit_events where event_type like 'agent.action.%'").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("auto-maintain (#778): takes no terminal action when merge/close/approve autonomy is not granted (gate now fails normally for a non-confirmed author)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      autonomy: { review_state_label: "auto", request_changes: "auto" },
    });
    // No confirmed-miner seed → author is unconfirmed; the manifest's linkedIssue:block + no issue fires a
    // blocker, so the gate now FAILS the author normally (#gate-nonconfirmed — confirmed status no longer
    // neutralizes the verdict). But this repo grants only review_state_label/request_changes autonomy — NOT
    // merge/close/approve — so the failing gate yields a request-changes/label action at most, never a terminal action.
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { linkedIssue: "block" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/gate123/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) return Response.json({ id: 900 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "unconfirmed",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 45, title: "No issue", state: "open", user: { login: "stranger" }, head: { sha: "gate123" }, labels: [], body: "No issue link." },
      },
    });

    // The failing gate is surfaced (request-changes/label), but with no merge/close/approve autonomy granted the
    // bot takes NO TERMINAL action — proving terminal actions require their own autonomy grant, independent of the
    // gate verdict. (Auto-close on a failing gate is exercised by the #778 close-autonomy tests below.)
    const terminal = await env.DB.prepare("select count(*) as n from audit_events where event_type in ('agent.action.merge','agent.action.close','agent.action.approve')").first<{ n: number }>();
    expect(terminal?.n).toBe(0);
  });

  it("auto-maintain (#778): skips a closed PR even on an agent-configured repo", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      autonomy: { label: "auto" },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/check-runs")) return Response.json({ id: 900 }, { status: 201 });
      if (url.includes("/comments")) return Response.json({ id: 1 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "closed-pr",
      eventName: "pull_request",
      payload: {
        action: "closed",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 46, title: "Closed", state: "closed", user: { login: "contributor" }, head: { sha: "gate123" }, labels: [], body: "x" },
      },
    });

    const count = await env.DB.prepare("select count(*) as n from audit_events where event_type like 'agent.action.%'").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("auto-maintain (#778): labels a clean passing PR even with no author and no installation record (dry-run)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    // No installation record seeded → installation lookup returns null (label needs only issues:write, exempt).
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      autonomy: { review_state_label: "auto" },
      agentDryRun: true,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/clean123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/clean123/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) return Response.json({ id: 900 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "no-author-clean",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        // No `user` → authorLogin is absent; default linkedIssue mode is advisory so the verdict is a clean pass.
        pull_request: { number: 47, title: "Clean", state: "open", head: { sha: "clean123" }, labels: [], body: "Closes #1" },
      },
    });

    const labelAudit = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("agent.action.label").first<{ outcome: string; metadata_json: string }>();
    expect(labelAudit?.outcome).toBe("completed");
    expect(JSON.parse(labelAudit?.metadata_json ?? "{}")).toMatchObject({ mode: "dry_run" });
  });

  it("publishes an enabled gate when bot PR public output is skipped", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "block",
    });
    const calls = { gateChecks: 0, comments: 0, minerList: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([]);
      }
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gatebot123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/issues/53/comments")) {
        calls.comments += 1;
        return Response.json([]);
      }
      if (url.includes("/check-runs") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string; output?: { title?: string } };
        expect(body).toMatchObject({ status: "in_progress", output: { title: "LoopOver Orb Review Agent is evaluating" } });
        expect(body.conclusion).toBeUndefined();
        calls.gateChecks += 1;
        return Response.json({ id: 910 }, { status: 201 });
      }
      if (url.includes("/check-runs/910") && method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string; output?: { title?: string } };
        // The bot author is gated normally now (no confirmation gate); linked-issue block + no issue → failure (#gate-nonconfirmed).
        expect(body).toMatchObject({ status: "completed", conclusion: "failure", output: { title: "LoopOver Orb Review Agent: No linked issue detected" } });
        calls.gateChecks += 1;
        return Response.json({ id: 910 });
      }
      return new Response("not found", { status: 404 });
    });

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { linkedIssue: "block" } });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-bot-public-skip",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 53, title: "Bot PR", state: "open", user: { login: "automation-bot", type: "Bot" }, head: { sha: "gatebot123" }, labels: [], body: "No issue link." },
      },
    });

    expect(calls).toEqual({ gateChecks: 2, comments: 0, minerList: 0 });
    const audit = await env.DB.prepare("select detail from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.pr_visibility_skipped", "JSONbored/gittensory#53")
      .first<{ detail: string }>();
    expect(audit?.detail).toBe("bot_author");
  });

  it("evaluates the gate while suppressing public review output for ignored authors", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "block",
    });
    const calls = { gateChecks: 0, comments: 0, minerList: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([]);
      }
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/ignoredauthor123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/issues/56/comments")) {
        if (method !== "GET") calls.comments += 1;
        return Response.json([]);
      }
      if (url.includes("/check-runs") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string; output?: { title?: string } };
        expect(body).toMatchObject({ status: "in_progress", output: { title: "LoopOver Orb Review Agent is evaluating" } });
        expect(body.conclusion).toBeUndefined();
        calls.gateChecks += 1;
        return Response.json({ id: 930 }, { status: 201 });
      }
      if (url.includes("/check-runs/930") && method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string; output?: { title?: string } };
        expect(body).toMatchObject({
          status: "completed",
          conclusion: "failure",
          output: { title: "LoopOver Orb Review Agent: No linked issue detected" },
        });
        calls.gateChecks += 1;
        return Response.json({ id: 930 });
      }
      return new Response("not found", { status: 404 });
    });

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", {
      gate: { linkedIssue: "block" },
      review: { auto_review: { ignore_authors: ["renovate*"] } },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "ignored-author-skip",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 56, title: "Automated dependency update", state: "open", user: { login: "renovate-release" }, head: { sha: "ignoredauthor123" }, labels: [], body: "No issue link." },
      },
    });

    expect(calls).toEqual({ gateChecks: 2, comments: 1, minerList: 0 });
    const visibilitySkip = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.pr_visibility_skipped", "JSONbored/gittensory#56")
      .first<{ detail: string; metadata_json: string }>();
    expect(visibilitySkip?.detail).toBe("ignored_author");
    expect(JSON.parse(visibilitySkip?.metadata_json ?? "{}")).toMatchObject({ deliveryId: "ignored-author-skip" });
  });

  it("audits ignored authors without a skipped check when review checks are disabled", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "disabled",
      linkedIssueGateMode: "off",
    });
    const calls = { github: 0, minerList: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") calls.minerList += 1;
      if (url.includes("api.github.com")) calls.github += 1;
      return new Response("not found", { status: 404 });
    });

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", {
      review: { auto_review: { ignore_authors: ["release-please*"] } },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "ignored-author-no-check",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 57, title: "Automated release", state: "open", user: { login: "release-please-bot" }, head: { sha: "ignorednocheck123" }, labels: [], body: "No issue link." },
      },
    });

    expect(calls).toEqual({ github: 0, minerList: 0 });
    const skipped = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.pr_visibility_skipped", "JSONbored/gittensory#57")
      .first<{ detail: string; metadata_json: string }>();
    expect(skipped?.detail).toBe("ignored_author");
    expect(JSON.parse(skipped?.metadata_json ?? "{}")).toMatchObject({ deliveryId: "ignored-author-no-check" });
  });

  it("keeps surface_off precedence over ignored authors when no PR surface is visible", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "disabled",
      linkedIssueGateMode: "off",
    });
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", {
      review: { auto_review: { ignore_authors: ["renovate*"] } },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "surface-off-before-ignored-author",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 58, title: "Automated dependency update", state: "open", user: { login: "renovate-release" }, head: { sha: "surfaceoff123" }, labels: [], body: "No issue link." },
      },
    });

    const skips = await env.DB.prepare("select detail from audit_events where event_type = ? and target_key = ? order by created_at")
      .bind("github_app.pr_visibility_skipped", "JSONbored/gittensory#58")
      .all<{ detail: string }>();
    expect(skips.results.map((row) => row.detail)).toEqual(["surface_off"]);
    const publicSkip = await env.DB.prepare("select detail from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.pr_public_surface_skipped", "JSONbored/gittensory#58")
      .first<{ detail: string }>();
    expect(publicSkip ?? null).toBeNull();
  });

  it("publishes an enabled gate when Gittensor-only public output is skipped for an unconfirmed miner", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicAudienceMode: "gittensor_only",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "block",
    });
    const calls = { minerList: 0, gateChecks: 0, comments: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([]);
      }
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gateminer123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/issues/54/comments")) {
        calls.comments += 1;
        return Response.json([]);
      }
      if (url.includes("/check-runs") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string; output?: { title?: string } };
        expect(body).toMatchObject({ status: "in_progress", output: { title: "LoopOver Orb Review Agent is evaluating" } });
        expect(body.conclusion).toBeUndefined();
        calls.gateChecks += 1;
        return Response.json({ id: 920 }, { status: 201 });
      }
      if (url.includes("/check-runs/920") && method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string; output?: { title?: string } };
        // The unconfirmed miner is gated normally now; linked-issue block + no issue → failure (#gate-nonconfirmed).
        expect(body).toMatchObject({ status: "completed", conclusion: "failure", output: { title: "LoopOver Orb Review Agent: No linked issue detected" } });
        calls.gateChecks += 1;
        return Response.json({ id: 920 });
      }
      return new Response("not found", { status: 404 });
    });

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { linkedIssue: "block" } });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-unconfirmed-miner-public-skip",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 54, title: "Unconfirmed miner PR", state: "open", user: { login: "newbie" }, head: { sha: "gateminer123" }, labels: [], body: "No issue link." },
      },
    });

    expect(calls).toEqual({ minerList: 1, gateChecks: 2, comments: 0 });
    const audit = await env.DB.prepare("select detail from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.pr_visibility_skipped", "JSONbored/gittensory#54")
      .first<{ detail: string }>();
    expect(audit?.detail).toBe("not_official_gittensor_miner");
  });

  it("keeps gate checks without double-auditing unavailable miner detection as not official", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicAudienceMode: "gittensor_only",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "block",
    });

    const calls = { minerList: 0, gateChecks: 0, comments: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return new Response("gittensor unavailable", { status: 503 });
      }
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gateunavailable123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/issues/55/comments")) {
        calls.comments += 1;
        return Response.json([]);
      }
      if (url.includes("/check-runs") && method === "POST") {
        calls.gateChecks += 1;
        return Response.json({ id: 921 }, { status: 201 });
      }
      if (url.includes("/check-runs/921") && method === "PATCH") {
        calls.gateChecks += 1;
        return Response.json({ id: 921 });
      }
      return new Response("not found", { status: 404 });
    });

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { linkedIssue: "block" } });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-unavailable-miner-public-skip",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Unavailable miner PR", state: "open", user: { login: "newbie" }, head: { sha: "gateunavailable123" }, labels: [], body: "No issue link." },
      },
    });

    expect(calls).toEqual({ minerList: 1, gateChecks: 2, comments: 0 });
    const audit = await env.DB.prepare("select detail from audit_events where event_type = ? and target_key = ? order by id")
      .bind("github_app.pr_visibility_skipped", "JSONbored/gittensory#55")
      .all<{ detail: string }>();
    expect(audit.results.map((event) => event.detail)).toEqual(["miner_detection_unavailable"]);
  });

  it("hard-blocks a confirmed Gittensor contributor in a gate-only configuration when a configured blocker fires", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicAudienceMode: "oss_maintainer",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "block",
    });
    const calls = { minerList: 0, gateChecks: 0 };
    let gatePatchBody: { conclusion?: string; output?: { title?: string; text?: string } } = {};
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([
          { uid: 7, githubUsername: "confirmed-dev", githubId: "123", totalPrs: 4, totalMergedPrs: 3, totalOpenPrs: 1, totalClosedPrs: 0, totalOpenIssues: 0, totalClosedIssues: 0, totalSolvedIssues: 0, totalValidSolvedIssues: 0, isEligible: true, credibility: 1, eligibleRepoCount: 1 },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({ repositories: [{ repositoryFullName: "JSONbored/gittensory", totalPrs: "4", totalMergedPrs: "3", totalOpenPrs: "1", totalClosedPrs: "0", totalOpenIssues: "0", totalClosedIssues: "0", isEligible: true, credibility: "1.000000" }] });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/confirmed123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs/940") && method === "PATCH") {
        gatePatchBody = JSON.parse(String(init?.body ?? "{}")) as typeof gatePatchBody;
        calls.gateChecks += 1;
        return Response.json({ id: 940 });
      }
      if (url.includes("/check-runs") && method === "POST") {
        calls.gateChecks += 1;
        return Response.json({ id: 940 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { linkedIssue: "block" } });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-confirmed-block",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 61, title: "Add helper", state: "open", user: { login: "confirmed-dev" }, head: { sha: "confirmed123" }, labels: [], body: "Adds a helper." },
      },
    });

    // A confirmed contributor with a configured hard blocker (linked-issue gate set to block, no issue
    // linked) IS blocked even when the Gate is the only public output, and the Gate names the exact
    // blocker so the fix is obvious.
    expect(calls.minerList).toBe(1);
    expect(calls.gateChecks).toBe(2);
    expect(gatePatchBody.conclusion).toBe("failure");
    expect(gatePatchBody.output?.title).toBe("LoopOver Orb Review Agent: No linked issue detected");
  });

  it("hard-blocks a confirmed contributor on a dual-model AI consensus defect when aiReview: block is opted in", async () => {
    const defectJson = JSON.stringify({
      assessment: "Introduces a likely crash.",
      blockers: ["Unhandled null dereference on empty input in src/a.ts — the new branch dereferences a possibly-null value."],
      nits: ["Guard the null case."],
      suggestions: ["Guard the null case."],
    });
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: async () => ({ response: defectJson }) } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "off",
      aiReviewMode: "block",
      // Also exercise the opt-in slop advisory in the same surface pass: it persists a per-PR assessment
      // and runs the (advisory-only) AI slop pass, but never blocks — the gate still fails on the AI
      // consensus defect alone.
      slopGateMode: "advisory",
      slopAiAdvisory: true,
    });
    let gatePatchBody: { conclusion?: string; output?: { title?: string; text?: string } } = {};
    const cacheReadSpy = vi
      .spyOn(repositoriesModule, "getCachedAiReview")
      .mockRejectedValueOnce(new Error("cache read failed"));
    const cacheWriteSpy = vi
      .spyOn(repositoriesModule, "putCachedAiReview")
      .mockRejectedValueOnce(new Error("cache write failed"));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          { uid: 7, githubUsername: "confirmed-dev", githubId: "123", totalPrs: 4, totalMergedPrs: 3, totalOpenPrs: 1, totalClosedPrs: 0, totalOpenIssues: 0, totalClosedIssues: 0, totalSolvedIssues: 0, totalValidSolvedIssues: 0, isEligible: true, credibility: 1, eligibleRepoCount: 1 },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({ repositories: [{ repositoryFullName: "JSONbored/gittensory", totalPrs: "4", totalMergedPrs: "3", totalOpenPrs: "1", totalClosedPrs: "0", totalOpenIssues: "0", totalClosedIssues: "0", isEligible: true, credibility: "1.000000" }] });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/aidefect123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs/950") && method === "PATCH") {
        gatePatchBody = JSON.parse(String(init?.body ?? "{}")) as typeof gatePatchBody;
        return Response.json({ id: 950 });
      }
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 950 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-ai-consensus-block",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 71, title: "Add helper", state: "open", user: { login: "confirmed-dev" }, head: { sha: "aidefect123" }, labels: [], body: "Adds a helper." },
      },
    });

    expect(gatePatchBody.conclusion).toBe("failure");
    expect(gatePatchBody.output?.title).toContain("AI reviewers agree on a likely critical defect");
    // The AI usage event was recorded for the review (never with key material).
    const usage = await env.DB.prepare("select feature, status from ai_usage_events where feature = ?").bind("ai_review_pr").first<{ feature: string; status: string }>();
    expect(usage).toMatchObject({ feature: "ai_review_pr", status: "ok" });
    expect(cacheReadSpy).toHaveBeenCalled();
    expect(cacheReadSpy.mock.calls[0]?.[5]).toMatch(/^ai-review-input:v4:/);
    expect(cacheWriteSpy).toHaveBeenCalled();
    expect(cacheWriteSpy.mock.calls[0]?.[5]).toMatchObject({
      metadata: { inputFingerprint: expect.stringMatching(/^ai-review-input:v4:/) },
    });
    cacheReadSpy.mockRestore();
    cacheWriteSpy.mockRestore();
  });

  it("finalizes the Gate to neutral instead of leaving it in_progress when gate completion fails", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "off",
    });
    const patchBodies: Array<{ status?: string; conclusion?: string; output?: { title?: string } }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/finalize123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 970 }, { status: 201 }); // pending
      if (url.includes("/check-runs/970") && method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string; output?: { title?: string } };
        patchBodies.push(body);
        // First PATCH = the gate completion; fail it transiently so the catch must finalize the check.
        if (patchBodies.length === 1) return new Response(JSON.stringify({ message: "server error" }), { status: 500 });
        return Response.json({ id: 970 });
      }
      return new Response("not found", { status: 404 });
    });
    const realPrepare = env.DB.prepare.bind(env.DB);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    env.DB.prepare = ((sql: string) => {
      if (/insert\s+into\s+["`]?check_summaries["`]?/i.test(sql)) throw new Error("summary write failed");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-finalize-on-error",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 80, title: "Some change", state: "open", user: { login: "contributor" }, head: { sha: "finalize123" }, labels: [], body: "No issue link." },
      },
    });

    // The completion PATCH failed (500), so the LOCAL check-run catch finalized the SAME check run (id 970) to
    // a neutral, non-blocking terminal state — never left hanging in_progress — and CONTINUED the review
    // (no re-throw), so the comment/audit/auto-action still run instead of the whole review dead-lettering.
    expect(patchBodies.length).toBe(2);
    const finalize = patchBodies[1];
    expect(finalize?.status).toBe("completed");
    expect(finalize?.conclusion).toBe("neutral");
    expect(finalize?.output?.title).toBe("LoopOver Orb Review Agent — could not finish evaluating");
    const audit = await env.DB.prepare("select outcome from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.gate_check_failed_nonfatal", "JSONbored/gittensory#80")
      .first<{ outcome: string }>();
    expect(audit?.outcome).toBe("error");
    expect(errors.mock.calls.some((call) => String(call[0]).includes("gate_check_summary_upsert_failed"))).toBe(true);
    errors.mockRestore();
  });

  it("does not stamp a current public surface when a required Gate check never finalizes", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "off",
      aiReviewMode: "off",
    });
    let commentPosts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.endsWith("/users/contributor")) return Response.json({ login: "contributor", public_repos: 1 });
      if (url.includes("/users/contributor/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate-missing/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 972 }, { status: 201 });
      if (url.includes("/check-runs/972") && method === "PATCH") return new Response("check update failed", { status: 500 });
      if (url.includes("/issues/82/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/82/comments") && method === "POST") {
        commentPosts += 1;
        return Response.json({ id: 8200, html_url: "https://github.com/comment/8200" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-missing-but-comment-posted",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 82, title: "Comment cannot mask missing gate", state: "open", user: { login: "contributor" }, head: { sha: "gate-missing" }, labels: [], body: "No issue link." },
      },
    });

    expect(commentPosts).toBeGreaterThan(0);
    const stored = await getPullRequest(env, "JSONbored/gittensory", 82);
    expect(stored?.lastPublishedSurfaceSha ?? null).toBeNull();
    const incomplete = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = ?")
      .bind("github_app.pr_public_surface_incomplete")
      .first<{ detail: string; metadata_json: string }>();
    expect(incomplete?.detail).toBe("required gate check did not finalize");
    expect(incomplete?.metadata_json).toContain('"publishedOutputs":["comment"]');
    const published = await env.DB.prepare("select event_type from audit_events where event_type = ?")
      .bind("github_app.pr_public_surface_published")
      .all();
    expect(published.results).toEqual([]);
    const summary = await env.DB.prepare("select id from check_summaries where repo_full_name = ? and pull_number = ? and head_sha = ?")
      .bind("JSONbored/gittensory", 82, "gate-missing")
      .first<{ id: string }>();
    expect(summary ?? null).toBeNull();
  });

  it("records the intended label in incomplete-surface audits when a label publishes but Gate never finalizes", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "label_only",
      autoLabelEnabled: true,
      createMissingLabel: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "off",
      aiReviewMode: "off",
    });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    let labelPosts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate-missing-label/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 978 }, { status: 201 });
      if (url.includes("/check-runs/978") && method === "PATCH") return new Response("check update failed", { status: 500 });
      if (url.includes("/issues/88/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/88/labels") && method === "POST") {
        labelPosts += 1;
        return Response.json([{ name: "gittensor" }]);
      }
      if (url.includes("/labels") && method === "POST") return Response.json({ name: "gittensor" }, { status: 201 });
      if (url.includes("/labels/") && method === "DELETE") return new Response(null, { status: 204 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-missing-label-published",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 88, title: "Label cannot mask missing gate", state: "open", user: { login: "contributor" }, head: { sha: "gate-missing-label" }, labels: [], body: "Fixes #1" },
      },
    });

    expect(labelPosts).toBeGreaterThan(0);
    const stored = await getPullRequest(env, "JSONbored/gittensory", 88);
    expect(stored?.lastPublishedSurfaceSha ?? null).toBeNull();
    const incomplete = await env.DB.prepare("select metadata_json from audit_events where event_type = ?")
      .bind("github_app.pr_public_surface_incomplete")
      .first<{ metadata_json: string }>();
    const metadata = JSON.parse(incomplete?.metadata_json ?? "{}");
    expect(metadata).toMatchObject({
      label: "gittensor",
      publishedOutputs: ["label"],
    });
  });

  it("does not stamp a gate-only surface when the incomplete-surface audit write fails", async () => {
    const originalRecordAuditEvent = repositoriesModule.recordAuditEvent;
    let incompleteAuditWrites = 0;
    const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockImplementation(async (auditEnv, event) => {
      if (event.eventType === "github_app.pr_public_surface_incomplete") {
        incompleteAuditWrites += 1;
        throw new Error("audit failed");
      }
      await originalRecordAuditEvent(auditEnv, event);
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "off",
      aiReviewMode: "off",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate-zero-missing/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 973 }, { status: 201 });
      if (url.includes("/check-runs/973") && method === "PATCH") return new Response("check update failed", { status: 500 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-missing-zero-output",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 83, title: "Gate only missing", state: "open", user: { login: "contributor" }, head: { sha: "gate-zero-missing" }, labels: [], body: "No issue link." },
      },
    });

    expect(incompleteAuditWrites).toBe(1);
    const stored = await getPullRequest(env, "JSONbored/gittensory", 83);
    expect(stored?.lastPublishedSurfaceSha ?? null).toBeNull();
    auditSpy.mockRestore();
  });

  it("does not stamp a comment surface when the incomplete-surface audit write fails", async () => {
    const originalRecordAuditEvent = repositoriesModule.recordAuditEvent;
    let incompleteAuditWrites = 0;
    const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockImplementation(async (auditEnv, event) => {
      if (event.eventType === "github_app.pr_public_surface_incomplete") {
        incompleteAuditWrites += 1;
        throw new Error("audit failed");
      }
      await originalRecordAuditEvent(auditEnv, event);
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "off",
      aiReviewMode: "off",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.endsWith("/users/contributor")) return Response.json({ login: "contributor", public_repos: 1 });
      if (url.includes("/users/contributor/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate-comment-missing/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 974 }, { status: 201 });
      if (url.includes("/check-runs/974") && method === "PATCH") return new Response("check update failed", { status: 500 });
      if (url.includes("/issues/84/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/84/comments") && method === "POST") return Response.json({ id: 8400, html_url: "https://github.com/comment/8400" }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-missing-comment-audit-fails",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 84, title: "Comment missing gate", state: "open", user: { login: "contributor" }, head: { sha: "gate-comment-missing" }, labels: [], body: "No issue link." },
      },
    });

    expect(incompleteAuditWrites).toBe(1);
    const stored = await getPullRequest(env, "JSONbored/gittensory", 84);
    expect(stored?.lastPublishedSurfaceSha ?? null).toBeNull();
    auditSpy.mockRestore();
  });

  it("propagates a rate-limited Gate completion so the queue retries and the pending Gate stays reviewing", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "off",
    });
    const patchBodies: Array<{ status?: string; conclusion?: string; output?: { title?: string } }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/forbidden403/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 971 }, { status: 201 }); // pending in_progress
      if (url.includes("/check-runs/971") && method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string; output?: { title?: string } };
        patchBodies.push(body);
        // Gate completion stays rate-limited through the inline retry budget. It must propagate to the queue instead
        // of being swallowed as nonfatal; the pending check remains in_progress while the queue backs off and retries.
        return new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), { status: 403, headers: { "retry-after": "0" } });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "gate-finalize-on-403",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 81, title: "Some change", state: "open", user: { login: "contributor" }, head: { sha: "forbidden403" }, labels: [], body: "No issue link." },
        },
      }),
    ).rejects.toThrow(/rate limit/i);

    expect(patchBodies).toHaveLength(4); // initial attempt + GITHUB_RATE_LIMIT_MAX_RETRIES (3)
    expect(patchBodies[0]?.status).toBe("completed");
  });

  it("disables the gate from .loopover.yml (gate.enabled: false) even when repo settings enable it", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "block",
      requireLinkedIssue: true,
    });
    // Config turns the gate OFF even though repo settings have reviewCheckMode: required (the gate check-run publishing).
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { enabled: false } });
    const calls = { gateChecks: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/check-runs")) {
        calls.gateChecks += 1;
        return Response.json({ id: 999 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-yml-disabled",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 70, title: "No issue", state: "open", user: { login: "contributor" }, head: { sha: "ymldisabled123" }, labels: [], body: "No issue." },
      },
    });

    // gate.enabled: false in .loopover.yml disables the gate entirely — no Gate check is posted.
    expect(calls.gateChecks).toBe(0);
  });

  it("audits opt-in gate check permission failures without blocking webhook processing", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      requireLinkedIssue: true,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate403/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs")) return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-permission-missing",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 42, title: "Gate without issue", state: "open", user: { login: "contributor" }, head: { sha: "gate403" }, labels: [], body: "No issue link." },
      },
    });

    const audit = await env.DB.prepare("select event_type, actor, target_key, outcome, detail from audit_events where event_type = ?")
      .bind("github_app.gate_check_permission_missing")
      .first<{ event_type: string; actor: string; target_key: string; outcome: string; detail: string }>();

    expect(audit).toMatchObject({
      event_type: "github_app.gate_check_permission_missing",
      actor: "contributor",
      target_key: "JSONbored/gittensory#42",
      outcome: "error",
    });
    expect(audit?.detail).toMatch(/Checks: write permission is missing/i);
  });

  it("marks closed PR gates skipped without creating late first comments", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
    });
    const calls = { gateWrites: 0, commentGets: 0, commentPosts: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/closed123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; status?: string; conclusion?: string; output?: { title?: string } };
        expect(body).toMatchObject({ name: "LoopOver Orb Review Agent", status: "completed", conclusion: "skipped", output: { title: "LoopOver Orb Review Agent skipped" } });
        calls.gateWrites += 1;
        return Response.json({ id: 901 }, { status: 201 });
      }
      if (url.includes("/issues/43/comments") && method === "GET") {
        calls.commentGets += 1;
        return Response.json([]);
      }
      if (url.includes("/issues/43/comments") && method === "POST") {
        calls.commentPosts += 1;
        return Response.json({ id: 1 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-closed",
      eventName: "pull_request",
      payload: {
        action: "closed",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 43, title: "Fast merged PR", state: "closed", user: { login: "contributor" }, head: { sha: "closed123" }, labels: [], body: "Fixes #1" },
      },
    });

    // The real review is PRESERVED on close: the gate check is marked skipped (gateWrites:1), but the unified
    // comment is NOT touched (commentGets:0, commentPosts:0) — no post-close pass overwrites the open-time review
    // with an empty skip card. (#preserve-review-on-close)
    expect(calls).toEqual({ gateWrites: 1, commentGets: 0, commentPosts: 0 });
  });

  it("audits closed PR skipped gate permission failures (no late panel write — the real review is preserved)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
    });
    let commentGets = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/check-runs")) return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
      if (url.includes("/issues/47/comments")) {
        commentGets += 1;
        return new Response("comments down", { status: 503 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-closed-permission-missing",
      eventName: "pull_request",
      payload: {
        action: "closed",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 47, title: "Fast merged PR", state: "closed", user: { login: "contributor" }, head: { sha: "closed403" }, labels: [], body: "Fixes #1" },
      },
    });

    // No late panel update on close (the real review is preserved), so the comment endpoint is never hit.
    expect(commentGets).toBe(0);
    const audit = await env.DB.prepare("select target_key, outcome, detail from audit_events where event_type = ?")
      .bind("github_app.gate_check_permission_missing")
      .first<{ target_key: string; outcome: string; detail: string }>();
    expect(audit).toMatchObject({
      target_key: "JSONbored/gittensory#47",
      outcome: "error",
    });
    expect(audit?.detail).toMatch(/Checks: write permission is missing/i);
    const webhook = await env.DB.prepare("select status from webhook_events where delivery_id = ?").bind("gate-closed-permission-missing").first<{ status: string }>();
    expect(webhook?.status).toBe("processed");
  });

  it("reruns the sticky PR panel when a maintainer checks the rerun task", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicAudienceMode: "oss_maintainer",
      publicSignalLevel: "standard",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      includeMaintainerAuthors: true,
      commandAuthorization: { default: ["maintainer", "collaborator", "confirmed_miner"], commands: { "review-now": ["maintainer"] } },
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 45,
      title: "Refresh panel",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "panel123" },
      labels: [],
      body: "Validation: npm test",
    });
    const checkedPanel = [
      "<!-- gittensory-pr-panel:v1 -->",
      "",
      "- [x] <!-- gittensory-rerun-review:v1 --> Re-run LoopOver review",
    ].join("\n");
    const calls = { token: 0, permission: 0, minerList: 0, commentGets: 0, commentPatches: 0, checkRuns: 0 };
    let patchedBody = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        // A confirmed official Gittensor contributor → the rerun renders the FULL readiness panel
        // (which carries the rerun task); a non-registered author would get the minimal invite.
        return Response.json([
          { uid: 7, githubUsername: "contributor", githubId: "123", totalPrs: 4, totalMergedPrs: 3, totalOpenPrs: 1, totalClosedPrs: 0, totalOpenIssues: 0, totalClosedIssues: 0, totalSolvedIssues: 0, totalValidSolvedIssues: 0, isEligible: true, credibility: 1, eligibleRepoCount: 1 },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({ repositories: [{ repositoryFullName: "JSONbored/gittensory", totalPrs: "4", totalMergedPrs: "3", totalOpenPrs: "1", totalClosedPrs: "0", totalOpenIssues: "0", totalClosedIssues: "0", isEligible: true, credibility: "1.000000" }] });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/contributor")) return Response.json({ login: "contributor", public_repos: 2, followers: 1 });
      if (url.includes("/users/contributor/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      if (url.includes("/check-runs")) {
        calls.checkRuns += 1;
        return Response.json({ id: 888 });
      }
      if (url.includes("/collaborators/maintainer/permission")) {
        calls.permission += 1;
        return Response.json({ permission: "maintain" });
      }
      if (url.includes("/issues/45/comments") && method === "GET") {
        calls.commentGets += 1;
        return Response.json([{ id: 777, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } }]);
      }
      if (url.includes("/issues/comments/777") && method === "PATCH") {
        calls.commentPatches += 1;
        patchedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 777 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-retrigger",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 45, title: "Refresh panel", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 777, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });

    // token: 1 — the installation token is now cached + reused within the request (was 2: main + permission check).
    // commentGets/commentPatches: 2 — first the purple reviewing placeholder, then the final refreshed panel.
    expect(calls).toEqual({ token: 1, permission: 1, minerList: 1, commentGets: 2, commentPatches: 2, checkRuns: 0 });
    expect(patchedBody).toContain("<!-- gittensory-pr-panel:v1 -->");
    expect(patchedBody).toContain("Readiness score:");
    expect(patchedBody).toContain("- [ ] <!-- gittensory-rerun-review:v1 --> Re-run LoopOver review");
    expect(patchedBody).not.toContain("- [x] <!-- gittensory-rerun-review:v1 -->");
    const audit = await env.DB.prepare("select event_type, actor, target_key, outcome from audit_events where event_type = ?")
      .bind("github_app.pr_panel_retriggered")
      .first<{ event_type: string; actor: string; target_key: string; outcome: string }>();
    expect(audit).toMatchObject({
      event_type: "github_app.pr_panel_retriggered",
      actor: "maintainer",
      target_key: "JSONbored/gittensory#45",
      outcome: "completed",
    });
    const usageEvents = await listProductUsageEvents(env, { limit: 5 });
    expect(usageEvents).toEqual(expect.arrayContaining([expect.objectContaining({ surface: "github_app", eventName: "pr_panel_retriggered", outcome: "completed" })]));
  });

  it("defers a manual panel rerun while CI is still running", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      includeMaintainerAuthors: true,
      autonomy: { merge: "auto" },
      commandAuthorization: { default: ["maintainer"], commands: { "review-now": ["maintainer"] } },
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 46,
      title: "Pending CI rerun",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "pendingci" },
      base: { ref: "main" },
      labels: [],
      body: "Validation: npm test",
    });
    const checkedPanel = [
      "<!-- gittensory-pr-panel:v1 -->",
      "",
      "- [x] <!-- gittensory-rerun-review:v1 --> Re-run LoopOver review",
    ].join("\n");
    env.SELFHOST_TRANSIENT_CACHE = {
      get: async () => {
        throw new Error("Redis unavailable");
      },
      set: async () => undefined,
    };
    const originalRecordAuditEvent = repositoriesModule.recordAuditEvent;
    const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockImplementation(async (auditEnv, event) => {
      if (event.eventType === "github_app.pr_panel_retrigger_deferred")
        throw new Error("D1 audit failed");
      await originalRecordAuditEvent(auditEnv, event);
    });
    let commentPatches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" });
      if (/\/pulls\/46(?:\?|$)/.test(url)) return Response.json({ number: 46, mergeable_state: "clean" });
      if (url.includes("/commits/pendingci/check-runs")) {
        return Response.json({ check_runs: [{ name: "test", status: "in_progress", conclusion: null, app: { slug: "github-actions" } }] });
      }
      if (url.includes("/commits/pendingci/status")) return Response.json({ statuses: [] });
      if (url.includes("/issues/comments/778") && method === "PATCH") {
        commentPatches += 1;
        return Response.json({ id: 778 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-retrigger-ci-pending",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 46, title: "Pending CI rerun", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 778, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });

    expect(commentPatches).toBe(0);
    expect(auditSpy).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        eventType: "github_app.pr_panel_retrigger_deferred",
        actor: "maintainer",
        targetKey: "JSONbored/gittensory#46",
        outcome: "queued",
      }),
    );
    auditSpy.mockRestore();
  });

  it("refreshes the PR's files on a manual rerun so the slop/manifest gate evaluates the current diff", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicAudienceMode: "oss_maintainer",
      publicSignalLevel: "standard",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      includeMaintainerAuthors: true,
      // Slop gate on → the rerun must refresh the PR files before evaluating (the guard fires).
      slopGateMode: "advisory",
      commandAuthorization: { default: ["maintainer", "collaborator", "confirmed_miner"], commands: { "review-now": ["maintainer"] } },
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 45,
      title: "Refresh panel",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "panel123" },
      labels: [],
      body: "Validation: npm test",
    });
    const checkedPanel = ["<!-- gittensory-pr-panel:v1 -->", "", "- [x] <!-- gittensory-rerun-review:v1 --> Re-run LoopOver review"].join("\n");
    const calls = { pullsFiles: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([{ uid: 7, githubUsername: "contributor", githubId: "123", totalPrs: 4, totalMergedPrs: 3, totalOpenPrs: 1, totalClosedPrs: 0, totalOpenIssues: 0, totalClosedIssues: 0, totalSolvedIssues: 0, totalValidSolvedIssues: 0, isEligible: true, credibility: 1, eligibleRepoCount: 1 }]);
      }
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/contributor")) return Response.json({ login: "contributor", public_repos: 2, followers: 1 });
      if (url.includes("/users/contributor/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" });
      // The refresh fetches files/reviews/checks; count the files fetch to prove the refresh ran on the rerun.
      if (url.includes("/pulls/45/files")) {
        calls.pullsFiles += 1;
        return Response.json([{ filename: "src/app.ts", status: "modified", additions: 5, deletions: 1, changes: 6 }]);
      }
      if (url.includes("/pulls/45/reviews")) return Response.json([]);
      if (url.includes("/commits/panel123/check-runs")) return Response.json({ check_runs: [] });
      if (url.includes("/issues/45/comments") && method === "GET") return Response.json([{ id: 777, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } }]);
      if (url.includes("/issues/comments/777") && method === "PATCH") return Response.json({ id: 777 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-retrigger-refresh",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 45, title: "Refresh panel", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 777, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });

    // The rerun fetched the PR's current files before publishing the panel/gate — not the stale cache.
    expect(calls.pullsFiles).toBeGreaterThanOrEqual(1);
    const audit = await env.DB.prepare("select outcome from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.pr_panel_retriggered", "JSONbored/gittensory#45")
      .first<{ outcome: string }>();
    expect(audit?.outcome).toBe("completed");
  });

  it("skips PR panel reruns from confirmed-miner PR authors because the checkbox is maintainer-only", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      includeMaintainerAuthors: true,
      // Even if repo config tries to allow confirmed miners, the checkbox is a maintainer/write-collaborator
      // control because it mutates the bot's persisted review comment.
      commandAuthorization: { default: ["maintainer", "collaborator", "confirmed_miner"], commands: { "review-now": ["maintainer", "confirmed_miner"] } },
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 48,
      title: "Miner self-rerun",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "panel480" },
      labels: [],
      body: "Validation: npm test",
    });
    const checkedPanel = ["<!-- gittensory-pr-panel:v1 -->", "", "- [x] <!-- gittensory-rerun-review:v1 --> Re-run LoopOver review"].join("\n");
    const calls = { minerList: 0, permission: 0, commentPatches: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([{ uid: 7, githubUsername: "contributor", githubId: "123", totalPrs: 4, totalMergedPrs: 3, totalOpenPrs: 1, totalClosedPrs: 0, totalOpenIssues: 0, totalClosedIssues: 0, totalSolvedIssues: 0, totalValidSolvedIssues: 0, isEligible: true, credibility: 1, eligibleRepoCount: 1 }]);
      }
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [{ repositoryFullName: "JSONbored/gittensory", totalPrs: "4", totalMergedPrs: "3", totalOpenPrs: "1", totalClosedPrs: "0", totalOpenIssues: "0", totalClosedIssues: "0", isEligible: true, credibility: "1.000000" }] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/contributor")) return Response.json({ login: "contributor", public_repos: 2, followers: 1 });
      if (url.includes("/users/contributor/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // The confirmed-miner author has NO repo write/admin — authorized via confirmed_miner, not maintainer.
      if (url.includes("/collaborators/contributor/permission")) {
        calls.permission += 1;
        return Response.json({ permission: "none" });
      }
      if (url.includes("/issues/48/comments") && method === "GET") return Response.json([{ id: 778, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } }]);
      if (url.includes("/issues/comments/778") && method === "PATCH") {
        calls.commentPatches += 1;
        return Response.json({ id: 778 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-retrigger-miner",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 48, title: "Miner self-rerun", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 778, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "contributor", type: "User" },
      },
    });

    // The checkbox authorization ignores the widened repo command policy, so it never reaches miner detection or
    // comment mutation for a plain PR author.
    expect(calls.minerList).toBe(0);
    expect(calls.permission).toBe(1);
    expect(calls.commentPatches).toBe(0);
    const audit = await env.DB.prepare("select actor, outcome, detail from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.pr_panel_retrigger_skipped", "JSONbored/gittensory#48")
      .first<{ actor: string; outcome: string; detail: string }>();
    expect(audit).toMatchObject({ actor: "contributor", outcome: "completed", detail: "maintainer_command_requires_maintainer" });
  });

  it("skips PR panel reruns from users without repository write permission", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 46,
      title: "Unauthorized panel refresh",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "panel-denied" },
      labels: [],
      body: "Validation: npm test",
    });
    const checkedPanel = [
      "<!-- gittensory-pr-panel:v1 -->",
      "",
      "- [x] <!-- gittensory-rerun-review:v1 --> Re-run LoopOver review",
    ].join("\n");
    const calls = { token: 0, permission: 0, commentGets: 0, commentPatches: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      if (url.includes("/collaborators/drive-by-user/permission")) {
        calls.permission += 1;
        return Response.json({ permission: "read" });
      }
      if (url.includes("/issues/46/comments")) {
        calls.commentGets += 1;
        return Response.json([{ id: 778, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } }]);
      }
      if (url.includes("/issues/comments/778")) {
        calls.commentPatches += 1;
        return Response.json({ id: 778 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-retrigger-denied",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 46, title: "Unauthorized panel refresh", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 778, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "drive-by-user", type: "User" },
      },
    });

    expect(calls).toEqual({ token: 1, permission: 1, commentGets: 0, commentPatches: 0 });
    const audit = await env.DB.prepare("select event_type, actor, target_key, outcome, detail from audit_events where event_type = ?")
      .bind("github_app.pr_panel_retrigger_skipped")
      .first<{ event_type: string; actor: string; target_key: string; outcome: string; detail: string }>();
    expect(audit).toMatchObject({
      event_type: "github_app.pr_panel_retrigger_skipped",
      actor: "drive-by-user",
      target_key: "JSONbored/gittensory#46",
      outcome: "completed",
      detail: "not_maintainer_or_pr_author",
    });
  });

  it("reruns the sticky PR panel when a write collaborator checks the rerun task", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicAudienceMode: "oss_maintainer",
      publicSignalLevel: "standard",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      includeMaintainerAuthors: true,
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 47,
      title: "Refresh panel as collaborator",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "panel-writer" },
      labels: [],
      body: "Validation: npm test",
    });
    const checkedPanel = [
      "<!-- gittensory-pr-panel:v1 -->",
      "",
      "- [x] <!-- gittensory-rerun-review:v1 --> Re-run LoopOver review",
    ].join("\n");
    const calls = { token: 0, permission: 0, minerList: 0, commentGets: 0, commentPatches: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([]);
      }
      if (url.endsWith("/users/contributor")) return Response.json({ login: "contributor", public_repos: 2, followers: 1 });
      if (url.includes("/users/contributor/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      if (url.includes("/collaborators/writer/permission")) {
        calls.permission += 1;
        return Response.json({ permission: "write" });
      }
      if (url.includes("/issues/47/comments") && method === "GET") {
        calls.commentGets += 1;
        return Response.json([{ id: 779, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } }]);
      }
      if (url.includes("/issues/comments/779") && method === "PATCH") {
        calls.commentPatches += 1;
        return Response.json({ id: 779 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-retrigger-writer",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 47, title: "Refresh panel as collaborator", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 779, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "writer", type: "User" },
      },
    });

    // token: 1 — the installation token is now cached + reused within the request (was 2: main + permission check).
    // commentGets/commentPatches: 2 — first the purple reviewing placeholder, then the final refreshed panel.
    expect(calls).toEqual({ token: 1, permission: 1, minerList: 1, commentGets: 2, commentPatches: 2 });
  });

  it("skips PR panel reruns when the editing actor and PR author are unavailable", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 48,
      title: "Unknown panel refresh actor",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "panel-unknown" },
      labels: [],
      body: "Validation: npm test",
    });
    await env.DB.prepare("update pull_requests set author_login = null where repo_full_name = ? and number = ?").bind("JSONbored/gittensory", 48).run();
    const checkedPanel = [
      "<!-- gittensory-pr-panel:v1 -->",
      "",
      "- [x] <!-- gittensory-rerun-review:v1 --> Re-run LoopOver review",
    ].join("\n");
    vi.stubGlobal("fetch", async () => new Response("unexpected fetch", { status: 500 }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-retrigger-unknown-actor",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 48, title: "Unknown panel refresh actor", state: "open", pull_request: {} },
        comment: { id: 780, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
      },
    });

    const audit = await env.DB.prepare("select actor, target_key, detail from audit_events where event_type = ?")
      .bind("github_app.pr_panel_retrigger_skipped")
      .first<{ actor: string | null; target_key: string; detail: string }>();
    expect(audit).toMatchObject({
      actor: null,
      target_key: "JSONbored/gittensory#48",
      detail: "not_maintainer_or_pr_author",
    });
  });

  it("ignores invalid rerun task edits and audits skipped rerun requests", async () => {
    const env = createTestEnv();
    const checkedPanel = [
      "<!-- gittensory-pr-panel:v1 -->",
      "",
      "- [x] <!-- gittensory-rerun-review:v1 --> Re-run LoopOver review",
    ].join("\n");
    const uncheckedPanel = checkedPanel.replace("- [x]", "- [ ]");
    let fetchCalls = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCalls += 1;
      return new Response("unexpected fetch", { status: 500 });
    });
    const basePayload = {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
      issue: { number: 46, title: "Panel skip", state: "open", user: { login: "contributor" }, pull_request: {} },
    };

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", {});
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-created-ignore",
      eventName: "issue_comment",
      payload: {
        action: "created",
        ...basePayload,
        comment: { id: 800, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-unchecked-ignore",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        ...basePayload,
        comment: { id: 801, body: uncheckedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-non-bot-ignore",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        ...basePayload,
        comment: { id: 802, body: checkedPanel, user: { login: "maintainer", type: "User" } },
        sender: { login: "maintainer", type: "User" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-missing-comment-ignore",
      eventName: "issue_comment",
      payload: { action: "edited", ...basePayload, sender: { login: "maintainer", type: "User" } },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-missing-panel-marker-ignore",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        ...basePayload,
        comment: { id: 806, body: "- [x] <!-- gittensory-rerun-review:v1 --> Re-run LoopOver review", user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-missing-rerun-marker-ignore",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        ...basePayload,
        comment: { id: 807, body: "<!-- gittensory-pr-panel:v1 -->\n\n- [x] Re-run LoopOver review", user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-other-bot-ignore",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        ...basePayload,
        comment: { id: 808, body: checkedPanel, user: { login: "other[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-bot-skip",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        ...basePayload,
        comment: { id: 803, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "gittensory[bot]", type: "Bot" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-missing-cache",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        ...basePayload,
        comment: { id: 804, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "panel-rerun-missing-context",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        comment: { id: 805, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
        sender: { login: "maintainer", type: "User" },
      },
    });

    expect(fetchCalls).toBe(0);
    const skips = await env.DB.prepare("select detail from audit_events where event_type = ? order by detail")
      .bind("github_app.pr_panel_retrigger_skipped")
      .all<{ detail: string }>();
    expect(skips.results.map((event) => event.detail)).toEqual(["bot_author", "cached_pr_missing", "missing_repo_pr_or_installation"]);
  });

  it("debounces noisy PR events without publishing public surfaces", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_and_label",
      autoLabelEnabled: true,
      checkRunMode: "enabled",
      reviewCheckMode: "required",
    });
    let publicCalls = 0;
    vi.stubGlobal("fetch", async () => {
      publicCalls += 1;
      return new Response("unexpected public call", { status: 500 });
    });

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", {});
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-labeled-noisy",
      eventName: "pull_request",
      payload: {
        action: "labeled",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 44, title: "Noisy event PR", state: "open", user: { login: "contributor" }, head: { sha: "noisy123" }, labels: [{ name: "bug" }], body: "Fixes #1" },
      },
    });

    expect(publicCalls).toBe(0);
  });

  it("processes GitHub webhook jobs for PRs, issues, comments-off, comment-attempt, and deleted installs", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 1,
      title: "Prior merged work",
      state: "closed",
      merged_at: "2026-05-01T00:00:00.000Z",
      user: { login: "oktofeesh1" },
      labels: [{ name: "bug" }],
      body: "Fixes #1",
    });
    const visibleCalls = { comments: 0, labelsCreated: 0, labelsApplied: 0, checks: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          {
            uid: 7,
            githubUsername: "oktofeesh1",
            githubId: "123",
            totalPrs: 4,
            totalMergedPrs: 3,
            totalOpenPrs: 1,
            totalClosedPrs: 0,
            totalOpenIssues: 0,
            totalClosedIssues: 0,
            totalSolvedIssues: 0,
            totalValidSolvedIssues: 0,
            isEligible: true,
            credibility: 1,
            eligibleRepoCount: 1,
            hotkey: "must-not-leak",
          },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({
          repositories: [
            {
              repositoryFullName: "JSONbored/gittensory",
              totalPrs: "4",
              totalMergedPrs: "3",
              totalOpenPrs: "1",
              totalClosedPrs: "0",
              totalOpenIssues: "0",
              totalClosedIssues: "0",
              isEligible: true,
              credibility: "1.000000",
            },
          ],
        });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/3/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/3/comments") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        expect(body.body).toContain("<!-- gittensory-pr-panel:v1 -->");
        expect(body.body).toContain("Confirmed Gittensor contributor");
        expect(body.body).not.toMatch(/reviewability|likely_duplicate|reward|scoreability|estimated score|wallet|hotkey|trust score|payout|farming/i);
        visibleCalls.comments += 1;
        return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      }
      if (url.includes("/issues/3/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/3/labels") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { labels?: string[] };
        expect(body.labels).toEqual(["gittensor"]);
        visibleCalls.labelsApplied += 1;
        return Response.json([{ name: "gittensor" }]);
      }
      if (url.includes("/repos/JSONbored/gittensory/labels") && !url.includes("/issues/") && method === "GET") return Response.json([]);
      if (url.includes("/repos/JSONbored/gittensory/labels") && !url.includes("/issues/") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string };
        expect(body.name).toBe("gittensor");
        visibleCalls.labelsCreated += 1;
        return Response.json({ name: "gittensor" }, { status: 201 });
      }
      if (url.includes("/check-runs")) {
        visibleCalls.checks += 1;
        return new Response("checks disabled", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    });

    const basePayload = {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "read", issues: "write" },
        events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
      },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
    };

    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSignalLevel: "standard",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      backfillEnabled: true,
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-off",
      eventName: "pull_request",
      payload: {
        action: "opened",
        ...basePayload,
        pull_request: {
          number: 2,
          title: "Fix webhook duplicate delivery",
          state: "open",
          user: { login: "oktofeesh1" },
          labels: [{ name: "bug" }],
          body: "Fixes #1",
        },
      },
    });
    expect(await listPullRequests(env, "JSONbored/gittensory")).toEqual(expect.arrayContaining([expect.objectContaining({ number: 2 })]));

    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: true,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      backfillEnabled: true,
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-comment-attempt",
      eventName: "pull_request",
      payload: {
        action: "synchronize",
        ...basePayload,
        pull_request: {
          number: 3,
          title: "Fix webhook duplicate delivery again",
          state: "open",
          user: { login: "oktofeesh1" },
          labels: [{ name: "bug" }],
          body: "Fixes #1",
        },
      },
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-comment-undetected",
      eventName: "pull_request",
      payload: {
        action: "opened",
        ...basePayload,
        pull_request: {
          number: 4,
          title: "New contributor work",
          state: "open",
          user: { login: "newbie" },
          labels: [],
          body: "Fixes #1",
        },
      },
    });

    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "minimal",
      publicSurface: "comment_and_label",
      autoLabelEnabled: true,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      backfillEnabled: true,
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-comment-no-author",
      eventName: "pull_request",
      payload: {
        action: "opened",
        ...basePayload,
        pull_request: {
          number: 5,
          title: "Anonymous webhook work",
          state: "open",
          labels: [],
          body: "Fixes #1",
        },
      },
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "issue",
      eventName: "issues",
      payload: {
        action: "opened",
        ...basePayload,
        issue: {
          number: 1,
          title: "Webhook duplicate delivery",
          state: "open",
          user: { login: "reporter" },
          labels: [{ name: "bug" }],
          body: "Duplicate delivery should be idempotent.",
        },
      },
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "deleted",
      eventName: "installation",
      payload: { action: "deleted", installation: { id: 123 } },
    });

    expect(visibleCalls).toEqual({ comments: 1, labelsCreated: 1, labelsApplied: 1, checks: 0 });
    const skipped = await env.DB.prepare("select detail from audit_events where event_type = ? order by created_at").bind("github_app.pr_visibility_skipped").all<{
      detail: string;
    }>();
    expect(skipped.results.map((event) => event.detail)).toEqual(expect.arrayContaining(["not_official_gittensor_miner", "missing_author"]));
  });

  // #1007 convergence (Stage D): with LOOPOVER_REVIEW_UNIFIED_COMMENT on AND the gate evaluating, the public PR-panel
  // comment is rendered by the UNIFIED renderer (GitHub alert + synthesized "Code review" row) instead of the
  // legacy panel — while STILL leading with the same panel marker so the in-place upsert updates the same
  // comment. Mirrors the legacy panel-posting setup (confirmed miner + comment_and_label) but flips the flag
  // and enables the gate so `maybePublishPrPublicSurface` takes the flag-ON branch.
  it("renders the unified PR-review comment when the flag is on and the gate evaluates", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_UNIFIED_COMMENT: "1" });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      reviewCheckMode: "required",
      backfillEnabled: true,
      autonomy: { update_branch: "auto" },
    });
    let postedBody = "";
    const calls = { comments: 0, gateChecks: 0 };
    let gateFinalized = false;
    let failedPostGateMint = false;
    const liveCiSpy = vi
      .spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl")
      .mockRejectedValueOnce(new Error("transient CI read failed"))
      .mockResolvedValue({
        ciState: "passed",
        hasPending: false,
        hasVisiblePending: false,
        hasMissingRequiredContext: false,
        failingDetails: [],
        nonRequiredFailingDetails: [],
        ciCompletenessWarning: null,
      });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          {
            uid: 7,
            githubUsername: "oktofeesh1",
            githubId: "123",
            totalPrs: 4,
            totalMergedPrs: 3,
            totalOpenPrs: 1,
            totalClosedPrs: 0,
            totalOpenIssues: 0,
            totalClosedIssues: 0,
            totalSolvedIssues: 0,
            totalValidSolvedIssues: 0,
            isEligible: true,
            credibility: 1,
            eligibleRepoCount: 1,
            hotkey: "must-not-leak",
          },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({
          repositories: [
            {
              repositoryFullName: "JSONbored/gittensory",
              totalPrs: "4",
              totalMergedPrs: "3",
              totalOpenPrs: "1",
              totalClosedPrs: "0",
              totalOpenIssues: "0",
              totalClosedIssues: "0",
              isEligible: true,
              credibility: "1.000000",
            },
          ],
        });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      if (url.includes("/access_tokens")) {
        if (gateFinalized && !failedPostGateMint) {
          failedPostGateMint = true;
          return new Response("mint failed", { status: 500 });
        }
        return Response.json({ token: "installation-token", expires_at: "2026-05-28T00:04:00.000Z" });
      }
      // PR files — the unified branch (re)fetches them to count changed files for the readiness chip.
      if (url.includes("/pulls/3/files")) return Response.json([{ filename: "src/cache.ts", additions: 5, deletions: 1, status: "modified" }]);
      // #review-audit: the LIVE merge-state the comment now reads — the base just advanced with a conflict, so the
      // live state is `dirty` even though the stored mergeableState (unset on this payload) would not say so.
      if (/\/pulls\/3(?:\?|$)/.test(url)) return Response.json({ number: 3, mergeable_state: "dirty" });
      // Gate check-run — must succeed so `gateEvaluation` is produced and the flag-ON branch runs.
      // The pending check is POSTed (in_progress), then PATCHed to its completed conclusion.
      if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") {
        calls.gateChecks += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string };
        if (body.status !== "in_progress" || body.conclusion) {
          gateFinalized = true;
          clearInstallationTokenCacheForTest();
        }
        return Response.json({ id: 901 }, { status: 201 });
      }
      if (url.includes("/check-runs/901") && method === "PATCH") {
        calls.gateChecks += 1;
        gateFinalized = true;
        clearInstallationTokenCacheForTest();
        return Response.json({ id: 901 });
      }
      if (url.includes("/issues/3/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/3/comments") && method === "POST") {
        calls.comments += 1;
        postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "pr-unified-comment",
        eventName: "pull_request",
        payload: {
          action: "synchronize",
          installation: {
            id: 123,
            account: { login: "JSONbored", id: 1, type: "User" },
            repository_selection: "selected",
            permissions: { metadata: "read", pull_requests: "read", issues: "write", checks: "write" },
            events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
          },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: {
            number: 3,
            title: "Fix webhook duplicate delivery again",
            state: "open",
            user: { login: "oktofeesh1" },
            head: { sha: "unified123" },
            labels: [{ name: "bug" }],
            body: "Fixes #1\n\nValidation: npm test",
          },
        },
      });

      const installationTokenCiReads = liveCiSpy.mock.calls.filter(
        ([, , , token]) => token === "installation-token",
      );
      expect(installationTokenCiReads).toHaveLength(2);
      expect(calls.comments).toBe(2);
      expect(failedPostGateMint).toBe(true);
      // Still leads with the panel marker → the upsert updates the SAME sticky comment in place (no duplicate).
      expect(postedBody).toContain("<!-- gittensory-pr-panel:v1 -->");
      // The UNIFIED shape, which the legacy body never emits: a full-comment GitHub alert wrapper…
      expect(postedBody).toMatch(/> \[!(TIP|NOTE|WARNING|CAUTION)\]/);
      // …and the renderer's synthesized "Code review" signal row (bold first table label).
      expect(postedBody).toContain("**Code review**");
      // Public-safe by construction — no internal trust/economics fields leak through the unified renderer.
      expect(postedBody).not.toMatch(/wallet|hotkey|reward|trust score/i);
      // #review-audit (#4220): the comment reads the LIVE `dirty` merge-state (not the stale stored one), so it must
      // NOT headline "safe to merge" while the disposition would auto-close the base-conflicting PR.
      expect(postedBody).not.toMatch(/safe to merge/i);
      // #1955: no `.loopover.yml` was fetched here (the raw-content URL isn't stubbed, so it 404s and the
      // manifest resolves to null) — review.effort_score is absent/default OFF, so the effort chip must NOT render.
      expect(postedBody).not.toMatch(/review effort:/);
    } finally {
      liveCiSpy.mockRestore();
    }
  });

  // #4744 (improvement-signal panel row, epic #4737): same unified-comment scaffold as the test above, but with
  // the `improvementSignal` converged feature ALSO resolved on (env kill-switch + allowlist) — this is the only
  // way, anywhere in the existing suite, that `maybePublishPrPublicSurface`'s `improvementSignalAllowed` ternary
  // takes its TRUE arm: every other existing test leaves the feature off (the default), which already covers the
  // FALSE arm thousands of times over. Proves the deterministic tier threads end to end into a real posted
  // comment, not just in the isolated `buildPublicPrPanelSignalRows`/`buildStructuralImprovementAssessment` unit
  // tests (signals-coverage.test.ts).
  it("#4744: threads the improvement-signal row into the unified comment when the converged feature resolves on", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_UNIFIED_COMMENT: "1",
      LOOPOVER_REVIEW_IMPROVEMENT_SIGNAL: "true",
      LOOPOVER_REVIEW_REPOS: "JSONbored/gittensory",
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      reviewCheckMode: "required",
      backfillEnabled: true,
      autonomy: { update_branch: "auto" },
    });
    let postedBody = "";
    const calls = { comments: 0, gateChecks: 0 };
    let gateFinalized = false;
    let failedPostGateMint = false;
    const liveCiSpy = vi
      .spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl")
      .mockRejectedValueOnce(new Error("transient CI read failed"))
      .mockResolvedValue({
        ciState: "passed",
        hasPending: false,
        hasVisiblePending: false,
        hasMissingRequiredContext: false,
        failingDetails: [],
        nonRequiredFailingDetails: [],
        ciCompletenessWarning: null,
      });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          {
            uid: 7,
            githubUsername: "oktofeesh1",
            githubId: "123",
            totalPrs: 4,
            totalMergedPrs: 3,
            totalOpenPrs: 1,
            totalClosedPrs: 0,
            totalOpenIssues: 0,
            totalClosedIssues: 0,
            totalSolvedIssues: 0,
            totalValidSolvedIssues: 0,
            isEligible: true,
            credibility: 1,
            eligibleRepoCount: 1,
            hotkey: "must-not-leak",
          },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({
          repositories: [
            {
              repositoryFullName: "JSONbored/gittensory",
              totalPrs: "4",
              totalMergedPrs: "3",
              totalOpenPrs: "1",
              totalClosedPrs: "0",
              totalOpenIssues: "0",
              totalClosedIssues: "0",
              isEligible: true,
              credibility: "1.000000",
            },
          ],
        });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      if (url.includes("/access_tokens")) {
        if (gateFinalized && !failedPostGateMint) {
          failedPostGateMint = true;
          return new Response("mint failed", { status: 500 });
        }
        return Response.json({ token: "installation-token", expires_at: "2026-05-28T00:04:00.000Z" });
      }
      // PR files — also what the improvement-signal deterministic tier reads via getReviewFiles() for its
      // test-evidence axis (#4742); one plain code file with no accompanying test evidence resolves to band "none".
      if (url.includes("/pulls/4/files")) return Response.json([{ filename: "src/cache.ts", additions: 5, deletions: 1, status: "modified" }]);
      if (/\/pulls\/4(?:\?|$)/.test(url)) return Response.json({ number: 4, mergeable_state: "clean" });
      if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") {
        calls.gateChecks += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string };
        if (body.status !== "in_progress" || body.conclusion) {
          gateFinalized = true;
          clearInstallationTokenCacheForTest();
        }
        return Response.json({ id: 901 }, { status: 201 });
      }
      if (url.includes("/check-runs/901") && method === "PATCH") {
        calls.gateChecks += 1;
        gateFinalized = true;
        clearInstallationTokenCacheForTest();
        return Response.json({ id: 901 });
      }
      if (url.includes("/issues/4/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/4/comments") && method === "POST") {
        calls.comments += 1;
        postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "pr-improvement-signal-unified",
        eventName: "pull_request",
        payload: {
          action: "synchronize",
          installation: {
            id: 123,
            account: { login: "JSONbored", id: 1, type: "User" },
            repository_selection: "selected",
            permissions: { metadata: "read", pull_requests: "read", issues: "write", checks: "write" },
            events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
          },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: {
            number: 4,
            title: "Cache invalidation cleanup",
            state: "open",
            user: { login: "oktofeesh1" },
            head: { sha: "improvement123" },
            labels: [{ name: "bug" }],
            body: "Fixes #1",
          },
        },
      });

      expect(calls.comments).toBeGreaterThan(0);
      expect(postedBody).toContain("<!-- gittensory-pr-panel:v1 -->");
      // The improvement-signal row (#4744) — proves improvementSignalAllowed resolved TRUE and
      // buildStructuralImprovementAssessment's result threaded all the way into the posted comment, not just
      // computed and discarded. No test evidence was provided for the one changed code file, so this resolves to
      // band "none" (measured, found nothing) rather than "insufficient-signal" (nothing to measure at all). The
      // unified renderer's table only surfaces the first 3 of each row's 4 cells (Label/Result/Evidence, not
      // Action) — same as the adjacent "Gate result" row, which also never shows its own 4th cell here — so this
      // asserts against the 3 columns this renderer actually prints, not the row's full cells array.
      expect(postedBody).toContain("| Improvement | ⚠️ ℹ️ None detected | No structural-improvement signals were detected for this PR. |");
      // Public-safe regardless: no internal trust/economics fields leak through this new row either.
      expect(postedBody).not.toMatch(/wallet|hotkey|coldkey|reward|trust score/i);
    } finally {
      liveCiSpy.mockRestore();
    }
  });

  // #4745 (risk x value quadrant, sub-issue H of epic #4737): same scaffold as the #4744 test just above, but
  // ALSO opts the repo into slop evidence collection (slopGateMode: "advisory", never "block" -- this test is
  // not exercising the slop gate itself) so `maybePublishPrPublicSurface`'s hoisted `slopBand` is populated from
  // a REAL `buildSlopAssessment` call this pass, not left null. Proves the risk x value quadrant threads end to
  // end from that real slop band through to the posted comment's Improvement row -- the only place in the
  // existing suite where BOTH improvementSignalAllowed AND shouldCollectSlopEvidence resolve true in the same
  // pass (every other test exercises them independently).
  it("#4745: threads the real slop band into the Improvement row's quadrant prefix when both improvementSignal and slop evidence collection are on", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_UNIFIED_COMMENT: "1",
      LOOPOVER_REVIEW_IMPROVEMENT_SIGNAL: "true",
      LOOPOVER_REVIEW_REPOS: "JSONbored/gittensory",
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      reviewCheckMode: "required",
      backfillEnabled: true,
      autonomy: { update_branch: "auto" },
      // The only delta from the #4744 test above: turns on slop evidence collection so `slopBand` is populated
      // this pass. "advisory" never blocks (only "block" mode does, at the configured threshold) -- this test
      // is exercising the quadrant label, not the slop gate.
      slopGateMode: "advisory",
    });
    let postedBody = "";
    const calls = { comments: 0, gateChecks: 0 };
    let gateFinalized = false;
    let failedPostGateMint = false;
    const liveCiSpy = vi
      .spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl")
      .mockRejectedValueOnce(new Error("transient CI read failed"))
      .mockResolvedValue({
        ciState: "passed",
        hasPending: false,
        hasVisiblePending: false,
        hasMissingRequiredContext: false,
        failingDetails: [],
        nonRequiredFailingDetails: [],
        ciCompletenessWarning: null,
      });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          {
            uid: 7,
            githubUsername: "oktofeesh1",
            githubId: "123",
            totalPrs: 4,
            totalMergedPrs: 3,
            totalOpenPrs: 1,
            totalClosedPrs: 0,
            totalOpenIssues: 0,
            totalClosedIssues: 0,
            totalSolvedIssues: 0,
            totalValidSolvedIssues: 0,
            isEligible: true,
            credibility: 1,
            eligibleRepoCount: 1,
            hotkey: "must-not-leak",
          },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({
          repositories: [
            {
              repositoryFullName: "JSONbored/gittensory",
              totalPrs: "4",
              totalMergedPrs: "3",
              totalOpenPrs: "1",
              totalClosedPrs: "0",
              totalOpenIssues: "0",
              totalClosedIssues: "0",
              isEligible: true,
              credibility: "1.000000",
            },
          ],
        });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      if (url.includes("/access_tokens")) {
        if (gateFinalized && !failedPostGateMint) {
          failedPostGateMint = true;
          return new Response("mint failed", { status: 500 });
        }
        return Response.json({ token: "installation-token", expires_at: "2026-05-28T00:04:00.000Z" });
      }
      // PR files — one plain code file with no accompanying test evidence: `missingTestEvidence` is the only
      // slop finding that can fire for this fixture (churn is far below MIN_CHURN_LINES, description/linked
      // issue are both present) -- slopRisk 15, band "low". Also what the improvement-signal deterministic
      // tier reads via getReviewFiles() for its own test-evidence axis (#4742); same inputs, band "none".
      if (url.includes("/pulls/4/files")) return Response.json([{ filename: "src/cache.ts", additions: 5, deletions: 1, status: "modified" }]);
      if (/\/pulls\/4(?:\?|$)/.test(url)) return Response.json({ number: 4, mergeable_state: "clean" });
      if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") {
        calls.gateChecks += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string };
        if (body.status !== "in_progress" || body.conclusion) {
          gateFinalized = true;
          clearInstallationTokenCacheForTest();
        }
        return Response.json({ id: 901 }, { status: 201 });
      }
      if (url.includes("/check-runs/901") && method === "PATCH") {
        calls.gateChecks += 1;
        gateFinalized = true;
        clearInstallationTokenCacheForTest();
        return Response.json({ id: 901 });
      }
      if (url.includes("/issues/4/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/4/comments") && method === "POST") {
        calls.comments += 1;
        postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "pr-improvement-signal-quadrant",
        eventName: "pull_request",
        payload: {
          action: "synchronize",
          installation: {
            id: 123,
            account: { login: "JSONbored", id: 1, type: "User" },
            repository_selection: "selected",
            permissions: { metadata: "read", pull_requests: "read", issues: "write", checks: "write" },
            events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
          },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: {
            number: 4,
            title: "Cache invalidation cleanup",
            state: "open",
            user: { login: "oktofeesh1" },
            head: { sha: "quadrant123" },
            labels: [{ name: "bug" }],
            body: "Fixes #1",
          },
        },
      });

      expect(calls.comments).toBeGreaterThan(0);
      expect(postedBody).toContain("<!-- gittensory-pr-panel:v1 -->");
      // The quadrant prefix ("risk: low · value: none") threaded from the REAL slopBand computed this pass
      // (missingTestEvidence only, slopRisk 15 -> band "low") ahead of the SAME evidence text #4744 already
      // asserts verbatim -- proving processors.ts's new hoisted slopBand reaches the rendered comment, not
      // just computed and discarded.
      expect(postedBody).toContain("| Improvement | ⚠️ ℹ️ None detected | risk: low · value: none — No structural-improvement signals were detected for this PR. |");
      // Public-safe regardless: no internal trust/economics fields leak through the new quadrant clause either.
      expect(postedBody).not.toMatch(/wallet|hotkey|coldkey|reward|trust score/i);
    } finally {
      liveCiSpy.mockRestore();
    }
  });

  it("INVARIANT (#4498): the disposition planner reuses the public surface's own live mergeable_state/CI read instead of re-fetching a third time", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_UNIFIED_COMMENT: "1" });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      reviewCheckMode: "required",
      backfillEnabled: true,
      autonomy: { update_branch: "auto" },
    });
    let mergeableStateReads = 0;
    // No mockRejectedValueOnce here -- unlike the "renders the unified PR-review comment" test above, every call
    // succeeds identically, isolating the "both refreshes succeed" case this fix targets (a prior-call failure
    // legitimately forces a genuine second live read, which is a different, already-covered scenario).
    const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
      ciState: "passed",
      hasPending: false,
      hasVisiblePending: false,
      hasMissingRequiredContext: false,
      failingDetails: [],
      nonRequiredFailingDetails: [],
      ciCompletenessWarning: null,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      // commentMode: "detected_contributors_only" requires the author to actually resolve as a detected
      // Gittensor contributor for the unified-comment (and its live merge-state/CI refresh) code path to
      // engage at all -- an empty miner match here would silently skip that whole block, same as the
      // original "renders the unified PR-review comment" test's fixture this one is adapted from.
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          { uid: 7, githubUsername: "oktofeesh1", githubId: "123", totalPrs: 4, totalMergedPrs: 3, totalOpenPrs: 1, totalClosedPrs: 0, totalOpenIssues: 0, totalClosedIssues: 0, totalSolvedIssues: 0, totalValidSolvedIssues: 0, isEligible: true, credibility: 1, eligibleRepoCount: 1, hotkey: "must-not-leak" },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({
          repositories: [
            { repositoryFullName: "JSONbored/gittensory", totalPrs: "4", totalMergedPrs: "3", totalOpenPrs: "1", totalClosedPrs: "0", totalOpenIssues: "0", totalClosedIssues: "0", isEligible: true, credibility: "1.000000" },
          ],
        });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token", expires_at: "2026-05-28T00:04:00.000Z" });
      if (url.includes("/pulls/3/files")) return Response.json([{ filename: "src/cache.ts", additions: 5, deletions: 1, status: "modified" }]);
      if (/\/pulls\/3(?:\?|$)/.test(url) && method === "GET") {
        mergeableStateReads += 1;
        return Response.json({ number: 3, mergeable_state: "clean" });
      }
      if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 901 }, { status: 201 });
      if (url.includes("/check-runs/901") && method === "PATCH") return Response.json({ id: 901 });
      if (url.includes("/issues/3/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/3/comments") && method === "POST") return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "pr-single-live-fetch",
        eventName: "pull_request",
        payload: {
          action: "synchronize",
          installation: {
            id: 123,
            account: { login: "JSONbored", id: 1, type: "User" },
            repository_selection: "selected",
            permissions: { metadata: "read", pull_requests: "read", issues: "write", checks: "write" },
            events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
          },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: {
            number: 3,
            title: "Single live fetch per pass",
            state: "open",
            user: { login: "oktofeesh1" },
            head: { sha: "singlefetch123" },
            labels: [{ name: "bug" }],
            body: "Fixes #1\n\nValidation: npm test",
          },
        },
      });

      // 2, not 3: readiness's own cachedLiveMergeState/cachedLiveCiAggregate check contributes ONE legitimate,
      // unrelated live read each (a genuine durable-cache miss on this never-before-seen head, unaffected by
      // this fix), and maybePublishPrPublicSurface's own forced refresh contributes the other -- reused
      // directly by the disposition planner instead of re-fetched a third time. Verified empirically: reverting
      // this fix on this exact fixture produces 3 of each, confirming the fix removes exactly the redundant
      // third call, not readiness's separate, necessary one.
      expect(mergeableStateReads).toBe(2);
      const installationTokenCiReads = liveCiSpy.mock.calls.filter(([, , , token]) => token === "installation-token");
      expect(installationTokenCiReads).toHaveLength(2);
    } finally {
      liveCiSpy.mockRestore();
    }
  });

  // #3609/#3610: same fixture as the unified-comment test above (screenshotsAllowed needs both the global flag
  // AND the repo cutover allowlist — createTestEnv already defaults LOOPOVER_REVIEW_REPOS to include this
  // repo), but the changed file is WEB-VISIBLE (isVisualPath) so the capture pipeline actually fires, proving
  // resolveVisualCaptureConfig / buildCapture's config-threading (review.visual) is reached end to end from the
  // real webhook path, not just from the pure-function unit tests in visual-capture.test.ts.
  it("threads review.visual config into the capture pipeline and renders a Visual preview section (#3609 / #3610)", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_UNIFIED_COMMENT: "1",
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      reviewCheckMode: "required",
      backfillEnabled: true,
      autonomy: { update_branch: "auto" },
    });
    let postedBody = "";
    const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
      ciState: "passed",
      hasPending: false,
      hasVisiblePending: false,
      hasMissingRequiredContext: false,
      failingDetails: [],
      nonRequiredFailingDetails: [],
      ciCompletenessWarning: null,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          {
            uid: 7,
            githubUsername: "oktofeesh1",
            githubId: "123",
            totalPrs: 4,
            totalMergedPrs: 3,
            totalOpenPrs: 1,
            totalClosedPrs: 0,
            totalOpenIssues: 0,
            totalClosedIssues: 0,
            totalSolvedIssues: 0,
            totalValidSolvedIssues: 0,
            isEligible: true,
            credibility: 1,
            eligibleRepoCount: 1,
            hotkey: "must-not-leak",
          },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({
          repositories: [
            {
              repositoryFullName: "JSONbored/gittensory",
              totalPrs: "4",
              totalMergedPrs: "3",
              totalOpenPrs: "1",
              totalClosedPrs: "0",
              totalOpenIssues: "0",
              totalClosedIssues: "0",
              isEligible: true,
              credibility: "1.000000",
            },
          ],
        });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      if (url.includes("/access_tokens")) {
        return Response.json({ token: "installation-token", expires_at: "2026-05-28T00:04:00.000Z" });
      }
      // A web-visible route file (isVisualPath) — the ONLY difference from the sibling unified-comment fixture —
      // so screenshotsAllowed's file-touch gate opens and buildCapture actually runs for this PR.
      if (url.includes("/pulls/3/files")) {
        return Response.json([{ filename: "apps/gittensory-ui/src/routes/app.index.tsx", additions: 5, deletions: 1, status: "modified" }]);
      }
      if (/\/pulls\/3(?:\?|$)/.test(url)) return Response.json({ number: 3, mergeable_state: "clean" });
      if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 901 }, { status: 201 });
      if (url.includes("/check-runs/901") && method === "PATCH") return Response.json({ id: 901 });
      if (url.includes("/issues/3/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/3/comments") && method === "POST") {
        postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      }
      // Preview discovery (deployments / commit checks / PR comments): none configured for this fixture, so
      // buildCapture's discovery chain finds nothing and falls back to placeholders — it's wrapped in its own
      // try/catch, so a 404 here degrades to "no preview" rather than failing the capture or the review.
      return new Response("not found", { status: 404 });
    });

    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "pr-visual-config-wiring",
        eventName: "pull_request",
        payload: {
          action: "synchronize",
          installation: {
            id: 123,
            account: { login: "JSONbored", id: 1, type: "User" },
            repository_selection: "selected",
            permissions: { metadata: "read", pull_requests: "read", issues: "write", checks: "write" },
            events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
          },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: {
            number: 3,
            title: "Update the app index route",
            state: "open",
            user: { login: "oktofeesh1" },
            head: { sha: "visualcfg123" },
            labels: [{ name: "bug" }],
            body: "Fixes #1\n\nValidation: npm test",
          },
        },
      });

      // The capture pipeline ran (resolveVisualCaptureConfig -> buildCapture, both reached only through this
      // webhook path) and produced at least a placeholder-backed route, so the collapsible renders.
      expect(postedBody).toContain("Visual preview");
      expect(postedBody).toContain("`/app`");
      // Public-safe by construction — no internal trust/economics fields leak through the shot URLs either.
      expect(postedBody).not.toMatch(/wallet|hotkey|reward|trust score/i);
    } finally {
      liveCiSpy.mockRestore();
    }
  });

  // #4083: review.visual.enabled: false (config-as-code, VPS-only in practice) overrides the coarser
  // LOOPOVER_REVIEW_SCREENSHOTS + LOOPOVER_REVIEW_REPOS env-var gate above — same fixture as the sibling
  // test above (same webhook, same visual-file touch, same env flag ON), the ONLY difference being the
  // .loopover.yml content, so this isolates the new enabled:false branch in processors.ts.
  it("skips the capture pipeline entirely when review.visual.enabled is false, even though the env-var gate allows it (#4083)", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_UNIFIED_COMMENT: "1",
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      reviewCheckMode: "required",
      backfillEnabled: true,
      autonomy: { update_branch: "auto" },
    });
    let postedBody = "";
    const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
      ciState: "passed",
      hasPending: false,
      hasVisiblePending: false,
      hasMissingRequiredContext: false,
      failingDetails: [],
      nonRequiredFailingDetails: [],
      ciCompletenessWarning: null,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://raw.githubusercontent.com/JSONbored/gittensory/HEAD/.loopover.yml") {
        return new Response("review:\n  visual:\n    enabled: false\n");
      }
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          {
            uid: 7,
            githubUsername: "oktofeesh1",
            githubId: "123",
            totalPrs: 4,
            totalMergedPrs: 3,
            totalOpenPrs: 1,
            totalClosedPrs: 0,
            totalOpenIssues: 0,
            totalClosedIssues: 0,
            totalSolvedIssues: 0,
            totalValidSolvedIssues: 0,
            isEligible: true,
            credibility: 1,
            eligibleRepoCount: 1,
            hotkey: "must-not-leak",
          },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({
          repositories: [
            {
              repositoryFullName: "JSONbored/gittensory",
              totalPrs: "4",
              totalMergedPrs: "3",
              totalOpenPrs: "1",
              totalClosedPrs: "0",
              totalOpenIssues: "0",
              totalClosedIssues: "0",
              isEligible: true,
              credibility: "1.000000",
            },
          ],
        });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      if (url.includes("/access_tokens")) {
        return Response.json({ token: "installation-token", expires_at: "2026-05-28T00:04:00.000Z" });
      }
      if (url.includes("/pulls/3/files")) {
        return Response.json([{ filename: "apps/gittensory-ui/src/routes/app.index.tsx", additions: 5, deletions: 1, status: "modified" }]);
      }
      if (/\/pulls\/3(?:\?|$)/.test(url)) return Response.json({ number: 3, mergeable_state: "clean" });
      if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 901 }, { status: 201 });
      if (url.includes("/check-runs/901") && method === "PATCH") return Response.json({ id: 901 });
      if (url.includes("/issues/3/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/3/comments") && method === "POST") {
        postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "pr-visual-config-disabled",
        eventName: "pull_request",
        payload: {
          action: "synchronize",
          installation: {
            id: 123,
            account: { login: "JSONbored", id: 1, type: "User" },
            repository_selection: "selected",
            permissions: { metadata: "read", pull_requests: "read", issues: "write", checks: "write" },
            events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
          },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: {
            number: 3,
            title: "Update the app index route",
            state: "open",
            user: { login: "oktofeesh1" },
            // Empty sha + a present ref (the opposite combination from the sibling "threads review.visual config"
            // test's { sha: "visualcfg123" }) so between the two tests, both branches of captureTarget's
            // optional headSha/headRef spreads are exercised.
            head: { sha: "", ref: "feature/visual-config-disabled" },
            labels: [{ name: "bug" }],
            body: "Fixes #1\n\nValidation: npm test",
          },
        },
      });

      // review.visual.enabled: false overrode the env-var gate — no capture attempted, so no Visual preview
      // section at all, even though the PR touches a visual file and LOOPOVER_REVIEW_SCREENSHOTS is on.
      expect(postedBody).not.toContain("Visual preview");
    } finally {
      liveCiSpy.mockRestore();
    }
  });

  // #1957: with the unified comment on AND `.loopover.yml` opting into `review.changed_files_summary`, the
  // rendered comment gains the deterministic "Changed files" collapsible built from the SAME PR-files fetch the
  // unified branch already does for the readiness chip — no separate call, no AI. Mirrors the base unified-comment
  // test above but adds the manifest opt-in and asserts the new section's presence + content.
  it("renders the Changed files summary when review.changed_files_summary is on in .loopover.yml", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_UNIFIED_COMMENT: "1" });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      reviewCheckMode: "required",
      backfillEnabled: true,
      autonomy: { update_branch: "auto" },
    });
    let postedBody = "";
    const calls = { comments: 0, gateChecks: 0 };
    let gateFinalized = false;
    let failedPostGateMint = false;
    const liveCiSpy = vi
      .spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl")
      .mockRejectedValueOnce(new Error("transient CI read failed"))
      .mockResolvedValue({
        ciState: "passed",
        hasPending: false,
        hasVisiblePending: false,
        hasMissingRequiredContext: false,
        failingDetails: [],
        nonRequiredFailingDetails: [],
        ciCompletenessWarning: null,
      });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          {
            uid: 7,
            githubUsername: "oktofeesh1",
            githubId: "123",
            totalPrs: 4,
            totalMergedPrs: 3,
            totalOpenPrs: 1,
            totalClosedPrs: 0,
            totalOpenIssues: 0,
            totalClosedIssues: 0,
            totalSolvedIssues: 0,
            totalValidSolvedIssues: 0,
            isEligible: true,
            credibility: 1,
            eligibleRepoCount: 1,
            hotkey: "must-not-leak",
          },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({
          repositories: [
            {
              repositoryFullName: "JSONbored/gittensory",
              totalPrs: "4",
              totalMergedPrs: "3",
              totalOpenPrs: "1",
              totalClosedPrs: "0",
              totalOpenIssues: "0",
              totalClosedIssues: "0",
              isEligible: true,
              credibility: "1.000000",
            },
          ],
        });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      // .loopover.yml opts into the deterministic changed-files summary — no AI involved.
      if (url === "https://raw.githubusercontent.com/JSONbored/gittensory/HEAD/.loopover.yml") {
        return new Response("review:\n  changed_files_summary: true\n");
      }
      if (url.includes("/access_tokens")) {
        if (gateFinalized && !failedPostGateMint) {
          failedPostGateMint = true;
          return new Response("mint failed", { status: 500 });
        }
        return Response.json({ token: "installation-token", expires_at: "2026-05-28T00:04:00.000Z" });
      }
      // PR files — the unified branch (re)fetches them to count changed files AND (with the toggle above) to
      // build the "Changed files" summary. A doc + a source file so the summary shows 2 distinct category rows.
      if (url.includes("/pulls/3/files"))
        return Response.json([
          { filename: "src/cache.ts", additions: 5, deletions: 1, status: "modified" },
          { filename: "README.md", additions: 2, deletions: 0, status: "modified" },
        ]);
      if (/\/pulls\/3(?:\?|$)/.test(url)) return Response.json({ number: 3, mergeable_state: "clean" });
      // Gate check-run — must succeed so `gateEvaluation` is produced and the flag-ON branch runs.
      // The pending check is POSTed (in_progress), then PATCHed to its completed conclusion.
      if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") {
        calls.gateChecks += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string };
        if (body.status !== "in_progress" || body.conclusion) {
          gateFinalized = true;
          clearInstallationTokenCacheForTest();
        }
        return Response.json({ id: 901 }, { status: 201 });
      }
      if (url.includes("/check-runs/901") && method === "PATCH") {
        calls.gateChecks += 1;
        gateFinalized = true;
        clearInstallationTokenCacheForTest();
        return Response.json({ id: 901 });
      }
      if (url.includes("/issues/3/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/3/comments") && method === "POST") {
        calls.comments += 1;
        postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "pr-unified-comment-changed-files",
        eventName: "pull_request",
        payload: {
          action: "synchronize",
          installation: {
            id: 123,
            account: { login: "JSONbored", id: 1, type: "User" },
            repository_selection: "selected",
            permissions: { metadata: "read", pull_requests: "read", issues: "write", checks: "write" },
            events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
          },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: {
            number: 3,
            title: "Fix webhook duplicate delivery again",
            state: "open",
            user: { login: "oktofeesh1" },
            head: { sha: "unified456" },
            labels: [{ name: "bug" }],
            body: "Fixes #1\n\nValidation: npm test",
          },
        },
      });

      expect(calls.comments).toBe(2);
      expect(postedBody).toContain("<!-- gittensory-pr-panel:v1 -->");
      // The deterministic changed-files collapsible — per-file rows with GitHub Files-tab links (#2157).
      expect(postedBody).toContain("Changed files");
      expect(postedBody).toContain("| `src/cache.ts` | +5 | -1 | [View diff](https://github.com/JSONbored/gittensory/pull/3/files#diff-");
      expect(postedBody).toContain("| `README.md` | +2 | -0 | [View diff](https://github.com/JSONbored/gittensory/pull/3/files#diff-");
    } finally {
      liveCiSpy.mockRestore();
    }
  });

  // #1955: with the unified comment on AND `.loopover.yml` opting into `review.effort_score`, the rendered
  // comment gains the deterministic, no-AI "review effort: N/5 (~M min)" chip — computed by estimateReviewEffort
  // from the SAME PR-files fetch the unified branch already does (no separate call). Mirrors the
  // changed_files_summary test above but asserts the effort chip's presence + exact value instead.
  it("renders the review effort chip when review.effort_score is on in .loopover.yml", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_UNIFIED_COMMENT: "1" });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      reviewCheckMode: "required",
      backfillEnabled: true,
      autonomy: { update_branch: "auto" },
    });
    let postedBody = "";
    const calls = { comments: 0, gateChecks: 0 };
    let gateFinalized = false;
    let failedPostGateMint = false;
    const liveCiSpy = vi
      .spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl")
      .mockRejectedValueOnce(new Error("transient CI read failed"))
      .mockResolvedValue({
        ciState: "passed",
        hasPending: false,
        hasVisiblePending: false,
        hasMissingRequiredContext: false,
        failingDetails: [],
        nonRequiredFailingDetails: [],
        ciCompletenessWarning: null,
      });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          {
            uid: 7,
            githubUsername: "oktofeesh1",
            githubId: "123",
            totalPrs: 4,
            totalMergedPrs: 3,
            totalOpenPrs: 1,
            totalClosedPrs: 0,
            totalOpenIssues: 0,
            totalClosedIssues: 0,
            totalSolvedIssues: 0,
            totalValidSolvedIssues: 0,
            isEligible: true,
            credibility: 1,
            eligibleRepoCount: 1,
            hotkey: "must-not-leak",
          },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({
          repositories: [
            {
              repositoryFullName: "JSONbored/gittensory",
              totalPrs: "4",
              totalMergedPrs: "3",
              totalOpenPrs: "1",
              totalClosedPrs: "0",
              totalOpenIssues: "0",
              totalClosedIssues: "0",
              isEligible: true,
              credibility: "1.000000",
            },
          ],
        });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      // .loopover.yml opts into the deterministic effort score — no AI involved.
      if (url === "https://raw.githubusercontent.com/JSONbored/gittensory/HEAD/.loopover.yml") {
        return new Response("review:\n  effort_score: true\n");
      }
      if (url.includes("/access_tokens")) {
        if (gateFinalized && !failedPostGateMint) {
          failedPostGateMint = true;
          return new Response("mint failed", { status: 500 });
        }
        return Response.json({ token: "installation-token", expires_at: "2026-05-28T00:04:00.000Z" });
      }
      // PR files — the unified branch (re)fetches them to count changed files AND (with the toggle above) to
      // compute the effort estimate. A 10-added-line source file WITH a patch (weighted 10) plus a docs file with
      // NO `patch` field (exercises the `typeof file.payload?.patch === "string" ? ... : undefined` fallback ->
      // addedLineCount(undefined) = 0, so it contributes 0 weighted lines but still its per-file overhead):
      // weighted 10 + 0 + 2 files * 3 overhead = effort 16 -> band 2, minutes round(16 * 0.5) = 8
      // (see estimateReviewEffort — src/review/review-effort.ts).
      if (url.includes("/pulls/3/files"))
        return Response.json([
          {
            filename: "src/cache.ts",
            additions: 10,
            deletions: 1,
            status: "modified",
            patch: `@@ -1,1 +1,11 @@\n${Array.from({ length: 10 }, (_, i) => `+const x${i} = ${i};`).join("\n")}`,
          },
          { filename: "README.md", additions: 2, deletions: 0, status: "modified" },
        ]);
      if (/\/pulls\/3(?:\?|$)/.test(url)) return Response.json({ number: 3, mergeable_state: "clean" });
      // Gate check-run — must succeed so `gateEvaluation` is produced and the flag-ON branch runs.
      // The pending check is POSTed (in_progress), then PATCHed to its completed conclusion.
      if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") {
        calls.gateChecks += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string };
        if (body.status !== "in_progress" || body.conclusion) {
          gateFinalized = true;
          clearInstallationTokenCacheForTest();
        }
        return Response.json({ id: 901 }, { status: 201 });
      }
      if (url.includes("/check-runs/901") && method === "PATCH") {
        calls.gateChecks += 1;
        gateFinalized = true;
        clearInstallationTokenCacheForTest();
        return Response.json({ id: 901 });
      }
      if (url.includes("/issues/3/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/3/comments") && method === "POST") {
        calls.comments += 1;
        postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "pr-unified-comment-effort-score",
        eventName: "pull_request",
        payload: {
          action: "synchronize",
          installation: {
            id: 123,
            account: { login: "JSONbored", id: 1, type: "User" },
            repository_selection: "selected",
            permissions: { metadata: "read", pull_requests: "read", issues: "write", checks: "write" },
            events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
          },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: {
            number: 3,
            title: "Fix webhook duplicate delivery again",
            state: "open",
            user: { login: "oktofeesh1" },
            head: { sha: "unified789" },
            labels: [{ name: "bug" }],
            body: "Fixes #1\n\nValidation: npm test",
          },
        },
      });

      expect(calls.comments).toBe(2);
      expect(postedBody).toContain("<!-- gittensory-pr-panel:v1 -->");
      // The new deterministic, no-AI chip: band 2 (effort 16 <= BAND_MAX[1]=40), minutes round(16*0.5)=8.
      expect(postedBody).toContain("`review effort: 2/5 (~8 min)`");
    } finally {
      liveCiSpy.mockRestore();
    }
  });

  // #2051/#4147: with the unified comment on AND `.loopover.yml` opting into `review.auto_merge_summary`,
  // the rendered comment gains the deterministic, no-AI "Auto-merge readiness" collapsible — computed from the
  // SAME live CI state, gate conclusion, mergeable_state, and linked-issue facts this pass already resolves
  // for the readiness chip and gate verdict, no extra fetch. Mirrors the effort_score test above but asserts
  // the auto-merge-readiness table's presence + condition marks instead.
  it("renders the Auto-merge readiness collapsible when review.auto_merge_summary is on in .loopover.yml", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_UNIFIED_COMMENT: "1" });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      reviewCheckMode: "required",
      backfillEnabled: true,
      autonomy: { update_branch: "auto" },
    });
    let postedBody = "";
    const calls = { comments: 0, gateChecks: 0 };
    let gateFinalized = false;
    let failedPostGateMint = false;
    const liveCiSpy = vi
      .spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl")
      .mockRejectedValueOnce(new Error("transient CI read failed"))
      .mockResolvedValue({
        ciState: "passed",
        hasPending: false,
        hasVisiblePending: false,
        hasMissingRequiredContext: false,
        failingDetails: [],
        nonRequiredFailingDetails: [],
        ciCompletenessWarning: null,
      });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          {
            uid: 7,
            githubUsername: "oktofeesh1",
            githubId: "123",
            totalPrs: 4,
            totalMergedPrs: 3,
            totalOpenPrs: 1,
            totalClosedPrs: 0,
            totalOpenIssues: 0,
            totalClosedIssues: 0,
            totalSolvedIssues: 0,
            totalValidSolvedIssues: 0,
            isEligible: true,
            credibility: 1,
            eligibleRepoCount: 1,
            hotkey: "must-not-leak",
          },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({
          repositories: [
            {
              repositoryFullName: "JSONbored/gittensory",
              totalPrs: "4",
              totalMergedPrs: "3",
              totalOpenPrs: "1",
              totalClosedPrs: "0",
              totalOpenIssues: "0",
              totalClosedIssues: "0",
              isEligible: true,
              credibility: "1.000000",
            },
          ],
        });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      // .loopover.yml opts into the deterministic auto-merge summary — no AI involved.
      if (url === "https://raw.githubusercontent.com/JSONbored/gittensory/HEAD/.loopover.yml") {
        return new Response("review:\n  auto_merge_summary: true\n");
      }
      if (url.includes("/access_tokens")) {
        if (gateFinalized && !failedPostGateMint) {
          failedPostGateMint = true;
          return new Response("mint failed", { status: 500 });
        }
        return Response.json({ token: "installation-token", expires_at: "2026-05-28T00:04:00.000Z" });
      }
      if (url.includes("/pulls/3/files"))
        return Response.json([{ filename: "src/cache.ts", additions: 10, deletions: 1, status: "modified" }]);
      // mergeable_state: "clean" -> mergeableClean: true in the rendered table.
      if (/\/pulls\/3(?:\?|$)/.test(url)) return Response.json({ number: 3, mergeable_state: "clean" });
      // Gate check-run — must succeed so `gateEvaluation` concludes "success" -> gatePassing: true.
      if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") {
        calls.gateChecks += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string };
        if (body.status !== "in_progress" || body.conclusion) {
          gateFinalized = true;
          clearInstallationTokenCacheForTest();
        }
        return Response.json({ id: 901 }, { status: 201 });
      }
      if (url.includes("/check-runs/901") && method === "PATCH") {
        calls.gateChecks += 1;
        gateFinalized = true;
        clearInstallationTokenCacheForTest();
        return Response.json({ id: 901 });
      }
      if (url.includes("/issues/3/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/3/comments") && method === "POST") {
        calls.comments += 1;
        postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "pr-unified-comment-auto-merge-summary",
        eventName: "pull_request",
        payload: {
          action: "synchronize",
          installation: {
            id: 123,
            account: { login: "JSONbored", id: 1, type: "User" },
            repository_selection: "selected",
            permissions: { metadata: "read", pull_requests: "read", issues: "write", checks: "write" },
            events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
          },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: {
            number: 3,
            title: "Fix webhook duplicate delivery again",
            state: "open",
            user: { login: "oktofeesh1" },
            head: { sha: "unified789" },
            labels: [{ name: "bug" }],
            // A linked issue (#1) is present -> linkedIssueValid: true in the rendered table.
            body: "Fixes #1\n\nValidation: npm test",
          },
        },
      });

      expect(calls.comments).toBe(2);
      expect(postedBody).toContain("<!-- gittensory-pr-panel:v1 -->");
      expect(postedBody).toContain("Auto-merge readiness");
      expect(postedBody).toContain("_Read-only snapshot of the current auto-merge conditions");
      // All four conditions pass with this fixture: CI green, gate passing, branch mergeable clean, valid
      // linked issue.
      expect(postedBody).toContain("| CI checks green | ✅ |");
      expect(postedBody).toContain("| Gate passing | ✅ |");
      expect(postedBody).toContain("| Branch mergeable (clean) | ✅ |");
      expect(postedBody).toContain("| Valid linked issue | ✅ |");
    } finally {
      liveCiSpy.mockRestore();
    }
  });

  // #2044: `.loopover.yml` `review.tone` is folded into the AI reviewer's system prompt by
  // composeManifestReviewInstructions (src/signals/focus-manifest.ts), consumed by
  // src/queue/processors.ts's aiReviewCacheReadDecideAndRun. That composition is unit-tested in isolation
  // (focus-manifest.test.ts), but nothing previously drove the full webhook -> processJob -> runGittensoryAiReview
  // pipeline to confirm the resolved tone text actually reaches env.AI.run's system message. Mirrors the
  // changed_files_summary/effort_score tests above but captures the AI system prompt instead of the posted body.
  it("threads review.tone from .loopover.yml into the AI reviewer's system prompt (#2044)", async () => {
    let capturedSystem = "";
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: {
        run: async (_model: string, options: { messages: Array<{ role: string; content: string }> }) => {
          capturedSystem = options.messages[0]?.content ?? "";
          return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) };
        },
      } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "block",
      gatePack: "oss-anti-slop",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/issues/7/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/7/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      // The repo's own review.tone opt-in (#2044) -- a maintainer voice brief, distinct from review.instructions.
      if (url === "https://raw.githubusercontent.com/JSONbored/gittensory/HEAD/.loopover.yml") {
        return new Response("review:\n  tone: Keep findings terse and skip pleasantries\n");
      }
      // Real GitHub raw-content 404s for every other manifest candidate -- without this, Response.json({}) below would 200 the first candidate
      // tried and mask the review.tone config crafted above.
      if (url.startsWith("https://raw.githubusercontent.com/")) return new Response("not found", { status: 404 });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "review-tone-system-prompt",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" },
      },
    });

    // The composed tone section (composeManifestReviewInstructions) really reached env.AI.run's system message --
    // not just the pure-function assertion in focus-manifest.test.ts.
    expect(capturedSystem).toContain(
      "Review tone (maintainer voice brief — complements review.profile): Keep findings terse and skip pleasantries",
    );
  });

  // #review-exclude-paths / #2043: `review.exclude_paths`/`review.path_filters` are resolved by
  // resolveReviewPromptOverrides and applied by filterReviewFilesForAi (src/signals/focus-manifest.ts), consumed
  // by src/queue/processors.ts's runAiReviewForAdvisory -- but ONLY in advisory mode (block mode intentionally
  // reviews the full diff so a filtered path can never bypass an AI consensus blocker). filterReviewFilesForAi
  // itself is unit-tested as a pure function (focus-manifest.test.ts); every existing e2e assertion of this field
  // elsewhere in this file only ever passes EMPTY excludePaths/pathFilters arrays (cache-fingerprint checks), so
  // nothing previously proved a NON-EMPTY glob genuinely removes a matching file from what the AI reviewer sees.
  it("genuinely removes a review.exclude_paths match from the AI reviewer's diff in advisory mode (#review-exclude-paths)", async () => {
    let capturedUser = "";
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: {
        run: async (_model: string, options: { messages: Array<{ role: string; content: string }> }) => {
          capturedUser = options.messages[1]?.content ?? "";
          return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) };
        },
      } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      // advisory (NOT block): block mode always reviews the full diff, ignoring exclude_paths/path_filters, so
      // only advisory mode exercises the filterReviewFilesForAi branch (src/queue/processors.ts).
      aiReviewMode: "advisory",
      // The PR author below is an unconfirmed contributor; aiReviewAllAuthors is the documented per-repo opt-in
      // that widens the AI-spend gate to every author (already unit-tested in ai-review-advisory.test.ts) so this
      // test doesn't also have to stand up the full miner-confirmation registry mocks just to reach the AI call.
      aiReviewAllAuthors: true,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/7/files"))
        return Response.json([
          { filename: "src/real-change.ts", status: "modified", additions: 3, deletions: 0, patch: "@@ -1,1 +1,4 @@\n+export const real = 1;\n+export const two = 2;\n+export const three = 3;" },
          { filename: "src/schema.generated.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,1 +1,2 @@\n+export const generatedMarker = true;" },
        ]);
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/issues/7/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/7/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      // The repo's own review.exclude_paths opt-in -- a NON-EMPTY glob (#review-exclude-paths), unlike every
      // existing fingerprint-only assertion of this field elsewhere in this file.
      if (url === "https://raw.githubusercontent.com/JSONbored/gittensory/HEAD/.loopover.yml") {
        return new Response('review:\n  exclude_paths:\n    - "**/*.generated.ts"\n');
      }
      // Real GitHub raw-content 404s for every other manifest candidate -- without this, the generic Response.json({}) catch-all below would
      // otherwise 200 the FIRST candidate tried and mask the exclude_paths config crafted above.
      if (url.startsWith("https://raw.githubusercontent.com/")) return new Response("not found", { status: 404 });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "review-exclude-paths-ai-diff",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" },
      },
    });

    // The non-excluded file's diff genuinely reached the AI reviewer's user prompt...
    expect(capturedUser).toContain("src/real-change.ts");
    // ...but the exclude_paths match is genuinely ABSENT -- not merely uncounted -- from what the AI reviewer
    // sees: neither its path nor its patch content leaked into the prompt.
    expect(capturedUser).not.toContain("schema.generated.ts");
    expect(capturedUser).not.toContain("generatedMarker");
  });

  // #2049: with the unified comment on AND `.loopover.yml` setting `review.max_findings`, the processor wires
  // manifest caps into `buildUnifiedCommentBody` and the renderer truncates blocker/nit lists with a "+N more"
  // footer. Mirrors the effort_score test above but asserts display-only truncation instead.
  it("truncates unified-comment blockers when review.max_findings is set in .loopover.yml (#2049)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_UNIFIED_COMMENT: "1" });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      reviewCheckMode: "required",
      backfillEnabled: true,
      autonomy: { update_branch: "auto" },
      linkedIssueGateMode: "block",
    });
    let postedBody = "";
    const calls = { comments: 0, gateChecks: 0 };
    let gateFinalized = false;
    let failedPostGateMint = false;
    const liveCiSpy = vi
      .spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl")
      .mockRejectedValueOnce(new Error("transient CI read failed"))
      .mockResolvedValue({
        ciState: "passed",
        hasPending: false,
        hasVisiblePending: false,
        hasMissingRequiredContext: false,
        failingDetails: [],
        nonRequiredFailingDetails: [],
        ciCompletenessWarning: null,
      });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          {
            uid: 7,
            githubUsername: "oktofeesh1",
            githubId: "123",
            totalPrs: 4,
            totalMergedPrs: 3,
            totalOpenPrs: 1,
            totalClosedPrs: 0,
            totalOpenIssues: 0,
            totalClosedIssues: 0,
            totalSolvedIssues: 0,
            totalValidSolvedIssues: 0,
            isEligible: true,
            credibility: 1,
            eligibleRepoCount: 1,
            hotkey: "must-not-leak",
          },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({
          repositories: [
            {
              repositoryFullName: "JSONbored/gittensory",
              totalPrs: "4",
              totalMergedPrs: "3",
              totalOpenPrs: "1",
              totalClosedPrs: "0",
              totalOpenIssues: "0",
              totalClosedIssues: "0",
              isEligible: true,
              credibility: "1.000000",
            },
          ],
        });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      if (url === "https://raw.githubusercontent.com/JSONbored/gittensory/HEAD/.loopover.yml") {
        return new Response("review:\n  max_findings:\n    blockers: 0\n");
      }
      if (url.includes("/access_tokens")) {
        if (gateFinalized && !failedPostGateMint) {
          failedPostGateMint = true;
          return new Response("mint failed", { status: 500 });
        }
        return Response.json({ token: "installation-token", expires_at: "2026-05-28T00:04:00.000Z" });
      }
      if (url.includes("/pulls/3/files"))
        return Response.json([{ filename: "src/cache.ts", additions: 5, deletions: 1, status: "modified" }]);
      if (/\/pulls\/3(?:\?|$)/.test(url)) return Response.json({ number: 3, mergeable_state: "clean" });
      if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") {
        calls.gateChecks += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string };
        if (body.status !== "in_progress" || body.conclusion) {
          gateFinalized = true;
          clearInstallationTokenCacheForTest();
        }
        return Response.json({ id: 901 }, { status: 201 });
      }
      if (url.includes("/check-runs/901") && method === "PATCH") {
        calls.gateChecks += 1;
        gateFinalized = true;
        clearInstallationTokenCacheForTest();
        return Response.json({ id: 901 });
      }
      if (url.includes("/issues/3/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/3/comments") && method === "POST") {
        calls.comments += 1;
        postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "pr-unified-comment-max-findings",
        eventName: "pull_request",
        payload: {
          action: "synchronize",
          installation: {
            id: 123,
            account: { login: "JSONbored", id: 1, type: "User" },
            repository_selection: "selected",
            permissions: { metadata: "read", pull_requests: "read", issues: "write", checks: "write" },
            events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
          },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: {
            number: 3,
            title: "Fix webhook duplicate delivery again",
            state: "open",
            user: { login: "oktofeesh1" },
            head: { sha: "unifiedmaxfindings" },
            labels: [{ name: "bug" }],
            body: "No linked issue on purpose.\n\nValidation: npm test",
          },
        },
      });

      expect(calls.comments).toBe(2);
      expect(postedBody).toContain("<!-- gittensory-pr-panel:v1 -->");
      expect(postedBody).toContain("_+1 more_");
    } finally {
      liveCiSpy.mockRestore();
    }
  });

  // #2181 (apply slice of #1964): review.memory end-to-end through the real webhook path. A `qualityGateMode:
  // "advisory"` + an unreachable `qualityGateMinScore: 100` deterministically produces the
  // `readiness_score_below_threshold` ADVISORY (never a blocker — readiness stays advisory-only, see
  // rules.test.ts) warning finding on every pass, giving a stable target to record a suppression signal against
  // and verify it is (or is not) suppressed from the rendered unified comment. The manifest is seeded DIRECTLY
  // via upsertRepoFocusManifest (bypassing the 6h .loopover.yml fetch cache) so each test's `.loopover.yml`
  // fetch response is never actually needed on the hot path — it only serves as an inert 404 fallback.
  async function runReadinessWarningPass(env: Env, opts: { deliveryId: string; headSha: string; reviewMemoryManifest: boolean }) {
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      reviewCheckMode: "required",
      backfillEnabled: true,
      autonomy: { update_branch: "auto" },
      qualityGateMode: "advisory",
      qualityGateMinScore: 100,
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", opts.reviewMemoryManifest ? { review: { memory: true } } : {});
    let postedBody = "";
    let gateFinalized = false;
    let failedPostGateMint = false;
    const liveCiSpy = vi
      .spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl")
      .mockResolvedValue({
        ciState: "passed",
        hasPending: false,
        hasVisiblePending: false,
        hasMissingRequiredContext: false,
        failingDetails: [],
        nonRequiredFailingDetails: [],
        ciCompletenessWarning: null,
      });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          {
            uid: 7,
            githubUsername: "oktofeesh1",
            githubId: "123",
            totalPrs: 4,
            totalMergedPrs: 3,
            totalOpenPrs: 1,
            totalClosedPrs: 0,
            totalOpenIssues: 0,
            totalClosedIssues: 0,
            totalSolvedIssues: 0,
            totalValidSolvedIssues: 0,
            isEligible: true,
            credibility: 1,
            eligibleRepoCount: 1,
            hotkey: "must-not-leak",
          },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({
          repositories: [
            {
              repositoryFullName: "JSONbored/gittensory",
              totalPrs: "4",
              totalMergedPrs: "3",
              totalOpenPrs: "1",
              totalClosedPrs: "0",
              totalOpenIssues: "0",
              totalClosedIssues: "0",
              isEligible: true,
              credibility: "1.000000",
            },
          ],
        });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      if (url === "https://raw.githubusercontent.com/JSONbored/gittensory/HEAD/.loopover.yml") {
        return new Response("not found", { status: 404 });
      }
      if (url.includes("/access_tokens")) {
        if (gateFinalized && !failedPostGateMint) {
          failedPostGateMint = true;
          return new Response("mint failed", { status: 500 });
        }
        return Response.json({ token: "installation-token", expires_at: "2026-05-28T00:04:00.000Z" });
      }
      if (url.includes("/pulls/3/files"))
        return Response.json([{ filename: "src/cache.ts", additions: 5, deletions: 1, status: "modified" }]);
      if (/\/pulls\/3(?:\?|$)/.test(url)) return Response.json({ number: 3, mergeable_state: "clean" });
      if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string };
        if (body.status !== "in_progress" || body.conclusion) {
          gateFinalized = true;
          clearInstallationTokenCacheForTest();
        }
        return Response.json({ id: 901 }, { status: 201 });
      }
      if (url.includes("/check-runs/901") && method === "PATCH") {
        gateFinalized = true;
        clearInstallationTokenCacheForTest();
        return Response.json({ id: 901 });
      }
      if (url.includes("/issues/3/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/3/comments") && method === "POST") {
        postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });
    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: opts.deliveryId,
        eventName: "pull_request",
        payload: {
          action: "synchronize",
          installation: {
            id: 123,
            account: { login: "JSONbored", id: 1, type: "User" },
            repository_selection: "selected",
            permissions: { metadata: "read", pull_requests: "read", issues: "write", checks: "write" },
            events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
          },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: {
            number: 3,
            title: "Fix webhook duplicate delivery again",
            state: "open",
            user: { login: "oktofeesh1" },
            head: { sha: opts.headSha },
            labels: [{ name: "bug" }],
            // No linked issue AND no validation evidence -- keeps the readiness score comfortably below the
            // unreachable qualityGateMinScore: 100 threshold above, so readiness_score_below_threshold fires
            // deterministically regardless of the panel's exact scoring breakdown.
            body: "No linked issue, no validation evidence on purpose.",
          },
        },
      });
    } finally {
      liveCiSpy.mockRestore();
    }
    return postedBody;
  }

  it("FLAG-OFF (default): review.memory in .loopover.yml alone never suppresses the readiness warning (operator kill-switch required)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_UNIFIED_COMMENT: "1" });
    // review.memory: true in the manifest, but NO LOOPOVER_REVIEW_MEMORY env flag on this env -- byte-identical.
    const postedBody = await runReadinessWarningPass(env, {
      deliveryId: "review-memory-flag-off",
      headSha: "revmem-flag-off",
      reviewMemoryManifest: true,
    });
    expect(postedBody).toContain("Readiness score is below the configured threshold");
  });

  it("FLAG-ON: suppresses a readiness warning EXACTLY matching a previously recorded suppression signal", async () => {
    const seedEnv = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_UNIFIED_COMMENT: "1" });
    // A throwaway pass (flag/manifest both off — byte-identical review path) against a SEPARATE, disposable D1
    // instance just to learn the finding's REAL, LIVE-computed readiness score (a pure function of the fixed
    // PR/settings fixture above, so it reproduces identically for the real pass below on its own fresh `env`).
    // The rendered nit itself only carries `title`+`action` (see buildDualReviewNotes's gateNits) — the score
    // comes from the status chip.
    const seedBody = await runReadinessWarningPass(seedEnv, { deliveryId: "review-memory-seed", headSha: "revmem-seed", reviewMemoryManifest: false });
    expect(seedBody).toContain("Readiness score is below the configured threshold");
    const scoreMatch = /readiness (\d+)\/100/.exec(seedBody);
    expect(scoreMatch).not.toBeNull();
    const score = Number(scoreMatch![1]);
    // Reconstructs buildQualityGateWarning's exact title+detail template (src/rules/advisory.ts) from the live
    // score + the qualityGateMinScore: 100 configured above, so the computed patternHash matches the real finding.
    const detail = `The public readiness score is ${score}/100, below the repository threshold of 100/100.`;
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_UNIFIED_COMMENT: "1", LOOPOVER_REVIEW_MEMORY: "true" });
    await recordReviewSuppression(env, {
      repoFullName: "JSONbored/gittensory",
      category: "readiness_score_below_threshold",
      patternHash: reviewMemoryFingerprint({
        category: "readiness_score_below_threshold",
        message: `Readiness score is below the configured threshold ${detail}`,
      }),
      createdBy: "maintainer1",
    });
    // The flag is ON (env + manifest) and the exact-match signal is now stored -- the warning must be
    // suppressed from the rendered unified comment.
    const postedBody = await runReadinessWarningPass(env, {
      deliveryId: "review-memory-flag-on",
      headSha: "revmem-flag-on",
      reviewMemoryManifest: true,
    });
    expect(postedBody).not.toContain("Readiness score is below the configured threshold");
  });

  it("FLAG-ON, no stored signals: neither suppresses nor demotes -- the warning renders exactly as if review.memory were off (REGRESSION: the all-clear branch where the store read succeeds but finds nothing to apply)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_UNIFIED_COMMENT: "1", LOOPOVER_REVIEW_MEMORY: "true" });
    // Flag is fully ON (env + manifest) and the suppression-store read succeeds, but NO signal has ever been
    // recorded for this repo -- applyReviewMemorySuppression's own empty-signals short-circuit returns
    // suppressedCount: 0, demotedCount: 0, so processors.ts's "anything to apply?" check is false and
    // renderedGate is never reassigned away from the original commentGate.
    const postedBody = await runReadinessWarningPass(env, {
      deliveryId: "review-memory-no-signals",
      headSha: "revmem-no-signals",
      reviewMemoryManifest: true,
    });
    expect(postedBody).toContain("Readiness score is below the configured threshold");
  });

  it("FLAG-ON: DEMOTES (keeps, but does not suppress) a same-category readiness warning that does not exactly match any stored signal", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_UNIFIED_COMMENT: "1", LOOPOVER_REVIEW_MEMORY: "true" });
    // A signal for the SAME category but a patternHash that can never match this PR's real finding -- exercises
    // the "demote" (scope-matched, hash-mismatched) branch instead of "suppress".
    await recordReviewSuppression(env, {
      repoFullName: "JSONbored/gittensory",
      category: "readiness_score_below_threshold",
      patternHash: "never-matches-the-real-finding",
      createdBy: "maintainer1",
    });
    const postedBody = await runReadinessWarningPass(env, {
      deliveryId: "review-memory-demote",
      headSha: "revmem-demote",
      reviewMemoryManifest: true,
    });
    // Demoted (not suppressed) -- the finding still renders in the comment.
    expect(postedBody).toContain("Readiness score is below the configured threshold");
  });

  it("FLAG-ON, fail-safe: a suppression-store read error leaves the readiness warning untouched rather than throwing", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_UNIFIED_COMMENT: "1", LOOPOVER_REVIEW_MEMORY: "true" });
    const listSpy = vi.spyOn(repositoriesModule, "listReviewSuppressions").mockRejectedValue(new Error("D1 unavailable"));
    try {
      const postedBody = await runReadinessWarningPass(env, {
        deliveryId: "review-memory-store-error",
        headSha: "revmem-store-error",
        reviewMemoryManifest: true,
      });
      expect(postedBody).toContain("Readiness score is below the configured threshold");
    } finally {
      listSpy.mockRestore();
    }
  });

  // #1955: the review-effort minutes persisted onto the public-stats audit event (independent of
  // review.effort_score, which only gates the unified-comment CHIP) must never block the publish itself when the
  // estimator throws — the publish still completes and simply omits `reviewEffortMinutes` from the event metadata
  // (public-stats.ts's own COALESCE-style fallback then applies, same as a pre-#1955 historical row).
  it("swallows an estimateReviewEffort failure when persisting the public-stats minutes — the publish still completes", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", commentMode: "all_prs", publicSurface: "comment_only", autoLabelEnabled: false, checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "off", gatePack: "oss-anti-slop" });
    const estimateSpy = vi.spyOn(reviewEffortModule, "estimateReviewEffort").mockImplementationOnce(() => {
      throw new Error("estimator blew up");
    });
    let commentPosted = false;
    let publishedMetadata: Record<string, unknown> | undefined;
    const originalRecordAuditEvent = repositoriesModule.recordAuditEvent;
    const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockImplementation(async (auditEnv, event) => {
      if (event.eventType === "github_app.pr_public_surface_published") {
        publishedMetadata = event.metadata as Record<string, unknown>;
      }
      await originalRecordAuditEvent(auditEnv, event);
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/8/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/8")) return Response.json({ number: 8, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a8" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a8/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a8/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/issues/8/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/8/comments") && method === "POST") { commentPosted = true; return Response.json({ id: 1 }, { status: 201 }); }
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    try {
      await expect(
        processJob(env, {
          type: "github-webhook",
          deliveryId: "effort-estimator-throws",
          eventName: "pull_request",
          payload: {
            action: "opened",
            installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
            repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
            pull_request: { number: 8, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a8" }, labels: [], body: "Closes #1" },
          },
        }),
      ).resolves.toBeUndefined();

      expect(commentPosted).toBe(true); // the publish completed despite the estimator throwing
      expect(estimateSpy).toHaveBeenCalled();
      expect(publishedMetadata).toBeDefined();
      expect(publishedMetadata).not.toHaveProperty("reviewEffortMinutes");
    } finally {
      estimateSpy.mockRestore();
      auditSpy.mockRestore();
    }
  });

  // #1958: with inline comments AND finding categories both on in .loopover.yml (finding_categories rides on
  // inline_comments, exactly like suggestions did for #1956), the model is asked to self-categorize each
  // inlineFindings item, and BOTH surfaces render it — the posted inline review comment label AND the unified
  // comment's new "Finding categories" collapsible.
  it("renders finding categories in the inline comment label and the unified comment's Finding categories section when review.finding_categories is on", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_UNIFIED_COMMENT: "1",
      LOOPOVER_REVIEW_INLINE_COMMENTS: "true",
      LOOPOVER_REVIEW_REPOS: "JSONbored/gittensory",
      AI: {
        run: async () =>
          ({
            response: JSON.stringify({
              assessment: "Looks fine overall.",
              blockers: [],
              nits: [],
              suggestions: [],
              inlineFindings: [
                { path: "src/db.ts", line: 2, severity: "nit", body: "This query is vulnerable to SQL injection.", category: "security" },
              ],
            }),
          }) as { response: string },
      } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "block",
      gatePack: "oss-anti-slop",
    });
    let inlineReviewComments: Array<{ body: string }> = [];
    let unifiedCommentBody = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // .loopover.yml opts into inline comments AND finding categories together.
      if (url === "https://raw.githubusercontent.com/JSONbored/gittensory/HEAD/.loopover.yml") {
        return new Response("review:\n  inline_comments: true\n  finding_categories: true\n");
      }
      // Real GitHub raw-content 404s for every other manifest candidate -- without this, Response.json({}) below would 200 the first candidate
      // tried and mask the inline_comments/finding_categories config crafted above.
      if (url.startsWith("https://raw.githubusercontent.com/")) return new Response("not found", { status: 404 });
      if (url.includes("/pulls/8/files"))
        return Response.json([{ filename: "src/db.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@ -1,1 +1,2 @@\n ctx\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/8")) return Response.json({ number: 8, title: "Add query helper", state: "open", user: { login: "contributor" }, head: { sha: "a8" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/a8/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a8/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      // The separate, quiet inline-review post (event: COMMENT) — distinct from the sticky unified issue comment.
      if (url.endsWith("/pulls/8/reviews") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { comments?: Array<{ body: string }> };
        inlineReviewComments = body.comments ?? [];
        return Response.json({ id: 55 });
      }
      if (url.includes("/issues/8/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/8/comments") && method === "POST") {
        unifiedCommentBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1 }, { status: 201 });
      }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-finding-categories",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 8, title: "Add query helper", state: "open", user: { login: "contributor" }, head: { sha: "a8" }, labels: [], body: "Closes #1" },
      },
    });

    // The inline PR-review comment label carries the category tag.
    expect(inlineReviewComments[0]?.body).toBe("**Nit · Security:** This query is vulnerable to SQL injection.");
    // The unified comment's new collapsible counts it too.
    expect(unifiedCommentBody).toContain("Finding categories");
    expect(unifiedCommentBody).toContain("| Security | 1 |");
  });

  // #1971: a FROZEN (manual-review) PR reuses its last published AI review, which carries no impact-map entries —
  // the unified comment still renders, and the impact-map render arm degrades to no section (aiReview present but
  // aiReview.impactMap undefined ⇒ `aiReview?.impactMap ?? []` ⇒ [] ⇒ buildImpactMapCollapsible null).
  it("renders the unified comment WITHOUT an Impact map section when a frozen review is reused (no threaded entries)", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_UNIFIED_COMMENT: "1",
      AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Fresh.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await persistRegistrySnapshot(env, normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"));
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", commentMode: "all_prs", publicSurface: "comment_only", autoLabelEnabled: false, checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "block", gatePack: "oss-anti-slop" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 77, title: "Held PR", state: "open", user: { login: "contributor" }, head: { sha: "a77" }, labels: [{ name: "manual-review" }], body: "Closes #1" });
    await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 77, status: "complete", reviewsSyncedAt: new Date().toISOString() });
    // A prior PUBLISHED review for this exact head — the freeze path reuses it (aiReview = frozenReview) instead of
    // spending a fresh AI call. Its cached shape has notes+reviewerCount but NO impactMap, so the render arm's
    // nullish arm fires.
    await putCachedAiReview(env, "JSONbored/gittensory", 77, "a77", "block", { notes: "Prior published review.", reviewerCount: 1 });
    await markAiReviewPublished(env, "JSONbored/gittensory", 77, "a77");
    let unifiedCommentBody = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/pulls/77/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/77")) return Response.json({ number: 77, title: "Held PR", state: "open", user: { login: "contributor" }, head: { sha: "a77" }, labels: [{ name: "manual-review" }], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/a77/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a77/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/issues/77/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/77/comments")) { unifiedCommentBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? unifiedCommentBody); return Response.json({ id: 1 }, { status: 201 }); }
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await processJob(env, { type: "agent-regate-pr", deliveryId: "impact-map-frozen-reuse", repoFullName: "JSONbored/gittensory", prNumber: 77, installationId: 123 });

    expect(aiCalls).toBe(0); // frozen ⇒ reused, no fresh AI
    expect(unifiedCommentBody).toContain("gittensory-pr-panel"); // the unified panel rendered from the frozen review
    expect(unifiedCommentBody).not.toContain("Impact map"); // ...with no impact-map section (reused review has none)
  });

  // #1962: with BOTH the operator flag and the manifest opt-in on, the review emits a "Fix handoff" collapsible —
  // one machine-readable block per inline finding a contributor's own local agent can consume — in the unified
  // comment. Flag-OFF (every other review test) ⇒ no such section.
  it("emits the Fix handoff collapsible in the unified comment when review.fixHandoff + the operator flag are on", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_UNIFIED_COMMENT: "1",
      LOOPOVER_REVIEW_INLINE_COMMENTS: "true",
      LOOPOVER_REVIEW_FIX_HANDOFF: "true",
      LOOPOVER_REVIEW_REPOS: "JSONbored/gittensory",
      AI: {
        run: async () =>
          ({
            response: JSON.stringify({
              assessment: "One real issue.",
              blockers: [],
              nits: [],
              suggestions: [],
              inlineFindings: [
                { path: "src/db.ts", line: 2, severity: "blocker", body: "This query is vulnerable to SQL injection.", suggestion: "Use a parameterized query." },
              ],
            }),
          }) as { response: string },
      } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", commentMode: "all_prs", publicSurface: "comment_only", autoLabelEnabled: false, checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "block", gatePack: "oss-anti-slop" });
    let unifiedCommentBody = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url === "https://raw.githubusercontent.com/JSONbored/gittensory/HEAD/.loopover.yml") {
        // NOTE: the manifest key is camelCase `fixHandoff` (unlike snake-case `finding_categories`) — see focus-manifest parse.
        return new Response("review:\n  inline_comments: true\n  fixHandoff: true\n");
      }
      // Real GitHub raw-content 404s for every other manifest candidate -- without this, Response.json({}) below would 200 the first candidate
      // tried and mask the inline_comments/fixHandoff config crafted above.
      if (url.startsWith("https://raw.githubusercontent.com/")) return new Response("not found", { status: 404 });
      if (url.includes("/pulls/9/files"))
        return Response.json([{ filename: "src/db.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@ -1,1 +1,2 @@\n ctx\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/9")) return Response.json({ number: 9, title: "Add query helper", state: "open", user: { login: "contributor" }, head: { sha: "a9" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/a9/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a9/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      if (url.endsWith("/pulls/9/reviews") && method === "POST") return Response.json({ id: 55 });
      if (url.includes("/issues/9/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/9/comments") && method === "POST") {
        unifiedCommentBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1 }, { status: 201 });
      }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-fix-handoff",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 9, title: "Add query helper", state: "open", user: { login: "contributor" }, head: { sha: "a9" }, labels: [], body: "Closes #1" },
      },
    });

    expect(unifiedCommentBody).toContain("Fix handoff"); // the collapsible section is emitted
    expect(unifiedCommentBody).toContain("Fix handoff — Blocker at `src/db.ts:2`"); // the per-finding block header + location anchor
    expect(unifiedCommentBody).toContain("This query is vulnerable to SQL injection."); // the finding, handed off verbatim
    expect(unifiedCommentBody).toContain("Suggested change:"); // its suggestion carried through
  });

  // FIX B + FIX D3 at the processor call site: a unified comment for a PR whose CI has a FAILED check, with the
  // PR's files only available from GitHub (stored rows empty) — proves (B) the inline file fetch populates the
  // real diff/changed-file count on the first review, and (D3) the failing check name + its per-check WHY render
  // under a "CI checks failing" section (not just a bare "CI failing" chip).
  it("inline-fetches the PR files and renders failing CI check names + reasons in the unified comment (FIX B + D3)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITHUB_PUBLIC_TOKEN: "public-token", LOOPOVER_REVIEW_UNIFIED_COMMENT: "1" });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      reviewCheckMode: "required",
      backfillEnabled: true,
    });
    // Seed a FAILED check summary with a per-check WHY (codecov-style) so listCheckSummaries returns it and the
    // unified site populates failingDetails. (The PR row + headSha must match for the check to associate.)
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 3,
      title: "Fix webhook duplicate delivery again",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "unified123" },
      labels: [{ name: "bug" }],
      body: "Fixes #1\n\nValidation: npm test",
    });
    await upsertCheckSummary(env, {
      id: "JSONbored/gittensory#unified123#codecov/patch",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 3,
      headSha: "unified123",
      name: "codecov/patch",
      status: "completed",
      conclusion: "failure",
      detailsUrl: "https://codecov.io/report",
      payload: { output: { summary: "60% of diff hit (target 97%)" } },
    });
    let postedBody = "";
    let filesFetched = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          {
            uid: 7,
            githubUsername: "oktofeesh1",
            githubId: "123",
            totalPrs: 4,
            totalMergedPrs: 3,
            totalOpenPrs: 1,
            totalClosedPrs: 0,
            totalOpenIssues: 0,
            totalClosedIssues: 0,
            totalSolvedIssues: 0,
            totalValidSolvedIssues: 0,
            isEligible: true,
            credibility: 1,
            eligibleRepoCount: 1,
            hotkey: "must-not-leak",
          },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({
          repositories: [
            {
              repositoryFullName: "JSONbored/gittensory",
              totalPrs: "4",
              totalMergedPrs: "3",
              totalOpenPrs: "1",
              totalClosedPrs: "0",
              totalOpenIssues: "0",
              totalClosedIssues: "0",
              isEligible: true,
              credibility: "1.000000",
            },
          ],
        });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // FIX B: stored pull_request_files is empty, so the review path inline-fetches from GitHub here.
      if (url.includes("/pulls/3/files")) {
        filesFetched += 1;
        return Response.json([{ filename: "src/cache.ts", additions: 5, deletions: 1, status: "modified", patch: "@@\n+const x = 1;" }]);
      }
      // The review path now reads the LIVE CI aggregate (check-runs + commit-statuses). codecov/patch is a
      // classic COMMIT-STATUS (not a check-run), so it comes from the combined-status endpoint; the check-runs
      // list stays empty (it must, so the gate's own check-run upsert finds no pre-existing run to PATCH).
      if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/") && url.includes("/status"))
        return Response.json({ state: "failure", statuses: [{ context: "codecov/patch", state: "failure", description: "60% of diff hit (target 97%)", target_url: "https://codecov.io/report" }] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 902 }, { status: 201 });
      if (url.includes("/check-runs/902") && method === "PATCH") return Response.json({ id: 902 });
      if (url.includes("/issues/3/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/3/comments") && method === "POST") {
        postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-unified-ci-failing",
      eventName: "pull_request",
      payload: {
        action: "synchronize",
        installation: {
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: { metadata: "read", pull_requests: "read", issues: "write", checks: "write" },
          events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
        },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 3,
          title: "Fix webhook duplicate delivery again",
          state: "open",
          user: { login: "oktofeesh1" },
          head: { sha: "unified123" },
          labels: [{ name: "bug" }],
          body: "Fixes #1\n\nValidation: npm test",
        },
      },
    });

    // FIX B: the files were fetched inline from GitHub (stored rows were empty) and the changed-file count is real.
    expect(filesFetched).toBeGreaterThan(0);
    expect(postedBody).toContain("`1 file`");
    // FIX D3: the failing check name + its WHY render under a "CI checks failing" section, plus the chip.
    expect(postedBody).toContain("`CI failing`");
    expect(postedBody).toContain("CI checks failing");
    expect(postedBody).toContain("codecov/patch");
    expect(postedBody).toContain("60% of diff hit (target 97%)");
    // Still public-safe.
    expect(postedBody).not.toMatch(/wallet|hotkey|reward|trust score/i);
  });

  // REGRESSION (#4414-class advisory holds): a third-party app's COMPLETED action_required check-run that is
  // NOT a branch-protection required context (e.g. Superagent's "Contributor trust", posted alongside its own
  // separate, actually-required "Superagent Security Scan") must never flip ciState to "failed" or post under
  // "CI checks failing" -- that auto-closes real contributor PRs (#4414's regression). It must still be VISIBLE,
  // under its own non-blocking "Flagged checks" section, so a maintainer can act on it without the PR being
  // silently waved through OR silently closed.
  it("REGRESSION (#4414-class advisory holds): a non-required third-party action_required check renders as a non-blocking 'Flagged checks' note, not a CI failure", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITHUB_PUBLIC_TOKEN: "public-token", LOOPOVER_REVIEW_UNIFIED_COMMENT: "1" });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      reviewCheckMode: "required",
      backfillEnabled: true,
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 6,
      title: "Fix flaky retry test",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "flagged456" },
      base: { ref: "main" },
      labels: [{ name: "bug" }],
      body: "Fixes #1\n\nValidation: npm test",
    });
    let postedBody = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          {
            uid: 7,
            githubUsername: "oktofeesh1",
            githubId: "123",
            totalPrs: 4,
            totalMergedPrs: 3,
            totalOpenPrs: 1,
            totalClosedPrs: 0,
            totalOpenIssues: 0,
            totalClosedIssues: 0,
            totalSolvedIssues: 0,
            totalValidSolvedIssues: 0,
            isEligible: true,
            credibility: 1,
            eligibleRepoCount: 1,
            hotkey: "must-not-leak",
          },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({
          repositories: [
            {
              repositoryFullName: "JSONbored/gittensory",
              totalPrs: "4",
              totalMergedPrs: "3",
              totalOpenPrs: "1",
              totalClosedPrs: "0",
              totalOpenIssues: "0",
              totalClosedIssues: "0",
              isEligible: true,
              credibility: "1.000000",
            },
          ],
        });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/6/files")) return Response.json([{ filename: "src/retry.ts", additions: 3, deletions: 1, status: "modified", patch: "@@\n+const x = 1;" }]);
      // Branch protection requires ONLY "validate" + "Superagent Security Scan" -- NOT "Contributor trust",
      // matching the real-world JSONbored/gittensory config that #4414 broke.
      if (url.includes("/branches/main/protection/required_status_checks")) return Response.json({ contexts: ["validate", "Superagent Security Scan"] });
      if (url.includes("/check-runs") && method === "GET") {
        return Response.json({
          total_count: 3,
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
      if (url.includes("/commits/") && url.includes("/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 903 }, { status: 201 });
      if (url.includes("/check-runs/903") && method === "PATCH") return Response.json({ id: 903 });
      if (url.includes("/issues/6/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/6/comments") && method === "POST") {
        postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-flagged-nonrequired-check",
      eventName: "pull_request",
      payload: {
        action: "synchronize",
        installation: {
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: { metadata: "read", pull_requests: "read", issues: "write", checks: "write" },
          events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
        },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 6,
          title: "Fix flaky retry test",
          state: "open",
          user: { login: "oktofeesh1" },
          head: { sha: "flagged456" },
          base: { ref: "main" },
          labels: [{ name: "bug" }],
          body: "Fixes #1\n\nValidation: npm test",
        },
      },
    });

    // Never a CI failure -- the non-required check must not flip ciState/block the PR.
    expect(postedBody).not.toContain("`CI failing`");
    expect(postedBody).not.toContain("CI checks failing");
    // But never silently invisible either -- surfaced as its own non-blocking note, with its per-check WHY.
    expect(postedBody).toContain("Flagged checks (non-blocking)");
    expect(postedBody).toContain("Contributor trust");
    expect(postedBody).toContain("Manual review needed");
    expect(postedBody).not.toMatch(/wallet|hotkey|reward|trust score/i);
  });

  it("REGRESSION (#4414-class advisory holds): a bare non-required action_required check (no output/details_url) still renders under 'Flagged checks', name-only", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITHUB_PUBLIC_TOKEN: "public-token", LOOPOVER_REVIEW_UNIFIED_COMMENT: "1" });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicAudienceMode: "gittensor_only",
      publicSignalLevel: "standard",
      publicSurface: "comment_and_label",
      autoLabelEnabled: false,
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      reviewCheckMode: "required",
      backfillEnabled: true,
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 7,
      title: "Bump lockfile",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "flagged457" },
      base: { ref: "main" },
      labels: [{ name: "bug" }],
      body: "Fixes #1\n\nValidation: npm test",
    });
    let postedBody = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          { uid: 7, githubUsername: "oktofeesh1", githubId: "123", totalPrs: 4, totalMergedPrs: 3, totalOpenPrs: 1, totalClosedPrs: 0, totalOpenIssues: 0, totalClosedIssues: 0, totalSolvedIssues: 0, totalValidSolvedIssues: 0, isEligible: true, credibility: 1, eligibleRepoCount: 1, hotkey: "must-not-leak" },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({ repositories: [{ repositoryFullName: "JSONbored/gittensory", totalPrs: "4", totalMergedPrs: "3", totalOpenPrs: "1", totalClosedPrs: "0", totalOpenIssues: "0", totalClosedIssues: "0", isEligible: true, credibility: "1.000000" }] });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "package-lock.json", additions: 2, deletions: 2, status: "modified", patch: "@@\n+1" }]);
      if (url.includes("/branches/main/protection/required_status_checks")) return Response.json({ contexts: ["validate", "Superagent Security Scan"] });
      if (url.includes("/check-runs") && method === "GET") {
        return Response.json({
          total_count: 3,
          check_runs: [
            { name: "validate", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
            { name: "Superagent Security Scan", status: "completed", conclusion: "success", app: { slug: "superagent-security" } },
            // Bare: no output, no details_url -- the common real-world shape for a check-run with nothing to say.
            { name: "Contributor trust", status: "completed", conclusion: "action_required", app: { slug: "superagent-security" } },
          ],
        });
      }
      if (url.includes("/commits/") && url.includes("/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 904 }, { status: 201 });
      if (url.includes("/check-runs/904") && method === "PATCH") return Response.json({ id: 904 });
      if (url.includes("/issues/7/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/7/comments") && method === "POST") {
        postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1, html_url: "https://github.com/comment/1" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-flagged-nonrequired-check-bare",
      eventName: "pull_request",
      payload: {
        action: "synchronize",
        installation: {
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: { metadata: "read", pull_requests: "read", issues: "write", checks: "write" },
          events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
        },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 7,
          title: "Bump lockfile",
          state: "open",
          user: { login: "oktofeesh1" },
          head: { sha: "flagged457" },
          base: { ref: "main" },
          labels: [{ name: "bug" }],
          body: "Fixes #1\n\nValidation: npm test",
        },
      },
    });

    expect(postedBody).not.toContain("CI checks failing");
    expect(postedBody).toContain("Flagged checks (non-blocking)");
    expect(postedBody).toContain("- Contributor trust");
  });

  it("skips bots and maintainer authors, and keeps explicitly enabled checks minimal", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "enabled",
    });
    const calls = { minerList: 0, checks: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([{ githubUsername: "oktofeesh1", githubId: "123", hotkey: "must-not-cache", totalPrs: 1, totalMergedPrs: 1, isEligible: true, credibility: 1 }]);
      }
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1" });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/abc123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { output?: { title?: string; text?: string } };
        expect(body.output?.text).toBe("No detailed findings are published in check runs.");
        calls.checks += 1;
        return Response.json({ id: 99 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });
    const basePayload = {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
    };

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "bot-skip",
      eventName: "pull_request",
      payload: {
        action: "opened",
        ...basePayload,
        pull_request: { number: 20, title: "Dependency update", state: "open", user: { login: "renovate[bot]", type: "Bot" }, labels: [], body: "" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "maintainer-skip",
      eventName: "pull_request",
      payload: {
        action: "opened",
        ...basePayload,
        pull_request: { number: 21, title: "Maintainer work", state: "open", user: { login: "jsonbored" }, author_association: "OWNER", labels: [], body: "" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "check-enabled",
      eventName: "pull_request",
      payload: {
        action: "opened",
        ...basePayload,
        pull_request: { number: 22, title: "Miner work", state: "open", user: { login: "oktofeesh1" }, head: { sha: "abc123" }, labels: [], body: "No issue needed." },
      },
    });

    expect(calls).toEqual({ minerList: 1, checks: 1 });
    const skipped = await env.DB.prepare("select detail from audit_events where event_type = ? order by created_at").bind("github_app.pr_visibility_skipped").all<{
      detail: string;
    }>();
    expect(skipped.results.map((event) => event.detail)).toEqual(expect.arrayContaining(["bot_author", "maintainer_author"]));
  });

  it("audits advisory context check permission failures without blocking webhook processing", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "enabled",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.endsWith("/users/contributor")) return Response.json({ login: "contributor" });
      if (url.includes("/users/contributor/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/context403/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs")) return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "context-permission-missing",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
        pull_request: { number: 24, title: "Context check", state: "open", user: { login: "contributor" }, head: { sha: "context403" }, labels: [], body: "No issue needed." },
      },
    });

    const audit = await env.DB.prepare("select event_type, actor, target_key, outcome, detail from audit_events where event_type = ?")
      .bind("github_app.check_run_permission_missing")
      .first<{ event_type: string; actor: string; target_key: string; outcome: string; detail: string }>();

    expect(audit).toMatchObject({
      event_type: "github_app.check_run_permission_missing",
      actor: "contributor",
      target_key: "JSONbored/gittensory#24",
      outcome: "error",
    });
    expect(audit?.detail).toMatch(/Checks: write permission is missing/i);
  });

  it("audits advisory context check publish failures AND retries the job (GitHub 5xx is transient, GITTENSORY-5)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "enabled",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.endsWith("/users/contributor")) return Response.json({ login: "contributor" });
      if (url.includes("/users/contributor/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/context500/check-runs")) return new Response("GitHub check API failed", { status: 500 });
      return new Response("not found", { status: 404 });
    });
    const captureSpy = vi.spyOn(sentryModule, "captureReviewFailure");

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "context-check-failure",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
          pull_request: { number: 25, title: "Context check", state: "open", user: { login: "contributor" }, head: { sha: "context500" }, labels: [], body: "No issue needed." },
        },
      }),
    ).rejects.toMatchObject({ retryKind: "public_surface_publish_transient" });

    const outputFailure = await env.DB.prepare("select event_type, detail from audit_events where event_type = ?")
      .bind("github_app.pr_check_run_publish_failed")
      .first<{ event_type: string; detail: string }>();
    expect(outputFailure).toMatchObject({ event_type: "github_app.pr_check_run_publish_failed" });
    expect(outputFailure?.detail).toMatch(/GitHub check API failed|failed/i);
    const aggregate = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = ?")
      .bind("github_app.pr_public_surface_failed")
      .first<{ detail: string; metadata_json: string }>();
    expect(aggregate).toMatchObject({ detail: "check_run" });
    expect(aggregate?.metadata_json).toContain('"output":"check_run"');
    expect(aggregate?.metadata_json).toContain('"transient":true');
    // The total publish failure (nothing reached the PR) escalates to Sentry at error level, not just the ledger —
    // this still fires BEFORE the retryable throw, so the failure stays observable even though the job also retries.
    expect(captureSpy).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ kind: "publish", repo: "JSONbored/gittensory" }), "pr_public_surface_publish_failed");
    captureSpy.mockRestore();
  });

  it("audits disabled public-surface skips without miner lookup", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
    });
    const calls = { fetch: 0, repoWideReads: 0 };
    const originalDb = env.DB;
    env.DB = new Proxy(originalDb, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          if (/from\s+["`]?issues["`]?/i.test(sql) || /from\s+["`]?bounties["`]?/i.test(sql)) calls.repoWideReads += 1;
          return target.prepare(sql);
        };
      },
    }) as D1Database;
    vi.stubGlobal("fetch", async () => {
      calls.fetch += 1;
      return new Response("unexpected fetch", { status: 500 });
    });

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", {});
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "surface-off-skip",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
        pull_request: { number: 23, title: "Quiet repo work", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "" },
      },
    });

    expect(calls).toEqual({ fetch: 0, repoWideReads: 0 });
    const skipped = await env.DB.prepare("select actor, target_key, detail, metadata_json from audit_events where event_type = ?").bind("github_app.pr_visibility_skipped").all<{
      actor: string;
      target_key: string;
      detail: string;
      metadata_json: string;
    }>();
    expect(skipped.results).toEqual([
      expect.objectContaining({
        actor: "oktofeesh1",
        target_key: "JSONbored/gittensory#23",
        detail: "surface_off",
      }),
    ]);
    expect(JSON.stringify(skipped.results)).not.toMatch(/wallet|hotkey|raw trust|installation-token/i);
  });

  it("records public comment failure without blocking the context check", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicSurface: "comment_only",
      autoLabelEnabled: true,
      createMissingLabel: true,
      checkRunMode: "enabled",
      checkRunDetailLevel: "standard",
    });
    const calls = { checks: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([{ githubUsername: "oktofeesh1", githubId: "123", totalPrs: 2, totalMergedPrs: 2, isEligible: true, credibility: 1 }]);
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1" });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/abc123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") {
        calls.checks += 1;
        return Response.json({ id: 42, html_url: "https://github.com/checks/42" }, { status: 201 });
      }
      if (url.includes("/issues/30/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/30/comments") && method === "POST") return new Response("comment failed", { status: 503 });
      return new Response("not found", { status: 404 });
    });

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "comment-failure",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
          pull_request: { number: 30, title: "Miner work", state: "open", head: { sha: "abc123", ref: "feature" }, user: { login: "oktofeesh1" }, labels: [], body: "Fixes #1" },
        },
      }),
    ).resolves.toBeUndefined();

    expect(calls.checks).toBe(1);
    const webhook = await env.DB.prepare("select status from webhook_events where delivery_id = ?").bind("comment-failure").first<{ status: string }>();
    expect(webhook?.status).toBe("processed");
    const outputFailures = await env.DB.prepare("select event_type, detail from audit_events where target_key = ? and outcome = ? order by event_type")
      .bind("JSONbored/gittensory#30", "error")
      .all<{ event_type: string; detail: string }>();
    expect(outputFailures.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "github_app.pr_comment_publish_failed",
          detail: "comment failed",
        }),
      ]),
    );
    const published = await env.DB.prepare("select metadata_json from audit_events where event_type = ?").bind("github_app.pr_public_surface_published").first<{ metadata_json: string }>();
    expect(published?.metadata_json).toContain('"publishedOutputs":["check_run"]');
    expect(published?.metadata_json).toContain('"output":"comment"');
  });

  it("records an aggregate public-surface failure when no configured output publishes (permanent failure, no retry)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicSurface: "comment_only",
      checkRunMode: "off",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([{ githubUsername: "oktofeesh1", githubId: "123", totalPrs: 2, totalMergedPrs: 2, isEligible: true, credibility: 1 }]);
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1" });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/31/comments") && method === "GET") return Response.json([]);
      // A 403 with no rate-limit signal (permissions revoked, not a burst limit) is PERMANENT: retrying forever
      // would never converge, so this must keep today's swallow-and-audit behavior, not throw a retryable error.
      if (url.includes("/issues/31/comments") && method === "POST") return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
      return new Response("not found", { status: 404 });
    });

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "all-public-outputs-failed",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
          pull_request: { number: 31, title: "Miner work", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "Fixes #1" },
        },
      }),
    ).resolves.toBeUndefined();

    const aggregate = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = ?")
      .bind("github_app.pr_public_surface_failed")
      .first<{ detail: string; metadata_json: string }>();
    expect(aggregate).toMatchObject({ detail: "comment" });
    expect(aggregate?.metadata_json).toContain('"output":"comment"');
    expect(aggregate?.metadata_json).toContain('"transient":false');
    const published = await env.DB.prepare("select event_type from audit_events where event_type = ?").bind("github_app.pr_public_surface_published").all();
    expect(published.results).toEqual([]);
    const webhookRow = await env.DB.prepare("select status from webhook_events where delivery_id = ?").bind("all-public-outputs-failed").first<{ status: string }>();
    expect(webhookRow?.status).toBe("processed");
  });

  it("retries the whole job when a transient GitHub 5xx drops every public-surface output (GITTENSORY-5)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicSurface: "comment_only",
      checkRunMode: "off",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([{ githubUsername: "oktofeesh1", githubId: "123", totalPrs: 2, totalMergedPrs: 2, isEligible: true, credibility: 1 }]);
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1" });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/32/comments") && method === "GET") return Response.json([]);
      // GitHub 5xx during publish: momentary, not the caller's fault — the job must retry, not silently drop the
      // review the same way JSONbored/awesome-claude#4251 did (Sentry GITTENSORY-5).
      if (url.includes("/issues/32/comments") && method === "POST") return new Response("upstream unavailable", { status: 502 });
      return new Response("not found", { status: 404 });
    });

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "transient-publish-failure",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
          pull_request: { number: 32, title: "Miner work", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "Fixes #1" },
        },
      }),
    ).rejects.toMatchObject({ retryKind: "public_surface_publish_transient" });

    // The failure IS still audited (observability doesn't regress) — it just also throws so the queue retries.
    const aggregate = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = ?")
      .bind("github_app.pr_public_surface_failed")
      .first<{ detail: string; metadata_json: string }>();
    expect(aggregate).toMatchObject({ detail: "comment" });
    expect(aggregate?.metadata_json).toContain('"transient":true');
    const published = await env.DB.prepare("select event_type from audit_events where event_type = ?").bind("github_app.pr_public_surface_published").all();
    expect(published.results).toEqual([]);
    // The webhook row is marked "error", not "processed" — a thrown job is exactly what lets the queue retry it.
    const webhookRow = await env.DB.prepare("select status from webhook_events where delivery_id = ?").bind("transient-publish-failure").first<{ status: string }>();
    expect(webhookRow?.status).toBe("error");
  });

  it("leaves a fully successful public-surface publish unaffected by the transient-retry check", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicSurface: "comment_only",
      checkRunMode: "off",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([{ githubUsername: "oktofeesh1", githubId: "123", totalPrs: 2, totalMergedPrs: 2, isEligible: true, credibility: 1 }]);
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1" });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/33/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/33/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "public-surface-clean-publish",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
          pull_request: { number: 33, title: "Miner work", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "Fixes #1" },
        },
      }),
    ).resolves.toBeUndefined();

    const webhookRow = await env.DB.prepare("select status from webhook_events where delivery_id = ?").bind("public-surface-clean-publish").first<{ status: string }>();
    expect(webhookRow?.status).toBe("processed");
    const failed = await env.DB.prepare("select event_type from audit_events where event_type = ?").bind("github_app.pr_public_surface_failed").all();
    expect(failed.results).toEqual([]);
    const published = await env.DB.prepare("select metadata_json from audit_events where event_type = ?").bind("github_app.pr_public_surface_published").first<{ metadata_json: string }>();
    expect(published?.metadata_json).toContain('"publishedOutputs":["comment"]');
    expect(published?.metadata_json).toContain('"failedOutputs":[]');
  });

  it("keeps repository and PR webhook processing internal when installation context is absent", async () => {
    const env = createTestEnv();
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "repositories-without-installation",
      eventName: "repository",
      payload: {
        action: "created",
        repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } }],
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pr-without-installation",
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
        pull_request: { number: 44, title: "Internal-only PR", state: "open", user: { login: "oktofeesh1" }, labels: [] },
      },
    });

    expect(await listPullRequests(env, "JSONbored/gittensory")).toEqual(expect.arrayContaining([expect.objectContaining({ number: 44, body: null })]));
    const events = await env.DB.prepare("select delivery_id, status from webhook_events where delivery_id in (?, ?) order by delivery_id")
      .bind("pr-without-installation", "repositories-without-installation")
      .all<{ delivery_id: string; status: string }>();
    expect(events.results).toEqual([
      { delivery_id: "pr-without-installation", status: "processed" },
      { delivery_id: "repositories-without-installation", status: "processed" },
    ]);
  });

  it("uses cached confirmed miner detection for label-only public surfaces", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicSurface: "label_only",
      autoLabelEnabled: true,
      createMissingLabel: false,
      checkRunMode: "off",
    });
    const calls = { comments: 0, labels: 0, minerList: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([{ githubUsername: "oktofeesh1", githubId: "123", totalPrs: 1, totalMergedPrs: 1, isEligible: true, credibility: 1 }]);
      }
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1" });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/comments")) {
        calls.comments += 1;
        return Response.json([]);
      }
      if (url.includes("/labels") && method === "GET") return Response.json([]);
      if (url.includes("/labels") && method === "POST") {
        calls.labels += 1;
        return Response.json([{ name: "gittensor" }]);
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "label-only",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
        pull_request: { number: 45, title: "Miner label-only work", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "Fixes #1" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "label-only-cached",
      eventName: "pull_request",
      payload: {
        action: "synchronize",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
        pull_request: { number: 46, title: "Miner label-only follow-up", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "Fixes #1" },
      },
    });

    // 2 PRs × 3 label POSTs each: the gittensor context label (apply) + the per-PR TYPE label (create + apply).
    expect(calls).toEqual({ comments: 0, labels: 6, minerList: 1 });
    const cacheAudit = await env.DB.prepare("select event_type, detail from audit_events where actor = ? order by created_at")
      .bind("oktofeesh1")
      .all<{ event_type: string; detail: string | null }>();
    expect(cacheAudit.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "github_app.miner_detection_cache_miss", detail: "miss" }),
        expect.objectContaining({ event_type: "github_app.miner_detection_cache_hit", detail: "confirmed" }),
      ]),
    );
    const cached = await env.DB.prepare("select status from official_miner_detections where login = ?").bind("oktofeesh1").first<{ status: string }>();
    expect(cached?.status).toBe("confirmed");
    const snapshot = await env.DB.prepare("select snapshot_json from official_miner_detections where login = ?").bind("oktofeesh1").first<{ snapshot_json: string }>();
    expect(snapshot?.snapshot_json).not.toContain("must-not-cache");
  });

  it("records label-only public-surface failures without creating duplicate comments", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicSurface: "label_only",
      autoLabelEnabled: true,
      createMissingLabel: false,
      checkRunMode: "off",
    });
    const calls = { comments: 0, labels: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([{ githubUsername: "oktofeesh1", githubId: "123", totalPrs: 1, totalMergedPrs: 1, isEligible: true, credibility: 1 }]);
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1" });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/comments")) {
        calls.comments += 1;
        return Response.json([]);
      }
      if (url.includes("/labels") && method === "GET") return Response.json([]);
      if (url.includes("/labels") && method === "POST") {
        calls.labels += 1;
        // A permanent failure (permissions gap, not a momentary blip) — this test is about duplicate-comment
        // suppression on a label-only surface, not about retry classification, so it must stay non-transient.
        return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "label-failure",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
          pull_request: { number: 50, title: "Miner label work", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "Fixes #1" },
        },
      }),
    ).resolves.toBeUndefined();

    // gittensor context-label apply (fails 403, recorded) + the best-effort type-label create attempt (also 403,
    // swallowed). The context-label failure is still recorded below; the type label never drops the recording.
    expect(calls).toEqual({ comments: 0, labels: 2 });
    const outputFailure = await env.DB.prepare("select event_type, detail from audit_events where event_type = ?")
      .bind("github_app.pr_label_publish_failed")
      .first<{ event_type: string; detail: string }>();
    expect(outputFailure?.event_type).toBe("github_app.pr_label_publish_failed");
    expect(outputFailure?.detail).toMatch(/Resource not accessible by integration/);
    const aggregate = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = ?")
      .bind("github_app.pr_public_surface_failed")
      .first<{ detail: string; metadata_json: string }>();
    expect(aggregate).toMatchObject({ detail: "label" });
    expect(aggregate?.metadata_json).toContain('"output":"label"');
    const published = await env.DB.prepare("select event_type from audit_events where event_type = ?").bind("github_app.pr_public_surface_published").all();
    expect(published.results).toEqual([]);
  });

  it("keeps GitHub-history-only contributors quiet through not_found cache hits and expiry", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 9,
      title: "Historical merged work",
      state: "closed",
      merged_at: "2026-05-22T00:00:00.000Z",
      user: { login: "newbie" },
      author_association: "NONE",
      labels: [{ name: "feature" }],
      body: "Previously merged.",
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicAudienceMode: "gittensor_only",
      publicSurface: "comment_and_label",
      autoLabelEnabled: true,
      checkRunMode: "off",
    });
    const calls = { minerList: 0, publicOutput: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([]);
      }
      if (url.includes("/access_tokens") || url.includes("/comments") || url.includes("/labels")) {
        calls.publicOutput += 1;
        return Response.json({});
      }
      return new Response("not found", { status: 404 });
    });
    const basePayload = {
      action: "opened",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
    };

    for (const number of [47, 48]) {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: `not-found-cache-${number}`,
        eventName: "pull_request",
        payload: {
          ...basePayload,
          pull_request: { number, title: "Contributor work", state: "open", user: { login: "newbie" }, labels: [], body: "Fixes #1" },
        },
      });
    }
    await env.DB.prepare("update official_miner_detections set expires_at = ? where login = ?").bind("2000-01-01T00:00:00.000Z", "newbie").run();
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "not-found-cache-expired",
      eventName: "pull_request",
      payload: {
        ...basePayload,
        pull_request: { number: 49, title: "Contributor follow-up", state: "open", user: { login: "newbie" }, labels: [], body: "Fixes #1" },
      },
    });

    expect(calls).toEqual({ minerList: 2, publicOutput: 0 });
    const audit = await env.DB.prepare("select event_type, detail from audit_events where actor = ? order by created_at")
      .bind("newbie")
      .all<{ event_type: string; detail: string | null }>();
    expect(audit.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "github_app.miner_detection_cache_miss", detail: "miss" }),
        expect.objectContaining({ event_type: "github_app.miner_detection_cache_hit", detail: "not_found" }),
        expect.objectContaining({ event_type: "github_app.pr_visibility_skipped", detail: "not_official_gittensor_miner" }),
      ]),
    );
    const cached = await env.DB.prepare("select status from official_miner_detections where login = ?").bind("newbie").first<{ status: string }>();
    expect(cached?.status).toBe("not_found");
  });

  it("checks official miner status for detected-only comments before publishing public output", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicAudienceMode: "oss_maintainer",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 3,
      title: "Cached historical work",
      state: "closed",
      merged_at: "2026-05-20T00:00:00.000Z",
      user: { login: "confirmed-dev" },
      labels: [],
      body: "Historical cached PR.",
    });

    const calls = { minerList: 0, comments: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([
          { githubUsername: "confirmed-dev", githubId: "123", totalPrs: 2, totalMergedPrs: 1, isEligible: true, credibility: 1 },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/confirmed-dev")) return Response.json({ login: "confirmed-dev", public_repos: 1, followers: 0 });
      if (url.includes("/users/confirmed-dev/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/51/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/51/comments") && method === "POST") {
        calls.comments += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        expect(body.body).toContain("[Gittensor profile](https://gittensor.io/miners/details?githubId=123)");
        expect(body.body).toContain("2 PR(s)");
        expect(body.body).not.toContain("Cached prior PRs/issues");
        expect(body.body).not.toContain("api.gittensor.io/miners/123");
        return Response.json({ id: 51 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    const basePayload = {
      action: "opened",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
    };

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "detected-comment-confirmed",
      eventName: "pull_request",
      payload: {
        ...basePayload,
        pull_request: { number: 51, title: "Confirmed contributor work", state: "open", user: { login: "confirmed-dev" }, labels: [], body: "Fixes #1" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "detected-comment-not-found",
      eventName: "pull_request",
      payload: {
        ...basePayload,
        pull_request: { number: 52, title: "Unconfirmed contributor work", state: "open", user: { login: "newbie" }, labels: [], body: "Fixes #1" },
      },
    });

    expect(calls).toEqual({ minerList: 2, comments: 2 });
  });

  it("fails closed when official miner detection is unavailable", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      publicAudienceMode: "gittensor_only",
    });
    const payload = {
      action: "opened",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
      pull_request: {
        number: 10,
        title: "Check run failure path",
        state: "open",
        user: { login: "oktofeesh1" },
        head: { sha: "abc123" },
        labels: [],
        body: "Fixes #1",
      },
    };

    const calls = { minerList: 0 };
    vi.stubGlobal("fetch", async () => {
      calls.minerList += 1;
      return new Response("gittensor unavailable", { status: 503 });
    });

    await upsertRepoFocusManifest(env, "JSONbored/gittensory", {});
    await expect(processJob(env, { type: "github-webhook", deliveryId: "miner-unavailable", eventName: "pull_request", payload })).resolves.toBeUndefined();
    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "miner-unavailable-cached",
        eventName: "pull_request",
        payload: { ...payload, pull_request: { ...payload.pull_request, number: 11 } },
      }),
    ).resolves.toBeUndefined();
    expect(calls.minerList).toBe(1);
    const audit = await env.DB.prepare("select event_type, outcome, detail from audit_events where target_key = ?")
      .bind("JSONbored/gittensory#10")
      .all<{ event_type: string; outcome: string; detail: string }>();
    expect(audit.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "github_app.miner_detection_cache_miss", outcome: "completed", detail: "miss" }),
        expect.objectContaining({ event_type: "github_app.miner_detection_unavailable", outcome: "error", detail: expect.stringContaining("Gittensor API failed") }),
        expect.objectContaining({ event_type: "github_app.pr_visibility_skipped", outcome: "completed", detail: "miner_detection_unavailable" }),
      ]),
    );
    const cachedAudit = await env.DB.prepare("select event_type, outcome, detail from audit_events where target_key = ?")
      .bind("JSONbored/gittensory#11")
      .all<{ event_type: string; outcome: string; detail: string }>();
    expect(cachedAudit.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "github_app.miner_detection_cache_hit", outcome: "completed", detail: "unavailable" }),
        expect.objectContaining({ event_type: "github_app.miner_detection_unavailable", outcome: "error", detail: expect.stringContaining("Gittensor API failed") }),
        expect.objectContaining({ event_type: "github_app.pr_visibility_skipped", outcome: "completed", detail: "miner_detection_unavailable" }),
      ]),
    );
    const cached = await env.DB.prepare("select status from official_miner_detections where login = ?").bind("oktofeesh1").first<{ status: string }>();
    expect(cached?.status).toBe("unavailable");
  });

  it("recovers confirmed miners after the unavailable cache window expires", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "detected_contributors_only",
      publicSurface: "label_only",
      autoLabelEnabled: true,
      createMissingLabel: false,
      checkRunMode: "off",
    });
    let officialSource: "down" | "confirmed" = "down";
    const calls = { minerList: 0, labels: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        if (officialSource === "down") return new Response("gittensor unavailable", { status: 503 });
        return Response.json([{ githubUsername: "oktofeesh1", githubId: "123", hotkey: "must-not-cache", totalPrs: 1, totalMergedPrs: 1, isEligible: true, credibility: 1 }]);
      }
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1" });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/labels") && method === "GET") return Response.json([]);
      if (url.includes("/labels") && method === "POST") {
        calls.labels += 1;
        return Response.json([{ name: "gittensor" }]);
      }
      return new Response("not found", { status: 404 });
    });
    const basePayload = {
      action: "opened",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
    };

    for (const number of [12, 13]) {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: `miner-unavailable-recovery-${number}`,
        eventName: "pull_request",
        payload: {
          ...basePayload,
          pull_request: { number, title: "Miner recovery", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "Fixes #1" },
        },
      });
    }
    expect(calls).toEqual({ minerList: 1, labels: 0 });
    await env.DB.prepare("update official_miner_detections set expires_at = ? where login = ?").bind("2000-01-01T00:00:00.000Z", "oktofeesh1").run();
    officialSource = "confirmed";

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "miner-unavailable-recovered",
      eventName: "pull_request",
      payload: {
        ...basePayload,
        pull_request: { number: 14, title: "Miner recovery confirmed", state: "open", user: { login: "oktofeesh1" }, labels: [], body: "Fixes #1" },
      },
    });

    // 1 labeled PR × 3 label POSTs: the gittensor context label (apply) + the per-PR TYPE label (create + apply).
    expect(calls).toEqual({ minerList: 2, labels: 3 });
    const cached = await env.DB.prepare("select status, snapshot_json from official_miner_detections where login = ?")
      .bind("oktofeesh1")
      .first<{ status: string; snapshot_json: string }>();
    expect(cached?.status).toBe("confirmed");
    expect(cached?.snapshot_json).not.toMatch(/hotkey|wallet|coldkey|must-not-cache/i);
  });

  it("suppresses labels and comments when agentPaused is true", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      publicSurface: "comment_and_label",
      autoLabelEnabled: true,
      createMissingLabel: false,
      checkRunMode: "off",
      agentPaused: true,
    });
    const calls = { labels: 0, comments: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([{ githubUsername: "paused-miner", githubId: "999", totalPrs: 1, totalMergedPrs: 1, isEligible: true, credibility: 1 }]);
      if (url === "https://api.gittensor.io/miners/999") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/999/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/999/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/paused-miner")) return Response.json({ login: "paused-miner" });
      if (url.includes("/users/paused-miner/repos")) return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/labels") && method === "POST") {
        calls.labels += 1;
        return Response.json([{ name: "gittensor" }]);
      }
      if (url.includes("/comments") && method === "POST") {
        calls.comments += 1;
        return Response.json({ id: 1 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "paused-surface",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
        pull_request: { number: 88, title: "Paused repo PR", state: "open", user: { login: "paused-miner" }, labels: [], body: "Fixes #1" },
      },
    });

    // agentPaused suppresses ALL public surface mutations — no label, no comment.
    expect(calls).toEqual({ labels: 0, comments: 0 });
  });

  it("responds to authorized @gittensory mention commands with one public-safe comment", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 77,
      title: "Miner command context",
      state: "open",
      user: { login: "oktofeesh1" },
      author_association: "NONE",
      labels: [],
      body: "Fixes #1",
    });
    const calls = { commentsCreated: 0, token: 0, minerList: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([{ githubUsername: "oktofeesh1", githubId: "123", totalPrs: 3, totalMergedPrs: 2, isEligible: true, credibility: 1 }]);
      }
      if (url === "https://api.gittensor.io/miners/123") return Response.json({ repositories: [] });
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 3, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      // #788: Q&A commands now authorize by REAL repo permission. The "maintainer" commenter has maintain
      // access; everyone else has none and is authorized only as pr_author/confirmed_miner where applicable.
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "none" });
      if (url.includes("/issues/") && url.includes("/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/") && url.includes("/comments") && method === "POST") {
        calls.commentsCreated += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        expect(body.body).toContain("<!-- gittensory-pr-panel:v1 -->");
        expect(body.body).toContain("@gittensory");
        expect(body.body).not.toMatch(/wallet|hotkey|estimated score|reward estimate|payout|farming|raw trust score|private reviewability|reviewability internals|scoreability|public score estimate/i);
        return Response.json({ id: 1001 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-miner-context",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: {
          id: 1,
          body: "@gittensory miner-context",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-blockers",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: {
          id: 2,
          body: "@gittensory blockers",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-help",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: {
          id: 3,
          body: "@gittensory help",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-author-next-action",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: {
          id: 4,
          body: "@gittensory next-action",
          user: { login: "oktofeesh1", type: "User" },
          author_association: "NONE",
        },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-reviewability",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: {
          id: 5,
          body: "@gittensory reviewability",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-repo-fit",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: {
          id: 6,
          body: "@gittensory repo-fit",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-packet",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: {
          id: 7,
          body: "@gittensory packet",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-packet-no-cache",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 78, title: "Uncached PR command", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: {
          id: 8,
          body: "@gittensory packet",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });

    expect(calls.commentsCreated).toBe(8);
    // The installation token is cached + reused across all 8 commands (each previously minted 2 — permission
    // check + comment — for 16 total). Caching collapses them to a single mint, which is the rate-limit fix.
    expect(calls.token).toBe(1);
    expect(calls.minerList).toBeGreaterThanOrEqual(1);
    const audit = await env.DB.prepare("select event_type, detail from audit_events where target_key = ? order by created_at")
      .bind("JSONbored/gittensory#77")
      .all<{ event_type: string; detail: string | null }>();
    expect(audit.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "github_app.agent_command_replied" }),
        expect.objectContaining({ event_type: "github_app.miner_detection_cache_miss", detail: "miss" }),
        expect.objectContaining({ event_type: "github_app.miner_detection_cache_hit", detail: "confirmed" }),
      ]),
    );
    const usage = await env.DB.prepare("select payload_json from signal_snapshots where signal_type = ? and target_key = ? order by generated_at")
      .bind("github-agent-command-usage", "JSONbored/gittensory#77")
      .all<{ payload_json: string }>();
    const usagePayloads = usage.results.map((entry) => JSON.parse(entry.payload_json) as { command: string; outcome: string; actorKind: string; actorHash?: string });
    expect(usagePayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "reviewability", outcome: "replied", actorKind: "maintainer" }),
        expect.objectContaining({ command: "repo-fit", outcome: "replied", actorKind: "maintainer" }),
        expect.objectContaining({ command: "packet", outcome: "replied", actorKind: "maintainer" }),
      ]),
    );
    expect(usagePayloads.every((payload) => typeof payload.actorHash === "string" && /^[a-f0-9]{64}$/.test(payload.actorHash))).toBe(true);
    expect(JSON.stringify(usagePayloads)).not.toContain('"actor":');
    expect(JSON.stringify(usagePayloads)).not.toMatch(/wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate|@gittensory|oktofeesh1/i);
    const usageEvents = await listProductUsageEvents(env, { limit: 10 });
    expect(usageEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surface: "github_app", eventName: "agent_command_replied", outcome: "completed", repoFullName: "JSONbored/gittensory" }),
      ]),
    );
    expect(JSON.stringify(usageEvents)).not.toMatch(/wallet|hotkey|raw trust|deliveryId|installation-token/i);
  });

  it("a @gittensory Q&A mention command respects agentPaused — never posts the answer card live (#2258)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", agentPaused: true });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 77,
      title: "Paused Q&A context",
      state: "open",
      user: { login: "oktofeesh1" },
      author_association: "NONE",
      labels: [],
      body: "Fixes #1",
    });
    const calls = { commentPosts: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "maintain" });
      if (url.includes("/issues/") && url.includes("/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/") && url.includes("/comments") && method === "POST") {
        calls.commentPosts += 1;
        return Response.json({ id: 1001 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-help-paused",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 77, title: "Paused Q&A context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: { id: 1, body: "@gittensory help", user: { login: "maintainer", type: "User" }, author_association: "OWNER" },
      },
    });

    expect(calls.commentPosts).toBe(0); // the answer card must never post live on a paused repo
    // REGRESSION: a paused command must not be audited/usage-tracked as a real, completed reply.
    const replied = await env.DB.prepare("select id from audit_events where event_type = ?").bind("github_app.agent_command_replied").first<{ id: string }>();
    expect(replied).toBeUndefined();
    const skipped = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.agent_command_reply_skipped").first<{ outcome: string; detail: string }>();
    expect(skipped).toMatchObject({ outcome: "completed", detail: "agent_paused" });
    const usageEvents = await listProductUsageEvents(env, { limit: 10 });
    expect(usageEvents).toEqual(expect.arrayContaining([expect.objectContaining({ eventName: "agent_command_reply_skipped", outcome: "skipped" })]));
    expect(usageEvents.some((event) => event.eventName === "agent_command_replied")).toBe(false);
  });

  it("a @gittensory maintainer-digest command respects agentDryRun — records dry_run, not agent_paused (#2258)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", agentDryRun: true });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 78,
      title: "Dry-run digest context",
      state: "open",
      user: { login: "oktofeesh1" },
      author_association: "NONE",
      labels: [],
      body: "Fixes #1",
    });
    const calls = { commentPosts: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "maintain" });
      if (url.includes("/issues/") && url.includes("/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/") && url.includes("/comments") && method === "POST") {
        calls.commentPosts += 1;
        return Response.json({ id: 1002 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-queue-summary-dry-run",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 78, title: "Dry-run digest context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: { id: 2, body: "@gittensory queue-summary", user: { login: "maintainer", type: "User" }, author_association: "OWNER" },
      },
    });

    expect(calls.commentPosts).toBe(0); // the digest must never post live on a dry-run repo
    const skipped = await env.DB.prepare("select outcome, detail, metadata_json from audit_events where event_type = ?")
      .bind("github_app.agent_command_reply_skipped")
      .first<{ outcome: string; detail: string; metadata_json: string }>();
    expect(skipped).toMatchObject({ outcome: "completed", detail: "dry_run" });
    const usageEvents = await listProductUsageEvents(env, { limit: 10 });
    expect(usageEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ eventName: "agent_command_reply_skipped", outcome: "skipped", metadata: expect.objectContaining({ family: "queue_digest" }) })]),
    );
  });

  it("posts maintainer-only queue digest commands from cached public-safe metadata", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    delete (env as Partial<Env>).PUBLIC_SITE_ORIGIN;
    for (const issue of [
      { number: 1, title: "Ready linked fix" },
      { number: 2, title: "Overlap issue" },
    ]) {
      await upsertIssueFromGitHub(env, "JSONbored/gittensory", {
        number: issue.number,
        title: issue.title,
        state: "open",
        user: { login: "reporter" },
        labels: [],
        body: "",
      });
    }
    for (const pull of [
      { number: 90, title: "Ready linked fix", user: { login: "alice" }, body: "Fixes #1" },
      { number: 91, title: "Needs author context", user: { login: "bob" }, body: "" },
      { number: 92, title: "Overlap route first", user: { login: "carol" }, body: "Fixes #2" },
      { number: 93, title: "Overlap route second", user: { login: "dana" }, body: "Fixes #2" },
    ]) {
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        ...pull,
        state: "open",
        author_association: "NONE",
        labels: [],
      });
    }
    await upsertOfficialMinerDetection(env, "alice", { status: "confirmed", snapshot: queueMinerSnapshot("alice") }, 60_000);

    const calls = { commentsCreated: 0, token: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" }); // #788 real-permission auth
      if (url.includes("/issues/90/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/90/comments") && method === "POST") {
        calls.commentsCreated += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        expect(body.body).toContain("**Gittensory maintainer queue summary**");
        expect(body.body).toContain("Open PRs: 4");
        expect(body.body).toContain("confirmed-miner PRs: 1");
        expect(body.body).toContain("Authenticated control panel: https://loopover.ai/app?view=maintainer&repo=JSONbored%2Fgittensory");
        expect(body.body).not.toMatch(/wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate/i);
        return Response.json({ id: 1001 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "maintainer-queue-summary",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 90, title: "Ready linked fix", state: "open", pull_request: {}, user: { login: "alice" }, author_association: "NONE" },
        comment: {
          id: 9001,
          body: "@gittensory queue-summary",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });

    expect(calls).toEqual({ commentsCreated: 1, token: 1 }); // token cached + reused across the #788 permission check
    const audit = await env.DB.prepare("select event_type, detail, metadata_json from audit_events where target_key = ? order by created_at")
      .bind("JSONbored/gittensory#90")
      .all<{ event_type: string; detail: string | null; metadata_json: string }>();
    expect(audit.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "github_app.agent_command_replied" }),
        expect.objectContaining({ event_type: "github_app.agent_command_feedback_prompted", detail: "queue-summary" }),
      ]),
    );
    expect(audit.results.find((entry) => entry.event_type === "github_app.agent_command_feedback_prompted")?.metadata_json).toContain("maintainer_digest");
    const usage = await env.DB.prepare("select payload_json from signal_snapshots where signal_type = ? and target_key = ?")
      .bind("github-agent-command-usage", "JSONbored/gittensory#90")
      .all<{ payload_json: string }>();
    const usagePayload = JSON.parse(usage.results[0]?.payload_json ?? "{}") as { command?: string; outcome?: string; family?: string; actorHash?: string };
    expect(usagePayload).toEqual(expect.objectContaining({ command: "queue-summary", outcome: "replied", family: "maintainer_digest" }));
    expect(usagePayload.actorHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(usagePayload)).not.toContain('"actor":');
    const usageEvents = await listProductUsageEvents(env, { limit: 5 });
    expect(usageEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surface: "github_app", eventName: "agent_command_replied", outcome: "completed", metadata: expect.objectContaining({ family: "queue_digest" }) }),
      ]),
    );
  });

  it("omits the maintainer queue digest control-panel link when the public site origin is invalid", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), PUBLIC_SITE_ORIGIN: "not a url" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 94,
      title: "Ready linked fix",
      state: "open",
      author_association: "NONE",
      user: { login: "alice" },
      labels: [],
      body: "Fixes #1",
    });
    let commentBody = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" }); // #788 real-permission auth
      if (url.includes("/issues/94/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/94/comments") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        commentBody = body.body ?? "";
        return Response.json({ id: 1002 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "maintainer-queue-summary-invalid-origin",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 94, title: "Ready linked fix", state: "open", pull_request: {}, user: { login: "alice" }, author_association: "NONE" },
        comment: {
          id: 9002,
          body: "@gittensory queue-summary",
          user: { login: "maintainer", type: "User" },
          author_association: "OWNER",
        },
      },
    });

    expect(commentBody).toContain("**Gittensory maintainer queue summary**");
    expect(commentBody).not.toContain("Authenticated control panel:");
  });

  it("applies repo command authorization policy overrides during issue_comment handling", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commandAuthorization: { default: ["maintainer"], commands: { help: ["pr_author"] } },
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 91,
      title: "Author policy command",
      state: "open",
      user: { login: "driveby" },
      author_association: "NONE",
      labels: [],
      body: "Fixes #90",
    });

    const calls = { commentsCreated: 0, token: 0, minerList: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([]);
      }
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      // #788: "driveby" has no repo permission — authorized only as pr_author via the help-command override.
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "none" });
      if (url.includes("/issues/") && url.includes("/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/") && url.includes("/comments") && method === "POST") {
        calls.commentsCreated += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        expect(body.body).toContain("<!-- gittensory-pr-panel:v1 -->");
        expect(body.body).not.toMatch(/wallet|hotkey|estimated score|reward estimate|payout|farming|raw trust score|private reviewability|public score estimate/i);
        return Response.json({ id: 9191 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-policy-author",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 91, title: "Author policy command", state: "open", pull_request: {}, user: { login: "driveby" }, author_association: "NONE" },
        comment: {
          id: 191,
          body: "@gittensory help",
          user: { login: "driveby", type: "User" },
          author_association: "NONE",
        },
      },
    });

    expect(calls).toEqual({ commentsCreated: 1, token: 1, minerList: 0 }); // token cached + reused across the #788 permission check
    const audit = await env.DB.prepare("select event_type, detail from audit_events where target_key = ? order by created_at")
      .bind("JSONbored/gittensory#91")
      .all<{ event_type: string; detail: string | null }>();
    expect(audit.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "github_app.agent_command_replied", detail: null }),
        expect.objectContaining({ event_type: "github_app.agent_command_feedback_prompted", detail: "help" }),
      ]),
    );
    const usage = await env.DB.prepare("select payload_json from signal_snapshots where signal_type = ? and target_key = ?")
      .bind("github-agent-command-usage", "JSONbored/gittensory#91")
      .all<{ payload_json: string }>();
    expect(JSON.parse(usage.results[0]?.payload_json ?? "{}")).toMatchObject({ command: "help", outcome: "replied", actorKind: "author" });
  });

  it("records deduped @gittensory answer usefulness from authorized reactions only", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "maintainer" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 77,
      title: "Miner command context",
      state: "open",
      user: { login: "oktofeesh1" },
      author_association: "NONE",
    });
    await upsertOfficialMinerDetection(env, "oktofeesh1", { status: "confirmed", snapshot: queueMinerSnapshot("oktofeesh1") }, 60 * 60 * 1000);
    await upsertAgentCommandAnswer(env, commandAnswer("answer-maintainer", "preflight", { responseCommentId: 9001 }));
    await upsertAgentCommandAnswer(env, commandAnswer("answer-author", "next-action", { responseCommentId: 9002 }));
    await upsertAgentCommandAnswer(env, { ...commandAnswer("answer-no-author", "preflight", { responseCommentId: 9003 }), issueNumber: 78 });
    const basePayload = {
      action: "created",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
      issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
    };

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-1",
      eventName: "reaction",
      payload: {
        ...basePayload,
        comment: { id: 9001, body: commandAnswerBody("answer-maintainer", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 1, content: "+1", user: { login: "maintainer", type: "User" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-2",
      eventName: "reaction",
      payload: {
        ...basePayload,
        comment: { id: 9001, body: commandAnswerBody("answer-maintainer", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 2, content: "-1", user: { login: "maintainer", type: "User" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-3",
      eventName: "reaction",
      payload: {
        ...basePayload,
        comment: { id: 9002, body: commandAnswerBody("answer-author", "next-action"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 3, content: "+1", user: { login: "oktofeesh1", type: "User" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-4",
      eventName: "reaction",
      payload: {
        ...basePayload,
        comment: { id: 9002, body: commandAnswerBody("answer-author", "next-action"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 4, content: "+1", user: { login: "random", type: "User" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-5",
      eventName: "reaction",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 78, title: "No author", state: "open", pull_request: {}, author_association: "NONE" },
        comment: { id: 9003, body: commandAnswerBody("answer-no-author", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 5, content: "+1", user: { login: "random", type: "User" } },
      },
    });

    const summary = await getCommandUsefulnessSummary(env, { now: "2026-05-29T00:00:00.000Z", windowDays: 30 });
    expect(summary.totals).toMatchObject({ feedbackCount: 2, usefulCount: 1, notUsefulCount: 1, answerCount: 2, usefulnessRate: 0.5 });
    expect(summary.commands).toEqual([
      expect.objectContaining({ command: "next-action", feedbackCount: 1, usefulCount: 1 }),
      expect.objectContaining({ command: "preflight", feedbackCount: 1, notUsefulCount: 1 }),
    ]);
    const audit = await env.DB.prepare("select event_type, detail from audit_events where event_type like ? order by created_at")
      .bind("github_app.agent_command_feedback_%")
      .all<{ event_type: string; detail: string | null }>();
    expect(audit.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "github_app.agent_command_feedback_recorded" }),
        expect.objectContaining({ event_type: "github_app.agent_command_feedback_denied", detail: "not_maintainer_or_pr_author" }),
      ]),
    );
    const stored = await env.DB.prepare("select actor_hash, metadata_json from github_agent_command_feedback").all<{ actor_hash: string; metadata_json: string }>();
    expect(stored.results.map((row) => row.actor_hash).join("\n")).not.toMatch(/maintainer|oktofeesh1|random/);
    expect(stored.results.every((row) => row.actor_hash.startsWith("sha256:"))).toBe(true);
  });

  it("skips unsupported @gittensory feedback reactions without storing votes", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "maintainer" });
    await upsertAgentCommandAnswer(env, commandAnswer("answer-skip", "preflight", { responseCommentId: 9001 }));
    const basePayload = {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
      issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
    };

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-skip-1",
      eventName: "reaction",
      payload: {
        ...basePayload,
        action: "deleted",
        comment: { id: 9001, body: commandAnswerBody("answer-skip", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 1, content: "+1", user: { login: "maintainer", type: "User" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-skip-1b",
      eventName: "reaction",
      payload: {
        ...basePayload,
        comment: { id: 9001, body: commandAnswerBody("answer-skip", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 11, content: "+1", user: { login: "maintainer", type: "User" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-skip-2",
      eventName: "reaction",
      payload: {
        ...basePayload,
        action: "created",
        comment: { id: 9001, body: commandAnswerBody("answer-skip", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 2, content: "+1", user: { login: "helper[bot]", type: "Bot" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-skip-3",
      eventName: "reaction",
      payload: {
        ...basePayload,
        action: "created",
        comment: { id: 9001, body: commandAnswerBody("answer-missing", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
        reaction: { id: 3, content: "-1", user: { login: "maintainer", type: "User" } },
      },
    });

    await expect(getCommandUsefulnessSummary(env, { now: "2026-05-29T00:00:00.000Z", windowDays: 30 })).resolves.toMatchObject({
      totals: { feedbackCount: 0 },
      commands: [],
    });
    const skips = await env.DB.prepare("select detail from audit_events where event_type = ? order by detail")
      .bind("github_app.agent_command_feedback_skipped")
      .all<{ detail: string }>();
    expect(skips.results.map((row) => row.detail)).toEqual(["bot_reaction", "unknown_answer", "unsupported_reaction_action", "unsupported_reaction_action"]);
  });

  it("accepts repo-owner feedback through sender fallback and ignores non-vote reactions", async () => {
    const env = createTestEnv();
    await upsertAgentCommandAnswer(env, commandAnswer("answer-owner", "blockers"));
    const basePayload = {
      action: "created",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
      issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
      comment: { id: 9001, body: commandAnswerBody("answer-owner", "blockers"), user: { login: "gittensory[bot]", type: "Bot" } },
    };

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-owner-1",
      eventName: "reaction",
      payload: {
        ...basePayload,
        reaction: { content: "+1" },
        sender: { login: "JSONbored", type: "User" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-owner-2",
      eventName: "reaction",
      payload: {
        ...basePayload,
        reaction: { id: 2, content: "heart" },
        sender: { login: "JSONbored", type: "User" },
      },
    });

    const summary = await getCommandUsefulnessSummary(env, { now: "2026-05-29T00:00:00.000Z", windowDays: 30 });
    expect(summary.totals).toMatchObject({ feedbackCount: 1, usefulCount: 1, answerCount: 1 });
    expect(summary.commands).toEqual([expect.objectContaining({ command: "blockers", usefulnessRate: 1 })]);
  });

  it("rejects copied feedback markers that do not match the stored answer context", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "maintainer" });
    await upsertAgentCommandAnswer(env, commandAnswer("answer-bound", "preflight", { responseCommentId: 9001 }));
    const basePayload = {
      action: "created",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
      issue: { number: 77, title: "Miner command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
      reaction: { id: 1, content: "+1", user: { login: "maintainer", type: "User" } },
    };

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-bound-1",
      eventName: "reaction",
      payload: {
        ...basePayload,
        comment: { id: 9002, body: commandAnswerBody("answer-bound", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-bound-2",
      eventName: "reaction",
      payload: {
        ...basePayload,
        repository: { name: "other", full_name: "JSONbored/other", private: false, owner: { login: "JSONbored" } },
        comment: { id: 9001, body: commandAnswerBody("answer-bound", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "feedback-bound-3",
      eventName: "reaction",
      payload: {
        ...basePayload,
        issue: { ...basePayload.issue, number: 78 },
        comment: { id: 9001, body: commandAnswerBody("answer-bound", "preflight"), user: { login: "gittensory[bot]", type: "Bot" } },
      },
    });

    await expect(getCommandUsefulnessSummary(env, { now: "2026-05-29T00:00:00.000Z", windowDays: 30 })).resolves.toMatchObject({
      totals: { feedbackCount: 0 },
      commands: [],
    });
    const skips = await env.DB.prepare("select detail from audit_events where event_type = ? order by detail")
      .bind("github_app.agent_command_feedback_skipped")
      .all<{ detail: string }>();
    expect(skips.results.map((row) => row.detail)).toEqual(["answer_comment_mismatch", "answer_context_mismatch", "answer_context_mismatch"]);
  });

  it("records webhook errors when command replies fail before mutation", async () => {
    const env = createTestEnv();
    // Authorize via the confirmed-miner path (PR author + cached confirmed status), which does not depend on
    // the #788 real-permission check — that check swallows the invalid-repo error and would deny otherwise.
    await upsertOfficialMinerDetection(env, "oktofeesh1", { status: "confirmed", snapshot: queueMinerSnapshot("oktofeesh1") }, 60_000);
    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "agent-command-error",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "broken", full_name: "broken", private: false, owner: { login: "JSONbored" } },
          issue: { number: 77, title: "Broken command context", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
          comment: {
            id: 9,
            body: "@gittensory help",
            user: { login: "oktofeesh1", type: "User" },
            author_association: "NONE",
          },
        },
      }),
    ).rejects.toThrow("Invalid repository full name");

    const event = await env.DB.prepare("select status, error_summary from webhook_events where delivery_id = ?")
      .bind("agent-command-error")
      .first<{ status: string; error_summary: string }>();
    expect(event).toMatchObject({ status: "error", error_summary: expect.stringContaining("Invalid repository full name") });
  });

  it("skips unauthorized, bot, and non-PR @gittensory mention commands without public output", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    let commentCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/issues/")) {
        commentCalls += 1;
        return Response.json([]);
      }
      return new Response("not found", { status: 404 });
    });
    const basePayload = {
      action: "created",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
    };
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-none",
      eventName: "issue_comment",
      payload: {
        ...basePayload,
        issue: { number: 79, title: "No command", state: "open", pull_request: {}, user: { login: "reporter" } },
        comment: { id: 0, body: "plain comment", user: { login: "reporter", type: "User" }, author_association: "NONE" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-missing-fields",
      eventName: "issue_comment",
      payload: {
        action: "created",
        comment: { id: 9, body: "@gittensory preflight", user: { login: "reporter", type: "User" }, author_association: "NONE" },
      },
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-non-pr",
      eventName: "issue_comment",
      payload: {
        ...basePayload,
        issue: { number: 80, title: "Plain issue", state: "open", user: { login: "reporter" } },
        comment: { id: 1, body: "@gittensory preflight", user: { login: "reporter", type: "User" }, author_association: "NONE" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-bot",
      eventName: "issue_comment",
      payload: {
        ...basePayload,
        issue: { number: 81, title: "Bot PR", state: "open", pull_request: {}, user: { login: "renovate[bot]" } },
        comment: { id: 2, body: "@gittensory preflight", user: { login: "renovate[bot]", type: "Bot" }, author_association: "NONE" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-unauthorized",
      eventName: "issue_comment",
      payload: {
        ...basePayload,
        issue: { number: 82, title: "Unauthorized PR", state: "open", pull_request: {}, user: { login: "not-a-miner" }, author_association: "NONE" },
        comment: { id: 3, body: "@gittensory preflight", user: { login: "not-a-miner", type: "User" }, author_association: "NONE" },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-no-pr-author",
      eventName: "issue_comment",
      payload: {
        ...basePayload,
        issue: { number: 83, title: "Unknown author PR", state: "open", pull_request: {}, author_association: "NONE" },
        comment: { id: 4, body: "@gittensory preflight", user: { login: "commenter", type: "User" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-maintainer-only-denied",
      eventName: "issue_comment",
      payload: {
        ...basePayload,
        issue: { number: 84, title: "Maintainer digest PR", state: "open", pull_request: {}, user: { login: "not-a-miner" }, author_association: "NONE" },
        comment: { id: 5, body: "@gittensory queue-summary", user: { login: "not-a-miner", type: "User" }, author_association: "NONE" },
      },
    });

    expect(commentCalls).toBe(0);
    const skips = await env.DB.prepare("select detail from audit_events where event_type = ? order by detail")
      .bind("github_app.agent_command_skipped")
      .all<{ detail: string }>();
    expect(skips.results.map((entry) => entry.detail)).toEqual(expect.arrayContaining(["bot_author", "maintainer_command_requires_maintainer", "not_a_pull_request_thread", "pr_author_not_confirmed_miner"]));
    const usageEvents = await listProductUsageEvents(env, { limit: 10 });
    expect(usageEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surface: "github_app", eventName: "agent_command_skipped", outcome: "skipped" }),
      ]),
    );
    expect(JSON.stringify(usageEvents)).not.toMatch(/deliveryId|wallet|hotkey|raw trust/i);
  });

});
