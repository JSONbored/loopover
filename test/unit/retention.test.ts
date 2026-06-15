import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { getDb } from "../../src/db/client";
import { pruneExpiredRecords, RETENTION_POLICY } from "../../src/db/retention";
import { aiUsageEvents, webhookEvents } from "../../src/db/schema";
import { processJob, runRetentionPrune } from "../../src/queue/processors";
import { createTestEnv } from "../helpers/d1";

const NOW = Date.parse("2026-06-13T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

async function seed(env: Env) {
  const db = getDb(env.DB);
  // webhook_events are durable replay/idempotency records and must not be pruned.
  await db.insert(webhookEvents).values([
    { deliveryId: "wh-old-1", eventName: "push", payloadHash: "h", status: "processed", receivedAt: daysAgo(40) },
    { deliveryId: "wh-old-2", eventName: "push", payloadHash: "h", status: "processed", receivedAt: daysAgo(35) },
    { deliveryId: "wh-recent", eventName: "push", payloadHash: "h", status: "processed", receivedAt: daysAgo(1) },
  ]);
  // ai_usage_events window = 90d; one old + one recent.
  await db.insert(aiUsageEvents).values([
    { id: "ai-old", feature: "f", model: "m", status: "ok", estimatedNeurons: 1, createdAt: daysAgo(100) },
    { id: "ai-recent", feature: "f", model: "m", status: "ok", estimatedNeurons: 1, createdAt: daysAgo(2) },
  ]);
}

const countWebhook = async (env: Env) => (await env.DB.prepare("SELECT count(*) AS n FROM webhook_events").first<{ n: number }>())?.n ?? 0;

describe("pruneExpiredRecords", () => {
  it("dry-run reports eligible rows per table without deleting anything", async () => {
    const env = createTestEnv();
    await seed(env);
    const results = await pruneExpiredRecords(env, { dryRun: true, nowMs: NOW });
    const ai = results.find((r) => r.table === "ai_usage_events");
    expect(results.find((r) => r.table === "webhook_events")).toBeUndefined();
    expect(ai?.deleted).toBe(1);
    expect(await countWebhook(env)).toBe(3); // nothing actually deleted
  });

  it("deletes rows older than the window and keeps recent ones", async () => {
    const env = createTestEnv();
    await seed(env);
    const results = await pruneExpiredRecords(env, { nowMs: NOW });
    expect(results.find((r) => r.table === "webhook_events")).toBeUndefined();
    expect(results.find((r) => r.table === "ai_usage_events")?.deleted).toBe(1);
    expect(await countWebhook(env)).toBe(3);
    const aiCount = await env.DB.prepare("SELECT count(*) AS n FROM ai_usage_events").first<{ n: number }>();
    expect(aiCount?.n).toBe(1);
  });

  it("deletes across multiple batches and stops at the per-table cap", async () => {
    const env = createTestEnv();
    const db = getDb(env.DB);
    await db.insert(aiUsageEvents).values(
      Array.from({ length: 5 }, (_, i) => ({ id: `ai-${i}`, feature: "f", model: "m", status: "ok", estimatedNeurons: 1, createdAt: daysAgo(100) })),
    );
    // batchSize 2 forces multiple iterations; maxPerTable 4 forces the cap break before all 5 are gone.
    const results = await pruneExpiredRecords(env, { nowMs: NOW, batchSize: 2, maxPerTable: 4, policy: [{ table: "ai_usage_events", column: "created_at", days: 90 }] });
    expect(results[0]?.deleted).toBe(4); // 2 + 2, then cap reached
    const remaining = await env.DB.prepare("SELECT count(*) AS n FROM ai_usage_events").first<{ n: number }>();
    expect(remaining?.n).toBe(1); // one old row left for the next run
  });

  it("rejects an unsafe table/column identifier (defensive guard)", async () => {
    const env = createTestEnv();
    await expect(pruneExpiredRecords(env, { policy: [{ table: "webhook_events; DROP TABLE x", column: "received_at", days: 1 }] })).rejects.toThrow("Unsafe retention identifier");
  });

  it("the policy only targets append-only/log/snapshot tables (no current-state tables)", () => {
    const tables = RETENTION_POLICY.map((r) => r.table);
    for (const protectedTable of ["webhook_events", "repositories", "repository_settings", "pull_requests", "issues", "repository_ai_keys", "contributors"]) {
      expect(tables).not.toContain(protectedTable);
    }
  });
});

describe("runRetentionPrune + processJob", () => {
  it("audits a dry-run without deleting", async () => {
    const env = createTestEnv();
    await seed(env);
    await runRetentionPrune(env, "test", true);
    expect(await countWebhook(env)).toBe(3);
    const audit = await env.DB.prepare("SELECT outcome, detail FROM audit_events WHERE event_type = ?").bind("retention.prune").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("completed");
    expect(audit?.detail).toMatch(/dry-run/);
  });

  it("processJob prune-retention deletes and audits", async () => {
    const env = createTestEnv();
    await seed(env);
    await processJob(env, { type: "prune-retention", requestedBy: "schedule" });
    expect(await countWebhook(env)).toBe(3);
    const audit = await env.DB.prepare("SELECT outcome FROM audit_events WHERE event_type = ?").bind("retention.prune").first<{ outcome: string }>();
    expect(audit?.outcome).toBe("success");
  });
});

describe("retention preview route", () => {
  it("GET /v1/internal/retention/preview returns eligible counts and deletes nothing", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seed(env);
    const res = await app.request("/v1/internal/retention/preview", { headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalEligible: number; eligible: Array<{ table: string; deleted: number }> };
    expect(body.totalEligible).toBeGreaterThanOrEqual(1);
    expect(body.eligible.find((r) => r.table === "webhook_events")).toBeUndefined();
    expect(await countWebhook(env)).toBe(3); // preview is read-only
  });
});
