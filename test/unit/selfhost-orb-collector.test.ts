import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createD1Adapter, nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { exportOrbBatch, orbEnabled, recordOrbEvent } from "../../src/selfhost/orb-collector";
import { resetMetrics, renderMetrics } from "../../src/selfhost/metrics";

/** Spin up an in-memory SQLite DB with the orb_events table (and the _selfhost_migrations
 *  stub so the adapter resolves without running all 56 migrations). */
function makeDb(): D1Database {
  const raw = new DatabaseSync(":memory:") as never;
  const driver = nodeSqliteDriver(raw);
  driver.exec(`
    CREATE TABLE orb_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('merged', 'closed')),
      gate_verdict TEXT,
      time_to_close_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      exported_at TEXT,
      UNIQUE (repo, pr_number, head_sha)
    );
    CREATE INDEX orb_events_repo_pr ON orb_events (repo, pr_number);
    CREATE INDEX orb_events_export_pending ON orb_events (exported_at) WHERE exported_at IS NULL;
  `);
  return createD1Adapter(driver);
}

async function countRows(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM orb_events").first<{ n: number }>();
  return r?.n ?? 0;
}

async function allRows(db: D1Database) {
  return (await db.prepare("SELECT * FROM orb_events").all()).results;
}

describe("orbEnabled()", () => {
  afterEach(() => { delete process.env.ORB_ENABLED; });

  it("returns false when ORB_ENABLED is unset (default off)", () => {
    delete process.env.ORB_ENABLED;
    expect(orbEnabled()).toBe(false);
  });

  it("returns true for 'true', '1', 'yes' (case-insensitive)", () => {
    for (const v of ["true", "True", "TRUE", "1", "yes", "Yes"]) {
      process.env.ORB_ENABLED = v;
      expect(orbEnabled()).toBe(true);
    }
  });

  it("returns false for empty string and 'false'", () => {
    for (const v of ["", "false", "0", "no"]) {
      process.env.ORB_ENABLED = v;
      expect(orbEnabled()).toBe(false);
    }
  });
});

describe("recordOrbEvent()", () => {
  beforeEach(() => { resetMetrics(); process.env.ORB_ENABLED = "true"; });
  afterEach(() => { delete process.env.ORB_ENABLED; });

  it("inserts an event with all fields when ORB_ENABLED=true", async () => {
    const db = makeDb();
    await recordOrbEvent(db, { repo: "owner/repo", pr_number: 42, head_sha: "abc123", outcome: "merged", gate_verdict: "approve", time_to_close_ms: 3600000 });
    expect(await countRows(db)).toBe(1);
    const [row] = (await allRows(db)) as Array<Record<string, unknown>>;
    expect(row?.repo).toBe("owner/repo");
    expect(row?.pr_number).toBe(42);
    expect(row?.outcome).toBe("merged");
    expect(row?.gate_verdict).toBe("approve");
    expect(row?.time_to_close_ms).toBe(3600000);
    expect(row?.exported_at).toBeNull();
  });

  it("inserts with null gate_verdict and time_to_close_ms when omitted", async () => {
    const db = makeDb();
    await recordOrbEvent(db, { repo: "o/r", pr_number: 1, head_sha: "sha", outcome: "closed" });
    const [row] = (await allRows(db)) as Array<Record<string, unknown>>;
    expect(row?.gate_verdict).toBeNull();
    expect(row?.time_to_close_ms).toBeNull();
  });

  it("is idempotent — INSERT OR IGNORE prevents duplicates for the same (repo, pr, sha)", async () => {
    const db = makeDb();
    await recordOrbEvent(db, { repo: "o/r", pr_number: 1, head_sha: "sha1", outcome: "merged" });
    await recordOrbEvent(db, { repo: "o/r", pr_number: 1, head_sha: "sha1", outcome: "merged" });
    expect(await countRows(db)).toBe(1);
  });

  it("increments gittensory_orb_events_recorded_total on each successful insert", async () => {
    const db = makeDb();
    await recordOrbEvent(db, { repo: "o/r", pr_number: 1, head_sha: "sha1", outcome: "merged" });
    await recordOrbEvent(db, { repo: "o/r", pr_number: 2, head_sha: "sha2", outcome: "closed" });
    expect(await renderMetrics()).toMatch(/gittensory_orb_events_recorded_total 2/);
  });

  it("does nothing when ORB_ENABLED=false", async () => {
    process.env.ORB_ENABLED = "false";
    const db = makeDb();
    await recordOrbEvent(db, { repo: "o/r", pr_number: 99, head_sha: "sha", outcome: "merged" });
    expect(await countRows(db)).toBe(0);
  });

  it("swallows DB errors and never throws (best-effort)", async () => {
    const brokenDb = { prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error("disk full")) }) }) } as unknown as D1Database;
    await expect(recordOrbEvent(brokenDb, { repo: "o/r", pr_number: 1, head_sha: "sha", outcome: "merged" })).resolves.not.toThrow();
  });
});

