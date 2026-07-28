import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { getDb } from "../../src/db/client";
import { dedupeSignalSnapshots, pruneExpiredRecords, RETENTION_COMPOSITE_PK_TABLES, RETENTION_PK_COLUMN, RETENTION_POLICY, retentionCutoffIsoForTable } from "../../src/db/retention";
import { getOrbGlobalStats } from "../../src/orb/outcomes";
import { agentContextSnapshots, aiReviewCache, aiSlopCache, aiUsageEvents, groundingFileContentCache, linkedIssueSatisfactionCache, webhookEvents } from "../../src/db/schema";
import { processJob, runRetentionPrune } from "../../src/queue/processors";
import { REPO_FOCUS_MANIFEST_SIGNAL, REPO_PUBLIC_FOCUS_MANIFEST_SIGNAL } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

const NOW = Date.parse("2026-06-13T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

async function seed(env: Env) {
  const db = getDb(env.DB);
  // webhook_events: 90d window (#8381) — seed past-cutoff + recent rows.
  await db.insert(webhookEvents).values([
    { deliveryId: "wh-old-1", eventName: "push", payloadHash: "h", status: "processed", receivedAt: daysAgo(100) },
    { deliveryId: "wh-old-2", eventName: "push", payloadHash: "h", status: "processed", receivedAt: daysAgo(95) },
    // Anchored to REAL now, not the fixed NOW the `daysAgo` rows use: the pruneExpiredRecords tests below
    // pass an explicit `nowMs: NOW`, but the processJob and preview-route tests do not and so evaluate the
    // policy against actual wall-clock time. A `daysAgo(1)` "recent" row is ~45 days before real now, which
    // survived the old 90-day webhook_events window purely by accident and stopped surviving when that
    // window tightened to 14 days. Real-now keeps this row genuinely recent under BOTH clocks (it is also
    // after NOW, so it is never past a NOW-based cutoff either) and keeps each test's "recent rows are
    // kept" intent independent of how wide the window happens to be.
    { deliveryId: "wh-recent", eventName: "push", payloadHash: "h", status: "processed", receivedAt: new Date().toISOString() },
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
    .bind(id, signalType, targetKey, "JSONbored/loopover", "{}", generatedAt)
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
    expect(results.find((r) => r.table === "webhook_events")?.deleted).toBe(2);
    expect(ai?.deleted).toBe(1);
    expect(await countWebhook(env)).toBe(3); // nothing actually deleted
  });

  it("deletes rows older than the window and keeps recent ones", async () => {
    const env = createTestEnv();
    await seed(env);
    const results = await pruneExpiredRecords(env, { nowMs: NOW });
    expect(results.find((r) => r.table === "webhook_events")?.deleted).toBe(2);
    expect(results.find((r) => r.table === "ai_usage_events")?.deleted).toBe(1);
    expect(await countWebhook(env)).toBe(1);
    const aiCount = await env.DB.prepare("SELECT count(*) AS n FROM ai_usage_events").first<{ n: number }>();
    expect(aiCount?.n).toBe(1);
  });

  it("keeps published public-surface audit events because public stats use them as durable review keys", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `INSERT INTO audit_events (id, event_type, target_key, outcome, created_at)
       VALUES
         ('published-old', 'github_app.pr_public_surface_published', 'JSONbored/loopover#1', 'completed', ?),
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

  // The hosted D1 reached its 10GB ceiling because these five tables had NO retention rule at all: every
  // write then failed with `D1_ERROR: Exceeded maximum DB size`, including recordOrbWebhookEvent's INSERT,
  // so /v1/orb/webhook returned 500 to GitHub and inbound webhook delivery stopped fleet-wide. Pinning the
  // exact column names matters as much as the windows -- pruneExpiredRecords builds `<column> < ?` from
  // this policy, so a column that does not exist on the table makes the rule a permanent silent no-op and
  // the table resumes growing without bound exactly as before.
  it("covers the five previously-unbounded high-growth tables (D1 ceiling regression)", () => {
    const expected = [
      { table: "check_summaries", column: "updated_at", days: 30 },
      { table: "pull_request_files", column: "updated_at", days: 30 },
      { table: "repo_github_totals_snapshots", column: "fetched_at", days: 30 },
      { table: "recent_merged_pull_requests", column: "updated_at", days: 30 },
      { table: "orb_pr_outcomes", column: "occurred_at", days: 90 },
    ];
    for (const want of expected) {
      expect(RETENTION_POLICY).toContainEqual(want);
    }
  });

  // Both webhook logs are short-lived idempotency lookups (minutes-old at most), cut 90d -> 14d as the
  // single largest avoidable contributor to the same ceiling.
  it("keeps both webhook idempotency logs on the tightened 14-day window", () => {
    expect(RETENTION_POLICY).toContainEqual({ table: "webhook_events", column: "received_at", days: 14 });
    expect(RETENTION_POLICY).toContainEqual({ table: "orb_webhook_events", column: "received_at", days: 14 });
  });

  // check_summaries was the largest single consumer in the database at the time of the outage (100,459 rows
  // / 0.30GB of payload_json). Exercises the REAL policy window rather than an ad-hoc override, so dropping
  // or re-widening the entry fails here.
  it("prunes check_summaries past its policy window and keeps recent rows", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `INSERT INTO check_summaries (id, repo_full_name, pull_number, head_sha, name, status, conclusion, payload_json, updated_at)
       VALUES
         ('cs-old-1', 'acme/widgets', 1, 'sha1', 'ci', 'completed', 'success', '{}', ?),
         ('cs-old-2', 'acme/widgets', 2, 'sha2', 'ci', 'completed', 'failure', '{}', ?),
         ('cs-recent', 'acme/widgets', 3, 'sha3', 'ci', 'completed', 'success', '{}', ?)`,
    )
      .bind(daysAgo(60), daysAgo(31), daysAgo(1))
      .run();

    const rule = RETENTION_POLICY.find((r) => r.table === "check_summaries");
    expect(rule).toBeDefined();

    const results = await pruneExpiredRecords(env, { nowMs: NOW, policy: [rule as (typeof RETENTION_POLICY)[number]] });
    expect(results[0]?.deleted).toBe(2);
    const rows = await env.DB.prepare("SELECT id FROM check_summaries").all<{ id: string }>();
    expect(rows.results.map((row) => row.id)).toEqual(["cs-recent"]);
  });

  it("the policy only targets append-only/log/snapshot tables (no current-state tables)", () => {
    const tables = RETENTION_POLICY.map((r) => r.table);
    expect(tables).toContain("webhook_events");
    for (const protectedTable of ["repositories", "repository_settings", "pull_requests", "issues", "repository_ai_keys", "contributors"]) {
      expect(tables).not.toContain(protectedTable);
    }
  });

  it("prunes webhook_events older than 90d and keeps recent deliveries (#8381)", async () => {
    const env = createTestEnv();
    await seed(env);
    const results = await pruneExpiredRecords(env, {
      nowMs: NOW,
      policy: [{ table: "webhook_events", column: "received_at", days: 90 }],
    });
    expect(results[0]?.deleted).toBe(2);
    const rows = await env.DB.prepare("SELECT delivery_id FROM webhook_events").all<{ delivery_id: string }>();
    expect(rows.results.map((row) => row.delivery_id)).toEqual(["wh-recent"]);
  });

  it("prunes notification_deliveries older than 90d and keeps recent rows (#8899)", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `INSERT INTO notification_deliveries
        (id, dedup_key, channel, recipient_login, event_type, repo_full_name, title, body, deeplink, status, created_at)
       VALUES
         ('nd-old-1', 'd1', 'email', 'alice', 'issue_watch_match', 'acme/widgets', 't', 'b', 'https://x', 'delivered', ?),
         ('nd-old-2', 'd2', 'email', 'alice', 'issue_watch_match', 'acme/widgets', 't', 'b', 'https://x', 'delivered', ?),
         ('nd-recent', 'd3', 'email', 'alice', 'issue_watch_match', 'acme/widgets', 't', 'b', 'https://x', 'delivered', ?)`,
    )
      .bind(daysAgo(100), daysAgo(95), daysAgo(1))
      .run();

    expect(RETENTION_POLICY.some((rule) => rule.table === "notification_deliveries" && rule.column === "created_at" && rule.days === 90)).toBe(
      true,
    );

    const results = await pruneExpiredRecords(env, {
      nowMs: NOW,
      policy: [{ table: "notification_deliveries", column: "created_at", days: 90 }],
    });
    expect(results[0]?.deleted).toBe(2);
    const rows = await env.DB.prepare("SELECT id FROM notification_deliveries").all<{ id: string }>();
    expect(rows.results.map((row) => row.id)).toEqual(["nd-recent"]);
  });

  // #9138: predicted_gate_calls (src/review/predicted-gate-calls.ts) deliberately never dedups at write time --
  // "every call gets its own row" -- so it needed the same retention path as the other unbounded, contributor-
  // driven append-only log tables above.
  it("prunes predicted_gate_calls older than 90d and keeps recent rows (#9138)", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `INSERT INTO predicted_gate_calls (id, login, project, predicted_action, conclusion, reason_code, created_at)
       VALUES
         ('pgc-old-1', 'octocat', 'owner/repo', 'merge', 'success', 'success', ?),
         ('pgc-old-2', 'octocat', 'owner/repo', 'hold', 'action_required', 'missing_linked_issue', ?),
         ('pgc-recent', 'octocat', 'owner/repo', 'merge', 'success', 'success', ?)`,
    )
      .bind(daysAgo(100), daysAgo(95), daysAgo(1))
      .run();

    expect(RETENTION_POLICY.some((rule) => rule.table === "predicted_gate_calls" && rule.column === "created_at" && rule.days === 90)).toBe(true);

    const results = await pruneExpiredRecords(env, {
      nowMs: NOW,
      policy: [{ table: "predicted_gate_calls", column: "created_at", days: 90 }],
    });
    expect(results[0]?.deleted).toBe(2);
    const rows = await env.DB.prepare("SELECT id FROM predicted_gate_calls").all<{ id: string }>();
    expect(rows.results.map((row) => row.id)).toEqual(["pgc-recent"]);
  });

  // #9083: four read-side caches had a read-side TTL but no delete path anywhere — every row lived forever.
  // Each now has a RETENTION_POLICY entry; these regression tests exercise the actual policy windows (not
  // an ad-hoc override) so a future edit to RETENTION_POLICY that drops one of these entries fails loudly.
  it("prunes grounding_file_content_cache older than its 2-day window and keeps recent rows (#9083)", async () => {
    const env = createTestEnv();
    const db = getDb(env.DB);
    await db.insert(groundingFileContentCache).values([
      { repoFullName: "acme/widgets", path: "a.ts", headSha: "sha-old", content: "old", fetchedAt: daysAgo(3) },
      { repoFullName: "acme/widgets", path: "a.ts", headSha: "sha-new", content: "new", fetchedAt: daysAgo(1) },
    ]);

    const rule = RETENTION_POLICY.find((r) => r.table === "grounding_file_content_cache");
    expect(rule).toEqual({ table: "grounding_file_content_cache", column: "fetched_at", days: 2 });

    const results = await pruneExpiredRecords(env, { nowMs: NOW, policy: [rule!] });
    expect(results[0]?.deleted).toBe(1);
    const rows = await env.DB.prepare("SELECT head_sha FROM grounding_file_content_cache").all<{ head_sha: string }>();
    expect(rows.results.map((row) => row.head_sha)).toEqual(["sha-new"]);
  });

  it("prunes ai_review_cache and ai_slop_cache older than their 30-day window and keeps recent rows (#9083)", async () => {
    const env = createTestEnv();
    const db = getDb(env.DB);
    await db.insert(aiReviewCache).values([
      { repoFullName: "acme/widgets", pullNumber: 1, headSha: "sha-old", aiReviewMode: "full", notes: "n", reviewerCount: 1, createdAt: daysAgo(40) },
      { repoFullName: "acme/widgets", pullNumber: 1, headSha: "sha-new", aiReviewMode: "full", notes: "n", reviewerCount: 1, createdAt: daysAgo(1) },
    ]);
    await db.insert(aiSlopCache).values([
      { repoFullName: "acme/widgets", pullNumber: 1, headSha: "sha-old", inputFingerprint: "f", status: "ok", createdAt: daysAgo(40) },
      { repoFullName: "acme/widgets", pullNumber: 1, headSha: "sha-new", inputFingerprint: "f", status: "ok", createdAt: daysAgo(1) },
    ]);

    const reviewRule = RETENTION_POLICY.find((r) => r.table === "ai_review_cache");
    const slopRule = RETENTION_POLICY.find((r) => r.table === "ai_slop_cache");
    expect(reviewRule).toEqual({ table: "ai_review_cache", column: "created_at", days: 30 });
    expect(slopRule).toEqual({ table: "ai_slop_cache", column: "created_at", days: 30 });

    const results = await pruneExpiredRecords(env, { nowMs: NOW, policy: [reviewRule!, slopRule!] });
    expect(results.find((r) => r.table === "ai_review_cache")?.deleted).toBe(1);
    expect(results.find((r) => r.table === "ai_slop_cache")?.deleted).toBe(1);
    const reviewRows = await env.DB.prepare("SELECT head_sha FROM ai_review_cache").all<{ head_sha: string }>();
    expect(reviewRows.results.map((row) => row.head_sha)).toEqual(["sha-new"]);
    const slopRows = await env.DB.prepare("SELECT head_sha FROM ai_slop_cache").all<{ head_sha: string }>();
    expect(slopRows.results.map((row) => row.head_sha)).toEqual(["sha-new"]);
  });

  it("prunes linked_issue_satisfaction_cache older than its 30-day window and keeps recent rows (#9083)", async () => {
    const env = createTestEnv();
    const db = getDb(env.DB);
    await db.insert(linkedIssueSatisfactionCache).values([
      { repoFullName: "acme/widgets", pullNumber: 1, headSha: "sha-old", linkedIssueNumber: 5, inputFingerprint: "f", status: "ok", createdAt: daysAgo(40) },
      { repoFullName: "acme/widgets", pullNumber: 1, headSha: "sha-new", linkedIssueNumber: 5, inputFingerprint: "f", status: "ok", createdAt: daysAgo(1) },
    ]);

    const rule = RETENTION_POLICY.find((r) => r.table === "linked_issue_satisfaction_cache");
    expect(rule).toEqual({ table: "linked_issue_satisfaction_cache", column: "created_at", days: 30 });

    const results = await pruneExpiredRecords(env, { nowMs: NOW, policy: [rule!] });
    expect(results[0]?.deleted).toBe(1);
    const rows = await env.DB.prepare("SELECT head_sha FROM linked_issue_satisfaction_cache").all<{ head_sha: string }>();
    expect(rows.results.map((row) => row.head_sha)).toEqual(["sha-new"]);
  });

  // #9083: review_audit, decision_records, and orb_webhook_events were append-only logs with no retention
  // rule at all. All three are raw-SQL-only tables (RAW_SQL_ONLY_TABLES in check-schema-drift.ts), so seed
  // via raw SQL like the predicted_gate_calls test above.
  it("prunes review_audit older than its 90-day window and keeps recent rows (#9083)", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at)
       VALUES
         ('ra-old', 'acme/widgets', 'acme/widgets#1', 'gate_decision', 'merge', 'loopover-native', 'sha1', 'success', ?),
         ('ra-recent', 'acme/widgets', 'acme/widgets#1', 'gate_decision', 'merge', 'loopover-native', 'sha2', 'success', ?)`,
    )
      .bind(daysAgo(100), daysAgo(1))
      .run();

    const rule = RETENTION_POLICY.find((r) => r.table === "review_audit");
    expect(rule).toEqual({ table: "review_audit", column: "created_at", days: 90 });

    const results = await pruneExpiredRecords(env, { nowMs: NOW, policy: [rule!] });
    expect(results[0]?.deleted).toBe(1);
    const rows = await env.DB.prepare("SELECT id FROM review_audit").all<{ id: string }>();
    expect(rows.results.map((row) => row.id)).toEqual(["ra-recent"]);
  });

  it("prunes decision_records older than its 180-day window and keeps recent rows (#9083)", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `INSERT INTO decision_records (id, repo_full_name, pull_number, head_sha, action, reason_code, record_digest, record_json, created_at)
       VALUES
         ('dr-old', 'acme/widgets', 1, 'sha1', 'close', 'missing_linked_issue', 'digest1', '{}', ?),
         ('dr-recent', 'acme/widgets', 1, 'sha2', 'close', 'missing_linked_issue', 'digest2', '{}', ?)`,
    )
      .bind(daysAgo(200), daysAgo(1))
      .run();

    const rule = RETENTION_POLICY.find((r) => r.table === "decision_records");
    expect(rule).toEqual({ table: "decision_records", column: "created_at", days: 180 });

    const results = await pruneExpiredRecords(env, { nowMs: NOW, policy: [rule!] });
    expect(results[0]?.deleted).toBe(1);
    const rows = await env.DB.prepare("SELECT id FROM decision_records").all<{ id: string }>();
    expect(rows.results.map((row) => row.id)).toEqual(["dr-recent"]);
  });

  it("prunes orb_webhook_events older than its 14-day window and keeps recent rows (#9083)", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `INSERT INTO orb_webhook_events (delivery_id, event_name, payload_hash, status, received_at)
       VALUES
         ('owe-old', 'push', 'h', 'processed', ?),
         ('owe-recent', 'push', 'h', 'processed', ?)`,
    )
      .bind(daysAgo(100), daysAgo(1))
      .run();

    const rule = RETENTION_POLICY.find((r) => r.table === "orb_webhook_events");
    expect(rule).toEqual({ table: "orb_webhook_events", column: "received_at", days: 14 });

    const results = await pruneExpiredRecords(env, { nowMs: NOW, policy: [rule!] });
    expect(results[0]?.deleted).toBe(1);
    const rows = await env.DB.prepare("SELECT delivery_id FROM orb_webhook_events").all<{ delivery_id: string }>();
    expect(rows.results.map((row) => row.delivery_id)).toEqual(["owe-recent"]);
  });

  // #9083: pruneExpiredRecords now deletes via a real PK (RETENTION_PK_COLUMN) ordered by the retention
  // column instead of rowid/ctid, so this pins that a table absent from that map (composite-PK caches, or
  // any future ad-hoc policy entry) still falls back to the rowid path correctly rather than erroring.
  it("falls back to rowid ordering for a table with no RETENTION_PK_COLUMN entry", async () => {
    const env = createTestEnv();
    const db = getDb(env.DB);
    await db.insert(aiReviewCache).values([
      { repoFullName: "acme/widgets", pullNumber: 2, headSha: "sha-a", aiReviewMode: "full", notes: "n", reviewerCount: 1, createdAt: daysAgo(50) },
      { repoFullName: "acme/widgets", pullNumber: 2, headSha: "sha-b", aiReviewMode: "full", notes: "n", reviewerCount: 1, createdAt: daysAgo(45) },
    ]);
    // ai_review_cache has a composite primary key (repo, pull, head_sha) so it is intentionally absent from
    // RETENTION_PK_COLUMN; the delete must still succeed via the rowid fallback.
    const results = await pruneExpiredRecords(env, {
      nowMs: NOW,
      policy: [{ table: "ai_review_cache", column: "created_at", days: 30 }],
    });
    expect(results[0]?.deleted).toBe(2);
    const remaining = await env.DB.prepare("SELECT count(*) AS n FROM ai_review_cache").first<{ n: number }>();
    expect(remaining?.n).toBe(0);
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
    await insertSignalSnapshot(env, "s-1", "repo-culture-profile", "JSONbored/loopover", "2026-06-01T00:00:00.000Z");
    await insertSignalSnapshot(env, "s-2", "repo-culture-profile", "JSONbored/loopover", "2026-06-02T00:00:00.000Z");
    await insertSignalSnapshot(env, "s-3", "repo-culture-profile", "other/repo", "2026-06-01T00:00:00.000Z"); // distinct key, not a duplicate
    const results = await dedupeSignalSnapshots(env, { dryRun: true });
    expect(results).toEqual([{ signalType: "repo-culture-profile", deleted: 1 }]);
    expect(await countSignalSnapshots(env)).toBe(3); // nothing actually deleted
  });

  it("keeps only the highest-rowid row for latest-only signal types and preserves historical signal types", async () => {
    const env = createTestEnv();
    await insertSignalSnapshot(env, "s-1", "repo-culture-profile", "JSONbored/loopover", "2026-06-01T00:00:00.000Z");
    await insertSignalSnapshot(env, "s-2", "repo-culture-profile", "JSONbored/loopover", "2026-06-02T00:00:00.000Z");
    await insertSignalSnapshot(env, "s-3", "repo-culture-profile", "JSONbored/loopover", "2026-06-03T00:00:00.000Z"); // latest, kept
    await insertSignalSnapshot(env, "s-4", "queue-health", "JSONbored/loopover", "2026-06-01T00:00:00.000Z"); // historical type, not deduped

    const results = await dedupeSignalSnapshots(env);
    expect(results.find((r) => r.signalType === "repo-culture-profile")?.deleted).toBe(2);
    expect(results.find((r) => r.signalType === "queue-health")).toBeUndefined();
    expect(await countSignalSnapshots(env, "repo-culture-profile")).toBe(1);
    expect(await countSignalSnapshots(env, "queue-health")).toBe(1);
    const remaining = await env.DB.prepare("SELECT id FROM signal_snapshots WHERE signal_type = ?").bind("repo-culture-profile").first<{ id: string }>();
    expect(remaining?.id).toBe("s-3");
  });

  it("dedupes the contributor-intelligence types to latest-per-contributor (2026-07 recurrence of #3810: ~6GB in three weeks)", async () => {
    const env = createTestEnv();
    for (const signalType of ["contributor-evidence-graph", "contributor-outcome-history", "contributor-strategy"] as const) {
      await insertSignalSnapshot(env, `${signalType}-old`, signalType, "octocat", "2026-07-01T00:00:00.000Z");
      await insertSignalSnapshot(env, `${signalType}-new`, signalType, "octocat", "2026-07-02T00:00:00.000Z");
      await insertSignalSnapshot(env, `${signalType}-other`, signalType, "hubot", "2026-07-02T00:00:00.000Z");
    }
    // #9435/#9459: contributor-decision-pack is NOT a bounded trend series (that earlier assumption was wrong
    // and was itself the single largest contributor to the D1 filling up) — it dedupes to latest-per-contributor
    // exactly like its three neighbors above; see the dedicated test below for its own coverage.
    await insertSignalSnapshot(env, "pack-1", "contributor-decision-pack", "octocat", "2026-07-01T00:00:00.000Z");
    await insertSignalSnapshot(env, "pack-2", "contributor-decision-pack", "octocat", "2026-07-02T00:00:00.000Z");

    const results = await dedupeSignalSnapshots(env);
    const byType = Object.fromEntries(results.map((r) => [r.signalType, r.deleted]));
    expect(byType["contributor-evidence-graph"]).toBe(1);
    expect(byType["contributor-outcome-history"]).toBe(1);
    expect(byType["contributor-strategy"]).toBe(1);
    expect(byType["contributor-decision-pack"]).toBe(1);

    const remaining = await env.DB.prepare("SELECT id FROM signal_snapshots ORDER BY id").all<{ id: string }>();
    const ids = (remaining.results ?? []).map((row) => row.id);
    expect(ids).toContain("contributor-strategy-new");
    expect(ids).toContain("contributor-strategy-other");
    expect(ids).not.toContain("contributor-strategy-old");
    expect(ids).not.toContain("pack-1"); // now deduped away
    expect(ids).toContain("pack-2");
  });

  it("dedupes the eight latest-only signal types added in #8900 to one row per repo", async () => {
    const env = createTestEnv();
    const types = [
      "config-quality",
      "label-audit",
      "maintainer-lane",
      "maintainer-cut-readiness",
      "contributor-intake-health",
      "issue-quality",
      "repo-outcome-patterns",
      "pr-reviewability",
    ] as const;
    for (const signalType of types) {
      await insertSignalSnapshot(env, `${signalType}-old`, signalType, "JSONbored/loopover", "2026-07-01T00:00:00.000Z");
      await insertSignalSnapshot(env, `${signalType}-mid`, signalType, "JSONbored/loopover", "2026-07-02T00:00:00.000Z");
      await insertSignalSnapshot(env, `${signalType}-new`, signalType, "JSONbored/loopover", "2026-07-03T00:00:00.000Z");
      await insertSignalSnapshot(env, `${signalType}-other`, signalType, "other/repo", "2026-07-03T00:00:00.000Z");
    }

    const results = await dedupeSignalSnapshots(env);
    const byType = Object.fromEntries(results.map((r) => [r.signalType, r.deleted]));
    for (const signalType of types) {
      expect(byType[signalType]).toBe(2); // old + mid deleted; new kept; other/repo untouched
      expect(await countSignalSnapshots(env, signalType)).toBe(2); // latest for loopover + other/repo
    }
    const remaining = await env.DB.prepare("SELECT id FROM signal_snapshots ORDER BY id").all<{ id: string }>();
    const ids = (remaining.results ?? []).map((row) => row.id);
    expect(ids).toContain("pr-reviewability-new");
    expect(ids).toContain("pr-reviewability-other");
    expect(ids).not.toContain("pr-reviewability-old");
    expect(ids).not.toContain("pr-reviewability-mid");
  });

  it("dedupes private and public focus-manifest cache snapshots (regression for storage exhaustion)", async () => {
    const env = createTestEnv();
    await insertSignalSnapshot(env, "private-old", REPO_FOCUS_MANIFEST_SIGNAL, "JSONbored/loopover", "2026-06-01T00:00:00.000Z");
    await insertSignalSnapshot(env, "private-latest", REPO_FOCUS_MANIFEST_SIGNAL, "JSONbored/loopover", "2026-06-02T00:00:00.000Z");
    await insertSignalSnapshot(env, "public-old", REPO_PUBLIC_FOCUS_MANIFEST_SIGNAL, "JSONbored/loopover", "2026-06-01T00:00:00.000Z");
    await insertSignalSnapshot(env, "public-latest", REPO_PUBLIC_FOCUS_MANIFEST_SIGNAL, "JSONbored/loopover", "2026-06-02T00:00:00.000Z");

    const results = await dedupeSignalSnapshots(env);

    expect(results).toEqual([
      { signalType: REPO_FOCUS_MANIFEST_SIGNAL, deleted: 1 },
      { signalType: REPO_PUBLIC_FOCUS_MANIFEST_SIGNAL, deleted: 1 },
    ]);
    expect(await countSignalSnapshots(env, REPO_FOCUS_MANIFEST_SIGNAL)).toBe(1);
    expect(await countSignalSnapshots(env, REPO_PUBLIC_FOCUS_MANIFEST_SIGNAL)).toBe(1);
    const rows = await env.DB.prepare("SELECT id FROM signal_snapshots ORDER BY signal_type, id").all<{ id: string }>();
    expect(rows.results.map((row) => row.id)).toEqual(["private-latest", "public-latest"]);
  });

  it("preserves bounded history for queue-health, the one signal type genuinely read as a historical series", async () => {
    const env = createTestEnv();
    await insertSignalSnapshot(env, "queue-old", "queue-health", "JSONbored/loopover", "2026-06-01T00:00:00.000Z");
    await insertSignalSnapshot(env, "queue-current", "queue-health", "JSONbored/loopover", "2026-06-02T00:00:00.000Z");

    expect(await dedupeSignalSnapshots(env)).toEqual([]);

    expect(await countSignalSnapshots(env, "queue-health")).toBe(2);
  });

  // #9435/#9459: contributor-decision-pack was previously excluded from LATEST_ONLY_SIGNAL_SNAPSHOT_TYPES on the
  // theory that it's a bounded trend series -- it isn't (src/services/decision-pack.ts reads only index [0],
  // the same latest-only contract as its contributor-* neighbors below) and it was, measured live, the single
  // largest contributor to the hosted D1 filling up: 6.3 GB across 18,549 rows, 71% of the whole database, still
  // entirely inside the 90-day age window and accumulating ~1,000 rows/day.
  it("dedupes contributor-decision-pack alongside its contributor-* neighbors (#9435/#9459)", async () => {
    const env = createTestEnv();
    await insertSignalSnapshot(env, "decision-prev", "contributor-decision-pack", "alice", "2026-06-01T00:00:00.000Z");
    await insertSignalSnapshot(env, "decision-current", "contributor-decision-pack", "alice", "2026-06-02T00:00:00.000Z");
    await insertSignalSnapshot(env, "decision-other-prev", "contributor-decision-pack", "bob", "2026-06-01T00:00:00.000Z");
    await insertSignalSnapshot(env, "decision-other-current", "contributor-decision-pack", "bob", "2026-06-02T00:00:00.000Z");

    const results = await dedupeSignalSnapshots(env);
    const byType = Object.fromEntries(results.map((r) => [r.signalType, r.deleted]));
    expect(byType["contributor-decision-pack"]).toBe(2);

    expect(await countSignalSnapshots(env, "contributor-decision-pack")).toBe(2);
    const rows = await env.DB.prepare("SELECT id FROM signal_snapshots WHERE signal_type = 'contributor-decision-pack' ORDER BY id").all<{ id: string }>();
    expect(rows.results.map((row) => row.id)).toEqual(["decision-current", "decision-other-current"]);
  });

  it("deletes across multiple batches per signal_type and stops at the per-type cap", async () => {
    const env = createTestEnv();
    for (let i = 0; i < 6; i++) {
      await insertSignalSnapshot(env, `s-${i}`, "repo-culture-profile", "JSONbored/loopover", `2026-06-0${i + 1}T00:00:00.000Z`);
    }
    // The 6th insert (highest generated_at, inserted last so it also has the highest rowid) is kept, leaving 5
    // duplicates; batchSize 2 forces multiple full (changes === batchSize) delete iterations before maxPerType 4
    // is reached, so the loop continues past its first batch instead of stopping there.
    const results = await dedupeSignalSnapshots(env, { batchSize: 2, maxPerType: 4 });
    expect(results).toEqual([{ signalType: "repo-culture-profile", deleted: 4 }]); // 2 + 2, then cap reached
    expect(await countSignalSnapshots(env, "repo-culture-profile")).toBe(2); // 1 kept + 1 duplicate left for the next run
  });

  it("dry-run falls back to 0 when the count query returns no row (defensive ?? 0 arm)", async () => {
    const noRowEnv = {
      DB: {
        prepare: (sql: string) => ({
          bind: (..._binds: unknown[]) =>
            sql.includes("DISTINCT signal_type")
              ? { all: async () => ({ results: [{ signal_type: "repo-culture-profile" }] }) }
              : { first: async () => undefined }, // count query returns no row → `row?.n ?? 0` fallback fires
        }),
      },
    } as unknown as Env;
    const results = await dedupeSignalSnapshots(noRowEnv, { dryRun: true });
    expect(results).toEqual([{ signalType: "repo-culture-profile", deleted: 0 }]);
  });

  it("falls back to 0 changes when a delete run() result lacks meta (defensive ?? 0 arm)", async () => {
    const noMetaEnv = {
      DB: {
        prepare: (sql: string) => ({
          bind: (..._binds: unknown[]) =>
            sql.includes("DISTINCT signal_type")
              ? { all: async () => ({ results: [{ signal_type: "repo-culture-profile" }] }) }
              : { run: async () => ({}) }, // no meta → `result.meta?.changes ?? 0` fallback fires, so changes = 0 < batchSize
        }),
      },
    } as unknown as Env;
    const results = await dedupeSignalSnapshots(noMetaEnv);
    expect(results).toEqual([{ signalType: "repo-culture-profile", deleted: 0 }]);
  });
});

