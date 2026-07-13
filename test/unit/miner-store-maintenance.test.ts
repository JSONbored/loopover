import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAIM_LEDGER_PURGE_SPEC,
  EVENT_LEDGER_RETENTION_SPEC,
  LEDGER_RETENTION_DAYS_ENV,
  LEDGER_RETENTION_MAX_ROWS_ENV,
  checkStoreIntegrity,
  classifyIntegrityRows,
  countStoreByRepo,
  describeError,
  pruneLedgerByRetention,
  purgeStoreByRepo,
  resolveLedgerRetentionPolicy,
} from "../../packages/gittensory-miner/lib/store-maintenance.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "miner-store-maint-"));
  tempDirs.push(dir);
  return dir;
}

// A minimal append-only ledger matching the event-ledger's retention spec (created_at TEXT, id order column).
function seedLedger(rows: Array<{ createdAt: string }>): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE miner_event_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO miner_event_ledger (created_at) VALUES (?)");
  for (const row of rows) insert.run(row.createdAt);
  return db;
}
function rowCount(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM miner_event_ledger").get() as { n: number }).n);
}

// A minimal store matching CLAIM_LEDGER_PURGE_SPEC's shape (table miner_claims, repoColumn repo_full_name).
function seedPurgeTable(rows: Array<{ repoFullName: string }>): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE miner_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_full_name TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO miner_claims (repo_full_name) VALUES (?)");
  for (const row of rows) insert.run(row.repoFullName);
  return db;
}
function purgeTableRowCount(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM miner_claims").get() as { n: number }).n);
}

describe("classifyIntegrityRows (#4834)", () => {
  it("reports ok for a single 'ok' row", () => {
    expect(classifyIntegrityRows([{ integrity_check: "ok" }])).toEqual({ ok: true, note: "ok" });
  });
  it("joins every problem row when not ok", () => {
    expect(classifyIntegrityRows([{ integrity_check: "row 3 missing" }, { integrity_check: "page 7 bad" }])).toEqual({
      ok: false,
      note: "row 3 missing; page 7 bad",
    });
  });
});

describe("describeError (#4834)", () => {
  it("uses an Error's message and stringifies a non-Error value", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("plain string")).toBe("plain string");
  });
});

