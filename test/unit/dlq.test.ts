import { afterEach, describe, expect, it, vi } from "vitest";
import { processDlqBatch } from "../../src/queue/dlq";
import { recordGitHubRateLimitObservation, recordWebhookEvent } from "../../src/db/repositories";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import type { JobMessage } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

function makeBatch(messages: Array<{ id: string; body: unknown }>, queue = "gittensory-jobs-dlq") {
  const acked: string[] = [];
  const retried: string[] = [];
  return {
    queue,
    messages: messages.map((m) => ({
      id: m.id,
      body: m.body,
      ack() {
        acked.push(m.id);
      },
      retry() {
        retried.push(m.id);
      },
    })),
    acked,
    retried,
  };
}

describe("DLQ consumer (processDlqBatch)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetMetrics();
  });

  it("acks every message — never retries", async () => {
    const env = createTestEnv();
    const batch = makeBatch([
      { id: "msg-1", body: { type: "github-webhook", deliveryId: "d1", eventName: "pull_request", payload: {} } },
      { id: "msg-2", body: { type: "refresh-registry", requestedBy: "schedule" } },
    ]);

    await processDlqBatch(batch as unknown as MessageBatch<never>, env);

    expect(batch.acked).toEqual(["msg-1", "msg-2"]);
    expect(batch.retried).toEqual([]);
  });

  it("records a dlq_dead_lettered audit event for each message", async () => {
    const env = createTestEnv();
    const batch = makeBatch([
      { id: "msg-3", body: { type: "github-webhook", deliveryId: "evt-42", eventName: "check_suite", payload: {} } },
      { id: "msg-4", body: { type: "backfill-registered-repos", requestedBy: "schedule" } },
    ]);

    await processDlqBatch(batch as unknown as MessageBatch<never>, env);

    const events = await env.DB.prepare("select event_type, target_key, outcome, detail from audit_events order by rowid").all<{
      event_type: string;
      target_key: string;
      outcome: string;
      detail: string;
    }>();
    expect(events.results).toHaveLength(2);
    expect(events.results[0]).toMatchObject({ event_type: "github_app.dlq_dead_lettered", outcome: "error", target_key: "dlq:github-webhook:msg-3" });
    expect(events.results[1]).toMatchObject({ event_type: "github_app.dlq_dead_lettered", outcome: "error", target_key: "dlq:backfill-registered-repos:msg-4" });
    expect(events.results[0]?.detail).toContain("github-webhook");
    expect(events.results[1]?.detail).toContain("backfill-registered-repos");
  });

  it("includes deliveryId + eventName in the structured log for github-webhook jobs", async () => {
    const errorLogs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorLogs.push(String(args[0]));
    });

    const env = createTestEnv();
    const batch = makeBatch([{ id: "msg-5", body: { type: "github-webhook", deliveryId: "delivery-99", eventName: "pull_request", payload: {} } }]);

    await processDlqBatch(batch as unknown as MessageBatch<never>, env);

    const log = JSON.parse(errorLogs[0] ?? "{}") as Record<string, unknown>;
    expect(log).toMatchObject({ event: "dlq_message_dead_lettered", jobType: "github-webhook", deliveryId: "delivery-99", eventName: "pull_request" });
  });

  it("handles an unknown / malformed message body without throwing", async () => {
    const env = createTestEnv();
    const batch = makeBatch([{ id: "msg-6", body: null }]);

    await expect(processDlqBatch(batch as unknown as MessageBatch<never>, env)).resolves.toBeUndefined();
    expect(batch.acked).toEqual(["msg-6"]);
    expect(await renderMetrics()).toContain('gittensory_dlq_dead_lettered_total{jobType="unknown",redriven="false"} 1');
  });

  it("is fail-safe when recordAuditEvent throws — the catch body runs and ack is not blocked", async () => {
    const env = createTestEnv();
    // Break DB to force recordAuditEvent to throw → exercises the .catch(() => undefined) body
    const brokenEnv = { ...env, DB: null } as unknown as typeof env;
    const batch = makeBatch([{ id: "msg-7", body: { type: "github-webhook", deliveryId: "d99", eventName: "push", payload: {} } }]);

    await expect(processDlqBatch(batch as unknown as MessageBatch<never>, brokenEnv)).resolves.toBeUndefined();
    expect(batch.acked).toEqual(["msg-7"]);
    expect(await renderMetrics()).toContain('gittensory_dlq_dead_lettered_total{jobType="github-webhook",redriven="false"} 1');
  });

  describe("webhook self-heal re-drive (#1276)", () => {
    function captureWebhooks(env: ReturnType<typeof createTestEnv>) {
      const sent: JobMessage[] = [];
      env.WEBHOOKS = { send: async (m: JobMessage) => void sent.push(m) } as unknown as Queue;
      return sent;
    }

    it("INVARIANT: re-drives a recoverable github-webhook ONCE onto the webhook lane (event not yet processed)", async () => {
      const env = createTestEnv();
      const sent = captureWebhooks(env);
      // No webhook_events row for fresh-1 → status is undefined (≠ processed) → recoverable, re-drive.
      const batch = makeBatch([{ id: "wh-1", body: { type: "github-webhook", deliveryId: "fresh-1", eventName: "pull_request", payload: { action: "opened" } } }], "gittensory-webhooks-dlq");

      await processDlqBatch(batch as unknown as MessageBatch<never>, env);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: "github-webhook", deliveryId: "fresh-1", eventName: "pull_request", redriven: true });
      expect(batch.acked).toEqual(["wh-1"]);
      const metrics = await renderMetrics();
      expect(metrics).toContain('gittensory_dlq_dead_lettered_total{jobType="github-webhook",redriven="false"} 1');
      expect(metrics).toContain('gittensory_dlq_redriven_total{eventName="pull_request"} 1');
    });

    it("REGRESSION (idempotency): does NOT re-drive a webhook whose event row is already 'processed'", async () => {
      const env = createTestEnv();
      await recordWebhookEvent(env, { deliveryId: "done-1", eventName: "pull_request", payloadHash: "processed", status: "processed" });
      const sent = captureWebhooks(env);
      const batch = makeBatch([{ id: "wh-2", body: { type: "github-webhook", deliveryId: "done-1", eventName: "pull_request", payload: {} } }], "gittensory-webhooks-dlq");

      await processDlqBatch(batch as unknown as MessageBatch<never>, env);

      expect(sent).toEqual([]); // already processed → no duplicate side effects
      expect(batch.acked).toEqual(["wh-2"]);
      expect(await renderMetrics()).not.toContain("gittensory_dlq_redriven_total");
    });

    it("REGRESSION (metrics): failed webhook re-drive sends do not increment the redriven counter", async () => {
      const env = createTestEnv();
      env.WEBHOOKS = {
        send: async () => {
          throw new Error("queue unavailable");
        },
      } as unknown as Queue;
      const batch = makeBatch([{ id: "wh-send-fail", body: { type: "github-webhook", deliveryId: "send-fail-1", eventName: "pull_request", payload: {} } }], "gittensory-webhooks-dlq");

      await processDlqBatch(batch as unknown as MessageBatch<never>, env);

      expect(batch.acked).toEqual(["wh-send-fail"]);
      const metrics = await renderMetrics();
      expect(metrics).toContain('gittensory_dlq_dead_lettered_total{jobType="github-webhook",redriven="false"} 1');
      expect(metrics).not.toContain("gittensory_dlq_redriven_total");
    });

    it("REGRESSION (metrics): missing webhook queue binding does not increment the redriven counter", async () => {
      const env = createTestEnv();
      delete (env as Partial<Env>).WEBHOOKS;
      const batch = makeBatch([{ id: "wh-no-queue", body: { type: "github-webhook", deliveryId: "no-queue-1", eventName: "pull_request", payload: {} } }], "gittensory-webhooks-dlq");

      await processDlqBatch(batch as unknown as MessageBatch<never>, env);

      expect(batch.acked).toEqual(["wh-no-queue"]);
      const metrics = await renderMetrics();
      expect(metrics).toContain('gittensory_dlq_dead_lettered_total{jobType="github-webhook",redriven="false"} 1');
      expect(metrics).not.toContain("gittensory_dlq_redriven_total");
    });

    it("REGRESSION (no DLQ loop): does NOT re-drive a webhook that was already re-driven once", async () => {
      const env = createTestEnv();
      const sent = captureWebhooks(env);
      const batch = makeBatch([{ id: "wh-3", body: { type: "github-webhook", deliveryId: "loop-1", eventName: "push", payload: {}, redriven: true } }], "gittensory-webhooks-dlq");

      await processDlqBatch(batch as unknown as MessageBatch<never>, env);

      expect(sent).toEqual([]); // bounded to a single re-drive
      expect(batch.acked).toEqual(["wh-3"]);
      const metrics = await renderMetrics();
      expect(metrics).toContain('gittensory_dlq_dead_lettered_total{jobType="github-webhook",redriven="true"} 1');
      expect(metrics).not.toContain("gittensory_dlq_redriven_total");
    });

    it("REGRESSION (no re-drive of maintenance jobs): a backfill job is audited and dropped, never re-driven", async () => {
      const env = createTestEnv();
      const sent = captureWebhooks(env);
      const batch = makeBatch([{ id: "mn-1", body: { type: "backfill-repo-segment" } }], "gittensory-jobs-dlq");

      await processDlqBatch(batch as unknown as MessageBatch<never>, env);

      expect(sent).toEqual([]); // cron self-heals maintenance jobs
      expect(batch.acked).toEqual(["mn-1"]);
      const metrics = await renderMetrics();
      expect(metrics).toContain('gittensory_dlq_dead_lettered_total{jobType="backfill-repo-segment",redriven="false"} 1');
      expect(metrics).not.toContain("gittensory_dlq_redriven_total");
    });

    it("does not re-drive webhook jobs when webhook redrive is disabled for broker-only Cloudflare", async () => {
      const env = createTestEnv();
      const sent = captureWebhooks(env);
      const batch = makeBatch([{ id: "wh-broker-only", body: { type: "github-webhook", deliveryId: "broker-only-1", eventName: "pull_request", payload: {} } }], "gittensory-webhooks-dlq");

      await processDlqBatch(batch as unknown as MessageBatch<never>, env, { redriveWebhooks: false });

      expect(sent).toEqual([]);
      expect(batch.acked).toEqual(["wh-broker-only"]);
    });

    it("re-drives a rate-limited webhook AFTER the reset delay when the shared REST budget is exhausted (#audit-rate-headroom)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
      const env = createTestEnv();
      await recordGitHubRateLimitObservation(env, { repoFullName: "owner/repo", resource: "rest", path: "/x", statusCode: 200, limitValue: 5000, remaining: 5, resetAt: "2026-06-24T12:30:00.000Z", observedAt: "2026-06-24T12:00:00.000Z" });
      const options: Array<{ delaySeconds?: number } | undefined> = [];
      env.WEBHOOKS = { send: async (_m: JobMessage, opts?: { delaySeconds?: number }) => void options.push(opts) } as unknown as Queue;
      const batch = makeBatch([{ id: "wh-rl", body: { type: "github-webhook", deliveryId: "rl-1", eventName: "pull_request", payload: {} } }], "gittensory-webhooks-dlq");

      await processDlqBatch(batch as unknown as MessageBatch<never>, env);

      expect(options).toHaveLength(1);
      expect(options[0]?.delaySeconds).toBe(900); // re-driven after the reset, not immediately
      vi.useRealTimers();
    });
  });
});
