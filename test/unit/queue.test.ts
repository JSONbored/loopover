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


  it("fans build-contributor-evidence out into per-batch jobs when the login set exceeds CONTRIBUTOR_EVIDENCE_BATCH_SIZE (#1941)", async () => {
    vi.stubEnv("CONTRIBUTOR_EVIDENCE_BATCH_SIZE", "1"); // force a fan-out at > 1 derived login
    const env = createTestEnv();
    // Two contributors via stored PRs with distinct authors → a derived login set of 2.
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 1, title: "PR one", state: "open", user: { login: "alice" }, head: { sha: "a1" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 2, title: "PR two", state: "open", user: { login: "bob" }, head: { sha: "b2" }, labels: [], body: "y" });

    const fanned: import("../../src/types").JobMessage[] = [];
    const send = env.JOBS.send.bind(env.JOBS);
    env.JOBS.send = (async (message: import("../../src/types").JobMessage, options?: QueueSendOptions) => {
      if (message.type === "build-contributor-evidence") fanned.push(message);
      return send(message, options);
    }) as typeof env.JOBS.send;

    await processJob(env, { type: "build-contributor-evidence", requestedBy: "schedule" });
    env.JOBS.send = send;

    // The scheduled trigger fanned out into one per-batch job per login (batch size 1), each carrying a `logins`
    // array — not a single giant inline job.
    expect(fanned).toHaveLength(2);
    const batched = fanned.flatMap((m) => (m as { logins?: string[] }).logins ?? []).sort();
    expect(batched).toEqual(["alice", "bob"]);
    expect(fanned.every((m) => Array.isArray((m as { logins?: string[] }).logins))).toBe(true);
  });

  it("reads CONTRIBUTOR_EVIDENCE_BATCH_SIZE, defaulting on unset / invalid / negative values", () => {
    expect(contributorEvidenceBatchSize()).toBe(150); // unset → default
    vi.stubEnv("CONTRIBUTOR_EVIDENCE_BATCH_SIZE", "40");
    expect(contributorEvidenceBatchSize()).toBe(40);
    vi.stubEnv("CONTRIBUTOR_EVIDENCE_BATCH_SIZE", "0");
    expect(contributorEvidenceBatchSize()).toBe(0); // 0 = disable fan-out
    vi.stubEnv("CONTRIBUTOR_EVIDENCE_BATCH_SIZE", "-5");
    expect(contributorEvidenceBatchSize()).toBe(150); // negative → default
    vi.stubEnv("CONTRIBUTOR_EVIDENCE_BATCH_SIZE", "not-a-number");
    expect(contributorEvidenceBatchSize()).toBe(150); // NaN → default
  });

  it("does NOT fan out when batching is disabled (CONTRIBUTOR_EVIDENCE_BATCH_SIZE=0) — the scheduled trigger stays one job (#1941)", async () => {
    vi.stubEnv("CONTRIBUTOR_EVIDENCE_BATCH_SIZE", "0");
    vi.stubGlobal("fetch", async () => Response.json({})); // inline path makes per-login + scoring reads; keep off-network
    const env = createTestEnv();
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 1, title: "PR one", state: "open", user: { login: "alice" }, head: { sha: "a1" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 2, title: "PR two", state: "open", user: { login: "bob" }, head: { sha: "b2" }, labels: [], body: "y" });
    const batches: import("../../src/types").JobMessage[] = [];
    const send = env.JOBS.send.bind(env.JOBS);
    env.JOBS.send = (async (message: import("../../src/types").JobMessage, options?: QueueSendOptions) => {
      if (message.type === "build-contributor-evidence" && Array.isArray((message as { logins?: string[] }).logins)) batches.push(message);
      return send(message, options);
    }) as typeof env.JOBS.send;
    await processJob(env, { type: "build-contributor-evidence", requestedBy: "schedule" });
    env.JOBS.send = send;
    expect(batches).toHaveLength(0); // never fanned out — processed inline
  });

  it("build-contributor-evidence is a no-op when there are no contributors (empty derived set) (#1941)", async () => {
    const env = createTestEnv();
    // No PRs/issues → no derived logins → the worker early-returns before loading aggregate data or making any read.
    await expect(processJob(env, { type: "build-contributor-evidence", requestedBy: "schedule" })).resolves.toBeUndefined();
  });

  it("a fanned-out batch job (explicit `logins`) processes exactly those logins — never re-derives or re-fans (#1941)", async () => {
    vi.stubEnv("CONTRIBUTOR_EVIDENCE_BATCH_SIZE", "1");
    vi.stubGlobal("fetch", async () => Response.json({})); // per-login reads stay off-network
    const env = createTestEnv();
    // Stored PRs from OTHER authors — an explicit batch must ignore them (no derivation from stored records).
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 1, title: "PR one", state: "open", user: { login: "alice" }, head: { sha: "a1" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 2, title: "PR two", state: "open", user: { login: "bob" }, head: { sha: "b2" }, labels: [], body: "y" });
    const refanned: import("../../src/types").JobMessage[] = [];
    const send = env.JOBS.send.bind(env.JOBS);
    env.JOBS.send = (async (message: import("../../src/types").JobMessage, options?: QueueSendOptions) => {
      if (message.type === "build-contributor-evidence") refanned.push(message);
      return send(message, options);
    }) as typeof env.JOBS.send;
    // A batch carrying an explicit `logins` array processes exactly that set (even a login with no stored PRs)...
    await expect(
      processJob(env, { type: "build-contributor-evidence", requestedBy: "schedule", logins: ["carol"] }),
    ).resolves.toBeUndefined();
    env.JOBS.send = send;
    // ...and short-circuits BEFORE the fan-out: it never re-derives from stored PRs nor re-enqueues evidence jobs.
    expect(refanned).toHaveLength(0);
  });

  it("derives only records that have an author — a null-author (ghost/deleted account) record contributes nothing (#1941)", async () => {
    vi.stubEnv("CONTRIBUTOR_EVIDENCE_BATCH_SIZE", "1"); // force a fan-out so the derived set is observable via the batch jobs
    const env = createTestEnv();
    // Two real authors + a ghost issue with no `user` (deleted account) → the ghost must NOT become a derived login.
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 1, title: "PR one", state: "open", user: { login: "alice" }, head: { sha: "a1" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 2, title: "PR two", state: "open", user: { login: "bob" }, head: { sha: "b2" }, labels: [], body: "y" });
    await upsertIssueFromGitHub(env, "owner/repo", { number: 9, title: "ghost issue", state: "open", labels: [], body: "z" }); // no user → null authorLogin
    const fanned: import("../../src/types").JobMessage[] = [];
    const send = env.JOBS.send.bind(env.JOBS);
    env.JOBS.send = (async (message: import("../../src/types").JobMessage, options?: QueueSendOptions) => {
      if (message.type === "build-contributor-evidence") fanned.push(message);
      return send(message, options);
    }) as typeof env.JOBS.send;
    await processJob(env, { type: "build-contributor-evidence", requestedBy: "schedule" });
    env.JOBS.send = send;
    const derived = fanned.flatMap((m) => (m as { logins?: string[] }).logins ?? []).sort();
    expect(derived).toEqual(["alice", "bob"]); // only the real authors; the null-author issue is filtered out
  });

  it("processes registry, backfill, installation health, and signal snapshot jobs", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("api.gittensor.io") || url.includes("mirror.gittensor.io")) {
        return new Response("missing", { status: 404 });
      }
      if (url.includes("master_repositories.json")) {
        return Response.json({
          "JSONbored/gittensory": {
            emission_share: 0.01,
            issue_discovery_share: 0,
            label_multipliers: { bug: 1.1 },
            trusted_label_pipeline: true,
          },
        });
      }
      if (url.includes("constants.py")) {
        return new Response("OSS_EMISSION_SHARE = 0.90\nMIN_TOKEN_SCORE_FOR_BASE_SCORE = 5\nMAX_CODE_DENSITY_MULTIPLIER = 1.15\n");
      }
      if (url.includes("programming_languages.json")) return Response.json({ TypeScript: 1 });
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
      if (url.includes("/labels?")) return Response.json([{ name: "bug" }]);
      if (url.includes("/issues?")) {
        return Response.json([{ number: 1, title: "Webhook duplicate delivery", state: "open", user: { login: "reporter" }, labels: [{ name: "bug" }], body: "Bug." }]);
      }
      if (url.includes("/pulls?state=open")) {
        return Response.json([{ number: 2, title: "Fix webhook duplicate delivery", state: "open", user: { login: "oktofeesh1" }, labels: [{ name: "bug" }], body: "Fixes #1" }]);
      }
      if (url.includes("/pulls?state=closed")) return Response.json([]);
      if (url.includes("/pulls/2/files")) return Response.json([]);
      if (url.includes("/pulls/2/reviews")) return Response.json([]);
      if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 2, followers: 1 });
      if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
      return Response.json({ check_runs: [] });
    });

    await processJob(env, { type: "refresh-registry", requestedBy: "test" });
    await processJob(env, { type: "sync-brokered-installed-repos", requestedBy: "test" });
    await processJob(env, { type: "refresh-scoring-model", requestedBy: "test" });
    await processJob(env, { type: "backfill-registered-repos", requestedBy: "test", repoFullName: "JSONbored/gittensory", force: true });
    await processJob(env, { type: "generate-signal-snapshots", requestedBy: "test", repoFullName: "JSONbored/gittensory" });
    await processJob(env, { type: "build-contributor-evidence", requestedBy: "test", login: "oktofeesh1" });
    await processJob(env, { type: "build-contributor-decision-packs", requestedBy: "test", login: "oktofeesh1" });
    await processJob(env, { type: "refresh-contributor-activity", requestedBy: "test", login: "oktofeesh1", repoFullName: "JSONbored/gittensory" });
    await processJob(env, { type: "build-contributor-evidence", requestedBy: "test" });
    await processJob(env, { type: "build-contributor-decision-packs", requestedBy: "test" });
    await processJob(env, { type: "build-burden-forecasts", requestedBy: "test", repoFullName: "JSONbored/gittensory" });
    await processJob(env, { type: "refresh-contributor-activity", requestedBy: "test", login: "oktofeesh1" });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "installation-created",
      eventName: "installation",
      payload: {
        action: "created",
        installation: { id: 456, account: { login: "JSONbored", id: 1, type: "User" } },
        repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } }],
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "installation-added-single-repo",
      eventName: "installation",
      payload: {
        action: "added",
        installation: { account: { login: "JSONbored", id: 1, type: "User" } } as never,
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
      },
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "installation-added-empty",
      eventName: "installation",
      payload: {
        action: "added",
        installation: { id: 789, account: { login: "JSONbored", id: 1, type: "User" } },
      },
    });

    expect(await listRepoSyncStates(env)).toMatchObject([{ repoFullName: "JSONbored/gittensory", status: "success" }]);
    expect(await listCollisionEdges(env, "JSONbored/gittensory")).not.toHaveLength(0);
    expect(await listSignalSnapshots(env, "queue-health", "JSONbored/gittensory")).toHaveLength(1);
    const issueQualitySnapshots = await listSignalSnapshots(env, "issue-quality", "JSONbored/gittensory");
    expect(issueQualitySnapshots).toHaveLength(1);
    expect(issueQualitySnapshots[0]?.payload).toMatchObject({ repoFullName: "JSONbored/gittensory", issues: expect.any(Array), summary: expect.any(String) });
    const outcomePatternSnapshots = await listSignalSnapshots(env, "repo-outcome-patterns", "JSONbored/gittensory");
    expect(outcomePatternSnapshots).toHaveLength(1);
    expect(outcomePatternSnapshots[0]?.payload).toMatchObject({
      repoFullName: "JSONbored/gittensory",
      totals: expect.any(Object),
      evidenceCompleteness: expect.objectContaining({ status: expect.any(String) }),
    });
    expect(await listSignalSnapshots(env, "contributor-decision-pack", "oktofeesh1")).not.toHaveLength(0);
    const contributorEvidence = await getContributorEvidence(env, "oktofeesh1");
    expect(contributorEvidence).toMatchObject({ login: "oktofeesh1", payload: { evidenceGraph: expect.objectContaining({ login: "oktofeesh1" }) } });
    expect(await listSignalSnapshots(env, "contributor-evidence-graph", "oktofeesh1")).not.toHaveLength(0);
    expect(await getContributorScoringProfile(env, "oktofeesh1")).toMatchObject({ login: "oktofeesh1" });
    const persistedBurden = await getBurdenForecast(env, "JSONbored/gittensory");
    expect(persistedBurden).toMatchObject({ repoFullName: "JSONbored/gittensory" });
    expect(persistedBurden?.payload).toMatchObject({ level: expect.any(String), summary: expect.any(String) });
    expect(await listProductUsageEvents(env, { limit: 10 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventName: "github_installation_created", repoFullName: "<redacted-actor>/gittensory", metadata: expect.objectContaining({ action: "created" }) }),
      ]),
    );
  });

  it("runs queued agent jobs through the queue processor", async () => {
    const queued: unknown[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: unknown) {
          queued.push(message);
        },
      } as unknown as Queue,
    });
    await createAgentRun(env, {
      id: "agent-run-queue",
      objective: "Plan next work",
      actorLogin: "oktofeesh1",
      surface: "api",
      mode: "copilot",
      status: "queued",
      dataQualityStatus: "unknown",
      payload: { kind: "plan_next_work", login: "oktofeesh1" },
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
    });

    await processJob(env, { type: "run-agent", requestedBy: "api", runId: "agent-run-queue" });

    await expect(getAgentRun(env, "agent-run-queue")).resolves.toMatchObject({ status: "needs_snapshot_refresh" });
    expect(queued).toContainEqual({ type: "build-contributor-decision-packs", requestedBy: "api", login: "oktofeesh1" });
  });

  it("runs product usage rollups through the queue processor", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });
    await recordProductUsageEvent(env, {
      surface: "api",
      eventName: "agent_plan_next_work_completed",
      actor: "oktofeesh1",
      repoFullName: "JSONbored/gittensory",
      outcome: "success",
      occurredAt: "2026-05-27T12:00:00.000Z",
    });

    await processJob(env, { type: "rollup-product-usage", requestedBy: "test", day: "2026-05-27" });
    await processJob(env, { type: "rollup-product-usage", requestedBy: "test", days: 1 });

    await expect(listProductUsageDailyRollups(env)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        day: "2026-05-27",
        totalEvents: 1,
        activeActors: 1,
        activation: expect.objectContaining({ firstUsefulActionActors: 1 }),
      }),
    ]));
  });

  it("runs weekly value report generation through the queue processor", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "fixed-test-salt" });

    await processJob(env, { type: "generate-weekly-value-report", requestedBy: "test", variant: "operator", days: 7 });
    await processJob(env, { type: "generate-weekly-value-report", requestedBy: "test" });

    const row = await env.DB.prepare("select event_type, target_key, outcome from audit_events where event_type = ? order by created_at limit 1").bind("weekly_value_report_generated").first();
    expect(row).toMatchObject({
      event_type: "weekly_value_report_generated",
      target_key: "weekly-value-report:operator:7",
      outcome: "success",
    });
    const auditCount = await env.DB.prepare("select count(*) as count from audit_events where event_type = ?").bind("weekly_value_report_generated").first<{ count: number }>();
    expect(auditCount?.count).toBe(2);
  });

  it("runs the review recap job through the queue processor when reviewRecap.enabled is true (#1963)", async () => {
    const env = Object.assign(createTestEnv(), { GITTENSORY_DISCORD_WEBHOOK: "https://discord.com/api/webhooks/123/abc" }) as Env;
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { reviewRecap: { enabled: true, cadenceDays: 3 } });
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));

    await processJob(env, { type: "generate-review-recap", requestedBy: "test", repoFullName: "JSONbored/gittensory" });

    const row = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? order by created_at desc limit 1").bind("review_recap_notification.discord").first();
    expect(row).toMatchObject({ outcome: "completed", detail: "sent" });
    vi.unstubAllGlobals();
  });

  it("uses the job message's explicit windowDays over the manifest's cadenceDays default (#1963, nullish fallback present side)", async () => {
    const env = Object.assign(createTestEnv(), { GITTENSORY_DISCORD_WEBHOOK: "https://discord.com/api/webhooks/123/abc" }) as Env;
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { reviewRecap: { enabled: true, cadenceDays: 3 } });
    let capturedBody: string | undefined;
    vi.stubGlobal("fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return new Response(null, { status: 204 });
    });

    await processJob(env, { type: "generate-review-recap", requestedBy: "test", repoFullName: "JSONbored/gittensory", windowDays: 21 });

    expect(capturedBody).toContain("(21d)");
    vi.unstubAllGlobals();
  });

  it("skips the review recap job as a no-op when reviewRecap is NOT enabled for the repo (default-off, #1963)", async () => {
    const env = Object.assign(createTestEnv(), { GITTENSORY_DISCORD_WEBHOOK: "https://discord.com/api/webhooks/123/abc" }) as Env;
    // Prime an explicit, present-but-disabled manifest so loadRepoFocusManifest hits the cache instead of
    // falling through to a live GitHub fetch for this repo's .gittensory.yml (there is none in this test env).
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { wantedPaths: ["src/"] });
    let fetchCalled = false;
    vi.stubGlobal("fetch", async () => {
      fetchCalled = true;
      return new Response(null, { status: 204 });
    });

    await processJob(env, { type: "generate-review-recap", requestedBy: "test", repoFullName: "JSONbored/gittensory" });

    expect(fetchCalled).toBe(false);
    const row = await env.DB.prepare("select count(*) as count from audit_events where event_type = ?").bind("review_recap_notification.discord").first<{ count: number }>();
    expect(row?.count).toBe(0);
    vi.unstubAllGlobals();
  });

  it("runs the maintainer recap job through the queue processor when GITTENSORY_MAINTAINER_RECAP is ON (#1963, #2248)", async () => {
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc", GITTENSORY_MAINTAINER_RECAP: "true" });
    await env.DB.prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, ?, ?, 1, 1)").bind("JSONbored/gittensory", "JSONbored", "gittensory").run();
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));

    await processJob(env, { type: "generate-maintainer-recap", requestedBy: "test" });

    const row = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? order by created_at desc limit 1").bind("maintainer_recap_notification.discord").first();
    expect(row).toMatchObject({ outcome: "completed", detail: "sent" });
    vi.unstubAllGlobals();
  });

  it("skips the maintainer recap job as a no-op when GITTENSORY_MAINTAINER_RECAP is OFF (default, #2248)", async () => {
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc" });
    let discordFetchCalled = false;
    // The disabled-check ALSO resolves the self-repo's manifest override (#2250), which may fall through to a
    // live GitHub fetch for its .gittensory.yml when uncached -- stub that fetch as a generic 404 so the
    // manifest loader degrades to "no override", and only flag a call to the Discord webhook itself.
    vi.stubGlobal("fetch", async (url: RequestInfo | URL) => {
      if (String(url).includes("discord.com")) discordFetchCalled = true;
      return new Response(null, { status: 404 });
    });

    await processJob(env, { type: "generate-maintainer-recap", requestedBy: "test" });

    expect(discordFetchCalled).toBe(false);
    const row = await env.DB.prepare("select count(*) as count from audit_events where event_type = ?").bind("maintainer_recap_notification.discord").first<{ count: number }>();
    expect(row?.count).toBe(0);
    vi.unstubAllGlobals();
  });

  it("routes upstream drift jobs through queue processors", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/commits/")) return Response.json({ sha: "queue-upstream-commit" });
      if (url.includes("/contents/gittensor/constants.py")) {
        return Response.json({ content: b64("SRC_TOK_SATURATION_SCALE = 58\nMAX_CODE_DENSITY_MULTIPLIER = 1.15\n"), encoding: "base64", sha: "constants-sha" });
      }
      if (url.includes("/contents/gittensor/validator/weights/master_repositories.json")) {
        return Response.json({ content: b64(JSON.stringify({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: true } })), encoding: "base64", sha: "registry-sha" });
      }
      if (url.includes("/contents/gittensor/validator/weights/programming_languages.json")) {
        return Response.json({ content: b64(JSON.stringify({ TypeScript: 1 })), encoding: "base64", sha: "languages-sha" });
      }
      if (url.includes("/contents/gittensor/validator/oss_contributions/mirror/scoring.py")) {
        return Response.json({ content: b64("score = 1 - exp(-x)\nsolved_by_pr = True\n"), encoding: "base64", sha: "scoring-sha" });
      }
      if (url.includes("/contents/gittensor/validator/issue_discovery/scan.py")) {
        return Response.json({ content: b64("branch eligibility required\n"), encoding: "base64", sha: "issue-scan-sha" });
      }
      if (url.includes("/contents/gittensor/utils/mirror/models.py")) {
        return Response.json({ content: b64("solved_by_pr: int\n"), encoding: "base64", sha: "models-sha" });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, { type: "refresh-upstream-drift", requestedBy: "test" });
    await processJob(env, { type: "file-upstream-drift-issues", requestedBy: "test" });

    await expect(getLatestUpstreamRulesetSnapshot(env)).resolves.toMatchObject({ activeModel: "pending_saturation_model", registryRepoCount: 1 });
    await expect(listUpstreamDriftReports(env)).resolves.toEqual([]);
  });

  it("fans out all-repo backfill jobs into repo-scoped queue messages", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
          "we-promise/sure": { emission_share: 0.02, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
        },
        { kind: "raw-github", url: "fixture://registry" },
        "2026-05-25T00:00:00.000Z",
      ),
    );

    await processJob(env, { type: "backfill-registered-repos", requestedBy: "api", force: true, mode: "full" });

    expect(sent).toEqual([
      { type: "backfill-registered-repos", requestedBy: "api", repoFullName: "JSONbored/gittensory", force: true, mode: "full" },
      { type: "backfill-registered-repos", requestedBy: "api", repoFullName: "we-promise/sure", force: true, mode: "full" },
    ]);
    expect(await listRepoSyncStates(env)).toEqual([]);
  });

  it("falls back to inline all-repo backfill when no registered repositories exist", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });

    await processJob(env, { type: "backfill-registered-repos", requestedBy: "api", mode: "light" });

    expect(sent).toEqual([]);
    expect(await listRepoSyncStates(env)).toEqual([]);
  });

  it("routes repo-scoped API backfills into open-data segment jobs", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false } },
        { kind: "raw-github", url: "fixture://registry" },
        "2026-05-25T00:00:00.000Z",
      ),
    );
    await processJob(env, { type: "backfill-registered-repos", requestedBy: "api", repoFullName: "JSONbored/gittensory", force: false, mode: "resume" });

    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "backfill-repo-segment", repoFullName: "JSONbored/gittensory", mode: "resume", force: false }),
      ]),
    );
  });

  it("repairs incomplete fidelity through queue-backed repo jobs", async () => {
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
          "we-promise/sure": { emission_share: 0.02, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
        },
        { kind: "raw-github", url: "fixture://registry" },
        "2026-05-25T00:00:00.000Z",
      ),
    );

    await upsertRepoSyncSegment(env, completeSegment("JSONbored/gittensory", "labels"));
    await upsertRepoSyncSegment(env, completeSegment("JSONbored/gittensory", "open_issues"));
    await upsertRepoSyncSegment(env, completeSegment("JSONbored/gittensory", "open_pull_requests"));

    await processJob(env, { type: "repair-data-fidelity", requestedBy: "schedule" });

    expect(sent.map((entry) => entry.message)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "backfill-registered-repos", repoFullName: "we-promise/sure", mode: "resume" }),
        expect.objectContaining({ type: "generate-signal-snapshots", repoFullName: "JSONbored/gittensory" }),
      ]),
    );
  });

  it("marks fidelity repair completed when only signal refreshes are needed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T01:00:00.000Z"));

    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
          "we-promise/sure": { emission_share: 0.02, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
        },
        { kind: "raw-github", url: "fixture://registry" },
        "2026-05-25T00:00:00.000Z",
      ),
    );
    for (const repoFullName of ["JSONbored/gittensory", "we-promise/sure"]) {
      await upsertRepoSyncSegment(env, completeSegment(repoFullName, "labels"));
      await upsertRepoSyncSegment(env, completeSegment(repoFullName, "open_issues"));
      await upsertRepoSyncSegment(env, completeSegment(repoFullName, "open_pull_requests"));
    }

    await processJob(env, { type: "repair-data-fidelity", requestedBy: "api" });

    expect(sent).toEqual([
      { message: expect.objectContaining({ type: "generate-signal-snapshots", repoFullName: "JSONbored/gittensory" }) },
      { message: expect.objectContaining({ type: "generate-signal-snapshots", repoFullName: "we-promise/sure" }), options: { delaySeconds: 70 } },
    ]);
    const audit = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("sync.fidelity_repair").first<{
      outcome: string;
      metadata_json: string;
    }>();
    expect(audit?.outcome).toBe("completed");
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({ repairCount: 0, signalRefreshCount: 2, freshnessSlo: { status: "fresh", repairRecommended: false } });
    const sloAudit = await env.DB.prepare("select detail, outcome, metadata_json from audit_events where event_type = ?").bind("signals.freshness_slo").first<{
      detail: string;
      outcome: string;
      metadata_json: string;
    }>();
    expect(sloAudit).toMatchObject({ detail: "fresh", outcome: "completed" });
    expect(JSON.parse(sloAudit?.metadata_json ?? "{}")).toMatchObject({ status: "fresh", affectedAreas: [] });
    expect(sloAudit?.metadata_json).not.toMatch(/JSONbored|we-promise|github|token|secret/i);
  });

  it("queues signal repair and emits alertable audit state when freshness SLOs breach", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T13:00:00.000Z"));

    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false } },
        { kind: "raw-github", url: "fixture://registry" },
        "2026-05-25T00:00:00.000Z",
      ),
    );
    await upsertRepoSyncSegment(env, completeSegment("JSONbored/gittensory", "labels"));
    await upsertRepoSyncSegment(env, completeSegment("JSONbored/gittensory", "open_issues"));
    await upsertRepoSyncSegment(env, completeSegment("JSONbored/gittensory", "open_pull_requests"));
    await persistSignalSnapshot(env, {
      id: "stale-queue-health",
      signalType: "queue-health",
      targetKey: "JSONbored/gittensory",
      repoFullName: "JSONbored/gittensory",
      payload: {},
      generatedAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
    });

    await processJob(env, { type: "repair-data-fidelity", requestedBy: "api" });

    expect(sent).toEqual([{ message: expect.objectContaining({ type: "generate-signal-snapshots", repoFullName: "JSONbored/gittensory" }) }]);
    const repairAudit = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("sync.fidelity_repair").first<{
      outcome: string;
      metadata_json: string;
    }>();
    expect(repairAudit?.outcome).toBe("queued");
    expect(JSON.parse(repairAudit?.metadata_json ?? "{}")).toMatchObject({
      repairCount: 0,
      signalRefreshCount: 1,
      freshnessSlo: { status: "degraded", repairRecommended: true, affectedAreas: ["signal_snapshot"], launchBlockingCount: 0 },
    });
    const sloAudit = await env.DB.prepare("select detail, outcome, metadata_json from audit_events where event_type = ?").bind("signals.freshness_slo").first<{
      detail: string;
      outcome: string;
      metadata_json: string;
    }>();
    expect(sloAudit).toMatchObject({ detail: "degraded", outcome: "queued" });
    expect(JSON.parse(sloAudit?.metadata_json ?? "{}")).toMatchObject({ status: "degraded", affectedAreas: ["signal_snapshot"], launchBlockingCount: 0 });
    expect(sloAudit?.metadata_json).not.toMatch(/JSONbored|gittensory|token|secret/i);
  });

  it("fans out signal snapshot generation instead of doing all repo work inline", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
          "we-promise/sure": { emission_share: 0.02, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
        },
        { kind: "raw-github", url: "fixture://registry" },
        "2026-05-25T00:00:00.000Z",
      ),
    );

    await processJob(env, { type: "generate-signal-snapshots", requestedBy: "schedule" });

    expect(sent).toEqual([
      expect.objectContaining({ type: "generate-signal-snapshots", repoFullName: "JSONbored/gittensory" }),
      expect.objectContaining({ type: "generate-signal-snapshots", repoFullName: "we-promise/sure" }),
    ]);
  });

  it("agent re-gate sweep fans out to acting-autonomy repos (#777), skipping non-acting ones when not allowlisted", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITTENSORY_REVIEW_REPOS: "", // isolate the acting-autonomy gate from the allowlist-sweep path (tested below)
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    // #sweep-requires-installation: acting-autonomy eligibility also requires a real installation now — give
    // the repos that SHOULD be swept a real installationId, mirroring an actually-installed repo.
    await upsertRepositoryFromGitHub(env, { name: "agent-a", full_name: "owner/agent-a", private: false, owner: { login: "owner" } }, 9201);
    await upsertRepositoryFromGitHub(env, { name: "agent-b", full_name: "owner/agent-b", private: false, owner: { login: "owner" } }, 9202);
    await upsertRepositoryFromGitHub(env, { name: "plain-repo", full_name: "owner/plain-repo", private: false, owner: { login: "owner" } }, 9203);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-a", autonomy: { label: "auto" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-b", autonomy: { merge: "auto_with_approval" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/plain-repo", autonomy: { review: "observe" } }); // non-acting → not configured

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule" });

    expect(sent).toHaveLength(2);
    expect(sent.every((message) => message.type === "agent-regate-sweep")).toBe(true);
    expect(sent.map((message) => (message.type === "agent-regate-sweep" ? message.repoFullName : null)).sort()).toEqual(["owner/agent-a", "owner/agent-b"]);
    const fanout = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("agent.sweep.fanout").first<{
      outcome: string;
      metadata_json: string;
    }>();
    expect(fanout?.outcome).toBe("queued");
    expect(JSON.parse(fanout?.metadata_json ?? "{}")).toMatchObject({ repoCount: 2, requestedBy: "schedule" });
  });

  it("REGRESSION (#sweep-requires-installation): an acting-autonomy repo with NO real installation is excluded, even though it resolves the operator's global-default autonomy", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITTENSORY_REVIEW_REPOS: "",
      JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue,
    });
    // A repo that merely EXISTS locally (e.g. a stray row from an unrelated sync) with a real installation and
    // acting autonomy — sweep-eligible.
    await upsertRepositoryFromGitHub(env, { name: "installed-repo", full_name: "owner/installed-repo", private: false, owner: { login: "owner" } }, 9301);
    await upsertRepositorySettings(env, { repoFullName: "owner/installed-repo", autonomy: { merge: "auto" } });
    // Same acting autonomy, but NO installationId (never upserted with one) — this is exactly the shape a
    // stray repositories row takes: it can still resolve a permissive global-default autonomy policy, but
    // there is no GitHub App installation on it at all, so it must never be treated as agent-configured.
    await upsertRepositoryFromGitHub(env, { name: "uninstalled-repo", full_name: "owner/uninstalled-repo", private: false, owner: { login: "owner" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/uninstalled-repo", autonomy: { merge: "auto" } });

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule" });

    expect(sent.map((m) => (m.type === "agent-regate-sweep" ? m.repoFullName : null))).toEqual(["owner/installed-repo"]);
  });

  it("agent re-gate sweep ALSO fans out to allowlisted repos regardless of autonomy mode (#sweep-all-modes)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ GITTENSORY_REVIEW_REPOS: "owner/advisory-repo", JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    // advisory-repo is allowlisted but autonomy is observe (NOT acting) — it must STILL be swept so advisory reviews fire.
    await upsertRepositoryFromGitHub(env, { name: "advisory-repo", full_name: "owner/advisory-repo", private: false, owner: { login: "owner" } }, 9102);
    await upsertRepositorySettings(env, { repoFullName: "owner/advisory-repo", autonomy: { merge: "observe", close: "observe" } });
    // off-repo is neither allowlisted nor acting → still skipped.
    await upsertRepositoryFromGitHub(env, { name: "off-repo", full_name: "owner/off-repo", private: false, owner: { login: "owner" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/off-repo", autonomy: { review: "observe" } });

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule" });

    const swept = sent.filter((m): m is Extract<import("../../src/types").JobMessage, { type: "agent-regate-sweep" }> => m.type === "agent-regate-sweep").map((m) => m.repoFullName);
    expect(swept).toEqual(["owner/advisory-repo"]); // allowlisted observe repo IS swept; off-repo is not
    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: "agent-regate-sweep", repoFullName: "owner/advisory-repo", installationId: 9102 })]));
  });

  it("REGRESSION (#audit-sweep-fanout-isolation): one repo's settings-check failure does not abort the fan-out for every other repo", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITTENSORY_REVIEW_REPOS: "",
      JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue,
    });
    await upsertRepositoryFromGitHub(env, { name: "agent-a", full_name: "owner/agent-a", private: false, owner: { login: "owner" } }, 9204);
    await upsertRepositoryFromGitHub(env, { name: "agent-b", full_name: "owner/agent-b", private: false, owner: { login: "owner" } }, 9205);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-a", autonomy: { label: "auto" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-b", autonomy: { label: "auto" } });
    const realResolve = repositorySettingsModule.resolveRepositorySettings;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const resolveSpy = vi.spyOn(repositorySettingsModule, "resolveRepositorySettings").mockImplementation(async (e, repoFullName) => {
      if (repoFullName === "owner/agent-a") throw new Error("D1 read error");
      return realResolve(e, repoFullName);
    });

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule" });

    expect(sent).toEqual([expect.objectContaining({ type: "agent-regate-sweep", repoFullName: "owner/agent-b" })]); // agent-a's failure did not block agent-b
    expect(errors.mock.calls.some((call) => String(call[0]).includes("sweep_fanout_repo_check_failed") && String(call[0]).includes("owner/agent-a"))).toBe(true);
    const fanout = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("agent.sweep.fanout").first<{ outcome: string; metadata_json: string }>();
    expect(fanout?.outcome).toBe("queued"); // the fan-out still completes and records its own outcome
    expect(JSON.parse(fanout?.metadata_json ?? "{}")).toMatchObject({ repoCount: 1, skippedErrored: 1 });
    errors.mockRestore();
    resolveSpy.mockRestore();
  });

  it("REGRESSION (#audit-sweep-fanout-isolation): one repo's dispatch failure does not abort dispatch for every other repo, and the fan-out audit event still records", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITTENSORY_REVIEW_REPOS: "",
      JOBS: {
        async send(m: import("../../src/types").JobMessage) {
          if (m.type === "agent-regate-sweep" && m.repoFullName === "owner/agent-a") throw new Error("queue send error");
          sent.push(m);
        },
      } as unknown as Queue,
    });
    await upsertRepositoryFromGitHub(env, { name: "agent-a", full_name: "owner/agent-a", private: false, owner: { login: "owner" } }, 9206);
    await upsertRepositoryFromGitHub(env, { name: "agent-b", full_name: "owner/agent-b", private: false, owner: { login: "owner" } }, 9207);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-a", autonomy: { label: "auto" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-b", autonomy: { label: "auto" } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule" });

    expect(sent).toEqual([expect.objectContaining({ type: "agent-regate-sweep", repoFullName: "owner/agent-b" })]); // agent-a's failed send did not block agent-b's
    expect(errors.mock.calls.some((call) => String(call[0]).includes("sweep_fanout_dispatch_failed") && String(call[0]).includes("owner/agent-a"))).toBe(true);
    const fanout = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("agent.sweep.fanout").first<{ outcome: string; metadata_json: string }>();
    expect(fanout?.outcome).toBe("queued"); // reached — the dispatch failure did not throw the fan-out itself
    expect(JSON.parse(fanout?.metadata_json ?? "{}")).toMatchObject({ repoCount: 2 }); // both PASSED their settings/draining checks regardless of dispatch outcome
    errors.mockRestore();
  });

  it("REGRESSION (#3899): resolves multiple repos' settings/drain-state CONCURRENTLY, bounded by SWEEP_FANOUT_RESOLUTION_CONCURRENCY", async () => {
    vi.useRealTimers();
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITTENSORY_REVIEW_REPOS: "",
      JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue,
    });
    const repoNames = ["r1", "r2", "r3", "r4", "r5", "r6"];
    for (const [index, name] of repoNames.entries()) {
      await upsertRepositoryFromGitHub(env, { name, full_name: `owner/${name}`, private: false, owner: { login: "owner" } }, 9300 + index);
      await upsertRepositorySettings(env, { repoFullName: `owner/${name}`, autonomy: { label: "auto" } });
    }
    const { mapWithConcurrencyLimit: realMapWithConcurrencyLimit } =
      await vi.importActual<typeof focusManifestLoaderModule>("../../src/signals/focus-manifest-loader");
    let inFlight = 0;
    let maxInFlight = 0;
    const mapSpy = vi.spyOn(focusManifestLoaderModule, "mapWithConcurrencyLimit").mockImplementation(
      async (items, limit, mapper) => {
        expect(limit).toBe(SWEEP_FANOUT_RESOLUTION_CONCURRENCY);
        return realMapWithConcurrencyLimit(items, limit, async (item) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            await new Promise((resolve) => setTimeout(resolve, 5)); // hold the window open long enough for others to overlap
            return await mapper(item);
          } finally {
            inFlight -= 1;
          }
        });
      },
    );

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule" });

    expect(mapSpy).toHaveBeenCalled();
    expect(maxInFlight).toBeGreaterThan(1); // proves real overlap — not the old strictly-sequential loop
    expect(maxInFlight).toBeLessThanOrEqual(SWEEP_FANOUT_RESOLUTION_CONCURRENCY); // proves BOUNDED, not unlimited fan-out
    expect(sent.filter((m) => m.type === "agent-regate-sweep").length).toBe(repoNames.length); // every repo still dispatched
  });

  it("agent re-gate sweep recomputes stale open PR verdicts as an advisory audit, never publishing (#777)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: import("../../src/types").JobMessage) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, linkedIssueGateMode: "block" });
    // #7 has no linked issue → blocked under linkedIssueGateMode:block; #8 links one → passes. Both are stale.
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Unlinked PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "no linked issue here" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 8, title: "Linked PR", state: "open", user: { login: "contributor" }, head: { sha: "a8" }, labels: [], body: "Closes #1" });
    // Advance past the one-hour freshness window so the just-seeded PRs read as stale.
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    const audit = await env.DB.prepare("select outcome, detail, metadata_json from audit_events where event_type = ?").bind("agent.sweep.regate").first<{
      outcome: string;
      detail: string;
      metadata_json: string;
    }>();
    expect(audit?.outcome).toBe("completed");
    const meta = JSON.parse(audit?.metadata_json ?? "{}");
    expect(meta).toMatchObject({ repoFullName: "owner/agent-repo", mode: "live", examined: 2, flagged: 1 });
    expect(meta.flaggedPulls).toEqual([7]);
    expect(meta.verdicts).toMatchObject({ "7": "failure", "8": "success" });
    // Advisory only: the sweep enqueues no jobs and posts no check/comment/label.
    expect(sent).toEqual([]);
  });

  it("agent re-gate sweep applies the self-authored-linked-issue block (#self-authored-parity)", async () => {
    const env = createTestEnv({ JOBS: { async send() {} } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, selfAuthoredLinkedIssueGateMode: "block" });
    // Issue #5 is authored by miner1; PR #9 by miner1 links it → self-authored. Without threading the linked-issue
    // author into the sweep's advisory, this PR would re-gate as "success" and escape the block. (#self-authored-parity)
    await upsertIssueFromGitHub(env, "owner/agent-repo", { number: 5, title: "Self-reported bug", body: "", state: "open", user: { login: "miner1" }, labels: [], html_url: "https://github.com/owner/agent-repo/issues/5", created_at: "2026-05-27T00:00:00Z", updated_at: "2026-05-27T00:00:00Z" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 9, title: "Fix self-reported bug", state: "open", user: { login: "miner1" }, head: { sha: "a9" }, labels: [], body: "Closes #5" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    const audit = await env.DB.prepare("select metadata_json from audit_events where event_type = ?").bind("agent.sweep.regate").first<{ metadata_json: string }>();
    const meta = JSON.parse(audit?.metadata_json ?? "{}");
    expect(meta.verdicts).toMatchObject({ "9": "failure" });
    expect(meta.flaggedPulls).toContain(9);
  });

  it("agent re-gate sweep skips advisory AI review while refreshing the PR surface on a stale AI-enabled PR", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: {
        run: async () => {
          aiCalls += 1;
          return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) };
        },
      } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, {
      repoFullName: "owner/agent-repo",
      autonomy: { merge: "auto" },
      aiReviewMode: "advisory",
      gatePack: "oss-anti-slop",
      reviewCheckMode: "required",
      checkRunMode: "off",
      commentMode: "off",
      publicSurface: "off",
    });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Stale PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "no linked issue here" });
    await upsertPullRequestFile(env, { repoFullName: "owner/agent-repo", pullNumber: 7, path: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, payload: { patch: "@@\n+export const ok = true;" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Stale PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "no linked issue here" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      return new Response("not found", { status: 404 });
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    expect(aiCalls).toBe(0);
    const aiUsage = await env.DB.prepare("select count(*) as n from ai_usage_events where feature = ?").bind("ai_review_pr").first<{ n: number }>();
    expect(aiUsage?.n).toBe(0);
    const audit = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("agent.sweep.regate").first<{ outcome: string; metadata_json: string }>();
    expect(audit?.outcome).toBe("completed");
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({ repoFullName: "owner/agent-repo", examined: 1 });
  });

  it("agent re-gate sweep ignores stale same-head AI cache inputs before auto-maintenance (regression)", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: {
        run: async () => {
          aiCalls += 1;
          return { response: JSON.stringify({ assessment: "Critical defect found.", blockers: ["Unhandled null dereference in src/a.ts"], nits: [], suggestions: [] }) };
        },
      } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, {
      repoFullName: "owner/agent-repo",
      autonomy: { merge: "auto" },
      aiReviewMode: "block",
      gatePack: "oss-anti-slop",
      reviewCheckMode: "required",
      checkRunMode: "off",
      commentMode: "off",
      publicSurface: "off",
    });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Stale PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
    await upsertPullRequestFile(env, { repoFullName: "owner/agent-repo", pullNumber: 7, path: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, payload: { patch: "@@\n+export const ok = value.length;" } });
    await putCachedAiReview(env, "owner/agent-repo", 7, "a7", "block", {
      notes: "stale cached review from older review inputs",
      reviewerCount: 2,
      findings: [{ code: "ai_review_split", severity: "critical", title: "Old cache", detail: "Old prompt inputs." }],
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = value.length;" }]);
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Stale PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.endsWith("/pulls/7/merge")) return new Response(null, { status: 204 });
      if (url.endsWith("/pulls/7/reviews") && init?.method === "POST") return Response.json({ id: 1 });
      if (url.endsWith("/pulls/7/reviews")) return Response.json([]);
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await sweepAndDrainPerPr(env, "owner/agent-repo");

    expect(aiCalls).toBeGreaterThanOrEqual(2);
    const blocker = await env.DB.prepare("select blocker_codes_json from gate_outcomes where repo_full_name = ? and pull_number = ? order by rowid desc limit 1").bind("owner/agent-repo", 7).first<{ blocker_codes_json: string }>();
    expect(blocker?.blocker_codes_json).toContain("ai_consensus_defect");
    const mergeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and detail like ?").bind("agent.action.merge", "%merged%").first<{ n: number }>();
    expect(mergeAudit?.n).toBe(0);
  });

  // #sweep-resync: when a `synchronize` webhook is lost (self-host relay down), the stored head SHA + cached files
  // go stale and the sweep would review an INCOHERENT diff. The re-review now RESYNCS the stored PR to its live head
  // before reviewing. These two cases pin both arms of the drift check (differs → resync fires, matches → no-op).
  it("#sweep-resync: re-review RESYNCS the stored PR to the live head when it drifted, then reviews on the new head", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    // STORED head is the stale a7; GitHub's LIVE head is b8 (a push the lost synchronize never delivered).
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Drifted PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
    let liveFilesFetched = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // GET /pulls/7 reports the live head b8 — the resync upserts this over the stale a7.
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Drifted PR", state: "open", user: { login: "contributor" }, head: { sha: "b8" }, labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) { liveFilesFetched = true; return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]); }
      if (url.includes("/commits/b8/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/b8/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-pr", deliveryId: "resync-drift", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

    // The stored PR was resynced to the live head, and its files were refreshed (so the review runs on b8, not a7).
    const stored = await getPullRequest(env, "owner/agent-repo", 7);
    expect(stored?.headSha).toBe("b8");
    expect(liveFilesFetched).toBe(true);
  });

  it("#sweep-resync: re-review does NOT resync when the stored head already matches the live head", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
    const resyncUpsertSpy = vi.spyOn(repositoriesModule, "upsertPullRequestFromGitHub");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // GET /pulls/7 reports the SAME head a7 — no drift, so the resync upsert must not fire.
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-pr", deliveryId: "resync-nodrift", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

    // No drift → the resync branch's upsert never ran; the stored head is unchanged.
    expect(resyncUpsertSpy).not.toHaveBeenCalled();
    const stored = await getPullRequest(env, "owner/agent-repo", 7);
    expect(stored?.headSha).toBe("a7");
    resyncUpsertSpy.mockRestore();
  });

  it("#regate-terminal-exit: a swept PR CLOSED on GitHub reconciles the stored row then early-exits — no files/CI reads, no review (#1942)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    // STORED row still reads open — the `closed` webhook was dropped (relay down); GitHub's LIVE state is closed.
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Closed PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
    let filesFetched = false;
    let ciFetched = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Closed PR", state: "closed", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) { filesFetched = true; return Response.json([]); }
      if (url.includes("/commits/")) { ciFetched = true; return Response.json({ total_count: 0, check_runs: [] }); }
      return Response.json({});
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-pr", deliveryId: "resync-closed", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

    // Reconciled: the stored row now reflects the live terminal state, so the NEXT sweep skips it outright.
    const stored = await getPullRequest(env, "owner/agent-repo", 7);
    expect(stored?.state).toBe("closed");
    // Early-exit BEFORE the expensive resync + readiness reads: no files, no CI reads (and no review output).
    expect(filesFetched).toBe(false);
    expect(ciFetched).toBe(false);
  });

  it("#regate-terminal-exit: skips a stale terminal upsert when a concurrent webhook already reopened the PR", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Open PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
    let webhookReplayApplied = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/pulls/7")) {
        vi.setSystemTime(new Date("2026-05-28T02:00:01.000Z"));
        await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Reopened PR", state: "open", user: { login: "contributor" }, head: { sha: "b8" }, labels: [], body: "Closes #1" });
        webhookReplayApplied = true;
        return Response.json({ number: 7, title: "Stale closed PR", state: "closed", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
      }
      return Response.json({});
    });

    await processJob(env, { type: "agent-regate-pr", deliveryId: "resync-stale-closed", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

    expect(webhookReplayApplied).toBe(true);
    const stored = await getPullRequest(env, "owner/agent-repo", 7);
    expect(stored?.state).toBe("open");
    expect(stored?.headSha).toBe("b8");
  });

  // REST-budget dedup (#audit-rate-headroom): one per-PR re-review threads request-local live GitHub facts through
  // readiness and auto-maintain, while post-gate planning refreshes facts that can change after the bot publishes
  // review/check state. Mergeability can advance to clean; CI can flip red and must still suppress merge.
  it("#audit-rate-headroom: the per-PR re-review refreshes merge state and CI after the gate publication boundary", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    // Seed an UP-TO-DATE reviews-cache marker so this dedup-focused call-count test stays isolated from the
    // reviews-staleness self-heal (#2537 follow-up) — that behavior has its own dedicated coverage below.
    await upsertPullRequestDetailSyncState(env, { repoFullName: "owner/agent-repo", pullNumber: 7, status: "complete", reviewsSyncedAt: new Date().toISOString() });
    let barePullGets = 0;
    let branchProtectionGets = 0;
    let liveCheckRunsGets = 0;
    let statusGets = 0;
    let mergeAttempts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // Count only the bare `GET /pulls/7` (no sub-resource, GET only). The resync payload starts blocked, then the
      // post-gate maintenance read observes the bot's newly published review/check state as clean.
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") {
        barePullGets += 1;
        return Response.json({
          number: 7,
          title: "Clean PR",
          state: "open",
          user: { login: "contributor" },
          head: { sha: "a7" },
          mergeable_state: barePullGets === 1 ? "blocked" : "clean",
          labels: [],
          body: "Closes #1",
        });
      }
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/commits/a7/check-runs") && url.includes("per_page=100")) {
        liveCheckRunsGets += 1;
        return Response.json({ total_count: 0, check_runs: [] });
      }
      if (url.includes("/commits/a7/status")) {
        statusGets += 1;
        return Response.json(
          statusGets === 1
            ? { state: "success", statuses: [] }
            : {
                state: "failure",
                statuses: [
                  {
                    context: "codecov/patch",
                    state: "failure",
                    description: "patch coverage below target",
                    target_url: "https://ci.example.test/codecov",
                  },
                ],
              },
        );
      }
      if (url.includes("/pulls/7/merge") && method === "PUT") {
        mergeAttempts += 1;
        return Response.json({ merged: true, sha: "merged-a7" });
      }
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) {
        branchProtectionGets += 1;
        return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      }
      return Response.json({});
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-pr", deliveryId: "dedup-pulls-get", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

    // Readiness reuses the resync payload; the freshness guard runs before auto-maintain refreshes merge-state and CI.
    expect(barePullGets).toBe(2);
    expect(fetchPullRequestFreshness).toHaveBeenCalledWith(env, expect.objectContaining({ expectedHeadSha: "a7" }));
    expect(branchProtectionGets).toBe(1);
    expect(liveCheckRunsGets).toBe(2);
    expect(statusGets).toBe(2);
    expect(mergeAttempts).toBe(0);
  });

  it("REGRESSION (#2537 follow-up): the per-PR sweep unit force-refreshes a STALE reviews cache even when no OTHER reason (slop evidence, manifest gate, pre-merge check paths) would have triggered a refresh", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    // A sync that predates an invalidation (STALE) and no other refresh trigger in play (slop evidence off,
    // manifest gate off, no pre-merge check paths configured) — proves the sweep's own visit, not some unrelated
    // setting, is what converges the stale reviews cache.
    await upsertPullRequestDetailSyncState(env, {
      repoFullName: "owner/agent-repo",
      pullNumber: 7,
      status: "complete",
      reviewsSyncedAt: "2026-05-01T00:00:00.000Z",
      reviewsInvalidatedAt: "2026-05-02T00:00:00.000Z",
    });
    let reviewsGets = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") {
        return Response.json({ number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      }
      if (url.includes("/pulls/7/files")) return Response.json([]);
      if (url.includes("/pulls/7/reviews")) {
        reviewsGets += 1;
        return Response.json([]);
      }
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-pr", deliveryId: "reviews-stale-selfheal", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

    expect(reviewsGets).toBeGreaterThan(0);
  });

  it("REGRESSION (#2537 second pass): a SILENTLY DROPPED invalidation write (reviewsInvalidatedAt stays null forever) still self-heals via the bounded-age backstop", async () => {
    // The invalidation-marker comparison alone (isReviewsCacheUpToDate) reads "up to date" forever when
    // markPullRequestReviewsInvalidated's write is dropped -- there is no marker to compare a sync timestamp
    // against. Only a bounded-age fallback, independent of the marker, can catch this: an old enough
    // reviewsSyncedAt with NO invalidation recorded at all must still be treated as stale.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 8, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a8" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    // No reviewsInvalidatedAt at all -- the marker comparison alone would read this as permanently up to date.
    await upsertPullRequestDetailSyncState(env, {
      repoFullName: "owner/agent-repo",
      pullNumber: 8,
      status: "complete",
      reviewsSyncedAt: "2026-05-01T00:00:00.000Z",
    });
    let reviewsGets = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (/\/pulls\/8(?:\?|$)/.test(url) && method === "GET") {
        return Response.json({ number: 8, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a8" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      }
      if (url.includes("/pulls/8/files")) return Response.json([]);
      if (url.includes("/pulls/8/reviews")) {
        reviewsGets += 1;
        return Response.json([]);
      }
      if (url.includes("/commits/a8/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a8/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });
    // Far past the 48h bounded-age backstop, well past the 2026-05-01 sync stamp.
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-pr", deliveryId: "reviews-dropped-invalidation-selfheal", repoFullName: "owner/agent-repo", prNumber: 8, installationId: 9001 });

    expect(reviewsGets).toBeGreaterThan(0);
  });

  it("REGRESSION (#2537 follow-up): a failed read of the reviews-cache sync state fails OPEN — the sweep completes without crashing rather than propagating the D1 error", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    await upsertPullRequestDetailSyncState(env, { repoFullName: "owner/agent-repo", pullNumber: 7, status: "complete", reviewsSyncedAt: new Date().toISOString() });
    // mockRejectedValue (not -Once): an earlier getPullRequestDetailSyncState read inside the resync/readiness
    // path runs before this function's own read, so a single -Once rejection could be consumed there instead.
    const syncStateSpy = vi.spyOn(repositoriesModule, "getPullRequestDetailSyncState").mockRejectedValue(new Error("D1 read failed"));
    let reviewsGets = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") {
        return Response.json({ number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      }
      if (url.includes("/pulls/7/files")) return Response.json([]);
      if (url.includes("/pulls/7/reviews")) {
        reviewsGets += 1;
        return Response.json([]);
      }
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await expect(
      processJob(env, { type: "agent-regate-pr", deliveryId: "reviews-syncstate-readfail", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 }),
    ).resolves.toBeUndefined();

    expect(syncStateSpy).toHaveBeenCalled();
    syncStateSpy.mockRestore();
  });

  it("#audit-rate-headroom: auto-maintain falls back to the public token when a post-gate mint fails", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITHUB_PUBLIC_TOKEN: "public-token" });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", approve: "auto", update_branch: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    let gateFinalized = false;
    let failedMaintenanceMint = false;
    let publicFallbackUsed = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const headersText = init?.headers instanceof Headers ? JSON.stringify([...init.headers.entries()]) : JSON.stringify(init?.headers ?? {});
      if (url.includes("/access_tokens")) {
        if (gateFinalized && !failedMaintenanceMint) {
          failedMaintenanceMint = true;
          return new Response("mint failed", { status: 500 });
        }
        return Response.json({ token: "installation-token", expires_at: "2026-05-28T00:04:00.000Z" });
      }
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main", sha: "base" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/a7/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/branches/")) {
        if (gateFinalized && headersText.includes("public-token")) publicFallbackUsed = true;
        return Response.json({ contexts: [] });
      }
      if (url === "https://api.github.com/graphql") return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
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
      return Response.json({});
    });

    await processJob(env, { type: "agent-regate-pr", deliveryId: "dedup-public-token-fallback", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

    expect(failedMaintenanceMint).toBe(true);
    expect(publicFallbackUsed).toBe(true);
  });

  it("#audit-rate-headroom: required-context lookup failures still fetch pending CI before review", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Pending CI", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    const requiredContextsSpy = vi
      .spyOn(backfillModule, "fetchRequiredStatusContexts")
      .mockRejectedValue(new Error("branch protection unavailable"));
    let checkRunsFetched = false;
    let gateChecks = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Pending CI", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/commits/a7/check-runs")) {
        checkRunsFetched = true;
        return Response.json({ total_count: 1, check_runs: [{ name: "CI build", status: "in_progress", conclusion: null, app: { slug: "github-actions" } }] });
      }
      if (url.includes("/commits/a7/status")) return Response.json({ state: "pending", statuses: [] });
      if (url.includes("/check-runs") && method === "POST") {
        gateChecks += 1;
        return Response.json({ id: 901 }, { status: 201 });
      }
      return Response.json({});
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    try {
      await processJob(env, { type: "agent-regate-pr", deliveryId: "ci-required-contexts-fail", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

      expect(requiredContextsSpy).toHaveBeenCalled();
      expect(checkRunsFetched).toBe(true);
      expect(gateChecks).toBe(0);
      const deferred = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
        .bind("github_app.review_deferred_ci_pending")
        .first<{ n: number }>();
      expect(deferred?.n).toBe(1);
    } finally {
      requiredContextsSpy.mockRestore();
    }
  });

  it("keeps deferring when CI is visibly running even after the stale-CI cap", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Still running CI", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    await env.SELFHOST_TRANSIENT_CACHE?.set(
      "ci-pending-first-seen:owner/agent-repo#7:a7",
      String(Date.now() - 31 * 60 * 1000),
      7 * 24 * 3600,
    );
    const requiredContextsSpy = vi
      .spyOn(backfillModule, "fetchRequiredStatusContexts")
      .mockResolvedValue(null);
    let gateChecks = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Still running CI", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/commits/a7/check-runs")) return Response.json({ check_runs: [{ name: "CI / validate-code", status: "in_progress", conclusion: null, app: { slug: "github-actions" } }] });
      if (url.includes("/commits/a7/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs") && method === "POST") {
        gateChecks += 1;
        return Response.json({ id: 901 }, { status: 201 });
      }
      return Response.json({});
    });

    try {
      await processJob(env, { type: "agent-regate-pr", deliveryId: "visible-ci-still-running", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

      expect(gateChecks).toBe(0);
      const deferred = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
        .bind("github_app.review_deferred_ci_pending")
        .first<{ n: number }>();
      const finalized = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
        .bind("github_app.review_finalized_ci_stuck")
        .first<{ n: number }>();
      expect(deferred?.n).toBe(1);
      expect(finalized?.n).toBe(0);
    } finally {
      requiredContextsSpy.mockRestore();
    }
  });

  it("keeps deferring inferred pending CI before the stale-CI cap", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Missing aggregate CI", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    const requiredContextsSpy = vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(null);
    const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
      ciState: "pending",
      hasPending: true,
      hasVisiblePending: false,
      hasMissingRequiredContext: false,
      failingDetails: [],
      nonRequiredFailingDetails: [],
      ciCompletenessWarning: null,
    });
    let gateChecks = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Missing aggregate CI", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/check-runs") && method === "POST") {
        gateChecks += 1;
        return Response.json({ id: 901 }, { status: 201 });
      }
      return Response.json({});
    });

    try {
      await processJob(env, { type: "agent-regate-pr", deliveryId: "fresh-inferred-ci", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

      expect(gateChecks).toBe(0);
      const deferred = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
        .bind("github_app.review_deferred_ci_pending")
        .first<{ n: number }>();
      expect(deferred?.n).toBe(1);
    } finally {
      liveCiSpy.mockRestore();
      requiredContextsSpy.mockRestore();
    }
  });

  it("surfaces stale optional CI after the stale-CI cap", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Stale optional CI", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    await env.SELFHOST_TRANSIENT_CACHE?.set(
      "ci-pending-first-seen:owner/agent-repo#7:a7",
      String(Date.now() - 31 * 60 * 1000),
      7 * 24 * 3600,
    );
    const requiredContextsSpy = vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(new Set(["trusted-required-ci"]));
    const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
      ciState: "passed",
      hasPending: true,
      hasVisiblePending: false,
      hasMissingRequiredContext: false,
      failingDetails: [],
      nonRequiredFailingDetails: [],
      ciCompletenessWarning: null,
    });
    let gateChecks = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Stale optional CI", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/check-runs") && (method === "POST" || method === "PATCH")) {
        gateChecks += 1;
        return Response.json({ id: 901 }, { status: method === "POST" ? 201 : 200 });
      }
      return Response.json({});
    });

    try {
      await processJob(env, { type: "agent-regate-pr", deliveryId: "stale-optional-ci", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

      expect(liveCiSpy).toHaveBeenCalledWith(
        expect.anything(),
        "owner/agent-repo",
        "a7",
        expect.any(String),
        new Set(["trusted-required-ci"]),
        "installation:9001",
      );
      expect(gateChecks).toBeGreaterThan(0);
      const finalized = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
        .bind("github_app.review_finalized_ci_stuck")
        .first<{ n: number }>();
      expect(finalized?.n).toBe(1);
    } finally {
      liveCiSpy.mockRestore();
      requiredContextsSpy.mockRestore();
    }
  });

  it("REGRESSION (#orb-ci-stuck-repeat): re-evaluating the SAME stuck head SHA after it was already finalized once defers instead of paying for another review", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Permanently stuck CI", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    await env.SELFHOST_TRANSIENT_CACHE?.set(
      "ci-pending-first-seen:owner/agent-repo#7:a7",
      String(Date.now() - 31 * 60 * 1000),
      7 * 24 * 3600,
    );
    const requiredContextsSpy = vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(new Set(["trusted-required-ci"]));
    const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
      ciState: "passed",
      hasPending: true,
      hasVisiblePending: false,
      hasMissingRequiredContext: false,
      failingDetails: [],
      nonRequiredFailingDetails: [],
      ciCompletenessWarning: null,
    });
    let gateChecks = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Permanently stuck CI", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/check-runs") && (method === "POST" || method === "PATCH")) {
        gateChecks += 1;
        return Response.json({ id: 901 }, { status: method === "POST" ? 201 : 200 });
      }
      return Response.json({});
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      // First evaluation: CI is stuck past the cap -- this SHOULD finalize and run a real review.
      await processJob(env, { type: "agent-regate-pr", deliveryId: "stuck-ci-eval-1", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });
      expect(gateChecks).toBeGreaterThan(0);
      const gateChecksAfterFirst = gateChecks;
      const finalizedAfterFirst = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
        .bind("github_app.review_finalized_ci_stuck")
        .first<{ n: number }>();
      expect(finalizedAfterFirst?.n).toBe(1);
      const guardAfterFirst = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.review_finalized_ci_stuck_guard", "owner/agent-repo#7#a7")
        .first<{ n: number }>();
      expect(guardAfterFirst?.n).toBe(1);
      expect(errors.mock.calls.some(([line]) => typeof line === "string" && line.includes("ci_stuck_review_repeat_suppressed"))).toBe(false);

      // Second evaluation, same head SHA, CI still stuck: must NOT finalize (and NOT pay for) another review.
      await processJob(env, { type: "agent-regate-pr", deliveryId: "stuck-ci-eval-2", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });
      expect(gateChecks).toBe(gateChecksAfterFirst); // no additional check-run write — no second review ran
      const finalizedAfterSecond = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
        .bind("github_app.review_finalized_ci_stuck")
        .first<{ n: number }>();
      expect(finalizedAfterSecond?.n).toBe(1); // unchanged — guarded, not re-finalized
      const deferred = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.review_deferred_ci_pending", "owner/agent-repo#7")
        .first<{ n: number }>();
      expect(deferred?.n).toBe(1); // the second evaluation deferred instead
      // Sentry-visible signal (via the structured-log forwarder) fires exactly once, on the guarded evaluation.
      const repeatSuppressedLogs = errors.mock.calls.filter(([line]) => typeof line === "string" && line.includes("ci_stuck_review_repeat_suppressed"));
      expect(repeatSuppressedLogs).toHaveLength(1);
      const logged = JSON.parse(repeatSuppressedLogs[0]![0] as string) as Record<string, unknown>;
      expect(logged).toMatchObject({ level: "error", event: "ci_stuck_review_repeat_suppressed", repo: "owner/agent-repo", pullNumber: 7, headSha: "a7" });
    } finally {
      errors.mockRestore();
      liveCiSpy.mockRestore();
      requiredContextsSpy.mockRestore();
    }
  });

  it("REGRESSION (#4998): ci_stuck_review_repeat_suppressed rate-limits its log to once per (repo, pr, headSha) per day -- the defer still runs on every evaluation", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Permanently stuck CI", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    await env.SELFHOST_TRANSIENT_CACHE?.set(
      "ci-pending-first-seen:owner/agent-repo#7:a7",
      String(Date.now() - 31 * 60 * 1000),
      7 * 24 * 3600,
    );
    const requiredContextsSpy = vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(new Set(["trusted-required-ci"]));
    const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
      ciState: "passed",
      hasPending: true,
      hasVisiblePending: false,
      hasMissingRequiredContext: false,
      failingDetails: [],
      nonRequiredFailingDetails: [],
      ciCompletenessWarning: null,
    });
    let liveHeadSha = "a7";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Permanently stuck CI", state: "open", user: { login: "contributor" }, head: { sha: liveHeadSha }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/check-runs") && (method === "POST" || method === "PATCH")) return Response.json({ id: 901 }, { status: method === "POST" ? 201 : 200 });
      return Response.json({});
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      // 1st evaluation: finalizes for real (pays for one review). 2nd: guarded — defers AND logs (the ONE
      // Sentry-visible signal). 3rd: guarded again — defers again, but the log is now within the 24h coalesce
      // window, so it must NOT re-fire.
      await processJob(env, { type: "agent-regate-pr", deliveryId: "stuck-ci-eval-1", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });
      await processJob(env, { type: "agent-regate-pr", deliveryId: "stuck-ci-eval-2", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });
      await processJob(env, { type: "agent-regate-pr", deliveryId: "stuck-ci-eval-3", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

      const deferred = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.review_deferred_ci_pending", "owner/agent-repo#7")
        .first<{ n: number }>();
      expect(deferred?.n).toBe(2); // both the 2nd AND 3rd evaluations deferred -- suppression itself is unchanged
      const repeatSuppressedLogs = errors.mock.calls.filter(([line]) => typeof line === "string" && line.includes("ci_stuck_review_repeat_suppressed"));
      expect(repeatSuppressedLogs).toHaveLength(1); // only the 2nd evaluation's log survives -- the 3rd is coalesced

      // A DIFFERENT head SHA (a new commit) is a fresh key -- its first guarded evaluation must log again, not
      // inherit the previous SHA's coalesce window.
      liveHeadSha = "b7";
      await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Permanently stuck CI", state: "open", user: { login: "contributor" }, head: { sha: "b7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
      await env.SELFHOST_TRANSIENT_CACHE?.set(
        "ci-pending-first-seen:owner/agent-repo#7:b7",
        String(Date.now() - 31 * 60 * 1000),
        7 * 24 * 3600,
      );
      await processJob(env, { type: "agent-regate-pr", deliveryId: "stuck-ci-eval-4", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });
      await processJob(env, { type: "agent-regate-pr", deliveryId: "stuck-ci-eval-5", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });
      const repeatSuppressedLogsAfterNewSha = errors.mock.calls.filter(([line]) => typeof line === "string" && line.includes("ci_stuck_review_repeat_suppressed"));
      expect(repeatSuppressedLogsAfterNewSha).toHaveLength(2); // the new SHA's own guarded evaluation logged once
    } finally {
      errors.mockRestore();
      liveCiSpy.mockRestore();
      requiredContextsSpy.mockRestore();
    }
  });

  it("REGRESSION (#orb-ci-stuck-repeat, fail-open): a failed guard-audit write does not stop the first stuck-CI finalize from running its review", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 8, title: "Permanently stuck CI, audit write fails", state: "open", user: { login: "contributor" }, head: { sha: "b8" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    await env.SELFHOST_TRANSIENT_CACHE?.set(
      "ci-pending-first-seen:owner/agent-repo#8:b8",
      String(Date.now() - 31 * 60 * 1000),
      7 * 24 * 3600,
    );
    const requiredContextsSpy = vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(new Set(["trusted-required-ci"]));
    const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
      ciState: "passed",
      hasPending: true,
      hasVisiblePending: false,
      hasMissingRequiredContext: false,
      failingDetails: [],
      nonRequiredFailingDetails: [],
      ciCompletenessWarning: null,
    });
    let gateChecks = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/8(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 8, title: "Permanently stuck CI, audit write fails", state: "open", user: { login: "contributor" }, head: { sha: "b8" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/8/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/check-runs") && (method === "POST" || method === "PATCH")) {
        gateChecks += 1;
        return Response.json({ id: 902 }, { status: method === "POST" ? 201 : 200 });
      }
      return Response.json({});
    });
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/insert\s+into\s+["`]?audit_events["`]?/i.test(sql)) throw new Error("audit write failed");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;

    try {
      await processJob(env, { type: "agent-regate-pr", deliveryId: "stuck-ci-audit-fail", repoFullName: "owner/agent-repo", prNumber: 8, installationId: 9001 });
      // The guard-audit write (CI_STUCK_FINALIZE_GUARD_EVENT_TYPE) failed silently, but the finalize decision
      // itself (fall through -> return true) is independent of that write's success -- the review still runs.
      expect(gateChecks).toBeGreaterThan(0);
    } finally {
      env.DB.prepare = realPrepare;
      liveCiSpy.mockRestore();
      requiredContextsSpy.mockRestore();
    }
  });

  it("REGRESSION (#orb-ci-stuck-repeat, fail-open): a failed defer-audit write does not stop a guarded repeat evaluation from deferring", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 9, title: "Permanently stuck CI, repeat defer audit write fails", state: "open", user: { login: "contributor" }, head: { sha: "c9" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    await env.SELFHOST_TRANSIENT_CACHE?.set(
      "ci-pending-first-seen:owner/agent-repo#9:c9",
      String(Date.now() - 31 * 60 * 1000),
      7 * 24 * 3600,
    );
    const requiredContextsSpy = vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(new Set(["trusted-required-ci"]));
    const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
      ciState: "passed",
      hasPending: true,
      hasVisiblePending: false,
      hasMissingRequiredContext: false,
      failingDetails: [],
      nonRequiredFailingDetails: [],
      ciCompletenessWarning: null,
    });
    let gateChecks = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/9(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 9, title: "Permanently stuck CI, repeat defer audit write fails", state: "open", user: { login: "contributor" }, head: { sha: "c9" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/9/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/check-runs") && (method === "POST" || method === "PATCH")) {
        gateChecks += 1;
        return Response.json({ id: 903 }, { status: method === "POST" ? 201 : 200 });
      }
      return Response.json({});
    });

    try {
      // First evaluation succeeds normally, establishing the guard row.
      await processJob(env, { type: "agent-regate-pr", deliveryId: "stuck-ci-audit-fail-1", repoFullName: "owner/agent-repo", prNumber: 9, installationId: 9001 });
      expect(gateChecks).toBeGreaterThan(0);
      const gateChecksAfterFirst = gateChecks;

      // Second evaluation is guarded (defers), but its OWN audit write (review_deferred_ci_pending) fails.
      const realPrepare = env.DB.prepare.bind(env.DB);
      env.DB.prepare = ((sql: string) => {
        if (/insert\s+into\s+["`]?audit_events["`]?/i.test(sql)) throw new Error("audit write failed");
        return realPrepare(sql);
      }) as typeof env.DB.prepare;
      try {
        await processJob(env, { type: "agent-regate-pr", deliveryId: "stuck-ci-audit-fail-2", repoFullName: "owner/agent-repo", prNumber: 9, installationId: 9001 });
      } finally {
        env.DB.prepare = realPrepare;
      }
      // Guarded — no additional review ran, despite the defer-audit write itself failing silently.
      expect(gateChecks).toBe(gateChecksAfterFirst);
    } finally {
      liveCiSpy.mockRestore();
      requiredContextsSpy.mockRestore();
    }
  });

  it("surfaces inferred pending CI after the stale-CI cap", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Stale missing aggregate CI", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    await env.SELFHOST_TRANSIENT_CACHE?.set(
      "ci-pending-first-seen:owner/agent-repo#7:a7",
      String(Date.now() - 31 * 60 * 1000),
      7 * 24 * 3600,
    );
    const requiredContextsSpy = vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(null);
    const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
      ciState: "pending",
      hasPending: true,
      hasVisiblePending: false,
      hasMissingRequiredContext: false,
      failingDetails: [],
      nonRequiredFailingDetails: [],
      ciCompletenessWarning: null,
    });
    let gateChecks = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Stale missing aggregate CI", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/check-runs") && (method === "POST" || method === "PATCH")) {
        gateChecks += 1;
        return Response.json({ id: 901 }, { status: method === "POST" ? 201 : 200 });
      }
      return Response.json({});
    });

    try {
      await processJob(env, { type: "agent-regate-pr", deliveryId: "stale-inferred-ci", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

      expect(gateChecks).toBeGreaterThan(0);
      const finalized = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
        .bind("github_app.review_finalized_ci_stuck")
        .first<{ n: number }>();
      expect(finalized?.n).toBe(1);
    } finally {
      liveCiSpy.mockRestore();
      requiredContextsSpy.mockRestore();
    }
  });

  it("keeps deferring a missing-required-context PR within its own short cap (#selfhost-ci-deferral-staleness)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Missing required context, within cap", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    // 1 minute elapsed: under the new 2-minute missing-required-context cap AND under the old 30-minute cap —
    // proves the short cap, not the long one, governs this class.
    await env.SELFHOST_TRANSIENT_CACHE?.set(
      "ci-pending-first-seen:owner/agent-repo#7:a7",
      String(Date.now() - 1 * 60 * 1000),
      7 * 24 * 3600,
    );
    const requiredContextsSpy = vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(null);
    const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
      ciState: "pending",
      hasPending: true,
      hasVisiblePending: false,
      hasMissingRequiredContext: true,
      failingDetails: [],
      nonRequiredFailingDetails: [],
      ciCompletenessWarning: null,
    });
    let gateChecks = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Missing required context, within cap", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/check-runs") && method === "POST") {
        gateChecks += 1;
        return Response.json({ id: 901 }, { status: 201 });
      }
      return Response.json({});
    });

    try {
      await processJob(env, { type: "agent-regate-pr", deliveryId: "missing-context-within-cap", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

      expect(gateChecks).toBe(0);
      const deferred = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
        .bind("github_app.review_deferred_ci_pending")
        .first<{ n: number }>();
      const finalized = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
        .bind("github_app.review_finalized_ci_stuck")
        .first<{ n: number }>();
      expect(deferred?.n).toBe(1);
      expect(finalized?.n).toBe(0);
    } finally {
      liveCiSpy.mockRestore();
      requiredContextsSpy.mockRestore();
    }
  });

  it("keeps deferring a missing-required-context PR after the short surfacing cap (#selfhost-ci-deferral-staleness)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Missing required context, past short cap", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    // 3 minutes elapsed: past the 2-minute missing-required-context surfacing cap, but nowhere near the old
    // 30-minute stale-CI cap. Missing required contexts must still not publish a passing gate before expected CI
    // reports, because the review check may itself be branch-protection-required.
    await env.SELFHOST_TRANSIENT_CACHE?.set(
      "ci-pending-first-seen:owner/agent-repo#7:a7",
      String(Date.now() - 3 * 60 * 1000),
      7 * 24 * 3600,
    );
    const requiredContextsSpy = vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(null);
    const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
      ciState: "pending",
      hasPending: true,
      hasVisiblePending: false,
      hasMissingRequiredContext: true,
      failingDetails: [],
      nonRequiredFailingDetails: [],
      ciCompletenessWarning: null,
    });
    let gateChecks = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Missing required context, past short cap", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/check-runs") && (method === "POST" || method === "PATCH")) {
        gateChecks += 1;
        return Response.json({ id: 901 }, { status: method === "POST" ? 201 : 200 });
      }
      return Response.json({});
    });

    try {
      await processJob(env, { type: "agent-regate-pr", deliveryId: "missing-context-past-short-cap", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

      expect(gateChecks).toBe(0);
      const deferred = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
        .bind("github_app.review_deferred_ci_pending")
        .first<{ n: number }>();
      const finalized = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
        .bind("github_app.review_finalized_ci_stuck")
        .first<{ n: number }>();
      expect(deferred?.n).toBe(1);
      expect(finalized?.n).toBe(0);
    } finally {
      liveCiSpy.mockRestore();
      requiredContextsSpy.mockRestore();
    }
  });

  it("records an informational audit event when the live CI aggregate carries a completeness warning (#2137)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "CI completeness unverified", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    const requiredContextsSpy = vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(null);
    const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
      ciState: "passed",
      hasPending: false,
      hasVisiblePending: false,
      hasMissingRequiredContext: false,
      failingDetails: [],
      nonRequiredFailingDetails: [],
      ciCompletenessWarning: "CI resolved to passed with no branch-protection required checks configured — cannot verify every expected workflow ran.",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "CI completeness unverified", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      return Response.json({});
    });

    try {
      await processJob(env, { type: "agent-regate-pr", deliveryId: "ci-completeness-unverified", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

      const audit = await env.DB.prepare("select outcome, detail, metadata_json from audit_events where event_type = ?").bind("github_app.ci_completeness_unverified").first<{ outcome: string; detail: string; metadata_json: string }>();
      expect(audit?.outcome).toBe("completed"); // informational only — never a denial, never changes the disposition
      expect(audit?.detail).toContain("branch-protection required checks");
      // REGRESSION: deliveryId must actually thread through from maybeRunAgentMaintenance's args down into
      // runAgentMaintenancePlanAndExecute — a prior version referenced args.deliveryId on a type that never
      // declared or received the field (a typecheck break that slipped past CI on the commit that added #2137).
      expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({ deliveryId: "ci-completeness-unverified" });
    } finally {
      liveCiSpy.mockRestore();
      requiredContextsSpy.mockRestore();
    }
  });

  it("does NOT record the CI-completeness audit event when the live CI aggregate carries no warning", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "CI fully verified", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    const requiredContextsSpy = vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(new Set(["trusted-required-ci"]));
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
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "CI fully verified", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      return Response.json({});
    });

    try {
      await processJob(env, { type: "agent-regate-pr", deliveryId: "ci-fully-verified", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

      const audit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.ci_completeness_unverified").first<{ n: number }>();
      expect(audit?.n).toBe(0);
    } finally {
      liveCiSpy.mockRestore();
      requiredContextsSpy.mockRestore();
    }
  });

  describe("linked-issue hard-rule violation persistence (#linked-issue-hard-rule-persistence)", () => {
    // Shared scaffold for both regression tests below: a repo with the owner-assigned hard rule ON and the
    // flag-then-close verify window ON (defaults), autonomy acting on close + review_state_label. Each test
    // drives TWO separate agent-regate-pr passes over the SAME PR/head, changing only what the live GitHub read
    // reports between them -- exactly the two ways resolveLinkedIssueHardRule's own statelessness lets a
    // confirmed Pass-1 violation dodge the Pass-2 close.
    // `linkedIssueHardRules` (unlike most repository settings) has NO backing DB column (src/db/schema.ts) --
    // it is exclusively a `.gittensory.yml`-driven override (settings/repository-settings.ts's default is
    // always the built-in all-off DEFAULT_LINKED_ISSUE_HARD_RULES; only resolveEffectiveSettings's manifest
    // overlay can turn a rule on). So this scaffold enables it via a stubbed `.gittensory.yml` content fetch,
    // not via upsertRepositorySettings.
    const HARD_RULE_MANIFEST = JSON.stringify({ settings: { linkedIssueHardRules: { ownerAssignedClose: "block" } } });

    async function seedHardRuleRepoAndPr(env: ReturnType<typeof createTestEnv>): Promise<void> {
      await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", issues: "write", checks: "write" }, events: [] } });
      await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
      await upsertRepositorySettings(env, {
        repoFullName: "owner/agent-repo",
        autonomy: { close: "auto", review_state_label: "auto" },
        aiReviewMode: "off",
        gatePack: "oss-anti-slop",
        reviewCheckMode: "required",
        checkRunMode: "off",
        commentMode: "off",
        publicSurface: "off",
      });
      await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Ineligible linked issue", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #9" });
    }

    // Stateful label set (mutated by the real ensurePullRequestLabel/removePullRequestLabel POST/DELETE calls,
    // mirroring how a real GitHub repo's label state persists between two separate agent-regate-pr passes) --
    // the `/pulls/7` GET always reflects it, so Pass 2's own live re-sync of the stored PR sees the label Pass 1
    // actually applied, exactly like the real GitHub API would report it. `ruleEnabled` selects whether the
    // stubbed `.gittensory.yml` fetch turns the owner-assigned hard rule on (the two regression tests) or
    // resolves to a genuine 404 -- i.e. the rule genuinely OFF (the sanity-check test).
    function stubHardRuleFetch(liveLabels: string[], opts: { prBody: string; issueState: string; issueAssignees: string[]; ruleEnabled: boolean }) {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Ineligible linked issue", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: liveLabels.map((name) => ({ name })), body: opts.prBody });
        if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.includes("/issues/9") && method === "GET") return Response.json({ number: 9, state: opts.issueState, labels: [], assignees: opts.issueAssignees.map((login) => ({ login })), user: { login: "reporter" } });
        if (url.includes("/issues/7/labels") && method === "GET") return Response.json(liveLabels.map((name) => ({ name })));
        if (url.includes("/issues/7/labels") && method === "POST") {
          const body = init?.body ? (JSON.parse(String(init.body)) as { labels?: string[] }) : {};
          for (const label of body.labels ?? []) if (!liveLabels.includes(label)) liveLabels.push(label);
          return Response.json(liveLabels.map((name) => ({ name })), { status: 200 });
        }
        if (url.includes("/labels/") && method === "DELETE") {
          const removed = decodeURIComponent(url.slice(url.lastIndexOf("/labels/") + "/labels/".length));
          const index = liveLabels.indexOf(removed);
          if (index >= 0) liveLabels.splice(index, 1);
          return new Response(null, { status: 204 });
        }
        // The `.gittensory.yml`/`.json` content fetch (raw.githubusercontent.com) is the ONLY place
        // linkedIssueHardRules can be turned on (see the comment above).
        if (url.includes("raw.githubusercontent.com")) return opts.ruleEnabled ? new Response(HARD_RULE_MANIFEST, { status: 200 }) : new Response("not found", { status: 404 });
        return Response.json({});
      });
    }

    const requiredContextsMock = () => vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(null);
    const liveCiMock = () =>
      vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
        ciState: "passed",
        hasPending: false,
        hasVisiblePending: false,
        hasMissingRequiredContext: false,
        failingDetails: [],
        nonRequiredFailingDetails: [],
        ciCompletenessWarning: null,
      });

    it("REGRESSION (body-edit-during-grace-window): Pass 1 flags a real owner-assigned violation; Pass 2's live re-parse finds NO linked issues (body edited) but the persisted violation still closes the PR", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedHardRuleRepoAndPr(env);
      const requiredContextsSpy = requiredContextsMock();
      const liveCiSpy = liveCiMock();
      const liveLabels: string[] = [];
      try {
        // Pass 1: body links #9, issue #9 is genuinely assigned to the repo owner -> a REAL violation. Verify-
        // before-close is on by default, so this pass FLAGS (pending-closure label) and does not close yet.
        stubHardRuleFetch(liveLabels, { prBody: "Closes #9", issueState: "open", issueAssignees: ["owner"], ruleEnabled: true });
        await processJob(env, { type: "agent-regate-pr", deliveryId: "hard-rule-pass-1", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

        const afterPass1 = await getPullRequest(env, "owner/agent-repo", 7);
        expect(afterPass1?.state).toBe("open"); // flagged, not closed yet
        // The label MUTATION itself is asserted via the executor's own audit trail, not the DB's cached
        // labels_json -- that cache is only refreshed by the NEXT sync (reReviewStoredPullRequest resyncs at
        // the START of a pass, so a label applied DURING this pass isn't reflected in labels_json until the
        // following pass reads it back from the live GitHub state, which stubHardRuleFetch's liveLabels does).
        const flagAudit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? and detail like ? order by rowid desc limit 1").bind("agent.action.label", "%linked-issue hard rule%").first<{ outcome: string; detail: string }>();
        expect(flagAudit?.outcome).toBe("completed");
        expect(liveLabels).toContain(AGENT_LABEL_PENDING_CLOSURE);
        // The confirmed Pass-1 violation must already be persisted -- this is the fact Pass 2 depends on.
        expect(afterPass1?.linkedIssueHardRuleViolatedAt).toEqual(expect.any(String));
        expect(afterPass1?.linkedIssueHardRuleViolationReason).toContain("#9");

        // Between passes: GitHub echoes the Pass-1 label mutation back as its own `labeled` webhook in real
        // operation, which the normal PR-sync path (upsertPullRequestFromGitHub) writes into labels_json --
        // reReviewStoredPullRequest's OWN resync only re-fetches on a head-SHA change (#sweep-resync), so it
        // does not carry a same-pass label mutation forward on its own. Simulate that already-processed sync
        // directly (same head, only the label list changed) rather than re-deriving the whole webhook pipeline.
        await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Ineligible linked issue", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: liveLabels.map((name) => ({ name })), body: "Closes #9" });

        // Pass 2: the contributor edited the PR body during the grace window to remove the closing reference.
        // The live re-parse now sees ZERO linked issues, so resolveLinkedIssueHardRule alone would return
        // undefined -- WITHOUT the persisted-violation backstop, clearLinkedIssueFlag would remove the
        // pending-closure label and the PR would survive with the flag silently cleared.
        stubHardRuleFetch(liveLabels, { prBody: "no more linked issue here", issueState: "open", issueAssignees: ["owner"], ruleEnabled: true });
        await processJob(env, { type: "agent-regate-pr", deliveryId: "hard-rule-pass-2-body-edited", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

        // The disposition planner's `close` action is the observable proof the persisted violation was enforced
        // (the executor's own closePullRequest mutation succeeds against GitHub directly; the PR row's `state`
        // column only flips to "closed" once GitHub's OWN `closed` webhook round-trips back through the normal
        // sync path -- a separate delivery this two-pass sweep test does not simulate, mirroring the identical
        // gap for labels_json handled above).
        const close = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? order by rowid desc limit 1").bind("agent.action.close").first<{ outcome: string; detail: string }>();
        expect(close?.outcome).toBe("completed");
        expect(close?.detail).toContain("#9");
        // WITHOUT the persisted-violation backstop this pass's live re-parse (undefined -- zero linked issues)
        // would have cleared the pending-closure flag instead: confirm that never happened.
        const clearedFlag = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and detail like ?").bind("agent.action.label", "%resolved%").first<{ n: number }>();
        expect(clearedFlag?.n).toBe(0);
      } finally {
        liveCiSpy.mockRestore();
        requiredContextsSpy.mockRestore();
      }
    });

    it("REGRESSION (live-issue-state-change-before-re-evaluation): Pass 1 flags a real violation; Pass 2's live re-parse re-evaluates the SAME issue as clean (assignee removed) but the persisted violation still closes the PR", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedHardRuleRepoAndPr(env);
      const requiredContextsSpy = requiredContextsMock();
      const liveCiSpy = liveCiMock();
      const liveLabels: string[] = [];
      try {
        // Pass 1: same real owner-assigned violation as the sibling test above -> FLAGS, does not close.
        stubHardRuleFetch(liveLabels, { prBody: "Closes #9", issueState: "open", issueAssignees: ["owner"], ruleEnabled: true });
        await processJob(env, { type: "agent-regate-pr", deliveryId: "hard-rule-live-pass-1", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

        const afterPass1 = await getPullRequest(env, "owner/agent-repo", 7);
        expect(afterPass1?.state).toBe("open");
        const flagAudit = await env.DB.prepare("select outcome from audit_events where event_type = ? and detail like ? order by rowid desc limit 1").bind("agent.action.label", "%linked-issue hard rule%").first<{ outcome: string }>();
        expect(flagAudit?.outcome).toBe("completed");
        expect(liveLabels).toContain(AGENT_LABEL_PENDING_CLOSURE);
        expect(afterPass1?.linkedIssueHardRuleViolatedAt).toEqual(expect.any(String));

        // Between passes: GitHub echoes the Pass-1 label mutation back as its own `labeled` webhook in real
        // operation (see the sibling test's identical comment for the full rationale).
        await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Ineligible linked issue", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: liveLabels.map((name) => ({ name })), body: "Closes #9" });

        // Pass 2: the PR body is UNCHANGED (still "Closes #9"), but issue #9's LIVE state changed between passes
        // -- the owner was unassigned. The live re-parse re-evaluates the SAME issue number cleanly
        // ({ violated: false }), indistinguishable from "never violated" to resolveLinkedIssueHardRule alone.
        // WITHOUT the persisted-violation backstop, clearLinkedIssueFlag would remove the flag and the PR
        // would survive.
        stubHardRuleFetch(liveLabels, { prBody: "Closes #9", issueState: "open", issueAssignees: [], ruleEnabled: true });
        await processJob(env, { type: "agent-regate-pr", deliveryId: "hard-rule-live-pass-2-unassigned", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

        // See the sibling test's identical comment: the `close` action's own audit outcome is the observable
        // proof (the PR row's `state` column only flips once GitHub's `closed` webhook round-trips back).
        const close = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? order by rowid desc limit 1").bind("agent.action.close").first<{ outcome: string; detail: string }>();
        expect(close?.outcome).toBe("completed");
        expect(close?.detail).toContain("#9");
        const clearedFlag = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and detail like ?").bind("agent.action.label", "%resolved%").first<{ n: number }>();
        expect(clearedFlag?.n).toBe(0);
      } finally {
        liveCiSpy.mockRestore();
        requiredContextsSpy.mockRestore();
      }
    });

    it("does not persist anything (and Pass 2 clears the flag normally) when the violation is GENUINELY resolved before it was ever confirmed", async () => {
      // Sanity check / non-regression: a hard rule that is OFF (never violates at all) must not write the
      // persisted marker, and the plan/label state must stay byte-identical to today's pre-existing behavior.
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", issues: "write", checks: "write" }, events: [] } });
      await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
      await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { close: "auto", review_state_label: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
      await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "No hard rule enabled", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #9" });
      const requiredContextsSpy = requiredContextsMock();
      const liveCiSpy = liveCiMock();
      try {
        stubHardRuleFetch([], { prBody: "Closes #9", issueState: "open", issueAssignees: ["owner"], ruleEnabled: false });
        await processJob(env, { type: "agent-regate-pr", deliveryId: "hard-rule-off", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

        const after = await getPullRequest(env, "owner/agent-repo", 7);
        expect(after?.state).toBe("open");
        expect(after?.labels ?? []).not.toContain(AGENT_LABEL_PENDING_CLOSURE);
        expect(after?.linkedIssueHardRuleViolatedAt).toBeNull();
      } finally {
        liveCiSpy.mockRestore();
        requiredContextsSpy.mockRestore();
      }
    });
  });

  describe("durable CI-state snapshot cache (#selfhost-ci-verification, cross-job)", () => {
    async function seedRepoAndPr(headSha: string): Promise<{ env: ReturnType<typeof createTestEnv> }> {
      // GITTENSORY_REVIEW_REPOS (review/cutover-gate.ts) gates maybeReReviewOnCiCompletion's whole invalidation
      // loop -- an unlisted repo leaves the durable cache never invalidated by a check_run/check_suite webhook,
      // relying solely on the 60s TTL. Must be allowlisted for the invalidation tests below to be meaningful.
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/agent-repo" });
      await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
      await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
      // isAgentConfigured (settings/autonomy.ts) requires at least one ACTING autonomy class before
      // prReadyForReview even reaches the live CI read (processors.ts's readiness short-circuits to `true`,
      // skipping cachedLiveCiAggregate entirely, when no class is "auto"/"auto_with_approval") -- so this can't
      // be omitted or left fully "observe" the way a non-CI-cache test could. `auto_with_approval` (not `auto`)
      // keeps both passes comparable: it satisfies isAgentConfigured, but the action executor STAGES the merge
      // for approval instead of ever calling the GitHub merge endpoint, so the PR stays open with the same
      // head_sha across both passes.
      await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto_with_approval", update_branch: "auto_with_approval" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
      await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Cross-job CI cache", state: "open", user: { login: "contributor" }, head: { sha: headSha }, base: { ref: "main" }, labels: [], body: "Closes #1" });
      return { env };
    }

    it("a fresh but undeserializable cached row (corrupted JSON) is treated as a miss, not a crash", async () => {
      const { env } = await seedRepoAndPr("a7");
      // Fresh by isCiStateCacheFresh's own contract (matching head_sha, matching -- here absent -- required-
      // contexts key, recent ciStateFetchedAt), but ciFailingDetailsJson is malformed, so
      // deserializeCachedCiAggregate's JSON.parse throws and it returns null -- the `if (deserialized)` false arm.
      await upsertPullRequestDetailSyncState(env, {
        repoFullName: "owner/agent-repo",
        pullNumber: 7,
        status: "complete",
        ciHeadSha: "a7",
        ciState: "passed",
        ciHasPending: false,
        ciHasVisiblePending: false,
        ciHasMissingRequiredContext: false,
        ciFailingDetailsJson: "not-json",
        ciNonRequiredFailingDetailsJson: "[]",
        ciCompletenessWarning: null,
        ciRequiredContextsKey: "",
        ciStateFetchedAt: new Date().toISOString(),
      });
      const requiredContextsSpy = vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(null);
      const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
        ciState: "failed",
        hasPending: false,
        hasVisiblePending: false,
        hasMissingRequiredContext: false,
        failingDetails: [],
        nonRequiredFailingDetails: [],
        ciCompletenessWarning: null,
      });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Cross-job CI cache", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
        if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        return Response.json({});
      });

      try {
        resetMetrics();
        await expect(
          processJob(env, { type: "agent-regate-pr", deliveryId: "corrupted-cache-row", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 }),
        ).resolves.toBeUndefined();
        expect(liveCiSpy).toHaveBeenCalled();
        // No "hit" recorded -- the corrupted row was NOT trusted; the live-fetched aggregate overwrote it.
        expect(await renderMetrics()).not.toContain('gittensory_ci_state_cache_total{field="aggregate",result="hit"}');
        expect(await getPullRequestDetailSyncState(env, "owner/agent-repo", 7)).toMatchObject({ ciState: "failed", ciFailingDetailsJson: "[]" });
      } finally {
        liveCiSpy.mockRestore();
        requiredContextsSpy.mockRestore();
      }
    });

    it("a second agent-regate-pr pass for the SAME still-settled head_sha serves the readiness check from the durable cache (fewer live CI reads than the first pass)", async () => {
      const { env } = await seedRepoAndPr("a7");
      const requiredContextsSpy = vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(null);
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
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Cross-job CI cache", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
        if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        return Response.json({});
      });

      try {
        resetMetrics();
        // Pass 1: cold. Readiness's cachedLiveCiAggregate misses (nothing cached yet); the disposition planner's
        // refreshLiveCiAggregate always forces a live read regardless. Both write through the same durable row.
        await processJob(env, { type: "agent-regate-pr", deliveryId: "cross-job-pass-1", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });
        const callsAfterPass1 = liveCiSpy.mock.calls.length;
        expect(callsAfterPass1).toBeGreaterThan(0);
        expect(await renderMetrics()).toContain('gittensory_ci_state_cache_total{field="aggregate",result="miss"} 1');
        expect(await renderMetrics()).toContain('gittensory_ci_state_cache_total{field="aggregate",result="forced"} 1');

        // Pass 2: SAME PR, SAME head_sha, no invalidating webhook in between. Readiness's cachedLiveCiAggregate
        // now HITS the row pass 1's disposition planner wrote through -- one fewer live call than pass 1, even
        // though the disposition planner's OWN refreshLiveCiAggregate still forces a fresh read every time.
        await processJob(env, { type: "agent-regate-pr", deliveryId: "cross-job-pass-2", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });
        const callsDuringPass2 = liveCiSpy.mock.calls.length - callsAfterPass1;
        expect(callsDuringPass2).toBeLessThan(callsAfterPass1);
        expect(await renderMetrics()).toContain('gittensory_ci_state_cache_total{field="aggregate",result="hit"} 1');
        // The disposition planner's forced refresh fired again on pass 2 too (now 2 total across both passes).
        expect(await renderMetrics()).toContain('gittensory_ci_state_cache_total{field="aggregate",result="forced"} 2');
      } finally {
        liveCiSpy.mockRestore();
        requiredContextsSpy.mockRestore();
      }
    });

    it("a check_run completed webhook invalidates the durable cache, forcing the NEXT readiness check to miss again", async () => {
      const { env } = await seedRepoAndPr("a7");
      const requiredContextsSpy = vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(null);
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
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Cross-job CI cache", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
        if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        return Response.json({});
      });

      try {
        resetMetrics();
        await processJob(env, { type: "agent-regate-pr", deliveryId: "invalidate-pass-1", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });
        expect(await renderMetrics()).toContain('gittensory_ci_state_cache_total{field="aggregate",result="miss"} 1');
        // The durable row now has a fresh ciState, well within the 60s TTL.
        expect(await getPullRequestDetailSyncState(env, "owner/agent-repo", 7)).toMatchObject({ ciState: "passed" });

        // maybeReReviewOnCiCompletion invalidates THEN (unless coalesced) immediately re-reviews the same PR --
        // so a naive "row is null right after the webhook" assertion is a race against that same job's own
        // re-review repopulating it. Pre-claim the ci-coalesce window (mirrors the existing technique above at
        // "ci-coalesce:owner/agent-repo#7") so this delivery's own re-review is skipped, leaving the
        // invalidation's null state directly observable rather than immediately overwritten.
        await env.SELFHOST_TRANSIENT_CACHE?.set("ci-coalesce:owner/agent-repo#7", "1", 60);
        await processJob(env, {
          type: "github-webhook",
          deliveryId: "check-run-completed",
          eventName: "check_run",
          payload: {
            action: "completed",
            repository: { name: "agent-repo", full_name: "owner/agent-repo", owner: { login: "owner" } },
            installation: { id: 9001 },
            check_run: { head_sha: "a7", pull_requests: [{ number: 7 }] },
          },
        } as never);

        expect(await getPullRequestDetailSyncState(env, "owner/agent-repo", 7)).toMatchObject({ ciState: null, ciStateFetchedAt: null });

        // A subsequent readiness check misses again -- proving invalidation, not just a coincidental TTL expiry.
        resetMetrics();
        await processJob(env, { type: "agent-regate-pr", deliveryId: "invalidate-pass-2", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });
        expect(await renderMetrics()).toContain('gittensory_ci_state_cache_total{field="aggregate",result="miss"} 1');
      } finally {
        liveCiSpy.mockRestore();
        requiredContextsSpy.mockRestore();
      }
    });

    it("a failing cache invalidation write does not crash the check_run webhook's re-review (best-effort, fail-open)", async () => {
      const { env } = await seedRepoAndPr("a7");
      const requiredContextsSpy = vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(null);
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
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Cross-job CI cache", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
        if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        return Response.json({});
      });
      // invalidateCiStateCache's OWN read already fails open internally; this instead breaks its WRITE (the one
      // call the function does not itself wrap in a .catch), so the coverage that matters here is the CALL SITE's
      // own .catch(() => undefined) in maybeReReviewOnCiCompletion (processors.ts) -- one bad invalidation write
      // must never crash the webhook job or block the coalesced re-review that follows it in the same loop body.
      const upsertSyncStateSpy = vi.spyOn(repositoriesModule, "upsertPullRequestDetailSyncState").mockRejectedValueOnce(new Error("D1 write failed"));

      try {
        await expect(
          processJob(env, {
            type: "github-webhook",
            deliveryId: "check-run-invalidate-write-fails",
            eventName: "check_run",
            payload: {
              action: "completed",
              repository: { name: "agent-repo", full_name: "owner/agent-repo", owner: { login: "owner" } },
              installation: { id: 9001 },
              check_run: { head_sha: "a7", pull_requests: [{ number: 7 }] },
            },
          } as never),
        ).resolves.toBeUndefined();
        // The re-review after the failed invalidation still ran and wrote its own fresh entry.
        expect(await getPullRequestDetailSyncState(env, "owner/agent-repo", 7)).toMatchObject({ ciState: "passed" });
      } finally {
        upsertSyncStateSpy.mockRestore();
        liveCiSpy.mockRestore();
        requiredContextsSpy.mockRestore();
      }
    });

    it("REGRESSION (#selfhost-ci-verification gate review): a swallowed branch-protection read failure never writes the fail-open aggregate through to the durable cache", async () => {
      const { env } = await seedRepoAndPr("a7");
      const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
        ciState: "passed",
        hasPending: false,
        hasVisiblePending: false,
        hasMissingRequiredContext: false,
        failingDetails: [],
        nonRequiredFailingDetails: [],
        ciCompletenessWarning: null,
      });
      let branchProtectionReadable = false;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.includes("/branches/main/protection/required_status_checks")) {
          return branchProtectionReadable ? Response.json({ contexts: ["trusted-required-ci"], checks: [] }) : new Response("forbidden", { status: 403 });
        }
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Cross-job CI cache", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
        if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        return Response.json({});
      });

      try {
        // This pass's OWN decision still uses the live-fetched (fail-open) aggregate normally -- only the
        // DURABLE cache write is skipped, so a transient required-context lookup error can't poison what every
        // OTHER reader sees for the rest of the TTL.
        await expect(
          processJob(env, { type: "agent-regate-pr", deliveryId: "required-contexts-lookup-fails", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 }),
        ).resolves.toBeUndefined();
        const liveReadsAfterFailedLookup = liveCiSpy.mock.calls.length;
        expect(liveReadsAfterFailedLookup).toBeGreaterThan(0);

        // Nothing was ever persisted under this PR's row -- ciState stays absent, not the fail-open "passed".
        const row = await getPullRequestDetailSyncState(env, "owner/agent-repo", 7);
        expect(row?.ciState ?? null).toBeNull();

        // A subsequent pass (required-context lookup now succeeds) still correctly misses the cache and re-fetches
        // live -- proving the earlier failed pass left no stale/poisoned entry behind for this reader either.
        branchProtectionReadable = true;
        resetMetrics();
        await processJob(env, { type: "agent-regate-pr", deliveryId: "required-contexts-lookup-recovers", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });
        expect(liveCiSpy.mock.calls.length).toBeGreaterThan(liveReadsAfterFailedLookup);
        expect(await renderMetrics()).toContain('gittensory_ci_state_cache_total{field="aggregate",result="miss"} 1');
        expect(await getPullRequestDetailSyncState(env, "owner/agent-repo", 7)).toMatchObject({ ciState: "passed", ciRequiredContextsKey: JSON.stringify(["trusted-required-ci"]) });
      } finally {
        liveCiSpy.mockRestore();
      }
    });

    // #selfhost-ci-verification gate review finding: status/workflow_run events still aren't wired to
    // RE-REVIEW TRIGGERING (see maybeReReviewOnCiCompletion's own doc comment -- that stays out of scope), but
    // they now invalidate the durable CI-state cache directly via maybeInvalidateCiCacheOnLegacyCiEvent so a
    // tracked PR's next reader within the TTL doesn't see a stale pre-transition aggregate.
    it.each([
      ["status", (sha: string) => ({ state: "success", sha, repository: { name: "agent-repo", full_name: "owner/agent-repo", owner: { login: "owner" } }, installation: { id: 9001 } })],
      ["workflow_run", (sha: string) => ({ action: "completed", workflow_run: { head_sha: sha }, repository: { name: "agent-repo", full_name: "owner/agent-repo", owner: { login: "owner" } }, installation: { id: 9001 } })],
    ] as const)("a %s webhook event invalidates the durable CI-state cache for a tracked PR at the matching head SHA", async (eventName, buildPayload) => {
      const { env } = await seedRepoAndPr("a7");
      const requiredContextsSpy = vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(null);
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
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Cross-job CI cache", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
        if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        return Response.json({});
      });

      try {
        await processJob(env, { type: "agent-regate-pr", deliveryId: "legacy-ci-cache-seed", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });
        expect(await getPullRequestDetailSyncState(env, "owner/agent-repo", 7)).toMatchObject({ ciState: "passed" });

        await processJob(env, {
          type: "github-webhook",
          deliveryId: `${eventName}-event`,
          eventName,
          payload: buildPayload("a7"),
        } as never);

        // Invalidated -- ciState is cleared to null, not left at the stale pre-transition "passed".
        expect(await getPullRequestDetailSyncState(env, "owner/agent-repo", 7)).toMatchObject({ ciState: null, ciStateFetchedAt: null });
      } finally {
        liveCiSpy.mockRestore();
        requiredContextsSpy.mockRestore();
      }
    });

    it("a status/workflow_run webhook missing repository or installation info invalidates nothing (fails open, does not throw)", async () => {
      const { env } = await seedRepoAndPr("a7");
      await upsertPullRequestDetailSyncState(env, { repoFullName: "owner/agent-repo", pullNumber: 7, status: "complete", ciHeadSha: "a7", ciState: "passed", ciStateFetchedAt: new Date().toISOString(), ciRequiredContextsKey: "" });
      await expect(
        processJob(env, {
          type: "github-webhook",
          deliveryId: "status-no-installation",
          eventName: "status",
          payload: { state: "success", sha: "a7", repository: { name: "agent-repo", full_name: "owner/agent-repo", owner: { login: "owner" } } },
        } as never),
      ).resolves.toBeUndefined();
      // No installation on the payload -- the function bails before ever consulting the cache.
      expect(await getPullRequestDetailSyncState(env, "owner/agent-repo", 7)).toMatchObject({ ciState: "passed" });
    });

    it.each([
      ["status", { state: "success", repository: { name: "agent-repo", full_name: "owner/agent-repo", owner: { login: "owner" } }, installation: { id: 9001 } }],
      ["workflow_run", { action: "completed", workflow_run: {}, repository: { name: "agent-repo", full_name: "owner/agent-repo", owner: { login: "owner" } }, installation: { id: 9001 } }],
    ] as const)("a %s webhook with no sha/head_sha on the payload invalidates nothing", async (eventName, payload) => {
      const { env } = await seedRepoAndPr("a7");
      await upsertPullRequestDetailSyncState(env, { repoFullName: "owner/agent-repo", pullNumber: 7, status: "complete", ciHeadSha: "a7", ciState: "passed", ciStateFetchedAt: new Date().toISOString(), ciRequiredContextsKey: "" });
      await expect(
        processJob(env, { type: "github-webhook", deliveryId: `${eventName}-no-sha`, eventName, payload } as never),
      ).resolves.toBeUndefined();
      expect(await getPullRequestDetailSyncState(env, "owner/agent-repo", 7)).toMatchObject({ ciState: "passed" });
    });

    it("a status webhook for a DIFFERENT head SHA than any open PR invalidates nothing (loop's non-matching arm)", async () => {
      const { env } = await seedRepoAndPr("a7");
      await upsertPullRequestDetailSyncState(env, { repoFullName: "owner/agent-repo", pullNumber: 7, status: "complete", ciHeadSha: "a7", ciState: "passed", ciStateFetchedAt: new Date().toISOString(), ciRequiredContextsKey: "" });
      await expect(
        processJob(env, {
          type: "github-webhook",
          deliveryId: "status-unmatched-sha",
          eventName: "status",
          payload: { state: "success", sha: "different-sha", repository: { name: "agent-repo", full_name: "owner/agent-repo", owner: { login: "owner" } }, installation: { id: 9001 } },
        } as never),
      ).resolves.toBeUndefined();
      // The tracked PR's own head_sha ("a7") doesn't match this event's sha -- the loop's continue arm fires,
      // and its cache entry is left untouched.
      expect(await getPullRequestDetailSyncState(env, "owner/agent-repo", 7)).toMatchObject({ ciState: "passed" });
    });
  });

  // #selfhost-ci-verification: settings.expectedCiContexts must actually change the live-CI disposition, not just
  // get threaded through as an inert parameter. Branch protection is unreadable (empty) on BOTH calls, so without
  // expectedCiContexts folded into mergeRequiredCiContexts every check-run folds to "passed" (fold-all); WITH
  // expectedCiContexts naming a context that never appears in check-runs, mergeRequiredCiContexts makes it the
  // SOLE required context and reduceLiveCiAggregate's "a required context that never appeared is not safe to
  // treat as passed" rule (backfill.ts) forces ciState to "pending" — deferring the review before auto-maintain
  // ever runs. Two full processJob passes (each gets its own request-scoped LiveGithubFacts, so this is a
  // same-repo/baseRef/headSha comparison of the MERGED outcome, not a same-cache-hit test) prove the config is
  // live, not stale/ignored.
  it("REGRESSION (#selfhost-ci-verification): expectedCiContexts turns an otherwise-passing fold-all CI aggregate into a deferred pending review", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Fold-all vs configured", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    let branchProtectionGets = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Fold-all vs configured", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      // Neither call's check-runs/status ever mentions "required-build" — only expectedCiContexts makes that matter.
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "lint", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      // Branch protection unreadable on both calls — expectedCiContexts is the ONLY source of a required context.
      if (url.includes("/branches/")) {
        branchProtectionGets += 1;
        return new Response("forbidden", { status: 403 });
      }
      return Response.json({});
    });

    // Call A: no expectedCiContexts configured — fold-all mode, nothing pending, review proceeds normally.
    await processJob(env, { type: "agent-regate-pr", deliveryId: "no-expected-contexts", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });
    const deferredBefore = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and metadata_json like ?")
      .bind("github_app.review_deferred_ci_pending", '%"no-expected-contexts"%')
      .first<{ n: number }>();
    expect(deferredBefore?.n).toBe(0);
    expect(branchProtectionGets).toBe(1);

    // Config change: gate.expectedCiContexts now names a context absent from every check-run/status above.
    await upsertRepoFocusManifest(env, "owner/agent-repo", { gate: { expectedCiContexts: ["required-build"] } });

    // Call B: SAME repo/baseRef/headSha/check-run state — only settings.expectedCiContexts changed.
    await processJob(env, { type: "agent-regate-pr", deliveryId: "with-expected-contexts", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

    // The branch-protection endpoint was fetched again for call B (a fresh per-job LiveGithubFacts always misses),
    // proving the merged result was actually RE-DERIVED against the new config rather than reused from call A.
    expect(branchProtectionGets).toBe(2);
    const deferredAfter = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and metadata_json like ?")
      .bind("github_app.review_deferred_ci_pending", '%"with-expected-contexts"%')
      .first<{ n: number }>();
    // "required-build" never appears in check-runs/status ⇒ mergeRequiredCiContexts(null, ["required-build"]) makes
    // it the sole required context ⇒ reduceLiveCiAggregate treats the unseen required context as pending ⇒
    // prReadyForReview defers BEFORE auto-maintain runs — the opposite disposition of call A on identical CI data.
    expect(deferredAfter?.n).toBe(1);
  });

  // #selfhost-ci-verification: within a SINGLE processJob pass, cachedRequiredStatusContexts is reached from THREE
  // call sites sharing one request-scoped LiveGithubFacts — prReadyForReview (via cachedLiveCiAggregate),
  // maybePublishPrPublicSurface (via refreshLiveCiAggregate), and runAgentMaintenancePlanAndExecute (directly, and
  // again via refreshLiveCiAggregate). All three now fold expectedCiContextsKeyPart(settings.expectedCiContexts)
  // into their cache key. Since settings is resolved ONCE per job, expectedCiContexts is constant across the three
  // call sites within this one pass — this proves folding it into the key did NOT reintroduce a redundant fetch:
  // the branch-protection endpoint is still hit exactly once for the whole job, exactly like before expectedCiContexts
  // existed (see the sibling "#audit-rate-headroom: the per-PR re-review refreshes..." dedup test above).
  it("REGRESSION (#selfhost-ci-verification): expectedCiContexts in the cache key does not defeat within-job required-contexts memoization", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "squash" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Configured + clean", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    await upsertPullRequestDetailSyncState(env, { repoFullName: "owner/agent-repo", pullNumber: 7, status: "complete", reviewsSyncedAt: new Date().toISOString() });
    // gate.expectedCiContexts is satisfied by a real, passing check-run — so CI resolves cleanly and the pass
    // proceeds all the way through readiness, public-surface publish, AND auto-maintain (unlike the deferred-pending
    // test above, which deliberately stops at readiness to prove the disposition changes).
    await upsertRepoFocusManifest(env, "owner/agent-repo", { gate: { expectedCiContexts: ["required-build"] } });
    let branchProtectionGets = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Configured + clean", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "required-build", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) {
        branchProtectionGets += 1;
        return new Response("forbidden", { status: 403 });
      }
      return Response.json({});
    });

    await processJob(env, { type: "agent-regate-pr", deliveryId: "configured-memoized", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

    // One fetch for the whole job despite three internal call sites sharing the config-aware cache key.
    expect(branchProtectionGets).toBe(1);
    const deferred = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
      .bind("github_app.review_deferred_ci_pending")
      .first<{ n: number }>();
    expect(deferred?.n).toBe(0);
  });

  // REGRESSION (#selfhost-ci-verification): the DURABLE cross-job CI-state cache row must be keyed on the actual
  // RESOLVED required-contexts set (mergeRequiredCiContexts' output: live branch-protection contexts unioned with
  // settings.expectedCiContexts), not on the raw, unresolved expectedCiContexts config alone. Branch protection can
  // change server-side (a maintainer adds a required check in GitHub's UI) while expectedCiContexts config stays
  // put and the head_sha is unchanged -- if the durable row were keyed only on the config, the readiness path would
  // keep serving a stale aggregate computed against the OLD required-context set for up to the 60s TTL, producing a
  // wrong merge/close verdict. Two processJob passes at the SAME head_sha, same unchanged expectedCiContexts config,
  // but DIFFERENT branch-protection required contexts between them, must each independently reach a live CI read
  // (both misses) and each persist their OWN ciRequiredContextsKey -- proving the key tracks the resolved set.
  it("REGRESSION (#selfhost-ci-verification): the durable CI-state cache keys on the RESOLVED required-contexts set, not the raw expectedCiContexts config", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Branch protection drift", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    // expectedCiContexts is configured ONCE and never changes across the two calls below -- only branch protection
    // (the OTHER input to mergeRequiredCiContexts) drifts between them.
    await upsertRepoFocusManifest(env, "owner/agent-repo", { gate: { expectedCiContexts: ["lint"] } });
    let requiredContextsFromBranchProtection: Array<string | null> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Branch protection drift", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "lint", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ contexts: requiredContextsFromBranchProtection });
      return Response.json({});
    });

    // Pass 1: branch protection requires nothing extra beyond expectedCiContexts's own "lint" -- the resolved set
    // is exactly {"lint"}, satisfied by the check-run above, so CI resolves and the durable row's key reflects it.
    requiredContextsFromBranchProtection = [];
    await processJob(env, { type: "agent-regate-pr", deliveryId: "branch-protection-before", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });
    const rowAfterPass1 = await getPullRequestDetailSyncState(env, "owner/agent-repo", 7);
    expect(rowAfterPass1?.ciState).toBe("passed");
    const keyAfterPass1 = rowAfterPass1?.ciRequiredContextsKey ?? null;

    // A maintainer now adds "required-build" as a branch-protection required check via GitHub's UI -- the SAME
    // head_sha, the SAME (unchanged) expectedCiContexts config, but the RESOLVED required-contexts set just grew.
    requiredContextsFromBranchProtection = ["required-build"];
    await processJob(env, { type: "agent-regate-pr", deliveryId: "branch-protection-after", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });
    const rowAfterPass2 = await getPullRequestDetailSyncState(env, "owner/agent-repo", 7);
    const keyAfterPass2 = rowAfterPass2?.ciRequiredContextsKey ?? null;

    // The durable row's key must differ once the RESOLVED set changed -- if it were still derived from the raw,
    // unchanged expectedCiContexts config (the bug), keyAfterPass2 would equal keyAfterPass1 even though the
    // resolved required-contexts set is now materially different (missing "required-build" entirely).
    expect(keyAfterPass2).not.toBe(keyAfterPass1);
    // "required-build" never appears in any check-run/status ⇒ once it is folded into the resolved required set,
    // reduceLiveCiAggregate can no longer treat it as satisfied ⇒ the aggregate correctly flips to pending,
    // proving pass 2 actually re-derived against the NEW resolved set rather than serving pass 1's stale "passed"
    // row from a durable cache keyed on the unchanged config.
    expect(rowAfterPass2?.ciState).toBe("pending");
  });

  it("REGRESSION (#selfhost-ci-verification): the durable CI-state cache key does not collide for required context names containing spaces", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write", checks: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto", update_branch: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Spaced context drift", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, base: { ref: "main" }, labels: [], body: "Closes #1" });
    await upsertRepoFocusManifest(env, "owner/agent-repo", { gate: { expectedCiContexts: ["lint"] } });
    let requiredContextsFromBranchProtection: Array<string | null> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/7(?:\?|$)/.test(url) && method === "GET") return Response.json({ number: 7, title: "Spaced context drift", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/commits/a7/check-runs")) {
        return Response.json({
          total_count: 3,
          check_runs: [
            { name: "lint", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
            { name: "a b", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
            { name: "c", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
          ],
        });
      }
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ contexts: requiredContextsFromBranchProtection });
      return Response.json({});
    });

    requiredContextsFromBranchProtection = ["a b", "c"];
    await processJob(env, { type: "agent-regate-pr", deliveryId: "spaced-contexts-before", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });
    const rowAfterPass1 = await getPullRequestDetailSyncState(env, "owner/agent-repo", 7);
    expect(rowAfterPass1?.ciState).toBe("passed");
    const keyAfterPass1 = rowAfterPass1?.ciRequiredContextsKey ?? null;

    requiredContextsFromBranchProtection = ["a", "b c"];
    await processJob(env, { type: "agent-regate-pr", deliveryId: "spaced-contexts-after", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });
    const rowAfterPass2 = await getPullRequestDetailSyncState(env, "owner/agent-repo", 7);
    const keyAfterPass2 = rowAfterPass2?.ciRequiredContextsKey ?? null;

    expect(keyAfterPass2).not.toBe(keyAfterPass1);
    expect(rowAfterPass2?.ciState).toBe("pending");
  });

  it("#sweep-resync: a failing resync upsert is swallowed (fail-open) — the sweep never throws", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Drifted PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
    // The live head drifted (b8 ≠ a7), so the resync upsert fires — but it REJECTS. The `.catch(() => undefined)`
    // must swallow it so the sweep proceeds on the stored `pr` rather than stalling (#sweep-resync fail-open).
    const resyncUpsertSpy = vi.spyOn(repositoriesModule, "upsertPullRequestFromGitHub").mockRejectedValueOnce(new Error("D1 upsert failed"));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Drifted PR", state: "open", user: { login: "contributor" }, head: { sha: "b8" }, labels: [], body: "Closes #1" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/commits/a7/check-runs") || url.includes("/commits/b8/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status") || url.includes("/commits/b8/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    // The rejecting upsert is caught; the job resolves without throwing and the stored head stays a7 (fail-open).
    await expect(processJob(env, { type: "agent-regate-pr", deliveryId: "resync-failopen", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 })).resolves.toBeUndefined();
    expect(resyncUpsertSpy).toHaveBeenCalledTimes(1);
    const stored = await getPullRequest(env, "owner/agent-repo", 7);
    expect(stored?.headSha).toBe("a7");
    resyncUpsertSpy.mockRestore();
  });

  it("#4 stale-surface repair: the sweep re-reviews even when the local surface marker already matches the current head", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
    await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", 7, "a7"); // marker says current, but GitHub may still show a stale/partial panel
    let checkRunsFetched = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" }); // live head matches → no drift
      if (url.includes("/check-runs")) { checkRunsFetched = true; return Response.json({ total_count: 0, check_runs: [] }); }
      if (url.includes("/status")) return Response.json({ state: "success", statuses: [] });
      return Response.json({});
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-pr", deliveryId: "repair-current", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

    // The marker is not authoritative enough to skip: re-review still reaches prReadyForReview and can repair
    // stale legacy/placeholder GitHub surfaces at the same head.
    expect(checkRunsFetched).toBe(true);
  });

  it("#4 stale-surface repair: same-head CI completions also re-run review when the marker is current", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/agent-repo" });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
    await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", 7, "a7");
    let checkRunsFetched = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a7/check-runs")) { checkRunsFetched = true; return Response.json({ total_count: 0, check_runs: [] }); }
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "ci-bypass-current",
      eventName: "check_suite",
      payload: {
        action: "completed",
        repository: { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } },
        installation: { id: 9001 },
        check_suite: { head_sha: "a7", pull_requests: [{ number: 7 }] },
      } as never,
    });

    // CI completion is event-driven dynamic state, so it must re-run prReadyForReview even when the last surface
    // publish marker already matches this head SHA.
    expect(checkRunsFetched).toBe(true);
  });

  it("drops already-enqueued self-authored app CI completions without re-reviewing", async () => {
    const env = createTestEnv({
      GITHUB_APP_SLUG: "gittensory-orb",
      GITTENSORY_REVIEW_REPOS: "owner/agent-repo",
    });
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount += 1;
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "self-check-suite-queued",
      eventName: "check_suite",
      payload: {
        action: "completed",
        repository: { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } },
        installation: { id: 9001 },
        check_suite: {
          head_sha: "a7",
          pull_requests: [{ number: 7 }],
          app: { slug: "gittensory-orb" },
        },
      } as never,
    });

    expect(fetchCount).toBe(0);
    await expect(getWebhookEvent(env, "self-check-suite-queued")).resolves.toMatchObject({
      status: "processed",
      payloadHash: "processed",
    });
  });

  it("issue label change wakes the linked PR's hard-rule re-evaluation promptly (#2259)", async () => {
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      GITTENSORY_REVIEW_REPOS: "owner/agent-repo",
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    // Links issue #1 — the issue the "labeled" event below fires on.
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Linking PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1", created_at: "2026-07-03T10:00:00.000Z" });
    let fetchCount = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      fetchCount += 1;
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Linking PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [{ name: "maintainer-only" }], user: { login: "owner" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "issue-label-wake",
      eventName: "issues",
      payload: {
        action: "labeled",
        repository: { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } },
        installation: { id: 9001 },
        issue: { number: 1, title: "Issue", state: "open", labels: [{ name: "maintainer-only" }] },
        label: { name: "maintainer-only" },
      } as never,
    });

    // The linked PR wake is queued promptly off the issue-side signal, not performed inline or left only for the
    // staleness-ordered sweep.
    expect(fetchCount).toBe(0);
    expect(sent).toEqual([
      { message: expect.objectContaining({ type: "agent-regate-pr", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001, prCreatedAt: "2026-07-03T10:00:00.000Z" }) },
    ]);
    const webhookRow = await env.DB.prepare("select status from webhook_events where delivery_id = ?").bind("issue-label-wake").first<{ status: string }>();
    expect(webhookRow?.status).toBe("processed");
  });

  it("issue label change does NOT wake an open PR that links a DIFFERENT issue", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/agent-repo" });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    // Links issue #99 — the "labeled" event below fires on issue #1, which this PR does NOT link.
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Unrelated PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #99" });
    let checkRunsFetched = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      checkRunsFetched ||= input.toString().includes("/commits/a7/check-runs");
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "issue-label-no-link",
      eventName: "issues",
      payload: {
        action: "labeled",
        repository: { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } },
        installation: { id: 9001 },
        issue: { number: 1, title: "Issue", state: "open", labels: [{ name: "maintainer-only" }] },
        label: { name: "maintainer-only" },
      } as never,
    });

    expect(checkRunsFetched).toBe(false); // PR #7 links #99, not #1 — never re-reviewed
  });

  it("issue label change wakes the linked PR via the acting-autonomy fallback even OUTSIDE the GITTENSORY_REVIEW_REPOS convergence allowlist, mirroring sweepRepoRegate's own gate (#5385)", async () => {
    // Before #5385, this exact shape (real acting autonomy, but not in the env allowlist) silently stayed
    // dormant here even though the periodic sweep (sweepRepoRegate) would already treat this repo as eligible
    // via `isConvergenceRepoAllowed || isAgentConfigured(settings.autonomy)` — a self-hoster who configures
    // autonomy without also updating the allowlist (or a repo removed from the allowlist during a rollback)
    // would see a stale type label / hard-rule verdict until the sweep eventually reached it, cycles later.
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      GITTENSORY_REVIEW_REPOS: "",
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Linking PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1", created_at: "2026-07-03T10:00:00.000Z" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // The acting-autonomy fallback resolves settings via resolveRepositorySettings, which reads the repo's
      // manifest file (unlike the allowlisted common case, which never fetches at all) — a 404 here is the
      // realistic "no .gittensory.yml override" response, not a stub gap.
      if (url.includes("/contents/")) return new Response("not found", { status: 404 });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "issue-label-fallback-wake",
      eventName: "issues",
      payload: {
        action: "labeled",
        repository: { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } },
        installation: { id: 9001 },
        issue: { number: 1, title: "Issue", state: "open", labels: [{ name: "maintainer-only" }] },
        label: { name: "maintainer-only" },
      } as never,
    });

    expect(sent).toEqual([
      { message: expect.objectContaining({ type: "agent-regate-pr", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001, prCreatedAt: "2026-07-03T10:00:00.000Z" }) },
    ]);
    const webhookRow = await env.DB.prepare("select status from webhook_events where delivery_id = ?").bind("issue-label-fallback-wake").first<{ status: string }>();
    expect(webhookRow?.status).toBe("processed");
  });

  it("issue label change stays dormant when the repo is neither in the convergence allowlist NOR has any acting autonomy configured (#5385 — genuinely inert repos are still untouched)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      GITTENSORY_REVIEW_REPOS: "",
      JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    // Every autonomy class left at the deny-by-default "observe" floor — isAgentConfigured is false, same as
    // isConvergenceRepoAllowed, so this repo has genuinely opted into nothing.
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { review: "observe" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Linking PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/contents/")) return new Response("not found", { status: 404 });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "issue-label-not-converged",
      eventName: "issues",
      payload: {
        action: "labeled",
        repository: { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } },
        installation: { id: 9001 },
        issue: { number: 1, title: "Issue", state: "open", labels: [{ name: "maintainer-only" }] },
        label: { name: "maintainer-only" },
      } as never,
    });

    expect(sent).toEqual([]); // dormant: neither allowlisted nor acting-autonomy-configured
    const webhookRow = await env.DB.prepare("select status from webhook_events where delivery_id = ?").bind("issue-label-not-converged").first<{ status: string }>();
    expect(webhookRow?.status).toBe("processed"); // still marked handled — only the re-review work is skipped
  });

  it("issue label change no-ops on a malformed payload missing the issue number", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/agent-repo" });
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount += 1;
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "issue-label-no-issue-number",
      eventName: "issues",
      payload: {
        action: "labeled",
        repository: { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } },
        installation: { id: 9001 },
        label: { name: "maintainer-only" },
        // No `issue` field at all — GitHub always sends one, but the handler must not assume it.
      } as never,
    });

    expect(fetchCount).toBe(0); // never even minted a token — bailed before touching GitHub
  });

  it("REGRESSION (#2371): an unrelated CI-completion coalesce claim does NOT suppress the issue-side wake for the same PR", async () => {
    // The two triggers are not interchangeable: a CI-completion webhook re-review and an issue-side
    // label/assignment re-review answer different questions. Sharing one coalesce window let a completely
    // unrelated CI re-review silently swallow a genuine issue-side signal, leaving the PR on stale linked-issue
    // state until the window expired or the sweep eventually reached it. The issue-side wake must use its OWN
    // window and proceed regardless of what the CI-completion window holds.
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      GITTENSORY_REVIEW_REPOS: "owner/agent-repo",
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Linking PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1", created_at: "2026-07-03T10:00:00.000Z" });
    // A CI completion for this exact PR claimed the CI-completion window moments earlier — a wholly separate
    // trigger from the issue-side label change below.
    await env.SELFHOST_TRANSIENT_CACHE?.set("ci-coalesce:owner/agent-repo#7", "1", 60);
    let fetchCount = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      fetchCount += 1;
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Linking PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [{ name: "maintainer-only" }], user: { login: "owner" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "issue-label-not-suppressed-by-ci-coalesce",
      eventName: "issues",
      payload: {
        action: "labeled",
        repository: { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } },
        installation: { id: 9001 },
        issue: { number: 1, title: "Issue", state: "open", labels: [{ name: "maintainer-only" }] },
        label: { name: "maintainer-only" },
      } as never,
    });

    expect(fetchCount).toBe(0); // issue-side wake only enqueues; it never performs the expensive live re-review inline
    expect(sent).toEqual([
      { message: expect.objectContaining({ type: "agent-regate-pr", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 }) },
    ]); // the CI window's claim is irrelevant to the issue-side wake
  });

  it("issue label change coalesces a burst of same-PR issue-side signals within its OWN window (#2371)", async () => {
    // The issue-side window's legitimate purpose: bound FREQUENCY for a burst of label/assignment churn on the
    // same PR, without depending on (or being defeated by) the unrelated CI-completion window.
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      GITTENSORY_REVIEW_REPOS: "owner/agent-repo",
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Linking PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1", created_at: "2026-07-03T10:00:00.000Z" });
    let fetchCallCount = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      fetchCallCount += 1;
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Linking PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [{ name: "maintainer-only" }] });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });
    const labeled = (deliveryId: string) => ({
      type: "github-webhook" as const,
      deliveryId,
      eventName: "issues",
      payload: {
        action: "labeled",
        repository: { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } },
        installation: { id: 9001 },
        issue: { number: 1, title: "Issue", state: "open", labels: [{ name: "maintainer-only" }] },
        label: { name: "maintainer-only" },
      } as never,
    });

    await processJob(env, labeled("issue-label-burst-1"));
    expect(fetchCallCount).toBe(0); // the first signal queues a bounded per-PR job instead of re-reviewing inline
    expect(sent).toEqual([
      { message: expect.objectContaining({ type: "agent-regate-pr", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 }) },
    ]);
    const fetchCallCountAfterFirst = fetchCallCount;

    await processJob(env, labeled("issue-label-burst-2"));

    // Second signal within the window coalesces — no GitHub interaction and one trailing job for the latest state.
    expect(fetchCallCount).toBe(fetchCallCountAfterFirst);
    expect(sent).toEqual([
      { message: expect.objectContaining({ type: "agent-regate-pr", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001, prCreatedAt: "2026-07-03T10:00:00.000Z" }) },
      {
        message: expect.objectContaining({ type: "agent-regate-pr", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001, prCreatedAt: "2026-07-03T10:00:00.000Z" }),
        options: { delaySeconds: 60 },
      },
    ]);
  });

  it("REGRESSION: issue-side linked PR wake queues every linked PR when many PRs link the same issue", async () => {
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      GITTENSORY_REVIEW_REPOS: "owner/agent-repo",
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    for (let number = 1; number <= SWEEP_MAX_PRS + 2; number += 1) {
      await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number, title: `Linking PR ${number}`, state: "open", user: { login: "contributor" }, head: { sha: `a${number}` }, labels: [], body: "Closes #1" });
    }
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount += 1;
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "issue-label-bounded-linked-fanout",
      eventName: "issues",
      payload: {
        action: "labeled",
        repository: { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } },
        installation: { id: 9001 },
        issue: { number: 1, title: "Issue", state: "open", labels: [{ name: "maintainer-only" }] },
        label: { name: "maintainer-only" },
      } as never,
    });

    expect(fetchCount).toBe(0);
    expect(sent).toHaveLength(SWEEP_MAX_PRS + 2);
    expect(sent.map(({ message }) => message)).toEqual(
      Array.from({ length: SWEEP_MAX_PRS + 2 }, (_, index) =>
        expect.objectContaining({ type: "agent-regate-pr", repoFullName: "owner/agent-repo", prNumber: index + 1, installationId: 9001 }),
      ),
    );
    expect(sent.map(({ options }) => options)).toEqual([
      undefined,
      { delaySeconds: 10 },
      { delaySeconds: 20 },
      { delaySeconds: 30 },
      { delaySeconds: 40 },
    ]);
  });

  it("REGRESSION (#3989 review): issue-side linked PR wake stays bounded by ISSUE_WAKE_MAX_PRS when a popular issue links far more PRs", async () => {
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      GITTENSORY_REVIEW_REPOS: "owner/agent-repo",
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    for (let number = 1; number <= ISSUE_WAKE_MAX_PRS + 2; number += 1) {
      await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number, title: `Linking PR ${number}`, state: "open", user: { login: "contributor" }, head: { sha: `a${number}` }, labels: [], body: "Closes #1" });
    }
    vi.stubGlobal("fetch", async () => Response.json({}));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "issue-label-popular-issue-fanout",
      eventName: "issues",
      payload: {
        action: "labeled",
        repository: { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } },
        installation: { id: 9001 },
        issue: { number: 1, title: "Issue", state: "open", labels: [{ name: "maintainer-only" }] },
        label: { name: "maintainer-only" },
      } as never,
    });

    // ISSUE_WAKE_MAX_PRS + 2 PRs link the issue, but only the first ISSUE_WAKE_MAX_PRS are enqueued -- a
    // popular/tracking issue must not be able to enqueue an unbounded number of ~9-REST-GET re-gates from a
    // single webhook, even though this one-shot handler's budget is intentionally larger than SWEEP_MAX_PRS.
    expect(sent).toHaveLength(ISSUE_WAKE_MAX_PRS);
    expect(sent.map(({ message }) => (message as { prNumber: number }).prNumber)).toEqual(
      Array.from({ length: ISSUE_WAKE_MAX_PRS }, (_, index) => index + 1),
    );
  });

  it("sibling re-gate fan-out (#4005): a merged PR enqueues a bounded agent-regate-pr job for each open sibling PR", async () => {
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      GITTENSORY_REVIEW_REPOS: "owner/agent-repo",
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    for (const number of [10, 11, 12]) {
      await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number, title: `Sibling PR ${number}`, state: "open", user: { login: "contributor" }, head: { sha: `sib${number}` }, labels: [], body: "No linked issue.", created_at: `2026-07-0${number - 9}T00:00:00.000Z` });
    }
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/check-runs")) return Response.json({ id: 900 }, { status: 201 });
      if (url.includes("/files")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "sibling-merge-fanout",
      eventName: "pull_request",
      payload: {
        action: "closed",
        installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" } },
        repository: { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } },
        pull_request: { number: 999, title: "Merged PR", state: "closed", merged_at: "2026-07-08T00:00:00.000Z", user: { login: "contributor" }, head: { sha: "mergedsha" }, labels: [], body: "No linked issue." },
      } as never,
    });

    // Bounded, staggered fan-out for each OTHER open PR — never for the merged PR's own number.
    const regateJobs = sent.filter(({ message }) => message.type === "agent-regate-pr");
    expect(regateJobs.map(({ message }) => message)).toEqual([
      expect.objectContaining({ type: "agent-regate-pr", repoFullName: "owner/agent-repo", prNumber: 10, installationId: 9001, prCreatedAt: "2026-07-01T00:00:00.000Z" }),
      expect.objectContaining({ type: "agent-regate-pr", repoFullName: "owner/agent-repo", prNumber: 11, installationId: 9001, prCreatedAt: "2026-07-02T00:00:00.000Z" }),
      expect.objectContaining({ type: "agent-regate-pr", repoFullName: "owner/agent-repo", prNumber: 12, installationId: 9001, prCreatedAt: "2026-07-03T00:00:00.000Z" }),
    ]);
    expect(regateJobs.map(({ options }) => options)).toEqual([undefined, { delaySeconds: 10 }, { delaySeconds: 20 }]);
  });

  it("sibling re-gate fan-out (#4005): closing a PR WITHOUT a merge does not enqueue any sibling re-gate", async () => {
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      GITTENSORY_REVIEW_REPOS: "owner/agent-repo",
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    for (const number of [10, 11, 12]) {
      await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number, title: `Sibling PR ${number}`, state: "open", user: { login: "contributor" }, head: { sha: `sib${number}` }, labels: [], body: "No linked issue." });
    }
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/check-runs")) return Response.json({ id: 900 }, { status: 201 });
      if (url.includes("/files")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "sibling-close-no-merge",
      eventName: "pull_request",
      payload: {
        action: "closed",
        installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" } },
        repository: { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } },
        pull_request: { number: 999, title: "Closed without merge", state: "closed", merged_at: null, user: { login: "contributor" }, head: { sha: "closedsha" }, labels: [], body: "No linked issue." },
      } as never,
    });

    // An ordinary close changed nothing on the base branch — no sibling has anything new to react to.
    const regateJobs = sent.filter(({ message }) => message.type === "agent-regate-pr");
    expect(regateJobs).toEqual([]);
  });

  it("sibling re-gate fan-out (#4005): the fan-out is capped at MERGE_WAKE_MAX_PRS even with more open siblings", async () => {
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      GITTENSORY_REVIEW_REPOS: "owner/agent-repo",
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    for (let number = 1; number <= MERGE_WAKE_MAX_PRS + 2; number += 1) {
      await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number, title: `Sibling PR ${number}`, state: "open", user: { login: "contributor" }, head: { sha: `sib${number}` }, labels: [], body: "No linked issue." });
    }
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/check-runs")) return Response.json({ id: 900 }, { status: 201 });
      if (url.includes("/files")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "sibling-merge-fanout-bounded",
      eventName: "pull_request",
      payload: {
        action: "closed",
        installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" } },
        repository: { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } },
        pull_request: { number: 999, title: "Merged PR", state: "closed", merged_at: "2026-07-08T00:00:00.000Z", user: { login: "contributor" }, head: { sha: "mergedsha" }, labels: [], body: "No linked issue." },
      } as never,
    });

    // MERGE_WAKE_MAX_PRS + 2 siblings are open, but only the first MERGE_WAKE_MAX_PRS (lowest-numbered, same
    // ordering listOtherOpenPullRequests already returns) are enqueued -- a repo with many open PRs must not be
    // able to turn one merge into an unbounded burst of ~9-REST-GET re-gates.
    const regateJobs = sent.filter(({ message }) => message.type === "agent-regate-pr");
    expect(regateJobs).toHaveLength(MERGE_WAKE_MAX_PRS);
    expect(regateJobs.map(({ message }) => (message as { prNumber: number }).prNumber)).toEqual(
      Array.from({ length: MERGE_WAKE_MAX_PRS }, (_, index) => index + 1),
    );
  });

  it("REGRESSION (#2371): a coalesced issue-side signal schedules a trailing re-review so an add-then-remove sequence is never lost", async () => {
    // Unlike CI-completion events, same-PR issue-side events are NOT interchangeable within the window: a
    // label ADD immediately followed by a REMOVE carries genuinely different states. The first event's
    // queued re-review captures the ADD; the second is coalesced (per the window's frequency bound) but must not
    // silently drop the REMOVE — it schedules a trailing agent-regate-pr re-review to run just after the
    // window closes, so the PR converges on the LATEST (removed) state instead of staying stuck on the ADD.
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      GITTENSORY_REVIEW_REPOS: "owner/agent-repo",
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Linking PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Linking PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [] });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });
    const event = (deliveryId: string, action: "labeled" | "unlabeled") => ({
      type: "github-webhook" as const,
      deliveryId,
      eventName: "issues",
      payload: {
        action,
        repository: { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } },
        installation: { id: 9001 },
        issue: { number: 1, title: "Issue", state: "open", labels: action === "labeled" ? [{ name: "maintainer-only" }] : [] },
        label: { name: "maintainer-only" },
      } as never,
    });

    await processJob(env, event("issue-add-then-remove-1", "labeled"));
    expect(sent).toEqual([
      { message: expect.objectContaining({ type: "agent-regate-pr", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 }) },
    ]); // the FIRST event queues bounded per-PR work — no trailing job needed yet

    await processJob(env, event("issue-add-then-remove-2", "unlabeled"));
    // The REMOVE was coalesced (same window), so it must schedule exactly one trailing re-review for the PR,
    // delayed past the window's close, rather than being silently dropped.
    expect(sent).toEqual([
      { message: expect.objectContaining({ type: "agent-regate-pr", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 }) },
      {
        message: expect.objectContaining({ type: "agent-regate-pr", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 }),
        options: { delaySeconds: 60 },
      },
    ]);
    const trailingReReview = sent[1]!;
    expect((trailingReReview.message as Extract<import("../../src/types").JobMessage, { type: "agent-regate-pr" }>).prCreatedAt).toBeUndefined();

    await processJob(env, event("issue-add-then-remove-3", "labeled"));
    // A THIRD coalesced event in the same window must not schedule a second, redundant trailing job.
    expect(sent).toHaveLength(2);
  });

  it("a failed trailing-re-review enqueue is swallowed — best-effort, the sweep remains the ultimate backstop (#2371)", async () => {
    let sendAttempts = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      GITTENSORY_REVIEW_REPOS: "owner/agent-repo",
      JOBS: {
        async send() {
          sendAttempts += 1;
          if (sendAttempts > 1) throw new Error("queue unavailable");
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Linking PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Linking PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [{ name: "maintainer-only" }] });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });
    const labeled = (deliveryId: string) => ({
      type: "github-webhook" as const,
      deliveryId,
      eventName: "issues",
      payload: {
        action: "labeled",
        repository: { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } },
        installation: { id: 9001 },
        issue: { number: 1, title: "Issue", state: "open", labels: [{ name: "maintainer-only" }] },
        label: { name: "maintainer-only" },
      } as never,
    });

    await expect(processJob(env, labeled("issue-enqueue-fail-1"))).resolves.toBeUndefined(); // immediate per-PR enqueue succeeds
    // The second (coalesced) event exercises scheduleTrailingIssueLinkedReReview's env.JOBS.send — its failure
    // must be swallowed, not thrown into the webhook handler.
    await expect(processJob(env, labeled("issue-enqueue-fail-2"))).resolves.toBeUndefined();
  });

  it("REGRESSION: a TRANSIENT trailing-re-review enqueue failure does not permanently forfeit the trailing job — the next coalesced event retries", async () => {
    // The dedupe marker must be claimed only AFTER env.JOBS.send actually succeeds. Claiming it eagerly (before
    // the send settles) would let a transient queue failure permanently swallow the guarantee: every later
    // coalesced event in the SAME window would see the marker already held and skip retrying, even though
    // nothing was ever actually queued.
    const sent: Array<{ message: import("../../src/types").JobMessage; options?: QueueSendOptions }> = [];
    let sendAttempts = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      GITTENSORY_REVIEW_REPOS: "owner/agent-repo",
      JOBS: {
        async send(message: import("../../src/types").JobMessage, options?: QueueSendOptions) {
          sendAttempts += 1;
          if (sendAttempts === 2) throw new Error("queue transiently unavailable");
          sent.push(options ? { message, options } : { message });
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Linking PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Linking PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [{ name: "maintainer-only" }] });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });
    const labeled = (deliveryId: string) => ({
      type: "github-webhook" as const,
      deliveryId,
      eventName: "issues",
      payload: {
        action: "labeled",
        repository: { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } },
        installation: { id: 9001 },
        issue: { number: 1, title: "Issue", state: "open", labels: [{ name: "maintainer-only" }] },
        label: { name: "maintainer-only" },
      } as never,
    });

    await processJob(env, labeled("issue-transient-retry-1")); // immediate per-PR enqueue succeeds
    await processJob(env, labeled("issue-transient-retry-2")); // coalesced — the FIRST send attempt, throws
    expect(sendAttempts).toBe(2);
    expect(sent).toEqual([
      { message: expect.objectContaining({ type: "agent-regate-pr", repoFullName: "owner/agent-repo", prNumber: 7 }) },
    ]); // the failed trailing attempt must NOT have claimed the marker

    await processJob(env, labeled("issue-transient-retry-3")); // still coalesced — retries the enqueue, succeeds
    expect(sendAttempts).toBe(3);
    expect(sent).toEqual([
      { message: expect.objectContaining({ type: "agent-regate-pr", repoFullName: "owner/agent-repo", prNumber: 7 }) },
      { message: expect.objectContaining({ type: "agent-regate-pr", repoFullName: "owner/agent-repo", prNumber: 7 }), options: { delaySeconds: 60 } },
    ]);

    await processJob(env, labeled("issue-transient-retry-4")); // coalesced again — the successful claim now dedupes further retries
    expect(sendAttempts).toBe(3);
  });

  it("#4 stale-surface repair: a rebased PR resyncs + re-reviews at the new head, and the marker survives the resync", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Rebased PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
    await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", 7, "a7"); // published at the OLD head a7
    let checkRunsFetchedAtNewHead = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Rebased PR", state: "open", user: { login: "contributor" }, head: { sha: "b8" }, labels: [], body: "Closes #1" }); // LIVE head drifted to b8 (rebase/force-push)
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/commits/b8/check-runs")) { checkRunsFetchedAtNewHead = true; return Response.json({ total_count: 0, check_runs: [] }); }
      if (url.includes("/commits/b8/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-pr", deliveryId: "rebase-rereview", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

    // The PR was resynced to b8 and re-reviewed at the new head (check-runs fetched at b8). The GitHub-sync SET
    // clause still preserves the old marker; the successful gate publication is what advances it to the new head.
    expect(checkRunsFetchedAtNewHead).toBe(true);
    const stored = await getPullRequest(env, "owner/agent-repo", 7);
    expect(stored?.headSha).toBe("b8");
    expect(stored?.lastPublishedSurfaceSha).toBe("b8");
  });

  it("#4 over-publish dedup: a failing surface-published stamp is swallowed (fail-open) — the publish still completes", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", commentMode: "all_prs", publicSurface: "comment_only", autoLabelEnabled: false, checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "off", gatePack: "oss-anti-slop" });
    const stampSpy = vi.spyOn(repositoriesModule, "markPullRequestSurfacePublished").mockRejectedValueOnce(new Error("D1 stamp failed"));
    let commentPosted = false;
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
      if (url.includes("/issues/7/comments") && method === "POST") { commentPosted = true; return Response.json({ id: 1 }, { status: 201 }); }
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "stamp-failopen",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" },
        },
      }),
    ).resolves.toBeUndefined();

    expect(commentPosted).toBe(true); // the surface published despite the marker write throwing
    expect(stampSpy).toHaveBeenCalled();
    stampSpy.mockRestore();
  });

  it("REGRESSION (registry-never-synced lane fix): a contributor PR panel does not show the lane-unavailable hold when no registry snapshot has ever synced", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", commentMode: "all_prs", publicSurface: "comment_only", autoLabelEnabled: false, checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "off", gatePack: "oss-anti-slop" });
    let commentBody = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // A confirmed official Gittensor contributor renders the FULL readiness panel (with the Validation
      // posture row this test is about) instead of the minimal first-timer invite comment.
      if (url === "https://api.gittensor.io/miners") {
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
      if (url.includes("/pulls/95/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/95")) return Response.json({ number: 95, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a95" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a95/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a95/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/issues/95/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/95/comments") && method === "POST") {
        commentBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1 }, { status: 201 });
      }
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "no-registry-sync",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 95, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a95" }, labels: [], body: "Closes #1" },
      },
    });

    expect(commentBody).toContain("gittensory-pr-panel");
    expect(commentBody).not.toContain("the review lane is unavailable");
  });

  it("REGRESSION (registry-never-synced lane fix): the SAME setup still shows the lane-unavailable hold once a registry snapshot has synced at least once", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    // A real snapshot exists, but it does not list THIS repo -- a genuine "unregistered" signal, unlike the
    // companion test above where no snapshot has EVER been produced.
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "some-other/repo": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", commentMode: "all_prs", publicSurface: "comment_only", autoLabelEnabled: false, checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "off", gatePack: "oss-anti-slop" });
    let commentBody = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // A confirmed official Gittensor contributor renders the FULL readiness panel (with the Validation
      // posture row this test is about) instead of the minimal first-timer invite comment.
      if (url === "https://api.gittensor.io/miners") {
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
      if (url.includes("/pulls/96/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/96")) return Response.json({ number: 96, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a96" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a96/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a96/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/issues/96/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/96/comments") && method === "POST") {
        commentBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 1 }, { status: 201 });
      }
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "registry-synced-unregistered",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 96, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a96" }, labels: [], body: "Closes #1" },
      },
    });

    expect(commentBody).toContain("the review lane is unavailable");
  });

  it("#regate-churn: a failing markAiReviewPublished stamp is swallowed (fail-open) — the publish still completes", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", commentMode: "all_prs", publicSurface: "comment_only", autoLabelEnabled: false, checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "off", gatePack: "oss-anti-slop" });
    const markSpy = vi.spyOn(repositoriesModule, "markAiReviewPublished").mockRejectedValueOnce(new Error("D1 stamp failed"));
    let commentPosted = false;
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
      if (url.includes("/issues/7/comments") && method === "POST") { commentPosted = true; return Response.json({ id: 1 }, { status: 201 }); }
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "ai-review-published-stamp-failopen",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" },
        },
      }),
    ).resolves.toBeUndefined();

    expect(commentPosted).toBe(true); // the surface published despite the ai_review_cache marker write throwing
    expect(markSpy).toHaveBeenCalledWith(env, "JSONbored/gittensory", 7, "a7"); // ties this regression to the real write path, not any call
    markSpy.mockRestore();
  });

  describe("#regate-churn: scheduled re-gate idempotency", () => {
    async function seedRegateChurnRepo(env: Env, overrides: Partial<Parameters<typeof upsertRepositorySettings>[1]> = {}) {
      await persistRegistrySnapshot(
        env,
        normalizeRegistryPayload(
          { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
          { kind: "raw-github", url: "https://example.test" },
          "2026-05-23T00:00:00.000Z",
        ),
      );
      await upsertInstallation(env, { action: "created", installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "selected", permissions: {}, events: [] } });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "all_prs",
        publicSurface: "off",
        autoLabelEnabled: false,
        checkRunMode: "off",
        reviewCheckMode: "required",
        aiReviewMode: "block",
        gatePack: "oss-anti-slop",
        ...overrides,
      });
      await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    }

    it("#9: a scheduled sweep does not call AI twice for a non-cacheable outcome at an unchanged head (reproduces the 281-calls/24h incident)", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: "not-json" }; } } as unknown as Ai, // inconclusive → non-cacheable
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      // #one-shot-review-cadence: this test is about the non-cacheable-outcome cooldown specifically, not
      // cadence -- opt into continuous so the SAME unchanged-head assertions below exercise that mechanism in
      // isolation, unaffected by the one_shot default now suppressing repeat automatic passes for a different reason.
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { auto_review: { cadence: "continuous" } } });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Quiet PR", state: "open", user: { login: "contributor" }, head: { sha: "a60" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 60, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/60/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/60")) return Response.json({ number: 60, title: "Quiet PR", state: "open", user: { login: "contributor" }, head: { sha: "a60" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a60/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a60/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/60/comments")) return method === "POST" ? Response.json({ id: 60 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });
      vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

      // Three scheduled sweep passes over the SAME unchanged head, minutes apart — exactly the low-activity-repo
      // shape from the production incident (repeated sweep ticks, no real state change).
      await processJob(env, { type: "agent-regate-pr", deliveryId: "churn-1", repoFullName: "JSONbored/gittensory", prNumber: 60, installationId: 123 });
      const firstRunAiCalls = aiCalls;
      expect(firstRunAiCalls).toBeGreaterThan(0);
      vi.setSystemTime(new Date("2026-05-28T02:05:00.000Z"));
      await processJob(env, { type: "agent-regate-pr", deliveryId: "churn-2", repoFullName: "JSONbored/gittensory", prNumber: 60, installationId: 123 });
      vi.setSystemTime(new Date("2026-05-28T02:10:00.000Z"));
      await processJob(env, { type: "agent-regate-pr", deliveryId: "churn-3", repoFullName: "JSONbored/gittensory", prNumber: 60, installationId: 123 });

      expect(aiCalls).toBe(firstRunAiCalls); // unchanged — the non-cacheable outcome was reused for both later passes
      const skipAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("agent.sweep.regate_ai_skipped_current", "JSONbored/gittensory#60")
        .first<{ n: number }>();
      expect(skipAudit?.n).toBe(2); // churn-2 and churn-3 both skipped
    });

    it("#9: a cache write failure is observable via audit_events and metrics, not silently swallowed", async () => {
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }) } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a61" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 61, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/61/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/61")) return Response.json({ number: 61, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a61" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a61/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a61/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/61/comments")) return method === "POST" ? Response.json({ id: 61 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });
      const writeSpy = vi.spyOn(repositoriesModule, "putCachedAiReview").mockRejectedValueOnce(new Error("D1 write error"));

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "write-fail", repoFullName: "JSONbored/gittensory", prNumber: 61, installationId: 123 }),
      ).resolves.toBeUndefined(); // the review still completes — a cache write failure is best-effort, never fatal
      writeSpy.mockRestore();

      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_cache_write_error", "JSONbored/gittensory#61")
        .first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("error");
      expect(audit?.detail).toContain("D1 write error");
    });

    it("INVARIANT (#4507): a real agent-regate-pr pass with reputation ON makes only ONE reputation-scan D1 read set, not two", async () => {
      // JSONbored/gittensory is in createTestEnv's default GITTENSORY_REVIEW_REPOS allowlist, so the outer
      // maybePublishPrPublicSurface scope's own preComputedReputationSkip gate condition is true here — this
      // exercises the REAL caller-scope computation (processors.ts's outer webhook-processing code), not just
      // the two consumer functions called directly.
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }) } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
        GITTENSORY_REVIEW_REPUTATION: "true",
      });
      await seedRegateChurnRepo(env);
      // Deliberately NOT "contributor" -- several other tests earlier in this file (e.g. line ~3732) stub the
      // Gittensor miners endpoint to confirm "contributor" as an official miner, and that caches a "confirmed"
      // official_miner_detections row (5-min TTL) in this file's shared D1 instance. A submitter this test's own
      // fetch stub never confirms must still resolve as NOT a miner, or #4513's install-wide widening adds a 4th
      // reputation-scan prepare and this invariant's count goes stale for reasons unrelated to what it's testing.
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 62, title: "Reputation PR", state: "open", user: { login: "reputation-single-read-user" }, head: { sha: "a62" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 62, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/62/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/62")) return Response.json({ number: 62, title: "Reputation PR", state: "open", user: { login: "reputation-single-read-user" }, head: { sha: "a62" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a62/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a62/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/62/comments")) return method === "POST" ? Response.json({ id: 62 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        if (url.includes("/miners")) return Response.json([]);
        return Response.json({});
      });

      const spy = vi.spyOn(env.DB, "prepare");
      const before = spy.mock.calls.length;
      await processJob(env, { type: "agent-regate-pr", deliveryId: "reputation-single-read", repoFullName: "JSONbored/gittensory", prNumber: 62, installationId: 123 });
      // Before #4507, the outer caller-scope computation AND runAiReviewForAdvisory's own internal check each
      // independently scanned review_targets for this submitter — 2 full sets (6 prepares), not 1 (3).
      const reputationPrepares = spy.mock.calls
        .slice(before)
        .map(([sql]) => String(sql))
        .filter((sql) => sql.includes("submitter_stats") || sql.includes("terminal_at IS NOT NULL") || sql.includes("created_at >= datetime"));
      spy.mockRestore();
      expect(reputationPrepares).toHaveLength(3); // submitter_stats + review_targets quality scan + cadence scan, ONCE
    });

    it("INVARIANT (#4446): a real agent-regate-pr pass with AI review persists a non-negative reviewDurationMs onto the publish audit event", async () => {
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }) } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 63, title: "Turnaround PR", state: "open", user: { login: "contributor" }, head: { sha: "a63" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 63, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/63/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/63")) return Response.json({ number: 63, title: "Turnaround PR", state: "open", user: { login: "contributor" }, head: { sha: "a63" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a63/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a63/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/63/comments")) return method === "POST" ? Response.json({ id: 63 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "turnaround-capture", repoFullName: "JSONbored/gittensory", prNumber: 63, installationId: 123 });

      const published = await env.DB.prepare("select metadata_json from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.pr_public_surface_published", "JSONbored/gittensory#63")
        .first<{ metadata_json: string }>();
      const metadata = JSON.parse(published?.metadata_json ?? "{}");
      expect(typeof metadata.reviewDurationMs).toBe("number");
      expect(metadata.reviewDurationMs).toBeGreaterThanOrEqual(0);
    });

    it("REGRESSION (#4446): reviewDurationMs is correctly ABSENT (not a bogus 0) when no active-review-tracking row exists for this exact headSha", async () => {
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }) } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env, { aiReviewMode: "off" }); // AI review never runs -> startActiveReviewTracking never fires
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 64, title: "No AI review PR", state: "open", user: { login: "contributor" }, head: { sha: "a64" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 64, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/64/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/64")) return Response.json({ number: 64, title: "No AI review PR", state: "open", user: { login: "contributor" }, head: { sha: "a64" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a64/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a64/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/64/comments")) return method === "POST" ? Response.json({ id: 64 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "turnaround-absent", repoFullName: "JSONbored/gittensory", prNumber: 64, installationId: 123 });

      const published = await env.DB.prepare("select metadata_json from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.pr_public_surface_published", "JSONbored/gittensory#64")
        .first<{ metadata_json: string }>();
      const metadata = JSON.parse(published?.metadata_json ?? "{}");
      expect(metadata.reviewDurationMs).toBeUndefined();
    });

    it("swallows a failing getActiveReviewStartedAt lookup without throwing, publishing with no reviewDurationMs (#4446)", async () => {
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }) } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 65, title: "Lookup failure PR", state: "open", user: { login: "contributor" }, head: { sha: "a65" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 65, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/65/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/65")) return Response.json({ number: 65, title: "Lookup failure PR", state: "open", user: { login: "contributor" }, head: { sha: "a65" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a65/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a65/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/65/comments")) return method === "POST" ? Response.json({ id: 65 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });
      const lookupSpy = vi.spyOn(repositoriesModule, "getActiveReviewStartedAt").mockRejectedValueOnce(new Error("D1 read error"));

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "turnaround-lookup-fail", repoFullName: "JSONbored/gittensory", prNumber: 65, installationId: 123 }),
      ).resolves.toBeUndefined(); // the publish still completes — a lookup failure is best-effort, never fatal
      lookupSpy.mockRestore();

      const published = await env.DB.prepare("select metadata_json from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.pr_public_surface_published", "JSONbored/gittensory#65")
        .first<{ metadata_json: string }>();
      const metadata = JSON.parse(published?.metadata_json ?? "{}");
      expect(metadata.reviewDurationMs).toBeUndefined();
    });

    describe("reviewDurationMsSince (#4446, pure)", () => {
      it("returns undefined for a null startedAt (no active-review-tracking row)", () => {
        expect(reviewDurationMsSince(null, 1_000_000)).toBeUndefined();
      });

      it("returns the elapsed ms for a valid past startedAt", () => {
        expect(reviewDurationMsSince(new Date(1_000_000).toISOString(), 1_005_000)).toBe(5_000);
      });

      it("returns 0 for a startedAt exactly equal to now", () => {
        const now = new Date(1_000_000).toISOString();
        expect(reviewDurationMsSince(now, 1_000_000)).toBe(0);
      });

      it("REGRESSION: returns undefined (not a negative number) for a startedAt in the FUTURE relative to now (clock skew)", () => {
        expect(reviewDurationMsSince(new Date(2_000_000).toISOString(), 1_000_000)).toBeUndefined();
      });

      it("REGRESSION: returns undefined (not NaN) for an unparseable startedAt string", () => {
        expect(reviewDurationMsSince("not-a-real-timestamp", 1_000_000)).toBeUndefined();
      });
    });

    it("swallows a failing hit/skip audit write without throwing (cache-hit path)", async () => {
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }) } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 66, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a66" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 66, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      await putCachedAiReview(env, "JSONbored/gittensory", 66, "a66", "block", {
        notes: "Looks fine.",
        reviewerCount: 1,
        cacheable: true,
        metadata: {
          inputFingerprint: await aiReviewCacheInputFingerprint({
            title: "Clean PR", mode: "block", byok: false, provider: null, model: null, aiReviewAllAuthors: false,
            aiReviewCloseConfidence: undefined, aiReviewCombine: null, aiReviewOnMerge: null, aiReviewReviewers: null, gatePack: "oss-anti-slop", reviewerPlan: env.AI_REVIEW_PLAN, selfHostProviderConfig: null, selfHostAiModelOverride: { claudeModel: null, claudeEffort: null, codexModel: null, codexEffort: null, ollamaModel: null, openaiModel: null, openaiCompatibleModel: null, anthropicModel: null },
            reviewFiles: [{ path: "src/a.ts", status: "modified", patch: "@@\n+export const ok = true;", additions: 1, deletions: 0 }],
            profile: null, securityFocus: false, inlineComments: false, pathInstructions: [], pathGuidance: "", repoInstructions: null, excludePaths: [], pathFilters: [], changedPaths: ["src/a.ts"],
            features: { grounding: false, rag: false, enrichment: false, reputation: false, cultureProfile: false, impactMap: false },
          }),
        },
      });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/66/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/66")) return Response.json({ number: 66, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a66" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/66/comments")) return method === "POST" ? Response.json({ id: 66 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });
      const originalRecordAuditEvent = repositoriesModule.recordAuditEvent;
      const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockImplementation(async (auditEnv, event) => {
        if (event.eventType === "github_app.ai_review_cache_hit" || event.eventType === "agent.sweep.regate_ai_skipped_current")
          throw new Error("audit DB down");
        await originalRecordAuditEvent(auditEnv, event);
      });

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "hit-audit-fail", repoFullName: "JSONbored/gittensory", prNumber: 66, installationId: 123 }),
      ).resolves.toBeUndefined();
      auditSpy.mockRestore();
    });

    it("swallows failing miss/non-cacheable audit writes AND a failing write-error audit write, without throwing", async () => {
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: "not-json" }) } as unknown as Ai, // inconclusive → non-cacheable
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 67, title: "Quiet PR", state: "open", user: { login: "contributor" }, head: { sha: "a67" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 67, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/67/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/67")) return Response.json({ number: 67, title: "Quiet PR", state: "open", user: { login: "contributor" }, head: { sha: "a67" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/67/comments")) return method === "POST" ? Response.json({ id: 67 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });
      const writeSpy = vi.spyOn(repositoriesModule, "putCachedAiReview").mockRejectedValue(new Error("D1 write error"));
      const originalRecordAuditEvent = repositoriesModule.recordAuditEvent;
      const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockImplementation(async (auditEnv, event) => {
        if (
          event.eventType === "github_app.ai_review_cache_miss" ||
          event.eventType === "github_app.ai_review_non_cacheable" ||
          event.eventType === "github_app.ai_review_cache_write_error" ||
          event.eventType === "github_app.ai_review_force_bypass"
        )
          throw new Error("audit DB down");
        await originalRecordAuditEvent(auditEnv, event);
      });

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "miss-audit-fail", repoFullName: "JSONbored/gittensory", prNumber: 67, installationId: 123 }),
      ).resolves.toBeUndefined();
      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "miss-audit-fail-forced", repoFullName: "JSONbored/gittensory", prNumber: 67, installationId: 123, force: true }),
      ).resolves.toBeUndefined();
      writeSpy.mockRestore();
      auditSpy.mockRestore();
    });

    it("skips AI review for draft PRs when review.auto_review.skip_drafts is enabled (#1954)", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { auto_review: { skip_drafts: true } } });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        number: 68,
        title: "Draft feature",
        state: "open",
        draft: true,
        user: { login: "contributor" },
        head: { sha: "a68" },
        labels: [],
        body: "Closes #1",
      } as never);
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 68, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/68/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/68")) return Response.json({ number: 68, title: "Draft feature", state: "open", draft: true, user: { login: "contributor" }, head: { sha: "a68" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a68/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a68/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/68/comments")) return method === "POST" ? Response.json({ id: 68 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "auto-review-skip-draft", repoFullName: "JSONbored/gittensory", prNumber: 68, installationId: 123 }),
      ).resolves.toBeUndefined();
      expect(aiCalls).toBe(0);
      const audit = await env.DB.prepare("select detail from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_auto_review_skipped", "JSONbored/gittensory#68")
        .first<{ detail: string }>();
      expect(audit?.detail).toBe("review skipped (draft)");
    });

    it("publishes a skipped Orb review check with a human summary when auto-review eligibility fails (#2067)", async () => {
      let aiCalls = 0;
      let gateConclusion: string | null = null;
      let gateSummary: string | null = null;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { auto_review: { skip_drafts: true } } });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        number: 81,
        title: "Draft feature",
        state: "open",
        draft: true,
        user: { login: "contributor" },
        head: { sha: "a81" },
        labels: [],
        body: "Closes #1",
      } as never);
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 81, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/81/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/81")) return Response.json({ number: 81, title: "Draft feature", state: "open", draft: true, user: { login: "contributor" }, head: { sha: "a81" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a81/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a81/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/81/comments")) return method === "POST" ? Response.json({ id: 81 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        if (url.includes("/check-runs") && (method === "POST" || method === "PATCH")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { conclusion?: string; output?: { summary?: string } };
          if (body.conclusion) gateConclusion = body.conclusion;
          if (body.output?.summary) gateSummary = body.output.summary;
          return Response.json({ id: 981, html_url: "https://github.com/check/981" }, { status: method === "POST" ? 201 : 200 });
        }
        return Response.json({});
      });

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "auto-review-skip-status", repoFullName: "JSONbored/gittensory", prNumber: 81, installationId: 123 }),
      ).resolves.toBeUndefined();
      expect(aiCalls).toBe(0);
      expect(gateConclusion).toBe("skipped");
      expect(gateSummary).toBe("AI review is skipped for draft pull requests while review.auto_review.skip_drafts is enabled.");
      const audit = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_auto_review_skipped", "JSONbored/gittensory#81")
        .first<{ detail: string; metadata_json: string }>();
      expect(audit?.detail).toBe("review skipped (draft)");
      expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({
        summary: "AI review is skipped for draft pull requests while review.auto_review.skip_drafts is enabled.",
      });
    });

    it("publishes the deterministic gate conclusion when auto-review eligibility is skipped but the gate does not pass", async () => {
      let aiCalls = 0;
      let gateConclusion: string | null = null;
      let gateSummary = "";
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "off",
        publicSurface: "off",
        autoLabelEnabled: false,
        checkRunMode: "enabled",
        reviewCheckMode: "required",
        linkedIssueGateMode: "block",
        requireLinkedIssue: true,
        autonomy: { merge: "observe", request_changes: "observe" },
        agentDryRun: false,
      });
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", {
        review: {
          auto_review: { skip_drafts: true },
        },
        gate: { linkedIssue: "block" },
      });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        number: 82,
        title: "Draft feature",
        state: "open",
        draft: true,
        user: { login: "contributor" },
        head: { sha: "a82" },
        labels: [],
        body: "No linked issue here.",
      } as never);
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 82, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-credential" });
        if (url.includes("/pulls/82/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/82")) return Response.json({ number: 82, title: "Draft feature", state: "open", draft: true, user: { login: "contributor" }, head: { sha: "a82" }, labels: [], body: "No linked issue here.", mergeable_state: "clean" });
        if (url.includes("/commits/a82/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a82/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/82/comments")) return method === "POST" ? Response.json({ id: 82 }, { status: 201 }) : Response.json([]);
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        if (url.includes("/check-runs") && (method === "POST" || method === "PATCH")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { conclusion?: string; output?: { title?: string; summary?: string } };
          if (body.conclusion) gateConclusion = body.conclusion;
          gateSummary = `${body.output?.title ?? ""} ${body.output?.summary ?? ""}`;
          return Response.json({ id: 982, html_url: "https://github.com/check/982" }, { status: method === "POST" ? 201 : 200 });
        }
        return Response.json({});
      });

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "auto-review-skip-gate-not-pass", repoFullName: "JSONbored/gittensory", prNumber: 82, installationId: 123 }),
      ).resolves.toBeUndefined();
      expect(aiCalls).toBe(0);
      expect(gateConclusion).toBe("neutral");
      expect(gateSummary).toContain("LoopOver public check output is intentionally minimal");
      const summary = await env.DB.prepare("select conclusion from check_summaries where repo_full_name = ? and pull_number = ?")
        .bind("JSONbored/gittensory", 82)
        .first<{ conclusion: string }>();
      expect(summary?.conclusion).not.toBe("skipped");
    });

    it("skips AI review when review.auto_review.skip_labels matches a PR label (#2062)", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { auto_review: { skip_labels: ["do-not-review"] } } });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        number: 78,
        title: "Ready feature",
        state: "open",
        draft: false,
        user: { login: "contributor" },
        head: { sha: "a78" },
        labels: [{ name: "Do-Not-Review" }],
        body: "Closes #1",
      } as never);
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 78, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/78/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/78")) return Response.json({ number: 78, title: "Ready feature", state: "open", draft: false, user: { login: "contributor" }, head: { sha: "a78" }, labels: [{ name: "Do-Not-Review" }], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a78/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a78/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/78/comments")) return method === "POST" ? Response.json({ id: 78 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "auto-review-skip-label", repoFullName: "JSONbored/gittensory", prNumber: 78, installationId: 123 }),
      ).resolves.toBeUndefined();
      expect(aiCalls).toBe(0);
      const audit = await env.DB.prepare("select detail from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_auto_review_skipped", "JSONbored/gittensory#78")
        .first<{ detail: string }>();
      expect(audit?.detail).toBe("review skipped (label)");
    });

    it("skips AI review for docs-only PRs when review.auto_review.skip_docs_only is enabled (#2063)", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { auto_review: { skip_docs_only: true } } });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        number: 79,
        title: "docs: update readme",
        state: "open",
        draft: false,
        user: { login: "contributor" },
        head: { sha: "a79" },
        labels: [],
        body: "Closes #1",
      } as never);
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 79, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/79/files")) return Response.json([
          { filename: "README.md", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@\n+docs" },
          { filename: "docs/guide.md", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+more" },
        ]);
        if (url.endsWith("/pulls/79")) return Response.json({ number: 79, title: "docs: update readme", state: "open", draft: false, user: { login: "contributor" }, head: { sha: "a79" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a79/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a79/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/79/comments")) return method === "POST" ? Response.json({ id: 79 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "auto-review-skip-docs-only", repoFullName: "JSONbored/gittensory", prNumber: 79, installationId: 123 }),
      ).resolves.toBeUndefined();
      expect(aiCalls).toBe(0);
      const audit = await env.DB.prepare("select detail from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_auto_review_skipped", "JSONbored/gittensory#79")
        .first<{ detail: string }>();
      expect(audit?.detail).toBe("review skipped (docs only)");
    });

    it("skips AI review when review.auto_review.max_added_lines is exceeded (#2065)", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { auto_review: { max_added_lines: 1 } } });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        number: 80,
        title: "feat: large change",
        state: "open",
        draft: false,
        user: { login: "contributor" },
        head: { sha: "a80" },
        labels: [],
        body: "Closes #1",
      } as never);
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 80, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/80/files")) return Response.json([
          { filename: "src/a.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@\n+a\n+b" },
        ]);
        if (url.endsWith("/pulls/80")) return Response.json({ number: 80, title: "feat: large change", state: "open", draft: false, user: { login: "contributor" }, head: { sha: "a80" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a80/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a80/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/80/comments")) return method === "POST" ? Response.json({ id: 80 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "auto-review-skip-too-large", repoFullName: "JSONbored/gittensory", prNumber: 80, installationId: 123 }),
      ).resolves.toBeUndefined();
      expect(aiCalls).toBe(0);
      const audit = await env.DB.prepare("select detail from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_auto_review_skipped", "JSONbored/gittensory#80")
        .first<{ detail: string }>();
      expect(audit?.detail).toBe("review skipped (too large)");
    });

    it("runs AI review with cached manifest when auto_review eligibility passes (#1954)", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { auto_review: { skip_drafts: true, ignore_authors: ["*[bot]"] } } });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        number: 69,
        title: "Ready feature",
        state: "open",
        draft: false,
        user: { login: "contributor" },
        head: { sha: "a69" },
        labels: [],
        body: "Closes #1",
      } as never);
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 69, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/69/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/69")) return Response.json({ number: 69, title: "Ready feature", state: "open", draft: false, user: { login: "contributor" }, head: { sha: "a69" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a69/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a69/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/69/comments")) return method === "POST" ? Response.json({ id: 69 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "auto-review-run", repoFullName: "JSONbored/gittensory", prNumber: 69, installationId: 123 }),
      ).resolves.toBeUndefined();
      expect(aiCalls).toBeGreaterThan(0);
      const skipAudit = await env.DB.prepare("select detail from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_auto_review_skipped", "JSONbored/gittensory#69")
        .first<{ detail: string }>();
      expect(skipAudit).toBeUndefined();
    });

    it("skips AI review but still enforces the gate once a PR has an autoreview pause marker (#2164 regression)", async () => {
      let aiCalls = 0;
      let commentPosted = false;
      let checkRunWritten = false;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "all_prs",
        publicSurface: "comment_only",
        autoLabelEnabled: false,
        checkRunMode: "enabled",
        reviewCheckMode: "required",
        aiReviewMode: "block",
        gatePack: "oss-anti-slop",
      });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        number: 83,
        title: "Ready feature",
        state: "open",
        draft: false,
        user: { login: "contributor" },
        head: { sha: "a83" },
        labels: [],
        body: "Closes #1",
      } as never);
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 83, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      await env.DB.prepare(
        "insert into audit_events (id, event_type, actor, target_key, outcome, detail, metadata_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind("pause-83", "github_app.autoreview_paused", "maintainer1", "JSONbored/gittensory#83", "completed", "stop reviewing", "{}", new Date().toISOString())
        .run();
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.endsWith("/pulls/83")) return Response.json({ number: 83, title: "Ready feature", state: "open", draft: false, user: { login: "contributor" }, head: { sha: "a83" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/issues/83/comments") && method === "POST") {
          commentPosted = true;
          return Response.json({ id: 83 }, { status: 201 });
        }
        if (url.includes("/check-runs") && (method === "POST" || method === "PATCH")) {
          checkRunWritten = true;
          return Response.json({ id: 983, html_url: "https://github.com/check/983" }, { status: method === "POST" ? 201 : 200 });
        }
        return Response.json({});
      });

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "paused-autoreview", repoFullName: "JSONbored/gittensory", prNumber: 83, installationId: 123 }),
      ).resolves.toBeUndefined();
      expect(aiCalls).toBe(0);
      expect(commentPosted).toBe(false);
      expect(checkRunWritten).toBe(true);
    });

    it("threads review.ai_model through the full webhook pipeline into ai.run's options (#selfhost-ai-model-override)", async () => {
      let seenOptions: Record<string, unknown> = {};
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: {
          run: async (_model: string, options: Record<string, unknown>) => {
            seenOptions = options;
            return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) };
          },
        } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", {
        review: { ai_model: { claude_model: "claude-haiku-4-5", claude_effort: "low", codex_model: "gpt-5.4-mini", codex_effort: "high" } },
      });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        number: 70,
        title: "Ready feature",
        state: "open",
        draft: false,
        user: { login: "contributor" },
        head: { sha: "a70" },
        labels: [],
        body: "Closes #1",
      } as never);
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 70, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/70/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/70")) return Response.json({ number: 70, title: "Ready feature", state: "open", draft: false, user: { login: "contributor" }, head: { sha: "a70" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a70/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a70/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/70/comments")) return method === "POST" ? Response.json({ id: 70 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "ai-model-override-thread", repoFullName: "JSONbored/gittensory", prNumber: 70, installationId: 123 }),
      ).resolves.toBeUndefined();
      expect(seenOptions).toMatchObject({
        claudeModel: "claude-haiku-4-5",
        claudeEffort: "low",
        codexModel: "gpt-5.4-mini",
        codexEffort: "high",
      });
    });

    it("pauses AI review when auto_pause_after_reviewed_commits threshold is reached (#2042)", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { auto_review: { auto_pause_after_reviewed_commits: 2 } } });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        number: 77,
        title: "Churny feature",
        state: "open",
        draft: false,
        user: { login: "contributor" },
        head: { sha: "a77-v3" },
        labels: [],
        body: "Closes #1",
      } as never);
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 77, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      await putCachedAiReview(env, "JSONbored/gittensory", 77, "a77-v1", "block", { notes: "First.", reviewerCount: 1 });
      await markAiReviewPublished(env, "JSONbored/gittensory", 77, "a77-v1");
      await putCachedAiReview(env, "JSONbored/gittensory", 77, "a77-v2", "block", { notes: "Second.", reviewerCount: 1 });
      await markAiReviewPublished(env, "JSONbored/gittensory", 77, "a77-v2");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/77/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/77")) return Response.json({ number: 77, title: "Churny feature", state: "open", draft: false, user: { login: "contributor" }, head: { sha: "a77-v3" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a77-v3/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a77-v3/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/77/comments")) return method === "POST" ? Response.json({ id: 77 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "auto-review-pause-threshold", repoFullName: "JSONbored/gittensory", prNumber: 77, installationId: 123 }),
      ).resolves.toBeUndefined();
      expect(aiCalls).toBe(0);
      const audit = await env.DB.prepare("select detail from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_auto_review_skipped", "JSONbored/gittensory#77")
        .first<{ detail: string }>();
      expect(audit?.detail).toBe("review paused (commit threshold)");
    });

    // #selfhost-token-burn: the PREVIOUS test only ever presents a NEW, never-before-reviewed head to the
    // threshold check (a77-v3 has no cache row of its own) -- countPublishedAiReviewHeads correctly counted
    // the two PRIOR distinct heads even before this fix, so that test alone can't prove the actual bug: a PR
    // repeatedly swept with NO new commits (the same head, over and over) never reached its OWN threshold,
    // because the count used to exclude "the current head" -- which, on every single one of those repeat
    // sweeps, IS the one and only head this PR has ever had. Confirmed live: one real PR took 63 fresh AI
    // calls across 12 hours of scheduled sweeps with zero new commits.
    it("regression (#selfhost-token-burn): pauses AND reuses the cached blocker when the SAME unchanged head is swept repeatedly", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env, { publicSurface: "comment_and_label" });
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { auto_review: { auto_pause_after_reviewed_commits: 1 } } });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        number: 78,
        title: "Stuck-open feature",
        state: "open",
        draft: false,
        user: { login: "contributor" },
        head: { sha: "a78-only" },
        labels: [],
        body: "Closes #1",
      } as never);
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 78, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      // The ONLY review this PR has ever had -- for its OWN current (unchanged) head -- carrying a real blocker.
      await putCachedAiReview(env, "JSONbored/gittensory", 78, "a78-only", "block", {
        notes: "Prior published review with a real defect.",
        reviewerCount: 1,
        findings: [{ code: "ai_consensus_defect", title: "Null pointer on empty input", severity: "critical", detail: "The reviewer flagged a real defect that will break on an empty array." }],
      });
      await markAiReviewPublished(env, "JSONbored/gittensory", 78, "a78-only");
      let publicCommentBody = "";
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/78/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/78")) return Response.json({ number: 78, title: "Stuck-open feature", state: "open", draft: false, user: { login: "contributor" }, head: { sha: "a78-only" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a78-only/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a78-only/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/78/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/78/comments")) { publicCommentBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? publicCommentBody); return Response.json({ id: 78 }, { status: 201 }); }
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      // Simulate THREE consecutive scheduled sweeps of the exact same unchanged PR -- exactly the real-world
      // pattern (no new commits, just the periodic sweep firing over and over).
      for (const deliveryId of ["sweep-1", "sweep-2", "sweep-3"]) {
        await expect(
          processJob(env, { type: "agent-regate-pr", deliveryId, repoFullName: "JSONbored/gittensory", prNumber: 78, installationId: 123 }),
        ).resolves.toBeUndefined();
      }

      expect(aiCalls).toBe(0); // never spent a fresh AI call -- paused from the very first repeat sweep
      const pausedReuseCount = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_paused_reuse", "JSONbored/gittensory#78")
        .first<{ n: number }>();
      expect(pausedReuseCount?.n).toBe(3); // every one of the 3 sweeps reused the cached review, none skipped it silently
      // The blocker from the ONE real review is still visible in the public comment on every pass -- it never
      // silently vanished once the pause engaged (the exact regression #3719 was originally guarding against).
      expect(publicCommentBody).toContain("Null pointer on empty input");
    });

    it("#9: the public surface is not republished when already current at the head (check-run-only repo, req 6)", async () => {
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }) } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 62, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a62" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 62, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      await putCachedAiReview(env, "JSONbored/gittensory", 62, "a62", "block", {
        notes: "Looks fine.",
        reviewerCount: 1,
        cacheable: true,
        metadata: {
          inputFingerprint: await aiReviewCacheInputFingerprint({
            title: "Current PR",
            mode: "block",
            byok: false,
            provider: null,
            model: null,
            aiReviewAllAuthors: false,
            aiReviewCloseConfidence: undefined,
            aiReviewCombine: null,
            aiReviewOnMerge: null,
            aiReviewReviewers: null,
            gatePack: "oss-anti-slop",
            reviewerPlan: env.AI_REVIEW_PLAN,
            selfHostProviderConfig: null, selfHostAiModelOverride: { claudeModel: null, claudeEffort: null, codexModel: null, codexEffort: null, ollamaModel: null, openaiModel: null, openaiCompatibleModel: null, anthropicModel: null },
            reviewFiles: [{ path: "src/a.ts", status: "modified", patch: "@@\n+export const ok = true;", additions: 1, deletions: 0 }],
            profile: null,
            securityFocus: false,
            inlineComments: false,
            pathInstructions: [],
            pathGuidance: "",
            repoInstructions: null,
            excludePaths: [],
            pathFilters: [],
            changedPaths: ["src/a.ts"],
            features: { grounding: false, rag: false, enrichment: false, reputation: false, cultureProfile: false, impactMap: false },
          }),
        },
      });
      await upsertCheckSummary(env, {
        id: "gate-62",
        repoFullName: "JSONbored/gittensory",
        pullNumber: 62,
        headSha: "a62",
        name: "LoopOver Orb Review Agent",
        status: "completed",
        conclusion: "success",
        payload: {},
      });
      await repositoriesModule.markPullRequestSurfacePublished(env, "JSONbored/gittensory", 62, "a62");
      const checkRunWrites: Array<{ method: string; body: Record<string, unknown> }> = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/62/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/62")) return Response.json({ number: 62, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a62" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a62/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        if (url.includes("/check-runs") && init?.method === "POST") {
          checkRunWrites.push({ method: "POST", body: JSON.parse(String(init.body)) as Record<string, unknown> });
          return Response.json({ id: 6201 });
        }
        if (url.includes("/check-runs/6201") && init?.method === "PATCH") {
          checkRunWrites.push({ method: "PATCH", body: JSON.parse(String(init.body)) as Record<string, unknown> });
          return Response.json({ id: 6201 });
        }
        if (url.includes("/check-runs")) return Response.json({ check_runs: [{ id: 6200, status: "completed" }] });
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "surface-skip", repoFullName: "JSONbored/gittensory", prNumber: 62, installationId: 123 });

      const skipAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.public_surface_publish_skipped_current", "JSONbored/gittensory#62")
        .first<{ n: number }>();
      expect(skipAudit?.n).toBe(1);
      const publishedAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.pr_public_surface_published", "JSONbored/gittensory#62")
        .first<{ n: number }>();
      expect(publishedAudit?.n).toBe(0); // the full publish path never ran — it was proven redundant up-front
      expect(checkRunWrites.map((write) => [write.method, write.body.status])).toEqual([
        ["POST", "in_progress"],
        ["PATCH", "completed"],
      ]);
    });

    it("REGRESSION (#2947): still skips the republish when no pending check was posted this pass (gate permission missing)", async () => {
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }) } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 72, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a72" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 72, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      await putCachedAiReview(env, "JSONbored/gittensory", 72, "a72", "block", {
        notes: "Looks fine.",
        reviewerCount: 1,
        cacheable: true,
        metadata: {
          inputFingerprint: await aiReviewCacheInputFingerprint({
            title: "Current PR", mode: "block", byok: false, provider: null, model: null, aiReviewAllAuthors: false,
            aiReviewCloseConfidence: undefined, aiReviewCombine: null, aiReviewOnMerge: null, aiReviewReviewers: null, gatePack: "oss-anti-slop", reviewerPlan: env.AI_REVIEW_PLAN, selfHostProviderConfig: null, selfHostAiModelOverride: { claudeModel: null, claudeEffort: null, codexModel: null, codexEffort: null, ollamaModel: null, openaiModel: null, openaiCompatibleModel: null, anthropicModel: null },
            reviewFiles: [{ path: "src/a.ts", status: "modified", patch: "@@\n+export const ok = true;", additions: 1, deletions: 0 }],
            profile: null, securityFocus: false, inlineComments: false, pathInstructions: [], pathGuidance: "", repoInstructions: null, excludePaths: [], pathFilters: [], changedPaths: ["src/a.ts"],
            features: { grounding: false, rag: false, enrichment: false, reputation: false, cultureProfile: false, impactMap: false },
          }),
        },
      });
      await upsertCheckSummary(env, { id: "gate-72", repoFullName: "JSONbored/gittensory", pullNumber: 72, headSha: "a72", name: "LoopOver Orb Review Agent", status: "completed", conclusion: "success", payload: {} });
      await repositoriesModule.markPullRequestSurfacePublished(env, "JSONbored/gittensory", 72, "a72");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/72/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/72")) return Response.json({ number: 72, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a72" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a72/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        // The pending gate check-run POST fails with a permission error, so pendingGateCheckRunId stays
        // undefined for the whole pass -- the "still-in-flight from THIS pass" refresh in the skip guard
        // must never fire without a pending check id to refresh.
        if (url.includes("/check-runs") && init?.method === "POST") {
          return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
        }
        if (url.includes("/check-runs")) return Response.json({ check_runs: [] });
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "surface-skip-no-pending", repoFullName: "JSONbored/gittensory", prNumber: 72, installationId: 123 });

      const skipAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.public_surface_publish_skipped_current", "JSONbored/gittensory#72")
        .first<{ n: number }>();
      expect(skipAudit?.n).toBe(1);
      const publishedAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.pr_public_surface_published", "JSONbored/gittensory#72")
        .first<{ n: number }>();
      expect(publishedAudit?.n).toBe(0); // still proven redundant up-front, even with no pending check id to refresh
    });

    it("REGRESSION (#2947): falls through to a full republish when this pass's own pending check does not finalize as published", async () => {
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }) } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 73, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a73" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 73, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      await putCachedAiReview(env, "JSONbored/gittensory", 73, "a73", "block", {
        notes: "Looks fine.",
        reviewerCount: 1,
        cacheable: true,
        metadata: {
          inputFingerprint: await aiReviewCacheInputFingerprint({
            title: "Current PR", mode: "block", byok: false, provider: null, model: null, aiReviewAllAuthors: false,
            aiReviewCloseConfidence: undefined, aiReviewCombine: null, aiReviewOnMerge: null, aiReviewReviewers: null, gatePack: "oss-anti-slop", reviewerPlan: env.AI_REVIEW_PLAN, selfHostProviderConfig: null, selfHostAiModelOverride: { claudeModel: null, claudeEffort: null, codexModel: null, codexEffort: null, ollamaModel: null, openaiModel: null, openaiCompatibleModel: null, anthropicModel: null },
            reviewFiles: [{ path: "src/a.ts", status: "modified", patch: "@@\n+export const ok = true;", additions: 1, deletions: 0 }],
            profile: null, securityFocus: false, inlineComments: false, pathInstructions: [], pathGuidance: "", repoInstructions: null, excludePaths: [], pathFilters: [], changedPaths: ["src/a.ts"],
            features: { grounding: false, rag: false, enrichment: false, reputation: false, cultureProfile: false, impactMap: false },
          }),
        },
      });
      await upsertCheckSummary(env, { id: "gate-73", repoFullName: "JSONbored/gittensory", pullNumber: 73, headSha: "a73", name: "LoopOver Orb Review Agent", status: "completed", conclusion: "success", payload: {} });
      await repositoriesModule.markPullRequestSurfacePublished(env, "JSONbored/gittensory", 73, "a73");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/73/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/73")) return Response.json({ number: 73, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a73" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a73/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        // The initial pending check-run POST succeeds (pendingGateCheckRunId gets set), but every
        // subsequent PATCH to finalize it -- both this pass's refresh attempt AND any fallthrough publish
        // attempt -- fails with a permission error, so the refresh never resolves as "published".
        if (url.includes("/check-runs") && init?.method === "POST") return Response.json({ id: 7301 });
        if (url.includes("/check-runs/7301") && init?.method === "PATCH") {
          return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
        }
        if (url.includes("/check-runs")) return Response.json({ check_runs: [] });
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "surface-skip-refresh-not-published", repoFullName: "JSONbored/gittensory", prNumber: 73, installationId: 123 });

      // The skip guard did NOT prove the surface redundant -- it must fall through to the normal publish
      // path rather than silently returning early, even though the refresh attempt itself failed.
      const skipAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.public_surface_publish_skipped_current", "JSONbored/gittensory#73")
        .first<{ n: number }>();
      expect(skipAudit?.n).toBe(0);
    });

    it("REGRESSION (#2947): swallows a failing check-summary write on the skip-guard's own refresh, still returning the gate evaluation", async () => {
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }) } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 74, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a74" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 74, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      await putCachedAiReview(env, "JSONbored/gittensory", 74, "a74", "block", {
        notes: "Looks fine.",
        reviewerCount: 1,
        cacheable: true,
        metadata: {
          inputFingerprint: await aiReviewCacheInputFingerprint({
            title: "Current PR", mode: "block", byok: false, provider: null, model: null, aiReviewAllAuthors: false,
            aiReviewCloseConfidence: undefined, aiReviewCombine: null, aiReviewOnMerge: null, aiReviewReviewers: null, gatePack: "oss-anti-slop", reviewerPlan: env.AI_REVIEW_PLAN, selfHostProviderConfig: null, selfHostAiModelOverride: { claudeModel: null, claudeEffort: null, codexModel: null, codexEffort: null, ollamaModel: null, openaiModel: null, openaiCompatibleModel: null, anthropicModel: null },
            reviewFiles: [{ path: "src/a.ts", status: "modified", patch: "@@\n+export const ok = true;", additions: 1, deletions: 0 }],
            profile: null, securityFocus: false, inlineComments: false, pathInstructions: [], pathGuidance: "", repoInstructions: null, excludePaths: [], pathFilters: [], changedPaths: ["src/a.ts"],
            features: { grounding: false, rag: false, enrichment: false, reputation: false, cultureProfile: false, impactMap: false },
          }),
        },
      });
      await upsertCheckSummary(env, { id: "gate-74", repoFullName: "JSONbored/gittensory", pullNumber: 74, headSha: "a74", name: "LoopOver Orb Review Agent", status: "completed", conclusion: "success", payload: {} });
      await repositoriesModule.markPullRequestSurfacePublished(env, "JSONbored/gittensory", 74, "a74");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/74/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/74")) return Response.json({ number: 74, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a74" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a74/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        if (url.includes("/check-runs") && init?.method === "POST") return Response.json({ id: 7401 });
        if (url.includes("/check-runs/7401") && init?.method === "PATCH") return Response.json({ id: 7401 });
        if (url.includes("/check-runs")) return Response.json({ check_runs: [] });
        return Response.json({});
      });
      const upsertSpy = vi.spyOn(repositoriesModule, "upsertCheckSummary").mockRejectedValueOnce(new Error("check_summaries write failed"));

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "surface-skip-summary-write-fails", repoFullName: "JSONbored/gittensory", prNumber: 74, installationId: 123 }),
      ).resolves.toBeUndefined();

      const skipAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.public_surface_publish_skipped_current", "JSONbored/gittensory#74")
        .first<{ n: number }>();
      expect(skipAudit?.n).toBe(1); // the check-summary write failure is swallowed; the redundant-surface skip still completes
      upsertSpy.mockRestore();
    });

    it("swallows a failing publish-skip audit write without throwing", async () => {
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }) } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 70, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a70" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 70, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      await putCachedAiReview(env, "JSONbored/gittensory", 70, "a70", "block", {
        notes: "Looks fine.",
        reviewerCount: 1,
        cacheable: true,
        metadata: {
          inputFingerprint: await aiReviewCacheInputFingerprint({
            title: "Current PR", mode: "block", byok: false, provider: null, model: null, aiReviewAllAuthors: false,
            aiReviewCloseConfidence: undefined, aiReviewCombine: null, aiReviewOnMerge: null, aiReviewReviewers: null, gatePack: "oss-anti-slop", reviewerPlan: env.AI_REVIEW_PLAN, selfHostProviderConfig: null, selfHostAiModelOverride: { claudeModel: null, claudeEffort: null, codexModel: null, codexEffort: null, ollamaModel: null, openaiModel: null, openaiCompatibleModel: null, anthropicModel: null },
            reviewFiles: [{ path: "src/a.ts", status: "modified", patch: "@@\n+export const ok = true;", additions: 1, deletions: 0 }],
            profile: null, securityFocus: false, inlineComments: false, pathInstructions: [], pathGuidance: "", repoInstructions: null, excludePaths: [], pathFilters: [], changedPaths: ["src/a.ts"],
            features: { grounding: false, rag: false, enrichment: false, reputation: false, cultureProfile: false, impactMap: false },
          }),
        },
      });
      await upsertCheckSummary(env, { id: "gate-70", repoFullName: "JSONbored/gittensory", pullNumber: 70, headSha: "a70", name: "LoopOver Orb Review Agent", status: "completed", conclusion: "success", payload: {} });
      await repositoriesModule.markPullRequestSurfacePublished(env, "JSONbored/gittensory", 70, "a70");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/70/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/70")) return Response.json({ number: 70, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a70" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a70/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });
      const originalRecordAuditEvent = repositoriesModule.recordAuditEvent;
      const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockImplementation(async (auditEnv, event) => {
        if (event.eventType === "github_app.public_surface_publish_skipped_current") throw new Error("audit DB down");
        await originalRecordAuditEvent(auditEnv, event);
      });

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "surface-skip-audit-fail", repoFullName: "JSONbored/gittensory", prNumber: 70, installationId: 123 }),
      ).resolves.toBeUndefined();
      auditSpy.mockRestore();
    });

    it("#6: falls through to a full republish when the surface marker matches but NO completed check run backs it up (partial-publish edge case)", async () => {
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }) } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 69, title: "Partially published PR", state: "open", user: { login: "contributor" }, head: { sha: "a69" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 69, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      await putCachedAiReview(env, "JSONbored/gittensory", 69, "a69", "block", {
        notes: "Looks fine.",
        reviewerCount: 1,
        cacheable: true,
        metadata: {
          inputFingerprint: await aiReviewCacheInputFingerprint({
            title: "Partially published PR", mode: "block", byok: false, provider: null, model: null, aiReviewAllAuthors: false,
            aiReviewCloseConfidence: undefined, aiReviewCombine: null, aiReviewOnMerge: null, aiReviewReviewers: null, gatePack: "oss-anti-slop", reviewerPlan: env.AI_REVIEW_PLAN, selfHostProviderConfig: null, selfHostAiModelOverride: { claudeModel: null, claudeEffort: null, codexModel: null, codexEffort: null, ollamaModel: null, openaiModel: null, openaiCompatibleModel: null, anthropicModel: null },
            reviewFiles: [{ path: "src/a.ts", status: "modified", patch: "@@\n+export const ok = true;", additions: 1, deletions: 0 }],
            profile: null, securityFocus: false, inlineComments: false, pathInstructions: [], pathGuidance: "", repoInstructions: null, excludePaths: [], pathFilters: [], changedPaths: ["src/a.ts"],
            features: { grounding: false, rag: false, enrichment: false, reputation: false, cultureProfile: false, impactMap: false },
          }),
        },
      });
      // The marker says current — but NO check-run row exists for this head (a prior pass's check-run publish
      // itself failed/errored partway). Per markPullRequestSurfacePublished's own doc comment, the marker alone
      // must never be trusted for this.
      await repositoriesModule.markPullRequestSurfacePublished(env, "JSONbored/gittensory", 69, "a69");
      let checkRunCreated = false;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/69/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/69")) return Response.json({ number: 69, title: "Partially published PR", state: "open", user: { login: "contributor" }, head: { sha: "a69" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a69/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        if (url.endsWith("/check-runs") && init?.method === "POST") { checkRunCreated = true; return Response.json({ id: 1 }); }
        if (url.includes("/check-runs")) return Response.json({ id: 1 });
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "surface-no-skip", repoFullName: "JSONbored/gittensory", prNumber: 69, installationId: 123 });

      expect(checkRunCreated).toBe(true); // fell through to a real publish — the missing check-run backstop fired
      const skipAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.public_surface_publish_skipped_current", "JSONbored/gittensory#69")
        .first<{ n: number }>();
      expect(skipAudit?.n).toBe(0);
    });

    it("#6: a failed check-run read fails open — falls through to a full republish rather than crashing", async () => {
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }) } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 71, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a71" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 71, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      await putCachedAiReview(env, "JSONbored/gittensory", 71, "a71", "block", {
        notes: "Looks fine.",
        reviewerCount: 1,
        cacheable: true,
        metadata: {
          inputFingerprint: await aiReviewCacheInputFingerprint({
            title: "Current PR", mode: "block", byok: false, provider: null, model: null, aiReviewAllAuthors: false,
            aiReviewCloseConfidence: undefined, aiReviewCombine: null, aiReviewOnMerge: null, aiReviewReviewers: null, gatePack: "oss-anti-slop", reviewerPlan: env.AI_REVIEW_PLAN, selfHostProviderConfig: null, selfHostAiModelOverride: { claudeModel: null, claudeEffort: null, codexModel: null, codexEffort: null, ollamaModel: null, openaiModel: null, openaiCompatibleModel: null, anthropicModel: null },
            reviewFiles: [{ path: "src/a.ts", status: "modified", patch: "@@\n+export const ok = true;", additions: 1, deletions: 0 }],
            profile: null, securityFocus: false, inlineComments: false, pathInstructions: [], pathGuidance: "", repoInstructions: null, excludePaths: [], pathFilters: [], changedPaths: ["src/a.ts"],
            features: { grounding: false, rag: false, enrichment: false, reputation: false, cultureProfile: false, impactMap: false },
          }),
        },
      });
      await upsertCheckSummary(env, { id: "gate-71", repoFullName: "JSONbored/gittensory", pullNumber: 71, headSha: "a71", name: "LoopOver Orb Review Agent", status: "completed", conclusion: "success", payload: {} });
      await repositoriesModule.markPullRequestSurfacePublished(env, "JSONbored/gittensory", 71, "a71");
      let checkRunCreated = false;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/71/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/71")) return Response.json({ number: 71, title: "Current PR", state: "open", user: { login: "contributor" }, head: { sha: "a71" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a71/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        if (url.endsWith("/check-runs") && init?.method === "POST") { checkRunCreated = true; return Response.json({ id: 1 }); }
        if (url.includes("/check-runs")) return Response.json({ id: 1 });
        return Response.json({});
      });
      const listCheckSummariesSpy = vi.spyOn(repositoriesModule, "listCheckSummaries").mockRejectedValueOnce(new Error("D1 read error"));

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "surface-check-read-fail", repoFullName: "JSONbored/gittensory", prNumber: 71, installationId: 123 }),
      ).resolves.toBeUndefined();
      listCheckSummariesSpy.mockRestore();
      expect(checkRunCreated).toBe(true); // could not prove "already current" → fell through to a real publish
    });

    it("#9: a changed head still triggers a fresh AI review even within the cooldown window", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: "not-json" }; } } as unknown as Ai, // inconclusive → non-cacheable
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      // #one-shot-review-cadence: isolate this test to the cooldown-vs-real-state-change mechanism it's actually
      // about (see the PR 60 test above for the identical rationale).
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { auto_review: { cadence: "continuous" } } });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 63, title: "Pushed PR", state: "open", user: { login: "contributor" }, head: { sha: "a63" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 63, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      let liveHeadSha = "a63";
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/63/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/63")) return Response.json({ number: 63, title: "Pushed PR", state: "open", user: { login: "contributor" }, head: { sha: liveHeadSha }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/63/comments")) return method === "POST" ? Response.json({ id: 63 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });
      vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

      await processJob(env, { type: "agent-regate-pr", deliveryId: "head-change-1", repoFullName: "JSONbored/gittensory", prNumber: 63, installationId: 123 });
      const firstRunAiCalls = aiCalls;
      expect(firstRunAiCalls).toBeGreaterThan(0);

      // Two minutes later a real push lands (well within the cooldown window) — the head genuinely changed.
      vi.setSystemTime(new Date("2026-05-28T02:02:00.000Z"));
      liveHeadSha = "b63";
      await processJob(env, { type: "agent-regate-pr", deliveryId: "head-change-2", repoFullName: "JSONbored/gittensory", prNumber: 63, installationId: 123 });

      expect(aiCalls).toBe(firstRunAiCalls * 2); // a real state change bypasses the cooldown immediately, regardless of age
    });

    it("#8: a rate-limit-deferred re-enqueue of a forced re-gate carries the force flag and PR age forward", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedRegateChurnRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 68, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a68" }, labels: [], body: "Closes #1" });
      const rateLimitSpy = vi.spyOn(rateLimitModule, "shouldWaitForGitHubRateLimit").mockResolvedValueOnce("2026-05-28T03:00:00.000Z");
      let enqueued: import("../../src/types").JobMessage | undefined;
      const send = env.JOBS.send.bind(env.JOBS);
      env.JOBS.send = (async (message: import("../../src/types").JobMessage, options?: QueueSendOptions) => {
        enqueued = message;
        return send(message, options);
      }) as typeof env.JOBS.send;

      await processJob(env, { type: "agent-regate-pr", deliveryId: "rate-limited-force", repoFullName: "JSONbored/gittensory", prNumber: 68, installationId: 123, force: true, prCreatedAt: "2026-07-03T10:00:00.000Z" });

      rateLimitSpy.mockRestore();
      expect(enqueued).toMatchObject({ type: "agent-regate-pr", prNumber: 68, force: true, prCreatedAt: "2026-07-03T10:00:00.000Z" });
    });

    it("#8: a manual force re-gate bypasses the cache and cooldown, always paying for a fresh AI opinion", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 64, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a64" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 64, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/64/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/64")) return Response.json({ number: 64, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a64" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/64/comments")) return method === "POST" ? Response.json({ id: 64 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });
      vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

      await processJob(env, { type: "agent-regate-pr", deliveryId: "force-1", repoFullName: "JSONbored/gittensory", prNumber: 64, installationId: 123 });
      const firstRunAiCalls = aiCalls;
      expect(firstRunAiCalls).toBeGreaterThan(0);

      // A normal re-gate one minute later reuses the cached (cacheable) review — no new LLM spend.
      vi.setSystemTime(new Date("2026-05-28T02:01:00.000Z"));
      await processJob(env, { type: "agent-regate-pr", deliveryId: "force-2", repoFullName: "JSONbored/gittensory", prNumber: 64, installationId: 123 });
      expect(aiCalls).toBe(firstRunAiCalls);

      // An explicitly forced re-gate, seconds later, bypasses the cache and pays for a fresh opinion anyway.
      vi.setSystemTime(new Date("2026-05-28T02:01:05.000Z"));
      await processJob(env, { type: "agent-regate-pr", deliveryId: "force-3", repoFullName: "JSONbored/gittensory", prNumber: 64, installationId: 123, force: true });
      expect(aiCalls).toBe(firstRunAiCalls * 2);

      // The forced bypass is recorded distinctly from a genuine cache miss — a caller opting out is not the
      // same incident-dashboard signal as "the cache had nothing to serve."
      const forceAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_force_bypass", "JSONbored/gittensory#64")
        .first<{ n: number }>();
      expect(forceAudit?.n).toBe(1);
      const missAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_cache_miss", "JSONbored/gittensory#64")
        .first<{ n: number }>();
      expect(missAudit?.n).toBe(1); // only the genuine first-run miss — the forced pass is NOT double-counted here
    });

    it("#9: a low-activity repo's old open PR NEVER generates a repeated AI review across many sweep ticks once published (#regate-churn)", async () => {
      // Superseded policy note: this used to assert a BOUNDED, periodic retry (one fresh attempt per tick once
      // AI_REVIEW_NON_CACHEABLE_RETRY_COOLDOWN_MS elapsed) for a never-durably-cacheable (still-inconclusive)
      // outcome. That was itself the incident-mitigation for #1462, but it was still an UNBOUNDED total spend
      // over a PR's lifetime (one fresh call every cooldown window, forever, for as long as the PR stayed open
      // and inconclusive). The `published_at` marker (this PR) makes ANY review — cacheable or not — immutable
      // for its exact head+fingerprint the moment it is actually published: a tick past the cooldown no longer
      // buys a fresh attempt at all; only a real content/config change or an explicit maintainer force-rerun does.
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: "not-json" }; } } as unknown as Ai, // stuck inconclusive, like the real incident
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 65, title: "Old quiet PR", state: "open", user: { login: "contributor" }, head: { sha: "a65" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 65, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/65/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/65")) return Response.json({ number: 65, title: "Old quiet PR", state: "open", user: { login: "contributor" }, head: { sha: "a65" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/65/comments")) return method === "POST" ? Response.json({ id: 65 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      // A single review attempt makes more than one underlying `env.AI.run` call (dual-reviewer + retry
      // behavior) — measure that unit first so later assertions compare in ATTEMPTS, not raw call counts.
      vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
      await processJob(env, { type: "agent-regate-pr", deliveryId: "low-activity-baseline", repoFullName: "JSONbored/gittensory", prNumber: 65, installationId: 123 });
      const callsPerAttempt = aiCalls;
      expect(callsPerAttempt).toBeGreaterThan(0);

      // 5 more sweep ticks over a ~10-hour span (the production incident's 6h window had 97 sweep events for one
      // repo), each beyond what used to be the 30-minute cooldown — the unchanged PR's published review is now
      // reused indefinitely, so NONE of these buy a fresh attempt.
      const tickTimes = ["03:50:00", "05:40:00", "07:30:00", "09:20:00", "11:10:00"];
      for (const [index, time] of tickTimes.entries()) {
        vi.setSystemTime(new Date(`2026-05-28T${time}.000Z`));
        await processJob(env, { type: "agent-regate-pr", deliveryId: `low-activity-${index}`, repoFullName: "JSONbored/gittensory", prNumber: 65, installationId: 123 });
      }
      expect(aiCalls).toBe(callsPerAttempt); // still just the one, original attempt

      // Tighten four more ticks to well INSIDE what used to be the cooldown window — still zero additional spend.
      const tightTicks = ["12:00:00", "12:05:00", "12:10:00", "12:15:00"];
      for (const [index, time] of tightTicks.entries()) {
        vi.setSystemTime(new Date(`2026-05-28T${time}.000Z`));
        await processJob(env, { type: "agent-regate-pr", deliveryId: `low-activity-tight-${index}`, repoFullName: "JSONbored/gittensory", prNumber: 65, installationId: 123 });
      }
      expect(aiCalls).toBe(callsPerAttempt);
    });

    describe("#regate-churn: production reproductions (#3379, #3383) and the maintainer-gated freeze", () => {
    it("REPRODUCES #3379: a comment_and_label repo's unchanged PR gets no additional AI calls, no comment PATCH, and no re-created comment across repeated regate-sweep passes — label repair keeps running", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env, { publicSurface: "comment_and_label" });
      // #one-shot-review-cadence: isolate this test to the unchanged-head/label-repair mechanism it's about.
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { auto_review: { cadence: "continuous" } } });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 70, title: "Fix the retry loop", state: "open", user: { login: "contributor" }, head: { sha: "a70" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 70, status: "complete", reviewsSyncedAt: new Date().toISOString() });

      const stickyComment: { current: { id: number; body: string } | null } = { current: null };
      let commentPosts = 0;
      let commentPatches = 0;
      let labelPosts = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/70/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/70")) return Response.json({ number: 70, title: "Fix the retry loop", state: "open", user: { login: "contributor" }, head: { sha: "a70" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a70/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a70/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/issues/70/comments") && method === "GET") {
          return Response.json(stickyComment.current ? [{ ...stickyComment.current, user: { login: "gittensory[bot]", type: "Bot" } }] : []);
        }
        if (url.includes("/issues/70/comments") && method === "POST") {
          commentPosts += 1;
          const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          stickyComment.current = { id: 1, body };
          return Response.json({ id: 1 }, { status: 201 });
        }
        if (url.includes("/issues/comments/1") && method === "PATCH") {
          commentPatches += 1;
          const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          stickyComment.current = { id: 1, body };
          return Response.json({ id: 1 }, { status: 200 });
        }
        // The label GET always reports "missing" -- proving label repair keeps re-applying it every pass,
        // independent of the AI-review freeze/reuse logic (labels/assignees must repair without rewriting
        // the final review comment).
        if (url.includes("/issues/70/labels") && method === "GET") return Response.json([]);
        if (url.includes("/issues/70/labels") && method === "POST") {
          labelPosts += 1;
          return Response.json([]);
        }
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "webhook-open", repoFullName: "JSONbored/gittensory", prNumber: 70, installationId: 123 });
      const aiCallsAfterFirst = aiCalls;
      expect(aiCallsAfterFirst).toBeGreaterThan(0);
      expect(commentPosts).toBe(1); // the very first comment is a CREATE (placeholder, then patched to final)
      const patchesAfterFirst = commentPatches;
      expect(stickyComment.current?.body).not.toContain("is reviewing"); // settled to the final verdict
      const finalBody = stickyComment.current?.body;
      const labelPostsAfterFirst = labelPosts;
      expect(labelPostsAfterFirst).toBeGreaterThan(0);

      // Two later scheduled regate-sweep passes, matching the production delivery-id shape, over the SAME head.
      await processJob(env, { type: "agent-regate-pr", deliveryId: "regate-sweep:JSONbored/gittensory#70:1", repoFullName: "JSONbored/gittensory", prNumber: 70, installationId: 123 });
      await processJob(env, { type: "agent-regate-pr", deliveryId: "regate-sweep:JSONbored/gittensory#70:2", repoFullName: "JSONbored/gittensory", prNumber: 70, installationId: 123 });

      expect(aiCalls).toBe(aiCallsAfterFirst); // no additional AI calls
      expect(commentPosts).toBe(1); // never a second CREATE (no duplicate comment thread)
      expect(commentPatches).toBe(patchesAfterFirst); // no additional PATCH -- content is byte-identical, never rewritten
      expect(stickyComment.current?.body).toBe(finalBody); // the published comment never changed
      expect(labelPosts).toBeGreaterThan(labelPostsAfterFirst); // label repair keeps running on every later pass

      const reuseAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_cache_hit", "JSONbored/gittensory#70")
        .first<{ n: number }>();
      expect(reuseAudit?.n).toBe(2); // both later passes explicitly reused the durable cache
    });

    it("a PURE base-branch movement (no reviewed content change) triggers neither a fresh AI review nor a comment rewrite", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env, { publicSurface: "comment_only" });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 71, title: "Quiet PR", state: "open", user: { login: "contributor" }, head: { sha: "a71" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 71, status: "complete", reviewsSyncedAt: new Date().toISOString() });

      let baseSha = "main-tip-1";
      const stickyComment: { current: { id: number; body: string } | null } = { current: null };
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/71/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        // base.sha is the LIVE tip of the target branch -- it advances on every unrelated merge to it, with the
        // reviewed file's own patch content completely unaffected (#regate-churn root cause).
        if (url.endsWith("/pulls/71")) return Response.json({ number: 71, title: "Quiet PR", state: "open", user: { login: "contributor" }, head: { sha: "a71" }, base: { sha: baseSha }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a71/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a71/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/issues/71/comments") && method === "GET") {
          return Response.json(stickyComment.current ? [{ ...stickyComment.current, user: { login: "gittensory[bot]", type: "Bot" } }] : []);
        }
        if (url.includes("/issues/71/comments") && method === "POST") {
          const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          stickyComment.current = { id: 1, body };
          return Response.json({ id: 1 }, { status: 201 });
        }
        if (url.includes("/issues/comments/1") && method === "PATCH") {
          const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          stickyComment.current = { id: 1, body };
          return Response.json({ id: 1 }, { status: 200 });
        }
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "base-move-1", repoFullName: "JSONbored/gittensory", prNumber: 71, installationId: 123 });
      const aiCallsAfterFirst = aiCalls;
      expect(aiCallsAfterFirst).toBeGreaterThan(0);
      const finalBody = stickyComment.current?.body;

      // Main moved (some OTHER PR merged) -- the PR's own reviewed content is completely unchanged.
      baseSha = "main-tip-2";
      await processJob(env, { type: "agent-regate-pr", deliveryId: "base-move-2", repoFullName: "JSONbored/gittensory", prNumber: 71, installationId: 123 });

      expect(aiCalls).toBe(aiCallsAfterFirst); // no fresh AI review
      expect(stickyComment.current?.body).toBe(finalBody); // no comment rewrite
    });

    it("a REAL contributor code change DOES trigger a fresh AI review and an updated comment", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: {
          run: async () => {
            aiCalls += 1;
            return { response: JSON.stringify({ assessment: aiCalls === 1 ? "Looks fine." : "Second look also fine.", blockers: [], nits: [], suggestions: [] }) };
          },
        } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env, { publicSurface: "comment_only" });
      // #one-shot-review-cadence: isolate this test to the real-code-change-triggers-fresh-review mechanism.
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { auto_review: { cadence: "continuous" } } });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 72, title: "Evolving PR", state: "open", user: { login: "contributor" }, head: { sha: "a72" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 72, status: "complete", reviewsSyncedAt: new Date().toISOString() });

      let headSha = "a72";
      let patch = "@@\n+export const ok = true;";
      const stickyComment: { current: { id: number; body: string } | null } = { current: null };
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/72/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch }]);
        if (url.endsWith("/pulls/72")) return Response.json({ number: 72, title: "Evolving PR", state: "open", user: { login: "contributor" }, head: { sha: headSha }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes(`/commits/${headSha}/check-runs`)) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes(`/commits/${headSha}/status`)) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/issues/72/comments") && method === "GET") {
          return Response.json(stickyComment.current ? [{ ...stickyComment.current, user: { login: "gittensory[bot]", type: "Bot" } }] : []);
        }
        if (url.includes("/issues/72/comments") && method === "POST") {
          const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          stickyComment.current = { id: 1, body };
          return Response.json({ id: 1 }, { status: 201 });
        }
        if (url.includes("/issues/comments/1") && method === "PATCH") {
          const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          stickyComment.current = { id: 1, body };
          return Response.json({ id: 1 }, { status: 200 });
        }
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "content-change-1", repoFullName: "JSONbored/gittensory", prNumber: 72, installationId: 123 });
      expect(aiCalls).toBeGreaterThan(0);
      const aiCallsAfterFirst = aiCalls;
      const firstBody = stickyComment.current?.body;

      // The contributor genuinely pushes new code: a new head SHA with different patch content.
      headSha = "a72-v2";
      patch = "@@\n+export const ok = false; // real change";
      await processJob(env, { type: "agent-regate-pr", deliveryId: "content-change-2", repoFullName: "JSONbored/gittensory", prNumber: 72, installationId: 123 });

      expect(aiCalls).toBeGreaterThan(aiCallsAfterFirst); // a fresh review IS allowed for genuinely new content
      expect(stickyComment.current?.body).not.toBe(firstBody); // the comment reflects the new review
    });

    it("REPRODUCES the #3383 class: re-evaluating an unchanged, already-published subject never re-runs AI, so a published verdict cannot flip on its own", async () => {
      let aiCalls = 0;
      let secondPassStarted = false;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        // The mock is DELIBERATELY configured to flip to a blocking verdict for every call AFTER the first
        // review PASS (not the first raw call -- a single pass can make more than one underlying `env.AI.run`
        // call via dual-reviewer behavior, so gating on `secondPassStarted` keeps every call within one pass
        // consistent). If the fix regressed and AI ran again for the same unchanged subject, this would flip
        // the published gate from success to failure, exactly reproducing #3383's "held -> close" flip.
        AI: {
          run: async () => {
            aiCalls += 1;
            if (!secondPassStarted) return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) };
            return { response: JSON.stringify({ assessment: "Critical defect found on re-run.", blockers: ["x"], nits: [], suggestions: [] }) };
          },
        } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env, { publicSurface: "comment_only" });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 73, title: "CI-settling PR", state: "open", user: { login: "contributor" }, head: { sha: "a73" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 73, status: "complete", reviewsSyncedAt: new Date().toISOString() });

      const stickyComment: { current: { id: number; body: string } | null } = { current: null };
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/73/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/73")) return Response.json({ number: 73, title: "CI-settling PR", state: "open", user: { login: "contributor" }, head: { sha: "a73" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a73/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a73/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/issues/73/comments") && method === "GET") {
          return Response.json(stickyComment.current ? [{ ...stickyComment.current, user: { login: "gittensory[bot]", type: "Bot" } }] : []);
        }
        if (url.includes("/issues/73/comments") && method === "POST") {
          const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          stickyComment.current = { id: 1, body };
          return Response.json({ id: 1 }, { status: 201 });
        }
        if (url.includes("/issues/comments/1") && method === "PATCH") {
          const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          stickyComment.current = { id: 1, body };
          return Response.json({ id: 1 }, { status: 200 });
        }
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      // Pass 1: CI already settled — the review runs to completion and publishes a clean verdict.
      await processJob(env, { type: "agent-regate-pr", deliveryId: "ci-settle-1", repoFullName: "JSONbored/gittensory", prNumber: 73, installationId: 123 });
      const callsAfterFirstPass = aiCalls;
      expect(callsAfterFirstPass).toBeGreaterThan(0);
      expect(stickyComment.current?.body).not.toContain("Critical defect");
      secondPassStarted = true; // any call from here on would prove a flip-prone re-run happened

      // Pass 2: a later re-evaluation of the SAME unchanged subject (e.g. triggered by a check-run/check-suite
      // completion webhook re-firing the review). Must reuse the published result, not spend a second AI call.
      await processJob(env, { type: "agent-regate-pr", deliveryId: "ci-settle-2", repoFullName: "JSONbored/gittensory", prNumber: 73, installationId: 123 });
      expect(aiCalls).toBe(callsAfterFirstPass); // the flip-prone second pass never runs AI at all
      expect(stickyComment.current?.body).not.toContain("Critical defect"); // the published verdict never flips
    });

    it("an explicit maintainer force-rerun bypasses the published snapshot and pays for a fresh AI call, with a distinct audit reason", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env, { publicSurface: "comment_only" });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 74, title: "Force re-gate PR", state: "open", user: { login: "contributor" }, head: { sha: "a74" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 74, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/74/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/74")) return Response.json({ number: 74, title: "Force re-gate PR", state: "open", user: { login: "contributor" }, head: { sha: "a74" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a74/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a74/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/issues/74/comments")) return method === "POST" || method === "PATCH" ? Response.json({ id: 1 }, { status: 201 }) : Response.json([]);
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "force-baseline", repoFullName: "JSONbored/gittensory", prNumber: 74, installationId: 123 });
      const callsPerAttempt = aiCalls;
      expect(callsPerAttempt).toBeGreaterThan(0);

      // A same-head sweep tick would normally reuse — confirm that first, then force.
      await processJob(env, { type: "agent-regate-pr", deliveryId: "force-would-reuse", repoFullName: "JSONbored/gittensory", prNumber: 74, installationId: 123 });
      expect(aiCalls).toBe(callsPerAttempt);

      // An explicit maintainer/collaborator retrigger (the PR-panel checkbox) sets `force` on the job.
      await processJob(env, { type: "agent-regate-pr", deliveryId: "force-retrigger", repoFullName: "JSONbored/gittensory", prNumber: 74, installationId: 123, force: true });
      expect(aiCalls).toBe(callsPerAttempt * 2); // the snapshot is bypassed -- a fresh opinion is spent

      const forceAudit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_force_bypass", "JSONbored/gittensory#74")
        .first<{ outcome: string; detail: string }>();
      expect(forceAudit?.outcome).toBe("completed");
      expect(forceAudit?.detail).toContain("explicit force re-gate bypassed");
    });

    it("maintainer-gated freeze: a PR already held for manual review does not spend a fresh AI call on a later contributor push, even to a NEW head SHA", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Fresh (should not happen while frozen).", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env, { publicSurface: "comment_only" });
      // The PR is already carrying the manual-review label from a PRIOR pass (the disposition already held it),
      // and a review for its ORIGINAL head SHA was already published — the exact precondition the freeze exists
      // to protect: the contributor keeps pushing while waiting for a maintainer to actually look.
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 75, title: "Held PR", state: "open", user: { login: "contributor" }, head: { sha: "a75-v1" }, labels: [{ name: "manual-review" }], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 75, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      await putCachedAiReview(env, "JSONbored/gittensory", 75, "a75-v1", "block", { notes: "Original held review.", reviewerCount: 1 });
      await markAiReviewPublished(env, "JSONbored/gittensory", 75, "a75-v1");

      const stickyComment: { current: { id: number; body: string } | null } = { current: null };
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        // The contributor pushed AGAIN: a genuinely new head SHA, still carrying the manual-review label.
        if (url.includes("/pulls/75/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@\n+export const ok = true;\n+export const also = 1;" }]);
        if (url.endsWith("/pulls/75")) return Response.json({ number: 75, title: "Held PR", state: "open", user: { login: "contributor" }, head: { sha: "a75-v2" }, labels: [{ name: "manual-review" }], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a75-v2/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a75-v2/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/issues/75/comments") && method === "GET") {
          return Response.json(stickyComment.current ? [{ ...stickyComment.current, user: { login: "gittensory[bot]", type: "Bot" } }] : []);
        }
        if (url.includes("/issues/75/comments") && method === "POST") {
          const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          stickyComment.current = { id: 1, body };
          return Response.json({ id: 1 }, { status: 201 });
        }
        if (url.includes("/issues/comments/1") && method === "PATCH") {
          const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          stickyComment.current = { id: 1, body };
          return Response.json({ id: 1 }, { status: 200 });
        }
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "held-push-retry", repoFullName: "JSONbored/gittensory", prNumber: 75, installationId: 123 });

      expect(aiCalls).toBe(0); // frozen -- the new push never bought a fresh AI review
      expect(stickyComment.current?.body).toContain("Original held review."); // the OLD published verdict is reused
      const freezeAudit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_frozen_reuse", "JSONbored/gittensory#75")
        .first<{ outcome: string; detail: string }>();
      expect(freezeAudit?.outcome).toBe("completed");
      expect(freezeAudit?.detail).toContain("held for manual review");

      // An explicit maintainer/collaborator retrigger unfreezes it — a fresh AI call IS spent.
      await processJob(env, { type: "agent-regate-pr", deliveryId: "held-push-force-retrigger", repoFullName: "JSONbored/gittensory", prNumber: 75, installationId: 123, force: true });
      expect(aiCalls).toBeGreaterThan(0);
      const bypassAudit = await env.DB.prepare("select outcome from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_force_bypass", "JSONbored/gittensory#75")
        .first<{ outcome: string }>();
      expect(bypassAudit?.outcome).toBe("completed"); // the retrigger genuinely bypassed the freeze, not just a coincidental reuse
    });

    it("REGRESSION (#3725, reproduces #3702): the PR-panel rerun checkbox forces a fresh AI review instead of silently replaying a cached one", async () => {
      // #3702 showed "Code review: No blockers | No AI review summary" (reviewerCount 0) and re-checking the
      // panel's rerun checkbox repeatedly did not fix it -- the retrigger ran but never set `forceAiReview`, so
      // it kept reusing whatever was already cached for the unchanged head SHA instead of spending a fresh call.
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 90, title: "Clean PR awaiting retrigger", state: "open", user: { login: "contributor" }, head: { sha: "a90" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 90, status: "complete", reviewsSyncedAt: new Date().toISOString() });

      const checkedPanel = [
        "<!-- gittensory-pr-panel:v1 -->",
        "",
        "- [x] <!-- gittensory-rerun-review:v1 --> Re-run LoopOver review",
      ].join("\n");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" });
        if (url.includes("/pulls/90/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/90")) return Response.json({ number: 90, title: "Clean PR awaiting retrigger", state: "open", user: { login: "contributor" }, head: { sha: "a90" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/90/comments") && method === "GET") return Response.json([{ id: 777, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } }]);
        if (url.includes("/issues/comments/777") && method === "PATCH") return Response.json({ id: 777 });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      // Establish a real, cacheable review at the current head via a normal (non-forced) regate pass.
      await processJob(env, { type: "agent-regate-pr", deliveryId: "baseline", repoFullName: "JSONbored/gittensory", prNumber: 90, installationId: 123 });
      const baselineCalls = aiCalls;
      expect(baselineCalls).toBeGreaterThan(0);

      // A normal repeat pass at the SAME head reuses the cache -- matches the reported symptom (nothing changes).
      await processJob(env, { type: "agent-regate-pr", deliveryId: "repeat", repoFullName: "JSONbored/gittensory", prNumber: 90, installationId: 123 });
      expect(aiCalls).toBe(baselineCalls);

      // Checking the panel's "Re-run LoopOver review" checkbox must force a FRESH AI opinion, not silently
      // replay the cached one -- this is the exact #3702 bug: the checkbox did nothing without forceAiReview.
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "panel-retrigger-forces-fresh-review",
        eventName: "issue_comment",
        payload: {
          action: "edited",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 90, title: "Clean PR awaiting retrigger", state: "open", user: { login: "contributor" }, pull_request: {} },
          comment: { id: 777, body: checkedPanel, user: { login: "gittensory[bot]", type: "Bot" } },
          sender: { login: "maintainer", type: "User" },
        },
      });

      expect(aiCalls).toBe(baselineCalls * 2); // a genuinely fresh AI call was spent, not a replay
      const bypassAudit = await env.DB.prepare("select outcome from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_force_bypass", "JSONbored/gittensory#90")
        .first<{ outcome: string }>();
      expect(bypassAudit?.outcome).toBe("completed");
    });

    describe("one-shot AI review cadence (#one-shot-review-cadence)", () => {
      it("default (one_shot, no manual-review label): a genuinely NEW push does not spend a fresh main-review AI call -- reuses the prior published review", async () => {
        let aiCalls = 0;
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Fresh (should not happen under one-shot).", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
          AI_DAILY_NEURON_BUDGET: "100000",
        });
        // No cadence override anywhere (no yml, no GITTENSORY_REVIEW_CONTINUOUS) -- one_shot is the codebase default.
        await seedRegateChurnRepo(env, { publicSurface: "comment_only" });
        await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 91, title: "One-shot PR", state: "open", user: { login: "contributor" }, head: { sha: "a91-v1" }, labels: [], body: "Closes #1" });
        await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 91, status: "complete", reviewsSyncedAt: new Date().toISOString() });
        await putCachedAiReview(env, "JSONbored/gittensory", 91, "a91-v1", "block", { notes: "Original one-shot review.", reviewerCount: 1 });
        await markAiReviewPublished(env, "JSONbored/gittensory", 91, "a91-v1");

        let publicCommentBody = "";
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
          // A genuinely NEW push -- a new head SHA, no manual-review label anywhere.
          if (url.includes("/pulls/91/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@\n+export const ok = true;\n+export const also = 1;" }]);
          if (url.endsWith("/pulls/91")) return Response.json({ number: 91, title: "One-shot PR", state: "open", user: { login: "contributor" }, head: { sha: "a91-v2" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
          if (url.includes("/commits/a91-v2/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
          if (url.includes("/commits/a91-v2/status")) return Response.json({ state: "success", statuses: [] });
          if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
          if (url.includes("/issues/91/comments") && method === "GET") return Response.json([]);
          if (url.includes("/issues/91/comments") && method === "POST") {
            publicCommentBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
            return Response.json({ id: 1 }, { status: 201 });
          }
          if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
          return Response.json({});
        });

        await processJob(env, { type: "agent-regate-pr", deliveryId: "one-shot-push", repoFullName: "JSONbored/gittensory", prNumber: 91, installationId: 123 });

        expect(aiCalls).toBe(0); // the new head never bought a fresh AI review
        expect(publicCommentBody).toContain("Original one-shot review.");
        const reuseAudit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? and target_key = ?")
          .bind("github_app.ai_review_one_shot_reuse", "JSONbored/gittensory#91")
          .first<{ outcome: string; detail: string }>();
        expect(reuseAudit?.outcome).toBe("completed");
        expect(reuseAudit?.detail).toContain("one-shot review cadence");
      });

      it("default (one_shot): a PR with no prior review yet still gets its first pass -- one-shot never blocks the FIRST review", async () => {
        let aiCalls = 0;
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "First pass.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
          AI_DAILY_NEURON_BUDGET: "100000",
        });
        await seedRegateChurnRepo(env, { publicSurface: "comment_only" });
        await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 92, title: "Brand-new PR", state: "open", user: { login: "contributor" }, head: { sha: "a92" }, labels: [], body: "Closes #1" });
        await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 92, status: "complete", reviewsSyncedAt: new Date().toISOString() });
        // Deliberately NO prior putCachedAiReview/markAiReviewPublished -- this PR has never been reviewed.

        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
          if (url.includes("/pulls/92/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
          if (url.endsWith("/pulls/92")) return Response.json({ number: 92, title: "Brand-new PR", state: "open", user: { login: "contributor" }, head: { sha: "a92" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
          if (url.includes("/commits/a92/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
          if (url.includes("/commits/a92/status")) return Response.json({ state: "success", statuses: [] });
          if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
          if (url.includes("/issues/92/comments")) return method === "GET" ? Response.json([]) : Response.json({ id: 1 }, { status: 201 });
          if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
          return Response.json({});
        });

        await processJob(env, { type: "agent-regate-pr", deliveryId: "one-shot-first-pass", repoFullName: "JSONbored/gittensory", prNumber: 92, installationId: 123 });

        expect(aiCalls).toBeGreaterThan(0); // the very first pass is never suppressed by one-shot mode
        const reuseAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
          .bind("github_app.ai_review_one_shot_reuse", "JSONbored/gittensory#92")
          .first<{ n: number }>();
        expect(reuseAudit?.n).toBe(0); // no reuse fired -- there was nothing to reuse
      });

      it("default (one_shot): a repeat trigger does not spend a fresh SLOP advisory call once this PR already had one, regardless of head SHA", async () => {
        let aiCalls = 0;
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ risk: "low", rationale: "fine" }) }; } } as unknown as Ai,
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
          AI_DAILY_NEURON_BUDGET: "100000",
        });
        await seedRegateChurnRepo(env, { publicSurface: "comment_only", aiReviewMode: "off", slopGateMode: "advisory", slopAiAdvisory: true });
        await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 93, title: "Slop one-shot PR", state: "open", user: { login: "contributor" }, head: { sha: "a93-v1" }, labels: [], body: "Closes #1" });
        await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 93, status: "complete", reviewsSyncedAt: new Date().toISOString() });
        // A slop advisory row already exists for an EARLIER head -- this PR already had its one-shot slop pass.
        await putCachedAiSlopAdvisory(env, "JSONbored/gittensory", 93, "a93-v1", "seed-fp", { status: "ok", band: "low", finding: null, estimatedNeurons: 4 });

        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
          if (url.includes("/pulls/93/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@\n+export const ok = true;\n+export const also = 1;" }]);
          if (url.endsWith("/pulls/93")) return Response.json({ number: 93, title: "Slop one-shot PR", state: "open", user: { login: "contributor" }, head: { sha: "a93-v2" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
          if (url.includes("/commits/a93-v2/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
          if (url.includes("/commits/a93-v2/status")) return Response.json({ state: "success", statuses: [] });
          if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
          if (url.includes("/issues/93/comments")) return method === "GET" ? Response.json([]) : Response.json({ id: 1 }, { status: 201 });
          if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
          return Response.json({});
        });

        await processJob(env, { type: "agent-regate-pr", deliveryId: "one-shot-slop-push", repoFullName: "JSONbored/gittensory", prNumber: 93, installationId: 123 });

        expect(aiCalls).toBe(0); // no fresh slop LLM call on the new head
        const skipAudit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? and target_key = ?")
          .bind("github_app.ai_slop_one_shot_skip", "JSONbored/gittensory#93")
          .first<{ outcome: string; detail: string }>();
        expect(skipAudit?.outcome).toBe("completed");
        expect(skipAudit?.detail).toContain("one-shot review cadence");
      });

      it("default (one_shot): a NEWLY-linked issue still gets its own linked-issue-satisfaction pass even though the PR already has one for a DIFFERENT issue", async () => {
        let aiCalls = 0;
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ status: "addressed", rationale: "looks done" }) }; } } as unknown as Ai,
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
          AI_DAILY_NEURON_BUDGET: "100000",
        });
        await seedRegateChurnRepo(env, { publicSurface: "comment_only", aiReviewMode: "off", linkedIssueSatisfactionGateMode: "advisory" });
        // The PR now cites issue #2 as its primary linked issue -- a prior pass exists only for issue #1, a
        // DIFFERENT (now-superseded) issue, so issue #2 must still be treated as never-assessed.
        await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 94, title: "Re-linked PR", state: "open", user: { login: "contributor" }, head: { sha: "a94" }, labels: [], body: "Closes #2" });
        await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 94, status: "complete", reviewsSyncedAt: new Date().toISOString() });
        await putCachedLinkedIssueSatisfaction(env, "JSONbored/gittensory", 94, "a94-old", 1, "seed-fp", { status: "ok", result: { status: "addressed", rationale: "old issue was done", confidence: 0.9 }, estimatedNeurons: 4 });

        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
          if (url.includes("/pulls/94/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
          if (url.endsWith("/pulls/94")) return Response.json({ number: 94, title: "Re-linked PR", state: "open", user: { login: "contributor" }, head: { sha: "a94" }, labels: [], body: "Closes #2", mergeable_state: "clean" });
          if (url.includes("/commits/a94/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
          if (url.includes("/commits/a94/status")) return Response.json({ state: "success", statuses: [] });
          if (url.includes("/issues/2")) return Response.json({ number: 2, title: "Second issue", state: "open", labels: [], user: { login: "reporter" }, body: "Do the second thing." });
          if (url.includes("/issues/94/comments")) return method === "GET" ? Response.json([]) : Response.json({ id: 1 }, { status: 201 });
          if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
          return Response.json({});
        });

        await processJob(env, { type: "agent-regate-pr", deliveryId: "one-shot-relinked", repoFullName: "JSONbored/gittensory", prNumber: 94, installationId: 123 });

        expect(aiCalls).toBeGreaterThan(0); // issue #2 was never assessed before -- gets its own first pass
        const skipAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
          .bind("github_app.linked_issue_satisfaction_one_shot_skip", "JSONbored/gittensory#94")
          .first<{ n: number }>();
        expect(skipAudit?.n).toBe(0); // never skipped -- issue #2 genuinely had no prior pass
      });

      it("default (one_shot): a repeat trigger does not spend a fresh linked-issue-satisfaction call once the SAME primary issue already has one", async () => {
        let aiCalls = 0;
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ status: "addressed", rationale: "looks done" }) }; } } as unknown as Ai,
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
          AI_DAILY_NEURON_BUDGET: "100000",
        });
        await seedRegateChurnRepo(env, { publicSurface: "comment_only", aiReviewMode: "off", linkedIssueSatisfactionGateMode: "advisory" });
        // The PR's primary linked issue is #1 -- SAME issue the prior pass already assessed (at an earlier head).
        await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 97, title: "Same-issue PR", state: "open", user: { login: "contributor" }, head: { sha: "a97-v1" }, labels: [], body: "Closes #1" });
        await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 97, status: "complete", reviewsSyncedAt: new Date().toISOString() });
        await putCachedLinkedIssueSatisfaction(env, "JSONbored/gittensory", 97, "a97-v1", 1, "seed-fp", { status: "ok", result: { status: "addressed", rationale: "already done", confidence: 0.9 }, estimatedNeurons: 4 });

        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
          // A genuinely NEW push -- a new head SHA, but the SAME primary linked issue (#1).
          if (url.includes("/pulls/97/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@\n+export const ok = true;\n+export const also = 1;" }]);
          if (url.endsWith("/pulls/97")) return Response.json({ number: 97, title: "Same-issue PR", state: "open", user: { login: "contributor" }, head: { sha: "a97-v2" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
          if (url.includes("/commits/a97-v2/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
          if (url.includes("/commits/a97-v2/status")) return Response.json({ state: "success", statuses: [] });
          if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
          if (url.includes("/issues/97/comments")) return method === "GET" ? Response.json([]) : Response.json({ id: 1 }, { status: 201 });
          if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
          return Response.json({});
        });

        await processJob(env, { type: "agent-regate-pr", deliveryId: "one-shot-same-issue-push", repoFullName: "JSONbored/gittensory", prNumber: 97, installationId: 123 });

        expect(aiCalls).toBe(0); // no fresh linked-issue-satisfaction call on the new head -- same issue already assessed
        const skipAudit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? and target_key = ?")
          .bind("github_app.linked_issue_satisfaction_one_shot_skip", "JSONbored/gittensory#97")
          .first<{ outcome: string; detail: string }>();
        expect(skipAudit?.outcome).toBe("completed");
        expect(skipAudit?.detail).toContain("one-shot review cadence");
      });

      it("default (one_shot): a repeat trigger replays a cached unaddressed linked-issue blocker in block mode", async () => {
        let aiCalls = 0;
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ status: "addressed", rationale: "fresh call should not run" }) }; } } as unknown as Ai,
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
          AI_DAILY_NEURON_BUDGET: "100000",
        });
        await seedRegateChurnRepo(env, { publicSurface: "comment_only", aiReviewMode: "off", linkedIssueSatisfactionGateMode: "block" });
        await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 98, title: "Same-issue blocker PR", state: "open", user: { login: "contributor" }, head: { sha: "a98-v1" }, labels: [], body: "Closes #1" });
        await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 98, status: "complete", reviewsSyncedAt: new Date().toISOString() });
        await putCachedLinkedIssueSatisfaction(env, "JSONbored/gittensory", 98, "a98-v1", 1, "seed-fp", { status: "ok", result: { status: "unaddressed", rationale: "still does not implement the requested stream", confidence: 0.91 }, estimatedNeurons: 4 });

        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
          if (url.includes("/pulls/98/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@\n+export const ok = true;\n+export const also = 1;" }]);
          if (url.endsWith("/pulls/98")) return Response.json({ number: 98, title: "Same-issue blocker PR", state: "open", user: { login: "contributor" }, head: { sha: "a98-v2" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
          if (url.includes("/commits/a98-v2/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
          if (url.includes("/commits/a98-v2/status")) return Response.json({ state: "success", statuses: [] });
          if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
          if (url.includes("/issues/98/comments")) return method === "GET" ? Response.json([]) : Response.json({ id: 1 }, { status: 201 });
          if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
          return Response.json({});
        });

        await processJob(env, { type: "agent-regate-pr", deliveryId: "one-shot-same-issue-blocker-push", repoFullName: "JSONbored/gittensory", prNumber: 98, installationId: 123 });

        expect(aiCalls).toBe(0);
        const summary = await env.DB.prepare("select conclusion from check_summaries where repo_full_name = ? and pull_number = ? and head_sha = ?")
          .bind("JSONbored/gittensory", 98, "a98-v2")
          .first<{ conclusion: string }>();
        expect(summary?.conclusion).toBe("failure");
        const blocker = await env.DB.prepare("select blocker_codes_json as blockerCodesJson from gate_outcomes where repo_full_name = ? and pull_number = ? and head_sha = ?")
          .bind("JSONbored/gittensory", 98, "a98-v2")
          .first<{ blockerCodesJson: string }>();
        expect(JSON.parse(blocker?.blockerCodesJson ?? "[]")).toContain("linked_issue_scope_mismatch");
      });

      it("default (one_shot, block mode): a failed replay-lookup falls through without pushing a blocker (fail-safe), even though a genuinely unaddressed row exists", async () => {
        let aiCalls = 0;
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ status: "addressed", rationale: "fresh call should not run" }) }; } } as unknown as Ai,
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
          AI_DAILY_NEURON_BUDGET: "100000",
        });
        await seedRegateChurnRepo(env, { publicSurface: "comment_only", aiReviewMode: "off", linkedIssueSatisfactionGateMode: "block" });
        await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 101, title: "Replay-read-fails PR", state: "open", user: { login: "contributor" }, head: { sha: "a101-v1" }, labels: [], body: "Closes #1" });
        await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 101, status: "complete", reviewsSyncedAt: new Date().toISOString() });
        // The EXISTENCE check (hasPublishedLinkedIssueSatisfaction) that gates the one-shot skip stays real and
        // sees this row -- only the separate REPLAY read (getLatestPublishedLinkedIssueSatisfaction) below is
        // made to fail, proving its `.catch(() => null)` fail-safe never spuriously blocks (or throws) a PR just
        // because the prior verdict couldn't be read back for replay.
        await putCachedLinkedIssueSatisfaction(env, "JSONbored/gittensory", 101, "a101-v1", 1, "seed-fp", { status: "ok", result: { status: "unaddressed", rationale: "still does not implement the requested stream", confidence: 0.91 }, estimatedNeurons: 4 });

        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
          if (url.includes("/pulls/101/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@\n+export const ok = true;\n+export const also = 1;" }]);
          if (url.endsWith("/pulls/101")) return Response.json({ number: 101, title: "Replay-read-fails PR", state: "open", user: { login: "contributor" }, head: { sha: "a101-v2" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
          if (url.includes("/commits/a101-v2/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
          if (url.includes("/commits/a101-v2/status")) return Response.json({ state: "success", statuses: [] });
          if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
          if (url.includes("/issues/101/comments")) return method === "GET" ? Response.json([]) : Response.json({ id: 1 }, { status: 201 });
          if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
          return Response.json({});
        });

        const readSpy = vi.spyOn(repositoriesModule, "getLatestPublishedLinkedIssueSatisfaction").mockRejectedValueOnce(new Error("D1 read error"));
        await expect(
          processJob(env, { type: "agent-regate-pr", deliveryId: "one-shot-replay-read-fails", repoFullName: "JSONbored/gittensory", prNumber: 101, installationId: 123 }),
        ).resolves.toBeUndefined();
        readSpy.mockRestore();

        expect(aiCalls).toBe(0); // still skipped -- the existence check alone gates the one-shot skip
        const summary = await env.DB.prepare("select conclusion from check_summaries where repo_full_name = ? and pull_number = ? and head_sha = ?")
          .bind("JSONbored/gittensory", 101, "a101-v2")
          .first<{ conclusion: string }>();
        expect(summary?.conclusion).not.toBe("failure");
        const blocker = await env.DB.prepare("select blocker_codes_json as blockerCodesJson from gate_outcomes where repo_full_name = ? and pull_number = ? and head_sha = ?")
          .bind("JSONbored/gittensory", 101, "a101-v2")
          .first<{ blockerCodesJson: string }>();
        expect(JSON.parse(blocker?.blockerCodesJson ?? "[]")).not.toContain("linked_issue_scope_mismatch");
        const skipAudit = await env.DB.prepare("select outcome from audit_events where event_type = ? and target_key = ?")
          .bind("github_app.linked_issue_satisfaction_one_shot_skip", "JSONbored/gittensory#101")
          .first<{ outcome: string }>();
        expect(skipAudit?.outcome).toBe("completed"); // the skip itself still completes normally despite the failed replay read
      });

      it("default (one_shot, block mode): a replayed 'addressed' prior verdict never pushes a blocker (only an 'unaddressed' verdict does)", async () => {
        let aiCalls = 0;
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ status: "unaddressed", rationale: "fresh call should not run" }) }; } } as unknown as Ai,
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
          AI_DAILY_NEURON_BUDGET: "100000",
        });
        await seedRegateChurnRepo(env, { publicSurface: "comment_only", aiReviewMode: "off", linkedIssueSatisfactionGateMode: "block" });
        await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 102, title: "Addressed-replay PR", state: "open", user: { login: "contributor" }, head: { sha: "a102-v1" }, labels: [], body: "Closes #1" });
        await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 102, status: "complete", reviewsSyncedAt: new Date().toISOString() });
        await putCachedLinkedIssueSatisfaction(env, "JSONbored/gittensory", 102, "a102-v1", 1, "seed-fp", { status: "ok", result: { status: "addressed", rationale: "fully implements the requested stream", confidence: 0.95 }, estimatedNeurons: 4 });

        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
          if (url.includes("/pulls/102/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@\n+export const ok = true;\n+export const also = 1;" }]);
          if (url.endsWith("/pulls/102")) return Response.json({ number: 102, title: "Addressed-replay PR", state: "open", user: { login: "contributor" }, head: { sha: "a102-v2" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
          if (url.includes("/commits/a102-v2/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
          if (url.includes("/commits/a102-v2/status")) return Response.json({ state: "success", statuses: [] });
          if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
          if (url.includes("/issues/102/comments")) return method === "GET" ? Response.json([]) : Response.json({ id: 1 }, { status: 201 });
          if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
          return Response.json({});
        });

        await processJob(env, { type: "agent-regate-pr", deliveryId: "one-shot-addressed-replay", repoFullName: "JSONbored/gittensory", prNumber: 102, installationId: 123 });

        expect(aiCalls).toBe(0);
        const summary = await env.DB.prepare("select conclusion from check_summaries where repo_full_name = ? and pull_number = ? and head_sha = ?")
          .bind("JSONbored/gittensory", 102, "a102-v2")
          .first<{ conclusion: string }>();
        expect(summary?.conclusion).not.toBe("failure");
        const blocker = await env.DB.prepare("select blocker_codes_json as blockerCodesJson from gate_outcomes where repo_full_name = ? and pull_number = ? and head_sha = ?")
          .bind("JSONbored/gittensory", 102, "a102-v2")
          .first<{ blockerCodesJson: string }>();
        expect(JSON.parse(blocker?.blockerCodesJson ?? "[]")).not.toContain("linked_issue_scope_mismatch");
      });

      it("default (one_shot, advisory mode): a replayed unaddressed prior verdict is reused for display but never pushes a hard blocker (only block mode does)", async () => {
        let aiCalls = 0;
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ status: "addressed", rationale: "fresh call should not run" }) }; } } as unknown as Ai,
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
          AI_DAILY_NEURON_BUDGET: "100000",
        });
        // advisory (not block) -- the same "unaddressed" stored verdict as the block-mode regression test above,
        // so the ONLY variable changed is linkedIssueSatisfactionGateMode itself.
        await seedRegateChurnRepo(env, { publicSurface: "comment_only", aiReviewMode: "off", linkedIssueSatisfactionGateMode: "advisory" });
        await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 103, title: "Advisory-replay PR", state: "open", user: { login: "contributor" }, head: { sha: "a103-v1" }, labels: [], body: "Closes #1" });
        await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 103, status: "complete", reviewsSyncedAt: new Date().toISOString() });
        await putCachedLinkedIssueSatisfaction(env, "JSONbored/gittensory", 103, "a103-v1", 1, "seed-fp", { status: "ok", result: { status: "unaddressed", rationale: "still does not implement the requested stream", confidence: 0.91 }, estimatedNeurons: 4 });

        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
          if (url.includes("/pulls/103/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@\n+export const ok = true;\n+export const also = 1;" }]);
          if (url.endsWith("/pulls/103")) return Response.json({ number: 103, title: "Advisory-replay PR", state: "open", user: { login: "contributor" }, head: { sha: "a103-v2" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
          if (url.includes("/commits/a103-v2/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
          if (url.includes("/commits/a103-v2/status")) return Response.json({ state: "success", statuses: [] });
          if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
          if (url.includes("/issues/103/comments")) return method === "GET" ? Response.json([]) : Response.json({ id: 1 }, { status: 201 });
          if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
          return Response.json({});
        });

        await processJob(env, { type: "agent-regate-pr", deliveryId: "one-shot-advisory-replay", repoFullName: "JSONbored/gittensory", prNumber: 103, installationId: 123 });

        expect(aiCalls).toBe(0);
        const summary = await env.DB.prepare("select conclusion from check_summaries where repo_full_name = ? and pull_number = ? and head_sha = ?")
          .bind("JSONbored/gittensory", 103, "a103-v2")
          .first<{ conclusion: string }>();
        expect(summary?.conclusion).not.toBe("failure"); // advisory mode never hard-blocks, even on an unaddressed replay
        const blocker = await env.DB.prepare("select blocker_codes_json as blockerCodesJson from gate_outcomes where repo_full_name = ? and pull_number = ? and head_sha = ?")
          .bind("JSONbored/gittensory", 103, "a103-v2")
          .first<{ blockerCodesJson: string }>();
        expect(JSON.parse(blocker?.blockerCodesJson ?? "[]")).not.toContain("linked_issue_scope_mismatch");
      });

      it("per-repo override (continuous via .gittensory.yml): a new push DOES spend a fresh main-review AI call, unlike the one_shot default", async () => {
        let aiCalls = 0;
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Continuous re-review.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
          AI_DAILY_NEURON_BUDGET: "100000",
        });
        await seedRegateChurnRepo(env, { publicSurface: "comment_only" });
        await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { auto_review: { cadence: "continuous" } } });
        await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 95, title: "Continuous-mode PR", state: "open", user: { login: "contributor" }, head: { sha: "a95-v1" }, labels: [], body: "Closes #1" });
        await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 95, status: "complete", reviewsSyncedAt: new Date().toISOString() });
        await putCachedAiReview(env, "JSONbored/gittensory", 95, "a95-v1", "block", { notes: "Original review.", reviewerCount: 1 });
        await markAiReviewPublished(env, "JSONbored/gittensory", 95, "a95-v1");

        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
          if (url.includes("/pulls/95/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@\n+export const ok = true;\n+export const also = 1;" }]);
          if (url.endsWith("/pulls/95")) return Response.json({ number: 95, title: "Continuous-mode PR", state: "open", user: { login: "contributor" }, head: { sha: "a95-v2" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
          if (url.includes("/commits/a95-v2/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
          if (url.includes("/commits/a95-v2/status")) return Response.json({ state: "success", statuses: [] });
          if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
          if (url.includes("/issues/95/comments")) return method === "GET" ? Response.json([]) : Response.json({ id: 1 }, { status: 201 });
          if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
          return Response.json({});
        });

        await processJob(env, { type: "agent-regate-pr", deliveryId: "continuous-push", repoFullName: "JSONbored/gittensory", prNumber: 95, installationId: 123 });

        expect(aiCalls).toBeGreaterThan(0); // continuous mode: the new head DOES buy a fresh AI review
        const reuseAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
          .bind("github_app.ai_review_one_shot_reuse", "JSONbored/gittensory#95")
          .first<{ n: number }>();
        expect(reuseAudit?.n).toBe(0); // one-shot reuse never engaged -- this repo opted out
      });

      it("fleet-wide env default (GITTENSORY_REVIEW_CONTINUOUS): applies when the repo has no yml override, but a repo override still wins over it", async () => {
        let aiCalls = 0;
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          GITTENSORY_REVIEW_CONTINUOUS: "true",
          AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Fleet-wide continuous.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
          AI_DAILY_NEURON_BUDGET: "100000",
        });
        await seedRegateChurnRepo(env, { publicSurface: "comment_only" });
        // No per-repo cadence override -- inherits the fleet-wide GITTENSORY_REVIEW_CONTINUOUS default.
        await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 96, title: "Fleet-default PR", state: "open", user: { login: "contributor" }, head: { sha: "a96-v1" }, labels: [], body: "Closes #1" });
        await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 96, status: "complete", reviewsSyncedAt: new Date().toISOString() });
        await putCachedAiReview(env, "JSONbored/gittensory", 96, "a96-v1", "block", { notes: "Original review.", reviewerCount: 1 });
        await markAiReviewPublished(env, "JSONbored/gittensory", 96, "a96-v1");

        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
          if (url.includes("/pulls/96/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@\n+export const ok = true;\n+export const also = 1;" }]);
          if (url.endsWith("/pulls/96")) return Response.json({ number: 96, title: "Fleet-default PR", state: "open", user: { login: "contributor" }, head: { sha: "a96-v2" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
          if (url.includes("/commits/a96-v2/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
          if (url.includes("/commits/a96-v2/status")) return Response.json({ state: "success", statuses: [] });
          if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
          if (url.includes("/issues/96/comments")) return method === "GET" ? Response.json([]) : Response.json({ id: 1 }, { status: 201 });
          if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
          return Response.json({});
        });

        await processJob(env, { type: "agent-regate-pr", deliveryId: "fleet-continuous-push", repoFullName: "JSONbored/gittensory", prNumber: 96, installationId: 123 });

        expect(aiCalls).toBeGreaterThan(0); // the fleet-wide env default applied since the repo set no override
      });

      it("swallows a hasPublishedAiSlopAdvisory read failure and a slop one-shot-skip audit write failure without throwing", async () => {
        let aiCalls = 0;
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ risk: "low", rationale: "fine" }) }; } } as unknown as Ai,
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
          AI_DAILY_NEURON_BUDGET: "100000",
        });
        await seedRegateChurnRepo(env, { publicSurface: "comment_only", aiReviewMode: "off", slopGateMode: "advisory", slopAiAdvisory: true });
        await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 98, title: "Slop flaky-read PR", state: "open", user: { login: "contributor" }, head: { sha: "a98" }, labels: [], body: "Closes #1" });
        await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 98, status: "complete", reviewsSyncedAt: new Date().toISOString() });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
          if (url.includes("/pulls/98/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
          if (url.endsWith("/pulls/98")) return Response.json({ number: 98, title: "Slop flaky-read PR", state: "open", user: { login: "contributor" }, head: { sha: "a98" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
          if (url.includes("/commits/a98/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
          if (url.includes("/commits/a98/status")) return Response.json({ state: "success", statuses: [] });
          if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
          if (url.includes("/issues/98/comments")) return method === "GET" ? Response.json([]) : Response.json({ id: 1 }, { status: 201 });
          if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
          return Response.json({});
        });

        const readSpy = vi.spyOn(repositoriesModule, "hasPublishedAiSlopAdvisory").mockRejectedValueOnce(new Error("D1 read error"));
        await expect(
          processJob(env, { type: "agent-regate-pr", deliveryId: "slop-existence-read-fails", repoFullName: "JSONbored/gittensory", prNumber: 98, installationId: 123 }),
        ).resolves.toBeUndefined();
        readSpy.mockRestore();
        expect(aiCalls).toBeGreaterThan(0); // fail-safe treats the read failure as "not skipped" -- a fresh slop call still runs

        await putCachedAiSlopAdvisory(env, "JSONbored/gittensory", 98, "a98", "seed-fp", { status: "ok", band: "low", finding: null, estimatedNeurons: 4 });
        const originalRecordAuditEvent = repositoriesModule.recordAuditEvent;
        const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockImplementation(async (auditEnv, event) => {
          if (event.eventType === "github_app.ai_slop_one_shot_skip") throw new Error("audit DB down");
          await originalRecordAuditEvent(auditEnv, event);
        });
        await expect(
          processJob(env, { type: "agent-regate-pr", deliveryId: "slop-skip-audit-fails", repoFullName: "JSONbored/gittensory", prNumber: 98, installationId: 123 }),
        ).resolves.toBeUndefined();
        auditSpy.mockRestore();
      });

      it("swallows a hasPublishedLinkedIssueSatisfaction read failure and a linked-issue one-shot-skip audit write failure without throwing", async () => {
        let aiCalls = 0;
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ status: "addressed", rationale: "looks done" }) }; } } as unknown as Ai,
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
          AI_DAILY_NEURON_BUDGET: "100000",
        });
        await seedRegateChurnRepo(env, { publicSurface: "comment_only", aiReviewMode: "off", linkedIssueSatisfactionGateMode: "advisory" });
        await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 99, title: "Linked-issue flaky-read PR", state: "open", user: { login: "contributor" }, head: { sha: "a99" }, labels: [], body: "Closes #1" });
        await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 99, status: "complete", reviewsSyncedAt: new Date().toISOString() });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
          if (url.includes("/pulls/99/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
          if (url.endsWith("/pulls/99")) return Response.json({ number: 99, title: "Linked-issue flaky-read PR", state: "open", user: { login: "contributor" }, head: { sha: "a99" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
          if (url.includes("/commits/a99/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
          if (url.includes("/commits/a99/status")) return Response.json({ state: "success", statuses: [] });
          if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
          if (url.includes("/issues/99/comments")) return method === "GET" ? Response.json([]) : Response.json({ id: 1 }, { status: 201 });
          if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
          return Response.json({});
        });

        const readSpy = vi.spyOn(repositoriesModule, "hasPublishedLinkedIssueSatisfaction").mockRejectedValueOnce(new Error("D1 read error"));
        await expect(
          processJob(env, { type: "agent-regate-pr", deliveryId: "linked-issue-existence-read-fails", repoFullName: "JSONbored/gittensory", prNumber: 99, installationId: 123 }),
        ).resolves.toBeUndefined();
        readSpy.mockRestore();
        expect(aiCalls).toBeGreaterThan(0); // fail-safe treats the read failure as "not skipped" -- a fresh assessment still runs

        await putCachedLinkedIssueSatisfaction(env, "JSONbored/gittensory", 99, "a99", 1, "seed-fp", { status: "ok", result: { status: "addressed", rationale: "already done", confidence: 0.9 }, estimatedNeurons: 4 });
        const originalRecordAuditEvent = repositoriesModule.recordAuditEvent;
        const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockImplementation(async (auditEnv, event) => {
          if (event.eventType === "github_app.linked_issue_satisfaction_one_shot_skip") throw new Error("audit DB down");
          await originalRecordAuditEvent(auditEnv, event);
        });
        await expect(
          processJob(env, { type: "agent-regate-pr", deliveryId: "linked-issue-skip-audit-fails", repoFullName: "JSONbored/gittensory", prNumber: 99, installationId: 123 }),
        ).resolves.toBeUndefined();
        auditSpy.mockRestore();
      });

      it("swallows a one-shot-reuse getLatestPublishedAiReview read failure and a one-shot-reuse audit write failure without throwing", async () => {
        let aiCalls = 0;
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Fresh.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
          AI_DAILY_NEURON_BUDGET: "100000",
        });
        await seedRegateChurnRepo(env, { publicSurface: "comment_only" });
        await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 100, title: "One-shot flaky-read PR", state: "open", user: { login: "contributor" }, head: { sha: "a100" }, labels: [], body: "Closes #1" });
        await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 100, status: "complete", reviewsSyncedAt: new Date().toISOString() });
        await putCachedAiReview(env, "JSONbored/gittensory", 100, "a100-old", "block", { notes: "Old.", reviewerCount: 1 });
        await markAiReviewPublished(env, "JSONbored/gittensory", 100, "a100-old");
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
          if (url.includes("/pulls/100/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
          if (url.endsWith("/pulls/100")) return Response.json({ number: 100, title: "One-shot flaky-read PR", state: "open", user: { login: "contributor" }, head: { sha: "a100" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
          if (url.includes("/commits/a100/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
          if (url.includes("/commits/a100/status")) return Response.json({ state: "success", statuses: [] });
          if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
          if (url.includes("/issues/100/comments")) return method === "POST" || method === "PATCH" ? Response.json({ id: 1 }, { status: 201 }) : Response.json([]);
          if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
          return Response.json({});
        });

        const readSpy = vi.spyOn(repositoriesModule, "getLatestPublishedAiReview").mockRejectedValueOnce(new Error("D1 read error"));
        await expect(
          processJob(env, { type: "agent-regate-pr", deliveryId: "one-shot-reuse-read-fails", repoFullName: "JSONbored/gittensory", prNumber: 100, installationId: 123 }),
        ).resolves.toBeUndefined();
        readSpy.mockRestore();
        expect(aiCalls).toBeGreaterThan(0); // fail-safe treats the read failure as "nothing to reuse" -- a fresh review still runs

        const originalRecordAuditEvent = repositoriesModule.recordAuditEvent;
        const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockImplementation(async (auditEnv, event) => {
          if (event.eventType === "github_app.ai_review_one_shot_reuse") throw new Error("audit DB down");
          await originalRecordAuditEvent(auditEnv, event);
        });
        await expect(
          processJob(env, { type: "agent-regate-pr", deliveryId: "one-shot-reuse-audit-fails", repoFullName: "JSONbored/gittensory", prNumber: 100, installationId: 123 }),
        ).resolves.toBeUndefined();
        auditSpy.mockRestore();
      });
    });

    it("#freeze-owner-exemption (incident, confirmed live on PR #3476): the repo owner's OWN held PR is never frozen -- a new push gets a fresh AI review", async () => {
      // The owner pushing a genuine fix to their OWN held PR must not keep replaying the ORIGINAL, now-stale
      // verdict pass after pass -- confirmed live via github_app.ai_review_frozen_reuse firing on every one of
      // #3476's own follow-up commits, hiding the owner's own fix from the review meant to evaluate it. The
      // anti-gaming concern the freeze exists for is specific to a CONTRIBUTOR iterating pushes against the
      // bot; it must never apply to the repo owner, matching the same exemption this codebase already grants
      // owner/admin/automation-bot authors everywhere else (auto-close, review-nag, contributor caps).
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Fresh owner fix.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env, { publicSurface: "comment_only" });
      // #one-shot-review-cadence: isolate this test to the owner-exemption-from-the-LABEL-freeze mechanism --
      // without this, a prior published review would ALSO be reused by the (correctly firing) one_shot default,
      // for an unrelated reason, masking whether the label-freeze exemption itself actually works.
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { auto_review: { cadence: "continuous" } } });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 79, title: "Owner's held PR", state: "open", user: { login: "JSONbored" }, head: { sha: "a79-v1" }, labels: [{ name: "manual-review" }], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 79, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      await putCachedAiReview(env, "JSONbored/gittensory", 79, "a79-v1", "block", { notes: "Original stale review.", reviewerCount: 1 });
      await markAiReviewPublished(env, "JSONbored/gittensory", 79, "a79-v1");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        // The owner pushed a genuine fix: a new head SHA, still carrying the manual-review label.
        if (url.includes("/pulls/79/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@\n+export const fixed = true;" }]);
        if (url.endsWith("/pulls/79")) return Response.json({ number: 79, title: "Owner's held PR", state: "open", user: { login: "JSONbored" }, head: { sha: "a79-v2" }, labels: [{ name: "manual-review" }], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a79-v2/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a79-v2/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/issues/79/comments")) return method === "POST" || method === "PATCH" ? Response.json({ id: 1 }, { status: 201 }) : Response.json([]);
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "owner-held-push", repoFullName: "JSONbored/gittensory", prNumber: 79, installationId: 123 });

      expect(aiCalls).toBeGreaterThan(0); // NOT frozen -- the owner's own push gets a real, fresh AI review
      const freezeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_frozen_reuse", "JSONbored/gittensory#79")
        .first<{ n: number }>();
      expect(freezeAudit?.n).toBe(0); // never took the frozen-reuse path at all
    });

    it("#freeze-owner-exemption: an ADMIN_GITHUB_LOGINS fleet-operator's held PR is never frozen either", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        ADMIN_GITHUB_LOGINS: "fleet-admin",
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Fresh admin fix.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env, { publicSurface: "comment_only" });
      // #one-shot-review-cadence: isolate this test to the admin-exemption-from-the-LABEL-freeze mechanism.
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { auto_review: { cadence: "continuous" } } });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 80, title: "Admin's held PR", state: "open", user: { login: "fleet-admin" }, head: { sha: "a80-v1" }, labels: [{ name: "manual-review" }], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 80, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      await putCachedAiReview(env, "JSONbored/gittensory", 80, "a80-v1", "block", { notes: "Original stale review.", reviewerCount: 1 });
      await markAiReviewPublished(env, "JSONbored/gittensory", 80, "a80-v1");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/80/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@\n+export const fixed = true;" }]);
        if (url.endsWith("/pulls/80")) return Response.json({ number: 80, title: "Admin's held PR", state: "open", user: { login: "fleet-admin" }, head: { sha: "a80-v2" }, labels: [{ name: "manual-review" }], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a80-v2/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a80-v2/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/issues/80/comments")) return method === "POST" || method === "PATCH" ? Response.json({ id: 1 }, { status: 201 }) : Response.json([]);
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "admin-held-push", repoFullName: "JSONbored/gittensory", prNumber: 80, installationId: 123 });

      expect(aiCalls).toBeGreaterThan(0);
      const freezeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_frozen_reuse", "JSONbored/gittensory#80")
        .first<{ n: number }>();
      expect(freezeAudit?.n).toBe(0);
    });

    it("#freeze-owner-exemption: a protected automation bot's held PR is never frozen either", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Fresh bot fix.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      // #one-shot-review-cadence: isolate this test to the automation-bot-exemption-from-the-LABEL-freeze mechanism.
      // #automation-bot-skip: ALSO isolate from the newer, broader automation-bot-skip.ts early-return in
      // reReviewStoredPullRequest -- that skip would otherwise short-circuit before ever reaching the freeze
      // logic this test targets, so it's explicitly turned off here too.
      await seedRegateChurnRepo(env, { publicSurface: "comment_only", skipAutomationBotAuthors: "off" });
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { auto_review: { cadence: "continuous" } } });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 81, title: "Bot's held PR", state: "open", user: { login: "dependabot[bot]" }, head: { sha: "a81-v1" }, labels: [{ name: "manual-review" }], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 81, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      await putCachedAiReview(env, "JSONbored/gittensory", 81, "a81-v1", "block", { notes: "Original stale review.", reviewerCount: 1 });
      await markAiReviewPublished(env, "JSONbored/gittensory", 81, "a81-v1");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/81/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@\n+export const fixed = true;" }]);
        if (url.endsWith("/pulls/81")) return Response.json({ number: 81, title: "Bot's held PR", state: "open", user: { login: "dependabot[bot]" }, head: { sha: "a81-v2" }, labels: [{ name: "manual-review" }], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a81-v2/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a81-v2/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/issues/81/comments")) return method === "POST" || method === "PATCH" ? Response.json({ id: 1 }, { status: 201 }) : Response.json([]);
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "bot-held-push", repoFullName: "JSONbored/gittensory", prNumber: 81, installationId: 123 });

      expect(aiCalls).toBeGreaterThan(0);
      const freezeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_frozen_reuse", "JSONbored/gittensory#81")
        .first<{ n: number }>();
      expect(freezeAudit?.n).toBe(0);
    });

    it("maintainer-gated freeze never engages when manualReviewLabel is explicitly disabled (null)", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Fresh.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env, { publicSurface: "comment_only" });
      // manualReviewLabel is config-as-code only (.gittensory.yml), not a DB-backed repository setting.
      // #one-shot-review-cadence: also opts into continuous here so this test stays isolated to the
      // manualReviewLabel-disabled mechanism it's actually about.
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { manualReviewLabel: null }, review: { auto_review: { cadence: "continuous" } } });
      // The PR carries the literal "manual-review" text as a label, but with the mechanism disabled repo-wide
      // there is no configured label to match against — the freeze must never engage on text alone.
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 76, title: "Held PR, mechanism disabled", state: "open", user: { login: "contributor" }, head: { sha: "a76" }, labels: [{ name: "manual-review" }], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 76, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      await putCachedAiReview(env, "JSONbored/gittensory", 76, "a76-old", "block", { notes: "Old.", reviewerCount: 1 });
      await markAiReviewPublished(env, "JSONbored/gittensory", 76, "a76-old");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/76/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/76")) return Response.json({ number: 76, title: "Held PR, mechanism disabled", state: "open", user: { login: "contributor" }, head: { sha: "a76" }, labels: [{ name: "manual-review" }], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a76/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a76/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/issues/76/comments")) return method === "POST" || method === "PATCH" ? Response.json({ id: 1 }, { status: 201 }) : Response.json([]);
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "disabled-mechanism", repoFullName: "JSONbored/gittensory", prNumber: 76, installationId: 123 });

      expect(aiCalls).toBeGreaterThan(0); // NOT frozen -- a fresh review runs normally
      const freezeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_frozen_reuse", "JSONbored/gittensory#76")
        .first<{ n: number }>();
      expect(freezeAudit?.n).toBe(0);
    });

    it("maintainer-gated freeze: a held PR with nothing ever published falls through gracefully (no reuse, no crash, no fresh AI while frozen)", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Fresh.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env, { publicSurface: "comment_only" });
      // Carries the manual-review label (e.g. a non-AI hold reason such as a protected-author close-withheld
      // hold), but AI review was OFF/skipped when that hold was established -- so nothing was ever published.
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 77, title: "Held, never reviewed by AI", state: "open", user: { login: "contributor" }, head: { sha: "a77" }, labels: [{ name: "manual-review" }], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 77, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/77/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/77")) return Response.json({ number: 77, title: "Held, never reviewed by AI", state: "open", user: { login: "contributor" }, head: { sha: "a77" }, labels: [{ name: "manual-review" }], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a77/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a77/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/issues/77/comments")) return method === "POST" || method === "PATCH" ? Response.json({ id: 1 }, { status: 201 }) : Response.json([]);
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "held-never-published", repoFullName: "JSONbored/gittensory", prNumber: 77, installationId: 123 }),
      ).resolves.toBeUndefined();

      expect(aiCalls).toBe(0); // still frozen -- no fresh call, even though there was nothing to reuse either
      const freezeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_frozen_reuse", "JSONbored/gittensory#77")
        .first<{ n: number }>();
      expect(freezeAudit?.n).toBe(0); // nothing was actually reused, so no reuse audit either
    });

    it("swallows a getLatestPublishedAiReview read failure and a frozen-reuse audit write failure without throwing", async () => {
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: JSON.stringify({ assessment: "Fresh.", blockers: [], nits: [], suggestions: [] }) }) } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env, { publicSurface: "comment_only" });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 78, title: "Held PR, flaky reads", state: "open", user: { login: "contributor" }, head: { sha: "a78" }, labels: [{ name: "manual-review" }], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 78, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      await putCachedAiReview(env, "JSONbored/gittensory", 78, "a78-old", "block", { notes: "Old.", reviewerCount: 1 });
      await markAiReviewPublished(env, "JSONbored/gittensory", 78, "a78-old");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/78/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/78")) return Response.json({ number: 78, title: "Held PR, flaky reads", state: "open", user: { login: "contributor" }, head: { sha: "a78" }, labels: [{ name: "manual-review" }], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a78/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a78/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/issues/78/comments")) return method === "POST" || method === "PATCH" ? Response.json({ id: 1 }, { status: 201 }) : Response.json([]);
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      const readSpy = vi.spyOn(repositoriesModule, "getLatestPublishedAiReview").mockRejectedValueOnce(new Error("D1 read error"));
      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "frozen-read-fails", repoFullName: "JSONbored/gittensory", prNumber: 78, installationId: 123 }),
      ).resolves.toBeUndefined();
      readSpy.mockRestore();

      const originalRecordAuditEvent = repositoriesModule.recordAuditEvent;
      const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockImplementation(async (auditEnv, event) => {
        if (event.eventType === "github_app.ai_review_frozen_reuse") throw new Error("audit DB down");
        await originalRecordAuditEvent(auditEnv, event);
      });
      await expect(
        processJob(env, { type: "agent-regate-pr", deliveryId: "frozen-audit-fails", repoFullName: "JSONbored/gittensory", prNumber: 78, installationId: 123 }),
      ).resolves.toBeUndefined();
      auditSpy.mockRestore();
    });

    it("REPRODUCES the production incident (JSONbored/awesome-claude#4554): two near-simultaneous webhook deliveries for the SAME PR + head SHA spend AI exactly ONCE, not twice (#regate-dup-prep)", async () => {
      // Root cause: two GitHub webhook deliveries ~900ms apart for the identical head SHA each independently
      // reached the cache-read/cache-miss-log decision in maybePublishPrPublicSurface BEFORE either one ever
      // claimed claimAiReviewLock (that claim used to live only deep inside runAiReviewForAdvisory) — so both
      // logged an identical "no reusable stored AI review" cache miss and both proceeded to spend a real LLM
      // call for byte-identical code. The fix claims the SAME (repo, PR, head, mode) lock in the CALLER, wrapping
      // the cache-read decision itself, so the loser of the race defers before ever reading the cache — not
      // merely before the LLM call.
      //
      // A real LLM call has genuine wall-clock latency (seconds), which is exactly the window the second
      // delivery's cache-read can land inside, still finding nothing written yet. A synchronous test stub
      // resolves instantly, closing that window — Promise.all alone is not enough to force the race
      // deterministically (the loser's cache-read can simply land AFTER the winner's entire pass, including its
      // cache WRITE, has already completed, producing an incidental cache HIT that proves nothing either way).
      // Widen the window explicitly with a real setTimeout inside env.AI.run, the same "hold the window open
      // long enough for others to overlap" technique this file already uses for the sweep fan-out concurrency
      // regression above (#3899) — so the assertion below is a genuine two-way race, not a scheduling accident.
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: {
          run: async () => {
            aiCalls += 1;
            await new Promise((resolve) => setTimeout(resolve, 20)); // hold the window open long enough for the racing delivery to reach its own cache-read
            return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) };
          },
        } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seedRegateChurnRepo(env);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 90, title: "Baseline PR", state: "open", user: { login: "contributor" }, head: { sha: "a90" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 90, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 91, title: "Duplicate-delivery PR", state: "open", user: { login: "contributor" }, head: { sha: "a91" }, labels: [], body: "Closes #1" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 91, status: "complete", reviewsSyncedAt: new Date().toISOString() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/90/files") || url.includes("/pulls/91/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/90")) return Response.json({ number: 90, title: "Baseline PR", state: "open", user: { login: "contributor" }, head: { sha: "a90" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.endsWith("/pulls/91")) return Response.json({ number: 91, title: "Duplicate-delivery PR", state: "open", user: { login: "contributor" }, head: { sha: "a91" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/a90/check-runs") || url.includes("/commits/a91/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a90/status") || url.includes("/commits/a91/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/90/comments") || url.includes("/issues/91/comments")) return method === "POST" || method === "PATCH" ? Response.json({ id: 1 }, { status: 201 }) : Response.json([]);
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      // Baseline: measure how many underlying env.AI.run calls a SINGLE genuine review attempt makes (block mode's
      // dual-reviewer setup means this is not necessarily 1) — the race assertion below compares in ATTEMPTS, the
      // same "attempts, not raw call counts" idiom the #9 low-activity-repo regression above uses, not a hardcoded
      // call count. A separate PR/head so this baseline run's own cache write cannot affect the race below.
      await processJob(env, { type: "agent-regate-pr", deliveryId: "delivery-baseline", repoFullName: "JSONbored/gittensory", prNumber: 90, installationId: 123 });
      const callsPerAttempt = aiCalls;
      expect(callsPerAttempt).toBeGreaterThan(0);
      aiCalls = 0;

      // Two DIFFERENT delivery ids (matching the real incident's two distinct webhook deliveries) for the SAME
      // repo/PR/head, fired concurrently — neither awaits the other before both are in flight.
      await Promise.all([
        processJob(env, { type: "agent-regate-pr", deliveryId: "delivery-a", repoFullName: "JSONbored/gittensory", prNumber: 91, installationId: 123 }),
        processJob(env, { type: "agent-regate-pr", deliveryId: "delivery-b", repoFullName: "JSONbored/gittensory", prNumber: 91, installationId: 123 }),
      ]);

      // The DISCRIMINATING assertion (fails on unfixed code, verified by temporarily reverting the fix): exactly
      // ONE pass logged a genuine cache miss (read the cache, found nothing, ran fresh) — the loser never reached
      // the cache-read at all, because the lock now wraps that read too, not just the LLM call. Without the fix
      // this is 2: both passes independently reach the cache-read and both log a miss before either one's
      // runAiReviewForAdvisory-internal lock (the historical, narrower placement) ever engages.
      const missAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.ai_review_cache_miss", "JSONbored/gittensory#91")
        .first<{ n: number }>();
      expect(missAudit?.n).toBe(1);

      // The real review still only spent ONE attempt's worth of AI calls in total — never two full attempts (the
      // production incident's duplicate LLM spend), and never zero (the winner completes a real review; the PR
      // is not left permanently unreviewed because the other delivery happened to hold the lock).
      expect(aiCalls).toBe(callsPerAttempt);

      // The real review was actually published (the winner completed normally) and the PR is left in a normal,
      // unbroken state — the loser deferred cleanly rather than crashing processJob or leaving the PR unreviewed.
      const publishedReview = await repositoriesModule.getLatestPublishedAiReview(env, "JSONbored/gittensory", 91, "block");
      expect(publishedReview).not.toBeNull();
      const pr91 = await getPullRequest(env, "JSONbored/gittensory", 91);
      expect(pr91?.state).toBe("open");
    });
  });
  });

  it("#1: the block-mode re-gate sweep replays cached AI findings before gate evaluation", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Critical defect found.", blockers: ["x"], nits: [], suggestions: [] }) }; } } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "block", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Stale PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
    await upsertPullRequestFile(env, { repoFullName: "owner/agent-repo", pullNumber: 7, path: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, payload: { patch: "@@\n+export const ok = value.length;" } });
    // Pre-seed the AI review for this exact head SHA + mode → the sweep's block-mode review must reuse it, not re-run.
    const inputFingerprint = await aiReviewCacheInputFingerprint({
      title: "Stale PR",
      mode: "block",
      byok: false,
      provider: null,
      model: null,
      aiReviewAllAuthors: false,
      aiReviewCloseConfidence: undefined,
      aiReviewCombine: null,
      aiReviewOnMerge: null,
      aiReviewReviewers: null,
      gatePack: "oss-anti-slop",
      reviewerPlan: env.AI_REVIEW_PLAN,
      selfHostProviderConfig: null, selfHostAiModelOverride: { claudeModel: null, claudeEffort: null, codexModel: null, codexEffort: null, ollamaModel: null, openaiModel: null, openaiCompatibleModel: null, anthropicModel: null },
      reviewFiles: [{ path: "src/a.ts", status: "modified", patch: "@@\n+export const ok = value.length;", additions: 1, deletions: 0 }],
      profile: null,
      securityFocus: false,
      inlineComments: false,
      pathInstructions: [],
      pathGuidance: "",
      repoInstructions: null,
      excludePaths: [],
      pathFilters: [],
      changedPaths: ["src/a.ts"],
      features: {
        grounding: false,
        rag: false,
        enrichment: false,
        reputation: false,
        cultureProfile: false,
        impactMap: false,
      },
    });
    await putCachedAiReview(env, "owner/agent-repo", 7, "a7", "block", {
      notes: "cached review",
      reviewerCount: 2,
      findings: [{ code: "ai_consensus_defect", severity: "critical", title: "Cached defect", detail: "Cached critical defect." }],
      metadata: { inputFingerprint },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = value.length;" }]);
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Stale PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.endsWith("/pulls/7/merge")) return new Response(null, { status: 204 });
      if (url.endsWith("/pulls/7/reviews") && init?.method === "POST") return Response.json({ id: 1 });
      if (url.endsWith("/pulls/7/reviews")) return Response.json([]);
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await sweepAndDrainPerPr(env, "owner/agent-repo");

    expect(aiCalls).toBe(0); // the cached AI review was reused — the LLM was never called for this head SHA
    const blocker = await env.DB.prepare("select blocker_codes_json from gate_outcomes where repo_full_name = ? and pull_number = ? order by rowid desc limit 1").bind("owner/agent-repo", 7).first<{ blocker_codes_json: string }>();
    expect(blocker?.blocker_codes_json).toContain("ai_consensus_defect");
    const mergeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and detail like ?").bind("agent.action.merge", "%merged%").first<{ n: number }>();
    expect(mergeAudit?.n).toBe(0);
  });

  // Shared cache-input-fingerprint builder for the #4603 pair below -- mirrors "#1"'s own inline fingerprint,
  // parameterized only by PR title/number/sha so both tests get a genuine cache HIT (aiCalls stays 0) instead of
  // silently falling through to a real (unmocked-defect) AI call on a fingerprint mismatch.
});
