import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FOREGROUND_QUEUE_PRIORITY_FLOOR,
  buildSelfHostQueueSnapshot,
  consumingRetryDelayMs,
  deterministicJitterMs,
  githubRateLimitAdmissionDelayMs,
  githubRateLimitAdmissionKeyScope,
  githubRateLimitAdmissionKeyForJob,
  githubRateLimitMetricContext,
  githubRateLimitMetricLabels,
  githubBackgroundRateLimitDelayMs,
  githubRateLimitRetryDelayMs,
  githubWebhookRateLimitDelayMs,
  isGitHubBudgetBackgroundJob,
  isForegroundJobPriority,
  jobCoalesceAbsorbedByKey,
  jobCoalesceKey,
  jobCoalesceSupersededKeyPrefix,
  jobPriority,
  matchesGitHubRateLimitAdmissionTarget,
  nonConsumingRetryDelayMs,
  queueBackgroundConcurrency,
  queueProcessingTimeoutMs,
  queueRecoveryJitterMs,
  queueSnapshotBacklog,
  queueSnapshotFromBinding,
  queueStartupJitterMinJobs,
  queueStartupJitterMs,
  scheduledEnqueueDelaySeconds,
  scheduledEnqueueJitterMs,
} from "../../src/selfhost/queue-common";
import { clearGitHubResponseCacheForTest, githubRateLimitAdmissionKeyForInstallation, githubRateLimitAdmissionKeyForPublicToken, timeoutFetch } from "../../src/github/client";
import { RetryableJobError } from "../../src/queue/retryable";
import type { JobMessage } from "../../src/types";

const payload = (value: unknown): string => JSON.stringify(value);

