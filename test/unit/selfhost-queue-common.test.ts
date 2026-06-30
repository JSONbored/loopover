import { describe, expect, it, vi } from "vitest";
import {
  FOREGROUND_QUEUE_PRIORITY_FLOOR,
  consumingRetryDelayMs,
  githubBackgroundRateLimitDelayMs,
  githubRateLimitRetryDelayMs,
  isGitHubBudgetBackgroundJob,
  isForegroundJobPriority,
  jobCoalesceKey,
  jobPriority,
  nonConsumingRetryDelayMs,
  queueBackgroundConcurrency,
  queueProcessingTimeoutMs,
  queueRecoveryJitterMs,
  queueStartupJitterMinJobs,
  queueStartupJitterMs,
} from "../../src/selfhost/queue-common";
import { RetryableJobError } from "../../src/queue/retryable";
import type { JobMessage } from "../../src/types";

const payload = (value: unknown): string => JSON.stringify(value);

describe("self-host queue common helpers", () => {
  it("classifies job priority by job type and webhook sender", () => {
    expect(jobPriority(payload({ type: "github-webhook" }))).toBe(10);
    expect(jobPriority(payload({ type: "agent-regate-pr" }))).toBe(9);
    expect(jobPriority(payload({ type: "agent-regate-pr", deliveryId: "manual-regate:owner/repo#1:123" }))).toBe(99);
    expect(jobPriority(payload({ type: "recapture-preview" }))).toBe(9);
    expect(jobPriority(payload({ type: "agent-regate-sweep" }))).toBe(8);
    expect(jobPriority(payload({ type: "rag-index-repo" }))).toBe(0);
    expect(jobPriority("{}")).toBe(0);
    expect(jobPriority("not-json")).toBe(0);
  });

  it("keeps foreground review work separate from capped background work", () => {
    expect(FOREGROUND_QUEUE_PRIORITY_FLOOR).toBe(8);
    expect(isForegroundJobPriority(10)).toBe(true);
    expect(isForegroundJobPriority(8)).toBe(true);
    expect(isForegroundJobPriority(7)).toBe(false);
    expect(queueBackgroundConcurrency(4, undefined)).toBe(1);
    expect(queueBackgroundConcurrency(4, "3")).toBe(3);
    expect(queueBackgroundConcurrency(2, "9")).toBe(2);
    expect(queueBackgroundConcurrency(4, "-1")).toBe(1);
    expect(queueBackgroundConcurrency(4, "not-a-number")).toBe(1);
    expect(queueBackgroundConcurrency(4, "0")).toBe(0);
    expect(queueBackgroundConcurrency(Number.NaN, "3")).toBe(0);
    expect(queueBackgroundConcurrency(4, null)).toBe(1);
    expect(queueBackgroundConcurrency(4, "")).toBe(1);
  });

  it("identifies GitHub-budget background jobs without pre-yielding fresh webhooks or manual re-gates", () => {
    expect(isGitHubBudgetBackgroundJob({ type: "github-webhook", deliveryId: "d1", eventName: "pull_request", payload: {} })).toBe(false);
    expect(isGitHubBudgetBackgroundJob({ type: "recapture-preview", deliveryId: "r1", repoFullName: "owner/repo", prNumber: 1, installationId: 2, attempt: 1 })).toBe(false);
    expect(isGitHubBudgetBackgroundJob({ type: "agent-regate-pr" } as unknown as JobMessage)).toBe(false);
    expect(isGitHubBudgetBackgroundJob({ type: "agent-regate-pr", deliveryId: "manual-regate:owner/repo#1:1", repoFullName: "owner/repo", prNumber: 1, installationId: 2 })).toBe(false);
    expect(isGitHubBudgetBackgroundJob({ type: "agent-regate-pr", deliveryId: "sweep:owner/repo#1", repoFullName: "owner/repo", prNumber: 1, installationId: 2 })).toBe(true);
    expect(isGitHubBudgetBackgroundJob({ type: "agent-regate-sweep", requestedBy: "schedule" })).toBe(true);
    expect(isGitHubBudgetBackgroundJob({ type: "backfill-repo-segment", requestedBy: "schedule", repoFullName: "owner/repo", segment: "open_pull_requests" })).toBe(true);
    expect(isGitHubBudgetBackgroundJob({ type: "rag-index-repo", requestedBy: "schedule" })).toBe(true);
    expect(isGitHubBudgetBackgroundJob({ type: "refresh-installation-health", requestedBy: "schedule" })).toBe(false);
  });

  it("computes background admission delays from persisted GitHub REST observations", () => {
    const now = Date.parse("2026-06-24T12:00:00.000Z");
    expect(githubBackgroundRateLimitDelayMs(null, now)).toBeNull();
    expect(githubBackgroundRateLimitDelayMs({ remaining: 500, reset_at: "2026-06-24T12:10:00.000Z" }, now)).toBeNull();
    expect(githubBackgroundRateLimitDelayMs({ remaining: 120, reset_at: "2026-06-24T11:59:00.000Z" }, now)).toBeNull();
    expect(githubBackgroundRateLimitDelayMs({ remaining: null, reset_at: "2026-06-24T12:10:00.000Z" }, now)).toBeNull();
    expect(githubBackgroundRateLimitDelayMs({ remaining: "soon", reset_at: "2026-06-24T12:10:00.000Z" }, now)).toBeNull();
    expect(githubBackgroundRateLimitDelayMs({ remaining: "120", reset_at: "2026-06-24T12:10:00.000Z" }, now)).toBe(615_000);
    expect(githubBackgroundRateLimitDelayMs({ remaining: 120, resetAt: "2026-06-24T12:00:05.000Z" }, now)).toBe(30_000);
    expect(githubBackgroundRateLimitDelayMs({ remaining: 120, reset_at: "2026-06-24T14:00:00.000Z" }, now)).toBe(900_000);
  });

  it("demotes bot-authored issue-comment edit webhooks without demoting human reruns", () => {
    const issueCommentEdit = (sender: { login?: string; type?: string }) =>
      payload({
        type: "github-webhook",
        eventName: "issue_comment",
        payload: { action: "edited", sender },
      });
    expect(
      jobPriority(issueCommentEdit({ login: "gittensory-orb[bot]", type: "Bot" })),
    ).toBe(0);
    expect(
      jobPriority(issueCommentEdit({ login: "codecov[bot]", type: "User" })),
    ).toBe(0);
    expect(
      jobPriority(issueCommentEdit({ login: "jsonbored", type: "User" })),
    ).toBe(10);
    expect(
      jobPriority(
        payload({
          type: "github-webhook",
          eventName: "issue_comment",
          payload: { action: "created", sender: { login: "codecov[bot]" } },
        }),
      ),
    ).toBe(10);
  });

  it("fails closed when a malformed webhook payload reaches priority parsing", () => {
    const raw = payload({ type: "github-webhook" });
    const parse = vi.spyOn(JSON, "parse");
    parse
      .mockImplementationOnce(() => ({ type: "github-webhook" }))
      .mockImplementationOnce(() => {
        throw new Error("malformed webhook payload");
      });

    expect(jobPriority(raw)).toBe(0);
    parse.mockRestore();
  });

  it("fails closed when an agent re-gate priority payload becomes unreadable after type extraction", () => {
    const raw = payload({ type: "agent-regate-pr" });
    const parse = vi.spyOn(JSON, "parse");
    parse
      .mockImplementationOnce(() => ({ type: "agent-regate-pr" }))
      .mockImplementationOnce(() => {
        throw new Error("malformed re-gate payload");
      });

    expect(jobPriority(raw)).toBe(9);
    parse.mockRestore();
  });

  it("coalesces CI-completion webhooks with sorted pull numbers", () => {
    expect(jobCoalesceKey(payload({ type: "agent-regate-pr", repoFullName: "JSONbored/Gittensory", prNumber: 7 }))).toBe("agent-regate-pr:jsonbored/gittensory#7");
    expect(jobCoalesceKey(payload({ type: "agent-regate-pr", repoFullName: "JSONbored/Gittensory" }))).toBeNull();
    expect(jobCoalesceKey(payload({ type: "agent-regate-sweep", requestedBy: "schedule" }))).toBe("agent-regate-sweep:all");
    expect(jobCoalesceKey(payload({ type: "agent-regate-sweep", repoFullName: "JSONbored/Gittensory" }))).toBe("agent-regate-sweep:jsonbored/gittensory");
    expect(jobCoalesceKey(payload({ type: "recapture-preview", repoFullName: "JSONbored/Gittensory", prNumber: 7, attempt: 2 }))).toBe("recapture-preview:jsonbored/gittensory#7:2");
    expect(jobCoalesceKey(payload({ type: "recapture-preview", repoFullName: "JSONbored/Gittensory", prNumber: 7 }))).toBeNull();
    expect(
      jobCoalesceKey(
        payload({
          type: "github-webhook",
          eventName: "check_suite",
          payload: {
            action: "completed",
            repository: { full_name: "JSONbored/Gittensory" },
            check_suite: {
              head_sha: "abc1234",
              pull_requests: [{ number: 12 }, { number: 3 }, { number: 7 }],
            },
          },
        }),
      ),
    ).toBe("github-webhook:ci-completed:jsonbored/gittensory@abc1234#3,7,12");
    expect(
      jobCoalesceKey(
        payload({
          type: "github-webhook",
          eventName: "check_run",
          payload: {
            action: "completed",
            repository: { full_name: "JSONbored/Gittensory" },
            check_run: {
              check_suite: { head_sha: "DEF5678" },
              pull_requests: [],
            },
          },
        }),
      ),
    ).toBe("github-webhook:ci-completed:jsonbored/gittensory@def5678");
    expect(
      jobCoalesceKey(
        payload({
          type: "github-webhook",
          eventName: "check_run",
          payload: {
            action: "completed",
            repository: { full_name: "JSONbored/Gittensory" },
            check_run: {
              head_sha: "C0FFEE1",
            },
          },
        }),
      ),
    ).toBe("github-webhook:ci-completed:jsonbored/gittensory@c0ffee1");
    expect(
      jobCoalesceKey(
        payload({
          type: "github-webhook",
          eventName: "check_suite",
          payload: {
            action: "completed",
            repository: { full_name: "JSONbored/Gittensory" },
            check_suite: { pull_requests: [{ number: 7 }] },
          },
        }),
      ),
    ).toBeNull();
    expect(
      jobCoalesceKey(
        payload({
          type: "github-webhook",
          eventName: "pull_request",
          payload: {
            action: "synchronize",
            repository: { full_name: "JSONbored/Gittensory" },
            number: 99,
            pull_request: {},
          },
        }),
      ),
    ).toBe("github-webhook:pr-refresh:jsonbored/gittensory#99");
    expect(
      jobCoalesceKey(
        payload({
          type: "github-webhook",
          eventName: "pull_request",
          payload: {
            action: "opened",
            repository: { full_name: "JSONbored/Gittensory" },
            pull_request: { number: 100, head: { sha: "BEEF123" } },
          },
        }),
      ),
    ).toBe("github-webhook:pr-refresh:jsonbored/gittensory#100@beef123");
    expect(
      jobCoalesceKey(
        payload({
          type: "github-webhook",
          eventName: "pull_request",
          payload: {
            action: "opened",
            repository: { full_name: "JSONbored/Gittensory" },
            pull_request: { head: { sha: "BEEF123" } },
          },
        }),
      ),
    ).toBeNull();
  });

  it("coalesces recurring maintenance jobs while preserving their semantic scope", () => {
    expect(
      jobCoalesceKey(
        payload({ type: "backfill-registered-repos", requestedBy: "schedule" }),
      ),
    ).toBe("backfill-registered-repos:all:default:0");
    expect(
      jobCoalesceKey(
        payload({
          type: "backfill-registered-repos",
          requestedBy: "api",
          repoFullName: "JSONbored/Gittensory",
          mode: "resume",
          force: true,
        }),
      ),
    ).toBe("backfill-registered-repos:jsonbored/gittensory:resume:1");
    expect(
      jobCoalesceKey(
        payload({
          type: "backfill-repo-segment",
          requestedBy: "schedule",
          repoFullName: "JSONbored/Gittensory",
          segment: "labels",
          mode: "resume",
          force: true,
          cursor: "  page-2  ",
        }),
      ),
    ).toBe("backfill-repo-segment:jsonbored/gittensory:labels:resume:1:page-2");
    expect(
      jobCoalesceKey(
        payload({
          type: "refresh-contributor-activity",
          requestedBy: "schedule",
          login: "OktoFeesh1",
          repoFullName: "JSONbored/Gittensory",
        }),
      ),
    ).toBe("refresh-contributor-activity:oktofeesh1:jsonbored/gittensory");
    expect(
      jobCoalesceKey(
        payload({
          type: "rollup-product-usage",
          requestedBy: "schedule",
          day: "2026-06-30",
          days: 7,
        }),
      ),
    ).toBe("rollup-product-usage:2026-06-30:7");
    expect(
      jobCoalesceKey(
        payload({
          type: "generate-weekly-value-report",
          requestedBy: "schedule",
          variant: "public",
          days: 31,
        }),
      ),
    ).toBe("generate-weekly-value-report:public:31");
    expect(
      jobCoalesceKey(
        payload({
          type: "rag-index-repo",
          requestedBy: "webhook",
          repoFullName: "JSONbored/Gittensory",
          paths: ["README.md", "src/a.ts", "README.md"],
        }),
      ),
    ).toBe('rag-index-repo:jsonbored/gittensory:["README.md","src/a.ts"]');
    expect(
      jobCoalesceKey(
        payload({
          type: "rag-index-repo",
          requestedBy: "webhook",
          repoFullName: "JSONbored/Gittensory",
          paths: ["a,b", "c"],
        }),
      ),
    ).toBe('rag-index-repo:jsonbored/gittensory:["a,b","c"]');
    expect(
      jobCoalesceKey(
        payload({
          type: "rag-index-repo",
          requestedBy: "schedule",
          repoFullName: "JSONbored/Gittensory",
          paths: ["a", "b,c"],
        }),
      ),
    ).toBe('rag-index-repo:jsonbored/gittensory:["a","b,c"]');
    expect(jobCoalesceKey(payload({ type: "prune-retention", requestedBy: "schedule", dryRun: true }))).toBe(
      "prune-retention:1",
    );
    expect(jobCoalesceKey(payload({ type: "ops-alerts", requestedBy: "schedule" }))).toBe(
      "ops-alerts",
    );
  });

  it("returns no coalesce key for malformed payloads", () => {
    expect(jobCoalesceKey("not-json")).toBeNull();
  });

  it("extracts retry delays from GitHub rate-limit errors", () => {
    expect(githubRateLimitRetryDelayMs(null)).toBeNull();
    expect(githubRateLimitRetryDelayMs({ status: 403, message: "Forbidden" })).toBeNull();

    expect(
      githubRateLimitRetryDelayMs({
        status: 403,
        message: "secondary rate limit",
      }),
    ).toBe(300_000);
    expect(
      githubRateLimitRetryDelayMs({
        status: 429,
        response: { headers: new Headers({ "retry-after": "2" }) },
      }),
    ).toBe(2_000);
    expect(
      githubRateLimitRetryDelayMs(
        {
          status: 403,
          response: {
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1003",
            },
          },
        },
        1_000_000,
      ),
    ).toBe(8_000);
    expect(
      githubRateLimitRetryDelayMs(
        {
          status: 403,
          response: {
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "990",
            },
          },
        },
        1_000_000,
      ),
    ).toBe(300_000);
    expect(
      githubRateLimitRetryDelayMs({
        status: 429,
        response: { headers: new Headers() },
        message: "rate limit",
      }),
    ).toBe(300_000);
    expect(
      githubRateLimitRetryDelayMs({
        status: 429,
        response: { headers: new Headers({ "retry-after": "soon" }) },
        message: "secondary rate limit",
      }),
    ).toBe(300_000);
    expect(
      githubRateLimitRetryDelayMs(
        new Error("openai api rate limit exceeded"),
      ),
    ).toBeNull();
  });

  it("keeps only GitHub rate limits on the non-consuming retry path", () => {
    expect(nonConsumingRetryDelayMs(new Error("boom"))).toBeNull();
    expect(
      nonConsumingRetryDelayMs({
        status: 429,
        response: { headers: new Headers({ "retry-after": "2" }) },
      }),
    ).toBe(2_000);
    expect(
      nonConsumingRetryDelayMs(
        new RetryableJobError("AI review pending", {
          retryAfterMs: 1234,
          retryKind: "ai_review_public_summary_missing",
        }),
      ),
    ).toBeNull();
    expect(nonConsumingRetryDelayMs(new Error("openai rate limit"))).toBeNull();
  });

  it("uses RetryableJobError delays on the bounded consuming retry path", () => {
    expect(consumingRetryDelayMs(new Error("boom"), 77)).toBe(77);
    expect(
      consumingRetryDelayMs(
        new RetryableJobError("AI review pending", {
          retryAfterMs: 1234,
          retryKind: "ai_review_public_summary_missing",
        }),
        77,
      ),
    ).toBe(1234);
    expect(
      consumingRetryDelayMs(
        new RetryableJobError("AI review pending", {
          retryAfterMs: Number.NaN,
          retryKind: "ai_review_public_summary_missing",
        }),
        77,
      ),
    ).toBe(300_000);
    expect(
      consumingRetryDelayMs(
        new RetryableJobError("AI review pending", {
          retryKind: "ai_review_public_summary_missing",
        }),
        77,
      ),
    ).toBe(300_000);
  });

  it("parses queue timing env values with defensive fallbacks", () => {
    const oldStartup = process.env.QUEUE_STARTUP_JITTER_MS;
    const oldRecovery = process.env.QUEUE_RECOVERY_JITTER_MS;
    const oldTimeout = process.env.QUEUE_PROCESSING_TIMEOUT_MS;
    try {
      process.env.QUEUE_STARTUP_JITTER_MS = "42";
      process.env.QUEUE_RECOVERY_JITTER_MS = "25.9";
      process.env.QUEUE_PROCESSING_TIMEOUT_MS = "not-a-number";

      expect(queueStartupJitterMs()).toBe(42);
      expect(queueRecoveryJitterMs()).toBe(25);
      expect(queueProcessingTimeoutMs()).toBe(30 * 60_000);

      process.env.QUEUE_STARTUP_JITTER_MS = "-1";
      expect(queueStartupJitterMs()).toBe(3 * 60_000);
    } finally {
      if (oldStartup === undefined) delete process.env.QUEUE_STARTUP_JITTER_MS;
      else process.env.QUEUE_STARTUP_JITTER_MS = oldStartup;
      if (oldRecovery === undefined) delete process.env.QUEUE_RECOVERY_JITTER_MS;
      else process.env.QUEUE_RECOVERY_JITTER_MS = oldRecovery;
      if (oldTimeout === undefined) delete process.env.QUEUE_PROCESSING_TIMEOUT_MS;
      else process.env.QUEUE_PROCESSING_TIMEOUT_MS = oldTimeout;
    }
  });

  it("bounds startup jitter min-jobs config to a non-negative finite integer", () => {
    const old = process.env.QUEUE_STARTUP_JITTER_MIN_JOBS;
    try {
      process.env.QUEUE_STARTUP_JITTER_MIN_JOBS = "2.9";
      expect(queueStartupJitterMinJobs()).toBe(2);
      process.env.QUEUE_STARTUP_JITTER_MIN_JOBS = "-1";
      expect(queueStartupJitterMinJobs()).toBe(8);
      process.env.QUEUE_STARTUP_JITTER_MIN_JOBS = "not-a-number";
      expect(queueStartupJitterMinJobs()).toBe(8);
    } finally {
      if (old === undefined) delete process.env.QUEUE_STARTUP_JITTER_MIN_JOBS;
      else process.env.QUEUE_STARTUP_JITTER_MIN_JOBS = old;
    }
  });
});
