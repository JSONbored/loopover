import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  upsertInstallation,
  upsertOfficialMinerDetection,
  upsertPullRequestFromGitHub,
  upsertRepositoryFromGitHub,
  upsertRepositorySettings,
} from "../../src/db/repositories";
import { processJob, reReviewStoredPullRequest } from "../../src/queue/processors";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { asCloudEnv, createTestEnv } from "../helpers/d1";
import type { GitHubWebhookPayload } from "../../src/types";
import { generatePrivateKeyPem } from "../helpers/github-app-key";

// #7626: maybeProcessPrPanelRetrigger threads forceAiReview: true into maybePublishPrPublicSurface when the
// "Re-run LoopOver review" checkbox is checked -- but ONLY when prReadyForReview can confirm readiness right
// away. When CI is still pending for the current head SHA, the handler defers and returns; before this fix,
// the user's forceAiReview intent was never persisted, so the eventual natural re-evaluation (once CI settles)
// had no idea a manual retrigger was pending and silently replayed/skipped stale content instead of forcing a
// fresh AI opinion. These tests pin the persisted pending-marker fix: mark on defer, consume (once) on the
// next readiness-confirmed pass through either reReviewStoredPullRequest or handlePullRequestWebhookEvent.

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

// Mirrors queue.test.ts's own seedRegateChurnRepo (#regate-churn) -- same manifest/registry/miner-detection
// shape already proven to drive a real AI review call in that file's freeze/force-bypass tests, duplicated
// here rather than exported/shared (matching this test suite's existing per-file duplication convention for
// small fixture helpers like generatePrivateKeyPem/queueMinerSnapshot above).
async function seedRetriggerRepo(env: Env, overrides: Partial<Parameters<typeof upsertRepositorySettings>[1]> = {}) {
  await persistRegistrySnapshot(
    asCloudEnv(env),
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
    autoLabelEnabled: false,
    gatePack: "oss-anti-slop",
    // isAgentConfigured (prReadyForReview's own first-line gate) requires SOME action class at an acting
    // autonomy level, or readiness returns true unconditionally and never even reaches the CI-wait logic
    // these tests exist to exercise. "label" is deliberately the ONLY acting class here -- merge/approve/close
    // stay at the "observe" default, so maybeRunAgentMaintenance never attempts a live merge/approve (which
    // would otherwise need fetchPullRequestFreshness + merge-endpoint mocking this suite doesn't set up).
    autonomy: { label: "auto" },
    ...overrides,
  });
  await upsertRepoFocusManifest(env, "JSONbored/gittensory", {
    settings: {
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "block",
    },
  });
  await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
}

const CHECKED_PANEL = [
  "<!-- gittensory-pr-panel:v1 -->",
  "",
  "- [x] <!-- gittensory-rerun-review:v1 --> Re-run LoopOver review",
].join("\n");

function retriggerWebhookPayload(prNumber: number, commentId: number): GitHubWebhookPayload {
  return {
    action: "edited",
    installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
    repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
    issue: { number: prNumber, title: "Retrigger PR", state: "open", user: { login: "contributor" }, pull_request: {} },
    comment: { id: commentId, body: CHECKED_PANEL, user: { login: "loopover-orb[bot]", type: "Bot" } },
    sender: { login: "maintainer", type: "User" },
  } as GitHubWebhookPayload;
}

