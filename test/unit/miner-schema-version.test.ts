import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  applySchemaMigrations,
  readSchemaVersion,
  BASELINE_SCHEMA_VERSION,
} from "../../packages/loopover-miner/lib/schema-version";

type Migration = (db: DatabaseSync) => void;

/** A minimal store whose bootstrap table already exists (the `CREATE TABLE IF NOT EXISTS` convention). */
function freshStore(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)");
  return db;
}

describe("schema-version migration runner (#4832)", () => {
  it("treats a pre-versioning file as version 0 and stamps the baseline when there are no migrations", () => {
    const db = freshStore();
    expect(readSchemaVersion(db)).toBe(0);
    expect(applySchemaMigrations(db, [])).toBe(BASELINE_SCHEMA_VERSION);
    expect(readSchemaVersion(db)).toBe(1);
    db.close();
  });

  it("runs every pending migration in order on a pre-versioning file and stamps the target version", () => {
    const db = freshStore();
    const calls: number[] = [];
    const migrations: Migration[] = [
      (d) => {
        d.exec("ALTER TABLE t ADD COLUMN a TEXT");
        calls.push(1);
      },
      (d) => {
        d.exec("ALTER TABLE t ADD COLUMN b TEXT");
        calls.push(2);
      },
    ];
    expect(applySchemaMigrations(db, migrations)).toBe(3); // baseline 1 + 2 migrations
    expect(calls).toEqual([1, 2]);
    expect(readSchemaVersion(db)).toBe(3);
    db.exec("INSERT INTO t (id, a, b) VALUES (1, 'x', 'y')"); // both added columns exist
    db.close();
  });

  it("is idempotent: re-applying the same migrations on an up-to-date file runs none and does not re-stamp", () => {
    const db = freshStore();
    let runs = 0;
    const migrations: Migration[] = [
      (d) => {
        d.exec("ALTER TABLE t ADD COLUMN a TEXT");
        runs += 1;
      },
    ];
    applySchemaMigrations(db, migrations);
    expect(runs).toBe(1);
    expect(applySchemaMigrations(db, migrations)).toBe(2);
    expect(runs).toBe(1); // the already-applied migration did not run again
    db.close();
  });

  it("runs only the outstanding migrations when a file is partway through the history", () => {
    const db = freshStore();
    // A prior release shipped one migration → file is at version 2.
    applySchemaMigrations(db, [(d) => d.exec("ALTER TABLE t ADD COLUMN a TEXT")]);
    expect(readSchemaVersion(db)).toBe(2);
    const ran: string[] = [];
    const migrations: Migration[] = [
      () => ran.push("0"), // already applied — must NOT run
      (d) => {
        d.exec("ALTER TABLE t ADD COLUMN b TEXT");
        ran.push("1");
      },
    ];
    expect(applySchemaMigrations(db, migrations)).toBe(3);
    expect(ran).toEqual(["1"]);
    db.close();
  });

  it("stamps after each migration so a mid-sequence failure leaves the file at the last applied version (no re-run)", () => {
    const db = freshStore();
    let firstRuns = 0;
    const failing: Migration[] = [
      (d) => {
        d.exec("ALTER TABLE t ADD COLUMN a TEXT");
        firstRuns += 1;
      },
      () => {
        throw new Error("migration 2 failed");
      },
    ];
    expect(() => applySchemaMigrations(db, failing)).toThrow("migration 2 failed");
    expect(readSchemaVersion(db)).toBe(2); // migration[0] committed (baseline 1 + 1); migration[1] did not
    expect(firstRuns).toBe(1);
    // Re-open with the now-fixed migrations: migration[0] must NOT re-run (re-running its ALTER would throw a
    // duplicate-column error), and migration[1] completes.
    const fixed: Migration[] = [
      (d) => {
        d.exec("ALTER TABLE t ADD COLUMN a TEXT");
        firstRuns += 1;
      },
      (d) => d.exec("ALTER TABLE t ADD COLUMN b TEXT"),
    ];
    expect(applySchemaMigrations(db, fixed)).toBe(3);
    expect(firstRuns).toBe(1); // migration[0] was not applied a second time
    db.exec("INSERT INTO t (id, a, b) VALUES (1, 'x', 'y')"); // both columns exist exactly once
    db.close();
  });

  it("rolls back a failed migration's partial changes (each migration is atomic)", () => {
    const db = freshStore();
    const partial: Migration[] = [
      (d) => {
        d.exec("ALTER TABLE t ADD COLUMN a TEXT");
        throw new Error("boom after the ALTER");
      },
    ];
    expect(() => applySchemaMigrations(db, partial)).toThrow("boom after the ALTER");
    // The baseline stamp persisted, but the migration's ALTER rolled back with its version stamp.
    expect(readSchemaVersion(db)).toBe(1);
    const columns = (db.prepare("PRAGMA table_info(t)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).not.toContain("a");
    db.close();
  });

  it("never downgrades a file written by newer code (current > target): no migrations run, version unchanged", () => {
    const db = freshStore();
    // Newer code (2 migrations) stamped this file at version 3.
    applySchemaMigrations(db, [
      (d) => d.exec("ALTER TABLE t ADD COLUMN a TEXT"),
      (d) => d.exec("ALTER TABLE t ADD COLUMN b TEXT"),
    ]);
    expect(readSchemaVersion(db)).toBe(3);
    // Older code that only knows one migration opens the same file: it must run nothing and must NOT stamp the
    // version back down to its own target of 2.
    let ran = 0;
    const resulting = applySchemaMigrations(db, [
      () => {
        ran += 1;
      },
    ]);
    expect(ran).toBe(0);
    expect(readSchemaVersion(db)).toBe(3); // left at the newer version, not downgraded to 2
    expect(resulting).toBe(3); // reports the file's actual (higher) version
    db.close();
  });

  it("coerces an absent, non-integer, or negative user_version to 0", () => {
    const absent = { prepare: () => ({ get: () => undefined }) } as unknown as DatabaseSync;
    expect(readSchemaVersion(absent)).toBe(0);
    const nonInteger = { prepare: () => ({ get: () => ({ user_version: "oops" }) }) } as unknown as DatabaseSync;
    expect(readSchemaVersion(nonInteger)).toBe(0);
    const negative = { prepare: () => ({ get: () => ({ user_version: -3 }) }) } as unknown as DatabaseSync;
    expect(readSchemaVersion(negative)).toBe(0);
  });
});
