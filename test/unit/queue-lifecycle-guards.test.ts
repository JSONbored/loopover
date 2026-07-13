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

describe("changedPathsForGuardrail", () => {
  it("collects current + rename paths and skips empty entries", () => {
    const files = [
      { path: "src/a.ts", previousFilename: null },
      { path: "src/b.ts", previousFilename: "src/old-b.ts" }, // a rename contributes both names
      { path: "", previousFilename: "" }, // an empty path AND empty rename are both skipped (both guard branches false)
    ] as unknown as Parameters<typeof changedPathsForGuardrail>[0];
    expect(changedPathsForGuardrail(files)).toEqual(["src/a.ts", "src/b.ts", "src/old-b.ts"]);
  });
});

describe("agentMaintenanceHeadMatchesGate", () => {
  it("allows maintenance only when the stored PR head still matches the reviewed gate head", () => {
    expect(agentMaintenanceHeadMatchesGate("reviewed", "reviewed")).toBe(true);
    expect(agentMaintenanceHeadMatchesGate("reviewed", "new-unreviewed")).toBe(false);
  });

  it("keeps legacy no-SHA paths fail-open because no exact reviewed head can be pinned", () => {
    expect(agentMaintenanceHeadMatchesGate(undefined, "current")).toBe(true);
    expect(agentMaintenanceHeadMatchesGate("reviewed", null)).toBe(true);
  });

  it("REGRESSION (#stale-head): a newer synchronize that advances the stored head before maintenance acts blocks the stale-gate auto-merge", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      action: "created",
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        target_type: "User",
        repository_selection: "all",
        permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    // Clean, mergeable, approved, green CI + merge:auto + approve:auto + close:auto — this PR WOULD be auto-acted.
    // The ONLY thing that must stop it is the stale-head guard in maybeRunAgentMaintenance.
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
      if (url.includes("/commits/stale1/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/stale1/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) return Response.json({ id: 902 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    // Simulate the concurrent-queue race the guard defends against: the gate evaluated head "stale1", but by the
    // time maintenance re-reads the persisted row a newer `synchronize` has advanced the stored head to "newer2".
    // maybeRunAgentMaintenance re-reads via getPullRequest, so divert that read to the advanced head.
    const realGetPullRequest = repositoriesModule.getPullRequest;
    const spy = vi.spyOn(repositoriesModule, "getPullRequest").mockImplementation(async (...callArgs) => {
      const row = await realGetPullRequest(...callArgs);
      return row ? { ...row, headSha: "newer2" } : row;
    });
    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "stale-head-no-maintenance",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 71, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "stale1" }, labels: [], body: "Closes #1", mergeable_state: "clean", reviewDecision: "APPROVED" },
        },
      });
    } finally {
      spy.mockRestore();
    }

    // No terminal maintenance action of ANY class fires: the gate verdict belonged to the now-stale head.
    const acted = await env.DB.prepare("select count(*) as n from audit_events where event_type in ('agent.action.merge','agent.action.approve','agent.action.close')").first<{ n: number }>();
    expect(acted?.n).toBe(0);
  });
});

describe("one-shot reopen prevention", () => {
  beforeEach(() => {
    clearInstallationTokenCacheForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("re-closes contributor reopens after a write collaborator closed the PR", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      // Both a "closed" event (by the write collaborator) AND a "reopened" event (by the contributor, still the
      // most recent reopener) — the new live re-check (#2369) reads this same endpoint to confirm the contributor
      // is still the current reopener before proceeding to close.
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }, { event: "reopened", actor: { login: "contributor" } }]);
      if (url.endsWith("/issues/42/comments")) return Response.json({ id: 99 }, { status: 201 });
      if (url.endsWith("/pulls/42") && method === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto", request_changes: "auto", close: "auto" } }); // opted into acting autonomy

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "reopen-write-collab-close",
      eventName: "pull_request",
      payload: reopenedPayload("contributor"),
    });

    expect(calls.some((call) => call.url.endsWith("/collaborators/contributor/permission"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/collaborators/maintainer/permission"))).toBe(true);
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/issues/42/comments"))).toBe(true);
    expect(calls.some((call) => call.method === "PATCH" && call.url.endsWith("/pulls/42"))).toBe(true);
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("completed"); // #2260: a successful close is unaffected
    expect(audit?.detail).toContain("originally closed by maintainer");
    // #review-audit: the early return after a re-close stamps the delivery processed (was left "queued").
    const webhookRow = await env.DB.prepare("select status from webhook_events where delivery_id = ?").bind("reopen-write-collab-close").first<{ status: string }>();
    expect(webhookRow?.status).toBe("processed");
  });

  it("does NOT re-close a disallowed reopen when live PR state has moved since the webhook was received (#2130, #2261)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }]);
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto", request_changes: "auto", close: "auto" } });
    // A maintainer legitimately reopened/re-approved the PR — or a queue retry replayed a stale payload — in
    // the window between the original webhook delivery and this handler's permission/closer-history reads. The
    // live re-check must catch it and deny the re-close rather than overwriting a live maintainer decision.
    vi.mocked(fetchPullRequestFreshness).mockResolvedValueOnce({ status: "stale", reason: "head_changed", expectedHeadSha: "abc123", liveHeadSha: "def456", liveState: "open" });

    await processJob(env, { type: "github-webhook", deliveryId: "reopen-stale", eventName: "pull_request", payload: reopenedPayload("contributor") });

    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("reopen re-close not executed");
  });

  it("REGRESSION: does NOT re-close when the reopener gained maintainer permission before the close fires (#2130 follow-up)", async () => {
    // Same head, still open — a head/state-only freshness check would say "current". But the reopener could
    // have been promoted to a write/maintain/admin collaborator (or added as one) in the window between the
    // initial permission read and this handler's close, which retroactively authorizes exactly the reopen
    // this handler is about to undo.
    const calls: Array<{ url: string; method: string }> = [];
    let contributorPermissionCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) {
        contributorPermissionCalls += 1;
        // First read (upstream decision to re-close at all): still just a reader. Second read (the live
        // re-check right before the mutation): promoted to a write collaborator.
        return Response.json({ permission: contributorPermissionCalls === 1 ? "read" : "write" });
      }
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }]);
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto", request_changes: "auto", close: "auto" } });

    await processJob(env, { type: "github-webhook", deliveryId: "reopen-promoted", eventName: "pull_request", payload: reopenedPayload("contributor") });

    expect(contributorPermissionCalls).toBe(2);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("now holds maintainer permission");
  });

  it("REGRESSION: does NOT re-close when a DIFFERENT (maintainer) reopener supersedes the original disallowed reopen (#2369)", async () => {
    // The original contributor reopen is what triggered this handler, but by the time it runs, a real maintainer
    // has ALSO reopened the same PR (a legitimate, authorized reopen is now the current reason it's open). Head/
    // state freshness and the reopener's OWN permission re-check both miss this — neither sees WHO most recently
    // reopened. The timeline shows a "closed" event by "maintainer" (the original one-shot close) followed by a
    // LATER "reopened" event by a different maintainer login ("second-maintainer"), after the contributor's own
    // earlier reopen.
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) {
        return Response.json([
          { event: "closed", actor: { login: "maintainer" } },
          { event: "reopened", actor: { login: "contributor" } },
          { event: "closed", actor: { login: "maintainer" } },
          { event: "reopened", actor: { login: "second-maintainer" } },
        ]);
      }
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto", request_changes: "auto", close: "auto" } });

    await processJob(env, { type: "github-webhook", deliveryId: "reopen-superseded", eventName: "pull_request", payload: reopenedPayload("contributor") });

    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("second-maintainer");
    expect(audit?.detail).toContain("not contributor");
  });

  it("happy path unaffected: re-closes when the same reopener is still the latest reopener on the timeline (#2369)", async () => {
    // Confirms the new live re-check does not spuriously block the ordinary case: the contributor is BOTH the
    // original AND the still-current reopener (no one else reopened it again in the meantime).
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }, { event: "reopened", actor: { login: "contributor" } }]);
      if (url.endsWith("/issues/42/comments")) return Response.json({ id: 99 }, { status: 201 });
      if (url.endsWith("/pulls/42") && method === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto", request_changes: "auto", close: "auto" } });

    await processJob(env, { type: "github-webhook", deliveryId: "reopen-same-latest", eventName: "pull_request", payload: reopenedPayload("contributor") });

    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(true);
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(true);
    const audit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ outcome: string }>();
    expect(audit?.outcome).toBe("completed");
  });

  it("REGRESSION: denies when padding makes the latest reopener ambiguous beyond the inspected event window", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const eventPages: number[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.includes("/issues/42/events")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        eventPages.push(page);
        if (page === 1) {
          return Response.json([{ event: "closed", actor: { login: "maintainer" } }, { event: "reopened", actor: { login: "contributor" } }], {
            headers: { link: '<https://api.github.com/repos/owner/repo/issues/42/events?per_page=100&page=22>; rel="last"' },
          });
        }
        if (page === 12) return Response.json([{ event: "reopened", actor: { login: "second-maintainer" } }]);
        return Response.json([{ event: "renamed", actor: { login: "contributor" } }]);
      }
      if (url.endsWith("/issues/42/comments")) return Response.json({ id: 99 }, { status: 201 });
      if (url.endsWith("/pulls/42") && method === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto", request_changes: "auto", close: "auto" } });

    await processJob(env, { type: "github-webhook", deliveryId: "reopen-window-stuffed", eventName: "pull_request", payload: reopenedPayload("contributor") });

    expect(eventPages).toContain(22);
    expect(eventPages).not.toContain(12);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("the current reopener is now unknown, not contributor");
  });

  it("REGRESSION: fails CLOSED (denies the re-close) when the reopener-timeline read errors (#2369)", async () => {
    // The reopener-timeline lookup errors (network failure) → getLastReopenerLogin catches and returns
    // { login: null, coveredAllPages: false, errored: true } — DISTINCT from the padded-window case above
    // (which has errored: false). The design explicitly fails CLOSED here (deny the close) rather than
    // proceeding, since wrongly re-closing a maintainer-authorized PR is worse than leaving a disallowed
    // reopen open for one more tick.
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) throw new Error("GitHub events API down");
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto", request_changes: "auto", close: "auto" } });

    await processJob(env, { type: "github-webhook", deliveryId: "reopen-timeline-error", eventName: "pull_request", payload: reopenedPayload("contributor") });

    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("could not confirm");
  });

  it("REGRESSION: denies with an 'unknown' current-reopener detail when the timeline genuinely has no reopen event at all (#2369)", async () => {
    // The window is FULLY covered (a single page, no Link header) but contains no "reopened" event whatsoever —
    // getLastReopenerLogin returns { login: null, coveredAllPages: true }, which is NOT the ambiguous case (that
    // requires coveredAllPages: false); it lands on the "superseded by a different actor" arm with a null login,
    // exercising the `latestReopenerLogin ?? "unknown"` fallback in the audit detail.
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }]);
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto", request_changes: "auto", close: "auto" } });

    await processJob(env, { type: "github-webhook", deliveryId: "reopen-no-reopen-event", eventName: "pull_request", payload: reopenedPayload("contributor") });

    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("the current reopener is now unknown, not contributor");
  });

  it("swallows a recordAuditEvent failure on the superseded-reopener denial path — handler still completes (#2369)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) {
        return Response.json([
          { event: "closed", actor: { login: "maintainer" } },
          { event: "reopened", actor: { login: "contributor" } },
          { event: "closed", actor: { login: "maintainer" } },
          { event: "reopened", actor: { login: "second-maintainer" } },
        ]);
      }
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto", request_changes: "auto", close: "auto" } });
    vi.spyOn(repositoriesModule, "recordAuditEvent").mockRejectedValueOnce(new Error("D1 write error"));

    await expect(
      processJob(env, { type: "github-webhook", deliveryId: "reopen-superseded-audit-fail", eventName: "pull_request", payload: reopenedPayload("contributor") }),
    ).resolves.toBeUndefined();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
  });

  it("swallows a recordAuditEvent failure on the stale-reopen denial path — handler still completes (#2130)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }]);
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto", request_changes: "auto", close: "auto" } });
    vi.mocked(fetchPullRequestFreshness).mockResolvedValueOnce({ status: "stale", reason: "head_changed", expectedHeadSha: "abc123", liveHeadSha: "def456", liveState: "open" });
    vi.spyOn(repositoriesModule, "recordAuditEvent").mockRejectedValueOnce(new Error("D1 write error"));

    await expect(
      processJob(env, { type: "github-webhook", deliveryId: "reopen-stale-audit-fail", eventName: "pull_request", payload: reopenedPayload("contributor") }),
    ).resolves.toBeUndefined();
  });

  it("swallows a recordAuditEvent failure on the promoted-reopener denial path — handler still completes (#2130 follow-up)", async () => {
    let contributorPermissionCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) {
        contributorPermissionCalls += 1;
        return Response.json({ permission: contributorPermissionCalls === 1 ? "read" : "write" });
      }
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }]);
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto", request_changes: "auto", close: "auto" } });
    vi.spyOn(repositoriesModule, "recordAuditEvent").mockRejectedValueOnce(new Error("D1 write error"));

    await expect(
      processJob(env, { type: "github-webhook", deliveryId: "reopen-promoted-audit-fail", eventName: "pull_request", payload: reopenedPayload("contributor") }),
    ).resolves.toBeUndefined();
    expect(contributorPermissionCalls).toBe(2);
  });

  it("records outcome:error (not completed) when the reclose PATCH call itself fails (#2260)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      // "contributor" (the payload's reopener) must be the MOST RECENT "reopened" actor in the timeline, or the
      // #2369 live-recheck #3 (reopenerSuperseded) denies before ever reaching the close attempt this test targets.
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }, { event: "reopened", actor: { login: "contributor" } }]);
      if (url.endsWith("/issues/42/comments")) return Response.json({ id: 99 }, { status: 201 }); // the courtesy comment succeeds
      if (url.endsWith("/pulls/42") && method === "PATCH") return new Response("forbidden", { status: 403 }); // the close itself fails
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto", request_changes: "auto", close: "auto" } });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "reopen-close-fails",
      eventName: "pull_request",
      payload: reopenedPayload("contributor"),
    });

    expect(calls.some((call) => call.method === "PATCH" && call.url.endsWith("/pulls/42"))).toBe(true); // the close WAS attempted
    const audit = await env.DB.prepare("select outcome, detail, metadata_json from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ outcome: string; detail: string; metadata_json: string }>();
    expect(audit?.outcome).toBe("error"); // NOT "completed" — the close did not actually succeed
    expect(audit?.detail).toContain("FAILED to re-close");
    expect(JSON.parse(audit?.metadata_json ?? "{}").error).toBeTruthy();
    // The handler still owns the decision (never falls through to normal re-review) even though the API call failed.
    const webhookRow = await env.DB.prepare("select status from webhook_events where delivery_id = ?").bind("reopen-close-fails").first<{ status: string }>();
    expect(webhookRow?.status).toBe("processed");
  });

  it("retries the reopen-reclose when a concurrent delivery already holds the per-PR actuation lock (#2447)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }]);
      if (url.endsWith("/issues/42/comments")) return Response.json({ id: 99 }, { status: 201 });
      if (url.endsWith("/pulls/42") && method === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto", request_changes: "auto" } });
    // Simulates a DIFFERENT concurrent delivery for the same PR already in flight (e.g. the draft-dodge sibling
    // racing this reopen) — the lock key it would hold is pre-claimed here.
    await env.SELFHOST_TRANSIENT_CACHE?.set("pr-actuation-lock:jsonbored/gittensory#42", "1", 60);
    // A contended lock must still stop before resolveRepositorySettings, the first call the normal re-review makes,
    // but must NOT stamp this reopen delivery processed: the lock holder may be an unrelated same-PR guard that
    // no-ops, so the queue needs to retry this reopen guard once the lock clears.
    const resolveSettingsSpy = vi.spyOn(repositorySettingsModule, "resolveRepositorySettings");

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "reopen-lock-contended",
        eventName: "pull_request",
        payload: reopenedPayload("contributor"),
      }),
    ).rejects.toMatchObject({ retryKind: "pr_actuation_lock_contended" });

    expect(calls.some((call) => call.method === "PATCH" && call.url.endsWith("/pulls/42"))).toBe(false);
    const audit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ n: number }>();
    expect(audit?.n).toBe(0); // no decision recorded either way — retry owns the eventual reopen decision
    expect(resolveSettingsSpy).not.toHaveBeenCalled(); // the normal re-review pass never started
    const webhookRow = await env.DB.prepare("select status, error_summary from webhook_events where delivery_id = ?").bind("reopen-lock-contended").first<{ status: string; error_summary: string }>();
    expect(webhookRow?.status).toBe("error");
    expect(webhookRow?.error_summary).toContain("pr actuation lock contended");
  });

  it("does NOT re-close a disallowed reopen on an OBSERVE-only / un-opted-in repo (autonomy floor, #review-audit)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }]);
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    // NO autonomy configured (observe-only / un-opted-in): the agent must take NO destructive action.
    await processJob(env, { type: "github-webhook", deliveryId: "reopen-observe-only", eventName: "pull_request", payload: reopenedPayload("contributor") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false); // never closed
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(false); // never commented
  });

  it("does NOT re-close a disallowed reopen while the global freeze is on — records a skip instead (#killswitch-gap)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }]);
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto", request_changes: "auto", close: "auto" } }); // opted into acting autonomy
    await repositoriesModule.setGlobalAgentFrozen(env, true); // emergency brake on
    await processJob(env, { type: "github-webhook", deliveryId: "reopen-frozen", eventName: "pull_request", payload: reopenedPayload("contributor") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false); // never closed
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("skipped (agent paused)");
  });

  it("dry-run: audits a would-be reopen re-close without touching GitHub (#killswitch-gap)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }]);
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", agentDryRun: true, autonomy: { merge: "auto", request_changes: "auto", close: "auto" } });
    await processJob(env, { type: "github-webhook", deliveryId: "reopen-dryrun", eventName: "pull_request", payload: reopenedPayload("contributor") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false); // never closed
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("completed");
    expect(audit?.detail).toContain("dry-run: would re-close");
  });

  it("allows the bot's own reopen without reclosing (nightly re-review reopen, #one-shot-reopen)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await processJob(env, { type: "github-webhook", deliveryId: "bot-reopen", eventName: "pull_request", payload: reopenedPayload("gittensory[bot]") });
    // No collaborator-permission lookup or reclose PATCH -- the bot-login short-circuit fires before either.
    expect(calls.some((c) => c.url.includes("/collaborators/"))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
  });

  it("allows an admin reopener to reopen without reclosing (fast-path hasMaintainerPermission)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory", ADMIN_GITHUB_LOGINS: "admin-user" });
    await processJob(env, { type: "github-webhook", deliveryId: "admin-reopen", eventName: "pull_request", payload: reopenedPayload("admin-user") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
  });

  it("allows reopen when the closer is unknown (null lastCloser)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.includes("/issues/42/events")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await processJob(env, { type: "github-webhook", deliveryId: "unknown-closer", eventName: "pull_request", payload: reopenedPayload("contributor") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
  });

  it("re-closes when the close event is hidden beyond the inspected event window (window-evasion fail-closed, #audit-2.4)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.includes("/issues/42/events")) {
        // Long timeline (lastPage=12): the contributor padded the events so the real close sits before the
        // inspected newest window. No "closed" appears in the read pages → null closer + coveredAllPages=false.
        // The tail DOES include the contributor's own "reopened" event (the one this whole handler is reacting
        // to), so the new live re-check (#2369) still finds `contributor` as the current reopener and does not
        // itself block the re-close — only the (deliberately fail-closed) window-evasion path above does.
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        if (page === 1) {
          return Response.json([{ event: "labeled", actor: { login: "contributor" } }], {
            headers: { link: '<https://api.github.com/repos/owner/repo/issues/42/events?per_page=100&page=12>; rel="last"' },
          });
        }
        if (page === 12) return Response.json([{ event: "labeled", actor: { login: "contributor" } }, { event: "reopened", actor: { login: "contributor" } }]);
        return Response.json([{ event: "labeled", actor: { login: "contributor" } }]);
      }
      if (url.endsWith("/issues/42/comments")) return Response.json({ id: 99 }, { status: 201 });
      if (url.endsWith("/pulls/42") && method === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto", request_changes: "auto", close: "auto" } }); // opted into acting autonomy
    await processJob(env, { type: "github-webhook", deliveryId: "window-evasion-reclose", eventName: "pull_request", payload: reopenedPayload("contributor") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(true);
    const audit = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ detail: string }>();
    expect(audit?.detail).toContain("beyond the inspected event window");
  });

  it("re-closes when the bot itself was the last closer", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "gittensory[bot]" } }, { event: "reopened", actor: { login: "contributor" } }]);
      if (url.endsWith("/issues/42/comments")) return Response.json({ id: 99 }, { status: 201 });
      if (url.endsWith("/pulls/42") && method === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto", request_changes: "auto", close: "auto" } }); // opted into acting autonomy
    await processJob(env, { type: "github-webhook", deliveryId: "bot-closer-reclose", eventName: "pull_request", payload: reopenedPayload("contributor") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(true);
  });

  it("allows reopen when a contributor self-closed (non-maintainer, non-bot closer)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "contributor" } }]);
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await processJob(env, { type: "github-webhook", deliveryId: "self-close-reopen", eventName: "pull_request", payload: reopenedPayload("contributor") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
  });

  it("treats permission API errors as non-maintainer (catch path returns null)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.endsWith("/permission")) throw new Error("permission API down");
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "contributor" } }]);
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await processJob(env, { type: "github-webhook", deliveryId: "perm-api-error", eventName: "pull_request", payload: reopenedPayload("contributor") });
    // permission API threw → null → non-maintainer reopener + non-maintainer closer → no reclose.
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
  });

  it("swallows createIssueComment, closePullRequest, and recordAuditEvent errors on reclose (fail-safe — all .catch() bodies)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }, { event: "reopened", actor: { login: "contributor" } }]);
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      // createIssueComment (POST) and closePullRequest (PATCH) both throw → their .catch(() => undefined) bodies run
      throw new Error("GitHub API unavailable");
    });
    vi.spyOn(repositoriesModule, "recordAuditEvent").mockRejectedValueOnce(new Error("D1 write error"));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await expect(
      processJob(env, { type: "github-webhook", deliveryId: "reopen-api-fail-safe", eventName: "pull_request", payload: reopenedPayload("contributor") }),
    ).resolves.toBeUndefined();
  });

  it("REGRESSION (#4602): does NOT re-close a disallowed reopen when close autonomy is unconfigured, even though another class (merge) is auto", async () => {
    // Before #4602, this guard gated only on isAgentConfigured(autonomy) -- true here because `merge` is
    // acting -- with no check on the `close` action class specifically. A repo that opts into merge/review
    // autonomy but deliberately leaves close unconfigured (deny-by-default) must NOT have PRs re-closed here.
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }, { event: "reopened", actor: { login: "contributor" } }]);
      if (url.endsWith("/issues/42/comments")) return Response.json({ id: 99 }, { status: 201 });
      if (url.endsWith("/pulls/42") && method === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { merge: "auto", request_changes: "auto" } });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "reopen-close-autonomy-unconfigured",
      eventName: "pull_request",
      payload: reopenedPayload("contributor"),
    });

    expect(calls.some((call) => call.method === "PATCH" && call.url.endsWith("/pulls/42"))).toBe(false);
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/issues/42/comments"))).toBe(false);
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("autonomy for close is not acting");
    expect(audit?.detail).toContain("reopen re-close not enforced for contributor");
  });

  it("REGRESSION (#4602): denies with an approval-required message when close autonomy is auto_with_approval", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
      if (url.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" });
      if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "maintainer" } }, { event: "reopened", actor: { login: "contributor" } }]);
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await repositoriesModule.upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto_with_approval" } });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "reopen-close-autonomy-approval",
      eventName: "pull_request",
      payload: reopenedPayload("contributor"),
    });

    expect(calls.some((call) => call.method === "PATCH" && call.url.endsWith("/pulls/42"))).toBe(false);
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("close autonomy requires approval");
  });
});

