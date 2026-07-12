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

  async function cachedSubFloorDefectFingerprint(title: string): Promise<string> {
    return aiReviewCacheInputFingerprint({
      title,
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
      reviewerPlan: undefined,
      selfHostProviderConfig: null,
      selfHostAiModelOverride: { claudeModel: null, claudeEffort: null, codexModel: null, codexEffort: null, ollamaModel: null, openaiModel: null, openaiCompatibleModel: null, anthropicModel: null },
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
      features: { grounding: false, rag: false, enrichment: false, reputation: false, cultureProfile: false, impactMap: false },
    });
  }

  it("#4603: a sub-floor cached ai_consensus_defect under hold_for_review (default) still fails the gate but does NOT one-shot-close", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    // aiReviewLowConfidenceDisposition left UNSET — the shipped default (hold_for_review) is what's under test.
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { close: "auto" }, aiReviewMode: "block", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 8, title: "Sub-floor defect PR", state: "open", user: { login: "contributor" }, head: { sha: "b8" }, labels: [], body: "Closes #1" });
    await upsertPullRequestFile(env, { repoFullName: "owner/agent-repo", pullNumber: 8, path: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, payload: { patch: "@@\n+export const ok = value.length;" } });
    const inputFingerprint = await cachedSubFloorDefectFingerprint("Sub-floor defect PR");
    await putCachedAiReview(env, "owner/agent-repo", 8, "b8", "block", {
      notes: "cached review",
      reviewerCount: 2,
      // 0.3 is well below the default 0.93 close-confidence floor.
      findings: [{ code: "ai_consensus_defect", severity: "critical", title: "Cached defect", detail: "Cached critical defect.", confidence: 0.3 }],
      metadata: { inputFingerprint },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/8/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = value.length;" }]);
      if (url.endsWith("/pulls/8") && init?.method === "PATCH") return Response.json({ number: 8, state: "closed" });
      if (url.endsWith("/pulls/8")) return Response.json({ number: 8, title: "Sub-floor defect PR", state: "open", user: { login: "contributor" }, head: { sha: "b8" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/b8/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/b8/status")) return Response.json({ state: "success", statuses: [] });
      if (url.endsWith("/pulls/8/reviews") && init?.method === "POST") return Response.json({ id: 1 });
      if (url.endsWith("/pulls/8/reviews")) return Response.json([]);
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await sweepAndDrainPerPr(env, "owner/agent-repo");

    expect(aiCalls).toBe(0); // the cached AI review was reused — the LLM was never called for this head SHA
    // The gate still failed on the AI-judgment blocker (the merge stays blocked).
    const blocker = await env.DB.prepare("select blocker_codes_json from gate_outcomes where repo_full_name = ? and pull_number = ? order by rowid desc limit 1").bind("owner/agent-repo", 8).first<{ blocker_codes_json: string }>();
    expect(blocker?.blocker_codes_json).toContain("ai_consensus_defect");
    // But it was NOT one-shot-closed -- the hold suppressed the close autonomy would otherwise have taken.
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and detail like ?").bind("agent.action.close", "%closed%").first<{ n: number }>();
    expect(closeAudit?.n).toBe(0);
    const pr8 = await getPullRequest(env, "owner/agent-repo", 8);
    expect(pr8?.state).toBe("open");
  });

  it("#4603: the SAME sub-floor defect one-shot-closes when aiReviewLowConfidenceDisposition is explicitly one_shot", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write" }, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { close: "auto" }, aiReviewMode: "block", aiReviewLowConfidenceDisposition: "one_shot", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 9, title: "Sub-floor defect PR (one_shot)", state: "open", user: { login: "contributor" }, head: { sha: "c9" }, labels: [], body: "Closes #1" });
    await upsertPullRequestFile(env, { repoFullName: "owner/agent-repo", pullNumber: 9, path: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, payload: { patch: "@@\n+export const ok = value.length;" } });
    const inputFingerprint = await cachedSubFloorDefectFingerprint("Sub-floor defect PR (one_shot)");
    await putCachedAiReview(env, "owner/agent-repo", 9, "c9", "block", {
      notes: "cached review",
      reviewerCount: 2,
      findings: [{ code: "ai_consensus_defect", severity: "critical", title: "Cached defect", detail: "Cached critical defect.", confidence: 0.3 }],
      metadata: { inputFingerprint },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/9/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = value.length;" }]);
      if (url.endsWith("/pulls/9") && init?.method === "PATCH") return Response.json({ number: 9, state: "closed" });
      if (url.endsWith("/pulls/9")) return Response.json({ number: 9, title: "Sub-floor defect PR (one_shot)", state: "open", user: { login: "contributor" }, head: { sha: "c9" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/c9/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/c9/status")) return Response.json({ state: "success", statuses: [] });
      if (url.endsWith("/pulls/9/reviews") && init?.method === "POST") return Response.json({ id: 1 });
      if (url.endsWith("/pulls/9/reviews")) return Response.json([]);
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await sweepAndDrainPerPr(env, "owner/agent-repo");

    expect(aiCalls).toBe(0);
    const blocker = await env.DB.prepare("select blocker_codes_json from gate_outcomes where repo_full_name = ? and pull_number = ? order by rowid desc limit 1").bind("owner/agent-repo", 9).first<{ blocker_codes_json: string }>();
    expect(blocker?.blocker_codes_json).toContain("ai_consensus_defect");
    // one_shot ignores the floor: the close autonomy actually fires this time (contrast with the hold_for_review
    // test above, whose closeAudit count is 0). The PR row's `state` column only flips once GitHub's own
    // `closed` webhook round-trips back through the normal sync path -- a separate delivery this sweep-driven
    // test does not simulate (see the identical gap documented at this file's #linked-issue-hard-rule-persistence
    // two-pass test), so the disposition planner's own audit record is the observable proof instead.
    const close = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? order by rowid desc limit 1").bind("agent.action.close").first<{ outcome: string; detail: string }>();
    expect(close?.outcome).toBe("completed");
  });

  it("posts the 🟪 reviewing placeholder before the AI review runs, then overwrites it with the verdict (#reviewing-placeholder)", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: {
        run: async () => ({ response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }),
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
    const stickyComment: { current: { id: number; body: string } | null } = { current: null };
    let firstWriteWasPlaceholder = false;
    let postCount = 0;
    let patchCount = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/issues/7/comments") && method === "GET") {
        return Response.json(stickyComment.current ? [{ ...stickyComment.current, user: { login: "gittensory[bot]", type: "Bot" } }] : []);
      }
      if (url.includes("/issues/7/comments") && method === "POST") {
        const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        postCount += 1;
        if (postCount === 1) firstWriteWasPlaceholder = body.includes("is reviewing");
        stickyComment.current = { id: 1, body };
        return Response.json({ id: 1 }, { status: 201 });
      }
      if (url.includes("/issues/comments/1") && method === "PATCH") {
        const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        patchCount += 1;
        stickyComment.current = { id: 1, body };
        return Response.json({ id: 1 }, { status: 200 });
      }
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "reviewing-placeholder",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" },
      },
    });

    // The transient purple placeholder is the first write, then the final verdict updates the same sticky comment.
    expect(postCount).toBe(1);
    expect(patchCount).toBeGreaterThanOrEqual(1);
    expect(firstWriteWasPlaceholder).toBe(true);
    expect(stickyComment.current?.body).toContain(PR_PANEL_COMMENT_MARKER);
    expect(stickyComment.current?.body).toContain("Thanks for the contribution");
    expect(stickyComment.current?.body).not.toContain("is reviewing");
  });

  it("flags an open-PR file-path collision against a sibling PR when GITTENSORY_OPEN_PR_FILE_COLLISION is on (#2653)", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      GITTENSORY_OPEN_PR_FILE_COLLISION: "true",
    });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      aiReviewMode: "off",
    });
    // A sibling PR (different author, unrelated title) already open and already detail-synced — its files are
    // in the pull_request_files cache, the same way routine backfill would have populated them.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 8,
      title: "Document logging output",
      state: "open",
      user: { login: "other-author" },
      head: { sha: "b8" },
      labels: [],
      body: "",
    });
    await upsertPullRequestFile(env, { repoFullName: "JSONbored/gittensory", pullNumber: 8, path: "src/shared/util.ts", additions: 1, deletions: 0, changes: 1, payload: {} });
    // The PR under review (#7) was ALSO already detail-synced against the same file before this rerun.
    await upsertPullRequestFile(env, { repoFullName: "JSONbored/gittensory", pullNumber: 7, path: "src/shared/util.ts", additions: 1, deletions: 0, changes: 1, payload: {} });
    const stickyComment: { current: { id: number; body: string } | null } = { current: null };
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
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/shared/util.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Improve widget rendering", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/7/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/7/comments") && method === "POST") {
        const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        stickyComment.current = { id: 1, body };
        return Response.json({ id: 1 }, { status: 201 });
      }
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "open-pr-file-collision",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 7, title: "Improve widget rendering", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "" },
      },
    });

    // The sibling PR #8 (different author, same file, unrelated title) surfaces in the related-work panel —
    // proof the enriched changedFiles flowed through buildCollisionReport's existing termOverlap scoring.
    expect(stickyComment.current?.body).toContain("#8");
  });

  it("does NOT flag an open-PR file-path collision when GITTENSORY_OPEN_PR_FILE_COLLISION is unset (byte-identical default)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      aiReviewMode: "off",
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 8,
      title: "Document logging output",
      state: "open",
      user: { login: "other-author" },
      head: { sha: "b8" },
      labels: [],
      body: "",
    });
    await upsertPullRequestFile(env, { repoFullName: "JSONbored/gittensory", pullNumber: 8, path: "src/shared/util.ts", additions: 1, deletions: 0, changes: 1, payload: {} });
    await upsertPullRequestFile(env, { repoFullName: "JSONbored/gittensory", pullNumber: 7, path: "src/shared/util.ts", additions: 1, deletions: 0, changes: 1, payload: {} });
    const stickyComment: { current: { id: number; body: string } | null } = { current: null };
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
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/shared/util.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Improve widget rendering", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/7/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/7/comments") && method === "POST") {
        const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        stickyComment.current = { id: 1, body };
        return Response.json({ id: 1 }, { status: 201 });
      }
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "open-pr-file-collision-flag-off",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 7, title: "Improve widget rendering", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "" },
      },
    });

    expect(stickyComment.current?.body).not.toContain("#8");
  });

  it("computes the AI review cache fingerprint with a self-host reviewer plan and converged grounding/enrichment on (#2119)", async () => {
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
      // A self-host reviewer plan (not just BYOK/cloud provider/model) plus its underlying provider config.
      AI_REVIEW_PLAN: { reviewers: [{ model: "claude-code" }], combine: "single" } as never,
      CLAUDE_AI_MODEL: "sonnet",
      CLAUDE_AI_EFFORT: "high",
      // Grounding + enrichment ON, with the repo allowlisted for convergence, so both feature flags
      // resolve past their `isXEnabled(env) && convergedRepoAllowed` check into the fingerprint.
      GITTENSORY_REVIEW_GROUNDING: "true",
      GITTENSORY_REVIEW_ENRICHMENT: "true",
      REES_URL: "https://rees.example",
      GITTENSORY_REVIEW_REPOS: "JSONbored/gittensory",
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
      if (url.includes("/pulls/7/files"))
        return Response.json([
          { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" },
          // GitHub omits `patch` for binary/oversized files -- the fingerprint must still normalize this case.
          { filename: "assets/logo.png", status: "modified", additions: 0, deletions: 0, changes: 0 },
        ]);
      if (url.endsWith("/pulls/7")) return Response.json({ number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/issues/7/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/7/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      // REES enrichment + any other unmatched call degrade fail-open on a generic empty response.
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "self-host-plan-converged-features",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" },
      },
    });

    // The review ran fresh (no pre-seeded cache to reuse), reaching the fingerprint computation with the
    // self-host reviewer plan, its provider config, and both converged feature checks evaluated.
    expect(aiCalls).toBeGreaterThan(0);
  });

  it("computes the AI review cache fingerprint with the repo quality-culture profile on, both the global flag and the per-repo opt-in (#2995)", async () => {
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
      // Both gates on: the global capability switch, and — unlike grounding/enrichment/RAG/reputation, which are
      // env-only — the per-repo `.gittensory.yml` opt-in mocked below, so `dynamicReviewFeatures.cultureProfile`
      // (src/queue/processors.ts) actually evaluates its `&&` right-hand side true, not just short-circuits.
      GITTENSORY_REVIEW_CULTURE_PROFILE: "true",
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
      // The repo's own review.culture_profile opt-in.
      if (url === "https://raw.githubusercontent.com/JSONbored/gittensory/HEAD/.gittensory.yml") {
        return new Response("review:\n  culture_profile: true\n");
      }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "culture-profile-converged-feature",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" },
      },
    });

    // The review ran fresh, reaching the fingerprint computation with the culture-profile feature evaluated —
    // this repo has no merge history seeded, so the context itself is empty, but the FLAG combination (not the
    // context content) is what dynamicReviewFeatures.cultureProfile tracks for cache-bypass purposes.
    expect(aiCalls).toBeGreaterThan(0);
  });

  it("marks a cached AI review non-durable (cacheable=0) when the impact-map feature is on, even with grounding/rag/enrichment/reputation all off (#2182-#2186)", async () => {
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
      // Both gates on: the global capability switch, and (like culture-profile above, unlike
      // grounding/enrichment/RAG/reputation which are env-only) the per-repo `.gittensory.yml` opt-in mocked
      // below, so `dynamicReviewFeatures.impactMap` (src/queue/processors.ts) actually evaluates
      // shouldComputeImpactMap's `&&` right-hand side true, not just short-circuits.
      GITTENSORY_REVIEW_IMPACT_MAP: "true",
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
      // The repo's own review.impact_map opt-in.
      if (url === "https://raw.githubusercontent.com/JSONbored/gittensory/HEAD/.gittensory.yml") {
        return new Response("review:\n  impact_map: true\n");
      }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "impact-map-non-durable",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" },
      },
    });

    expect(aiCalls).toBeGreaterThan(0);
    const cached = await env.DB.prepare("select cacheable from ai_review_cache where repo_full_name = ? and pull_number = ? and head_sha = ?")
      .bind("JSONbored/gittensory", 7, "a7")
      .first<{ cacheable: number }>();
    // Never durably cacheable on its own merits, even though grounding/rag/enrichment/reputation are all off in
    // this env -- impact-map alone is enough to trip dynamicReviewContextActive.
    expect(cached?.cacheable).toBe(0);
  });

  it("reuses a dynamic-context (grounding) AI review indefinitely once published, even long past the old cooldown window (#2119, #regate-churn)", async () => {
    // Grounding/RAG/enrichment/reputation each pull TIME-VARYING external context (live CI checks, the vector
    // index, REES/CVE data, reputation) that can change for the SAME head SHA without the feature flags
    // themselves flipping — so treating a hit here as an INDEFINITELY durable result BEFORE it is ever published
    // could replay a review built against now-stale context forever. #regate-churn (root-caused in production: a
    // single dynamic-context PR generated 259 of 281 AI review calls in 24h at an unchanged head, because this
    // used to re-run UNCONDITIONALLY on every single call, with no bound at all) FIRST changed this to a bounded,
    // non-durable reuse (AI_REVIEW_NON_CACHEABLE_RETRY_COOLDOWN_MS) — but that bound was itself still an
    // UNBOUNDED total spend over the PR's lifetime (one fresh call every cooldown window, forever). Once the
    // review has actually been PUBLISHED to the PR, `published_at` makes it authoritative for its exact
    // head+fingerprint regardless of how much time elapses — only a real content/config change or an explicit
    // maintainer force-rerun may spend another one.
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
      GITTENSORY_REVIEW_GROUNDING: "true",
      GITTENSORY_REVIEW_REPOS: "JSONbored/gittensory",
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
      return Response.json({});
    });

    const webhook = {
      type: "github-webhook" as const,
      eventName: "pull_request" as const,
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" as const } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" },
      },
    };
    await processJob(env, { ...webhook, deliveryId: "dynamic-context-bypass-1" });
    const firstRunAiCalls = aiCalls;
    expect(firstRunAiCalls).toBeGreaterThan(0);
    const cached = await env.DB.prepare("select cacheable, published_at as publishedAt from ai_review_cache where repo_full_name = ? and pull_number = ? and head_sha = ?")
      .bind("JSONbored/gittensory", 7, "a7")
      .first<{ cacheable: number; publishedAt: string | null }>();
    expect(cached?.cacheable).toBe(0); // never durably cacheable on its own merits
    expect(cached?.publishedAt).not.toBeNull(); // but it WAS published to the PR this pass

    // Re-review of the SAME head with the SAME (unchanged) inputs, shortly after: reused, no additional LLM spend.
    vi.setSystemTime(new Date("2026-05-28T00:05:00.000Z"));
    await processJob(env, { ...webhook, deliveryId: "dynamic-context-bypass-2" });
    expect(aiCalls).toBe(firstRunAiCalls);

    // What used to be the cooldown window (30 min) elapses, then a full day, then a full month — the published
    // snapshot is authoritative regardless: none of these buy a fresh call.
    for (const later of ["2026-05-28T00:31:00.000Z", "2026-05-29T00:00:00.000Z", "2026-06-28T00:00:00.000Z"]) {
      vi.setSystemTime(new Date(later));
      await processJob(env, { ...webhook, deliveryId: `dynamic-context-bypass-later-${later}` });
    }
    expect(aiCalls).toBe(firstRunAiCalls);
  });

  it("continues to final verdict when the reviewing placeholder audit write fails", async () => {
    const originalRecordAuditEvent = repositoriesModule.recordAuditEvent;
    const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockImplementation(async (auditEnv, event) => {
      if (event.eventType === "github_app.reviewing_placeholder_failed")
        throw new Error("D1 audit failed");
      await originalRecordAuditEvent(auditEnv, event);
    });
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: {
        run: async () => ({ response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }),
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
    const postedBodies: string[] = [];
    let postAttempts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/47/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/47")) return Response.json({ number: 47, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a47" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/a47/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a47/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/issues/47/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/47/comments") && method === "POST") {
        postAttempts += 1;
        const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        if (postAttempts === 1) return new Response(JSON.stringify({ message: "temporary comment failure" }), { status: 500 });
        postedBodies.push(body);
        return Response.json({ id: 47 }, { status: 201 });
      }
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "reviewing-placeholder-audit-fails",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 47, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a47" }, labels: [], body: "Closes #1" },
      },
    });

    expect(postAttempts).toBeGreaterThanOrEqual(2);
    expect(postedBodies.some((body) => !body.includes("is reviewing"))).toBe(true);
    expect(auditSpy).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ eventType: "github_app.reviewing_placeholder_failed" }),
    );
    auditSpy.mockRestore();
  });

  it("posts the 🟪 reviewing placeholder for non-AI comment refreshes, then overwrites it with the verdict", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "false",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await persistRegistrySnapshot(env, normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"));
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", commentMode: "all_prs", publicSurface: "comment_only", autoLabelEnabled: false, checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory" });
    const stickyComment: { current: { id: number; body: string } | null } = { current: null };
    let postCount = 0;
    let patchCount = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/8/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/8")) return Response.json({ number: 8, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a8" }, labels: [], body: "Closes #1" });
      if (url.includes("/commits/a8/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a8/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/issues/8/comments") && method === "GET") {
        return Response.json(stickyComment.current ? [{ ...stickyComment.current, user: { login: "gittensory[bot]", type: "Bot" } }] : []);
      }
      if (url.includes("/issues/8/comments") && method === "POST") {
        const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        postCount += 1;
        stickyComment.current = { id: 1, body };
        return Response.json({ id: 1 }, { status: 201 });
      }
      if (url.includes("/issues/comments/1") && method === "PATCH") {
        const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        patchCount += 1;
        stickyComment.current = { id: 1, body };
        return Response.json({ id: 1 }, { status: 200 });
      }
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "reviewing-placeholder-disabled-ai",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 8, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a8" }, labels: [], body: "Closes #1" },
      },
    });

    expect(aiCalls).toBe(0);
    expect(postCount).toBe(1);
    expect(patchCount).toBeGreaterThanOrEqual(1);
    expect(stickyComment.current?.body).toContain(PR_PANEL_COMMENT_MARKER);
    expect(stickyComment.current?.body).toContain("Thanks for the contribution");
    expect(stickyComment.current?.body).not.toContain("is reviewing");
  });

  it("keeps the PR comment in 🟪 reviewing state and retries when the final comment update is rate-limited", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "false",
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
      aiReviewMode: "advisory",
    });
    const postedBodies: string[] = [];
    let finalCommentAttempted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/9/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/9")) return Response.json({ number: 9, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a9" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/a9/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a9/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/issues/9/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/9/comments") && method === "POST") {
        const body = String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? "");
        if (postedBodies.length === 0) {
          postedBodies.push(body);
          return Response.json({ id: 1 }, { status: 201 });
        }
        finalCommentAttempted = true;
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        });
      }
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "reviewing-placeholder-comment-ratelimit",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 9, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a9" }, labels: [], body: "Closes #1" },
        },
      }),
    ).rejects.toThrow(/rate limit/i);

    expect(finalCommentAttempted).toBe(true);
    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0]).toContain("is reviewing");
    expect(postedBodies[0]).toContain("🟪");
  });

  it("publishes AI notes when the review omits a narrative assessment", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: {
        run: async () => {
          aiCalls += 1;
          return {
            response: JSON.stringify({
              assessment: "",
              blockers: [],
              nits: ["Add coverage for the new branch."],
              suggestions: ["Add coverage for the new branch."],
            }),
          };
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
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    await putCachedAiReview(env, "JSONbored/gittensory", 10, "a10", "block", {
      notes: "**Nits (1)**\n- stale cached nit",
      reviewerCount: 1,
    });
    const commentBodies: string[] = [];
    const checkPatches: Array<{ status?: string; conclusion?: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/10/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/10")) return Response.json({ number: 10, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a10" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/a10/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a10/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/10/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/10/comments") && method === "POST") {
        commentBodies.push(String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""));
        return Response.json({ id: 1 }, { status: 201 });
      }
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 971 }, { status: 201 });
      if (url.includes("/check-runs/971") && method === "PATCH") {
        checkPatches.push(JSON.parse(String(init?.body ?? "{}")) as { status?: string; conclusion?: string });
        return Response.json({ id: 971 });
      }
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "reviewing-placeholder-ai-summary-missing",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 10, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a10" }, labels: [], body: "Closes #1" },
        },
      }),
    ).resolves.toBeUndefined();

    expect(commentBodies.length).toBeGreaterThanOrEqual(2);
    expect(commentBodies[0]).toContain("is reviewing");
    expect(commentBodies[0]).toContain("🟪");
    const finalComment = commentBodies.find((body) => !body.includes("is reviewing"));
    expect(finalComment).toBeDefined();
    expect(finalComment).toContain("Readiness score");
    expect(finalComment).not.toContain("stale cached nit");
    expect(finalComment).toContain("did not include a separate narrative summary");
    expect(finalComment).toContain("Add coverage for the new branch.");
    expect(aiCalls).toBeGreaterThan(0);
    expect(checkPatches).toContainEqual(expect.objectContaining({ status: "completed" }));
    const audit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
      .bind("github_app.ai_review_public_summary_missing")
      .first<{ n: number }>();
    expect(audit?.n).toBe(0);
  });

  it("publishes a non-cacheable AI-unavailable note when no reviewer returns usable output", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: {
        run: async () => ({ response: "not-json" }),
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
    await upsertInstallation(env, { action: "created", installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "selected", permissions: {}, events: [] } });
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
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 48, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a48" }, labels: [], body: "Closes #1" });
    const commentBodies: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/48/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/48")) return Response.json({ number: 48, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a48" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/a48/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a48/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/48/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/48/comments") && method === "POST") {
        commentBodies.push(String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""));
        return Response.json({ id: 48 }, { status: 201 });
      }
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await expect(
      processJob(env, {
        type: "agent-regate-pr",
        deliveryId: "regate-ai-unavailable",
        repoFullName: "JSONbored/gittensory",
        prNumber: 48,
        installationId: 123,
      }),
    ).resolves.toBeUndefined();

    expect(commentBodies.length).toBeGreaterThanOrEqual(2);
    expect(commentBodies[0]).toContain("is reviewing");
    const finalComment = commentBodies.find((body) => !body.includes("is reviewing"));
    expect(finalComment).toContain("LoopOver review needs maintainer review");
    expect(finalComment).toContain("AI review could not be completed for this PR head");
    expect(finalComment).not.toContain("The AI reviewer returned public review text but not the expected structured verdict");
    // #regate-churn: the "AI review could not be completed" outcome is now PERSISTED (so a repeated scheduled
    // sweep pass at the same head can reuse it for a bounded cooldown instead of re-spending an LLM call every
    // tick) but marked non-durable (cacheable=0) — it must never be replayed as a trustworthy, indefinitely-valid
    // verdict.
    const cached = await env.DB.prepare("select cacheable from ai_review_cache where repo_full_name = ? and pull_number = ?")
      .bind("JSONbored/gittensory", 48)
      .first<{ cacheable: number }>();
    expect(cached?.cacheable).toBe(0);
    const nonCacheableAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
      .bind("github_app.ai_review_non_cacheable")
      .first<{ n: number }>();
    expect(nonCacheableAudit?.n).toBe(1);
    const audit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
      .bind("github_app.ai_review_public_summary_missing")
      .first<{ n: number }>();
    expect(audit?.n).toBe(0);
  });

  it("INVARIANT (#confirmed-bug): a second overlapping pass for the same PR head defers to the AI review lock, holds the gate NEUTRAL, and never calls the AI a second time", async () => {
    // Simulates the confirmed TOCTOU race: a webhook pass and an agent-regate-pr sweep pass both reach
    // runAiReviewForAdvisory for the SAME PR at the SAME head SHA before either has written the cache. The
    // webhook pass (not modeled directly here — job-coalesce keys never match across trigger shapes) is
    // simulated by pre-claiming the lock exactly as runAiReviewForAdvisory itself would; the agent-regate-pr
    // pass under test must then defer instead of firing its own, potentially-divergent LLM call.
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
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "block",
      gatePack: "oss-anti-slop",
    });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 49, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a49" }, labels: [], body: "Closes #1" });
    const commentBodies: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/49/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/49")) return Response.json({ number: 49, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a49" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/a49/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a49/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/49/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/49/comments") && method === "POST") {
        commentBodies.push(String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""));
        return Response.json({ id: 49 }, { status: 201 });
      }
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    // The "first pass" (webhook-shaped) claims the lock for this exact (repo, PR, head, mode) tuple and is still
    // in-flight when the "second pass" (agent-regate-pr sweep-shaped) below reaches runAiReviewForAdvisory.
    expect((await claimAiReviewLock(env, "JSONbored/gittensory", 49, "a49", "block")).acquired).toBe(true);

    await expect(
      processJob(env, {
        type: "agent-regate-pr",
        deliveryId: "race-ai-review",
        repoFullName: "JSONbored/gittensory",
        prNumber: 49,
        installationId: 123,
      }),
    ).resolves.toBeUndefined();

    // The losing pass never called the AI a second time — it deferred to the lock instead of double-spending.
    expect(aiCalls).toBe(0);
    const finalComment = commentBodies.find((body) => !body.includes("is reviewing"));
    expect(finalComment).toContain("LoopOver review needs maintainer review");
    expect(finalComment).toContain("AI review is already running for this PR head in another LoopOver pass");
    // A lock-contention placeholder must never be persisted at all (not even non-durably, #regate-churn) — the
    // concurrent pass it deferred to writes the REAL result within seconds, and replaying this placeholder for
    // the rest of a bounded-cooldown window would mask that real result long after the race resolved.
    const cached = await env.DB.prepare("select count(*) as n from ai_review_cache where repo_full_name = ? and pull_number = ?")
      .bind("JSONbored/gittensory", 49)
      .first<{ n: number }>();
    expect(cached?.n).toBe(0);
  });

  it("publishes deterministic surface and reports missing summary when required AI is over quota", async () => {
    const aiRun = vi.fn(async () => ({ response: "{}" }));
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: aiRun } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "0",
    });
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
      publicSurface: "comment_only",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "block",
      gatePack: "oss-anti-slop",
    });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 49, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a49" }, labels: [], body: "Closes #1" });
    const commentBodies: string[] = [];
    const captureSpy = vi.spyOn(sentryModule, "captureReviewFailure");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/49/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/49")) return Response.json({ number: 49, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a49" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/a49/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a49/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/49/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/49/comments") && method === "POST") {
        commentBodies.push(String((JSON.parse(String(init?.body ?? "{}")) as { body?: string }).body ?? ""));
        return Response.json({ id: 49 }, { status: 201 });
      }
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await expect(
      processJob(env, {
        type: "agent-regate-pr",
        deliveryId: "regate-ai-over-quota",
        repoFullName: "JSONbored/gittensory",
        prNumber: 49,
        installationId: 123,
      }),
    ).resolves.toBeUndefined();

    expect(aiRun).not.toHaveBeenCalled();
    expect(commentBodies.length).toBeGreaterThanOrEqual(2);
    const finalComment = commentBodies.find((body) => !body.includes("is reviewing"));
    expect(finalComment).toContain("Readiness score");
    expect(finalComment).not.toContain("AI review returned public review text");
    const audit = await env.DB.prepare("select event_type, metadata_json from audit_events where event_type = ?")
      .bind("github_app.ai_review_public_summary_missing")
      .first<{ event_type: string; metadata_json: string }>();
    expect(audit).toMatchObject({ event_type: "github_app.ai_review_public_summary_missing" });
    expect(audit?.metadata_json).toContain('"aiReviewMode":"block"');
    expect(captureSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        reason: "ai_review_public_summary_missing",
        repo: "JSONbored/gittensory",
        pr: 49,
        reviewer_count: 0,
        public_notes: false,
      }),
      "ai_review_public_summary_missing",
    );
    captureSpy.mockRestore();
  });

  it("agent re-gate sweep re-reviews each stale open PR (installation id) and swallows a failing re-review", async () => {
    const env = createTestEnv({});
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, linkedIssueGateMode: "block" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Unlinked PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "no linked issue here" });
    // Advance past the one-hour freshness window so the just-seeded PR reads as stale.
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    // Make the re-review itself REJECT (its advisory persist throws) so the sweep's per-PR error backstop runs.
    // Only the advisories insert is poisoned; every other read/write (verdict computation, the closing audit
    // event) keeps working — the sweep must still complete and record its advisory verdict.
    const realPrepare = env.DB.prepare.bind(env.DB);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    env.DB.prepare = ((sql: string) => {
      if (/insert\s+into\s+["'`]?advisories/i.test(sql)) throw new Error("advisory persist failed");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;

    await sweepAndDrainPerPr(env, "owner/agent-repo");

    const audit = await realPrepare("select outcome, metadata_json from audit_events where event_type = ?").bind("agent.sweep.regate").first<{
      outcome: string;
      metadata_json: string;
    }>();
    expect(audit?.outcome).toBe("completed");
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({ repoFullName: "owner/agent-repo", examined: 1, flagged: 1 });
    // The failing re-review was caught and logged via the sweep_rereview_failed backstop, not rethrown.
    expect(errors.mock.calls.some((call) => String(call[0]).includes("sweep_rereview_failed"))).toBe(true);
    errors.mockRestore();
  });

  it("agent re-gate sweep stamps last_regated_at on each recomputed PR so the next sweep advances (#audit-sweep-converge)", async () => {
    const env = createTestEnv({});
    await upsertInstallation(env, { action: "created", installation: { id: 9002, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9002);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Stale PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "" });
    const before = await env.DB.prepare("select last_regated_at from pull_requests where repo_full_name = ? and number = 7").bind("owner/agent-repo").first<{ last_regated_at: string | null }>();
    expect(before?.last_regated_at).toBeNull(); // never swept yet
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    // #2852: autonomy configured (merge: auto) now means the gate CONCLUSION is evaluated even without a
    // GITHUB_APP_PRIVATE_KEY / check-run publish, which reaches the review-thread-blockers live fetch -- stub a
    // generic safe response so that call resolves instead of hitting a real, unmocked network request.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url === "https://api.github.com/graphql") return Response.json({ data: {} });
      return Response.json({});
    });

    await sweepAndDrainPerPr(env, "owner/agent-repo");

    const after = await env.DB.prepare("select last_regated_at from pull_requests where repo_full_name = ? and number = 7").bind("owner/agent-repo").first<{ last_regated_at: string | null }>();
    expect(typeof after?.last_regated_at).toBe("string"); // stamped via a D1 write at dispatch — convergence does not need a GitHub write
  });

  it("agent re-gate sweep processes strict staleness order even when a PR is missing its current Gate check (#selfhost-fifo-ordering)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertInstallation(env, { action: "created", installation: { id: 9400, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9400);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    for (const number of [1, 2, 3, 4]) {
      const headSha = `a${number}`;
      await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number, title: `PR${number}`, state: "open", user: { login: "c" }, head: { sha: headSha }, labels: [], body: "" });
      await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", number, headSha);
      if (number !== 2) {
        await upsertCheckSummary(env, {
          id: `gate-${number}`,
          repoFullName: "owner/agent-repo",
          pullNumber: number,
          headSha,
          name: "LoopOver Orb Review Agent",
          status: "completed",
          conclusion: "success",
          payload: {},
        });
      }
    }
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 5, title: "Draft without a head", state: "open", draft: true, user: { login: "c" }, labels: [], body: "" } as never);
    // Only PR2 gets a regate stamp (post-#never-endless-reregate, an ordinary already-regated PR is permanently
    // excluded from the sweep -- see agent-sweep.test.ts -- so PR1/3/4 must stay never-regated to remain eligible
    // ordinary candidates at all). PR2 is missing its current Gate check (surfaceRepairPriorityPullNumbers would
    // flag it as a repair candidate), so its repair-priority bypass keeps it eligible DESPITE already having a
    // stamp -- this is exactly the scenario the repair-priority bypass exists for.
    await env.DB.prepare(
      `update pull_requests set last_regated_at = '2026-05-28T01:50:00.000Z' where repo_full_name = ? and number = 2`,
    )
      .bind("owner/agent-repo")
      .run();
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    const fanned = sent.filter((job) => job.type === "agent-regate-pr");
    // PR2 is missing its current Gate check and already has a regate stamp from 10 min ago (very fresh by
    // lastRegatedAt), while PR1/3/4 have never been regated at all (the ordinary, post-#never-endless-reregate
    // candidate shape). An earlier revision sorted repair candidates first regardless of staleness, jumping PR2
    // to the front of this batch -- that let a PR needing repair cut ahead of older PRs that merely went stale,
    // observed live as PRs dispatching out of order ("spraying") whenever a repo had a mixed repair/ordinary
    // backlog. Repair status only affects ELIGIBILITY (staying in the pool despite already having a stamp),
    // never final order, so PR2 takes its rightful (last, since it's the freshest-regated) place and is dropped
    // by the max:3 cap this round -- same as it would be with no repair flag at all.
    expect(fanned.map((job) => (job as Extract<import("../../src/types").JobMessage, { type: "agent-regate-pr" }>).prNumber)).toEqual([1, 3, 4]);
  });

  it("REGRESSION (#3815): regateSweepOrderMode 'oldest-first' fans out per-PR jobs in creation order with a monotonic delaySeconds stagger", async () => {
    const dispatched: { prNumber: number; delaySeconds: number | undefined }[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(m: import("../../src/types").JobMessage, options?: { delaySeconds?: number }) {
          if (m.type === "agent-regate-pr") dispatched.push({ prNumber: m.prNumber, delaySeconds: options?.delaySeconds ?? 0 });
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9403, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9403);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, regateSweepOrderMode: "oldest-first", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    // Deliberately seeded out of PR-number order: #1 is the NEWEST, #3 is the OLDEST — proves the fan-out
    // follows createdAt, not insertion/number order.
    const created: Record<number, string> = { 1: "2026-05-20T00:00:00.000Z", 2: "2026-05-10T00:00:00.000Z", 3: "2026-05-01T00:00:00.000Z" };
    for (const number of [1, 2, 3]) {
      await upsertPullRequestFromGitHub(env, "owner/agent-repo", {
        number,
        title: `PR${number}`,
        state: "open",
        user: { login: "c" },
        head: { sha: `a${number}` },
        labels: [],
        body: "",
        created_at: created[number]!,
        updated_at: created[number]!,
      });
    }
    vi.setSystemTime(new Date("2026-05-28T00:00:00.000Z")); // well past the 2-min webhook-freshness window for all three

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    expect(dispatched.map((d) => d.prNumber)).toEqual([3, 2, 1]); // oldest-created (#3) first, newest (#1) last
    expect(dispatched.map((d) => d.delaySeconds)).toEqual([0, 10, 20]); // strictly increasing with dispatch order
  });

  it("REGRESSION: scheduled sweeps repair every missing current Gate check without waiting behind another repo backlog", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(m: import("../../src/types").JobMessage) {
          sent.push(m);
        },
        snapshot() {
          return {
            totals: { pending: 0, processing: 1, dead: 0, due: 0 },
            byType: [
              {
                type: "agent-regate-pr",
                status: "processing",
                count: 1,
                due: 0,
              },
            ],
          };
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9402, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9402);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    for (const number of [1, 2, 3, 4, 5]) {
      const headSha = `repair-${number}`;
      await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number, title: `Repair ${number}`, state: "open", user: { login: "c" }, head: { sha: headSha }, labels: [], body: "" });
      await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", number, headSha);
    }
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule", repoFullName: "owner/agent-repo" });

    const fanned = sent.filter((job): job is Extract<import("../../src/types").JobMessage, { type: "agent-regate-pr" }> => job.type === "agent-regate-pr");
    expect(fanned.map((job) => job.prNumber)).toEqual([1, 2, 3, 4, 5]);
    const audit = await env.DB.prepare("select metadata_json from audit_events where event_type = ? and outcome = ?")
      .bind("agent.sweep.regate", "completed")
      .first<{ metadata_json: string }>();
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({
      repoFullName: "owner/agent-repo",
      examined: 5,
    });
  });

  it("REGRESSION: an active per-PR regate backlog restricts the sweep to priority repairs, not a full stale-PR batch too", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(m: import("../../src/types").JobMessage) {
          sent.push(m);
        },
        // A nonzero per-PR regate backlog (agent-regate-pr pending/processing > 0) -- the same signal the
        // "waiting behind another repo backlog" deferral above reacts to.
        snapshot() {
          return {
            totals: { pending: 1, processing: 0, dead: 0, due: 1 },
            byType: [{ type: "agent-regate-pr", status: "pending", count: 1, due: 1 }],
          };
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9403, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9403);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    // PR 1: missing its current Gate check -- the one priority repair. Make it newer-by-regate than the
    // ordinary stale PRs below, reproducing the backlog bug where a max=1 staleness slice could drop the repair.
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 1, title: "Repair 1", state: "open", user: { login: "c" }, head: { sha: "repair-1" }, labels: [], body: "" });
    await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", 1, "repair-1");
    await env.DB.prepare("update pull_requests set last_regated_at = ? where repo_full_name = ? and number = ?")
      .bind("2026-05-28T01:59:00.000Z", "owner/agent-repo", 1)
      .run();
    // PRs 2-5: ordinary, already-current, stale-by-time PRs -- a normal (no-backlog) sweep would pick these up
    // too, but while the backlog is draining they must sit out so the sweep only carries the priority repair.
    for (const number of [2, 3, 4, 5]) {
      const headSha = `stale-${number}`;
      await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number, title: `Stale ${number}`, state: "open", user: { login: "c" }, head: { sha: headSha }, labels: [], body: "" });
      await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", number, headSha);
      await env.DB.prepare("update pull_requests set last_regated_at = ? where repo_full_name = ? and number = ?")
        .bind(`2026-05-28T01:0${number}:00.000Z`, "owner/agent-repo", number)
        .run();
      await upsertCheckSummary(env, {
        id: `gate-current-${number}`,
        repoFullName: "owner/agent-repo",
        pullNumber: number,
        headSha,
        name: "LoopOver Orb Review Agent",
        status: "completed",
        conclusion: "success",
        payload: {},
      });
    }
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule", repoFullName: "owner/agent-repo" });

    const fanned = sent.filter((job): job is Extract<import("../../src/types").JobMessage, { type: "agent-regate-pr" }> => job.type === "agent-regate-pr");
    expect(fanned.map((job) => job.prNumber)).toEqual([1]); // only the priority repair, not PRs 2-5
  });

  it("REGRESSION: the sweep tags a priority-repair fan-out with 'regate-repair:' and an ordinary candidate with 'regate-sweep:' (#selfhost-queue-liveness)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertInstallation(env, { action: "created", installation: { id: 9404, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9404);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    // PR 1: missing its current Gate check for its current head -- surfaceRepairPriorityPullNumbers flags this as
    // outage-repair priority (no completed Gittensory Gate check run at the live head SHA).
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 1, title: "Repair 1", state: "open", user: { login: "c" }, head: { sha: "repair-1" }, labels: [], body: "" });
    await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", 1, "repair-1");
    // PR 2: ordinary PR with a completed current-head Gate check -- NOT priority.
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 2, title: "Ordinary 2", state: "open", user: { login: "c" }, head: { sha: "ordinary-2" }, labels: [], body: "" });
    await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", 2, "ordinary-2");
    await upsertCheckSummary(env, {
      id: "gate-current-2",
      repoFullName: "owner/agent-repo",
      pullNumber: 2,
      headSha: "ordinary-2",
      name: "LoopOver Orb Review Agent",
      status: "completed",
      conclusion: "success",
      payload: {},
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    const fanned = sent.filter((job): job is Extract<import("../../src/types").JobMessage, { type: "agent-regate-pr" }> => job.type === "agent-regate-pr");
    expect(fanned).toHaveLength(2);
    const repairJob = fanned.find((job) => job.prNumber === 1);
    const ordinaryJob = fanned.find((job) => job.prNumber === 2);
    expect(repairJob).toMatchObject({
      type: "agent-regate-pr",
      deliveryId: "regate-repair:owner/agent-repo#1",
      repoFullName: "owner/agent-repo",
      prNumber: 1,
      installationId: 9404,
    });
    expect(ordinaryJob).toMatchObject({
      type: "agent-regate-pr",
      deliveryId: "regate-sweep:owner/agent-repo#2",
      repoFullName: "owner/agent-repo",
      prNumber: 2,
      installationId: 9404,
    });
  });

  it("REGRESSION (#orb-retry-storm): after MAX_ATTEMPTS repair dispatches for the SAME head SHA, the sweep stops bypassing freshness and records exactly one repair_exhausted audit event", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertInstallation(env, { action: "created", installation: { id: 9407, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9407);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    // PR 1: missing its current Gate check for its current head -- would ordinarily be flagged outage-repair
    // priority on every tick. Pre-seed REGATE_REPAIR_MAX_ATTEMPTS_PER_SHA=5 (#3998) prior repair-attempt audit
    // events for this EXACT head SHA to simulate a review that keeps failing (e.g. a timeout) and never
    // publishes a completed gate check.
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 1, title: "Stuck repair", state: "open", user: { login: "c" }, head: { sha: "stuck-sha" }, labels: [], body: "" });
    await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", 1, "stuck-sha");
    const targetKey = "owner/agent-repo#1#stuck-sha";
    for (let i = 0; i < 5; i += 1) {
      await repositoriesModule.recordAuditEvent(env, {
        eventType: "agent.sweep.regate.repair_attempt",
        actor: "gittensory",
        targetKey,
        outcome: "queued",
        detail: "prior attempt",
        metadata: {},
      });
    }
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

      // No longer treated as priority repair -- either not fanned at all, or fanned as an ordinary "regate-sweep:"
      // candidate, but never re-dispatched as "regate-repair:" once the same SHA has exhausted its attempt budget.
      const fanned = sent.filter((job): job is Extract<import("../../src/types").JobMessage, { type: "agent-regate-pr" }> => job.type === "agent-regate-pr");
      expect(fanned.every((job) => job.deliveryId !== "regate-repair:owner/agent-repo#1")).toBe(true);
      const exhausted = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("agent.sweep.regate.repair_exhausted", targetKey)
        .first<{ n: number }>();
      expect(exhausted?.n).toBe(1);
      // No further repair-attempt event was recorded for the exhausted SHA this tick.
      const attempts = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
        .bind("agent.sweep.regate.repair_attempt", targetKey)
        .first<{ n: number }>();
      expect(attempts?.n).toBe(5);
      // Sentry-visible signal (via the structured-log forwarder) fires exactly once alongside the audit event.
      const exhaustedLogs = errors.mock.calls.filter(([line]) => typeof line === "string" && line.includes("regate_repair_exhausted"));
      expect(exhaustedLogs).toHaveLength(1);
      const logged = JSON.parse(exhaustedLogs[0]![0] as string) as Record<string, unknown>;
      expect(logged).toMatchObject({ level: "error", event: "regate_repair_exhausted", repo: "owner/agent-repo", pullNumber: 1, headSha: "stuck-sha", attempts: 5 });
    } finally {
      errors.mockRestore();
    }
  }, 60_000);

  it("REGRESSION (#orb-retry-storm): a repair dispatch under the attempt cap records a repair_attempt audit event, and a second sweep tick does not duplicate the repair_exhausted event once already flagged", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertInstallation(env, { action: "created", installation: { id: 9408, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9408);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 2, title: "Fresh repair", state: "open", user: { login: "c" }, head: { sha: "fresh-sha" }, labels: [], body: "" });
    await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", 2, "fresh-sha");
    const targetKey = "owner/agent-repo#2#fresh-sha";
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    const fanned = sent.filter((job): job is Extract<import("../../src/types").JobMessage, { type: "agent-regate-pr" }> => job.type === "agent-regate-pr");
    expect(fanned.map((job) => job.deliveryId)).toContain("regate-repair:owner/agent-repo#2");
    // #orb-retry-storm (#3998): repair_attempt is now recorded at EXECUTION time (inside regatePullRequest,
    // after rate-limit admission), not at dispatch time -- a deferred/dropped fan-out no longer counts against
    // the cap. The sweep only dispatches the per-PR job above; it must actually run for the attempt to land.
    await processJob(env, fanned.find((job) => job.deliveryId === "regate-repair:owner/agent-repo#2")!);
    const attemptsAfterFirst = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
      .bind("agent.sweep.regate.repair_attempt", targetKey)
      .first<{ n: number }>();
    expect(attemptsAfterFirst?.n).toBe(1);

    // Manually push this SHA over the REGATE_REPAIR_MAX_ATTEMPTS_PER_SHA=5 cap (#3998), then run the sweep twice
    // more -- the exhausted event must be recorded only once even though the PR is (re-)evaluated on every tick.
    for (let i = 0; i < 4; i += 1) {
      await repositoriesModule.recordAuditEvent(env, {
        eventType: "agent.sweep.regate.repair_attempt",
        actor: "gittensory",
        targetKey,
        outcome: "queued",
        detail: "prior attempt",
        metadata: {},
      });
    }
    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });
    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    const exhausted = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
      .bind("agent.sweep.regate.repair_exhausted", targetKey)
      .first<{ n: number }>();
    expect(exhausted?.n).toBe(1);
  }, 60_000);

  it("agent re-gate sweep fail-opens when current Gate check reads fail during repair priority selection", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertInstallation(env, { action: "created", installation: { id: 9401, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9401);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Repair me", state: "open", user: { login: "c" }, head: { sha: "a7" }, labels: [], body: "" });
    await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", 7, "a7");
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/from\s+["`]?check_summaries["`]?/i.test(sql)) throw new Error("check summary read failed");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    const fanned = sent.filter((job) => job.type === "agent-regate-pr") as Extract<import("../../src/types").JobMessage, { type: "agent-regate-pr" }>[];
    expect(fanned.map((job) => job.prNumber)).toEqual([7]);
  });

  it("scheduled sweeps skip open-PR refresh when an allowlisted repo has not been registered locally yet", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      GITTENSORY_REVIEW_REPOS: "owner/missing-repo",
      JOBS: {
        async send(m: import("../../src/types").JobMessage) {
          sent.push(m);
        },
      } as unknown as Queue,
    });
    const segmentSpy = vi.spyOn(repositoriesModule, "getRepoSyncSegment");
    const backfillSpy = vi.spyOn(backfillModule, "backfillRepositorySegment");
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule", repoFullName: "owner/missing-repo" });

    expect(segmentSpy).not.toHaveBeenCalled();
    expect(backfillSpy).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    segmentSpy.mockRestore();
    backfillSpy.mockRestore();
  });

  it("scheduled sweeps can refresh stale open-PR rows with an Orb enrollment credential", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      ORB_ENROLLMENT_SECRET: "orb-secret",
      JOBS: {
        async send(m: import("../../src/types").JobMessage) {
          sent.push(m);
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9406, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9406);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertRepoSyncSegment(env, completeSegment("owner/agent-repo", "open_pull_requests"));
    const backfillSpy = vi.spyOn(backfillModule, "backfillRepositorySegment").mockResolvedValueOnce({
      ok: true,
      repoFullName: "owner/agent-repo",
      segment: "open_pull_requests",
      status: "complete",
      fetchedCount: 0,
      warnings: [],
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule", repoFullName: "owner/agent-repo" });

    expect(backfillSpy).toHaveBeenCalledWith(env, expect.objectContaining({ segment: "open_pull_requests", force: true }));
    expect(sent.filter((job) => job.type === "agent-regate-pr")).toEqual([]);
    backfillSpy.mockRestore();
  });

  it("REGRESSION: scheduled sweeps refresh stale open-PR rows so missed webhooks cannot hide PRs from repair", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(m: import("../../src/types").JobMessage) {
          sent.push(m);
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9402, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9402);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertRepoSyncSegment(env, completeSegment("owner/agent-repo", "open_pull_requests"));
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        return Response.json({
          data: {
            rateLimit: { remaining: 4999, resetAt: "2026-05-28T03:00:00.000Z" },
            repository: {
              issues: { totalCount: 0 },
              openPullRequests: { totalCount: 1 },
              mergedPullRequests: { totalCount: 0 },
              closedPullRequests: { totalCount: 0 },
              labels: { totalCount: 0 },
            },
          },
        });
      }
      if (url.includes("/pulls?state=open")) {
        return Response.json([
          {
            number: 11,
            title: "Webhook missed this PR",
            state: "open",
            user: { login: "contributor" },
            head: { sha: "h11" },
            labels: [],
            body: "Fixes #1",
            created_at: "2026-05-27T00:00:00.000Z",
            updated_at: "2026-05-27T00:00:00.000Z",
          },
        ]);
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule", repoFullName: "owner/agent-repo" });

    expect((await getPullRequest(env, "owner/agent-repo", 11))?.headSha).toBe("h11");
    const fanned = sent.filter((job) => job.type === "agent-regate-pr") as Extract<import("../../src/types").JobMessage, { type: "agent-regate-pr" }>[];
    expect(fanned.map((job) => job.prNumber)).toEqual([11]);
    expect(sent.some((job) => job.type === "backfill-pr-details" && job.repoFullName === "owner/agent-repo")).toBe(true);
  });

  it("scheduled sweeps do not duplicate an active open-PR refresh", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(m: import("../../src/types").JobMessage) {
          sent.push(m);
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9403, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9403);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertRepoSyncSegment(env, {
      ...completeSegment("owner/agent-repo", "open_pull_requests"),
      status: "running",
    });
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json([]));
    vi.stubGlobal("fetch", fetchSpy);
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule", repoFullName: "owner/agent-repo" });

    expect(
      fetchSpy.mock.calls
        .map((call) => String((call as [RequestInfo | URL, RequestInit?])[0]))
        .filter((url) => url === "https://api.github.com/graphql" || url.includes("/pulls?state=open")),
    ).toEqual([]);
    expect(sent.filter((job) => job.type === "agent-regate-pr")).toEqual([]);
  });

  it("scheduled sweeps fail open when open-PR sync state reads and refreshes fail", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(m: import("../../src/types").JobMessage) {
          sent.push(m);
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9404, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9404);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    const segmentSpy = vi.spyOn(repositoriesModule, "getRepoSyncSegment").mockRejectedValueOnce(new Error("segment read failed"));
    const backfillSpy = vi.spyOn(backfillModule, "backfillRepositorySegment").mockRejectedValueOnce(new Error("open PR refresh failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule", repoFullName: "owner/agent-repo" });

    expect(backfillSpy).toHaveBeenCalledWith(env, expect.objectContaining({ segment: "open_pull_requests", mode: "light", force: true }));
    expect(warn.mock.calls.some((call) => String(call[0]).includes("sweep_open_pr_sync_failed"))).toBe(true);
    expect(sent.filter((job) => job.type === "agent-regate-pr")).toEqual([]);
    segmentSpy.mockRestore();
    backfillSpy.mockRestore();
    warn.mockRestore();
  });

  it("REGRESSION (#sweep-uninstalled-budget-waste): a scheduled sweep never refreshes open PRs (via the shared GITHUB_PUBLIC_TOKEN) for a registered-but-uninstalled repo, since no per-PR fan-out will ever follow", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(m: import("../../src/types").JobMessage) {
          sent.push(m);
        },
      } as unknown as Queue,
    });
    // Registered (e.g. via the subnet registry sync) but NOT installed — no installationId.
    await upsertRepositoryFromGitHub(env, { name: "no-install", full_name: "owner/no-install", private: false, owner: { login: "owner" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/no-install", autonomy: { merge: "auto" } });
    const segmentSpy = vi.spyOn(repositoriesModule, "getRepoSyncSegment");
    const backfillSpy = vi.spyOn(backfillModule, "backfillRepositorySegment");
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule", repoFullName: "owner/no-install" });

    expect(segmentSpy).not.toHaveBeenCalled();
    expect(backfillSpy).not.toHaveBeenCalled();
    expect(sent.filter((job) => job.type === "agent-regate-pr")).toEqual([]);
    segmentSpy.mockRestore();
    backfillSpy.mockRestore();
  });

  it("scheduled sweeps DO still refresh open PRs for an installed repo even when GITHUB_PUBLIC_TOKEN is also configured (installation presence gates the skip, not credential kind)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(m: import("../../src/types").JobMessage) {
          sent.push(m);
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9405, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9405);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    const backfillSpy = vi.spyOn(backfillModule, "backfillRepositorySegment").mockResolvedValueOnce(undefined as never);
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule", repoFullName: "owner/agent-repo" });

    expect(backfillSpy).toHaveBeenCalledWith(env, expect.objectContaining({ segment: "open_pull_requests", mode: "light", force: true }));
    backfillSpy.mockRestore();
  });

  it("scheduled sweeps refresh incomplete open-PR sync segments", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(m: import("../../src/types").JobMessage) {
          sent.push(m);
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9405, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9405);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertRepoSyncSegment(env, {
      ...completeSegment("owner/agent-repo", "open_pull_requests"),
      status: "partial",
    });
    const backfillSpy = vi.spyOn(backfillModule, "backfillRepositorySegment").mockResolvedValueOnce({
      ok: true,
      repoFullName: "owner/agent-repo",
      segment: "open_pull_requests",
      status: "complete",
      fetchedCount: 0,
      warnings: [],
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule", repoFullName: "owner/agent-repo" });

    expect(backfillSpy).toHaveBeenCalledWith(env, expect.objectContaining({ segment: "open_pull_requests" }));
    expect(sent.filter((job) => job.type === "agent-regate-pr")).toEqual([]);
    backfillSpy.mockRestore();
  });

  it("scheduled sweeps refresh completed open-PR sync rows whose completion time is missing", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
      JOBS: {
        async send(m: import("../../src/types").JobMessage) {
          sent.push(m);
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9407, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9407);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    const segmentSpy = vi.spyOn(repositoriesModule, "getRepoSyncSegment").mockResolvedValueOnce({
      ...completeSegment("owner/agent-repo", "open_pull_requests"),
      completedAt: undefined,
    } as never);
    const backfillSpy = vi.spyOn(backfillModule, "backfillRepositorySegment").mockResolvedValueOnce({
      ok: true,
      repoFullName: "owner/agent-repo",
      segment: "open_pull_requests",
      status: "complete",
      fetchedCount: 0,
      warnings: [],
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule", repoFullName: "owner/agent-repo" });

    expect(backfillSpy).toHaveBeenCalledWith(env, expect.objectContaining({ segment: "open_pull_requests", force: true }));
    expect(sent.filter((job) => job.type === "agent-regate-pr")).toEqual([]);
    segmentSpy.mockRestore();
    backfillSpy.mockRestore();
  });

  it("REGRESSION (#audit-sweep-dispatch-stamp): ONE sweep stamps ALL candidates AT DISPATCH, so the next fan-out skips the repo as draining — no overlapping sweeps", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertInstallation(env, { action: "created", installation: { id: 9300, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9300);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" } });
    for (const number of [7, 8, 9]) {
      await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number, title: `PR${number}`, state: "open", user: { login: "c" }, head: { sha: `a${number}` }, labels: [], body: "" });
    }
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    // Run ONE sweep — but do NOT drain the per-PR jobs (simulate the staggered/deferred re-reviews not having run yet).
    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    // The marker is stamped for EVERY candidate immediately at dispatch — NOT waiting on the per-PR jobs.
    const stamped = await env.DB.prepare("select count(*) as n from pull_requests where repo_full_name = ? and last_regated_at is not null").bind("owner/agent-repo").first<{ n: number }>();
    expect(stamped?.n).toBe(3);

    // So the very next cron fan-out sees the fresh stamp and SKIPS this repo as draining — the overlap that caused the runaway is gone.
    sent.length = 0;
    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule" });
    expect(sent.some((m) => m.type === "agent-regate-sweep" && m.repoFullName === "owner/agent-repo")).toBe(false);
    const fanout = await env.DB.prepare("select metadata_json from audit_events where event_type = ? order by created_at desc limit 1").bind("agent.sweep.fanout").first<{ metadata_json: string }>();
    expect(JSON.parse(fanout?.metadata_json ?? "{}").skippedDraining).toBeGreaterThanOrEqual(1);
  });

  it("agent re-gate sweep swallows a failing last_regated_at stamp and still completes (#audit-sweep-converge)", async () => {
    const env = createTestEnv({});
    await upsertInstallation(env, { action: "created", installation: { id: 9003, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9003);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Stale PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    // #2852: autonomy configured (merge: auto) now means the gate CONCLUSION is evaluated even without a
    // GITHUB_APP_PRIVATE_KEY / check-run publish, which reaches the review-thread-blockers live fetch -- stub a
    // generic safe response so that call resolves instead of hitting a real, unmocked network request.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url === "https://api.github.com/graphql") return Response.json({ data: {} });
      return Response.json({});
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stamp = vi.spyOn(repositoriesModule, "markPullRequestsRegated").mockRejectedValueOnce(new Error("D1 write error"));

    await sweepAndDrainPerPr(env, "owner/agent-repo");

    const audit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.sweep.regate").first<{ outcome: string }>();
    expect(audit?.outcome).toBe("completed"); // the sweep still records its verdict; the dispatch-time stamp failure is swallowed
    expect(errors.mock.calls.some((call) => String(call[0]).includes("sweep_mark_regated_failed"))).toBe(true);
    stamp.mockRestore();
    errors.mockRestore();
  });

  it("agent re-gate sweep respects the #776 kill-switch: a paused repo records a skip and recomputes nothing (#777)", async () => {
    const env = createTestEnv({});
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, agentPaused: true });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Stale PR", state: "open", user: { login: "contributor" }, head: { sha: "abc" }, labels: [], body: "x" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    const audit = await env.DB.prepare("select outcome, detail, metadata_json from audit_events where event_type = ?").bind("agent.sweep.regate").first<{
      outcome: string;
      detail: string;
      metadata_json: string;
    }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toMatch(/paused/i);
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({ mode: "paused" });
  });

  it("agent re-gate sweep no-ops safely on a missing repo arg or an un-configured repo (#777)", async () => {
    const env = createTestEnv({});
    // (a) a test-mode per-repo job with no repoFullName → defensive early return
    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test" });
    // (b) a repo that never opted the agent in → defensive return after settings resolve
    await upsertRepositoryFromGitHub(env, { name: "plain-repo", full_name: "owner/plain-repo", private: false, owner: { login: "owner" } });
    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/plain-repo" });

    const count = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("agent.sweep.regate").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("agent re-gate sweep stays quiet when no open PR is stale enough to re-gate (#777)", async () => {
    const env = createTestEnv({});
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" } });
    // Seeded "now" → within the freshness window → not a candidate; no clock advance.
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Fresh PR", state: "open", user: { login: "c" }, head: { sha: "a7" }, labels: [], body: "x" });
    await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", 7, "a7");
    await upsertCheckSummary(env, {
      id: "gate-fresh-7",
      repoFullName: "owner/agent-repo",
      pullNumber: 7,
      headSha: "a7",
      name: "LoopOver Orb Review Agent",
      status: "completed",
      conclusion: "success",
      payload: {},
    });

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    const count = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("agent.sweep.regate").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("INVARIANT: the sweep fans out one agent-regate-pr job per candidate onto the JOBS lane, not inline (#audit-sweep-fanout)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertInstallation(env, { action: "created", installation: { id: 9100, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9100);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "PR7", state: "open", user: { login: "c" }, head: { sha: "a7" }, labels: [], body: "" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 8, title: "PR8", state: "open", user: { login: "c" }, head: { sha: "a8" }, labels: [], body: "" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    const perPr = sent.filter((m): m is Extract<import("../../src/types").JobMessage, { type: "agent-regate-pr" }> => m.type === "agent-regate-pr");
    expect(perPr.map((m) => m.prNumber).sort()).toEqual([7, 8]); // one per candidate
    expect(perPr.every((m) => m.installationId === 9100 && m.repoFullName === "owner/agent-repo")).toBe(true);
    expect(sent.every((m) => m.type === "agent-regate-pr")).toBe(true); // the heavy work is enqueued, never done inline
  });

  it("INVARIANT (in-flight guard): the fan-out SKIPS a repo whose prior sweep is still draining, enqueues an idle one (#audit-sweep-fanout)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ GITTENSORY_REVIEW_REPOS: "", JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertInstallation(env, { action: "created", installation: { id: 9101, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    for (const name of ["draining", "idle"]) {
      await upsertRepositoryFromGitHub(env, { name, full_name: `owner/${name}`, private: false, owner: { login: "owner" } }, 9101);
      await upsertRepositorySettings(env, { repoFullName: `owner/${name}`, autonomy: { merge: "auto" } });
      await upsertPullRequestFromGitHub(env, `owner/${name}`, { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "h1" }, labels: [], body: "" });
    }
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    // owner/draining was just regated (a sweep is mid-drain); owner/idle has never been swept.
    await repositoriesModule.markPullRequestRegated(env, "owner/draining", 1);

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule" }); // no repoFullName → fan-out path

    const sweepRepos = sent.filter((m): m is Extract<import("../../src/types").JobMessage, { type: "agent-regate-sweep" }> => m.type === "agent-regate-sweep").map((m) => m.repoFullName);
    expect(sweepRepos).toEqual(["owner/idle"]); // the draining repo is skipped, the idle one enqueued
    const fanout = await env.DB.prepare("select metadata_json from audit_events where event_type = ?").bind("agent.sweep.fanout").first<{ metadata_json: string }>();
    expect(JSON.parse(fanout?.metadata_json ?? "{}")).toMatchObject({ repoCount: 1, skippedDraining: 1 });
  });

  it("INVARIANT (#audit-fanout-dedup): a BURST of fan-outs collapses to ONE — the second claims nothing and audits denied", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertInstallation(env, { action: "created", installation: { id: 9400, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9400);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "PR7", state: "open", user: { login: "c" }, head: { sha: "a7" }, labels: [], body: "" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule" }); // first fan-out claims the window
    expect(sent.some((m) => m.type === "agent-regate-sweep" && m.repoFullName === "owner/agent-repo")).toBe(true);

    sent.length = 0;
    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule" }); // burst sibling in the same window → deduped
    expect(sent.filter((m) => m.type === "agent-regate-sweep")).toEqual([]); // enqueues no redundant sweep
    const denied = await env.DB.prepare("select count(*) as n from audit_events where event_type='agent.sweep.fanout' and outcome='denied'").first<{ n: number }>();
    expect(denied?.n).toBe(1);
  });

  it("claimAiReviewLock claims when free, denies when held (per-PR+head+mode, not globally), and release frees it again (#confirmed-bug)", async () => {
    const env = createTestEnv({});
    // First claim for this exact (repo, PR, head, mode) succeeds — no prior pass in-flight.
    const first = await claimAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block");
    expect(first.acquired).toBe(true);
    // A second, concurrent pass for the SAME PR at the SAME head and mode (regardless of what triggered it —
    // webhook or sweep) is denied while the first is still in-flight — exactly the race this lock exists for.
    expect((await claimAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block")).acquired).toBe(false);
    // A DIFFERENT head SHA for the same PR is unaffected — a new commit is a genuinely new review, not a dup.
    expect((await claimAiReviewLock(env, "owner/agent-repo", 7, "sha2", "block")).acquired).toBe(true);
    // A DIFFERENT mode for the same PR+head is also unaffected — advisory vs block are independent lock keys.
    expect((await claimAiReviewLock(env, "owner/agent-repo", 7, "sha1", "advisory")).acquired).toBe(true);
    // A DIFFERENT PR in the same repo is unaffected — the lock is per-PR+head+mode, not repo-wide.
    expect((await claimAiReviewLock(env, "owner/agent-repo", 8, "sha1", "block")).acquired).toBe(true);
    // Release (the finally block's job) frees the (PR, head, mode) tuple — a subsequent pass can claim it again.
    await releaseAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block", first.ownerToken);
    expect((await claimAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block")).acquired).toBe(true);
  });

  it("claimAiReviewLock fails OPEN on a broken transient cache — never itself blocks a real review from running (#confirmed-bug)", async () => {
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async () => { throw new Error("cache read error"); },
        set: async () => { throw new Error("cache write error"); },
        del: async () => { throw new Error("cache delete error"); },
      },
    });
    expect((await claimAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block")).acquired).toBe(true);
    await expect(releaseAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block", null)).resolves.toBeUndefined();
  });

  it("claimAiReviewLock fails OPEN when no transient cache is configured at all — nothing to serialize against (#confirmed-bug)", async () => {
    const env = createTestEnv({});
    delete env.SELFHOST_TRANSIENT_CACHE;
    expect((await claimAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block")).acquired).toBe(true);
  });

  it("claimAiReviewLock fails OPEN when the atomic claim primitive itself throws (#confirmed-bug)", async () => {
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async () => null,
        set: async () => undefined,
        claim: async () => { throw new Error("redis unavailable"); },
      },
    });
    expect((await claimAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block")).acquired).toBe(true);
  });

  it("REGRESSION: claimAiReviewLock uses an atomic check-and-set, so two genuinely concurrent claims for the SAME (repo, PR, head, mode) can never both succeed", async () => {
    // A get-then-set pair has a window between the read and the write where two concurrent callers can both
    // observe an absent key and both claim it — exactly what this lock exists to prevent (a webhook pass and a
    // sweep pass both missing the cache and both firing a real LLM call). This test races two claims for the
    // same tuple via Promise.all (both kick off before either resolves) against the default test cache's
    // claim(), which mirrors createRedisCache's atomic SET NX: the check-and-set happens with no `await`
    // boundary in between, so it is impossible for both callers to see "unclaimed".
    const env = createTestEnv({});
    const [first, second] = await Promise.all([
      claimAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block"),
      claimAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block"),
    ]);
    expect([first, second].filter((claim) => claim.acquired)).toHaveLength(1);
  });

  it("REGRESSION: claimAiReviewLock calls the atomic claim primitive, not a separate get+set pair, when the cache supports it", async () => {
    const calls: string[] = [];
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async () => { calls.push("get"); return null; },
        set: async () => { calls.push("set"); },
        claim: async () => { calls.push("claim"); return true; },
        releaseIfValue: async () => true,
      },
    });
    expect((await claimAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block")).acquired).toBe(true);
    expect(calls).toEqual(["claim"]); // never falls through to the racy get/set pair when claim is available
  });

  it("claimAiReviewLock returns true unconditionally when the cache has no claim() — no false exclusivity guarantee (#confirmed-bug, review round 2)", async () => {
    // A prior version of this helper fell back to a get-then-set pair (even with an extra write-then-verify
    // re-read) when claim() wasn't available. That is NOT a real exclusivity guarantee: caller A can write its
    // own token, read it straight back, and return true entirely before caller B's later write/read also
    // completes and also returns true -- both callers "win". Rather than pretend to serialize via a check that
    // silently fails under exactly the concurrent load this lock exists to guard against (duplicate LLM calls),
    // a cache without claim() now gets NO exclusivity at all -- every call proceeds, sequential or concurrent,
    // even for a key a previous call already "set" via get/set.
    const values = new Map<string, string>();
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async (key: string) => values.get(key) ?? null,
        set: async (key: string, value: string) => { values.set(key, value); },
      },
    });
    expect((await claimAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block")).acquired).toBe(true);
    expect((await claimAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block")).acquired).toBe(true);
  });

  it("REGRESSION (#confirmed-bug, review round 2): claimAiReviewLock does not falsely claim exclusivity for two genuinely concurrent callers when the cache has no claim()", async () => {
    // Documents the corrected, honest contract under the exact interleaving the gate flagged: with no atomic
    // claim() primitive, BOTH concurrent callers proceed (true) -- a webhook pass and a sweep pass racing for
    // the same PR head both fire their LLM call, same as before this lock existed, rather than one of them
    // wrongly believing it has exclusive ownership when it doesn't.
    const values = new Map<string, string>();
    const yieldThenRun = <T,>(fn: () => T): Promise<T> => new Promise((resolve) => queueMicrotask(() => resolve(fn())));
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: (key: string) => yieldThenRun(() => values.get(key) ?? null),
        set: (key: string, value: string) => yieldThenRun(() => { values.set(key, value); }),
      },
    });
    const [first, second] = await Promise.all([
      claimAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block"),
      claimAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block"),
    ]);
    expect([first.acquired, second.acquired]).toEqual([true, true]);
  });

  // claimPrActuationLock (#2129/#2135) is the ONE shared per-PR actuation lock: maybeRunAgentMaintenance,
  // maybeCloseDraftDodgeAttempt, and maybeRecloseDisallowedReopen all claim/release the SAME key so none of the
  // three mutating PR paths can race any other (review round 4) — a single namespace, not one lock per path.
  it("claimPrActuationLock claims when free, denies when held (per-PR), and release frees it again (#2135)", async () => {
    const env = createTestEnv({});
    const first = await claimPrActuationLock(env, "owner/act-repo", 7);
    expect(first.acquired).toBe(true);
    expect((await claimPrActuationLock(env, "owner/act-repo", 7)).acquired).toBe(false);
    expect((await claimPrActuationLock(env, "owner/act-repo", 8)).acquired).toBe(true);
    await releasePrActuationLock(env, "owner/act-repo", 7, first.ownerToken);
    expect((await claimPrActuationLock(env, "owner/act-repo", 7)).acquired).toBe(true);
  });

  it("claimPrActuationLock fails OPEN on a broken transient cache — never itself blocks actuation (#2135)", async () => {
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async () => { throw new Error("cache read error"); },
        set: async () => { throw new Error("cache write error"); },
        del: async () => { throw new Error("cache delete error"); },
      },
    });
    expect((await claimPrActuationLock(env, "owner/act-repo", 7)).acquired).toBe(true);
    await expect(releasePrActuationLock(env, "owner/act-repo", 7, null)).resolves.toBeUndefined();
  });

  it("claimPrActuationLock fails OPEN when the atomic claim primitive itself throws (#2135)", async () => {
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async () => null,
        set: async () => undefined,
        claim: async () => { throw new Error("redis unavailable"); },
      },
    });
    expect((await claimPrActuationLock(env, "owner/act-repo", 7)).acquired).toBe(true);
  });

  it("REGRESSION (#2135): claimPrActuationLock uses an atomic check-and-set, so two genuinely concurrent claims for the SAME PR can never both succeed", async () => {
    const env = createTestEnv({});
    const [first, second] = await Promise.all([
      claimPrActuationLock(env, "owner/act-repo", 7),
      claimPrActuationLock(env, "owner/act-repo", 7),
    ]);
    expect([first, second].filter((claim) => claim.acquired)).toHaveLength(1);
  });

  it("REGRESSION (#2135): claimPrActuationLock calls the atomic claim primitive, not a separate get+set pair, when the cache supports it", async () => {
    const calls: string[] = [];
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async () => { calls.push("get"); return null; },
        set: async () => { calls.push("set"); },
        claim: async () => { calls.push("claim"); return true; },
        releaseIfValue: async () => true,
      },
    });
    expect((await claimPrActuationLock(env, "owner/act-repo", 7)).acquired).toBe(true);
    expect(calls).toEqual(["claim"]); // never falls through to the racy get/set pair when claim is available
  });

  it("claimPrActuationLock returns true unconditionally when the cache has no claim() — no false exclusivity guarantee (#2135, review round 2)", async () => {
    // A get-then-set pair (even with a re-read) is not a real exclusivity guarantee under concurrent load, so a
    // cache without claim() now gets NO exclusivity at all rather than a fallback that only looks atomic.
    const values = new Map<string, string>();
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async (key: string) => values.get(key) ?? null,
        set: async (key: string, value: string) => { values.set(key, value); },
      },
    });
    expect((await claimPrActuationLock(env, "owner/act-repo", 7)).acquired).toBe(true);
    expect((await claimPrActuationLock(env, "owner/act-repo", 7)).acquired).toBe(true);
  });

  it("REGRESSION (#2135, review round 2): claimPrActuationLock does not falsely claim exclusivity for two genuinely concurrent callers when the cache has no claim()", async () => {
    const values = new Map<string, string>();
    const yieldThenRun = <T,>(fn: () => T): Promise<T> => new Promise((resolve) => queueMicrotask(() => resolve(fn())));
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: (key: string) => yieldThenRun(() => values.get(key) ?? null),
        set: (key: string, value: string) => yieldThenRun(() => { values.set(key, value); }),
      },
    });
    const [first, second] = await Promise.all([
      claimPrActuationLock(env, "owner/act-repo", 7),
      claimPrActuationLock(env, "owner/act-repo", 7),
    ]);
    expect([first.acquired, second.acquired]).toEqual([true, true]);
  });

  it("REGRESSION (#2129/#2135): a stale actuation-lock holder's release does not delete a successor's live lock", async () => {
    // The exact race the ownership-token scheme exists to close: holder A's claim TTL lapses (or its finally
    // block simply runs late), a NEW holder B claims the same key in the meantime, and then A's release finally
    // runs. A blind del() would delete B's still-live lock; releaseIfValue only deletes when the caller's OWN
    // token still matches what's stored, so A's late release is a safe no-op against B's key.
    const env = createTestEnv({});
    const staleHolder = await claimPrActuationLock(env, "owner/act-repo", 7);
    expect(staleHolder.acquired).toBe(true);
    expect(staleHolder.ownerToken).toBeTruthy();
    // Simulate B's claim landing in the same key slot after A's token would have expired.
    await env.SELFHOST_TRANSIENT_CACHE!.set!("pr-actuation-lock:owner/act-repo#7", "successor-token", 600);
    await releasePrActuationLock(env, "owner/act-repo", 7, staleHolder.ownerToken);
    expect(await env.SELFHOST_TRANSIENT_CACHE!.get!("pr-actuation-lock:owner/act-repo#7")).toBe("successor-token");
    // B's own release, with the matching token, does free the key.
    await releasePrActuationLock(env, "owner/act-repo", 7, "successor-token");
    expect(await env.SELFHOST_TRANSIENT_CACHE!.get!("pr-actuation-lock:owner/act-repo#7")).toBeNull();
  });

  it("releaseAiReviewLock and releasePrActuationLock are no-ops when ownerToken is null (nothing was actually claimed)", async () => {
    const env = createTestEnv({});
    const calls: string[] = [];
    env.SELFHOST_TRANSIENT_CACHE = {
      get: async () => null,
      set: async () => undefined,
      releaseIfValue: async () => { calls.push("releaseIfValue"); return true; },
    };
    await releasePrActuationLock(env, "owner/act-repo", 7, null);
    await releaseAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block", null);
    expect(calls).toEqual([]); // a null token means nothing was claimed, so release must never touch the cache
  });

  it("REGRESSION: stale AI-review-lock holder releaseIfValue does not delete a successor's live lock", async () => {
    const env = createTestEnv({});
    const staleHolder = await claimAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block");
    expect(staleHolder.acquired).toBe(true);
    expect(staleHolder.ownerToken).toBeTruthy();
    await env.SELFHOST_TRANSIENT_CACHE!.set!("ai-review-lock:owner/agent-repo#7@sha1:block", "successor-token", 1800);
    await releaseAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block", staleHolder.ownerToken);
    expect(await env.SELFHOST_TRANSIENT_CACHE!.get!("ai-review-lock:owner/agent-repo#7@sha1:block")).toBe("successor-token");
    await releaseAiReviewLock(env, "owner/agent-repo", 7, "sha1", "block", "successor-token");
    expect(await env.SELFHOST_TRANSIENT_CACHE!.get!("ai-review-lock:owner/agent-repo#7@sha1:block")).toBeNull();
  });

  it("claimPrActuationLock fails open without exclusivity when claim() is present but releaseIfValue is absent (#3153)", async () => {
    let claimed = false;
    const store = new Map<string, string>();
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async (key: string) => store.get(key) ?? null,
        set: async (key: string, value: string) => { store.set(key, value); },
        claim: async (key: string, value: string) => {
          claimed = true;
          if (store.has(key)) return false;
          store.set(key, value);
          return true;
        },
      },
    });
    const lock = await claimPrActuationLock(env, "owner/act-repo", 7);
    expect(lock.acquired).toBe(true);
    expect(lock.ownerToken).toBeNull();
    expect(claimed).toBe(false);
    expect(store.size).toBe(0);
  });

  it("INVARIANT (#2129 per-PR lock): a maintenance pass defers when another pass already holds the PR's lock", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1" });
    let mergeCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/pulls/7/merge")) {
        mergeCalls += 1;
        return new Response(null, { status: 204 });
      }
      if (url.includes("/pulls/7/reviews") && init?.method === "POST") return Response.json({ id: 1 });
      if (url.includes("/pulls/7/reviews")) return Response.json([]);
      // Only the bare PR resource (no sub-path) — the more specific checks above already claimed
      // /pulls/7/files, /pulls/7/merge, and /pulls/7/reviews.
      if (/\/pulls\/7(\?|$)/.test(url)) return Response.json({ number: 7, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/a7/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a7/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/a7/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      if (url.includes(".gittensory.yml")) return new Response("Not Found", { status: 404 });
      if (url.endsWith("/check-runs") && init?.method === "POST") return Response.json({ id: 1 });
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.endsWith("/graphql")) return Response.json({ data: {} });
      return Response.json({});
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    // Simulate a webhook pass already in-flight for this exact PR — a github-webhook:pr-refresh job's coalesce
    // key never matches agent-regate-pr's, so the two would never dedup against each other pre-#2129; the
    // shared per-PR actuation lock is what makes a second, independently-triggered pass defer instead of racing
    // it. Pre-claims the SAME pr-actuation-lock key the draft-dodge/reopen-reclose paths use (#2129/#2135,
    // review round 4) — one shared namespace, not a maintenance-only lock.
    await env.SELFHOST_TRANSIENT_CACHE?.set("pr-actuation-lock:owner/agent-repo#7", "1", 60);

    await processJob(env, { type: "agent-regate-pr", deliveryId: "race-sweep", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9001 });

    // The held lock made this pass skip its plan-and-execute critical section entirely — no mutation attempted.
    expect(mergeCalls).toBe(0);
    const actionAudits = await env.DB.prepare("select count(*) as n from audit_events where event_type like 'agent.action.%'").first<{ n: number }>();
    expect(actionAudits?.n).toBe(0);
  });

  it("the sweep stamps the marker INLINE when the repo has no installation (audit-only, still converges) (#audit-sweep-fanout)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    // Configured but NOT installed (no installationId) — there is no installation to re-review with.
    await upsertRepositoryFromGitHub(env, { name: "no-install", full_name: "owner/no-install", private: false, owner: { login: "owner" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/no-install", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/no-install", { number: 7, title: "PR7", state: "open", user: { login: "c" }, head: { sha: "a7" }, labels: [], body: "" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/no-install" });

    expect(sent.filter((m) => m.type === "agent-regate-pr")).toEqual([]); // no installation → no per-PR fan-out
    const after = await env.DB.prepare("select last_regated_at from pull_requests where repo_full_name = ? and number = 7").bind("owner/no-install").first<{ last_regated_at: string | null }>();
    expect(typeof after?.last_regated_at).toBe("string"); // stamped inline so the sweep still advances
  });

  it("the sweep swallows a failing dispatch-time stamp on a no-installation repo and still completes (#audit-sweep-fanout)", async () => {
    const env = createTestEnv({ JOBS: { async send() {} } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "no-install", full_name: "owner/no-install", private: false, owner: { login: "owner" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/no-install", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/no-install", { number: 7, title: "PR7", state: "open", user: { login: "c" }, head: { sha: "a7" }, labels: [], body: "" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stamp = vi.spyOn(repositoriesModule, "markPullRequestsRegated").mockRejectedValueOnce(new Error("D1 write error"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/no-install" });

    const audit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.sweep.regate").first<{ outcome: string }>();
    expect(audit?.outcome).toBe("completed"); // the dispatch-time stamp failure is swallowed; the sweep still records its verdict
    expect(errors.mock.calls.some((call) => String(call[0]).includes("sweep_mark_regated_failed"))).toBe(true);
    stamp.mockRestore();
    errors.mockRestore();
  });

  it("REGRESSION: the sweep DEFERS (re-queues, no fan-out) when the shared REST budget is below the maintenance floor (#audit-rate-headroom)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertInstallation(env, { action: "created", installation: { id: 9200, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9200);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "PR7", state: "open", user: { login: "c" }, head: { sha: "a7" }, labels: [], body: "" });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    // Low REST budget (10 ≤ 150 maintenance floor) with a future reset → maintenance must yield. Scoped to this
    // repo's own installation bucket (#audit-rate-scoping) — the sweep now checks that bucket specifically.
    await repositoriesModule.recordGitHubRateLimitObservation(env, { repoFullName: "owner/agent-repo", admissionKey: "installation:9200", resource: "rest", path: "/x", statusCode: 200, limitValue: 5000, remaining: 10, resetAt: "2026-05-28T02:30:00.000Z", observedAt: "2026-05-28T02:00:00.000Z" });

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    expect(sent.filter((m) => m.type === "agent-regate-pr")).toEqual([]); // no fan-out while deferred
    expect(sent.some((m) => m.type === "agent-regate-sweep" && m.repoFullName === "owner/agent-repo")).toBe(true); // re-queued
    const audit = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("agent.sweep.regate").first<{ outcome: string; metadata_json: string }>();
    expect(audit?.outcome).toBe("queued");
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({ deferred: true });
  });

  it("REGRESSION: a scheduled repo sweep does not fan out more per-PR regates while prior regate work is queued", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(m: import("../../src/types").JobMessage) {
          sent.push(m);
        },
        snapshot: async () => ({
          totals: { pending: 1, processing: 0, dead: 0, due: 1 },
          byType: [{ type: "agent-regate-pr", status: "pending", count: 1, due: 1 }],
        }),
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9201, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9201);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "PR7", state: "open", user: { login: "c" }, head: { sha: "a7" }, labels: [], body: "" });
    await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", 7, "a7");
    await upsertCheckSummary(env, {
      id: "gate-backlog-7",
      repoFullName: "owner/agent-repo",
      pullNumber: 7,
      headSha: "a7",
      name: "LoopOver Orb Review Agent",
      status: "completed",
      conclusion: "success",
      payload: {},
    });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    const getRepo = vi.spyOn(repositoriesModule, "getRepository");
    const listOpen = vi.spyOn(repositoriesModule, "listOpenPullRequests");

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule", repoFullName: "owner/agent-repo" });

    expect(sent.filter((m) => m.type === "agent-regate-pr")).toEqual([]);
    expect(getRepo).toHaveBeenCalledWith(env, "owner/agent-repo");
    expect(listOpen).toHaveBeenCalledWith(env, "owner/agent-repo");
    const audit = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("agent.sweep.regate").first<{ outcome: string; metadata_json: string }>();
    expect(audit?.outcome).toBe("queued");
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({ deferred: true, regateBacklog: 1 });
  });

  it("REGRESSION: a scheduled repo sweep ignores sweep rows when deciding per-PR regate backlog", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(m: import("../../src/types").JobMessage) {
          sent.push(m);
        },
        snapshot: async () => ({
          totals: { pending: 0, processing: 1, dead: 0, due: 0 },
          byType: [{ type: "agent-regate-sweep", status: "processing", count: 1, due: 0 }],
        }),
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9203, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9203);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 9, title: "PR9", state: "open", user: { login: "c" }, head: { sha: "a9" }, labels: [], body: "" });
    // Published at the current head so this is an ORDINARY (non-priority-repair) candidate -- this test is about
    // backlog-row-type filtering, not the priority-repair "regate-repair:" tagging (covered separately above).
    await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", 9, "a9");
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule", repoFullName: "owner/agent-repo" });

    expect(sent.filter((m) => m.type === "agent-regate-pr")).toEqual([
      expect.objectContaining({
        type: "agent-regate-pr",
        deliveryId: "regate-sweep:owner/agent-repo#9",
        repoFullName: "owner/agent-repo",
        prNumber: 9,
        installationId: 9203,
      }),
    ]);
  });

  it("INVARIANT: a scheduled repo sweep does not require queue introspection", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(m: import("../../src/types").JobMessage) {
          sent.push(m);
        },
        snapshot: async () => {
          throw new Error("snapshot unavailable");
        },
      } as unknown as Queue,
    });
    await upsertInstallation(env, { action: "created", installation: { id: 9202, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9202);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 8, title: "PR8", state: "open", user: { login: "c" }, head: { sha: "a8" }, labels: [], body: "" });
    // Published at the current head so this is an ORDINARY (non-priority-repair) candidate -- this test is about
    // queue-introspection independence, not the priority-repair "regate-repair:" tagging (covered separately above).
    await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", 8, "a8");
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));

    await processJob(env, { type: "agent-regate-sweep", requestedBy: "schedule", repoFullName: "owner/agent-repo" });

    expect(sent.filter((m) => m.type === "agent-regate-pr")).toEqual([
      {
        type: "agent-regate-pr",
        deliveryId: "regate-sweep:owner/agent-repo#8",
        repoFullName: "owner/agent-repo",
        prNumber: 8,
        installationId: 9202,
      },
    ]);
  });

  it("REGRESSION: a per-PR re-gate job DEFERS (re-queues, no re-review/stamp) when the REST budget is below the maintenance floor (#audit-rate-headroom)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    // Scoped to this job's own installation bucket (#audit-rate-scoping) — installationId 9200 below.
    await repositoriesModule.recordGitHubRateLimitObservation(env, { repoFullName: "owner/agent-repo", admissionKey: "installation:9200", resource: "rest", path: "/x", statusCode: 200, limitValue: 5000, remaining: 10, resetAt: "2026-05-28T02:30:00.000Z", observedAt: "2026-05-28T02:00:00.000Z" });
    const stamp = vi.spyOn(repositoriesModule, "markPullRequestsRegated");

    await processJob(env, { type: "agent-regate-pr", deliveryId: "regate-sweep:owner/agent-repo#7", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9200 });

    expect(sent.filter((m) => m.type === "agent-regate-pr")).toHaveLength(1); // re-queued for after the reset
    expect(stamp).not.toHaveBeenCalled(); // the per-PR job NEVER stamps the convergence marker — the sweep already did, at dispatch
    stamp.mockRestore();
  });

  it("REGRESSION: a 'regate-sweep:' per-PR job DEFERS at the maintenance floor even with headroom above the lower live floor (#selfhost-queue-liveness)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    // 100 remaining sits BELOW the 150 maintenance floor but ABOVE the 75 live floor -- isScheduledRegateSweepJob
    // must route this "regate-sweep:"-prefixed job to the higher (150) floor, so it still defers here. Scoped to
    // this job's own installation bucket (#audit-rate-scoping) — installationId 9200 below.
    await repositoriesModule.recordGitHubRateLimitObservation(env, { repoFullName: "owner/agent-repo", admissionKey: "installation:9200", resource: "rest", path: "/x", statusCode: 200, limitValue: 5000, remaining: 100, resetAt: "2026-05-28T02:30:00.000Z", observedAt: "2026-05-28T02:00:00.000Z" });
    const stamp = vi.spyOn(repositoriesModule, "markPullRequestsRegated");

    await processJob(env, { type: "agent-regate-pr", deliveryId: "regate-sweep:owner/agent-repo#7", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9200 });

    expect(sent.filter((m) => m.type === "agent-regate-pr")).toHaveLength(1); // re-queued for after the reset
    expect(stamp).not.toHaveBeenCalled();
    stamp.mockRestore();
  });

  it("REGRESSION: a non-'regate-sweep:' per-PR job (current-head trigger) does NOT defer at the maintenance floor, only at the lower live floor (#selfhost-queue-liveness)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    vi.setSystemTime(new Date("2026-05-28T02:00:00.000Z"));
    // Same 100-remaining observation as the sibling "regate-sweep:" test above (scoped to this job's own
    // installation:9200 bucket, #audit-rate-scoping), but this deliveryId does NOT carry the "regate-sweep:"
    // prefix (e.g. a repair-priority fan-out, or a real webhook-triggered re-review), so isScheduledRegateSweepJob
    // is false and shouldWaitForGitHubRateLimit is called with the lower 75 floor: 100 > 75, so this job proceeds
    // instead of deferring.
    await repositoriesModule.recordGitHubRateLimitObservation(env, { repoFullName: "owner/agent-repo", admissionKey: "installation:9200", resource: "rest", path: "/x", statusCode: 200, limitValue: 5000, remaining: 100, resetAt: "2026-05-28T02:30:00.000Z", observedAt: "2026-05-28T02:00:00.000Z" });

    // No stored PR row for prNumber 7 -- reReviewStoredPullRequest reaches its `getPullRequest` read (proving the
    // rate-limit gate did not short-circuit it) and then returns immediately with no re-enqueue, since there is
    // nothing to review. A deferral would instead re-enqueue this exact job (asserted absent below).
    await processJob(env, { type: "agent-regate-pr", deliveryId: "regate-repair:owner/agent-repo#7", repoFullName: "owner/agent-repo", prNumber: 7, installationId: 9200 });

    expect(sent.filter((m) => m.type === "agent-regate-pr")).toEqual([]); // proceeded — no rate-limit re-enqueue
  });

  it("routes repo-scoped backfill jobs into resumable segment and detail processors", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
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
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        return Response.json({
          data: {
            rateLimit: { remaining: 4999, resetAt: "2026-05-25T01:00:00.000Z" },
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
      if (url.includes("/issues?") || url.includes("/labels?") || url.includes("/pulls?")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });

    await processJob(env, { type: "backfill-registered-repos", requestedBy: "api", repoFullName: "JSONbored/gittensory" });
    await processJob(env, { type: "backfill-repo-segment", requestedBy: "api", repoFullName: "JSONbored/gittensory", segment: "open_issues" });
    await processJob(env, { type: "backfill-pr-details", requestedBy: "api", repoFullName: "JSONbored/gittensory" });

    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: "backfill-repo-segment", repoFullName: "JSONbored/gittensory" })]));
    expect(await listRepoSyncStates(env)).toEqual(expect.arrayContaining([expect.objectContaining({ repoFullName: "JSONbored/gittensory" })]));
  });

  it("covers optional queue payload branches for fanout, segment, and detail jobs", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITHUB_PUBLIC_TOKEN: "public-token",
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
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") {
        return Response.json({
          data: {
            rateLimit: { remaining: 4999, resetAt: "2026-05-25T01:00:00.000Z" },
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
      if (url.includes("/labels?") || url.includes("/pulls?") || url.includes("/issues?")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });

    await processJob(env, { type: "backfill-registered-repos", requestedBy: "api" });
    await processJob(env, { type: "backfill-repo-segment", requestedBy: "api", repoFullName: "JSONbored/gittensory", segment: "labels", mode: "resume", cursor: "2", force: true });
    await processJob(env, { type: "backfill-pr-details", requestedBy: "api", repoFullName: "JSONbored/gittensory", mode: "resume", cursor: 2 });

    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: "backfill-registered-repos", repoFullName: "JSONbored/gittensory" })]));
  });

  it("marks installation health from queued installation metadata", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" },
        events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } }],
    });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } }, 123);
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

    await processJob(env, { type: "refresh-installation-health", requestedBy: "test" });
    expect(await listInstallationHealth(env)).toMatchObject([{ status: "healthy", registeredInstalledCount: 1 }]);
  });

  it("syncs repositories added to and removed from an existing installation", async () => {
    const env = createTestEnv();
    const installation = { id: 123, account: { login: "JSONbored", id: 1, type: "User" } };
    await upsertInstallation(env, {
      installation: {
        ...installation,
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "read", issues: "write" },
        events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
      },
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "installation-repo-added",
      eventName: "installation_repositories",
      payload: {
        action: "added",
        installation: { id: 123 },
        repositories_added: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
      },
    });

    expect(await getRepository(env, "JSONbored/gittensory")).toMatchObject({ isInstalled: true, installationId: 123 });
    expect(await getInstallation(env, 123)).toMatchObject({
      accountLogin: "JSONbored",
      permissions: { metadata: "read", pull_requests: "read", issues: "write" },
      events: ["issues", "issue_comment", "pull_request", "repository", "installation_repositories"],
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "installation-repo-removed",
      eventName: "installation_repositories",
      payload: {
        action: "removed",
        installation: { id: 123 },
        repositories_removed: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
      },
    });

    expect(await getRepository(env, "JSONbored/gittensory")).toMatchObject({ isInstalled: false, installationId: null });
    expect(await listProductUsageEvents(env, { limit: 10 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventName: "github_installation_repository_added", repoFullName: "<redacted-actor>/gittensory" }),
        expect.objectContaining({ eventName: "github_installation_repository_removed", repoFullName: "<redacted-actor>/gittensory" }),
      ]),
    );
  });

  it("does not record phantom telemetry when installation-created has no repositories (#installation-created-fallback)", async () => {
    const env = createTestEnv();

    // Case 1: neither repositories nor repository.full_name — must produce zero events (was [undefined])
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "install-no-repos",
      eventName: "installation",
      payload: {
        action: "created",
        installation: { id: 900, account: { login: "empty-org", id: 99, type: "Organization" } },
      },
    });
    const eventsAfterEmpty = await listProductUsageEvents(env, { limit: 50 });
    expect(eventsAfterEmpty.filter((e) => e.eventName === "github_installation_created")).toHaveLength(0);

    // Case 2: repository fallback (no repositories array) — must produce exactly one event with consistent metadata
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "install-single-repo-fallback",
      eventName: "installation",
      payload: {
        action: "created",
        installation: { id: 901, account: { login: "single-org", id: 100, type: "Organization" } },
        repository: { name: "my-repo", full_name: "single-org/my-repo", private: false, owner: { login: "single-org" } },
      },
    });
    const eventsAfterSingle = await listProductUsageEvents(env, { limit: 50 });
    const createdEvents = eventsAfterSingle.filter((e) => e.eventName === "github_installation_created");
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]).toMatchObject({
      eventName: "github_installation_created",
      repoFullName: "<redacted-actor>/my-repo",
      metadata: expect.objectContaining({ action: "created", repoCount: 1, truncatedRepos: 0 }),
    });
  });

  it("REGRESSION: installation-created telemetry falls back to repoFullName as the targetKey when the payload carries no installation.id", async () => {
    const env = createTestEnv();
    // `handleInstallationCreatedWebhookEvent`'s own guard is `eventName === "installation" && action === "created"`
    // -- unlike the sibling installation_repositories handler, it does NOT also require `installation.id`, so a
    // malformed/partial delivery (no `installation` object at all) still enters the block. The per-repo
    // `targetKey: payload.installation?.id ? \`installation:${id}\` : repoFullName` ternary must then take its
    // `repoFullName` fallback arm instead of throwing or omitting the field.
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "install-created-no-installation-id",
      eventName: "installation",
      payload: {
        action: "created",
        repository: { name: "my-repo", full_name: "no-installation-org/my-repo", private: false, owner: { login: "no-installation-org" } },
      },
    });
    const events = await listProductUsageEvents(env, { limit: 50 });
    const created = events.filter((e) => e.eventName === "github_installation_created");
    expect(created).toHaveLength(1);
    // No installation/sender on the payload -> installationActor is undefined -> no actor redaction applies, so
    // both fields surface the real (unredacted) value here.
    expect(created[0]).toMatchObject({
      eventName: "github_installation_created",
      repoFullName: "no-installation-org/my-repo",
      targetKey: "no-installation-org/my-repo",
    });
  });

  it("REGRESSION: a deployment_status webhook for an allowlisted repo re-reviews the correlated PR and short-circuits before the other wake triggers", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_REPOS: "JSONbored/gittensory" });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    // Deliberately no stored PR #4242 -- reReviewStoredPullRequest's own `if (!pr || pr.state !== "open") return;`
    // no-ops immediately, so this test stays focused on maybeCaptureOnDeploymentStatus's early-return contract
    // (processGitHubWebhook must `return` right after it, never falling through to the other wake-trigger checks)
    // without needing to mock the full re-review pipeline.
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "deployment-status-4242",
      eventName: "deployment_status",
      payload: {
        installation: { id: 123 },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        deployment_status: { state: "success", environment_url: "https://preview.example.test" },
        deployment: { sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", ref: "feature", payload: JSON.stringify({ pr: 4242 }) },
      },
    } as never);
    const stored = await env.DB.prepare("select status from webhook_events where delivery_id = ?").bind("deployment-status-4242").first<{ status: string }>();
    expect(stored?.status).toBe("processed");
  });

  it("publishes an opt-in gate without comment output, blocking a non-confirmed author normally (#gate-nonconfirmed)", async () => {
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
      linkedIssueGateMode: "block",
      requireLinkedIssue: true,
    });
    const calls = { minerList: 0, gateChecks: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") {
        calls.minerList += 1;
        return Response.json([]);
      }
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate123/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && (init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; status?: string; conclusion?: string; output?: { title?: string } };
        expect(body).toMatchObject({ name: "LoopOver Orb Review Agent", status: "in_progress", output: { title: "LoopOver Orb Review Agent is evaluating" } });
        expect(body.conclusion).toBeUndefined();
        calls.gateChecks += 1;
        return Response.json({ id: 900 }, { status: 201 });
      }
      if (url.includes("/check-runs/900") && (init?.method ?? "GET") === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; status?: string; conclusion?: string; output?: { title?: string } };
        // Non-confirmed author + linked-issue block + no issue → gated normally → failure (#gate-nonconfirmed).
        expect(body).toMatchObject({ name: "LoopOver Orb Review Agent", status: "completed", conclusion: "failure", output: { title: "LoopOver Orb Review Agent: No linked issue detected" } });
        calls.gateChecks += 1;
        return Response.json({ id: 900, html_url: "https://github.com/checks/900" });
      }
      return new Response("not found", { status: 404 });
    });

    // .gittensory.yml authoritatively sets the linked-issue blocker to "block" (config-as-code).
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { linkedIssue: "block" } });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-only",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 42, title: "Gate without issue", state: "open", user: { login: "contributor" }, head: { sha: "gate123" }, labels: [], body: "No issue link." },
      },
    });

    expect(calls).toEqual({ minerList: 1, gateChecks: 2 });
    const stored = await getPullRequest(env, "JSONbored/gittensory", 42);
    expect(stored?.lastPublishedSurfaceSha).toBe("gate123");
    const published = await env.DB.prepare("select metadata_json from audit_events where event_type = ?")
      .bind("github_app.pr_public_surface_published")
      .first<{ metadata_json: string }>();
    expect(published?.metadata_json).toContain('"publishedOutputs":["gate_check_run"]');
    const summary = await env.DB.prepare("select name, status, conclusion from check_summaries where repo_full_name = ? and pull_number = ? and head_sha = ?")
      .bind("JSONbored/gittensory", 42, "gate123")
      .first<{ name: string; status: string; conclusion: string }>();
    expect(summary).toMatchObject({
      name: "LoopOver Orb Review Agent",
      status: "completed",
      conclusion: "failure",
    });
  });

  it("blocks under linkedIssueGateMode:block when the PR only cites an already-CLOSED issue (#unlinked-issue-guardrail-followup — the stale-link gaming case)", async () => {
    // Before the fix, pr.linkedIssues.length > 0 alone satisfied this gate regardless of the cited issue's real
    // state — a contributor could cite an already-closed (or fabricated) issue number to fake compliance.
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
      linkedIssueGateMode: "block",
      requireLinkedIssue: true,
    });
    // .gittensory.yml authoritatively sets the linked-issue blocker to "block" (config-as-code) — mirrors the
    // existing "publishes an opt-in gate..." test above, which needs the same manifest override for the raw
    // DB setting to take effect as a live hard block.
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { linkedIssue: "block" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/5") && !url.includes("/comments")) return Response.json({ number: 5, state: "closed", labels: [], assignees: [] });
      if (url.includes("/commits/gate124/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && (init?.method ?? "GET") === "POST") return Response.json({ id: 901 }, { status: 201 });
      if (url.includes("/check-runs/901") && (init?.method ?? "GET") === "PATCH") return Response.json({ id: 901, html_url: "https://github.com/checks/901" });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-stale-link",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 43, title: "Fake compliance", state: "open", user: { login: "contributor" }, head: { sha: "gate124" }, labels: [], body: "Closes #5" },
      },
    });

    const summary = await env.DB.prepare("select conclusion from check_summaries where repo_full_name = ? and pull_number = ? and head_sha = ?")
      .bind("JSONbored/gittensory", 43, "gate124")
      .first<{ conclusion: string }>();
    expect(summary?.conclusion).toBe("failure");
  });

  it("does NOT block under linkedIssueGateMode:block when the cited issue is genuinely OPEN", async () => {
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
      linkedIssueGateMode: "block",
      requireLinkedIssue: true,
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { linkedIssue: "block" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/issues/5") && !url.includes("/comments")) return Response.json({ number: 5, state: "open", labels: [], assignees: [] });
      if (url.includes("/commits/gate125/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && (init?.method ?? "GET") === "POST") return Response.json({ id: 902 }, { status: 201 });
      if (url.includes("/check-runs/902") && (init?.method ?? "GET") === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { conclusion?: string; output?: { title?: string } };
        expect(body.output?.title).not.toBe("LoopOver Orb Review Agent: No linked issue detected");
        return Response.json({ id: 902, html_url: "https://github.com/checks/902" });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-open-link",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 44, title: "Real link", state: "open", user: { login: "contributor" }, head: { sha: "gate125" }, labels: [], body: "Closes #5" },
      },
    });

    const summary = await env.DB.prepare("select conclusion from check_summaries where repo_full_name = ? and pull_number = ? and head_sha = ?")
      .bind("JSONbored/gittensory", 44, "gate125")
      .first<{ conclusion: string }>();
    expect(summary?.conclusion).not.toBe("failure");
  });

  it("accepts PR-body validation evidence for configured manifest test expectations", async () => {
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
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "off",
      manifestPolicyGateMode: "block",
      requireLinkedIssue: false,
      typeLabelsEnabled: false,
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { testExpectations: ["Run npm run test:ci."] });
    await upsertPullRequestFile(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 43,
      path: "src/feature.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: {},
    });

    const gatePatches: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate-validation/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 901 }, { status: 201 });
      if (url.includes("/check-runs/901") && method === "PATCH") {
        gatePatches.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return Response.json({ id: 901, html_url: "https://github.com/checks/901" });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-validation-evidence",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 43,
          title: "Validated change",
          state: "open",
          user: { login: "contributor" },
          head: { sha: "gate-validation" },
          labels: [],
          body: "Validated with npm run test:ci.",
        },
      },
    });

    expect(gatePatches).toHaveLength(1);
    expect(gatePatches[0]).toMatchObject({ status: "completed", conclusion: "success" });
    expect(JSON.stringify(gatePatches[0])).not.toContain("Configured validation evidence missing");
    expect(JSON.stringify(gatePatches[0])).not.toContain("manifest_missing_tests");
  });

  // REGRESSION (#3304): a PR body that merely MENTIONS testing without affirming it was done ("No tests
  // run.") must not satisfy a configured manifest test expectation on the live webhook gate path.
  it("still flags manifest_missing_tests for a PR body that only claims tests were NOT run", async () => {
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
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "off",
      manifestPolicyGateMode: "block",
      requireLinkedIssue: false,
      typeLabelsEnabled: false,
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { testExpectations: ["Run npm run test:ci."] });
    await upsertPullRequestFile(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 44,
      path: "src/feature.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: {},
    });

    const gatePatches: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate-no-validation/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 902 }, { status: 201 });
      if (url.includes("/check-runs/902") && method === "PATCH") {
        gatePatches.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return Response.json({ id: 902, html_url: "https://github.com/checks/902" });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-no-validation-evidence",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 44,
          title: "Unvalidated change",
          state: "open",
          user: { login: "contributor" },
          head: { sha: "gate-no-validation" },
          labels: [],
          body: "No tests run.",
        },
      },
    });

    expect(gatePatches).toHaveLength(1);
    expect(gatePatches[0]).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(JSON.stringify(gatePatches[0])).toContain("Configured validation evidence missing");
  });

  // #4607 (maybeApplyManifestPolicyGate extraction): buildFocusManifestGuidance can produce findings whose
  // code is NOT one of the two enforceable manifest-policy codes (manifest_linked_issue_required /
  // manifest_missing_tests -- manifest_blocked_path was retired #2974/removed from this Set #5294) -- e.g.
  // manifest_off_focus, when wantedPaths is configured and no changed path matches it. Those non-enforceable
  // findings must be filtered out before
  // ever reaching the advisory/gate, never published alongside an enforceable one from the same pass.
  it("filters out a non-enforceable manifest finding (manifest_off_focus) while still surfacing an enforceable one", async () => {
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
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "off",
      manifestPolicyGateMode: "block",
      requireLinkedIssue: false,
      typeLabelsEnabled: false,
    });
    // wantedPaths configured + a changed file outside it produces manifest_off_focus (NOT one of the three
    // enforceable codes); testExpectations configured + no evidence produces manifest_missing_tests (IS
    // enforceable) -- so this single pass yields one filtered finding and one published finding.
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", {
      wantedPaths: ["docs/"],
      testExpectations: ["Run npm run test:ci."],
    });
    await upsertPullRequestFile(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 45,
      path: "src/feature.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: {},
    });

    const gatePatches: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate-off-focus/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 903 }, { status: 201 });
      if (url.includes("/check-runs/903") && method === "PATCH") {
        gatePatches.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return Response.json({ id: 903, html_url: "https://github.com/checks/903" });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-off-focus-filtered",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 45,
          title: "Out of focus change",
          state: "open",
          user: { login: "contributor" },
          head: { sha: "gate-off-focus" },
          labels: [],
          body: "No tests run.",
        },
      },
    });

    expect(gatePatches).toHaveLength(1);
    // The enforceable finding (manifest_missing_tests) is published...
    expect(JSON.stringify(gatePatches[0])).toContain("Configured validation evidence missing");
    // ...but the non-enforceable finding (manifest_off_focus) is filtered out before it ever reaches the advisory.
    expect(JSON.stringify(gatePatches[0])).not.toContain("Change is outside maintainer-wanted areas");
    expect(JSON.stringify(gatePatches[0])).not.toContain("manifest_off_focus");
  });

  // REGRESSION (#3304): a PR with no body at all (GitHub sends `body: null` for an empty description) must
  // fall back to treating validation evidence as absent, not throw or silently pass the manifest gate.
  it("still flags manifest_missing_tests for a PR with a null body", async () => {
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
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "off",
      manifestPolicyGateMode: "block",
      requireLinkedIssue: false,
      typeLabelsEnabled: false,
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { testExpectations: ["Run npm run test:ci."] });
    await upsertPullRequestFile(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 45,
      path: "src/feature.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: {},
    });

    const gatePatches: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate-null-body/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 903 }, { status: 201 });
      if (url.includes("/check-runs/903") && method === "PATCH") {
        gatePatches.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return Response.json({ id: 903, html_url: "https://github.com/checks/903" });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-null-body-evidence",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 45,
          title: "No-description change",
          state: "open",
          user: { login: "contributor" },
          head: { sha: "gate-null-body" },
          labels: [],
          body: null,
        },
      },
    });

    expect(gatePatches).toHaveLength(1);
    expect(gatePatches[0]).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(JSON.stringify(gatePatches[0])).toContain("Configured validation evidence missing");
  });

  // REGRESSION (#4719 gate-review finding): passedValidationCount previously came ONLY from a PR-body
  // prose match (hasValidationNote), with zero connection to the PR's actual CI results -- a fully green
  // PR whose body simply doesn't happen to use a "tested"/"validated" word still tripped
  // manifest_missing_tests. A fully-green live CI rollup must now ALSO count as validation evidence.
  it("treats a fully-green live CI rollup as validation evidence even with no body validation note (#4719)", async () => {
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
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "off",
      manifestPolicyGateMode: "block",
      requireLinkedIssue: false,
      typeLabelsEnabled: false,
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { testExpectations: ["Run npm run test:ci."] });
    await upsertPullRequestFile(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 46,
      path: "src/feature.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: {},
    });

    const gatePatches: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // A single completed+successful, first-party check-run with no failing/pending statuses -- the
      // live CI aggregate resolves this to ciState: "passed".
      if (url.includes("/commits/gate-ci-green/check-runs")) {
        return Response.json({ total_count: 1, check_runs: [{ name: "build", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
      }
      if (url.includes("/commits/gate-ci-green/status")) return Response.json({ statuses: [] });
      if (url.includes("/commits/gate-ci-green/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 904 }, { status: 201 });
      if (url.includes("/check-runs/904") && method === "PATCH") {
        gatePatches.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return Response.json({ id: 904, html_url: "https://github.com/checks/904" });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-ci-green-evidence",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 46,
          title: "CI-green change with a plain description",
          state: "open",
          user: { login: "contributor" },
          head: { sha: "gate-ci-green" },
          labels: [],
          body: "Fixes the checkout retry bug.",
        },
      },
    });

    expect(gatePatches).toHaveLength(1);
    expect(gatePatches[0]).toMatchObject({ status: "completed", conclusion: "success" });
    expect(JSON.stringify(gatePatches[0])).not.toContain("manifest_missing_tests");
    expect(JSON.stringify(gatePatches[0])).not.toContain("Configured validation evidence missing");
  });

  // REGRESSION: review.auto_review.ignore_authors is only an AI/public-output skip. It must not
  // suppress deterministic manifest policy blockers or the e2e-test-generation trigger that reads them.
  it("still flags manifest_missing_tests for an ignored bot author without validation evidence", async () => {
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
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "off",
      manifestPolicyGateMode: "block",
      requireLinkedIssue: false,
      typeLabelsEnabled: false,
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", {
      testExpectations: ["Run npm run test:ci."],
      review: { auto_review: { ignore_authors: ["*[bot]"] } },
    });
    await upsertPullRequestFile(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 47,
      path: "README.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      payload: {},
    });

    const gatePatches: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate-ignored-bot-blocked/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 905 }, { status: 201 });
      if (url.includes("/check-runs/905") && method === "PATCH") {
        gatePatches.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return Response.json({ id: 905, html_url: "https://github.com/checks/905" });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-ignored-bot-blocked-evidence",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 47,
          title: "Update README",
          state: "open",
          user: { login: "github-actions[bot]" },
          head: { sha: "gate-ignored-bot-blocked" },
          labels: [],
          body: "Auto-generated by a workflow.",
        },
      },
    });

    expect(gatePatches).toHaveLength(1);
    expect(gatePatches[0]).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(JSON.stringify(gatePatches[0])).toContain("Configured validation evidence missing");
  });

  it("stamps a gate-only surface even when local Gate check-summary persistence fails", async () => {
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
    const realPrepare = env.DB.prepare.bind(env.DB);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    env.DB.prepare = ((sql: string) => {
      if (/insert\s+into\s+["`]?check_summaries["`]?/i.test(sql)) throw new Error("summary write failed");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate-summary-fails/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 975 }, { status: 201 });
      if (url.includes("/check-runs/975") && method === "PATCH") return Response.json({ id: 975, html_url: "https://github.com/checks/975" });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-summary-fails",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 85, title: "Gate summary fails", state: "open", user: { login: "contributor" }, head: { sha: "gate-summary-fails" }, labels: [], body: "No issue link." },
      },
    });

    const stored = await getPullRequest(env, "JSONbored/gittensory", 85);
    expect(stored?.lastPublishedSurfaceSha).toBe("gate-summary-fails");
    expect(errors.mock.calls.some((call) => String(call[0]).includes("gate_check_summary_upsert_failed"))).toBe(true);
    errors.mockRestore();
  });

  it("finalizes a permission-missing gate check through the neutral fallback before stamping the surface", async () => {
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
    const realPrepare = env.DB.prepare.bind(env.DB);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    env.DB.prepare = ((sql: string) => {
      if (/insert\s+into\s+["`]?check_summaries["`]?/i.test(sql)) throw new Error("summary write failed");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    let patches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate-permission-fallback/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 976 }, { status: 201 });
      if (url.includes("/check-runs/976") && method === "PATCH") {
        patches += 1;
        if (patches === 1)
          return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
        return Response.json({ id: 976, html_url: "https://github.com/checks/976" });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-permission-fallback",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 86, title: "Gate permission fallback", state: "open", user: { login: "contributor" }, head: { sha: "gate-permission-fallback" }, labels: [], body: "No issue link." },
      },
    });

    expect(patches).toBe(2);
    const stored = await getPullRequest(env, "JSONbored/gittensory", 86);
    expect(stored?.lastPublishedSurfaceSha).toBe("gate-permission-fallback");
    expect(errors.mock.calls.some((call) => String(call[0]).includes("gate_check_permission_missing"))).toBe(true);
    expect(errors.mock.calls.some((call) => String(call[0]).includes("gate_check_summary_upsert_failed"))).toBe(true);
    errors.mockRestore();
  });

  it("does not stamp a permission-missing gate check when the neutral fallback cannot publish", async () => {
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
    let patches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/gate-permission-fallback-fails/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 977 }, { status: 201 });
      if (url.includes("/check-runs/977") && method === "PATCH") {
        patches += 1;
        if (patches === 1)
          return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
        return new Response("fallback update failed", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "gate-permission-fallback-fails",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 87, title: "Gate permission fallback fails", state: "open", user: { login: "contributor" }, head: { sha: "gate-permission-fallback-fails" }, labels: [], body: "No issue link." },
      },
    });

    expect(patches).toBe(2);
    const stored = await getPullRequest(env, "JSONbored/gittensory", 87);
    expect(stored?.lastPublishedSurfaceSha ?? null).toBeNull();
    const incomplete = await env.DB.prepare("select metadata_json from audit_events where event_type = ?")
      .bind("github_app.pr_public_surface_incomplete")
      .first<{ metadata_json: string }>();
    expect(incomplete?.metadata_json).toContain('"publishedOutputs":[]');
    const published = await env.DB.prepare("select event_type from audit_events where event_type = ?")
      .bind("github_app.pr_public_surface_published")
      .all();
    expect(published.results).toEqual([]);
  });

  it("suppresses public review output when the live PR head changed before publish", async () => {
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
      aiReviewMode: "off",
    });
    let commentPosts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/stale.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const stale = true;" }]);
      if (/\/pulls\/55(?:\?|$)/.test(url)) return Response.json({ number: 55, title: "Stale before publish", state: "open", user: { login: "contributor" }, head: { sha: "newsha" }, labels: [], body: "Fixes #1" });
      if (url.includes("/issues/55/comments") && method === "POST") {
        commentPosts += 1;
        return Response.json({ id: 1 }, { status: 201 });
      }
      if (url.includes("/issues/55/comments") && method === "GET") return Response.json([]);
      return new Response("not found", { status: 404 });
    });
    vi.mocked(fetchPullRequestFreshness).mockResolvedValue({
      status: "stale",
      reason: "head_changed",
      expectedHeadSha: "oldsha",
      liveHeadSha: "newsha",
      liveState: "open",
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "stale-before-public-output",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Stale before publish", state: "open", user: { login: "contributor" }, head: { sha: "oldsha" }, labels: [], body: "Fixes #1" },
      },
    });

    expect(commentPosts).toBe(0);
    const stale = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = ?")
      .bind("github_app.pr_review_stale")
      .first<{ detail: string; metadata_json: string }>();
    expect(stale?.detail).toContain("PR head changed from oldsha to newsha");
    expect(JSON.parse(stale?.metadata_json ?? "{}")).toMatchObject({
      phase: "pre_public_output",
      reason: "head_changed",
      expectedHeadSha: "oldsha",
      liveHeadSha: "newsha",
    });
    const published = await env.DB.prepare("select event_type from audit_events where event_type = ?")
      .bind("github_app.pr_public_surface_published")
      .all();
    expect(published.results).toEqual([]);
  });

  it("retries unavailable live PR freshness while suppressing terminal stale review output", async () => {
    const cases = [
      {
        pullNumber: 59,
        deliveryId: "unavailable-before-public-output",
        title: "Unavailable before publish",
        freshness: classifyPullRequestFreshness(undefined, "oldsha", {
          unavailableSource: "pull_request_fetch",
          unavailableDetail: "GitHub API failed for JSONbored/gittensory/pulls/59 (503)",
        }),
        expectRetry: true,
        expectedDetail: "live PR state could not be verified",
        expectedMetadata: {
          reason: "unavailable",
          expectedHeadSha: "oldsha",
          liveHeadSha: null,
          liveState: null,
          unavailableSource: "pull_request_fetch",
          unavailableDetail: "GitHub API failed for JSONbored/gittensory/pulls/59 (503)",
        },
      },
      {
        pullNumber: 60,
        deliveryId: "head-unresolved-before-public-output",
        title: "Unresolved head before publish",
        freshness: classifyPullRequestFreshness(
          {
            state: "open",
            head: {},
          },
          "oldsha",
        ),
        expectRetry: false,
        expectedDetail: "live PR head SHA could not be verified",
        expectedMetadata: {
          reason: "head_unresolved",
          expectedHeadSha: "oldsha",
          liveHeadSha: null,
          liveState: "open",
        },
      },
      {
        pullNumber: 61,
        deliveryId: "unavailable-no-detail-before-public-output",
        title: "Unavailable before publish without detail",
        freshness: classifyPullRequestFreshness(undefined, "oldsha"),
        expectRetry: true,
        expectedDetail: "live PR state could not be verified",
        expectedMetadata: {
          reason: "unavailable",
          expectedHeadSha: "oldsha",
          liveHeadSha: null,
          liveState: null,
          unavailableSource: "unknown",
          unavailableDetail: null,
        },
      },
    ] as const;

    for (const scenario of cases) {
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
        aiReviewMode: "off",
      });
      let commentPosts = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes(`/pulls/${scenario.pullNumber}/files`)) return Response.json([{ filename: "src/stale.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const stale = true;" }]);
        if (url.includes(`/issues/${scenario.pullNumber}/comments`) && method === "POST") {
          commentPosts += 1;
          return Response.json({ id: 1 }, { status: 201 });
        }
        if (url.includes(`/issues/${scenario.pullNumber}/comments`) && method === "GET") return Response.json([]);
        return new Response("not found", { status: 404 });
      });
      vi.mocked(fetchPullRequestFreshness).mockResolvedValue(scenario.freshness);

      const job = processJob(env, {
        type: "github-webhook",
        deliveryId: scenario.deliveryId,
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: scenario.pullNumber, title: scenario.title, state: "open", user: { login: "contributor" }, head: { sha: "oldsha" }, labels: [], body: "Fixes #1" },
        },
      });
      if (scenario.expectRetry) await expect(job).rejects.toThrow("live PR state unavailable");
      else await expect(job).resolves.toBeUndefined();

      expect(commentPosts).toBe(0);
      const stale = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = ?")
        .bind("github_app.pr_review_stale")
        .first<{ detail: string; metadata_json: string }>();
      expect(stale?.detail).toContain(scenario.expectedDetail);
      expect(JSON.parse(stale?.metadata_json ?? "{}")).toMatchObject({
        phase: "pre_public_output",
        ...scenario.expectedMetadata,
      });
      const published = await env.DB.prepare("select event_type from audit_events where event_type = ?")
        .bind("github_app.pr_public_surface_published")
        .all();
      expect(published.results).toEqual([]);
    }
  });

  it("suppresses public review output for no-head reviews when the live PR is closed", async () => {
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
      aiReviewMode: "off",
    });
    let commentPosts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/61/files")) return Response.json([{ filename: "src/no-head.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const noHead = true;" }]);
      if (url.includes("/issues/61/comments") && method === "POST") {
        commentPosts += 1;
        return Response.json({ id: 1 }, { status: 201 });
      }
      if (url.includes("/issues/61/comments") && method === "GET") return Response.json([]);
      return new Response("not found", { status: 404 });
    });
    vi.mocked(fetchPullRequestFreshness).mockResolvedValue(classifyPullRequestFreshness({ state: "closed", head: {} }, null));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "no-head-closed-before-public-output",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 61, title: "No head before publish", state: "open", user: { login: "contributor" }, head: {}, labels: [], body: "Fixes #1" },
      },
    });

    expect(fetchPullRequestFreshness).toHaveBeenCalledWith(env, expect.objectContaining({ expectedHeadSha: null }));
    expect(commentPosts).toBe(0);
    const stale = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = ?")
      .bind("github_app.pr_review_stale")
      .first<{ detail: string; metadata_json: string }>();
    expect(stale?.detail).toContain("PR is no longer open");
    expect(JSON.parse(stale?.metadata_json ?? "{}")).toMatchObject({
      phase: "pre_public_output",
      reason: "closed",
      expectedHeadSha: null,
      liveHeadSha: null,
      liveState: "closed",
    });
    const published = await env.DB.prepare("select event_type from audit_events where event_type = ?")
      .bind("github_app.pr_public_surface_published")
      .all();
    expect(published.results).toEqual([]);
  });

  it("still suppresses stale public output when the stale audit write fails", async () => {
    const originalRecordAuditEvent = repositoriesModule.recordAuditEvent;
    let staleAuditWrites = 0;
    const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockImplementation(async (auditEnv, event) => {
      if (event.eventType === "github_app.pr_review_stale") {
        staleAuditWrites += 1;
        throw new Error("D1 audit failed");
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
      aiReviewMode: "off",
    });
    let commentPosts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/57/files")) return Response.json([{ filename: "src/stale.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const stale = true;" }]);
      if (/\/pulls\/57(?:\?|$)/.test(url)) return Response.json({ number: 57, title: "Stale audit failure", state: "open", user: { login: "contributor" }, head: { sha: "newsha" }, labels: [], body: "Fixes #1" });
      if (url.includes("/issues/57/comments") && method === "POST") {
        commentPosts += 1;
        return Response.json({ id: 1 }, { status: 201 });
      }
      if (url.includes("/issues/57/comments") && method === "GET") return Response.json([]);
      return new Response("not found", { status: 404 });
    });
    vi.mocked(fetchPullRequestFreshness).mockResolvedValue({
      status: "stale",
      reason: "head_changed",
      expectedHeadSha: "oldsha",
      liveHeadSha: "newsha",
      liveState: "open",
    });

    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "stale-audit-failure",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 57, title: "Stale audit failure", state: "open", user: { login: "contributor" }, head: { sha: "oldsha" }, labels: [], body: "Fixes #1" },
        },
      });
    } finally {
      auditSpy.mockRestore();
    }

    expect(staleAuditWrites).toBe(1);
    expect(commentPosts).toBe(0);
    const published = await env.DB.prepare("select event_type from audit_events where event_type = ?")
      .bind("github_app.pr_public_surface_published")
      .all();
    expect(published.results).toEqual([]);
  });

  it("finalizes the pending gate as skipped when the PR head changes after review work", async () => {
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
    let livePullReads = 0;
    const checkBodies: Array<{ status?: string; conclusion?: string; output?: { title?: string; summary?: string } }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url === "https://api.github.com/graphql") {
        return Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
      }
      if (url.includes("/pulls/56/files")) return Response.json([{ filename: "src/final.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const final = true;" }]);
      if (/\/pulls\/56(?:\?|$)/.test(url)) {
        livePullReads += 1;
        return Response.json({
          number: 56,
          title: "Stale after review",
          state: "open",
          user: { login: "contributor" },
          head: { sha: "newsha" },
          labels: [],
          body: "No issue link.",
        });
      }
      if (url.includes("/commits/oldsha/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/oldsha/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      if (url.includes("/check-runs") && method === "POST") {
        checkBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return Response.json({ id: 906 }, { status: 201 });
      }
      if (url.includes("/check-runs/906") && method === "PATCH") {
        checkBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return Response.json({ id: 906 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.mocked(fetchPullRequestFreshness).mockResolvedValue({
      status: "stale",
      reason: "head_changed",
      expectedHeadSha: "oldsha",
      liveHeadSha: "newsha",
      liveState: "open",
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "stale-after-review",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 56, title: "Stale after review", state: "open", user: { login: "contributor" }, head: { sha: "oldsha" }, labels: [], body: "No issue link." },
      },
    });

    expect(livePullReads).toBe(0);
    expect(fetchPullRequestFreshness).toHaveBeenCalledWith(env, expect.objectContaining({ expectedHeadSha: "oldsha" }));
    expect(checkBodies).toHaveLength(2);
    expect(checkBodies[0]).toMatchObject({ status: "in_progress", output: { title: "LoopOver Orb Review Agent is evaluating" } });
    expect(checkBodies[1]).toMatchObject({
      status: "completed",
      conclusion: "skipped",
      output: {
        title: "LoopOver Orb Review Agent skipped",
        summary: "PR head changed from oldsha to newsha",
      },
    });
    const stale = await env.DB.prepare("select metadata_json from audit_events where event_type = ?")
      .bind("github_app.pr_review_stale")
      .first<{ metadata_json: string }>();
    expect(JSON.parse(stale?.metadata_json ?? "{}")).toMatchObject({ phase: "final_publish", reason: "head_changed" });
  });

  it("still suppresses stale final output when the skipped gate check update fails", async () => {
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
    let patchAttempts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url === "https://api.github.com/graphql") {
        return Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
      }
      if (url.includes("/pulls/58/files")) return Response.json([{ filename: "src/final.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const final = true;" }]);
      if (/\/pulls\/58(?:\?|$)/.test(url)) return Response.json({ number: 58, title: "Stale skip failure", state: "open", user: { login: "contributor" }, head: { sha: "newsha" }, labels: [], body: "No issue link." });
      if (url.includes("/commits/oldsha/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/oldsha/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 907 }, { status: 201 });
      if (url.includes("/check-runs/907") && method === "PATCH") {
        patchAttempts += 1;
        throw new Error("check-run update failed");
      }
      return new Response("not found", { status: 404 });
    });
    vi.mocked(fetchPullRequestFreshness).mockResolvedValue({
      status: "stale",
      reason: "head_changed",
      expectedHeadSha: "oldsha",
      liveHeadSha: "newsha",
      liveState: "open",
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "stale-skip-failure",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 58, title: "Stale skip failure", state: "open", user: { login: "contributor" }, head: { sha: "oldsha" }, labels: [], body: "No issue link." },
      },
    });

    expect(patchAttempts).toBe(1);
    const stale = await env.DB.prepare("select metadata_json from audit_events where event_type = ?")
      .bind("github_app.pr_review_stale")
      .first<{ metadata_json: string }>();
    expect(JSON.parse(stale?.metadata_json ?? "{}")).toMatchObject({ phase: "final_publish", reason: "head_changed" });
  });

  it("auto-maintain (#778): a blocking gate on an agent-configured repo records the changes-requested label, never a formal request_changes (dry-run)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "block",
      requireLinkedIssue: true,
      autonomy: { review_state_label: "auto", request_changes: "auto" },
      agentDryRun: true, // dry-run → the actions are recorded but make no GitHub mutation
    });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    // .gittensory.yml authoritatively sets the linked-issue blocker to "block" (config-as-code, as in the gate tests above).
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { linkedIssue: "block" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
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
      deliveryId: "auto-maintain",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 42, title: "No issue", state: "open", user: { login: "contributor" }, head: { sha: "gate123" }, labels: [], body: "No issue link." },
      },
    });

    const labelAudit = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("agent.action.label").first<{ outcome: string; metadata_json: string }>();
    expect(labelAudit?.outcome).toBe("completed");
    expect(JSON.parse(labelAudit?.metadata_json ?? "{}")).toMatchObject({ mode: "dry_run", actionClass: "label" });
    // The bot NEVER posts a formal request_changes (a blocking review strands the PR). With close NOT at an acting
    // level here, a blocking contributor PR is only labeled; with close acting it would be closed. No request_changes.
    const rcAudit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.action.request_changes").first<{ outcome: string }>();
    expect(rcAudit).toBeFalsy();
  });

  it("auto-maintain (#778): uses hard guardrails so guarded paths cannot be merged", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      manifestPolicyGateMode: "block",
      autonomy: { merge: "auto", request_changes: "auto" },
      agentDryRun: true,
    });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { hardGuardrailGlobs: ["migrations/**"] } });
    await upsertPullRequestFile(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 48,
      path: "migrations/0099_attacker.sql",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: {},
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
      deliveryId: "auto-maintain-hard-guardrail",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 48,
          title: "Blocked migration",
          state: "open",
          user: { login: "contributor" },
          head: { sha: "gate123" },
          labels: [],
          body: "Closes #1",
          mergeable_state: "clean",
          reviewDecision: "APPROVED",
        },
      },
    });

    const mergeCount = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("agent.action.merge").first<{ n: number }>();
    expect(mergeCount?.n).toBe(0); // the hard guardrail prevents the auto-merge (the key assertion)
    // The bot never posts a formal request_changes. With close NOT at an acting level here, the blocked PR is
    // simply not merged (no blocking review); with close acting it would be closed.
    const rcAudit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.action.request_changes").first<{ outcome: string }>();
    expect(rcAudit).toBeFalsy();
  });

  it("refreshes pull request files for path-gated pre-merge checks on synchronize (#review-pre-merge-checks)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      autonomy: { merge: "observe", request_changes: "observe" },
      slopGateMode: "off",
      mergeReadinessGateMode: "off",
      manifestPolicyGateMode: "off",
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", {
      review: { pre_merge_checks: [{ name: "Migration approval", require_label: "approved", when_paths: ["migrations/**"], enforce: true }] },
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 49,
      title: "feat: add migration",
      state: "open",
      user: { login: "contributor" },
      head: { sha: "gate125" },
      labels: [],
      body: "Closes #1",
    });
    await upsertPullRequestFile(env, { repoFullName: "JSONbored/gittensory", pullNumber: 49, path: "src/feature.ts", status: "modified", additions: 1, deletions: 0, changes: 1, payload: {} });

    let pullFilesFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/49/files")) {
        pullFilesFetches += 1;
        return Response.json([{ filename: "migrations/0099_security.sql", status: "added", additions: 3, deletions: 0, changes: 3 }]);
      }
      if (url.includes("/pulls/49/reviews")) return Response.json([]);
      if (url.includes("/commits/gate125/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/gate125/status")) return Response.json({ statuses: [] });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pre-merge-refresh-sync",
      eventName: "pull_request",
      payload: {
        action: "synchronize",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 49,
          title: "feat: add migration",
          state: "open",
          user: { login: "contributor" },
          head: { sha: "gate125" },
          labels: [],
          body: "Closes #1",
          mergeable_state: "clean",
        },
      },
    });

    expect(pullFilesFetches).toBeGreaterThan(0);
    expect((await listPullRequestFiles(env, "JSONbored/gittensory", 49)).map((file) => file.path)).toEqual(["migrations/0099_security.sql"]);
  });

  it("pre-merge checks (#review-pre-merge-checks): an enforced check that fails blocks the auto-merge", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "enabled",
      reviewCheckMode: "required",
      autonomy: { merge: "observe", request_changes: "observe" }, // evaluate + post the gate, take no merge/close action
      agentDryRun: false, // so the gate check-run is actually POSTed (dry-run suppresses the write) and capturable
    });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    // The maintainer requires the "approved" label before merge — DETERMINISTIC, enforced.
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { pre_merge_checks: [{ name: "Approved label required", require_label: "approved", enforce: true }] } });
    await upsertPullRequestFile(env, { repoFullName: "JSONbored/gittensory", pullNumber: 49, path: "src/feature.ts", status: "modified", additions: 5, deletions: 0, changes: 5, payload: {} });

    let gateConclusion: string | undefined;
    let gateText = "";
    const captureGate = (body: { name?: string; conclusion?: string; output?: { title?: string; summary?: string } }) => {
      if ((body.name ?? "").includes("LoopOver Orb Review Agent") && body.conclusion) {
        gateConclusion = body.conclusion;
        gateText = `${body.output?.title ?? ""} ${body.output?.summary ?? ""}`;
      }
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/") && url.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/") && url.includes("/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) {
        if (init?.body) captureGate(JSON.parse(init.body.toString()));
        return Response.json({ id: 901 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pre-merge-check-block",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 49,
          title: "feat: add a feature",
          state: "open",
          user: { login: "contributor" },
          head: { sha: "gate124" },
          labels: [], // missing the required "approved" label → the enforced check FAILS
          body: "Closes #1",
          mergeable_state: "clean",
          reviewDecision: "APPROVED",
        },
      },
    });
    // The enforced pre-merge check failed → the gate check-run is a FAILURE that names the specific check.
    expect(gateConclusion).toBe("failure");
    expect(gateText).toContain("Pre-merge check not satisfied: Approved label required");
  });

  it("CLA gate (#2564): claMode: block + a missing consent phrase blocks the auto-merge (acceptance criterion)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "enabled",
      reviewCheckMode: "required",
      autonomy: { merge: "observe", request_changes: "observe" },
      agentDryRun: false,
    });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { claMode: "block", cla: { consentPhrase: "I have read and agree to the CLA" } } });
    await upsertPullRequestFile(env, { repoFullName: "JSONbored/gittensory", pullNumber: 49, path: "src/feature.ts", status: "modified", additions: 5, deletions: 0, changes: 5, payload: {} });

    let gateConclusion: string | undefined;
    let gateText = "";
    const captureGate = (body: { name?: string; conclusion?: string; output?: { title?: string; summary?: string } }) => {
      if ((body.name ?? "").includes("LoopOver Orb Review Agent") && body.conclusion) {
        gateConclusion = body.conclusion;
        gateText = `${body.output?.title ?? ""} ${body.output?.summary ?? ""}`;
      }
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/commits/") && url.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/") && url.includes("/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) {
        if (init?.body) captureGate(JSON.parse(init.body.toString()));
        return Response.json({ id: 901 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "cla-gate-block",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 49,
          title: "feat: add a feature",
          state: "open",
          user: { login: "contributor" },
          head: { sha: "gate126" },
          labels: [],
          body: "Closes #1", // missing the required CLA consent phrase → the gate FAILS
          mergeable_state: "clean",
          reviewDecision: "APPROVED",
        },
      },
    });
    // The CLA consent phrase is missing → the gate check-run is a FAILURE naming the CLA finding.
    expect(gateConclusion).toBe("failure");
    expect(gateText).toContain("CLA consent not confirmed");
  });

  it("CLA gate (#2564): claMode: block + the consent phrase present in the PR body passes the gate", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "enabled",
      reviewCheckMode: "required",
      autonomy: { merge: "observe", request_changes: "observe" },
      agentDryRun: false,
    });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { claMode: "block", cla: { consentPhrase: "I have read and agree to the CLA" } } });
    await upsertPullRequestFile(env, { repoFullName: "JSONbored/gittensory", pullNumber: 50, path: "src/feature.ts", status: "modified", additions: 5, deletions: 0, changes: 5, payload: {} });

    let gateConclusion: string | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/commits/") && url.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/") && url.includes("/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) {
        if (init?.body) {
          const body = JSON.parse(init.body.toString()) as { name?: string; conclusion?: string };
          if ((body.name ?? "").includes("LoopOver Orb Review Agent") && body.conclusion) gateConclusion = body.conclusion;
        }
        return Response.json({ id: 902 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "cla-gate-pass",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 50,
          title: "feat: add a feature",
          state: "open",
          user: { login: "contributor" },
          head: { sha: "gate127" },
          labels: [],
          body: "Closes #1\n\nI have read and agree to the CLA.",
          mergeable_state: "clean",
          reviewDecision: "APPROVED",
        },
      },
    });
    expect(gateConclusion).not.toBe("failure");
  });

  it("CLA gate (#2564) is OFF by default: no manifest opt-in ⇒ a PR with no CLA consent still passes (zero behavior change)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "enabled",
      reviewCheckMode: "required",
      autonomy: { merge: "observe", request_changes: "observe" },
      agentDryRun: false,
      // No gate.claMode manifest override — claGateMode stays undefined (the safe default).
    });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    await upsertPullRequestFile(env, { repoFullName: "JSONbored/gittensory", pullNumber: 51, path: "src/feature.ts", status: "modified", additions: 5, deletions: 0, changes: 5, payload: {} });

    let gateConclusion: string | undefined;
    let gateText = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/commits/") && url.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/") && url.includes("/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) {
        if (init?.body) {
          const body = JSON.parse(init.body.toString()) as { name?: string; conclusion?: string; output?: { title?: string; summary?: string } };
          if ((body.name ?? "").includes("LoopOver Orb Review Agent") && body.conclusion) {
            gateConclusion = body.conclusion;
            gateText = `${body.output?.title ?? ""} ${body.output?.summary ?? ""}`;
          }
        }
        return Response.json({ id: 903 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "cla-gate-off-default",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 51,
          title: "feat: add a feature",
          state: "open",
          user: { login: "contributor" },
          head: { sha: "gate128" },
          labels: [],
          body: "Closes #1", // no CLA consent anywhere — must not matter when claMode is off
          mergeable_state: "clean",
          reviewDecision: "APPROVED",
        },
      },
    });
    expect(gateConclusion).not.toBe("failure");
    expect(gateText).not.toContain("CLA consent not confirmed");
  });

  it("CLA gate (#2564): check-run-conclusion detection — a passing named CLA-bot check-run satisfies consent", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "enabled",
      reviewCheckMode: "required",
      autonomy: { merge: "observe", request_changes: "observe" },
      agentDryRun: false,
    });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    // Check-run-only config: no consentPhrase, so ONLY the named check-run's conclusion is consulted.
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { claMode: "block", cla: { checkRunName: "CLA Assistant Lite", checkRunAppSlug: "cla-assistant" } } });
    await upsertPullRequestFile(env, { repoFullName: "JSONbored/gittensory", pullNumber: 52, path: "src/feature.ts", status: "modified", additions: 5, deletions: 0, changes: 5, payload: {} });

    let gateConclusion: string | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/commits/gate129/check-runs")) {
        return Response.json({ total_count: 1, check_runs: [{ id: 1, name: "CLA Assistant Lite", status: "completed", conclusion: "success", app: { slug: "cla-assistant" } }] });
      }
      if (url.includes("/commits/") && url.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/") && url.includes("/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) {
        if (init?.body) {
          const body = JSON.parse(init.body.toString()) as { name?: string; conclusion?: string };
          if ((body.name ?? "").includes("LoopOver Orb Review Agent") && body.conclusion) gateConclusion = body.conclusion;
        }
        return Response.json({ id: 904 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "cla-gate-checkrun-pass",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 52,
          title: "feat: add a feature",
          state: "open",
          user: { login: "contributor" },
          head: { sha: "gate129" },
          labels: [],
          body: "Closes #1", // no phrase — consent comes entirely from the check-run
          mergeable_state: "clean",
          reviewDecision: "APPROVED",
        },
      },
    });
    expect(gateConclusion).not.toBe("failure");
  });

  it("CLA gate (#2564): check-run-conclusion detection — a failing named CLA-bot check-run blocks the auto-merge", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "enabled",
      reviewCheckMode: "required",
      autonomy: { merge: "observe", request_changes: "observe" },
      agentDryRun: false,
    });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { claMode: "block", cla: { checkRunName: "CLA Assistant Lite", checkRunAppSlug: "cla-assistant" } } });
    await upsertPullRequestFile(env, { repoFullName: "JSONbored/gittensory", pullNumber: 53, path: "src/feature.ts", status: "modified", additions: 5, deletions: 0, changes: 5, payload: {} });

    let gateConclusion: string | undefined;
    let gateText = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/commits/gate130/check-runs")) {
        return Response.json({ total_count: 1, check_runs: [{ id: 2, name: "CLA Assistant Lite", status: "completed", conclusion: "failure", app: { slug: "cla-assistant" } }] });
      }
      if (url.includes("/commits/") && url.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/") && url.includes("/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) {
        if (init?.body) {
          const body = JSON.parse(init.body.toString()) as { name?: string; conclusion?: string; output?: { title?: string; summary?: string } };
          if ((body.name ?? "").includes("LoopOver Orb Review Agent") && body.conclusion) {
            gateConclusion = body.conclusion;
            gateText = `${body.output?.title ?? ""} ${body.output?.summary ?? ""}`;
          }
        }
        return Response.json({ id: 905 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "cla-gate-checkrun-fail",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 53,
          title: "feat: add a feature",
          state: "open",
          user: { login: "contributor" },
          head: { sha: "gate130" },
          labels: [],
          body: "Closes #1",
          mergeable_state: "clean",
          reviewDecision: "APPROVED",
        },
      },
    });
    expect(gateConclusion).toBe("failure");
    expect(gateText).toContain("CLA consent not confirmed");
  });

  it("REGRESSION (gate finding): CLA gate (#2564) — a check-run-only config missing checkRunAppSlug BLOCKS the auto-merge instead of silently holding forever", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "enabled",
      reviewCheckMode: "required",
      autonomy: { merge: "observe", request_changes: "observe" },
      agentDryRun: false,
    });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    // Misconfigured: checkRunName set, checkRunAppSlug forgotten -- no run can ever be trusted, so the gate
    // must BLOCK (not hold), even though a same-name check-run with a passing conclusion exists on the commit.
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { claMode: "block", cla: { checkRunName: "CLA Assistant Lite" } } });
    await upsertPullRequestFile(env, { repoFullName: "JSONbored/gittensory", pullNumber: 54, path: "src/feature.ts", status: "modified", additions: 5, deletions: 0, changes: 5, payload: {} });

    let gateConclusion: string | undefined;
    let gateText = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      // Even though a same-name check-run with a passing conclusion exists on the commit, the missing
      // checkRunAppSlug means fetchNamedCheckRunConclusion never gets far enough to see it (returns null
      // before any check-runs fetch) -- the gate must still see it as blocking, not "not evaluated".
      if (url.includes("/commits/gate131/check-runs")) {
        return Response.json({ total_count: 1, check_runs: [{ id: 3, name: "CLA Assistant Lite", status: "completed", conclusion: "success", app: { slug: "cla-assistant" } }] });
      }
      if (url.includes("/commits/") && url.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/") && url.includes("/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) {
        if (init?.body) {
          const body = JSON.parse(init.body.toString()) as { name?: string; conclusion?: string; output?: { title?: string; summary?: string } };
          if ((body.name ?? "").includes("LoopOver Orb Review Agent") && body.conclusion) {
            gateConclusion = body.conclusion;
            gateText = `${body.output?.title ?? ""} ${body.output?.summary ?? ""}`;
          }
        }
        return Response.json({ id: 906 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "cla-gate-checkrun-missing-slug",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 54,
          title: "feat: add a feature",
          state: "open",
          user: { login: "contributor" },
          head: { sha: "gate131" },
          labels: [],
          body: "Closes #1",
          mergeable_state: "clean",
          reviewDecision: "APPROVED",
        },
      },
    });
    expect(gateConclusion).toBe("failure");
    expect(gateText).toContain("CLA consent not confirmed");
  });

});
