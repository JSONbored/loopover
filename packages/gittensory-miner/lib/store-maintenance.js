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

/** Env opt-ins for ledger retention (unset ⇒ retention disabled). */
export const LEDGER_RETENTION_DAYS_ENV = "LOOPOVER_MINER_LEDGER_RETENTION_DAYS";
export const LEDGER_RETENTION_MAX_ROWS_ENV = "LOOPOVER_MINER_LEDGER_RETENTION_MAX_ROWS";

/** Fixed retention specs for the three append-only ledgers. These identifiers are INTERNAL constants — never
 *  caller/user text — and are validated as plain identifiers before interpolation as defence in depth. */
export const EVENT_LEDGER_RETENTION_SPEC = { table: "miner_event_ledger", timestampColumn: "created_at", orderColumn: "id" };
export const GOVERNOR_LEDGER_RETENTION_SPEC = { table: "governor_events", timestampColumn: "ts", orderColumn: "id" };
export const PREDICTION_LEDGER_RETENTION_SPEC = { table: "predictions", timestampColumn: "ts", orderColumn: "id" };

/** Fixed purge specs (#5564) for the four stores whose rows are directly scoped by a `repoColumn`. Same
 *  internal-constant-only discipline as the retention specs above. `attempt-log.js` is deliberately absent: its
 *  payload is a free-form `Record<string, unknown>` with no dedicated repo column, so a precise per-repo purge
 *  isn't possible there without risking false matches — `purge-cli.js` reports it as not-purgeable instead. */
export const CLAIM_LEDGER_PURGE_SPEC = { table: "miner_claims", repoColumn: "repo_full_name" };
export const EVENT_LEDGER_PURGE_SPEC = { table: "miner_event_ledger", repoColumn: "repo_full_name" };
export const GOVERNOR_LEDGER_PURGE_SPEC = { table: "governor_events", repoColumn: "repo_full_name" };
export const PREDICTION_LEDGER_PURGE_SPEC = { table: "predictions", repoColumn: "repo_full_name" };

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A readable message for a caught value, whether or not it is an Error. */
export function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify raw `PRAGMA integrity_check` rows. A healthy database yields a single `"ok"` row; a corrupt one yields
 * one row per problem. Pure — extracted so both the healthy and problem paths are testable without a genuinely
 * corrupt file (which SQLite typically refuses to open at all, i.e. the catch path below).
 * @param {Array<{ integrity_check?: unknown }>} rows
 * @returns {{ ok: boolean, note: string }}
 */
export function classifyIntegrityRows(rows) {
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
 * @param {string} name - the check label (e.g. "event-ledger").
 * @param {string} dbPath - the store file path.
 * @returns {{ name: string, ok: boolean, detail: string }}
 */
export function checkStoreIntegrity(name, dbPath) {
  if (!existsSync(dbPath)) {
    return { name, ok: true, detail: `${dbPath}: not created yet` };
  }
  let db;
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
function positiveIntOrNull(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const numeric = Math.floor(Number(raw));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/**
 * Resolve the opt-in ledger retention policy from an env object. OFF by default: returns null unless at least
 * one bound is set to a positive value. A zero/negative/non-numeric value is treated as unset. When set, returns
 * `{ maxAgeMs? }` (from a day count) and/or `{ maxRows? }`.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ maxAgeMs?: number, maxRows?: number } | null}
 */
export function resolveLedgerRetentionPolicy(env = process.env) {
  const maxAgeDays = positiveIntOrNull(env[LEDGER_RETENTION_DAYS_ENV]);
  const maxRows = positiveIntOrNull(env[LEDGER_RETENTION_MAX_ROWS_ENV]);
  if (maxAgeDays === null && maxRows === null) return null;
  const policy = {};
  if (maxAgeDays !== null) policy.maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  if (maxRows !== null) policy.maxRows = maxRows;
  return policy;
}

/**
 * Prune one append-only ledger per a resolved retention policy: delete rows older than the age bound AND rows
 * beyond the row-count bound (keeping the newest `maxRows` by `orderColumn`), atomically. A null policy is a
 * no-op. `nowMs` is caller-supplied (no internal clock). Timestamp columns are UTC ISO-8601 strings, which sort
 * lexicographically in chronological order, so a string comparison against the ISO cutoff selects older rows.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ table: string, timestampColumn: string, orderColumn: string }} spec
 * @param {{ maxAgeMs?: number, maxRows?: number } | null} policy
 * @param {number} nowMs
 * @returns {number} rows deleted
 */
export function pruneLedgerByRetention(db, spec, policy, nowMs) {
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
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ table: string, repoColumn: string }} spec
 * @param {string} repoFullName
 * @returns {number} rows deleted
 */
export function purgeStoreByRepo(db, spec, repoFullName) {
  for (const identifier of [spec.table, spec.repoColumn]) {
    if (!SQL_IDENTIFIER.test(identifier)) throw new Error(`unsafe SQL identifier: ${identifier}`);
  }
  const info = db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.repoColumn} = ?`).run(repoFullName);
  return Number(info.changes);
}

/**
 * Count rows for one repo in a store without deleting anything (#5564) — the read-only counterpart to
 * `purgeStoreByRepo`, used by `purge-cli.js --dry-run` to report what a real purge would remove.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ table: string, repoColumn: string }} spec
 * @param {string} repoFullName
 * @returns {number} matching row count
 */
export function countStoreByRepo(db, spec, repoFullName) {
  for (const identifier of [spec.table, spec.repoColumn]) {
    if (!SQL_IDENTIFIER.test(identifier)) throw new Error(`unsafe SQL identifier: ${identifier}`);
  }
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${spec.table} WHERE ${spec.repoColumn} = ?`).get(repoFullName);
  return Number(row.count);
}