describe("converted_to_draft gate-close (draft-dodge prevention)", () => {
  beforeEach(() => clearInstallationTokenCacheForTest());
  afterEach(() => {
    clearInstallationTokenCacheForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function draftPayload(author: string, headSha = "abc123", isDraft = true): any {
    return {
      action: "converted_to_draft",
      installation: { id: 123 },
      repository: { id: 1, name: "gittensory", full_name: "JSONbored/gittensory", private: false, default_branch: "main", owner: { login: "JSONbored" } },
      sender: { login: author, type: "User" },
      pull_request: {
        id: 4242,
        number: 42,
        state: "open",
        title: "Some PR",
        body: "Body.",
        user: { login: author },
        head: { sha: headSha, ref: "fix", repo: { full_name: `${author}/gittensory`, owner: { login: author } } },
        base: { sha: "base123", ref: "main", repo: { full_name: "JSONbored/gittensory", owner: { login: "JSONbored" } } },
        draft: isDraft,
        merged: false,
        mergeable_state: "clean",
        created_at: "2026-05-27T00:00:00Z",
        updated_at: "2026-05-27T00:00:00Z",
      },
    };
  }

  async function setupRepo(env: ReturnType<typeof createTestEnv>, overrides: Record<string, unknown> = {}): Promise<void> {
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
      reviewCheckMode: "required",
      autonomy: { close: "auto" },
      agentPaused: false,
      ...overrides,
    });
  }

  it("closes a PR immediately when the contributor converts to draft after a gate failure on the same headSha", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.endsWith("/issues/42/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.endsWith("/pulls/42") && method === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    await processJob(env, { type: "github-webhook", deliveryId: "draft-dodge-1", eventName: "pull_request", payload: draftPayload("contributor") });

    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(true);
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(true);
    const audit = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ detail: string }>();
    expect(audit?.detail).toContain("abc123");
    expect(audit?.detail).toContain("contributor");
  });

  it("does NOT draft-dodge close when live PR state has moved since the webhook was received (#2130)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });
    // A maintainer merged/closed the PR — or a fresh commit resolved the gate failure — in the window between
    // webhook ingestion and this handler's async DB reads (getGateBlockOutcome, isGlobalAgentFrozen). The live
    // re-check must catch it and deny the close rather than firing blind off the stale ingestion-time payload.
    vi.mocked(fetchPullRequestFreshness).mockResolvedValueOnce({ status: "stale", reason: "closed", expectedHeadSha: "abc123", liveHeadSha: "abc123", liveState: "closed" });

    await processJob(env, { type: "github-webhook", deliveryId: "draft-dodge-stale", eventName: "pull_request", payload: draftPayload("contributor") });

    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("draft-dodge close not executed");
  });

  it("REGRESSION: does NOT draft-dodge close when the PR was converted back to ready_for_review before the close fires (#2130 follow-up)", async () => {
    // Same head, still open — a head/state-only freshness check would say "current". But the draft-dodge
    // close's whole justification is "the author is dodging the gate via draft state", which no longer holds
    // once the PR is ready_for_review again — closing here would be wrong even though nothing else moved.
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });
    vi.mocked(fetchPullRequestFreshness).mockResolvedValueOnce({ status: "stale", reason: "no_longer_draft", expectedHeadSha: "abc123", liveHeadSha: "abc123", liveState: "open" });

    await processJob(env, { type: "github-webhook", deliveryId: "draft-dodge-no-longer-draft", eventName: "pull_request", payload: draftPayload("contributor") });

    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    expect(fetchPullRequestFreshness).toHaveBeenCalledWith(env, expect.objectContaining({ requireDraft: true }));
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("no longer a draft");
  });

  it("swallows a recordAuditEvent failure on the stale-draft-dodge denial path — handler still completes (#2130)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });
    vi.mocked(fetchPullRequestFreshness).mockResolvedValueOnce({ status: "stale", reason: "closed", expectedHeadSha: "abc123", liveHeadSha: "abc123", liveState: "closed" });
    vi.spyOn(repositoriesModule, "recordAuditEvent").mockRejectedValueOnce(new Error("D1 write error"));

    await expect(
      processJob(env, { type: "github-webhook", deliveryId: "draft-dodge-stale-audit-fail", eventName: "pull_request", payload: draftPayload("contributor") }),
    ).resolves.toBeUndefined();
  });

  it("denies the draft-dodge close (never attempts it) when pull_requests: write is not granted (#2134)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.endsWith("/issues/42/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.endsWith("/pulls/42") && method === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    // Installation grant is missing pull_requests: write (revoked or never consented) — issues: write is present,
    // so this isn't a blanket permission failure, just the specific scope this close needs.
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewCheckMode: "required", autonomy: { close: "auto" }, agentPaused: false });
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    await processJob(env, { type: "github-webhook", deliveryId: "draft-dodge-no-write", eventName: "pull_request", payload: draftPayload("contributor") });

    // Neither the close nor its accompanying comment was attempted — a 403 from GitHub is never reached.
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(false);
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("pull_requests: write not granted");
  });

  it("denies the draft-dodge close when no installation row was pre-synced and the webhook payload carries no permissions", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.endsWith("/issues/42/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.endsWith("/pulls/42") && method === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    // No installations row pre-seeded. processGitHubWebhook auto-upserts one from the payload's bare
    // `installation: { id: 123 }` (no permissions field, as a real pull_request payload carries), so the
    // resulting row has no explicit pull_requests:write grant — the permission check must fail CLOSED (deny).
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewCheckMode: "required", autonomy: { close: "auto" }, agentPaused: false });
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    await processJob(env, { type: "github-webhook", deliveryId: "draft-dodge-no-install-row", eventName: "pull_request", payload: draftPayload("contributor") });

    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    const audit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ outcome: string }>();
    expect(audit?.outcome).toBe("denied");
  });

  it("REGRESSION: a transient getInstallation read failure during the draft-dodge readiness check propagates (retries) instead of misrecording a permission denial", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.endsWith("/issues/42/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.endsWith("/pulls/42") && method === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
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
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", reviewCheckMode: "required", autonomy: { close: "auto" }, agentPaused: false });
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });
    // First getInstallation call in processGitHubWebhook (installationActor derivation, unrelated to this fix)
    // resolves normally; the SECOND call is the draft-dodge readiness check itself -- that one is a genuine D1
    // read failure, not a "row not found."
    const getInstallationSpy = vi.spyOn(repositoriesModule, "getInstallation");
    getInstallationSpy.mockResolvedValueOnce({
      id: 123,
      accountLogin: "JSONbored",
      accountId: 1,
      appId: null,
      targetType: "User",
      repositorySelection: "selected",
      permissions: { metadata: "read", pull_requests: "write", issues: "write" },
      events: ["pull_request"],
      suspendedAt: null,
      createdAt: null,
      updatedAt: null,
    });
    getInstallationSpy.mockRejectedValueOnce(new Error("D1 read failed"));

    await expect(processJob(env, { type: "github-webhook", deliveryId: "draft-dodge-install-read-fails", eventName: "pull_request", payload: draftPayload("contributor") })).rejects.toThrow("D1 read failed");

    // Neither the close nor its accompanying comment was attempted -- the failure short-circuits before either.
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(false);
    // No misleading "pull_requests: write not granted" audit -- the webhook's own top-level catch records the
    // actual error instead, which the queue's standard retry-on-throw semantics will re-attempt.
    const draftDodgeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ n: number }>();
    expect(draftDodgeAudit?.n).toBe(0);
    const webhookAudit = await env.DB.prepare("select status, error_summary from webhook_events where delivery_id = ?").bind("draft-dodge-install-read-fails").first<{ status: string; error_summary: string | null }>();
    expect(webhookAudit?.status).toBe("error");
    expect(webhookAudit?.error_summary).toContain("D1 read failed");
  });

  it("does NOT draft-dodge close while the global freeze is on (#killswitch-gap)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });
    await repositoriesModule.setGlobalAgentFrozen(env, true);
    await processJob(env, { type: "github-webhook", deliveryId: "draft-frozen", eventName: "pull_request", payload: draftPayload("contributor") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false); // never closed under freeze
    expect(await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it("dry-run: audits a would-be draft-dodge close without touching GitHub (#killswitch-gap)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env, { agentDryRun: true });
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });
    await processJob(env, { type: "github-webhook", deliveryId: "draft-dryrun", eventName: "pull_request", payload: draftPayload("contributor") });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false); // never closed in dry-run
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("completed");
    expect(audit?.detail).toContain("dry-run: would close");
  });

  it("retries the draft-dodge close when a concurrent delivery already holds the per-PR actuation lock (#2447)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.endsWith("/issues/42/comments")) return Response.json({ id: 1 }, { status: 201 });
      if (url.endsWith("/pulls/42")) return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });
    // Simulates a DIFFERENT concurrent delivery for the same PR already in flight (e.g. a check_suite completion
    // racing this converted_to_draft event) — the lock key it would hold is pre-claimed here.
    await env.SELFHOST_TRANSIENT_CACHE?.set("pr-actuation-lock:jsonbored/gittensory#42", "1", 60);

    await expect(processJob(env, { type: "github-webhook", deliveryId: "draft-dodge-lock-contended", eventName: "pull_request", payload: draftPayload("contributor") })).rejects.toThrow("pr actuation lock contended");

    expect(calls.some((c) => c.includes("PATCH") && c.includes("/pulls/42"))).toBe(false);
    const audit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ n: number }>();
    expect(audit?.n).toBe(0); // no decision recorded either way — the queue retry owns the deferred decision
  });

  it("REGRESSION: exactly ONE of two genuinely concurrent draft-dodge deliveries for the SAME PR wins the actuation lock (#2135)", async () => {
    // Unlike the lock-contended test above (which pre-seeds the key before the call even starts), this fires
    // two deliveries together via Promise.all with NEITHER pre-claiming anything — exercising the actual
    // check-and-set race claimPrActuationLock must arbitrate, not just "the key was already there". A
    // get-then-set (non-atomic) implementation lets both deliveries observe an absent key and both proceed,
    // which this test would catch as more than one PATCH / more than one completed audit row.
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.endsWith("/issues/42/comments")) return Response.json({ id: 1 }, { status: 201 });
      if (url.endsWith("/pulls/42")) return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    const results = await Promise.allSettled([
      processJob(env, { type: "github-webhook", deliveryId: "draft-dodge-race-a", eventName: "pull_request", payload: draftPayload("contributor") }),
      processJob(env, { type: "github-webhook", deliveryId: "draft-dodge-race-b", eventName: "pull_request", payload: draftPayload("contributor") }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const patchCalls = calls.filter((c) => c.includes("PATCH") && c.includes("/pulls/42"));
    expect(patchCalls).toHaveLength(1); // exactly one delivery won the race and closed the PR
    const audit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and outcome = 'completed'").bind("github_app.draft_dodge_closed").first<{ n: number }>();
    expect(audit?.n).toBe(1); // exactly one completed close recorded — not two (the race), not zero
  });

  it("no-ops when no prior gate failure exists for the PR", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    // No gate block recorded — gate hasn't run yet.

    await processJob(env, { type: "github-webhook", deliveryId: "draft-no-block", eventName: "pull_request", payload: draftPayload("contributor") });

    expect(calls.some((c) => c.includes("PATCH") && c.includes("/pulls/42"))).toBe(false);
  });

  it("no-ops when the prior gate failure is for a different headSha (contributor pushed fixes in draft)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    // Block exists but for an OLDER commit — contributor has pushed new code in draft.
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "old-sha-XYZ", blockerCodes: ["missing_linked_issue"] });

    // Payload headSha is "abc123" (new commit), not "old-sha-XYZ".
    await processJob(env, { type: "github-webhook", deliveryId: "draft-new-sha", eventName: "pull_request", payload: draftPayload("contributor", "abc123") });

    expect(calls.some((c) => c.includes("PATCH") && c.includes("/pulls/42"))).toBe(false);
  });

  it("no-ops when the gate block has been maintainer-overridden", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });
    await markGateOutcomeOverridden(env, "JSONbored/gittensory", 42);

    await processJob(env, { type: "github-webhook", deliveryId: "draft-overridden", eventName: "pull_request", payload: draftPayload("contributor") });

    expect(calls.some((c) => c.includes("PATCH") && c.includes("/pulls/42"))).toBe(false);
  });

  it("no-ops when the PR author is the repo owner (owner PRs are never auto-closed)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    // Author = "JSONbored" = repo owner → no close.
    await processJob(env, { type: "github-webhook", deliveryId: "draft-owner", eventName: "pull_request", payload: draftPayload("JSONbored") });

    expect(calls.some((c) => c.includes("PATCH") && c.includes("/pulls/42"))).toBe(false);
  });

  it("no-ops when the PR author is an ADMIN_GITHUB_LOGINS fleet-operator, not just the literal repo owner (#2133)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory", ADMIN_GITHUB_LOGINS: "admin-user" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    // Author = "admin-user" ≠ repo owner "JSONbored", but IS in ADMIN_GITHUB_LOGINS → no close.
    await processJob(env, { type: "github-webhook", deliveryId: "draft-admin", eventName: "pull_request", payload: draftPayload("admin-user") });

    expect(calls.some((c) => c.includes("PATCH") && c.includes("/pulls/42"))).toBe(false);
  });

  it("no-ops when the agent is paused (agentPaused=true)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env, { agentPaused: true });
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    await processJob(env, { type: "github-webhook", deliveryId: "draft-paused", eventName: "pull_request", payload: draftPayload("contributor") });

    expect(calls.some((c) => c.includes("PATCH") && c.includes("/pulls/42"))).toBe(false);
  });

  it("no-ops when the agent autonomy is not configured (autonomy=null)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env, { autonomy: null });
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    await processJob(env, { type: "github-webhook", deliveryId: "draft-no-autonomy", eventName: "pull_request", payload: draftPayload("contributor") });

    expect(calls.some((c) => c.includes("PATCH") && c.includes("/pulls/42"))).toBe(false);
  });

  it("closes with empty blockerCodes (no codes parenthetical) and null author (uses 'unknown' in audit)", async () => {
    // covers: codes ? `(${codes})` : "" → "" branch; pr.authorLogin ?? "unknown" → "unknown" branch
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.endsWith("/issues/42/comments") && (init?.method ?? "GET") === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.endsWith("/pulls/42") && (init?.method ?? "GET") === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    // empty blockerCodes → codes = "" → ternary takes the "" branch
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: [] });

    // null user.login → authorLogin null → (null ?? "").toLowerCase() === "" ≠ "jsonbored" → authorIsOwner false → close proceeds
    // → pr.authorLogin ?? "unknown" in audit detail takes the "unknown" branch
    const payload = draftPayload("contributor");
    payload.pull_request.user = { login: null };
    await processJob(env, { type: "github-webhook", deliveryId: "empty-codes-null-author", eventName: "pull_request", payload });

    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(true);
    const comment = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"));
    expect(comment).toBeDefined();
    const audit = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ detail: string }>();
    expect(audit?.detail).toContain("unknown");
  });

  it("swallows createIssueComment and closePullRequest API errors (fail-safe — both .catch() bodies)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      throw new Error("simulated network error"); // all GitHub calls throw
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    // Should not throw even though createIssueComment and closePullRequest both throw
    await expect(
      processJob(env, { type: "github-webhook", deliveryId: "api-error-swallow", eventName: "pull_request", payload: draftPayload("contributor") }),
    ).resolves.toBeUndefined();

    // Audit event was still written to DB (recordAuditEvent uses D1, not fetch)
    const audit = await env.DB.prepare("select event_type from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ event_type: string }>();
    expect(audit?.event_type).toBe("github_app.draft_dodge_closed");
  });

  it("getGateBlockOutcome DB error is caught — handler no-ops gracefully", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${input}`);
      if (input.toString().includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    // Spy on getGateBlockOutcome to throw — the .catch(() => undefined) body must execute
    vi.spyOn(repositoriesModule, "getGateBlockOutcome").mockRejectedValueOnce(new Error("D1 error"));

    await expect(
      processJob(env, { type: "github-webhook", deliveryId: "gbo-db-error", eventName: "pull_request", payload: draftPayload("contributor") }),
    ).resolves.toBeUndefined();

    // No close should have happened (block was unknown due to DB error)
    expect(calls.some((c) => c.includes("PATCH") && c.includes("/pulls/42"))).toBe(false);
  });

  it("recordAuditEvent failure is swallowed — close still proceeds without crashing", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.endsWith("/issues/42/comments") && (init?.method ?? "GET") === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.endsWith("/pulls/42") && (init?.method ?? "GET") === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env);
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    vi.spyOn(repositoriesModule, "recordAuditEvent").mockRejectedValueOnce(new Error("D1 write error"));

    await expect(
      processJob(env, { type: "github-webhook", deliveryId: "audit-db-error", eventName: "pull_request", payload: draftPayload("contributor") }),
    ).resolves.toBeUndefined();

    // Close still happened despite audit failure
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(true);
  });

  it("no-op owner-exemption when repoFullName has no slash (repoOwner is empty — authorIsOwner always false)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/issues/") && (init?.method ?? "GET") === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/pulls/") && (init?.method ?? "GET") === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    // Setup with a slash-free repo name
    await upsertRepositoryFromGitHub(env, { name: "noslash", full_name: "noslash", private: false, owner: { login: "" } }, 200);
    await upsertInstallation(env, {
      installation: {
        id: 200,
        account: { login: "", id: 2, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "noslash", full_name: "noslash", private: false, owner: { login: "" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "noslash",
      reviewCheckMode: "required",
      autonomy: { close: "auto" },
      agentPaused: false,
    });
    await recordGateBlockOutcome(env, { repoFullName: "noslash", pullNumber: 77, headSha: "sha-noslash", blockerCodes: ["missing_linked_issue"] });

    const noslashPayload = {
      action: "converted_to_draft",
      installation: { id: 200 },
      repository: { id: 2, name: "noslash", full_name: "noslash", private: false, default_branch: "main", owner: { login: "" } },
      sender: { login: "someone", type: "User" },
      pull_request: {
        id: 9999,
        number: 77,
        state: "open",
        title: "slash-free",
        body: "",
        user: { login: "someone" },
        head: { sha: "sha-noslash", ref: "fix", repo: { full_name: "someone/noslash", owner: { login: "someone" } } },
        base: { sha: "base", ref: "main", repo: { full_name: "noslash", owner: { login: "" } } },
        draft: true,
        merged: false,
        mergeable_state: "clean",
        created_at: "2026-05-27T00:00:00Z",
        updated_at: "2026-05-27T00:00:00Z",
      },
    };

    await expect(
      processJob(env, { type: "github-webhook", deliveryId: "noslash-test", eventName: "pull_request", payload: noslashPayload }),
    ).resolves.toBeUndefined();

    // With no slash in repoFullName: repoOwner="" (branch 196 false) → repoOwner.length>0=false (branch 198 false)
    // → authorIsOwner=false → handler enters the close path. closePullRequest/.catch() swallows the splitRepo
    // error (GitHub API requires owner/repo — slash-free names can't be closed via API) but the handler itself
    // doesn't crash. Verify the handler DID reach getGateBlockOutcome, proving branches 196+198 were exercised.
    const verifyBlock = await repositoriesModule.getGateBlockOutcome(env, "noslash", 77);
    expect(verifyBlock?.headSha).toBe("sha-noslash");
  });

  it("REGRESSION (#4602): does NOT draft-dodge close when close autonomy is unconfigured, even though another PR-write class (approve) is auto and pull_requests:write IS granted", async () => {
    // Before #4602, resolveAgentPermissionReadiness's missing actionClass:"close" checked the UNION of every
    // acting class's write-permission grant, not close's specifically -- `approve` is a PR-write class and
    // pull_requests:write IS granted here (setupRepo's default), so readiness alone used to read "ready" and
    // let the close proceed despite close itself never being authorized.
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.endsWith("/issues/42/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.endsWith("/pulls/42") && method === "PATCH") return Response.json({ state: "closed" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env, { autonomy: { approve: "auto" } });
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    await processJob(env, { type: "github-webhook", deliveryId: "draft-dodge-close-autonomy-unconfigured", eventName: "pull_request", payload: draftPayload("contributor") });

    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("autonomy for close is not acting");
    expect(audit?.detail).toContain("draft-dodge close not enforced for contributor");
  });

  it("REGRESSION (#4602): denies with an approval-required message when close autonomy is auto_with_approval", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    await setupRepo(env, { autonomy: { close: "auto_with_approval" } });
    await recordGateBlockOutcome(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });

    await processJob(env, { type: "github-webhook", deliveryId: "draft-dodge-close-autonomy-approval", eventName: "pull_request", payload: draftPayload("contributor") });

    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toContain("close autonomy requires approval");
  });
});

function draftEvasionPayload(author: string, headSha = "abc123"): any {
  return {
    action: "converted_to_draft",
    installation: { id: 123 },
    repository: { id: 1, name: "gittensory", full_name: "JSONbored/gittensory", private: false, default_branch: "main", owner: { login: "JSONbored" } },
    sender: { login: author, type: "User" },
    pull_request: {
      id: 4242,
      number: 42,
      state: "open",
      title: "Some PR",
      body: "Body.",
      user: { login: author },
      head: { sha: headSha, ref: "fix", repo: { full_name: `${author}/gittensory`, owner: { login: author } } },
      base: { sha: "base123", ref: "main", repo: { full_name: "JSONbored/gittensory", owner: { login: "JSONbored" } } },
      draft: true,
      merged: false,
      mergeable_state: "clean",
      created_at: "2026-05-27T00:00:00Z",
      updated_at: "2026-05-27T00:00:00Z",
    },
  };
}

function closedPayload(sender: string, author = sender, headSha = "abc123"): any {
  return {
    action: "closed",
    installation: { id: 123 },
    repository: { id: 1, name: "gittensory", full_name: "JSONbored/gittensory", private: false, default_branch: "main", owner: { login: "JSONbored" } },
    sender: { login: sender, type: "User" },
    pull_request: {
      id: 4242,
      number: 42,
      state: "closed",
      title: "Some PR",
      body: "Body.",
      user: { login: author },
      head: { sha: headSha, ref: "fix", repo: { full_name: `${author}/gittensory`, owner: { login: author } } },
      base: { sha: "base123", ref: "main", repo: { full_name: "JSONbored/gittensory", owner: { login: "JSONbored" } } },
      draft: false,
      merged: false,
      mergeable_state: "clean",
      created_at: "2026-05-27T00:00:00Z",
      updated_at: "2026-05-27T00:00:00Z",
    },
  };
}

describe("review-evasion protection (#review-evasion-protection)", () => {
  beforeEach(() => clearInstallationTokenCacheForTest());
  afterEach(() => {
    clearInstallationTokenCacheForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function setupEvasionRepo(env: ReturnType<typeof createTestEnv>, overrides: Record<string, unknown> = {}): Promise<void> {
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
      publicSurface: "off",
      commentMode: "off",
      checkRunMode: "off",
      autonomy: { close: "auto" },
      agentPaused: false,
      reviewEvasionProtection: "close",
      ...overrides,
    });
  }

  // Generic GitHub fetch stub covering every endpoint the evasion handlers (and the surrounding webhook
  // pipeline they run inside) can call. `collaboratorPermission` controls what a non-owner/non-admin closer's
  // permission check reports (default "read" — an ordinary contributor).
  function stubEvasionFetch(calls: Array<{ url: string; method: string }>, opts: { collaboratorPermission?: string; onPatch?: (url: string) => Response | null } = {}) {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/collaborators/")) return Response.json({ permission: opts.collaboratorPermission ?? "read" });
      if (method === "PATCH" && url.endsWith("/pulls/42")) {
        const custom = opts.onPatch?.(url);
        if (custom) return custom;
        return Response.json({ state: url === "open" ? "open" : "closed" });
      }
      if (method === "POST" && url.endsWith("/issues/42/comments")) return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/check-runs")) return Response.json({ id: 900 }, { status: 201 });
      if (url.includes("/labels")) return Response.json([{ name: "review-evasion" }]);
      if (url.includes("/pulls/42/files")) return Response.json([]);
      // A .loopover.yml content fetch (raw.githubusercontent.com) must resolve to SOMETHING with no opinion
      // on reviewEvasionProtection -- otherwise a miss here falls through to the bundled JSONbored/gittensory
      // fallback manifest (gittensory-repo-focus-manifest.ts), whose OWN checked-in reviewEvasionProtection:
      // close would silently outrank every test below's DB-level override (yml > DB precedence, #config-as-code).
      if (url.includes("raw.githubusercontent.com") && url.includes("loopover.y")) return new Response("source: repo_file\n", { status: 200 });
      return new Response("not found", { status: 404 });
    });
  }

  describe("self-close during an active review", () => {
    it("reopens then re-closes as the App, posts the explanation comment, applies the label, and records a review_evasion strike", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", authorLogin: "contributor", deliveryId: "review-start-1" });
      await repositoriesModule.upsertGlobalModerationConfig(env, { enabled: true, rules: ["review_evasion"] });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-1", eventName: "pull_request", payload: closedPayload("contributor") });

      const patches = calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"));
      expect(patches.length).toBeGreaterThanOrEqual(2); // reopen (state=open) then re-close (state=closed)
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(true);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("completed");
      expect(audit?.detail).toContain("contributor");
      expect(await repositoriesModule.hasActiveReviewForHeadSha(env, "JSONbored/gittensory", 42, "abc123")).toBe(false); // terminalized
      const strike = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("moderation.violation.review_evasion").first<{ outcome: string }>();
      expect(strike?.outcome).toBe("completed");
    });

    it("reopens and re-closes when the live self-closed PR is already closed on the reviewed head", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", authorLogin: "contributor", deliveryId: "review-start-1" });
      await repositoriesModule.upsertGlobalModerationConfig(env, { enabled: true, rules: ["review_evasion"] });
      vi.mocked(fetchPullRequestFreshness).mockResolvedValueOnce({
        status: "stale",
        reason: "closed",
        expectedHeadSha: "abc123",
        liveHeadSha: "ABC123",
        liveState: "closed",
      });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-live-closed", eventName: "pull_request", payload: closedPayload("contributor") });

      const patches = calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"));
      expect(patches.length).toBeGreaterThanOrEqual(2); // same-head closed is the normal self-close state: reopen then re-close
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("completed");
      expect(await repositoriesModule.hasActiveReviewForHeadSha(env, "JSONbored/gittensory", 42, "abc123")).toBe(false);
      const strike = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("moderation.violation.review_evasion").first<{ outcome: string }>();
      expect(strike?.outcome).toBe("completed");
    });

    it("retries (via a thrown lock-contended error) when a concurrent delivery already holds the per-PR actuation lock", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      await env.SELFHOST_TRANSIENT_CACHE?.set("pr-actuation-lock:jsonbored/gittensory#42", "1", 60);

      await expect(
        processJob(env, { type: "github-webhook", deliveryId: "self-close-lock-contended", eventName: "pull_request", payload: closedPayload("contributor") }),
      ).rejects.toThrow("during review-evasion-self-close");

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ n: number }>();
      expect(audit?.n).toBe(0); // no decision recorded either way -- the queue retry owns the deferred decision
    });

    it("does nothing when reviewEvasionProtection is explicitly off (#4011: the only respected opt-out)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env, { reviewEvasionProtection: "off" });
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-off", eventName: "pull_request", payload: closedPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ n: number }>();
      expect(audit?.n).toBe(0);
    });

    it("does nothing when NO active review is tracked for this head (an ordinary close, nothing to evade)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      // No startActiveReviewTracking call at all.

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-no-active-review", eventName: "pull_request", payload: closedPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("does nothing when a THIRD PARTY closed someone else's PR (not the author) — an ordinary maintainer close, not self-close evasion", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls, { collaboratorPermission: "write" });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-third-party", eventName: "pull_request", payload: closedPayload("a-maintainer", "contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("does nothing when the closer is the repo owner", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-owner", eventName: "pull_request", payload: closedPayload("JSONbored") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("does nothing when the closer is an ADMIN_GITHUB_LOGINS fleet-operator", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory", ADMIN_GITHUB_LOGINS: "admin-user" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-admin", eventName: "pull_request", payload: closedPayload("admin-user") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("does nothing when the closer holds write/maintain/admin collaborator permission", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls, { collaboratorPermission: "write" });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-maintainer", eventName: "pull_request", payload: closedPayload("write-collaborator") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("does nothing for a protected automation author (e.g. dependabot[bot])", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-bot", eventName: "pull_request", payload: closedPayload("dependabot[bot]") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("dry-run: audits the would-be enforcement without mutating GitHub or recording a live strike", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env, { agentDryRun: true });
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      await repositoriesModule.upsertGlobalModerationConfig(env, { enabled: true, rules: ["review_evasion"] });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-dry-run", eventName: "pull_request", payload: closedPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("completed");
      expect(audit?.detail).toContain("dry-run");
      const strike = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("moderation.violation.review_evasion").first<{ n: number }>();
      expect(strike?.n).toBe(0);
    });

    it("denies enforcement when the agent is globally frozen", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      await repositoriesModule.setGlobalAgentFrozen(env, true, "test");

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-frozen", eventName: "pull_request", payload: closedPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
      expect(audit?.detail).toContain("paused");
    });

    it("denies enforcement when close autonomy is not acting (observe)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env, { autonomy: { close: "observe" } });
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-observe", eventName: "pull_request", payload: closedPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
      expect(audit?.detail).toContain("autonomy for close is not acting");
    });

    it("REGRESSION: denies live self-close enforcement when close autonomy requires approval", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env, { autonomy: { close: "auto_with_approval" } });
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-approval-required", eventName: "pull_request", payload: closedPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
      expect(audit?.detail).toContain("requires approval");
    });

    it("denies enforcement when pull_requests: write is not granted", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertInstallation(env, {
        installation: {
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: { metadata: "read", issues: "write" },
          events: ["pull_request"],
        },
        repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
      });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", publicSurface: "off", commentMode: "off", checkRunMode: "off", autonomy: { close: "auto" }, agentPaused: false, reviewEvasionProtection: "close" });
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-no-write", eventName: "pull_request", payload: closedPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
      expect(audit?.detail).toContain("pull_requests: write not granted");
    });

    it("denies enforcement when the closed live PR is not on the reviewed head", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      vi.mocked(fetchPullRequestFreshness).mockResolvedValueOnce({ status: "stale", reason: "closed", expectedHeadSha: "abc123", liveHeadSha: "def456", liveState: "closed" });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-stale", eventName: "pull_request", payload: closedPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
      expect(audit?.detail).toContain("review-evasion enforcement not executed");
    });

    it("audits an error and does NOT record a strike when the reopen API call fails", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.includes("/access_tokens")) return Response.json({ token: "t" });
        if (url.includes("/collaborators/")) return Response.json({ permission: "read" });
        if (method === "PATCH" && url.endsWith("/pulls/42")) return new Response("server error", { status: 500 });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      await repositoriesModule.upsertGlobalModerationConfig(env, { enabled: true, rules: ["review_evasion"] });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-reopen-fail", eventName: "pull_request", payload: closedPayload("contributor") });

      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("error");
      expect(audit?.detail).toContain("FAILED to reopen");
      const strike = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("moderation.violation.review_evasion").first<{ n: number }>();
      expect(strike?.n).toBe(0);
      // The PR is closed either way (our reopen attempt failing doesn't reopen it) -- the general
      // "closed"-action cleanup still terminalizes the tracking row, independent of enforcement success.
      expect(await repositoriesModule.hasActiveReviewForHeadSha(env, "JSONbored/gittensory", 42, "abc123")).toBe(false);
    });

    it("REGRESSION (gate-flagged): throws (never silently leaves the PR open) when reopen succeeds but the re-close API call fails, so the queue retries the job", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      let patchCount = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.includes("/access_tokens")) return Response.json({ token: "t" });
        if (url.includes("/collaborators/")) return Response.json({ permission: "read" });
        if (method === "PATCH" && url.endsWith("/pulls/42")) {
          patchCount += 1;
          if (patchCount === 1) return Response.json({ state: "open" }); // reopen succeeds
          return new Response("server error", { status: 500 }); // re-close fails
        }
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      await repositoriesModule.upsertGlobalModerationConfig(env, { enabled: true, rules: ["review_evasion"] });

      // Deliberately UNCAUGHT: leaving the reopened PR open and returning normally would be worse than the
      // contributor's original close, so this must propagate for the queue's own retry mechanism instead of
      // resolving quietly.
      await expect(
        processJob(env, { type: "github-webhook", deliveryId: "self-close-close-fail", eventName: "pull_request", payload: closedPayload("contributor") }),
      ).rejects.toThrow();

      expect(patchCount).toBe(2);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("error");
      expect(audit?.detail).toContain("FAILED to re-close");
      const strike = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("moderation.violation.review_evasion").first<{ n: number }>();
      expect(strike?.n).toBe(0);
      // Still active -- enforcement never completed, so the active-review row must not have been cleared
      // (the active-review-tracking cleanup below only fires on the "closed" webhook action's OWN pass, and
      // this throw aborts that pass before it reaches the general terminalize hook).
      expect(await repositoriesModule.hasActiveReviewForHeadSha(env, "JSONbored/gittensory", 42, "abc123")).toBe(true);
    });

    it("REGRESSION (gate-flagged): a retry after the re-close failure converges -- the PR ends up closed, and the strike is recorded exactly once", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      let closeAttempts = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.includes("/access_tokens")) return Response.json({ token: "t" });
        if (url.includes("/collaborators/")) return Response.json({ permission: "read" });
        if (method === "PATCH" && url.endsWith("/pulls/42")) {
          const body = init?.body ? JSON.parse(String(init.body)) : {};
          if (body.state === "open") return Response.json({ state: "open" }); // reopen always succeeds
          closeAttempts += 1;
          if (closeAttempts === 1) return new Response("server error", { status: 500 }); // FIRST close attempt fails
          return Response.json({ state: "closed" }); // retry's close attempt succeeds
        }
        if (method === "POST" && url.endsWith("/issues/42/comments")) return Response.json({ id: 1 }, { status: 201 });
        if (url.includes("/labels")) return Response.json([{ name: "review-evasion" }]);
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", authorLogin: "contributor", deliveryId: "review-start-1" });
      await repositoriesModule.upsertGlobalModerationConfig(env, { enabled: true, rules: ["review_evasion"] });

      const payload = closedPayload("contributor");
      await expect(processJob(env, { type: "github-webhook", deliveryId: "self-close-close-fail-retry", eventName: "pull_request", payload })).rejects.toThrow();
      // The queue's own retry mechanism re-delivers the SAME job after the first attempt threw.
      await processJob(env, { type: "github-webhook", deliveryId: "self-close-close-fail-retry", eventName: "pull_request", payload });

      expect(closeAttempts).toBe(2);
      const audit = await env.DB.prepare("select outcome from audit_events where event_type = ? order by created_at desc limit 1").bind("github_app.review_evasion_closed").first<{ outcome: string }>();
      expect(audit?.outcome).toBe("completed");
      const strikeCount = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("moderation.violation.review_evasion").first<{ n: number }>();
      expect(strikeCount?.n).toBe(1); // exactly one strike, not one per attempt
      expect(await repositoriesModule.hasActiveReviewForHeadSha(env, "JSONbored/gittensory", 42, "abc123")).toBe(false);
    });

    it("global moderation disabled: the evasion close/label/comment still happen, but no moderation strike/label is recorded", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      // Global moderation config left at its default (disabled).

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-mod-off", eventName: "pull_request", payload: closedPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(true);
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(true);
      const audit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string }>();
      expect(audit?.outcome).toBe("completed");
      const strike = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("moderation.violation.review_evasion").first<{ n: number }>();
      expect(strike?.n).toBe(0);
    });

    it("REGRESSION: no duplicate strike or duplicate enforcement on a webhook redelivery/retry after the first enforcement already succeeded", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      await repositoriesModule.upsertGlobalModerationConfig(env, { enabled: true, rules: ["review_evasion"] });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-redelivery-1", eventName: "pull_request", payload: closedPayload("contributor") });
      const firstPatchCount = calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42")).length;
      expect(firstPatchCount).toBeGreaterThanOrEqual(2);

      // A SECOND, genuinely distinct delivery for the same underlying event (e.g. a queue retry after the first
      // job's ack was lost) — the active-review row is already terminalized, so this must be a pure no-op.
      await processJob(env, { type: "github-webhook", deliveryId: "self-close-redelivery-2", eventName: "pull_request", payload: closedPayload("contributor") });
      const secondPatchCount = calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42")).length - firstPatchCount;
      expect(secondPatchCount).toBe(0);

      const strikeCount = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("moderation.violation.review_evasion").first<{ n: number }>();
      expect(strikeCount?.n).toBe(1);
    });

    it("a subsequent contributor reopen after the App's evasion close is re-closed by the EXISTING one-shot reopen guard", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-then-reopen-1", eventName: "pull_request", payload: closedPayload("contributor") });
      expect((await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string }>())?.outcome).toBe("completed");

      // getLastCloserLogin reads the issue-events timeline -- the App's own close (via the enforcement handler,
      // NOT via the reopen-reclose guard) must be visible there for the existing guard to recognize it.
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.includes("/access_tokens")) return Response.json({ token: "t" });
        if (url.includes("/collaborators/contributor/permission")) return Response.json({ permission: "read" });
        if (url.includes("/issues/42/events")) return Response.json([{ event: "closed", actor: { login: "gittensory[bot]" } }, { event: "reopened", actor: { login: "contributor" } }]);
        if (method === "POST" && url.endsWith("/issues/42/comments")) return Response.json({ id: 2 }, { status: 201 });
        if (method === "PATCH" && url.endsWith("/pulls/42")) return Response.json({ state: "closed" });
        return new Response("not found", { status: 404 });
      });
      await processJob(env, { type: "github-webhook", deliveryId: "contributor-reopens-after-evasion-close", eventName: "pull_request", payload: reopenedPayload("contributor") });

      const reopenAudit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.reopen_reclosed").first<{ outcome: string; detail: string }>();
      expect(reopenAudit?.outcome).toBe("completed");
      expect(reopenAudit?.detail).toContain("one-shot");
    });

    it("STILL protects when reviewEvasionProtection is unset (undefined, not an explicit 'off') (#4011: default-ON)", async () => {
      // upsertRepositorySettings coalesces undefined -> "close" at write time (mirrors reviewEvasionLabel/
      // reviewEvasionComment's own write-time defaulting below), and the consuming handler's own fallback
      // (settings.reviewEvasionProtection === "off") treats anything but an explicit "off" as protected too --
      // so the only way to get `undefined` past BOTH layers and into the handler is to mock the resolved-
      // settings layer directly, confirming neither layer silently reintroduces the old off-by-default gap.
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      const baseSettings = await repositorySettingsModule.resolveRepositorySettings(env, "JSONbored/gittensory");
      vi.spyOn(repositorySettingsModule, "resolveRepositorySettings").mockResolvedValue({ ...baseSettings, reviewEvasionProtection: undefined });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-protection-unset", eventName: "pull_request", payload: closedPayload("contributor") });

      const patches = calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"));
      expect(patches.length).toBeGreaterThanOrEqual(2); // reopen then re-close, same as an explicit "close"
    });

    it("does nothing when the webhook payload has no sender", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      const payload = closedPayload("contributor");
      payload.sender = undefined;

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-no-sender", eventName: "pull_request", payload });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("does nothing when the PR record has no author (a deleted-account PR)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      const payload = closedPayload("contributor");
      payload.pull_request.user = null;

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-no-author", eventName: "pull_request", payload });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("does nothing when the PR record has no headSha", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      const payload = closedPayload("contributor");
      payload.pull_request.head = null;

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-no-head-sha", eventName: "pull_request", payload });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("denies enforcement when the installation record is missing (uninstalled mid-flight)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      vi.spyOn(repositoriesModule, "getInstallation").mockResolvedValue(null);

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-no-installation", eventName: "pull_request", payload: closedPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
      expect(audit?.detail).toContain("pull_requests: write not granted");
    });

    it("skips the courtesy comment when reviewEvasionComment is unset (defaults to true, but false is honored too)", async () => {
      // Same write-time-coalescing note as the reviewEvasionProtection test above.
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      const baseSettings = await repositorySettingsModule.resolveRepositorySettings(env, "JSONbored/gittensory");
      vi.spyOn(repositorySettingsModule, "resolveRepositorySettings").mockResolvedValue({ ...baseSettings, reviewEvasionComment: undefined });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-comment-unset", eventName: "pull_request", payload: closedPayload("contributor") });

      // reviewEvasionComment unset falls back to `true` -- the courtesy comment still posts.
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(true);
    });

    it("applies no label when reviewEvasionLabel is explicitly null (a .gittensory.yml-only 'no label' override)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      const labelPostBodies: string[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.includes("/access_tokens")) return Response.json({ token: "t" });
        if (url.includes("/collaborators/")) return Response.json({ permission: "read" });
        if (method === "PATCH" && url.endsWith("/pulls/42")) return Response.json({ state: "closed" });
        if (method === "POST" && url.endsWith("/issues/42/comments")) return Response.json({ id: 1 }, { status: 201 });
        if (method === "POST" && url.endsWith("/issues/42/labels")) {
          labelPostBodies.push(String(init?.body ?? ""));
          return Response.json([], { status: 200 });
        }
        if (url.includes("/labels")) return Response.json([]); // dedup probe: no labels on the issue yet
        if (url.includes("/pulls/42/files")) return Response.json([]);
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      // reviewEvasionLabel is a NOT NULL DB column (upsertRepositorySettings coalesces null -> the default at
      // write time, per the migration's own "never persisted" comment) -- null only ever reaches this handler
      // via the .gittensory.yml config-as-code layer, so the resolved-settings layer is mocked directly here.
      const baseSettings = await repositorySettingsModule.resolveRepositorySettings(env, "JSONbored/gittensory");
      vi.spyOn(repositorySettingsModule, "resolveRepositorySettings").mockResolvedValue({ ...baseSettings, reviewEvasionLabel: null });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-label-null", eventName: "pull_request", payload: closedPayload("contributor") });

      // Some OTHER unrelated feature (title-based type-labeling) may still post its own labels on a close --
      // what matters here is that the review-evasion label specifically was never requested.
      expect(labelPostBodies.some((b) => b.includes("review-evasion"))).toBe(false);
      const audit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string }>();
      expect(audit?.outcome).toBe("completed");
    });

    it("falls back to the default label when reviewEvasionLabel is unset", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      const labelPostBodies: string[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.includes("/access_tokens")) return Response.json({ token: "t" });
        if (url.includes("/collaborators/")) return Response.json({ permission: "read" });
        if (method === "PATCH" && url.endsWith("/pulls/42")) return Response.json({ state: "closed" });
        if (method === "POST" && url.endsWith("/issues/42/comments")) return Response.json({ id: 1 }, { status: 201 });
        if (method === "POST" && url.endsWith("/issues/42/labels")) {
          labelPostBodies.push(String(init?.body ?? ""));
          return Response.json([], { status: 200 });
        }
        if (url.includes("/labels")) return Response.json([]); // dedup probe: no labels on the issue yet
        if (url.includes("/pulls/42/files")) return Response.json([]);
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      const baseSettings = await repositorySettingsModule.resolveRepositorySettings(env, "JSONbored/gittensory");
      vi.spyOn(repositorySettingsModule, "resolveRepositorySettings").mockResolvedValue({ ...baseSettings, reviewEvasionLabel: undefined });

      await processJob(env, { type: "github-webhook", deliveryId: "self-close-label-unset", eventName: "pull_request", payload: closedPayload("contributor") });

      expect(labelPostBodies.some((b) => b.includes("review-evasion"))).toBe(true);
    });
  });

  describe("converted_to_draft during an active review", () => {
    it("closes as the App (no reopen needed), posts the explanation comment, applies the label, and records a review_evasion strike", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", authorLogin: "contributor", deliveryId: "review-start-1" });
      await repositoriesModule.upsertGlobalModerationConfig(env, { enabled: true, rules: ["review_evasion"] });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      const patches = calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"));
      expect(patches).toHaveLength(1); // no reopen needed -- a single close.
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(true);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("completed");
      expect(audit?.detail).toContain("draft-conversion");
      const strike = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("moderation.violation.review_evasion").first<{ outcome: string }>();
      expect(strike?.outcome).toBe("completed");
    });

    it("retries (via a thrown lock-contended error) when a concurrent delivery already holds the per-PR actuation lock", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      // Deliberately autonomy: {} (not {close: "auto"}) -- this repo's OUTER dispatch condition for the
      // SIBLING draft-dodge guard requires isAgentConfigured(settings.autonomy), so with no acting autonomy
      // class at all, draft-dodge's OWN lock-claim attempt is skipped entirely and this test genuinely
      // exercises THIS handler's own lock claim/throw, not draft-dodge's (both guards fire on
      // converted_to_draft and would otherwise race for the identical lock key).
      await setupEvasionRepo(env, { autonomy: {} });
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      await env.SELFHOST_TRANSIENT_CACHE?.set("pr-actuation-lock:jsonbored/gittensory#42", "1", 60);

      await expect(
        processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-lock-contended", eventName: "pull_request", payload: draftEvasionPayload("contributor") }),
      ).rejects.toThrow("during review-evasion-draft");

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ n: number }>();
      expect(audit?.n).toBe(0);
    });

    it("does nothing for a draft conversion BEFORE any active review has started", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      // No startActiveReviewTracking call -- no review has ever run for this PR.

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-no-active-review", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("does NOT require a prior gate failure (unlike the draft-dodge guard) -- an active review alone is enough", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      // Deliberately NO recordGateBlockOutcome call -- the draft-dodge guard's own trigger condition is absent.
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-no-gate-failure", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(true);
      const draftDodgeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.draft_dodge_closed").first<{ n: number }>();
      expect(draftDodgeAudit?.n).toBe(0); // the SIBLING guard never fired -- this is genuinely the new path.
      const evasionAudit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string }>();
      expect(evasionAudit?.outcome).toBe("completed");
    });

    it("does nothing when the author holds write collaborator permission", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls, { collaboratorPermission: "write" });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-maintainer", eventName: "pull_request", payload: draftEvasionPayload("write-collaborator") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("REGRESSION (gate-flagged): does nothing when a THIRD PARTY converts someone else's PR to draft (not the author) -- an ordinary maintainer action, not self-evasion, must never be enforced against the author who didn't do it", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls, { collaboratorPermission: "write" });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      const payload = draftEvasionPayload("contributor");
      payload.sender = { login: "a-maintainer", type: "User" }; // the CONVERTER, distinct from pull_request.user (the author)

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-third-party", eventName: "pull_request", payload });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ n: number }>();
      expect(audit?.n).toBe(0);
    });

    it("dry-run: audits the would-be enforcement without mutating GitHub or recording a live strike", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env, { agentDryRun: true });
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      await repositoriesModule.upsertGlobalModerationConfig(env, { enabled: true, rules: ["review_evasion"] });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-dry-run", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("completed");
      expect(audit?.detail).toContain("dry-run");
      const strike = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("moderation.violation.review_evasion").first<{ n: number }>();
      expect(strike?.n).toBe(0);
    });

    it("denies enforcement when the agent is globally frozen", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      await repositoriesModule.setGlobalAgentFrozen(env, true, "test");

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-frozen", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
      expect(audit?.detail).toContain("paused");
    });

    it("denies enforcement when close autonomy is not acting (observe)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env, { autonomy: { close: "observe" } });
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-observe", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
      expect(audit?.detail).toContain("autonomy for close is not acting");
    });

    it("REGRESSION: denies live draft-conversion enforcement when close autonomy requires approval", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env, { autonomy: { close: "auto_with_approval" } });
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-approval-required", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
      expect(audit?.detail).toContain("requires approval");
    });

    it("denies enforcement when pull_requests: write is not granted", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertInstallation(env, {
        installation: {
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: { metadata: "read", issues: "write" },
          events: ["pull_request"],
        },
        repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
      });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", publicSurface: "off", commentMode: "off", checkRunMode: "off", autonomy: { close: "auto" }, agentPaused: false, reviewEvasionProtection: "close" });
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-no-write", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
      expect(audit?.detail).toContain("pull_requests: write not granted");
    });

    it("denies enforcement when the PR was converted back to ready_for_review before the close fires (requireDraft freshness)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      vi.mocked(fetchPullRequestFreshness).mockResolvedValueOnce({ status: "stale", reason: "no_longer_draft", expectedHeadSha: "abc123", liveHeadSha: "abc123", liveState: "open" });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-no-longer-draft", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      expect(fetchPullRequestFreshness).toHaveBeenCalledWith(env, expect.objectContaining({ requireDraft: true }));
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
    });

    it("audits an error and does NOT record a strike when the close API call fails", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.includes("/access_tokens")) return Response.json({ token: "t" });
        if (url.includes("/collaborators/")) return Response.json({ permission: "read" });
        if (method === "PATCH" && url.endsWith("/pulls/42")) return new Response("server error", { status: 500 });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      await repositoriesModule.upsertGlobalModerationConfig(env, { enabled: true, rules: ["review_evasion"] });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-close-fail", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("error");
      const strike = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("moderation.violation.review_evasion").first<{ n: number }>();
      expect(strike?.n).toBe(0);
    });

    it("global moderation disabled: the evasion close/label/comment still happen, but no moderation strike is recorded", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-mod-off", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(true);
      const audit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string }>();
      expect(audit?.outcome).toBe("completed");
      const strike = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("moderation.violation.review_evasion").first<{ n: number }>();
      expect(strike?.n).toBe(0);
    });

    it("STILL protects when reviewEvasionProtection is unset (undefined, not an explicit 'off') (#4011: default-ON)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      const baseSettings = await repositorySettingsModule.resolveRepositorySettings(env, "JSONbored/gittensory");
      vi.spyOn(repositorySettingsModule, "resolveRepositorySettings").mockResolvedValue({ ...baseSettings, reviewEvasionProtection: undefined });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-protection-unset", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(true);
    });

    it("does nothing when the webhook payload has no sender", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      const payload = draftEvasionPayload("contributor");
      payload.sender = undefined;

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-no-sender", eventName: "pull_request", payload });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("does nothing when the PR record has no author (a deleted-account PR)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      const payload = draftEvasionPayload("contributor");
      payload.pull_request.user = null;

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-no-author", eventName: "pull_request", payload });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("does nothing for a protected automation author (e.g. dependabot[bot])", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-bot", eventName: "pull_request", payload: draftEvasionPayload("dependabot[bot]") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("does nothing when the PR record has no headSha", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });

      const payload = draftEvasionPayload("contributor");
      payload.pull_request.head = null;

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-no-head-sha", eventName: "pull_request", payload });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("denies enforcement when the installation record is missing (uninstalled mid-flight)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      vi.spyOn(repositoriesModule, "getInstallation").mockResolvedValue(null);

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-no-installation", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
      expect(audit?.detail).toContain("pull_requests: write not granted");
    });

    it("skips the courtesy comment when reviewEvasionComment is unset (defaults to true, but false is honored too)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      const baseSettings = await repositorySettingsModule.resolveRepositorySettings(env, "JSONbored/gittensory");
      vi.spyOn(repositorySettingsModule, "resolveRepositorySettings").mockResolvedValue({ ...baseSettings, reviewEvasionComment: undefined });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-comment-unset", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(true);
    });

    it("applies no label when reviewEvasionLabel is explicitly null (a .gittensory.yml-only 'no label' override)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      const labelPostBodies: string[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.includes("/access_tokens")) return Response.json({ token: "t" });
        if (url.includes("/collaborators/")) return Response.json({ permission: "read" });
        if (method === "PATCH" && url.endsWith("/pulls/42")) return Response.json({ state: "closed" });
        if (method === "POST" && url.endsWith("/issues/42/comments")) return Response.json({ id: 1 }, { status: 201 });
        if (method === "POST" && url.endsWith("/issues/42/labels")) {
          labelPostBodies.push(String(init?.body ?? ""));
          return Response.json([], { status: 200 });
        }
        if (url.includes("/labels")) return Response.json([]); // dedup probe: no labels on the issue yet
        if (url.includes("/pulls/42/files")) return Response.json([]);
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      const baseSettings = await repositorySettingsModule.resolveRepositorySettings(env, "JSONbored/gittensory");
      vi.spyOn(repositorySettingsModule, "resolveRepositorySettings").mockResolvedValue({ ...baseSettings, reviewEvasionLabel: null });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-label-null", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(labelPostBodies.some((b) => b.includes("review-evasion"))).toBe(false);
      const audit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.review_evasion_closed").first<{ outcome: string }>();
      expect(audit?.outcome).toBe("completed");
    });

    it("falls back to the default label when reviewEvasionLabel is unset", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      const labelPostBodies: string[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.includes("/access_tokens")) return Response.json({ token: "t" });
        if (url.includes("/collaborators/")) return Response.json({ permission: "read" });
        if (method === "PATCH" && url.endsWith("/pulls/42")) return Response.json({ state: "closed" });
        if (method === "POST" && url.endsWith("/issues/42/comments")) return Response.json({ id: 1 }, { status: 201 });
        if (method === "POST" && url.endsWith("/issues/42/labels")) {
          labelPostBodies.push(String(init?.body ?? ""));
          return Response.json([], { status: 200 });
        }
        if (url.includes("/labels")) return Response.json([]); // dedup probe: no labels on the issue yet
        if (url.includes("/pulls/42/files")) return Response.json([]);
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.startActiveReviewTracking(env, { repoFullName: "JSONbored/gittensory", pullNumber: 42, headSha: "abc123", deliveryId: "review-start-1" });
      const baseSettings = await repositorySettingsModule.resolveRepositorySettings(env, "JSONbored/gittensory");
      vi.spyOn(repositorySettingsModule, "resolveRepositorySettings").mockResolvedValue({ ...baseSettings, reviewEvasionLabel: undefined });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-evasion-label-unset", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(labelPostBodies.some((b) => b.includes("review-evasion"))).toBe(true);
    });
  });

  describe("repeated ready<->draft cycling (#gaming-tactic-draft-cycle)", () => {
    it("does nothing on the FIRST draft conversion, then closes on the SECOND -- independent of active-review/gate-block state", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.upsertGlobalModerationConfig(env, { enabled: true, rules: ["review_evasion"] });
      // Deliberately NO startActiveReviewTracking / recordGateBlockOutcome call -- neither sibling guard's own
      // trigger condition is present, so any close observed below can only be this new, count-based guard.

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      const patches = calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"));
      expect(patches).toHaveLength(1);
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(true);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? order by rowid desc limit 1")
        .bind("github_app.review_evasion_closed")
        .first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("completed");
      expect(audit?.detail).toContain("repeated draft-cycling");
      expect(audit?.detail).toContain("#2");
      const strike = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("moderation.violation.review_evasion").first<{ outcome: string }>();
      expect(strike?.outcome).toBe("completed");
    });

    it("does nothing when reviewEvasionProtection is off, even after a repeated cycle", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env, { reviewEvasionProtection: "off" });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-off-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-off-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("STILL enforces the repeated-cycle close when reviewEvasionProtection is unset (undefined, not an explicit 'off') (#4011: default-ON)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      const baseSettings = await repositorySettingsModule.resolveRepositorySettings(env, "JSONbored/gittensory");
      vi.spyOn(repositorySettingsModule, "resolveRepositorySettings").mockResolvedValue({ ...baseSettings, reviewEvasionProtection: undefined });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-unset-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false); // first conversion never closes

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-unset-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      const patches = calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"));
      expect(patches).toHaveLength(1); // second conversion closes, same as an explicit "close"
    });

    it("REGRESSION (gate-flagged): does not enforce against a THIRD PARTY repeatedly converting someone else's PR to draft", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls, { collaboratorPermission: "write" });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      const payload = draftEvasionPayload("contributor");
      payload.sender = { login: "a-maintainer", type: "User" };

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-third-party-1", eventName: "pull_request", payload });
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-third-party-2", eventName: "pull_request", payload });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("REGRESSION (gate-flagged, gittensory-orb review): a maintainer's draft conversion must NOT count toward the author's own cycle -- the author's first-ever conversion is never enforced even after a prior third-party one", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls, { collaboratorPermission: "write" });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      const maintainerConversion = draftEvasionPayload("contributor");
      maintainerConversion.sender = { login: "a-maintainer", type: "User" };

      // A maintainer converts the contributor's PR to draft first.
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-mixed-1", eventName: "pull_request", payload: maintainerConversion });
      // Without the fix, this maintainer action would have already bumped the shared counter to 1.
      const afterMaintainer = await env.DB.prepare("select draft_conversion_count as n from pull_requests where repo_full_name = ? and number = 42")
        .bind("JSONbored/gittensory")
        .first<{ n: number }>();
      expect(afterMaintainer?.n).toBe(0); // the maintainer's own conversion never counted at all.

      // The AUTHOR now converts their OWN PR to draft for the very first time -- ordinary WIP behavior.
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-mixed-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const afterAuthor = await env.DB.prepare("select draft_conversion_count as n from pull_requests where repo_full_name = ? and number = 42")
        .bind("JSONbored/gittensory")
        .first<{ n: number }>();
      expect(afterAuthor?.n).toBe(1); // the author's first conversion is counted as their first, not their second.
    });

    it("does nothing for a protected automation author (e.g. dependabot[bot]), even after a repeated cycle", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-bot-1", eventName: "pull_request", payload: draftEvasionPayload("dependabot[bot]") });
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-bot-2", eventName: "pull_request", payload: draftEvasionPayload("dependabot[bot]") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("does nothing when the PR record has no headSha, even after a repeated cycle", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      const payload = draftEvasionPayload("contributor");
      payload.pull_request.head = null;

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-no-head-1", eventName: "pull_request", payload });
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-no-head-2", eventName: "pull_request", payload });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("does nothing when the author holds write collaborator permission, even after a repeated cycle", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls, { collaboratorPermission: "write" });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-maintainer-1", eventName: "pull_request", payload: draftEvasionPayload("write-collaborator") });
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-maintainer-2", eventName: "pull_request", payload: draftEvasionPayload("write-collaborator") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("denies enforcement when close autonomy is not acting (observe)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env, { autonomy: { close: "observe" } });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-observe-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-observe-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? order by rowid desc limit 1")
        .bind("github_app.review_evasion_closed")
        .first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
      expect(audit?.detail).toContain("autonomy for close is not acting");
    });

    it("REGRESSION: denies live repeated draft-cycling enforcement when close autonomy requires approval", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env, { autonomy: { close: "auto_with_approval" } });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-approval-required-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-approval-required-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? order by rowid desc limit 1")
        .bind("github_app.review_evasion_closed")
        .first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
      expect(audit?.detail).toContain("requires approval");
    });

    it("dry-run: audits the would-be enforcement without mutating GitHub or recording a live strike", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env, { agentDryRun: true });
      await repositoriesModule.upsertGlobalModerationConfig(env, { enabled: true, rules: ["review_evasion"] });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-dry-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-dry-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? order by rowid desc limit 1")
        .bind("github_app.review_evasion_closed")
        .first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("completed");
      expect(audit?.detail).toContain("dry-run");
      const strike = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("moderation.violation.review_evasion").first<{ n: number }>();
      expect(strike?.n).toBe(0);
    });

    it("denies enforcement when the agent is paused for this repo", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env, { agentPaused: true });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-paused-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-paused-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? order by rowid desc limit 1")
        .bind("github_app.review_evasion_closed")
        .first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
      expect(audit?.detail).toContain("paused");
    });

    it("denies enforcement when pull_requests: write is not granted", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertInstallation(env, {
        installation: {
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          repository_selection: "selected",
          permissions: { metadata: "read", issues: "write" },
          events: ["pull_request"],
        },
        repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
      });
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", publicSurface: "off", commentMode: "off", checkRunMode: "off", autonomy: { close: "auto" }, agentPaused: false, reviewEvasionProtection: "close" });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-no-write-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-no-write-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? order by rowid desc limit 1")
        .bind("github_app.review_evasion_closed")
        .first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
      expect(audit?.detail).toContain("pull_requests: write not granted");
    });

    it("denies enforcement when the PR was converted back to ready_for_review before the close fires (requireDraft freshness)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-fresh-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      vi.mocked(fetchPullRequestFreshness).mockResolvedValueOnce({ status: "stale", reason: "no_longer_draft", expectedHeadSha: "abc123", liveHeadSha: "abc123", liveState: "open" });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-fresh-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      expect(fetchPullRequestFreshness).toHaveBeenCalledWith(env, expect.objectContaining({ requireDraft: true }));
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? order by rowid desc limit 1")
        .bind("github_app.review_evasion_closed")
        .first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
    });

    it("audits an error and does NOT record a strike when the close API call fails", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.includes("/access_tokens")) return Response.json({ token: "t" });
        if (url.includes("/collaborators/")) return Response.json({ permission: "read" });
        if (method === "PATCH" && url.endsWith("/pulls/42")) return new Response("server error", { status: 500 });
        if (url.includes("raw.githubusercontent.com") && url.includes("loopover.y")) return new Response("source: repo_file\n", { status: 200 });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await repositoriesModule.upsertGlobalModerationConfig(env, { enabled: true, rules: ["review_evasion"] });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-close-fail-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-close-fail-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? order by rowid desc limit 1")
        .bind("github_app.review_evasion_closed")
        .first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("error");
      const strike = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("moderation.violation.review_evasion").first<{ n: number }>();
      expect(strike?.n).toBe(0);
    });

    it("global moderation disabled: the close/label/comment still happen, but no moderation strike is recorded", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-mod-off-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-mod-off-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(true);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? order by rowid desc limit 1")
        .bind("github_app.review_evasion_closed")
        .first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("completed");
      const strike = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("moderation.violation.review_evasion").first<{ n: number }>();
      expect(strike?.n).toBe(0);
    });

    it("REGRESSION: the third (and every later) conversion is enforced too, not just exactly the second", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      let patchCount = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.includes("/access_tokens")) return Response.json({ token: "t" });
        if (url.includes("/collaborators/")) return Response.json({ permission: "read" });
        if (method === "PATCH" && url.endsWith("/pulls/42")) {
          patchCount += 1;
          return Response.json({ state: "open" }); // simulate the close failing to stick / a reopen between cycles
        }
        if (method === "POST" && url.endsWith("/issues/42/comments")) return Response.json({ id: 1 }, { status: 201 });
        if (url.includes("/labels")) return Response.json([{ name: "review-evasion" }]);
        if (url.includes("/pulls/42/files")) return Response.json([]);
        if (url.includes("raw.githubusercontent.com") && url.includes("loopover.y")) return new Response("source: repo_file\n", { status: 200 });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-third-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-third-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-third-3", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(patchCount).toBe(2); // enforced on the 2nd AND the 3rd -- >= 2, not === 2.
      const completed = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and outcome = 'completed'")
        .bind("github_app.review_evasion_closed")
        .first<{ n: number }>();
      expect(completed?.n).toBe(2);
    });

    it("REGRESSION: the first conversion returns before the repeated-cycle lock so a retry cannot double-count it", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      // Deliberately autonomy: {} -- draft-dodge's own outer dispatch condition (isAgentConfigured) is false, so
      // ITS lock claim never fires. The remaining sibling (review-evasion-active-review) has no settings gate at
      // its OWN lock claim, so it claims+releases the lock normally on every converted_to_draft delivery. THIS
      // guard now checks reviewEvasionProtection/count BEFORE claiming its own lock (#nit-lock-contention), so it
      // never attempts a claim at all until draftConversionCount reaches 2 -- the first delivery below produces
      // only the sibling's claim (mocked to succeed); the second produces the sibling's claim (succeeds) THEN
      // this guard's own first-ever claim attempt, which is the one mocked to fail here.
      await setupEvasionRepo(env, { autonomy: {} });
      const claimSpy = vi.spyOn(env.SELFHOST_TRANSIENT_CACHE!, "claim").mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-lock-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      expect(claimSpy).toHaveBeenCalledTimes(1); // count is only 1 -- this guard never attempted a claim yet.

      await expect(
        processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-lock-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") }),
      ).rejects.toThrow("during review-evasion-draft-cycle");

      expect(claimSpy).toHaveBeenCalledTimes(3);
      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("does nothing when the webhook payload has no sender, even after a repeated cycle", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      const payload = draftEvasionPayload("contributor");

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-no-sender-1", eventName: "pull_request", payload: { ...payload, sender: undefined } });
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-no-sender-2", eventName: "pull_request", payload: { ...payload, sender: undefined } });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("does nothing when the PR record has no author (a deleted-account PR), even after a repeated cycle", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      const payload = draftEvasionPayload("contributor");
      payload.pull_request.user = null;

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-no-author-1", eventName: "pull_request", payload });
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-no-author-2", eventName: "pull_request", payload });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
    });

    it("denies enforcement when the installation record is missing (uninstalled mid-flight)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-no-install-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      vi.spyOn(repositoriesModule, "getInstallation").mockResolvedValue(null);

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-no-install-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(false);
      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? order by rowid desc limit 1")
        .bind("github_app.review_evasion_closed")
        .first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("denied");
      expect(audit?.detail).toContain("pull_requests: write not granted");
    });

    it("skips the courtesy comment when reviewEvasionComment is explicitly false", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env, { reviewEvasionComment: false });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-comment-false-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-comment-false-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/42"))).toBe(true);
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(false);
    });

    it("posts the courtesy comment when reviewEvasionComment is unset (undefined, not just a stored default)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      stubEvasionFetch(calls);
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-comment-unset-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      const baseSettings = await repositorySettingsModule.resolveRepositorySettings(env, "JSONbored/gittensory");
      vi.spyOn(repositorySettingsModule, "resolveRepositorySettings").mockResolvedValue({ ...baseSettings, reviewEvasionComment: undefined });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-comment-unset-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments"))).toBe(true);
    });

    it("applies no label when reviewEvasionLabel is explicitly null (a .gittensory.yml-only 'no label' override)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      const labelPostBodies: string[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.includes("/access_tokens")) return Response.json({ token: "t" });
        if (url.includes("/collaborators/")) return Response.json({ permission: "read" });
        if (method === "PATCH" && url.endsWith("/pulls/42")) return Response.json({ state: "closed" });
        if (method === "POST" && url.endsWith("/issues/42/comments")) return Response.json({ id: 1 }, { status: 201 });
        if (method === "POST" && url.endsWith("/issues/42/labels")) {
          labelPostBodies.push(String(init?.body ?? ""));
          return Response.json([], { status: 200 });
        }
        if (url.includes("/labels")) return Response.json([]);
        if (url.includes("/pulls/42/files")) return Response.json([]);
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-label-null-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      const baseSettings = await repositorySettingsModule.resolveRepositorySettings(env, "JSONbored/gittensory");
      vi.spyOn(repositorySettingsModule, "resolveRepositorySettings").mockResolvedValue({ ...baseSettings, reviewEvasionLabel: null });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-label-null-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(labelPostBodies.some((b) => b.includes("review-evasion"))).toBe(false);
      const audit = await env.DB.prepare("select outcome from audit_events where event_type = ? order by rowid desc limit 1").bind("github_app.review_evasion_closed").first<{ outcome: string }>();
      expect(audit?.outcome).toBe("completed");
    });

    it("falls back to the default label when reviewEvasionLabel is unset (undefined, not just a stored default)", async () => {
      const calls: Array<{ url: string; method: string }> = [];
      const labelPostBodies: string[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.includes("/access_tokens")) return Response.json({ token: "t" });
        if (url.includes("/collaborators/")) return Response.json({ permission: "read" });
        if (method === "PATCH" && url.endsWith("/pulls/42")) return Response.json({ state: "closed" });
        if (method === "POST" && url.endsWith("/issues/42/comments")) return Response.json({ id: 1 }, { status: 201 });
        if (method === "POST" && url.endsWith("/issues/42/labels")) {
          labelPostBodies.push(String(init?.body ?? ""));
          return Response.json([], { status: 200 });
        }
        if (url.includes("/labels")) return Response.json([]);
        if (url.includes("/pulls/42/files")) return Response.json([]);
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
      await setupEvasionRepo(env);
      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-label-unset-1", eventName: "pull_request", payload: draftEvasionPayload("contributor") });
      const baseSettings = await repositorySettingsModule.resolveRepositorySettings(env, "JSONbored/gittensory");
      vi.spyOn(repositorySettingsModule, "resolveRepositorySettings").mockResolvedValue({ ...baseSettings, reviewEvasionLabel: undefined });

      await processJob(env, { type: "github-webhook", deliveryId: "draft-cycle-label-unset-2", eventName: "pull_request", payload: draftEvasionPayload("contributor") });

      expect(labelPostBodies.some((b) => b.includes("review-evasion"))).toBe(true);
    });
  });

  describe("bumpPullRequestDraftConversionCount", () => {
    it("increments across repeated calls for the same PR and is independent of head SHA", async () => {
      const env = createTestEnv({});
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await repositoriesModule.upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        id: 4242,
        number: 77,
        state: "open",
        title: "Some PR",
        user: { login: "contributor" },
        head: { sha: "sha-1", ref: "fix", repo: { full_name: "contributor/gittensory", owner: { login: "contributor" } } },
        base: { sha: "base123", ref: "main", repo: { full_name: "JSONbored/gittensory", owner: { login: "JSONbored" } } },
        draft: false,
        merged: false,
        created_at: "2026-05-27T00:00:00Z",
        updated_at: "2026-05-27T00:00:00Z",
      } as never);

      expect(await repositoriesModule.bumpPullRequestDraftConversionCount(env, "JSONbored/gittensory", 77)).toBe(1);
      expect(await repositoriesModule.bumpPullRequestDraftConversionCount(env, "JSONbored/gittensory", 77)).toBe(2);
      // A fresh push (new head SHA) between cycles must NOT reset the counter -- unlike mergeAttemptCount.
      await repositoriesModule.upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        id: 4242,
        number: 77,
        state: "open",
        title: "Some PR",
        user: { login: "contributor" },
        head: { sha: "sha-2", ref: "fix", repo: { full_name: "contributor/gittensory", owner: { login: "contributor" } } },
        base: { sha: "base123", ref: "main", repo: { full_name: "JSONbored/gittensory", owner: { login: "JSONbored" } } },
        draft: false,
        merged: false,
        created_at: "2026-05-27T00:00:00Z",
        updated_at: "2026-05-27T00:00:00Z",
      } as never);
      expect(await repositoriesModule.bumpPullRequestDraftConversionCount(env, "JSONbored/gittensory", 77)).toBe(3);
    });

    it("returns 0 for a PR that does not exist (no row to increment)", async () => {
      const env = createTestEnv({});
      expect(await repositoriesModule.bumpPullRequestDraftConversionCount(env, "JSONbored/gittensory", 999999)).toBe(0);
    });
  });
});

describe("markPullRequestLinkedIssueHardRuleViolated (#linked-issue-hard-rule-persistence)", () => {
  it("sets violatedAt + the reason on the first call and never overwrites them on a later call", async () => {
    const env = createTestEnv({});
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await repositoriesModule.upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      id: 5151,
      number: 88,
      state: "open",
      title: "Some PR",
      user: { login: "contributor" },
      head: { sha: "sha-1", ref: "fix", repo: { full_name: "contributor/gittensory", owner: { login: "contributor" } } },
      base: { sha: "base123", ref: "main", repo: { full_name: "JSONbored/gittensory", owner: { login: "JSONbored" } } },
      draft: false,
      merged: false,
      created_at: "2026-05-27T00:00:00Z",
      updated_at: "2026-05-27T00:00:00Z",
    } as never);

    const before = await repositoriesModule.getPullRequest(env, "JSONbored/gittensory", 88);
    expect(before?.linkedIssueHardRuleViolatedAt).toBeNull();
    expect(before?.linkedIssueHardRuleViolationReason).toBeNull();

    await repositoriesModule.markPullRequestLinkedIssueHardRuleViolated(env, "JSONbored/gittensory", 88, "Linked issue #7 is assigned to the maintainer (@JSONbored)");
    const afterFirst = await repositoriesModule.getPullRequest(env, "JSONbored/gittensory", 88);
    expect(afterFirst?.linkedIssueHardRuleViolatedAt).toEqual(expect.any(String));
    expect(afterFirst?.linkedIssueHardRuleViolationReason).toBe("Linked issue #7 is assigned to the maintainer (@JSONbored)");

    // A SECOND confirmed violation (e.g. against a different linked issue, or a re-detected same one) must not
    // move the timestamp or replace the reason -- the FIRST confirmed violation is what's remembered forever.
    await repositoriesModule.markPullRequestLinkedIssueHardRuleViolated(env, "JSONbored/gittensory", 88, "Linked issue #9 is already assigned to @someone-else");
    const afterSecond = await repositoriesModule.getPullRequest(env, "JSONbored/gittensory", 88);
    expect(afterSecond?.linkedIssueHardRuleViolatedAt).toBe(afterFirst?.linkedIssueHardRuleViolatedAt);
    expect(afterSecond?.linkedIssueHardRuleViolationReason).toBe("Linked issue #7 is assigned to the maintainer (@JSONbored)");

    // A fresh push (new head SHA) between violations must NOT reset either field -- unlike mergeBlockedSha,
    // this marker is deliberately not scoped to head SHA.
    await repositoriesModule.upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      id: 5151,
      number: 88,
      state: "open",
      title: "Some PR",
      user: { login: "contributor" },
      head: { sha: "sha-2", ref: "fix", repo: { full_name: "contributor/gittensory", owner: { login: "contributor" } } },
      base: { sha: "base123", ref: "main", repo: { full_name: "JSONbored/gittensory", owner: { login: "JSONbored" } } },
      draft: false,
      merged: false,
      created_at: "2026-05-27T00:00:00Z",
      updated_at: "2026-05-27T00:00:00Z",
    } as never);
    const afterNewHead = await repositoriesModule.getPullRequest(env, "JSONbored/gittensory", 88);
    expect(afterNewHead?.linkedIssueHardRuleViolatedAt).toBe(afterFirst?.linkedIssueHardRuleViolatedAt);
    expect(afterNewHead?.linkedIssueHardRuleViolationReason).toBe("Linked issue #7 is assigned to the maintainer (@JSONbored)");
  });

  it("truncates an overlong reason to 280 chars, mirroring markPullRequestMergeBlocked", async () => {
    const env = createTestEnv({});
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await repositoriesModule.upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      id: 5152,
      number: 89,
      state: "open",
      title: "Some PR",
      user: { login: "contributor" },
      head: { sha: "sha-1", ref: "fix", repo: { full_name: "contributor/gittensory", owner: { login: "contributor" } } },
      base: { sha: "base123", ref: "main", repo: { full_name: "JSONbored/gittensory", owner: { login: "JSONbored" } } },
      draft: false,
      merged: false,
      created_at: "2026-05-27T00:00:00Z",
      updated_at: "2026-05-27T00:00:00Z",
    } as never);

    const longReason = "x".repeat(400);
    await repositoriesModule.markPullRequestLinkedIssueHardRuleViolated(env, "JSONbored/gittensory", 89, longReason);
    const row = await repositoriesModule.getPullRequest(env, "JSONbored/gittensory", 89);
    expect(row?.linkedIssueHardRuleViolationReason).toHaveLength(280);
  });

  it("is a safe no-op when the PR row does not exist yet", async () => {
    const env = createTestEnv({});
    await expect(repositoriesModule.markPullRequestLinkedIssueHardRuleViolated(env, "JSONbored/gittensory", 999999, "unreachable")).resolves.toBeUndefined();
  });
});

describe("recordAgentCommandUsage (signal-snapshot fail-safe)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("swallows persistSignalSnapshot errors — catch body runs without crashing the handler", async () => {
    // Bot-authored @gittensory comment hits the early bot_author bail-out path in
    // maybeProcessGittensoryMentionCommand, which calls recordAgentCommandUsage. Injecting a
    // persistSignalSnapshot failure exercises the catch at the bottom of that function.
    vi.spyOn(repositoriesModule, "persistSignalSnapshot").mockRejectedValueOnce(new Error("signal DB error"));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    const payload: any = {
      action: "created",
      installation: { id: 123 },
      repository: { id: 1, name: "gittensory", full_name: "JSONbored/gittensory", private: false, default_branch: "main", owner: { login: "JSONbored" } },
      sender: { login: "gittensory[bot]", type: "Bot" },
      comment: { id: 999, body: "@gittensory help", user: { login: "gittensory[bot]", type: "Bot" } },
      issue: { id: 1, number: 77, title: "some issue", pull_request: { url: "https://api.github.com/repos/JSONbored/gittensory/pulls/77" } },
    };
    await expect(
      processJob(env, { type: "github-webhook", deliveryId: "bot-mention-signal-fail", eventName: "issue_comment", payload }),
    ).resolves.toBeUndefined();
  });

  it("ignores a @gittensory mention on an EDITED comment — only newly-created comments are answered (#review-audit)", async () => {
    const posts: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if ((init?.method ?? "GET") === "POST" && url.includes("/comments")) posts.push(url);
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "gittensory" });
    const payload: any = {
      action: "edited", // an edit re-fires issue_comment with a NEW delivery id — the handler must NOT re-answer
      installation: { id: 123 },
      repository: { id: 1, name: "gittensory", full_name: "JSONbored/gittensory", private: false, default_branch: "main", owner: { login: "JSONbored" } },
      sender: { login: "maintainer", type: "User" },
      comment: { id: 999, body: "@gittensory ask is this mergeable?", user: { login: "maintainer", type: "User" } },
      issue: { id: 1, number: 77, title: "some issue", pull_request: { url: "https://api.github.com/repos/JSONbored/gittensory/pulls/77" } },
    };
    await processJob(env, { type: "github-webhook", deliveryId: "mention-edited", eventName: "issue_comment", payload });
    expect(posts).toEqual([]); // the action guard returns false → no answer card posted
  });
});

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

function reopenedPayload(sender: string): any {
  return {
    action: "reopened",
    installation: { id: 123 },
    repository: { id: 1, name: "gittensory", full_name: "JSONbored/gittensory", private: false, default_branch: "main", owner: { login: "JSONbored" } },
    sender: { login: sender, type: "User" },
    pull_request: {
      id: 4242,
      number: 42,
      state: "open",
      title: "Fix queued guard",
      body: "Fixes the queued guard.",
      user: { login: "contributor" },
      head: { sha: "abc123", ref: "fix", repo: { full_name: "contributor/gittensory", owner: { login: "contributor" } } },
      base: { sha: "base123", ref: "main", repo: { full_name: "JSONbored/gittensory", owner: { login: "JSONbored" } } },
      draft: false,
      merged: false,
      mergeable_state: "clean",
      created_at: "2026-05-27T00:00:00Z",
      updated_at: "2026-05-27T00:00:00Z",
    },
  };
}

describe("installation app_id capture + dual-app webhook filter (#selfhost-app-id)", () => {
  it("captures app_id from an installation payload, returns it, and preserves it when a later payload omits it", async () => {
    const env = createTestEnv();
    const stored = await upsertInstallation(env, {
      action: "created",
      installation: { id: 4242, app_id: 555, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] },
    });
    expect(stored).toBe(555);
    expect((await getInstallation(env, 4242))?.appId).toBe(555);
    // A subsequent payload WITHOUT app_id (e.g. a pull_request event) must not clear the stored value.
    const preserved = await upsertInstallation(env, { action: "synchronize", installation: { id: 4242, account: { login: "owner", id: 1, type: "Organization" } } });
    expect(preserved).toBe(555);
    expect((await getInstallation(env, 4242))?.appId).toBe(555);
  });

  it("acks a webhook whose installation belongs to a DIFFERENT app without processing it", async () => {
    const env = createTestEnv(); // own GITHUB_APP_ID defaults to "3824093"
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 7777);
    // The installation is recorded as belonging to a FOREIGN app (99999 ≠ 3824093).
    await upsertInstallation(env, { action: "created", installation: { id: 7777, app_id: 99999, account: { login: "JSONbored", id: 1, type: "User" }, repository_selection: "selected", permissions: {}, events: [] } });
    vi.stubGlobal("fetch", async () => Response.json({}));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "foreign-app-pr",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 7777 }, // a PR event carries no app_id; the stored 99999 is used
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 88, title: "Foreign", state: "open", user: { login: "contributor" }, head: { sha: "f88" }, labels: [], body: "x" },
      },
    });

    // The delivery was acked as foreign, and the PR was never upserted (the handler returned before the PR block).
    const evt = await env.DB.prepare("select payload_hash from webhook_events where delivery_id = ?").bind("foreign-app-pr").first<{ payload_hash: string }>();
    expect(evt?.payload_hash).toBe("foreign_app");
    const pr = await env.DB.prepare("select count(*) as n from pull_requests where repo_full_name = ? and number = ?").bind("JSONbored/gittensory", 88).first<{ n: number }>();
    expect(pr?.n).toBe(0);
  });

  it("processes a webhook whose installation app_id matches this backend (no false filtering)", async () => {
    const env = createTestEnv(); // own GITHUB_APP_ID "3824093"
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 3824093001);
    await upsertInstallation(env, { action: "created", installation: { id: 3824093001, app_id: 3824093, account: { login: "JSONbored", id: 1, type: "User" }, repository_selection: "selected", permissions: {}, events: [] } });
    vi.stubGlobal("fetch", async () => Response.json({}));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "own-app-pr",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 3824093001 },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 89, title: "Own", state: "open", user: { login: "contributor" }, head: { sha: "o89" }, labels: [], body: "x" },
      },
    });

    // The matching-app webhook was processed normally — the PR row exists and it was NOT acked as foreign.
    const pr = await env.DB.prepare("select count(*) as n from pull_requests where repo_full_name = ? and number = ?").bind("JSONbored/gittensory", 89).first<{ n: number }>();
    expect(pr?.n).toBe(1);
    const evt = await env.DB.prepare("select payload_hash from webhook_events where delivery_id = ?").bind("own-app-pr").first<{ payload_hash: string }>();
    expect(evt?.payload_hash).not.toBe("foreign_app");
  });

  // #2537: durable PR-state cache — webhook invalidation + the act-boundary regression.
  describe("durable PR-state cache (#2537)", () => {
    function seedWarmPrStateCache(env: Env, repoFullName: string, pullNumber: number): Promise<void> {
      return upsertPullRequestDetailSyncState(env, {
        repoFullName,
        pullNumber,
        status: "complete",
        prMergeableState: "clean",
        prState: "open",
        prStateFetchedAt: new Date().toISOString(),
      });
    }

    it.each(["synchronize", "closed", "reopened"] as const)(
      "pull_request %s action invalidates the durable PR-state cache",
      async (action) => {
        const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
        await upsertInstallation(env, { action: "created", installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: {}, events: [] } });
        await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
        await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
        await seedWarmPrStateCache(env, "JSONbored/gittensory", 200);
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = input.toString();
          if (url.includes("/access_tokens")) return Response.json({ token: "tok" });
          return Response.json({});
        });

        await processJob(env, {
          type: "github-webhook",
          deliveryId: `invalidate-pr-state-${action}`,
          eventName: "pull_request",
          payload: {
            action,
            installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
            repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
            pull_request: { number: 200, title: "PR", state: action === "closed" ? "closed" : "open", user: { login: "contributor" }, head: { sha: "a200" }, labels: [], body: "" },
          },
        });

        expect(await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 200)).toMatchObject({
          prMergeableState: null,
          prState: null,
          prStateFetchedAt: null,
        });
      },
    );

    it("a non-invalidating pull_request action (labeled) leaves the durable PR-state cache UNCHANGED", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertInstallation(env, { action: "created", installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: {}, events: [] } });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
      await seedWarmPrStateCache(env, "JSONbored/gittensory", 201);
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "tok" });
        return Response.json({});
      });

      await processJob(env, {
        type: "github-webhook",
        deliveryId: "invalidate-pr-state-labeled",
        eventName: "pull_request",
        payload: {
          action: "labeled",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 201, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "a201" }, labels: [], body: "" },
        },
      });

      expect(await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 201)).toMatchObject({
        prMergeableState: "clean",
        prState: "open",
      });
    });

    it("REGRESSION (#2537, gate-flagged): reconcileLiveDuplicateSiblings must NOT serve a warm durable PR-state cache row — a cached 'open' read up to PR_STATE_CACHE_MAX_AGE_MS stale after a missed closed webhook would keep an already-closed sibling eligible as the duplicate-cluster winner, wrongly closing the CURRENT PR as the loser", async () => {
      const env = createTestEnv({ GITTENSORY_DUPLICATE_WINNER: "true" });
      // Seed a WARM cache row claiming the sibling is still open, but the live GitHub state below says CLOSED —
      // proving the cache is never consulted: only a genuine live read can discover this and correctly reconcile it.
      await seedWarmPrStateCache(env, "owner/repo", 5);
      let liveStateFetches = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "tok" });
        if (/\/pulls\/5(?:\?|$)/.test(url)) {
          liveStateFetches += 1;
          return Response.json({ number: 5, state: "closed" });
        }
        return Response.json({});
      });

      const winner: Parameters<typeof reconcileLiveDuplicateSiblings>[3] = { repoFullName: "owner/repo", number: 10, title: "Winner", state: "open", labels: [], linkedIssues: [1] };
      const sibling: Parameters<typeof reconcileLiveDuplicateSiblings>[3] = { repoFullName: "owner/repo", number: 5, title: "Sibling", state: "open", labels: [], linkedIssues: [1] };
      const result = await reconcileLiveDuplicateSiblings(env, null, "owner/repo", winner, [sibling]);

      // The sibling is correctly dropped as stale-closed, proving a genuine live fetch happened rather than
      // trusting the warm-but-wrong cached "open" value.
      expect(result).toEqual([]);
      expect(liveStateFetches).toBe(1);
    });

    it("REGRESSION (#2537): the per-PR sweep unit's live resync primes the durable PR-state cache for later readers", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await upsertInstallation(env, { action: "created", installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { pull_requests: "write" }, events: [] } });
      await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9001);
      await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", checkRunMode: "off", commentMode: "off", publicSurface: "off" });
      await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 6, title: "Sweep target", state: "open", user: { login: "contributor" }, head: { sha: "a6" }, base: { ref: "main" }, labels: [], body: "" });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "tok" });
        if (/\/pulls\/6(?:\?|$)/.test(url)) return Response.json({ number: 6, state: "open", mergeable_state: "clean", head: { sha: "a6" } });
        if (url.includes("/pulls/6/files")) return Response.json([]);
        if (url.includes("/pulls/6/reviews")) return Response.json([]);
        if (url.includes("/commits/a6/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/commits/a6/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "prime-pr-state-cache", repoFullName: "owner/agent-repo", prNumber: 6, installationId: 9001 });

      expect(await getPullRequestDetailSyncState(env, "owner/agent-repo", 6)).toMatchObject({
        prMergeableState: "clean",
        prState: "open",
      });
    });
  });
});

describe("enrichOpenPullRequestsWithChangedFiles (#2653)", () => {
  const pr = (number: number, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord => ({
    repoFullName: "owner/repo",
    number,
    title: `PR ${number}`,
    state: "open",
    labels: [],
    linkedIssues: [],
    ...overrides,
  });

  it("populates changedFiles for open PRs from the pull_request_files cache", async () => {
    const env = createTestEnv();
    await upsertPullRequestFile(env, { repoFullName: "owner/repo", pullNumber: 10, path: "src/a.ts", additions: 1, deletions: 0, changes: 1, payload: {} });
    await upsertPullRequestFile(env, { repoFullName: "owner/repo", pullNumber: 10, path: "src/b.ts", additions: 1, deletions: 0, changes: 1, payload: {} });
    await upsertPullRequestFile(env, { repoFullName: "owner/repo", pullNumber: 11, path: "src/c.ts", additions: 1, deletions: 0, changes: 1, payload: {} });

    const result = await enrichOpenPullRequestsWithChangedFiles(env, "owner/repo", [pr(10), pr(11)]);

    expect(result.find((candidate) => candidate.number === 10)?.changedFiles?.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.find((candidate) => candidate.number === 11)?.changedFiles).toEqual(["src/c.ts"]);
  });

  it("leaves a PR's changedFiles untouched when the cache has no rows for it (fail-safe degrade, not an error)", async () => {
    const env = createTestEnv();
    await upsertPullRequestFile(env, { repoFullName: "owner/repo", pullNumber: 10, path: "src/a.ts", additions: 1, deletions: 0, changes: 1, payload: {} });

    const result = await enrichOpenPullRequestsWithChangedFiles(env, "owner/repo", [pr(10), pr(12)]);

    expect(result.find((candidate) => candidate.number === 12)?.changedFiles).toBeUndefined();
  });

  it("does not query the cache and returns the same array reference when there are no open PRs", async () => {
    const env = createTestEnv();
    const input = [pr(20, { state: "closed" })];

    const result = await enrichOpenPullRequestsWithChangedFiles(env, "owner/repo", input);

    expect(result).toBe(input);
  });

  it("returns the same array reference when the cache has no rows for any open PR", async () => {
    const env = createTestEnv();
    const input = [pr(30)];

    const result = await enrichOpenPullRequestsWithChangedFiles(env, "owner/repo", input);

    expect(result).toBe(input);
  });
});

describe("backlog-convergence sweep (#selfhost-backlog-convergence)", () => {
  it("fans out to acting-autonomy repos, skipping a non-acting/non-allowlisted repo", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      LOOPOVER_REVIEW_REPOS: "",
      JOBS: { async send(message: import("../../src/types").JobMessage) { sent.push(message); } } as unknown as Queue,
    });
    await upsertRepositoryFromGitHub(env, { name: "agent-a", full_name: "owner/agent-a", private: false, owner: { login: "owner" } });
    await upsertRepositoryFromGitHub(env, { name: "plain-repo", full_name: "owner/plain-repo", private: false, owner: { login: "owner" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-a", autonomy: { merge: "auto" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/plain-repo", autonomy: { review: "observe" } });

    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "schedule" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "backlog-convergence-sweep", repoFullName: "owner/agent-a" });
    const fanout = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?")
      .bind("agent.sweep.backlog_convergence.fanout")
      .first<{ outcome: string; metadata_json: string }>();
    expect(fanout?.outcome).toBe("queued");
    expect(JSON.parse(fanout?.metadata_json ?? "{}")).toMatchObject({ repoCount: 1, requestedBy: "schedule" });
  });

  it("also fans out to an allowlisted repo regardless of autonomy mode (#sweep-all-modes parity)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ LOOPOVER_REVIEW_REPOS: "owner/advisory-repo", JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "advisory-repo", full_name: "owner/advisory-repo", private: false, owner: { login: "owner" } }, 9502);
    await upsertRepositorySettings(env, { repoFullName: "owner/advisory-repo", autonomy: { merge: "observe" } });

    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "schedule" });

    expect(sent).toEqual([expect.objectContaining({ type: "backlog-convergence-sweep", repoFullName: "owner/advisory-repo", installationId: 9502 })]);
  });

  it("fans out to an allowlisted repo that was never registered locally (no installationId) and staggers a second repo's delay", async () => {
    const sent: Array<{ message: import("../../src/types").JobMessage; delaySeconds?: number }> = [];
    const env = createTestEnv({
      LOOPOVER_REVIEW_REPOS: "owner/never-registered",
      JOBS: { async send(m: import("../../src/types").JobMessage, options?: { delaySeconds?: number }) { sent.push({ message: m, ...(options?.delaySeconds === undefined ? {} : { delaySeconds: options.delaySeconds }) }); } } as unknown as Queue,
    });
    await upsertRepositoryFromGitHub(env, { name: "agent-a", full_name: "owner/agent-a", private: false, owner: { login: "owner" } }, 9506);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-a", autonomy: { merge: "auto" } });
    // owner/never-registered is allowlisted but has no local repository row at all -> no installationId to attach.

    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "schedule" });

    expect(sent).toHaveLength(2);
    const neverRegistered = sent.find((s) => s.message.type === "backlog-convergence-sweep" && s.message.repoFullName === "owner/never-registered");
    expect(neverRegistered?.message).not.toHaveProperty("installationId");
    // Whichever entry landed second (index 1) carries a nonzero stagger delay.
    expect(sent.some((s) => (s.delaySeconds ?? 0) > 0)).toBe(true);
  });

  it("no-ops safely on a missing repo arg or an un-configured repo", async () => {
    const env = createTestEnv({});
    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "test" });
    await upsertRepositoryFromGitHub(env, { name: "plain-repo", full_name: "owner/plain-repo", private: false, owner: { login: "owner" } });
    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "test", repoFullName: "owner/plain-repo" });

    const count = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("agent.sweep.backlog_convergence").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("respects the global pause kill-switch: a paused repo records a denial and enqueues nothing", async () => {
    const env = createTestEnv({});
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9503);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" }, agentPaused: true });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Stale surface", state: "open", user: { login: "contributor" }, head: { sha: "abc" }, labels: [], body: "x" });

    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    const audit = await env.DB.prepare("select outcome, detail, metadata_json from audit_events where event_type = ?")
      .bind("agent.sweep.backlog_convergence")
      .first<{ outcome: string; detail: string; metadata_json: string }>();
    expect(audit?.outcome).toBe("denied");
    expect(audit?.detail).toMatch(/paused/i);
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({ mode: "paused" });
  });

  it("stays quiet (no audit, no enqueue) with no installation to act with", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }); // no installationId
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Stale surface", state: "open", user: { login: "contributor" }, head: { sha: "abc" }, labels: [], body: "x" });

    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    expect(sent).toEqual([]);
    const count = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("agent.sweep.backlog_convergence").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("stays quiet when every open PR's surface is already published at its current head", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertInstallation(env, { action: "created", installation: { id: 9504, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9504);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Converged", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "x" });
    await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", 7, "a7");

    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    expect(sent).toEqual([]);
  });

  it("fans out one agent-regate-pr per stale-surface candidate, tagged with the backlog-convergence deliveryId prefix", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertInstallation(env, { action: "created", installation: { id: 9505, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9505);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" } });
    // #7 never had its surface published; #8 was published at an OLDER head than its current one; #9 is fully converged;
    // #10 is a legacy/sparse row with no GitHub created_at, and still needs a re-gate without PR-age metadata.
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Never published", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "x", created_at: "2026-07-03T10:00:00.000Z" });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 8, title: "Stale surface", state: "open", user: { login: "contributor" }, head: { sha: "b8" }, labels: [], body: "x", created_at: "2026-07-03T11:00:00.000Z" });
    await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", 8, "old-b8");
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 9, title: "Converged", state: "open", user: { login: "contributor" }, head: { sha: "a9" }, labels: [], body: "x" });
    await repositoriesModule.markPullRequestSurfacePublished(env, "owner/agent-repo", 9, "a9");
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 10, title: "Sparse legacy row", state: "open", user: { login: "contributor" }, head: { sha: "a10" }, labels: [], body: "x" });

    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "schedule", repoFullName: "owner/agent-repo" });

    const fanned = sent.filter((job): job is Extract<import("../../src/types").JobMessage, { type: "agent-regate-pr" }> => job.type === "agent-regate-pr");
    expect(fanned.map((job) => job.prNumber).sort((a, b) => a - b)).toEqual([7, 8, 10]);
    for (const job of fanned) {
      expect(job.deliveryId).toBe(`backlog-convergence:owner/agent-repo#${job.prNumber}`);
      expect(job.installationId).toBe(9505);
    }
    expect(Object.fromEntries(fanned.map((job) => [job.prNumber, job.prCreatedAt]))).toEqual({
      7: "2026-07-03T10:00:00.000Z",
      8: "2026-07-03T11:00:00.000Z",
      10: undefined,
    });
    const audit = await env.DB.prepare("select outcome, detail, metadata_json from audit_events where event_type = ?")
      .bind("agent.sweep.backlog_convergence")
      .first<{ outcome: string; detail: string; metadata_json: string }>();
    expect(audit?.outcome).toBe("completed");
    const meta = JSON.parse(audit?.metadata_json ?? "{}");
    expect(meta).toMatchObject({ repoFullName: "owner/agent-repo", openCount: 4, examined: 3 });
    expect(meta.candidatePulls.sort((a: number, b: number) => a - b)).toEqual([7, 8, 10]);
  });

  it("REGRESSION (#4502, #audit-sweep-dispatch-stamp): ONE sweep stamps ALL candidates AT DISPATCH, so the next fan-out skips the repo as draining — no overlapping sweeps", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertInstallation(env, { action: "created", installation: { id: 9510, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9510);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" } });
    for (const number of [7, 8, 9]) {
      await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number, title: `PR${number}`, state: "open", user: { login: "c" }, head: { sha: `a${number}` }, labels: [], body: "" });
    }

    // Run ONE per-repo sweep — do NOT drain the per-PR jobs (simulate the staggered re-reviews not having run yet).
    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    // The marker is stamped for EVERY candidate immediately at dispatch — NOT waiting on the per-PR jobs.
    const stamped = await env.DB.prepare("select count(*) as n from pull_requests where repo_full_name = ? and last_backlog_convergence_regated_at is not null").bind("owner/agent-repo").first<{ n: number }>();
    expect(stamped?.n).toBe(3);

    // So the very next cron fan-out sees the fresh stamp and SKIPS this repo as draining — the overlap that would
    // duplicate per-PR jobs is gone.
    sent.length = 0;
    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "schedule" });
    expect(sent.some((m) => m.type === "backlog-convergence-sweep" && m.repoFullName === "owner/agent-repo")).toBe(false);
    const fanout = await env.DB.prepare("select metadata_json from audit_events where event_type = ? order by created_at desc limit 1").bind("agent.sweep.backlog_convergence.fanout").first<{ metadata_json: string }>();
    expect(JSON.parse(fanout?.metadata_json ?? "{}").skippedDraining).toBeGreaterThanOrEqual(1);
  });

  it("INVARIANT (#4502, in-flight guard): the fan-out SKIPS a repo whose prior sweep is still draining, enqueues an idle one", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ LOOPOVER_REVIEW_REPOS: "", JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertInstallation(env, { action: "created", installation: { id: 9511, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    for (const name of ["draining", "idle"]) {
      await upsertRepositoryFromGitHub(env, { name, full_name: `owner/${name}`, private: false, owner: { login: "owner" } }, 9511);
      await upsertRepositorySettings(env, { repoFullName: `owner/${name}`, autonomy: { merge: "auto" } });
      await upsertPullRequestFromGitHub(env, `owner/${name}`, { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "h1" }, labels: [], body: "" });
    }
    // owner/draining was just backlog-convergence-regated (a sweep is mid-drain); owner/idle has never been swept.
    await repositoriesModule.markPullRequestsBacklogConvergenceRegated(env, "owner/draining", [1]);

    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "schedule" }); // no repoFullName → fan-out path

    const sweepRepos = sent.filter((m): m is Extract<import("../../src/types").JobMessage, { type: "backlog-convergence-sweep" }> => m.type === "backlog-convergence-sweep").map((m) => m.repoFullName);
    expect(sweepRepos).toEqual(["owner/idle"]); // the draining repo is skipped, the idle one enqueued
    const fanout = await env.DB.prepare("select metadata_json from audit_events where event_type = ?").bind("agent.sweep.backlog_convergence.fanout").first<{ metadata_json: string }>();
    expect(JSON.parse(fanout?.metadata_json ?? "{}")).toMatchObject({ repoCount: 1, skippedDraining: 1 });
  });

  it("INVARIANT (#4502, #audit-fanout-dedup): a BURST of fan-outs collapses to ONE — the second claims nothing and audits denied", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertInstallation(env, { action: "created", installation: { id: 9512, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9512);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "PR7", state: "open", user: { login: "c" }, head: { sha: "a7" }, labels: [], body: "" });

    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "schedule" }); // first fan-out claims the window
    expect(sent.some((m) => m.type === "backlog-convergence-sweep" && m.repoFullName === "owner/agent-repo")).toBe(true);

    sent.length = 0;
    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "schedule" }); // burst sibling in the same window → deduped
    expect(sent.filter((m) => m.type === "backlog-convergence-sweep")).toEqual([]); // enqueues no redundant sweep
    const denied = await env.DB.prepare("select count(*) as n from audit_events where event_type='agent.sweep.backlog_convergence.fanout' and outcome='denied'").first<{ n: number }>();
    expect(denied?.n).toBe(1);
  });

  it("REGRESSION (#4502, #audit-sweep-fanout-isolation): one repo's settings-check failure does not abort the fan-out for every other repo", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      LOOPOVER_REVIEW_REPOS: "",
      JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue,
    });
    await upsertRepositoryFromGitHub(env, { name: "agent-a", full_name: "owner/agent-a", private: false, owner: { login: "owner" } });
    await upsertRepositoryFromGitHub(env, { name: "agent-b", full_name: "owner/agent-b", private: false, owner: { login: "owner" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-a", autonomy: { label: "auto" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-b", autonomy: { label: "auto" } });
    const realResolve = repositorySettingsModule.resolveRepositorySettings;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const resolveSpy = vi.spyOn(repositorySettingsModule, "resolveRepositorySettings").mockImplementation(async (e, repoFullName) => {
      if (repoFullName === "owner/agent-a") throw new Error("D1 read error");
      return realResolve(e, repoFullName);
    });

    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "schedule" });

    expect(sent).toEqual([expect.objectContaining({ type: "backlog-convergence-sweep", repoFullName: "owner/agent-b" })]); // agent-a's failure did not block agent-b
    expect(errors.mock.calls.some((call) => String(call[0]).includes("backlog_convergence_fanout_repo_check_failed") && String(call[0]).includes("owner/agent-a"))).toBe(true);
    const fanout = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("agent.sweep.backlog_convergence.fanout").first<{ outcome: string; metadata_json: string }>();
    expect(fanout?.outcome).toBe("queued"); // the fan-out still completes and records its own outcome
    expect(JSON.parse(fanout?.metadata_json ?? "{}")).toMatchObject({ repoCount: 1, skippedErrored: 1 });
    errors.mockRestore();
    resolveSpy.mockRestore();
  });

  it("REGRESSION (#4502, #audit-sweep-fanout-isolation): one repo's dispatch failure does not abort dispatch for every other repo, and the fan-out audit event still records", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      LOOPOVER_REVIEW_REPOS: "",
      JOBS: {
        async send(m: import("../../src/types").JobMessage) {
          if (m.type === "backlog-convergence-sweep" && m.repoFullName === "owner/agent-a") throw new Error("queue send error");
          sent.push(m);
        },
      } as unknown as Queue,
    });
    await upsertRepositoryFromGitHub(env, { name: "agent-a", full_name: "owner/agent-a", private: false, owner: { login: "owner" } });
    await upsertRepositoryFromGitHub(env, { name: "agent-b", full_name: "owner/agent-b", private: false, owner: { login: "owner" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-a", autonomy: { label: "auto" } });
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-b", autonomy: { label: "auto" } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "schedule" });

    expect(sent).toEqual([expect.objectContaining({ type: "backlog-convergence-sweep", repoFullName: "owner/agent-b" })]); // agent-a's failed send did not block agent-b's
    expect(errors.mock.calls.some((call) => String(call[0]).includes("backlog_convergence_fanout_dispatch_failed") && String(call[0]).includes("owner/agent-a"))).toBe(true);
    const fanout = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("agent.sweep.backlog_convergence.fanout").first<{ outcome: string; metadata_json: string }>();
    expect(fanout?.outcome).toBe("queued"); // reached — the dispatch failure did not throw the fan-out itself
    expect(JSON.parse(fanout?.metadata_json ?? "{}")).toMatchObject({ repoCount: 2 }); // both PASSED their settings/draining checks regardless of dispatch outcome
    errors.mockRestore();
  });

  it("agent re-gate sweep swallows a failing last_backlog_convergence_regated_at stamp and still completes (#4502, #audit-sweep-converge)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertInstallation(env, { action: "created", installation: { id: 9513, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "agent-repo", full_name: "owner/agent-repo", private: false, owner: { login: "owner" } }, 9513);
    await upsertRepositorySettings(env, { repoFullName: "owner/agent-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/agent-repo", { number: 7, title: "Stale surface", state: "open", user: { login: "contributor" }, head: { sha: "a7" }, labels: [], body: "" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stamp = vi.spyOn(repositoriesModule, "markPullRequestsBacklogConvergenceRegated").mockRejectedValueOnce(new Error("D1 write error"));

    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "test", repoFullName: "owner/agent-repo" });

    const audit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("agent.sweep.backlog_convergence").first<{ outcome: string }>();
    expect(audit?.outcome).toBe("completed"); // the sweep still completes; the dispatch-time stamp failure is swallowed
    expect(sent.some((m) => m.type === "agent-regate-pr" && m.prNumber === 7)).toBe(true); // the per-PR fan-out still happens
    expect(errors.mock.calls.some((call) => String(call[0]).includes("backlog_convergence_mark_regated_failed"))).toBe(true);
    stamp.mockRestore();
    errors.mockRestore();
  });

  it("REGRESSION (#4502, #3899-style port): resolves multiple repos' settings/drain-state CONCURRENTLY, bounded by SWEEP_FANOUT_RESOLUTION_CONCURRENCY, and drops no repo", async () => {
    vi.useRealTimers();
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      LOOPOVER_REVIEW_REPOS: "",
      JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue,
    });
    const repoNames = ["r1", "r2", "r3", "r4", "r5", "r6"];
    for (const name of repoNames) {
      await upsertRepositoryFromGitHub(env, { name, full_name: `owner/${name}`, private: false, owner: { login: "owner" } });
      await upsertRepositorySettings(env, { repoFullName: `owner/${name}`, autonomy: { merge: "auto" } });
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

    await processJob(env, { type: "backlog-convergence-sweep", requestedBy: "schedule" });

    expect(mapSpy).toHaveBeenCalled();
    expect(maxInFlight).toBeGreaterThan(1); // proves real overlap — not the old strictly-sequential loop
    expect(maxInFlight).toBeLessThanOrEqual(SWEEP_FANOUT_RESOLUTION_CONCURRENCY); // proves BOUNDED, not unlimited fan-out
    expect(sent.filter((m) => m.type === "backlog-convergence-sweep").length).toBe(repoNames.length); // every repo still dispatched, none silently dropped
  });
});

