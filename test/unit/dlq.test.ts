import { afterEach, describe, expect, it, vi } from "vitest";
import { processDlqBatch } from "../../src/queue/dlq";
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
  });

  it("is fail-safe when recordAuditEvent throws — the catch body runs and ack is not blocked", async () => {
    const env = createTestEnv();
    // Break DB to force recordAuditEvent to throw → exercises the .catch(() => undefined) body
    const brokenEnv = { ...env, DB: null } as unknown as typeof env;
    const batch = makeBatch([{ id: "msg-7", body: { type: "github-webhook", deliveryId: "d99", eventName: "push", payload: {} } }]);

    await expect(processDlqBatch(batch as unknown as MessageBatch<never>, brokenEnv)).resolves.toBeUndefined();
    expect(batch.acked).toEqual(["msg-7"]);
  });
});
