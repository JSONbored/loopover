import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { } from "node:crypto";
import { clearInstallationTokenCacheForTest } from "../../src/github/app";
import { clearReviewSuppressionCacheForTest } from "../../src/review/review-memory-wire";
import { } from "../../src/github/comments";
import * as repositoriesModule from "../../src/db/repositories";
import * as visualCaptureModule from "../../src/review/visual/capture";
import { MAX_CAPTURE_RETRY_ATTEMPTS, MAX_PREVIEW_POLL_ATTEMPTS, recordCaptureRetryAttempt } from "../../src/review/visual/preview-poll-budget";
import * as repositorySettingsModule from "../../src/settings/repository-settings";
import { } from "../../src/selfhost/queue-common";
import {
  getPullRequest,
  upsertPullRequestDetailSyncState,
  upsertIssueFromGitHub,
  upsertInstallation,
  upsertOfficialMinerDetection,
  upsertPullRequestFromGitHub,
  listOtherOpenPullRequestsForAuthor,
  upsertRepositorySettings,
  upsertRepositoryFromGitHub,
  setGlobalAgentFrozen,
} from "../../src/db/repositories";
import { processJob, } from "../../src/queue/processors";
import type { } from "../../src/types";
import { } from "../../src/review/ai-review-cache-input";
import { } from "../../src/review/review-memory-match";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import * as focusManifestLoaderModule from "../../src/signals/focus-manifest-loader";
import { } from "../../src/registry/normalize";
import { } from "../../src/registry/sync";
import {
  fetchPullRequestFreshness,
} from "../../src/github/pr-freshness";
import { createTestEnv } from "../helpers/d1";
import { generatePrivateKeyPem } from "../helpers/github-app-key";

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







