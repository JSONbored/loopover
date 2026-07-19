// Local-store maintenance for the miner (#4834): SQLite integrity checks + append-only ledger retention.
//
// Three independent, side-effect-light helpers used by `doctor`, the ledgers, and `purge-cli.js`:
//   1. checkStoreIntegrity — run `PRAGMA integrity_check` on one store file and report health, so `doctor` can
//      flag a corrupted store instead of only probing a single one with `SELECT 1`.
//   2. resolveLedgerRetentionPolicy / pruneLedgerByRetention — an opt-in, age- and/or size-based retention
//      policy for the unbounded append-only ledgers (event, governor, prediction), which otherwise grow forever.
//      OFF by default: retention only runs when an operator sets the env opt-in.
//   3. purgeStoreByRepo — an explicit, operator-invoked delete of every row for one repo (#5564, right-to-be-
//      forgotten). Distinct from retention pruning: never runs automatically, always caller-initiated via
//      `purge-cli.js`, and always reports how many rows it removed so a purge is never silent.
// Pure control flow over injected inputs (a DB handle, an env object, a caller-supplied clock) — no network, and
// no internal clock read in the prune path so it stays deterministic and unit-testable.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CONTRIBUTION_PROFILE_STORE_TABLE } from "./contribution-profile.js";

/** Env opt-ins for ledger retention (unset ⇒ retention disabled). */
export const LEDGER_RETENTION_DAYS_ENV = "LOOPOVER_MINER_LEDGER_RETENTION_DAYS";
export const LEDGER_RETENTION_MAX_ROWS_ENV = "LOOPOVER_MINER_LEDGER_RETENTION_MAX_ROWS";

export type LedgerRetentionSpec = { table: string; timestampColumn: string; orderColumn: string };

/** Fixed retention specs for the three append-only ledgers. These identifiers are INTERNAL constants — never
 *  caller/user text — and are validated as plain identifiers before interpolation as defence in depth. */
export const EVENT_LEDGER_RETENTION_SPEC: LedgerRetentionSpec = { table: "miner_event_ledger", timestampColumn: "created_at", orderColumn: "id" };
export const GOVERNOR_LEDGER_RETENTION_SPEC: LedgerRetentionSpec = { table: "governor_events", timestampColumn: "ts", orderColumn: "id" };
export const PREDICTION_LEDGER_RETENTION_SPEC: LedgerRetentionSpec = { table: "predictions", timestampColumn: "ts", orderColumn: "id" };

export type LedgerPurgeSpec = { table: string; repoColumn: string };

/** Fixed purge specs (#5564, #6599) for the six stores whose rows are directly scoped by a `repoColumn`. Same
 *  internal-constant-only discipline as the retention specs above. `attempt-log.js` is deliberately absent: its
 *  payload is a free-form `Record<string, unknown>` with no dedicated repo column, so a precise per-repo purge
 *  isn't possible there without risking false matches — `purge-cli.js` reports it as not-purgeable instead. */
export const CLAIM_LEDGER_PURGE_SPEC: LedgerPurgeSpec = { table: "miner_claims", repoColumn: "repo_full_name" };
export const EVENT_LEDGER_PURGE_SPEC: LedgerPurgeSpec = { table: "miner_event_ledger", repoColumn: "repo_full_name" };
export const GOVERNOR_LEDGER_PURGE_SPEC: LedgerPurgeSpec = { table: "governor_events", repoColumn: "repo_full_name" };
export const PREDICTION_LEDGER_PURGE_SPEC: LedgerPurgeSpec = { table: "predictions", repoColumn: "repo_full_name" };
export const PORTFOLIO_QUEUE_PURGE_SPEC: LedgerPurgeSpec = { table: "miner_portfolio_queue", repoColumn: "repo_full_name" };
export const RUN_STATE_PURGE_SPEC: LedgerPurgeSpec = { table: "miner_run_state", repoColumn: "repo_full_name" };