describe("pruneExpiredRecords defensive ?? 0 arms (#8370)", () => {
  // Mirrors the sibling dedupeSignalSnapshots tests for the identical pattern: mock env.DB so the
  // row / meta shape is missing the field, and assert the fallback yields 0 rather than NaN or a throw.
  const RULE = [{ table: "audit_events", column: "created_at", days: 90 }] as const;

  it("dry-run falls back to 0 when the count query returns no row (line 75 arm)", async () => {
    const noRowEnv = {
      DB: {
        prepare: (_sql: string) => ({
          bind: (..._binds: unknown[]) => ({ first: async () => undefined }), // no row -> `row?.n ?? 0`
        }),
      },
    } as unknown as Env;

    const results = await pruneExpiredRecords(noRowEnv, { dryRun: true, nowMs: NOW, policy: RULE });
    expect(results).toHaveLength(1);
    expect(results[0]?.deleted).toBe(0);
    expect(Number.isNaN(results[0]?.deleted)).toBe(false); // Number(undefined) would be NaN without the ?? 0
  });

  it("dry-run falls back to 0 when the row is present but n is null (line 75 arm)", async () => {
    const nullCountEnv = {
      DB: {
        prepare: (_sql: string) => ({
          bind: (..._binds: unknown[]) => ({ first: async () => ({ n: null }) }), // nullish n -> same arm
        }),
      },
    } as unknown as Env;

    const results = await pruneExpiredRecords(nullCountEnv, { dryRun: true, nowMs: NOW, policy: RULE });
    expect(results[0]?.deleted).toBe(0);
  });

  it("falls back to 0 changes when a delete run() result lacks meta (line 85 arm)", async () => {
    const noMetaEnv = {
      DB: {
        prepare: (_sql: string) => ({
          // no meta -> `result.meta?.changes ?? 0` fires, so changes = 0 < batchSize and the loop exits.
          bind: (..._binds: unknown[]) => ({ run: async () => ({}) }),
        }),
      },
    } as unknown as Env;

    const results = await pruneExpiredRecords(noMetaEnv, { nowMs: NOW, policy: RULE, batchSize: 5 });
    expect(results).toHaveLength(1);
    expect(results[0]?.deleted).toBe(0);
    expect(Number.isNaN(results[0]?.deleted)).toBe(false);
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
    await insertSignalSnapshot(env, "s-1", "repo-culture-profile", "JSONbored/loopover", "2026-06-01T00:00:00.000Z");
    await insertSignalSnapshot(env, "s-2", "repo-culture-profile", "JSONbored/loopover", "2026-06-02T00:00:00.000Z");
    await processJob(env, { type: "prune-retention", requestedBy: "schedule" });
    expect(await countWebhook(env)).toBe(1);
    expect(await countSignalSnapshots(env, "repo-culture-profile")).toBe(1);
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
    await insertSignalSnapshot(env, "s-1", "repo-culture-profile", "JSONbored/loopover", "2026-06-01T00:00:00.000Z");
    await insertSignalSnapshot(env, "s-2", "repo-culture-profile", "JSONbored/loopover", "2026-06-02T00:00:00.000Z");
    const res = await app.request("/v1/internal/retention/preview", { headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalEligible: number;
      eligible: Array<{ table: string; deleted: number }>;
      totalSignalSnapshotDuplicates: number;
      signalSnapshotDuplicates: Array<{ signalType: string; deleted: number }>;
    };
    expect(body.totalEligible).toBeGreaterThanOrEqual(1);
    expect(body.eligible.find((r) => r.table === "webhook_events")?.deleted).toBe(2);
    expect(body.totalSignalSnapshotDuplicates).toBe(1);
    expect(body.signalSnapshotDuplicates).toEqual([{ signalType: "repo-culture-profile", deleted: 1 }]);
    expect(await countWebhook(env)).toBe(3); // preview is read-only
    expect(await countSignalSnapshots(env)).toBe(2); // preview is read-only
  });
});

// #9472 drift guard: #9415 added five tables to RETENTION_POLICY but shipped neither a RETENTION_PK_COLUMN
// entry nor an index migration for any of them, so every batched delete fell back to `rowid` (-> `ctid` on
// Postgres) and ran as a full sequential scan plus a full sort -- hourly, on the two largest tables in the
// database. Nothing caught it, because nothing asserted the three sites stay in step. These tests are that
// assertion: a future policy entry cannot ship without its PK mapping and its retention-column index.
describe("RETENTION_POLICY completeness (drift guard, #9472)", () => {
  it("every policy table is either PK-mapped or explicitly listed as composite-PK (never silently unmapped)", () => {
    // An absent entry used to mean either "composite PK, rowid fallback is correct" or "someone forgot" --
    // indistinguishable, which is how #9415's five shipped unmapped. Now it must be a deliberate choice.
    const unaccounted = RETENTION_POLICY.filter((rule) => !(rule.table in RETENTION_PK_COLUMN) && !RETENTION_COMPOSITE_PK_TABLES.has(rule.table)).map(
      (rule) => rule.table,
    );
    expect(unaccounted).toEqual([]);
  });

  it("no table claims both a single-column PK and a composite-PK exemption", () => {
    const both = Object.keys(RETENTION_PK_COLUMN).filter((table) => RETENTION_COMPOSITE_PK_TABLES.has(table));
    expect(both).toEqual([]);
  });

  it("every policy table has an index leading with its retention column somewhere in migrations/", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "migrations");
    const files = (await readdir(dir)).filter((name) => name.endsWith(".sql"));
    const sql = (await Promise.all(files.map((name) => readFile(join(dir, name), "utf8")))).join("\n").toLowerCase();
    // The index must LEAD with the retention column -- a trailing position cannot serve the ordered range
    // scan the batched delete performs (that was 0193's whole point).
    const missing = RETENTION_POLICY.filter((rule) => !sql.includes(`on ${rule.table}(${rule.column})`) && !sql.includes(`on ${rule.table} (${rule.column})`)).map(
      (rule) => `${rule.table}(${rule.column})`,
    );
    expect(missing).toEqual([]);
  });

  it("every RETENTION_PK_COLUMN entry names a table the policy actually prunes (no dead mappings)", () => {
    const policyTables = new Set(RETENTION_POLICY.map((rule) => rule.table));
    const orphaned = Object.keys(RETENTION_PK_COLUMN).filter((table) => !policyTables.has(table));
    expect(orphaned).toEqual([]);
  });
});

