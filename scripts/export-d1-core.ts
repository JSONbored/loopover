// Pure core for the self-host D1 export (#selfhost-migration Phase 3). Read-only: it transforms rows already
// SELECTed from the cloud D1 into a redacted, checksummed, category-organized export the self-host importer can
// load idempotently. No IO here — the CLI (export-d1-data.ts) does the wrangler/D1 reads and the file writes —
// so this stays unit-testable. See [[gittensory-selfhost-migration-plan]].
import { createHash } from "node:crypto";

export type D1Row = Record<string, unknown>;

export type TableExport = {
  table: string;
  rowCount: number;
  redactedColumns: string[];
  checksum: string;
  rows: D1Row[];
};

export type ExportManifest = {
  tableCount: number;
  totalRows: number;
  tables: Array<{ table: string; rowCount: number; redactedColumns: string[]; checksum: string }>;
  [meta: string]: unknown;
};

// Tables NEVER exported: SQLite/Drizzle internals, the cloud's own migration ledger (the self-host applies its
// own forward migrations), plus private cloud-only calibration signals that must not cross instance boundaries.
// predicted_gate_calls (0137) and predicted_gate_calibration_ledger (0138) are both login-keyed, LOCAL-ONLY by
// their own migration docstrings ("never wired into exportOrbBatch or any other cross-instance/public export
// path") — same sensitivity class, same exclusion.
// Keep this conservative — excluding a real table loses data; the importer also skips it.
export const EXCLUDED_TABLES: Set<string> = new Set([
  "sqlite_sequence",
  "sqlite_stat1",
  "d1_migrations",
  "_cf_KV",
  "__drizzle_migrations",
  "predicted_gate_calibration_ledger",
  "predicted_gate_calls",
]);

// Columns dropped per table on export — cloud-specific secrets/hashes that are dead or unsafe on self-host. A
// committed credential never crosses the boundary (#selfhost-migration DO-NOT-MIGRATE list):
//   • auth_sessions.token_hash                 — hashed browser session tokens, scoped to the cloud deploy.
//   • webhook_events.payload_hash              — per-delivery dedup hash, scoped to the cloud deploy.
//   • orb_webhook_events.payload_hash          — the Orb App's own per-delivery dedup hash; same purpose and
//                                                cloud-scope as webhook_events.payload_hash, separate table.
//   • repository_ai_keys.ciphertext            — maintainer BYOK provider keys, encrypted with the cloud key.
//   • repository_linear_keys.ciphertext        — Linear API keys; same never-serialize envelope as AI keys (#6295).
//   • provider_credentials.ciphertext / iv /   — the instance's own subscription-CLI credential envelope
//     salt                                       (AES-256-GCM via TOKEN_ENCRYPTION_SECRET, same envelope as the
//                                                BYOK key tables above); never serialized off the cloud (#9543).
//   • auth_session_github_tokens.ciphertext /  — per-session GitHub OAuth envelopes; isolated so a full-row
//     refresh_ciphertext                         serialize can't leak them (#6295 / #6114).
//   • submission_user_tokens.encrypted_token   — short-lived GitHub OAuth token envelopes, cloud-scoped.
//   • orb_enrollments.secret_hash              — one-time enrollment secret hashes.
//   • orb_enrollments.relay_secret_*           — encrypted relay webhook signing secret material.
//   • orb_enrollments.cached_token_json        — encrypted GitHub installation-token cache envelope.
//   • orb_enrollments.secret_value_ciphertext  — the STORED (not minted) secret-value envelope; the other half
//     / secret_value_iv / secret_value_salt      of this table's encrypted-secret family (#8064).
//   • orb_instances.ingest_secret_hash         — per-instance risk-control ingest secret hash; sibling of
//                                                orb_enrollments.secret_hash (#9121).
export const REDACTED_COLUMNS: Record<string, string[]> = {
  auth_sessions: ["token_hash"],
  webhook_events: ["payload_hash"],
  orb_webhook_events: ["payload_hash"],
  repository_ai_keys: ["ciphertext"],
  repository_linear_keys: ["ciphertext"],
  provider_credentials: ["ciphertext", "iv", "salt"],
  auth_session_github_tokens: ["ciphertext", "refresh_ciphertext"],
  submission_user_tokens: ["encrypted_token"],
  orb_enrollments: [
    "secret_hash",
    "relay_secret_enc",
    "relay_secret_iv",
    "relay_secret_salt",
    "cached_token_json",
    "secret_value_ciphertext",
    "secret_value_iv",
    "secret_value_salt",
  ],
  orb_instances: ["ingest_secret_hash"],
};