describe("exportOrbBatch()", () => {
  beforeEach(() => {
    resetMetrics();
    process.env.ORB_ENABLED = "true";
    process.env.ORB_WEBHOOK_SECRET = "test-secret";
    process.env.ORB_ANONYMIZE = "true";
    delete process.env.ORB_AIR_GAP;
    delete process.env.ORB_COLLECTOR_URL;
  });
  afterEach(() => {
    delete process.env.ORB_ENABLED;
    process.env.ORB_WEBHOOK_SECRET = undefined as unknown as string;
    delete process.env.ORB_ANONYMIZE;
    delete process.env.ORB_AIR_GAP;
    delete process.env.ORB_COLLECTOR_URL;
  });

  it("returns 0 when ORB_ENABLED=false (no-op)", async () => {
    process.env.ORB_ENABLED = "false";
    const db = makeDb();
    expect(await exportOrbBatch(db, 200, async () => new Response(null, { status: 200 }))).toBe(0);
  });

  it("returns 0 when ORB_AIR_GAP=true", async () => {
    process.env.ORB_AIR_GAP = "true";
    const db = makeDb();
    await recordOrbEvent(db, { repo: "o/r", pr_number: 1, head_sha: "sha", outcome: "merged" });
    expect(await exportOrbBatch(db, 200, async () => new Response(null, { status: 200 }))).toBe(0);
  });

  it("returns 0 when there are no pending events", async () => {
    const db = makeDb();
    expect(await exportOrbBatch(db, 200, async () => new Response(null, { status: 200 }))).toBe(0);
  });

  it("exports pending events and marks them as exported", async () => {
    const db = makeDb();
    await recordOrbEvent(db, { repo: "owner/repo", pr_number: 1, head_sha: "sha1", outcome: "merged", gate_verdict: "approve" });
    await recordOrbEvent(db, { repo: "owner/repo", pr_number: 2, head_sha: "sha2", outcome: "closed" });

    let capturedBody: string | undefined;
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(null, { status: 200 });
    };

    const exported = await exportOrbBatch(db, 200, fakeFetch);
    expect(exported).toBe(2);

    // Verify the payload is signed and anonymized
    const payload = JSON.parse(capturedBody!) as { instance_id: string; events: Array<{ repo_hash: string; pr_hash: string }> };
    expect(payload.events).toHaveLength(2);
    // Anonymized: repo_hash must NOT be the raw repo name
    expect(payload.events[0]?.repo_hash).not.toBe("owner/repo");
    expect(payload.events[0]?.repo_hash).toHaveLength(24); // HMAC slice

    // Rows are marked as exported
    const rows = (await allRows(db)) as Array<Record<string, unknown>>;
    expect(rows.every((r) => r.exported_at !== null)).toBe(true);

    // Counter incremented
    expect(await renderMetrics()).toMatch(/gittensory_orb_events_exported_total 2/);
  });

  it("ORB_ANONYMIZE=false sends raw repo name in payload", async () => {
    process.env.ORB_ANONYMIZE = "false";
    const db = makeDb();
    await recordOrbEvent(db, { repo: "owner/repo", pr_number: 1, head_sha: "sha1", outcome: "merged" });

    let capturedBody: string | undefined;
    await exportOrbBatch(db, 200, async (_u, init) => { capturedBody = init?.body as string; return new Response(null, { status: 200 }); });
    const payload = JSON.parse(capturedBody!) as { events: Array<{ repo_hash: string }> };
    expect(payload.events[0]?.repo_hash).toBe("owner/repo");
  });

  it("does not re-export already-exported events", async () => {
    const db = makeDb();
    await recordOrbEvent(db, { repo: "o/r", pr_number: 1, head_sha: "sha1", outcome: "merged" });
    const fakeFetch = vi.fn(async () => new Response(null, { status: 200 }));
    await exportOrbBatch(db, 200, fakeFetch); // exports 1
    const second = await exportOrbBatch(db, 200, fakeFetch); // nothing left
    expect(second).toBe(0);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("returns 0 and increments error counter on HTTP error from collector", async () => {
    const db = makeDb();
    await recordOrbEvent(db, { repo: "o/r", pr_number: 1, head_sha: "sha", outcome: "merged" });
    const result = await exportOrbBatch(db, 200, async () => new Response(null, { status: 503 }));
    expect(result).toBe(0);
    expect(await renderMetrics()).toContain("gittensory_orb_export_errors_total");
    // Event still pending (not marked as exported)
    const rows = (await allRows(db)) as Array<Record<string, unknown>>;
    expect(rows[0]?.exported_at).toBeNull();
  });

  it("returns 0 and increments error counter when collector is unreachable (network error)", async () => {
    const db = makeDb();
    await recordOrbEvent(db, { repo: "o/r", pr_number: 1, head_sha: "sha", outcome: "merged" });
    const result = await exportOrbBatch(db, 200, async () => { throw new Error("ECONNREFUSED"); });
    expect(result).toBe(0);
    expect(await renderMetrics()).toContain("gittensory_orb_export_errors_total");
  });

  it("includes x-orb-signature header with sha256 HMAC", async () => {
    const db = makeDb();
    await recordOrbEvent(db, { repo: "o/r", pr_number: 1, head_sha: "sha", outcome: "merged" });

    let sigHeader: string | undefined;
    await exportOrbBatch(db, 200, async (_u, init) => {
      sigHeader = (init?.headers as Record<string, string>)?.["x-orb-signature"];
      return new Response(null, { status: 200 });
    });
    expect(sigHeader).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it("uses empty-string HMAC key when ORB_WEBHOOK_SECRET is unset (covers ?? '' branch)", async () => {
    delete (process.env as NodeJS.Dict<string>)["ORB_WEBHOOK_SECRET"];
    const db = makeDb();
    await recordOrbEvent(db, { repo: "o/r", pr_number: 1, head_sha: "sha", outcome: "merged" });
    let sigHeader: string | undefined;
    const exported = await exportOrbBatch(db, 200, async (_u, init) => {
      sigHeader = (init?.headers as Record<string, string>)?.["x-orb-signature"];
      return new Response(null, { status: 200 });
    });
    expect(exported).toBe(1);
    // Signature should still be formed (with empty-string key)
    expect(sigHeader).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it("defaults ORB_ANONYMIZE to true when unset (covers ?? 'true' branch)", async () => {
    delete process.env.ORB_ANONYMIZE;
    const db = makeDb();
    await recordOrbEvent(db, { repo: "owner/repo", pr_number: 1, head_sha: "sha1", outcome: "merged" });
    let capturedBody: string | undefined;
    await exportOrbBatch(db, 200, async (_u, init) => { capturedBody = init?.body as string; return new Response(null, { status: 200 }); });
    const payload = JSON.parse(capturedBody!) as { events: Array<{ repo_hash: string }> };
    // Default is anonymize=true, so repo name must be hashed
    expect(payload.events[0]?.repo_hash).not.toBe("owner/repo");
    expect(payload.events[0]?.repo_hash).toHaveLength(24);
  });

  it("respects batchSize — exports only the first N pending events", async () => {
    const db = makeDb();
    for (let i = 1; i <= 5; i++)
      await recordOrbEvent(db, { repo: "o/r", pr_number: i, head_sha: `sha${i}`, outcome: "merged" });
    const exported = await exportOrbBatch(db, 3, async () => new Response(null, { status: 200 }));
    expect(exported).toBe(3);
    // 2 events still pending
    const rows = (await allRows(db)) as Array<Record<string, unknown>>;
    expect(rows.filter((r) => r.exported_at === null)).toHaveLength(2);
  });
});