afterEach(() => {
  clearGitHubResponseCacheForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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

  it("builds queue snapshots by job type/status and only marks due pending jobs", () => {
    const now = 1_000;
    const snapshot = buildSelfHostQueueSnapshot(
      [
        { payload: payload({ type: "agent-regate-pr" }), status: "pending", run_after: 999 },
        { payload: payload({ type: "agent-regate-pr" }), status: "pending", run_after: "1001" },
        { payload: payload({ type: "agent-regate-pr" }), status: "processing", run_after: 1 },
        { payload: payload({ type: "github-webhook" }), status: "processing", run_after: 1 },
        { payload: "not-json", status: "dead", run_after: 1 },
        { payload: payload({ type: "ignored" }), status: "done", run_after: 1 },
        { payload: null, status: "pending", runAfter: "not-a-number" },
      ],
      now,
    );

    expect(snapshot.totals).toEqual({ pending: 3, processing: 2, dead: 1, due: 2 });
    expect(snapshot.byType).toEqual([
      { type: "agent-regate-pr", status: "pending", count: 2, due: 1 },
      { type: "agent-regate-pr", status: "processing", count: 1, due: 0 },
      { type: "github-webhook", status: "processing", count: 1, due: 0 },
      { type: "unknown", status: "dead", count: 1, due: 0 },
      { type: "unknown", status: "pending", count: 1, due: 1 },
    ]);
    expect(queueSnapshotBacklog(snapshot, ["agent-regate-pr"])).toBe(3);
    expect(queueSnapshotBacklog(snapshot, ["agent-regate-pr"], ["processing"])).toBe(1);
    expect(queueSnapshotBacklog(snapshot, ["agent-regate-pr"], ["dead"])).toBe(0);
    expect(queueSnapshotBacklog(null, ["agent-regate-pr"])).toBe(0);
  });

  it("reads queue snapshots only from self-host bindings that expose introspection", async () => {
    const snapshot = buildSelfHostQueueSnapshot([
      { payload: payload({ type: "agent-regate-sweep" }), status: "pending", run_after: 0 },
    ]);
    const binding = {
      async send() {},
      async sendBatch() {},
      snapshot: () => snapshot,
    } as unknown as Queue;

    await expect(queueSnapshotFromBinding(binding)).resolves.toBe(snapshot);
    await expect(queueSnapshotFromBinding({ async send() {}, async sendBatch() {} } as unknown as Queue)).resolves.toBeNull();
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

  it("normalizes GitHub rate-limit metric labels without leaking raw admission keys", () => {
    const webhookJob = {
      type: "github-webhook",
      deliveryId: "d1",
      eventName: "pull_request",
      payload: {},
    } as JobMessage;

    expect(githubRateLimitAdmissionKeyScope("installation:123")).toBe("installation");
    expect(githubRateLimitAdmissionKeyScope(githubRateLimitAdmissionKeyForPublicToken())).toBe("public");
    expect(githubRateLimitAdmissionKeyScope("global:shared")).toBe("global");
    expect(githubRateLimitAdmissionKeyScope(null)).toBe("unknown");
    expect(githubRateLimitAdmissionKeyScope("pat:shared")).toBe("other");
    expect(githubRateLimitMetricLabels(webhookJob, {
      kind: "webhook",
      admissionKey: "installation:123",
    })).toEqual({
      job_type: "github-webhook",
      key_scope: "installation",
      kind: "webhook",
    });
    expect(githubRateLimitMetricLabels({ type: "rag-index-repo", requestedBy: "schedule" } as JobMessage, null)).toEqual({
      job_type: "rag-index-repo",
      key_scope: "unknown",
      kind: "unknown",
    });
    expect(githubRateLimitMetricContext(webhookJob, {
      kind: "webhook",
      admissionKey: "installation:456",
    })).toEqual({
      labels: {
        job_type: "github-webhook",
        key_scope: "installation",
        kind: "webhook",
      },
      spanAttributes: {
        "github.rate_limit.kind": "webhook",
        "github.rate_limit.key_scope": "installation",
      },
      logFields: {
        jobType: "github-webhook",
        key_scope: "installation",
        kind: "webhook",
      },
    });
  });

  it("derives admission keys from both installation-backed jobs and webhook payloads", () => {
    expect(githubRateLimitAdmissionKeyForJob({ type: "agent-regate-pr", deliveryId: "sweep:owner/repo#1", repoFullName: "owner/repo", prNumber: 1, installationId: 123 })).toBe("installation:123");
    expect(githubRateLimitAdmissionKeyForJob({ type: "github-webhook", deliveryId: "d1", eventName: "pull_request", payload: { installation: { id: 456 } } })).toBe("installation:456");
    expect(githubRateLimitAdmissionKeyForJob({ type: "github-webhook", deliveryId: "d2", eventName: "pull_request", payload: {} })).toBeNull();
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

  it("computes webhook admission delays only when the shared REST bucket is exhausted", () => {
    const now = Date.parse("2026-06-24T12:00:00.000Z");
    expect(githubWebhookRateLimitDelayMs(null, now)).toBeNull();
    expect(githubWebhookRateLimitDelayMs({ remaining: 76, reset_at: "2026-06-24T12:10:00.000Z" }, now)).toBeNull();
    expect(githubWebhookRateLimitDelayMs({ remaining: 75, reset_at: "2026-06-24T12:10:00.000Z" }, now)).toBe(615_000);
    expect(githubWebhookRateLimitDelayMs({ remaining: "50", reset_at: "2026-06-24T12:10:00.000Z" }, now)).toBe(615_000);
    expect(githubWebhookRateLimitDelayMs({ remaining: 50, resetAt: "2026-06-24T12:00:05.000Z" }, now)).toBe(30_000);
    expect(githubWebhookRateLimitDelayMs({ remaining: 50, reset_at: "2026-06-24T11:59:00.000Z" }, now)).toBeNull();
  });

  it("computes admission delays from the newest unkeyed persisted candidate", () => {
    const now = Date.parse("2026-06-24T12:00:00.000Z");
    expect(
      githubRateLimitAdmissionDelayMs(
        "webhook",
        null,
        [
          { remaining: 4000, reset_at: "2026-06-24T12:20:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" },
          { remaining: 0, reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T11:59:00.000Z" },
        ],
        now,
      ),
    ).toBeNull();
    expect(
      githubRateLimitAdmissionDelayMs(
        "webhook",
        null,
        [
          { remaining: 0, reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T11:59:00.000Z" },
          { remaining: 75, reset_at: "2026-06-24T12:15:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" },
        ],
        now,
      ),
    ).toBe(900_000);
    expect(githubRateLimitAdmissionDelayMs("background", null, [], now)).toBeNull();
  });

  it("uses the newest comparable exact or legacy admission observation", () => {
    const now = Date.parse("2026-06-24T12:00:00.000Z");
    const key = githubRateLimitAdmissionKeyForInstallation(123);
    const unrelatedKey = githubRateLimitAdmissionKeyForInstallation(456);
    expect(
      githubRateLimitAdmissionDelayMs(
        "webhook",
        key,
        [
          { admission_key: null, remaining: 0, reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T11:59:00.000Z" },
          { admission_key: key, remaining: 4000, reset_at: "2026-06-24T12:20:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" },
        ],
        now,
      ),
    ).toBeNull();
    // A newer unkeyed/legacy fallback must NOT suppress a healthy exact installation observation, even
    // though it is the most recently observed row -- the fallback is very likely an unrelated bucket
    // (a public token, another consumer, or a pre-migration write), and recency alone is not evidence
    // that THIS installation's own budget is exhausted (the incident this regression guards against).
    expect(
      githubRateLimitAdmissionDelayMs(
        "webhook",
        key,
        [
          { admissionKey: key, remaining: 4000, reset_at: "2026-06-24T12:20:00.000Z", observed_at: "2026-06-24T11:59:00.000Z" },
          { admission_key: null, remaining: 0, reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" },
        ],
        now,
      ),
    ).toBeNull();
    // A newer unkeyed/legacy fallback must not CLEAR a genuine exact exhaustion either -- it is the
    // same untrustworthy, unrelated-bucket signal as the suppression case above, just pointing the
    // other way. The exact reading's own reset_at already bounds how long this can block admission.
    expect(
      githubRateLimitAdmissionDelayMs(
        "webhook",
        key,
        [
          { admission_key: key, remaining: 0, reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T11:59:00.000Z" },
          { admission_key: null, remaining: 4000, reset_at: "2026-06-24T12:20:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" },
        ],
        now,
      ),
    ).toBe(615_000);
    expect(
      githubRateLimitAdmissionDelayMs(
        "webhook",
        key,
        [
          { admission_key: key, remaining: 4000, reset_at: "2026-06-24T12:20:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" },
          { admission_key: null, remaining: 0, reset_at: "2026-06-24T12:10:00.000Z" },
        ],
        now,
      ),
    ).toBeNull();
    expect(
      githubRateLimitAdmissionDelayMs(
        "webhook",
        key,
        [
          { admission_key: unrelatedKey, remaining: 0, reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" },
        ],
        now,
      ),
    ).toBeNull();
    expect(
      githubRateLimitAdmissionDelayMs(
        "webhook",
        null,
        [
          { remaining: 4000, reset_at: "2026-06-24T12:20:00.000Z" },
          { remaining: 0, reset_at: "2026-06-24T12:10:00.000Z" },
        ],
        now,
      ),
    ).toBe(615_000);
    expect(
      githubRateLimitAdmissionDelayMs(
        "webhook",
        null,
        [
          { remaining: 4000, reset_at: "2026-06-24T12:20:00.000Z" },
          { remaining: 0, reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" },
        ],
        now,
      ),
    ).toBe(615_000);
  });

  describe("fallback vs exact admission precedence (self-host webhook backlog regression)", () => {
    const now = Date.parse("2026-06-24T12:00:00.000Z");
    const key = githubRateLimitAdmissionKeyForInstallation(123);

    it("REGRESSION: a healthy, newer-enough exact installation observation is never suppressed by a newer unkeyed exhausted fallback", () => {
      expect(
        githubRateLimitAdmissionDelayMs(
          "webhook",
          key,
          [
            { admission_key: key, remaining: 4000, reset_at: "2026-06-24T12:20:00.000Z", observed_at: "2026-06-24T11:59:30.000Z" },
            { admission_key: null, remaining: 0, reset_at: "2026-06-24T12:01:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" },
          ],
          now,
        ),
      ).toBeNull();
    });

    it("REGRESSION: no exact installation observation + an exhausted unkeyed fallback still defers webhook admission", () => {
      expect(
        githubRateLimitAdmissionDelayMs(
          "webhook",
          key,
          [{ admission_key: null, remaining: 0, reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" }],
          now,
        ),
      ).toBe(615_000);
    });

    it("REGRESSION: an exhausted exact installation observation alone still defers webhook admission", () => {
      expect(
        githubRateLimitAdmissionDelayMs(
          "webhook",
          key,
          [{ admission_key: key, remaining: 0, reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" }],
          now,
        ),
      ).toBe(615_000);
    });

    it("INVARIANT: a newer unkeyed fallback cannot CLEAR a genuine exact exhaustion either -- an untrusted bucket is untrusted in both directions", () => {
      // A null/unkeyed fallback is not proven to report on the SAME budget as this admission key, so
      // it must not move admission in EITHER direction once an exact observation exists: it can't
      // suppress a healthy exact reading (the original bug), and it equally can't manufacture an early
      // "recovery" for a genuinely exhausted one. The exact reading's own reset_at already bounds the
      // wait.
      expect(
        githubRateLimitAdmissionDelayMs(
          "webhook",
          key,
          [
            { admission_key: key, remaining: 0, reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T11:59:00.000Z" },
            { admission_key: null, remaining: 4000, reset_at: "2026-06-24T12:20:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" },
          ],
          now,
        ),
      ).toBe(615_000);
    });

    it("background admission observes the same precedence: a newer exhausted fallback cannot suppress a healthy exact background observation", () => {
      expect(
        githubRateLimitAdmissionDelayMs(
          "background",
          key,
          [
            { admission_key: key, remaining: 4000, reset_at: "2026-06-24T12:20:00.000Z", observed_at: "2026-06-24T11:59:30.000Z" },
            { admission_key: null, remaining: 0, reset_at: "2026-06-24T12:01:00.000Z", observed_at: "2026-06-24T12:00:00.000Z" },
          ],
          now,
        ),
      ).toBeNull();
    });
  });

  describe("matchesGitHubRateLimitAdmissionTarget", () => {
    const installationKey = githubRateLimitAdmissionKeyForInstallation(123);
    const otherInstallationKey = githubRateLimitAdmissionKeyForInstallation(456);

    it("returns false for a candidate that is not GitHub-budget work at all", () => {
      expect(matchesGitHubRateLimitAdmissionTarget(null, { kind: "webhook", admissionKey: installationKey })).toBe(false);
    });

    it("matches a candidate sharing the same admission key as a keyed blocked target", () => {
      expect(
        matchesGitHubRateLimitAdmissionTarget(
          { kind: "webhook", admissionKey: installationKey },
          { kind: "webhook", admissionKey: installationKey },
        ),
      ).toBe(true);
    });

    it("still conservatively matches a null-keyed (legacy/unknown) candidate against a keyed blocked target", () => {
      expect(
        matchesGitHubRateLimitAdmissionTarget(
          { kind: "webhook", admissionKey: null },
          { kind: "webhook", admissionKey: installationKey },
        ),
      ).toBe(true);
    });

    it("does not match a DIFFERENT concretely-keyed candidate against a keyed blocked target", () => {
      expect(
        matchesGitHubRateLimitAdmissionTarget(
          { kind: "webhook", admissionKey: otherInstallationKey },
          { kind: "webhook", admissionKey: installationKey },
        ),
      ).toBe(false);
    });

    it("REGRESSION: a null-keyed blocked target no longer parks EVERY concretely-keyed candidate (only null-keyed ones)", () => {
      // Before the fix, a confirmed rate-limit failure on a job with NO admission key (legacy/unknown
      // actor work) would defer every OTHER pending job regardless of its own key -- the same false
      // positive class as a stale unkeyed observation pinning a healthy installation's webhooks.
      expect(
        matchesGitHubRateLimitAdmissionTarget(
          { kind: "webhook", admissionKey: installationKey },
          { kind: "webhook", admissionKey: null },
        ),
      ).toBe(false);
      expect(
        matchesGitHubRateLimitAdmissionTarget(
          { kind: "webhook", admissionKey: null },
          { kind: "webhook", admissionKey: null },
        ),
      ).toBe(true);
    });
  });

  it("uses the newest local REST rate-limit observation for admission control", async () => {
    const now = Date.parse("2026-06-24T12:00:00.000Z");
    const key = githubRateLimitAdmissionKeyForInstallation(123);
    const unrelatedKey = githubRateLimitAdmissionKeyForInstallation(456);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "50",
            "x-ratelimit-reset": String(Math.floor(Date.parse("2026-06-24T12:10:00.000Z") / 1000)),
          },
        }),
    );

    await timeoutFetch("https://api.github.com/repos/owner/repo/issues", { githubRateLimitAdmission: true, githubRateLimitAdmissionKey: key });

    expect(githubRateLimitAdmissionDelayMs("webhook", key, null, now)).toBe(615_000);
    expect(githubRateLimitAdmissionDelayMs("webhook", unrelatedKey, null, now)).toBeNull();
    expect(
      githubRateLimitAdmissionDelayMs(
        "webhook",
        key,
        { remaining: 500, reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T11:59:00.000Z" },
        now,
      ),
    ).toBe(615_000);
    expect(
      githubRateLimitAdmissionDelayMs(
        "webhook",
        key,
        { admission_key: key, remaining: 500, reset_at: "2026-06-24T12:10:00.000Z", observed_at: "2026-06-24T12:01:00.000Z" },
        now,
      ),
    ).toBeNull();
    expect(
      githubRateLimitAdmissionDelayMs(
        "webhook",
        key,
        { remaining: 500, reset_at: "2026-06-24T12:10:00.000Z", observedAtMs: now + 60_000 } as unknown as { remaining: number; reset_at: string },
        now,
      ),
    ).toBeNull();
    expect(
      githubRateLimitAdmissionDelayMs(
        "webhook",
        key,
        { remaining: 500, reset_at: "2026-06-24T12:10:00.000Z", observedAt: "2026-06-24T12:01:00.000Z" },
        now,
      ),
    ).toBeNull();
    expect(
      githubRateLimitAdmissionDelayMs(
        "webhook",
        key,
        { remaining: 500, reset_at: "2026-06-24T12:10:00.000Z", observed_at: "not-a-date" },
        now,
      ),
    ).toBe(615_000);
    expect(
      githubRateLimitAdmissionDelayMs(
        "webhook",
        key,
        { remaining: 500, reset_at: "2026-06-24T12:10:00.000Z" },
        now,
      ),
    ).toBe(615_000);
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

  it("coalesces the event-driven jobs by their stable per-invocation id — and only true duplicates (#1942)", () => {
    // A DUPLICATE re-enqueue of the SAME job (same id — e.g. a webhook redelivery) coalesces.
    expect(jobCoalesceKey(payload({ type: "run-agent", requestedBy: "github_comment", runId: "run-abc123" }))).toBe("run-agent:run-abc123");
    expect(jobCoalesceKey(payload({ type: "notify-deliver", requestedBy: "notify-evaluate", deliveryId: "del-77" }))).toBe("notify-deliver:del-77");
    expect(jobCoalesceKey(payload({ type: "submit-draft", requestedBy: "api", draftId: "draft-9" }))).toBe("submit-draft:draft-9");
    expect(jobCoalesceKey(payload({ type: "notify-evaluate", requestedBy: "webhook", event: { dedupKey: "review_requested:o/r#3:bob" } }))).toBe("notify-evaluate:review_requested:o/r#3:bob");
    // Two DISTINCT invocations have distinct ids → distinct keys, so they never merge.
    expect(jobCoalesceKey(payload({ type: "run-agent", requestedBy: "github_comment", runId: "run-xyz789" }))).toBe("run-agent:run-xyz789");
    // A payload missing its id → null (uncoalesced), never a shared key that could drop a distinct job.
    expect(jobCoalesceKey(payload({ type: "run-agent", requestedBy: "test" }))).toBeNull();
    expect(jobCoalesceKey(payload({ type: "notify-deliver", requestedBy: "test" }))).toBeNull();
    expect(jobCoalesceKey(payload({ type: "submit-draft", requestedBy: "test" }))).toBeNull();
    expect(jobCoalesceKey(payload({ type: "notify-evaluate", requestedBy: "test" }))).toBeNull();
    expect(jobCoalesceKey(payload({ type: "notify-evaluate", requestedBy: "test", event: {} }))).toBeNull();
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
    const incrementalRagJob = payload({
      type: "rag-index-repo",
      requestedBy: "webhook",
      repoFullName: "JSONbored/Gittensory",
      paths: ["README.md", "src/a.ts", "README.md"],
    });
    expect(jobCoalesceKey(incrementalRagJob)).toBe(
      "rag-index-repo:jsonbored/gittensory:sha256:8812e979fc698c98d98665ad4ccd8630e396dabdce08ebf87b41600c94bb1df5",
    );
    expect(jobCoalesceAbsorbedByKey(incrementalRagJob)).toBe("rag-index-repo:jsonbored/gittensory:full");
    expect(jobCoalesceSupersededKeyPrefix(incrementalRagJob)).toBeNull();
    expect(
      jobCoalesceKey(
        payload({
          type: "rag-index-repo",
          requestedBy: "webhook",
          repoFullName: "JSONbored/Gittensory",
          paths: ["a,b", "c"],
        }),
      ),
    ).toBe("rag-index-repo:jsonbored/gittensory:sha256:569c363fb7e855f85eeae4e4dc032d1f8d262191b68ade7297566486982b5183");
    expect(
      jobCoalesceKey(
        payload({
          type: "rag-index-repo",
          requestedBy: "schedule",
          repoFullName: "JSONbored/Gittensory",
          paths: ["a", "b,c"],
        }),
      ),
    ).toBe("rag-index-repo:jsonbored/gittensory:sha256:472ecd0a16762a33c3090345032fcadcfe6b34ee43a5cce5385fef8e72169c92");
    const longPathKey = jobCoalesceKey(
      payload({
        type: "rag-index-repo",
        requestedBy: "webhook",
        repoFullName: "JSONbored/Gittensory",
        paths: Array.from({ length: 100 }, (_, index) => `src/${index}-${"a".repeat(220)}.ts`),
      }),
    );
    expect(longPathKey).toMatch(/^rag-index-repo:jsonbored\/gittensory:sha256:[a-f0-9]{64}$/);
    expect(longPathKey?.length).toBe("rag-index-repo:jsonbored/gittensory:sha256:".length + 64);
    expect(
      jobCoalesceKey(
        payload({
          type: "rag-index-repo",
          requestedBy: "webhook",
          repoFullName: "JSONbored/Gittensory",
          paths: [" ", null],
        }),
      ),
    ).toBe("rag-index-repo:jsonbored/gittensory:full");
    const fullRagJob = payload({
      type: "rag-index-repo",
      requestedBy: "schedule",
      repoFullName: "JSONbored/Gittensory",
    });
    expect(jobCoalesceKey(fullRagJob)).toBe("rag-index-repo:jsonbored/gittensory:full");
    expect(jobCoalesceSupersededKeyPrefix(fullRagJob)).toBe("rag-index-repo:jsonbored/gittensory:");
    expect(jobCoalesceAbsorbedByKey(fullRagJob)).toBeNull();
    expect(jobCoalesceKey(payload({ type: "prune-retention", requestedBy: "schedule", dryRun: true }))).toBe(
      "prune-retention:1",
    );
    expect(jobCoalesceKey(payload({ type: "ops-alerts", requestedBy: "schedule" }))).toBe(
      "ops-alerts",
    );
  });

  it("keys build-contributor-evidence by login/all, and fanned-out batches by their FIRST login (never one shared key) (#1941)", () => {
    // A single-login (re-index) job coalesces by login; the scheduled trigger (no login/logins) → the "all" slot.
    expect(jobCoalesceKey(payload({ type: "build-contributor-evidence", requestedBy: "schedule", login: "Alice" }))).toBe("build-contributor-evidence:alice");
    expect(jobCoalesceKey(payload({ type: "build-contributor-evidence", requestedBy: "schedule" }))).toBe("build-contributor-evidence:all");
    // Fanned-out batches key by their FIRST login → DISTINCT batches get DISTINCT keys (none is dropped by coalescing).
    const batchA = jobCoalesceKey(payload({ type: "build-contributor-evidence", requestedBy: "schedule", logins: ["Bob", "Carol"] }));
    const batchB = jobCoalesceKey(payload({ type: "build-contributor-evidence", requestedBy: "schedule", logins: ["Dave", "Erin"] }));
    expect(batchA).toBe("build-contributor-evidence:batch:bob");
    expect(batchB).toBe("build-contributor-evidence:batch:dave");
    expect(batchA).not.toBe(batchB);
    expect(batchA).not.toBe("build-contributor-evidence:all"); // the footgun: a batch must never collapse into "all"
    // An EMPTY batch (no logins) is the scheduled-trigger shape → the "all" slot.
    expect(jobCoalesceKey(payload({ type: "build-contributor-evidence", requestedBy: "schedule", logins: [] }))).toBe("build-contributor-evidence:all");
    // A non-empty batch whose first login is unusable is left UNCOALESCED (null) — never collapsed into "all".
    expect(jobCoalesceKey(payload({ type: "build-contributor-evidence", requestedBy: "schedule", logins: [""] }))).toBeNull();
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

  it("parses the scheduled-enqueue jitter window with defensive fallbacks", () => {
    const old = process.env.SCHEDULED_ENQUEUE_JITTER_MS;
    try {
      delete process.env.SCHEDULED_ENQUEUE_JITTER_MS;
      expect(scheduledEnqueueJitterMs()).toBe(5 * 60_000); // default
      process.env.SCHEDULED_ENQUEUE_JITTER_MS = "42000";
      expect(scheduledEnqueueJitterMs()).toBe(42000);
      process.env.SCHEDULED_ENQUEUE_JITTER_MS = "-1"; // negative → fallback
      expect(scheduledEnqueueJitterMs()).toBe(5 * 60_000);
      process.env.SCHEDULED_ENQUEUE_JITTER_MS = "not-a-number"; // NaN → fallback
      expect(scheduledEnqueueJitterMs()).toBe(5 * 60_000);
    } finally {
      if (old === undefined) delete process.env.SCHEDULED_ENQUEUE_JITTER_MS;
      else process.env.SCHEDULED_ENQUEUE_JITTER_MS = old;
    }
  });

  it("keeps the every-tick priority jobs immediate and phase-spreads the periodic maintenance jobs (#1948)", () => {
    const old = process.env.SCHEDULED_ENQUEUE_JITTER_MS;
    try {
      delete process.env.SCHEDULED_ENQUEUE_JITTER_MS; // default 5-min window
      // The timely-merge sweep and its Orb-relay retry run every ~2-min tick → never deferred.
      expect(scheduledEnqueueDelaySeconds("agent-regate-sweep")).toBe(0);
      expect(scheduledEnqueueDelaySeconds("retry-orb-relay")).toBe(0);

      // A periodic maintenance job gets a stable, in-window slot derived from the shared jitter helper.
      const window = 5 * 60_000;
      for (const type of [
        "refresh-registry",
        "refresh-scoring-model",
        "generate-signal-snapshots",
        "build-contributor-evidence",
      ]) {
        const delay = scheduledEnqueueDelaySeconds(type);
        expect(delay).toBe(Math.floor(deterministicJitterMs(type, window) / 1000));
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(window / 1000);
        expect(scheduledEnqueueDelaySeconds(type)).toBe(delay); // deterministic
      }

      // Distinct job types land in distinct slots → the enqueue is actually spread, not synchronized.
      const slots = [
        "refresh-registry",
        "refresh-scoring-model",
        "refresh-upstream-drift",
        "generate-signal-snapshots",
        "build-burden-forecasts",
        "build-contributor-evidence",
        "build-contributor-decision-packs",
        "file-upstream-drift-issues",
        "rollup-product-usage",
      ].map(scheduledEnqueueDelaySeconds);
      expect(new Set(slots).size).toBeGreaterThan(1);

      // A sub-second window collapses every slot to an immediate send (covers the floor → 0 path).
      process.env.SCHEDULED_ENQUEUE_JITTER_MS = "500";
      expect(scheduledEnqueueDelaySeconds("refresh-registry")).toBe(0);
      // A zero window disables jitter entirely.
      process.env.SCHEDULED_ENQUEUE_JITTER_MS = "0";
      expect(scheduledEnqueueDelaySeconds("generate-signal-snapshots")).toBe(0);
    } finally {
      if (old === undefined) delete process.env.SCHEDULED_ENQUEUE_JITTER_MS;
      else process.env.SCHEDULED_ENQUEUE_JITTER_MS = old;
    }
  });
});