describe("checkStoreIntegrity (#4834)", () => {
  it("treats a not-yet-created store as healthy by absence", () => {
    const result = checkStoreIntegrity("event-ledger", join(tempDir(), "missing.sqlite3"));
    expect(result).toMatchObject({ name: "event-ledger", ok: true });
    expect(result.detail).toContain("not created yet");
  });

  it("reports ok for a healthy database file", () => {
    const path = join(tempDir(), "healthy.sqlite3");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE t (id INTEGER)");
    db.close();
    const result = checkStoreIntegrity("plan-store", path);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("ok");
  });

  it("reports not-ok for a file that is not a valid database (read fails after open)", () => {
    const path = join(tempDir(), "garbage.sqlite3");
    writeFileSync(path, "this is not a sqlite database");
    const result = checkStoreIntegrity("event-ledger", path);
    expect(result.ok).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("reports not-ok when the path cannot be opened as a database at all (e.g. a directory)", () => {
    // A directory exists but cannot be opened as a SQLite file, so the open itself throws (the handle is never
    // assigned) — exercises the open-failure path and the no-handle-to-close branch.
    const result = checkStoreIntegrity("event-ledger", tempDir());
    expect(result.ok).toBe(false);
  });
});

describe("resolveLedgerRetentionPolicy (#4834)", () => {
  it("returns null (off) when neither env opt-in is set", () => {
    expect(resolveLedgerRetentionPolicy({})).toBeNull();
  });
  it("returns an age policy from a day count", () => {
    expect(resolveLedgerRetentionPolicy({ [LEDGER_RETENTION_DAYS_ENV]: "30" })).toEqual({ maxAgeMs: 30 * 86_400_000 });
  });
  it("returns a row-count policy", () => {
    expect(resolveLedgerRetentionPolicy({ [LEDGER_RETENTION_MAX_ROWS_ENV]: "500" })).toEqual({ maxRows: 500 });
  });
  it("returns both bounds when both are set", () => {
    const policy = resolveLedgerRetentionPolicy({
      [LEDGER_RETENTION_DAYS_ENV]: "7",
      [LEDGER_RETENTION_MAX_ROWS_ENV]: "1000",
    });
    expect(policy).toEqual({ maxAgeMs: 7 * 86_400_000, maxRows: 1000 });
  });
  it("ignores zero, negative, blank, non-numeric, and non-finite values (treated as unset)", () => {
    expect(resolveLedgerRetentionPolicy({ [LEDGER_RETENTION_DAYS_ENV]: "0", [LEDGER_RETENTION_MAX_ROWS_ENV]: "-5" })).toBeNull();
    expect(resolveLedgerRetentionPolicy({ [LEDGER_RETENTION_DAYS_ENV]: "  ", [LEDGER_RETENTION_MAX_ROWS_ENV]: "abc" })).toBeNull();
    expect(resolveLedgerRetentionPolicy({ [LEDGER_RETENTION_DAYS_ENV]: "Infinity" })).toBeNull();
    expect(resolveLedgerRetentionPolicy({ [LEDGER_RETENTION_MAX_ROWS_ENV]: "2.9" })).toEqual({ maxRows: 2 }); // floors ≥1
  });

  it("floors a fractional value BELOW 1 to a disabled null, never a dangerous 0", () => {
    // Regression: "0.5" must NOT resolve to 0 (which would prune the whole ledger) — it floors to 0 ⇒ disabled.
    expect(resolveLedgerRetentionPolicy({ [LEDGER_RETENTION_MAX_ROWS_ENV]: "0.5" })).toBeNull();
    expect(resolveLedgerRetentionPolicy({ [LEDGER_RETENTION_DAYS_ENV]: "0.9" })).toBeNull();
  });
});

describe("pruneLedgerByRetention (#4834)", () => {
  const NOW = Date.parse("2026-07-12T00:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();

  it("is a no-op for a null policy (retention off)", () => {
    const db = seedLedger([{ createdAt: iso(NOW) }]);
    expect(pruneLedgerByRetention(db, EVENT_LEDGER_RETENTION_SPEC, null, NOW)).toBe(0);
    expect(rowCount(db)).toBe(1);
    db.close();
  });

  it("deletes rows older than the age bound and keeps ones at or after the cutoff", () => {
    const db = seedLedger([
      { createdAt: iso(NOW - 10 * 86_400_000) }, // 10 days old → pruned
      { createdAt: iso(NOW - 5 * 86_400_000) }, // exactly at the 5-day cutoff → kept
      { createdAt: iso(NOW - 1 * 86_400_000) }, // 1 day old → kept
    ]);
    const deleted = pruneLedgerByRetention(db, EVENT_LEDGER_RETENTION_SPEC, { maxAgeMs: 5 * 86_400_000 }, NOW);
    expect(deleted).toBe(1);
    expect(rowCount(db)).toBe(2);
    db.close();
  });

  it("keeps only the newest maxRows by the order column", () => {
    const db = seedLedger(Array.from({ length: 5 }, (_, i) => ({ createdAt: iso(NOW - i * 1000) })));
    const deleted = pruneLedgerByRetention(db, EVENT_LEDGER_RETENTION_SPEC, { maxRows: 2 }, NOW);
    expect(deleted).toBe(3);
    const ids = (db.prepare("SELECT id FROM miner_event_ledger ORDER BY id ASC").all() as Array<{ id: number }>).map((r) => r.id);
    expect(ids).toEqual([4, 5]); // the two most recently inserted rows
    db.close();
  });

  it("applies both bounds together", () => {
    const db = seedLedger([
      { createdAt: iso(NOW - 100 * 86_400_000) }, // very old → age-pruned
      { createdAt: iso(NOW - 2 * 86_400_000) },
      { createdAt: iso(NOW - 1 * 86_400_000) },
      { createdAt: iso(NOW) },
    ]);
    const deleted = pruneLedgerByRetention(db, EVENT_LEDGER_RETENTION_SPEC, { maxAgeMs: 3 * 86_400_000, maxRows: 2 }, NOW);
    expect(deleted).toBe(2); // 1 by age + 1 by row cap → newest 2 remain
    expect(rowCount(db)).toBe(2);
    db.close();
  });

  it("does not prune when the ledger is within both bounds", () => {
    const db = seedLedger([{ createdAt: iso(NOW) }, { createdAt: iso(NOW - 1000) }]);
    expect(pruneLedgerByRetention(db, EVENT_LEDGER_RETENTION_SPEC, { maxAgeMs: 86_400_000, maxRows: 10 }, NOW)).toBe(0);
    expect(rowCount(db)).toBe(2);
    db.close();
  });

  it("never deletes the whole ledger for a degenerate zero bound (defence in depth)", () => {
    const db = seedLedger([{ createdAt: iso(NOW) }, { createdAt: iso(NOW - 100 * 86_400_000) }]);
    // A 0 age would otherwise prune everything older than now; a 0 row-cap would make NOT IN (empty) delete all.
    expect(pruneLedgerByRetention(db, EVENT_LEDGER_RETENTION_SPEC, { maxAgeMs: 0, maxRows: 0 }, NOW)).toBe(0);
    expect(rowCount(db)).toBe(2);
    db.close();
  });

  it("rejects an unsafe SQL identifier in the spec", () => {
    const db = seedLedger([]);
    expect(() =>
      pruneLedgerByRetention(db, { table: "bad; DROP TABLE t", timestampColumn: "created_at", orderColumn: "id" }, { maxRows: 1 }, NOW),
    ).toThrow(/unsafe SQL identifier/);
    db.close();
  });

  it("rolls back and rethrows when a delete fails (e.g. an unknown table)", () => {
    const db = seedLedger([{ createdAt: iso(NOW) }]);
    expect(() =>
      pruneLedgerByRetention(db, { table: "nonexistent_table", timestampColumn: "ts", orderColumn: "id" }, { maxAgeMs: 1000 }, NOW),
    ).toThrow();
    // the original ledger is untouched, and the failed transaction left no open transaction behind
    expect(rowCount(db)).toBe(1);
    db.close();
  });
});

describe("purgeStoreByRepo (#5564)", () => {
  it("deletes every row for one repo and leaves other repos untouched", () => {
    const db = seedPurgeTable([
      { repoFullName: "acme/widgets" },
      { repoFullName: "acme/widgets" },
      { repoFullName: "acme/gadgets" },
    ]);
    expect(purgeStoreByRepo(db, CLAIM_LEDGER_PURGE_SPEC, "acme/widgets")).toBe(2);
    expect(purgeTableRowCount(db)).toBe(1);
    const remaining = db.prepare("SELECT repo_full_name FROM miner_claims").get() as { repo_full_name: string };
    expect(remaining.repo_full_name).toBe("acme/gadgets");
    db.close();
  });

  it("returns 0 when no row matches the repo", () => {
    const db = seedPurgeTable([{ repoFullName: "acme/gadgets" }]);
    expect(purgeStoreByRepo(db, CLAIM_LEDGER_PURGE_SPEC, "acme/widgets")).toBe(0);
    expect(purgeTableRowCount(db)).toBe(1);
    db.close();
  });

  it("rejects an unsafe SQL identifier in the spec", () => {
    const db = seedPurgeTable([]);
    expect(() => purgeStoreByRepo(db, { table: "bad; DROP TABLE t", repoColumn: "repo_full_name" }, "acme/widgets")).toThrow(
      /unsafe SQL identifier/,
    );
    expect(() => purgeStoreByRepo(db, { table: "miner_claims", repoColumn: "bad; --" }, "acme/widgets")).toThrow(
      /unsafe SQL identifier/,
    );
    db.close();
  });
});

describe("countStoreByRepo (#5564)", () => {
  it("counts matching rows without deleting anything", () => {
    const db = seedPurgeTable([
      { repoFullName: "acme/widgets" },
      { repoFullName: "acme/widgets" },
      { repoFullName: "acme/gadgets" },
    ]);
    expect(countStoreByRepo(db, CLAIM_LEDGER_PURGE_SPEC, "acme/widgets")).toBe(2);
    expect(purgeTableRowCount(db)).toBe(3); // nothing deleted
    db.close();
  });

  it("returns 0 when no row matches the repo", () => {
    const db = seedPurgeTable([{ repoFullName: "acme/gadgets" }]);
    expect(countStoreByRepo(db, CLAIM_LEDGER_PURGE_SPEC, "acme/widgets")).toBe(0);
    db.close();
  });

  it("rejects an unsafe SQL identifier in the spec", () => {
    const db = seedPurgeTable([]);
    expect(() => countStoreByRepo(db, { table: "bad; DROP TABLE t", repoColumn: "repo_full_name" }, "acme/widgets")).toThrow(
      /unsafe SQL identifier/,
    );
    db.close();
  });
});
