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

  async function setupPlannerRepo(env: Env): Promise<void> {
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["issues", "issue_comment"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
  }

  function plannerWebhook(commentBody: string, sender: string, issueOverride?: Record<string, unknown>): Parameters<typeof processJob>[1] {
    return {
      type: "github-webhook",
      deliveryId: `plan-${sender}-${commentBody.length}-${issueOverride ? "pr" : "issue"}`,
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: issueOverride ?? { number: 77, title: "Add a retry to the fetch helper", state: "open", user: { login: "reporter" }, body: "The fetch helper should retry on 5xx." },
        comment: { body: commentBody, user: { login: sender, type: "User" } },
        sender: { login: sender, type: "User" },
      },
    } as unknown as Parameters<typeof processJob>[1];
  }

  it("planner (#issue-coding-plan): a maintainer @gittensory plan on an issue posts an AI plan (flag ON)", async () => {
    const run = vi.fn(async () => ({ response: "## Summary\nAdd retry-on-5xx to the fetch helper.\n\n## Steps\n1. Wrap the fetch in a retry loop." }));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "true", AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    let postedBody: string | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" }); // maintainer
      if (url.includes("/issues/77/comments")) {
        postedBody = init?.body ? JSON.parse(init.body.toString()).body : undefined;
        return Response.json({ id: 5 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, plannerWebhook("@gittensory plan", "maintainer1"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(postedBody).toContain("Gittensory implementation plan");
    expect(postedBody).toContain("Add retry-on-5xx");
    const audit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.issue_plan_generated").first<{ n: number }>();
    expect(audit?.n).toBe(1);
    const usage = await env.DB.prepare("select feature, actor, status, estimated_neurons, metadata_json from ai_usage_events where feature = ?").bind("issue_plan").first<{ feature: string; actor: string; status: string; estimated_neurons: number; metadata_json: string }>();
    expect(usage?.status).toBe("ok");
    expect(usage?.actor).toBe("maintainer1");
    expect(usage?.estimated_neurons).toBeGreaterThan(0);
    expect(JSON.parse(usage?.metadata_json ?? "{}")).toMatchObject({ repoFullName: "JSONbored/gittensory", issueNumber: 77 });
  });

  it("planner: enforces the shared AI budget before calling Workers AI", async () => {
    const run = vi.fn(async () => ({ response: "should not run" }));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "true", AI_DAILY_NEURON_BUDGET: "0", AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory plan", "maintainer1"));
    expect(run).not.toHaveBeenCalled();
    const usage = await env.DB.prepare("select status from ai_usage_events where feature = ?").bind("issue_plan").first<{ status: string }>();
    expect(usage?.status).toBe("quota_exceeded");
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.issue_plan_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("no_plan_generated");
  });

  it("planner: respects agentPaused — never spends Workers AI on a paused repo (#2257)", async () => {
    const run = vi.fn(async () => ({ response: "should not run" }));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "true", AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", agentPaused: true });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory plan", "maintainer1"));
    expect(run).not.toHaveBeenCalled(); // no speculative AI spend on a paused repo
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.issue_plan_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("agent_paused");
  });

  it("planner: respects a global freeze — never spends Workers AI while the DB kill-switch is engaged (#2257)", async () => {
    const run = vi.fn(async () => ({ response: "should not run" }));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "true", AGENT_ACTIONS_PAUSED: "true", AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory plan", "maintainer1"));
    expect(run).not.toHaveBeenCalled();
  });

  it("planner: respects agentDryRun — never spends Workers AI on a dry-run repo (#2257)", async () => {
    const run = vi.fn(async () => ({ response: "should not run" }));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "true", AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", agentDryRun: true });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory plan", "maintainer1"));
    expect(run).not.toHaveBeenCalled();
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.issue_plan_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("dry_run");
  });

  it("planner: enforces a per-actor per-repo cooldown before spending AI", async () => {
    const run = vi.fn(async () => ({ response: "## Summary\nPlan." }));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "true", AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      if (url.includes("/issues/77/comments")) return Response.json({ id: init?.body ? 5 : 6 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory plan", "maintainer1"));
    await processJob(env, plannerWebhook("@gittensory plan again", "maintainer1"));
    expect(run).toHaveBeenCalledTimes(1);
    const cooldown = await env.DB.prepare("select detail from audit_events where event_type = ? and detail = ?").bind("github_app.issue_plan_skipped", "cooldown_active").first<{ detail: string }>();
    expect(cooldown?.detail).toBe("cooldown_active");
  });

  it("planner: flag OFF is byte-identical — @gittensory plan posts no plan and the AI is never called", async () => {
    const run = vi.fn(async () => ({ response: "should not run" }));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "false", AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    let postedPlan = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      if (url.includes("/issues/77/comments")) {
        if (init?.body && JSON.parse(init.body.toString()).body?.includes("implementation plan")) postedPlan = true;
        return Response.json({ id: 5 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory plan", "maintainer1"));
    expect(run).not.toHaveBeenCalled();
    expect(postedPlan).toBe(false);
  });

  it("planner: a NON-maintainer is denied — no plan is generated or posted (flag ON)", async () => {
    const run = vi.fn(async () => ({ response: "should not run" }));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "true", AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "read" }); // not a maintainer
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory plan", "outsider"));
    expect(run).not.toHaveBeenCalled();
    const denied = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.issue_plan_skipped").first<{ detail: string }>();
    // Authorization now flows through the per-repo commandAuthorization policy (#21), so the skip reason is the
    // policy's verdict (not the old bespoke "actor_not_maintainer").
    expect(denied?.detail).toBe("not_maintainer_or_pr_author");
  });

  it("planner (#21): honors a per-repo commandAuthorization override that restricts `plan` to maintainers", async () => {
    const run = vi.fn(async () => ({ response: "should not run" }));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "true", AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    // Override: `plan` is maintainer-ONLY (drop the default collaborator role).
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", commandAuthorization: { default: ["maintainer", "collaborator", "confirmed_miner"], commands: { plan: ["maintainer"] } } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "write" }); // collaborator, not maintainer
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory plan", "collab1"));
    expect(run).not.toHaveBeenCalled();
    const denied = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.issue_plan_skipped").first<{ detail: string }>();
    expect(denied?.detail).toBe("not_maintainer_or_pr_author");
  });


  it("planner: a flag-ON non-plan comment is not intercepted (the handler declines)", async () => {
    const run = vi.fn(async () => ({ response: "nope" }));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "true", AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await processJob(env, plannerWebhook("just a normal comment with no command", "maintainer1"));
    expect(run).not.toHaveBeenCalled(); // not a plan command → maybeProcessPlanCommand returns false, no AI spend
  });

  it("planner (#22): @gittensory plan on a PR is NOT consumed — it falls through (no plan, no skip audit)", async () => {
    const run = vi.fn(async () => ({ response: "nope" }));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "true", AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    vi.stubGlobal("fetch", async () => Response.json({}));
    await processJob(env, plannerWebhook("@gittensory plan", "maintainer1", { number: 77, title: "PR not issue", state: "open", user: { login: "x" }, body: "b", pull_request: { url: "https://api.github.com/x" } }));
    expect(run).not.toHaveBeenCalled();
    // Planning is issue-only; a PR-thread `plan` falls through to the mention/help path (flag-ON now matches
    // flag-OFF) instead of being swallowed as a plan skip.
    const planAudits = await env.DB.prepare("select count(*) as n from audit_events where event_type in (?, ?)").bind("github_app.issue_plan_skipped", "github_app.issue_plan_generated").first<{ n: number }>();
    expect(planAudits?.n).toBe(0);
  });

  it("planner: a bot-authored @gittensory plan on an issue is recorded as a classifier skip", async () => {
    const run = vi.fn(async () => ({ response: "nope" }));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "true", AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    vi.stubGlobal("fetch", async () => Response.json({}));
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "plan-bot",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 77, title: "Issue", state: "open", user: { login: "reporter" }, body: "b" },
        comment: { body: "@gittensory plan", user: { login: "some-bot[bot]", type: "Bot" } },
        sender: { login: "some-bot[bot]", type: "Bot" },
      },
    } as unknown as Parameters<typeof processJob>[1]);
    expect(run).not.toHaveBeenCalled();
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.issue_plan_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("unsupported_comment_action_or_bot");
  });

  it("planner: a maintainer request that yields no plan is recorded as a skip (fail-safe)", async () => {
    const run = vi.fn(async () => ({ response: "   " })); // model returns nothing usable
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "true", AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    let posted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "write" }); // maintainer
      if (url.includes("/issues/77/comments")) {
        posted = true;
        return Response.json({ id: 5 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory plan", "maintainer1"));
    expect(posted).toBe(false); // no plan → nothing posted
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.issue_plan_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("no_plan_generated");
  });

  it("configuration (#2168): a maintainer @gittensory configuration posts the effective resolved config", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupPlannerRepo(env);
    let postedBody: string | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" }); // maintainer
      if (url.includes("/issues/77/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/77/comments") && method === "POST") {
        postedBody = init?.body ? JSON.parse(init.body.toString()).body : undefined;
        return Response.json({ id: 5 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory configuration", "maintainer1"));
    expect(postedBody).toContain("Effective review configuration");
    expect(postedBody).toContain("Agent execution mode: **live**");
    expect(postedBody).toContain("Autonomy by action class:");
    // public-safe: never leaks a reward/trust/wallet field
    expect(postedBody?.toLowerCase()).not.toMatch(/reward|wallet|hotkey|coldkey|trustscore/);
    const audit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.configuration_posted").first<{ outcome: string }>();
    expect(audit?.outcome).toBe("completed");
  });

  it.each([
    ["env pause", async (env: Env) => { (env as Env & { AGENT_ACTIONS_PAUSED: string }).AGENT_ACTIONS_PAUSED = "true"; }, "paused"],
    ["repo pause", async (env: Env) => { await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", agentPaused: true }); }, "paused"],
    ["repo dry-run", async (env: Env) => { await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", agentDryRun: true }); }, "dry_run"],
    ["DB global freeze", async (env: Env) => { await setGlobalAgentFrozen(env, true); }, "paused"],
  ] as const)("configuration respects %s — never posts the effective-config comment live", async (_label, applyPause, expectedMode) => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupPlannerRepo(env);
    await applyPause(env);
    const calls = { commentPosts: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      if (url.includes("/issues/77/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/77/comments") && method === "POST") {
        calls.commentPosts += 1;
        return Response.json({ id: 5 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    await processJob(env, plannerWebhook("@gittensory configuration", "maintainer1"));

    expect(calls.commentPosts).toBe(0);
    const audit = await env.DB.prepare("select json_extract(metadata_json, '$.mode') as mode from audit_events where event_type = ?").bind("github_app.configuration_posted").first<{ mode: string }>();
    expect(audit?.mode).toBe(expectedMode);
  });

  it("configuration: a non-maintainer is denied — nothing is posted and a skip is recorded", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupPlannerRepo(env);
    let posted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "read" }); // not a maintainer
      if (url.includes("/issues/77/comments")) {
        posted = true;
        return Response.json({ id: 5 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory configuration", "outsider"));
    expect(posted).toBe(false);
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.configuration_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("not_maintainer_or_pr_author");
  });

  it("configuration: a non-configuration comment is not intercepted (the handler declines, no config audit)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupPlannerRepo(env);
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await processJob(env, plannerWebhook("just a normal comment, no mention", "maintainer1"));
    const posted = await env.DB.prepare("select 1 from audit_events where event_type = ?").bind("github_app.configuration_posted").first();
    const skipped = await env.DB.prepare("select 1 from audit_events where event_type = ?").bind("github_app.configuration_skipped").first();
    expect(posted).toBeFalsy();
    expect(skipped).toBeFalsy();
  });

  it("configuration: a bot-authored command is recorded as a classifier skip, never posted", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupPlannerRepo(env);
    let posted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/comments")) posted = true;
      return new Response("not found", { status: 404 });
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "config-bot",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 77, title: "t", state: "open", user: { login: "reporter" }, body: "b" },
        comment: { body: "@gittensory configuration", user: { login: "some-bot[bot]", type: "Bot" } },
        sender: { login: "some-bot[bot]", type: "Bot" },
      },
    } as unknown as Parameters<typeof processJob>[1]);
    expect(posted).toBe(false);
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.configuration_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("unsupported_comment_action_or_bot");
  });

  const pauseIssue = { number: 77, title: "Add a retry to the fetch helper", state: "open", user: { login: "reporter" }, body: "b", pull_request: { url: "https://api.github.com/repos/JSONbored/gittensory/pulls/77" } };
  async function seedPausePr(env: Env): Promise<void> {
    await setupPlannerRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 77, title: "Add a retry to the fetch helper", state: "open", user: { login: "reporter" }, head: { sha: "h1" }, labels: [], body: "b" });
  }
  // Mirrors hasAutoreviewPausedMarker's own MOST-RECENT-of-{paused,resumed} query (#2165) via a raw read,
  // rather than exporting that internal helper just for tests -- same pattern the pre-existing pause tests
  // already use (raw audit_events queries) instead of importing processors.ts internals.
  async function isCurrentlyPaused(env: Env, repoFullName: string, prNumber: number): Promise<boolean> {
    const row = await env.DB.prepare(
      "select event_type from audit_events where event_type in (?, ?) and target_key = ? and outcome = ? order by created_at desc, rowid desc limit 1",
    )
      .bind("github_app.autoreview_paused", "github_app.autoreview_resumed", `${repoFullName}#${prNumber}`, "completed")
      .first<{ event_type: string }>();
    return row?.event_type === "github_app.autoreview_paused";
  }

  it("pause (#2164): a maintainer @gittensory pause records the autoreview-paused marker and posts a public-safe confirmation", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedPausePr(env);
    let postedBody: string | undefined;
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      urls.push(url);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" }); // maintainer
      if (url.includes("/issues/77/comments")) {
        postedBody = init?.body ? JSON.parse(init.body.toString()).body : undefined;
        return Response.json({ id: 5 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory pause flaky CI, will re-enable after the fix", "maintainer1", pauseIssue));
    expect(postedBody).toContain("Auto-review paused by @maintainer1");
    expect(postedBody).toContain("Gate enforcement and the one-shot disposition are unchanged");
    expect(postedBody).toContain("flaky CI, will re-enable after the fix");
    // AUTO-REVIEW SCOPE ONLY (#2164): no Gate check-run is written and no gate-disposition audit is recorded, so the
    // one-shot gate/advisory is provably untouched.
    expect(urls.some((u) => u.includes("/check-runs"))).toBe(false);
    const gateAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type like 'github_app.gate_%'").first<{ n: number }>();
    expect(gateAudit?.n).toBe(0);
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.autoreview_paused").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("completed");
    expect(audit?.detail).toBe("flaky CI, will re-enable after the fix");
    const usage = await env.DB.prepare("select outcome from product_usage_events where event_name = ?").bind("autoreview_paused").first<{ outcome: string }>();
    expect(usage?.outcome).toBe("completed");
  });

  it("pause: an authorized pause with no trailing reason records the marker with a 'No reason provided.' detail", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedPausePr(env);
    let postedBody: string | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      if (url.includes("/issues/77/comments")) {
        postedBody = init?.body ? JSON.parse(init.body.toString()).body : undefined;
        return Response.json({ id: 5 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory pause", "maintainer1", pauseIssue));
    expect(postedBody).toContain("No reason provided.");
    const audit = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.autoreview_paused").first<{ detail: string }>();
    expect(audit?.detail).toBe("No reason provided.");
  });

  it("pause: a non-maintainer is denied — nothing is posted and a denied marker is recorded (never a pause)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedPausePr(env);
    let posted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "read" }); // not a maintainer
      if (url.includes("/issues/77/comments")) {
        posted = true;
        return Response.json({ id: 5 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory pause let me in", "outsider", pauseIssue));
    expect(posted).toBe(false);
    const denied = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.autoreview_paused_denied").first<{ outcome: string }>();
    expect(denied?.outcome).toBe("denied");
    const paused = await env.DB.prepare("select 1 from audit_events where event_type = ?").bind("github_app.autoreview_paused").first();
    expect(paused).toBeFalsy();
  });

  it("pause: a pause on a PR with no cached record is recorded as a cached_pr_missing skip, never posted", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupPlannerRepo(env); // repo + installation, but deliberately NO cached PR record
    let posted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      if (url.includes("/comments")) posted = true;
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory pause", "maintainer1", pauseIssue));
    expect(posted).toBe(false);
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.autoreview_paused_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("cached_pr_missing");
  });

  it("pause: a bot-authored @gittensory pause is recorded as a classifier skip, never posted", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedPausePr(env);
    let posted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/comments")) posted = true;
      return new Response("not found", { status: 404 });
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "pause-bot",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: pauseIssue,
        comment: { body: "@gittensory pause", user: { login: "some-bot[bot]", type: "Bot" } },
        sender: { login: "some-bot[bot]", type: "Bot" },
      },
    } as unknown as Parameters<typeof processJob>[1]);
    expect(posted).toBe(false);
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.autoreview_paused_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("bot_author");
  });

  it("pause: a non-pause comment is not intercepted (the handler declines, no autoreview audit)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedPausePr(env);
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await processJob(env, plannerWebhook("just a normal comment, no mention", "maintainer1", pauseIssue));
    const paused = await env.DB.prepare("select 1 from audit_events where event_type like 'github_app.autoreview_paused%'").first();
    expect(paused).toBeFalsy();
  });

  const reviewIssue = { number: 78, title: "Draft feature for review command", state: "open", user: { login: "reporter" }, body: "b", pull_request: { url: "https://api.github.com/repos/JSONbored/gittensory/pulls/78" } };
  async function seedReviewPr(env: Env, options: { draft?: boolean } = {}): Promise<void> {
    await setupPlannerRepo(env);
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { review: { auto_review: { skip_drafts: true } } });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 78, title: "Draft feature for review command", state: "open", draft: options.draft ?? true, user: { login: "reporter" }, head: { sha: "r78" }, labels: [], body: "b" });
    await upsertPullRequestDetailSyncState(env, { repoFullName: "JSONbored/gittensory", pullNumber: 78, status: "complete", reviewsSyncedAt: new Date().toISOString() });
  }
  function reviewCommandFetchStub(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
    const seen: string[] = [];
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      seen.push(url);
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" }); // maintainer
      if (url.includes("/pulls/78/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/78")) return Response.json({ number: 78, title: "Draft feature for review command", state: "open", draft: true, user: { login: "reporter" }, head: { sha: "r78" }, labels: [], body: "b", mergeable_state: "clean" });
      if (url.includes("/commits/r78/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/r78/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      if (url.includes("/issues/78/comments") && method === "POST") return Response.json({ id: 78 }, { status: 201 });
      if (url.includes("/issues/78/comments")) return Response.json([]);
      if (url.includes("/check-runs") && (method === "POST" || method === "PATCH")) return Response.json({ id: 981 }, { status: method === "POST" ? 201 : 200 });
      return Response.json({});
    };
  }

  it("review (#2163): an authorized @gittensory review posts a confirmation, dispatches a REAL re-review (proven by a live PR resync fetch inside reReviewStoredPullRequest, not just the command's own comment post), and records review_command_completed", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedReviewPr(env);
    let postedCommentBody: string | undefined;
    let liveResyncFetched = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/issues/78/comments") && method === "POST") {
        postedCommentBody = init?.body ? JSON.parse(init.body.toString()).body : undefined;
        return Response.json({ id: 78 }, { status: 201 });
      }
      // reReviewStoredPullRequest's own live-head resync (#sweep-resync) GETs the PR fresh before reviewing --
      // this only happens INSIDE that function, never in the command handler's own classify/authorize/confirm
      // steps, so seeing it proves the dispatch call genuinely reached the real re-review path.
      if (url.endsWith("/pulls/78") && method === "GET") liveResyncFetched = true;
      return reviewCommandFetchStub()(input, init);
    });
    await processJob(env, plannerWebhook("@gittensory review", "maintainer1", reviewIssue));
    expect(postedCommentBody).toContain("Re-review triggered by @maintainer1");
    expect(liveResyncFetched).toBe(true); // proves the real reReviewStoredPullRequest path ran, unlike pause
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_command_completed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("completed");
    const usage = await env.DB.prepare("select outcome from product_usage_events where event_name = ?").bind("review_command_completed").first<{ outcome: string }>();
    expect(usage?.outcome).toBe("completed");
    // The command itself never writes repository_settings -- it only triggers a fresh eval through the same
    // path a scheduled sweep would take (#2163's hard constraint: never reimplements/flips the disposition).
    const settingsRow = await env.DB.prepare("select 1 from repository_settings where repo_full_name = ?").bind("JSONbored/gittensory").first();
    expect(settingsRow).toBeFalsy();
  });

  it("review: the 're-review' alias resolves to the same handler", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedReviewPr(env);
    let postedCommentBody: string | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/issues/78/comments") && method === "POST") {
        postedCommentBody = init?.body ? JSON.parse(init.body.toString()).body : undefined;
        return Response.json({ id: 78 }, { status: 201 });
      }
      return reviewCommandFetchStub()(input, init);
    });
    await processJob(env, plannerWebhook("@gittensory re-review", "maintainer1", reviewIssue));
    expect(postedCommentBody).toContain("Re-review triggered by @maintainer1");
  });

  it("review: a non-maintainer/collaborator/confirmed-miner is denied — nothing posted, no re-review dispatched", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedReviewPr(env);
    let posted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "read" }); // not authorized
      if (url.includes("/comments")) posted = true;
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory review", "outsider", reviewIssue));
    expect(posted).toBe(false);
    const denied = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.review_command_denied").first<{ outcome: string }>();
    expect(denied?.outcome).toBe("denied");
    const completed = await env.DB.prepare("select 1 from audit_events where event_type = ?").bind("github_app.review_command_completed").first();
    expect(completed).toBeFalsy();
  });

  // REGRESSION: DEFAULT_COMMAND_AUTHORIZATION_POLICY deliberately widens "review" to confirmed_miner (a
  // confirmed miner may re-trigger review on their own PR, the same self-rerun precedent as review-now). That
  // requires authorizePrActionActor's needsMinerDetection: true -- an earlier version of this handler omitted
  // it, so a confirmed miner's OWN PR author (not a maintainer/collaborator) was wrongly denied every time,
  // since there was no other role they could match instead.
  it("review: a confirmed Gittensor miner is authorized to re-review their OWN PR (not a maintainer/collaborator)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedReviewPr(env);
    await upsertOfficialMinerDetection(env, "reporter", { status: "confirmed", snapshot: queueMinerSnapshot("reporter") }, 60_000);
    // A confirmed miner is ALSO a confirmedContributor for the dispatched reReviewStoredPullRequest's own
    // public-surface eligibility, so this pass can post a SECOND, unrelated deterministic panel comment
    // alongside the review command's own confirmation -- collect every posted body rather than assuming
    // the command's confirmation is the only (or the last) one.
    const postedBodies: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/collaborators/") && url.includes("/permission")) return new Response("not found", { status: 404 }); // no repo permission at all
      if (url.includes("/issues/78/comments") && method === "POST") {
        postedBodies.push(init?.body ? JSON.parse(init.body.toString()).body : "");
        return Response.json({ id: 78 }, { status: 201 });
      }
      return reviewCommandFetchStub()(input, init);
    });

    await processJob(env, plannerWebhook("@gittensory review", "reporter", reviewIssue));

    expect(postedBodies.some((body) => body.includes("Re-review triggered by @reporter"))).toBe(true);
    const completed = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.review_command_completed").first<{ outcome: string }>();
    expect(completed?.outcome).toBe("completed");
    const denied = await env.DB.prepare("select 1 from audit_events where event_type = ?").bind("github_app.review_command_denied").first();
    expect(denied).toBeFalsy();
    const forceBypass = await env.DB.prepare("select 1 from audit_events where event_type = ? and target_key = ?").bind("github_app.ai_review_force_bypass", "JSONbored/gittensory#78").first();
    expect(forceBypass).toBeFalsy();
  });

  it("review: respects agentPaused and agentDryRun without dispatching re-review", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedReviewPr(env);
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", agentPaused: true });
    vi.stubGlobal("fetch", reviewCommandFetchStub());

    await processJob(env, plannerWebhook("@gittensory review", "maintainer1", reviewIssue));
    let skipped = await env.DB.prepare("select detail from audit_events where event_type = ? order by rowid desc limit 1").bind("github_app.review_command_skipped").first<{ detail: string }>();
    expect(skipped?.detail).toBe("agent_paused");
    let completed = await env.DB.prepare("select 1 from audit_events where event_type = ?").bind("github_app.review_command_completed").first();
    expect(completed).toBeFalsy();

    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", agentPaused: false, agentDryRun: true });
    await processJob(env, plannerWebhook("@gittensory review", "maintainer1", reviewIssue));
    skipped = await env.DB.prepare("select detail from audit_events where event_type = ? order by rowid desc limit 1").bind("github_app.review_command_skipped").first<{ detail: string }>();
    expect(skipped?.detail).toBe("dry_run");
    completed = await env.DB.prepare("select 1 from audit_events where event_type = ?").bind("github_app.review_command_completed").first();
    expect(completed).toBeFalsy();
  });

  it("review: a review command on a PR with no cached record is recorded as a cached_pr_missing skip, never posted", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupPlannerRepo(env); // repo + installation, but deliberately NO cached PR record
    let posted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      if (url.includes("/comments")) posted = true;
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory review", "maintainer1", reviewIssue));
    expect(posted).toBe(false);
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.review_command_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("cached_pr_missing");
  });

  it("review: a bot-authored @gittensory review is recorded as a classifier skip, never posted", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedReviewPr(env);
    let posted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/comments")) posted = true;
      return new Response("not found", { status: 404 });
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "review-bot",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: reviewIssue,
        comment: { body: "@gittensory review", user: { login: "some-bot[bot]", type: "Bot" } },
        sender: { login: "some-bot[bot]", type: "Bot" },
      },
    } as unknown as Parameters<typeof processJob>[1]);
    expect(posted).toBe(false);
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.review_command_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("bot_author");
  });

  it("resume (#2165): an authorized @gittensory resume clears an earlier pause and posts a public-safe confirmation", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedPausePr(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      if (url.includes("/issues/77/comments") && (init?.method ?? "GET") === "POST") return Response.json({ id: 5 }, { status: 201 });
      if (url.includes("/issues/77/comments")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });
    // Pause first, matching real usage: a resume without a prior pause is still valid (idempotent), but this
    // proves the SUPERSEDE behavior, not just that resume can run standalone.
    await processJob(env, plannerWebhook("@gittensory pause", "maintainer1", pauseIssue));
    expect(await isCurrentlyPaused(env, "JSONbored/gittensory", 77)).toBe(true);

    let postedBody: string | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      if (url.includes("/issues/77/comments")) {
        postedBody = init?.body ? JSON.parse(init.body.toString()).body : undefined;
        return Response.json({ id: 6 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory resume", "maintainer1", pauseIssue));
    expect(postedBody).toContain("Auto-review resumed by @maintainer1");
    const audit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.autoreview_resumed").first<{ outcome: string }>();
    expect(audit?.outcome).toBe("completed");
    // The core bug fix (#2165): hasAutoreviewPausedMarker now reads the MOST RECENT of {paused, resumed}, so
    // resume actually supersedes the earlier pause instead of silently no-opping forever.
    expect(await isCurrentlyPaused(env, "JSONbored/gittensory", 77)).toBe(false);
  });

  it("resume: a LATER pause after a resume still re-pauses correctly (ordering, not just existence)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedPausePr(env);
    const adminFetch = (): ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => async (input, init) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      if (url.includes("/issues/77/comments") && (init?.method ?? "GET") === "POST") return Response.json({ id: 5 }, { status: 201 });
      if (url.includes("/issues/77/comments")) return Response.json([]);
      return new Response("not found", { status: 404 });
    };
    vi.stubGlobal("fetch", adminFetch());
    await processJob(env, plannerWebhook("@gittensory pause", "maintainer1", pauseIssue));
    expect(await isCurrentlyPaused(env, "JSONbored/gittensory", 77)).toBe(true);
    vi.stubGlobal("fetch", adminFetch());
    await processJob(env, plannerWebhook("@gittensory resume", "maintainer1", pauseIssue));
    expect(await isCurrentlyPaused(env, "JSONbored/gittensory", 77)).toBe(false);
    vi.stubGlobal("fetch", adminFetch());
    await processJob(env, plannerWebhook("@gittensory pause again", "maintainer1", pauseIssue));
    expect(await isCurrentlyPaused(env, "JSONbored/gittensory", 77)).toBe(true);
  });

  it("resume: a non-maintainer/collaborator is denied — nothing posted and the pause marker is untouched", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedPausePr(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      if (url.includes("/issues/77/comments") && (init?.method ?? "GET") === "POST") return Response.json({ id: 5 }, { status: 201 });
      if (url.includes("/issues/77/comments")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory pause", "maintainer1", pauseIssue));
    let posted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "read" }); // not authorized
      if (url.includes("/comments")) posted = true;
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory resume", "outsider", pauseIssue));
    expect(posted).toBe(false);
    const denied = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.autoreview_resumed_denied").first<{ outcome: string }>();
    expect(denied?.outcome).toBe("denied");
    expect(await isCurrentlyPaused(env, "JSONbored/gittensory", 77)).toBe(true); // still paused
  });

  it("resume: a resume on a PR with no cached record is recorded as a cached_pr_missing skip, never posted", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupPlannerRepo(env); // repo + installation, but deliberately NO cached PR record
    let posted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      if (url.includes("/comments")) posted = true;
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@gittensory resume", "maintainer1", pauseIssue));
    expect(posted).toBe(false);
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.autoreview_resumed_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("cached_pr_missing");
  });

  it("resume: a bot-authored @gittensory resume is recorded as a classifier skip, never posted", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedPausePr(env);
    let posted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/comments")) posted = true;
      return new Response("not found", { status: 404 });
    });
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "resume-bot",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: pauseIssue,
        comment: { body: "@gittensory resume", user: { login: "some-bot[bot]", type: "Bot" } },
        sender: { login: "some-bot[bot]", type: "Bot" },
      },
    } as unknown as Parameters<typeof processJob>[1]);
    expect(posted).toBe(false);
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.autoreview_resumed_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("bot_author");
  });

  it("REGRESSION (#audit-draft-maintenance): a clean DRAFT PR is never auto-merged/approved/closed (drafts are WIP)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      action: "created",
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        target_type: "User",
        repository_selection: "all",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    // Clean, mergeable, approved, green CI + merge:auto + close:auto + approve:auto — a NON-draft here would be
    // auto-acted. The ONLY thing that must stop it is the draft guard in maybeRunAgentMaintenance.
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      autoLabelEnabled: false,
      checkRunMode: "off",
      reviewCheckMode: "required",
      autonomy: { merge: "auto", approve: "auto", close: "auto" },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/draft1/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/draft1/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) return Response.json({ id: 901 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "draft-no-maintenance",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 49,
          title: "Work in progress",
          state: "open",
          draft: true,
          user: { login: "contributor" },
          head: { sha: "draft1" },
          labels: [],
          body: "Closes #1",
          mergeable_state: "clean",
          reviewDecision: "APPROVED",
        },
      },
    });

    // No terminal maintenance action of ANY class fires on a draft.
    const acted = await env.DB.prepare("select count(*) as n from audit_events where event_type in ('agent.action.merge','agent.action.approve','agent.action.close')").first<{ n: number }>();
    expect(acted?.n).toBe(0);
  });

  it("blacklist (#1425): a banned author's PR is labeled + closed deterministically with NO AI call and no merit merge", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "n/a", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      // The banned login is per-repo DB config; the label is the configurable `.gittensory.yml` value below —
      // nothing is hard-coded.
      contributorBlacklist: [{ login: "baduser", reason: "plagiarism" }],
    });
    // The label is configurable via `.gittensory.yml` (default "slop"); set a custom one to prove it's not hardcoded.
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { blacklistLabel: "spam" } }, "repo_file");
    const seen = { closed: false, labels: [] as string[], comments: [] as string[] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if ((url.endsWith("/pulls/53") || url.endsWith("/pulls/54")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/pulls/55") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 55, state: "closed" }); }
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "baduser" }, head: { sha: "bl55" }, mergeable_state: "clean" });
      if (url.includes("/commits/bl55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/bl55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/55/labels") && method === "POST") { seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[])); return Response.json([]); }
      if (url.includes("/issues/55/comments") && method === "POST") { seen.comments.push(String(JSON.parse(String(init?.body ?? "{}")).body ?? "")); return Response.json({ id: 1 }, { status: 201 }); }
      if (url.includes("/issues/55/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "blacklist-close",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Banned author PR", state: "open", user: { login: "baduser" }, head: { sha: "bl55" }, labels: [], body: "Closes #1", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    // Deterministic gate: closed + labeled (with the configured label), and the AI was NEVER called.
    expect(aiCalls).toBe(0);
    expect(seen.closed).toBe(true);
    expect(seen.labels).toContain("spam");
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBeGreaterThanOrEqual(1);
    // No merit merge despite a clean+green+approved PR (the blacklist short-circuits ahead of merit).
    const mergeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.merge'").first<{ n: number }>();
    expect(mergeAudit?.n).toBe(0);
    // The close comment is public-safe and explains the block.
    expect(seen.comments.some((c) => c.includes("blocked from contributing"))).toBe(true);
  });

  it("screenshot-table gate (#2006): an in-scope contributor PR missing a before/after table is closed deterministically with NO AI call and no merit merge", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "n/a", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
    });
    // Scoped to the `visual` label only, config-as-code, nothing hardcoded — mirrors the blacklistLabel test above.
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { screenshotTableGate: { enabled: true, whenLabels: ["visual"] } } }, "repo_file");
    const seen = { closed: false, labels: [] as string[], comments: [] as string[] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/56/files")) return Response.json([{ filename: "apps/ui/src/App.tsx", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/56/reviews")) return Response.json([]);
      if (url.includes("/pulls/56/commits")) return Response.json([]);
      if (url.endsWith("/pulls/56") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 56, state: "closed" }); }
      if (url.endsWith("/pulls/56")) return Response.json({ number: 56, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis56" }, mergeable_state: "clean" });
      if (url.includes("/commits/vis56/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/vis56/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/56/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/56/labels") && method === "POST") { seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[])); return Response.json([]); }
      if (url.includes("/issues/56/comments") && method === "POST") { seen.comments.push(String(JSON.parse(String(init?.body ?? "{}")).body ?? "")); return Response.json({ id: 1 }, { status: 201 }); }
      if (url.includes("/issues/56/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "screenshot-table-close",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 56, title: "New button color", state: "open", user: { login: "visual-contributor" }, head: { sha: "vis56" }, labels: [{ name: "visual" }], body: "Changed the button color. Closes #1", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    // Deterministic gate: closed, and the AI was NEVER called for the disposition.
    expect(aiCalls).toBe(0);
    expect(seen.closed).toBe(true);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBeGreaterThanOrEqual(1);
    // No merit merge despite a clean+green+approved PR (the screenshot-table gate short-circuits ahead of merit).
    const mergeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.merge'").first<{ n: number }>();
    expect(mergeAudit?.n).toBe(0);
    // The close comment explains the missing table.
    expect(seen.comments.some((c) => c.includes("before/after screenshot table"))).toBe(true);
  });

  it("screenshot-table gate (#2006): an in-scope PR WITH a valid before/after table is NOT closed by the gate (no false-positive)", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
    });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      autonomy: { close: "auto", merge: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { screenshotTableGate: { enabled: true, whenLabels: ["visual"] } } }, "repo_file");
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/57/files")) return Response.json([{ filename: "apps/ui/src/App.tsx", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/57/reviews")) return Response.json([]);
      if (url.includes("/pulls/57/commits")) return Response.json([]);
      if (url.endsWith("/pulls/57") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 57, state: "closed" }); }
      if (url.endsWith("/pulls/57")) return Response.json({ number: 57, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis57" }, mergeable_state: "clean" });
      if (url.includes("/commits/vis57/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/vis57/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      if (url.includes("/issues/57/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/57/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "screenshot-table-pass",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 57,
          title: "New button color",
          state: "open",
          user: { login: "visual-contributor" },
          head: { sha: "vis57" },
          labels: [{ name: "visual" }],
          body: "Changed the button color.\n\n| Before | After |\n| --- | --- |\n| ![before](https://x/before.png) | ![after](https://x/after.png) |\n\nCloses #1",
          mergeable_state: "clean",
          reviewDecision: "APPROVED",
        },
      },
    });

    // The valid before/after table means the deterministic gate never matches — no close of any kind fires.
    expect(seen.closed).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBe(0);
  });

  // #4110: same in-scope, NO-body-table fixture as the "closed deterministically" test above (a hand-authored
  // table would normally be the ONLY way to avoid the close) -- the ONLY difference is that this PR ALSO
  // touches a web-visible route file with a real, resolvable preview deploy. Proves the marker
  // (markPullRequestVisualCaptureSatisfied) is READ BACK correctly (evaluateScreenshotTableGate's
  // botCaptureSatisfied) without a hand-authored table.
  //
  // #4136: isPersistedShotUrl now requires a real `key=` R2 URL, which only a genuine Browser Rendering pass
  // can produce (env.BROWSER is unavailable in this unit-test environment, so buildCapture always falls back
  // to a placeholder here -- covered separately by test/unit/visual-shot.test.ts's own captureShot mocking).
  // Rather than mock a full headless-browser launch just to exercise this gate-read-back assertion, this
  // seeds the marker the SAME way production does: markPullRequestVisualCaptureSatisfied is called by an
  // EARLIER pass (a `synchronize` capture) at this exact head SHA, before the webhook under test runs. This
  // is not a weaker test of the real behavior -- capture and gate evaluation routinely happen on different
  // webhook deliveries in production (buildCapture runs on `synchronize`; the maintenance pass that reads the
  // marker back can fire later, e.g. a re-gate sweep) -- and it still fully proves the read-back half of the
  // #4110 gate: upsertPullRequestFromGitHub's own onConflict clause never touches visualCaptureSatisfiedSha
  // (see its own comment), so the marker survives this webhook's PR upsert untouched, exactly as it would
  // survive any later webhook in production.
  it("screenshot-table gate (#4110): a persisted bot capture from an earlier pass satisfies the gate, no body table needed", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_UNIFIED_COMMENT: "1",
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
    });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { screenshotTableGate: { enabled: true, whenLabels: ["visual"] } } }, "repo_file");
    // Simulates an earlier `synchronize` pass whose real (Browser Rendering) capture already succeeded at
    // this head SHA and persisted the marker -- see the test doc comment above.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 58,
      title: "Update the app index route",
      state: "open",
      user: { login: "visual-contributor" },
      head: { sha: "vis58" },
      labels: [{ name: "visual" }],
      body: "Changed the route layout, no table here.",
    });
    await repositoriesModule.markPullRequestVisualCaptureSatisfied(env, "JSONbored/gittensory", 58, "vis58");
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // A web-visible route file (isVisualPath) — this is what makes screenshotsAllowed's file-touch gate open
      // and buildCapture actually run, on TOP of the no-body-table screenshotTableGate scope match (label).
      if (url.includes("/pulls/58/files")) return Response.json([{ filename: "apps/gittensory-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/58/reviews")) return Response.json([]);
      if (url.includes("/pulls/58/commits")) return Response.json([]);
      if (url.endsWith("/pulls/58") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 58, state: "closed" }); }
      if (url.endsWith("/pulls/58")) return Response.json({ number: 58, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis58" }, mergeable_state: "clean" });
      // Deployments API: none found -> buildCapture falls through to findPreviewUrlFromChecks below.
      if (url.includes("/deployments?")) return Response.json([]);
      // Combined status: empty statuses[] (byte-identical to the sibling "closed deterministically" fixture's
      // CI stub) -- findPreviewUrlFromChecks' status lookup finds nothing here and falls through to check-runs.
      if (url.includes("/commits/vis58/status")) return Response.json({ state: "success", statuses: [] });
      // A completed, successful check-run whose details_url is a real workers.dev preview link --
      // findPreviewUrlFromChecks' SECOND lookup resolves it, and reduceLiveCiAggregate reads it as an ordinary
      // green check (no pending/failing signal), so CI still evaluates "passed".
      if (url.includes("/commits/vis58/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "preview-deploy", status: "completed", conclusion: "success", details_url: "https://pr-58-preview.workers.dev" }] });
      // Check-suite hardening: reduceLiveCiAggregate only certifies a commit settled once it can ALSO read the
      // check-suites (a non-empty check-runs list makes it fetch this as a backstop) -- an unstubbed 404 here
      // would fail CLOSED to "pending" and defer the whole review before it ever reaches the publish/maintain
      // pass. An empty list means nothing is still running.
      if (url.includes("/commits/vis58/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/58/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/58/comments")) return Response.json([]);
      // The unified-comment path also creates/patches the "Gittensory Orb Review Agent" check run and applies
      // the title-derived type label -- neither is under test here, but both must resolve so the review
      // completes normally instead of throwing on an unstubbed 404.
      if (url.endsWith("/labels") && method === "POST") return Response.json([]);
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 901 }, { status: 201 });
      if (url.includes("/check-runs/901") && method === "PATCH") return Response.json({ id: 901 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "screenshot-table-bot-capture",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 58,
          title: "Update the app index route",
          state: "open",
          user: { login: "visual-contributor" },
          head: { sha: "vis58" },
          labels: [{ name: "visual" }],
          body: "Changed the route layout, no table here.",
          mergeable_state: "clean",
          reviewDecision: "APPROVED",
        },
      },
    });

    // The bot's own capture already proved the change visually -- no close, despite no body table at all.
    expect(seen.closed).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBe(0);
    // The marker persisted and round-trips through toPullRequestRecordFromRow.
    const stored = await getPullRequest(env, "JSONbored/gittensory", 58);
    expect(stored?.visualCaptureSatisfiedSha).toBe("vis58");
  });

  // #4110 fail-safe: same fixture as the sibling "satisfies the gate on its own" test above (successful capture,
  // in-scope, no body table), except the persistence write itself fails. Proves (1) the write failure never
  // throws / never blocks the rest of the review (the marker write is wrapped in its own .catch), and (2) with
  // NOTHING persisted, the screenshot-table gate correctly falls back to requiring a body table -- so this
  // particular PR IS closed, unlike its sibling. Together the two tests pin both sides of the write's outcome.
  it("screenshot-table gate (#4110): a failed visual-capture-satisfied write is swallowed (fail-safe) -- the gate falls back to requiring a body table", async () => {
    const markSpy = vi.spyOn(repositoriesModule, "markPullRequestVisualCaptureSatisfied").mockRejectedValueOnce(new Error("D1 write failed"));
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_UNIFIED_COMMENT: "1",
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
    });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { screenshotTableGate: { enabled: true, whenLabels: ["visual"] } } }, "repo_file");
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/59/files")) return Response.json([{ filename: "apps/gittensory-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/59/reviews")) return Response.json([]);
      if (url.includes("/pulls/59/commits")) return Response.json([]);
      if (url.endsWith("/pulls/59") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 59, state: "closed" }); }
      if (url.endsWith("/pulls/59")) return Response.json({ number: 59, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis59" }, mergeable_state: "clean" });
      if (url.includes("/deployments?")) return Response.json([]);
      if (url.includes("/commits/vis59/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/vis59/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "preview-deploy", status: "completed", conclusion: "success", details_url: "https://pr-59-preview.workers.dev" }] });
      if (url.includes("/commits/vis59/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/59/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/59/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/59/comments")) return Response.json([]);
      if (url.endsWith("/labels") && method === "POST") return Response.json([]);
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 901 }, { status: 201 });
      if (url.includes("/check-runs/901") && method === "PATCH") return Response.json({ id: 901 });
      return new Response("not found", { status: 404 });
    });

    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "screenshot-table-bot-capture-write-fail",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: {
            number: 59,
            title: "Update the app index route",
            state: "open",
            user: { login: "visual-contributor" },
            head: { sha: "vis59" },
            labels: [{ name: "visual" }],
            body: "Changed the route layout, no table here.",
            mergeable_state: "clean",
            reviewDecision: "APPROVED",
          },
        },
      });
    } finally {
      markSpy.mockRestore();
    }

    // The write failure never throws / never blocks the review -- but with nothing persisted, the gate has no
    // bot-capture evidence and falls back to its ordinary no-table close.
    expect(seen.closed).toBe(true);
    const stored = await getPullRequest(env, "JSONbored/gittensory", 59);
    expect(stored?.visualCaptureSatisfiedSha).toBeNull();
  });

  describe("live migrations/** collision recheck (#2550)", () => {
    // Full merge-eligible stub set (clean + green + approved), reused across scenarios — a positive test proves
    // the collision hold actually suppresses what would otherwise merge; a negative test proves the check
    // correctly stays out of the way. `liveTree` is the live git/trees response for `main` (the collision
    // source of truth); `seen.treeCalls` counts how many times it was fetched, so the "no latency for a
    // non-migrations PR" and "off by default" requirements are directly assertable, not just inferred.
    function stubMigrationRecheckFetch(prNumber: number, changedFile: { filename: string; status: string } | Array<{ filename: string; status: string }>, liveTree: Array<{ type: string; path: string }> | "error", seen: { closed: boolean; merged: boolean; labels: string[]; comments: string[]; treeCalls: number }) {
      const changedFiles = Array.isArray(changedFile) ? changedFile : [changedFile];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/check-runs/") && method === "PATCH") return Response.json({ id: 901 });
        if (url.includes(`/git/trees/main`)) {
          seen.treeCalls += 1;
          if (liveTree === "error") return new Response("not found", { status: 404 });
          return Response.json({ tree: liveTree });
        }
        if (/\/pulls\/\d+(?:\?|$)/.test(url) && method === "GET" && !url.includes(`/pulls/${prNumber}/`)) {
          return Response.json({ number: prNumber, state: "open", user: { login: "contributor" }, head: { sha: "sha1" }, base: { ref: "main", sha: "base" }, mergeable_state: "clean", labels: [] });
        }
        if (url.includes(`/pulls/${prNumber}/files`)) return Response.json(changedFiles.map((f) => ({ ...f, additions: 5, deletions: 0, changes: 5, patch: "@@\n+ALTER TABLE t ADD COLUMN c TEXT;" })));
        if (url.includes(`/commits/sha1/check-runs`)) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes(`/commits/sha1/status`)) return Response.json({ state: "success", statuses: [{ context: "ci/build", state: "success", description: "ok" }] });
        if (url.includes(`/commits/sha1/check-suites`)) return Response.json({ check_suites: [] });
        if (url.includes("/branches/")) return Response.json({ contexts: [] });
        if (url === "https://api.github.com/graphql") return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
        if (url.includes(`/pulls/${prNumber}/merge`) && method === "PUT") {
          seen.merged = true;
          return Response.json({ merged: true, sha: "merged-sha1" });
        }
        if (url.includes(`/pulls/${prNumber}`) && method === "PATCH") {
          seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed";
          return Response.json({ number: prNumber, state: "closed" });
        }
        if (url.includes(`/issues/${prNumber}/labels`) && method === "GET") return Response.json([]);
        if (url.includes(`/issues/${prNumber}/labels`) && method === "POST") {
          seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[]));
          return Response.json([]);
        }
        if (url.endsWith("/labels") && method === "POST") return Response.json({ name: "x" }, { status: 201 }); // repo-level label creation (createMissingLabel probe)
        if (url.includes(`/issues/${prNumber}/comments`) && method === "POST") {
          seen.comments.push(String(JSON.parse(String(init?.body ?? "{}")).body ?? ""));
          return Response.json({ id: 1 }, { status: 201 });
        }
        if (url.includes(`/issues/${prNumber}/comments`)) return Response.json([]);
        if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 901 }, { status: 201 });
        return Response.json({});
      });
    }

    async function seedMigrationRecheckRepo(env: Env, prNumber: number, opts: { premergeContentRecheck?: boolean } = {}) {
      await upsertInstallation(env, {
        installation: { id: 123, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { contents: "write", pull_requests: "write", issues: "write" }, events: [] },
      });
      await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 123);
      await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto", review_state_label: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
      if (opts.premergeContentRecheck !== undefined) {
        await upsertRepoFocusManifest(env, "owner/repo", { gate: { premergeContentRecheck: opts.premergeContentRecheck } });
      }
      await upsertPullRequestFromGitHub(env, "owner/repo", { number: prNumber, title: "Migration PR", state: "open", user: { login: "contributor" }, head: { sha: "sha1" }, base: { ref: "main" }, labels: [], body: "" });
    }

    it("holds a would-otherwise-merge PR when the live base has a colliding migration number, with the distinct label + rebase comment", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedMigrationRecheckRepo(env, 60, { premergeContentRecheck: true });
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[], treeCalls: 0 };
      stubMigrationRecheckFetch(60, { filename: "migrations/0099_a.sql", status: "added" }, [{ type: "blob", path: "migrations/0099_b.sql" }], seen);

      await processJob(env, { type: "agent-regate-pr", deliveryId: "migration-collision-hold", repoFullName: "owner/repo", prNumber: 60, installationId: 123 });

      expect(seen.merged).toBe(false);
      expect(seen.closed).toBe(false); // held, never closed — this is a hold, not a close
      expect(seen.labels).toContain("migration-collision");
      expect(seen.comments.some((c) => c.includes("rebase") && c.includes("0099"))).toBe(true);
      expect(seen.treeCalls).toBe(1);
    });

    it("does not hold when the base has no colliding number — merges normally", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedMigrationRecheckRepo(env, 61, { premergeContentRecheck: true });
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[], treeCalls: 0 };
      stubMigrationRecheckFetch(61, { filename: "migrations/0099_a.sql", status: "added" }, [{ type: "blob", path: "migrations/0050_unrelated.sql" }], seen);

      await processJob(env, { type: "agent-regate-pr", deliveryId: "migration-no-collision", repoFullName: "owner/repo", prNumber: 61, installationId: 123 });

      expect(seen.merged).toBe(true);
      expect(seen.labels).not.toContain("migration-collision");
      expect(seen.treeCalls).toBe(1);
    });

    it("pays zero latency (never fetches the live tree) for a PR that does not touch migrations/**, even with the recheck enabled", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedMigrationRecheckRepo(env, 62, { premergeContentRecheck: true });
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[], treeCalls: 0 };
      stubMigrationRecheckFetch(62, { filename: "src/index.ts", status: "modified" }, [{ type: "blob", path: "migrations/0099_b.sql" }], seen);

      await processJob(env, { type: "agent-regate-pr", deliveryId: "migration-not-touched", repoFullName: "owner/repo", prNumber: 62, installationId: 123 });

      expect(seen.treeCalls).toBe(0); // path-gated — never even attempted the live fetch
      expect(seen.merged).toBe(true);
    });

    it("is off by default — never fetches the live tree even for a migrations/**-touching PR when unconfigured", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedMigrationRecheckRepo(env, 63); // premergeContentRecheck left unset — defaults off
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[], treeCalls: 0 };
      stubMigrationRecheckFetch(63, { filename: "migrations/0099_a.sql", status: "added" }, [{ type: "blob", path: "migrations/0099_b.sql" }], seen);

      await processJob(env, { type: "agent-regate-pr", deliveryId: "migration-recheck-off", repoFullName: "owner/repo", prNumber: 63, installationId: 123 });

      expect(seen.treeCalls).toBe(0);
      expect(seen.merged).toBe(true); // a live collision exists but the feature is off — merges anyway (opt-in)
    });

    it("fails OPEN (merges normally) when the live tree fetch errors — never holds a PR on inconclusive data", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedMigrationRecheckRepo(env, 64, { premergeContentRecheck: true });
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[], treeCalls: 0 };
      stubMigrationRecheckFetch(64, { filename: "migrations/0099_a.sql", status: "added" }, "error", seen);

      await processJob(env, { type: "agent-regate-pr", deliveryId: "migration-fetch-error", repoFullName: "owner/repo", prNumber: 64, installationId: 123 });

      expect(seen.treeCalls).toBe(1);
      expect(seen.merged).toBe(true);
      expect(seen.labels).not.toContain("migration-collision");
    });

    it("fails OPEN (never fetches the live tree) when the PR has no resolvable base ref", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertInstallation(env, {
        installation: { id: 123, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { contents: "write", pull_requests: "write", issues: "write" }, events: [] },
      });
      // No default_branch on the repo record AND no base.ref on the PR record — baseRef resolves to undefined.
      await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 123);
      await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto", review_state_label: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
      await upsertRepoFocusManifest(env, "owner/repo", { gate: { premergeContentRecheck: true } });
      await upsertPullRequestFromGitHub(env, "owner/repo", { number: 65, title: "No base ref", state: "open", user: { login: "contributor" }, head: { sha: "sha1" }, labels: [], body: "" });
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[], treeCalls: 0 };
      stubMigrationRecheckFetch(65, { filename: "migrations/0099_a.sql", status: "added" }, [{ type: "blob", path: "migrations/0099_b.sql" }], seen);

      await processJob(env, { type: "agent-regate-pr", deliveryId: "migration-no-base-ref", repoFullName: "owner/repo", prNumber: 65, installationId: 123 });

      expect(seen.treeCalls).toBe(0); // no live target to compare against — never even attempted the fetch
      expect(seen.merged).toBe(true);
      expect(seen.labels).not.toContain("migration-collision");
    });

    it("REGRESSION: is deliberately UNCACHED — a live tree that changes between two consecutive maintenance passes is picked up fresh, never served stale", async () => {
      // The exact race a caching layer would reintroduce: a sibling PR (not modeled directly here — simulated
      // by the live tree response CHANGING between the two fetches, the same effect a sibling merge has) adds
      // a colliding migration file in the window between two maintenance passes on the SAME PR. A cache keyed
      // by repo+baseRef would serve the first (pre-collision) snapshot on the second pass and miss the
      // collision entirely — this asserts both passes fetch fresh and the second one correctly detects it.
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedMigrationRecheckRepo(env, 66, { premergeContentRecheck: true });
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[], treeCalls: 0 };
      let liveTree: Array<{ type: string; path: string }> = []; // pass 1: main has nothing colliding yet
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/check-runs/") && method === "PATCH") return Response.json({ id: 901 });
        if (url.includes("/git/trees/main")) {
          seen.treeCalls += 1;
          return Response.json({ tree: liveTree });
        }
        if (/\/pulls\/\d+(?:\?|$)/.test(url) && method === "GET" && !url.includes("/pulls/66/")) {
          return Response.json({ number: 66, state: "open", user: { login: "contributor" }, head: { sha: "sha1" }, base: { ref: "main", sha: "base" }, mergeable_state: "clean", labels: [] });
        }
        if (url.includes("/pulls/66/files")) return Response.json([{ filename: "migrations/0099_a.sql", status: "added", additions: 5, deletions: 0, changes: 5, patch: "@@\n+ALTER TABLE t ADD COLUMN c TEXT;" }]);
        if (url.includes("/commits/sha1/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/sha1/status")) return Response.json({ state: "success", statuses: [{ context: "ci/build", state: "success", description: "ok" }] });
        if (url.includes("/commits/sha1/check-suites")) return Response.json({ check_suites: [] });
        if (url.includes("/branches/")) return Response.json({ contexts: [] });
        if (url === "https://api.github.com/graphql") return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
        if (url.includes("/pulls/66/merge") && method === "PUT") {
          seen.merged = true;
          return Response.json({ merged: true, sha: "merged-sha1" });
        }
        if (url.includes("/issues/66/labels") && method === "GET") return Response.json([]);
        if (url.includes("/issues/66/labels") && method === "POST") {
          seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[]));
          return Response.json([]);
        }
        if (url.endsWith("/labels") && method === "POST") return Response.json({ name: "x" }, { status: 201 });
        if (url.includes("/issues/66/comments")) return Response.json([]);
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "migration-fresh-pass-1", repoFullName: "owner/repo", prNumber: 66, installationId: 123 });
      expect(seen.merged).toBe(true); // pass 1: no collision yet — merges

      // Between passes, a sibling PR merges its own colliding 0099 file — main's live tree now has it.
      liveTree = [{ type: "blob", path: "migrations/0099_b.sql" }];
      seen.merged = false;
      await processJob(env, { type: "agent-regate-pr", deliveryId: "migration-fresh-pass-2", repoFullName: "owner/repo", prNumber: 66, installationId: 123 });

      expect(seen.treeCalls).toBe(2); // every pass fetches fresh — no cache could ever mask the change
      expect(seen.labels).toContain("migration-collision");
      expect(seen.merged).toBe(false); // pass 2 correctly catches the now-live collision, never stale-served
    });

    it("does NOT hold for a pre-existing collision between two OTHER files unrelated to this PR's own migration number", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedMigrationRecheckRepo(env, 67, { premergeContentRecheck: true });
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[], treeCalls: 0 };
      // main already has a real collision at 0050 (two unrelated, already-merged files) — nothing to do with
      // this PR's own migration at 0099. The prNumbers scoping must exclude it: main is already broken by
      // someone else's mistake, but that must not hold an unrelated third PR.
      stubMigrationRecheckFetch(67, { filename: "migrations/0099_a.sql", status: "added" }, [
        { type: "blob", path: "migrations/0050_x.sql" },
        { type: "blob", path: "migrations/0050_y.sql" },
      ], seen);

      await processJob(env, { type: "agent-regate-pr", deliveryId: "migration-unrelated-collision", repoFullName: "owner/repo", prNumber: 67, installationId: 123 });

      expect(seen.merged).toBe(true);
      expect(seen.labels).not.toContain("migration-collision");
    });

    it("holds and reports every colliding number when a PR touches two migration files that each independently collide", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedMigrationRecheckRepo(env, 68, { premergeContentRecheck: true });
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[], treeCalls: 0 };
      stubMigrationRecheckFetch(
        68,
        [
          { filename: "migrations/0098_a.sql", status: "added" },
          { filename: "migrations/0099_a.sql", status: "added" },
        ],
        [
          { type: "blob", path: "migrations/0098_b.sql" },
          { type: "blob", path: "migrations/0099_b.sql" },
        ],
        seen,
      );

      await processJob(env, { type: "agent-regate-pr", deliveryId: "migration-multi-collision", repoFullName: "owner/repo", prNumber: 68, installationId: 123 });

      expect(seen.merged).toBe(false);
      expect(seen.labels).toContain("migration-collision");
      expect(seen.comments.some((c) => c.includes("0098") && c.includes("0099"))).toBe(true);
    });

    it("does not hold when the live base already contains one of the real grandfathered duplicate pairs, unrelated to this PR's own migration number", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedMigrationRecheckRepo(env, 69, { premergeContentRecheck: true });
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[], treeCalls: 0 };
      // The real, already-shipped 0090 grandfathered pair (see KNOWN_MIGRATION_DUPLICATES) is present on main —
      // this must never trigger a hold for an unrelated PR touching a different number.
      stubMigrationRecheckFetch(69, { filename: "migrations/0099_a.sql", status: "added" }, [
        { type: "blob", path: "migrations/0090_contributor_cap_label.sql" },
        { type: "blob", path: "migrations/0090_pull_request_detail_sync_head_sha.sql" },
      ], seen);

      await processJob(env, { type: "agent-regate-pr", deliveryId: "migration-grandfathered", repoFullName: "owner/repo", prNumber: 69, installationId: 123 });

      expect(seen.merged).toBe(true);
      expect(seen.labels).not.toContain("migration-collision");
    });

    it("REGRESSION: renaming this PR's own not-yet-merged migration file (e.g. a typo fix, same number) does NOT self-collide", async () => {
      // Before the fix, prMigrationFilenames was derived from changedPathsForGuardrail's collapsed set, which
      // includes BOTH a renamed file's old and new name — counting one logical file as two and self-colliding.
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedMigrationRecheckRepo(env, 70, { premergeContentRecheck: true });
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[], treeCalls: 0 };
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/check-runs/") && method === "PATCH") return Response.json({ id: 901 });
        if (url.includes("/git/trees/main")) {
          seen.treeCalls += 1;
          return Response.json({ tree: [] }); // empty live base — nothing else to collide with
        }
        if (/\/pulls\/\d+(?:\?|$)/.test(url) && method === "GET" && !url.includes("/pulls/70/")) {
          return Response.json({ number: 70, state: "open", user: { login: "contributor" }, head: { sha: "sha1" }, base: { ref: "main", sha: "base" }, mergeable_state: "clean", labels: [] });
        }
        // A single GitHub PR-files entry for a rename: status="renamed", filename=new name, previous_filename=old name.
        if (url.includes("/pulls/70/files")) return Response.json([{ filename: "migrations/0099_add_column.sql", previous_filename: "migrations/0099_add_colum.sql", status: "renamed", additions: 1, deletions: 1, changes: 2, patch: "@@\n rename" }]);
        if (url.includes("/commits/sha1/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/sha1/status")) return Response.json({ state: "success", statuses: [{ context: "ci/build", state: "success", description: "ok" }] });
        if (url.includes("/commits/sha1/check-suites")) return Response.json({ check_suites: [] });
        if (url.includes("/branches/")) return Response.json({ contexts: [] });
        if (url === "https://api.github.com/graphql") return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
        if (url.includes("/pulls/70/merge") && method === "PUT") {
          seen.merged = true;
          return Response.json({ merged: true, sha: "merged-sha1" });
        }
        if (url.includes("/issues/70/labels") && method === "GET") return Response.json([]);
        if (url.includes("/issues/70/labels") && method === "POST") {
          seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[]));
          return Response.json([]);
        }
        if (url.endsWith("/labels") && method === "POST") return Response.json({ name: "x" }, { status: 201 });
        if (url.includes("/issues/70/comments")) return Response.json([]);
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "migration-rename-self", repoFullName: "owner/repo", prNumber: 70, installationId: 123 });

      expect(seen.merged).toBe(true); // no false self-collision from counting the old+new rename names as two files
      expect(seen.labels).not.toContain("migration-collision");
    });

    it("REGRESSION: renaming an EXISTING base migration (same number) does NOT self-collide with its own old name still live on main", async () => {
      // Before the fix, liveFilenames (fetched from main, which still has the pre-rename name until this PR
      // merges) was unioned as-is with prMigrationFilenames (the new name only) — so a same-number typo-fix
      // rename of an ALREADY-MERGED base migration counted as two distinct files at one number and
      // self-collided, even though the merged tree would only ever contain the renamed file.
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedMigrationRecheckRepo(env, 73, { premergeContentRecheck: true });
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[], treeCalls: 0 };
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/check-runs/") && method === "PATCH") return Response.json({ id: 901 });
        if (url.includes("/git/trees/main")) {
          seen.treeCalls += 1;
          // main still has the PRE-rename name — this PR's rename hasn't merged yet.
          return Response.json({ tree: [{ type: "blob", path: "migrations/0099_old.sql" }] });
        }
        if (/\/pulls\/\d+(?:\?|$)/.test(url) && method === "GET" && !url.includes("/pulls/73/")) {
          return Response.json({ number: 73, state: "open", user: { login: "contributor" }, head: { sha: "sha1" }, base: { ref: "main", sha: "base" }, mergeable_state: "clean", labels: [] });
        }
        // Renames an EXISTING base migration (same number 0099), not a file this PR itself added.
        if (url.includes("/pulls/73/files")) return Response.json([{ filename: "migrations/0099_new.sql", previous_filename: "migrations/0099_old.sql", status: "renamed", additions: 1, deletions: 1, changes: 2, patch: "@@\n rename" }]);
        if (url.includes("/commits/sha1/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/sha1/status")) return Response.json({ state: "success", statuses: [{ context: "ci/build", state: "success", description: "ok" }] });
        if (url.includes("/commits/sha1/check-suites")) return Response.json({ check_suites: [] });
        if (url.includes("/branches/")) return Response.json({ contexts: [] });
        if (url === "https://api.github.com/graphql") return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
        if (url.includes("/pulls/73/merge") && method === "PUT") {
          seen.merged = true;
          return Response.json({ merged: true, sha: "merged-sha1" });
        }
        if (url.includes("/issues/73/labels") && method === "GET") return Response.json([]);
        if (url.includes("/issues/73/labels") && method === "POST") {
          seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[]));
          return Response.json([]);
        }
        if (url.endsWith("/labels") && method === "POST") return Response.json({ name: "x" }, { status: 201 });
        if (url.includes("/issues/73/comments")) return Response.json([]);
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "migration-rename-existing-base", repoFullName: "owner/repo", prNumber: 73, installationId: 123 });

      expect(seen.merged).toBe(true); // the pre-rename name still live on main must not count against this PR
      expect(seen.labels).not.toContain("migration-collision");
    });

    it("REGRESSION: renumbering (renaming) this PR's migration to resolve a real collision does not leave a stale hold from the old filename", async () => {
      // Before the fix, the stale previousFilename (the OLD number) stayed in prMigrationFilenames forever,
      // colliding with an unrelated already-merged file at that old number and permanently re-holding a PR
      // that had already fixed itself — exactly the remediation this feature's own comment recommends.
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedMigrationRecheckRepo(env, 71, { premergeContentRecheck: true });
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[], treeCalls: 0 };
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/check-runs/") && method === "PATCH") return Response.json({ id: 901 });
        if (url.includes("/git/trees/main")) {
          seen.treeCalls += 1;
          // main already has an unrelated, already-merged file at the OLD number (0099) — nothing to do with
          // this PR anymore, since it renumbered away from 0099 to 0100.
          return Response.json({ tree: [{ type: "blob", path: "migrations/0099_other_already_merged.sql" }] });
        }
        if (/\/pulls\/\d+(?:\?|$)/.test(url) && method === "GET" && !url.includes("/pulls/71/")) {
          return Response.json({ number: 71, state: "open", user: { login: "contributor" }, head: { sha: "sha1" }, base: { ref: "main", sha: "base" }, mergeable_state: "clean", labels: [] });
        }
        if (url.includes("/pulls/71/files")) return Response.json([{ filename: "migrations/0100_mine.sql", previous_filename: "migrations/0099_mine.sql", status: "renamed", additions: 1, deletions: 1, changes: 2, patch: "@@\n rename" }]);
        if (url.includes("/commits/sha1/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/sha1/status")) return Response.json({ state: "success", statuses: [{ context: "ci/build", state: "success", description: "ok" }] });
        if (url.includes("/commits/sha1/check-suites")) return Response.json({ check_suites: [] });
        if (url.includes("/branches/")) return Response.json({ contexts: [] });
        if (url === "https://api.github.com/graphql") return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
        if (url.includes("/pulls/71/merge") && method === "PUT") {
          seen.merged = true;
          return Response.json({ merged: true, sha: "merged-sha1" });
        }
        if (url.includes("/issues/71/labels") && method === "GET") return Response.json([]);
        if (url.includes("/issues/71/labels") && method === "POST") {
          seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[]));
          return Response.json([]);
        }
        if (url.endsWith("/labels") && method === "POST") return Response.json({ name: "x" }, { status: 201 });
        if (url.includes("/issues/71/comments")) return Response.json([]);
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "migration-renumber-remediation", repoFullName: "owner/repo", prNumber: 71, installationId: 123 });

      expect(seen.merged).toBe(true); // the stale old-number previousFilename must not re-trigger a hold
      expect(seen.labels).not.toContain("migration-collision");
    });

    it("REGRESSION: deleting this PR's own colliding migration file does not still count it as one of the PR's own filenames", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedMigrationRecheckRepo(env, 72, { premergeContentRecheck: true });
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[], treeCalls: 0 };
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/check-runs/") && method === "PATCH") return Response.json({ id: 901 });
        if (url.includes("/git/trees/main")) {
          seen.treeCalls += 1;
          return Response.json({ tree: [{ type: "blob", path: "migrations/0099_other_already_merged.sql" }] });
        }
        if (/\/pulls\/\d+(?:\?|$)/.test(url) && method === "GET" && !url.includes("/pulls/72/")) {
          return Response.json({ number: 72, state: "open", user: { login: "contributor" }, head: { sha: "sha1" }, base: { ref: "main", sha: "base" }, mergeable_state: "clean", labels: [] });
        }
        // The PR deletes its own migration file (status="removed") — it no longer exists in the PR's tree.
        if (url.includes("/pulls/72/files")) return Response.json([{ filename: "migrations/0099_mine.sql", status: "removed", additions: 0, deletions: 5, changes: 5, patch: "@@\n-removed" }]);
        if (url.includes("/commits/sha1/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/sha1/status")) return Response.json({ state: "success", statuses: [{ context: "ci/build", state: "success", description: "ok" }] });
        if (url.includes("/commits/sha1/check-suites")) return Response.json({ check_suites: [] });
        if (url.includes("/branches/")) return Response.json({ contexts: [] });
        if (url === "https://api.github.com/graphql") return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
        if (url.includes("/pulls/72/merge") && method === "PUT") {
          seen.merged = true;
          return Response.json({ merged: true, sha: "merged-sha1" });
        }
        if (url.includes("/issues/72/labels") && method === "GET") return Response.json([]);
        if (url.includes("/issues/72/labels") && method === "POST") {
          seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[]));
          return Response.json([]);
        }
        if (url.endsWith("/labels") && method === "POST") return Response.json({ name: "x" }, { status: 201 });
        if (url.includes("/issues/72/comments")) return Response.json([]);
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "migration-removed-file", repoFullName: "owner/repo", prNumber: 72, installationId: 123 });

      // With no migrations/**-touching file left in the PR's own set (the only entry is `status: "removed"`),
      // prMigrationFilenames is empty — the whole recheck is path-gated off, so it never even fetches the tree.
      expect(seen.treeCalls).toBe(0);
      expect(seen.merged).toBe(true);
      expect(seen.labels).not.toContain("migration-collision");
    });
  });

  describe("unlinked-issue guardrail (#unlinked-issue-guardrail, credibility-gate-farming defense)", () => {
    // Mirrors the #2550 migration-recheck fixture immediately above: full merge-eligible stub set
    // (clean + green + approved) so a positive test proves the hold actually suppresses what would
    // otherwise merge, and a negative test proves the guardrail correctly stays out of the way / off by
    // default. `run` (the env.AI.run spy) is asserted directly rather than inferred from side effects.
    function stubUnlinkedIssueGuardrailFetch(prNumber: number, seen: { closed: boolean; merged: boolean; labels: string[]; comments: string[] }) {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/check-runs/") && method === "PATCH") return Response.json({ id: 901 });
        if (/\/pulls\/\d+(?:\?|$)/.test(url) && method === "GET" && !url.includes(`/pulls/${prNumber}/`)) {
          return Response.json({ number: prNumber, state: "open", user: { login: "contributor" }, head: { sha: "sha1" }, base: { ref: "main", sha: "base" }, mergeable_state: "clean", labels: [] });
        }
        // src/github/webhook.ts (not src/queue/**): this block tests the unlinked-issue guardrail specifically,
        // and src/queue/** is one of ENGINE_DECISION_GUARDRAIL_GLOBS' built-in invariants (guardrail-config.ts) —
        // a diff touching it would unconditionally hold regardless of this guardrail's own on/off setting.
        if (url.includes(`/pulls/${prNumber}/files`)) return Response.json([{ filename: "src/github/webhook.ts", status: "modified", additions: 5, deletions: 0, changes: 5, patch: "@@\n+dedupe retries" }]);
        if (url.includes(`/commits/sha1/check-runs`)) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes(`/commits/sha1/status`)) return Response.json({ state: "success", statuses: [{ context: "ci/build", state: "success", description: "ok" }] });
        if (url.includes(`/commits/sha1/check-suites`)) return Response.json({ check_suites: [] });
        if (url.includes("/branches/")) return Response.json({ contexts: [] });
        if (url === "https://api.github.com/graphql") return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
        if (url.includes(`/pulls/${prNumber}/merge`) && method === "PUT") {
          seen.merged = true;
          return Response.json({ merged: true, sha: "merged-sha1" });
        }
        if (url.includes(`/pulls/${prNumber}`) && method === "PATCH") {
          seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed";
          return Response.json({ number: prNumber, state: "closed" });
        }
        if (url.includes(`/issues/${prNumber}/labels`) && method === "GET") return Response.json([]);
        if (url.includes(`/issues/${prNumber}/labels`) && method === "POST") {
          seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[]));
          return Response.json([]);
        }
        if (url.endsWith("/labels") && method === "POST") return Response.json({ name: "x" }, { status: 201 });
        if (url.includes(`/issues/${prNumber}/comments`) && method === "POST") {
          seen.comments.push(String(JSON.parse(String(init?.body ?? "{}")).body ?? ""));
          return Response.json({ id: 1 }, { status: 201 });
        }
        if (url.includes(`/issues/${prNumber}/comments`)) return Response.json([]);
        if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 901 }, { status: 201 });
        return Response.json({});
      });
    }

    async function seedGuardrailRepo(env: Env, prNumber: number, opts: { guardrailMode?: "hold" | "off"; prBody?: string; autonomy?: Record<string, string> } = {}) {
      await upsertInstallation(env, {
        installation: { id: 123, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { contents: "write", pull_requests: "write", issues: "write" }, events: [] },
      });
      await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 123);
      await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: opts.autonomy ?? { merge: "auto", review_state_label: "auto" }, aiReviewMode: "off", gatePack: "oss-anti-slop", reviewCheckMode: "required", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
      if (opts.guardrailMode !== undefined) {
        await upsertRepoFocusManifest(env, "owner/repo", { settings: { unlinkedIssueGuardrail: { mode: opts.guardrailMode } } });
      }
      await upsertIssueFromGitHub(env, "owner/repo", { number: 5, title: "webhook retry duplicate bug report", state: "open", user: { login: "someone" }, labels: [], body: "retries duplicate events under heavy load, needs a dedup key" });
      await upsertPullRequestFromGitHub(env, "owner/repo", { number: prNumber, title: "fix webhook retry duplicate bug", state: "open", user: { login: "contributor" }, head: { sha: "sha1" }, base: { ref: "main" }, labels: [], body: opts.prBody ?? "" });
    }

    it("holds a would-otherwise-merge PR when its diff appears to directly solve an existing open issue it never linked", async () => {
      const run = vi.fn(async () => ({ response: JSON.stringify({ matched: true, confidence: 0.9, evidence: "adds the missing dedup key" }) }));
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), AI: { run } as unknown as Ai });
      await seedGuardrailRepo(env, 80, { guardrailMode: "hold" });
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[] };
      stubUnlinkedIssueGuardrailFetch(80, seen);

      await processJob(env, { type: "agent-regate-pr", deliveryId: "unlinked-issue-hold", repoFullName: "owner/repo", prNumber: 80, installationId: 123 });

      expect(seen.merged).toBe(false);
      expect(seen.closed).toBe(false); // held, never closed — this is a hold, not a close
      expect(seen.labels).toContain("manual-review");
      expect(seen.comments.some((c) => c.includes("#5"))).toBe(true);
      expect(run).toHaveBeenCalled();
    });

    it("is off by default — never calls the AI even for a PR whose diff clearly overlaps an open issue", async () => {
      const run = vi.fn(async () => ({ response: JSON.stringify({ matched: true, confidence: 0.9, evidence: "x" }) }));
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), AI: { run } as unknown as Ai });
      await seedGuardrailRepo(env, 81); // guardrailMode left unset — defaults off
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[] };
      stubUnlinkedIssueGuardrailFetch(81, seen);

      await processJob(env, { type: "agent-regate-pr", deliveryId: "unlinked-issue-off", repoFullName: "owner/repo", prNumber: 81, installationId: 123 });

      expect(run).not.toHaveBeenCalled();
      expect(seen.merged).toBe(true);
    });

    it("does not call the AI when the PR already links an issue, even with the guardrail on", async () => {
      const run = vi.fn(async () => ({ response: JSON.stringify({ matched: true, confidence: 0.9, evidence: "x" }) }));
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), AI: { run } as unknown as Ai });
      await seedGuardrailRepo(env, 82, { guardrailMode: "hold", prBody: "Closes #5" });
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[] };
      stubUnlinkedIssueGuardrailFetch(82, seen);

      await processJob(env, { type: "agent-regate-pr", deliveryId: "unlinked-issue-already-linked", repoFullName: "owner/repo", prNumber: 82, installationId: 123 });

      expect(run).not.toHaveBeenCalled();
      expect(seen.merged).toBe(true);
    });

    it("escalates to a CLOSE on a second confirmed match by the same contributor (#unlinked-issue-guardrail-followup)", async () => {
      const run = vi.fn(async () => ({ response: JSON.stringify({ matched: true, confidence: 0.9, evidence: "adds the missing dedup key" }) }));
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), AI: { run } as unknown as Ai });

      await seedGuardrailRepo(env, 90, { guardrailMode: "hold" });
      const seenFirst = { closed: false, merged: false, labels: [] as string[], comments: [] as string[] };
      stubUnlinkedIssueGuardrailFetch(90, seenFirst);
      await processJob(env, { type: "agent-regate-pr", deliveryId: "unlinked-issue-repeat-first", repoFullName: "owner/repo", prNumber: 90, installationId: 123 });
      expect(seenFirst.closed).toBe(false); // first confirmed match: held, not closed
      expect(seenFirst.merged).toBe(false);

      // The second PR needs `close` autonomy acting for the escalated disposition to actually execute as a
      // close (the first PR's hold path only ever needs `merge`/`review_state_label`).
      await seedGuardrailRepo(env, 91, { guardrailMode: "hold", autonomy: { merge: "auto", review_state_label: "auto", close: "auto" } });
      const seenSecond = { closed: false, merged: false, labels: [] as string[], comments: [] as string[] };
      stubUnlinkedIssueGuardrailFetch(91, seenSecond);
      await processJob(env, { type: "agent-regate-pr", deliveryId: "unlinked-issue-repeat-second", repoFullName: "owner/repo", prNumber: 91, installationId: 123 });
      expect(seenSecond.closed).toBe(true); // same contributor's SECOND confirmed match: closed
      expect(seenSecond.merged).toBe(false);
    });
  });

  describe("force-fresh-rebase-before-merge gate (#2552)", () => {
    // Full merge-eligible stub set (clean + green + approved), reused across scenarios — mirrors the #2550
    // migration-recheck fixture above. `baseAdvancedAt` stubs the NEW /commits/{baseRef} freshness read;
    // `null` simulates an unreadable base commit (404).
    function stubFreshRebaseFetch(prNumber: number, opts: { baseAdvancedAt: string | null; mergeableState?: string; headSha?: string }, seen: { merged: boolean; updateBranchCalls: number; baseCommitCalls: number }) {
      const headSha = opts.headSha ?? "sha1";
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "https://api.gittensor.io/miners") return Response.json([]);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/check-runs/") && method === "PATCH") return Response.json({ id: 901 });
        if (url.includes(`/pulls/${prNumber}/update-branch`) && method === "PUT") {
          seen.updateBranchCalls += 1;
          return Response.json({ message: "Updating pull request branch." }, { status: 202 });
        }
        if (url.endsWith("/commits/main")) {
          seen.baseCommitCalls += 1;
          if (opts.baseAdvancedAt === null) return new Response("not found", { status: 404 });
          return Response.json({ commit: { committer: { date: opts.baseAdvancedAt } } });
        }
        if (/\/pulls\/\d+(?:\?|$)/.test(url) && method === "GET" && !url.includes(`/pulls/${prNumber}/`)) {
          return Response.json({ number: prNumber, state: "open", user: { login: "contributor" }, head: { sha: headSha }, base: { ref: "main", sha: "base" }, mergeable_state: opts.mergeableState ?? "clean", labels: [] });
        }
        if (url.includes(`/pulls/${prNumber}/files`)) return Response.json([{ filename: "src/index.ts", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+export const x = 1;" }]);
        if (url.includes(`/commits/${headSha}/check-runs`)) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes(`/commits/${headSha}/status`)) return Response.json({ state: "success", statuses: [{ context: "ci/build", state: "success", description: "ok" }] });
        if (url.includes(`/commits/${headSha}/check-suites`)) return Response.json({ check_suites: [] });
        if (url.includes("/branches/")) return Response.json({ contexts: [] });
        if (url === "https://api.github.com/graphql") return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
        if (url.includes(`/pulls/${prNumber}/merge`) && method === "PUT") {
          seen.merged = true;
          return Response.json({ merged: true, sha: "merged-sha1" });
        }
        if (url.includes(`/issues/${prNumber}/labels`) && method === "GET") return Response.json([]);
        if (url.includes(`/issues/${prNumber}/labels`) && method === "POST") return Response.json([]);
        if (url.endsWith("/labels") && method === "POST") return Response.json({ name: "x" }, { status: 201 });
        if (url.includes(`/issues/${prNumber}/comments`)) return Response.json([]);
        if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 901 }, { status: 201 });
        return Response.json({});
      });
    }

    async function seedFreshRebaseRepo(env: Env, prNumber: number, opts: { requireFreshRebaseWindowMinutes?: number | null; autonomy?: Record<string, string> } = {}) {
      await upsertInstallation(env, {
        installation: { id: 123, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { contents: "write", pull_requests: "write", issues: "write" }, events: [] },
      });
      await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "owner/repo",
        autonomy: opts.autonomy ?? { merge: "auto", update_branch: "auto", label: "auto" },
        autoMaintain: { requireApprovals: 0, mergeMethod: "squash" },
        aiReviewMode: "off",
        gatePack: "oss-anti-slop",
        reviewCheckMode: "required",
        checkRunMode: "off",
        commentMode: "off",
        publicSurface: "off",
        ...(opts.requireFreshRebaseWindowMinutes !== undefined ? { requireFreshRebaseWindowMinutes: opts.requireFreshRebaseWindowMinutes } : {}),
      });
      await upsertPullRequestFromGitHub(env, "owner/repo", { number: prNumber, title: "Fresh rebase PR", state: "open", user: { login: "contributor" }, head: { sha: "sha1" }, base: { ref: "main" }, labels: [], body: "" });
    }

    it("merges normally when the base has not advanced recently", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedFreshRebaseRepo(env, 90, { requireFreshRebaseWindowMinutes: 10 });
      const seen = { merged: false, updateBranchCalls: 0, baseCommitCalls: 0 };
      stubFreshRebaseFetch(90, { baseAdvancedAt: new Date(Date.now() - 60 * 60_000).toISOString() }, seen); // 1h ago, outside a 10m window

      await processJob(env, { type: "agent-regate-pr", deliveryId: "fresh-rebase-old-base", repoFullName: "owner/repo", prNumber: 90, installationId: 123 });

      expect(seen.baseCommitCalls).toBe(1);
      expect(seen.updateBranchCalls).toBe(0);
      expect(seen.merged).toBe(true);
      const merge = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.action.merge").first<{ outcome: string }>();
      expect(merge?.outcome).toBe("completed");
    });

    it("forces update_branch instead of merging when the base advanced within the freshness window", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedFreshRebaseRepo(env, 91, { requireFreshRebaseWindowMinutes: 10 });
      const seen = { merged: false, updateBranchCalls: 0, baseCommitCalls: 0 };
      stubFreshRebaseFetch(91, { baseAdvancedAt: new Date(Date.now() - 60_000).toISOString() }, seen); // 1 minute ago, within a 10m window

      await processJob(env, { type: "agent-regate-pr", deliveryId: "fresh-rebase-forced", repoFullName: "owner/repo", prNumber: 91, installationId: 123 });

      expect(seen.updateBranchCalls).toBe(1);
      expect(seen.merged).toBe(false);
      const ub = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.action.update_branch").first<{ outcome: string }>();
      expect(ub?.outcome).toBe("completed");
      const forced = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.action.forced_rebase_freshness").first<{ outcome: string }>();
      expect(forced?.outcome).toBe("completed");
      const merge = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("agent.action.merge").first<{ n: number }>();
      expect(merge?.n).toBe(0);
    });

    it("never fetches the base commit or forces a rebase when the setting is unset (off by default)", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedFreshRebaseRepo(env, 92); // requireFreshRebaseWindowMinutes left unset
      const seen = { merged: false, updateBranchCalls: 0, baseCommitCalls: 0 };
      stubFreshRebaseFetch(92, { baseAdvancedAt: new Date().toISOString() }, seen); // "now" — would force if the setting were on

      await processJob(env, { type: "agent-regate-pr", deliveryId: "fresh-rebase-off", repoFullName: "owner/repo", prNumber: 92, installationId: 123 });

      expect(seen.baseCommitCalls).toBe(0);
      expect(seen.updateBranchCalls).toBe(0);
      expect(seen.merged).toBe(true);
    });

    it("falls through to a normal merge once the bounded-retry cap is reached, with a cap-exceeded audit event", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedFreshRebaseRepo(env, 93, { requireFreshRebaseWindowMinutes: 10 });
      // Seed the bounded-retry counter at the cap (3) for this repo+PR, matching what 3 prior forced
      // attempts would have left behind.
      await env.SELFHOST_TRANSIENT_CACHE?.set("fresh-rebase-forced:owner/repo#93", "3", 24 * 3600);
      const seen = { merged: false, updateBranchCalls: 0, baseCommitCalls: 0 };
      stubFreshRebaseFetch(93, { baseAdvancedAt: new Date(Date.now() - 60_000).toISOString() }, seen); // still within window

      await processJob(env, { type: "agent-regate-pr", deliveryId: "fresh-rebase-capped", repoFullName: "owner/repo", prNumber: 93, installationId: 123 });

      expect(seen.updateBranchCalls).toBe(0); // capped — never forces a 4th attempt
      expect(seen.merged).toBe(true); // falls through to a normal merge instead
      const capped = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.action.fresh_rebase_window_cap_exceeded").first<{ outcome: string }>();
      expect(capped?.outcome).toBe("completed");
    });

    it("fails open (merges normally) when the base commit is unreadable", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedFreshRebaseRepo(env, 94, { requireFreshRebaseWindowMinutes: 10 });
      const seen = { merged: false, updateBranchCalls: 0, baseCommitCalls: 0 };
      stubFreshRebaseFetch(94, { baseAdvancedAt: null }, seen); // 404 on the base commit fetch

      await processJob(env, { type: "agent-regate-pr", deliveryId: "fresh-rebase-unreadable", repoFullName: "owner/repo", prNumber: 94, installationId: 123 });

      expect(seen.baseCommitCalls).toBe(1);
      expect(seen.updateBranchCalls).toBe(0);
      expect(seen.merged).toBe(true);
    });

    it("falls through to a normal merge when the forced update_branch action itself is not authorized", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      // update_branch is deliberately absent from autonomy (resolves to the deny-by-default "observe" level),
      // while merge stays "auto" — proving the freshness gate fails open independently of the eventual merge
      // action's own authorization.
      await seedFreshRebaseRepo(env, 95, { requireFreshRebaseWindowMinutes: 10, autonomy: { merge: "auto", label: "auto" } });
      const seen = { merged: false, updateBranchCalls: 0, baseCommitCalls: 0 };
      stubFreshRebaseFetch(95, { baseAdvancedAt: new Date(Date.now() - 60_000).toISOString() }, seen); // within window

      await processJob(env, { type: "agent-regate-pr", deliveryId: "fresh-rebase-not-authorized", repoFullName: "owner/repo", prNumber: 95, installationId: 123 });

      expect(seen.baseCommitCalls).toBe(1);
      expect(seen.updateBranchCalls).toBe(0); // denied by autonomy before any GitHub mutation is attempted
      expect(seen.merged).toBe(true); // falls through to the normal merge decision
      const denied = await env.DB.prepare("select outcome from audit_events where event_type = ? order by created_at desc limit 1").bind("agent.action.update_branch").first<{ outcome: string }>();
      expect(denied?.outcome).toBe("denied");
    });

    it("REGRESSION (gate finding): the bounded-retry counter accumulates across successful forces even though each one changes the head SHA", async () => {
      // A successful update_branch itself produces a NEW head SHA (the merge-base-into-head commit). The
      // counter must NOT reset just because ITS OWN action changed the head -- otherwise the cap could never
      // be reached via the exact path it exists to bound, and a fast-moving base would force a rebase on
      // EVERY pass forever. Simulates 3 rounds, each with a genuinely different head SHA (mirroring the
      // synchronize webhook a real update_branch triggers), then a 4th round proving the cap holds.
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedFreshRebaseRepo(env, 96, { requireFreshRebaseWindowMinutes: 10 });
      const shas = ["sha-r1", "sha-r2", "sha-r3", "sha-r4"];

      for (const [round, sha] of shas.entries()) {
        await upsertPullRequestFromGitHub(env, "owner/repo", { number: 96, title: "Fresh rebase PR", state: "open", user: { login: "contributor" }, head: { sha }, base: { ref: "main" }, labels: [], body: "" });
        const seen = { merged: false, updateBranchCalls: 0, baseCommitCalls: 0 };
        stubFreshRebaseFetch(96, { baseAdvancedAt: new Date(Date.now() - 60_000).toISOString(), headSha: sha }, seen); // always within window

        await processJob(env, { type: "agent-regate-pr", deliveryId: `fresh-rebase-multi-round-${round}`, repoFullName: "owner/repo", prNumber: 96, installationId: 123 });

        if (round < 3) {
          // Rounds 0-2 (attempts 1-3): still under/at the cap -- forces update_branch, never merges.
          expect(seen.updateBranchCalls).toBe(1);
          expect(seen.merged).toBe(false);
        } else {
          // Round 3 (the 4th evaluation): the cap (3) was already reached by round 2 -- falls through to merge.
          expect(seen.updateBranchCalls).toBe(0);
          expect(seen.merged).toBe(true);
        }
      }

      const forcedCount = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("agent.action.forced_rebase_freshness").first<{ n: number }>();
      expect(forcedCount?.n).toBe(3); // exactly 3 successful forces, not 4
      const capped = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.action.fresh_rebase_window_cap_exceeded").first<{ outcome: string }>();
      expect(capped?.outcome).toBe("completed");
    });
  });

  it("contributor open-PR cap (#2270): a contributor's 3rd open PR (over a cap of 2) is labeled + closed deterministically with no merit merge", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "n/a", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    // Two PRE-EXISTING open PRs from the same author, seeded directly (as if opened moments earlier).
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 53, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f53" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR two", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
      // The label is the configurable `.gittensory.yml` value below — nothing is hard-coded.
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorCapLabel: "spam-cap" } }, "repo_file");
    const seen = { closed: false, labels: [] as string[], comments: [] as string[] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if ((url.endsWith("/pulls/53") || url.endsWith("/pulls/54")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/pulls/55") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 55, state: "closed" }); }
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, mergeable_state: "clean" });
      if (url.includes("/commits/f55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/55/labels") && method === "POST") { seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[])); return Response.json([]); }
      if (url.includes("/issues/55/comments") && method === "POST") { seen.comments.push(String(JSON.parse(String(init?.body ?? "{}")).body ?? "")); return Response.json({ id: 1 }, { status: 201 }); }
      if (url.includes("/issues/55/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-cap-close",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer's 3rd PR", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    // Deterministic gate: closed + labeled (with the configured label), and the AI was NEVER called.
    expect(aiCalls).toBe(0);
    expect(seen.closed).toBe(true);
    expect(seen.labels).toContain("spam-cap");
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBeGreaterThanOrEqual(1);
    // No merit merge despite a clean+green+approved PR (the cap short-circuits ahead of merit).
    const mergeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.merge'").first<{ n: number }>();
    expect(mergeAudit?.n).toBe(0);
    // The close comment states the cap + current count (public, unlike the blacklist's static-only comment).
    expect(seen.comments.some((c) => c.includes("@farmer99") && c.includes("3 open pull requests") && c.includes("limit of 2"))).toBe(true);
  });

  it("contributor open-PR cap (#2270): a maintainer-named autoCloseExemptLogins entry is exempt from the PER-REPO cap too (not just the install-wide cap)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    // Two PRE-EXISTING open PRs from an exempt bot author (e.g. a third-party automation App like Sentry's Seer
    // fix bot) — same over-cap shape as the "3rd PR" test above, but this login is on autoCloseExemptLogins.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 53, title: "Sentry fix one", state: "open", user: { login: "sentry[bot]" }, head: { sha: "f53" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Sentry fix two", state: "open", user: { login: "sentry[bot]" }, head: { sha: "f54" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
      autoCloseExemptLogins: ["sentry[bot]"],
    });
    const seen = { closed: false, labels: [] as string[], comments: [] as string[] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if (url.endsWith("/pulls/55") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 55, state: "closed" }); }
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "sentry[bot]" }, head: { sha: "f55" }, mergeable_state: "clean" });
      if (url.includes("/commits/f55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/55/labels") && method === "POST") { seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[])); return Response.json([]); }
      if (url.includes("/issues/55/comments") && method === "POST") { seen.comments.push(String(JSON.parse(String(init?.body ?? "{}")).body ?? "")); return Response.json({ id: 1 }, { status: 201 }); }
      if (url.includes("/issues/55/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-cap-exempt-login",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Sentry's 3rd PR", state: "open", user: { login: "sentry[bot]" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    // Exempt: the 3rd PR is NOT closed or labeled for the cap, despite being (numerically) over it.
    expect(seen.closed).toBe(false);
    expect(seen.labels).not.toContain("over-contributor-limit");
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBe(0);
  });

  function stubContributorCapCiCancelFetch(seen: { closed: boolean; cancelledIds: number[]; listedStatuses: string[] }, runListResponses: { in_progress?: number[]; queued?: number[] } = {}, cancelResponse: () => Response = () => new Response(null, { status: 202 })) {
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if (url.endsWith("/pulls/55") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 55, state: "closed" }); }
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, mergeable_state: "clean" });
      // The other-siblings live-state recheck (#2270 complete-set fix) confirms every counted sibling PR is
      // still open before trusting it toward the cap — farmer99's two pre-existing PRs (53, 54) must report open.
      if (url.endsWith("/pulls/53") || url.endsWith("/pulls/54")) return Response.json({ number: 53, state: "open" });
      if (url.includes("/commits/f55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels")) return Response.json([]);
      if (url.includes("/issues/55/comments")) return Response.json([]);
      if (url.includes("/actions/runs?head_sha=f55&status=in_progress")) { seen.listedStatuses.push("in_progress"); return Response.json({ workflow_runs: (runListResponses.in_progress ?? []).map((id) => ({ id, event: "pull_request", pull_requests: [{ number: 55 }] })) }); }
      if (url.includes("/actions/runs?head_sha=f55&status=queued")) { seen.listedStatuses.push("queued"); return Response.json({ workflow_runs: (runListResponses.queued ?? []).map((id) => ({ id, event: "pull_request", pull_requests: [{ number: 55 }] })) }); }
      if (url.includes("/actions/runs/") && url.endsWith("/cancel") && method === "POST") {
        seen.cancelledIds.push(Number(url.match(/\/actions\/runs\/(\d+)\/cancel/)?.[1]));
        return cancelResponse();
      }
      return Response.json({});
    };
  }

  it("contributor open-PR cap (#2462): a contributor_cap close cancels the PR's in-flight CI runs when contributorCapCancelCi is enabled", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 53, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f53" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR two", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
      contributorCapCancelCi: true,
    });
    const seen = { closed: false, cancelledIds: [] as number[], listedStatuses: [] as string[] };
    vi.stubGlobal("fetch", stubContributorCapCiCancelFetch(seen, { in_progress: [101], queued: [102] }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-cap-cancel-ci-enabled",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer's 3rd PR", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    expect(seen.closed).toBe(true);
    expect(seen.listedStatuses.sort()).toEqual(["in_progress", "queued"]);
    expect(seen.cancelledIds.sort()).toEqual([101, 102]);
    const cancelAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.contributor_cap_ci_cancelled'").first<{ n: number }>();
    expect(cancelAudit?.n).toBeGreaterThanOrEqual(1);
  });

  it("contributor open-PR cap (#2462): a failing cancel-success audit write does not throw — the close still completes", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 53, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f53" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR two", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
      contributorCapCancelCi: true,
    });
    const seen = { closed: false, cancelledIds: [] as number[], listedStatuses: [] as string[] };
    vi.stubGlobal("fetch", stubContributorCapCiCancelFetch(seen, { in_progress: [103] }));
    const originalRecordAuditEvent = repositoriesModule.recordAuditEvent;
    const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockImplementation(async (auditEnv, event) => {
      if (event.eventType === "github_app.contributor_cap_ci_cancelled") throw new Error("audit DB down");
      await originalRecordAuditEvent(auditEnv, event);
    });

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "contributor-cap-cancel-ci-audit-fail",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 55, title: "Farmer's 3rd PR", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
        },
      }),
    ).resolves.toBeUndefined();
    auditSpy.mockRestore();
    expect(seen.closed).toBe(true);
  });

  it("contributor open-PR cap (#2462): a failing cancel-FAILURE audit write also does not throw — the close still completes", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 53, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f53" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR two", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
      contributorCapCancelCi: true,
    });
    const seen = { closed: false, cancelledIds: [] as number[], listedStatuses: [] as string[] };
    vi.stubGlobal(
      "fetch",
      stubContributorCapCiCancelFetch(seen, { in_progress: [104] }, () => new Response(null, { status: 500 })),
    );
    const originalRecordAuditEvent = repositoriesModule.recordAuditEvent;
    const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockImplementation(async (auditEnv, event) => {
      if (event.eventType === "github_app.contributor_cap_ci_cancel_failed") throw new Error("audit DB down");
      await originalRecordAuditEvent(auditEnv, event);
    });

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "contributor-cap-cancel-ci-failed-audit-fail",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 55, title: "Farmer's 3rd PR", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
        },
      }),
    ).resolves.toBeUndefined();
    auditSpy.mockRestore();
    expect(seen.closed).toBe(true);
  });

  it("contributor open-PR cap (#2462): contributorCapCancelCi unset (default) never attempts to cancel CI runs", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 53, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f53" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR two", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
      // contributorCapCancelCi intentionally omitted — off by default, no CONTRIBUTOR_CAP_CANCEL_CI_DEFAULT set.
    });
    const seen = { closed: false, cancelledIds: [] as number[], listedStatuses: [] as string[] };
    vi.stubGlobal("fetch", stubContributorCapCiCancelFetch(seen, { in_progress: [201] }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-cap-cancel-ci-off",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer's 3rd PR", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    expect(seen.closed).toBe(true);
    expect(seen.listedStatuses).toEqual([]);
    expect(seen.cancelledIds).toEqual([]);
  });

  it("contributor open-PR cap (#2462): a missing actions:write permission degrades gracefully — the close still succeeds and a permission_missing audit is recorded", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 53, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f53" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR two", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
      contributorCapCancelCi: true,
    });
    const seen = { closed: false, cancelledIds: [] as number[], listedStatuses: [] as string[] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/actions/runs?head_sha=")) return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
      return stubContributorCapCiCancelFetch(seen)(input, init);
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-cap-cancel-ci-permission-missing",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer's 3rd PR", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    // The close itself still succeeded and is recorded "completed", NOT "error" -- the cancel-permission gap
    // must never retroactively fail an already-successful close (#2462 core requirement).
    expect(seen.closed).toBe(true);
    const closeAudit = await env.DB.prepare("select outcome from audit_events where event_type = 'agent.action.close' order by created_at desc limit 1").first<{ outcome: string }>();
    expect(closeAudit?.outcome).toBe("completed");
    const permissionAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.contributor_cap_ci_cancel_permission_missing'").first<{ n: number }>();
    expect(permissionAudit?.n).toBeGreaterThanOrEqual(1);
  });

  it("contributor open-PR cap (#2462, #gate finding): a genuine cancel error (not a permission gap) is recorded under its own event type, distinct from permission_missing", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 53, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f53" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR two", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
      contributorCapCancelCi: true,
    });
    const seen = { closed: false, cancelledIds: [] as number[], listedStatuses: [] as string[] };
    vi.stubGlobal(
      "fetch",
      stubContributorCapCiCancelFetch(seen, { in_progress: [901] }, () => new Response(null, { status: 500 })),
    );

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-cap-cancel-ci-generic-error",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer's 3rd PR", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    expect(seen.closed).toBe(true); // the close itself still succeeds regardless of the cancel outcome
    const failedAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.contributor_cap_ci_cancel_failed'").first<{ n: number }>();
    expect(failedAudit?.n).toBeGreaterThanOrEqual(1);
    const permissionAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.contributor_cap_ci_cancel_permission_missing'").first<{ n: number }>();
    expect(permissionAudit?.n).toBe(0); // a generic 500 must never be misclassified as a permission gap
  });

  it("contributor open-PR cap (#2462): CONTRIBUTOR_CAP_CANCEL_CI_DEFAULT env var enables cancellation when the repo hasn't configured its own value", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), CONTRIBUTOR_CAP_CANCEL_CI_DEFAULT: "true" });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 53, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f53" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR two", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
      // contributorCapCancelCi intentionally omitted (null) -- falls back to the env var default above.
    });
    const seen = { closed: false, cancelledIds: [] as number[], listedStatuses: [] as string[] };
    vi.stubGlobal("fetch", stubContributorCapCiCancelFetch(seen, { in_progress: [301] }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-cap-cancel-ci-env-default",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer's 3rd PR", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    expect(seen.closed).toBe(true);
    expect(seen.cancelledIds).toEqual([301]);
  });

  it("contributor open-PR cap (#2462): an explicit repo-level contributorCapCancelCi: false overrides a true CONTRIBUTOR_CAP_CANCEL_CI_DEFAULT", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), CONTRIBUTOR_CAP_CANCEL_CI_DEFAULT: "true" });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 53, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f53" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR two", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
      contributorCapCancelCi: false,
    });
    const seen = { closed: false, cancelledIds: [] as number[], listedStatuses: [] as string[] };
    vi.stubGlobal("fetch", stubContributorCapCiCancelFetch(seen, { in_progress: [401] }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-cap-cancel-ci-repo-override",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer's 3rd PR", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    expect(seen.closed).toBe(true);
    expect(seen.listedStatuses).toEqual([]);
    expect(seen.cancelledIds).toEqual([]);
  });

  it("contributor open-PR cap (#2270): uses a complete author-scoped set beyond the duplicate-analysis 100-row sample (regression)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    for (let number = 1; number <= 100; number += 1) {
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number, title: `Busy repo PR ${number}`, state: "open", user: { login: `other-${number}` }, head: { sha: `o${number}` }, labels: [], body: "x" });
    }
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 101, title: "Spammer PR one", state: "open", user: { login: "spammer" }, head: { sha: "s101" }, labels: [], body: "x" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 1,
    });
    const seen = { closed: false, comments: [] as string[] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/pulls/101") && method === "GET") return Response.json({ number: 101, state: "open" });
      if (url.includes("/pulls/102/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/102/reviews")) return Response.json([]);
      if (url.includes("/pulls/102/commits")) return Response.json([]);
      if (url.endsWith("/pulls/102") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 102, state: "closed" }); }
      if (url.endsWith("/pulls/102")) return Response.json({ number: 102, state: "open", user: { login: "spammer" }, head: { sha: "s102" }, mergeable_state: "clean" });
      if (url.includes("/commits/s102/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/s102/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/102/labels")) return Response.json([]);
      if (url.includes("/issues/102/comments") && method === "POST") { seen.comments.push(String(JSON.parse(String(init?.body ?? "{}")).body ?? "")); return Response.json({ id: 1 }, { status: 201 }); }
      if (url.includes("/issues/102/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-cap-busy-repo",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 102, title: "Spammer PR two", state: "open", user: { login: "spammer" }, head: { sha: "s102" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    expect(seen.closed).toBe(true);
    expect(seen.comments.some((c) => c.includes("@spammer") && c.includes("2 open pull requests") && c.includes("limit of 1"))).toBe(true);
  });

  it("REGRESSION (security review finding): the per-repo cap's sibling live-check bounds concurrency instead of firing one request per open PR at once", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    // 30 OTHER open PRs from the SAME author — well beyond CONTRIBUTOR_CAP_LIVE_CHECK_CONCURRENCY (10), so an
    // unbounded Promise.all would fire all 30 live-state GETs at once.
    const SIBLING_COUNT = 30;
    for (let number = 1; number <= SIBLING_COUNT; number += 1) {
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number, title: `Prolific PR ${number}`, state: "open", user: { login: "prolific" }, head: { sha: `p${number}` }, labels: [], body: "x" });
    }
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "off",
      publicSurface: "off",
      checkRunMode: "off",
      reviewCheckMode: "required",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 100, // above SIBLING_COUNT + 1 — this test only cares about concurrency, not closing.
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const siblingCheckPattern = new RegExp(`/pulls/(?:${Array.from({ length: SIBLING_COUNT }, (_, i) => i + 1).join("|")})$`);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (siblingCheckPattern.test(url) && method === "GET") {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // A tiny real delay forces genuine overlap between concurrently-dispatched sibling checks — without
        // it, each mock resolves synchronously and never actually overlaps another in-flight call.
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return Response.json({ state: "open" });
      }
      if (url.includes(`/pulls/${SIBLING_COUNT + 1}/files`)) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes(`/pulls/${SIBLING_COUNT + 1}/reviews`)) return Response.json([]);
      if (url.includes(`/pulls/${SIBLING_COUNT + 1}/commits`)) return Response.json([]);
      if (url.endsWith(`/pulls/${SIBLING_COUNT + 1}`)) return Response.json({ number: SIBLING_COUNT + 1, state: "open", user: { login: "prolific" }, head: { sha: `p${SIBLING_COUNT + 1}` }, mergeable_state: "clean" });
      if (url.includes(`/commits/p${SIBLING_COUNT + 1}/check-runs`)) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes(`/commits/p${SIBLING_COUNT + 1}/status`)) return Response.json({ state: "success", statuses: [] });
      if (url.includes(`/issues/${SIBLING_COUNT + 1}/labels`)) return Response.json([]);
      if (url.includes(`/issues/${SIBLING_COUNT + 1}/comments`)) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-cap-bounded-concurrency",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: SIBLING_COUNT + 1, title: "Prolific author's newest PR", state: "open", user: { login: "prolific" }, head: { sha: `p${SIBLING_COUNT + 1}` }, labels: [], body: "x", mergeable_state: "clean" },
      },
    });

    expect(maxInFlight).toBeGreaterThan(1); // proves the check is genuinely concurrent, not accidentally serial
    expect(maxInFlight).toBeLessThanOrEqual(10); // CONTRIBUTOR_CAP_LIVE_CHECK_CONCURRENCY
  });

  it("contributor open-PR cap (#2270): disabled (no cap configured, the default) never closes an over-threshold contributor", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 53, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f53" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR two", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "y" });
    // No contributorOpenPrCap set — the default, disabled state.
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
    });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if ((url.endsWith("/pulls/53") || url.endsWith("/pulls/54")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/pulls/55") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 55, state: "closed" }); }
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, mergeable_state: "clean" });
      if (url.includes("/commits/f55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/55/labels") && method === "POST") return Response.json([]);
      if (url.includes("/issues/55/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/55/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-cap-disabled",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer's 3rd PR", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n ?? 0).toBe(0);
    expect(seen.closed).toBe(false);
  });

  it("contributor open-PR cap (#2270): a contributor's 2nd PR AT (not over) a cap of 2 is not closed", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    // Only ONE pre-existing open PR from this author — the incoming PR is their 2nd, exactly at the cap.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 53, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f53" }, labels: [], body: "x" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
    });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if ((url.endsWith("/pulls/53") || url.endsWith("/pulls/54")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/pulls/55") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 55, state: "closed" }); }
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, mergeable_state: "clean" });
      if (url.includes("/commits/f55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/55/labels") && method === "POST") return Response.json([]);
      if (url.includes("/issues/55/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/55/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-cap-at-limit",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer's 2nd PR", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n ?? 0).toBe(0);
    expect(seen.closed).toBe(false);
  });

  it("install-wide contributor open-item cap (#2562): an actor over the install-wide cap but under EVERY individual repo's own cap is still caught", async () => {
    // No per-repo contributorOpenPrCap is configured on EITHER repo -- only the install-wide env cap. One
    // pre-existing open PR on repo-a and one on repo-b (2 total), plus the incoming 3rd (also on repo-a) = 3,
    // over a global cap of 2 -- even though repo-a's own count (2) and repo-b's own count (1) would each
    // individually be unremarkable (and no per-repo cap is even configured to catch them).
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "2" });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [
        { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        { name: "repo-b", full_name: "JSONbored/repo-b", private: false, owner: { login: "JSONbored" } },
      ],
    });
    // upsertInstallation's own `repositories:` array is NOT itself persisted to the `repositories` table (only
    // the `installations` row) -- the real webhook pipeline registers a repo's installationId as a side effect
    // of processing an event FOR that repo, which never happens here for repo-b (the non-webhook-triggered repo).
    // Register it explicitly so countOpenItemsForAuthorAcrossRepos's installation-scoped lookup can find its rows.
    await upsertRepositoryFromGitHub(env, { name: "repo-b", full_name: "JSONbored/repo-b", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertPullRequestFromGitHub(env, "JSONbored/repo-a", { number: 20, title: "Farmer PR on repo-a", state: "open", user: { login: "farmer99" }, head: { sha: "fa20" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/repo-b", { number: 10, title: "Farmer PR on repo-b", state: "open", user: { login: "farmer99" }, head: { sha: "fb10" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/repo-a",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      // Deliberately NO contributorOpenPrCap here — only the install-wide env cap should catch this.
    });
    const seen = { closed: false, labels: [] as string[], comments: [] as string[] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if ((url.endsWith("/pulls/53") || url.endsWith("/pulls/54")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/pulls/55") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 55, state: "closed" }); }
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, mergeable_state: "clean" });
      // Install-wide live-verify (#2562 gate-review follow-up) re-fetches every OTHER counted sibling before
      // trusting it toward the cap -- both of farmer99's other open items must resolve as confirmed-open here.
      if (url.endsWith("/repos/JSONbored/repo-a/pulls/20")) return Response.json({ number: 20, state: "open" });
      if (url.endsWith("/repos/JSONbored/repo-b/pulls/10")) return Response.json({ number: 10, state: "open" });
      if (url.includes("/commits/f55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/55/labels") && method === "POST") { seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[])); return Response.json([]); }
      if (url.includes("/issues/55/comments") && method === "POST") { seen.comments.push(String(JSON.parse(String(init?.body ?? "{}")).body ?? "")); return Response.json({ id: 1 }, { status: 201 }); }
      if (url.includes("/issues/55/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "global-contributor-cap-close",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer's 3rd PR install-wide", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    expect(seen.closed).toBe(true);
    expect(seen.labels).toContain("over-contributor-limit");
    // Install-wide cap counts BOTH open PRs and open issues together (#2562 gate-review follow-up), so the
    // close message reports the mixed noun rather than a stale "pull requests"-only phrasing.
    expect(seen.comments.some((c) => c.includes("@farmer99") && c.includes("3 open pull requests and issues") && c.includes("across every repository it gates"))).toBe(true);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBeGreaterThanOrEqual(1);
  });

  it("install-wide contributor open-item cap (#2562): stops live verification after the cap is exceeded", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "1" });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } }],
    });
    for (let number = 1; number <= 30; number += 1) {
      await upsertPullRequestFromGitHub(env, "JSONbored/repo-a", { number, title: `Farmer PR ${number}`, state: "open", user: { login: "farmer99" }, head: { sha: `fa${number}` }, labels: [], body: "x" });
    }
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/repo-a",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
    });
    const seen = { closed: false, livePullReads: [] as number[] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      const siblingPull = url.match(/\/repos\/JSONbored\/repo-a\/pulls\/(\d+)$/);
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (siblingPull && siblingPull[1] !== "55") { seen.livePullReads.push(Number(siblingPull[1])); return Response.json({ number: Number(siblingPull[1]), state: "open" }); }
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if (url.endsWith("/pulls/55") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 55, state: "closed" }); }
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, mergeable_state: "clean" });
      if (url.includes("/commits/f55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/55/labels") && method === "POST") return Response.json([]);
      if (url.includes("/issues/55/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/55/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "global-contributor-cap-short-circuit",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer's 31st PR install-wide", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    expect(seen.closed).toBe(true);
    expect(seen.livePullReads).toHaveLength(10);
    expect(seen.livePullReads).not.toContain(11);
  });

  it("install-wide contributor open-item cap (#2562, #4511): env var unset falls back to the real default (20), so a spread-across-repos actor well under it is not closed", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() }); // no GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP -- resolves to the DEFAULT_GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP, not "no cap" (#4511)
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [
        { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        { name: "repo-b", full_name: "JSONbored/repo-b", private: false, owner: { login: "JSONbored" } },
      ],
    });
    await upsertRepositoryFromGitHub(env, { name: "repo-b", full_name: "JSONbored/repo-b", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertPullRequestFromGitHub(env, "JSONbored/repo-b", { number: 10, title: "Farmer PR on repo-b", state: "open", user: { login: "farmer99" }, head: { sha: "fb10" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/repo-a",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
    });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if ((url.endsWith("/pulls/53") || url.endsWith("/pulls/54")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/pulls/55") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 55, state: "closed" }); }
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, mergeable_state: "clean" });
      if (url.includes("/commits/f55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/55/labels") && method === "POST") return Response.json([]);
      if (url.includes("/issues/55/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/55/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "global-contributor-cap-off-by-default",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer's 3rd PR install-wide", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n ?? 0).toBe(0);
    expect(seen.closed).toBe(false);
  });

  it("install-wide contributor open-item cap (#2562): a maintainer-named autoCloseExemptLogins entry is exempt from the install-wide cap", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "2" });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [
        { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        { name: "repo-b", full_name: "JSONbored/repo-b", private: false, owner: { login: "JSONbored" } },
      ],
    });
    await upsertRepositoryFromGitHub(env, { name: "repo-b", full_name: "JSONbored/repo-b", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertPullRequestFromGitHub(env, "JSONbored/repo-b", { number: 10, title: "Farmer PR on repo-b", state: "open", user: { login: "farmer99" }, head: { sha: "fb10" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/repo-a",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      autoCloseExemptLogins: ["farmer99"],
    });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if ((url.endsWith("/pulls/53") || url.endsWith("/pulls/54")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/pulls/55") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 55, state: "closed" }); }
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, mergeable_state: "clean" });
      if (url.includes("/commits/f55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/55/labels") && method === "POST") return Response.json([]);
      if (url.includes("/issues/55/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/55/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "global-contributor-cap-exempt",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer's 3rd PR install-wide", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n ?? 0).toBe(0);
    expect(seen.closed).toBe(false);
  });

  it("install-wide contributor open-item cap (#2562): an author AT (not over) the configured install-wide cap is not closed", async () => {
    // Global cap is configured (2) and reached exactly (repo-b's 1 pre-existing + this incoming PR = 2), so the
    // install-wide check must fall through without matching -- the `installOpenCount > globalCap` false branch.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "2" });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [
        { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        { name: "repo-b", full_name: "JSONbored/repo-b", private: false, owner: { login: "JSONbored" } },
      ],
    });
    await upsertRepositoryFromGitHub(env, { name: "repo-b", full_name: "JSONbored/repo-b", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertPullRequestFromGitHub(env, "JSONbored/repo-b", { number: 10, title: "Farmer PR on repo-b", state: "open", user: { login: "farmer99" }, head: { sha: "fb10" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/repo-a",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
    });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if ((url.endsWith("/pulls/53") || url.endsWith("/pulls/54")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/pulls/55") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 55, state: "closed" }); }
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, mergeable_state: "clean" });
      if (url.includes("/commits/f55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/55/labels") && method === "POST") return Response.json([]);
      if (url.includes("/issues/55/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/55/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "global-contributor-cap-at-limit",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer's 2nd PR, at the install-wide limit", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n ?? 0).toBe(0);
    expect(seen.closed).toBe(false);
  });

  it("install-wide contributor open-item cap (#4511): a CONFIRMED official Gittensor miner gets the higher miner-specific cap, not the human one, even though the human cap alone would already be exceeded", async () => {
    // Human cap (2) would already be exceeded by 3 open items -- but farmer99 resolves as a confirmed miner via
    // the /miners API, so the fleet-appropriate default (50, GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP_MINER unset) applies
    // instead, and 3 is nowhere near that. Must fall through without matching.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "2" });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [
        { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        { name: "repo-b", full_name: "JSONbored/repo-b", private: false, owner: { login: "JSONbored" } },
      ],
    });
    await upsertRepositoryFromGitHub(env, { name: "repo-b", full_name: "JSONbored/repo-b", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertPullRequestFromGitHub(env, "JSONbored/repo-b", { number: 10, title: "Farmer PR on repo-b", state: "open", user: { login: "farmer99" }, head: { sha: "fb10" }, labels: [], body: "y" });
    await upsertPullRequestFromGitHub(env, "JSONbored/repo-b", { number: 11, title: "Farmer 2nd PR on repo-b", state: "open", user: { login: "farmer99" }, head: { sha: "fb11" }, labels: [], body: "z" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/repo-a",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
    });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([{ githubUsername: "farmer99", githubId: "123", totalPrs: 2, totalMergedPrs: 2, isEligible: true, credibility: 1 }]);
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://api.gittensor.io/miners/123") return Response.json({});
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if ((url.endsWith("/pulls/10") || url.endsWith("/pulls/11")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/pulls/55") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 55, state: "closed" }); }
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, mergeable_state: "clean" });
      if (url.includes("/commits/f55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/55/labels") && method === "POST") return Response.json([]);
      if (url.includes("/issues/55/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/55/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "global-contributor-cap-confirmed-miner",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Confirmed miner's 3rd PR install-wide", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n ?? 0).toBe(0);
    expect(seen.closed).toBe(false);
  });

  it("contributor open-PR cap (#2270): the repo OWNER's own PR is never closed even over the cap (live processor path, not just the planner)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 53, title: "Owner PR one", state: "open", user: { login: "JSONbored" }, head: { sha: "o53" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Owner PR two", state: "open", user: { login: "JSONbored" }, head: { sha: "o54" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
    });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if (url.endsWith("/pulls/55") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 55, state: "closed" }); }
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "JSONbored" }, head: { sha: "o55" }, mergeable_state: "clean" });
      if (url.includes("/commits/o55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/o55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/55/labels") && method === "POST") return Response.json([]);
      if (url.includes("/issues/55/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/55/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-cap-owner",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Owner's 3rd PR", state: "open", user: { login: "JSONbored" }, head: { sha: "o55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    expect(seen.closed).toBe(false);
  });

  it("contributor open-PR cap (#2270): an author-less (ghost) open PR among the repo's others is excluded from the count and the sibling-wake scan, not crashed on", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    // A ghost PR with no `user` at all (authorLogin ends up null) — must not match farmer99's count, and must
    // not crash the sibling-wake scan, which runs the identical (authorLogin ?? "") fallback.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 50, title: "Ghost PR", state: "open", head: { sha: "ghost50" }, labels: [], body: "z" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 53, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f53" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR two", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
    });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if ((url.endsWith("/pulls/53") || url.endsWith("/pulls/54")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/pulls/55") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 55, state: "closed" }); }
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, mergeable_state: "clean" });
      if (url.includes("/commits/f55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/55/labels") && method === "POST") return Response.json([]);
      if (url.includes("/issues/55/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/55/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-cap-ghost-author",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer's 3rd PR", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    // Ghost PR's null authorLogin never matches "farmer99" — the count is still exactly 3 (farmer99's own).
    expect(seen.closed).toBe(true);
  });

  function stubAccountAgeFetch(prNumber: number, createdAt: string, seen: { labels: string[]; closed: boolean }) {
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/users/")) return Response.json({ login: "newbie", created_at: createdAt });
      if (url.includes(`/pulls/${prNumber}/files`)) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes(`/pulls/${prNumber}/reviews`)) return Response.json([]);
      if (url.includes(`/pulls/${prNumber}/commits`)) return Response.json([]);
      if (url.endsWith(`/pulls/${prNumber}`) && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: prNumber, state: "closed" }); }
      if (url.endsWith(`/pulls/${prNumber}`)) return Response.json({ number: prNumber, state: "open", user: { login: "newbie" }, head: { sha: `s${prNumber}` }, mergeable_state: "clean" });
      // The other-siblings live-state recheck (#2270 complete-set fix) confirms every counted sibling PR is
      // still open before trusting it toward the cap — a generic catch-all covers any of newbie's other
      // pre-existing PR numbers without hard-coding specific ones.
      if (/\/pulls\/\d+$/.test(url)) return Response.json({ state: "open" });
      if (url.includes(`/commits/s${prNumber}/check-runs`)) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes(`/commits/s${prNumber}/status`)) return Response.json({ state: "success", statuses: [] });
      if (url.includes(`/issues/${prNumber}/labels`) && method === "GET") return Response.json([]);
      if (url.includes(`/issues/${prNumber}/labels`) && method === "POST") { seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[])); return Response.json([]); }
      if (url.endsWith("/labels") && method === "POST") return Response.json({ name: "x" }, { status: 201 });
      if (url.includes(`/issues/${prNumber}/comments`)) return Response.json([]);
      return Response.json({});
    };
  }

  it("account-age throttle (#2561): a below-threshold-age account gets the new-account label AND a tighter effective cap", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    // Two pre-existing open PRs from the same new author — a cap of 4 (tightened to 2 for a new account)
    // means the 3rd PR is already over the tightened cap, even though it's well under the CONFIGURED cap of 4.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Newbie PR one", state: "open", user: { login: "newbie" }, head: { sha: "s60" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Newbie PR two", state: "open", user: { login: "newbie" }, head: { sha: "s61" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      reviewCheckMode: "required",
      // #label-scoping: the cap label/close rides on `close`; the new-account label rides on `review_state_label`.
      autonomy: { close: "auto", review_state_label: "auto" },
      contributorOpenPrCap: 4,
      accountAgeThresholdDays: 30,
    });
    const seen = { labels: [] as string[], closed: false };
    // Account created 2 days ago — well under the 30-day threshold.
    vi.stubGlobal("fetch", stubAccountAgeFetch(62, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), seen));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "account-age-tighter-cap",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 62, title: "Newbie's 3rd PR", state: "open", user: { login: "newbie" }, head: { sha: "s62" }, labels: [], body: "x", mergeable_state: "clean" },
      },
    });

    expect(seen.labels).toContain("new-account");
    // The tightened cap (ceil(4/2)=2) is already exceeded by the 3rd PR — closed despite being under the raw cap of 4.
    expect(seen.closed).toBe(true);
  });

  it("account-age throttle (#2561): stale cached sibling PRs do not inflate the tightened cap into an auto-close", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 66, title: "Stale newbie PR", state: "open", user: { login: "newbie" }, head: { sha: "s66" }, labels: [], body: "x" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      reviewCheckMode: "required",
      autonomy: { close: "auto", review_state_label: "auto" },
      contributorOpenPrCap: 2,
      accountAgeThresholdDays: 30,
    });
    const seen = { labels: [] as string[], closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/users/")) return Response.json({ login: "newbie", created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() });
      if (url.endsWith("/pulls/66")) return Response.json({ number: 66, state: "closed" });
      if (url.includes("/pulls/67/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/67/reviews")) return Response.json([]);
      if (url.includes("/pulls/67/commits")) return Response.json([]);
      if (url.endsWith("/pulls/67") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 67, state: "closed" }); }
      if (url.endsWith("/pulls/67")) return Response.json({ number: 67, state: "open", user: { login: "newbie" }, head: { sha: "s67" }, mergeable_state: "clean" });
      if (url.includes("/commits/s67/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/s67/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/67/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/67/labels") && method === "POST") { seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[])); return Response.json([]); }
      if (url.endsWith("/labels") && method === "POST") return Response.json({ name: "x" }, { status: 201 });
      if (url.includes("/issues/67/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "account-age-stale-tight-cap",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 67, title: "Newbie's live PR", state: "open", user: { login: "newbie" }, head: { sha: "s67" }, labels: [], body: "x", mergeable_state: "clean" },
      },
    });

    expect(seen.labels).toContain("new-account");
    expect(seen.closed).toBe(false);
  });

  it("account-age throttle (#2561): an account OLDER than the threshold is unaffected — no label, no cap tightening", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 63, title: "Vet PR one", state: "open", user: { login: "newbie" }, head: { sha: "s63" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 64, title: "Vet PR two", state: "open", user: { login: "newbie" }, head: { sha: "s64" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      reviewCheckMode: "required",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 4,
      accountAgeThresholdDays: 30,
    });
    const seen = { labels: [] as string[], closed: false };
    // Account created 2 years ago — well over the 30-day threshold.
    vi.stubGlobal("fetch", stubAccountAgeFetch(65, new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString(), seen));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "account-age-unaffected",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 65, title: "Vet's 3rd PR", state: "open", user: { login: "newbie" }, head: { sha: "s65" }, labels: [], body: "x", mergeable_state: "clean" },
      },
    });

    expect(seen.labels).not.toContain("new-account");
    // The RAW cap (4) is not yet exceeded by a 3rd PR — untouched.
    expect(seen.closed).toBe(false);
  });

  it("account-age throttle (#2561): the repo OWNER's own PR is never labeled even on a brand-new account", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      reviewCheckMode: "required",
      accountAgeThresholdDays: 30,
    });
    const seen = { labels: [] as string[], closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/users/")) return Response.json({ login: "JSONbored", created_at: new Date().toISOString() });
      if (url.includes("/pulls/66/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/66/reviews")) return Response.json([]);
      if (url.includes("/pulls/66/commits")) return Response.json([]);
      if (url.endsWith("/pulls/66")) return Response.json({ number: 66, state: "open", user: { login: "JSONbored" }, head: { sha: "s66" }, mergeable_state: "clean" });
      if (url.includes("/commits/s66/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/s66/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/66/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/66/labels") && method === "POST") { seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[])); return Response.json([]); }
      if (url.includes("/issues/66/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "account-age-owner-exempt",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 66, title: "Owner's own PR", state: "open", user: { login: "JSONbored" }, head: { sha: "s66" }, labels: [], body: "x", mergeable_state: "clean" },
      },
    });

    expect(seen.labels).not.toContain("new-account");
  });

  it("account-age throttle (#2561): disabled (no threshold configured, the default) never fetches the GitHub user or labels", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      reviewCheckMode: "required",
      autonomy: { close: "auto", label: "auto" },
      // accountAgeThresholdDays intentionally omitted — off by default.
    });
    const seen = { labels: [] as string[], accountAgeUsersFetched: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // Distinct from the UNRELATED, always-on public-contributor-profile lookup (src/github/public.ts), which
      // hits this same bare /users/{login} URL but with NO authorization header (GITHUB_PUBLIC_TOKEN unset in
      // this test) — only getGithubUserCreatedAt's account-age-specific call sends a Bearer installation token.
      if (url.includes("/users/") && (init?.headers as Record<string, string> | undefined)?.authorization) {
        seen.accountAgeUsersFetched = true;
        return Response.json({ login: "newbie", created_at: new Date().toISOString() });
      }
      if (url.includes("/users/")) return Response.json({ login: "newbie" });
      if (url.includes("/pulls/67/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/67/reviews")) return Response.json([]);
      if (url.includes("/pulls/67/commits")) return Response.json([]);
      if (url.endsWith("/pulls/67")) return Response.json({ number: 67, state: "open", user: { login: "newbie" }, head: { sha: "s67" }, mergeable_state: "clean" });
      if (url.includes("/commits/s67/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/s67/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/67/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/67/labels") && method === "POST") { seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[])); return Response.json([]); }
      if (url.includes("/issues/67/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "account-age-disabled",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 67, title: "Newbie's PR", state: "open", user: { login: "newbie" }, head: { sha: "s67" }, labels: [], body: "x", mergeable_state: "clean" },
      },
    });

    expect(seen.accountAgeUsersFetched).toBe(false);
    expect(seen.labels).not.toContain("new-account");
  });

  it("account-age throttle (#2561): a configured newAccountLabel is used instead of the default", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      reviewCheckMode: "required",
      autonomy: { close: "auto", review_state_label: "auto" },
      accountAgeThresholdDays: 30,
      newAccountLabel: "custom-new-account-label",
    });
    const seen = { labels: [] as string[], closed: false };
    vi.stubGlobal("fetch", stubAccountAgeFetch(68, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), seen));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "account-age-custom-label",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 68, title: "Newbie's PR", state: "open", user: { login: "newbie" }, head: { sha: "s68" }, labels: [], body: "x", mergeable_state: "clean" },
      },
    });

    expect(seen.labels).toContain("custom-new-account-label");
    expect(seen.labels).not.toContain("new-account");
  });

  it("account-age throttle (#2561): a below-threshold account is NOT labeled when the repo has not opted into label autonomy (regression, gate finding)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      reviewCheckMode: "required",
      // autonomy intentionally omitted — deny-by-default ("observe" for every action class, including "review_state_label").
      accountAgeThresholdDays: 30,
    });
    const seen = { labels: [] as string[], closed: false };
    vi.stubGlobal("fetch", stubAccountAgeFetch(69, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), seen));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "account-age-label-not-autonomous",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 69, title: "Newbie's PR", state: "open", user: { login: "newbie" }, head: { sha: "s69" }, labels: [], body: "x", mergeable_state: "clean" },
      },
    });

    expect(seen.labels).not.toContain("new-account");
  });

  function stubIssueAccountAgeFetch(issueNumber: number, createdAt: string, seen: { labels: string[]; closed: boolean }) {
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/users/")) return Response.json({ login: "newbie", created_at: createdAt });
      if ((url.endsWith("/issues/60") || url.endsWith("/issues/61")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith(`/issues/${issueNumber}`) && method === "PATCH") {
        seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed";
        return Response.json({ state: "closed" });
      }
      if (url.includes(`/issues/${issueNumber}/labels`) && method === "GET") return Response.json([]);
      if (url.includes(`/issues/${issueNumber}/labels`) && method === "POST") {
        seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[]));
        return Response.json([]);
      }
      if (url.includes(`/issues/${issueNumber}/comments`) && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.endsWith("/labels") && method === "POST") return Response.json({ name: "x" }, { status: 201 });
      return Response.json({});
    };
  }

  it("account-age throttle (#2561 issue path): a below-threshold-age account gets the new-account label AND a tighter effective issue cap", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Newbie issue one", state: "open", user: { login: "newbie" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Newbie issue two", state: "open", user: { login: "newbie" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", review_state_label: "auto" },
      contributorOpenIssueCap: 4,
      accountAgeThresholdDays: 30,
    });
    const seen = { labels: [] as string[], closed: false };
    vi.stubGlobal("fetch", stubIssueAccountAgeFetch(62, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), seen));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "account-age-issue-tighter-cap",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Newbie's 3rd issue", state: "open", user: { login: "newbie" }, labels: [], body: "x" },
      },
    });

    expect(seen.labels).toContain("new-account");
    expect(seen.closed).toBe(true);
  });

  it("account-age throttle (#2561 issue path): when accountAgeThresholdDays is off, no user lookup runs", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Newbie issue one", state: "open", user: { login: "newbie" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Newbie issue two", state: "open", user: { login: "newbie" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", review_state_label: "auto" },
      contributorOpenIssueCap: 4,
    });
    let accountAgeUsersFetched = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/users/")) { accountAgeUsersFetched = true; return Response.json({ login: "newbie", created_at: new Date().toISOString() }); }
      if ((url.endsWith("/issues/60") || url.endsWith("/issues/61")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/issues/62") && method === "PATCH") return Response.json({ state: "open" });
      if (url.includes("/issues/62/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "account-age-issue-off",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Newbie's 3rd issue", state: "open", user: { login: "newbie" }, labels: [], body: "x" },
      },
    });

    expect(accountAgeUsersFetched).toBe(false);
  });

  it("account-age throttle (#2561 issue path): established account uses the full issue cap (no tightening)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Oldbie issue one", state: "open", user: { login: "oldbie" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Oldbie issue two", state: "open", user: { login: "oldbie" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", review_state_label: "auto" },
      contributorOpenIssueCap: 4,
      accountAgeThresholdDays: 30,
    });
    const seen = { labels: [] as string[], closed: false };
    vi.stubGlobal("fetch", stubIssueAccountAgeFetch(62, new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString(), seen));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "account-age-issue-established",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Oldbie's 3rd issue", state: "open", user: { login: "oldbie" }, labels: [], body: "x" },
      },
    });

    expect(seen.labels).not.toContain("new-account");
    expect(seen.closed).toBe(false);
  });

  it("account-age throttle (#2561 issue path): does not label when review_state_label is not auto", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Newbie issue one", state: "open", user: { login: "newbie" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Newbie issue two", state: "open", user: { login: "newbie" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto" },
      contributorOpenIssueCap: 4,
      accountAgeThresholdDays: 30,
    });
    const seen = { labels: [] as string[], closed: false };
    vi.stubGlobal("fetch", stubIssueAccountAgeFetch(62, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), seen));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "account-age-issue-label-not-autonomous",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Newbie's 3rd issue", state: "open", user: { login: "newbie" }, labels: [], body: "x" },
      },
    });

    expect(seen.labels).not.toContain("new-account");
    expect(seen.closed).toBe(true);
  });

  it("account-age throttle (#2561 issue path): user lookup failure fail-opens to the full configured cap", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Newbie issue one", state: "open", user: { login: "newbie" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Newbie issue two", state: "open", user: { login: "newbie" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", review_state_label: "auto" },
      contributorOpenIssueCap: 4,
      accountAgeThresholdDays: 30,
    });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/users/")) return new Response("not found", { status: 404 });
      if ((url.endsWith("/issues/60") || url.endsWith("/issues/61")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ state: "closed" }); }
      if (url.includes("/issues/62/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "account-age-issue-lookup-fail-open",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Newbie's 3rd issue", state: "open", user: { login: "newbie" }, labels: [], body: "x" },
      },
    });

    expect(seen.closed).toBe(false);
  });

  it("account-age throttle (#2561 issue path): a configured newAccountLabel is used instead of the default", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", review_state_label: "auto" },
      accountAgeThresholdDays: 30,
      newAccountLabel: "custom-new-account-label",
    });
    const seen = { labels: [] as string[], closed: false };
    vi.stubGlobal("fetch", stubIssueAccountAgeFetch(62, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), seen));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "account-age-issue-custom-label",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Newbie's issue", state: "open", user: { login: "newbie" }, labels: [], body: "x" },
      },
    });

    expect(seen.labels).toContain("custom-new-account-label");
    expect(seen.labels).not.toContain("new-account");
  });

  it("account-age throttle (#2561 issue path): the repo OWNER's own issue is never labeled even on a brand-new account", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", review_state_label: "auto" },
      accountAgeThresholdDays: 30,
    });
    const seen = { labels: [] as string[], closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/users/")) return Response.json({ login: "JSONbored", created_at: new Date().toISOString() });
      if (url.includes("/issues/70/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/70/labels") && method === "POST") {
        seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[]));
        return Response.json([]);
      }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "account-age-issue-owner-exempt",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 70, title: "Owner's own issue", state: "open", user: { login: "JSONbored" }, labels: [], body: "x" },
      },
    });

    expect(seen.labels).not.toContain("new-account");
  });

  it("account-age throttle (#2561 issue path): an ADMIN_GITHUB_LOGINS author is never labeled even on a brand-new account", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      ADMIN_GITHUB_LOGINS: "fleet-admin",
    });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", review_state_label: "auto" },
      accountAgeThresholdDays: 30,
    });
    const seen = { labels: [] as string[], closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/users/")) return Response.json({ login: "fleet-admin", created_at: new Date().toISOString() });
      if (url.includes("/issues/71/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/71/labels") && method === "POST") {
        seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[]));
        return Response.json([]);
      }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "account-age-issue-admin-exempt",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 71, title: "Admin's issue", state: "open", user: { login: "fleet-admin" }, labels: [], body: "x" },
      },
    });

    expect(seen.labels).not.toContain("new-account");
  });

  it("account-age throttle (#2561 issue path): a protected automation bot author is never labeled even on a brand-new account", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", review_state_label: "auto" },
      accountAgeThresholdDays: 30,
    });
    const seen = { labels: [] as string[], closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/users/")) return Response.json({ login: "dependabot[bot]", created_at: new Date().toISOString() });
      if (url.includes("/issues/72/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/72/labels") && method === "POST") {
        seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[]));
        return Response.json([]);
      }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "account-age-issue-bot-exempt",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 72, title: "Bot issue", state: "open", user: { login: "dependabot[bot]" }, labels: [], body: "x" },
      },
    });

    expect(seen.labels).not.toContain("new-account");
  });

  it("contributor open-PR cap (#2270): out-of-order webhook delivery wakes and self-corrects the missed sibling (regression, gate finding on #2479)", async () => {
    // PR56 (the NEWER PR) is delivered BEFORE PR55 exists in the DB — a real possibility under concurrent/
    // retried webhook delivery. At that moment PR56 only sees {54, 56} (2 total, AT the cap of 2, not over),
    // so it correctly stays open — but a naive "only ever check myself" implementation would leave it open
    // FOREVER, since nothing else ever re-evaluates PR56 again. This pins the fix: once PR55's delivery later
    // sees the COMPLETE set {54, 55, 56}, it must wake PR56 (not just decide for itself) so PR56 gets a fresh,
    // fully-gated re-evaluation and self-corrects.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR zero", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "w" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
    });
    const closedNumbers = new Set<number>();
    const fanned: import("../../src/types").JobMessage[] = [];
    const realSend = env.JOBS.send.bind(env.JOBS);
    env.JOBS.send = (async (message: import("../../src/types").JobMessage, options?: QueueSendOptions) => {
      if (message.type === "agent-regate-pr") fanned.push(message);
      return realSend(message, options);
    }) as typeof env.JOBS.send;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      for (const [n, sha] of [[54, "f54"], [55, "f55"], [56, "f56"]] as const) {
        if (url.includes(`/pulls/${n}/files`)) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
        if (url.includes(`/pulls/${n}/reviews`)) return Response.json([]);
        if (url.includes(`/pulls/${n}/commits`)) return Response.json([]);
        if (url.endsWith(`/pulls/${n}`) && method === "PATCH") { closedNumbers.add(n); return Response.json({ number: n, state: "closed" }); }
        if (url.endsWith(`/pulls/${n}`)) return Response.json({ number: n, state: closedNumbers.has(n) ? "closed" : "open", user: { login: "farmer99" }, head: { sha }, mergeable_state: "clean" });
        if (url.includes(`/commits/${sha}/check-runs`)) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes(`/commits/${sha}/status`)) return Response.json({ state: "success", statuses: [] });
        if (url.includes(`/issues/${n}/labels`) && method === "GET") return Response.json([]);
        if (url.includes(`/issues/${n}/labels`) && method === "POST") return Response.json([]);
        if (url.includes(`/issues/${n}/comments`) && method === "POST") return Response.json({ id: 1 }, { status: 201 });
        if (url.includes(`/issues/${n}/comments`)) return Response.json([]);
      }
      return Response.json({});
    });

    // PR56 arrives FIRST — PR55 does not exist yet, so PR56 sees only {54, 56}: at the cap, not over.
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "burst-pr56-first",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 56, title: "Farmer PR two (out of order)", state: "open", user: { login: "farmer99" }, head: { sha: "f56" }, labels: [], body: "y", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });
    expect(closedNumbers.has(56)).toBe(false); // correctly not closed YET — the set looked complete at the time

    // PR55 arrives SECOND — now the complete set {54, 55, 56} is visible. PR55 itself ranks within the cap
    // (oldest 2 of 3), so it stays open — but PR56 is now discoverably over-cap and must be woken.
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "burst-pr55-second",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });
    expect(closedNumbers.has(55)).toBe(false); // PR55 itself is within the cap
    expect(fanned.some((job) => job.type === "agent-regate-pr" && job.prNumber === 56)).toBe(true); // sibling woken

    // Drain the woken job — PR56's OWN fresh re-evaluation now sees the complete set and self-corrects.
    env.JOBS.send = realSend;
    for (const job of fanned) await processJob(env, job);
    expect(closedNumbers.has(56)).toBe(true);
  });

  it("contributor open-PR cap (#2270): a re-delivered sibling-wake is coalesced — the second discovery does not re-enqueue", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    // Pre-seed the coalescing key for PR56 exactly as wakeOverCapSiblingPullRequests itself would after a
    // first, already-successful enqueue — proving the SECOND discovery within the window skips re-enqueueing.
    // #5385-sentry (GITTENSORY-1D): keyed by PR56's own head SHA ("f56", upserted below) since the sibling
    // wake now resolves and includes it, not just the bare PR number.
    await env.SELFHOST_TRANSIENT_CACHE?.set("contributor-cap-wake:jsonbored/gittensory#56#f56", "1", 60);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR zero", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "w" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 56, title: "Farmer PR two (already over cap)", state: "open", user: { login: "farmer99" }, head: { sha: "f56" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
    });
    const fanned: import("../../src/types").JobMessage[] = [];
    const realSend = env.JOBS.send.bind(env.JOBS);
    env.JOBS.send = (async (message: import("../../src/types").JobMessage, options?: QueueSendOptions) => {
      if (message.type === "agent-regate-pr") fanned.push(message);
      return realSend(message, options);
    }) as typeof env.JOBS.send;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, mergeable_state: "clean" });
      if (url.includes("/commits/f55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels")) return Response.json([]);
      if (url.includes("/issues/55/comments")) return Response.json([]);
      return Response.json({});
    });

    // PR55 arrives and independently discovers PR56 is over cap — but the wake was already claimed.
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "wake-coalesce-second",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    expect(fanned).toEqual([]); // coalesced — no duplicate wake enqueued
  });

  it("contributor open-PR cap (#2270): swallows a failed sibling-wake enqueue and does not claim the coalescing key (regression)", async () => {
    // If env.JOBS.send() throws (queue backpressure/outage), the wake must be a best-effort fire-and-forget:
    // log and move on WITHOUT claiming the coalescing key, so a later discovery can still retry the enqueue.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR zero", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "w" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 56, title: "Farmer PR two (already over cap)", state: "open", user: { login: "farmer99" }, head: { sha: "f56" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
    });
    env.JOBS.send = (async () => {
      throw new Error("queue send boom");
    }) as typeof env.JOBS.send;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, mergeable_state: "clean" });
      if (url.includes("/commits/f55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels")) return Response.json([]);
      if (url.includes("/issues/55/comments")) return Response.json([]);
      return Response.json({});
    });

    // PR55 arrives, discovers PR56 is over cap, and the wake enqueue itself fails — must not throw.
    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "wake-enqueue-fails",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 55, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
        },
      }),
    ).resolves.not.toThrow();

    // The coalescing key was NOT claimed (enqueue failed), so a later discovery can still retry. Keyed by
    // PR56's own head SHA ("f56", upserted above) — see the coalescing test's identical note.
    expect(await env.SELFHOST_TRANSIENT_CACHE?.get("contributor-cap-wake:jsonbored/gittensory#56#f56")).toBeNull();
  });

  it("REGRESSION (#5385-sentry, GITTENSORY-1D): a repeat sibling-wake for the SAME unchanged head is still coalesced well past the old 60s window, but a genuinely NEW commit resets the guard", async () => {
    // Confirmed live: a contributor repeatedly opening (and having auto-closed) near-duplicate PRs re-triggered
    // the SAME sibling's full review/gate republish every time the cap was recomputed, even though nothing
    // about the sibling itself ever changed -- one PR published 27 redundant review surfaces in 2 hours this
    // way. The 60s CI-completion-burst coalesce window was never meant to (and didn't) protect against a
    // trigger recurring every several minutes to hours.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR zero", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "w" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 56, title: "Farmer PR two (already over cap)", state: "open", user: { login: "farmer99" }, head: { sha: "f56" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
    });
    const fanned: import("../../src/types").JobMessage[] = [];
    const realSend = env.JOBS.send.bind(env.JOBS);
    env.JOBS.send = (async (message: import("../../src/types").JobMessage, options?: QueueSendOptions) => {
      if (message.type === "agent-regate-pr") fanned.push(message);
      return realSend(message, options);
    }) as typeof env.JOBS.send;
    let pr56Sha = "f56";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      // Bare GET /pulls/{54,56} is the sibling live-open-state check the cap computation live-verifies before
      // treating either as a real, currently-open sibling (#2270 busy-repo bypass fix) -- both must resolve
      // "open" for PR56 to be correctly identified as the (numerically highest, over-cap) sibling.
      if (url.endsWith("/pulls/54")) return Response.json({ number: 54, state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, mergeable_state: "clean" });
      if (url.endsWith("/pulls/56")) return Response.json({ number: 56, state: "open", user: { login: "farmer99" }, head: { sha: pr56Sha }, mergeable_state: "clean" });
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, mergeable_state: "clean" });
      if (url.includes("/commits/f55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels")) return Response.json([]);
      if (url.includes("/issues/55/comments")) return Response.json([]);
      return Response.json({});
    });
    const rediscoverPr56AsOverCap = (deliveryId: string) =>
      processJob(env, {
        type: "github-webhook",
        deliveryId,
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 55, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
        },
      });

    // First discovery: PR56 is over cap -- wakes it once.
    await rediscoverPr56AsOverCap("wake-first");
    expect(fanned.filter((job) => job.type === "agent-regate-pr" && job.prNumber === 56)).toHaveLength(1);

    // 90 seconds later: past the OLD 60s coalesce window, but well within the new ~30-minute cooldown for an
    // UNCHANGED head SHA. A second discovery of the SAME still-over-cap sibling must NOT re-wake it.
    vi.setSystemTime(new Date("2026-05-28T00:01:30.000Z"));
    await rediscoverPr56AsOverCap("wake-second-still-coalesced");
    expect(fanned.filter((job) => job.type === "agent-regate-pr" && job.prNumber === 56)).toHaveLength(1); // still just the one

    // PR56 gets a genuinely NEW commit -- the guard must reset for the new head SHA so the sibling still gets
    // re-evaluated eventually, not stay silenced forever regardless of what actually changes about it.
    pr56Sha = "f56-v2";
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 56, title: "Farmer PR two (already over cap)", state: "open", user: { login: "farmer99" }, head: { sha: "f56-v2" }, labels: [], body: "y" });
    await rediscoverPr56AsOverCap("wake-third-after-new-commit");
    expect(fanned.filter((job) => job.type === "agent-regate-pr" && job.prNumber === 56)).toHaveLength(2); // woken again for the new head
  });

  it("REGRESSION (#5385-sentry, GITTENSORY-1D): a sibling-wake lookup miss fails OPEN to the bare (headSha-less) key and the shorter 60s window, instead of skipping the wake", async () => {
    // wakeOverCapSiblingPullRequests re-resolves the sibling's OWN current head SHA via a fresh getPullRequest
    // lookup (not the already-fetched author-scoped record) so the coalescing key reflects the truly-latest
    // commit. Force JUST that lookup to miss (as it would for a PR not yet/no-longer tracked locally) while
    // every other getPullRequest call in this same pass resolves normally -- proving the documented fail-open
    // fallback (bare key, CI_COALESCE_WINDOW_SECONDS) actually fires instead of silently dropping the wake.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR zero", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "w" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 56, title: "Farmer PR two (already over cap)", state: "open", user: { login: "farmer99" }, head: { sha: "f56" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "advisory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenPrCap: 2,
    });
    const realGetPullRequest = repositoriesModule.getPullRequest;
    vi.spyOn(repositoriesModule, "getPullRequest").mockImplementation(async (spyEnv, fullName, number) => {
      if (number === 56) return null; // simulate PR56 not being found locally at wake time
      return realGetPullRequest(spyEnv, fullName, number);
    });
    const setSpy = vi.spyOn(env.SELFHOST_TRANSIENT_CACHE!, "set");
    const fanned: import("../../src/types").JobMessage[] = [];
    const realSend = env.JOBS.send.bind(env.JOBS);
    env.JOBS.send = (async (message: import("../../src/types").JobMessage, options?: QueueSendOptions) => {
      if (message.type === "agent-regate-pr") fanned.push(message);
      return realSend(message, options);
    }) as typeof env.JOBS.send;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if (url.endsWith("/pulls/54")) return Response.json({ number: 54, state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, mergeable_state: "clean" });
      if (url.endsWith("/pulls/56")) return Response.json({ number: 56, state: "open", user: { login: "farmer99" }, head: { sha: "f56" }, mergeable_state: "clean" });
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, mergeable_state: "clean" });
      if (url.includes("/commits/f55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels")) return Response.json([]);
      if (url.includes("/issues/55/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "sibling-lookup-miss",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f55" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    expect(fanned.some((job) => job.type === "agent-regate-pr" && job.prNumber === 56)).toBe(true); // still woken despite the lookup miss
    const call = setSpy.mock.calls.find(([key]) => (key as string).startsWith("contributor-cap-wake:jsonbored/gittensory#56"));
    expect(call?.[0]).toBe("contributor-cap-wake:jsonbored/gittensory#56"); // bare key -- no headSha suffix
    expect(call?.[2]).toBe(60); // CI_COALESCE_WINDOW_SECONDS, not the ~1800s headSha-keyed cooldown
  });

  it("contributor open-ISSUE cap (#2270): a contributor's 3rd open issue (over a cap of 2) is labeled + closed deterministically", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Farmer issue one", state: "open", user: { login: "farmer99" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Farmer issue two", state: "open", user: { login: "farmer99" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenIssueCap: 2,
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorCapLabel: "spam-cap" } }, "repo_file");
    const seen = { closed: false, labels: [] as string[], comments: [] as string[] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if ((url.endsWith("/issues/60") || url.endsWith("/issues/61")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ state: "closed" }); }
      if (url.includes("/issues/62/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/62/labels") && method === "POST") { seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[])); return Response.json([]); }
      if (url.includes("/issues/62/comments") && method === "POST") { seen.comments.push(String(JSON.parse(String(init?.body ?? "{}")).body ?? "")); return Response.json({ id: 1 }, { status: 201 }); }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-issue-cap-close",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Farmer's 3rd issue", state: "open", user: { login: "farmer99" }, labels: [], body: "x" },
      },
    });

    expect(seen.closed).toBe(true);
    expect(seen.labels).toContain("spam-cap");
    expect(seen.comments.some((c) => c.includes("@farmer99") && c.includes("3 open issues") && c.includes("limit of 2"))).toBe(true);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBeGreaterThanOrEqual(1);
  });

  it("contributor open-ISSUE cap (#2270): bounds the sibling live-check fan-out instead of firing one request per open issue at once (#2766 parity)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    // SIBLING_COUNT other open issues from the same author, well beyond the concurrency bound, so an unbounded
    // Promise.all would fire every live-state GET at once. The cap is set BELOW the total so the newest issue is
    // over the cap and the sibling live-verification path actually runs (it walks the complete sibling set).
    const SIBLING_COUNT = 30;
    const EXPECTED_LIVE_CHECK_CONCURRENCY = 10; // mirrors CONTRIBUTOR_CAP_LIVE_CHECK_CONCURRENCY in processors.ts
    const newIssue = SIBLING_COUNT + 1;
    for (let number = 1; number <= SIBLING_COUNT; number += 1) {
      await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number, title: `Prolific issue ${number}`, state: "open", user: { login: "prolific" }, labels: [], body: "x" });
    }
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenIssueCap: SIBLING_COUNT,
    });
    let inFlight = 0;
    let maxInFlight = 0;
    let closed = false;
    const siblingCheckPattern = new RegExp(`/issues/(?:${Array.from({ length: SIBLING_COUNT }, (_, i) => i + 1).join("|")})$`);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (siblingCheckPattern.test(url) && method === "GET") {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5)); // force genuine overlap between concurrent checks
        inFlight -= 1;
        return Response.json({ state: "open" });
      }
      if (url.endsWith(`/issues/${newIssue}`) && method === "PATCH") { closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ state: "closed" }); }
      if (url.includes(`/issues/${newIssue}/comments`) && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-issue-cap-bounded-concurrency",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: newIssue, title: "Prolific author's newest issue", state: "open", user: { login: "prolific" }, labels: [], body: "x" },
      },
    });

    expect(closed).toBe(true); // the over-cap issue is closed, confirming the sibling live-check path actually ran
    expect(maxInFlight).toBeGreaterThan(1); // genuinely concurrent, not accidentally serial
    expect(maxInFlight).toBeLessThanOrEqual(EXPECTED_LIVE_CHECK_CONCURRENCY);
  });

  it("contributor open-ISSUE cap (#2270): a maintainer-named autoCloseExemptLogins entry is exempt from the PER-REPO issue cap too (not just the install-wide cap)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Sentry issue one", state: "open", user: { login: "sentry[bot]" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Sentry issue two", state: "open", user: { login: "sentry[bot]" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", label: "auto" },
      contributorOpenIssueCap: 2,
      autoCloseExemptLogins: ["sentry[bot]"],
    });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if ((url.endsWith("/issues/60") || url.endsWith("/issues/61")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ state: "closed" }); }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-issue-cap-exempt-login",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Sentry's 3rd issue", state: "open", user: { login: "sentry[bot]" }, labels: [], body: "x" },
      },
    });

    // Exempt: the 3rd issue is NOT closed for the cap, despite being (numerically) over it.
    expect(seen.closed).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBe(0);
  });

  it("REGRESSION (#2479 gate finding): a stale-open DB row for an already-closed sibling does NOT inflate the count and wrongly close a newly opened issue within the real cap", async () => {
    // Issue #60 is stored `open` locally but is ACTUALLY closed on GitHub (live GET returns closed) -- e.g. a
    // webhook this instance hasn't processed yet, or a manual close elsewhere. Without live-verifying it, the
    // stale count would be 3 (60, 61, 62) against a cap of 2, wrongly closing #62. Live-verified, the real count
    // is 2 (61, 62), within cap.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Farmer issue one (stale-open)", state: "open", user: { login: "farmer99" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Farmer issue two", state: "open", user: { login: "farmer99" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" }, contributorOpenIssueCap: 2 });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/60") && method === "GET") return Response.json({ state: "closed" });
      if (url.endsWith("/issues/61") && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = true; return Response.json({ state: "closed" }); }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-issue-cap-stale-closed-sibling",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Farmer's issue, within the real cap", state: "open", user: { login: "farmer99" }, labels: [], body: "x" },
      },
    });

    expect(seen.closed).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n ?? 0).toBe(0);
  });

  it("REGRESSION (#2479 gate finding, second pass): a live-check failure for a counted sibling fails SAFE (excluded from the count) rather than counting it toward an irreversible close", async () => {
    // Unlike reconcileLiveDuplicateSiblings' fail-open-to-stored contract (safe there because it only re-ranks a
    // non-final duplicate-cluster winner recomputed every delivery), this count directly gates an IRREVERSIBLE
    // close. An unreadable live fetch for sibling #60 (404) must NOT let it keep counting toward the cap --
    // otherwise a transient fetch failure stacked on a stale "open" DB row would wrongly close a newly opened
    // issue that is actually within the real cap. #60 unverifiable + #61 confirmed open + #62 incoming = 2,
    // within the cap of 2, so #62 must NOT close.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Farmer issue one", state: "open", user: { login: "farmer99" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Farmer issue two", state: "open", user: { login: "farmer99" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" }, contributorOpenIssueCap: 2 });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/60") && method === "GET") return new Response("not found", { status: 404 });
      if (url.endsWith("/issues/61") && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = true; return Response.json({ state: "closed" }); }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-issue-cap-live-check-fails-safe",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Farmer's issue, within the real cap", state: "open", user: { login: "farmer99" }, labels: [], body: "x" },
      },
    });

    expect(seen.closed).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n ?? 0).toBe(0);
  });

  it("a live-verified-open sibling still counts toward the cap and closes the incoming issue when genuinely over", async () => {
    // Positive-confirmation path: both siblings live-verify as open, so the real count (60, 61, 62 = 3) against
    // a cap of 2 is genuine, and #62 correctly closes.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Farmer issue one", state: "open", user: { login: "farmer99" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Farmer issue two", state: "open", user: { login: "farmer99" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" }, contributorOpenIssueCap: 2 });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorCapLabel: "spam-cap" } }, "repo_file");
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/60") && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/issues/61") && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = true; return Response.json({ state: "closed" }); }
      if (url.includes("/issues/62/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/62/labels") || url.includes("/issues/62/comments")) return Response.json([], { status: 201 });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-issue-cap-live-verified-genuine",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Farmer's genuinely 3rd issue", state: "open", user: { login: "farmer99" }, labels: [], body: "x" },
      },
    });

    expect(seen.closed).toBe(true);
  });

  it("falls back to GITHUB_PUBLIC_TOKEN for the sibling live-check when the installation token mint fails", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITHUB_PUBLIC_TOKEN: "public-fallback-token" });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Farmer issue one (stale-open)", state: "open", user: { login: "farmer99" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Farmer issue two", state: "open", user: { login: "farmer99" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" }, contributorOpenIssueCap: 2 });
    const seen = { closed: false, sawPublicToken: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return new Response("suspended", { status: 401 });
      if (url.endsWith("/issues/60") && method === "GET") {
        seen.sawPublicToken = new Headers(init?.headers).get("authorization")?.includes("public-fallback-token") ?? false;
        return Response.json({ state: "closed" });
      }
      if (url.endsWith("/issues/61") && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = true; return Response.json({ state: "closed" }); }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-issue-cap-public-token-fallback",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Farmer's issue, within the real cap", state: "open", user: { login: "farmer99" }, labels: [], body: "x" },
      },
    });

    expect(seen.sawPublicToken).toBe(true);
    // #60 was live-verified closed via the public-token fallback, so the real count (61, 62) is within cap.
    expect(seen.closed).toBe(false);
  });

  it("contributor open-ISSUE cap (#2270): disabled (no cap configured, the default) never closes an over-threshold contributor's issue", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Farmer issue one", state: "open", user: { login: "farmer99" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Farmer issue two", state: "open", user: { login: "farmer99" }, labels: [], body: "y" });
    // No contributorOpenIssueCap set — the default, disabled state.
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = true; return Response.json({ state: "closed" }); }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-issue-cap-disabled",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Farmer's 3rd issue", state: "open", user: { login: "farmer99" }, labels: [], body: "x" },
      },
    });

    expect(seen.closed).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n ?? 0).toBe(0);
  });

  it("install-wide contributor open-item cap (#2562): an over-install-cap contributor's issue is caught even with NO per-repo contributorOpenIssueCap configured", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "2" });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [
        { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        { name: "repo-b", full_name: "JSONbored/repo-b", private: false, owner: { login: "JSONbored" } },
      ],
    });
    await upsertRepositoryFromGitHub(env, { name: "repo-b", full_name: "JSONbored/repo-b", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertIssueFromGitHub(env, "JSONbored/repo-a", { number: 20, title: "Farmer issue on repo-a", state: "open", user: { login: "farmer99" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/repo-b", { number: 10, title: "Farmer issue on repo-b", state: "open", user: { login: "farmer99" }, labels: [], body: "y" });
    // No contributorOpenIssueCap set — only the install-wide env cap should catch this.
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/repo-a", autonomy: { close: "auto", label: "auto" } });
    const seen = { closed: false, labels: [] as string[], comments: [] as string[] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ state: "closed" }); }
      if (url.includes("/issues/62/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/62/labels") && method === "POST") { seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[])); return Response.json([]); }
      if (url.includes("/issues/62/comments") && method === "POST") { seen.comments.push(String(JSON.parse(String(init?.body ?? "{}")).body ?? "")); return Response.json({ id: 1 }, { status: 201 }); }
      // Install-wide live-verify (#2562 gate-review follow-up) re-fetches every OTHER counted sibling before
      // trusting it toward the cap -- both of farmer99's other open items must resolve as confirmed-open here.
      if (url.endsWith("/repos/JSONbored/repo-a/issues/20")) return Response.json({ number: 20, state: "open" });
      if (url.endsWith("/repos/JSONbored/repo-b/issues/10")) return Response.json({ number: 10, state: "open" });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "global-contributor-issue-cap-close",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Farmer's 3rd issue install-wide", state: "open", user: { login: "farmer99" }, labels: [], body: "x" },
      },
    });

    expect(seen.closed).toBe(true);
    expect(seen.labels).toContain("over-contributor-limit");
    // Install-wide cap counts BOTH open PRs and open issues together (#2562 gate-review follow-up), so the
    // close message reports the mixed noun rather than a stale "issues"-only phrasing from the old count-only path.
    expect(seen.comments.some((c) => c.includes("@farmer99") && c.includes("3 open pull requests and issues") && c.includes("across every repository it gates"))).toBe(true);
  });

  it("install-wide contributor open-item cap (#2562, #4511): env var unset falls back to the real default (20), so an issue author spread across repos well under it is not closed", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() }); // no GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP -- resolves to the DEFAULT_GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP, not "no cap" (#4511)
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [
        { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        { name: "repo-b", full_name: "JSONbored/repo-b", private: false, owner: { login: "JSONbored" } },
      ],
    });
    await upsertIssueFromGitHub(env, "JSONbored/repo-a", { number: 20, title: "Farmer issue on repo-a", state: "open", user: { login: "farmer99" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/repo-b", { number: 10, title: "Farmer issue on repo-b", state: "open", user: { login: "farmer99" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/repo-a", autonomy: { close: "auto", label: "auto" } });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = true; return Response.json({ state: "closed" }); }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "global-contributor-issue-cap-off-by-default",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Farmer's 3rd issue install-wide", state: "open", user: { login: "farmer99" }, labels: [], body: "x" },
      },
    });

    expect(seen.closed).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n ?? 0).toBe(0);
  });

  it("install-wide contributor open-item cap (#2562): an issue author AT (not over) the install-wide cap is not closed, and falls through to the (unset) per-repo issue cap check safely", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "2" });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [
        { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        { name: "repo-b", full_name: "JSONbored/repo-b", private: false, owner: { login: "JSONbored" } },
      ],
    });
    await upsertIssueFromGitHub(env, "JSONbored/repo-b", { number: 10, title: "Farmer issue on repo-b", state: "open", user: { login: "farmer99" }, labels: [], body: "y" });
    // No contributorOpenIssueCap configured -- exercises the (typeof cap !== "number") early return after the
    // install-wide check falls through without matching.
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/repo-a", autonomy: { close: "auto", label: "auto" } });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = true; return Response.json({ state: "closed" }); }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "global-contributor-issue-cap-at-limit",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Farmer's 2nd issue, at the install-wide limit", state: "open", user: { login: "farmer99" }, labels: [], body: "x" },
      },
    });

    expect(seen.closed).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n ?? 0).toBe(0);
  });

  it("install-wide contributor open-item cap (#2562): an over-install-cap issue plans no action (observe-only autonomy) and does not execute a close", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "2" });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [
        { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        { name: "repo-b", full_name: "JSONbored/repo-b", private: false, owner: { login: "JSONbored" } },
      ],
    });
    await upsertIssueFromGitHub(env, "JSONbored/repo-a", { number: 20, title: "Farmer issue on repo-a", state: "open", user: { login: "farmer99" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/repo-b", { number: 10, title: "Farmer issue on repo-b", state: "open", user: { login: "farmer99" }, labels: [], body: "y" });
    // autonomy: {} (no acting classes granted) — the plan builds empty, so `planned.length > 0` is false.
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/repo-a", autonomy: {} });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = true; return Response.json({ state: "closed" }); }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "global-contributor-issue-cap-observe-only",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Farmer's 3rd issue install-wide, observe-only", state: "open", user: { login: "farmer99" }, labels: [], body: "x" },
      },
    });

    expect(seen.closed).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n ?? 0).toBe(0);
  });

  it("install-wide contributor open-item cap (#2562): with BOTH the global cap and the per-repo issue cap configured, an author within the global cap still trips the per-repo cap unchanged", async () => {
    // Global cap of 5 is never approached (only 1 open item on repo-b), but the per-repo contributorOpenIssueCap
    // of 2 on repo-a IS tripped by this author's 3rd repo-a issue -- proves the two checks are independent and
    // the per-repo path still runs (typeof cap !== "number" false branch) after the global check falls through.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "5" });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertIssueFromGitHub(env, "JSONbored/repo-a", { number: 60, title: "Farmer issue one", state: "open", user: { login: "farmer99" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/repo-a", { number: 61, title: "Farmer issue two", state: "open", user: { login: "farmer99" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/repo-a", autonomy: { close: "auto", label: "auto" }, contributorOpenIssueCap: 2 });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if ((url.endsWith("/issues/60") || url.endsWith("/issues/61")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ state: "closed" }); }
      if (url.includes("/issues/62/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/62/labels") && method === "POST") return Response.json([]);
      if (url.includes("/issues/62/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "global-and-per-repo-issue-cap-both-configured",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "repo-a", full_name: "JSONbored/repo-a", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Farmer's 3rd repo-a issue, over the per-repo cap only", state: "open", user: { login: "farmer99" }, labels: [], body: "x" },
      },
    });

    expect(seen.closed).toBe(true);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBeGreaterThanOrEqual(1);
  });

  it("install-wide contributor open-item cap (#4511): miner cap off still falls through to the per-repo issue cap", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP_MINER: "off",
    });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Farmer issue one", state: "open", user: { login: "farmer99" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Farmer issue two", state: "open", user: { login: "farmer99" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" }, contributorOpenIssueCap: 2 });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([{ githubUsername: "farmer99", githubId: "123", totalPrs: 2, totalMergedPrs: 2, isEligible: true, credibility: 1 }]);
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://api.gittensor.io/miners/123") return Response.json({});
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if ((url.endsWith("/issues/60") || url.endsWith("/issues/61")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ state: "closed" }); }
      if (url.includes("/issues/62/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/62/labels") && method === "POST") return Response.json([]);
      if (url.includes("/issues/62/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "miner-off-falls-through-to-repo-issue-cap",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Farmer's 3rd issue", state: "open", user: { login: "farmer99" }, labels: [], body: "x" },
      },
    });

    expect(seen.closed).toBe(true);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBeGreaterThanOrEqual(1);
  });

  it("install-wide contributor open-item cap (#5205): an over-install-cap issue with autonomy that plans NO action does not execute a close", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "2" });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Farmer issue one", state: "open", user: { login: "farmer99" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Farmer issue two", state: "open", user: { login: "farmer99" }, labels: [], body: "y" });
    // autonomy: {} (no acting classes granted) -- planAgentMaintenanceActions builds an empty plan, so
    // `planned.length > 0` is false and executeIssueMaintenanceActions is never called.
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: {} });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if ((url.endsWith("/issues/60") || url.endsWith("/issues/61")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = true; return Response.json({ state: "closed" }); }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "global-contributor-issue-cap-empty-plan",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Farmer's 3rd issue install-wide, no autonomy granted", state: "open", user: { login: "farmer99" }, labels: [], body: "x" },
      },
    });

    expect(seen.closed).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n ?? 0).toBe(0);
  });

  it("contributor open-ISSUE cap (#2270): the repo OWNER's own issue is never closed even over the cap", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Owner issue one", state: "open", user: { login: "JSONbored" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Owner issue two", state: "open", user: { login: "JSONbored" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" }, contributorOpenIssueCap: 2 });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = true; return Response.json({ state: "closed" }); }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-issue-cap-owner",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Owner's 3rd issue", state: "open", user: { login: "JSONbored" }, labels: [], body: "x" },
      },
    });

    expect(seen.closed).toBe(false);
  });

  it("contributor open-ISSUE cap (#2270): a contributor's 2nd issue AT (not over) a cap of 2 is not closed", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    // Only ONE pre-existing open issue from this author — the incoming issue is their 2nd, exactly at the cap.
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Farmer issue one", state: "open", user: { login: "farmer99" }, labels: [], body: "x" });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" }, contributorOpenIssueCap: 2 });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = true; return Response.json({ state: "closed" }); }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-issue-cap-at-limit",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Farmer's 2nd issue", state: "open", user: { login: "farmer99" }, labels: [], body: "x" },
      },
    });

    expect(seen.closed).toBe(false);
  });

  it("contributor open-ISSUE cap (#2270): an over-cap issue is not closed when both label and close autonomy are observe-only", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Farmer issue one", state: "open", user: { login: "farmer99" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Farmer issue two", state: "open", user: { login: "farmer99" }, labels: [], body: "y" });
    // No acting autonomy for label/close — deny-by-default (autonomy: {}) means planAgentMaintenanceActions
    // plans nothing at all, so this exercises the "planned.length === 0" early return distinctly from the
    // disabled-cap case above (here the cap DOES match; there is simply nothing to execute).
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: {}, contributorOpenIssueCap: 2 });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = true; return Response.json({ state: "closed" }); }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-issue-cap-no-autonomy",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Farmer's 3rd issue", state: "open", user: { login: "farmer99" }, labels: [], body: "x" },
      },
    });

    expect(seen.closed).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n ?? 0).toBe(0);
  });

  it("contributor open-ISSUE cap (#2270): a slash-free repoFullName is safely planned (repoOwner computation guard) even though the GitHub call itself can never succeed against that name", async () => {
    // A real webhook always carries "owner/repo"; this pins the DEFENSIVE repoFullName.includes("/") ? ... : ""
    // fallback (mirroring the PR path's own such guard) against a malformed value WITHOUT crashing the cap
    // computation. The actual close attempt legitimately errors — splitRepo() (shared by every GitHub-action
    // primitive) rejects any repoFullName that isn't "owner/repo" — and that error is caught and audited, not
    // thrown into the webhook handler; a successful close against a slash-free name is not physically possible
    // via the real GitHub REST API, so asserting an audited error (not a crash) is the correct expectation.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "noslash", full_name: "noslash", private: false, owner: { login: "" } }, 123);
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "noslash", full_name: "noslash", private: false, owner: { login: "" } }],
    });
    await upsertIssueFromGitHub(env, "noslash", { number: 60, title: "Farmer issue one", state: "open", user: { login: "farmer99" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "noslash", { number: 61, title: "Farmer issue two", state: "open", user: { login: "farmer99" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, { repoFullName: "noslash", autonomy: { close: "auto", label: "auto" }, contributorOpenIssueCap: 2 });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/60") || url.endsWith("/issues/61")) return Response.json({ state: "open" });
      return Response.json({});
    });

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "contributor-issue-cap-noslash",
        eventName: "issues",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "", id: 1, type: "User" } },
          repository: { name: "noslash", full_name: "noslash", private: false, owner: { login: "" } },
          issue: { number: 62, title: "Farmer's 3rd issue", state: "open", user: { login: "farmer99" }, labels: [], body: "x" },
        },
      }),
    ).resolves.not.toThrow();

    const closeAudit = await env.DB.prepare("select outcome, detail from audit_events where event_type = 'agent.action.close' order by created_at desc limit 1").first<{ outcome: string; detail: string }>();
    expect(closeAudit?.outcome).toBe("error");
    expect(closeAudit?.detail).toMatch(/Invalid repository full name/);
  });

  it("contributor open-ISSUE cap (#2270): an author-less (ghost) open issue among the repo's others is excluded from the count, not crashed on", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    // A ghost issue with no `user` at all (authorLogin ends up null) — must not match farmer99's count nor throw.
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 59, title: "Ghost issue", state: "open", labels: [], body: "z" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Farmer issue one", state: "open", user: { login: "farmer99" }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Farmer issue two", state: "open", user: { login: "farmer99" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" }, contributorOpenIssueCap: 2 });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if ((url.endsWith("/issues/60") || url.endsWith("/issues/61")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/issues/62") && method === "PATCH") { seen.closed = true; return Response.json({ state: "closed" }); }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-issue-cap-ghost-author",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Farmer's 3rd issue", state: "open", user: { login: "farmer99" }, labels: [], body: "x" },
      },
    });

    // Ghost issue's null authorLogin never matches "farmer99" — the count is still exactly 3 (farmer99's own),
    // so the cap-of-2 close fires; a broken nullish fallback would either crash or double-count the ghost.
    expect(seen.closed).toBe(true);
  });

  // #1092: prReadyForReview rebases a BEHIND-base PR through the agent executor (gated by update_branch autonomy
  // + pull_requests:write) before reviewing, then defers — the synchronize on the new head re-runs review.
});