// #selfhost-auto-action-convergence: end-to-end regression coverage for the GENERAL heuristic plan+execute path
// (runAgentMaintenancePlanAndExecute -> planAgentMaintenanceActions -> executeAgentMaintenanceActions), via real
// webhook -> processJob -> mocked-GitHub-API assertions. The specialized short-circuit mechanisms (blacklist,
// contributor-cap, review-nag, converted_to_draft gate-close) already have deep end-to-end coverage elsewhere in
// this file; planAgentMaintenanceActions itself is exhaustively unit-tested in agent-actions.test.ts; and
// executeAgentMaintenanceActions's own gate stack is exhaustively unit-tested in agent-action-executor.test.ts.
// What was missing was END-TO-END proof, for the plain gate-verdict path specifically, that the two connect: a
// plan computed from REAL PR/settings state actually reaches a REAL (mocked) GitHub mutation.
describe("auto-action convergence: end-to-end plan+execute for the general heuristic path (#selfhost-auto-action-convergence)", () => {
  const REPO = "JSONbored/gittensory";
  const INSTALLATION_ID = 9600;

  beforeEach(() => clearInstallationTokenCacheForTest());
  afterEach(() => {
    clearInstallationTokenCacheForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function setupAutoActionRepo(env: ReturnType<typeof createTestEnv>, settingsOverrides: Record<string, unknown> = {}): Promise<void> {
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: REPO, private: false, owner: { login: "JSONbored" } }, INSTALLATION_ID);
    await upsertInstallation(env, {
      installation: {
        id: INSTALLATION_ID,
        account: { login: "JSONbored", id: 1, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: REPO, private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: REPO,
      commentMode: "off",
      publicSurface: "off",
      checkRunMode: "off",
      reviewCheckMode: "required",
      linkedIssueGateMode: "block", // the default blocker mechanism for these tests: missing linked issue -> gate failure
      ...settingsOverrides,
    });
    // Without a registry snapshot the gate reports a "repo_unregistered" warning finding, which keeps the
    // conclusion at "neutral" instead of "success"/"failure" -- register the repo so the tests below exercise
    // real merge/close dispositions rather than the not-evaluated-yet state.
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ [REPO]: { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
    );
  }

  function prPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      action: "opened",
      installation: { id: INSTALLATION_ID, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: REPO, private: false, owner: { login: "JSONbored" } },
      pull_request: {
        number: 60,
        title: "A PR",
        state: "open",
        user: { login: "contributor" },
        head: { sha: "conv60" },
        labels: [],
        body: "no linked issue here", // missing-linked-issue -> gate conclusion=failure under linkedIssueGateMode:block
        mergeable_state: "clean",
        reviewDecision: "APPROVED",
        ...overrides,
      },
    };
  }

  /** A fetch stub for one PR (number/head parametrized) with a controllable CI state, capturing whether a real
   *  merge (PUT .../pulls/N/merge) or close (PATCH .../pulls/N with state:"closed") mutation actually fired. */
  function stubPrFetch(
    prNumber: number,
    headSha: string,
    seen: { closed: boolean; merged: boolean },
    ciState: "clear" | "pending" | "passed" = "clear",
  ): void {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url === "https://api.github.com/graphql") {
        return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
      }
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes(`/pulls/${prNumber}/files`)) return Response.json([]);
      if (url.includes(`/pulls/${prNumber}/reviews`)) return Response.json([]);
      if (url.includes(`/pulls/${prNumber}/commits`)) return Response.json([]);
      if (url.endsWith(`/pulls/${prNumber}/merge`) && method === "PUT") {
        seen.merged = true;
        return Response.json({ merged: true });
      }
      if (url.endsWith(`/pulls/${prNumber}`) && method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.state === "closed") seen.closed = true;
        return Response.json({ number: prNumber, state: body.state ?? "open" });
      }
      if (url.endsWith(`/pulls/${prNumber}`)) {
        return Response.json({ number: prNumber, state: "open", user: { login: "contributor" }, head: { sha: headSha }, mergeable_state: "clean" });
      }
      if (url.includes(`/commits/${headSha}/check-runs`)) {
        if (ciState === "pending") return Response.json({ total_count: 1, check_runs: [{ name: "CI", status: "in_progress", conclusion: null, app: { slug: "github-actions" } }] });
        if (ciState === "passed") return Response.json({ total_count: 1, check_runs: [{ name: "CI", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
        return Response.json({ total_count: 0, check_runs: [] });
      }
      if (url.includes(`/commits/${headSha}/status`)) {
        return Response.json({ state: ciState === "pending" ? "pending" : "success", statuses: [] });
      }
      if (url.includes(`/issues/${prNumber}/labels`)) return Response.json([]);
      if (url.includes(`/issues/${prNumber}/comments`)) return Response.json([]);
      return Response.json({});
    });
  }

  it("REGRESSION: a blocked contributor PR (plain gate failure) with close=auto is actually closed via the general heuristic-close path", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupAutoActionRepo(env, { autonomy: { close: "auto" } });
    const seen = { closed: false, merged: false };
    stubPrFetch(60, "conv60", seen);
    resetMetrics();

    await processJob(env, { type: "github-webhook", deliveryId: "conv-close", eventName: "pull_request", payload: prPayload() });

    expect(seen.closed).toBe(true);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBeGreaterThanOrEqual(1);
    // #terminal-outcome-audit: the disposition counter's "close" action_class, with the actual gate-blocker
    // code (missing_linked_issue, from the default linkedIssueGateMode:block + no-linked-issue body) as the
    // bounded blocker_class -- proof this reaches the real gate.blockers, not just a hardcoded label.
    expect(await renderMetrics()).toContain('loopover_agent_disposition_total{action_class="close",autonomy_level="auto",blocker_class="missing_linked_issue",repo="redacted-1"} 1');
    const nativeDecision = await env.DB.prepare("select decision, summary, source from review_audit where event_type = 'gate_decision' and target_id = ?").bind(`${REPO}#60`).first<{ decision: string; summary: string; source: string }>();
    expect(nativeDecision).toMatchObject({ decision: "close", summary: "missing_linked_issue", source: "gittensory-native" });
  });

  // REGRESSION (gate-flagged gap, #terminal-outcome-audit): a PR that touches a guardrail-protected path (e.g.
  // .github/workflows/**) is otherwise clean, so the gate lands on conclusion:"neutral" via guardrailHit --
  // gate.blockers is empty for that conclusion (see evaluateGateCheckCore), so before this fix the disposition
  // metric's blocker_class silently read "none", indistinguishable from a clean PR held on nothing more than
  // pending CI. neutralHoldReasonCode recovers the real reason from gate.warnings instead.
  it("a guardrail-path hold (neutral gate conclusion) records blocker_class=guardrail_hold, not 'none'", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupAutoActionRepo(env, { autonomy: { merge: "auto", close: "auto" }, linkedIssueGateMode: "off" });
    const seen = { closed: false, merged: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url === "https://raw.githubusercontent.com/JSONbored/gittensory/HEAD/.loopover.yml") return new Response("settings:\n  hardGuardrailGlobs:\n    - .github/workflows/**\n");
      if (url === "https://api.github.com/graphql") return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/61/files")) return Response.json([{ filename: ".github/workflows/ci.yml", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+  x: 1" }]);
      if (url.includes("/pulls/61/reviews")) return Response.json([]);
      if (url.includes("/pulls/61/commits")) return Response.json([]);
      if (url.endsWith("/pulls/61/merge") && method === "PUT") { seen.merged = true; return Response.json({ merged: true }); }
      if (url.endsWith("/pulls/61") && method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.state === "closed") seen.closed = true;
        return Response.json({ number: 61, state: body.state ?? "open" });
      }
      if (url.endsWith("/pulls/61")) return Response.json({ number: 61, state: "open", user: { login: "contributor" }, head: { sha: "conv61" }, mergeable_state: "clean" });
      if (url.includes("/commits/conv61/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "CI", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
      if (url.includes("/commits/conv61/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/61/labels")) return Response.json([]);
      if (url.includes("/issues/61/comments")) return Response.json([]);
      return Response.json({});
    });
    resetMetrics();

    await processJob(env, { type: "github-webhook", deliveryId: "conv-guardrail", eventName: "pull_request", payload: prPayload({ number: 61, head: { sha: "conv61" }, body: "no linked issue needed" }) });

    expect(seen.merged).toBe(false);
    expect(seen.closed).toBe(false);
    expect(await renderMetrics()).toContain('loopover_agent_disposition_total{action_class="hold",autonomy_level="auto",blocker_class="guardrail_hold",repo="redacted-1"} 1');
    const holdAudit = await env.DB.prepare("select metadata_json from audit_events where event_type = 'agent.action.hold' order by created_at desc limit 1").first<{ metadata_json: string }>();
    expect(JSON.parse(holdAudit?.metadata_json ?? "{}")).toMatchObject({
      repoFullName: REPO,
      pullNumber: 61,
      disposition: { actionClass: "hold", blockerClass: "guardrail_hold" },
      guardrailMatches: [{ path: ".github/workflows/ci.yml", glob: ".github/workflows/**" }],
    });
  });

  it("reviewCheckMode: disabled still auto-closes a blocked contributor PR via the general heuristic-close path (#2852)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupAutoActionRepo(env, { autonomy: { close: "auto" }, reviewCheckMode: "disabled" });
    const seen = { closed: false, merged: false };
    let checkRunApiCalls = 0;
    stubPrFetch(66, "conv66", seen);
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (/\/check-runs(?:\/|\?|$)/.test(url) && (method === "POST" || method === "PATCH")) checkRunApiCalls += 1;
      return realFetch(input, init);
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "conv-disabled-close",
      eventName: "pull_request",
      payload: prPayload({ number: 66, head: { sha: "conv66" } }),
    });

    expect(seen.closed).toBe(true);
    expect(checkRunApiCalls).toBe(0);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBeGreaterThanOrEqual(1);
  });

  it("REGRESSION: a green-verdict PR with CI still pending is NOT merged (merge withheld until CI/mergeability settle)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupAutoActionRepo(env, { autonomy: { merge: "auto", approve: "auto" }, linkedIssueGateMode: "off" });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    const seen = { closed: false, merged: false };
    stubPrFetch(61, "conv61", seen, "pending");

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "conv-ci-pending",
      eventName: "pull_request",
      payload: prPayload({ number: 61, head: { sha: "conv61" }, body: "Closes #1" }),
    });

    expect(seen.merged).toBe(false);
    const mergeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.merge'").first<{ n: number }>();
    expect(mergeAudit?.n).toBe(0);
  });

  it("REGRESSION (#selfhost-backlog-convergence): a CI-pending PR defers, then merges once check_suite.completed reports CI green (convergence chain)", async () => {
    // maybeReReviewOnCiCompletion (processors.ts) gates its ENTIRE re-review loop on isConvergenceRepoAllowed
    // (the LOOPOVER_REVIEW_REPOS cutover allowlist), independent of autonomy -- the check_suite/check_run
    // "THE auto-merge trigger" path only fires for an allowlisted repo.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_REPOS: REPO });
    await setupAutoActionRepo(env, { autonomy: { merge: "auto", approve: "auto" }, linkedIssueGateMode: "off" });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    const seen = { closed: false, merged: false };
    let ciState: "pending" | "passed" = "pending";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      // Delegate to a fresh stub per call so the closure sees the CURRENT ciState -- stubPrFetch captures ciState
      // by value at call time, so re-invoke its logic inline against the live ciState variable instead.
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url === "https://api.github.com/graphql") {
        return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
      }
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // A non-empty, non-guardrail file: an EMPTY files list is treated as "unresolved" and fails CLOSED into a
      // guardrail hold (isGuardrailHit short-circuits true on changedPaths.length === 0) -- so this must return a
      // real file for the merge disposition below to ever reach a genuine "success" gate conclusion.
      if (url.includes("/pulls/62/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/pulls/62/reviews")) return Response.json([]);
      if (url.includes("/pulls/62/commits")) return Response.json([]);
      if (url.endsWith("/pulls/62/merge") && method === "PUT") {
        seen.merged = true;
        return Response.json({ merged: true });
      }
      if (url.endsWith("/pulls/62")) {
        return Response.json({ number: 62, state: "open", user: { login: "contributor" }, head: { sha: "conv62" }, mergeable_state: "clean" });
      }
      if (url.includes("/commits/conv62/check-runs")) {
        return ciState === "pending"
          ? Response.json({ total_count: 1, check_runs: [{ name: "CI", status: "in_progress", conclusion: null, app: { slug: "github-actions" } }] })
          : Response.json({ total_count: 1, check_runs: [{ name: "CI", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
      }
      if (url.includes("/commits/conv62/status")) return Response.json({ state: ciState === "pending" ? "pending" : "success", statuses: [] });
      if (url.includes("/issues/62/labels")) return Response.json([]);
      if (url.includes("/issues/62/comments")) return Response.json([]);
      return Response.json({});
    });

    // Step 1: a synchronize webhook while CI is still running -> merge withheld.
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "conv-chain-1",
      eventName: "pull_request",
      payload: prPayload({ number: 62, head: { sha: "conv62" }, body: "Closes #1", action: "synchronize" }),
    });
    expect(seen.merged).toBe(false);

    // Step 2: CI finishes; a check_suite.completed webhook for the SAME head re-triggers the pipeline, which now
    // sees a passing CI aggregate and merges.
    ciState = "passed";
    resetMetrics();
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "conv-chain-2",
      eventName: "check_suite",
      payload: {
        action: "completed",
        installation: { id: INSTALLATION_ID, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: REPO, private: false, owner: { login: "JSONbored" } },
        check_suite: { head_sha: "conv62", conclusion: "success", pull_requests: [{ number: 62 }] },
      } as never,
    });

    expect(seen.merged).toBe(true);
    const mergeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.merge'").first<{ n: number }>();
    expect(mergeAudit?.n).toBeGreaterThanOrEqual(1);
    // #terminal-outcome-audit: the disposition counter's "merge" action_class, on the actual live call site.
    expect(await renderMetrics()).toContain('loopover_agent_disposition_total{action_class="merge",autonomy_level="auto",blocker_class="none",repo="redacted-1"} 1');
  });

  // #terminal-outcome-audit: end-to-end proof that the LIVE runAgentMaintenancePlanAndExecute call site (not just
  // the extracted pure precisionBreakerDowngradeDirections/applyPrecisionBreakers unit tests) actually increments
  // loopover_precision_breaker_downgrades_total when an engaged accuracy circuit-breaker rewrites a real plan.
  it("REGRESSION (#terminal-outcome-audit): an engaged holdonly breaker withholds a real would-merge AND increments the downgrade counter", async () => {
    // Mirrors the "#selfhost-backlog-convergence" chain test above (same two-step CI-pending-then-green shape,
    // the proven way this suite reaches a REAL merge attempt): a plain "opened" webhook with CI already green
    // never reaches the merge decision in this harness; the check_suite.completed re-review path does.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_REPOS: REPO });
    await setupAutoActionRepo(env, { autonomy: { merge: "auto", approve: "auto" }, linkedIssueGateMode: "off" });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    const seen = { closed: false, merged: false };
    let ciState: "pending" | "passed" = "pending";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url === "https://api.github.com/graphql") return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
      if (url.includes("/access_tokens")) return Response.json({ token: "test-token" });
      if (url.includes("/pulls/65/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/pulls/65/reviews")) return Response.json([]);
      if (url.includes("/pulls/65/commits")) return Response.json([]);
      if (url.endsWith("/pulls/65/merge") && method === "PUT") { seen.merged = true; return Response.json({ merged: true }); }
      if (url.endsWith("/pulls/65")) return Response.json({ number: 65, state: "open", user: { login: "contributor" }, head: { sha: "conv65" }, mergeable_state: "clean" });
      if (url.includes("/commits/conv65/check-runs")) {
        return ciState === "pending"
          ? Response.json({ total_count: 1, check_runs: [{ name: "CI", status: "in_progress", conclusion: null, app: { slug: "github-actions" } }] })
          : Response.json({ total_count: 1, check_runs: [{ name: "CI", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
      }
      if (url.includes("/commits/conv65/status")) return Response.json({ state: ciState === "pending" ? "pending" : "success", statuses: [] });
      if (url.includes("/issues/65/labels")) return Response.json([]);
      if (url.includes("/issues/65/comments")) return Response.json([]);
      return Response.json({});
    });

    // Step 1: a synchronize webhook while CI is still running — establishes the PR, no merge yet.
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "conv-holdonly-1",
      eventName: "pull_request",
      payload: prPayload({ number: 65, head: { sha: "conv65" }, body: "Closes #1", action: "synchronize" }),
    });
    expect(seen.merged).toBe(false);

    // Engage the merge-precision breaker for this exact repo BEFORE CI resolves — mirrors how runSelfTuneBreaker
    // (or a human) would set it via system_flags ahead of the next re-review.
    await env.DB.prepare("INSERT OR REPLACE INTO system_flags (key, value, updated_at) VALUES ('holdonly:JSONbored/gittensory', '1', CURRENT_TIMESTAMP)").run();
    resetMetrics();

    // Step 2: CI finishes; a check_suite.completed webhook re-triggers the pipeline — without the breaker this
    // would merge exactly like the sibling convergence-chain test above; the engaged breaker withholds it instead.
    ciState = "passed";
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "conv-holdonly-2",
      eventName: "check_suite",
      payload: {
        action: "completed",
        installation: { id: INSTALLATION_ID, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: REPO, private: false, owner: { login: "JSONbored" } },
        check_suite: { head_sha: "conv65", conclusion: "success", pull_requests: [{ number: 65 }] },
      } as never,
    });

    expect(seen.merged).toBe(false);
    const mergeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.merge'").first<{ n: number }>();
    expect(mergeAudit?.n).toBe(0);
    expect(await renderMetrics()).toContain('loopover_precision_breaker_downgrades_total{direction="merge"} 1');
    // #terminal-outcome-audit: the ALWAYS-recorded disposition counter, placed before the "nothing was planned"
    // early return -- this is the exact "hold, but no audit_events row at all" shape (the breaker downgrade
    // leaves no merge/close action) that previously had zero aggregate signal. close autonomy is unset in this
    // repo's settings (only merge/approve are configured), so it resolves to the default "observe".
    expect(await renderMetrics()).toContain('loopover_agent_disposition_total{action_class="hold",autonomy_level="observe",blocker_class="none",repo="redacted-1"} 1');
    const holdAudit = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = 'agent.action.hold' order by created_at desc limit 1").first<{ detail: string; metadata_json: string }>();
    expect(holdAudit?.detail).toBe("auto-action held by precision circuit breaker");
    expect(JSON.parse(holdAudit?.metadata_json ?? "{}")).toMatchObject({
      repoFullName: REPO,
      pullNumber: 65,
      gateConclusion: "success",
      ciState: "passed",
      disposition: { actionClass: "hold", blockerClass: "none" },
      plannedActionClasses: ["merge"],
      finalActionClasses: ["label"],
    });
  });

  it("reviewCheckMode: disabled still auto-merges a green PR via the general heuristic path, with ZERO check-run API calls (#2852)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupAutoActionRepo(env, { autonomy: { merge: "auto", approve: "auto" }, linkedIssueGateMode: "off", reviewCheckMode: "disabled" });
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
    const seen = { closed: false, merged: false };
    let checkRunApiCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (/\/check-runs(?:\/|\?|$)/.test(url) && (method === "POST" || method === "PATCH")) checkRunApiCalls += 1;
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url === "https://api.github.com/graphql") return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/64/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/pulls/64/reviews")) return Response.json([]);
      if (url.includes("/pulls/64/commits")) return Response.json([]);
      if (url.endsWith("/pulls/64/merge") && method === "PUT") {
        seen.merged = true;
        return Response.json({ merged: true });
      }
      if (url.endsWith("/pulls/64")) return Response.json({ number: 64, state: "open", user: { login: "contributor" }, head: { sha: "conv64" }, mergeable_state: "clean" });
      if (url.includes("/commits/conv64/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "CI", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
      if (url.includes("/commits/conv64/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/64/labels")) return Response.json([]);
      if (url.includes("/issues/64/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "conv-disabled-merge",
      eventName: "pull_request",
      payload: prPayload({ number: 64, head: { sha: "conv64" }, body: "Closes #1" }),
    });

    expect(seen.merged).toBe(true);
    expect(checkRunApiCalls).toBe(0);
    const mergeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.merge'").first<{ n: number }>();
    expect(mergeAudit?.n).toBeGreaterThanOrEqual(1);
  });

  it("reviewCheckMode: disabled still auto-merges an AUTHOR-LESS (ghost) PR when autonomy is configured (#2852)", async () => {
    // A ghost PR (no `user` at all -> authorLogin null) is the one other early-return in
    // maybePublishPrPublicSurface gated on gateEnabled (`if (!author && !gateEnabled && !autonomyNeedsGateEvaluation)
    // return undefined;`) -- proves autonomyNeedsGateEvaluation also keeps THIS guard from bailing.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupAutoActionRepo(env, { autonomy: { merge: "auto", approve: "auto" }, linkedIssueGateMode: "off", reviewCheckMode: "disabled" });
    const seen = { closed: false, merged: false };
    let checkRunApiCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (/\/check-runs(?:\/|\?|$)/.test(url) && (method === "POST" || method === "PATCH")) checkRunApiCalls += 1;
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url === "https://api.github.com/graphql") return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/67/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/pulls/67/reviews")) return Response.json([]);
      if (url.includes("/pulls/67/commits")) return Response.json([]);
      if (url.endsWith("/pulls/67/merge") && method === "PUT") {
        seen.merged = true;
        return Response.json({ merged: true });
      }
      if (url.endsWith("/pulls/67")) return Response.json({ number: 67, state: "open", head: { sha: "conv67" }, mergeable_state: "clean" });
      if (url.includes("/commits/conv67/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "CI", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
      if (url.includes("/commits/conv67/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/67/labels")) return Response.json([]);
      if (url.includes("/issues/67/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "conv-disabled-ghost-author",
      eventName: "pull_request",
      payload: prPayload({ number: 67, head: { sha: "conv67" }, body: "Closes #1", user: undefined }),
    });

    expect(seen.merged).toBe(true);
    expect(checkRunApiCalls).toBe(0);
  });

  it("an author-less (ghost) PR with the check-run disabled and NO autonomy configured stays fully silent (early-return preserved)", async () => {
    // Mirrors the ghost-PR test above but WITHOUT autonomy configured -- proves the early return in
    // maybePublishPrPublicSurface still fires (bails to undefined, no work at all) when neither gateEnabled nor
    // autonomyNeedsGateEvaluation applies, exactly as before #2852.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupAutoActionRepo(env, { reviewCheckMode: "disabled" }); // autonomy defaults to {} (unconfigured)
    let checkRunApiCalls = 0;
    let mergeAttempted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (/\/check-runs(?:\/|\?|$)/.test(url) && (method === "POST" || method === "PATCH")) checkRunApiCalls += 1;
      if (url.endsWith("/pulls/68/merge")) mergeAttempted = true;
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "ghost-no-autonomy",
      eventName: "pull_request",
      payload: prPayload({ number: 68, head: { sha: "conv68" }, body: "no linked issue here", user: undefined }),
    });

    expect(checkRunApiCalls).toBe(0);
    expect(mergeAttempted).toBe(false);
  });

  it("reviewCheckMode: disabled still posts the sticky PR comment and label (public surface is independent of the check-run publish decision) (#2852)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupAutoActionRepo(env, {
      autonomy: { merge: "auto", approve: "auto" },
      linkedIssueGateMode: "off",
      reviewCheckMode: "disabled",
      commentMode: "all_prs",
      publicSurface: "comment_and_label",
    });
    let checkRunApiCalls = 0;
    let commentPosted = false;
    let labelApplied = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (/\/check-runs(?:\/|\?|$)/.test(url) && (method === "POST" || method === "PATCH")) checkRunApiCalls += 1;
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url === "https://api.github.com/graphql") return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/65/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/pulls/65/reviews")) return Response.json([]);
      if (url.includes("/pulls/65/commits")) return Response.json([]);
      if (url.endsWith("/pulls/65")) return Response.json({ number: 65, state: "open", user: { login: "contributor" }, head: { sha: "conv65" }, mergeable_state: "clean" });
      if (url.includes("/commits/conv65/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "CI", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
      if (url.includes("/commits/conv65/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/65/comments") && method === "POST") {
        commentPosted = true;
        return Response.json({ id: 1 });
      }
      if (url.includes("/issues/65/labels") && method === "POST") {
        labelApplied = true;
        return Response.json([]);
      }
      if (url.includes("/issues/65/comments") || url.includes("/issues/65/labels")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "conv-disabled-surface",
      eventName: "pull_request",
      payload: prPayload({ number: 65, head: { sha: "conv65" }, body: "Closes #1" }),
    });

    expect(checkRunApiCalls).toBe(0);
    expect(commentPosted).toBe(true);
    expect(labelApplied).toBe(true);
  });

  it("REGRESSION: closeOwnerAuthors=false (default) protects an owner-authored blocked PR from the general heuristic-close path", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupAutoActionRepo(env, { autonomy: { close: "auto" } }); // closeOwnerAuthors defaults false
    const seen = { closed: false, merged: false };
    stubPrFetch(63, "conv63", seen);

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "conv-owner-protected",
      eventName: "pull_request",
      payload: prPayload({ number: 63, head: { sha: "conv63" }, user: { login: "JSONbored" } }), // author = repo owner
    });

    expect(seen.closed).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBe(0);
    // Enriched hold-audit fields (#selfhost-holdplan-audit): this scenario's gate blocker (missing linked issue)
    // already produced a specific "protected author" detail before this change -- what's new here is that
    // `metadata` now ALSO carries the structured closeEligible/closeAutonomy/protectedAuthor fields, so a hold
    // is debuggable from the audit table alone. The actual bug fix -- a RED-CI hold (no gate blocker at all)
    // gaining the same protected-author/close-autonomy disambiguation the gate-blocker branch already had --
    // is unit-tested directly against agentHoldAuditDetail in precision-breakers-chain.test.ts, where the two
    // branches can be exercised independently without needing a webhook fixture that produces CI-failed with
    // zero gate blockers.
    const holdAudit = await env.DB.prepare("select detail, metadata_json from audit_events where event_type = 'agent.action.hold' order by created_at desc limit 1").first<{ detail: string; metadata_json: string }>();
    expect(holdAudit?.detail).toBe("close withheld for protected author on gate blocker missing_linked_issue");
    expect(JSON.parse(holdAudit?.metadata_json ?? "{}")).toMatchObject({
      repoFullName: "JSONbored/gittensory",
      pullNumber: 63,
      closeEligible: false,
      closeAutonomy: "auto",
      // The repo owner is also treated as an admin (GitHub's own collaborator-permission model), so both flags
      // are true for this fixture -- only `automation` is meaningfully independent of `owner` here.
      protectedAuthor: { owner: true, admin: true, automation: false },
      closeOwnerAuthors: false,
    });
  });

  it("REGRESSION: closeOwnerAuthors=true allows the general heuristic-close path to close a blocked owner-authored PR", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupAutoActionRepo(env, { autonomy: { close: "auto" }, closeOwnerAuthors: true });
    const seen = { closed: false, merged: false };
    stubPrFetch(64, "conv64", seen);

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "conv-owner-allowed",
      eventName: "pull_request",
      payload: prPayload({ number: 64, head: { sha: "conv64" }, user: { login: "JSONbored" } }),
    });

    expect(seen.closed).toBe(true);
  });

  it("REGRESSION (#2133): an ADMIN_GITHUB_LOGINS fleet-operator author is exempt from the general heuristic-close path, same as the literal repo owner", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), ADMIN_GITHUB_LOGINS: "admin-user" });
    await setupAutoActionRepo(env, { autonomy: { close: "auto" } }); // closeOwnerAuthors defaults false
    const seen = { closed: false, merged: false };
    stubPrFetch(65, "conv65", seen);

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "conv-admin-protected",
      eventName: "pull_request",
      payload: prPayload({ number: 65, head: { sha: "conv65" }, user: { login: "admin-user" } }),
    });

    expect(seen.closed).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBe(0);
  });
});

