// Proactive schema-migration runner for the miner's local SQLite stores (#4871). Every store already applies
// its own pending migrations (schema-version.js's applySchemaMigrations) as a side effect of being opened by
// whatever command happens to touch it first -- this command instead lets an operator PROACTIVELY bring every
// known store's EXISTING on-disk file up to date in one pass (e.g. right after upgrading, or before starting a
// fleet), without needing to guess which command happens to touch which store first. Mirrors status.js's
// storeIntegrityChecks [name, resolve*DbPath(env)] store list exactly (same eleven stores `doctor` already
// covers, #6768), but actually OPENS each store (rather than a read-only integrity probe) so its real open/init
// function's migration path runs for real. A store file that does not exist yet is skipped, not created --
// "migrate" brings existing files up to date; it is not another way to bootstrap fresh state (that's `init`).
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readSchemaVersion } from "./schema-version.js";
import { argsWantJson, reportCliFailure } from "./cli-error.js";
import { openClaimLedger, resolveClaimLedgerDbPath } from "./claim-ledger.js";
import { initEventLedger, resolveEventLedgerDbPath } from "./event-ledger.js";
import { initGovernorLedger, resolveGovernorLedgerDbPath } from "./governor-ledger.js";
import { initPredictionLedger, resolvePredictionLedgerDbPath } from "./prediction-ledger.js";
import { initPortfolioQueueStore, resolvePortfolioQueueDbPath } from "./portfolio-queue.js";
import { initRunStateStore, resolveRunStateDbPath } from "./run-state.js";
import { openPlanStore, resolvePlanStoreDbPath } from "./plan-store.js";
import { openGovernorState, resolveGovernorStateDbPath } from "./governor-state.js";
import { initAttemptLog, resolveAttemptLogDbPath } from "./attempt-log.js";
import { openReplaySnapshotStore, resolveReplaySnapshotDbPath } from "./replay-snapshot.js";
import { openWorktreeAllocator, resolveWorktreeAllocatorDbPath } from "./worktree-allocator.js";
import { initContributionProfileCache, resolveContributionProfileCacheDbPath } from "./contribution-profile-cache.js";
import { initPolicyVerdictCacheStore, resolvePolicyVerdictCacheDbPath } from "./policy-verdict-cache.js";
import { initPolicyDocCacheStore, resolvePolicyDocCacheDbPath } from "./policy-doc-cache.js";
import { initRankedCandidatesStore, resolveRankedCandidatesDbPath } from "./ranked-candidates.js";
import { initDenyHookSynthesisStore, resolveDenyHookSynthesisDbPath } from "./deny-hook-synthesis.js";

const MIGRATE_USAGE = "Usage: loopover-miner migrate [--json]";

export type MigrateStatus = "skipped" | "up-to-date" | "migrated" | "failed";

export type MigrateResult = {
  name: string;
  dbPath: string;
  ok: boolean;
  status: MigrateStatus;
  detail: string;
  versionBefore: number | null;
  versionAfter: number | null;
};

export type MigrateStoreDescriptor = {
  name: string;
  resolveDbPath: (env?: Record<string, string | undefined>) => string;
  open: (dbPath: string) => { close: () => void };
};

const STORES: MigrateStoreDescriptor[] = [
  { name: "event-ledger", resolveDbPath: resolveEventLedgerDbPath, open: initEventLedger },
  { name: "governor-ledger", resolveDbPath: resolveGovernorLedgerDbPath, open: initGovernorLedger },
  { name: "prediction-ledger", resolveDbPath: resolvePredictionLedgerDbPath, open: initPredictionLedger },
  { name: "portfolio-queue", resolveDbPath: resolvePortfolioQueueDbPath, open: initPortfolioQueueStore },
  { name: "claim-ledger", resolveDbPath: resolveClaimLedgerDbPath, open: openClaimLedger },
  { name: "run-state", resolveDbPath: resolveRunStateDbPath, open: initRunStateStore },
  { name: "plan-store", resolveDbPath: resolvePlanStoreDbPath, open: openPlanStore },
  { name: "governor-state", resolveDbPath: resolveGovernorStateDbPath, open: openGovernorState },
  { name: "attempt-log", resolveDbPath: resolveAttemptLogDbPath, open: initAttemptLog },
  {
    name: "replay-snapshot",
    // resolveReplaySnapshotDbPath's own (not-yet-converted) .d.ts types `env` as `NodeJS.ProcessEnv`, unlike
    // every sibling resolver here (`Record<string, string | undefined>`) -- a pre-existing inconsistency, not
    // introduced by this batch. process.env genuinely satisfies both shapes at runtime, so this cast is safe.
    resolveDbPath: resolveReplaySnapshotDbPath as (env?: Record<string, string | undefined>) => string,
    open: openReplaySnapshotStore,
  },
  {
    name: "worktree-allocator",
    resolveDbPath: resolveWorktreeAllocatorDbPath,
    open: (dbPath: string) => openWorktreeAllocator({ dbPath }),
  },
  {
    name: "contribution-profile",
    resolveDbPath: resolveContributionProfileCacheDbPath,
    open: initContributionProfileCache,
  },
  { name: "policy-verdict-cache", resolveDbPath: resolvePolicyVerdictCacheDbPath, open: initPolicyVerdictCacheStore },
  { name: "policy-doc-cache", resolveDbPath: resolvePolicyDocCacheDbPath, open: initPolicyDocCacheStore },
  { name: "ranked-candidates", resolveDbPath: resolveRankedCandidatesDbPath, open: initRankedCandidatesStore },
  { name: "deny-hook-synthesis", resolveDbPath: resolveDenyHookSynthesisDbPath, open: initDenyHookSynthesisStore },
];