// Columns whose name MATCHES the sensitive-name pattern the drift guard scans for
// (/ciphertext|encrypted|secret|token/i across migrations/**) but which are deliberately EXPORTED because they
// carry no credential — reviewed and stated here rather than silently omitted, the same "say why, don't just
// leave it out" convention scripts/check-dead-source-files.ts's STAGED_AHEAD_OF_CONSUMERS uses. Every entry
// must name a column that still exists in migrations/** (the drift guard fails on a dead entry) and must be a
// genuine non-secret; do NOT add a real credential here to silence the guard — redact it above instead.
export const EXPORT_REVIEWED_NON_SECRET_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // LLM usage-metering token COUNTS (integers), not credentials — needed on self-host to render AI-spend.
  ai_usage_events: ["input_tokens", "output_tokens", "total_tokens"],
  orb_enrollments: [
    "secret_type", // discriminator string ('github_token' | ...), selects which secret family a row holds.
    "secret_value_version", // integer envelope-version for secret_value_*; the ciphertext itself is redacted.
    "last_token_at", // timestamp of the last brokered-token mint; observability metadata, no secret material.
  ],
};

// A table name is only ever interpolated into SQL (`SELECT * FROM "<name>"`) after passing this allowlist, so a
// hostile or malformed identifier (even though names come from the DB's own sqlite_master) can never break out of
// the quoted identifier — defense-in-depth against SQL injection on the export path.
const SAFE_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when `name` is a plain SQL identifier safe to interpolate into a quoted-table SELECT. */
export function isSafeTableName(name: unknown): boolean {
  return typeof name === "string" && SAFE_TABLE_NAME.test(name);
}

/** Drop the redacted columns for `table` from a single row (returns the row unchanged when nothing is redacted). */
export function redactRow(table: string, row: D1Row): D1Row {
  const drop = REDACTED_COLUMNS[table];
  if (!drop || drop.length === 0) return row;
  const out: D1Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (!drop.includes(key)) out[key] = value;
  }
  return out;
}

/** Canonicalize a row (sort keys) so column-order differences between D1/SQLite/Postgres don't change the checksum. */
function canonicalizeRow(row: D1Row): D1Row {
  return Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Deterministic SHA-256 over the canonicalized rows, so a self-host import can prove a faithful round-trip. */
export function checksumRows(rows: D1Row[]): string {
  return createHash("sha256").update(JSON.stringify(rows.map(canonicalizeRow))).digest("hex");
}

/**
 * Optional incremental export: keep only rows whose `sinceColumn` (an ISO-8601 timestamp column such as
 * `updated_at`) is >= `sinceDate`. ISO-8601 strings sort lexicographically, so a string compare is correct. A row
 * missing the column (or with a non-string value) is KEPT — fail-safe: an incremental pass never silently drops a
 * row it can't time-compare (the importer's idempotent upsert reconciles it).
 */
export function filterRowsSince(rows: D1Row[], sinceColumn: string | undefined, sinceDate: string | undefined): D1Row[] {
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
export function buildTableExport(table: string, rows: D1Row[], opts: { sinceColumn?: string; sinceDate?: string } = {}): TableExport | null {
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
export function buildExportManifest(tableExports: Array<TableExport | null>, meta: Record<string, unknown> = {}): ExportManifest {
  const tables = tableExports
    .filter((entry): entry is TableExport => entry !== null)
    .map(({ table, rowCount, redactedColumns, checksum }) => ({ table, rowCount, redactedColumns, checksum }));
  return {
    ...meta,
    tableCount: tables.length,
    totalRows: tables.reduce((sum, entry) => sum + entry.rowCount, 0),
    tables,
  };
}