// #10061: a minimal etag-aware in-memory R2 stand-in for the capture-retry budget (mirrors
// preview-poll-budget.test.ts's own memoryBudgetStore), used by the screenshot-table gate tests below that
// now need a REAL REVIEW_AUDIT binding to seed/observe scheduleVisualCaptureRetry's durable per-head counter.
function memoryBudgetStore(): R2Bucket {
  const store = new Map<string, { value: string; etag: string }>();
  let etagSeq = 0;
  return {
    async get(key: string) {
      const entry = store.get(key);
      return entry === undefined ? null : ({ body: new Response(entry.value).body, httpEtag: entry.etag } as unknown as R2ObjectBody);
    },
    async put(key: string, value: unknown, putOptions?: R2PutOptions) {
      const onlyIf = putOptions?.onlyIf as R2Conditional | undefined;
      const current = store.get(key);
      if (onlyIf?.etagMatches !== undefined && current?.etag !== onlyIf.etagMatches) return null;
      if (onlyIf?.etagDoesNotMatch === "*" && current !== undefined) return null;
      etagSeq += 1;
      const etag = `etag-${etagSeq}`;
      store.set(key, { value: await new Response(value as BodyInit).text(), etag });
      return { key, etag } as unknown as R2Object;
    },
  } as unknown as R2Bucket;
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

  it("planner (#issue-coding-plan): a maintainer @loopover plan on an issue posts an AI plan (flag ON)", async () => {
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

    await processJob(env, plannerWebhook("@loopover plan", "maintainer1"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(postedBody).toContain("LoopOver implementation plan");
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
    await processJob(env, plannerWebhook("@loopover plan", "maintainer1"));
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
    await processJob(env, plannerWebhook("@loopover plan", "maintainer1"));
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
    await processJob(env, plannerWebhook("@loopover plan", "maintainer1"));
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
    await processJob(env, plannerWebhook("@loopover plan", "maintainer1"));
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
    await processJob(env, plannerWebhook("@loopover plan", "maintainer1"));
    await processJob(env, plannerWebhook("@loopover plan again", "maintainer1"));
    expect(run).toHaveBeenCalledTimes(1);
    const cooldown = await env.DB.prepare("select detail from audit_events where event_type = ? and detail = ?").bind("github_app.issue_plan_skipped", "cooldown_active").first<{ detail: string }>();
    expect(cooldown?.detail).toBe("cooldown_active");
  });

  it("planner: flag OFF is byte-identical — @loopover plan posts no plan and the AI is never called", async () => {
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
    await processJob(env, plannerWebhook("@loopover plan", "maintainer1"));
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
    await processJob(env, plannerWebhook("@loopover plan", "outsider"));
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
    await processJob(env, plannerWebhook("@loopover plan", "collab1"));
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

  it("planner (#22): @loopover plan on a PR is NOT consumed — it falls through (no plan, no skip audit)", async () => {
    const run = vi.fn(async () => ({ response: "nope" }));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "true", AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    vi.stubGlobal("fetch", async () => Response.json({}));
    await processJob(env, plannerWebhook("@loopover plan", "maintainer1", { number: 77, title: "PR not issue", state: "open", user: { login: "x" }, body: "b", pull_request: { url: "https://api.github.com/x" } }));
    expect(run).not.toHaveBeenCalled();
    // Planning is issue-only; a PR-thread `plan` falls through to the mention/help path (flag-ON now matches
    // flag-OFF) instead of being swallowed as a plan skip.
    const planAudits = await env.DB.prepare("select count(*) as n from audit_events where event_type in (?, ?)").bind("github_app.issue_plan_skipped", "github_app.issue_plan_generated").first<{ n: number }>();
    expect(planAudits?.n).toBe(0);
  });

  it("planner: a bot-authored @loopover plan on an issue is recorded as a classifier skip", async () => {
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
        comment: { body: "@loopover plan", user: { login: "some-bot[bot]", type: "Bot" } },
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
    await processJob(env, plannerWebhook("@loopover plan", "maintainer1"));
    expect(posted).toBe(false); // no plan → nothing posted
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.issue_plan_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("no_plan_generated");
  });

  it("planner (#issue-coding-plan-config): a per-repo plannerMode: enabled override turns the command ON even when LOOPOVER_REVIEW_PLANNER is unset (fleet default off)", async () => {
    const run = vi.fn(async () => ({ response: "## Summary\nPer-repo override plan." }));
    // LOOPOVER_REVIEW_PLANNER deliberately absent -- the fleet default is off, so this proves the repo override
    // (not the env var) is what turns the command on.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { plannerMode: "enabled" } }, "repo_file");
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
    await processJob(env, plannerWebhook("@loopover plan", "maintainer1"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(postedBody).toContain("Per-repo override plan");
  });

  it("planner (#issue-coding-plan-config): a per-repo plannerMode: off override turns the command OFF even when LOOPOVER_REVIEW_PLANNER=true (fleet default on)", async () => {
    const run = vi.fn(async () => ({ response: "should not run" }));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "true", AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { plannerMode: "off" } }, "repo_file");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@loopover plan", "maintainer1"));
    expect(run).not.toHaveBeenCalled();
    // Not consumed at all (byte-identical to the fleet-off path) -- falls through, no skip audit either.
    const planAudits = await env.DB.prepare("select count(*) as n from audit_events where event_type in (?, ?)").bind("github_app.issue_plan_skipped", "github_app.issue_plan_generated").first<{ n: number }>();
    expect(planAudits?.n).toBe(0);
  });

  it("planner (#issue-coding-plan-config): plannerMode: inherit explicitly defers to the fleet default (both directions)", async () => {
    const runOff = vi.fn(async () => ({ response: "should not run" }));
    const envOff = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "false", AI: { run: runOff } as unknown as Ai });
    await setupPlannerRepo(envOff);
    await upsertRepoFocusManifest(envOff, "JSONbored/gittensory", { settings: { plannerMode: "inherit" } }, "repo_file");
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await processJob(envOff, plannerWebhook("@loopover plan", "maintainer1"));
    expect(runOff).not.toHaveBeenCalled();

    const runOn = vi.fn(async () => ({ response: "## Summary\nInherit-on plan." }));
    const envOn = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "true", AI: { run: runOn } as unknown as Ai });
    await setupPlannerRepo(envOn);
    await upsertRepoFocusManifest(envOn, "JSONbored/gittensory", { settings: { plannerMode: "inherit" } }, "repo_file");
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
    await processJob(envOn, plannerWebhook("@loopover plan", "maintainer1"));
    expect(runOn).toHaveBeenCalledTimes(1);
    expect(postedBody).toContain("Inherit-on plan");
  });

  it("planner (#issue-coding-plan-config): a manifest-load failure degrades to the fleet-only default (fail-safe), never throws into the webhook loop", async () => {
    const run = vi.fn(async () => ({ response: "## Summary\nFail-safe plan." }));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "true", AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    const loadSpy = vi.spyOn(focusManifestLoaderModule, "loadRepoFocusManifest").mockRejectedValueOnce(new Error("manifest unavailable"));
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
    await expect(processJob(env, plannerWebhook("@loopover plan", "maintainer1"))).resolves.not.toThrow();
    // A rejected manifest load degrades to the fleet-only default (LOOPOVER_REVIEW_PLANNER=true here), so the
    // command still runs -- the failure never blocks or throws.
    expect(run).toHaveBeenCalledTimes(1);
    expect(postedBody).toContain("Fail-safe plan");
    loadSpy.mockRestore();
  });

  it("planner (#issue-coding-plan-config): no repository on the payload falls back to the global-only default without attempting a manifest load", async () => {
    const run = vi.fn(async () => ({ response: "should not run" }));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), LOOPOVER_REVIEW_PLANNER: "false", AI: { run } as unknown as Ai });
    await setupPlannerRepo(env);
    const loadSpy = vi.spyOn(focusManifestLoaderModule, "loadRepoFocusManifest");
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "plan-no-repo",
      eventName: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        issue: { number: 77, title: "Issue", state: "open", user: { login: "reporter" }, body: "b" },
        comment: { body: "@loopover plan", user: { login: "maintainer1", type: "User" } },
        sender: { login: "maintainer1", type: "User" },
      },
    } as unknown as Parameters<typeof processJob>[1]);
    expect(loadSpy).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    loadSpy.mockRestore();
  });

  it("configuration (#2168): a maintainer @loopover configuration posts the effective resolved config", async () => {
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
    await processJob(env, plannerWebhook("@loopover configuration", "maintainer1"));
    expect(postedBody).toContain("Effective review configuration");
    expect(postedBody).toContain("Agent execution mode: **live**");
    expect(postedBody).toContain("Autonomy by action class:");
    // public-safe: never leaks a reward/trust/wallet field
    expect(postedBody?.toLowerCase()).not.toMatch(/reward|wallet|hotkey|coldkey|trustscore/);
    const audit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.configuration_posted").first<{ outcome: string }>();
    expect(audit?.outcome).toBe("completed");
  });

  it("configuration (#8688): a posted @loopover configuration is recorded in product-usage telemetry", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await setupPlannerRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" }); // maintainer
      if (url.includes("/issues/77/comments") && method === "GET") return Response.json([]);
      if (url.includes("/issues/77/comments") && method === "POST") return Response.json({ id: 5 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@loopover configuration", "maintainer1"));
    const usage = await env.DB.prepare("select outcome, json_extract(metadata_json, '$.mode') as mode from product_usage_events where event_name = ?").bind("configuration_posted").first<{ outcome: string; mode: string }>();
    expect(usage?.outcome).toBe("completed");
    expect(usage?.mode).toBe("live");
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

    await processJob(env, plannerWebhook("@loopover configuration", "maintainer1"));

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
    await processJob(env, plannerWebhook("@loopover configuration", "outsider"));
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
        comment: { body: "@loopover configuration", user: { login: "some-bot[bot]", type: "Bot" } },
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

  it("pause (#2164): a maintainer @loopover pause records the autoreview-paused marker and posts a public-safe confirmation", async () => {
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
    await processJob(env, plannerWebhook("@loopover pause flaky CI, will re-enable after the fix", "maintainer1", pauseIssue));
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
    await processJob(env, plannerWebhook("@loopover pause", "maintainer1", pauseIssue));
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
    await processJob(env, plannerWebhook("@loopover pause let me in", "outsider", pauseIssue));
    expect(posted).toBe(false);
    const denied = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.autoreview_paused_denied").first<{ outcome: string }>();
    expect(denied?.outcome).toBe("denied");
    const paused = await env.DB.prepare("select 1 from audit_events where event_type = ?").bind("github_app.autoreview_paused").first();
    expect(paused).toBeFalsy();
  });

  // REGRESSION (#8685): pause is a maintainer/collaborator-only default, but a repo may widen it to
  // confirmed_miner via commandAuthorization. That widening was dead because the pause handler omitted
  // authorizePrActionActor's needsMinerDetection: true, so the miner status was never computed and a
  // confirmed miner's own-PR pause always fell through to miner_detection_unavailable. With the flag now
  // passed, the documented widening actually authorizes the confirmed miner.
  it("pause (#8685): a confirmed Gittensor miner is authorized to pause their OWN PR once the repo widens commandAuthorization for pause", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedPausePr(env);
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", commandAuthorization: { default: ["maintainer", "collaborator"], commands: { pause: ["confirmed_miner"] } } });
    await upsertOfficialMinerDetection(env, "reporter", { status: "confirmed", snapshot: queueMinerSnapshot("reporter") }, 60_000);
    let postedBody: string | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // No repo permission at all — the ONLY route to authorization is the confirmed_miner role on their own PR.
      if (url.includes("/collaborators/") && url.includes("/permission")) return new Response("not found", { status: 404 });
      if (url.includes("/issues/77/comments")) {
        postedBody = init?.body ? JSON.parse(init.body.toString()).body : undefined;
        return Response.json({ id: 5 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@loopover pause CI is flaky today", "reporter", pauseIssue));
    expect(postedBody).toContain("Auto-review paused by @reporter");
    const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ?").bind("github_app.autoreview_paused").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("completed");
    expect(audit?.detail).toBe("CI is flaky today");
    // Provably NOT the pre-fix miner_detection_unavailable denial: no denied marker was recorded.
    const denied = await env.DB.prepare("select 1 from audit_events where event_type = ?").bind("github_app.autoreview_paused_denied").first();
    expect(denied).toBeFalsy();
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
    await processJob(env, plannerWebhook("@loopover pause", "maintainer1", pauseIssue));
    expect(posted).toBe(false);
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.autoreview_paused_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("cached_pr_missing");
  });

  it("pause: a bot-authored @loopover pause is recorded as a classifier skip, never posted", async () => {
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
        comment: { body: "@loopover pause", user: { login: "some-bot[bot]", type: "Bot" } },
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

  it("pause (#9312): a redelivered @loopover pause (same deliveryId) short-circuits — the pause is recorded once, no second confirmation", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedPausePr(env);
    let posts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      if (url.includes("/issues/77/comments") && (init?.method ?? "GET") === "POST") {
        posts += 1;
        return Response.json({ id: 5 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });
    // GitHub redelivery: identical deliveryId + payload arrive twice (queue max_retries / dlq re-drive).
    const job = plannerWebhook("@loopover pause flaky CI", "maintainer1", pauseIssue);
    await processJob(env, job);
    await processJob(env, job);
    expect(posts).toBe(1); // the replay posts no second confirmation
    const paused = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.autoreview_paused").first<{ n: number }>();
    expect(paused?.n).toBe(1);
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

  it("review (#2163): an authorized @loopover review posts a confirmation, dispatches a REAL re-review (proven by a live PR resync fetch inside reReviewStoredPullRequest, not just the command's own comment post), and records review_command_completed", async () => {
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
    await processJob(env, plannerWebhook("@loopover review", "maintainer1", reviewIssue));
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

  it("review (#9312): a redelivered @loopover review (same deliveryId) short-circuits — the re-review is dispatched exactly once", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedReviewPr(env);
    let confirmationPosts = 0;
    let liveResyncFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/issues/78/comments") && method === "POST") {
        const body = init?.body ? JSON.parse(init.body.toString()).body : "";
        if (String(body).includes("Re-review triggered by")) confirmationPosts += 1;
        return Response.json({ id: 78 }, { status: 201 });
      }
      // reReviewStoredPullRequest's own live-head resync GETs the PR fresh — only reached once the dispatch runs.
      if (url.endsWith("/pulls/78") && method === "GET") liveResyncFetches += 1;
      return reviewCommandFetchStub()(input, init);
    });
    // GitHub redelivery: the identical deliveryId + payload arrive a second time (queue max_retries / dlq re-drive).
    const job = plannerWebhook("@loopover review", "maintainer1", reviewIssue);
    await processJob(env, job);
    await processJob(env, job);
    expect(confirmationPosts).toBe(1); // the replay posts no second confirmation
    expect(liveResyncFetches).toBe(1); // and dispatches no second reReviewStoredPullRequest (no repeat AI-review spend)
    const completed = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.review_command_completed").first<{ n: number }>();
    expect(completed?.n).toBe(1);
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
    await processJob(env, plannerWebhook("@loopover re-review", "maintainer1", reviewIssue));
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
    await processJob(env, plannerWebhook("@loopover review", "outsider", reviewIssue));
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

    await processJob(env, plannerWebhook("@loopover review", "reporter", reviewIssue));

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

    await processJob(env, plannerWebhook("@loopover review", "maintainer1", reviewIssue));
    let skipped = await env.DB.prepare("select detail from audit_events where event_type = ? order by rowid desc limit 1").bind("github_app.review_command_skipped").first<{ detail: string }>();
    expect(skipped?.detail).toBe("agent_paused");
    let completed = await env.DB.prepare("select 1 from audit_events where event_type = ?").bind("github_app.review_command_completed").first();
    expect(completed).toBeFalsy();

    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", agentPaused: false, agentDryRun: true });
    await processJob(env, plannerWebhook("@loopover review", "maintainer1", reviewIssue));
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
    await processJob(env, plannerWebhook("@loopover review", "maintainer1", reviewIssue));
    expect(posted).toBe(false);
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.review_command_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("cached_pr_missing");
  });

  it("review: a bot-authored @loopover review is recorded as a classifier skip, never posted", async () => {
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
        comment: { body: "@loopover review", user: { login: "some-bot[bot]", type: "Bot" } },
        sender: { login: "some-bot[bot]", type: "Bot" },
      },
    } as unknown as Parameters<typeof processJob>[1]);
    expect(posted).toBe(false);
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.review_command_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("bot_author");
  });

  it("resume (#2165): an authorized @loopover resume clears an earlier pause and posts a public-safe confirmation", async () => {
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
    await processJob(env, plannerWebhook("@loopover pause", "maintainer1", pauseIssue));
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
    await processJob(env, plannerWebhook("@loopover resume", "maintainer1", pauseIssue));
    expect(postedBody).toContain("Auto-review resumed by @maintainer1");
    const audit = await env.DB.prepare("select outcome from audit_events where event_type = ?").bind("github_app.autoreview_resumed").first<{ outcome: string }>();
    expect(audit?.outcome).toBe("completed");
    // The core bug fix (#2165): hasAutoreviewPausedMarker now reads the MOST RECENT of {paused, resumed}, so
    // resume actually supersedes the earlier pause instead of silently no-opping forever.
    expect(await isCurrentlyPaused(env, "JSONbored/gittensory", 77)).toBe(false);
  });

  it("resume (#9312): a redelivered @loopover resume (same deliveryId) short-circuits — resumed is recorded once, no second confirmation", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedPausePr(env);
    let posts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "admin" });
      if (url.includes("/issues/77/comments") && (init?.method ?? "GET") === "POST") {
        posts += 1;
        return Response.json({ id: 6 }, { status: 201 });
      }
      if (url.includes("/issues/77/comments")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });
    // GitHub redelivery: identical deliveryId + payload arrive twice (queue max_retries / dlq re-drive).
    const job = plannerWebhook("@loopover resume", "maintainer1", pauseIssue);
    await processJob(env, job);
    await processJob(env, job);
    expect(posts).toBe(1); // the replay posts no second confirmation
    const resumed = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?").bind("github_app.autoreview_resumed").first<{ n: number }>();
    expect(resumed?.n).toBe(1);
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
    await processJob(env, plannerWebhook("@loopover pause", "maintainer1", pauseIssue));
    expect(await isCurrentlyPaused(env, "JSONbored/gittensory", 77)).toBe(true);
    vi.stubGlobal("fetch", adminFetch());
    await processJob(env, plannerWebhook("@loopover resume", "maintainer1", pauseIssue));
    expect(await isCurrentlyPaused(env, "JSONbored/gittensory", 77)).toBe(false);
    vi.stubGlobal("fetch", adminFetch());
    await processJob(env, plannerWebhook("@loopover pause again", "maintainer1", pauseIssue));
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
    await processJob(env, plannerWebhook("@loopover pause", "maintainer1", pauseIssue));
    let posted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/") && url.includes("/permission")) return Response.json({ permission: "read" }); // not authorized
      if (url.includes("/comments")) posted = true;
      return new Response("not found", { status: 404 });
    });
    await processJob(env, plannerWebhook("@loopover resume", "outsider", pauseIssue));
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
    await processJob(env, plannerWebhook("@loopover resume", "maintainer1", pauseIssue));
    expect(posted).toBe(false);
    const skip = await env.DB.prepare("select detail from audit_events where event_type = ?").bind("github_app.autoreview_resumed_skipped").first<{ detail: string }>();
    expect(skip?.detail).toBe("cached_pr_missing");
  });

  it("resume: a bot-authored @loopover resume is recorded as a classifier skip, never posted", async () => {
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
        comment: { body: "@loopover resume", user: { login: "some-bot[bot]", type: "Bot" } },
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
      autoLabelEnabled: false,
      autonomy: { merge: "auto", approve: "auto", close: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "off", publicSurface: "off", checkRunMode: "off", reviewCheckMode: "required" } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    // contributorBlacklist moved off the DB entirely (Batch B, loopover#6443) -- set via manifest injection.
    // The label is configurable via `.loopover.yml` (default "slop"); set a custom one to prove it's not hardcoded.
    await upsertRepoFocusManifest(
      env,
      "JSONbored/gittensory",
      {
        settings: {
          commentMode: "all_prs",
          publicSurface: "comment_only",
          checkRunMode: "off",
          blacklistLabel: "spam",
          contributorBlacklist: [{ login: "baduser", reason: "plagiarism" }],
          reviewCheckMode: "required",
          aiReviewMode: "advisory",
        },
      },
      "repo_file",
    );
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

  it("blacklist (#6659): a banned author's close also cancels the PR's in-flight CI runs, unconditionally (no config toggle)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    // contributorBlacklist moved off the DB entirely (Batch B, loopover#6443) -- set via manifest injection,
    // same as the deterministic-close test above. No contributorCapCancelCi anywhere -- CI-cancel on a
    // blacklist close is unconditional, unlike contributor_cap's opt-in toggle.
    await upsertRepoFocusManifest(
      env,
      "JSONbored/gittensory",
      { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", contributorBlacklist: [{ login: "baduser", reason: "force-push CI churn" }], reviewCheckMode: "required", aiReviewMode: "advisory" } },
      "repo_file",
    );
    const seen = { closed: false, cancelledIds: [] as number[], listedStatuses: [] as string[] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if (url.endsWith("/pulls/55") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 55, state: "closed" }); }
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "baduser" }, head: { sha: "bl55" }, mergeable_state: "clean" });
      if (url.includes("/commits/bl55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/bl55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels")) return Response.json([]);
      if (url.includes("/issues/55/comments")) return Response.json([]);
      if (url.includes("/actions/runs?head_sha=bl55&status=in_progress")) { seen.listedStatuses.push("in_progress"); return Response.json({ workflow_runs: [{ id: 301, event: "pull_request", pull_requests: [{ number: 55 }] }] }); }
      if (url.includes("/actions/runs?head_sha=bl55&status=queued")) { seen.listedStatuses.push("queued"); return Response.json({ workflow_runs: [{ id: 302, event: "pull_request", pull_requests: [{ number: 55 }] }] }); }
      if (url.includes("/actions/runs/") && url.endsWith("/cancel") && method === "POST") {
        seen.cancelledIds.push(Number(url.match(/\/actions\/runs\/(\d+)\/cancel/)?.[1]));
        return new Response(null, { status: 202 });
      }
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "blacklist-close-cancel-ci",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 55, title: "Banned author PR", state: "open", user: { login: "baduser" }, head: { sha: "bl55" }, labels: [], body: "Closes #1", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    expect(seen.closed).toBe(true);
    expect(seen.listedStatuses.sort()).toEqual(["in_progress", "queued"]);
    expect(seen.cancelledIds.sort()).toEqual([301, 302]);
    const cancelAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.blacklist_ci_cancelled'").first<{ n: number }>();
    expect(cancelAudit?.n).toBeGreaterThanOrEqual(1);
  });

  it("blacklist (#6659): a failed CI-cancel attempt degrades gracefully — the close still succeeds and a blacklist-specific failure audit is recorded", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(
      env,
      "JSONbored/gittensory",
      { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", contributorBlacklist: [{ login: "baduser", reason: "force-push CI churn" }], reviewCheckMode: "required", aiReviewMode: "advisory" } },
      "repo_file",
    );
    const seen = { closed: false, cancelledIds: [] as number[] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/55/reviews")) return Response.json([]);
      if (url.includes("/pulls/55/commits")) return Response.json([]);
      if (url.endsWith("/pulls/55") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 55, state: "closed" }); }
      if (url.endsWith("/pulls/55")) return Response.json({ number: 55, state: "open", user: { login: "baduser" }, head: { sha: "bl55" }, mergeable_state: "clean" });
      if (url.includes("/commits/bl55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/bl55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/55/labels")) return Response.json([]);
      if (url.includes("/issues/55/comments")) return Response.json([]);
      // A genuine cancel error (not a permission gap) -- both branches of that inner distinction are already
      // covered by the contributor_cap tests above; this just needs to hit the new blacklist-prefixed event.
      if (url.includes("/actions/runs?head_sha=bl55&status=in_progress")) return Response.json({ workflow_runs: [{ id: 303, event: "pull_request", pull_requests: [{ number: 55 }] }] });
      if (url.includes("/actions/runs?head_sha=bl55&status=queued")) return Response.json({ workflow_runs: [] });
      if (url.includes("/actions/runs/") && url.endsWith("/cancel") && method === "POST") { seen.cancelledIds.push(303); return new Response(null, { status: 500 }); }
      return Response.json({});
    });

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "blacklist-close-cancel-ci-failed",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 55, title: "Banned author PR", state: "open", user: { login: "baduser" }, head: { sha: "bl55" }, labels: [], body: "Closes #1", mergeable_state: "clean", reviewDecision: "APPROVED" },
        },
      }),
    ).resolves.toBeUndefined();

    expect(seen.closed).toBe(true);
    const failedAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.blacklist_ci_cancel_failed'").first<{ n: number }>();
    expect(failedAudit?.n).toBeGreaterThanOrEqual(1);
  });

  it("screenshot-table gate (#2006): an in-scope contributor PR missing a before/after table is closed deterministically regardless of the (unrelated, still-running) AI review and no merit merge", async () => {
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
      autonomy: { close: "auto", label: "auto" },
    });
    // Scoped to the `visual` label only, config-as-code, nothing hardcoded — mirrors the blacklistLabel test above.
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required", aiReviewMode: "advisory" } }, "repo_file");
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

    // Deterministic gate: closed regardless of the AI review's own (unrelated, advisory-only) verdict --
    // AI review runs for this author too (#orb-ai-review-always-review: it is no longer gated on
    // confirmed-contributor status), but the screenshot-table gate's close decision doesn't wait on or
    // depend on it either way.
    expect(aiCalls).toBe(1);
    expect(seen.closed).toBe(true);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBeGreaterThanOrEqual(1);
    // No merit merge despite a clean+green+approved PR (the screenshot-table gate short-circuits ahead of merit).
    const mergeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.merge'").first<{ n: number }>();
    expect(mergeAudit?.n).toBe(0);
    // The close comment explains the missing table.
    expect(seen.comments.some((c) => c.includes("before/after screenshot table"))).toBe(true);
  });

  it("REGRESSION (#2006 advisory follow-up): action: \"advisory\" is no longer a silent no-op -- a missing before/after table appends a visible, non-blocking finding instead of closing the PR", async () => {
    // Before the fix, evaluateScreenshotTableGate's `violated` result was only ever folded into a real signal
    // when `action === "close"` -- the "advisory" ternary branch discarded it entirely, so a maintainer who
    // deliberately chose the softer "advisory" action got neither enforcement NOR visibility. No `autonomy`
    // is configured here (unlike the "close" test above) -- advisory mode's finding comes from the main gate
    // pass, not the agent-maintenance close path, so it must appear even with the agent fully unconfigured.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"], action: "advisory" }, reviewCheckMode: "required" } }, "repo_file");
    const seen = { closed: false, comments: [] as string[] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/58/files")) return Response.json([{ filename: "apps/ui/src/App.tsx", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/58/reviews")) return Response.json([]);
      if (url.includes("/pulls/58/commits")) return Response.json([]);
      if (url.endsWith("/pulls/58") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 58, state: "closed" }); }
      if (url.endsWith("/pulls/58")) return Response.json({ number: 58, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis58" }, mergeable_state: "clean" });
      if (url.includes("/commits/vis58/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/vis58/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/58/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/58/comments") && method === "POST") {
        seen.comments.push(String(JSON.parse(String(init?.body ?? "{}")).body ?? ""));
        return Response.json({ id: 1 }, { status: 201 });
      }
      if (url.includes("/issues/58/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "screenshot-table-advisory",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 58, title: "New button color", state: "open", user: { login: "visual-contributor" }, head: { sha: "vis58" }, labels: [{ name: "visual" }], body: "Changed the button color.", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    // Never closed -- "advisory" must not enforce, only surface a finding.
    expect(seen.closed).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n ?? 0).toBe(0);
    // The finding surfaces in the published unified PR comment's advisory findings section (the `advisories`
    // DB table row is written once, EARLY, before this late-appended finding exists -- so the live-published
    // comment, not that row, is the correct place to observe it).
    const finalComment = seen.comments.at(-1) ?? "";
    expect(finalComment).toContain("Missing before/after screenshot table");
    expect(finalComment).toContain("before/after screenshot table to the pull request description");
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
      autonomy: { close: "auto", merge: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
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

  // #stale-screenshot-table-fix: the exact audited failure scenario -- a contributor pastes a genuine
  // before/after table on push #1 (gate passes, PR stays open), then pushes new commits (push #2, a NEW head
  // SHA) WITHOUT touching the PR body at all. Pre-fix, presence mode is pure regex matching over `prBody` with
  // no tie to the live head SHA, so the SAME unchanged table silently satisfies the gate forever, even though it
  // no longer proves anything about the code now on the new head. Post-fix, the gate must correlate presence-mode
  // evidence to the head SHA it was last satisfied at and re-violate on push #2 since the evidence never changed.
  it("screenshot-table gate (#stale-screenshot-table-fix): a table that passed on push #1 no longer satisfies the gate on push #2 when the body was never re-edited", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
    });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", merge: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
    // The SAME body/evidence is reused verbatim across both pushes -- the contributor never re-edits it.
    const unchangedBody =
      "Changed the button color.\n\n| Before | After |\n| --- | --- |\n| ![before](https://x/before.png) | ![after](https://x/after.png) |\n\nCloses #1";
    let currentHeadSha = "stale-push-1";
    const seen = { closed: false, closeCount: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/9001/files")) return Response.json([{ filename: "apps/ui/src/App.tsx", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/9001/reviews")) return Response.json([]);
      if (url.includes("/pulls/9001/commits")) return Response.json([]);
      if (url.endsWith("/pulls/9001") && method === "PATCH") {
        if (JSON.parse(String(init?.body ?? "{}")).state === "closed") { seen.closed = true; seen.closeCount += 1; }
        return Response.json({ number: 9001, state: "closed" });
      }
      if (url.endsWith("/pulls/9001")) return Response.json({ number: 9001, state: "open", user: { login: "visual-contributor" }, head: { sha: currentHeadSha }, mergeable_state: "clean" });
      if (url.includes(`/commits/${currentHeadSha}/check-runs`)) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes(`/commits/${currentHeadSha}/status`)) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      if (url.includes("/issues/9001/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/9001/labels") && method === "POST") return Response.json([]);
      if (url.includes("/issues/9001/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/9001/comments")) return Response.json([]);
      return Response.json({});
    });

    // Push #1: the table is present and correlated to THIS head for the first time ever -- passes, stays open.
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "screenshot-table-stale-push-1",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 9001, title: "New button color", state: "open", user: { login: "visual-contributor" }, head: { sha: currentHeadSha }, labels: [{ name: "visual" }], body: unchangedBody, mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });
    expect(seen.closed).toBe(false);
    // The presence-mode checkpoint was persisted for push #1's head, keyed to the evidence fingerprint.
    const afterPush1 = await getPullRequest(env, "JSONbored/gittensory", 9001);
    expect(afterPush1?.screenshotTablePresenceSatisfied?.headSha).toBe("stale-push-1");

    // Push #2: new commits land (a NEW head SHA) but the contributor never edits the body -- the SAME evidence
    // that satisfied push #1 is now stale. Pre-fix this would still pass (pure string match, no SHA awareness);
    // post-fix it must violate and the PR must be closed.
    currentHeadSha = "stale-push-2";
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "screenshot-table-stale-push-2",
      eventName: "pull_request",
      payload: {
        action: "synchronize",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 9001, title: "New button color", state: "open", user: { login: "visual-contributor" }, head: { sha: currentHeadSha }, labels: [{ name: "visual" }], body: unchangedBody, mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });
    expect(seen.closed).toBe(true);
    expect(seen.closeCount).toBe(1);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBeGreaterThanOrEqual(1);
  });

  // #8866: same audited failure as #stale-screenshot-table-fix, but for MATRIX mode (requireViewports set).
  // Pre-fix, matrix mode only re-scanned labeled rows with no head-SHA correlation, so an unchanged matrix
  // table silently PASSed forever after push #1. Post-fix it must reuse the presence-mode fingerprint
  // checkpoint and re-violate on push #2.
  it("screenshot-table gate (#8866): a matrix table that passed on push #1 no longer satisfies the gate on push #2 when the body was never re-edited", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
    });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", merge: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", {
      settings: {
        commentMode: "all_prs",
        publicSurface: "comment_only",
        checkRunMode: "off",
        screenshotTableGate: {
          enabled: true,
          whenLabels: ["visual"],
          requireViewports: ["Desktop"],
          requireThemes: ["Light"],
        },
        reviewCheckMode: "required",
      },
    }, "repo_file");
    const unchangedMatrixBody = [
      "Changed the button color.",
      "",
      "| Viewport · Theme | Before | After |",
      "| --- | --- | --- |",
      "| Desktop · Light | ![before](https://x/before.png) | ![after](https://x/after.png) |",
      "",
      "Closes #1",
    ].join("\n");
    let currentHeadSha = "matrix-stale-push-1";
    const seen = { closed: false, closeCount: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/9002/files")) return Response.json([{ filename: "apps/ui/src/App.tsx", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/9002/reviews")) return Response.json([]);
      if (url.includes("/pulls/9002/commits")) return Response.json([]);
      if (url.endsWith("/pulls/9002") && method === "PATCH") {
        if (JSON.parse(String(init?.body ?? "{}")).state === "closed") { seen.closed = true; seen.closeCount += 1; }
        return Response.json({ number: 9002, state: "closed" });
      }
      if (url.endsWith("/pulls/9002")) return Response.json({ number: 9002, state: "open", user: { login: "visual-contributor" }, head: { sha: currentHeadSha }, mergeable_state: "clean" });
      if (url.includes(`/commits/${currentHeadSha}/check-runs`)) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes(`/commits/${currentHeadSha}/status`)) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      if (url.includes("/issues/9002/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/9002/labels") && method === "POST") return Response.json([]);
      if (url.includes("/issues/9002/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      if (url.includes("/issues/9002/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "screenshot-table-matrix-stale-push-1",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 9002, title: "New button color", state: "open", user: { login: "visual-contributor" }, head: { sha: currentHeadSha }, labels: [{ name: "visual" }], body: unchangedMatrixBody, mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });
    expect(seen.closed).toBe(false);
    const afterPush1 = await getPullRequest(env, "JSONbored/gittensory", 9002);
    expect(afterPush1?.screenshotTablePresenceSatisfied?.headSha).toBe("matrix-stale-push-1");

    currentHeadSha = "matrix-stale-push-2";
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "screenshot-table-matrix-stale-push-2",
      eventName: "pull_request",
      payload: {
        action: "synchronize",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 9002, title: "New button color", state: "open", user: { login: "visual-contributor" }, head: { sha: currentHeadSha }, labels: [{ name: "visual" }], body: unchangedMatrixBody, mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });
    expect(seen.closed).toBe(true);
    expect(seen.closeCount).toBe(1);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBeGreaterThanOrEqual(1);
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
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
    });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
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
      if (url.includes("/pulls/58/files")) return Response.json([{ filename: "apps/loopover-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
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
      // The unified-comment path also creates/patches the "LoopOver Orb Review Agent" check run and applies
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
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
    });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/59/files")) return Response.json([{ filename: "apps/loopover-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
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

  // #9030: same fixture shape as the sibling "#4110" tests above (in-scope, no body table), except the capture
  // pipeline itself THROWS (browserless down, a timeout, a GitHub hiccup) rather than concluding normally with
  // no routes. Before this fix, that looked identical to "capture ran and found nothing" -- the PR was closed
  // purely because an internal service blipped.
  it("screenshot-table gate (#9030): a capture-pipeline ERROR defers the close instead of treating it as missing evidence", async () => {
    const buildCaptureSpy = vi.spyOn(visualCaptureModule, "buildCapture").mockRejectedValueOnce(new Error("browserless connection refused"));
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
    });
    const sentJobs: Array<Record<string, unknown>> = [];
    env.JOBS = { async send(message: Record<string, unknown>) { sentJobs.push(message); } } as unknown as Queue;
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/60/files")) return Response.json([{ filename: "apps/loopover-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/60/reviews")) return Response.json([]);
      if (url.includes("/pulls/60/commits")) return Response.json([]);
      if (url.endsWith("/pulls/60") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 60, state: "closed" }); }
      if (url.endsWith("/pulls/60")) return Response.json({ number: 60, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis60" }, mergeable_state: "clean" });
      if (url.includes("/commits/vis60/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/vis60/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/vis60/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/60/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/60/comments")) return Response.json([]);
      if (url.endsWith("/labels") && method === "POST") return Response.json([]);
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 901 }, { status: 201 });
      if (url.includes("/check-runs/901") && method === "PATCH") return Response.json({ id: 901 });
      return new Response("not found", { status: 404 });
    });

    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "screenshot-table-capture-error",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: {
            number: 60,
            title: "Update the app index route",
            state: "open",
            user: { login: "visual-contributor" },
            head: { sha: "vis60" },
            labels: [{ name: "visual" }],
            body: "Changed the route layout, no table here.",
            mergeable_state: "clean",
            reviewDecision: "APPROVED",
          },
        },
      });
    } finally {
      buildCaptureSpy.mockRestore();
    }

    // A capture ERROR must not be treated as "no visual evidence" -- the close is deferred, not fired.
    expect(seen.closed).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBe(0);
    // The retry marker is persisted for this exact head, and a bounded recapture retry was scheduled.
    const stored = await getPullRequest(env, "JSONbored/gittensory", 60);
    expect(stored?.visualCaptureRetryPendingSha).toBe("vis60");
    expect(stored?.visualCaptureSatisfiedSha).toBeNull();
    expect(sentJobs).toContainEqual(expect.objectContaining({ type: "recapture-preview", repoFullName: "JSONbored/gittensory", prNumber: 60, attempt: 1 }));
    // The deferral itself is named in the audit trail, not silent.
    const deferAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.screenshot_table_close_deferred_capture_retry", "JSONbored/gittensory#60")
      .first<{ n: number }>();
    expect(deferAudit?.n).toBe(1);
  });

  // #9464: the THIRD blip class, and the one that reached production. #9030 covers a capture that THROWS and
  // #9207 covers a preview that is still building; this is "the preview resolved fine, the RENDERER produced
  // nothing, and nothing threw". captureShot swallows its own errors per shot, so buildCapture RESOLVES --
  // previewPending false, no exception, no real pair -- which is byte-identical to a legitimately evidence-free
  // PR right up until the gate closes it one-shot. Browserless being down must not close contributor PRs.
  it("screenshot-table gate (#9464): a RESOLVED capture whose renderer failed defers the close, exactly like a thrown one", async () => {
    const buildCaptureSpy = vi.spyOn(visualCaptureModule, "buildCapture").mockResolvedValueOnce({ routes: [{ path: "/app", afterUrl: "https://worker.example/loopover/shot?url=x", afterUrlMobile: "https://worker.example/loopover/shot?url=x" }], interactions: [], previewPending: false, renderFailed: true, previewUnobtainable: false });
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
    });
    const sentJobs: Array<Record<string, unknown>> = [];
    env.JOBS = { async send(message: Record<string, unknown>) { sentJobs.push(message); } } as unknown as Queue;
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/64/files")) return Response.json([{ filename: "apps/loopover-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/64/reviews")) return Response.json([]);
      if (url.includes("/pulls/64/commits")) return Response.json([]);
      if (url.endsWith("/pulls/64") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 64, state: "closed" }); }
      if (url.endsWith("/pulls/64")) return Response.json({ number: 64, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis64" }, mergeable_state: "clean" });
      if (url.includes("/commits/vis64/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/vis64/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/vis64/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/64/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/64/comments")) return Response.json([]);
      if (url.endsWith("/labels") && method === "POST") return Response.json([]);
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 901 }, { status: 201 });
      if (url.includes("/check-runs/901") && method === "PATCH") return Response.json({ id: 901 });
      return new Response("not found", { status: 404 });
    });

    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "screenshot-table-render-failed-64",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: {
            number: 64,
            title: "Update the app index route",
            state: "open",
            user: { login: "visual-contributor" },
            head: { sha: "vis64" },
            labels: [{ name: "visual" }],
            body: "Changed the route layout, no table here.",
            mergeable_state: "clean",
            reviewDecision: "APPROVED",
          },
        },
      });
    } finally {
      buildCaptureSpy.mockRestore();
    }

    // The close must NOT fire: we cannot tell whether this PR has visual evidence, only that we failed to look.
    expect(seen.closed).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBe(0);
    // Same bounded self-heal the other two blip classes get -- marker persisted for this head, retry scheduled.
    const stored = await getPullRequest(env, "JSONbored/gittensory", 64);
    expect(stored?.visualCaptureRetryPendingSha).toBe("vis64");
    expect(stored?.visualCaptureSatisfiedSha).toBeNull();
    expect(sentJobs).toContainEqual(expect.objectContaining({ type: "recapture-preview", repoFullName: "JSONbored/gittensory", prNumber: 64, attempt: 1 }));
  });

  // #10061 invariant: the previewPending path's own budget accounting (inside buildCapture, via
  // previewPollAttemptCount/recordPreviewPollAttempt) is explicitly OUT of scope for this fix and must keep
  // behaving exactly as it did before -- a single still-building preview still schedules exactly one
  // recapture-preview retry and still marks the latch, unaffected by the NEW capture-retry budget this fix
  // adds for the renderFailed / thrown-capture chain.
  it("screenshot-table gate (#10061 invariant): a single previewPending capture still schedules exactly one recapture-preview and marks the latch", async () => {
    const buildCaptureSpy = vi.spyOn(visualCaptureModule, "buildCapture").mockResolvedValueOnce({ routes: [{ path: "/app", afterUrl: "https://worker.example/loopover/shot?url=x", afterUrlMobile: "https://worker.example/loopover/shot?url=x" }], interactions: [], previewPending: true, renderFailed: false, previewUnobtainable: false });
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
    });
    const sentJobs: Array<Record<string, unknown>> = [];
    env.JOBS = { async send(message: Record<string, unknown>) { sentJobs.push(message); } } as unknown as Queue;
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/82/files")) return Response.json([{ filename: "apps/loopover-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/82/reviews")) return Response.json([]);
      if (url.includes("/pulls/82/commits")) return Response.json([]);
      if (url.endsWith("/pulls/82") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 82, state: "closed" }); }
      if (url.endsWith("/pulls/82")) return Response.json({ number: 82, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis82" }, mergeable_state: "clean" });
      if (url.includes("/commits/vis82/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/vis82/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/vis82/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/82/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/82/comments")) return Response.json([]);
      if (url.endsWith("/labels") && method === "POST") return Response.json([]);
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 952 }, { status: 201 });
      if (url.includes("/check-runs/952") && method === "PATCH") return Response.json({ id: 952 });
      return new Response("not found", { status: 404 });
    });

    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "screenshot-table-preview-pending-82",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: {
            number: 82,
            title: "Update the app index route",
            state: "open",
            user: { login: "visual-contributor" },
            head: { sha: "vis82" },
            labels: [{ name: "visual" }],
            body: "Changed the route layout, no table here.",
            mergeable_state: "clean",
            reviewDecision: "APPROVED",
          },
        },
      });
    } finally {
      buildCaptureSpy.mockRestore();
    }

    expect(seen.closed).toBe(false);
    const stored = await getPullRequest(env, "JSONbored/gittensory", 82);
    expect(stored?.visualCaptureRetryPendingSha).toBe("vis82");
    expect(sentJobs).toContainEqual(expect.objectContaining({ type: "recapture-preview", repoFullName: "JSONbored/gittensory", prNumber: 82, attempt: 1 }));
    expect(sentJobs.filter((job) => job.type === "recapture-preview")).toHaveLength(1);
  });

  // #9464 INVARIANT / #4110 guard: the fix must not neuter the gate. The single distinguishing bit is
  // `renderFailed` -- an identical no-evidence capture from a HEALTHY renderer is a true negative and must
  // still close. This is the test that an earlier "infer the blip from zero pairs" attempt broke.
  it("screenshot-table gate (#9464 INVARIANT): a healthy renderer that found no evidence still CLOSES — the fix does not neuter the gate", async () => {
    const buildCaptureSpy = vi.spyOn(visualCaptureModule, "buildCapture").mockResolvedValueOnce({ routes: [], interactions: [], previewPending: false, renderFailed: false, previewUnobtainable: false });
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
    });
    const sentJobs: Array<Record<string, unknown>> = [];
    env.JOBS = { async send(message: Record<string, unknown>) { sentJobs.push(message); } } as unknown as Queue;
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/65/files")) return Response.json([{ filename: "apps/loopover-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/65/reviews")) return Response.json([]);
      if (url.includes("/pulls/65/commits")) return Response.json([]);
      if (url.endsWith("/pulls/65") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 65, state: "closed" }); }
      if (url.endsWith("/pulls/65")) return Response.json({ number: 65, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis65" }, mergeable_state: "clean" });
      if (url.includes("/commits/vis65/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/vis65/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/vis65/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/65/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/65/comments")) return Response.json([]);
      if (url.endsWith("/labels") && method === "POST") return Response.json([]);
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 901 }, { status: 201 });
      if (url.includes("/check-runs/901") && method === "PATCH") return Response.json({ id: 901 });
      return new Response("not found", { status: 404 });
    });

    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "screenshot-table-render-failed-65",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: {
            number: 65,
            title: "Update the app index route",
            state: "open",
            user: { login: "visual-contributor" },
            head: { sha: "vis65" },
            labels: [{ name: "visual" }],
            body: "Changed the route layout, no table here.",
            mergeable_state: "clean",
            reviewDecision: "APPROVED",
          },
        },
      });
    } finally {
      buildCaptureSpy.mockRestore();
    }

    expect(seen.closed).toBe(true);
    // No retry marker and no recapture job: there is nothing to retry, the answer was already definite.
    const stored = await getPullRequest(env, "JSONbored/gittensory", 65);
    expect(stored?.visualCaptureRetryPendingSha).toBeNull();
    expect(sentJobs.some((job) => job.type === "recapture-preview")).toBe(false);
  });

  // #9030: sibling of the test above, but the recapture retry BUDGET is already exhausted (this delivery IS
  // itself the final recapture-preview attempt) -- proves the deferral cannot hold a PR closed forever: once
  // no retry chance remains, a still-erroring capture pipeline falls through to the gate's normal, accurate
  // (and here, correctly negative) evaluation.
  it("screenshot-table gate (#9030): once the recapture retry budget is exhausted, a still-erroring capture no longer defers the close", async () => {
    const buildCaptureSpy = vi.spyOn(visualCaptureModule, "buildCapture").mockRejectedValue(new Error("browserless connection refused"));
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
      REVIEW_AUDIT: memoryBudgetStore(),
    });
    // #10061: exhaustion is now decided by the durable, headSha-keyed capture-retry counter, not the
    // recapture-preview job's own `attempt` payload field -- pre-spend the budget for this head directly.
    for (let i = 0; i < MAX_CAPTURE_RETRY_ATTEMPTS; i += 1) {
      await recordCaptureRetryAttempt(env, "vis61");
    }
    const sentJobs: Array<Record<string, unknown>> = [];
    env.JOBS = { async send(message: Record<string, unknown>) { sentJobs.push(message); } } as unknown as Queue;
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 61,
      title: "Update the app index route",
      state: "open",
      user: { login: "visual-contributor" },
      head: { sha: "vis61" },
      labels: [{ name: "visual" }],
      body: "Changed the route layout, no table here.",
    });
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/61/files")) return Response.json([{ filename: "apps/loopover-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/61/reviews")) return Response.json([]);
      if (url.includes("/pulls/61/commits")) return Response.json([]);
      if (url.endsWith("/pulls/61") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 61, state: "closed" }); }
      if (url.endsWith("/pulls/61")) return Response.json({ number: 61, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis61" }, mergeable_state: "clean" });
      if (url.includes("/commits/vis61/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/vis61/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/vis61/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/61/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/61/comments")) return Response.json([]);
      if (url.endsWith("/labels") && method === "POST") return Response.json([]);
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 901 }, { status: 201 });
      if (url.includes("/check-runs/901") && method === "PATCH") return Response.json({ id: 901 });
      return new Response("not found", { status: 404 });
    });

    try {
      // The durable captureRetryAttemptCount(env, "vis61") already reads MAX_CAPTURE_RETRY_ATTEMPTS -> the
      // budget check bails BEFORE scheduling yet another retry or persisting the marker (see
      // scheduleVisualCaptureRetry) regardless of what `attempt` this delivery itself carries.
      await processJob(env, { type: "recapture-preview", deliveryId: "screenshot-table-capture-error-exhausted", repoFullName: "JSONbored/gittensory", prNumber: 61, installationId: 123, attempt: 0 });
    } finally {
      buildCaptureSpy.mockRestore();
    }

    // No retry chance remains -- the gate falls through to its normal (accurate) evaluation and closes.
    expect(seen.closed).toBe(true);
    const stored = await getPullRequest(env, "JSONbored/gittensory", 61);
    expect(stored?.visualCaptureRetryPendingSha).toBeNull();
    expect(sentJobs.some((job) => job.type === "recapture-preview")).toBe(false);
  });

  // #9462 regression: the sibling test above starts from a PR that never had a marker written, so it exercises
  // the budget-exhausted early return but NOT the defect. The failing sequence is marker-SET-then-EXHAUSTED:
  // the early return only skipped writing the marker AGAIN, so the previous attempt's marker stood forever --
  // the sole other clear (markPullRequestVisualCaptureSatisfied) needs a SUCCESSFUL capture, which by
  // definition never arrives when the pipeline keeps failing. A permanently marked head silently disabled the
  // screenshot gate's close for that head, turning a deliberately temporary deferral into a permanent bypass.
  it("screenshot-table gate (#9462): a marker written by an earlier attempt is CLEARED once the budget is exhausted", async () => {
    const buildCaptureSpy = vi.spyOn(visualCaptureModule, "buildCapture").mockRejectedValue(new Error("browserless connection refused"));
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
      REVIEW_AUDIT: memoryBudgetStore(),
    });
    const sentJobs: Array<Record<string, unknown>> = [];
    env.JOBS = { async send(message: Record<string, unknown>) { sentJobs.push(message); } } as unknown as Queue;
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 62,
      title: "Update the app index route",
      state: "open",
      user: { login: "visual-contributor" },
      head: { sha: "vis62" },
      labels: [{ name: "visual" }],
      body: "Changed the route layout, no table here.",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/62/files")) return Response.json([{ filename: "apps/loopover-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/62/reviews")) return Response.json([]);
      if (url.includes("/pulls/62/commits")) return Response.json([]);
      if (url.endsWith("/pulls/62") && method === "PATCH") return Response.json({ number: 62, state: "closed" });
      if (url.endsWith("/pulls/62")) return Response.json({ number: 62, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis62" }, mergeable_state: "clean" });
      if (url.includes("/commits/vis62/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/vis62/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/vis62/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/62/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/62/comments")) return Response.json([]);
      if (url.endsWith("/labels") && method === "POST") return Response.json([]);
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 902 }, { status: 201 });
      if (url.includes("/check-runs/902") && method === "PATCH") return Response.json({ id: 902 });
      return new Response("not found", { status: 404 });
    });

    try {
      // Attempt 0 errors -> the marker IS written for this head and a retry is scheduled (the durable
      // capture-retry counter for "vis62" goes from 0 -> 1).
      await processJob(env, { type: "recapture-preview", deliveryId: "screenshot-marker-clear-first", repoFullName: "JSONbored/gittensory", prNumber: 62, installationId: 123, attempt: 0 });
      expect((await getPullRequest(env, "JSONbored/gittensory", 62))?.visualCaptureRetryPendingSha).toBe("vis62");

      // #10061: spend the REST of the durable budget directly (simulating the remaining independent retries
      // that would otherwise have to run through the full webhook pipeline), so the NEXT delivery is the one
      // that finds the counter already at MAX_CAPTURE_RETRY_ATTEMPTS and exhausts it.
      for (let i = 1; i < MAX_CAPTURE_RETRY_ATTEMPTS; i += 1) {
        await recordCaptureRetryAttempt(env, "vis62");
      }

      // The final attempt exhausts the budget while the pipeline is still failing.
      await processJob(env, { type: "recapture-preview", deliveryId: "screenshot-marker-clear-exhausted", repoFullName: "JSONbored/gittensory", prNumber: 62, installationId: 123, attempt: MAX_PREVIEW_POLL_ATTEMPTS });
    } finally {
      buildCaptureSpy.mockRestore();
    }

    // The stale marker must not outlive the retries that justified it, or the gate stays disabled for this head.
    expect((await getPullRequest(env, "JSONbored/gittensory", 62))?.visualCaptureRetryPendingSha).toBeNull();
  });

  // #9462: the clear is best-effort, mirroring its sibling mark write -- a failed clear means the gate stays
  // deferred until the head moves, which is strictly better than letting a cleanup failure crash the pass.
  it("screenshot-table gate (#9462): a failed marker clear is swallowed (fail-safe) -- the pass still completes", async () => {
    const buildCaptureSpy = vi.spyOn(visualCaptureModule, "buildCapture").mockRejectedValue(new Error("browserless connection refused"));
    const clearSpy = vi.spyOn(repositoriesModule, "clearPullRequestVisualCaptureRetryPending").mockRejectedValue(new Error("D1 write failed"));
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
      REVIEW_AUDIT: memoryBudgetStore(),
    });
    // #10061: pre-spend the durable capture-retry budget for this head so the delivery below finds it exhausted.
    for (let i = 0; i < MAX_CAPTURE_RETRY_ATTEMPTS; i += 1) {
      await recordCaptureRetryAttempt(env, "vis63");
    }
    env.JOBS = { async send() {} } as unknown as Queue;
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 63,
      title: "Update the app index route",
      state: "open",
      user: { login: "visual-contributor" },
      head: { sha: "vis63" },
      labels: [{ name: "visual" }],
      body: "Changed the route layout, no table here.",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/63/files")) return Response.json([{ filename: "apps/loopover-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/63/reviews")) return Response.json([]);
      if (url.includes("/pulls/63/commits")) return Response.json([]);
      if (url.endsWith("/pulls/63") && method === "PATCH") return Response.json({ number: 63, state: "closed" });
      if (url.endsWith("/pulls/63")) return Response.json({ number: 63, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis63" }, mergeable_state: "clean" });
      if (url.includes("/commits/vis63/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/vis63/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/vis63/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/63/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/63/comments")) return Response.json([]);
      if (url.endsWith("/labels") && method === "POST") return Response.json([]);
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 903 }, { status: 201 });
      if (url.includes("/check-runs/903") && method === "PATCH") return Response.json({ id: 903 });
      return new Response("not found", { status: 404 });
    });

    try {
      // Must not throw even though the clear rejects.
      await expect(
        processJob(env, { type: "recapture-preview", deliveryId: "screenshot-marker-clear-failed", repoFullName: "JSONbored/gittensory", prNumber: 63, installationId: 123, attempt: MAX_PREVIEW_POLL_ATTEMPTS }),
      ).resolves.not.toThrow();
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
      buildCaptureSpy.mockRestore();
    }
  });

  // #10061: THE regression this fix closes. Independent triggers (a CI-completion webhook, a
  // deployment_status webhook, the maintenance sweep) all reach scheduleVisualCaptureRetry WITHOUT threading
  // previewPollAttempt, so before this fix each one independently re-armed a fresh 5-attempt budget and a
  // sustained renderer outage produced an UNBOUNDED number of retries. Drive MAX_PREVIEW_POLL_ATTEMPTS + 1
  // independent `pull_request` webhook deliveries (each one a fresh delivery carrying no previewPollAttempt,
  // exactly like a real CI-completion/deployment_status/sweep trigger) against a renderer that never
  // recovers: the durable per-head capture-retry budget must still cap the TOTAL number of recapture-preview
  // jobs enqueued across ALL of them at MAX_CAPTURE_RETRY_ATTEMPTS.
  it("screenshot-table gate (#10061): independent triggers with NO previewPollAttempt still bound the renderFailed retry chain to MAX_CAPTURE_RETRY_ATTEMPTS jobs total", async () => {
    const buildCaptureSpy = vi.spyOn(visualCaptureModule, "buildCapture").mockResolvedValue({
      routes: [{ path: "/app", afterUrl: "https://worker.example/loopover/shot?url=x", afterUrlMobile: "https://worker.example/loopover/shot?url=x" }],
      interactions: [],
      previewPending: false,
      renderFailed: true,
      previewUnobtainable: false,
    });
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
      REVIEW_AUDIT: memoryBudgetStore(),
    });
    const sentJobs: Array<Record<string, unknown>> = [];
    env.JOBS = { async send(message: Record<string, unknown>) { sentJobs.push(message); } } as unknown as Queue;
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/80/files")) return Response.json([{ filename: "apps/loopover-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/80/reviews")) return Response.json([]);
      if (url.includes("/pulls/80/commits")) return Response.json([]);
      if (url.endsWith("/pulls/80") && method === "PATCH") return Response.json({ number: 80, state: "closed" });
      if (url.endsWith("/pulls/80")) return Response.json({ number: 80, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis80" }, mergeable_state: "clean" });
      if (url.includes("/commits/vis80/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/vis80/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/vis80/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/80/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/80/comments")) return Response.json([]);
      if (url.endsWith("/labels") && method === "POST") return Response.json([]);
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 950 }, { status: 201 });
      if (url.includes("/check-runs/950") && method === "PATCH") return Response.json({ id: 950 });
      return new Response("not found", { status: 404 });
    });

    try {
      // MAX_PREVIEW_POLL_ATTEMPTS + 1 independent triggers -- each a plain `pull_request` delivery, so each
      // reaches scheduleVisualCaptureRetry with previewPollAttempt undefined (-> 0), exactly like the bug.
      for (let i = 0; i < MAX_PREVIEW_POLL_ATTEMPTS + 1; i += 1) {
        await processJob(env, {
          type: "github-webhook",
          deliveryId: `screenshot-multi-trigger-render-failed-80-${i}`,
          eventName: "pull_request",
          payload: {
            action: "opened",
            installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
            repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
            pull_request: {
              number: 80,
              title: "Update the app index route",
              state: "open",
              user: { login: "visual-contributor" },
              head: { sha: "vis80" },
              labels: [{ name: "visual" }],
              body: "Changed the route layout, no table here.",
              mergeable_state: "clean",
              reviewDecision: "APPROVED",
            },
          },
        });
      }
    } finally {
      buildCaptureSpy.mockRestore();
    }

    // At most MAX_CAPTURE_RETRY_ATTEMPTS recapture-preview jobs total, no matter how many independent
    // triggers fired -- the durable per-head budget, not any one trigger's own payload counter, bounded it.
    const recaptureJobs = sentJobs.filter((job) => job.type === "recapture-preview");
    expect(recaptureJobs).toHaveLength(MAX_CAPTURE_RETRY_ATTEMPTS);
  });

  // #10061 regression (named for this bug): the failure mode was not merely "too many retries" -- it was that
  // `visual_capture_retry_pending_at` kept getting RE-STAMPED by every independent trigger's mark write,
  // continually resetting VISUAL_CAPTURE_RETRY_LATCH_MAX_AGE_MS's deadline so the latch's own age bound could
  // never elapse either. Once the durable budget is spent, the LAST trigger must CLEAR both latch columns
  // instead of re-stamping them, so the latch genuinely becomes releasable (by this clear, or by its age bound
  // as a backstop) instead of being held open forever by a clock that never stops moving.
  it("screenshot-table gate (#10061): once independent triggers spend the budget, the latch is cleared instead of the clock being kept moving forever", async () => {
    const buildCaptureSpy = vi.spyOn(visualCaptureModule, "buildCapture").mockResolvedValue({
      routes: [{ path: "/app", afterUrl: "https://worker.example/loopover/shot?url=x", afterUrlMobile: "https://worker.example/loopover/shot?url=x" }],
      interactions: [],
      previewPending: false,
      renderFailed: true,
      previewUnobtainable: false,
    });
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
      REVIEW_AUDIT: memoryBudgetStore(),
    });
    env.JOBS = { async send() {} } as unknown as Queue;
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/81/files")) return Response.json([{ filename: "apps/loopover-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/81/reviews")) return Response.json([]);
      if (url.includes("/pulls/81/commits")) return Response.json([]);
      if (url.endsWith("/pulls/81") && method === "PATCH") return Response.json({ number: 81, state: "closed" });
      if (url.endsWith("/pulls/81")) return Response.json({ number: 81, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis81" }, mergeable_state: "clean" });
      if (url.includes("/commits/vis81/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/vis81/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/vis81/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/81/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/81/comments")) return Response.json([]);
      if (url.endsWith("/labels") && method === "POST") return Response.json([]);
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 951 }, { status: 201 });
      if (url.includes("/check-runs/951") && method === "PATCH") return Response.json({ id: 951 });
      return new Response("not found", { status: 404 });
    });

    try {
      for (let i = 0; i < MAX_PREVIEW_POLL_ATTEMPTS + 1; i += 1) {
        await processJob(env, {
          type: "github-webhook",
          deliveryId: `screenshot-multi-trigger-latch-81-${i}`,
          eventName: "pull_request",
          payload: {
            action: "opened",
            installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
            repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
            pull_request: {
              number: 81,
              title: "Update the app index route",
              state: "open",
              user: { login: "visual-contributor" },
              head: { sha: "vis81" },
              labels: [{ name: "visual" }],
              body: "Changed the route layout, no table here.",
              mergeable_state: "clean",
              reviewDecision: "APPROVED",
            },
          },
        });
      }
    } finally {
      buildCaptureSpy.mockRestore();
    }

    const stored = await getPullRequest(env, "JSONbored/gittensory", 81);
    expect(stored?.visualCaptureRetryPendingSha).toBeNull();
    expect(stored?.visualCaptureRetryPendingAt).toBeNull();
  });

  // #9876 regression, and the one that reached production: the #9462 clear above is UNREACHABLE in the case
  // that actually ends most retry chains. The durable per-head poll budget (preview-poll-budget.ts) terminates
  // the chain by suppressing `previewPending` -- so on the attempt that ends it, buildCapture RESOLVES with
  // previewPending false, renderFailed false and no real pair. The call site's `previewPending || renderFailed`
  // condition is false, scheduleVisualCaptureRetry is never called, and the budget-exhausted clear living
  // inside it never runs. The marker written by the earlier failing attempt then stands forever: the gate can
  // neither close the PR nor pass it, so nothing ever happens to it again. Three contributor PRs in
  // JSONbored/awesome-claude were frozen exactly this way, verified on the production ORB.
  //
  // Note this test never reaches MAX_PREVIEW_POLL_ATTEMPTS -- that is the whole point. The chain ends while
  // attempts remain, which is precisely why an exhaustion-triggered clear cannot be the guarantee.
  it("screenshot-table gate (#9876): a marker is CLEARED when the capture concludes, not only when the budget runs out", async () => {
    const buildCaptureSpy = vi.spyOn(visualCaptureModule, "buildCapture").mockRejectedValue(new Error("browserless connection refused"));
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
    });
    const sentJobs: Array<Record<string, unknown>> = [];
    env.JOBS = { async send(message: Record<string, unknown>) { sentJobs.push(message); } } as unknown as Queue;
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 70,
      title: "Update the app index route",
      state: "open",
      user: { login: "visual-contributor" },
      head: { sha: "vis70" },
      labels: [{ name: "visual" }],
      body: "Changed the route layout, no table here.",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/70/files")) return Response.json([{ filename: "apps/loopover-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/70/reviews")) return Response.json([]);
      if (url.includes("/pulls/70/commits")) return Response.json([]);
      if (url.endsWith("/pulls/70") && method === "PATCH") return Response.json({ number: 70, state: "closed" });
      if (url.endsWith("/pulls/70")) return Response.json({ number: 70, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis70" }, mergeable_state: "clean" });
      if (url.includes("/commits/vis70/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/vis70/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/vis70/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/70/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/70/comments")) return Response.json([]);
      if (url.endsWith("/labels") && method === "POST") return Response.json([]);
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 903 }, { status: 201 });
      if (url.includes("/check-runs/903") && method === "PATCH") return Response.json({ id: 903 });
      return new Response("not found", { status: 404 });
    });

    try {
      // Attempt 0 errors -> the marker IS written for this head and a retry is scheduled.
      await processJob(env, { type: "recapture-preview", deliveryId: "screenshot-latch-conclusive-first", repoFullName: "JSONbored/gittensory", prNumber: 70, installationId: 123, attempt: 0 });
      const marked = await getPullRequest(env, "JSONbored/gittensory", 70);
      expect(marked?.visualCaptureRetryPendingSha).toBe("vis70");
      // #9876: the mark is dated, so its age alone can release it later.
      expect(marked?.visualCaptureRetryPendingAt).toEqual(expect.any(String));

      // The durable budget now ends the chain: the capture RESOLVES with nothing pending and nothing broken,
      // while attempts formally remain. Neither branch that could reschedule fires.
      buildCaptureSpy.mockResolvedValue({ routes: [], interactions: [], previewPending: false, renderFailed: false, previewUnobtainable: false });
      await processJob(env, { type: "recapture-preview", deliveryId: "screenshot-latch-conclusive-final", repoFullName: "JSONbored/gittensory", prNumber: 70, installationId: 123, attempt: 1 });
    } finally {
      buildCaptureSpy.mockRestore();
    }

    // A conclusive capture answers the question the latch was deferring, so the latch must be gone -- both
    // fields, or a dated-but-shaless row would confuse the next read.
    const stored = await getPullRequest(env, "JSONbored/gittensory", 70);
    expect(stored?.visualCaptureRetryPendingSha).toBeNull();
    expect(stored?.visualCaptureRetryPendingAt).toBeNull();
    // And no further retry was scheduled by that final pass -- the chain really did end here.
    expect(sentJobs.filter((job) => job.type === "recapture-preview")).toHaveLength(1);
  });

  // #9876: the conclusive clear is best-effort, mirroring the #9462 clear it backs up -- a cleanup write that
  // fails must not crash the pass, because the pass is also what publishes the review. The latch simply stays
  // until its age releases it, which is strictly better than losing the whole pass to a failed cleanup.
  it("screenshot-table gate (#9876): a failed conclusive clear is swallowed -- the pass still completes", async () => {
    const buildCaptureSpy = vi.spyOn(visualCaptureModule, "buildCapture").mockResolvedValue({ routes: [], interactions: [], previewPending: false, renderFailed: false, previewUnobtainable: false });
    const clearSpy = vi
      .spyOn(repositoriesModule, "clearPullRequestVisualCaptureRetryPending")
      .mockRejectedValue(new Error("d1 write failed"));
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
    });
    env.JOBS = { async send() {} } as unknown as Queue;
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 73,
      title: "Update the app index route",
      state: "open",
      user: { login: "visual-contributor" },
      head: { sha: "vis73" },
      labels: [{ name: "visual" }],
      body: "Changed the route layout, no table here.",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/73/files")) return Response.json([{ filename: "apps/loopover-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/73/reviews")) return Response.json([]);
      if (url.includes("/pulls/73/commits")) return Response.json([]);
      if (url.endsWith("/pulls/73") && method === "PATCH") return Response.json({ number: 73, state: "closed" });
      if (url.endsWith("/pulls/73")) return Response.json({ number: 73, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis73" }, mergeable_state: "clean" });
      if (url.includes("/commits/vis73/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/vis73/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/vis73/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/73/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/73/comments")) return Response.json([]);
      if (url.endsWith("/labels") && method === "POST") return Response.json([]);
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 906 }, { status: 201 });
      if (url.includes("/check-runs/906") && method === "PATCH") return Response.json({ id: 906 });
      return new Response("not found", { status: 404 });
    });

    try {
      await expect(
        processJob(env, { type: "recapture-preview", deliveryId: "screenshot-latch-clear-failed", repoFullName: "JSONbored/gittensory", prNumber: 73, installationId: 123, attempt: 1 }),
      ).resolves.not.toThrow();
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
      buildCaptureSpy.mockRestore();
    }
  });

  // #9876: the latch means "a retry is coming". The enqueue that makes that true is best-effort by design, so
  // writing the latch BEFORE it inverted the meaning -- a failed send left a latch behind with no retry in
  // existence that could ever release it, and the gate then deferred on a promise nothing was keeping.
  it("screenshot-table gate (#9876): a failed retry enqueue leaves NO latch behind", async () => {
    const buildCaptureSpy = vi.spyOn(visualCaptureModule, "buildCapture").mockRejectedValue(new Error("browserless connection refused"));
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
    });
    env.JOBS = { async send() { throw new Error("queue unavailable"); } } as unknown as Queue;
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 71,
      title: "Update the app index route",
      state: "open",
      user: { login: "visual-contributor" },
      head: { sha: "vis71" },
      labels: [{ name: "visual" }],
      body: "Changed the route layout, no table here.",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/71/files")) return Response.json([{ filename: "apps/loopover-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/71/reviews")) return Response.json([]);
      if (url.includes("/pulls/71/commits")) return Response.json([]);
      if (url.endsWith("/pulls/71") && method === "PATCH") return Response.json({ number: 71, state: "closed" });
      if (url.endsWith("/pulls/71")) return Response.json({ number: 71, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis71" }, mergeable_state: "clean" });
      if (url.includes("/commits/vis71/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/vis71/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/vis71/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/71/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/71/comments")) return Response.json([]);
      if (url.endsWith("/labels") && method === "POST") return Response.json([]);
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 904 }, { status: 201 });
      if (url.includes("/check-runs/904") && method === "PATCH") return Response.json({ id: 904 });
      return new Response("not found", { status: 404 });
    });

    try {
      // The pass still completes -- a queue outage is not a crash.
      await expect(
        processJob(env, { type: "recapture-preview", deliveryId: "screenshot-latch-enqueue-failed", repoFullName: "JSONbored/gittensory", prNumber: 71, installationId: 123, attempt: 0 }),
      ).resolves.not.toThrow();
    } finally {
      buildCaptureSpy.mockRestore();
    }

    // No retry exists, so no deferral may be claimed. The gate evaluates the evidence it has instead of
    // freezing the PR -- the safe direction for a failure in the thing the latch is a promise about.
    const stored = await getPullRequest(env, "JSONbored/gittensory", 71);
    expect(stored?.visualCaptureRetryPendingSha).toBeNull();
    expect(stored?.visualCaptureRetryPendingAt).toBeNull();
  });

  // #9876: the backstop. Even with both releases above wired, a latch is still released only by code that
  // runs -- and this latch has now had two separate releases proven unreachable in production. A latch older
  // than any possible retry chain is stale by arithmetic, so the gate stops deferring on it whatever did or
  // did not run. This is what unfreezes rows written before the timestamp column existed, which is why a sha
  // with a NULL date reads as expired rather than live.
  it("screenshot-table gate (#9876): an undatable latch expires instead of deferring the gate forever", async () => {
    // Screenshots deliberately OFF for this pass: a pass that DOES capture re-stamps the latch itself (and
    // rightly so), which would mask the backstop. The stale latch must be released by its own age on a pass
    // where nothing recaptures -- exactly the maintenance pass that finds a PR frozen by an old outage.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    const seen = { closed: false };
    env.JOBS = { async send() {} } as unknown as Queue;
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 72,
      title: "Update the app index route",
      state: "open",
      user: { login: "visual-contributor" },
      head: { sha: "vis72" },
      labels: [{ name: "visual" }],
      body: "Changed the route layout, no table here.",
    });
    // Exactly the production state: a latch for the live head, with no recorded date -- the row predates the
    // column. Written directly because no code path can produce it any more, which is the point.
    await env.DB.prepare("update pull_requests set visual_capture_retry_pending_sha = ?, visual_capture_retry_pending_at = null where repo_full_name = ? and number = ?")
      .bind("vis72", "JSONbored/gittensory", 72)
      .run();

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/72/files")) return Response.json([{ filename: "apps/loopover-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/72/reviews")) return Response.json([]);
      if (url.includes("/pulls/72/commits")) return Response.json([]);
      if (url.endsWith("/pulls/72") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 72, state: "closed" }); }
      if (url.endsWith("/pulls/72")) return Response.json({ number: 72, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis72" }, mergeable_state: "clean" });
      if (url.includes("/commits/vis72/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/vis72/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/vis72/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/72/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/72/comments")) return Response.json([]);
      if (url.endsWith("/labels") && method === "POST") return Response.json([]);
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 905 }, { status: 201 });
      if (url.includes("/check-runs/905") && method === "PATCH") return Response.json({ id: 905 });
      return new Response("not found", { status: 404 });
    });

    // A maintenance pass on the frozen row: no capture runs, so only the latch decides.
    await processJob(env, { type: "agent-regate-pr", deliveryId: "screenshot-latch-expired-regate", repoFullName: "JSONbored/gittensory", prNumber: 72, installationId: 123, force: true });

    // The gate reaches a decision instead of deferring for the 51st time.
    expect(seen.closed).toBe(true);
    // And the expiry is named in the audit trail -- this state used to freeze a PR invisibly, so its
    // recurrence must be visible.
    const expiredAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
      .bind("github_app.visual_capture_retry_latch_expired", "JSONbored/gittensory#72")
      .first<{ n: number }>();
    expect(expiredAudit?.n).toBe(1);
  });

  // #9881: `block` is the middle tier. `close` destroys a contributor PR that simply has not attached
  // screenshots yet -- unrecoverable, since they cannot reopen -- and `advisory` enforces nothing at all.
  it("screenshot-table gate (#9881): action=block HOLDS the PR with a reason instead of closing it", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[] };
    env.JOBS = { async send() {} } as unknown as Queue;
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto", merge: "auto" } });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true, action: "block", whenLabels: ["visual"] }, reviewCheckMode: "required" } }, "repo_file");
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 74, title: "Update the app index route", state: "open", user: { login: "visual-contributor" },
      head: { sha: "vis74" }, labels: [{ name: "visual" }], body: "Changed the route layout, no table here.",
    });

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/74/files")) return Response.json([{ filename: "apps/loopover-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/74/reviews")) return Response.json([{ state: "APPROVED", user: { login: "JSONbored" }, submitted_at: "2026-07-30T10:00:00Z" }]);
      if (url === "https://api.github.com/graphql") return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
      // A REAL required context (matching the status stub below): an empty list makes CI "resolved but
      // unverifiable", which is itself a hold reason and would mask the block tier under a different one.
      if (url.includes("/branches/")) return Response.json({ contexts: ["ci/build"] });
      if (url.includes("/pulls/74/commits")) return Response.json([]);
      if (url.endsWith("/pulls/74") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 74, state: "closed" }); }
      if (url.includes("/pulls/74/merge")) { seen.merged = true; return Response.json({ merged: true }); }
      if (url.endsWith("/pulls/74")) return Response.json({ number: 74, state: "open", user: { login: "visual-contributor" }, head: { sha: "vis74" }, mergeable_state: "clean" });
      if (url.includes("/commits/vis74/status")) return Response.json({ state: "success", statuses: [{ context: "ci/build", state: "success", description: "ok" }] });
      if (url.includes("/commits/vis74/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "ci/build", status: "completed", conclusion: "success" }] });
      if (url.includes("/commits/vis74/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/74/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/74/comments") && method === "POST") { seen.comments.push(String(JSON.parse(String(init?.body ?? "{}")).body ?? "")); return Response.json({ id: 1 }); }
      if (url.includes("/issues/74/comments")) return Response.json([]);
      if (url.endsWith("/labels") && method === "POST") { seen.labels.push(...(JSON.parse(String(init?.body ?? "{}")).labels ?? [])); return Response.json([]); }
      if (url.endsWith("/check-runs") && method === "POST") return Response.json({ id: 907 }, { status: 201 });
      if (url.includes("/check-runs/907") && method === "PATCH") return Response.json({ id: 907 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, { type: "agent-regate-pr", deliveryId: "screenshot-block-tier", repoFullName: "JSONbored/gittensory", prNumber: 74, installationId: 123, force: true });

    // The load-bearing distinction from `close`: the PR survives, and it is not merged either.
    expect(seen.closed).toBe(false);
    expect(seen.merged).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n).toBe(0);
    // The PR is parked for review rather than silently ignored.
    expect(seen.labels.join(",")).toContain("manual-review");
    // The hold's MESSAGE is asserted in agent-actions.test.ts (#9881) rather than here, and deliberately so:
    // every sibling hold (priorityEligibilityHold, migrationCollisionHold, advisoryCheckHold) is gated on
    // `reviewGood`, which a bare regate cannot reach -- it skips the AI review, so the gate conclusion is
    // `neutral`. Driving a full AI-review pass here to re-assert one string would test the harness, not the
    // tier. What only the pipeline can prove is this: a violated `block` gate reaches a real decision and the
    // PR still exists afterwards.
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
      await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto", review_state_label: "auto" }, gatePack: "oss-anti-slop" });
      await upsertRepoFocusManifest(env, "owner/repo", {
        settings: { checkRunMode: "off", commentMode: "off", publicSurface: "off", aiReviewMode: "off", reviewCheckMode: "required" },
        ...(opts.premergeContentRecheck !== undefined ? { gate: { premergeContentRecheck: opts.premergeContentRecheck } } : {}),
      });
      await upsertPullRequestFromGitHub(env, "owner/repo", { number: prNumber, title: "Migration PR", state: "open", user: { login: "contributor" }, head: { sha: "sha1" }, base: { ref: "main" }, labels: [], body: "" });
    }

    it("holds a would-otherwise-merge PR while its linked priority issue is still inside the eligibility window (#9738)", async () => {
      // The end-to-end shape of the rule: a clean, approved, green PR that would MERGE is held instead,
      // because the priority issue it closes only became public minutes ago. Held, never closed -- the PR
      // is early, not wrong.
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedMigrationRecheckRepo(env, 61);
      await upsertPullRequestFromGitHub(env, "owner/repo", {
        number: 61,
        title: "Fix the thing",
        state: "open",
        user: { login: "contributor" },
        head: { sha: "sha1" },
        base: { ref: "main" },
        labels: [],
        body: "Closes #7",
        created_at: new Date(Date.now() - 60_000).toISOString(),
      } as never);
      const seen = { closed: false, merged: false, labels: [] as string[], comments: [] as string[], treeCalls: 0 };
      stubMigrationRecheckFetch(61, { filename: "src/a.ts", status: "modified" }, [], seen);
      // The one extra fact the rule needs: the priority label landed on issue #7 a minute ago, so the
      // 30-minute window has not elapsed.
      const inner = globalThis.fetch as typeof fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://api.github.com/graphql" && String(init?.body ?? "").includes("LABELED_EVENT")) {
          return Response.json({
            data: {
              repository: {
                issue: {
                  timelineItems: {
                    nodes: [{ createdAt: new Date(Date.now() - 60_000).toISOString(), label: { name: "gittensor:priority" } }],
                  },
                },
              },
            },
          });
        }
        return inner(input as never, init as never);
      });

      await processJob(env, { type: "agent-regate-pr", deliveryId: "priority-eligibility-hold", repoFullName: "owner/repo", prNumber: 61, installationId: 123 });

      expect(seen.merged, "an unelapsed window must stop the auto-merge").toBe(false);
      expect(seen.closed, "a hold is never a close -- the contributor keeps their work").toBe(false);
      expect(seen.comments.some((c) => c.includes("continues normally")), "the comment reads as a wait, not a rejection").toBe(true);
    });

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
      await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto", review_state_label: "auto" }, gatePack: "oss-anti-slop" });
      await upsertRepoFocusManifest(env, "owner/repo", { settings: { checkRunMode: "off", commentMode: "off", publicSurface: "off", aiReviewMode: "off", reviewCheckMode: "required" }, gate: { premergeContentRecheck: true } });
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
      await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: opts.autonomy ?? { merge: "auto", review_state_label: "auto" }, gatePack: "oss-anti-slop" });
      await upsertRepoFocusManifest(env, "owner/repo", {
        settings: {
          checkRunMode: "off",
          commentMode: "off",
          publicSurface: "off",
          aiReviewMode: "off",
          reviewCheckMode: "required",
          ...(opts.guardrailMode !== undefined ? { unlinkedIssueGuardrail: { mode: opts.guardrailMode } } : {}),
        },
      });
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
    function stubFreshRebaseFetch(prNumber: number, opts: { baseAdvancedAt: string | null; mergeableState?: string; headSha?: string; aheadBy?: number }, seen: { merged: boolean; updateBranchCalls: number; baseCommitCalls: number; compareCalls?: number }) {
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
        if (url.includes("/compare/")) {
          seen.compareCalls = (seen.compareCalls ?? 0) + 1;
          return Response.json({ ahead_by: opts.aheadBy ?? 0, behind_by: 0 });
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

    async function seedFreshRebaseRepo(env: Env, prNumber: number, opts: { requireFreshRebaseWindowMinutes?: number | null; staleBaseAheadByThreshold?: number | null; autonomy?: Record<string, string> } = {}) {
      await upsertInstallation(env, {
        installation: { id: 123, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { contents: "write", pull_requests: "write", issues: "write" }, events: [] },
      });
      // default_branch is what the #9497 staleness compare anchors on (getRepository(...).defaultBranch).
      await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" }, default_branch: "main" }, 123);
      await upsertRepositorySettings(env, {
        repoFullName: "owner/repo",
        autonomy: opts.autonomy ?? { merge: "auto", update_branch: "auto", label: "auto" },
        gatePack: "oss-anti-slop",
        ...(opts.requireFreshRebaseWindowMinutes !== undefined ? { requireFreshRebaseWindowMinutes: opts.requireFreshRebaseWindowMinutes } : {}),
        ...(opts.staleBaseAheadByThreshold !== undefined ? { staleBaseAheadByThreshold: opts.staleBaseAheadByThreshold } : {}),
      });
      await upsertRepoFocusManifest(env, "owner/repo", { settings: { checkRunMode: "off", commentMode: "off", publicSurface: "off", aiReviewMode: "off", reviewCheckMode: "required", autoMaintain: { requireApprovals: 0, mergeMethod: "squash" } } });
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

    // #9497: the staleness threshold MOVED here from the readiness gate, so it now inherits the three guards
    // that path had none of -- imminent merge, clean mergeable state, and the 3-per-PR-per-24h cap keyed on PR
    // number. In the readiness gate it fired on any review pass, so an unrelated merge advancing the default
    // branch rebased a whole woken cohort mid-CI; here it fires only for the PR actually about to merge.
    it("#9497 forces update_branch at the MERGE boundary when the default branch is far enough ahead", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedFreshRebaseRepo(env, 95, { staleBaseAheadByThreshold: 5 });
      const seen = { merged: false, updateBranchCalls: 0, baseCommitCalls: 0, compareCalls: 0 };
      stubFreshRebaseFetch(95, { baseAdvancedAt: new Date(Date.now() - 60 * 60_000).toISOString(), aheadBy: 10 }, seen);

      await processJob(env, { type: "agent-regate-pr", deliveryId: "stale-threshold-merge-boundary", repoFullName: "owner/repo", prNumber: 95, installationId: 123 });

      expect(seen.compareCalls).toBe(1);
      expect(seen.updateBranchCalls).toBe(1); // 10 >= threshold 5
      expect(seen.merged).toBe(false); // the rebase defers the merge; the synchronize re-triggers evaluation
    });

    it("#9497 does NOT rebase when the default branch is ahead but below the threshold", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedFreshRebaseRepo(env, 96, { staleBaseAheadByThreshold: 5 });
      const seen = { merged: false, updateBranchCalls: 0, baseCommitCalls: 0, compareCalls: 0 };
      stubFreshRebaseFetch(96, { baseAdvancedAt: new Date(Date.now() - 60 * 60_000).toISOString(), aheadBy: 2 }, seen);

      await processJob(env, { type: "agent-regate-pr", deliveryId: "stale-threshold-below", repoFullName: "owner/repo", prNumber: 96, installationId: 123 });

      expect(seen.updateBranchCalls).toBe(0);
      expect(seen.merged).toBe(true);
    });

    it("#9497 skips the compare read when the repo has no stored default branch (nothing to compare against)", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedFreshRebaseRepo(env, 98, { staleBaseAheadByThreshold: 5 });
      // Clear the stored default branch so the compare has no ref to anchor on.
      await env.DB.prepare("UPDATE repositories SET default_branch = NULL WHERE full_name = ?").bind("owner/repo").run();
      const seen = { merged: false, updateBranchCalls: 0, baseCommitCalls: 0, compareCalls: 0 };
      stubFreshRebaseFetch(98, { baseAdvancedAt: new Date(Date.now() - 60 * 60_000).toISOString(), aheadBy: 999 }, seen);

      await processJob(env, { type: "agent-regate-pr", deliveryId: "stale-threshold-no-default-branch", repoFullName: "owner/repo", prNumber: 98, installationId: 123 });

      expect(seen.compareCalls).toBe(0);
      expect(seen.updateBranchCalls).toBe(0);
      expect(seen.merged).toBe(true);
    });

    it("#9497 records the cap-exceeded audit with the staleness trigger named, once the 24h cap is spent", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedFreshRebaseRepo(env, 99, { staleBaseAheadByThreshold: 5 });
      const seen = { merged: false, updateBranchCalls: 0, baseCommitCalls: 0, compareCalls: 0 };
      stubFreshRebaseFetch(99, { baseAdvancedAt: new Date(Date.now() - 60 * 60_000).toISOString(), aheadBy: 10 }, seen);

      // Spend the per-PR forced-rebase budget so the next attempt hits the cap branch.
      for (let i = 0; i < 3; i += 1) {
        await processJob(env, { type: "agent-regate-pr", deliveryId: `stale-cap-${i}`, repoFullName: "owner/repo", prNumber: 99, installationId: 123 });
      }
      await processJob(env, { type: "agent-regate-pr", deliveryId: "stale-cap-final", repoFullName: "owner/repo", prNumber: 99, installationId: 123 });

      const capped = await env.DB.prepare("select detail from audit_events where event_type = ? order by created_at desc limit 1")
        .bind("agent.action.fresh_rebase_window_cap_exceeded")
        .first<{ detail: string }>();
      // The audit names WHICH trigger fired, not just the freshness window it used to hardcode.
      expect(capped?.detail).toContain("commits ahead");
    });

    it("#9497 INVARIANT: no compare call at all when no threshold is configured (zero added cost)", async () => {
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      await seedFreshRebaseRepo(env, 97, {});
      const seen = { merged: false, updateBranchCalls: 0, baseCommitCalls: 0, compareCalls: 0 };
      stubFreshRebaseFetch(97, { baseAdvancedAt: new Date(Date.now() - 60 * 60_000).toISOString(), aheadBy: 999 }, seen);

      await processJob(env, { type: "agent-regate-pr", deliveryId: "stale-threshold-unset", repoFullName: "owner/repo", prNumber: 97, installationId: 123 });

      expect(seen.compareCalls).toBe(0);
      expect(seen.updateBranchCalls).toBe(0);
      expect(seen.merged).toBe(true);
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
      autonomy: { close: "auto", label: "auto" },
      // The label is the configurable `.loopover.yml` value below — nothing is hard-coded.
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", contributorCapLabel: "spam-cap", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2 } }, "repo_file");
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

    // #7284-fix: the cap short-circuit now runs on PR-open BEFORE the AI review pipeline ever starts (the
    // whole point of the fix -- an over-cap PR must never pay for a review it's about to be closed for
    // anyway), so the AI review never runs at all for this PR. Deterministic gate: closed + labeled (with the
    // configured label) regardless.
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
    // #9134 REGRESSION: this early cap-on-open close path used to write NO decision record and NO ledger row
    // at all -- exactly the contributor-disputable close the issue flagged as biasing the risk-control
    // calibration join. It must now emit both, by construction (the executor's shared record hook).
    const decisionRecord = await env.DB.prepare("select action, reason_code from decision_records where repo_full_name = ? and pull_number = 55").bind("JSONbored/gittensory").first<{ action: string; reason_code: string }>();
    expect(decisionRecord).toMatchObject({ action: "close", reason_code: "policy_close:contributor_cap" });
    const ledgerRows = await env.DB.prepare("select count(*) as n from decision_ledger").first<{ n: number }>();
    expect(ledgerRows?.n).toBeGreaterThanOrEqual(1);
  });

  it("#9125: listOtherOpenPullRequestsForAuthor matches on the immutable authorGithubId when present, surviving a rename that would otherwise clear the cap", async () => {
    const env = createTestEnv();
    // Two PRs opened under the OLD login, one under the NEW (post-rename) login -- all the SAME immutable id.
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 1, title: "old-login PR 1", state: "open", user: { login: "farmer99", id: 555 }, head: { sha: "s1" }, labels: [], body: "" });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 2, title: "old-login PR 2", state: "open", user: { login: "farmer99", id: 555 }, head: { sha: "s2" }, labels: [], body: "" });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 3, title: "new-login PR", state: "open", user: { login: "farmer99x", id: 555 }, head: { sha: "s3" }, labels: [], body: "" });
    // A genuinely unrelated PR, different id and login entirely -- must never be counted.
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 4, title: "unrelated", state: "open", user: { login: "someone-else", id: 999 }, head: { sha: "s4" }, labels: [], body: "" });

    // Without threading the id (login-only, pre-#9125 behavior): the renamed PR (#3) is invisible to a query
    // scoped to the OLD login -- exactly the gap that let a rename clear the cap.
    const loginOnly = await listOtherOpenPullRequestsForAuthor(env, "owner/repo", 1, "farmer99");
    expect(loginOnly.map((pr) => pr.number).sort()).toEqual([2]);

    // With the id threaded through: PR #2 (same old login) AND PR #3 (renamed, same id) both count; the
    // unrelated PR #4 never does.
    const withId = await listOtherOpenPullRequestsForAuthor(env, "owner/repo", 1, "farmer99", 555);
    expect(withId.map((pr) => pr.number).sort()).toEqual([2, 3]);
  });

  it("pre-merge contributor-cap re-check (#7284-fix): a contributor well UNDER a configured cap merges normally through the full pipeline", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: { contents: "write", pull_requests: "write", issues: "write" }, events: [] },
    });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "owner/repo",
      autonomy: { merge: "auto", label: "auto" },
      gatePack: "oss-anti-slop",
    });
    // A cap of 2 is configured, but this is the author's ONLY open PR -- well under cap, so the merge must
    // actually execute (the pre-merge recheck closure gets constructed AND invoked, confirms still under cap).
    await upsertRepoFocusManifest(env, "owner/repo", { settings: { checkRunMode: "off", commentMode: "off", publicSurface: "off", aiReviewMode: "off", reviewCheckMode: "required", contributorOpenPrCap: 2, autoMaintain: { requireApprovals: 0, mergeMethod: "squash" } } });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 92, title: "Soloist's only PR", state: "open", user: { login: "soloist1" }, head: { sha: "sha92" }, base: { ref: "main" }, labels: [], body: "" });
    const seen = { merged: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/\d+(?:\?|$)/.test(url) && method === "GET" && !url.includes("/pulls/92/")) {
        return Response.json({ number: 92, state: "open", user: { login: "soloist1" }, head: { sha: "sha92" }, base: { ref: "main", sha: "base" }, mergeable_state: "clean", labels: [] });
      }
      if (url.includes("/pulls/92/files")) return Response.json([{ filename: "src/index.ts", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+export const x = 1;" }]);
      if (url.includes("/commits/sha92/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/sha92/status")) return Response.json({ state: "success", statuses: [{ context: "ci/build", state: "success", description: "ok" }] });
      if (url.includes("/commits/sha92/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/branches/")) return Response.json({ contexts: [] });
      if (url === "https://api.github.com/graphql") return Response.json({ data: { repository: { pullRequest: { reviewDecision: "APPROVED" } } } });
      if (url.includes("/pulls/92/merge") && method === "PUT") { seen.merged = true; return Response.json({ merged: true, sha: "merged-sha92" }); }
      if (url.includes("/issues/92/labels")) return Response.json([]);
      if (url.includes("/issues/92/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, { type: "agent-regate-pr", deliveryId: "under-cap-merge", repoFullName: "owner/repo", prNumber: 92, installationId: 123 });

    expect(seen.merged).toBe(true);
    const merge = await env.DB.prepare("select outcome from audit_events where event_type = 'agent.action.merge'").first<{ outcome: string }>();
    expect(merge?.outcome).toBe("completed");
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2, autoCloseExemptLogins: ["sentry[bot]"] } });
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

  it("early cap short-circuit (#7284-fix): a contended per-author lock skips the early check and falls through to the normal pipeline, rather than blocking or racing", async () => {
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
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 53, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f53" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR two", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", contributorCapLabel: "spam-cap", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2 } }, "repo_file");
    // Simulate a concurrent sibling pass already deciding for this same author -- the early check must
    // gracefully skip (not throw, not block) rather than race it.
    await env.SELFHOST_TRANSIENT_CACHE?.claim?.("contributor-cap-lock:jsonbored/gittensory:farmer99", "someone-else-token", 30);
    const seen = { closed: false, labels: [] as string[] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/56/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/56/reviews")) return Response.json([]);
      if (url.includes("/pulls/56/commits")) return Response.json([]);
      if ((url.endsWith("/pulls/53") || url.endsWith("/pulls/54")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/pulls/56") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 56, state: "closed" }); }
      if (url.endsWith("/pulls/56")) return Response.json({ number: 56, state: "open", user: { login: "farmer99" }, head: { sha: "f56" }, mergeable_state: "clean" });
      if (url.includes("/commits/f56/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f56/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/56/labels") && method === "GET") return Response.json([]);
      if (url.includes("/issues/56/labels") && method === "POST") { seen.labels.push(...((JSON.parse(String(init?.body ?? "{}")).labels ?? []) as string[])); return Response.json([]); }
      if (url.includes("/issues/56/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-cap-lock-contended",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 56, title: "Farmer's 3rd PR", state: "open", user: { login: "farmer99" }, head: { sha: "f56" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    // The early path skipped itself (lock contended) -- unlike the uncontended "3rd PR" test above (aiCalls
    // stays 0 there), the pipeline actually ran this time, proving the early check gracefully backed off
    // instead of throwing or racing the concurrent holder.
    expect(aiCalls).toBeGreaterThan(0);
  });

  it("early cap short-circuit (#8805): a contended PER-PR actuation lock defers the close cleanly — no cross-namespace race with a sibling mutating pass", async () => {
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
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 53, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f53" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR two", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "y" });
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", contributorCapLabel: "spam-cap", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2 } }, "repo_file");
    // A sibling mutating pass (e.g. a sweep-fanned agent-regate-pr) already holds THIS PR's actuation lock —
    // pre-#8805 the early cap close executed anyway, outside the shared namespace. Now it must defer.
    await env.SELFHOST_TRANSIENT_CACHE?.claim?.("pr-actuation-lock:jsonbored/gittensory#56", "sibling-pass-token", 30);
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/56/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/56/reviews")) return Response.json([]);
      if (url.includes("/pulls/56/commits")) return Response.json([]);
      if ((url.endsWith("/pulls/53") || url.endsWith("/pulls/54")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/pulls/56") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 56, state: "closed" }); }
      if (url.endsWith("/pulls/56")) return Response.json({ number: 56, state: "open", user: { login: "farmer99" }, head: { sha: "f56" }, mergeable_state: "clean" });
      if (url.includes("/commits/f56/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f56/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/56/labels")) return Response.json([]);
      if (url.includes("/issues/56/comments")) return Response.json([]);
      return Response.json({});
    });

    // #9013: the public-surface publish call now claims this SAME still-held actuation lock BEFORE it (or the
    // trailing maintenance pass) does anything, so the contention now surfaces there instead of at the
    // trailing maintenance call's own (later) claim -- publish and maintain defer together, as ONE unit. The
    // early-cap short-circuit under test here is a different call site and still defers cleanly (its own
    // `return false`, unchanged); it's the REST of the pipeline that no longer "falls through" past a still-
    // held lock the way it used to pre-#9013.
    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "contributor-cap-pr-lock-contended",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
          pull_request: { number: 56, title: "Farmer's 3rd PR", state: "open", user: { login: "farmer99" }, head: { sha: "f56" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
        },
      }),
    ).rejects.toMatchObject({ name: "PrActuationLockContendedError" });

    // The early close DEFERRED (no PATCH close fired from it) and the REST of the pass deferred too, both
    // parts of the SAME lock namespace now (#9013) -- unlike pre-#9013, the AI review never ran either.
    expect(seen.closed).toBe(false);
    expect(aiCalls).toBe(0);
  });

  it("early cap short-circuit (#7284-fix): close autonomy not granted (observe) plans nothing early -- no crash, falls through to the normal pipeline", async () => {
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
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 53, title: "Farmer PR one", state: "open", user: { login: "farmer99" }, head: { sha: "f53" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 54, title: "Farmer PR two", state: "open", user: { login: "farmer99" }, head: { sha: "f54" }, labels: [], body: "y" });
    // close autonomy is "observe" (not "auto") -- over cap, but nothing may act on it.
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "observe", label: "observe" } });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", contributorCapLabel: "spam-cap", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2 } }, "repo_file");
    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/57/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      if (url.includes("/pulls/57/reviews")) return Response.json([]);
      if (url.includes("/pulls/57/commits")) return Response.json([]);
      if ((url.endsWith("/pulls/53") || url.endsWith("/pulls/54")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/pulls/57") && method === "PATCH") { seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed"; return Response.json({ number: 57, state: "closed" }); }
      if (url.endsWith("/pulls/57")) return Response.json({ number: 57, state: "open", user: { login: "farmer99" }, head: { sha: "f57" }, mergeable_state: "clean" });
      if (url.includes("/commits/f57/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/f57/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/issues/57/labels")) return Response.json([]);
      if (url.includes("/issues/57/comments")) return Response.json([]);
      return Response.json({});
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-cap-observe-autonomy",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 57, title: "Farmer's 3rd PR (observe)", state: "open", user: { login: "farmer99" }, head: { sha: "f57" }, labels: [], body: "x", mergeable_state: "clean", reviewDecision: "APPROVED" },
      },
    });

    // planContributorCapClose returns an empty plan (observe autonomy never "acts") -- the early path correctly
    // no-ops instead of crashing on an empty planned array, and the pipeline runs normally afterward.
    expect(seen.closed).toBe(false);
    expect(aiCalls).toBeGreaterThan(0);
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2, contributorCapCancelCi: true } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2, contributorCapCancelCi: true } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2, contributorCapCancelCi: true } });
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
      autonomy: { close: "auto", label: "auto" },
      // contributorCapCancelCi intentionally omitted — off by default, no CONTRIBUTOR_CAP_CANCEL_CI_DEFAULT set.
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2 } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2, contributorCapCancelCi: true } });
    const seen = { closed: false, cancelledIds: [] as number[], listedStatuses: [] as string[] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2, contributorCapCancelCi: true } });
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
      autonomy: { close: "auto", label: "auto" },
      // contributorCapCancelCi intentionally omitted (null) -- falls back to the env var default above.
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2 } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2, contributorCapCancelCi: false } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 1 } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "off", publicSurface: "off", checkRunMode: "off", reviewCheckMode: "required", contributorOpenPrCap: 100 } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory" } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2 } });
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
      autonomy: { close: "auto", label: "auto" },
      // Deliberately NO contributorOpenPrCap here — only the install-wide env cap should catch this.
    });
    await upsertRepoFocusManifest(env, "JSONbored/repo-a", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory" } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/repo-a", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory" } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/repo-a", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory" } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/repo-a", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", autoCloseExemptLogins: ["farmer99"] } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/repo-a", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory" } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/repo-a", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory" } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2 } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2 } });
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
      // #label-scoping: the cap label/close rides on `close`; the new-account label rides on `review_state_label`.
      autonomy: { close: "auto", review_state_label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", reviewCheckMode: "required", contributorOpenPrCap: 4, accountAgeThresholdDays: 30 } });
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
      autonomy: { close: "auto", review_state_label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", reviewCheckMode: "required", contributorOpenPrCap: 2, accountAgeThresholdDays: 30 } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", reviewCheckMode: "required", contributorOpenPrCap: 4, accountAgeThresholdDays: 30 } });
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
      reviewCheckMode: "required",
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", reviewCheckMode: "required", accountAgeThresholdDays: 30 } });
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
      autonomy: { close: "auto", label: "auto" },
      // accountAgeThresholdDays intentionally omitted — off by default.
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", reviewCheckMode: "required" } });
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
      autonomy: { close: "auto", review_state_label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", reviewCheckMode: "required", accountAgeThresholdDays: 30, newAccountLabel: "custom-new-account-label" } });
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
      // autonomy intentionally omitted — deny-by-default ("observe" for every action class, including "review_state_label").
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", reviewCheckMode: "required", accountAgeThresholdDays: 30 } });
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
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorOpenIssueCap: 4, accountAgeThresholdDays: 30 } });
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
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorOpenIssueCap: 4 } });
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
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorOpenIssueCap: 4, accountAgeThresholdDays: 30 } });
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
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorOpenIssueCap: 4, accountAgeThresholdDays: 30 } });
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
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorOpenIssueCap: 4, accountAgeThresholdDays: 30 } });
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
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { accountAgeThresholdDays: 30, newAccountLabel: "custom-new-account-label" } });
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

  it("account-age throttle (#8687 issue path): falls back to the default 'new-account' label when settings omit newAccountLabel", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", review_state_label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { accountAgeThresholdDays: 30 } });
    // The DB default normally always populates newAccountLabel; strip it at the one settings-resolution seam so
    // the issue-side call site's `?? "new-account"` fallback (previously a bare non-null assertion that would
    // have labeled with `undefined`) is exercised end-to-end, matching the already-correct PR-side twins.
    const original = repositorySettingsModule.resolveRepositorySettings;
    const settingsSpy = vi.spyOn(repositorySettingsModule, "resolveRepositorySettings").mockImplementation(async (e, r) => {
      const resolved = { ...(await original(e, r)) };
      delete resolved.newAccountLabel;
      return resolved;
    });
    const seen = { labels: [] as string[], closed: false };
    vi.stubGlobal("fetch", stubIssueAccountAgeFetch(62, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), seen));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "account-age-issue-default-label-8687",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Newbie's issue", state: "open", user: { login: "newbie" }, labels: [], body: "x" },
      },
    });

    expect(seen.labels).toContain("new-account");
    settingsSpy.mockRestore();
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
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { accountAgeThresholdDays: 30 } });
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
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { accountAgeThresholdDays: 30 } });
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
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { accountAgeThresholdDays: 30 } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2 } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2 } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2 } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2 } });
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
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "advisory", contributorOpenPrCap: 2 } });
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
    // #9499: with no local row there is no createdAt to thread, so the wake goes out WITHOUT the sort hint
    // rather than being skipped -- the same fail-open posture as the bare cooldown key below.
    const woken = fanned.find((job) => job.type === "agent-regate-pr" && job.prNumber === 56) as { prCreatedAt?: string } | undefined;
    expect(woken?.prCreatedAt).toBeUndefined();
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
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorCapLabel: "spam-cap", contributorOpenIssueCap: 2 } }, "repo_file");
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

  it("#9125: contributor open-ISSUE cap survives a rename -- two sibling issues opened under the OLD login still count toward the cap on a 3rd issue opened under the renamed login, via the shared immutable id", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", issues: "write" }, events: ["issues"] },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    // Two sibling issues opened under the OLD login, both carrying the immutable id 555.
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 60, title: "Farmer issue one", state: "open", user: { login: "farmer99", id: 555 }, labels: [], body: "x" });
    await upsertIssueFromGitHub(env, "JSONbored/gittensory", { number: 61, title: "Farmer issue two", state: "open", user: { login: "farmer99", id: 555 }, labels: [], body: "y" });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorCapLabel: "spam-cap", contributorOpenIssueCap: 2 } }, "repo_file");
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

    // The 3rd issue is opened under a NEW login -- same immutable id -- as if the contributor renamed
    // between opening #61 and #62. Before #9125 this cleared the cap (the login-only match saw a stranger).
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "contributor-issue-cap-rename",
      eventName: "issues",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        issue: { number: 62, title: "Farmer's 3rd issue, post-rename", state: "open", user: { login: "farmer99x", id: 555 }, labels: [], body: "x" },
      },
    });

    expect(seen.closed).toBe(true);
    expect(seen.labels).toContain("spam-cap");
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
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorOpenIssueCap: SIBLING_COUNT } }, "repo_file");
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
    });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorOpenIssueCap: 2, autoCloseExemptLogins: ["sentry[bot]"] } }, "repo_file");
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
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorOpenIssueCap: 2 } }, "repo_file");
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
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorOpenIssueCap: 2 } }, "repo_file");
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
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorCapLabel: "spam-cap", contributorOpenIssueCap: 2 } }, "repo_file");
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
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorOpenIssueCap: 2 } }, "repo_file");
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
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/repo-a", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(env, "JSONbored/repo-a", { settings: { contributorOpenIssueCap: 2 } });
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
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorOpenIssueCap: 2 } }, "repo_file");
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
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorOpenIssueCap: 2 } }, "repo_file");
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
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorOpenIssueCap: 2 } }, "repo_file");
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
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: {} });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorOpenIssueCap: 2 } }, "repo_file");
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
    await upsertRepositorySettings(env, { repoFullName: "noslash", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(env, "noslash", { settings: { contributorOpenIssueCap: 2 } });
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
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autonomy: { close: "auto", label: "auto" } });
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { settings: { contributorOpenIssueCap: 2 } }, "repo_file");
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
