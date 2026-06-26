import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createD1Adapter, nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { bucketReasonCode, exportOrbBatch, getOrCreateAnonSecret } from "../../src/selfhost/orb-collector";
import { resetMetrics, renderMetrics } from "../../src/selfhost/metrics";

/** In-memory DB with the review_audit + orb_export_cursor tables the exporter reads. */
function makeDb(): D1Database {
  const driver = nodeSqliteDriver(new DatabaseSync(":memory:") as never);
  driver.exec(`
    CREATE TABLE review_audit (
      id TEXT PRIMARY KEY NOT NULL, project TEXT NOT NULL, target_id TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'gate_decision', decision TEXT,
      source TEXT NOT NULL DEFAULT 'gittensory-native', head_sha TEXT, summary TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE orb_export_cursor (
      instance_hash TEXT PRIMARY KEY, last_exported_at TEXT NOT NULL DEFAULT '2000-01-01T00:00:00Z',
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE system_flags (
      key TEXT PRIMARY KEY, value TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);
  return createD1Adapter(driver);
}

let seq = 0;
async function audit(db: D1Database, project: string, pr: number, eventType: string, decision: string | null, at: string, summary: string | null = null): Promise<void> {
  await db
    .prepare(`INSERT INTO review_audit (id, project, target_id, event_type, decision, source, summary, created_at) VALUES (?, ?, ?, ?, ?, 'gittensory-native', ?, ?)`)
    .bind(`r${seq++}`, project, `${project}#${pr}`, eventType, decision, summary, at)
    .run();
}

describe("bucketReasonCode()", () => {
  it("maps each reason family to a fixed low-cardinality bucket", () => {
    expect(bucketReasonCode(null)).toBe("none");
    expect(bucketReasonCode("")).toBe("none");
    expect(bucketReasonCode("missing_linked_issue")).toBe("issue_policy");
    expect(bucketReasonCode("duplicate_pr_risk")).toBe("duplicate_risk");
    expect(bucketReasonCode("ai_slop_advisory")).toBe("slop_advisory");
    expect(bucketReasonCode("ai_consensus_defect")).toBe("ai_quality");
    expect(bucketReasonCode("self_authored_with_maintainer_cut")).toBe("author_policy");
    expect(bucketReasonCode("ci_state failing")).toBe("ci_readiness");
    expect(bucketReasonCode("something_unmapped")).toBe("other");
  });
});

describe("getOrCreateAnonSecret()", () => {
  it("generates a 256-bit (64 hex char) dedicated secret on first use and persists it", async () => {
    const db = makeDb();
    const secret = await getOrCreateAnonSecret(db);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const row = await db.prepare(`SELECT value FROM system_flags WHERE key = 'orb:anon_secret'`).first<{ value: string }>();
    expect(row?.value).toBe(secret); // persisted, so it survives restarts
  });

  it("reuses the persisted secret on subsequent calls (stable → collector dedup holds)", async () => {
    const db = makeDb();
    const first = await getOrCreateAnonSecret(db);
    const second = await getOrCreateAnonSecret(db);
    expect(second).toBe(first);
    expect(first).not.toBe(process.env.GITHUB_APP_PRIVATE_KEY); // never the App private key
  });
});

describe("exportOrbBatch() — always-on; reads review_audit, ships anonymized reversal-aware signal", () => {
  beforeEach(() => {
    resetMetrics();
    (process.env as NodeJS.Dict<string>).GITHUB_APP_PRIVATE_KEY = "test-private-key"; // gates export (App configured); not the anon key
    process.env.ORB_APP_ID = "555";
    process.env.ORB_ANONYMIZE = "true";
    delete process.env.ORB_AIR_GAP;
    delete process.env.ORB_COLLECTOR_URL;
    delete process.env.ORB_COLLECTOR_TOKEN;
  });
  afterEach(() => {
    for (const k of ["GITHUB_APP_PRIVATE_KEY", "ORB_APP_ID", "ORB_ANONYMIZE", "ORB_AIR_GAP", "ORB_COLLECTOR_URL", "ORB_COLLECTOR_TOKEN", "GITHUB_APP_ID"]) delete (process.env as NodeJS.Dict<string>)[k];
  });

  it("returns 0 when the App private key is not configured (App not set up → nothing to export)", async () => {
    delete (process.env as NodeJS.Dict<string>).GITHUB_APP_PRIVATE_KEY;
    const db = makeDb();
    await audit(db, "o/r", 1, "gate_decision", "merge", "2026-01-01T00:00:00Z");
    await audit(db, "o/r", 1, "pr_outcome", "merged", "2026-01-01T01:00:00Z");
    expect(await exportOrbBatch(db, 200, async () => new Response(null, { status: 200 }))).toBe(0);
  });

  it("returns 0 in air-gap mode", async () => {
    process.env.ORB_AIR_GAP = "true";
    expect(await exportOrbBatch(makeDb(), 200, async () => new Response(null, { status: 200 }))).toBe(0);
  });

  it("returns 0 when nothing is resolved", async () => {
    const db = makeDb();
    await audit(db, "o/r", 1, "gate_decision", "merge", "2026-01-01T00:00:00Z"); // decision but no outcome
    expect(await exportOrbBatch(db, 200, async () => new Response(null, { status: 200 }))).toBe(0);
  });

  it("exports a resolved PR with verdict, outcome, bucket, cycle-time; advances the cursor", async () => {
    const db = makeDb();
    await audit(db, "owner/repo", 7, "gate_decision", "merge", "2026-01-01T00:00:00Z", "duplicate_pr_risk");
    await audit(db, "owner/repo", 7, "pr_outcome", "merged", "2026-01-01T01:00:00Z");

    let captured: { instance_id: string; events: Array<Record<string, unknown>> } | undefined;
    const n = await exportOrbBatch(db, 200, async (_u, init) => { captured = JSON.parse(init!.body as string); return new Response(null, { status: 200 }); });
    expect(n).toBe(1);
    const ev = captured!.events[0]!;
    expect(ev.gate_verdict).toBe("merge");
    expect(ev.outcome).toBe("merged");
    expect(ev.reversal_flag).toBe("none");
    expect(ev.gate_reasoncode_bucket).toBe("duplicate_risk");
    expect(ev.time_to_close_ms).toBe(3_600_000); // 1h
    expect(ev.repo_hash).not.toBe("owner/repo"); // anonymized
    expect((ev.repo_hash as string)).toHaveLength(24);
    // cursor advanced → a second run exports nothing new
    expect(await exportOrbBatch(db, 200, async () => new Response(null, { status: 200 }))).toBe(0);
  });

  it("flags reversal_reverted and reversal_reopened", async () => {
    const db = makeDb();
    await audit(db, "o/r", 1, "gate_decision", "merge", "2026-02-01T00:00:00Z");
    await audit(db, "o/r", 1, "pr_outcome", "merged", "2026-02-01T01:00:00Z");
    await audit(db, "o/r", 1, "reversal_reverted", null, "2026-02-01T05:00:00Z");
    await audit(db, "o/r", 2, "gate_decision", "close", "2026-02-01T00:00:00Z");
    await audit(db, "o/r", 2, "pr_outcome", "merged", "2026-02-01T02:00:00Z");
    await audit(db, "o/r", 2, "reversal_reopened", null, "2026-02-01T03:00:00Z");
    let captured: { events: Array<{ reversal_flag: string }> } | undefined;
    await exportOrbBatch(db, 200, async (_u, init) => { captured = JSON.parse(init!.body as string); return new Response(null, { status: 200 }); });
    const flags = captured!.events.map((e) => e.reversal_flag).sort();
    expect(flags).toEqual(["reopened", "reverted"]);
  });

  it("sends raw repo when ORB_ANONYMIZE=false", async () => {
    process.env.ORB_ANONYMIZE = "false";
    const db = makeDb();
    await audit(db, "owner/repo", 1, "gate_decision", "close", "2026-01-01T00:00:00Z");
    await audit(db, "owner/repo", 1, "pr_outcome", "closed", "2026-01-01T00:30:00Z");
    let captured: { events: Array<{ repo_hash: string }> } | undefined;
    await exportOrbBatch(db, 200, async (_u, init) => { captured = JSON.parse(init!.body as string); return new Response(null, { status: 200 }); });
    expect(captured!.events[0]!.repo_hash).toBe("owner/repo");
  });

  it("null cycle-time when the resolution precedes the decision (negative delta)", async () => {
    const db = makeDb();
    await audit(db, "o/r", 1, "gate_decision", "merge", "2026-01-02T00:00:00Z");
    await audit(db, "o/r", 1, "pr_outcome", "merged", "2026-01-01T00:00:00Z"); // outcome BEFORE decision → negative → null
    let captured: { events: Array<{ time_to_close_ms: number | null }> } | undefined;
    await exportOrbBatch(db, 200, async (_u, init) => { captured = JSON.parse(init!.body as string); return new Response(null, { status: 200 }); });
    expect(captured!.events[0]!.time_to_close_ms).toBeNull();
  });

  it("returns 0 + increments error counter on a non-OK collector response", async () => {
    const db = makeDb();
    await audit(db, "o/r", 1, "gate_decision", "merge", "2026-01-01T00:00:00Z");
    await audit(db, "o/r", 1, "pr_outcome", "merged", "2026-01-01T01:00:00Z");
    expect(await exportOrbBatch(db, 200, async () => new Response(null, { status: 503 }))).toBe(0);
    expect(await renderMetrics()).toContain("gittensory_orb_export_errors_total");
  });

  it("returns 0 + increments error counter when the collector is unreachable", async () => {
    const db = makeDb();
    await audit(db, "o/r", 1, "gate_decision", "merge", "2026-01-01T00:00:00Z");
    await audit(db, "o/r", 1, "pr_outcome", "merged", "2026-01-01T01:00:00Z");
    expect(await exportOrbBatch(db, 200, async () => { throw new Error("ECONNREFUSED"); })).toBe(0);
    expect(await renderMetrics()).toContain("gittensory_orb_export_errors_total");
  });

  it("signs the batch and respects batchSize", async () => {
    const db = makeDb();
    for (let i = 1; i <= 5; i++) {
      await audit(db, "o/r", i, "gate_decision", "merge", `2026-03-0${i}T00:00:00Z`);
      await audit(db, "o/r", i, "pr_outcome", "merged", `2026-03-0${i}T01:00:00Z`);
    }
    process.env.ORB_COLLECTOR_TOKEN = "collector-secret";
    let headers: Record<string, string> | undefined;
    const n = await exportOrbBatch(db, 3, async (_u, init) => { headers = init!.headers as Record<string, string>; return new Response(null, { status: 200 }); });
    expect(n).toBe(3); // batch cap
    expect(headers?.["x-orb-signature"]).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(headers?.authorization).toBe("Bearer collector-secret");
  });

  it("falls back to GITHUB_APP_ID for the instance id and applies the anonymize default when ORB_* are unset", async () => {
    delete process.env.ORB_APP_ID; // → falls through to GITHUB_APP_ID
    delete process.env.ORB_ANONYMIZE; // → defaults to "true"
    (process.env as NodeJS.Dict<string>).GITHUB_APP_ID = "999";
    const db = makeDb();
    await audit(db, "owner/repo", 1, "gate_decision", "merge", "2026-01-01T00:00:00Z");
    await audit(db, "owner/repo", 1, "pr_outcome", "merged", "2026-01-01T01:00:00Z");
    let captured: { events: Array<{ repo_hash: string }> } | undefined;
    const n = await exportOrbBatch(db, 200, async (_u, init) => { captured = JSON.parse(init!.body as string); return new Response(null, { status: 200 }); });
    expect(n).toBe(1);
    expect(captured!.events[0]!.repo_hash).not.toBe("owner/repo"); // anonymize default = true
  });

  it("uses an 'unknown' instance id when neither ORB_APP_ID nor GITHUB_APP_ID is set", async () => {
    delete process.env.ORB_APP_ID;
    delete (process.env as NodeJS.Dict<string>).GITHUB_APP_ID;
    const db = makeDb();
    await audit(db, "o/r", 1, "gate_decision", "merge", "2026-01-01T00:00:00Z");
    await audit(db, "o/r", 1, "pr_outcome", "merged", "2026-01-01T01:00:00Z");
    let header: string | undefined;
    await exportOrbBatch(db, 200, async (_u, init) => { header = (init!.headers as Record<string, string>)["x-orb-instance"]; return new Response(null, { status: 200 }); });
    expect(header).toMatch(/^[a-f0-9]{16}$/);
  });
});
