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

  describe("review-nag cooldown (#2463)", () => {
    // Reusable stub covering everything the normal @gittensory Q&A dispatch needs (token, collaborator
    // permission, comment GET/search + POST) PLUS the maintenance close path (label GET/POST, PR PATCH) —
    // a superset so every scenario below (fall-through OR short-circuit) can share one fetch handler.
    function stubReviewNagFetch(prNumber: number, seen: { comments: string[]; labels: string[]; closed: boolean }) {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "none" });
        if (url.endsWith(`/pulls/${prNumber}`) && method === "PATCH") {
          seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed";
          return Response.json({ number: prNumber, state: "closed" });
        }
        if (url.endsWith(`/pulls/${prNumber}`)) return Response.json({ number: prNumber, state: "open", head: { sha: `sha${prNumber}` }, mergeable_state: "clean" });
        if (url.includes(`/issues/${prNumber}/labels`) && method === "GET") return Response.json([]);
        if (url.includes(`/issues/${prNumber}/labels`) && method === "POST") {
          seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[]));
          return Response.json([]);
        }
        // Repo-level label definition (createMissingLabel: true probes/creates the label before applying it).
        if (url.endsWith("/labels") && method === "POST") return Response.json({ name: JSON.parse(String(init?.body ?? "{}")).name }, { status: 201 });
        if (url.includes(`/issues/${prNumber}/comments`) && method === "GET") return Response.json([]);
        if (url.includes(`/issues/${prNumber}/comments`) && method === "POST") {
          seen.comments.push(String(JSON.parse(String(init?.body ?? "{}")).body ?? ""));
          return Response.json({ id: seen.comments.length }, { status: 201 });
        }
        return new Response("not found", { status: 404 });
      });
    }

    it("is off by default — no ping is tracked and no cooldown action fires", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 200, title: "Off by default", state: "open", user: { login: "chatty" }, author_association: "NONE", labels: [], body: "" });
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubReviewNagFetch(200, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "nag-off-default",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 200, title: "Off by default", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 1, body: "@gittensory help", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      const pings = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.review_nag_ping'").first<{ n: number }>();
      expect(pings?.n).toBe(0);
      expect(seen.closed).toBe(false);
    });

    it("REGRESSION (gate-flagged): caps an oversized review-nag cooldown at MAX_REVIEW_NAG_COOLDOWN_DAYS before Date arithmetic, even when the resolved settings object itself carries an oversized value", async () => {
      // upsertRepositorySettings/getRepositorySettings both clamp reviewNagCooldownDays on write AND read, so
      // seeding an oversized value through the normal repository layer (even via a raw DB update bypassing the
      // write-time clamp) can never actually reach maybeThrottleReviewNagPing uncapped -- the read-time clamp in
      // getRepositorySettings neutralizes it first. Mock resolveRepositorySettings directly so this test proves
      // processors.ts's OWN Math.min(reviewNagCooldownDays, MAX_REVIEW_NAG_COOLDOWN_DAYS) guard, not the DB layer.
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "hold", reviewNagMaxPings: 3 });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 206, title: "Huge cooldown", state: "open", user: { login: "chatty" }, author_association: "NONE", labels: [], body: "" });
      // Three prior pings, all 400 DAYS ago -- outside the 365-day cap, but well within an uncapped
      // "1,000,000,000-day" window. If the guard clamps correctly, these fall outside the window and don't
      // count; if the guard were removed, the uncapped window would count all three, crossing maxPings=3.
      vi.setSystemTime(new Date("2025-04-24T00:00:00.000Z"));
      for (let i = 0; i < 3; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "JSONbored/gittensory#206", outcome: "completed" });
      }
      vi.setSystemTime(new Date("2026-05-29T00:00:00.000Z")); // ~400 days later
      const baseSettings = await repositorySettingsModule.resolveRepositorySettings(env, "JSONbored/gittensory");
      const resolveSettingsSpy = vi
        .spyOn(repositorySettingsModule, "resolveRepositorySettings")
        .mockResolvedValueOnce({ ...baseSettings, reviewNagCooldownDays: 1_000_000_000 });
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubReviewNagFetch(206, seen);

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "nag-huge-cooldown",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 206, title: "Huge cooldown", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 1, body: "@gittensory help", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });

      // The 400-day-old pings fell outside the CAPPED 365-day window, so this is only the 1st ping this
      // window — under maxPings=3, never throttled. An uncapped window would have counted all 3 prior pings
      // (pingCount=4 > maxPings=3) and applied the cooldown instead.
      const applied = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.review_nag_cooldown_applied'").first<{ n: number }>();
      expect(applied?.n).toBe(0);
      expect(seen.closed).toBe(false);
      expect(seen.comments.some((c) => c.includes("cooldown limit"))).toBe(false);
      expect(resolveSettingsSpy).toHaveBeenCalled();
      resolveSettingsSpy.mockRestore();
    });

    it("records pings under the configured threshold without acting; the normal @gittensory reply still proceeds", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 3 });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 201, title: "Under threshold", state: "open", user: { login: "chatty" }, author_association: "NONE", labels: [], body: "" });
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubReviewNagFetch(201, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "nag-under-threshold",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 201, title: "Under threshold", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 1, body: "@gittensory help", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      const pings = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.review_nag_ping'").first<{ n: number }>();
      expect(pings?.n).toBe(1); // the ping is recorded (1st of 3 allowed)
      const applied = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.review_nag_cooldown_applied'").first<{ n: number }>();
      expect(applied?.n).toBe(0); // but no cooldown action — under threshold
      expect(seen.closed).toBe(false);
      // The review-nag hook returned false (fell through) — proven by the NORMAL mention-command dispatch
      // making its own (here: unauthorized-skip) decision, rather than review-nag's short-circuit ever firing.
      const skipped = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.agent_command_skipped'").first<{ n: number }>();
      expect(skipped?.n).toBeGreaterThanOrEqual(1);
    });

    it("hold policy: posts a cooldown reply and short-circuits once the threshold is crossed", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "hold", reviewNagMaxPings: 3, reviewNagCooldownDays: 5 });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 202, title: "Hold cooldown", state: "open", user: { login: "chatty" }, author_association: "NONE", labels: [], body: "" });
      for (let i = 0; i < 3; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "JSONbored/gittensory#202", outcome: "completed" });
      }
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubReviewNagFetch(202, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "nag-hold",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 202, title: "Hold cooldown", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 4, body: "@gittensory help", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      expect(seen.closed).toBe(false);
      expect(seen.comments.some((c) => c.includes("cooldown limit"))).toBe(true);
      // Only ONE comment posted — the short-circuit skipped the normal answer-card dispatch.
      expect(seen.comments).toHaveLength(1);
      const applied = await env.DB.prepare("select outcome, detail from audit_events where event_type = 'github_app.review_nag_cooldown_applied'").first<{ outcome: string; detail: string }>();
      expect(applied?.outcome).toBe("completed");
      expect(applied?.detail).toContain("hold applied");
    });

    it("close policy on a PR thread: labels + closes once the threshold is crossed, with no merit review", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertInstallation(env, {
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["issue_comment"] },
        repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
      });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 3, autonomy: { close: "auto", label: "auto" } });
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { reviewNagLabel: "too-chatty" } }, "repo_file");
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 203, title: "Close cooldown", state: "open", user: { login: "chatty" }, head: { sha: "sha203" }, author_association: "NONE", labels: [], body: "" });
      for (let i = 0; i < 3; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "JSONbored/gittensory#203", outcome: "completed" });
      }
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubReviewNagFetch(203, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "nag-close",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 203, title: "Close cooldown", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 4, body: "@gittensory help", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      expect(seen.closed).toBe(true);
      expect(seen.labels).toContain("too-chatty"); // configurable label, not hardcoded
      expect(seen.comments.some((c) => c.includes("chatty") && c.includes("4 times"))).toBe(true);
      const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
      expect(closeAudit?.n).toBeGreaterThanOrEqual(1);
    });

    it("REGRESSION (#review-nag-cross-pr-carryover): a contributor who exhausted their pings on PR A carries the count over to a BRAND-NEW PR B instead of resetting to a clean 0/maxPings slate", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertInstallation(env, {
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["issue_comment"] },
        repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
      });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 3, autonomy: { close: "auto", label: "auto" } });
      // PR A: "chatty" already sent 3 pings (the full budget) and PR A was closed for it -- this is the exact
      // state left behind by the "close policy on a PR thread" scenario above.
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 220, title: "PR A (already closed)", state: "closed", user: { login: "chatty" }, head: { sha: "sha220" }, author_association: "NONE", labels: [], body: "" });
      for (let i = 0; i < 3; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "JSONbored/gittensory#220", outcome: "completed" });
      }
      // PR B: a BRAND-NEW PR from the SAME contributor -- a new issue.number means a new targetKey the old
      // per-target count would treat as a clean slate. Only ONE ping is sent here.
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 221, title: "PR B (brand new)", state: "open", user: { login: "chatty" }, head: { sha: "sha221" }, author_association: "NONE", labels: [], body: "" });
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubReviewNagFetch(221, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "nag-carryover-pr-b",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 221, title: "PR B (brand new)", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 1, body: "@gittensory help", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      // Under the OLD per-targetKey count, this is ping 1/3 on PR B alone -- under threshold, no action. The
      // FIX counts every prior ping across the whole repo, so this single PR-B ping is already #4 overall
      // (3 carried over from PR A + this one), crossing maxPings=3 on the very first PR-B ping.
      expect(seen.closed).toBe(true);
      expect(seen.comments.some((c) => c.includes("chatty") && c.includes("4 times"))).toBe(true);
      const prA = await env.DB.prepare("select state from pull_requests where number = 220").first<{ state: string }>();
      expect(prA?.state).toBe("closed"); // PR A is untouched by this second evaluation
      const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
      expect(closeAudit?.n).toBeGreaterThanOrEqual(1);
    });

    it("close policy degrades to hold on an ISSUE thread (no closeIssue primitive yet)", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 3 });
      for (let i = 0; i < 3; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "JSONbored/gittensory#204", outcome: "completed" });
      }
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubReviewNagFetch(204, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "nag-issue-degrade",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 204, title: "Plain issue", state: "open", user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 4, body: "@gittensory help", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      expect(seen.closed).toBe(false); // no closeIssue primitive — degrades to hold
      expect(seen.comments.some((c) => c.includes("cooldown limit"))).toBe(true);
    });

    it("never throttles an exempt login, even over threshold", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 3, autoCloseExemptLogins: ["chatty"] });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 205, title: "Exempt author", state: "open", user: { login: "chatty" }, author_association: "NONE", labels: [], body: "" });
      for (let i = 0; i < 5; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "JSONbored/gittensory#205", outcome: "completed" });
      }
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubReviewNagFetch(205, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "nag-exempt",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 205, title: "Exempt author", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 4, body: "@gittensory help", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      expect(seen.closed).toBe(false);
      const applied = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.review_nag_cooldown_applied'").first<{ n: number }>();
      expect(applied?.n).toBe(0);
    });

    it("never throttles a third party pinging on someone else's PR — only the thread's OWN author is tracked", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 3 });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 206, title: "Third party pinger", state: "open", user: { login: "pr-author" }, author_association: "NONE", labels: [], body: "" });
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubReviewNagFetch(206, seen);
      for (let i = 0; i < 5; i += 1) {
        await processJob(env, {
          type: "github-webhook",
          deliveryId: `nag-third-party-${i}`,
          eventName: "issue_comment",
          payload: {
            action: "created",
            installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
            repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
            issue: { number: 206, title: "Third party pinger", state: "open", pull_request: {}, user: { login: "pr-author" }, author_association: "NONE" },
            comment: { id: i, body: "@gittensory help", user: { login: "bystander", type: "User" }, author_association: "NONE" },
          },
        });
      }
      const pings = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.review_nag_ping'").first<{ n: number }>();
      expect(pings?.n).toBe(0); // never even tracked — the commenter is not the thread's own author
      expect(seen.closed).toBe(false);
    });

    it("no-op owner-exemption when repoFullName has no slash (repoOwner is empty — never wrongly matches the commenter)", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertInstallation(env, {
        installation: { id: 123, account: { login: "", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["issue_comment"] },
        repositories: [{ name: "noslash", full_name: "noslash", private: false, owner: { login: "" } }],
      });
      await upsertRepositorySettings(env, { repoFullName: "noslash", reviewNagPolicy: "hold", reviewNagMaxPings: 3 });
      for (let i = 0; i < 3; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "noslash#209", outcome: "completed" });
      }
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubReviewNagFetch(209, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "nag-noslash",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "noslash", full_name: "noslash", private: false, owner: { login: "" } },
          issue: { number: 209, title: "Slash-free repo", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 4, body: "@gittensory help", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      // repoOwner="" (branch false) → commenter "chatty" never equals "" → the owner-exemption is skipped and
      // the throttle still engages normally (the comment post itself can't succeed for a slash-free repo — no
      // owner/repo to target — but that failure is swallowed by design, same as every other best-effort notice
      // in this file). Proven by reaching + completing the hold branch without the handler crashing.
      const applied = await env.DB.prepare("select outcome from audit_events where event_type = 'github_app.review_nag_cooldown_applied'").first<{ outcome: string }>();
      expect(applied?.outcome).toBe("completed");
    });

    it("never throttles the literal repo owner self-pinging their own PR", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 1 });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 207, title: "Owner PR", state: "open", user: { login: "JSONbored" }, author_association: "OWNER", labels: [], body: "" });
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubReviewNagFetch(207, seen);
      for (let i = 0; i < 3; i += 1) {
        await processJob(env, {
          type: "github-webhook",
          deliveryId: `nag-owner-${i}`,
          eventName: "issue_comment",
          payload: {
            action: "created",
            installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
            repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
            issue: { number: 207, title: "Owner PR", state: "open", pull_request: {}, user: { login: "JSONbored" }, author_association: "OWNER" },
            comment: { id: i, body: "@gittensory help", user: { login: "JSONbored", type: "User" }, author_association: "OWNER" },
          },
        });
      }
      const pings = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.review_nag_ping'").first<{ n: number }>();
      expect(pings?.n).toBe(0);
      expect(seen.closed).toBe(false);
    });

    it("never throttles an ADMIN_GITHUB_LOGINS fleet-operator, even over threshold", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), ADMIN_GITHUB_LOGINS: "fleet-admin" });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 3 });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 208, title: "Admin PR", state: "open", user: { login: "fleet-admin" }, author_association: "NONE", labels: [], body: "" });
      for (let i = 0; i < 5; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "fleet-admin", targetKey: "JSONbored/gittensory#208", outcome: "completed" });
      }
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubReviewNagFetch(208, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "nag-admin",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 208, title: "Admin PR", state: "open", pull_request: {}, user: { login: "fleet-admin" }, author_association: "NONE" },
          comment: { id: 6, body: "@gittensory help", user: { login: "fleet-admin", type: "User" }, author_association: "NONE" },
        },
      });
      expect(seen.closed).toBe(false);
      const applied = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.review_nag_cooldown_applied'").first<{ n: number }>();
      expect(applied?.n).toBe(0);
    });

    it("hold policy respects agentDryRun — records a denied cooldown-applied audit and never posts the reply live (#2258 parity)", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "hold", reviewNagMaxPings: 3, agentDryRun: true });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 209, title: "Dry-run hold", state: "open", user: { login: "chatty" }, author_association: "NONE", labels: [], body: "" });
      for (let i = 0; i < 3; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "JSONbored/gittensory#209", outcome: "completed" });
      }
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubReviewNagFetch(209, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "nag-hold-dryrun",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 209, title: "Dry-run hold", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 4, body: "@gittensory help", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      expect(seen.comments).toHaveLength(0); // dry-run — no live comment posted
      const applied = await env.DB.prepare("select outcome from audit_events where event_type = 'github_app.review_nag_cooldown_applied'").first<{ outcome: string }>();
      expect(applied?.outcome).toBe("denied");
    });

    it("close policy falls through harmlessly when the PR is no longer open by the time the threshold fires", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 3 });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 210, title: "Already closed", state: "closed", user: { login: "chatty" }, author_association: "NONE", labels: [], body: "" });
      for (let i = 0; i < 3; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "JSONbored/gittensory#210", outcome: "completed" });
      }
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubReviewNagFetch(210, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "nag-already-closed",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 210, title: "Already closed", state: "closed", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 4, body: "@gittensory help", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      expect(seen.closed).toBe(false);
      const applied = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.review_nag_cooldown_applied'").first<{ n: number }>();
      expect(applied?.n).toBe(0); // fell through silently — nothing left to act on
    });

    it("close policy records a denied cooldown-applied audit when autonomy is not acting for label/close (empty plan)", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 3, autonomy: {} });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 211, title: "Observe-only autonomy", state: "open", user: { login: "chatty" }, head: { sha: "sha211" }, author_association: "NONE", labels: [], body: "" });
      for (let i = 0; i < 3; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "JSONbored/gittensory#211", outcome: "completed" });
      }
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubReviewNagFetch(211, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "nag-observe-only",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 211, title: "Observe-only autonomy", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 4, body: "@gittensory help", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      expect(seen.closed).toBe(false);
      const applied = await env.DB.prepare("select outcome, detail from audit_events where event_type = 'github_app.review_nag_cooldown_applied'").first<{ outcome: string; detail: string }>();
      expect(applied?.outcome).toBe("denied");
      expect(applied?.detail).toContain("autonomy is not acting");
    });

    it("close policy denies the mutation (never crashes) when no installation is on record — installationPermissions falls back to null", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 3, autonomy: { close: "auto", label: "auto" } });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 212, title: "No installation row", state: "open", user: { login: "chatty" }, head: { sha: "sha212" }, author_association: "NONE", labels: [], body: "" });
      for (let i = 0; i < 3; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "JSONbored/gittensory#212", outcome: "completed" });
      }
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubReviewNagFetch(212, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "nag-no-installation",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 212, title: "No installation row", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 4, body: "@gittensory help", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      expect(seen.closed).toBe(false); // no installation permissions on record — the write-permission gate denies it
      const closeAudit = await env.DB.prepare("select outcome from audit_events where event_type = 'agent.action.close'").first<{ outcome: string }>();
      expect(closeAudit?.outcome).toBe("denied");
    });
  });

  describe("maintainer-mention nag moderation (#label-scoping)", () => {
    function stubMonitoredMentionFetch(prNumber: number, seen: { comments: string[]; labels: string[]; closed: boolean }) {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "none" });
        if (url.endsWith(`/pulls/${prNumber}`) && method === "PATCH") {
          seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed";
          return Response.json({ number: prNumber, state: "closed" });
        }
        if (url.endsWith(`/pulls/${prNumber}`)) return Response.json({ number: prNumber, state: "open", head: { sha: `sha${prNumber}` }, mergeable_state: "clean" });
        if (url.includes(`/issues/${prNumber}/labels`) && method === "GET") return Response.json([]);
        if (url.includes(`/issues/${prNumber}/labels`) && method === "POST") {
          seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[]));
          return Response.json([]);
        }
        if (url.endsWith("/labels") && method === "POST") return Response.json({ name: JSON.parse(String(init?.body ?? "{}")).name }, { status: 201 });
        if (url.includes(`/issues/${prNumber}/comments`) && method === "GET") return Response.json([]);
        if (url.includes(`/issues/${prNumber}/comments`) && method === "POST") {
          seen.comments.push(String(JSON.parse(String(init?.body ?? "{}")).body ?? ""));
          return Response.json({ id: seen.comments.length }, { status: 201 });
        }
        return new Response("not found", { status: 404 });
      });
    }

    it("is off by default (no monitored logins configured) — no ping is tracked", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close" });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 300, title: "No monitored logins", state: "open", user: { login: "chatty" }, author_association: "NONE", labels: [], body: "" });
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubMonitoredMentionFetch(300, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "mention-off-default",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 300, title: "No monitored logins", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 1, body: "@JSONbored are you going to review this?", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      const pings = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.monitored_mention_ping'").first<{ n: number }>();
      expect(pings?.n).toBe(0);
    });

    it("detects a mention of a configured maintainer login and records a ping under threshold without acting", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 3, reviewNagMonitoredMentions: ["JSONbored"] });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 301, title: "Under threshold", state: "open", user: { login: "chatty" }, author_association: "NONE", labels: [], body: "" });
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubMonitoredMentionFetch(301, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "mention-under-threshold",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 301, title: "Under threshold", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 1, body: "Hey @JSONbored can you take a look?", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      const pings = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.monitored_mention_ping'").first<{ n: number }>();
      expect(pings?.n).toBe(1);
      expect(seen.closed).toBe(false);
    });

    it("REGRESSION: matches bot-shaped monitored logins literally", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 3, reviewNagMonitoredMentions: ["dependabot[bot]"] });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 312, title: "Bot mention", state: "open", user: { login: "chatty" }, author_association: "NONE", labels: [], body: "" });
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubMonitoredMentionFetch(312, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "mention-bot-shaped-literal",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 312, title: "Bot mention", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 1, body: "Please check this @dependabot[bot].", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      const pings = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.monitored_mention_ping'").first<{ n: number }>();
      expect(pings?.n).toBe(1);
    });

    it("REGRESSION: does not treat bot-login metacharacters as a regex character class", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMonitoredMentions: ["dependabot[bot]"] });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 313, title: "Bot false positive", state: "open", user: { login: "chatty" }, author_association: "NONE", labels: [], body: "" });
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubMonitoredMentionFetch(313, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "mention-bot-shaped-false-positive",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 313, title: "Bot false positive", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 1, body: "This mentions @dependabotb, not the bot actor.", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      const pings = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.monitored_mention_ping'").first<{ n: number }>();
      expect(pings?.n).toBe(0);
    });

    it("case-insensitively matches a monitored login and ignores an unrelated mention", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMonitoredMentions: ["JSONbored"] });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 302, title: "Case + unrelated", state: "open", user: { login: "chatty" }, author_association: "NONE", labels: [], body: "" });
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubMonitoredMentionFetch(302, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "mention-case-insensitive",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 302, title: "Case + unrelated", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 1, body: "@jsonbored please review", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      const pings = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.monitored_mention_ping'").first<{ n: number }>();
      expect(pings?.n).toBe(1); // case-insensitive match on the configured "JSONbored"

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "mention-unrelated",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 302, title: "Case + unrelated", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 2, body: "this uses @some-other-package internally", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      const pingsAfter = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.monitored_mention_ping'").first<{ n: number }>();
      expect(pingsAfter?.n).toBe(1); // unrelated mention did not add a ping
    });

    it("counts a monitored-login mention independently of the @gittensory ping counter", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 3, reviewNagMonitoredMentions: ["JSONbored"] });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 303, title: "Independent counters", state: "open", user: { login: "chatty" }, author_association: "NONE", labels: [], body: "" });
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubMonitoredMentionFetch(303, seen);
      // A comment mentioning BOTH @gittensory and the monitored login should tick both counters independently.
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "mention-both",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 303, title: "Independent counters", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 1, body: "@gittensory help — also @JSONbored can you look?", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      const gittensoryPings = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.review_nag_ping'").first<{ n: number }>();
      const mentionPings = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.monitored_mention_ping'").first<{ n: number }>();
      expect(gittensoryPings?.n).toBe(1);
      expect(mentionPings?.n).toBe(1);
    });

    it("hold policy: posts a cooldown reply naming the mentioned login and short-circuits once the threshold is crossed", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "hold", reviewNagMaxPings: 3, reviewNagMonitoredMentions: ["JSONbored"] });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 304, title: "Hold on mention", state: "open", user: { login: "chatty" }, author_association: "NONE", labels: [], body: "" });
      for (let i = 0; i < 3; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.monitored_mention_ping", actor: "chatty", targetKey: "JSONbored/gittensory#304#mention:jsonbored", outcome: "completed" });
      }
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubMonitoredMentionFetch(304, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "mention-hold",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 304, title: "Hold on mention", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 1, body: "@JSONbored please look at this", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      expect(seen.closed).toBe(false);
      expect(seen.comments.some((c) => c.includes("cooldown limit for @JSONbored"))).toBe(true);
      expect(seen.comments).toHaveLength(1); // short-circuited — no normal answer-card reply
    });

    it("close policy on a PR thread: labels + closes once the threshold is crossed, reusing reviewNagLabel", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertInstallation(env, {
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["issue_comment"] },
        repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
      });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 3, reviewNagMonitoredMentions: ["JSONbored"], reviewNagLabel: "too-chatty", autonomy: { close: "auto" } });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 305, title: "Close on mention", state: "open", user: { login: "chatty" }, head: { sha: "sha305" }, author_association: "NONE", labels: [], body: "" });
      for (let i = 0; i < 3; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.monitored_mention_ping", actor: "chatty", targetKey: "JSONbored/gittensory#305#mention:jsonbored", outcome: "completed" });
      }
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubMonitoredMentionFetch(305, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "mention-close",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 305, title: "Close on mention", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 1, body: "@JSONbored please look at this", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      expect(seen.closed).toBe(true);
      expect(seen.labels).toContain("too-chatty");
      // #label-scoping: close: "auto" alone (no broad label: "auto") is sufficient for the label AND the close.
    });

    it("REGRESSION (#review-nag-cross-pr-carryover): a contributor who exhausted their @-mention pings for ONE login on PR A carries that login's count over to a BRAND-NEW PR B", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertInstallation(env, {
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["issue_comment"] },
        repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
      });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 3, reviewNagMonitoredMentions: ["JSONbored"], autonomy: { close: "auto" } });
      // PR A: "chatty" already sent 3 pings mentioning @JSONbored (the full budget) and PR A was closed for it.
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 320, title: "PR A (already closed)", state: "closed", user: { login: "chatty" }, head: { sha: "sha320" }, author_association: "NONE", labels: [], body: "" });
      for (let i = 0; i < 3; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.monitored_mention_ping", actor: "chatty", targetKey: "JSONbored/gittensory#320#mention:jsonbored", outcome: "completed" });
      }
      // PR B: a BRAND-NEW PR from the SAME contributor mentioning the SAME login. A new issue.number is a new
      // targetKey the old per-target count would treat as a clean slate. Only ONE mention is sent here.
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 321, title: "PR B (brand new)", state: "open", user: { login: "chatty" }, head: { sha: "sha321" }, author_association: "NONE", labels: [], body: "" });
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubMonitoredMentionFetch(321, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "mention-carryover-pr-b",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 321, title: "PR B (brand new)", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 1, body: "@JSONbored please look at this", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      // Under the OLD per-targetKey count, this is mention-ping 1/3 on PR B alone -- under threshold, no action.
      // The FIX counts every prior @JSONbored mention-ping across the whole repo, so this single PR-B ping is
      // already #4 overall (3 carried over from PR A + this one), crossing maxPings=3 on the very first ping.
      expect(seen.closed).toBe(true);
      const prA = await env.DB.prepare("select state from pull_requests where number = 320").first<{ state: string }>();
      expect(prA?.state).toBe("closed"); // PR A is untouched by this second evaluation
    });

    it("REGRESSION (#review-nag-cross-pr-carryover): a DIFFERENT monitored login mentioned on PR B keeps its own independent budget, unaffected by another login's exhausted count", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertInstallation(env, {
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["issue_comment"] },
        repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
      });
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        reviewNagPolicy: "close",
        reviewNagMaxPings: 3,
        reviewNagMonitoredMentions: ["JSONbored", "other-maintainer"],
        autonomy: { close: "auto" },
      });
      // PR A: "chatty" already exhausted the @JSONbored budget (3 pings) -- same seed as the carryover test above.
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 322, title: "PR A (JSONbored exhausted)", state: "closed", user: { login: "chatty" }, head: { sha: "sha322" }, author_association: "NONE", labels: [], body: "" });
      for (let i = 0; i < 3; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.monitored_mention_ping", actor: "chatty", targetKey: "JSONbored/gittensory#322#mention:jsonbored", outcome: "completed" });
      }
      // PR B: the SAME contributor mentions a DIFFERENT monitored login ("other-maintainer") for the FIRST time.
      // If the repo-wide carryover fix accidentally merged every mentioned login into one shared count, this
      // single ping would incorrectly already be "#4" and get throttled -- it must instead be a fresh 1/3.
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 323, title: "PR B (different login)", state: "open", user: { login: "chatty" }, head: { sha: "sha323" }, author_association: "NONE", labels: [], body: "" });
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubMonitoredMentionFetch(323, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "mention-independent-login-pr-b",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 323, title: "PR B (different login)", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
          comment: { id: 1, body: "@other-maintainer could you take a look?", user: { login: "chatty", type: "User" }, author_association: "NONE" },
        },
      });
      expect(seen.closed).toBe(false); // "other-maintainer"'s own budget is untouched by @JSONbored's exhausted count
      const mentionPings = await env.DB.prepare(
        "select count(*) as n from audit_events where event_type = 'github_app.monitored_mention_ping' and target_key = 'JSONbored/gittensory#323#mention:other-maintainer'",
      ).first<{ n: number }>();
      expect(mentionPings?.n).toBe(1); // recorded as ping 1/3 for THIS login, not folded into @JSONbored's tally
    });

    it("does NOT throttle the repo owner, an admin login, an automation bot, or an exempt login", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), ADMIN_GITHUB_LOGINS: "fleet-admin" });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 1, reviewNagMonitoredMentions: ["JSONbored"], autoCloseExemptLogins: ["trusted-regular"] });
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubMonitoredMentionFetch(306, seen);
      for (const [commenter, prNumber] of [
        ["JSONbored", 306], // repo owner
        ["fleet-admin", 307], // admin login
        ["some-bot[bot]", 308], // automation bot
        ["trusted-regular", 309], // configured exemption
      ] as const) {
        await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: prNumber, title: "Exempt", state: "open", user: { login: commenter }, author_association: "NONE", labels: [], body: "" });
        await processJob(env, {
          type: "github-webhook",
          deliveryId: `mention-exempt-${prNumber}`,
          eventName: "issue_comment",
          payload: {
            action: "created",
            installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
            repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
            issue: { number: prNumber, title: "Exempt", state: "open", pull_request: {}, user: { login: commenter }, author_association: "NONE" },
            comment: { id: prNumber, body: "@JSONbored can you review?", user: { login: commenter, type: commenter.endsWith("[bot]") ? "Bot" : "User" }, author_association: "NONE" },
          },
        });
      }
      const pings = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.monitored_mention_ping'").first<{ n: number }>();
      expect(pings?.n).toBe(0);
    });

    it("does NOT throttle a third party mentioning the login on someone else's thread (thread-author-only scope)", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMonitoredMentions: ["JSONbored"] });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 310, title: "Third party", state: "open", user: { login: "thread-author" }, author_association: "NONE", labels: [], body: "" });
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubMonitoredMentionFetch(310, seen);
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "mention-third-party",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 310, title: "Third party", state: "open", pull_request: {}, user: { login: "thread-author" }, author_association: "NONE" },
          comment: { id: 1, body: "@JSONbored can you weigh in here?", user: { login: "a-different-commenter", type: "User" }, author_association: "NONE" },
        },
      });
      const pings = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.monitored_mention_ping'").first<{ n: number }>();
      expect(pings?.n).toBe(0);
    });

    it("REGRESSION: a redelivered webhook (same deliveryId) does not double-count the ping", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewNagPolicy: "close", reviewNagMaxPings: 5, reviewNagMonitoredMentions: ["JSONbored"] });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 311, title: "Redelivery", state: "open", user: { login: "chatty" }, author_association: "NONE", labels: [], body: "" });
      const seen = { comments: [] as string[], labels: [] as string[], closed: false };
      stubMonitoredMentionFetch(311, seen);
      const payload = {
        action: "created" as const,
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" as const } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 311, title: "Redelivery", state: "open", pull_request: {}, user: { login: "chatty" }, author_association: "NONE" },
        comment: { id: 1, body: "@JSONbored ping", user: { login: "chatty", type: "User" as const }, author_association: "NONE" },
      };
      await processJob(env, { type: "github-webhook", deliveryId: "mention-redelivery-same", eventName: "issue_comment", payload });
      await processJob(env, { type: "github-webhook", deliveryId: "mention-redelivery-same", eventName: "issue_comment", payload });
      const pings = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.monitored_mention_ping'").first<{ n: number }>();
      // NOTE: unlike #2560's per-command limiter, review-nag/monitored-mention ping recording does not itself
      // dedup by deliveryId -- it always records. This assertion documents CURRENT behavior (2 pings from 2
      // deliveries) rather than asserting an idempotency guarantee this handler does not provide.
      expect(pings?.n).toBe(2);
    });
  });

  describe("per-command @gittensory rate limit (#2560)", () => {
    function stubCommandRateLimitFetch(issueNumber: number, seen: { comments: string[] }) {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "maintain" });
        if (url.includes(`/issues/${issueNumber}/comments`) && method === "GET") return Response.json([]);
        if (url.includes(`/issues/${issueNumber}/comments`) && method === "POST") {
          seen.comments.push(String(JSON.parse(String(init?.body ?? "{}")).body ?? ""));
          return Response.json({ id: seen.comments.length }, { status: 201 });
        }
        return new Response("not found", { status: 404 });
      });
    }

    function mentionPayload(issueNumber: number, body: string) {
      return {
        action: "created" as const,
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: issueNumber, title: "Rate limit target", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: { id: 1, body, user: { login: "maintainer", type: "User" }, author_association: "OWNER" },
      };
    }

    it("is off by default — no invocation is tracked and every command dispatches normally", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 300, title: "Rate limit target", state: "open", user: { login: "oktofeesh1" }, author_association: "NONE", labels: [], body: "" });
      const seen = { comments: [] as string[] };
      stubCommandRateLimitFetch(300, seen);
      for (let i = 0; i < 25; i += 1) {
        await processJob(env, { type: "github-webhook", deliveryId: `rl-off-${i}`, eventName: "issue_comment", payload: mentionPayload(300, "@gittensory help") });
      }
      const invocations = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.command_invocation'").first<{ n: number }>();
      expect(invocations?.n).toBe(0);
      expect(seen.comments).toHaveLength(25); // every one of the 25 invocations dispatched normally
    });

    it("records invocations under the configured threshold without holding — the normal reply still proceeds", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", commandRateLimitPolicy: "hold", commandRateLimitMaxPerWindow: 5, commandRateLimitWindowHours: 24 });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 301, title: "Rate limit target", state: "open", user: { login: "oktofeesh1" }, author_association: "NONE", labels: [], body: "" });
      const seen = { comments: [] as string[] };
      stubCommandRateLimitFetch(301, seen);
      await processJob(env, { type: "github-webhook", deliveryId: "rl-under", eventName: "issue_comment", payload: mentionPayload(301, "@gittensory help") });
      const invocations = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.command_invocation'").first<{ n: number }>();
      expect(invocations?.n).toBe(1); // 1st of 5 allowed
      const applied = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.command_rate_limit_applied'").first<{ n: number }>();
      expect(applied?.n).toBe(0); // under threshold — no hold
      expect(seen.comments).toHaveLength(1); // the normal answer card still posted
    });

    it("hold policy: posts a cooldown reply and short-circuits once a CHEAP command crosses its threshold", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", commandRateLimitPolicy: "hold", commandRateLimitMaxPerWindow: 3, commandRateLimitWindowHours: 24 });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 302, title: "Rate limit target", state: "open", user: { login: "oktofeesh1" }, author_association: "NONE", labels: [], body: "" });
      for (let i = 0; i < 3; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.command_invocation", actor: "maintainer", targetKey: "JSONbored/gittensory#302#help", outcome: "completed" });
      }
      const seen = { comments: [] as string[] };
      stubCommandRateLimitFetch(302, seen);
      await processJob(env, { type: "github-webhook", deliveryId: "rl-cheap-over", eventName: "issue_comment", payload: mentionPayload(302, "@gittensory help") });
      // Only ONE comment posted — the short-circuit skipped the normal answer-card dispatch.
      expect(seen.comments).toHaveLength(1);
      expect(seen.comments[0]).toContain("rate limit");
      const applied = await env.DB.prepare("select outcome, detail from audit_events where event_type = 'github_app.command_rate_limit_applied'").first<{ outcome: string; detail: string }>();
      expect(applied?.outcome).toBe("completed");
      expect(applied?.detail).toContain("hold applied");
    });

    it("an AI-cost-bearing command uses the TIGHTER commandRateLimitAiMaxPerWindow default, not the cheap-command limit", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      // Cheap-command limit left generous (20, the default); only the AI limit is tight enough to trip here.
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", commandRateLimitPolicy: "hold", commandRateLimitAiMaxPerWindow: 2, commandRateLimitWindowHours: 24 });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 303, title: "Rate limit target", state: "open", user: { login: "oktofeesh1" }, author_association: "NONE", labels: [], body: "" });
      for (let i = 0; i < 2; i += 1) {
        await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.command_invocation", actor: "maintainer", targetKey: "JSONbored/gittensory#303#next-action", outcome: "completed" });
      }
      const seen = { comments: [] as string[] };
      stubCommandRateLimitFetch(303, seen);
      await processJob(env, { type: "github-webhook", deliveryId: "rl-ai-over", eventName: "issue_comment", payload: mentionPayload(303, "@gittensory next-action") });
      expect(seen.comments).toHaveLength(1);
      expect(seen.comments[0]).toContain("rate limit");
      const applied = await env.DB.prepare("select detail from audit_events where event_type = 'github_app.command_rate_limit_applied'").first<{ detail: string }>();
      expect(applied?.detail).toContain("limit 2"); // the AI limit (2), not the cheap default (20)
    });

    it("commands have INDEPENDENT counters — repeatedly invoking one command never throttles a DIFFERENT command", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", commandRateLimitPolicy: "hold", commandRateLimitMaxPerWindow: 1, commandRateLimitWindowHours: 24 });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 304, title: "Rate limit target", state: "open", user: { login: "oktofeesh1" }, author_association: "NONE", labels: [], body: "" });
      // Already at the "help" limit (1) — a further "help" invocation would be held.
      await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.command_invocation", actor: "maintainer", targetKey: "JSONbored/gittensory#304#help", outcome: "completed" });
      const seen = { comments: [] as string[] };
      stubCommandRateLimitFetch(304, seen);
      // A DIFFERENT command ("miner-context") on the same thread by the same actor must not be affected.
      await processJob(env, { type: "github-webhook", deliveryId: "rl-independent", eventName: "issue_comment", payload: mentionPayload(304, "@gittensory miner-context") });
      expect(seen.comments).toHaveLength(1);
      expect(seen.comments[0]).not.toContain("rate limit");
      const applied = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.command_rate_limit_applied'").first<{ n: number }>();
      expect(applied?.n).toBe(0);
    });

    it("dry-run mode: holds the command but never posts a live cooldown comment", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", commandRateLimitPolicy: "hold", commandRateLimitMaxPerWindow: 1, commandRateLimitWindowHours: 24, agentDryRun: true });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 305, title: "Rate limit target", state: "open", user: { login: "oktofeesh1" }, author_association: "NONE", labels: [], body: "" });
      await repositoriesModule.recordAuditEvent(env, { eventType: "github_app.command_invocation", actor: "maintainer", targetKey: "JSONbored/gittensory#305#help", outcome: "completed" });
      const seen = { comments: [] as string[] };
      stubCommandRateLimitFetch(305, seen);
      await processJob(env, { type: "github-webhook", deliveryId: "rl-dry-run", eventName: "issue_comment", payload: mentionPayload(305, "@gittensory help") });
      expect(seen.comments).toHaveLength(0); // held, but dry-run posts nothing live
      const applied = await env.DB.prepare("select outcome from audit_events where event_type = 'github_app.command_rate_limit_applied'").first<{ outcome: string }>();
      expect(applied?.outcome).toBe("denied");
    });

    it("REGRESSION: a redelivered webhook (same deliveryId) does not double-count — the replay is a no-op, not a second invocation", async () => {
      // GitHub can and does redeliver the same issue_comment event (timeout/retry). Before the fix, the
      // second delivery would increment the counter again for what is really ONE real invocation, and could
      // incorrectly cross the rate-limit threshold on a redelivery alone.
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", commandRateLimitPolicy: "hold", commandRateLimitMaxPerWindow: 1, commandRateLimitWindowHours: 24 });
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 306, title: "Rate limit target", state: "open", user: { login: "oktofeesh1" }, author_association: "NONE", labels: [], body: "" });
      const seen = { comments: [] as string[] };
      stubCommandRateLimitFetch(306, seen);
      // The SAME deliveryId, redelivered — GitHub's own retry behavior on a timeout/5xx.
      await processJob(env, { type: "github-webhook", deliveryId: "rl-redelivered", eventName: "issue_comment", payload: mentionPayload(306, "@gittensory help") });
      await processJob(env, { type: "github-webhook", deliveryId: "rl-redelivered", eventName: "issue_comment", payload: mentionPayload(306, "@gittensory help") });

      const invocations = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.command_invocation'").first<{ n: number }>();
      expect(invocations?.n).toBe(1); // only ONE invocation recorded despite two processing passes
      expect(seen.comments).toHaveLength(1); // the replay is suppressed entirely — no second answer card
      expect(seen.comments.every((c) => !c.includes("rate limit"))).toBe(true);
      const suppressed = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.command_redelivery_suppressed'").first<{ n: number }>();
      expect(suppressed?.n).toBe(1);
    });
  });

  it("denies a maintainer Q&A command from an org member without real repo permission (#788)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 96,
      title: "Org member tries a maintainer command",
      state: "open",
      user: { login: "alice" },
      author_association: "NONE",
      labels: [],
      body: "",
    });
    const calls = { comments: 0, permission: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // The commenter is an org MEMBER but has only READ access to THIS repo — not a maintainer/collaborator.
      if (url.includes("/collaborators/orgmember/permission")) {
        calls.permission += 1;
        return Response.json({ permission: "read" });
      }
      if (url.includes("/issues/") && url.includes("/comments")) {
        calls.comments += 1;
        return Response.json([]);
      }
      return new Response("not found", { status: 404 });
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-org-member-no-permission",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 96, title: "Org member tries a maintainer command", state: "open", pull_request: {}, user: { login: "alice" }, author_association: "NONE" },
        // author_association MEMBER would have granted the maintainer role pre-#788; it no longer does.
        comment: { id: 96, body: "@gittensory queue-summary", user: { login: "orgmember", type: "User" }, author_association: "MEMBER" },
      },
    });
    expect(calls.permission).toBe(1); // the REAL repo permission was consulted, not the spoofable association
    expect(calls.comments).toBe(0); // …and the org member was denied — no maintainer reply
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.agent_command_skipped", "JSONbored/gittensory#96")
      .first<{ detail: string }>();
    expect(skip?.detail).toBe("not_maintainer_or_pr_author");
  });

  it("records command usage as an error when miner authorization cannot be checked", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return new Response("api down", { status: 503 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-miner-unavailable",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 84, title: "Miner unavailable PR", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: { id: 5, body: "@gittensory preflight", user: { login: "oktofeesh1", type: "User" }, author_association: "NONE" },
      },
    });

    const usageEvents = await listProductUsageEvents(env, { limit: 5 });
    expect(usageEvents).toEqual([
      expect.objectContaining({ surface: "github_app", eventName: "agent_command_skipped", outcome: "error", metadata: expect.objectContaining({ reason: "miner_detection_unavailable" }) }),
    ]);
  });

  it("does not let product usage write failures block GitHub command audits", async () => {
    const env = withProductUsageInsertFailure(createTestEnv());
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-product-usage-down",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 90, title: "Plain issue", state: "open", user: { login: "reporter" } },
        comment: { id: 1, body: "@gittensory preflight", user: { login: "reporter", type: "User" }, author_association: "NONE" },
      },
    });

    const audit = await env.DB.prepare("select event_type, detail from audit_events where target_key = ?")
      .bind("JSONbored/gittensory#90")
      .all<{ event_type: string; detail: string }>();
    expect(audit.results).toEqual([expect.objectContaining({ event_type: "github_app.agent_command_skipped", detail: "not_a_pull_request_thread" })]);
  });

  it("audits command authorization errors when miner detection is unavailable", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString() === "https://api.gittensor.io/miners") return new Response("unavailable", { status: 503 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "agent-command-miner-unavailable",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 84, title: "Unavailable miner check", state: "open", pull_request: {}, user: { login: "oktofeesh1" }, author_association: "NONE" },
        comment: { id: 5, body: "@gittensory preflight", user: { login: "oktofeesh1", type: "User" }, author_association: "NONE" },
      },
    });

    const event = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.agent_command_skipped", "JSONbored/gittensory#84")
      .first<{ outcome: string; detail: string }>();
    expect(event).toMatchObject({ outcome: "error", detail: "miner_detection_unavailable" });
  });

  it("detects a changes-requested review notification for the PR author", async () => {
    const enqueued: Array<{ type: string }> = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      JOBS: {
        async send(message: { type: string }) {
          enqueued.push(message);
        },
      } as unknown as Queue,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/repos/JSONbored/gittensory/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "review-changes-requested",
      eventName: "pull_request_review",
      payload: {
        action: "submitted",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 42,
          title: "Add feature",
          state: "open",
          user: { login: "contributor", type: "User" },
          html_url: "https://github.com/JSONbored/gittensory/pull/42",
        },
        review: {
          state: "changes_requested",
          user: { login: "maintainer", type: "User" },
          submitted_at: "2026-05-28T12:00:00.000Z",
          html_url: "https://github.com/JSONbored/gittensory/pull/42#pullrequestreview-1",
        },
        sender: { login: "maintainer", type: "User" },
      },
    });

    const detected = await env.DB.prepare("select actor, target_key, outcome, detail, metadata_json from audit_events where event_type = ?")
      .bind("notification.event_detected")
      .all<{ actor: string; target_key: string; outcome: string; detail: string; metadata_json: string }>();
    expect(detected.results).toHaveLength(1);
    expect(detected.results[0]).toMatchObject({
      actor: "maintainer",
      target_key: "contributor",
      outcome: "success",
      detail: "pull_request_changes_requested for JSONbored/gittensory#42",
    });
    expect(JSON.parse(detected.results[0]!.metadata_json)).toMatchObject({
      deliveryId: "review-changes-requested",
      eventType: "pull_request_changes_requested",
      recipientLogin: "contributor",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 42,
      dedupKey: "changes_requested:JSONbored/gittensory#42:maintainer:2026-05-28T12:00:00.000Z",
    });
    expect(JSON.stringify(detected.results[0])).not.toMatch(/trust score|wallet|hotkey|reward estimate|reviewability/i);

    const evaluateJob = enqueued.find((message): message is { type: "notify-evaluate"; events: Array<{ recipientLogin: string }> } => message.type === "notify-evaluate");
    expect(evaluateJob).toBeDefined();
    expect(evaluateJob!.events).toHaveLength(1);
    expect(evaluateJob!.events[0]!.recipientLogin).toBe("contributor");
  });

  it("skips changes-requested review notifications from reviewers without repository write permission", async () => {
    const enqueued: Array<{ type: string }> = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      JOBS: {
        async send(message: { type: string }) {
          enqueued.push(message);
        },
      } as unknown as Queue,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/repos/JSONbored/gittensory/collaborators/drive-by-user/permission")) return Response.json({ permission: "read" });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "review-changes-requested-low-priv",
      eventName: "pull_request_review",
      payload: {
        action: "submitted",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 42,
          title: "Add feature",
          state: "open",
          user: { login: "contributor", type: "User" },
          html_url: "https://github.com/JSONbored/gittensory/pull/42",
        },
        review: {
          state: "changes_requested",
          user: { login: "drive-by-user", type: "User" },
          submitted_at: "2026-05-28T12:00:00.000Z",
          html_url: "https://github.com/JSONbored/gittensory/pull/42#pullrequestreview-1",
        },
        sender: { login: "drive-by-user", type: "User" },
      },
    });

    const detected = await env.DB.prepare("select actor from audit_events where event_type = ?")
      .bind("notification.event_detected")
      .all<{ actor: string }>();
    expect(detected.results).toEqual([]);
    expect(enqueued).not.toContainEqual(expect.objectContaining({ type: "notify-evaluate" }));
  });

  it("skips changes-requested review notifications with an unknown actor without consulting repo permissions", async () => {
    const enqueued: Array<{ type: string }> = [];
    const permissionCalls: string[] = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      JOBS: {
        async send(message: { type: string }) {
          enqueued.push(message);
        },
      } as unknown as Queue,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/")) {
        permissionCalls.push(url);
        return Response.json({ permission: "admin" });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "review-changes-requested-unknown-actor",
      eventName: "pull_request_review",
      payload: {
        action: "submitted",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 42,
          title: "Add feature",
          state: "open",
          user: { login: "contributor", type: "User" },
          html_url: "https://github.com/JSONbored/gittensory/pull/42",
        },
        // Neither the review nor the sender carries a login → detectNotificationEvents emits actorLogin "unknown".
        review: {
          state: "changes_requested",
          submitted_at: "2026-05-28T12:00:00.000Z",
          html_url: "https://github.com/JSONbored/gittensory/pull/42#pullrequestreview-1",
        },
      },
    });

    const detected = await env.DB.prepare("select actor from audit_events where event_type = ?")
      .bind("notification.event_detected")
      .all<{ actor: string }>();
    expect(detected.results).toEqual([]);
    expect(enqueued).not.toContainEqual(expect.objectContaining({ type: "notify-evaluate" }));
    // The unknown-actor guard short-circuits before any collaborator-permission lookup.
    expect(permissionCalls).toEqual([]);
  });

  it("skips changes-requested review notifications when the webhook has no installation", async () => {
    const enqueued: Array<{ type: string }> = [];
    const permissionCalls: string[] = [];
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      JOBS: {
        async send(message: { type: string }) {
          enqueued.push(message);
        },
      } as unknown as Queue,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/")) {
        permissionCalls.push(url);
        return Response.json({ permission: "admin" });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "review-changes-requested-no-installation",
      eventName: "pull_request_review",
      payload: {
        action: "submitted",
        // No installation present → installationId is undefined and the reviewer cannot be verified.
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 42,
          title: "Add feature",
          state: "open",
          user: { login: "contributor", type: "User" },
          html_url: "https://github.com/JSONbored/gittensory/pull/42",
        },
        review: {
          state: "changes_requested",
          user: { login: "maintainer", type: "User" },
          submitted_at: "2026-05-28T12:00:00.000Z",
          html_url: "https://github.com/JSONbored/gittensory/pull/42#pullrequestreview-1",
        },
        sender: { login: "maintainer", type: "User" },
      },
    });

    const detected = await env.DB.prepare("select actor from audit_events where event_type = ?")
      .bind("notification.event_detected")
      .all<{ actor: string }>();
    expect(detected.results).toEqual([]);
    expect(enqueued).not.toContainEqual(expect.objectContaining({ type: "notify-evaluate" }));
    // With no installation we cannot verify the reviewer, so no permission lookup is attempted.
    expect(permissionCalls).toEqual([]);
  });

  it.each(["submitted", "dismissed", "edited"] as const)(
    "bumps reviewsInvalidatedAt for the right repo+PR on a pull_request_review '%s' webhook (#2537)",
    async (action) => {
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        JOBS: { async send() {} } as unknown as Queue,
      });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        return new Response("not found", { status: 404 });
      });
      // Seed an existing sync-state row so the assertion can confirm ONLY reviewsInvalidatedAt moved.
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        number: 42,
        title: "Add feature",
        state: "open",
        user: { login: "contributor" },
        head: { sha: "sha-42" },
        labels: [],
        body: "",
      });

      await processJob(env, {
        type: "github-webhook",
        deliveryId: `review-invalidate-${action}`,
        eventName: "pull_request_review",
        payload: {
          action,
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: {
            number: 42,
            title: "Add feature",
            state: "open",
            user: { login: "contributor", type: "User" },
            html_url: "https://github.com/JSONbored/gittensory/pull/42",
          },
          review: {
            state: action === "dismissed" ? "DISMISSED" : "APPROVED",
            user: { login: "maintainer", type: "User" },
            submitted_at: "2026-05-28T12:00:00.000Z",
            html_url: "https://github.com/JSONbored/gittensory/pull/42#pullrequestreview-1",
          },
          sender: { login: "maintainer", type: "User" },
        },
      });

      const state = await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 42);
      expect(state?.reviewsInvalidatedAt).toBeTruthy();
    },
  );

  it("does not bump reviewsInvalidatedAt for a pull_request_review action outside submitted/dismissed/edited", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      JOBS: { async send() {} } as unknown as Queue,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "review-invalidate-unsupported-action",
      eventName: "pull_request_review",
      payload: {
        // "submitted" | "dismissed" | "edited" are the only invalidating actions; GitHub also emits others
        // (e.g. review comments carry their own event) that must NOT stamp the cache marker.
        action: "unrecognized_action" as unknown as "submitted",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 43,
          title: "Add feature",
          state: "open",
          user: { login: "contributor", type: "User" },
          html_url: "https://github.com/JSONbored/gittensory/pull/43",
        },
        review: {
          state: "APPROVED",
          user: { login: "maintainer", type: "User" },
          submitted_at: "2026-05-28T12:00:00.000Z",
          html_url: "https://github.com/JSONbored/gittensory/pull/43#pullrequestreview-1",
        },
        sender: { login: "maintainer", type: "User" },
      },
    });

    expect(await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 43)).toBeNull();
  });

  it("notifies issue-watchers when a new grabbable maintainer-created issue opens (#699 path B)", async () => {
    const enqueued: Array<{ type: string; events?: Array<{ eventType: string; recipientLogin: string; pullNumber: number }> }> = [];
    const env = createTestEnv({ JOBS: { async send(message: { type: string }) { enqueued.push(message); } } as unknown as Queue });
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 })); // no .gittensory.yml → empty manifest
    const watcherLogins = Array.from({ length: 205 }, (_, index) => `watcher-${String(index + 1).padStart(3, "0")}`);
    for (const login of watcherLogins) {
      await upsertIssueWatchSubscription(env, { login, repoFullName: "JSONbored/gittensory" });
    }
    await upsertIssueWatchSubscription(env, { login: "maintainer", repoFullName: "JSONbored/gittensory" }); // the author — should be skipped

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "issue-watch-open",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 91, title: "Add caching to the registry sync", state: "open", user: { login: "maintainer" }, author_association: "OWNER", body: "We should cache the registry fetch." },
      },
    });

    // Batched but bounded (#selfhost-maintenance-self-pin): watcher matches from this ONE webhook delivery ride in
    // chunked notify-evaluate jobs, not one job per watcher and not one unbounded queue payload.
    const evaluateJobs = enqueued.filter((m): m is { type: "notify-evaluate"; events: Array<{ eventType: string; recipientLogin: string; pullNumber: number }> } => m.type === "notify-evaluate");
    expect(evaluateJobs.map((job) => job.events).map((events) => events.length)).toEqual([100, 100, 5]);
    const watchEvents = evaluateJobs.flatMap((job) => job.events).filter((event) => event.eventType === "issue_watch_match");
    expect(watchEvents.map((event) => event.recipientLogin).sort()).toEqual(watcherLogins); // maintainer (author) skipped
    expect(watchEvents.every((event) => event.pullNumber === 91)).toBe(true);

    const detected = await env.DB.prepare("select metadata_json from audit_events where event_type = 'notification.event_detected' and target_key = ?").bind("watcher-001").first<{ metadata_json: string }>();
    expect(JSON.parse(detected!.metadata_json)).toMatchObject({ eventType: "issue_watch_match", recipientLogin: "watcher-001", repoFullName: "JSONbored/gittensory" });
  });

  it("REGRESSION (#3218 review): chunk membership across a >100-watcher batch is order-independent -- the SAME watcher set in a different arrival order still produces the SAME set of chunk coalesce keys", async () => {
    const watcherLogins = Array.from({ length: 205 }, (_, index) => `watcher-${String(index + 1).padStart(3, "0")}`);

    const enqueueNotifyEvaluateJobs = async (loginOrder: string[]): Promise<Array<{ type: string; events: Array<{ dedupKey: string }> }>> => {
      const enqueued: Array<{ type: string; events?: Array<{ dedupKey: string }> }> = [];
      const env = createTestEnv({ JOBS: { async send(message: { type: string }) { enqueued.push(message); } } as unknown as Queue });
      vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 })); // no .gittensory.yml → empty manifest
      // listIssueWatchersForRepo has no ORDER BY -- insertion order IS read-back order, so inserting in a
      // different order here genuinely reproduces two logically-identical detection passes disagreeing on
      // notificationEvents' arrival order, exactly the redelivery scenario the review is concerned about.
      for (const login of loginOrder) {
        await upsertIssueWatchSubscription(env, { login, repoFullName: "JSONbored/gittensory" });
      }
      await processJob(env, {
        type: "github-webhook",
        deliveryId: `issue-watch-open-${loginOrder[0]}`,
        eventName: "issues",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          issue: { number: 91, title: "Add caching to the registry sync", state: "open", user: { login: "maintainer" }, author_association: "OWNER", body: "We should cache the registry fetch." },
        },
      });
      vi.unstubAllGlobals();
      return enqueued.filter((m): m is { type: "notify-evaluate"; events: Array<{ dedupKey: string }> } => m.type === "notify-evaluate");
    };

    const coalesceKeysFor = (jobs: Array<{ type: string; events: Array<{ dedupKey: string }> }>): Array<string | null> =>
      jobs.map((job) => jobCoalesceKey(JSON.stringify(job))).sort();

    const forwardJobs = await enqueueNotifyEvaluateJobs(watcherLogins);
    const reversedJobs = await enqueueNotifyEvaluateJobs([...watcherLogins].reverse());

    // Same chunk SIZES either way (chunking itself is unaffected -- only membership was the risk).
    expect(forwardJobs.map((job) => job.events.length)).toEqual([100, 100, 5]);
    expect(reversedJobs.map((job) => job.events.length)).toEqual([100, 100, 5]);
    // The set of chunk-level coalesce keys must match -- proving a redelivery whose events resolve in a
    // different order still coalesces with the original batch instead of silently re-running as "new" work.
    expect(coalesceKeysFor(reversedJobs)).toEqual(coalesceKeysFor(forwardJobs));
  });

  it("appends issue-side slop findings to the issue advisory only when slop is opted in (#533)", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 })); // no .gittensory.yml → empty manifest
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositoryFromGitHub(env, { name: "other", full_name: "JSONbored/other", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", slopGateMode: "advisory" });
    // JSONbored/other keeps the default slopGateMode "off".

    const emptyBodyIssue = (repoFull: string, name: string, number: number) => ({
      type: "github-webhook" as const,
      deliveryId: `issue-slop-${number}`,
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name, full_name: repoFull, private: false, owner: { login: "JSONbored" } },
        issue: { number, title: "Something is broken", state: "open", user: { login: "reporter" }, body: "   " },
      },
    });
    await processJob(env, emptyBodyIssue("JSONbored/gittensory", "gittensory", 501));
    await processJob(env, emptyBodyIssue("JSONbored/other", "other", 502));

    const slopOn = await env.DB.prepare("select findings_json from advisories where target_type = 'issue' and repo_full_name = ?").bind("JSONbored/gittensory").first<{ findings_json: string }>();
    const slopOff = await env.DB.prepare("select findings_json from advisories where target_type = 'issue' and repo_full_name = ?").bind("JSONbored/other").first<{ findings_json: string }>();
    expect(slopOn?.findings_json).toContain("empty_issue_body"); // opted in → triage finding present
    expect(slopOff?.findings_json ?? "").not.toContain("empty_issue_body"); // default off → no slop finding
  });

  it("clears the persisted dashboard slop score when the slop gate is off (#911)", async () => {
    // Merge-readiness still collects the live slop score, so shouldCollectSlopEvidence runs even with the
    // slop gate disabled — but with slopGateMode "off" the persisted dashboard row must be cleared to null
    // so a previously cached score doesn't linger after a maintainer disables slop.
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
      gateCheckMode: "enabled", reviewCheckMode: "required",
      linkedIssueGateMode: "off",
      slopGateMode: "off", // dashboard slop disabled…
      mergeReadinessGateMode: "advisory", // …but readiness keeps the live score in play
    });
    // Seed the PR row plus a stale dashboard slop score that the slop-off pass must clear.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 91,
      title: "Add helper",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "slopoff123" },
      labels: [],
      body: "Adds a helper.",
    });
    await updatePullRequestSlopAssessment(env, "JSONbored/gittensory", 91, { slopRisk: 80, slopBand: "high" });
    await upsertPullRequestFile(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 91,
      path: "src/helper.ts",
      status: "modified",
      additions: 5,
      deletions: 0,
      changes: 5,
      payload: {},
    });
    expect((await getPullRequest(env, "JSONbored/gittensory", 91))?.slopRisk).toBe(80); // stale score present pre-run

    const refreshedFiles: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/91/files")) {
        refreshedFiles.push(url);
        return Response.json([{ filename: "src/helper.ts", status: "modified", additions: 5, deletions: 0, changes: 5 }]);
      }
      if (url.includes("/commits/slopoff123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs")) return Response.json({ id: 991 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "slop-off-clear",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 91, title: "Add helper", state: "open", user: { login: "contributor" }, head: { sha: "slopoff123" }, labels: [], body: "Adds a helper." },
      },
    });

    // Slop gate off → the previously persisted dashboard score is null-persisted, not left stale.
    const cleared = await getPullRequest(env, "JSONbored/gittensory", 91);
    expect(cleared?.slopRisk).toBeNull();
    expect(cleared?.slopBand).toBeNull();
    expect(refreshedFiles).toHaveLength(1);
  });

  it("#dup-winner: flag ON spares the lowest open sibling — no duplicate block, slop not penalized for the cluster", async () => {
    // GITTENSORY_DUPLICATE_WINNER ON. A same-issue cluster of OPEN PRs (#91 winner, #92 loser) under
    // duplicatePrGateMode: block. The winner (#91, lowest open number) must NOT be gate-blocked or slop-
    // penalized as a duplicate — it is judged on its own merits. This drives the flag-ON branch of the
    // processors gate path (isDupWinner) + the advisory duplicate-finding suppression.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_DUPLICATE_WINNER: "true" });
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
      gateCheckMode: "enabled", reviewCheckMode: "required",
      linkedIssueGateMode: "off",
      duplicatePrGateMode: "block",
      slopGateMode: "advisory",
      qualityGateMode: "block",
      qualityGateMinScore: 95,
    });
    // The shared issue + the HIGHER-numbered open sibling (#92) → forms the same-issue duplicate cluster.
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 1, title: "Cache the registry sync", state: "open", user: { login: "maintainer" }, author_association: "OWNER", body: "We should cache the registry fetch." });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 91, title: "Fix the cache", state: "open", user: { login: "contributor" }, author_association: "CONTRIBUTOR", head: { sha: "win91" }, labels: [], body: "Fixes #1\n\nValidation: npm test" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 92, title: "Also fix the cache", state: "open", user: { login: "other" }, author_association: "CONTRIBUTOR", head: { sha: "sib92" }, labels: [], body: "Fixes #1" });

    let gatePatchBody: { conclusion?: string; output?: { title?: string; text?: string } } = {};
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/91/files")) return Response.json([{ filename: "src/cache.ts", status: "modified", additions: 12, deletions: 0, changes: 12 }]);
      if (url.includes("/commits/win91/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "PATCH") {
        gatePatchBody = JSON.parse(String(init?.body ?? "{}")) as typeof gatePatchBody;
        return Response.json({ id: 960 });
      }
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 960 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "dup-winner-on",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 91, title: "Fix the cache", state: "open", user: { login: "contributor" }, author_association: "CONTRIBUTOR", head: { sha: "win91" }, labels: [], body: "Fixes #1\n\nValidation: npm test" },
      },
    });

    // Winner survives: a later duplicate sibling must not lower readiness below a blocking threshold.
    expect(gatePatchBody.conclusion).not.toBe("failure");
    expect(gatePatchBody.output?.text ?? "").not.toContain("readiness_score_below_threshold");
    // The persisted advisory for the winner OMITS the duplicate finding (suppressed) — that is what suppresses
    // the gate failure and the auto-close duplicate cause.
    const winnerAdvisory = await env.DB.prepare("select findings_json from advisories where target_type = 'pull_request' and repo_full_name = ? and pull_number = ?").bind("JSONbored/gittensory", 91).first<{ findings_json: string }>();
    expect(winnerAdvisory?.findings_json ?? "").not.toContain("duplicate_pr_risk");
  });

  it("#dup-winner: flag OFF keeps every same-issue sibling blocked (byte-identical) — the winner is also closed-eligible", async () => {
    // Same cluster, flag OFF (default). The lowest open PR (#91) STILL gets the duplicate block + finding,
    // exactly like today — no winner is spared.
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
      gateCheckMode: "enabled", reviewCheckMode: "required",
      linkedIssueGateMode: "off",
      duplicatePrGateMode: "block",
      slopGateMode: "advisory",
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 1, title: "Cache the registry sync", state: "open", user: { login: "maintainer" }, author_association: "OWNER", body: "We should cache the registry fetch." });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 92, title: "Also fix the cache", state: "open", user: { login: "other" }, author_association: "CONTRIBUTOR", head: { sha: "sib92b" }, labels: [], body: "Fixes #1" });

    let gatePatchBody: { conclusion?: string; output?: { title?: string; text?: string } } = {};
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/91/files")) return Response.json([{ filename: "src/cache.ts", status: "modified", additions: 12, deletions: 0, changes: 12 }]);
      if (url.includes("/commits/win91b/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "PATCH") {
        gatePatchBody = JSON.parse(String(init?.body ?? "{}")) as typeof gatePatchBody;
        return Response.json({ id: 961 });
      }
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 961 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "dup-winner-off",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 91, title: "Fix the cache", state: "open", user: { login: "contributor" }, author_association: "CONTRIBUTOR", head: { sha: "win91b" }, labels: [], body: "Fixes #1" },
      },
    });

    // Flag OFF: the duplicate block still fires for the lowest sibling — the Gate fails, the finding persists.
    expect(gatePatchBody.conclusion).toBe("failure");
    const winnerAdvisory = await env.DB.prepare("select findings_json from advisories where target_type = 'pull_request' and repo_full_name = ? and pull_number = ?").bind("JSONbored/gittensory", 91).first<{ findings_json: string }>();
    expect(winnerAdvisory?.findings_json ?? "").toContain("duplicate_pr_risk");
  });

  it("REGRESSION (#dup-winner-slop-drift): maybePublishPrPublicSurface's slop penalty uses the LIVE-reconciled siblings, not a raw stale-cached read — a stale-cached-open lower sibling that is actually CLOSED on GitHub must not deny this PR winner status / slop-penalize it for the cluster", async () => {
    // GITTENSORY_DUPLICATE_WINNER ON. PR #95 (this PR, being reviewed) links issue #1; PR #90 (LOWER-numbered,
    // same linked issue) is cached `open` in the DB (a missed/delayed `closed` webhook), but GitHub's LIVE state
    // for #90 is actually `closed`. Before the fix, maybePublishPrPublicSurface's own duplicate-winner election
    // read the raw, un-reconciled `listPullRequests` result (still showing #90 as open) and so wrongly denied
    // #95 winner status, applying the duplicateClusterMembership slop penalty (weight 15, persisted slop_band
    // "low") even though the gate's OWN reconciled otherOpenPullRequests (used to build the advisory/gate
    // disposition) had already correctly dropped #90. After the fix, both paths agree: #95 is the winner (no
    // open siblings once reconciled) and carries NO duplicate-cluster slop penalty (slop_band "clean").
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_DUPLICATE_WINNER: "true" });
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
      gateCheckMode: "enabled", reviewCheckMode: "required",
      linkedIssueGateMode: "off",
      duplicatePrGateMode: "block",
      slopGateMode: "advisory",
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 1, title: "Cache the registry sync", state: "open", user: { login: "maintainer" }, author_association: "OWNER", body: "We should cache the registry fetch." });
    // Stale-cached-open sibling: the DB still says #90 is open (the closed webhook was missed/delayed).
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 90, title: "Older attempt at the cache fix", state: "open", user: { login: "other" }, author_association: "CONTRIBUTOR", head: { sha: "sib90" }, labels: [], body: "Fixes #1" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 95, title: "Fix the cache", state: "open", user: { login: "contributor" }, author_association: "CONTRIBUTOR", head: { sha: "win95" }, labels: [], body: "Fixes #1\n\nValidation: npm test" });

    let liveStateFetches90 = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // The LIVE state of the lower sibling #90 is CLOSED, contradicting the stale-cached "open" DB row --
      // reconcileLiveDuplicateSiblings must discover this via a genuine live fetch, not the cache.
      if (/\/pulls\/90(?:\?|$)/.test(url)) {
        liveStateFetches90 += 1;
        return Response.json({ number: 90, state: "closed" });
      }
      // Includes a test-file change alongside the code change so missingTestEvidence never confounds the
      // duplicateClusterMembership assertion below — this test isolates the ONE slop signal under test.
      if (url.includes("/pulls/95/files"))
        return Response.json([
          { filename: "src/cache.ts", status: "modified", additions: 12, deletions: 0, changes: 12 },
          { filename: "test/unit/cache.test.ts", status: "modified", additions: 8, deletions: 0, changes: 8 },
        ]);
      if (url.includes("/commits/win95/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "PATCH") return Response.json({ id: 970 });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 970 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "dup-winner-slop-drift",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 95, title: "Fix the cache", state: "open", user: { login: "contributor" }, author_association: "CONTRIBUTOR", head: { sha: "win95" }, labels: [], body: "Fixes #1\n\nValidation: npm test" },
      },
    });

    // A genuine live reconciliation happened (proving the fix reads live state, not the stale cache).
    expect(liveStateFetches90).toBeGreaterThan(0);
    // #95 is correctly credited as the cluster winner: no duplicateClusterMembership slop penalty persisted.
    const winnerPr = await env.DB.prepare("select slop_risk, slop_band from pull_requests where repo_full_name = ? and number = ?").bind("JSONbored/gittensory", 95).first<{ slop_risk: number | null; slop_band: string | null }>();
    expect(winnerPr?.slop_band).toBe("clean");
    expect(winnerPr?.slop_risk).toBe(0);
  });

  it("overrides the Gate to neutral for THIS commit only when a real write/admin maintainer runs gate-override", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled", reviewCheckMode: "required",
      linkedIssueGateMode: "off",
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 90,
      title: "Override me",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "override-sha" },
      labels: [],
      body: "Validation: npm test",
    });
    const calls = { token: 0, permission: 0, checkGets: 0, checkPatches: 0, commentGets: 0, commentPatches: 0 };
    const patchBodies: Array<{ status?: string; conclusion?: string; output?: { title?: string; text?: string } }> = [];
    let confirmationBody = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      // Authorization MUST come from the real collaborator-permission API, never the comment author_association.
      if (url.includes("/collaborators/maintainer/permission")) {
        calls.permission += 1;
        return Response.json({ permission: "admin" });
      }
      if (url.includes("/commits/override-sha/check-runs") && method === "GET") {
        calls.checkGets += 1;
        return Response.json({ total_count: 1, check_runs: [{ id: 555, name: "Gittensory Orb Review Agent" }] });
      }
      if (url.includes("/check-runs/555") && method === "PATCH") {
        calls.checkPatches += 1;
        patchBodies.push(JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string; output?: { title?: string; text?: string } });
        return Response.json({ id: 555 });
      }
      if (url.includes("/issues/90/comments") && method === "GET") {
        calls.commentGets += 1;
        return Response.json([]);
      }
      if (url.includes("/issues/90/comments") && method === "POST") {
        calls.commentPatches += 1;
        confirmationBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        return Response.json({ id: 9100 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-override-allow",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 90, title: "Override me", state: "open", user: { login: "contributor" }, pull_request: {} },
        // author_association lies (says OWNER); the handler must IGNORE it and use real permission instead.
        comment: { id: 800, body: "@gittensory gate-override known flaky duplicate check, shipping", author_association: "NONE", user: { login: "maintainer", type: "User" } },
        sender: { login: "maintainer", type: "User" },
      },
    });

    // The existing Gate run (id 555) was PATCHed to a neutral, non-blocking terminal state — not a new check.
    expect(calls.checkPatches).toBe(1);
    const finalize = patchBodies[0];
    expect(finalize?.status).toBe("completed");
    expect(finalize?.conclusion).toBe("neutral");
    expect(finalize?.output?.title).toBe("Gittensory Orb Review Agent — overridden by @maintainer");
    expect(finalize?.output?.text).toContain("Overridden by @maintainer: known flaky duplicate check, shipping");
    expect(confirmationBody).toContain("Gittensory Orb Review Agent overridden by @maintainer");
    const audit = await env.DB.prepare("select event_type, actor, target_key, outcome, detail from audit_events where event_type = ?")
      .bind("github_app.gate_overridden")
      .first<{ event_type: string; actor: string; target_key: string; outcome: string; detail: string }>();
    expect(audit).toMatchObject({ event_type: "github_app.gate_overridden", actor: "maintainer", target_key: "JSONbored/gittensory#90", outcome: "completed" });
    const usageEvents = await listProductUsageEvents(env, { limit: 10 });
    expect(usageEvents).toEqual(expect.arrayContaining([expect.objectContaining({ surface: "github_app", eventName: "gate_overridden", outcome: "completed" })]));
    // No override state is persisted: the gate stays "enabled" and the override does NOT persist an advisory,
    // so a follow-up synchronize re-evaluates the Gate from scratch (no permanent bypass).
    const settingsAfter = await env.DB.prepare("select gate_check_mode from repository_settings where repo_full_name = ?").bind("JSONbored/gittensory").first<{ gate_check_mode: string }>();
    expect(settingsAfter?.gate_check_mode).toBe("enabled");
    const overrideAdvisory = await env.DB.prepare("select id from advisories where target_key = ?").bind("JSONbored/gittensory#90").first<{ id: string }>();
    expect(overrideAdvisory ?? null).toBeNull();
  });

  it("a real gate-override still completes even when the false-positive telemetry write fails (best-effort)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled", reviewCheckMode: "required",
      linkedIssueGateMode: "off",
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 94,
      title: "Override me (telemetry write fails)",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "override-sha-telemetry" },
      labels: [],
      body: "Validation: npm test",
    });
    const telemetrySpy = vi.spyOn(repositoriesModule, "markGateOutcomeOverridden").mockRejectedValueOnce(new Error("D1 write failed"));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
      if (url.includes("/commits/override-sha-telemetry/check-runs") && method === "GET") {
        return Response.json({ total_count: 1, check_runs: [{ id: 559, name: "Gittensory Orb Review Agent" }] });
      }
      if (url.includes("/check-runs/559") && method === "PATCH") return Response.json({ id: 559 });
      if (url.includes("/issues/94/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/94/comments") && method === "POST") return Response.json({ id: 9104 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-override-telemetry-fail",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 94, title: "Override me (telemetry write fails)", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 812, body: "@gittensory gate-override known flaky", author_association: "NONE", user: { login: "maintainer", type: "User" } },
        sender: { login: "maintainer", type: "User" },
      },
    });

    expect(telemetrySpy).toHaveBeenCalled();
    // The override itself (audit + usage) still completed — the false-positive flag is best-effort and never
    // affects the primary override outcome.
    const audit = await env.DB.prepare("select outcome from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.gate_overridden", "JSONbored/gittensory#94")
      .first<{ outcome: string }>();
    expect(audit?.outcome).toBe("completed");
  });

  it("gate-override respects agentPaused — never flips the live check-run or posts a confirmation comment (#2256)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled", reviewCheckMode: "required",
      linkedIssueGateMode: "off",
      agentPaused: true,
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 91,
      title: "Override me while paused",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "paused-override-sha" },
      labels: [],
      body: "Validation: npm test",
    });
    const calls = { checkPatches: 0, commentPosts: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
      if (url.includes("/commits/paused-override-sha/check-runs") && method === "GET") {
        return Response.json({ total_count: 1, check_runs: [{ id: 556, name: "Gittensory Orb Review Agent" }] });
      }
      if (url.includes("/check-runs/556") && method === "PATCH") {
        calls.checkPatches += 1;
        return Response.json({ id: 556 });
      }
      if (url.includes("/issues/91/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/91/comments") && method === "POST") {
        calls.commentPosts += 1;
        return Response.json({ id: 9101 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-override-paused",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 91, title: "Override me while paused", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 810, body: "@gittensory gate-override please", author_association: "NONE", user: { login: "maintainer", type: "User" } },
        sender: { login: "maintainer", type: "User" },
      },
    });

    // Neither write reached GitHub — a pause must stop this exactly like every other agent-driven write.
    expect(calls.checkPatches).toBe(0);
    expect(calls.commentPosts).toBe(0);
    // REGRESSION: a paused command must not be audited/usage-tracked as a real, completed override.
    const overridden = await env.DB.prepare("select id from audit_events where event_type = ?").bind("github_app.gate_overridden").first<{ id: string }>();
    expect(overridden).toBeUndefined();
    const skipped = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.gate_override_skipped").first<{ outcome: string; detail: string }>();
    expect(skipped).toMatchObject({ outcome: "completed", detail: "agent_paused" });
    const usageEvents = await listProductUsageEvents(env, { limit: 10 });
    expect(usageEvents).toEqual(expect.arrayContaining([expect.objectContaining({ eventName: "gate_override_skipped", outcome: "skipped" })]));
    expect(usageEvents.some((event) => event.eventName === "gate_overridden")).toBe(false);
  });

  it("gate-override respects agentDryRun on a PR with no head sha — records dry_run, not agent_paused (#2256)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled", reviewCheckMode: "required",
      linkedIssueGateMode: "off",
      agentDryRun: true,
    });
    // No head sha — also exercises the metadata's `?? null` fallback on the skip-path audit/usage records.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 93,
      title: "Override me (dry-run, no head)",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: {},
      labels: [],
      body: "Validation: npm test",
    });
    const calls = { checkPatches: 0, commentPosts: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
      if (url.includes("/pulls/93") && method === "GET") return Response.json({ number: 93, state: "open", head: {} });
      if (url.includes("/issues/93/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/93/comments") && method === "POST") {
        calls.commentPosts += 1;
        return Response.json({ id: 9103 });
      }
      if (url.includes("/check-runs") && method === "PATCH") {
        calls.checkPatches += 1;
        return Response.json({ id: 557 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-override-dry-run-no-head",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 93, title: "Override me (dry-run, no head)", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 811, body: "@gittensory gate-override please", author_association: "NONE", user: { login: "maintainer", type: "User" } },
        sender: { login: "maintainer", type: "User" },
      },
    });

    expect(calls.checkPatches).toBe(0);
    expect(calls.commentPosts).toBe(0);
    const skipped = await env.DB.prepare("select outcome, detail, metadata_json from audit_events where event_type = ?")
      .bind("github_app.gate_override_skipped")
      .first<{ outcome: string; detail: string; metadata_json: string }>();
    expect(skipped).toMatchObject({ outcome: "completed", detail: "dry_run" });
    const metadata = JSON.parse(skipped?.metadata_json ?? "{}") as { headSha?: string | null; cachedHeadSha?: string | null; mode?: string };
    expect(metadata.headSha).toBeNull();
    expect(metadata.cachedHeadSha).toBeNull();
    expect(metadata.mode).toBe("dry_run");
    const usageEvents = await listProductUsageEvents(env, { limit: 10 });
    expect(usageEvents).toEqual(expect.arrayContaining([expect.objectContaining({ eventName: "gate_override_skipped", outcome: "skipped" })]));
  });

  it("overrides the LIVE head, not the stale cached SHA, when a commit landed after the command (#16)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled", reviewCheckMode: "required",
      linkedIssueGateMode: "off",
    });
    // The stored row still carries the OLD head; a new commit ("live-sha") landed between the comment and now.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 90,
      title: "Override me",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "stale-sha" },
      labels: [],
      body: "Validation: npm test",
    });
    const seen = { staleCheckGets: 0, liveCheckGets: 0, liveLegacyCheckGets: 0 };
    const patchBodies: Array<{ conclusion?: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
      // The LIVE head re-fetch — the row says stale-sha but GitHub's head is now live-sha.
      if (url.includes("/pulls/90") && method === "GET") return Response.json({ number: 90, state: "open", head: { sha: "live-sha" } });
      if (url.includes("/commits/stale-sha/check-runs") && method === "GET") {
        seen.staleCheckGets += 1;
        return Response.json({ total_count: 0, check_runs: [] });
      }
      if (url.includes("/commits/live-sha/check-runs") && method === "GET") {
        const checkName = new URL(url).searchParams.get("check_name");
        if (checkName === "Gittensory Gate") {
          seen.liveLegacyCheckGets += 1;
          return Response.json({ total_count: 0, check_runs: [] });
        }
        seen.liveCheckGets += 1;
        return Response.json({ total_count: 1, check_runs: [{ id: 556, name: "Gittensory Orb Review Agent" }] });
      }
      if (url.includes("/check-runs/556") && method === "PATCH") {
        patchBodies.push(JSON.parse(String(init?.body ?? "{}")) as { conclusion?: string });
        return Response.json({ id: 556 });
      }
      if (url.includes("/issues/90/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/90/comments") && method === "POST") return Response.json({ id: 9101 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-override-live-head",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 90, title: "Override me", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 803, body: "@gittensory gate-override flaky", author_association: "NONE", user: { login: "maintainer", type: "User" } },
        sender: { login: "maintainer", type: "User" },
      },
    });

    // The neutral PATCH targeted the LIVE head's Gate run (id 556), and the stale SHA was never touched.
    expect(seen.liveCheckGets).toBe(1);
    expect(seen.liveLegacyCheckGets).toBe(1);
    expect(seen.staleCheckGets).toBe(0);
    expect(patchBodies[0]?.conclusion).toBe("neutral");
    const audit = await env.DB.prepare("select metadata_json from audit_events where event_type = ?")
      .bind("github_app.gate_overridden")
      .first<{ metadata_json: string }>();
    const metadata = JSON.parse(audit?.metadata_json ?? "{}") as { headSha?: string; cachedHeadSha?: string };
    expect(metadata.headSha).toBe("live-sha");
    expect(metadata.cachedHeadSha).toBe("stale-sha");
  });

  it("records null head SHAs in the override audit when the PR head is unresolved (#16 fail-safe)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled", reviewCheckMode: "required",
      linkedIssueGateMode: "off",
    });
    // A cached row with no head SHA (never detail-synced); the live fetch also yields no head.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 90,
      title: "Override me",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: {},
      labels: [],
      body: "Validation: npm test",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
      if (url.includes("/pulls/90") && method === "GET") return Response.json({ number: 90, state: "open", head: {} });
      if (url.includes("/issues/90/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/90/comments") && method === "POST") return Response.json({ id: 9102 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-override-null-head",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 90, title: "Override me", state: "open", user: { login: "contributor" }, pull_request: {} },
        // No reason after the command — exercises the "No reason provided." fallback too.
        comment: { id: 804, body: "@gittensory gate-override", author_association: "NONE", user: { login: "maintainer", type: "User" } },
        sender: { login: "maintainer", type: "User" },
      },
    });

    const audit = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = ?")
      .bind("github_app.gate_overridden")
      .first<{ detail: string; metadata_json: string }>();
    expect(audit?.detail).toBe("No reason provided.");
    const metadata = JSON.parse(audit?.metadata_json ?? "{}") as { headSha?: string | null; cachedHeadSha?: string | null };
    expect(metadata.headSha).toBeNull();
    expect(metadata.cachedHeadSha).toBeNull();
  });

  it("ignores gate-override commands on edited comments", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled", reviewCheckMode: "required",
      linkedIssueGateMode: "off",
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 92,
      title: "Edited override",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "edited-override" },
      labels: [],
      body: "Validation: npm test",
    });
    const calls = { token: 0, permission: 0, checkRuns: 0, comments: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      if (url.includes("/collaborators/")) {
        calls.permission += 1;
        return Response.json({ permission: "admin" });
      }
      if (url.includes("/check-runs")) {
        calls.checkRuns += 1;
        return Response.json({ total_count: 1, check_runs: [{ id: 556, name: "Gittensory Orb Review Agent" }] });
      }
      if (url.includes("/comments")) {
        calls.comments += 1;
        return Response.json([]);
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-override-edited",
      eventName: "issue_comment",
      payload: {
        action: "edited",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 92, title: "Edited override", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 802, body: "@gittensory gate-override edited by moderator", author_association: "OWNER", user: { login: "maintainer", type: "User" } },
        sender: { login: "moderator", type: "User" },
      },
    });

    expect(calls.permission).toBe(0);
    expect(calls.checkRuns).toBe(0);
    expect(calls.comments).toBe(0);
    const overridden = await env.DB.prepare("select id from audit_events where event_type = ?").bind("github_app.gate_overridden").first<{ id: string }>();
    expect(overridden ?? null).toBeNull();
    const skipped = await env.DB.prepare("select actor, detail from audit_events where event_type = ?").bind("github_app.gate_override_skipped").first<{ actor: string; detail: string }>();
    expect(skipped).toMatchObject({ actor: "moderator", detail: "unsupported_comment_action" });
  });

  it("denies gate-override from an org member without real repository write/admin (ignores author_association)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      gateCheckMode: "enabled", reviewCheckMode: "required",
      linkedIssueGateMode: "off",
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 91,
      title: "Cannot override",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "override-denied" },
      labels: [],
      body: "Validation: npm test",
    });
    const calls = { token: 0, permission: 0, checkGets: 0, checkPatches: 0, comments: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) {
        calls.token += 1;
        return Response.json({ token: "installation-token" });
      }
      // Real permission is only "read" — even though the comment claims MEMBER, the Gate must NOT be touched.
      if (url.includes("/collaborators/org-member/permission")) {
        calls.permission += 1;
        return Response.json({ permission: "read" });
      }
      if (url.includes("/check-runs")) {
        calls.checkGets += 1;
        return new Response("not found", { status: 404 });
      }
      if (url.includes("/comments")) {
        calls.comments += 1;
        return Response.json([]);
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-override-deny",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 91, title: "Cannot override", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: 801, body: "@gittensory gate-override trust me", author_association: "MEMBER", user: { login: "org-member", type: "User" } },
        sender: { login: "org-member", type: "User" },
      },
    });

    // Authorization denied via real permission: no Gate check call and no comment were made.
    expect(calls.permission).toBe(1);
    expect(calls.checkGets).toBe(0);
    expect(calls.checkPatches).toBe(0);
    expect(calls.comments).toBe(0);
    const denied = await env.DB.prepare("select event_type, actor, target_key, outcome, detail from audit_events where event_type = ?")
      .bind("github_app.gate_override_denied")
      .first<{ event_type: string; actor: string; target_key: string; outcome: string; detail: string }>();
    expect(denied).toMatchObject({ event_type: "github_app.gate_override_denied", actor: "org-member", target_key: "JSONbored/gittensory#91", outcome: "denied", detail: "not_maintainer_or_pr_author" });
    const overridden = await env.DB.prepare("select id from audit_events where event_type = ?").bind("github_app.gate_overridden").first<{ id: string }>();
    expect(overridden ?? null).toBeNull();
  });

  // #1964 (record slice): `@gittensory resolve` records review-memory suppression signals for advisory warnings.
  describe("@gittensory resolve (#1964)", () => {
    async function seedResolvePr(env: Env, repoFullName: string, prNumber: number, headSha: string) {
      const slash = repoFullName.indexOf("/");
      const owner = slash >= 0 ? repoFullName.slice(0, slash) : repoFullName;
      const name = slash >= 0 ? repoFullName.slice(slash + 1) : repoFullName;
      await upsertRepositoryFromGitHub(env, { name, full_name: repoFullName, private: false, owner: { login: owner } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName,
        commentMode: "off",
        publicSurface: "off",
        autoLabelEnabled: false,
        checkRunMode: "off",
        gateCheckMode: "enabled", reviewCheckMode: "required",
        requireLinkedIssue: true,
        linkedIssueGateMode: "advisory",
        aiReviewMode: "advisory",
      });
      await upsertPullRequestFromGitHub(env, repoFullName, {
        number: prNumber,
        title: "Resolve me",
        state: "open",
        user: { login: "contributor" },
        author_association: "CONTRIBUTOR",
        head: { sha: headSha },
        labels: [],
        body: "No linked issue on purpose",
      });
    }

    it("records a suppression signal and finding_resolved when an authorized maintainer resolves a named warning with review.memory ON", async () => {
      const repoFullName = "JSONbored/resolve-1964-a";
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        GITTENSORY_REVIEW_MEMORY: "true",
      });
      await seedResolvePr(env, repoFullName, 1964, "resolve-1964-a");
      await upsertRepoFocusManifest(env, repoFullName, { review: { memory: true } });
      const calls = { permission: 0, checkPatches: 0, comments: 0 };
      let confirmationBody = "";
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) {
          calls.permission += 1;
          return Response.json({ permission: "admin" });
        }
        if (url.includes("/issues/1964/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/1964/comments") && method === "POST") {
          calls.comments += 1;
          confirmationBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          return Response.json({ id: 19641 });
        }
        if (url.includes("/check-runs") && method === "PATCH") {
          calls.checkPatches += 1;
          return Response.json({ id: 1 });
        }
        return new Response("not found", { status: 404 });
      });

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "resolve-1964-allow",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "resolve-1964-a", full_name: repoFullName, private: false, owner: { login: "JSONbored" } },
          issue: { number: 1964, title: "Resolve me", state: "open", user: { login: "contributor" }, pull_request: {} },
          comment: {
            id: 19640,
            body: "@gittensory resolve missing_linked_issue",
            author_association: "NONE",
            user: { login: "maintainer", type: "User" },
          },
          sender: { login: "maintainer", type: "User" },
        },
      });

      expect(calls.permission).toBe(1);
      expect(calls.checkPatches).toBe(0);
      expect(calls.comments).toBe(1);
      expect(confirmationBody).toContain("Review finding resolved");
      expect(confirmationBody).toContain("missing_linked_issue");
      expect(confirmationBody).toContain("Gate check-run is unchanged");
      const resolved = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?")
        .bind("github_app.finding_resolved")
        .first<{ outcome: string; detail: string }>();
      expect(resolved).toMatchObject({ outcome: "completed" });
      const memoryRecorded = await env.DB.prepare("select outcome from audit_events where event_type = ?")
        .bind("github_app.review_memory_recorded")
        .first<{ outcome: string }>();
      expect(memoryRecorded).toMatchObject({ outcome: "completed" });
      const suppressions = await listReviewSuppressions(env, repoFullName);
      expect(suppressions).toHaveLength(1);
      expect(suppressions[0]).toMatchObject({
        category: "missing_linked_issue",
        createdBy: "maintainer",
      });
    });

    it("records a suppression for a current cached AI review warning", async () => {
      const repoFullName = "JSONbored/resolve-1964-ai-cached";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_MEMORY: "true" });
      await seedResolvePr(env, repoFullName, 1974, "resolve-1964-ai-cached");
      await upsertRepoFocusManifest(env, repoFullName, { review: { memory: true } });
      await putCachedAiReview(env, repoFullName, 1974, "resolve-1964-ai-cached", "advisory", {
        notes: "The cached AI review found a public issue.",
        reviewerCount: 2,
        findings: [{ code: "ai_review_split", severity: "warning", title: "AI reviewers disagree", detail: "One reviewer flagged a likely defect that needs maintainer triage." }],
      });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("/issues/1974/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/1974/comments") && method === "POST") return Response.json({ id: 19741 });
        return new Response("not found", { status: 404 });
      });

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "resolve-1974-ai-cached",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "resolve-1964-ai-cached", full_name: repoFullName, private: false, owner: { login: "JSONbored" } },
          issue: { number: 1974, title: "Resolve me", state: "open", user: { login: "contributor" }, pull_request: {} },
          comment: { id: 19740, body: "@gittensory resolve ai_review_split", author_association: "NONE", user: { login: "maintainer", type: "User" } },
          sender: { login: "maintainer", type: "User" },
        },
      });

      const suppressions = await listReviewSuppressions(env, repoFullName);
      expect(suppressions).toHaveLength(1);
      expect(suppressions[0]).toMatchObject({ category: "ai_review_split", createdBy: "maintainer" });
      const resolved = await env.DB.prepare("select metadata_json from audit_events where event_type = ?")
        .bind("github_app.finding_resolved")
        .first<{ metadata_json: string }>();
      expect(JSON.parse(resolved?.metadata_json ?? "{}")).toMatchObject({ findingCode: "ai_review_split", resolvedWarningCount: 1, recordedSuppressionCount: 1 });
    });

    it("falls back to the last published public AI review when the current cached review has no public assessment", async () => {
      const repoFullName = "JSONbored/resolve-1964-ai-published";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_MEMORY: "true" });
      await seedResolvePr(env, repoFullName, 1975, "resolve-1964-ai-current");
      await upsertRepoFocusManifest(env, repoFullName, { review: { memory: true } });
      await putCachedAiReview(env, repoFullName, 1975, "resolve-1964-ai-old", "advisory", {
        notes: "The published AI review found a public consensus defect.",
        reviewerCount: 2,
        findings: [{ code: "ai_consensus_defect", severity: "warning", title: "AI reviewers agree on a defect", detail: "Both reviewers flagged the same likely defect for maintainer triage." }],
      });
      await markAiReviewPublished(env, repoFullName, 1975, "resolve-1964-ai-old");
      await putCachedAiReview(env, repoFullName, 1975, "resolve-1964-ai-current", "advisory", {
        notes: "",
        reviewerCount: 2,
        findings: [{ code: "ai_review_split", severity: "warning", title: "Hidden", detail: "No public assessment." }],
      });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("/issues/1975/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/1975/comments") && method === "POST") return Response.json({ id: 19751 });
        return new Response("not found", { status: 404 });
      });

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "resolve-1975-ai-published",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "resolve-1964-ai-published", full_name: repoFullName, private: false, owner: { login: "JSONbored" } },
          issue: { number: 1975, title: "Resolve me", state: "open", user: { login: "contributor" }, pull_request: {} },
          comment: { id: 19750, body: "@gittensory resolve ai_consensus_defect", author_association: "NONE", user: { login: "maintainer", type: "User" } },
          sender: { login: "maintainer", type: "User" },
        },
      });

      const suppressions = await listReviewSuppressions(env, repoFullName);
      expect(suppressions).toHaveLength(1);
      expect(suppressions[0]?.category).toBe("ai_consensus_defect");
    });

    it("records finding_resolved without a suppression write when review.memory is OFF (operator kill-switch)", async () => {
      const repoFullName = "JSONbored/resolve-1965-off";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedResolvePr(env, repoFullName, 1965, "resolve-1965-off");
      await upsertRepoFocusManifest(env, repoFullName, { review: { memory: true } });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("/issues/1965/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/1965/comments") && method === "POST") return Response.json({ id: 19651 });
        return new Response("not found", { status: 404 });
      });

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "resolve-1965-flag-off",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "resolve-1965-off", full_name: repoFullName, private: false, owner: { login: "JSONbored" } },
          issue: { number: 1965, title: "Resolve me", state: "open", user: { login: "contributor" }, pull_request: {} },
          comment: {
            id: 19650,
            body: "@gittensory resolve missing_linked_issue",
            author_association: "NONE",
            user: { login: "maintainer", type: "User" },
          },
          sender: { login: "maintainer", type: "User" },
        },
      });

      const memoryRecorded = await env.DB.prepare("select id from audit_events where event_type = ?")
        .bind("github_app.review_memory_recorded")
        .first<{ id: string }>();
      expect(memoryRecorded ?? null).toBeNull();
      expect(await listReviewSuppressions(env, repoFullName)).toHaveLength(0);
      const resolved = await env.DB.prepare("select outcome from audit_events where event_type = ?")
        .bind("github_app.finding_resolved")
        .first<{ outcome: string }>();
      expect(resolved).toMatchObject({ outcome: "completed" });
    });

    it("denies an unauthorized actor and records no suppression signal", async () => {
      const repoFullName = "JSONbored/resolve-1966-deny";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_MEMORY: "true" });
      await seedResolvePr(env, repoFullName, 1966, "resolve-1966-deny");
      await upsertRepoFocusManifest(env, repoFullName, { review: { memory: true } });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/org-member/permission")) return Response.json({ permission: "read" });
        return new Response("not found", { status: 404 });
      });

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "resolve-1966-deny",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "resolve-1966-deny", full_name: repoFullName, private: false, owner: { login: "JSONbored" } },
          issue: { number: 1966, title: "Resolve me", state: "open", user: { login: "contributor" }, pull_request: {} },
          comment: {
            id: 19660,
            body: "@gittensory resolve missing_linked_issue",
            author_association: "MEMBER",
            user: { login: "org-member", type: "User" },
          },
          sender: { login: "org-member", type: "User" },
        },
      });

      const denied = await env.DB.prepare("select outcome from audit_events where event_type = ?")
        .bind("github_app.finding_resolved_denied")
        .first<{ outcome: string }>();
      expect(denied).toMatchObject({ outcome: "denied" });
      expect(await listReviewSuppressions(env, repoFullName)).toHaveLength(0);
    });

    it.each([
      ["malformed finding id", "@gittensory resolve ../escape", "malformed_finding_id"],
      ["absent finding code", "@gittensory resolve readiness_score_below_threshold", "finding_not_found"],
    ] as const)("skips resolve when the maintainer supplies %s", async (_label, body, reason) => {
      const repoFullName = "JSONbored/resolve-1967-skip";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_MEMORY: "true" });
      await seedResolvePr(env, repoFullName, 1967, "resolve-1967-skip");
      await upsertRepoFocusManifest(env, repoFullName, { review: { memory: true } });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        return new Response("not found", { status: 404 });
      });

      await processJob(env, {
        type: "github-webhook",
        deliveryId: `resolve-1967-${reason}`,
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "resolve-1967-skip", full_name: repoFullName, private: false, owner: { login: "JSONbored" } },
          issue: { number: 1967, title: "Resolve me", state: "open", user: { login: "contributor" }, pull_request: {} },
          comment: { id: 19670, body, author_association: "NONE", user: { login: "maintainer", type: "User" } },
          sender: { login: "maintainer", type: "User" },
        },
      });

      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?")
        .bind("github_app.finding_resolved_skipped")
        .first<{ detail: string }>();
      expect(skipped?.detail).toBe(reason);
      expect(await listReviewSuppressions(env, repoFullName)).toHaveLength(0);
    });

    it("records every current advisory warning for a whole-PR `@gittensory resolve` ack", async () => {
      const repoFullName = "JSONbored/resolve-1968-whole";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_MEMORY: "true" });
      await seedResolvePr(env, repoFullName, 1968, "resolve-1968-whole");
      await upsertRepoFocusManifest(env, repoFullName, { review: { memory: true } });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("/issues/1968/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/1968/comments") && method === "POST") return Response.json({ id: 19681 });
        return new Response("not found", { status: 404 });
      });

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "resolve-1968-whole",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "resolve-1968-whole", full_name: repoFullName, private: false, owner: { login: "JSONbored" } },
          issue: { number: 1968, title: "Resolve me", state: "open", user: { login: "contributor" }, pull_request: {} },
          comment: { id: 19680, body: "@gittensory resolve", author_association: "NONE", user: { login: "maintainer", type: "User" } },
          sender: { login: "maintainer", type: "User" },
        },
      });

      expect(await listReviewSuppressions(env, repoFullName)).toHaveLength(2);
      const resolved = await env.DB.prepare("select metadata_json from audit_events where event_type = ?")
        .bind("github_app.finding_resolved")
        .first<{ metadata_json: string }>();
      expect(JSON.parse(resolved?.metadata_json ?? "{}")).toMatchObject({ scope: "whole_pr", resolvedWarningCount: 2 });
    });

    it("ignores issue comments that are not @gittensory resolve commands (#1964)", async () => {
      const repoFullName = "JSONbored/resolve-1973-plain";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedResolvePr(env, repoFullName, 1973, "resolve-1973-plain");
      let commentPosts = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/issues/1973/comments") && method === "POST") {
          commentPosts += 1;
          return Response.json({ id: 19730 });
        }
        return new Response("not found", { status: 404 });
      });
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "resolve-plain-comment",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "resolve-1973-plain", full_name: repoFullName, private: false, owner: { login: "JSONbored" } },
          issue: { number: 1973, title: "Resolve me", state: "open", user: { login: "contributor" }, pull_request: {} },
          comment: { id: 19731, body: "Looks good to me", author_association: "OWNER", user: { login: "maintainer", type: "User" } },
          sender: { login: "maintainer", type: "User" },
        },
      });
      expect(commentPosts).toBe(0);
      const events = await env.DB.prepare("select event_type from audit_events where event_type like ?").bind("github_app.finding_resolved%").all<{ event_type: string }>();
      expect(events.results ?? []).toEqual([]);
    });

    it("ignores other @gittensory verbs on the resolve handler path (#1964)", async () => {
      const repoFullName = "JSONbored/resolve-1974-help";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedResolvePr(env, repoFullName, 1974, "resolve-1974-help");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (input.toString().includes("/access_tokens")) return Response.json({ token: "installation-token" });
        return new Response("not found", { status: 404 });
      });
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "resolve-help-verb",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "resolve-1974-help", full_name: repoFullName, private: false, owner: { login: "JSONbored" } },
          issue: { number: 1974, title: "Resolve me", state: "open", user: { login: "contributor" }, pull_request: {} },
          comment: { id: 19740, body: "@gittensory help", author_association: "OWNER", user: { login: "maintainer", type: "User" } },
          sender: { login: "maintainer", type: "User" },
        },
      });
      const events = await env.DB.prepare("select event_type from audit_events where event_type like ?").bind("github_app.finding_resolved%").all<{ event_type: string }>();
      expect(events.results ?? []).toEqual([]);
    });

    it("skips resolve when the webhook payload lacks a repository (#1964)", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (input.toString().includes("/access_tokens")) return Response.json({ token: "installation-token" });
        return new Response("not found", { status: 404 });
      });
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "resolve-missing-repo",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          issue: { number: 1972, title: "Resolve me", state: "open", user: { login: "contributor" }, pull_request: {} },
          comment: { id: 19720, body: "@gittensory resolve missing_linked_issue", author_association: "NONE", user: { login: "maintainer", type: "User" } },
          sender: { login: "maintainer", type: "User" },
        },
      });
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.finding_resolved_skipped").first<{ detail: string }>();
      expect(skipped?.detail).toBe("missing_repo_pr_installation_or_actor");
    });

    it("skips resolve when the cached pull request row is missing (#1964)", async () => {
      const repoFullName = "JSONbored/resolve-1969-missing-pr";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_MEMORY: "true" });
      const slash = repoFullName.indexOf("/");
      await upsertRepositoryFromGitHub(env, { name: repoFullName.slice(slash + 1), full_name: repoFullName, private: false, owner: { login: repoFullName.slice(0, slash) } }, 123);
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (input.toString().includes("/access_tokens")) return Response.json({ token: "installation-token" });
        return new Response("not found", { status: 404 });
      });
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "resolve-1969-missing-pr",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "resolve-1969-missing-pr", full_name: repoFullName, private: false, owner: { login: "JSONbored" } },
          issue: { number: 1969, title: "Resolve me", state: "open", user: { login: "contributor" }, pull_request: {} },
          comment: { id: 19690, body: "@gittensory resolve missing_linked_issue", author_association: "NONE", user: { login: "maintainer", type: "User" } },
          sender: { login: "maintainer", type: "User" },
        },
      });
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.finding_resolved_skipped").first<{ detail: string }>();
      expect(skipped?.detail).toBe("cached_pr_missing");
    });

    it("skips resolve in agentDryRun without recording finding_resolved (#1964)", async () => {
      const repoFullName = "JSONbored/resolve-1970-dry-run";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_MEMORY: "true" });
      await seedResolvePr(env, repoFullName, 1970, "resolve-1970-dry-run");
      await upsertRepositorySettings(env, { repoFullName, commentMode: "off", publicSurface: "off", autoLabelEnabled: false, checkRunMode: "off", gateCheckMode: "enabled", reviewCheckMode: "required", requireLinkedIssue: true, linkedIssueGateMode: "advisory", agentDryRun: true });
      await upsertRepoFocusManifest(env, repoFullName, { review: { memory: true } });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        return new Response("not found", { status: 404 });
      });
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "resolve-1970-dry-run",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "resolve-1970-dry-run", full_name: repoFullName, private: false, owner: { login: "JSONbored" } },
          issue: { number: 1970, title: "Resolve me", state: "open", user: { login: "contributor" }, pull_request: {} },
          comment: { id: 19700, body: "@gittensory resolve missing_linked_issue", author_association: "NONE", user: { login: "maintainer", type: "User" } },
          sender: { login: "maintainer", type: "User" },
        },
      });
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.finding_resolved_skipped").first<{ detail: string }>();
      expect(skipped?.detail).toBe("dry_run");
      const resolved = await env.DB.prepare("select id from audit_events where event_type = ?").bind("github_app.finding_resolved").first<{ id: string }>();
      expect(resolved ?? null).toBeNull();
    });

    it("skips resolve when the repository is agentPaused (#1964)", async () => {
      const repoFullName = "JSONbored/resolve-1971-paused";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_MEMORY: "true" });
      await seedResolvePr(env, repoFullName, 1971, "resolve-1971-paused");
      await upsertRepositorySettings(env, { repoFullName, commentMode: "off", publicSurface: "off", autoLabelEnabled: false, checkRunMode: "off", gateCheckMode: "enabled", reviewCheckMode: "required", requireLinkedIssue: true, linkedIssueGateMode: "advisory", agentPaused: true });
      await upsertRepoFocusManifest(env, repoFullName, { review: { memory: true } });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        return new Response("not found", { status: 404 });
      });
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "resolve-1971-paused",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "resolve-1971-paused", full_name: repoFullName, private: false, owner: { login: "JSONbored" } },
          issue: { number: 1971, title: "Resolve me", state: "open", user: { login: "contributor" }, pull_request: {} },
          comment: { id: 19710, body: "@gittensory resolve missing_linked_issue", author_association: "NONE", user: { login: "maintainer", type: "User" } },
          sender: { login: "maintainer", type: "User" },
        },
      });
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.finding_resolved_skipped").first<{ detail: string }>();
      expect(skipped?.detail).toBe("agent_paused");
    });
  });

  // #2169 (part of #1960): `@gittensory explain <finding>` echoes an already-generated finding's public-safe
  // rationale on the PR thread — read-only, no model call, no mutation. Mirrors the `resolve` harness above.
  describe("@gittensory explain (#2169)", () => {
    async function seedExplainPr(env: Env, repoFullName: string, prNumber: number, headSha: string) {
      const slash = repoFullName.indexOf("/");
      const owner = repoFullName.slice(0, slash);
      const name = repoFullName.slice(slash + 1);
      await upsertRepositoryFromGitHub(env, { name, full_name: repoFullName, private: false, owner: { login: owner } }, 123);
      await upsertRepositorySettings(env, { repoFullName, commentMode: "off", publicSurface: "off", autoLabelEnabled: false, checkRunMode: "off", gateCheckMode: "enabled", reviewCheckMode: "required", requireLinkedIssue: true, linkedIssueGateMode: "advisory", aiReviewMode: "advisory" });
      await upsertPullRequestFromGitHub(env, repoFullName, { number: prNumber, title: "Explain me", state: "open", user: { login: "contributor" }, author_association: "CONTRIBUTOR", head: { sha: headSha }, labels: [], body: "No linked issue on purpose" });
    }
    const explainWebhook = (repoFullName: string, prNumber: number, body: string, actor: string, opts: { association?: string; bot?: boolean; action?: string } = {}) => ({
      type: "github-webhook" as const,
      deliveryId: `explain-${prNumber}-${actor}`,
      eventName: "issue_comment" as const,
      payload: {
        action: opts.action ?? "created",
        installation: { id: 123, account: { login: repoFullName.slice(0, repoFullName.indexOf("/")), id: 1, type: "User" } },
        repository: { name: repoFullName.slice(repoFullName.indexOf("/") + 1), full_name: repoFullName, private: false, owner: { login: repoFullName.slice(0, repoFullName.indexOf("/")) } },
        issue: { number: prNumber, title: "Explain me", state: "open", user: { login: "contributor" }, pull_request: {} },
        comment: { id: prNumber * 10, body, author_association: opts.association ?? "NONE", user: { login: actor, type: opts.bot ? "Bot" : "User" } },
        sender: { login: actor, type: opts.bot ? "Bot" : "User" },
      },
    }) as unknown as Parameters<typeof processJob>[1];

    it("echoes a named finding's stored rationale to an authorized maintainer + records finding_explained (no mutation)", async () => {
      const repoFullName = "JSONbored/explain-2169-echo";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedExplainPr(env, repoFullName, 2169, "explain-2169-echo");
      await putCachedAiReview(env, repoFullName, 2169, "explain-2169-echo", "advisory", {
        notes: "The cached AI review found a public issue.",
        reviewerCount: 2,
        findings: [{ code: "ai_review_split", severity: "warning", title: "AI reviewers disagree", detail: "One reviewer flagged a likely defect that needs maintainer triage." }],
      });
      let postedBody = "";
      const calls = { comments: 0, checkPatches: 0 };
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("/issues/2169/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/2169/comments") && method === "POST") { calls.comments += 1; postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""); return Response.json({ id: 21690 }); }
        if (url.includes("/check-runs") && method === "PATCH") { calls.checkPatches += 1; return Response.json({ id: 1 }); }
        return new Response("not found", { status: 404 });
      });

      await processJob(env, explainWebhook(repoFullName, 2169, "@gittensory explain ai_review_split", "maintainer"));

      expect(calls.comments).toBe(1);
      expect(calls.checkPatches).toBe(0); // read-only: never touches the gate check-run
      expect(postedBody).toContain("Explanation of `ai_review_split`");
      expect(postedBody).toContain("AI reviewers disagree"); // the finding's stored title
      expect(postedBody).toContain("One reviewer flagged a likely defect"); // its stored rationale, echoed verbatim
      const explained = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("github_app.finding_explained").first<{ outcome: string; metadata_json: string }>();
      expect(explained?.outcome).toBe("completed");
      expect(JSON.parse(explained?.metadata_json ?? "{}")).toMatchObject({ findingCode: "ai_review_split", explainedCount: 1 });
    });

    it("echoes a deterministic finding's rationale AND its suggested action", async () => {
      const repoFullName = "JSONbored/explain-2169-action";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      // seedExplainPr sets requireLinkedIssue + a body with no linked issue, so the gate yields the deterministic
      // `missing_linked_issue` warning, which carries a `detail` AND an `action` (src/rules/advisory.ts).
      await seedExplainPr(env, repoFullName, 2176, "explain-2169-action");
      let postedBody = "";
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("/issues/2176/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/2176/comments") && method === "POST") { postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""); return Response.json({ id: 21760 }); }
        return new Response("not found", { status: 404 });
      });

      await processJob(env, explainWebhook(repoFullName, 2176, "@gittensory explain missing_linked_issue", "maintainer"));

      expect(postedBody).toContain("No linked issue detected"); // title
      expect(postedBody).toContain("Suggested action:"); // the finding's action is rendered
      expect(postedBody).toContain("link it explicitly in the PR body"); // the action text, echoed
      const explained = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.finding_explained").first<{ outcome: string }>();
      expect(explained?.outcome).toBe("completed");
    });

    it("posts a public-safe not-found note when the finding id is unknown", async () => {
      const repoFullName = "JSONbored/explain-2169-missing";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedExplainPr(env, repoFullName, 2170, "explain-2169-missing");
      let postedBody = "";
      let posted = false;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("/issues/2170/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/2170/comments") && method === "POST") { posted = true; postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""); return Response.json({ id: 21700 }); }
        return new Response("not found", { status: 404 });
      });

      await processJob(env, explainWebhook(repoFullName, 2170, "@gittensory explain readiness_score_below_threshold", "maintainer"));

      expect(posted).toBe(true);
      expect(postedBody).toContain("No review finding `readiness_score_below_threshold`");
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.finding_explained_skipped").first<{ detail: string }>();
      expect(skipped?.detail).toBe("finding_not_found");
    });

    it.each([
      ["missing argument", "@gittensory explain", "missing_finding_argument"],
      ["malformed finding id", "@gittensory explain ../escape", "malformed_finding_id"],
    ] as const)("skips (no comment) when the maintainer supplies %s", async (_label, body, reason) => {
      const repoFullName = "JSONbored/explain-2169-skip";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedExplainPr(env, repoFullName, 2171, "explain-2169-skip");
      let posted = false;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("/comments") && method === "POST") { posted = true; return Response.json({ id: 1 }); }
        return new Response("not found", { status: 404 });
      });

      await processJob(env, explainWebhook(repoFullName, 2171, body, "maintainer"));

      expect(posted).toBe(false);
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.finding_explained_skipped").first<{ detail: string }>();
      expect(skipped?.detail).toBe(reason);
    });

    it("denies a non-maintainer — no explanation posted, records finding_explained_denied", async () => {
      const repoFullName = "JSONbored/explain-2169-deny";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedExplainPr(env, repoFullName, 2172, "explain-2169-deny");
      let posted = false;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/org-member/permission")) return Response.json({ permission: "read" });
        if (url.includes("/comments")) { posted = true; return Response.json({ id: 1 }); }
        return new Response("not found", { status: 404 });
      });

      await processJob(env, explainWebhook(repoFullName, 2172, "@gittensory explain ai_review_split", "org-member", { association: "MEMBER" }));

      expect(posted).toBe(false);
      const denied = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.finding_explained_denied").first<{ outcome: string }>();
      expect(denied).toMatchObject({ outcome: "denied" });
    });

    it("records a classifier skip for a bot-authored explain command, never acting on it", async () => {
      const repoFullName = "JSONbored/explain-2169-bot";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedExplainPr(env, repoFullName, 2173, "explain-2169-bot");
      let posted = false;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (input.toString().includes("/comments")) posted = true;
        return new Response("not found", { status: 404 });
      });

      await processJob(env, explainWebhook(repoFullName, 2173, "@gittensory explain ai_review_split", "some-bot[bot]", { bot: true }));

      expect(posted).toBe(false);
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.finding_explained_skipped").first<{ detail: string }>();
      expect(skipped?.detail).toBe("bot_author");
    });

    it("skips with cached_pr_missing when the referenced PR is not in the local store", async () => {
      const repoFullName = "JSONbored/explain-2169-nopr";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      // Register the repo + settings but NOT the PR row, so getPullRequest returns null.
      await upsertRepositoryFromGitHub(env, { name: "explain-2169-nopr", full_name: repoFullName, private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, { repoFullName, gateCheckMode: "enabled", reviewCheckMode: "required", aiReviewMode: "advisory" });
      let posted = false;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (input.toString().includes("/comments")) posted = true;
        return new Response("not found", { status: 404 });
      });

      await processJob(env, explainWebhook(repoFullName, 2174, "@gittensory explain ai_review_split", "maintainer"));

      expect(posted).toBe(false);
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.finding_explained_skipped").first<{ detail: string }>();
      expect(skipped?.detail).toBe("cached_pr_missing");
    });

    it("declines (returns false) for a non-explain comment and for a plain non-mention comment", async () => {
      const repoFullName = "JSONbored/explain-2169-decline";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedExplainPr(env, repoFullName, 2175, "explain-2169-decline");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("/issues/2175/comments") && !url.includes("POST")) return Response.json([]);
        return new Response("not found", { status: 404 });
      });

      await processJob(env, explainWebhook(repoFullName, 2175, "just a normal comment, no mention", "maintainer"));
      await processJob(env, explainWebhook(repoFullName, 2175, "@gittensory configuration", "maintainer"));

      // The explain handler never claimed either comment — no explain audit rows at all.
      const explainRows = await env.DB.prepare("select count(*) as n from audit_events where event_type like 'github_app.finding_explained%'").first<{ n: number }>();
      expect(explainRows?.n).toBe(0);
    });
  });

  // #4195 (part of the #4189 E2E-test-generation epic): `@gittensory generate-tests` -- on-demand,
  // MAINTAINER-ONLY AI-generated E2E test coverage, posted as its own reply comment. Mirrors the explain
  // harness above (classify -> authorize -> act -> audit), but with the authorization tier deliberately
  // narrowed to ["maintainer"] only -- no collaborator, no confirmed_miner -- and a real (mocked) model call.
  describe("@gittensory generate-tests (#4195)", () => {
    async function seedGenerateTestsPr(
      env: Env,
      repoFullName: string,
      prNumber: number,
      headSha: string,
      authorLogin = "contributor",
      opts: { headRef?: string; e2eTestDelivery?: "comment" | "commit" } = {},
    ) {
      const slash = repoFullName.indexOf("/");
      const owner = repoFullName.slice(0, slash);
      const name = repoFullName.slice(slash + 1);
      await upsertRepositoryFromGitHub(env, { name, full_name: repoFullName, private: false, owner: { login: owner } }, 123);
      await upsertRepositorySettings(env, { repoFullName, commentMode: "off", publicSurface: "off", autoLabelEnabled: false, checkRunMode: "off", gateCheckMode: "enabled", reviewCheckMode: "required", requireLinkedIssue: false, linkedIssueGateMode: "advisory", aiReviewMode: "advisory" });
      await upsertPullRequestFromGitHub(env, repoFullName, { number: prNumber, title: "Add retry to checkout", state: "open", user: { login: authorLogin }, author_association: "CONTRIBUTOR", head: { sha: headSha, ref: opts.headRef ?? "feature/checkout-retry" }, labels: [], body: "Retries the payment call once on a 5xx." });
      await upsertPullRequestFile(env, { repoFullName, pullNumber: prNumber, path: "src/checkout.ts", status: "modified", additions: 3, deletions: 0, changes: 3, payload: { patch: "+function retryPayment() {\n+  return true;\n+}" } });
      // A renamed-with-no-patch file (GitHub omits `patch` for pure renames) -- exercises the
      // payload?.patch-is-not-a-string branch in the files.map() that builds E2eTestGenChangedFile[].
      await upsertPullRequestFile(env, { repoFullName, pullNumber: prNumber, path: "src/renamed.ts", status: "renamed", additions: 0, deletions: 0, changes: 0, payload: {} });
      // features.e2eTests + review.e2e_test_delivery MUST land in the SAME upsertRepoFocusManifest call --
      // a second separate call REPLACES rather than merges with a prior one (see repo-doc-pr.test.ts).
      await upsertRepoFocusManifest(env, repoFullName, {
        features: { e2eTests: true },
        ...(opts.e2eTestDelivery ? { review: { e2e_test_delivery: opts.e2eTestDelivery } } : {}),
      });
    }
    const generateTestsWebhook = (repoFullName: string, prNumber: number, actor: string, opts: { association?: string; bot?: boolean; commenterIsAuthor?: boolean } = {}) => ({
      type: "github-webhook" as const,
      deliveryId: `generate-tests-${prNumber}-${actor}`,
      eventName: "issue_comment" as const,
      payload: {
        action: "created",
        installation: { id: 123, account: { login: repoFullName.slice(0, repoFullName.indexOf("/")), id: 1, type: "User" } },
        repository: { name: repoFullName.slice(repoFullName.indexOf("/") + 1), full_name: repoFullName, private: false, owner: { login: repoFullName.slice(0, repoFullName.indexOf("/")) } },
        issue: { number: prNumber, title: "Add retry to checkout", state: "open", user: { login: opts.commenterIsAuthor ? actor : "contributor" }, pull_request: {} },
        comment: { id: prNumber * 10, body: "@gittensory generate-tests", author_association: opts.association ?? "NONE", user: { login: actor, type: opts.bot ? "Bot" : "User" } },
        sender: { login: actor, type: opts.bot ? "Bot" : "User" },
      },
    }) as unknown as Parameters<typeof processJob>[1];
    const VALID_TEST_SOURCE = "import { test, expect } from '@playwright/test';\n\ntest('checkout retries on failure', async ({ page }) => {\n  await page.goto('/checkout');\n  await expect(page.getByRole('button', { name: 'Pay' })).toBeVisible();\n});";

    it("generates and posts an E2E test for an authorized maintainer, and records a completed audit event", async () => {
      const repoFullName = "JSONbored/gen-tests-4195-ok";
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: "```typescript\n" + VALID_TEST_SOURCE + "\n```" }) } as unknown as Ai,
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
      });
      await seedGenerateTestsPr(env, repoFullName, 4195, "gen-tests-4195-ok");
      let postedBody = "";
      let posted = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("/issues/4195/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/4195/comments") && method === "POST") { posted += 1; postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""); return Response.json({ id: 41950 }); }
        return new Response("not found", { status: 404 });
      });

      await processJob(env, generateTestsWebhook(repoFullName, 4195, "maintainer", { association: "MEMBER" }));

      expect(posted).toBe(1);
      expect(postedBody).toContain("AI-generated Playwright test for @maintainer");
      expect(postedBody).toContain("test('checkout retries on failure'");
      const audited = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("github_app.e2e_tests_generation").first<{ outcome: string; metadata_json: string }>();
      expect(audited?.outcome).toBe("completed");
      expect(JSON.parse(audited?.metadata_json ?? "{}")).toMatchObject({ status: "ok", byok: false });
    });

    it("denies a collaborator-tier actor (write permission, not the PR author) — narrower than every other command", async () => {
      const repoFullName = "JSONbored/gen-tests-4195-collab";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
      await seedGenerateTestsPr(env, repoFullName, 4196, "gen-tests-4195-collab");
      let posted = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/writer/permission")) return Response.json({ permission: "write" });
        if (url.includes("/issues/4196/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/4196/comments") && method === "POST") { posted += 1; return Response.json({ id: 41960 }); }
        return new Response("not found", { status: 404 });
      });

      await processJob(env, generateTestsWebhook(repoFullName, 4196, "writer", { association: "COLLABORATOR" }));

      expect(posted).toBe(0); // denied before any generation or comment
      const denied = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.e2e_tests_generation_denied").first<{ outcome: string; detail: string }>();
      expect(denied?.outcome).toBe("denied");
    });

    it("denies the PR's own author even though they authored it — the exact loophole a click-to-generate button must not open", async () => {
      const repoFullName = "JSONbored/gen-tests-4195-author";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
      await seedGenerateTestsPr(env, repoFullName, 4197, "gen-tests-4195-author", "contributor");
      let posted = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        // No collaborator/permission relationship at all -- a plain contributor commenting on their own PR.
        if (url.includes("/collaborators/contributor/permission")) return new Response("not found", { status: 404 });
        if (url.includes("/issues/4197/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/4197/comments") && method === "POST") { posted += 1; return Response.json({ id: 41970 }); }
        return new Response("not found", { status: 404 });
      });

      await processJob(env, generateTestsWebhook(repoFullName, 4197, "contributor", { association: "NONE", commenterIsAuthor: true }));

      expect(posted).toBe(0);
      const denied = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.e2e_tests_generation_denied").first<{ detail: string }>();
      expect(denied?.detail).toBe("maintainer_command_requires_maintainer");
    });

    it("falls back to a safe withheld-content note when posting the real generated-test comment fails", async () => {
      const repoFullName = "JSONbored/gen-tests-4195-post-fails";
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: "```typescript\n" + VALID_TEST_SOURCE + "\n```" }) } as unknown as Ai,
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
      });
      await seedGenerateTestsPr(env, repoFullName, 4200, "gen-tests-4195-post-fails");
      let postAttempts = 0;
      let fallbackBody = "";
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("/issues/4200/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/4200/comments") && method === "POST") {
          postAttempts += 1;
          // The FIRST attempt (the real generated-test comment) fails with a genuine GitHub API error; the
          // SECOND attempt (the withheld-content fallback) must still succeed.
          if (postAttempts === 1) return new Response("server exploded", { status: 500 });
          fallbackBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          return Response.json({ id: 42000 });
        }
        return new Response("not found", { status: 404 });
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await processJob(env, generateTestsWebhook(repoFullName, 4200, "maintainer", { association: "MEMBER" }));

      expect(postAttempts).toBe(2);
      expect(fallbackBody).toContain("did not produce a usable result");
      expect(fallbackBody).not.toContain("test('checkout retries on failure'");
      expect(logSpy.mock.calls.map((c) => String(c[0])).some((line) => line.includes("e2e_test_gen_comment_withheld"))).toBe(true);
      logSpy.mockRestore();
    });

    it("posts a not-enabled note (no generation call) when features.e2eTests is off for the repo", async () => {
      const repoFullName = "JSONbored/gen-tests-4195-disabled";
      const run = vi.fn();
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), AI: { run } as unknown as Ai, GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
      const slash = repoFullName.indexOf("/");
      await upsertRepositoryFromGitHub(env, { name: repoFullName.slice(slash + 1), full_name: repoFullName, private: false, owner: { login: repoFullName.slice(0, slash) } }, 123);
      await upsertRepositorySettings(env, { repoFullName, commentMode: "off", publicSurface: "off", autoLabelEnabled: false, checkRunMode: "off", gateCheckMode: "enabled", reviewCheckMode: "required", requireLinkedIssue: false, linkedIssueGateMode: "advisory", aiReviewMode: "advisory" });
      await upsertPullRequestFromGitHub(env, repoFullName, { number: 4198, title: "x", state: "open", user: { login: "contributor" }, author_association: "CONTRIBUTOR", head: { sha: "gen-tests-4195-disabled" }, labels: [], body: "x" });
      // Deliberately no upsertRepoFocusManifest features.e2eTests override -- stays off (no allowlist either).
      let postedBody = "";
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("/issues/4198/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/4198/comments") && method === "POST") { postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""); return Response.json({ id: 41980 }); }
        return new Response("not found", { status: 404 });
      });

      await processJob(env, generateTestsWebhook(repoFullName, 4198, "maintainer", { association: "MEMBER" }));

      expect(postedBody).toContain("E2E test generation is not enabled for this repository");
      expect(run).not.toHaveBeenCalled();
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.e2e_tests_generation_skipped").first<{ detail: string }>();
      expect(skipped?.detail).toBe("feature_disabled");
    });

    it("posts a did-not-produce-a-usable-result note when the model output never parses", async () => {
      const repoFullName = "JSONbored/gen-tests-4195-garbage";
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: "not a test file" }) } as unknown as Ai,
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
      });
      await seedGenerateTestsPr(env, repoFullName, 4199, "gen-tests-4195-garbage");
      let postedBody = "";
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("/issues/4199/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/4199/comments") && method === "POST") { postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""); return Response.json({ id: 41990 }); }
        return new Response("not found", { status: 404 });
      });

      await processJob(env, generateTestsWebhook(repoFullName, 4199, "maintainer", { association: "MEMBER" }));

      expect(postedBody).toContain("did not produce a usable result");
      const audited = await env.DB.prepare("select metadata_json from audit_events where event_type = ?").bind("github_app.e2e_tests_generation").first<{ metadata_json: string }>();
      expect(JSON.parse(audited?.metadata_json ?? "{}")).toMatchObject({ status: "ok" });
    });

    it("skips cleanly when the cached PR record is missing", async () => {
      const repoFullName = "JSONbored/gen-tests-4195-nopr";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
      const slash = repoFullName.indexOf("/");
      await upsertRepositoryFromGitHub(env, { name: repoFullName.slice(slash + 1), full_name: repoFullName, private: false, owner: { login: repoFullName.slice(0, slash) } }, 123);
      // No upsertPullRequestFromGitHub -- the PR was never cached.
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        return new Response("not found", { status: 404 });
      });

      await processJob(env, generateTestsWebhook(repoFullName, 4200, "maintainer", { association: "MEMBER" }));

      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.e2e_tests_generation_skipped").first<{ detail: string }>();
      expect(skipped?.detail).toBe("cached_pr_missing");
    });

    it("declines (returns false) for a non-command comment, claiming nothing", async () => {
      const repoFullName = "JSONbored/gen-tests-4195-decline";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
      await seedGenerateTestsPr(env, repoFullName, 4201, "gen-tests-4195-decline");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("/issues/4201/comments")) return Response.json([]);
        return new Response("not found", { status: 404 });
      });
      const webhook = generateTestsWebhook(repoFullName, 4201, "maintainer", { association: "MEMBER" });
      (webhook as unknown as { payload: { comment: { body: string } } }).payload.comment.body = "just chatting, no mention here";

      await processJob(env, webhook);

      const rows = await env.DB.prepare("select count(*) as n from audit_events where event_type like 'github_app.e2e_tests_generation%'").first<{ n: number }>();
      expect(rows?.n).toBe(0);
    });

    it("skips cleanly when the comment classifies as invalid (a bot posted the mention)", async () => {
      const repoFullName = "JSONbored/gen-tests-4195-bot";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
      await seedGenerateTestsPr(env, repoFullName, 4202, "gen-tests-4195-bot");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        return new Response("not found", { status: 404 });
      });

      await processJob(env, generateTestsWebhook(repoFullName, 4202, "some-bot[bot]", { association: "NONE", bot: true }));

      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.e2e_tests_generation_skipped").first<{ detail: string }>();
      expect(skipped?.detail).toBe("bot_author");
    });

    it("uses the maintainer's BYOK frontier model (not Workers AI) when aiReviewByok is on and a key is configured", async () => {
      const repoFullName = "JSONbored/gen-tests-4195-byok";
      const run = vi.fn(); // Workers AI must NOT be used when BYOK is configured
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run } as unknown as Ai,
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        TOKEN_ENCRYPTION_SECRET: "gen-tests-byok-test-encryption-secret-32b",
      });
      await seedGenerateTestsPr(env, repoFullName, 4203, "gen-tests-4195-byok");
      // aiReviewProvider set AND matching the stored key's provider -- exercises the "explicit provider
      // pin agrees with the stored key" arm, distinct from the (also-tested-elsewhere) "no pin configured"
      // default arm.
      await upsertRepositorySettings(env, { repoFullName, commentMode: "off", publicSurface: "off", autoLabelEnabled: false, checkRunMode: "off", gateCheckMode: "enabled", reviewCheckMode: "required", requireLinkedIssue: false, linkedIssueGateMode: "advisory", aiReviewMode: "advisory", aiReviewByok: true, aiReviewProvider: "anthropic" });
      await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-byok-gen-tests-9999", model: null });
      let postedBody = "";
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("api.anthropic.com")) return Response.json({ content: [{ type: "text", text: "```typescript\n" + VALID_TEST_SOURCE + "\n```" }] });
        if (url.includes("/issues/4203/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/4203/comments") && method === "POST") { postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""); return Response.json({ id: 42030 }); }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      await processJob(env, generateTestsWebhook(repoFullName, 4203, "maintainer", { association: "MEMBER" }));

      expect(run).not.toHaveBeenCalled();
      expect(postedBody).toContain("test('checkout retries on failure'");
      const audited = await env.DB.prepare("select metadata_json from audit_events where event_type = ?").bind("github_app.e2e_tests_generation").first<{ metadata_json: string }>();
      expect(JSON.parse(audited?.metadata_json ?? "{}")).toMatchObject({ byok: true });
    });

    it("degrades to the not-usable-result note when the feature is on but no AI provider is configured at all", async () => {
      const repoFullName = "JSONbored/gen-tests-4195-unavailable";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
      await seedGenerateTestsPr(env, repoFullName, 4204, "gen-tests-4195-unavailable"); // no env.AI, no BYOK key
      let postedBody = "";
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("/issues/4204/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/4204/comments") && method === "POST") { postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""); return Response.json({ id: 42040 }); }
        return new Response("not found", { status: 404 });
      });

      await processJob(env, generateTestsWebhook(repoFullName, 4204, "maintainer", { association: "MEMBER" }));

      expect(postedBody).toContain("did not produce a usable result");
      const audited = await env.DB.prepare("select metadata_json from audit_events where event_type = ?").bind("github_app.e2e_tests_generation").first<{ metadata_json: string }>();
      expect(JSON.parse(audited?.metadata_json ?? "{}")).toMatchObject({ status: "unavailable" });
    });

    it("generates via the GITTENSORY_REVIEW_REPOS allowlist default when no manifest is published at all", async () => {
      // No upsertRepoFocusManifest call -- loadRepoFocusManifest resolves null, so manifest?.review (fed to
      // resolveE2eTestGenInstructions) and the e2eTests feature gate itself both take their null/allowlist path.
      const repoFullName = "JSONbored/gen-tests-4195-allowlist";
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: "```typescript\n" + VALID_TEST_SOURCE + "\n```" }) } as unknown as Ai,
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        GITTENSORY_REVIEW_REPOS: repoFullName,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
      });
      const slash = repoFullName.indexOf("/");
      await upsertRepositoryFromGitHub(env, { name: repoFullName.slice(slash + 1), full_name: repoFullName, private: false, owner: { login: repoFullName.slice(0, slash) } }, 123);
      await upsertRepositorySettings(env, { repoFullName, commentMode: "off", publicSurface: "off", autoLabelEnabled: false, checkRunMode: "off", gateCheckMode: "enabled", reviewCheckMode: "required", requireLinkedIssue: false, linkedIssueGateMode: "advisory", aiReviewMode: "advisory" });
      await upsertPullRequestFromGitHub(env, repoFullName, { number: 4205, title: "Add retry to checkout", state: "open", user: { login: "contributor" }, author_association: "CONTRIBUTOR", head: { sha: "gen-tests-4195-allowlist" }, labels: [], body: "x" });
      await upsertPullRequestFile(env, { repoFullName, pullNumber: 4205, path: "src/checkout.ts", status: "modified", additions: 3, deletions: 0, changes: 3, payload: { patch: "+function retryPayment() {\n+  return true;\n+}" } });
      let postedBody = "";
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("/issues/4205/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/4205/comments") && method === "POST") { postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""); return Response.json({ id: 42050 }); }
        return new Response("not found", { status: 404 });
      });

      await processJob(env, generateTestsWebhook(repoFullName, 4205, "maintainer", { association: "MEMBER" }));

      expect(postedBody).toContain("test('checkout retries on failure'");
    });

    it("skips cleanly when the webhook payload has no comment object at all", async () => {
      const repoFullName = "JSONbored/gen-tests-4195-nocomment";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
      await seedGenerateTestsPr(env, repoFullName, 4206, "gen-tests-4195-nocomment");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        return new Response("not found", { status: 404 });
      });
      const webhook = generateTestsWebhook(repoFullName, 4206, "maintainer", { association: "MEMBER" });
      delete (webhook as unknown as { payload: { comment?: unknown } }).payload.comment;

      await processJob(env, webhook);

      const rows = await env.DB.prepare("select count(*) as n from audit_events where event_type like 'github_app.e2e_tests_generation%'").first<{ n: number }>();
      expect(rows?.n).toBe(0);
    });

    // #4197 (commit delivery) + #4201 (scoring-integrity safeguard), both part of the #4189 epic.
    describe("commit delivery mode (#4197, #4201)", () => {
      it("pushes the generated test as a commit onto the PR's own head branch for a non-miner author, and records commitStatus: committed", async () => {
        const repoFullName = "JSONbored/gen-tests-4197-commit-ok";
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => ({ response: "```typescript\n" + VALID_TEST_SOURCE + "\n```" }) } as unknown as Ai,
          GITTENSORY_REVIEW_E2E_TESTS: "true",
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
        });
        await seedGenerateTestsPr(env, repoFullName, 4207, "commit-ok-head-sha", "contributor", { headRef: "feature/checkout-retry", e2eTestDelivery: "commit" });
        let postedBody = "";
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
          if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
          if (url.endsWith("/pulls/4207") && method === "GET") return Response.json({ head: { ref: "feature/checkout-retry", sha: "commit-ok-head-sha", repo: { full_name: repoFullName } } });
          if (url.endsWith("/git/commits/commit-ok-head-sha") && method === "GET") return Response.json({ tree: { sha: "base-tree-sha" } });
          if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "new-tree-sha" });
          if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "committed-sha-123" });
          if (method === "PATCH") return Response.json({});
          if (url.includes("/issues/4207/comments") && method === "GET") return Response.json([]);
          if (url.includes("/issues/4207/comments") && method === "POST") { postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""); return Response.json({ id: 42070 }); }
          return new Response("not found", { status: 404 });
        });

        await processJob(env, generateTestsWebhook(repoFullName, 4207, "maintainer", { association: "MEMBER" }));

        expect(postedBody).toContain("pushed as a commit");
        expect(postedBody).toContain(`https://github.com/${repoFullName}/commit/committed-sha-123`);
        expect(postedBody).not.toContain("```typescript");
        const audited = await env.DB.prepare("select metadata_json from audit_events where event_type = ?").bind("github_app.e2e_tests_generation").first<{ metadata_json: string }>();
        expect(JSON.parse(audited?.metadata_json ?? "{}")).toMatchObject({ deliveryMode: "commit", commitStatus: "committed" });
      });

      it("blocks commit delivery for a confirmed Gittensor miner PR author, but still posts the generated test as a suggestion (#4201)", async () => {
        const repoFullName = "JSONbored/gen-tests-4201-miner-blocked";
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => ({ response: "```typescript\n" + VALID_TEST_SOURCE + "\n```" }) } as unknown as Ai,
          GITTENSORY_REVIEW_E2E_TESTS: "true",
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
        });
        await seedGenerateTestsPr(env, repoFullName, 4208, "miner-blocked-head-sha", "confirmed-miner", { headRef: "feature/checkout-retry", e2eTestDelivery: "commit" });
        await upsertOfficialMinerDetection(env, "confirmed-miner", { status: "confirmed", snapshot: queueMinerSnapshot("confirmed-miner") }, 60_000);
        let posted = 0;
        let postedBody = "";
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
          if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
          // No git/trees or git/commits stubs at all -- a blocked commit must never even attempt a GitHub write.
          if (url.includes("/issues/4208/comments") && method === "GET") return Response.json([]);
          if (url.includes("/issues/4208/comments") && method === "POST") { posted += 1; postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""); return Response.json({ id: 42080 }); }
          return new Response("not found", { status: 404 });
        });

        await processJob(env, generateTestsWebhook(repoFullName, 4208, "maintainer", { association: "MEMBER" }));

        expect(posted).toBe(1);
        expect(postedBody).toContain("confirmed Gittensor miner");
        expect(postedBody).toContain("```typescript\n" + VALID_TEST_SOURCE + "\n```");
        const audited = await env.DB.prepare("select metadata_json from audit_events where event_type = ?").bind("github_app.e2e_tests_generation").first<{ metadata_json: string }>();
        expect(JSON.parse(audited?.metadata_json ?? "{}")).toMatchObject({ deliveryMode: "commit", commitStatus: "blocked" });
      });

      it("falls back to a declined-with-reason suggestion when commit delivery has no write access to a fork PR branch", async () => {
        const repoFullName = "JSONbored/gen-tests-4197-commit-declined";
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => ({ response: "```typescript\n" + VALID_TEST_SOURCE + "\n```" }) } as unknown as Ai,
          GITTENSORY_REVIEW_E2E_TESTS: "true",
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
        });
        await seedGenerateTestsPr(env, repoFullName, 4209, "declined-head-sha", "contributor", { headRef: "feature/checkout-retry", e2eTestDelivery: "commit" });
        let postedBody = "";
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
          if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
          if (url.endsWith("/pulls/4209") && method === "GET") return new Response("forbidden", { status: 403 });
          if (url.includes("/issues/4209/comments") && method === "GET") return Response.json([]);
          if (url.includes("/issues/4209/comments") && method === "POST") { postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""); return Response.json({ id: 42090 }); }
          return new Response("not found", { status: 404 });
        });

        await processJob(env, generateTestsWebhook(repoFullName, 4209, "maintainer", { association: "MEMBER" }));

        expect(postedBody).toContain("Commit delivery was requested but declined: no write access");
        expect(postedBody).toContain("```typescript\n" + VALID_TEST_SOURCE + "\n```");
        const audited = await env.DB.prepare("select metadata_json from audit_events where event_type = ?").bind("github_app.e2e_tests_generation").first<{ metadata_json: string }>();
        expect(JSON.parse(audited?.metadata_json ?? "{}")).toMatchObject({ deliveryMode: "commit", commitStatus: "declined" });
      });

      it("declines commit delivery with a clear reason when the PR's head branch/commit is not cached at all", async () => {
        const repoFullName = "JSONbored/gen-tests-4197-commit-no-head";
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => ({ response: "```typescript\n" + VALID_TEST_SOURCE + "\n```" }) } as unknown as Ai,
          GITTENSORY_REVIEW_E2E_TESTS: "true",
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
        });
        const slash = repoFullName.indexOf("/");
        await upsertRepositoryFromGitHub(env, { name: repoFullName.slice(slash + 1), full_name: repoFullName, private: false, owner: { login: repoFullName.slice(0, slash) } }, 123);
        await upsertRepositorySettings(env, { repoFullName, commentMode: "off", publicSurface: "off", autoLabelEnabled: false, checkRunMode: "off", gateCheckMode: "enabled", reviewCheckMode: "required", requireLinkedIssue: false, linkedIssueGateMode: "advisory", aiReviewMode: "advisory" });
        // No head sha/ref cached at all on this PR record.
        await upsertPullRequestFromGitHub(env, repoFullName, { number: 4210, title: "Add retry to checkout", state: "open", user: { login: "contributor" }, author_association: "CONTRIBUTOR", labels: [], body: "x" });
        await upsertPullRequestFile(env, { repoFullName, pullNumber: 4210, path: "src/checkout.ts", status: "modified", additions: 3, deletions: 0, changes: 3, payload: { patch: "+function retryPayment() {\n+  return true;\n+}" } });
        await upsertRepoFocusManifest(env, repoFullName, { features: { e2eTests: true }, review: { e2e_test_delivery: "commit" } });
        let postedBody = "";
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
          if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
          if (url.includes("/issues/4210/comments") && method === "GET") return Response.json([]);
          if (url.includes("/issues/4210/comments") && method === "POST") { postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""); return Response.json({ id: 42100 }); }
          return new Response("not found", { status: 404 });
        });

        await processJob(env, generateTestsWebhook(repoFullName, 4210, "maintainer", { association: "MEMBER" }));

        expect(postedBody).toContain("Commit delivery was requested but declined: the PR's head branch/commit is not cached");
        const audited = await env.DB.prepare("select metadata_json from audit_events where event_type = ?").bind("github_app.e2e_tests_generation").first<{ metadata_json: string }>();
        expect(JSON.parse(audited?.metadata_json ?? "{}")).toMatchObject({ deliveryMode: "commit", commitStatus: "declined" });
      });

      it("maps a genuinely unexpected git-write failure to a declined outcome (not a thrown error) in the posted comment", async () => {
        const repoFullName = "JSONbored/gen-tests-4197-commit-error-mapped";
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => ({ response: "```typescript\n" + VALID_TEST_SOURCE + "\n```" }) } as unknown as Ai,
          GITTENSORY_REVIEW_E2E_TESTS: "true",
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
        });
        await seedGenerateTestsPr(env, repoFullName, 4213, "error-mapped-head-sha", "contributor", { headRef: "feature/checkout-retry", e2eTestDelivery: "commit" });
        let postedBody = "";
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
          if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
          // Neither a 403/404 (no write access) nor a 422/409 (branch moved) -- a genuinely unexpected 500,
          // which commitE2eTestToPrBranch maps to status: "error" rather than "declined".
          if (url.endsWith("/pulls/4213") && method === "GET") return new Response("server exploded", { status: 500 });
          if (url.includes("/issues/4213/comments") && method === "GET") return Response.json([]);
          if (url.includes("/issues/4213/comments") && method === "POST") { postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""); return Response.json({ id: 42130 }); }
          return new Response("not found", { status: 404 });
        });

        await processJob(env, generateTestsWebhook(repoFullName, 4213, "maintainer", { association: "MEMBER" }));

        expect(postedBody).toContain("Commit delivery was requested but declined:");
        expect(postedBody).toContain("```typescript\n" + VALID_TEST_SOURCE + "\n```");
        const audited = await env.DB.prepare("select metadata_json from audit_events where event_type = ?").bind("github_app.e2e_tests_generation").first<{ metadata_json: string }>();
        expect(JSON.parse(audited?.metadata_json ?? "{}")).toMatchObject({ deliveryMode: "commit", commitStatus: "declined" });
      });

      it("still resolves the miner-safeguard check (to not-found) when the cached PR record has no author login at all", async () => {
        const repoFullName = "JSONbored/gen-tests-4201-no-author";
        const env = createTestEnv({
          GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
          AI: { run: async () => ({ response: "```typescript\n" + VALID_TEST_SOURCE + "\n```" }) } as unknown as Ai,
          GITTENSORY_REVIEW_E2E_TESTS: "true",
          AI_SUMMARIES_ENABLED: "true",
          AI_PUBLIC_COMMENTS_ENABLED: "true",
        });
        const slash = repoFullName.indexOf("/");
        await upsertRepositoryFromGitHub(env, { name: repoFullName.slice(slash + 1), full_name: repoFullName, private: false, owner: { login: repoFullName.slice(0, slash) } }, 123);
        await upsertRepositorySettings(env, { repoFullName, commentMode: "off", publicSurface: "off", autoLabelEnabled: false, checkRunMode: "off", gateCheckMode: "enabled", reviewCheckMode: "required", requireLinkedIssue: false, linkedIssueGateMode: "advisory", aiReviewMode: "advisory" });
        // Deliberately no `user` field at all -- the cached PR's authorLogin resolves to null, exercising the
        // ternary's not-found arm (`pr.authorLogin ? ... : { status: "not_found" }`) instead of ever calling
        // getCachedOfficialMinerDetection.
        await upsertPullRequestFromGitHub(env, repoFullName, { number: 4214, title: "Add retry to checkout", state: "open", author_association: "CONTRIBUTOR", head: { sha: "no-author-head-sha", ref: "feature/checkout-retry" }, labels: [], body: "x" });
        await upsertPullRequestFile(env, { repoFullName, pullNumber: 4214, path: "src/checkout.ts", status: "modified", additions: 3, deletions: 0, changes: 3, payload: { patch: "+function retryPayment() {\n+  return true;\n+}" } });
        await upsertRepoFocusManifest(env, repoFullName, { features: { e2eTests: true }, review: { e2e_test_delivery: "commit" } });
        let postedBody = "";
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input.toString();
          const method = init?.method ?? "GET";
          if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
          if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
          if (url.endsWith("/pulls/4214") && method === "GET") return Response.json({ head: { ref: "feature/checkout-retry", sha: "no-author-head-sha", repo: { full_name: repoFullName } } });
          if (url.endsWith("/git/commits/no-author-head-sha") && method === "GET") return Response.json({ tree: { sha: "base-tree-sha" } });
          if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "new-tree-sha" });
          if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "no-author-commit-sha" });
          if (method === "PATCH") return Response.json({});
          if (url.includes("/issues/4214/comments") && method === "GET") return Response.json([]);
          if (url.includes("/issues/4214/comments") && method === "POST") { postedBody = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""); return Response.json({ id: 42140 }); }
          return new Response("not found", { status: 404 });
        });

        await processJob(env, generateTestsWebhook(repoFullName, 4214, "maintainer", { association: "MEMBER" }));

        expect(postedBody).toContain("pushed as a commit");
        const audited = await env.DB.prepare("select metadata_json from audit_events where event_type = ?").bind("github_app.e2e_tests_generation").first<{ metadata_json: string }>();
        expect(JSON.parse(audited?.metadata_json ?? "{}")).toMatchObject({ deliveryMode: "commit", commitStatus: "committed" });
      });

      it("respects agentDryRun — never attempts commit delivery, and records dry_run (not agent_paused)", async () => {
        const repoFullName = "JSONbored/gen-tests-4197-commit-dryrun";
        const run = vi.fn();
        const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), AI: { run } as unknown as Ai, GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
        await seedGenerateTestsPr(env, repoFullName, 4211, "dryrun-head-sha", "contributor", { headRef: "feature/checkout-retry", e2eTestDelivery: "commit" });
        await upsertRepositorySettings(env, { repoFullName, commentMode: "off", publicSurface: "off", autoLabelEnabled: false, checkRunMode: "off", gateCheckMode: "enabled", reviewCheckMode: "required", requireLinkedIssue: false, linkedIssueGateMode: "advisory", aiReviewMode: "advisory", agentDryRun: true });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = input.toString();
          if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
          if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
          return new Response("not found", { status: 404 });
        });

        await processJob(env, generateTestsWebhook(repoFullName, 4211, "maintainer", { association: "MEMBER" }));

        expect(run).not.toHaveBeenCalled();
        const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.e2e_tests_generation_skipped").first<{ detail: string }>();
        expect(skipped?.detail).toBe("dry_run");
        const generated = await env.DB.prepare("select id from audit_events where event_type = ?").bind("github_app.e2e_tests_generation").first<{ id: string }>();
        expect(generated ?? null).toBeNull();
      });

      it("respects agentPaused — never attempts generation or commit delivery, and records agent_paused", async () => {
        const repoFullName = "JSONbored/gen-tests-4197-commit-paused";
        const run = vi.fn();
        const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), AI: { run } as unknown as Ai, GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
        await seedGenerateTestsPr(env, repoFullName, 4212, "paused-head-sha", "contributor", { headRef: "feature/checkout-retry", e2eTestDelivery: "commit" });
        await upsertRepositorySettings(env, { repoFullName, commentMode: "off", publicSurface: "off", autoLabelEnabled: false, checkRunMode: "off", gateCheckMode: "enabled", reviewCheckMode: "required", requireLinkedIssue: false, linkedIssueGateMode: "advisory", aiReviewMode: "advisory", agentPaused: true });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = input.toString();
          if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
          if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
          return new Response("not found", { status: 404 });
        });

        await processJob(env, generateTestsWebhook(repoFullName, 4212, "maintainer", { association: "MEMBER" }));

        expect(run).not.toHaveBeenCalled();
        const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.e2e_tests_generation_skipped").first<{ detail: string }>();
        expect(skipped?.detail).toBe("agent_paused");
      });
    });
  });

  // #4196 (part of the #4189 epic): promotes the existing manifest_missing_tests advisory finding into an
  // actual auto-trigger for #4192/#4194's generation-and-render path, additive to the explicit
  // `@gittensory generate-tests` command (#4195) tested above -- this describe block drives the AUTOMATED
  // review pass (maybePublishPrPublicSurface, via a `pull_request` webhook) rather than an issue_comment.
  describe("manifest_missing_tests auto-trigger (#4196)", () => {
    const AUTO_TEST_SOURCE = "import { test, expect } from '@playwright/test';\n\ntest('auto-generated coverage', async ({ page }) => {\n  await page.goto('/');\n  await expect(page).toHaveTitle(/./);\n});";

    async function seedAutoTriggerPr(
      env: Env,
      repoFullName: string,
      prNumber: number,
      headSha: string,
      opts: { e2eTests?: boolean; hasTestFile?: boolean; validationNote?: boolean; manifestPolicyGateMode?: "advisory" | "block"; e2eTestDelivery?: "comment" | "commit"; autoTrigger?: boolean } = {},
    ) {
      const slash = repoFullName.indexOf("/");
      const owner = repoFullName.slice(0, slash);
      const name = repoFullName.slice(slash + 1);
      await upsertRepositoryFromGitHub(env, { name, full_name: repoFullName, private: false, owner: { login: owner } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName,
        commentMode: "off",
        publicSurface: "off",
        autoLabelEnabled: false,
        checkRunMode: "off",
        // reviewCheckMode: "required" (not "disabled") -- gateEnabled (which the whole manifestPolicyGateMode
        // block this auto-trigger lives inside is downstream of) requires a truthy reviewCheckMode + a headSha.
        // With reviewCheckMode: "disabled" the function bails out via its own early-return before ever reaching
        // guidance.
        gateCheckMode: "enabled", reviewCheckMode: "required",
        requireLinkedIssue: false,
        linkedIssueGateMode: "off",
        manifestPolicyGateMode: opts.manifestPolicyGateMode ?? "advisory",
        aiReviewMode: "off",
        typeLabelsEnabled: false,
      });
      await upsertPullRequestFromGitHub(env, repoFullName, {
        number: prNumber,
        title: "Add retry to checkout",
        state: "open",
        user: { login: "contributor" },
        author_association: "CONTRIBUTOR",
        head: { sha: headSha, ref: "feature/checkout-retry" },
        labels: [],
        body: opts.validationNote ? "Ran npm run test:ci -- all green." : "No validation evidence mentioned here.",
      });
      await upsertPullRequestFile(env, {
        repoFullName,
        pullNumber: prNumber,
        path: opts.hasTestFile ? "test/unit/checkout.test.ts" : "src/checkout.ts",
        status: "modified",
        additions: 3,
        deletions: 0,
        changes: 3,
        payload: { patch: "+function retryPayment() {\n+  return true;\n+}" },
      });
      // testExpectations is a TOP-LEVEL manifest field (unlike review.e2e_test_delivery's nested snake_case) --
      // both it and features.e2eTests must land in the SAME upsertRepoFocusManifest call, since a second
      // separate call replaces rather than merges with the first.
      // autoTrigger defaults to true here (NOT the production default) since this whole describe block exists
      // to exercise the auto-trigger's own behavior -- the one test that cares about the real production
      // default (OFF) passes `autoTrigger: false` explicitly, mirroring how the `e2eTests: false` case above
      // already tests ITS OWN negative default the same way.
      await upsertRepoFocusManifest(env, repoFullName, {
        testExpectations: ["Run npm run test:ci."],
        features: { e2eTests: opts.e2eTests ?? true },
        review: { e2e_test_auto_trigger: opts.autoTrigger ?? true, ...(opts.e2eTestDelivery ? { e2e_test_delivery: opts.e2eTestDelivery } : {}) },
      });
    }

    const autoTriggerWebhook = (repoFullName: string, prNumber: number, headSha: string, action: "opened" | "synchronize" = "opened", body = "No validation evidence mentioned here.") => ({
      type: "github-webhook" as const,
      deliveryId: `auto-e2e-${prNumber}-${headSha}-${action}`,
      eventName: "pull_request" as const,
      payload: {
        action,
        installation: { id: 123, account: { login: repoFullName.slice(0, repoFullName.indexOf("/")), id: 1, type: "User" } },
        repository: { name: repoFullName.slice(repoFullName.indexOf("/") + 1), full_name: repoFullName, private: false, owner: { login: repoFullName.slice(0, repoFullName.indexOf("/")) } },
        pull_request: {
          number: prNumber,
          title: "Add retry to checkout",
          state: "open",
          user: { login: "contributor" },
          head: { sha: headSha },
          labels: [],
          // The incoming webhook payload's own body ALWAYS re-upserts the cached PR record before this pass
          // runs, overwriting whatever body seedAutoTriggerPr wrote directly to the DB -- so a test that needs
          // a specific validation-note body must pass it here, not rely on the DB seed alone.
          body,
        },
      },
    }) as unknown as Parameters<typeof processJob>[1];

    function stubAutoTriggerFetch(prNumber: number, posted: { count: number; body: string }) {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        // gateCheckMode: "enabled" means this pass ALSO publishes/updates a gate check-run -- these three
        // endpoints back that unrelated publish, not the e2e-test-gen comment itself.
        if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/check-runs") && method === "POST") return Response.json({ id: prNumber * 100 }, { status: 201 });
        if (url.includes("/check-runs") && method === "PATCH") return Response.json({ id: prNumber * 100, html_url: `https://github.com/checks/${prNumber * 100}` });
        if (url.includes(`/issues/${prNumber}/comments`) && method === "GET") return Response.json([]);
        if (url.includes(`/issues/${prNumber}/comments`) && method === "POST") {
          posted.count += 1;
          posted.body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          return Response.json({ id: prNumber * 10 });
        }
        return new Response("not found", { status: 404 });
      });
    }

    it("auto-triggers generation when manifest_missing_tests fires and features.e2eTests is enabled", async () => {
      const repoFullName = "JSONbored/auto-e2e-4196-ok";
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: "```typescript\n" + AUTO_TEST_SOURCE + "\n```" }) } as unknown as Ai,
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
      });
      await seedAutoTriggerPr(env, repoFullName, 5001, "auto-4196-ok-sha");
      const posted = { count: 0, body: "" };
      stubAutoTriggerFetch(5001, posted);

      await processJob(env, autoTriggerWebhook(repoFullName, 5001, "auto-4196-ok-sha"));

      expect(posted.count).toBe(1);
      expect(posted.body).toContain("test('auto-generated coverage'");
      const audited = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("github_app.e2e_tests_generation").first<{ outcome: string; metadata_json: string }>();
      expect(audited?.outcome).toBe("completed");
      expect(JSON.parse(audited?.metadata_json ?? "{}")).toMatchObject({ trigger: "auto", headSha: "auto-4196-ok-sha" });
    });

    it("keeps the automated manifest_missing_tests trigger comment-only even when the manifest opts explicit commands into commit delivery", async () => {
      const repoFullName = "JSONbored/auto-e2e-4196-commit-forced-comment";
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: "```typescript\n" + AUTO_TEST_SOURCE + "\n```" }) } as unknown as Ai,
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
      });
      await seedAutoTriggerPr(env, repoFullName, 5011, "auto-4196-commit-forced-comment-sha", { e2eTestDelivery: "commit" });
      const posted = { count: 0, body: "" };
      const gitWrites: string[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 501100 }, { status: 201 });
        if (url.includes("/check-runs") && method === "PATCH") return Response.json({ id: 501100, html_url: "https://github.com/checks/501100" });
        if (url.includes("/git/trees") || url.includes("/git/commits") || url.includes("/git/refs/")) {
          gitWrites.push(`${method} ${url}`);
          return new Response("unexpected git write", { status: 500 });
        }
        if (url.includes("/issues/5011/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/5011/comments") && method === "POST") {
          posted.count += 1;
          posted.body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          return Response.json({ id: 50110 });
        }
        return new Response("not found", { status: 404 });
      });

      await processJob(env, autoTriggerWebhook(repoFullName, 5011, "auto-4196-commit-forced-comment-sha"));

      expect(gitWrites).toEqual([]);
      expect(posted.count).toBe(1);
      expect(posted.body).toContain("test('auto-generated coverage'");
      const audited = await env.DB.prepare("select metadata_json from audit_events where event_type = ?").bind("github_app.e2e_tests_generation").first<{ metadata_json: string }>();
      expect(JSON.parse(audited?.metadata_json ?? "{}")).toMatchObject({ deliveryMode: "comment", trigger: "auto" });
    });

    it("does not auto-trigger when manifest_missing_tests fires but features.e2eTests is disabled for the repo", async () => {
      const repoFullName = "JSONbored/auto-e2e-4196-disabled";
      const run = vi.fn();
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), AI: { run } as unknown as Ai, GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
      await seedAutoTriggerPr(env, repoFullName, 5002, "auto-4196-disabled-sha", { e2eTests: false });
      const posted = { count: 0, body: "" };
      stubAutoTriggerFetch(5002, posted);

      await processJob(env, autoTriggerWebhook(repoFullName, 5002, "auto-4196-disabled-sha"));

      expect(run).not.toHaveBeenCalled();
      expect(posted.count).toBe(0);
      const audited = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.e2e_tests_generation").first<{ n: number }>();
      expect(audited?.n).toBe(0);
    });

    it("does not auto-trigger when features.e2eTests is enabled but review.e2e_test_auto_trigger is not set (safe default, #4196 separation)", async () => {
      const repoFullName = "JSONbored/auto-e2e-4196-no-opt-in";
      const run = vi.fn();
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), AI: { run } as unknown as Ai, GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
      // e2eTests stays enabled (the master feature, which unlocks the command/checkbox) but autoTrigger is
      // explicitly withheld -- the exact "enabled for maintainer-initiated use, but never fires unprompted"
      // shape the feature must default to.
      await seedAutoTriggerPr(env, repoFullName, 5012, "auto-4196-no-opt-in-sha", { autoTrigger: false });
      const posted = { count: 0, body: "" };
      stubAutoTriggerFetch(5012, posted);

      await processJob(env, autoTriggerWebhook(repoFullName, 5012, "auto-4196-no-opt-in-sha"));

      expect(run).not.toHaveBeenCalled();
      expect(posted.count).toBe(0);
      const audited = await env.DB.prepare("select count(*) as n from audit_events where event_type like 'github_app.e2e_tests_generation%'").first<{ n: number }>();
      expect(audited?.n).toBe(0);
    });

    it("does not auto-trigger when the PR already carries a test file (the manifest_missing_tests signal never fires)", async () => {
      const repoFullName = "JSONbored/auto-e2e-4196-has-test";
      const run = vi.fn();
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), AI: { run } as unknown as Ai, GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
      await seedAutoTriggerPr(env, repoFullName, 5003, "auto-4196-has-test-sha", { hasTestFile: true });
      const posted = { count: 0, body: "" };
      stubAutoTriggerFetch(5003, posted);

      await processJob(env, autoTriggerWebhook(repoFullName, 5003, "auto-4196-has-test-sha"));

      expect(run).not.toHaveBeenCalled();
      expect(posted.count).toBe(0);
    });

    it("does not auto-trigger when the PR body already carries a validation note (the manifest_missing_tests signal never fires)", async () => {
      const repoFullName = "JSONbored/auto-e2e-4196-validated";
      const run = vi.fn();
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), AI: { run } as unknown as Ai, GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
      await seedAutoTriggerPr(env, repoFullName, 5004, "auto-4196-validated-sha", { validationNote: true });
      const posted = { count: 0, body: "" };
      stubAutoTriggerFetch(5004, posted);

      await processJob(env, autoTriggerWebhook(repoFullName, 5004, "auto-4196-validated-sha", "opened", "Ran npm run test:ci -- all green."));

      expect(run).not.toHaveBeenCalled();
      expect(posted.count).toBe(0);
    });

    it("does not re-trigger generation on a second automated pass over the SAME unchanged head SHA (double-generation guard)", async () => {
      const repoFullName = "JSONbored/auto-e2e-4196-dedup";
      let runCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { runCalls += 1; return { response: "```typescript\n" + AUTO_TEST_SOURCE + "\n```" }; } } as unknown as Ai,
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
      });
      await seedAutoTriggerPr(env, repoFullName, 5005, "auto-4196-dedup-sha");
      const posted = { count: 0, body: "" };
      stubAutoTriggerFetch(5005, posted);

      // Two passes over the identical head SHA -- e.g. a `synchronize` redelivery or a re-review sweep tick
      // with no new push in between.
      await processJob(env, autoTriggerWebhook(repoFullName, 5005, "auto-4196-dedup-sha", "opened"));
      await processJob(env, autoTriggerWebhook(repoFullName, 5005, "auto-4196-dedup-sha", "synchronize"));

      expect(runCalls).toBe(1);
      expect(posted.count).toBe(1);
      const rows = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.e2e_tests_generation").first<{ n: number }>();
      expect(rows?.n).toBe(1);
    });

    it("DOES trigger again for a genuinely NEW head SHA (a real push) even though a prior SHA on the same PR already fired", async () => {
      const repoFullName = "JSONbored/auto-e2e-4196-new-push";
      let runCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { runCalls += 1; return { response: "```typescript\n" + AUTO_TEST_SOURCE + "\n```" }; } } as unknown as Ai,
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
      });
      await seedAutoTriggerPr(env, repoFullName, 5006, "auto-4196-first-sha");
      const posted = { count: 0, body: "" };
      stubAutoTriggerFetch(5006, posted);
      await processJob(env, autoTriggerWebhook(repoFullName, 5006, "auto-4196-first-sha", "opened"));
      expect(runCalls).toBe(1);

      // A genuine new push: the PR's cached head SHA moves, re-seeding the manifest (features.e2eTests stays
      // on) and re-running the webhook at the NEW sha.
      await upsertPullRequestFromGitHub(env, repoFullName, { number: 5006, title: "Add retry to checkout", state: "open", user: { login: "contributor" }, author_association: "CONTRIBUTOR", head: { sha: "auto-4196-second-sha", ref: "feature/checkout-retry" }, labels: [], body: "No validation evidence mentioned here." });
      await processJob(env, autoTriggerWebhook(repoFullName, 5006, "auto-4196-second-sha", "synchronize"));

      expect(runCalls).toBe(2);
      expect(posted.count).toBe(2);
    });

    it("an explicit @gittensory generate-tests command still regenerates on the SAME head SHA the auto-trigger already covered", async () => {
      const repoFullName = "JSONbored/auto-e2e-4196-explicit-after-auto";
      let runCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { runCalls += 1; return { response: "```typescript\n" + AUTO_TEST_SOURCE + "\n```" }; } } as unknown as Ai,
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
      });
      await seedAutoTriggerPr(env, repoFullName, 5007, "auto-4196-explicit-sha");
      const posted = { count: 0, body: "" };
      stubAutoTriggerFetch(5007, posted);
      await processJob(env, autoTriggerWebhook(repoFullName, 5007, "auto-4196-explicit-sha"));
      expect(runCalls).toBe(1);

      // Now the maintainer explicitly asks, on the SAME PR at the SAME (still-unpushed) head SHA. The
      // auto-trigger's dedup guard must not leak into the explicit command's own path.
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.includes("/issues/5007/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/5007/comments") && method === "POST") { posted.count += 1; posted.body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""); return Response.json({ id: 50070 }); }
        return new Response("not found", { status: 404 });
      });
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "auto-e2e-4196-explicit-command",
        eventName: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "auto-e2e-4196-explicit-after-auto", full_name: repoFullName, private: false, owner: { login: "JSONbored" } },
          issue: { number: 5007, title: "Add retry to checkout", state: "open", user: { login: "contributor" }, pull_request: {} },
          comment: { id: 50071, body: "@gittensory generate-tests", author_association: "MEMBER", user: { login: "maintainer", type: "User" } },
          sender: { login: "maintainer", type: "User" },
        },
      } as unknown as Parameters<typeof processJob>[1]);

      expect(runCalls).toBe(2);
      expect(posted.count).toBe(2);
      const rows = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.e2e_tests_generation").first<{ n: number }>();
      expect(rows?.n).toBe(2);
    });

    it("respects agentPaused — records a skip and never spends an LLM call, even though the signal fired", async () => {
      const repoFullName = "JSONbored/auto-e2e-4196-paused";
      const run = vi.fn();
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), AI: { run } as unknown as Ai, GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
      await seedAutoTriggerPr(env, repoFullName, 5008, "auto-4196-paused-sha");
      await upsertRepositorySettings(env, { repoFullName, commentMode: "off", publicSurface: "off", autoLabelEnabled: false, checkRunMode: "off", gateCheckMode: "enabled", reviewCheckMode: "required", requireLinkedIssue: false, linkedIssueGateMode: "off", manifestPolicyGateMode: "advisory", aiReviewMode: "off", agentPaused: true });
      const posted = { count: 0, body: "" };
      stubAutoTriggerFetch(5008, posted);

      await processJob(env, autoTriggerWebhook(repoFullName, 5008, "auto-4196-paused-sha"));

      expect(run).not.toHaveBeenCalled();
      expect(posted.count).toBe(0);
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.e2e_tests_generation_skipped").first<{ detail: string }>();
      expect(skipped?.detail).toBe("agent_paused");
    });

    it("respects agentDryRun — records a skip with detail dry_run (not agent_paused), and never spends an LLM call", async () => {
      const repoFullName = "JSONbored/auto-e2e-4196-dryrun";
      const run = vi.fn();
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), AI: { run } as unknown as Ai, GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
      await seedAutoTriggerPr(env, repoFullName, 5009, "auto-4196-dryrun-sha");
      await upsertRepositorySettings(env, { repoFullName, commentMode: "off", publicSurface: "off", autoLabelEnabled: false, checkRunMode: "off", gateCheckMode: "enabled", reviewCheckMode: "required", requireLinkedIssue: false, linkedIssueGateMode: "off", manifestPolicyGateMode: "advisory", aiReviewMode: "off", agentDryRun: true });
      const posted = { count: 0, body: "" };
      stubAutoTriggerFetch(5009, posted);

      await processJob(env, autoTriggerWebhook(repoFullName, 5009, "auto-4196-dryrun-sha"));

      expect(run).not.toHaveBeenCalled();
      expect(posted.count).toBe(0);
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.e2e_tests_generation_skipped").first<{ detail: string }>();
      expect(skipped?.detail).toBe("dry_run");
    });

    it("attributes the generated test to \"the PR author\" when the cached PR has no author login at all (a ghost/deleted account)", async () => {
      const repoFullName = "JSONbored/auto-e2e-4196-no-author";
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: "```typescript\n" + AUTO_TEST_SOURCE + "\n```" }) } as unknown as Ai,
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
      });
      const slash = repoFullName.indexOf("/");
      await upsertRepositoryFromGitHub(env, { name: repoFullName.slice(slash + 1), full_name: repoFullName, private: false, owner: { login: repoFullName.slice(0, slash) } }, 123);
      await upsertRepositorySettings(env, { repoFullName, commentMode: "off", publicSurface: "off", autoLabelEnabled: false, checkRunMode: "off", gateCheckMode: "enabled", reviewCheckMode: "required", requireLinkedIssue: false, linkedIssueGateMode: "off", manifestPolicyGateMode: "advisory", aiReviewMode: "off" });
      // Deliberately no `user` field at all -- authorLogin resolves to null, exercising the `author ?? "the PR
      // author"` fallback arm (the explicit command's own `actor` is always a real commenter login, so this
      // branch is reachable only from the auto-trigger, which has no comment-invoker to fall back on).
      await upsertPullRequestFromGitHub(env, repoFullName, { number: 5010, title: "Add retry to checkout", state: "open", author_association: "CONTRIBUTOR", head: { sha: "auto-4196-no-author-sha", ref: "feature/checkout-retry" }, labels: [], body: "No validation evidence mentioned here." });
      await upsertPullRequestFile(env, { repoFullName, pullNumber: 5010, path: "src/checkout.ts", status: "modified", additions: 3, deletions: 0, changes: 3, payload: { patch: "+function retryPayment() {\n+  return true;\n+}" } });
      await upsertRepoFocusManifest(env, repoFullName, { testExpectations: ["Run npm run test:ci."], features: { e2eTests: true }, review: { e2e_test_auto_trigger: true } });
      const posted = { count: 0, body: "" };
      stubAutoTriggerFetch(5010, posted);

      // Built inline (not via autoTriggerWebhook) so the incoming payload's own pull_request sub-object omits
      // `user` too -- autoTriggerWebhook always hardcodes a real `user.login`, which would re-upsert (and thus
      // restore) an author login before this pass ever runs.
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "auto-e2e-4196-no-author",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "auto-e2e-4196-no-author", full_name: repoFullName, private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 5010, title: "Add retry to checkout", state: "open", head: { sha: "auto-4196-no-author-sha" }, labels: [], body: "No validation evidence mentioned here." },
        },
      } as unknown as Parameters<typeof processJob>[1]);

      expect(posted.count).toBe(1);
      expect(posted.body).toContain("AI-generated Playwright test for @the PR author");
    });
  });

  // #4589: the interactive counterpart to #4583's text-only CTA. Same issue_comment.edited detection shell as
  // the pre-existing "PR-panel retrigger" checkbox (marker presence, bot's-own-comment confirmation, bot-sender
  // guard, payload.sender as the real actor re-authorized server-side), but dispatches through the SAME shared
  // runE2eTestGenerationAndDeliver core the command (#4195) and auto-trigger (#4196) above already use.
  describe("PR-panel generate-tests checkbox (#4589)", () => {
    const CHECKBOX_TEST_SOURCE = "import { test, expect } from '@playwright/test';\n\ntest('checkbox-generated coverage', async ({ page }) => {\n  await page.goto('/');\n  await expect(page).toHaveTitle(/./);\n});";

    async function seedCheckboxPr(
      env: Env,
      repoFullName: string,
      prNumber: number,
      headSha: string,
      opts: { e2eTests?: boolean } = {},
    ) {
      const slash = repoFullName.indexOf("/");
      const owner = repoFullName.slice(0, slash);
      const name = repoFullName.slice(slash + 1);
      await upsertRepositoryFromGitHub(env, { name, full_name: repoFullName, private: false, owner: { login: owner } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName,
        commentMode: "off",
        publicSurface: "off",
        autoLabelEnabled: false,
        checkRunMode: "off",
        gateCheckMode: "off",
        requireLinkedIssue: false,
        linkedIssueGateMode: "off",
        manifestPolicyGateMode: "advisory",
        aiReviewMode: "off",
        typeLabelsEnabled: false,
      });
      await upsertPullRequestFromGitHub(env, repoFullName, {
        number: prNumber,
        title: "Add retry to checkout",
        state: "open",
        user: { login: "contributor" },
        author_association: "CONTRIBUTOR",
        head: { sha: headSha, ref: "feature/checkout-retry" },
        labels: [],
        body: "No validation evidence mentioned here.",
      });
      await upsertPullRequestFile(env, {
        repoFullName,
        pullNumber: prNumber,
        path: "src/checkout.ts",
        status: "modified",
        additions: 3,
        deletions: 0,
        changes: 3,
        payload: { patch: "+function retryPayment() {\n+  return true;\n+}" },
      });
      await upsertRepoFocusManifest(env, repoFullName, {
        testExpectations: ["Run npm run test:ci."],
        features: { e2eTests: opts.e2eTests ?? true },
      });
    }

    const CHECKED_GENERATE_TESTS_PANEL = [
      "<!-- gittensory-pr-panel:v1 -->",
      "",
      "- [x] <!-- gittensory-generate-tests:v1 --> Generate an AI Playwright test for this PR",
    ].join("\n");

    function checkboxWebhook(
      repoFullName: string,
      prNumber: number,
      commentId: number,
      sender: { login: string; type?: "User" | "Bot" },
      opts: { body?: string; commentUser?: { login: string; type: "User" | "Bot" }; omitInstallation?: boolean; omitPullRequest?: boolean } = {},
    ) {
      const slash = repoFullName.indexOf("/");
      return {
        type: "github-webhook" as const,
        deliveryId: `checkbox-${prNumber}-${commentId}`,
        eventName: "issue_comment" as const,
        payload: {
          action: "edited",
          ...(opts.omitInstallation ? {} : { installation: { id: 123, account: { login: repoFullName.slice(0, slash), id: 1, type: "User" } } }),
          repository: { name: repoFullName.slice(slash + 1), full_name: repoFullName, private: false, owner: { login: repoFullName.slice(0, slash) } },
          issue: { number: prNumber, title: "Add retry to checkout", state: "open", user: { login: "contributor" }, ...(opts.omitPullRequest ? {} : { pull_request: {} }) },
          comment: { id: commentId, body: opts.body ?? CHECKED_GENERATE_TESTS_PANEL, user: opts.commentUser ?? { login: "gittensory[bot]", type: "Bot" } },
          sender: { login: sender.login, type: sender.type ?? "User" },
        },
      } as unknown as Parameters<typeof processJob>[1];
    }

    function stubCheckboxFetch(prNumber: number, actorLogin: string, permission: string, posted: { count: number; body: string }) {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes(`/collaborators/${actorLogin}/permission`)) return Response.json({ permission });
        if (url.includes(`/issues/${prNumber}/comments`) && method === "GET") return Response.json([]);
        if (url.includes(`/issues/${prNumber}/comments`) && method === "POST") {
          posted.count += 1;
          posted.body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          return Response.json({ id: prNumber * 10 });
        }
        return new Response("not found", { status: 404 });
      });
    }

    it("dispatches generation when a maintainer checks the box", async () => {
      const repoFullName = "JSONbored/checkbox-4589-ok";
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: "```typescript\n" + CHECKBOX_TEST_SOURCE + "\n```" }) } as unknown as Ai,
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
      });
      await seedCheckboxPr(env, repoFullName, 6001, "checkbox-4589-ok-sha");
      const posted = { count: 0, body: "" };
      stubCheckboxFetch(6001, "maintainer", "admin", posted);

      await processJob(env, checkboxWebhook(repoFullName, 6001, 900, { login: "maintainer" }));

      expect(posted.count).toBe(1);
      expect(posted.body).toContain("test('checkbox-generated coverage'");
      const audited = await env.DB.prepare("select outcome, actor, metadata_json from audit_events where event_type = ?")
        .bind("github_app.e2e_tests_generation")
        .first<{ outcome: string; actor: string; metadata_json: string }>();
      expect(audited?.outcome).toBe("completed");
      expect(audited?.actor).toBe("maintainer");
      expect(JSON.parse(audited?.metadata_json ?? "{}")).toMatchObject({ trigger: "checkbox" });
    });

    it("is a silent no-op when a non-maintainer checks the box — no comment posted, only a denial audit event", async () => {
      const repoFullName = "JSONbored/checkbox-4589-denied";
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: vi.fn() } as unknown as Ai,
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
      });
      await seedCheckboxPr(env, repoFullName, 6002, "checkbox-4589-denied-sha");
      const posted = { count: 0, body: "" };
      stubCheckboxFetch(6002, "drive-by-user", "read", posted);

      await processJob(env, checkboxWebhook(repoFullName, 6002, 901, { login: "drive-by-user" }));

      expect(posted.count).toBe(0);
      const denied = await env.DB.prepare("select actor, outcome, detail from audit_events where event_type = ?")
        .bind("github_app.e2e_tests_generation_denied")
        .first<{ actor: string; outcome: string; detail: string }>();
      expect(denied).toMatchObject({ actor: "drive-by-user", outcome: "denied" });
    });

    // Authorization used to be hardcoded to maintainer-only here, ignoring whatever a repo's own
    // .gittensory.yml commandAuthorization configured -- a self-hoster who wants their contributors to be
    // able to trigger test generation had no way to widen it. It now respects settings.commandAuthorization,
    // the exact same resolved (and safely clamped) policy the text-command version already uses.
    it("dispatches generation for a COLLABORATOR (not just a maintainer) once the repo widens commandAuthorization for generate-tests", async () => {
      const repoFullName = "JSONbored/checkbox-4589-widened";
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: "```typescript\n" + CHECKBOX_TEST_SOURCE + "\n```" }) } as unknown as Ai,
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
      });
      await seedCheckboxPr(env, repoFullName, 6013, "checkbox-4589-widened-sha");
      await upsertRepositorySettings(env, {
        repoFullName,
        commentMode: "off",
        publicSurface: "off",
        autoLabelEnabled: false,
        checkRunMode: "off",
        gateCheckMode: "off",
        requireLinkedIssue: false,
        linkedIssueGateMode: "off",
        manifestPolicyGateMode: "advisory",
        aiReviewMode: "off",
        commandAuthorization: { default: ["maintainer"], commands: { "generate-tests": ["maintainer", "collaborator"] } },
      });
      const posted = { count: 0, body: "" };
      stubCheckboxFetch(6013, "collab-user", "write", posted); // "write" permission resolves to the COLLABORATOR association

      await processJob(env, checkboxWebhook(repoFullName, 6013, 911, { login: "collab-user" }));

      expect(posted.count).toBe(1);
      expect(posted.body).toContain("test('checkbox-generated coverage'");
      const audited = await env.DB.prepare("select outcome, actor from audit_events where event_type = ?")
        .bind("github_app.e2e_tests_generation")
        .first<{ outcome: string; actor: string }>();
      expect(audited).toMatchObject({ outcome: "completed", actor: "collab-user" });
    });

    it("still denies the PR's own author even if the repo tries to configure the raw pr_author role for generate-tests (safety clamp holds)", async () => {
      const repoFullName = "JSONbored/checkbox-4589-clamped";
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: vi.fn() } as unknown as Ai,
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
      });
      // seedCheckboxPr's own PR fixture is authored by "contributor" -- the SAME login checks the box below.
      await seedCheckboxPr(env, repoFullName, 6014, "checkbox-4589-clamped-sha");
      await upsertRepositorySettings(env, {
        repoFullName,
        commentMode: "off",
        publicSurface: "off",
        autoLabelEnabled: false,
        checkRunMode: "off",
        gateCheckMode: "off",
        requireLinkedIssue: false,
        linkedIssueGateMode: "off",
        manifestPolicyGateMode: "advisory",
        aiReviewMode: "off",
        // A repo attempting to grant its own PR authors unconditional access -- normalizeCommandRoleList drops
        // the spoofable raw pr_author role for any MAINTAINER_ONLY_DEFAULT_COMMANDS entry (generate-tests is
        // one), re-clamped at the point of use regardless of what's stored here.
        commandAuthorization: { default: ["maintainer"], commands: { "generate-tests": ["pr_author"] } },
      });
      const posted = { count: 0, body: "" };
      stubCheckboxFetch(6014, "contributor", "read", posted);

      await processJob(env, checkboxWebhook(repoFullName, 6014, 912, { login: "contributor" }));

      expect(posted.count).toBe(0);
      const denied = await env.DB.prepare("select actor, outcome from audit_events where event_type = ?")
        .bind("github_app.e2e_tests_generation_denied")
        .first<{ actor: string; outcome: string }>();
      expect(denied).toMatchObject({ actor: "contributor", outcome: "denied" });
    });

    it("skips a bot-initiated edit (the bot's own comment re-render) without dispatching generation", async () => {
      const repoFullName = "JSONbored/checkbox-4589-bot";
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
      });
      await seedCheckboxPr(env, repoFullName, 6003, "checkbox-4589-bot-sha");
      const posted = { count: 0, body: "" };
      stubCheckboxFetch(6003, "gittensory[bot]", "admin", posted);

      await processJob(env, checkboxWebhook(repoFullName, 6003, 902, { login: "gittensory[bot]", type: "Bot" }));

      expect(posted.count).toBe(0);
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?")
        .bind("github_app.e2e_tests_generation_skipped")
        .first<{ detail: string }>();
      expect(skipped?.detail).toBe("bot_author");
    });

    it("ignores the marker when it appears in a comment that isn't the bot's own", async () => {
      const repoFullName = "JSONbored/checkbox-4589-not-bot-comment";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
      await seedCheckboxPr(env, repoFullName, 6009, "checkbox-4589-not-bot-comment-sha");
      const posted = { count: 0, body: "" };
      stubCheckboxFetch(6009, "maintainer", "admin", posted);

      await processJob(
        env,
        checkboxWebhook(repoFullName, 6009, 908, { login: "maintainer" }, { commentUser: { login: "someone-else", type: "User" } }),
      );

      expect(posted.count).toBe(0);
      const events = await env.DB.prepare("select count(*) as n from audit_events where event_type like 'github_app.e2e_tests_generation%'").first<{ n: number }>();
      expect(events?.n).toBe(0);
    });

    it("skips when features.e2eTests is disabled for the repo, even though the checkbox was checked", async () => {
      const repoFullName = "JSONbored/checkbox-4589-disabled";
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: vi.fn() } as unknown as Ai,
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
      });
      await seedCheckboxPr(env, repoFullName, 6004, "checkbox-4589-disabled-sha", { e2eTests: false });
      const posted = { count: 0, body: "" };
      stubCheckboxFetch(6004, "maintainer", "admin", posted);

      await processJob(env, checkboxWebhook(repoFullName, 6004, 903, { login: "maintainer" }));

      expect(posted.count).toBe(0);
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?")
        .bind("github_app.e2e_tests_generation_skipped")
        .first<{ detail: string }>();
      expect(skipped?.detail).toBe("feature_disabled");
    });

    it("ignores an edit where the generate-tests marker isn't checked (e.g. only the re-run box was checked)", async () => {
      const repoFullName = "JSONbored/checkbox-4589-other-marker";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedCheckboxPr(env, repoFullName, 6005, "checkbox-4589-other-marker-sha");
      const posted = { count: 0, body: "" };
      stubCheckboxFetch(6005, "maintainer", "admin", posted);
      const otherPanel = [
        "<!-- gittensory-pr-panel:v1 -->",
        "",
        "- [x] <!-- gittensory-rerun-review:v1 --> Re-run Gittensory review",
        "- [ ] <!-- gittensory-generate-tests:v1 --> Generate an AI Playwright test for this PR",
      ].join("\n");

      await processJob(env, checkboxWebhook(repoFullName, 6005, 904, { login: "maintainer" }, { body: otherPanel }));

      expect(posted.count).toBe(0);
      const events = await env.DB.prepare("select count(*) as n from audit_events where event_type like 'github_app.e2e_tests_generation%'").first<{ n: number }>();
      expect(events?.n).toBe(0);
    });

    it("skips a malformed payload (no installation / not a PR comment) without throwing", async () => {
      const repoFullName = "JSONbored/checkbox-4589-malformed";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedCheckboxPr(env, repoFullName, 6006, "checkbox-4589-malformed-sha");
      const posted = { count: 0, body: "" };
      stubCheckboxFetch(6006, "maintainer", "admin", posted);

      await processJob(env, checkboxWebhook(repoFullName, 6006, 905, { login: "maintainer" }, { omitPullRequest: true }));

      expect(posted.count).toBe(0);
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?")
        .bind("github_app.e2e_tests_generation_skipped")
        .first<{ detail: string }>();
      expect(skipped?.detail).toBe("missing_repo_pr_or_installation");
    });

    it("skips when the cached PR record is missing", async () => {
      const repoFullName = "JSONbored/checkbox-4589-no-pr";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      // Repo registered but NO PR ever upserted -- getPullRequest resolves null.
      await upsertRepositoryFromGitHub(env, { name: "checkbox-4589-no-pr", full_name: repoFullName, private: false, owner: { login: "JSONbored" } }, 123);
      const posted = { count: 0, body: "" };
      stubCheckboxFetch(6007, "maintainer", "admin", posted);

      await processJob(env, checkboxWebhook(repoFullName, 6007, 906, { login: "maintainer" }));

      expect(posted.count).toBe(0);
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?")
        .bind("github_app.e2e_tests_generation_skipped")
        .first<{ detail: string }>();
      expect(skipped?.detail).toBe("cached_pr_missing");
    });

    it("respects agentPaused — records a skip and never spends an LLM call, even though an authorized maintainer checked the box", async () => {
      const repoFullName = "JSONbored/checkbox-4589-paused";
      const run = vi.fn();
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), AI: { run } as unknown as Ai, GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
      await seedCheckboxPr(env, repoFullName, 6008, "checkbox-4589-paused-sha");
      await upsertRepositorySettings(env, { repoFullName, commentMode: "off", publicSurface: "off", autoLabelEnabled: false, checkRunMode: "off", gateCheckMode: "off", requireLinkedIssue: false, linkedIssueGateMode: "off", manifestPolicyGateMode: "advisory", aiReviewMode: "off", agentPaused: true });
      const posted = { count: 0, body: "" };
      stubCheckboxFetch(6008, "maintainer", "admin", posted);

      await processJob(env, checkboxWebhook(repoFullName, 6008, 907, { login: "maintainer" }));

      expect(run).not.toHaveBeenCalled();
      expect(posted.count).toBe(0);
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?")
        .bind("github_app.e2e_tests_generation_skipped")
        .first<{ detail: string }>();
      expect(skipped?.detail).toBe("agent_paused");
    });

    it("respects agentDryRun — records a skip with detail dry_run (not agent_paused)", async () => {
      const repoFullName = "JSONbored/checkbox-4589-dryrun";
      const run = vi.fn();
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), AI: { run } as unknown as Ai, GITTENSORY_REVIEW_E2E_TESTS: "true", AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
      await seedCheckboxPr(env, repoFullName, 6010, "checkbox-4589-dryrun-sha");
      await upsertRepositorySettings(env, { repoFullName, commentMode: "off", publicSurface: "off", autoLabelEnabled: false, checkRunMode: "off", gateCheckMode: "off", requireLinkedIssue: false, linkedIssueGateMode: "off", manifestPolicyGateMode: "advisory", aiReviewMode: "off", agentDryRun: true });
      const posted = { count: 0, body: "" };
      stubCheckboxFetch(6010, "maintainer", "admin", posted);

      await processJob(env, checkboxWebhook(repoFullName, 6010, 909, { login: "maintainer" }));

      expect(run).not.toHaveBeenCalled();
      expect(posted.count).toBe(0);
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?")
        .bind("github_app.e2e_tests_generation_skipped")
        .first<{ detail: string }>();
      expect(skipped?.detail).toBe("dry_run");
    });

    it("respects the repo's configured commit delivery mode via the checkbox (NOT forced comment-only, unlike the auto-trigger)", async () => {
      const repoFullName = "JSONbored/checkbox-4589-commit";
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: "```typescript\n" + CHECKBOX_TEST_SOURCE + "\n```" }) } as unknown as Ai,
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
      });
      await seedCheckboxPr(env, repoFullName, 6011, "checkbox-4589-commit-sha");
      await upsertRepoFocusManifest(env, repoFullName, {
        testExpectations: ["Run npm run test:ci."],
        features: { e2eTests: true },
        review: { e2e_test_delivery: "commit" },
      });
      const posted = { count: 0, body: "" };
      const gitWrites: string[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "admin" });
        if (url.endsWith("/pulls/6011") && method === "GET") {
          return Response.json({ head: { ref: "feature/checkout-retry", sha: "checkbox-4589-commit-sha", repo: { full_name: repoFullName } } });
        }
        if (url.endsWith("/git/commits/checkbox-4589-commit-sha") && method === "GET") return Response.json({ tree: { sha: "base-tree" } });
        if (url.endsWith("/git/trees") && method === "POST") {
          gitWrites.push("tree");
          return Response.json({ sha: "new-tree" });
        }
        if (url.endsWith("/git/commits") && method === "POST") {
          gitWrites.push("commit");
          return Response.json({ sha: "new-commit" });
        }
        if (method === "PATCH") {
          gitWrites.push("ref");
          return Response.json({});
        }
        if (url.includes("/issues/6011/comments") && method === "GET") return Response.json([]);
        if (url.includes("/issues/6011/comments") && method === "POST") {
          posted.count += 1;
          posted.body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          return Response.json({ id: 60110 });
        }
        return new Response("not found", { status: 404 });
      });

      await processJob(env, checkboxWebhook(repoFullName, 6011, 910, { login: "maintainer" }));

      expect(gitWrites).toEqual(["tree", "commit", "ref"]);
      expect(posted.count).toBe(1);
      expect(posted.body).toContain("pushed as a commit");
    });

    it("renders the checkbox (and the Test coverage collapsible) in the main review comment for a detected contributor missing tests", async () => {
      const repoFullName = "JSONbored/checkbox-4589-full-panel";
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        GITTENSORY_REVIEW_E2E_TESTS: "true",
        // The checkbox/collapsible only render via the CONVERGED comment builder (buildUnifiedCommentBody);
        // the legacy buildPublicPrIntelligenceComment path has neither and must be opted out of here too.
        GITTENSORY_REVIEW_UNIFIED_COMMENT: "true",
      });
      const slash = repoFullName.indexOf("/");
      await upsertRepositoryFromGitHub(env, { name: repoFullName.slice(slash + 1), full_name: repoFullName, private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName,
        commentMode: "detected_contributors_only",
        publicAudienceMode: "gittensor_only",
        publicSurface: "comment_and_label",
        autoLabelEnabled: false,
        checkRunMode: "off",
        // gateCheckMode MUST be "enabled" (not "off") -- maybePublishPrPublicSurface only takes the UNIFIED
        // renderer branch when BOTH unifiedCommentAllowed AND gateEvaluation are truthy; gateEvaluation is
        // never computed at all when the gate is off, silently falling back to the legacy panel (which has
        // neither the Test coverage collapsible nor the generate-tests checkbox). Mirrors the settings shape
        // of the pre-existing "renders the unified PR-review comment..." test above.
        gateCheckMode: "enabled", reviewCheckMode: "required",
        requireLinkedIssue: false,
        linkedIssueGateMode: "off",
        manifestPolicyGateMode: "advisory",
        aiReviewMode: "off",
        typeLabelsEnabled: false,
      });
      await upsertRepoFocusManifest(env, repoFullName, { testExpectations: ["Run npm run test:ci."], features: { e2eTests: true, unifiedComment: true } });
      // gateEvaluation needs a resolved CI aggregate (mocking the module function directly is far simpler than
      // stubbing every raw status/check-suite endpoint the live CI aggregator would otherwise call) -- but
      // NOT "passed": resolveManifestPassedValidationCount treats a fully-green live CI rollup as validation
      // evidence in its own right (`liveCi.ciState === "passed" ? 1 : 0`), which would satisfy
      // manifest_missing_tests's own passedValidationCount check and suppress the very finding this test needs
      // to fire. "pending" still lets the gate resolve a verdict without smuggling in validation evidence.
      const liveCiSpy = vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
        ciState: "pending",
        hasPending: true,
        hasVisiblePending: true,
        hasMissingRequiredContext: false,
        failingDetails: [],
        nonRequiredFailingDetails: [],
        ciCompletenessWarning: null,
      });
      const posted = { count: 0, body: "" };
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url === "https://api.gittensor.io/miners")
          return Response.json([
            { uid: 9, githubUsername: "contributor", githubId: "321", totalPrs: 5, totalMergedPrs: 4, totalOpenPrs: 1, totalClosedPrs: 0, totalOpenIssues: 0, totalClosedIssues: 0, totalSolvedIssues: 0, totalValidSolvedIssues: 0, isEligible: true, credibility: 1, eligibleRepoCount: 1 },
          ]);
        if (url === "https://api.gittensor.io/miners/321") return Response.json({ repositories: [{ repositoryFullName: repoFullName, totalPrs: "5", totalMergedPrs: "4", totalOpenPrs: "1", totalClosedPrs: "0", totalOpenIssues: "0", totalClosedIssues: "0", isEligible: true, credibility: "1.000000" }] });
        if (url === "https://api.gittensor.io/miners/321/prs") return Response.json([]);
        if (url === "https://mirror.gittensor.io/api/v1/miners/321/issues") return Response.json({ issues: [] });
        if (url.endsWith("/users/contributor")) return Response.json({ login: "contributor", public_repos: 2, followers: 1 });
        if (url.includes("/users/contributor/repos")) return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/pulls/6012/files")) return Response.json([{ filename: "src/checkout.ts", additions: 3, deletions: 0, status: "modified" }]);
        if (/\/pulls\/6012(?:\?|$)/.test(url)) return Response.json({ number: 6012, mergeable_state: "clean" });
        // Gate check-run — must succeed so gateEvaluation is produced and the unified-renderer branch runs.
        if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 950 }, { status: 201 });
        if (url.includes("/check-runs/950") && method === "PATCH") return Response.json({ id: 950 });
        // Stateful comment store (mirrors the retrigger tests' own GET-finds-the-prior-POST pattern): the
        // FIRST GET finds nothing (posts a fresh comment), every SUBSequent GET/PATCH finds and updates the
        // SAME row -- a stub that always returns [] on GET would make the code re-POST on every update
        // attempt instead of PATCHing, inflating posted.count for reasons unrelated to this test.
        if (url.includes(`/issues/6012/comments`) && method === "GET") {
          return Response.json(posted.count > 0 ? [{ id: 60120, body: posted.body, user: { login: "gittensory[bot]", type: "Bot" } }] : []);
        }
        if (url.includes(`/issues/6012/comments`) && method === "POST") {
          posted.count += 1;
          posted.body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          return Response.json({ id: 60120 }, { status: 201 });
        }
        if (url.includes(`/issues/comments/60120`) && method === "PATCH") {
          posted.body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
          return Response.json({ id: 60120 });
        }
        return new Response("not found", { status: 404 });
      });

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "checkbox-4589-full-panel",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: {
            id: 123,
            account: { login: "JSONbored", id: 1, type: "User" },
            repository_selection: "selected",
            permissions: { metadata: "read", pull_requests: "read", issues: "write", checks: "write" },
            events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
          },
          repository: { name: repoFullName.slice(slash + 1), full_name: repoFullName, private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 6012, title: "Add retry to checkout", state: "open", user: { login: "contributor" }, head: { sha: "checkbox-4589-full-panel-sha" }, labels: [], body: "No validation evidence mentioned here." },
        },
      } as unknown as Parameters<typeof processJob>[1]);

      expect(liveCiSpy).toHaveBeenCalled();
      expect(posted.count).toBeGreaterThan(0);
      expect(posted.body).toContain("<details><summary><b>Test coverage</b></summary>");
      expect(posted.body).toContain("No changed test files or passing validation evidence were detected for this PR.");
      expect(posted.body).toContain("- [ ] <!-- gittensory-generate-tests:v1 --> **[BETA]** Generate an AI Playwright test for this PR");
    });

    it("handles a sparse payload with no repository, sender, or issue without throwing", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await expect(
        processJob(env, {
          type: "github-webhook",
          deliveryId: "checkbox-4589-sparse",
          eventName: "issue_comment",
          payload: {
            action: "edited",
            comment: { id: 999, body: CHECKED_GENERATE_TESTS_PANEL, user: { login: "gittensory[bot]", type: "Bot" } },
            sender: undefined,
          },
        } as unknown as Parameters<typeof processJob>[1]),
      ).resolves.not.toThrow();
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?")
        .bind("github_app.e2e_tests_generation_skipped")
        .first<{ detail: string }>();
      expect(skipped?.detail).toBe("missing_repo_pr_or_installation");
    });

    it("treats a non-Bot sender whose login merely ends in '[bot]' as a bot author (spoofing guard)", async () => {
      const repoFullName = "JSONbored/checkbox-4589-bot-suffix";
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedCheckboxPr(env, repoFullName, 6013, "checkbox-4589-bot-suffix-sha");
      const posted = { count: 0, body: "" };
      stubCheckboxFetch(6013, "impersonator[bot]", "admin", posted);

      await processJob(env, checkboxWebhook(repoFullName, 6013, 911, { login: "impersonator[bot]", type: "User" }));

      expect(posted.count).toBe(0);
      const skipped = await env.DB.prepare("select detail from audit_events where event_type = ?")
        .bind("github_app.e2e_tests_generation_skipped")
        .first<{ detail: string }>();
      expect(skipped?.detail).toBe("bot_author");
    });
  });

  it("ops-alerts job no-ops when GITTENSORY_REVIEW_OPS is OFF (does no anomaly scan)", async () => {
    const env = createTestEnv(); // flag unset → OFF
    await env.DB.prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, ?, ?, 1, 1)")
      .bind("owner/repo", "owner", "repo")
      .run();
    // Seed a gate false-positive anomaly that WOULD fire if the scan ran.
    for (let i = 1; i <= 6; i += 1) {
      await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: i, blockerCodes: ["missing_linked_issue"] });
      await upsertPullRequestFromGitHub(env, "owner/repo", { number: i, title: `PR ${i}`, state: "closed", merged_at: i <= 4 ? "2026-06-01T00:00:00.000Z" : null } as never);
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await processJob(env, { type: "ops-alerts", requestedBy: "test" });
    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("ops_anomaly"))).toBe(false);
    warn.mockRestore();
  });

  it("ops-alerts job runs the anomaly scan when GITTENSORY_REVIEW_OPS is ON", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_OPS: "true" });
    await env.DB.prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, ?, ?, 1, 1)")
      .bind("owner/repo", "owner", "repo")
      .run();
    for (let i = 1; i <= 6; i += 1) {
      await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: i, blockerCodes: ["missing_linked_issue"] });
      await upsertPullRequestFromGitHub(env, "owner/repo", { number: i, title: `PR ${i}`, state: "closed", merged_at: i <= 4 ? "2026-06-01T00:00:00.000Z" : null } as never);
    }
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await processJob(env, { type: "ops-alerts", requestedBy: "test" });
    expect(errors.mock.calls.map((c) => String(c[0])).some((line) => line.includes("ops_anomaly") && line.includes("owner/repo"))).toBe(true);
    errors.mockRestore();
  });

  it("sweep-liveness-watchdog job no-ops when GITTENSORY_SWEEP_WATCHDOG is OFF (does no scan, no re-enqueue)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue }); // flag unset → OFF
    await upsertRepositoryFromGitHub(env, { name: "stale-repo", full_name: "owner/stale-repo", private: false, owner: { login: "owner" } }, 9310);
    await upsertRepositorySettings(env, { repoFullName: "owner/stale-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/stale-repo", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });

    await processJob(env, { type: "sweep-liveness-watchdog", requestedBy: "test" });

    expect(sent).toEqual([]);
  });

  it("sweep-liveness-watchdog job runs the liveness scan and re-enqueues a stale repo when GITTENSORY_SWEEP_WATCHDOG is ON", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ GITTENSORY_SWEEP_WATCHDOG: "true", JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "stale-repo", full_name: "owner/stale-repo", private: false, owner: { login: "owner" } }, 9311);
    await upsertRepositorySettings(env, { repoFullName: "owner/stale-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/stale-repo", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });

    await processJob(env, { type: "sweep-liveness-watchdog", requestedBy: "test" });

    expect(sent).toEqual([expect.objectContaining({ type: "agent-regate-sweep", repoFullName: "owner/stale-repo", installationId: 9311 })]);
  });

  it("reconcile-open-prs job no-ops when GITTENSORY_PR_RECONCILIATION is OFF (does no scan)", async () => {
    const env = createTestEnv(); // flag unset → OFF
    await upsertRepositoryFromGitHub(env, { name: "stale-repo", full_name: "owner/stale-repo", private: false, owner: { login: "owner" } }, 9410);
    await upsertRepositorySettings(env, { repoFullName: "owner/stale-repo", autonomy: { merge: "auto" } });
    const reconcileSpy = vi.spyOn(backfillModule, "reconcileOpenPullRequests");

    await processJob(env, { type: "reconcile-open-prs", requestedBy: "test" });

    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("reconcile-open-prs job runs the reconciliation scan when GITTENSORY_PR_RECONCILIATION is ON", async () => {
    const env = createTestEnv({ GITTENSORY_PR_RECONCILIATION: "true" });
    await upsertRepositoryFromGitHub(env, { name: "stale-repo", full_name: "owner/stale-repo", private: false, owner: { login: "owner" } }, 9411);
    await upsertRepositorySettings(env, { repoFullName: "owner/stale-repo", autonomy: { merge: "auto" } });
    const reconcileSpy = vi.spyOn(backfillModule, "reconcileOpenPullRequests").mockResolvedValue({ repoFullName: "owner/stale-repo", remoteOpenCount: 0, localOpenCount: 0, missingNumbers: [] });

    await processJob(env, { type: "reconcile-open-prs", requestedBy: "test" });

    expect(reconcileSpy).toHaveBeenCalledWith(env, "owner/stale-repo");
    reconcileSpy.mockRestore();
  });

  describe("type label decoupling (#label-decoupling)", () => {
    function stubTypeLabelFetch(prNumber: number, seen: { posted: string[]; removed: string[]; checkRunCreated: boolean }) {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes(`/commits/`) && url.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/check-runs") && method === "POST") {
          seen.checkRunCreated = true;
          return Response.json({ id: 9001 }, { status: 201 });
        }
        if (url.includes("/check-runs/") && method === "PATCH") return Response.json({ id: 9001 });
        if (url.includes(`/issues/${prNumber}/labels`) && method === "GET") return Response.json([]);
        if (url.includes(`/issues/${prNumber}/labels`) && method === "POST") {
          seen.posted.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[]));
          return Response.json([]);
        }
        if (url.includes(`/issues/${prNumber}/labels/`) && method === "DELETE") {
          seen.removed.push(decodeURIComponent(url.split(`/issues/${prNumber}/labels/`)[1] ?? ""));
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/labels") && method === "POST") return Response.json({ name: JSON.parse(String(init?.body ?? "{}")).name }, { status: 201 });
        if (url.includes(`/issues/${prNumber}/comments`) && method === "GET") return Response.json([]);
        if (url.includes(`/issues/${prNumber}/comments`) && method === "POST") return Response.json({ id: 1 }, { status: 201 });
        return new Response("not found", { status: 404 });
      });
    }

    // Fails only the ONE audit_events insert whose bound values include `needle` (e.g. a specific
    // eventType), leaving every other audit write in the same job untouched -- a blanket "throw on any
    // audit_events insert" (as the sibling #orb-ci-stuck-repeat fail-open tests use for a narrower job
    // type) breaks unrelated earlier writes on the fuller pull_request webhook path used here.
    function failAuditEventInsertsContaining(env: Env, needle: string) {
      const realPrepare = env.DB.prepare.bind(env.DB);
      env.DB.prepare = ((sql: string) => {
        const statement = realPrepare(sql);
        if (!/insert\s+into\s+["`]?audit_events["`]?/i.test(sql)) return statement;
        return {
          ...statement,
          bind(...values: unknown[]) {
            const bound = statement.bind(...(values as never[]));
            if (!values.some((value) => typeof value === "string" && value.includes(needle))) return bound;
            return { ...bound, run: () => Promise.reject(new Error("audit write failed")) };
          },
        };
      }) as typeof env.DB.prepare;
    }

    it("applies the type label when oss_maintainer mode + an unconfirmed miner suppress the context label", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "off",
        publicSurface: "label_only",
        publicAudienceMode: "oss_maintainer",
        autoLabelEnabled: true,
        createMissingLabel: false,
        checkRunMode: "off",
        gateCheckMode: "enabled", reviewCheckMode: "required",
        linkedIssueGateMode: "off",
        aiReviewMode: "off",
      });
      await upsertOfficialMinerDetection(env, "contributor", { status: "not_found" }, 60_000);
      const seen = { posted: [] as string[], removed: [] as string[], checkRunCreated: false };
      stubTypeLabelFetch(210, seen);

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "type-label-oss-maintainer-unconfirmed",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 210, title: "fix: broken pagination", state: "open", user: { login: "contributor" }, author_association: "NONE", head: { sha: "sha210" }, labels: [], body: "Fixes #1" },
        },
      });

      expect(seen.posted).toEqual(["gittensor:bug"]);
      expect(seen.removed.sort()).toEqual(["gittensor:feature", "gittensor:priority"]);
    });

    it("keeps gate-only gittensor_only type labels silent until miner confirmation", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "off",
        publicSurface: "off",
        publicAudienceMode: "gittensor_only",
        autoLabelEnabled: false,
        createMissingLabel: false,
        checkRunMode: "off",
        gateCheckMode: "enabled", reviewCheckMode: "required",
        linkedIssueGateMode: "off",
        aiReviewMode: "off",
      });
      const seen = { posted: [] as string[], removed: [] as string[], checkRunCreated: false, minerList: 0 };
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url === "https://api.gittensor.io/miners") {
          seen.minerList += 1;
          return Response.json([]);
        }
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes(`/commits/`) && url.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/check-runs") && method === "POST") {
          seen.checkRunCreated = true;
          return Response.json({ id: 9002 }, { status: 201 });
        }
        if (url.includes("/check-runs/") && method === "PATCH") return Response.json({ id: 9002 });
        if (url.includes(`/issues/218/labels`) && method === "GET") return Response.json([]);
        if (url.includes(`/issues/218/labels`) && method === "POST") {
          seen.posted.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[]));
          return Response.json([]);
        }
        if (url.includes(`/issues/218/labels/`) && method === "DELETE") {
          seen.removed.push(decodeURIComponent(url.split(`/issues/218/labels/`)[1] ?? ""));
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/labels") && method === "POST") return Response.json({ name: JSON.parse(String(init?.body ?? "{}")).name }, { status: 201 });
        return new Response("not found", { status: 404 });
      });

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "type-label-gittensor-only-gate-only-muted",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 218, title: "fix: gate-only silence", state: "open", user: { login: "contributor" }, author_association: "NONE", head: { sha: "sha218" }, labels: [], body: "Fixes #1" },
        },
      });

      expect(seen.minerList).toBe(1);
      expect(seen.checkRunCreated).toBe(true);
      expect(seen.posted).toEqual([]);
      expect(seen.removed).toEqual([]);
    });

    it("still mutes the type label when gittensor_only mode's non-confirmed-miner silence applies, even with the gate enabled", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "all_prs",
        publicSurface: "comment_and_label",
        publicAudienceMode: "gittensor_only",
        autoLabelEnabled: true,
        createMissingLabel: false,
        checkRunMode: "off",
        // The only difference from the pre-existing "keeps GitHub-history-only contributors quiet" test
        // (which has the gate off, so it returns before ever reaching the type-label decision): with the
        // gate ENABLED, the function does NOT bail out early, so this is the only path that actually
        // exercises `decision.skipReason === "not_official_gittensor_miner"` at the type-label gate.
        gateCheckMode: "enabled", reviewCheckMode: "required",
        linkedIssueGateMode: "off",
        aiReviewMode: "off",
      });
      await upsertOfficialMinerDetection(env, "contributor", { status: "not_found" }, 60_000);
      const seen = { posted: [] as string[], removed: [] as string[], checkRunCreated: false };
      stubTypeLabelFetch(217, seen);

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "type-label-gittensor-only-muted",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 217, title: "fix: gittensor_only silence", state: "open", user: { login: "contributor" }, author_association: "NONE", head: { sha: "sha217" }, labels: [], body: "Fixes #1" },
        },
      });

      expect(seen.posted).toEqual([]);
      expect(seen.removed).toEqual([]);
    });

    it("does not apply the type label when typeLabelsEnabled is false, in the same oss_maintainer + unconfirmed-miner scenario", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "off",
        publicSurface: "label_only",
        publicAudienceMode: "oss_maintainer",
        autoLabelEnabled: true,
        typeLabelsEnabled: false,
        createMissingLabel: false,
        checkRunMode: "off",
        gateCheckMode: "enabled", reviewCheckMode: "required",
        linkedIssueGateMode: "off",
        aiReviewMode: "off",
      });
      await upsertOfficialMinerDetection(env, "contributor", { status: "not_found" }, 60_000);
      const seen = { posted: [] as string[], removed: [] as string[], checkRunCreated: false };
      stubTypeLabelFetch(211, seen);

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "type-label-disabled-oss-maintainer-unconfirmed",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 211, title: "fix: broken pagination", state: "open", user: { login: "contributor" }, author_association: "NONE", head: { sha: "sha211" }, labels: [], body: "Fixes #1" },
        },
      });

      expect(seen.posted).toEqual([]);
      expect(seen.removed).toEqual([]);
    });

    it("applies the type label to a maintainer-authored PR even though includeMaintainerAuthors excludes it from the public surface", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "off",
        publicSurface: "label_only",
        autoLabelEnabled: true,
        includeMaintainerAuthors: false,
        createMissingLabel: false,
        checkRunMode: "off",
        gateCheckMode: "enabled", reviewCheckMode: "required",
        linkedIssueGateMode: "off",
        aiReviewMode: "off",
      });
      const seen = { posted: [] as string[], removed: [] as string[], checkRunCreated: false };
      stubTypeLabelFetch(212, seen);

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "type-label-maintainer-author",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 212, title: "fix: internal cleanup", state: "open", user: { login: "org-member" }, author_association: "MEMBER", head: { sha: "sha212" }, labels: [], body: "Internal." },
        },
      });

      expect(seen.posted).toEqual(["gittensor:bug"]);
      expect(seen.posted).not.toContain("gittensor");
    });

    it("applies the type label to a bot-authored PR and keeps the three type labels mutually exclusive", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "off",
        publicSurface: "label_only",
        autoLabelEnabled: true,
        createMissingLabel: false,
        checkRunMode: "off",
        gateCheckMode: "enabled", reviewCheckMode: "required",
        linkedIssueGateMode: "off",
        aiReviewMode: "off",
      });
      const seen = { posted: [] as string[], removed: [] as string[], checkRunCreated: false };
      stubTypeLabelFetch(213, seen);

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "type-label-bot-author",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 213, title: "feat: add retry backoff", state: "open", user: { login: "renovate[bot]", type: "Bot" }, head: { sha: "sha213" }, labels: [], body: "Automated." },
        },
      });

      expect(seen.posted).toEqual(["gittensor:feature"]);
      expect(seen.removed.sort()).toEqual(["gittensor:bug", "gittensor:priority"]);
    });

    it("cleans up an arbitrary configured custom category alongside bug/feature/priority (#label-modularity)", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "off",
        publicSurface: "label_only",
        autoLabelEnabled: true,
        createMissingLabel: false,
        checkRunMode: "off",
        gateCheckMode: "enabled", reviewCheckMode: "required",
        linkedIssueGateMode: "off",
        aiReviewMode: "off",
        // A self-host taxonomy well beyond the built-in bug/feature/priority triad (#label-modularity):
        // `security` is a registered category with no title-classification rule of its own, so it is
        // never CHOSEN here, but it must still be a cleanup CANDIDATE (never left dangling on a PR whose
        // classification moved elsewhere) exactly like the built-in categories.
        typeLabels: { bug: "gittensor:bug", feature: "gittensor:feature", priority: "gittensor:priority", security: "area:security" },
      });
      const seen = { posted: [] as string[], removed: [] as string[], checkRunCreated: false };
      stubTypeLabelFetch(218, seen);

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "type-label-custom-category-cleanup",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 218, title: "feat: add retry backoff", state: "open", user: { login: "renovate[bot]", type: "Bot" }, head: { sha: "sha218" }, labels: [], body: "Automated." },
        },
      });

      expect(seen.posted).toEqual(["gittensor:feature"]);
      expect(seen.removed.sort()).toEqual(["area:security", "gittensor:bug", "gittensor:priority"]);
    });

    it("applies the type label when publicSurface: comment_only makes the base context label structurally impossible", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "off",
        publicSurface: "comment_only",
        autoLabelEnabled: true,
        createMissingLabel: false,
        checkRunMode: "off",
        gateCheckMode: "enabled", reviewCheckMode: "required",
        linkedIssueGateMode: "off",
        aiReviewMode: "off",
      });
      const seen = { posted: [] as string[], removed: [] as string[], checkRunCreated: false };
      stubTypeLabelFetch(214, seen);

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "type-label-comment-only-surface",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 214, title: "fix: comment-only regression", state: "open", user: { login: "contributor" }, author_association: "NONE", head: { sha: "sha214" }, labels: [], body: "Fixes #1" },
        },
      });

      expect(seen.posted).toEqual(["gittensor:bug"]);
    });

    it("typeLabelsEnabled: false does not suppress the base context label for a confirmed contributor", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "off",
        publicSurface: "label_only",
        autoLabelEnabled: true,
        typeLabelsEnabled: false,
        createMissingLabel: false,
        checkRunMode: "off",
        gateCheckMode: "enabled", reviewCheckMode: "required",
        linkedIssueGateMode: "off",
        aiReviewMode: "off",
      });
      await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
      const seen = { posted: [] as string[], removed: [] as string[], checkRunCreated: false };
      stubTypeLabelFetch(215, seen);

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "type-label-disabled-confirmed-contributor",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 215, title: "fix: confirmed contributor path", state: "open", user: { login: "contributor" }, author_association: "NONE", head: { sha: "sha215" }, labels: [], body: "Fixes #1" },
        },
      });

      expect(seen.posted).toEqual(["gittensor"]);
    });

    it("posts the Gittensory Context check run independently of both label families being off, with zero label writes", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "off",
        publicSurface: "off",
        autoLabelEnabled: false,
        typeLabelsEnabled: false,
        checkRunMode: "enabled",
        gateCheckMode: "off",
        linkedIssueGateMode: "off",
        aiReviewMode: "off",
      });
      await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
      const seen = { posted: [] as string[], removed: [] as string[], checkRunCreated: false };
      stubTypeLabelFetch(216, seen);

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "type-label-checkrun-independent",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 216, title: "fix: check-run independence", state: "open", user: { login: "contributor" }, author_association: "NONE", head: { sha: "sha216" }, labels: [], body: "Fixes #1" },
        },
      });

      expect(seen.checkRunCreated).toBe(true);
      expect(seen.posted).toEqual([]);
      expect(seen.removed).toEqual([]);
    });

    function stubPropagationFetch(
      prNumber: number,
      linkedIssueNumber: number,
      seen: { posted: string[]; removed: string[]; issueFetches: number },
      linkedIssueResponse: () => Response,
    ) {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes(`/commits/`) && url.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 9001 }, { status: 201 });
        if (url.includes("/check-runs/") && method === "PATCH") return Response.json({ id: 9001 });
        if (url.endsWith(`/issues/${linkedIssueNumber}`) && method === "GET") {
          seen.issueFetches += 1;
          return linkedIssueResponse();
        }
        if (url.includes(`/issues/${prNumber}/labels`) && method === "GET") return Response.json([]);
        if (url.includes(`/issues/${prNumber}/labels`) && method === "POST") {
          seen.posted.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[]));
          return Response.json([]);
        }
        if (url.includes(`/issues/${prNumber}/labels/`) && method === "DELETE") {
          seen.removed.push(decodeURIComponent(url.split(`/issues/${prNumber}/labels/`)[1] ?? ""));
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/labels") && method === "POST") return Response.json({ name: JSON.parse(String(init?.body ?? "{}")).name }, { status: 201 });
        if (url.includes(`/issues/${prNumber}/comments`)) return Response.json([]);
        return new Response("not found", { status: 404 });
      });
    }

    it("applies the configured priority label when a linked issue already carries the configured issue label (#priority-linked-issue-gate)", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "off",
        publicSurface: "label_only",
        autoLabelEnabled: true,
        createMissingLabel: false,
        checkRunMode: "off",
        gateCheckMode: "enabled", reviewCheckMode: "required",
        linkedIssueGateMode: "off",
        aiReviewMode: "off",
        linkedIssueLabelPropagation: {
          enabled: true,
          mode: "exclusive_type_label",
          mappings: [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: true }],
        },
      });
      const seen = { posted: [] as string[], removed: [] as string[], issueFetches: 0 };
      stubPropagationFetch(220, 1, seen, () => Response.json({ number: 1, state: "open", user: { login: "contributor" }, labels: ["gittensor:priority"] }));

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "priority-propagation-applied",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 220, title: "fix: some bug", state: "open", user: { login: "contributor" }, author_association: "NONE", head: { sha: "sha220" }, labels: [], body: "Fixes #1" },
        },
      });

      // JSONbored/gittensory falls back to its own bundled manifest (GITTENSORY_REPO_FOCUS_MANIFEST_YAML) when
      // no other manifest source responds, which REPLACES this test's DB-configured single-mapping override
      // with its own bug/feature (exclusive) + priority (additive) mapping list -- so the linked issue's
      // gittensor:priority label composes with the title-derived "fix" -> gittensor:bug, rather than replacing
      // it. Priority is additive (not a type of its own; see resolvePrTypeLabel's composition fix), so bug
      // still applies from the title and only feature (never matched) needs removing.
      expect(seen.issueFetches).toBe(1);
      expect(seen.posted).toEqual(["gittensor:bug", "gittensor:priority"]);
      expect(seen.removed).toEqual(["gittensor:feature"]);
    });

    it("REGRESSION (#4528, PR #4494 shape): keeps the propagated labels on the PR's own merge-closed webhook, instead of falling back to the title guess", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositoryFromGitHub(env, { name: "widget", full_name: "acme/widget", private: false, owner: { login: "acme" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "acme/widget",
        commentMode: "off",
        publicSurface: "label_only",
        autoLabelEnabled: true,
        createMissingLabel: false,
        checkRunMode: "off",
        gateCheckMode: "off",
        reviewCheckMode: "disabled",
        linkedIssueGateMode: "off",
        aiReviewMode: "off",
        // Real-world shape: the type-label decision runs regardless of the check-run/gate publish mode, but
        // the SURROUNDING function only reaches that far for an already-closed PR when the agent layer is
        // configured (autonomyNeedsGateEvaluation) -- an unconfigured repo's closed-PR pass has nothing else
        // to do and bails before the label block. `label: "auto"` is the minimal opt-in that reproduces this
        // without pulling in merge/close autonomy's own CI-wait/rebase machinery.
        autonomy: { label: "auto" },
        linkedIssueLabelPropagation: {
          enabled: true,
          mode: "exclusive_type_label",
          mappings: [
            { issueLabel: "gittensor:feature", prLabel: "gittensor:feature", removeOtherTypeLabels: true },
            { issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: false },
          ],
        },
      });
      const seen = { posted: [] as string[], removed: [] as string[], issueFetches: 0 };
      // The linked issue is CLOSED, at a timestamp at/after this PR's own merge -- GitHub's standard "Closes #N"
      // auto-close, fired by this very merge. Title deliberately uses a verb ("fold") absent from the
      // feature-action-verb whitelist, so a title-only fallback would misclassify this as gittensor:bug --
      // this only stays gittensor:feature/gittensor:priority if the merge-closed issue is still trusted.
      stubPropagationFetch(4494, 4279, seen, () =>
        Response.json({
          number: 4279,
          state: "closed",
          closed_at: "2026-07-09T22:15:14Z",
          user: { login: "contributor" },
          labels: ["gittensor:feature", "gittensor:priority"],
        }),
      );

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "merge-close-race-4528",
        eventName: "pull_request",
        payload: {
          action: "closed",
          installation: { id: 123, account: { login: "acme", id: 1, type: "User" } },
          repository: { name: "widget", full_name: "acme/widget", private: false, owner: { login: "acme" } },
          pull_request: {
            number: 4494,
            title: "feat(x): fold run-state into the status panel",
            state: "closed",
            merged_at: "2026-07-09T22:15:13Z",
            user: { login: "contributor" },
            author_association: "NONE",
            head: { sha: "sha4494" },
            labels: [],
            body: "Closes #4279",
          },
        },
      });

      expect(seen.issueFetches).toBe(1);
      expect(seen.posted.sort()).toEqual(["gittensor:feature", "gittensor:priority"]);
      expect(seen.removed).toEqual(["gittensor:bug"]);
    });

    it("fails open to the normal title-based label when the linked issue's fetch fails (#priority-linked-issue-gate)", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "off",
        publicSurface: "label_only",
        autoLabelEnabled: true,
        createMissingLabel: false,
        checkRunMode: "off",
        gateCheckMode: "enabled", reviewCheckMode: "required",
        linkedIssueGateMode: "off",
        aiReviewMode: "off",
        linkedIssueLabelPropagation: {
          enabled: true,
          mode: "exclusive_type_label",
          mappings: [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: true }],
        },
      });
      const seen = { posted: [] as string[], removed: [] as string[], issueFetches: 0 };
      stubPropagationFetch(221, 1, seen, () => new Response("server error", { status: 500 }));

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "priority-propagation-fetch-failed",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 221, title: "fix: some bug", state: "open", user: { login: "contributor" }, author_association: "NONE", head: { sha: "sha221" }, labels: [], body: "Fixes #1" },
        },
      });

      expect(seen.issueFetches).toBe(1);
      expect(seen.posted).toEqual(["gittensor:bug"]);
      expect(seen.removed.sort()).toEqual(["gittensor:feature", "gittensor:priority"]);
    });

    it("never fetches a linked issue and keeps normal behavior when propagation is left at its default (disabled) (#priority-linked-issue-gate)", async () => {
      // Deliberately NOT "JSONbored/gittensory" (unlike its two sibling tests above): this repo's own
      // `.gittensory.yml` now enables propagation for itself (#priority-linked-issue-gate-ownership
      // dogfooding), and `resolveRepositorySettings` falls back to the bundled
      // `GITTENSORY_REPO_FOCUS_MANIFEST_YAML` copy of it whenever a live manifest fetch is unavailable
      // (`isGittensorySelfRepo`, `src/signals/focus-manifest-loader.ts`) -- exactly the case in this test's
      // stubbed fetch. Using gittensory's own literal repo name here would make this "propagation is off by
      // DEFAULT" test silently stop being a default-behavior test at all.
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositoryFromGitHub(env, { name: "widget", full_name: "acme/widget", private: false, owner: { login: "acme" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "acme/widget",
        commentMode: "off",
        publicSurface: "label_only",
        autoLabelEnabled: true,
        createMissingLabel: false,
        checkRunMode: "off",
        gateCheckMode: "enabled", reviewCheckMode: "required",
        linkedIssueGateMode: "off",
        aiReviewMode: "off",
        // linkedIssueLabelPropagation intentionally omitted -- defaults to disabled.
      });
      const seen = { posted: [] as string[], removed: [] as string[], issueFetches: 0 };
      stubPropagationFetch(222, 1, seen, () => Response.json({ number: 1, state: "open", labels: ["gittensor:priority"] }));

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "priority-propagation-disabled-noop",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "acme", id: 1, type: "User" } },
          repository: { name: "widget", full_name: "acme/widget", private: false, owner: { login: "acme" } },
          pull_request: { number: 222, title: "fix: some bug", state: "open", user: { login: "contributor" }, author_association: "NONE", head: { sha: "sha222" }, labels: [], body: "Fixes #1" },
        },
      });

      expect(seen.issueFetches).toBe(0);
      expect(seen.posted).toEqual(["gittensor:bug"]);
      expect(seen.removed.sort()).toEqual(["gittensor:feature", "gittensor:priority"]);
    });

    it("records the audit event for a normal applied label decision (#label-decoupling audit)", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "off",
        publicSurface: "label_only",
        autoLabelEnabled: true,
        createMissingLabel: false,
        checkRunMode: "off",
        gateCheckMode: "enabled", reviewCheckMode: "required",
        linkedIssueGateMode: "off",
        aiReviewMode: "off",
      });
      const seen = { posted: [] as string[], removed: [] as string[], checkRunCreated: false };
      stubTypeLabelFetch(219, seen);

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "type-label-recorded",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 219, title: "fix: broken pagination", state: "open", user: { login: "contributor" }, author_association: "NONE", head: { sha: "sha219" }, labels: [], body: "Fixes #1" },
        },
      });

      expect(seen.posted).toEqual(["gittensor:bug"]);
      const labelEvent = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.type_label_decision", "JSONbored/gittensory#219")
        .first<{ outcome: string; detail: string }>();
      expect(labelEvent?.outcome).toBe("completed");
      expect(labelEvent?.detail).toBe("applied labels: gittensor:bug");
    });

    it("does not let a failing audit write stop label application (completed outcome, fail-open)", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "off",
        publicSurface: "label_only",
        autoLabelEnabled: true,
        createMissingLabel: false,
        checkRunMode: "off",
        gateCheckMode: "enabled", reviewCheckMode: "required",
        linkedIssueGateMode: "off",
        aiReviewMode: "off",
      });
      const seen = { posted: [] as string[], removed: [] as string[], checkRunCreated: false };
      stubTypeLabelFetch(220, seen);
      failAuditEventInsertsContaining(env, "github_app.type_label_decision");

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "type-label-completed-audit-fail",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 220, title: "fix: broken pagination", state: "open", user: { login: "contributor" }, author_association: "NONE", head: { sha: "sha220" }, labels: [], body: "Fixes #1" },
        },
      });

      // The label application itself must complete even though its audit-event write threw.
      expect(seen.posted).toEqual(["gittensor:bug"]);
    });

    it("does not let a failing audit write stop the decision when type labels are disabled (denied outcome, fail-open)", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "JSONbored/gittensory",
        commentMode: "off",
        publicSurface: "off",
        autoLabelEnabled: true,
        typeLabelsEnabled: false,
        createMissingLabel: false,
        checkRunMode: "off",
        gateCheckMode: "enabled", reviewCheckMode: "required",
        linkedIssueGateMode: "off",
        aiReviewMode: "off",
      });
      const seen = { posted: [] as string[], removed: [] as string[], checkRunCreated: false };
      stubTypeLabelFetch(221, seen);
      failAuditEventInsertsContaining(env, "github_app.type_label_decision");

      // Fail-open: the webhook job must still complete (and still reach the type-label decision) even
      // though recording it fails.
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "type-label-denied-audit-fail",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 221, title: "fix: broken pagination", state: "open", user: { login: "contributor" }, author_association: "NONE", head: { sha: "sha221" }, labels: [], body: "Fixes #1" },
        },
      });
      expect(seen.posted).toEqual([]);
    });
  });
});