// #automation-bot-skip: waste elimination for known automation authors (release-please's github-actions[bot],
// Renovate, Dependabot). End-to-end wiring on top of automation-bot-skip.test.ts's pure-function coverage --
// these pin the webhook + re-entry integration points, including the SECURITY property that a human pushing
// to an existing bot PR's branch still gets full review of their own commits.
describe("automation-bot-skip: end-to-end webhook + re-entry wiring (#automation-bot-skip)", () => {
  const basePayload = {
    installation: { id: 9101, account: { login: "owner", id: 1, type: "Organization" } },
    repository: { name: "bot-skip-repo", full_name: "owner/bot-skip-repo", private: false, owner: { login: "owner" } },
  };

  // resolveRepositorySettings itself probes for a config-as-code override (.gittensory.yml/.json in both the
  // repo root and .github/) BEFORE the skip check can even run (it needs the resolved settings for the
  // per-repo override) -- so those 4 raw.githubusercontent.com probes are unavoidable, pre-existing overhead
  // on EVERY webhook, not the "waste" this feature eliminates. The real signal is that NOTHING beyond that
  // touches the actual GitHub REST API (api.github.com) -- no installation-token fetch, no PR/files read, no
  // comment/check-run publish, no AI provider call.
  async function fetchCallTracker(livePulls: Record<number, { sha: string; state?: string }> = {}) {
    const state = { urls: [] as string[] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      state.urls.push(url);
      const match = /\/repos\/owner\/bot-skip-repo\/pulls\/(\d+)$/.exec(url);
      if (match) {
        const live = livePulls[Number(match[1])];
        if (live) {
          return Response.json({
            number: Number(match[1]),
            title: "chore(deps): bump baz",
            state: live.state ?? "open",
            user: { login: "renovate[bot]", type: "Bot" },
            head: { sha: live.sha },
            labels: [],
            body: "",
          });
        }
      }
      return new Response("not found", { status: 404 });
    });
    return state;
  }

  it("a genuine bot-triggered PR (sender IS the bot, matching the stored author) is skipped entirely: audited, zero GitHub/AI fetch calls, delivery marked processed", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    const calls = await fetchCallTracker();

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "bot-skip-genuine",
      eventName: "pull_request",
      payload: {
        action: "opened",
        ...basePayload,
        sender: { login: "renovate[bot]", type: "Bot" },
        pull_request: { number: 401, title: "chore(deps): bump foo", state: "open", user: { login: "renovate[bot]", type: "Bot" }, labels: [], body: "" },
      },
    });

    expect(calls.urls.some((url) => url.includes("api.github.com"))).toBe(false);
    const skipAudit = await env.DB.prepare("select detail, actor from audit_events where event_type = 'github_app.automation_bot_pr_skipped' and target_key = 'owner/bot-skip-repo#401'").first<{ detail: string; actor: string }>();
    expect(skipAudit?.actor).toBe("renovate[bot]");
    expect(skipAudit?.detail).toContain("automation-bot author");
    const webhookEvent = await env.DB.prepare("select status from webhook_events where delivery_id = 'bot-skip-genuine'").first<{ status: string }>();
    expect(webhookEvent?.status).toBe("processed");
  });

  it("SECURITY: a human who pushes to an existing bot-authored PR's branch (synchronize) is NOT skipped -- the live webhook actor, not the stored author, gates the skip", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await fetchCallTracker();

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "bot-skip-exploit-attempt",
      eventName: "pull_request",
      payload: {
        action: "synchronize",
        ...basePayload,
        sender: { login: "malicious-contributor", type: "User" },
        pull_request: { number: 402, title: "chore(deps): bump foo", state: "open", user: { login: "renovate[bot]", type: "Bot" }, labels: [], body: "", head: { sha: "hijacked-sha" } },
      },
    });

    const skipAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.automation_bot_pr_skipped' and target_key = 'owner/bot-skip-repo#402'").first<{ n: number }>();
    expect(skipAudit?.n).toBe(0);
  });

  it("a per-repo 'off' override forces full review even for a genuine bot-triggered PR", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await fetchCallTracker();
    await upsertRepositorySettings(env, { repoFullName: "owner/bot-skip-repo", skipAutomationBotAuthors: "off" });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "bot-skip-repo-off-override",
      eventName: "pull_request",
      payload: {
        action: "opened",
        ...basePayload,
        sender: { login: "dependabot[bot]", type: "Bot" },
        pull_request: { number: 403, title: "chore(deps): bump bar", state: "open", user: { login: "dependabot[bot]", type: "Bot" }, labels: [], body: "" },
      },
    });

    const skipAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.automation_bot_pr_skipped' and target_key = 'owner/bot-skip-repo#403'").first<{ n: number }>();
    expect(skipAudit?.n).toBe(0);
  });

  it("a per-repo 'enabled' override skips a genuine bot-triggered PR even when the global default is OFF", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_SKIP_AUTOMATION_BOT_PRS: "false" });
    const calls = await fetchCallTracker();
    await upsertRepositorySettings(env, { repoFullName: "owner/bot-skip-repo", skipAutomationBotAuthors: "enabled" });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "bot-skip-repo-enabled-override",
      eventName: "pull_request",
      payload: {
        action: "opened",
        ...basePayload,
        sender: { login: "github-actions[bot]", type: "Bot" },
        pull_request: { number: 404, title: "chore(release): 1.2.3", state: "open", user: { login: "github-actions[bot]", type: "Bot" }, labels: [], body: "" },
      },
    });

    expect(calls.urls.some((url) => url.includes("api.github.com"))).toBe(false);
    const skipAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.automation_bot_pr_skipped' and target_key = 'owner/bot-skip-repo#404'").first<{ n: number }>();
    expect(skipAudit?.n).toBe(1);
  });

  it("the re-entry sweep path (agent-regate-pr) only skips a stored bot author after the live resync proves the head is unchanged", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9101, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "bot-skip-repo", full_name: "owner/bot-skip-repo", private: false, owner: { login: "owner" } }, 9101);
    await upsertPullRequestFromGitHub(env, "owner/bot-skip-repo", { number: 405, title: "chore(deps): bump baz", state: "open", user: { login: "renovate[bot]", type: "Bot" }, head: { sha: "sha405" }, labels: [], body: "" });
    const calls = await fetchCallTracker({ 405: { sha: "sha405" } });

    await processJob(env, { type: "agent-regate-pr", deliveryId: "bot-skip-sweep", repoFullName: "owner/bot-skip-repo", prNumber: 405, installationId: 9101 });

    // The actorless re-entry path must pay for the live-head resync before trusting a stored bot author; once the
    // live head matches the stored head, it can still skip the later review/comment/check-run work.
    expect(calls.urls.some((url) => url.endsWith("/repos/owner/bot-skip-repo/pulls/405"))).toBe(true);
    const stored = await getPullRequest(env, "owner/bot-skip-repo", 405);
    expect(stored?.headSha).toBe("sha405");
  });

  it("SECURITY: actorless re-entry does not skip a stored bot author when the live head drifted", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, { action: "created", installation: { id: 9101, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] } });
    await upsertRepositoryFromGitHub(env, { name: "bot-skip-repo", full_name: "owner/bot-skip-repo", private: false, owner: { login: "owner" } }, 9101);
    await upsertPullRequestFromGitHub(env, "owner/bot-skip-repo", { number: 406, title: "chore(deps): bump baz", state: "open", user: { login: "renovate[bot]", type: "Bot" }, head: { sha: "bot-recorded-sha" }, labels: [], body: "" });
    const calls = await fetchCallTracker({ 406: { sha: "human-pushed-sha" } });

    await processJob(env, { type: "agent-regate-pr", deliveryId: "bot-skip-sweep-drift", repoFullName: "owner/bot-skip-repo", prNumber: 406, installationId: 9101 });

    expect(calls.urls.some((url) => url.endsWith("/repos/owner/bot-skip-repo/pulls/406"))).toBe(true);
    const stored = await getPullRequest(env, "owner/bot-skip-repo", 406);
    expect(stored?.headSha).toBe("human-pushed-sha");
  });
});