/** Three more repo-scoped stores the original six missed (#7091), same `repoColumn` shape and same internal-
 *  constant-only discipline. The contribution-profile-cache table name comes from its schema module's own
 *  `CONTRIBUTION_PROFILE_STORE_TABLE` constant so this spec can't drift from a second hardcoded literal.
 *  governor-state holds two genuinely repo-scoped tables (reputation history + own submissions);
 *  `governor_scalar_state` is intentionally excluded — it is a single whole-run scalar row with no repo
 *  dimension. `governor_reputation_history` is purged on `repo_full_name` alone (its key is composite with
 *  `api_base_url`), so a right-to-be-forgotten sweep clears the repo across every forge host it was recorded
 *  against, not just the default one. */
export const CONTRIBUTION_PROFILE_CACHE_PURGE_SPEC: LedgerPurgeSpec = { table: CONTRIBUTION_PROFILE_STORE_TABLE, repoColumn: "repo_full_name" };
export const GOVERNOR_REPUTATION_HISTORY_PURGE_SPEC: LedgerPurgeSpec = { table: "governor_reputation_history", repoColumn: "repo_full_name" };
export const GOVERNOR_OWN_SUBMISSIONS_PURGE_SPEC: LedgerPurgeSpec = { table: "governor_own_submissions", repoColumn: "repo_full_name" };

/** policy-verdict-cache (#6987), another repo-scoped store the earlier sweeps missed. Its `repo_scope TEXT
 *  PRIMARY KEY` is the per-repo column (a tenant forge host + `owner/repo`), the same `repoColumn` shape and
 *  internal-constant-only discipline as the specs above. `policy-doc-cache.js` stays out (keyed by URL, no repo
 *  column, exactly like `attempt-log.js`). */
export const POLICY_VERDICT_CACHE_PURGE_SPEC: LedgerPurgeSpec = { table: "policy_verdict_cache", repoColumn: "repo_scope" };

export type StoreIntegrityResult = { name: string; ok: boolean; detail: string };
export type LedgerRetentionPolicy = { maxAgeMs?: number; maxRows?: number };

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A readable message for a caught value, whether or not it is an Error. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify raw `PRAGMA integrity_check` rows. A healthy database yields a single `"ok"` row; a corrupt one yields
 * one row per problem. Pure — extracted so both the healthy and problem paths are testable without a genuinely
 * corrupt file (which SQLite typically refuses to open at all, i.e. the catch path below).
 */
export function classifyIntegrityRows(rows: Array<{ integrity_check?: unknown }>): { ok: boolean; note: string } {
  const problems = rows.map((row) => String(row.integrity_check)).filter((value) => value !== "ok");
  return problems.length === 0 ? { ok: true, note: "ok" } : { ok: false, note: problems.join("; ") };
}

/**
 * Run `PRAGMA integrity_check` on a single store file. A store that does not exist yet is healthy by absence
 * (nothing to corrupt). Never throws: a store that cannot be opened or read is reported as not-ok, so one bad
 * store cannot abort the whole doctor sweep. Opens the connection driver-enforced read-only -- `readOnly`
 * (camelCase) is the only option key node:sqlite recognizes for this; the lowercase `readonly` is silently
 * ignored and opens read-write instead (the exact gotcha claim-ledger.js's own openClaimLedgerReadOnly already
 * documents), which would defeat the read-only guarantee this function's own docs claim.
 */
export function checkStoreIntegrity(name: string, dbPath: string): StoreIntegrityResult {
  if (!existsSync(dbPath)) {
    return { name, ok: true, detail: `${dbPath}: not created yet` };
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const { ok, note } = classifyIntegrityRows(db.prepare("PRAGMA integrity_check").all());
    return { name, ok, detail: `${dbPath}: ${note}` };
  } catch (error) {
    return { name, ok: false, detail: `${dbPath}: ${describeError(error)}` };
  } finally {
    db?.close();
  }
}

/** Coerce an env value to a positive integer, or null (unset/blank/zero/negative/non-finite ⇒ null ⇒ disabled).
 *  Floors BEFORE the positivity test, so a fractional value below 1 (e.g. "0.5") floors to 0 and disables the
 *  bound rather than becoming a dangerous 0 that would prune the whole ledger. */
function positiveIntOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const numeric = Math.floor(Number(raw));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/**
 * Resolve the opt-in ledger retention policy from an env object. OFF by default: returns null unless at least
 * one bound is set to a positive value. A zero/negative/non-numeric value is treated as unset. When set, returns
 * `{ maxAgeMs? }` (from a day count) and/or `{ maxRows? }`.
 */
