import type { DatabaseSync } from "node:sqlite";

// Lightweight schema-versioning convention shared across the miner's local SQLite stores (#4832).
//
// Every store bootstraps its tables with `CREATE TABLE IF NOT EXISTS ...` but, until now, carried no
// `user_version`/migration mechanism at all — so an older on-disk file was silently reused with a stale shape.
// This module adds the missing convention without the weight of the main product's `migrations/` runner: each
// store's bootstrap schema is treated as version 1 (BASELINE_SCHEMA_VERSION), and a store's `migrations` array
// describes ONLY the changes AFTER that baseline (`migrations[i]` upgrades the schema from version i+1 to i+2).
// `applySchemaMigrations` reads the file's current `PRAGMA user_version`, runs exactly the pending migrations in
// order, and stamps the new version — so opening an older-schema file runs its outstanding migrations instead of
// silently continuing on an incompatible shape. A pre-versioning file (user_version 0) already carries the
// baseline tables (the idempotent `CREATE TABLE IF NOT EXISTS` ran), so it is treated as the baseline before any
// post-baseline migration is applied. Pure control flow over an injected `DatabaseSync` handle: no IO of its own
// beyond the PRAGMA read/write and the caller-supplied migration functions, and deterministic given the same
// handle + migration list.

/** A single post-baseline schema migration: mutate the store in place to advance it exactly one version. */
export type SchemaMigration = (db: DatabaseSync) => void;

/** The bootstrap schema every store creates inline is, by convention, schema version 1. */
export const BASELINE_SCHEMA_VERSION = 1;

/** Read a store's current `PRAGMA user_version`, coercing any absent/invalid value to 0 (pre-versioning). */
export function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  const raw = row ? Number(row.user_version) : 0;
  return Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/**
 * Bring a store's on-disk schema up to date, then stamp its `user_version`. `migrations[i]` upgrades from
 * version i+1 to i+2, so the target version is `BASELINE_SCHEMA_VERSION + migrations.length`. Every migration
 * whose resulting version is above the file's current version runs, in order; a file already at (or past) the
 * target runs none. Returns the resulting version. Never runs a migration twice (the stamped `user_version`
 * gates re-runs on the next open) and never DOWNGRADES: a file written by newer code with more migrations is
 * left at its higher version rather than stamped back down. Each migration and its version stamp are applied in
 * one transaction, so a failure part-way through the sequence leaves the file at the last fully-applied version
 * and re-opening resumes at the failed migration (a throwing migration rethrows after its changes roll back).
 */
export function applySchemaMigrations(db: DatabaseSync, migrations: SchemaMigration[] = []): number {
  const target = BASELINE_SCHEMA_VERSION + migrations.length;
  const current = readSchemaVersion(db);
  // A pre-versioning file (0) already holds the baseline schema, so advance from the baseline, not from 0.
  const effective = current < BASELINE_SCHEMA_VERSION ? BASELINE_SCHEMA_VERSION : current;
  // Stamp a pre-versioning file up to the baseline first, so a store with NO post-baseline migrations still
  // records a version. Only ever stamp UPWARD: a file already at or past the baseline (including one written by
  // newer code with more migrations) is never downgraded. `user_version` is an integer PRAGMA that cannot be
  // parameterized; every stamped value here is a computed integer, never caller text, so interpolating is safe.
  if (current < BASELINE_SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${BASELINE_SCHEMA_VERSION}`);
  }
  for (let version = effective; version < target; version += 1) {
    // Apply each migration AND stamp its resulting version in ONE transaction, so a failure part-way through the
    // sequence leaves the file at the LAST fully-applied version: the next open resumes at the failed migration
    // rather than re-running the ones that already succeeded (which, for a non-idempotent ALTER, would be a hard
    // duplicate-column error). PRAGMA user_version is transactional in SQLite, so ROLLBACK undoes the migration's
    // partial changes and its version stamp together.
    db.exec("BEGIN");
    try {
      const migration = migrations[version - BASELINE_SCHEMA_VERSION];
      // Index is in-range by construction (`version < target` and `target = BASELINE + migrations.length`).
      migration!(db);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  // The resulting on-disk version: `target` after an upgrade, or the file's own higher version when it was
  // written by newer code (never downgraded).
  return Math.max(current, target);
}