/** Read a store file's stamped schema version without ever creating it -- matches checkStoreIntegrity's
 *  "not created yet" convention: an absent file has nothing to report a version for. */
function peekSchemaVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return readSchemaVersion(db);
  } finally {
    db.close();
  }
}

/**
 * Bring one store's EXISTING on-disk schema up to date. Never throws: a store that fails to open/migrate is
 * reported as a failed result so one bad store cannot abort the whole sweep, matching doctor's per-store
 * isolation. A store file that does not exist yet is reported as a clean skip (nothing to migrate), never
 * created as a side effect of running this command.
 */
function migrateStore({ name, resolveDbPath, open }: MigrateStoreDescriptor, env?: Record<string, string | undefined>): MigrateResult {
  const dbPath = resolveDbPath(env);
  if (!existsSync(dbPath)) {
    return {
      name,
      dbPath,
      ok: true,
      status: "skipped",
      detail: "not created yet",
      versionBefore: null,
      versionAfter: null,
    };
  }
  // versionBefore is read INSIDE the same try as the migration itself: a corrupted file can throw on this very
  // first read (a store that can't even be opened has no readable version either), and that must still surface
  // as one failed store result rather than an uncaught exception aborting the whole sweep.
  let versionBefore: number | null = null;
  try {
    versionBefore = peekSchemaVersion(dbPath);
    const store = open(dbPath);
    store.close();
    const versionAfter = peekSchemaVersion(dbPath);
    return {
      name,
      dbPath,
      ok: true,
      status: versionAfter > versionBefore ? "migrated" : "up-to-date",
      detail: `v${versionBefore} -> v${versionAfter}`,
      versionBefore,
      versionAfter,
    };
  } catch (error) {
    // applySchemaMigrations applies AND stamps each migration in its OWN transaction, so a failure part-way
    // through a multi-migration sequence leaves the file at the LAST fully-applied version -- genuinely AHEAD
    // of versionBefore. Re-read the real on-disk version instead of reporting a misleading "nothing changed".
    // Guarded by its own try: the failure may itself be an unreadable/corrupt file (the same reason
    // versionBefore can still be null here), in which case the pre-failure reading is all we can honestly
    // report.
    let versionAfter = versionBefore;
    try {
      versionAfter = peekSchemaVersion(dbPath);
    } catch {
      versionAfter = versionBefore;
    }
    return {
      name,
      dbPath,
      ok: false,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
      versionBefore,
      versionAfter,
    };
  }
}

/** `stores` is injectable so tests can exercise a store descriptor's failure paths (e.g. a non-Error throw)
 *  without depending on real node:sqlite error shapes; defaults to the real seven-store list. */
export function runMigrateChecks(
  env: Record<string, string | undefined> = process.env,
  stores: MigrateStoreDescriptor[] = STORES,
): MigrateResult[] {
  return stores.map((store) => migrateStore(store, env));
}

export function runMigrate(args: string[] = [], env: Record<string, string | undefined> = process.env): number {
  const json = argsWantJson(args);
  // Validated BEFORE any store is opened: a typo'd flag must fail fast rather than silently run a full
  // migration sweep that ignored what the operator actually typed (#5917). `--json` is the only flag this
  // command takes, so anything else -- an unrecognized flag or a stray positional -- is rejected.
  const unknown = args.find((token) => token !== "--json");
  if (unknown !== undefined) return reportCliFailure(json, `Unknown option: ${unknown}. ${MIGRATE_USAGE}`, 2);

  const results = runMigrateChecks(env);
  const failed = results.filter((result) => !result.ok);
  if (json) {
    console.log(JSON.stringify({ ok: failed.length === 0, stores: results }, null, 2));
  } else {
    for (const result of results) {
      console.log(`${result.ok ? result.status.padEnd(10) : "FAIL      "} ${result.name}: ${result.detail}`);
    }
    if (failed.length > 0) console.error(`migrate: ${failed.length} store(s) failed`);
  }
  return failed.length === 0 ? 0 : 1;
}
