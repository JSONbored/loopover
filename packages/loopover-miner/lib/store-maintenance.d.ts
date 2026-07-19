import { DatabaseSync } from "node:sqlite";
/** Env opt-ins for ledger retention (unset ⇒ retention disabled). */
export declare const LEDGER_RETENTION_DAYS_ENV = "LOOPOVER_MINER_LEDGER_RETENTION_DAYS";
export declare const LEDGER_RETENTION_MAX_ROWS_ENV = "LOOPOVER_MINER_LEDGER_RETENTION_MAX_ROWS";
export type LedgerRetentionSpec = {
    table: string;
    timestampColumn: string;
    orderColumn: string;
};
/** Fixed retention specs for the three append-only ledgers. These identifiers are INTERNAL constants — never
 *  caller/user text — and are validated as plain identifiers before interpolation as defence in depth. */
export declare const EVENT_LEDGER_RETENTION_SPEC: LedgerRetentionSpec;
export declare const GOVERNOR_LEDGER_RETENTION_SPEC: LedgerRetentionSpec;
export declare const PREDICTION_LEDGER_RETENTION_SPEC: LedgerRetentionSpec;
export type LedgerPurgeSpec = {
    table: string;
    repoColumn: string;
};
/** Fixed purge specs (#5564, #6599) for the six stores whose rows are directly scoped by a `repoColumn`. Same
 *  internal-constant-only discipline as the retention specs above. `attempt-log.js` is deliberately absent: its
 *  payload is a free-form `Record<string, unknown>` with no dedicated repo column, so a precise per-repo purge
 *  isn't possible there without risking false matches — `purge-cli.js` reports it as not-purgeable instead. */
export declare const CLAIM_LEDGER_PURGE_SPEC: LedgerPurgeSpec;
export declare const EVENT_LEDGER_PURGE_SPEC: LedgerPurgeSpec;
export declare const GOVERNOR_LEDGER_PURGE_SPEC: LedgerPurgeSpec;
export declare const PREDICTION_LEDGER_PURGE_SPEC: LedgerPurgeSpec;
export declare const PORTFOLIO_QUEUE_PURGE_SPEC: LedgerPurgeSpec;
export declare const RUN_STATE_PURGE_SPEC: LedgerPurgeSpec;
/** Three more repo-scoped stores the original six missed (#7091), same `repoColumn` shape and same internal-
 *  constant-only discipline. The contribution-profile-cache table name comes from its schema module's own
 *  `CONTRIBUTION_PROFILE_STORE_TABLE` constant so this spec can't drift from a second hardcoded literal.
 *  governor-state holds two genuinely repo-scoped tables (reputation history + own submissions);
 *  `governor_scalar_state` is intentionally excluded — it is a single whole-run scalar row with no repo
 *  dimension. `governor_reputation_history` is purged on `repo_full_name` alone (its key is composite with
 *  `api_base_url`), so a right-to-be-forgotten sweep clears the repo across every forge host it was recorded
 *  against, not just the default one. */
export declare const CONTRIBUTION_PROFILE_CACHE_PURGE_SPEC: LedgerPurgeSpec;
export declare const GOVERNOR_REPUTATION_HISTORY_PURGE_SPEC: LedgerPurgeSpec;
export declare const GOVERNOR_OWN_SUBMISSIONS_PURGE_SPEC: LedgerPurgeSpec;
/** policy-verdict-cache (#6987), another repo-scoped store the earlier sweeps missed. Its `repo_scope TEXT
 *  PRIMARY KEY` is the per-repo column (a tenant forge host + `owner/repo`), the same `repoColumn` shape and
 *  internal-constant-only discipline as the specs above. `policy-doc-cache.js` stays out (keyed by URL, no repo
 *  column, exactly like `attempt-log.js`). */
export declare const POLICY_VERDICT_CACHE_PURGE_SPEC: LedgerPurgeSpec;
export type StoreIntegrityResult = {
    name: string;
    ok: boolean;
    detail: string;
};
export type LedgerRetentionPolicy = {
    maxAgeMs?: number;
    maxRows?: number;
};
/** A readable message for a caught value, whether or not it is an Error. */
export declare function describeError(error: unknown): string;
/**
 * Classify raw `PRAGMA integrity_check` rows. A healthy database yields a single `"ok"` row; a corrupt one yields
 * one row per problem. Pure — extracted so both the healthy and problem paths are testable without a genuinely
 * corrupt file (which SQLite typically refuses to open at all, i.e. the catch path below).
 */
export declare function classifyIntegrityRows(rows: Array<{
    integrity_check?: unknown;
}>): {
    ok: boolean;
    note: string;
};
/**
 * Run `PRAGMA integrity_check` on a single store file. A store that does not exist yet is healthy by absence
 * (nothing to corrupt). Never throws: a store that cannot be opened or read is reported as not-ok, so one bad
 * store cannot abort the whole doctor sweep. Opens the connection driver-enforced read-only -- `readOnly`
 * (camelCase) is the only option key node:sqlite recognizes for this; the lowercase `readonly` is silently
 * ignored and opens read-write instead (the exact gotcha claim-ledger.js's own openClaimLedgerReadOnly already
 * documents), which would defeat the read-only guarantee this function's own docs claim.
 */
export declare function checkStoreIntegrity(name: string, dbPath: string): StoreIntegrityResult;
/**
 * Resolve the opt-in ledger retention policy from an env object. OFF by default: returns null unless at least
 * one bound is set to a positive value. A zero/negative/non-numeric value is treated as unset. When set, returns
 * `{ maxAgeMs? }` (from a day count) and/or `{ maxRows? }`.
 */
export declare function resolveLedgerRetentionPolicy(env?: Record<string, string | undefined>): LedgerRetentionPolicy | null;
/**
 * Prune one append-only ledger per a resolved retention policy: delete rows older than the age bound AND rows
 * beyond the row-count bound (keeping the newest `maxRows` by `orderColumn`), atomically. A null policy is a
 * no-op. `nowMs` is caller-supplied (no internal clock). Timestamp columns are UTC ISO-8601 strings, which sort
 * lexicographically in chronological order, so a string comparison against the ISO cutoff selects older rows.
 */
export declare function pruneLedgerByRetention(db: DatabaseSync, spec: LedgerRetentionSpec, policy: LedgerRetentionPolicy | null, nowMs: number): number;
/**
 * Delete every row for one repo from a store (#5564). Unlike `pruneLedgerByRetention`, this never runs
 * automatically — it exists solely so `purge-cli.js` can give an operator a real right-to-be-forgotten path.
 * `repoFullName` is caller-normalized (owner/repo) before reaching here; this function only guards the SQL
 * identifiers, matching `pruneLedgerByRetention`'s own defence-in-depth discipline.
 */
export declare function purgeStoreByRepo(db: DatabaseSync, spec: LedgerPurgeSpec, repoFullName: string): number;
/**
 * Count rows for one repo in a store without deleting anything (#5564) — the read-only counterpart to
 * `purgeStoreByRepo`, used by `purge-cli.js --dry-run` to report what a real purge would remove.
 */
export declare function countStoreByRepo(db: DatabaseSync, spec: LedgerPurgeSpec, repoFullName: string): number;