describe("PR-panel retrigger pending force-review marker (#7626)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-20T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("REGRESSION (#7626): a retrigger deferred for pending CI still forces a fresh AI review once CI settles via reReviewStoredPullRequest, and the marker is truly one-shot", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Fresh opinion.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await seedRetriggerRepo(env);
    // Held for manual review from a PRIOR pass -- the exact production precondition (#7626): a frozen PR with
    // no reusable published review, so the retrigger's forced call is the ONLY way fresh content ever appears.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 701,
      title: "Held PR awaiting retrigger",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "shaPending" },
      base: { ref: "main" },
      labels: [{ name: "manual-review" }],
      body: "Closes #1",
    });

    let ciSettled = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" });
      if (url.includes("/pulls/701/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/701")) return Response.json({ number: 701, title: "Held PR awaiting retrigger", state: "open", user: { login: "contributor" }, head: { sha: "shaPending" }, labels: [{ name: "manual-review" }], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/shaPending/check-runs")) {
        return ciSettled
          ? Response.json({ total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] })
          : Response.json({ total_count: 1, check_runs: [{ name: "test", status: "in_progress", conclusion: null, app: { slug: "github-actions" } }] });
      }
      if (url.includes("/commits/shaPending/status")) return Response.json({ state: ciSettled ? "success" : "pending", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/issues/701/comments") && (method === "POST" || method === "PATCH")) return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/701/comments")) return Response.json([]);
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    // Step 1: the maintainer checks the panel's retrigger box while CI is still pending -- defers, and (the
    // fix) persists a pending marker for (repo, 701, "shaPending").
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "retrigger-defer-701",
      eventName: "issue_comment",
      payload: retriggerWebhookPayload(701, 501),
    });
    expect(aiCalls).toBe(0); // nothing published yet -- CI was pending, so this pass only deferred
    const deferAudit = await env.DB.prepare("select outcome from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.pr_panel_retrigger_deferred", "JSONbored/gittensory#701")
      .first<{ outcome: string }>();
    expect(deferAudit?.outcome).toBe("queued");
    // github_app.pr_panel_retriggered ("completed") is recorded unconditionally as soon as the retrigger is
    // authorized -- BEFORE readiness is even checked -- so it coexists with the "_deferred" row above from
    // this SAME step-1 call; it is not, on its own, evidence that a fresh review was actually published.
    const retriggerFamilyCountAfterStep1 = await env.DB.prepare("select count(*) as n from audit_events where event_type in (?, ?) and target_key = ?")
      .bind("github_app.pr_panel_retriggered", "github_app.pr_panel_retrigger_deferred", "JSONbored/gittensory#701")
      .first<{ n: number }>();
    expect(retriggerFamilyCountAfterStep1?.n).toBe(2);

    // Step 2: time passes, CI settles. This is the NATURAL re-evaluation path -- reReviewStoredPullRequest,
    // NOT the retrigger handler -- called with no `force` option, exactly as the real CI-completion trigger
    // (maybeReReviewOnCiCompletion) calls it. It must still honor the pending marker.
    vi.setSystemTime(new Date("2026-07-20T00:02:00.000Z")); // past the 60s durable CI-state cache window
    ciSettled = true;
    const proceeded = await reReviewStoredPullRequest(env, "ci-settle-701", 123, "JSONbored/gittensory", 701);
    expect(proceeded).toBe(true);

    expect(aiCalls).toBeGreaterThan(0); // the marker forced a genuinely fresh AI call, unfreezing the held PR
    const callsAfterForce = aiCalls;
    const bypassAudit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.ai_review_force_bypass", "JSONbored/gittensory#701")
      .first<{ outcome: string; detail: string }>();
    expect(bypassAudit?.outcome).toBe("completed");
    expect(bypassAudit?.detail).toContain("explicit force re-gate bypassed");
    // Step 2 never went through the retrigger handler itself -- no NEW retrigger-family row appeared (proves
    // the force came from the persisted marker, not from a second retrigger click).
    const retriggerFamilyCountAfterStep2 = await env.DB.prepare("select count(*) as n from audit_events where event_type in (?, ?) and target_key = ?")
      .bind("github_app.pr_panel_retriggered", "github_app.pr_panel_retrigger_deferred", "JSONbored/gittensory#701")
      .first<{ n: number }>();
    expect(retriggerFamilyCountAfterStep2?.n).toBe(retriggerFamilyCountAfterStep1?.n);

    // Step 3 (one-shot): a LATER, unrelated natural re-evaluation of the SAME still-unchanged head must NOT
    // force a second fresh AI call -- the marker was already consumed in step 2. The freeze re-applies (the
    // manual-review label is still on the stored PR row), so this reuses the review step 2 just published.
    vi.setSystemTime(new Date("2026-07-20T00:04:00.000Z"));
    const proceededAgain = await reReviewStoredPullRequest(env, "ci-settle-701-again", 123, "JSONbored/gittensory", 701);
    expect(proceededAgain).toBe(true);
    expect(aiCalls).toBe(callsAfterForce); // unchanged -- no second forced call from a leftover marker
    const frozenReuseAudit = await env.DB.prepare("select outcome from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.ai_review_frozen_reuse", "JSONbored/gittensory#701")
      .first<{ outcome: string }>();
    expect(frozenReuseAudit?.outcome).toBe("completed"); // reused the just-published review, not a fresh force
    const secondBypassCount = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.ai_review_force_bypass", "JSONbored/gittensory#701")
      .first<{ n: number }>();
    expect(secondBypassCount?.n).toBe(1); // exactly the ONE from step 2 -- never a second one
  });

  it("the retrigger's own IMMEDIATE-readiness path (CI already green) never creates a pending marker", async () => {
    class MemoryTransientCache {
      readonly values = new Map<string, string>();
      async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
      async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
      async del(key: string): Promise<void> { this.values.delete(key); }
    }
    const cache = new MemoryTransientCache();
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      SELFHOST_TRANSIENT_CACHE: cache,
    });
    await seedRetriggerRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 702,
      title: "Clean PR, CI already green",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "shaGreen702" },
      base: { ref: "main" },
      labels: [],
      body: "Closes #1",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" });
      if (url.includes("/pulls/702/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/702")) return Response.json({ number: 702, title: "Clean PR, CI already green", state: "open", user: { login: "contributor" }, head: { sha: "shaGreen702" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/shaGreen702/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
      if (url.includes("/commits/shaGreen702/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/issues/702/comments") && (method === "POST" || method === "PATCH")) return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/702/comments")) return Response.json([]);
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "retrigger-immediate-702",
      eventName: "issue_comment",
      payload: retriggerWebhookPayload(702, 502),
    });

    const retriggeredAudit = await env.DB.prepare("select outcome from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.pr_panel_retriggered", "JSONbored/gittensory#702")
      .first<{ outcome: string }>();
    expect(retriggeredAudit?.outcome).toBe("completed"); // the immediate path really did run (sanity)
    // No pending-retrigger marker was ever written -- the immediate-success path sets forceAiReview directly
    // and never touches markPendingPrPanelRetrigger (that only runs on the DEFER branch).
    expect([...cache.values.keys()].some((key) => key.startsWith("pr-panel-retrigger-pending:"))).toBe(false);
  });

  it("a new commit (different head SHA) after a pending-but-unhonored marker does not inherit the old marker's forceAiReview intent", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Fresh.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await seedRetriggerRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 703,
      title: "Retrigger then new push",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "shaA703" },
      base: { ref: "main" },
      labels: [], // NOT frozen -- this test only cares about key scoping, not the freeze mechanic
      body: "Closes #1",
    });

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" });
      if (url.includes("/pulls/703/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      // The live PR now reports the NEW head (shaB703) -- a push landed while shaA703's CI was still pending.
      if (url.endsWith("/pulls/703")) return Response.json({ number: 703, title: "Retrigger then new push", state: "open", user: { login: "contributor" }, head: { sha: "shaB703" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/shaA703/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "test", status: "in_progress", conclusion: null, app: { slug: "github-actions" } }] });
      if (url.includes("/commits/shaA703/status")) return Response.json({ state: "pending", statuses: [] });
      // The NEW head's CI is already green by the time the natural re-evaluation runs.
      if (url.includes("/commits/shaB703/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
      if (url.includes("/commits/shaB703/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/issues/703/comments") && (method === "POST" || method === "PATCH")) return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/703/comments")) return Response.json([]);
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    // Retrigger deferred on shaA703 -- persists a marker keyed to shaA703 specifically.
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "retrigger-defer-703",
      eventName: "issue_comment",
      payload: retriggerWebhookPayload(703, 503),
    });
    expect(aiCalls).toBe(0);

    // A new push lands (shaB703) BEFORE shaA703's CI ever settles. reReviewStoredPullRequest resyncs to the
    // new live head itself (#sweep-resync), so calling it directly here is the natural next evaluation.
    vi.setSystemTime(new Date("2026-07-20T00:02:00.000Z"));
    const proceeded = await reReviewStoredPullRequest(env, "new-push-703", 123, "JSONbored/gittensory", 703);
    expect(proceeded).toBe(true);

    expect(aiCalls).toBeGreaterThan(0); // a review DOES run (genuine cache miss for the new head) -- just never a FORCED one
    const forceBypass = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.ai_review_force_bypass", "JSONbored/gittensory#703")
      .first<{ n: number }>();
    expect(forceBypass?.n).toBe(0); // the OLD shaA703 marker never carried forward to shaB703
    const cacheMiss = await env.DB.prepare("select outcome from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.ai_review_cache_miss", "JSONbored/gittensory#703")
      .first<{ outcome: string }>();
    expect(cacheMiss?.outcome).toBe("completed"); // an ordinary cache miss, not a force
  });

  it("handlePullRequestWebhookEvent (the OTHER natural re-evaluation entry point) also consumes a pending marker", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Fresh via webhook.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await seedRetriggerRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 704,
      title: "Held PR, webhook re-evaluation",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "shaPending704" },
      base: { ref: "main" },
      labels: [{ name: "manual-review" }],
      body: "Closes #1",
    });

    let ciSettled = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" });
      if (url.includes("/pulls/704/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/pulls/704/reviews")) return Response.json([]);
      if (url.endsWith("/pulls/704")) return Response.json({ number: 704, title: "Held PR, webhook re-evaluation", state: "open", user: { login: "contributor" }, head: { sha: "shaPending704" }, labels: [{ name: "manual-review" }], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/shaPending704/check-runs")) {
        return ciSettled
          ? Response.json({ total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] })
          : Response.json({ total_count: 1, check_runs: [{ name: "test", status: "in_progress", conclusion: null, app: { slug: "github-actions" } }] });
      }
      if (url.includes("/commits/shaPending704/status")) return Response.json({ state: ciSettled ? "success" : "pending", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/issues/704/comments") && (method === "POST" || method === "PATCH")) return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/704/comments")) return Response.json([]);
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "retrigger-defer-704",
      eventName: "issue_comment",
      payload: retriggerWebhookPayload(704, 504),
    });
    expect(aiCalls).toBe(0);

    // Natural re-evaluation via the OTHER entry point: an ordinary `pull_request` webhook (e.g. a title edit)
    // on the SAME still-unchanged head, once CI has settled -- handlePullRequestWebhookEvent's own inline
    // readiness -> public-surface sequence, never touching reReviewStoredPullRequest at all.
    vi.setSystemTime(new Date("2026-07-20T00:02:00.000Z"));
    ciSettled = true;
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "webhook-ci-settle-704",
      eventName: "pull_request",
      payload: {
        action: "edited",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 704, title: "Held PR, webhook re-evaluation", state: "open", user: { login: "contributor" }, head: { sha: "shaPending704" }, base: { ref: "main" }, labels: [{ name: "manual-review" }], body: "Closes #1" },
      } as GitHubWebhookPayload,
    });

    expect(aiCalls).toBeGreaterThan(0); // the OTHER entry point also honored the pending marker
    const bypassAudit = await env.DB.prepare("select outcome from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.ai_review_force_bypass", "JSONbored/gittensory#704")
      .first<{ outcome: string }>();
    expect(bypassAudit?.outcome).toBe("completed");
  });

  it("storage-unavailable fail-open: a throwing transient cache never blocks the PR and never forces a re-review it can't actually persist", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Normal.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
      SELFHOST_TRANSIENT_CACHE: {
        get: async () => { throw new Error("Redis unavailable"); },
        set: async () => { throw new Error("Redis unavailable"); },
      },
    });
    await seedRetriggerRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 705,
      title: "Storage down throughout",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "shaPending705" },
      base: { ref: "main" },
      labels: [], // no freeze -- isolates the storage-unavailable behavior from the freeze mechanic
      body: "Closes #1",
    });

    let ciSettled = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" });
      if (url.includes("/pulls/705/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/705")) return Response.json({ number: 705, title: "Storage down throughout", state: "open", user: { login: "contributor" }, head: { sha: "shaPending705" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/shaPending705/check-runs")) {
        return ciSettled
          ? Response.json({ total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] })
          : Response.json({ total_count: 1, check_runs: [{ name: "test", status: "in_progress", conclusion: null, app: { slug: "github-actions" } }] });
      }
      if (url.includes("/commits/shaPending705/status")) return Response.json({ state: ciSettled ? "success" : "pending", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/issues/705/comments") && (method === "POST" || method === "PATCH")) return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/705/comments")) return Response.json([]);
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    // Defer while CI pending -- markPendingPrPanelRetrigger's write throws internally but is swallowed
    // (putTransientKey is already fail-safe); the defer itself must still complete normally.
    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "retrigger-defer-705",
        eventName: "issue_comment",
        payload: retriggerWebhookPayload(705, 505),
      }),
    ).resolves.toBeUndefined();
    const deferAudit = await env.DB.prepare("select outcome from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.pr_panel_retrigger_deferred", "JSONbored/gittensory#705")
      .first<{ outcome: string }>();
    expect(deferAudit?.outcome).toBe("queued");

    // Natural re-evaluation once CI settles: consumePendingPrPanelRetrigger's own read throws too (same
    // unavailable cache) and must degrade to "no pending marker" rather than propagating the error.
    vi.setSystemTime(new Date("2026-07-20T00:02:00.000Z"));
    ciSettled = true;
    await expect(
      reReviewStoredPullRequest(env, "ci-settle-705", 123, "JSONbored/gittensory", 705),
    ).resolves.toBe(true); // the review pipeline still ran -- never blocked by the storage failure

    expect(aiCalls).toBeGreaterThan(0); // a review DID run (nothing was ever cached for this PR) -- just never a FORCED one
    const forceBypass = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.ai_review_force_bypass", "JSONbored/gittensory#705")
      .first<{ n: number }>();
    expect(forceBypass?.n).toBe(0); // the marker could never be read back, so this pass was an ordinary review
  });

  it("consumePendingPrPanelRetrigger's headSha guard: a stored PR with no head SHA never touches the pending-marker cache (prReadyForReview already returns true unconditionally for a headless PR)", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: {} });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { publicSurface: "off", checkRunMode: "off" } });
    // No `head` field at all -- upsertPullRequestFromGitHub stores headSha as `pr.head?.sha` (undefined here).
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 706, title: "No head yet", state: "open", user: { login: "contributor" }, labels: [], body: "" } as never);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      // The live resync GET must not report a head SHA either, or the resync branch would try to upsert.
      if (url.endsWith("/pulls/706")) return Response.json({ number: 706, state: "open" });
      return Response.json({});
    });

    // prReadyForReview's OWN `!pr.headSha` check returns true before ever touching the pending-marker cache,
    // so this resolves true (readiness genuinely reached) without any forced-review bookkeeping happening.
    await expect(
      reReviewStoredPullRequest(env, "no-head-706", 123, "JSONbored/gittensory", 706),
    ).resolves.toBe(true);
  });

  it("consume falls back to a 'consumed' sentinel overwrite when the storage adapter has no delete method", async () => {
    class NoDeleteTransientCache {
      readonly values = new Map<string, string>();
      async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
      async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
      // Deliberately NO `del` -- exercises deleteTransientKey's own no-op guard branch.
    }
    const cache = new NoDeleteTransientCache();
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      SELFHOST_TRANSIENT_CACHE: cache,
      AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Fresh.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await seedRetriggerRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 707,
      title: "No-delete adapter",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "shaPending707" },
      base: { ref: "main" },
      labels: [],
      body: "Closes #1",
    });

    let ciSettled = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/collaborators/maintainer/permission")) return Response.json({ permission: "maintain" });
      if (url.includes("/pulls/707/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.endsWith("/pulls/707")) return Response.json({ number: 707, title: "No-delete adapter", state: "open", user: { login: "contributor" }, head: { sha: "shaPending707" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/shaPending707/check-runs")) {
        return ciSettled
          ? Response.json({ total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] })
          : Response.json({ total_count: 1, check_runs: [{ name: "test", status: "in_progress", conclusion: null, app: { slug: "github-actions" } }] });
      }
      if (url.includes("/commits/shaPending707/status")) return Response.json({ state: ciSettled ? "success" : "pending", statuses: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/issues/707/comments") && (method === "POST" || method === "PATCH")) return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/707/comments")) return Response.json([]);
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "retrigger-defer-707",
      eventName: "issue_comment",
      payload: retriggerWebhookPayload(707, 507),
    });
    const pendingKey = [...cache.values.keys()].find((key) => key.startsWith("pr-panel-retrigger-pending:"));
    expect(pendingKey).toBeDefined();
    expect(cache.values.get(pendingKey as string)).toBe("1");

    vi.setSystemTime(new Date("2026-07-20T00:02:00.000Z"));
    ciSettled = true;
    await reReviewStoredPullRequest(env, "ci-settle-707", 123, "JSONbored/gittensory", 707);

    expect(aiCalls).toBeGreaterThan(0); // the marker was still honored despite the missing `del` method
    // No `del` on the adapter -- one-shot consumption falls back to overwriting the SAME key with a
    // non-matching "consumed" sentinel rather than leaving the original marker value behind.
    expect(cache.values.get(pendingKey as string)).toBe("consumed");
  });
});
