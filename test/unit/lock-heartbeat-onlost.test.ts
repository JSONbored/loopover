import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearInstallationTokenCacheForTest } from "../../src/github/app";
import { clearReviewSuppressionCacheForTest } from "../../src/review/review-memory-wire";
import * as backfillModule from "../../src/github/backfill";
import * as repositoriesModule from "../../src/db/repositories";
import {
  upsertInstallation,
  upsertPullRequestFromGitHub,
  upsertRepositoryFromGitHub,
  upsertRepositorySettings,
} from "../../src/db/repositories";
import { processJob } from "../../src/queue/processors";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { fetchPullRequestFreshness } from "../../src/github/pr-freshness";
import { createTestEnv } from "../helpers/d1";
import { generatePrivateKeyPem } from "../helpers/github-app-key";

// #10019: `startLockHeartbeat`'s own renew/interval/fail-open mechanics are already exhaustively covered by
// `test/unit/transient-locks.test.ts` (INVARIANT/REGRESSION/fail-open cases). What was never wired -- and what
// this file tests -- is the CALLER side: do the two production heartbeats at src/queue/processors.ts actually
// pass an `onLost` handler, and does that handler make the pass abort/discard instead of actuating? Driving
// this through a real `setInterval` would require advancing real (600s/1800s) TTL-derived intervals, which
// `startLockHeartbeat`'s own tests already do with fake timers -- doing it again here would only re-test the
// heartbeat, not the wiring. Mocking `startLockHeartbeat` down to a synchronous `onLost()` trigger isolates
// exactly the new code: the flag it sets, and what the pass does with that flag.
const h = vi.hoisted(() => ({
  fireActuationOnLost: false,
  fireAiReviewOnLost: false,
}));

vi.mock("../../src/queue/transient-locks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/queue/transient-locks")>();
  return {
    ...actual,
    startLockHeartbeat: vi.fn(
      (
        _env: Env,
        key: string,
        _ownerToken: string | null,
        _ttlSeconds: number,
        options?: { onLost?: () => void },
      ) => {
        if (key.startsWith("pr-actuation-lock:") && h.fireActuationOnLost) options?.onLost?.();
        if (key.startsWith("ai-review-lock:") && h.fireAiReviewOnLost) options?.onLost?.();
        return { stop: vi.fn() };
      },
    ),
  };
});

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

