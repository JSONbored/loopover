import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVENT_LEDGER_RETENTION_SPEC,
  LEDGER_RETENTION_DAYS_ENV,
  LEDGER_RETENTION_MAX_ROWS_ENV,
  checkStoreIntegrity,
  classifyIntegrityRows,
  describeError,
  pruneLedgerByRetention,
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

  it("REGRESSION: pins the camelCase `readOnly` option key, never the lowercase `readonly` node:sqlite silently ignores", () => {
    // node:sqlite's DatabaseSync only recognizes `readOnly` (camelCase) for a driver-enforced read-only
    // connection; the lowercase `readonly` key is silently ignored and the connection opens read-write instead
    // -- the exact gotcha claim-ledger.js's own openClaimLedgerReadOnly already documents and pins. A source-text
    // check (rather than only a live-connection assertion below) means a future edit that reintroduces the wrong
    // casing fails immediately, without needing to reason about SQLite's own error-message wording.
    const source = readFileSync("packages/gittensory-miner/lib/store-maintenance.js", "utf8");
    expect(source).toContain("new DatabaseSync(dbPath, { readOnly: true })");
    expect(source).not.toMatch(/new DatabaseSync\(dbPath,\s*\{\s*readonly:/);
  });

  it("REGRESSION: a connection opened the same way checkStoreIntegrity does genuinely rejects a write", () => {
    // Mirrors claim-ledger.test.ts's own "readOnly vs. readonly key gotcha" regression test: proves the driver
    // itself enforces read-only for this exact option shape, so checkStoreIntegrity's connection can never
    // silently mutate the store file it's meant to only inspect.
    const path = join(tempDir(), "healthy.sqlite3");
    const setup = new DatabaseSync(path);
    setup.exec("CREATE TABLE t (id INTEGER)");
    setup.close();

    const readOnlyConnection = new DatabaseSync(path, { readOnly: true });
    try {
      expect(() => readOnlyConnection.exec("INSERT INTO t (id) VALUES (1)")).toThrow(/readonly/i);
    } finally {
      readOnlyConnection.close();
    }
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
