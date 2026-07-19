import type { DatabaseSync } from "node:sqlite";
/** A single post-baseline schema migration: mutate the store in place to advance it exactly one version. */
export type SchemaMigration = (db: DatabaseSync) => void;
/** The bootstrap schema every store creates inline is, by convention, schema version 1. */
export declare const BASELINE_SCHEMA_VERSION = 1;
/** Read a store's current `PRAGMA user_version`, coercing any absent/invalid value to 0 (pre-versioning). */
export declare function readSchemaVersion(db: DatabaseSync): number;
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
export declare function applySchemaMigrations(db: DatabaseSync, migrations?: SchemaMigration[]): number;
