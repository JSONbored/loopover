import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createD1Adapter, nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { bucketReasonCode, exportOrbBatch, getOrCreateAnonSecret } from "../../src/selfhost/orb-collector";
import { resetMetrics, renderMetrics } from "../../src/selfhost/metrics";

/** In-memory DB with the review_audit + orb_export_cursor tables the exporter reads. `withAuditEvents:
 *  false` drops the reuse-counter source table to prove the counter read fails SAFE (export still runs). */
function makeDb(options: { withAuditEvents?: boolean } = {}): D1Database {
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
      last_exported_target_id TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE system_flags (
      key TEXT PRIMARY KEY, value TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);
  if (options.withAuditEvents !== false) {
    driver.exec(`
      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, target_key TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );
    `);
  }
  return createD1Adapter(driver);
}

async function cacheEvent(db: D1Database, eventType: string, at: string): Promise<void> {
  await db.prepare(`INSERT INTO audit_events (event_type, target_key, created_at) VALUES (?, 'o/r#1', ?)`).bind(eventType, at).run();
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
    // #8825: an enforcement close buckets as policy_action, and the prefix wins over the substring rules
    // below it -- `policy_close:linked-issue-hard-rule` must NOT flatten into plain issue_policy.
    expect(bucketReasonCode("policy_close:contributor_cap")).toBe("policy_action");
    expect(bucketReasonCode("policy_close:linked-issue-hard-rule")).toBe("policy_action");
    expect(bucketReasonCode("policy_close:blacklist")).toBe("policy_action");
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
    for (const k of ["GITHUB_APP_PRIVATE_KEY", "ORB_APP_ID", "ORB_ANONYMIZE", "ORB_AIR_GAP", "ORB_COLLECTOR_URL", "ORB_COLLECTOR_TOKEN", "GITHUB_APP_ID", "ORB_ENROLLMENT_SECRET"]) delete (process.env as NodeJS.Dict<string>)[k];
  });

  it("returns 0 when the App private key is not configured (App not set up → nothing to export)", async () => {
    delete (process.env as NodeJS.Dict<string>).GITHUB_APP_PRIVATE_KEY;
    const db = makeDb();
    await audit(db, "o/r", 1, "gate_decision", "merge", "2026-01-01T00:00:00Z");
    await audit(db, "o/r", 1, "pr_outcome", "merged", "2026-01-01T01:00:00Z");
    expect(await exportOrbBatch(db, 200, async () => new Response(null, { status: 200 }))).toBe(0);
  });

  it("returns 0 in air-gap mode (self-managed instance)", async () => {
    process.env.ORB_AIR_GAP = "true";
    expect(await exportOrbBatch(makeDb(), 200, async () => new Response(null, { status: 200 }))).toBe(0);
  });

  it("returns 0 in air-gap mode even when brokered and no local App key is configured", async () => {
    delete (process.env as NodeJS.Dict<string>).GITHUB_APP_PRIVATE_KEY;
    delete (process.env as NodeJS.Dict<string>).ORB_APP_ID;
    process.env.ORB_AIR_GAP = "true";
    process.env.ORB_ENROLLMENT_SECRET = "orbsec_test_enrollment";
    const db = makeDb();
    await audit(db, "owner/repo", 9, "gate_decision", "merge", "2026-03-01T00:00:00Z");
    await audit(db, "owner/repo", 9, "pr_outcome", "merged", "2026-03-01T01:00:00Z");
    let called = false;
    const n = await exportOrbBatch(db, 200, async () => { called = true; return new Response(null, { status: 200 }); });
    expect(n).toBe(0);
    expect(called).toBe(false);
  });

  it("brokered mode exports without a local App key when air-gap is off", async () => {
    delete (process.env as NodeJS.Dict<string>).GITHUB_APP_PRIVATE_KEY;
    delete (process.env as NodeJS.Dict<string>).ORB_APP_ID;
    process.env.ORB_ENROLLMENT_SECRET = "orbsec_test_enrollment";
    const db = makeDb();
    await audit(db, "owner/repo", 9, "gate_decision", "merge", "2026-03-01T00:00:00Z");
    await audit(db, "owner/repo", 9, "pr_outcome", "merged", "2026-03-01T01:00:00Z");
    let captured: { instance_id: string } | undefined;
    const n = await exportOrbBatch(db, 200, async (_u, init) => { captured = JSON.parse(init!.body as string); return new Response(null, { status: 200 }); });
    expect(n).toBe(1);
    expect(captured!.instance_id).toMatch(/^[a-f0-9]{16}$/);
    expect(captured!.instance_id).not.toBe("6f2608643da1e0cf");
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

  it("flags reversal_superseded (#8820) — and an explicit reopen outranks the successor heuristic", async () => {
    const db = makeDb();
    // The one-shot culture's dominant reversal shape (#8166): bot-closed PR whose work merged via a successor.
    await audit(db, "o/r", 3, "gate_decision", "close", "2026-02-01T00:00:00Z");
    await audit(db, "o/r", 3, "pr_outcome", "closed", "2026-02-01T01:00:00Z");
    await audit(db, "o/r", 3, "reversal_superseded", null, "2026-02-01T04:00:00Z");
    // Both signals present → the stronger explicit reopen wins the single exported flag.
    await audit(db, "o/r", 4, "gate_decision", "close", "2026-02-01T00:00:00Z");
    await audit(db, "o/r", 4, "pr_outcome", "closed", "2026-02-01T01:30:00Z");
    await audit(db, "o/r", 4, "reversal_reopened", null, "2026-02-01T02:00:00Z");
    await audit(db, "o/r", 4, "reversal_superseded", null, "2026-02-01T03:00:00Z");
    let captured: { events: Array<{ reversal_flag: string }> } | undefined;
    await exportOrbBatch(db, 200, async (_u, init) => { captured = JSON.parse(init!.body as string); return new Response(null, { status: 200 }); });
    expect(captured!.events.map((e) => e.reversal_flag).sort()).toEqual(["reopened", "superseded"]);
  });

  it("ships day-bucketed reuse counters alongside the outcome events (#8820), bounded to the rolling window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-10T12:00:00Z"));
    try {
      const db = makeDb();
      await audit(db, "o/r", 1, "gate_decision", "merge", "2026-02-01T00:00:00Z");
      await audit(db, "o/r", 1, "pr_outcome", "merged", "2026-02-01T01:00:00Z");
      await cacheEvent(db, "github_app.grounding_cache_hit", "2026-02-01T02:00:00Z");
      await cacheEvent(db, "github_app.review_memory_cache_hit", "2026-02-01T03:00:00Z");
      await cacheEvent(db, "github_app.impact_map_cache_miss", "2026-02-01T04:00:00Z");
      await cacheEvent(db, "github_app.ai_review_frozen_reuse", "2026-02-02T00:00:00Z"); // non-suffix reuse variant = hit
      await cacheEvent(db, "github_app.grounding_cache_hit", "2020-01-01T00:00:00Z"); // far outside the window
      let captured: { reuse_counters?: Array<{ day: string; hits: number; misses: number }> } | undefined;
      await exportOrbBatch(db, 200, async (_u, init) => { captured = JSON.parse(init!.body as string); return new Response(null, { status: 200 }); });
      expect(captured!.reuse_counters).toEqual([
        { day: "2026-02-01", hits: 2, misses: 1 },
        { day: "2026-02-02", hits: 1, misses: 0 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits reuse_counters when the window has none — and a missing audit_events table fails SAFE (#8820)", async () => {
    // No cache events at all → the field is absent, not an empty array.
    const clean = makeDb();
    await audit(clean, "o/r", 1, "gate_decision", "merge", "2026-02-01T00:00:00Z");
    await audit(clean, "o/r", 1, "pr_outcome", "merged", "2026-02-01T01:00:00Z");
    let captured: Record<string, unknown> | undefined;
    await exportOrbBatch(clean, 200, async (_u, init) => { captured = JSON.parse(init!.body as string); return new Response(null, { status: 200 }); });
    expect("reuse_counters" in captured!).toBe(false);
    // A deployment whose ledger lacks the table entirely: the counter read degrades to none — the outcome
    // export riding the same tick still succeeds.
    const bare = makeDb({ withAuditEvents: false });
    await audit(bare, "o/r", 2, "gate_decision", "merge", "2026-02-01T00:00:00Z");
    await audit(bare, "o/r", 2, "pr_outcome", "merged", "2026-02-01T01:00:00Z");
    captured = undefined;
    expect(await exportOrbBatch(bare, 200, async (_u, init) => { captured = JSON.parse(init!.body as string); return new Response(null, { status: 200 }); })).toBe(1);
    expect("reuse_counters" in captured!).toBe(false);
  });

  it("REGRESSION (#8820): a reversal recorded AFTER a PR was already exported re-exports that PR with the flag", async () => {
    const db = makeDb();
    await audit(db, "o/r", 5, "gate_decision", "close", "2026-02-01T00:00:00Z");
    await audit(db, "o/r", 5, "pr_outcome", "closed", "2026-02-01T01:00:00Z");
    const bodies: Array<{ events: Array<{ reversal_flag: string }> }> = [];
    const capture = async (_u: RequestInfo | URL, init?: RequestInit) => { bodies.push(JSON.parse(init!.body as string)); return new Response(null, { status: 200 }); };
    expect(await exportOrbBatch(db, 200, capture)).toBe(1); // exported clean, cursor advanced past outcome_at
    expect(bodies[0]!.events[0]!.reversal_flag).toBe("none");
    // The successor merge lands LATER — event_at bumps to rev_at, past the cursor, so the row re-exports.
    await audit(db, "o/r", 5, "reversal_superseded", null, "2026-02-01T06:00:00Z");
    expect(await exportOrbBatch(db, 200, capture)).toBe(1);
    expect(bodies[1]!.events[0]!.reversal_flag).toBe("superseded");
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
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await exportOrbBatch(db, 200, async () => new Response(null, { status: 503 }))).toBe(0);
    expect(await renderMetrics()).toContain("loopover_orb_export_errors_total");
    // REGRESSION: was silent beyond the counter -- now logs a structured error so a failing export tick reaches
    // Sentry/Loki instead of being indistinguishable from "nothing new to export" in either tool.
    const logged = errors.mock.calls.map((c) => String(c[0])).find((line) => line.includes("orb_export_failed"));
    expect(logged).toBeDefined();
    expect(JSON.parse(logged!)).toMatchObject({ level: "error", event: "orb_export_failed", status: 503 });
    errors.mockRestore();
  });

  it("returns 0 + increments error counter when the collector is unreachable", async () => {
    const db = makeDb();
    await audit(db, "o/r", 1, "gate_decision", "merge", "2026-01-01T00:00:00Z");
    await audit(db, "o/r", 1, "pr_outcome", "merged", "2026-01-01T01:00:00Z");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await exportOrbBatch(db, 200, async () => { throw new Error("ECONNREFUSED"); })).toBe(0);
    expect(await renderMetrics()).toContain("loopover_orb_export_errors_total");
    const logged = errors.mock.calls.map((c) => String(c[0])).find((line) => line.includes("orb_export_failed"));
    expect(logged).toBeDefined();
    expect(JSON.parse(logged!)).toMatchObject({ level: "error", event: "orb_export_failed", message: "Error: ECONNREFUSED" });
    errors.mockRestore();
  });

  it("REGRESSION: the export POST carries a bounded timeout, so a wedged collector connection cannot hang the hourly tick forever", async () => {
    const db = makeDb();
    await audit(db, "o/r", 1, "gate_decision", "merge", "2026-01-01T00:00:00Z");
    await audit(db, "o/r", 1, "pr_outcome", "merged", "2026-01-01T01:00:00Z");
    let seenSignal: AbortSignal | undefined;
    await exportOrbBatch(db, 200, async (_url, init) => {
      seenSignal = init?.signal ?? undefined;
      return new Response(null, { status: 200 });
    });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
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

  it("exports every PR sharing the same event_at across batched runs (composite cursor tie-break)", async () => {
    const db = makeDb();
    const at = "2026-06-01T02:00:00Z";
    for (let pr = 1; pr <= 5; pr++) {
      await audit(db, "o/r", pr, "gate_decision", "merge", "2026-06-01T00:00:00Z");
      await audit(db, "o/r", pr, "pr_outcome", "merged", at);
    }
    const fetchOk = async () => new Response(null, { status: 200 });
    expect(await exportOrbBatch(db, 2, fetchOk)).toBe(2);
    expect(await exportOrbBatch(db, 2, fetchOk)).toBe(2);
    expect(await exportOrbBatch(db, 2, fetchOk)).toBe(1);
    expect(await exportOrbBatch(db, 2, fetchOk)).toBe(0);
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

  describe("health ping (#4933)", () => {
    it("does NOT call the collector when healthOk is undefined and there's nothing new (unchanged pre-#4933 behavior)", async () => {
      const db = makeDb();
      let called = false;
      const n = await exportOrbBatch(db, 200, async () => { called = true; return new Response(null, { status: 200 }); });
      expect(n).toBe(0);
      expect(called).toBe(false);
    });

    it("sends a health-only ping (events: []) when healthOk is provided and there's nothing new to export", async () => {
      const db = makeDb();
      let captured: { events: unknown[]; health?: { ok: boolean } } | undefined;
      const n = await exportOrbBatch(db, 200, async (_u, init) => { captured = JSON.parse(init!.body as string); return new Response(null, { status: 200 }); }, true);
      expect(n).toBe(0); // no outcome events exported
      expect(captured).toEqual({ instance_id: expect.any(String), events: [], health: { ok: true } });
    });

    it("reports healthOk === false", async () => {
      const db = makeDb();
      let captured: { health?: { ok: boolean } } | undefined;
      await exportOrbBatch(db, 200, async (_u, init) => { captured = JSON.parse(init!.body as string); return new Response(null, { status: 200 }); }, false);
      expect(captured!.health).toEqual({ ok: false });
    });

    it("includes the health field ALONGSIDE real outcome events in the same tick", async () => {
      const db = makeDb();
      await audit(db, "owner/repo", 3, "gate_decision", "merge", "2026-01-01T00:00:00Z");
      await audit(db, "owner/repo", 3, "pr_outcome", "merged", "2026-01-01T01:00:00Z");
      let captured: { events: unknown[]; health?: { ok: boolean } } | undefined;
      const n = await exportOrbBatch(db, 200, async (_u, init) => { captured = JSON.parse(init!.body as string); return new Response(null, { status: 200 }); }, true);
      expect(n).toBe(1);
      expect(captured!.events).toHaveLength(1);
      expect(captured!.health).toEqual({ ok: true });
    });

    it("still gates on air-gap/App-configured BEFORE ever considering healthOk", async () => {
      process.env.ORB_AIR_GAP = "true";
      let called = false;
      const n = await exportOrbBatch(makeDb(), 200, async () => { called = true; return new Response(null, { status: 200 }); }, true);
      expect(n).toBe(0);
      expect(called).toBe(false);
    });

    it("a health-only ping does not advance the export cursor (nothing new was actually exported)", async () => {
      const db = makeDb();
      await exportOrbBatch(db, 200, async () => new Response(null, { status: 200 }), true);
      const cursor = await db.prepare("SELECT COUNT(*) AS n FROM orb_export_cursor").first<{ n: number }>();
      expect(cursor?.n).toBe(0);
    });
  });
});