describe("lock-heartbeat onLost wiring at the production call sites (#10019)", () => {
  beforeEach(() => {
    clearInstallationTokenCacheForTest();
    clearReviewSuppressionCacheForTest();
    vi.mocked(fetchPullRequestFreshness).mockClear();
    h.fireActuationOnLost = false;
    h.fireAiReviewOnLost = false;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-28T00:00:00.000Z"));
    // Deterministic "CI green" for every scenario here -- none of these tests are about CI-aggregation
    // behavior, and leaving it to the raw check-runs/status/check-suites fetch mocks below is exactly the kind
    // of incidental coupling that makes an unrelated gate input flip the merge/no-merge outcome.
    vi.spyOn(backfillModule, "fetchRequiredStatusContexts").mockResolvedValue(null);
    vi.spyOn(backfillModule, "fetchLiveCiAggregatePreferGraphQl").mockResolvedValue({
      ciState: "passed",
      hasPending: false,
      hasVisiblePending: false,
      hasMissingRequiredContext: false,
      failingDetails: [],
      nonRequiredFailingDetails: [],
      advisoryHoldDetails: [],
      ignoredCheckDetails: [],
      ciCompletenessWarning: null,
    });
    // The planning pass's CI read above is separate from the live re-check agent-action-executor.ts does right
    // before actuating a merge (a check flipping between planning and actuation must invalidate the plan) --
    // both need to agree "passed" or the merge step itself denies the action, independent of the lock behavior
    // these tests are actually about.
    vi.spyOn(backfillModule, "fetchLiveCiAggregate").mockResolvedValue({
      ciState: "passed",
      hasPending: false,
      hasVisiblePending: false,
      hasMissingRequiredContext: false,
      failingDetails: [],
      nonRequiredFailingDetails: [],
      advisoryHoldDetails: [],
      ignoredCheckDetails: [],
      ciCompletenessWarning: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("actuation lock lost mid-pass: the publish-and-maintain unit throws PrActuationLockContendedError instead of merging", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await upsertInstallation(env, {
      action: "created",
      installation: { id: 9001, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" }, events: [] },
    });
    await upsertRepositoryFromGitHub(env, { name: "act-repo", full_name: "owner/act-repo", private: false, owner: { login: "owner" } }, 9001);
    await upsertRepositorySettings(env, { repoFullName: "owner/act-repo", autonomy: { merge: "auto" }, gatePack: "oss-anti-slop" });
    await upsertRepoFocusManifest(env, "owner/act-repo", { settings: { checkRunMode: "off", commentMode: "off", publicSurface: "off", aiReviewMode: "off", reviewCheckMode: "required", autoMaintain: { requireApprovals: 0, mergeMethod: "squash" } } });
    await upsertPullRequestFromGitHub(env, "owner/act-repo", { number: 41, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a41" }, labels: [], body: "Closes #1" });
    let mergeCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/41/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/pulls/41/merge")) {
        mergeCalls += 1;
        return new Response(null, { status: 204 });
      }
      if (url.includes("/pulls/41/reviews") && init?.method === "POST") return Response.json({ id: 1 });
      if (url.includes("/pulls/41/reviews")) return Response.json([]);
      if (/\/pulls\/41(\?|$)/.test(url)) return Response.json({ number: 41, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a41" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/a41/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a41/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/a41/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      if (url.includes(".loopover.yml")) return new Response("Not Found", { status: 404 });
      if (url.endsWith("/check-runs") && init?.method === "POST") return Response.json({ id: 1 });
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.endsWith("/graphql")) return Response.json({ data: {} });
      return Response.json({});
    });

    h.fireActuationOnLost = true;
    await expect(
      processJob(env, { type: "agent-regate-pr", deliveryId: "actuation-lock-lost", repoFullName: "owner/act-repo", prNumber: 41, installationId: 9001 }),
    ).rejects.toMatchObject({ name: "PrActuationLockContendedError", retryKind: "pr_actuation_lock_contended" });

    // Lost mid-flight, not merely contended at claim time: the lock WAS acquired (publish ran), but the
    // heartbeat's onLost aborted the pass before the maintenance section's irreversible merge/close mutation.
    expect(mergeCalls).toBe(0);
    expect(
      errorSpy.mock.calls.some(([line]) => typeof line === "string" && line.includes('"event":"pr_actuation_lock_lost"') && line.includes("owner/act-repo")),
    ).toBe(true);
  });

  it("actuation lock NOT lost (regression): the heartbeat firing never / onLost absent leaves the pass merging exactly as before", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      action: "created",
      installation: { id: 9002, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" }, events: [] },
    });
    await upsertRepositoryFromGitHub(env, { name: "act-repo-2", full_name: "owner/act-repo-2", private: false, owner: { login: "owner" } }, 9002);
    await upsertRepositorySettings(env, { repoFullName: "owner/act-repo-2", autonomy: { merge: "auto" }, gatePack: "oss-anti-slop" });
    await upsertRepoFocusManifest(env, "owner/act-repo-2", { settings: { checkRunMode: "off", commentMode: "off", publicSurface: "off", aiReviewMode: "off", reviewCheckMode: "required", autoMaintain: { requireApprovals: 0, mergeMethod: "squash" } } });
    await upsertPullRequestFromGitHub(env, "owner/act-repo-2", { number: 42, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a42" }, labels: [], body: "Closes #1" });
    let mergeCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/42/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/pulls/42/merge")) {
        mergeCalls += 1;
        return new Response(null, { status: 204 });
      }
      if (url.includes("/pulls/42/reviews") && init?.method === "POST") return Response.json({ id: 1 });
      if (url.includes("/pulls/42/reviews")) return Response.json([]);
      if (/\/pulls\/42(\?|$)/.test(url)) return Response.json({ number: 42, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a42" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/a42/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a42/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/a42/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      if (url.includes(".loopover.yml")) return new Response("Not Found", { status: 404 });
      if (url.endsWith("/check-runs") && init?.method === "POST") return Response.json({ id: 1 });
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.endsWith("/graphql")) return Response.json({ data: {} });
      return Response.json({});
    });

    // h.fireActuationOnLost stays false (default) -- the fail-open posture (an adapter without renewIfValue, or
    // a renewal that keeps confirming ownership) never calls onLost. Nothing here should differ from the
    // pre-#10019 behavior: the pass completes and actuates normally.
    await expect(
      processJob(env, { type: "agent-regate-pr", deliveryId: "actuation-lock-not-lost", repoFullName: "owner/act-repo-2", prNumber: 42, installationId: 9002 }),
    ).resolves.toBeUndefined();
    expect(mergeCalls).toBeGreaterThan(0);
  });

  it("AI-review lock lost mid-review: the pass discards its verdict for the lock-contended placeholder and never writes ai_review_cache", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const putCachedAiReviewSpy = vi.spyOn(repositoriesModule, "putCachedAiReview");
    await upsertInstallation(env, {
      action: "created",
      installation: { id: 9003, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" }, events: [] },
    });
    await upsertRepositoryFromGitHub(env, { name: "ai-repo", full_name: "owner/ai-repo", private: false, owner: { login: "owner" } }, 9003);
    await upsertRepositorySettings(env, { repoFullName: "owner/ai-repo", autonomy: { close: "auto", merge: "auto" }, gatePack: "oss-anti-slop" });
    await upsertRepoFocusManifest(env, "owner/ai-repo", { settings: { checkRunMode: "off", commentMode: "off", publicSurface: "off", reviewCheckMode: "required", aiReviewMode: "block", autoMaintain: { requireApprovals: 0, mergeMethod: "squash" } } });
    await upsertPullRequestFromGitHub(env, "owner/ai-repo", { number: 55, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a55" }, labels: [], body: "Closes #1" });
    let mergeCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/pulls/55/merge")) {
        mergeCalls += 1;
        return new Response(null, { status: 204 });
      }
      if (url.includes("/pulls/55/reviews") && method === "POST") return Response.json({ id: 1 });
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (/\/pulls\/55(\?|$)/.test(url)) return Response.json({ number: 55, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a55" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/a55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/a55/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      if (url.includes(".loopover.yml")) return new Response("Not Found", { status: 404 });
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 1 });
      if (url.endsWith("/graphql")) return Response.json({ data: {} });
      return Response.json({});
    });

    h.fireAiReviewOnLost = true;
    await expect(
      processJob(env, { type: "agent-regate-pr", deliveryId: "ai-review-lock-lost", repoFullName: "owner/ai-repo", prNumber: 55, installationId: 9003 }),
    ).resolves.toBeUndefined();

    // The LLM call genuinely ran (this is the fresh-review path, not the never-acquired short-circuit), but its
    // result was discarded once the heartbeat reported the lock lost -- so nothing was ever written to the cache.
    expect(aiCalls).toBeGreaterThan(0);
    expect(putCachedAiReviewSpy).not.toHaveBeenCalled();
    // The lock-contended placeholder holds the gate, so the losing pass never merges either.
    expect(mergeCalls).toBe(0);
    expect(
      errorSpy.mock.calls.some(([line]) => typeof line === "string" && line.includes('"event":"ai_review_lock_lost"') && line.includes("owner/ai-repo")),
    ).toBe(true);
  });

  it("AI-review lock NOT lost (regression): a completed pass with no onLost fired still writes ai_review_cache exactly as before", async () => {
    let aiCalls = 0;
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    const putCachedAiReviewSpy = vi.spyOn(repositoriesModule, "putCachedAiReview");
    await upsertInstallation(env, {
      action: "created",
      installation: { id: 9004, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" }, events: [] },
    });
    await upsertRepositoryFromGitHub(env, { name: "ai-repo-2", full_name: "owner/ai-repo-2", private: false, owner: { login: "owner" } }, 9004);
    await upsertRepositorySettings(env, { repoFullName: "owner/ai-repo-2", autonomy: { close: "auto", merge: "auto" }, gatePack: "oss-anti-slop" });
    await upsertRepoFocusManifest(env, "owner/ai-repo-2", { settings: { checkRunMode: "off", commentMode: "off", publicSurface: "off", reviewCheckMode: "required", aiReviewMode: "block", autoMaintain: { requireApprovals: 0, mergeMethod: "squash" } } });
    await upsertPullRequestFromGitHub(env, "owner/ai-repo-2", { number: 56, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a56" }, labels: [], body: "Closes #1" });
    let mergeCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/56/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
      if (url.includes("/pulls/56/merge")) {
        mergeCalls += 1;
        return new Response(null, { status: 204 });
      }
      if (url.includes("/pulls/56/reviews") && method === "POST") return Response.json({ id: 1 });
      if (url.includes("/pulls/56/reviews")) return Response.json([]);
      if (/\/pulls\/56(\?|$)/.test(url)) return Response.json({ number: 56, title: "Clean PR", state: "open", user: { login: "contributor" }, head: { sha: "a56" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/commits/a56/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/a56/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/a56/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      if (url.includes(".loopover.yml")) return new Response("Not Found", { status: 404 });
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 1 });
      if (url.endsWith("/graphql")) return Response.json({ data: {} });
      return Response.json({});
    });

    // Both flags stay false: neither heartbeat's onLost fires, so this must behave byte-identically to the
    // pre-#10019 pass -- a fresh review that persists, and a gate-clean merge.
    await expect(
      processJob(env, { type: "agent-regate-pr", deliveryId: "ai-review-lock-not-lost", repoFullName: "owner/ai-repo-2", prNumber: 56, installationId: 9004 }),
    ).resolves.toBeUndefined();

    expect(aiCalls).toBeGreaterThan(0);
    expect(putCachedAiReviewSpy).toHaveBeenCalledTimes(1);
    expect(mergeCalls).toBeGreaterThan(0);
  });
});