// #9470 regression: dedupe kept the row with the highest `rowid`, which pg-dialect rewrites to `ctid` -- a
// PHYSICAL heap location. Once the age-prune frees pages, a NEWER row inserted into a reclaimed early page
// gets a LOWER ctid than an older row on a later page, so MAX(ctid) selected a STALE snapshot and this delete
// removed the genuinely newest one. Confirmed live on production Postgres (2026-07-27): ~36% of multi-row
// keys for contributor-evidence-graph had ctid order disagreeing with recency, across ~344 keys of
// dedupe-eligible types, with the dedupe deleting thousands of rows per daily run.
//
// SQLite cannot reproduce ctid page reuse, so these tests pin the property that makes the bug impossible
// either way: the survivor is chosen by (generated_at, id), never by physical/insertion order. The row
// inserted LAST here is deliberately the OLDEST by generated_at -- under the old MAX(rowid) rule it would
// have survived and the newest would have been deleted.
describe("dedupeSignalSnapshots survivor selection (#9470)", () => {
  it("keeps the newest row by generated_at even when it was inserted FIRST", async () => {
    const env = createTestEnv();
    await insertSignalSnapshot(env, "s-newest", "repo-culture-profile", "JSONbored/loopover", "2026-06-13T00:00:00.000Z");
    await insertSignalSnapshot(env, "s-middle", "repo-culture-profile", "JSONbored/loopover", "2026-06-11T00:00:00.000Z");
    await insertSignalSnapshot(env, "s-oldest", "repo-culture-profile", "JSONbored/loopover", "2026-06-10T00:00:00.000Z");

    const results = await dedupeSignalSnapshots(env);

    expect(results).toEqual([{ signalType: "repo-culture-profile", deleted: 2 }]);
    const survivor = await env.DB.prepare("SELECT id FROM signal_snapshots WHERE signal_type = ?").bind("repo-culture-profile").first<{ id: string }>();
    expect(survivor?.id).toBe("s-newest");
  });

  it("breaks a generated_at tie deterministically on id, keeping exactly one row per key", async () => {
    // generated_at CAN tie (it was the original reason rowid was chosen); the id tiebreak restores the total
    // ordering without depending on physical layout.
    const env = createTestEnv();
    const tied = "2026-06-12T00:00:00.000Z";
    await insertSignalSnapshot(env, "s-aaa", "repo-culture-profile", "JSONbored/loopover", tied);
    await insertSignalSnapshot(env, "s-zzz", "repo-culture-profile", "JSONbored/loopover", tied);

    const results = await dedupeSignalSnapshots(env);

    expect(results).toEqual([{ signalType: "repo-culture-profile", deleted: 1 }]);
    const survivor = await env.DB.prepare("SELECT id FROM signal_snapshots WHERE signal_type = ?").bind("repo-culture-profile").first<{ id: string }>();
    expect(survivor?.id).toBe("s-zzz"); // highest id wins the tie
  });

  it("dedupes each target_key independently, keeping the newest row of every key", async () => {
    const env = createTestEnv();
    await insertSignalSnapshot(env, "a-new", "repo-culture-profile", "JSONbored/loopover", "2026-06-13T00:00:00.000Z");
    await insertSignalSnapshot(env, "a-old", "repo-culture-profile", "JSONbored/loopover", "2026-06-01T00:00:00.000Z");
    await insertSignalSnapshot(env, "b-new", "repo-culture-profile", "JSONbored/metagraphed", "2026-06-13T00:00:00.000Z");
    await insertSignalSnapshot(env, "b-old", "repo-culture-profile", "JSONbored/metagraphed", "2026-06-01T00:00:00.000Z");

    await dedupeSignalSnapshots(env);

    const rows = await env.DB.prepare("SELECT id FROM signal_snapshots WHERE signal_type = ? ORDER BY id").bind("repo-culture-profile").all<{ id: string }>();
    expect(rows.results.map((row) => row.id)).toEqual(["a-new", "b-new"]);
  });

  it("leaves a single-row key untouched (nothing to dedupe)", async () => {
    const env = createTestEnv();
    await insertSignalSnapshot(env, "only", "repo-culture-profile", "JSONbored/loopover", "2026-06-13T00:00:00.000Z");

    expect(await dedupeSignalSnapshots(env)).toEqual([{ signalType: "repo-culture-profile", deleted: 0 }]);
    expect(await countSignalSnapshots(env, "repo-culture-profile")).toBe(1);
  });
});