export function resolveLedgerRetentionPolicy(
  env: Record<string, string | undefined> = process.env,
): LedgerRetentionPolicy | null {
  const maxAgeDays = positiveIntOrNull(env[LEDGER_RETENTION_DAYS_ENV]);
  const maxRows = positiveIntOrNull(env[LEDGER_RETENTION_MAX_ROWS_ENV]);
  if (maxAgeDays === null && maxRows === null) return null;
  const policy: LedgerRetentionPolicy = {};
  if (maxAgeDays !== null) policy.maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  if (maxRows !== null) policy.maxRows = maxRows;
  return policy;
}

/**
 * Prune one append-only ledger per a resolved retention policy: delete rows older than the age bound AND rows
 * beyond the row-count bound (keeping the newest `maxRows` by `orderColumn`), atomically. A null policy is a
 * no-op. `nowMs` is caller-supplied (no internal clock). Timestamp columns are UTC ISO-8601 strings, which sort
 * lexicographically in chronological order, so a string comparison against the ISO cutoff selects older rows.
 */
export function pruneLedgerByRetention(
  db: DatabaseSync,
  spec: LedgerRetentionSpec,
  policy: LedgerRetentionPolicy | null,
  nowMs: number,
): number {
  if (!policy) return 0;
  for (const identifier of [spec.table, spec.timestampColumn, spec.orderColumn]) {
    if (!SQL_IDENTIFIER.test(identifier)) throw new Error(`unsafe SQL identifier: ${identifier}`);
  }
  let deleted = 0;
  db.exec("BEGIN");
  try {
    // Both bounds are guarded to be strictly positive as defence in depth: a 0 age would prune everything older
    // than `now`, and a 0 row-cap makes `LIMIT 0` match no rows so `NOT IN (empty)` would delete the whole ledger.
    if (policy.maxAgeMs !== undefined && policy.maxAgeMs > 0) {
      const cutoff = new Date(nowMs - policy.maxAgeMs).toISOString();
      const info = db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.timestampColumn} < ?`).run(cutoff);
      deleted += Number(info.changes);
    }
    if (policy.maxRows !== undefined && policy.maxRows >= 1) {
      const info = db
        .prepare(
          `DELETE FROM ${spec.table} WHERE ${spec.orderColumn} NOT IN ` +
            `(SELECT ${spec.orderColumn} FROM ${spec.table} ORDER BY ${spec.orderColumn} DESC LIMIT ?)`,
        )
        .run(policy.maxRows);
      deleted += Number(info.changes);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return deleted;
}

/**
 * Delete every row for one repo from a store (#5564). Unlike `pruneLedgerByRetention`, this never runs
 * automatically — it exists solely so `purge-cli.js` can give an operator a real right-to-be-forgotten path.
 * `repoFullName` is caller-normalized (owner/repo) before reaching here; this function only guards the SQL
 * identifiers, matching `pruneLedgerByRetention`'s own defence-in-depth discipline.
 */
export function purgeStoreByRepo(db: DatabaseSync, spec: LedgerPurgeSpec, repoFullName: string): number {
  for (const identifier of [spec.table, spec.repoColumn]) {
    if (!SQL_IDENTIFIER.test(identifier)) throw new Error(`unsafe SQL identifier: ${identifier}`);
  }
  const info = db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.repoColumn} = ?`).run(repoFullName);
  return Number(info.changes);
}

/**
 * Count rows for one repo in a store without deleting anything (#5564) — the read-only counterpart to
 * `purgeStoreByRepo`, used by `purge-cli.js --dry-run` to report what a real purge would remove.
 */
export function countStoreByRepo(db: DatabaseSync, spec: LedgerPurgeSpec, repoFullName: string): number {
  for (const identifier of [spec.table, spec.repoColumn]) {
    if (!SQL_IDENTIFIER.test(identifier)) throw new Error(`unsafe SQL identifier: ${identifier}`);
  }
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${spec.table} WHERE ${spec.repoColumn} = ?`).get(repoFullName);
  return Number(row?.count);
}
