// Pure core for the self-host D1 export (#selfhost-migration Phase 3). Read-only: it transforms rows already
// SELECTed from the cloud D1 into a redacted, checksummed, category-organized export the self-host importer can
// load idempotently. No IO here — the CLI (export-d1-data.mjs) does the wrangler/D1 reads and the file writes —
// so this stays unit-testable. See [[gittensory-selfhost-migration-plan]].
import { createHash } from "node:crypto";

// Tables NEVER exported: SQLite/Drizzle internals + the cloud's own migration ledger (the self-host applies its
// own forward migrations). Keep this conservative — excluding a real table loses data; the importer also skips it.
export const EXCLUDED_TABLES = new Set(["sqlite_sequence", "sqlite_stat1", "d1_migrations", "_cf_KV", "__drizzle_migrations"]);

// Columns dropped per table on export — cloud-specific secrets/hashes that are dead or unsafe on self-host. A
// committed credential never crosses the boundary (#selfhost-migration DO-NOT-MIGRATE list):
//   • auth_sessions.token_hash                 — hashed browser session tokens, scoped to the cloud deploy.
//   • webhook_events.payload_hash              — per-delivery dedup hash, scoped to the cloud deploy.
//   • repository_ai_keys.ciphertext            — maintainer BYOK provider keys, encrypted with the cloud key.
//   • submission_user_tokens.encrypted_token   — short-lived GitHub OAuth token envelopes, cloud-scoped.
//   • orb_enrollments.secret_hash              — one-time enrollment secret hashes.
//   • orb_enrollments.relay_secret_*           — encrypted relay webhook signing secret material.
//   • orb_enrollments.cached_token_json         — encrypted GitHub installation-token cache envelope.
export const REDACTED_COLUMNS = {
  auth_sessions: ["token_hash"],
  webhook_events: ["payload_hash"],
  repository_ai_keys: ["ciphertext"],
  submission_user_tokens: ["encrypted_token"],
  orb_enrollments: ["secret_hash", "relay_secret_enc", "relay_secret_iv", "relay_secret_salt", "cached_token_json"],
};

// A table name is only ever interpolated into SQL (`SELECT * FROM "<name>"`) after passing this allowlist, so a
// hostile or malformed identifier (even though names come from the DB's own sqlite_master) can never break out of
// the quoted identifier — defense-in-depth against SQL injection on the export path.
const SAFE_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when `name` is a plain SQL identifier safe to interpolate into a quoted-table SELECT. */
export function isSafeTableName(name) {
  return typeof name === "string" && SAFE_TABLE_NAME.test(name);
}

/** Drop the redacted columns for `table` from a single row (returns the row unchanged when nothing is redacted). */
export function redactRow(table, row) {
  const drop = REDACTED_COLUMNS[table];
  if (!drop || drop.length === 0) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (!drop.includes(key)) out[key] = value;
  }
  return out;
}

/** Canonicalize a row (sort keys) so column-order differences between D1/SQLite/Postgres don't change the checksum. */
function canonicalizeRow(row) {
  return Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Deterministic SHA-256 over the canonicalized rows, so a self-host import can prove a faithful round-trip. */
export function checksumRows(rows) {
  return createHash("sha256").update(JSON.stringify(rows.map(canonicalizeRow))).digest("hex");
}

/**
 * Optional incremental export: keep only rows whose `sinceColumn` (an ISO-8601 timestamp column such as
 * `updated_at`) is >= `sinceDate`. ISO-8601 strings sort lexicographically, so a string compare is correct. A row
 * missing the column (or with a non-string value) is KEPT — fail-safe: an incremental pass never silently drops a
 * row it can't time-compare (the importer's idempotent upsert reconciles it).
 */
export function filterRowsSince(rows, sinceColumn, sinceDate) {
  if (!sinceDate || !sinceColumn) return rows;
  return rows.filter((row) => {
    const value = row[sinceColumn];
    return typeof value !== "string" || value >= sinceDate;
  });
}

/**
 * Build the export for ONE table: returns null for an excluded table; otherwise redacts every row, applies the
 * optional incremental filter, and attaches a checksum + the list of redacted columns.
 */
export function buildTableExport(table, rows, opts = {}) {
  if (EXCLUDED_TABLES.has(table)) return null;
  const filtered = filterRowsSince(rows, opts.sinceColumn, opts.sinceDate);
  const redacted = filtered.map((row) => redactRow(table, row));
  return {
    table,
    rowCount: redacted.length,
    redactedColumns: REDACTED_COLUMNS[table] ?? [],
    checksum: checksumRows(redacted),
    rows: redacted,
  };
}

/** Summarize the table exports into a manifest (row payloads omitted) the importer validates against. */
export function buildExportManifest(tableExports, meta = {}) {
  const tables = tableExports
    .filter((entry) => entry !== null)
    .map(({ table, rowCount, redactedColumns, checksum }) => ({ table, rowCount, redactedColumns, checksum }));
  return {
    ...meta,
    tableCount: tables.length,
    totalRows: tables.reduce((sum, entry) => sum + entry.rowCount, 0),
    tables,
  };
}