// #9474: orb_pr_outcomes feeds a CUMULATIVE public counter -- getOrbGlobalStats SUMs the whole table and
// public-stats folds it into the homepage's all-time merged/closed/handled totals. #9415's 90-day window,
// left alone, would have made those "all-time" numbers plateau and then visibly DECREASE (~2026-10-25). The
// prune now folds every row it deletes into the durable orb_outcome_rollups totals in the SAME transaction,
// and getOrbGlobalStats adds them back -- so retention never changes the meaning of a published number.
describe("orb_pr_outcomes fold-before-delete (#9474)", () => {
  const RULE = { table: "orb_pr_outcomes", column: "occurred_at", days: 90 } as (typeof RETENTION_POLICY)[number];
  const seedOutcomes = async (env: Env) => {
    await env.DB.prepare("INSERT INTO orb_github_installations (installation_id, account_login, registered) VALUES (1, 'acme', 1), (2, 'JSONbored', 1), (3, 'stranger', 0)").run();
    await env.DB.prepare(
      `INSERT INTO orb_pr_outcomes (repository_full_name, pr_number, installation_id, outcome, occurred_at) VALUES
        ('acme/widgets', 1, 1, 'merged', ?1),
        ('acme/widgets', 2, 1, 'closed', ?1),
        ('jsonbored/loopover', 3, 2, 'merged', ?1),
        ('stranger/repo', 4, 3, 'merged', ?1),
        ('acme/widgets', 5, 1, 'merged', ?2)`,
    )
      .bind(daysAgo(100), daysAgo(1))
      .run();
  };

  it("REGRESSION: the cumulative public total is IDENTICAL before and after the prune, and the aged raw rows are gone", async () => {
    const env = createTestEnv();
    await seedOutcomes(env);
    const before = await getOrbGlobalStats(env);
    expect(before).toEqual({ merged: 3, closed: 1, total: 4 }); // unregistered install 3 never counted

    const results = await pruneExpiredRecords(env, { nowMs: NOW, policy: [RULE] });

    expect(results[0]?.deleted).toBe(4); // ALL aged rows deleted, including the never-counted unregistered one
    const remaining = await env.DB.prepare("SELECT pr_number FROM orb_pr_outcomes").all<{ pr_number: number }>();
    expect(remaining.results.map((row) => row.pr_number)).toEqual([5]);
    expect(await getOrbGlobalStats(env)).toEqual(before);
  });

  it("INVARIANT: rows the live query never counted are deleted WITHOUT folding — an unregistered install and an own-ledger-published PR do not join the total on prune day", async () => {
    const env = createTestEnv();
    await seedOutcomes(env);
    // acme/widgets#1 was already counted by the own ledger (published surface): the live query excludes it,
    // so the fold must too -- otherwise the public total would JUMP by one the day retention runs.
    await env.DB.prepare(
      "INSERT INTO audit_events (id, event_type, target_key, outcome, created_at) VALUES ('evt-1', 'github_app.pr_public_surface_published', 'acme/widgets#1', 'success', ?)",
    )
      .bind(daysAgo(100))
      .run();
    const before = await getOrbGlobalStats(env);
    expect(before).toEqual({ merged: 2, closed: 1, total: 3 });

    await pruneExpiredRecords(env, { nowMs: NOW, policy: [RULE] });

    expect(await getOrbGlobalStats(env)).toEqual(before);
    const rollup = await env.DB.prepare("SELECT SUM(total) AS n FROM orb_outcome_rollups").first<{ n: number }>();
    expect(rollup?.n).toBe(2); // acme/widgets#2 + jsonbored/loopover#3; NOT the published #1, NOT the unregistered #4
  });

  it("INVARIANT: a second prune run does not double-count — the fold and delete are one transaction, so re-running folds nothing new", async () => {
    const env = createTestEnv();
    await seedOutcomes(env);
    const before = await getOrbGlobalStats(env);

    await pruneExpiredRecords(env, { nowMs: NOW, policy: [RULE] });
    const second = await pruneExpiredRecords(env, { nowMs: NOW, policy: [RULE] });

    expect(second[0]?.deleted).toBe(0);
    expect(await getOrbGlobalStats(env)).toEqual(before);
  });

  it("INVARIANT: excludeAccount still de-dups against FOLDED totals — the rollup keys on lowercased account_login", async () => {
    const env = createTestEnv();
    await seedOutcomes(env);
    const beforeExcluded = await getOrbGlobalStats(env, { excludeAccount: "jsonbored" });
    expect(beforeExcluded).toEqual({ merged: 2, closed: 1, total: 3 });

    await pruneExpiredRecords(env, { nowMs: NOW, policy: [RULE] });

    expect(await getOrbGlobalStats(env, { excludeAccount: "jsonbored" })).toEqual(beforeExcluded);
  });

  // Review feedback on #9532: the first revision deleted the whole aged cohort in ONE unbatched statement,
  // arguing the daily volume is small. True today, and exactly the argument that ages badly -- one fleet-wide
  // backfill makes it a multi-million-row statement, removing the batching safety net this file enforces for
  // every other table. Slices are bounded now, and each slice's fold+delete still commit together.
  it("REGRESSION: deletes in BOUNDED slices, not one unbatched statement — and the cumulative total is still exact", async () => {
    const env = createTestEnv();
    await env.DB.prepare("INSERT INTO orb_github_installations (installation_id, account_login, registered) VALUES (1, 'acme', 1)").run();
    // 25 aged rows with DISTINCT timestamps, so slicing has real boundaries to find.
    const values = Array.from({ length: 25 }, (_, i) => `('acme/widgets', ${i + 1}, 1, '${i % 2 === 0 ? "merged" : "closed"}', '${daysAgo(200 - i)}')`).join(",");
    await env.DB.prepare(`INSERT INTO orb_pr_outcomes (repository_full_name, pr_number, installation_id, outcome, occurred_at) VALUES ${values}`).run();
    const before = await getOrbGlobalStats(env);
    expect(before.total).toBe(25);

    const results = await pruneExpiredRecords(env, { nowMs: NOW, policy: [RULE], batchSize: 10 });

    expect(results[0]?.deleted).toBe(25); // every aged row removed, across multiple bounded slices
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM orb_pr_outcomes").first<{ n: number }>())?.n).toBe(0);
    expect(await getOrbGlobalStats(env)).toEqual(before); // the public counter is untouched by the slicing
  });

  it("INVARIANT: a run of rows sharing ONE timestamp still makes progress — the inclusive slice boundary cannot spin", async () => {
    // An exclusive `<` boundary against a tie run selects zero rows and loops forever. All 12 rows here share
    // one occurred_at, so the first slice's boundary IS that timestamp: inclusive is what guarantees progress.
    const env = createTestEnv();
    await env.DB.prepare("INSERT INTO orb_github_installations (installation_id, account_login, registered) VALUES (1, 'acme', 1)").run();
    const tied = daysAgo(150);
    const values = Array.from({ length: 12 }, (_, i) => `('acme/widgets', ${i + 1}, 1, 'merged', '${tied}')`).join(",");
    await env.DB.prepare(`INSERT INTO orb_pr_outcomes (repository_full_name, pr_number, installation_id, outcome, occurred_at) VALUES ${values}`).run();

    const results = await pruneExpiredRecords(env, { nowMs: NOW, policy: [RULE], batchSize: 5 });

    expect(results[0]?.deleted).toBe(12);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM orb_pr_outcomes").first<{ n: number }>())?.n).toBe(0);
    expect((await getOrbGlobalStats(env)).total).toBe(12); // all 12 folded exactly once, no double-count
  });

  it("INVARIANT: maxPerTable still caps one run, leaving the remainder (and its rollup) for the next", async () => {
    const env = createTestEnv();
    await env.DB.prepare("INSERT INTO orb_github_installations (installation_id, account_login, registered) VALUES (1, 'acme', 1)").run();
    const values = Array.from({ length: 20 }, (_, i) => `('acme/widgets', ${i + 1}, 1, 'merged', '${daysAgo(200 - i)}')`).join(",");
    await env.DB.prepare(`INSERT INTO orb_pr_outcomes (repository_full_name, pr_number, installation_id, outcome, occurred_at) VALUES ${values}`).run();

    const first = await pruneExpiredRecords(env, { nowMs: NOW, policy: [RULE], batchSize: 5, maxPerTable: 10 });
    expect(first[0]?.deleted).toBe(10);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM orb_pr_outcomes").first<{ n: number }>())?.n).toBe(10);
    // The cumulative total is exact at EVERY point, not only once the cohort is fully drained.
    expect((await getOrbGlobalStats(env)).total).toBe(20);

    const second = await pruneExpiredRecords(env, { nowMs: NOW, policy: [RULE], batchSize: 5, maxPerTable: 10 });
    expect(second[0]?.deleted).toBe(10);
    expect((await getOrbGlobalStats(env)).total).toBe(20);
  });

  it("INVARIANT: dryRun counts without folding or deleting", async () => {
    const env = createTestEnv();
    await seedOutcomes(env);

    const results = await pruneExpiredRecords(env, { dryRun: true, nowMs: NOW, policy: [RULE] });

    expect(results[0]?.deleted).toBe(4);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM orb_pr_outcomes").first<{ n: number }>())?.n).toBe(5);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM orb_outcome_rollups").first<{ n: number }>())?.n).toBe(0);
  });

  it("ORDERING GUARD: orb_pr_outcomes prunes BEFORE audit_events, so the fold's own-ledger exclusion still sees the audit rows it needs", () => {
    const tables = RETENTION_POLICY.map((rule) => rule.table);
    expect(tables.indexOf("orb_pr_outcomes")).toBeGreaterThanOrEqual(0);
    expect(tables.indexOf("orb_pr_outcomes")).toBeLessThan(tables.indexOf("audit_events"));
  });
});

// #9474: the exported cutoff helper is what lets a consumer reason about a table's IMPERMANENCE instead of
// silently assuming permanence -- verifyDecisionLedger keys its pruned-record tolerance on it, so the two can
// never drift apart the way the retention rule and the verifier originally did.
describe("retentionCutoffIsoForTable (#9474)", () => {
  it("returns the policy cutoff for a covered table and null for a table with no rule", () => {
    const cutoff = retentionCutoffIsoForTable("decision_records", NOW);
    expect(cutoff).toBe(daysAgo(180)); // the published decision_records window, not a second hand-typed copy
    expect(retentionCutoffIsoForTable("decision_ledger", NOW)).toBeNull(); // ledger rows are kept forever
    expect(retentionCutoffIsoForTable("no_such_table", NOW)).toBeNull();
  });

  it("defaults to the current clock when nowMs is omitted", () => {
    const cutoff = retentionCutoffIsoForTable("decision_records");
    expect(cutoff).not.toBeNull();
    // Within a second of a locally computed 180-day cutoff -- pins the default-arg arm without clock flake.
    expect(Math.abs(Date.parse(cutoff!) - (Date.now() - 180 * 86_400_000))).toBeLessThan(1000);
  });
});
