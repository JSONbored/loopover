import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { getDb } from "../../src/db/client";
import { dedupeSignalSnapshots, pruneExpiredRecords, RETENTION_POLICY } from "../../src/db/retention";
import { agentContextSnapshots, aiUsageEvents, webhookEvents } from "../../src/db/schema";
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

async function insertSignalSnapshot(env: Env, id: string, signalType: string, targetKey: string, generatedAt: string) {
  await env.DB.prepare(
    "INSERT INTO signal_snapshots (id, signal_type, target_key, repo_full_name, payload_json, generated_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, signalType, targetKey, "JSONbored/gittensory", "{}", generatedAt)
    .run();
}

const countSignalSnapshots = async (env: Env, signalType?: string) =>
  (
    await env.DB.prepare(signalType ? "SELECT count(*) AS n FROM signal_snapshots WHERE signal_type = ?" : "SELECT count(*) AS n FROM signal_snapshots")
      .bind(...(signalType ? [signalType] : []))
      .first<{ n: number }>()
  )?.n ?? 0;

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

  it("keeps published public-surface audit events because public stats use them as durable review keys", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `INSERT INTO audit_events (id, event_type, target_key, outcome, created_at)
       VALUES
         ('published-old', 'github_app.pr_public_surface_published', 'JSONbored/gittensory#1', 'completed', ?),
         ('rate-limit-old', 'rate_limit.denied', 'actor', 'completed', ?),
         ('rate-limit-recent', 'rate_limit.denied', 'actor', 'completed', ?)`,
    )
      .bind(daysAgo(100), daysAgo(100), daysAgo(2))
      .run();

    const results = await pruneExpiredRecords(env, {
      nowMs: NOW,
      policy: [{ table: "audit_events", column: "created_at", days: 90 }],
    });
    expect(results[0]?.deleted).toBe(1);
    const rows = await env.DB.prepare("SELECT id FROM audit_events ORDER BY id").all<{ id: string }>();
    expect(rows.results.map((row) => row.id)).toEqual(["published-old", "rate-limit-recent"]);
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

  it("prunes agent_context_snapshots older than its window and keeps recent runs (#3896)", async () => {
    const env = createTestEnv();
    const db = getDb(env.DB);
    await db.insert(agentContextSnapshots).values([
      { id: "ctx-old", runId: "run-old", createdAt: daysAgo(40) },
      { id: "ctx-recent", runId: "run-recent", createdAt: daysAgo(2) },
    ]);

    const results = await pruneExpiredRecords(env, {
      nowMs: NOW,
      policy: [{ table: "agent_context_snapshots", column: "created_at", days: 30 }],
    });

    expect(results[0]?.deleted).toBe(1);
    const rows = await env.DB.prepare("SELECT id FROM agent_context_snapshots").all<{ id: string }>();
    expect(rows.results.map((row) => row.id)).toEqual(["ctx-recent"]);
  });

  it("the policy only targets append-only/log/snapshot tables (no current-state tables)", () => {
    const tables = RETENTION_POLICY.map((r) => r.table);
    for (const protectedTable of ["webhook_events", "repositories", "repository_settings", "pull_requests", "issues", "repository_ai_keys", "contributors"]) {
      expect(tables).not.toContain(protectedTable);
    }
  });
});

describe("dedupeSignalSnapshots", () => {
  it("returns no results when the table is empty", async () => {
    const env = createTestEnv();
    const results = await dedupeSignalSnapshots(env);
    expect(results).toEqual([]);
  });

  it("dry-run counts duplicates per signal_type without deleting anything", async () => {
    const env = createTestEnv();
    await insertSignalSnapshot(env, "s-1", "repo_culture", "JSONbored/gittensory", "2026-06-01T00:00:00.000Z");
    await insertSignalSnapshot(env, "s-2", "repo_culture", "JSONbored/gittensory", "2026-06-02T00:00:00.000Z");
    await insertSignalSnapshot(env, "s-3", "repo_culture", "other/repo", "2026-06-01T00:00:00.000Z"); // distinct key, not a duplicate
    const results = await dedupeSignalSnapshots(env, { dryRun: true });
    expect(results).toEqual([{ signalType: "repo_culture", deleted: 1 }]);
    expect(await countSignalSnapshots(env)).toBe(3); // nothing actually deleted
  });

  it("keeps only the highest-rowid row per (signal_type, target_key) and leaves other signal_types untouched", async () => {
    const env = createTestEnv();
    await insertSignalSnapshot(env, "s-1", "repo_culture", "JSONbored/gittensory", "2026-06-01T00:00:00.000Z");
    await insertSignalSnapshot(env, "s-2", "repo_culture", "JSONbored/gittensory", "2026-06-02T00:00:00.000Z");
    await insertSignalSnapshot(env, "s-3", "repo_culture", "JSONbored/gittensory", "2026-06-03T00:00:00.000Z"); // latest, kept
    await insertSignalSnapshot(env, "s-4", "burden_forecast", "JSONbored/gittensory", "2026-06-01T00:00:00.000Z"); // sole row, kept

    const results = await dedupeSignalSnapshots(env);
    expect(results.find((r) => r.signalType === "repo_culture")?.deleted).toBe(2);
    expect(results.find((r) => r.signalType === "burden_forecast")?.deleted).toBe(0);
    expect(await countSignalSnapshots(env, "repo_culture")).toBe(1);
    expect(await countSignalSnapshots(env, "burden_forecast")).toBe(1);
    const remaining = await env.DB.prepare("SELECT id FROM signal_snapshots WHERE signal_type = ?").bind("repo_culture").first<{ id: string }>();
    expect(remaining?.id).toBe("s-3");
  });

  it("deletes across multiple batches per signal_type and stops at the per-type cap", async () => {
    const env = createTestEnv();
    for (let i = 0; i < 6; i++) {
      await insertSignalSnapshot(env, `s-${i}`, "repo_culture", "JSONbored/gittensory", `2026-06-0${i + 1}T00:00:00.000Z`);
    }
    // The 6th insert (highest generated_at, inserted last so it also has the highest rowid) is kept, leaving 5
    // duplicates; batchSize 2 forces multiple full (changes === batchSize) delete iterations before maxPerType 4
    // is reached, so the loop continues past its first batch instead of stopping there.
    const results = await dedupeSignalSnapshots(env, { batchSize: 2, maxPerType: 4 });
    expect(results).toEqual([{ signalType: "repo_culture", deleted: 4 }]); // 2 + 2, then cap reached
    expect(await countSignalSnapshots(env, "repo_culture")).toBe(2); // 1 kept + 1 duplicate left for the next run
  });

  it("dry-run falls back to 0 when the count query returns no row (defensive ?? 0 arm)", async () => {
    const noRowEnv = {
      DB: {
        prepare: (sql: string) => ({
          all: async () => ({ results: [{ signal_type: "repo_culture" }] }), // the DISTINCT signal_type query
          bind: (..._binds: unknown[]) => ({
            first: async () => undefined, // count query returns no row → `row?.n ?? 0` fallback fires
          }),
        }),
      },
    } as unknown as Env;
    const results = await dedupeSignalSnapshots(noRowEnv, { dryRun: true });
    expect(results).toEqual([{ signalType: "repo_culture", deleted: 0 }]);
  });

  it("falls back to 0 changes when a delete run() result lacks meta (defensive ?? 0 arm)", async () => {
    const noMetaEnv = {
      DB: {
        prepare: (sql: string) => ({
          all: async () => ({ results: [{ signal_type: "repo_culture" }] }), // the DISTINCT signal_type query
          bind: (..._binds: unknown[]) => ({
            run: async () => ({}), // no meta → `result.meta?.changes ?? 0` fallback fires, so changes = 0 < batchSize
          }),
        }),
      },
    } as unknown as Env;
    const results = await dedupeSignalSnapshots(noMetaEnv);
    expect(results).toEqual([{ signalType: "repo_culture", deleted: 0 }]);
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

  it("processJob prune-retention deletes, dedupes signal_snapshots, and audits both", async () => {
    const env = createTestEnv();
    await seed(env);
    await insertSignalSnapshot(env, "s-1", "repo_culture", "JSONbored/gittensory", "2026-06-01T00:00:00.000Z");
    await insertSignalSnapshot(env, "s-2", "repo_culture", "JSONbored/gittensory", "2026-06-02T00:00:00.000Z");
    await processJob(env, { type: "prune-retention", requestedBy: "schedule" });
    expect(await countWebhook(env)).toBe(3);
    expect(await countSignalSnapshots(env, "repo_culture")).toBe(1);
    const audit = await env.DB.prepare("SELECT outcome, detail FROM audit_events WHERE event_type = ?").bind("retention.prune").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("success");
    expect(audit?.detail).toMatch(/deduped 1 signal_snapshots row/);
  });
});

describe("retention preview route", () => {
  it("GET /v1/internal/retention/preview returns eligible counts and deletes nothing", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seed(env);
    await insertSignalSnapshot(env, "s-1", "repo_culture", "JSONbored/gittensory", "2026-06-01T00:00:00.000Z");
    await insertSignalSnapshot(env, "s-2", "repo_culture", "JSONbored/gittensory", "2026-06-02T00:00:00.000Z");
    const res = await app.request("/v1/internal/retention/preview", { headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalEligible: number;
      eligible: Array<{ table: string; deleted: number }>;
      totalSignalSnapshotDuplicates: number;
      signalSnapshotDuplicates: Array<{ signalType: string; deleted: number }>;
    };
    expect(body.totalEligible).toBeGreaterThanOrEqual(1);
    expect(body.eligible.find((r) => r.table === "webhook_events")).toBeUndefined();
    expect(body.totalSignalSnapshotDuplicates).toBe(1);
    expect(body.signalSnapshotDuplicates).toEqual([{ signalType: "repo_culture", deleted: 1 }]);
    expect(await countWebhook(env)).toBe(3); // preview is read-only
    expect(await countSignalSnapshots(env)).toBe(2); // preview is read-only
  });
});
