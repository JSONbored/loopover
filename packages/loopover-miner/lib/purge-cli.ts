// `loopover-miner purge` (#5564, #6599): an explicit, operator-invoked right-to-be-forgotten path across the local
// ledgers. Deletes every row for one repo from the stores that have a real `repoColumn` (claim-ledger,
// event-ledger, governor-ledger, prediction-ledger, portfolio-queue, run-state, contribution-profile-cache,
// governor-state's two repo-scoped tables — #7091 — plus policy-verdict-cache — #6987 — and ranked-candidates,
// replay-snapshot, and deny-hook-synthesis — #8009 — and worktree-allocator's fixed-pool `worktree_slots` — #8320),
// via each store's own `purgeByRepo` method. Every store but worktree-allocator reuses `store-maintenance.js`'s
// shared, identifier-guarded `purgeStoreByRepo` (a hard DELETE); worktree-allocator hand-rolls an UPDATE instead,
// since deleting a fixed-pool slot row would break its own invariant that every slot index always exists.
// `attempt-log.js` is deliberately reported as not-purgeable rather than silently skipped or approximated: its
// payload is a free-form `Record<string, unknown>` with no dedicated repo column, so a precise per-repo match
// isn't possible there without risking false matches -- see store-maintenance.js's own purge-spec doc comment.
//
// Every purge is audit-observable by design (#5564's own acceptance criteria): the real (non-dry-run) path
// always prints a per-store summary, even under --json, so a purge can never be silent. A failure in one store
// does not prevent reporting what succeeded in the others -- see purgeOneStore's own per-store try/catch.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openClaimLedger, resolveClaimLedgerDbPath } from "./claim-ledger.js";
import type { ClaimLedger } from "./claim-ledger.js";
import { initEventLedger, resolveEventLedgerDbPath } from "./event-ledger.js";
import type { EventLedger } from "./event-ledger.js";
import { initGovernorLedger, resolveGovernorLedgerDbPath } from "./governor-ledger.js";
import type { GovernorLedger } from "./governor-ledger.js";
import { initPredictionLedger, resolvePredictionLedgerDbPath } from "./prediction-ledger.js";
import type { PredictionLedger } from "./prediction-ledger.js";
import { initPortfolioQueueStore, resolvePortfolioQueueDbPath } from "./portfolio-queue.js";
import type { PortfolioQueueStore } from "./portfolio-queue.js";
import { initRunStateStore, resolveRunStateDbPath } from "./run-state.js";
import type { RunStateStore } from "./run-state.js";
import { initContributionProfileCache, resolveContributionProfileCacheDbPath } from "./contribution-profile-cache.js";
import type { ContributionProfileCache } from "./contribution-profile-cache.js";
import { openGovernorState, resolveGovernorStateDbPath } from "./governor-state.js";
import type { GovernorState } from "./governor-state.js";
import { initPolicyVerdictCacheStore, resolvePolicyVerdictCacheDbPath } from "./policy-verdict-cache.js";
import type { PolicyVerdictCacheStore } from "./policy-verdict-cache.js";
import { initRankedCandidatesStore, resolveRankedCandidatesDbPath } from "./ranked-candidates.js";
import type { RankedCandidatesStore } from "./ranked-candidates.js";
import { openReplaySnapshotStore, resolveReplaySnapshotDbPath } from "./replay-snapshot.js";
import type { ReplaySnapshotStore } from "./replay-snapshot.js";
import { initDenyHookSynthesisStore, resolveDenyHookSynthesisDbPath } from "./deny-hook-synthesis.js";
import type { DenyHookSynthesisStore } from "./deny-hook-synthesis.js";
import { openWorktreeAllocator, resolveWorktreeAllocatorDbPath } from "./worktree-allocator.js";
import type { WorktreeAllocator } from "./worktree-allocator.js";
import { resolveAttemptLogDbPath } from "./attempt-log.js";
import {
  CLAIM_LEDGER_PURGE_SPEC,
  EVENT_LEDGER_PURGE_SPEC,
  GOVERNOR_LEDGER_PURGE_SPEC,
  PREDICTION_LEDGER_PURGE_SPEC,
  PORTFOLIO_QUEUE_PURGE_SPEC,
  RUN_STATE_PURGE_SPEC,
  CONTRIBUTION_PROFILE_CACHE_PURGE_SPEC,
  GOVERNOR_REPUTATION_HISTORY_PURGE_SPEC,
  GOVERNOR_OWN_SUBMISSIONS_PURGE_SPEC,
  POLICY_VERDICT_CACHE_PURGE_SPEC,
  RANKED_CANDIDATES_PURGE_SPEC,
  REPLAY_SNAPSHOT_PURGE_SPEC,
  DENY_HOOK_SYNTHESIS_PURGE_SPEC,
  countStoreByRepo,
  describeError,
} from "./store-maintenance.js";
import type { LedgerPurgeSpec } from "./store-maintenance.js";
import { argsWantJson, reportCliFailure } from "./cli-error.js";

const PURGE_USAGE = "Usage: loopover-miner purge --repo <owner/repo> [--dry-run] [--json]";

export const ATTEMPT_LOG_NOT_PURGEABLE_NOTE =
  "attempt-log has no repoFullName column and cannot be purged by repo (#5564); its rows are unaffected";

/** The shape every real purge target's opened store shares — all that `purgeOneStore`/`countExistingRows`
 *  actually need, regardless of which concrete store type a given target opens. */
type PurgeableStore = { purgeByRepo(repoFullName: string): number; close(): void };

type PurgeOpenerKey =
  | "openClaimLedger"
  | "initEventLedger"
  | "initGovernorLedger"
  | "initPredictionLedger"
  | "initPortfolioQueueStore"
  | "initRunStateStore"
  | "initContributionProfileCache"
  | "openGovernorState"
  | "initPolicyVerdictCacheStore"
  | "initRankedCandidatesStore"
  | "openReplaySnapshotStore"
  | "initDenyHookSynthesisStore"
  | "openWorktreeAllocator";

export type PurgeCliOptions = {
  openClaimLedger?: () => ClaimLedger;
  initEventLedger?: () => EventLedger;
  initGovernorLedger?: () => GovernorLedger;
  initPredictionLedger?: () => PredictionLedger;
  initPortfolioQueueStore?: () => PortfolioQueueStore;
  initRunStateStore?: () => RunStateStore;
  initContributionProfileCache?: () => ContributionProfileCache;
  openGovernorState?: () => GovernorState;
  initPolicyVerdictCacheStore?: () => PolicyVerdictCacheStore;
  initRankedCandidatesStore?: () => RankedCandidatesStore;
  openReplaySnapshotStore?: () => ReplaySnapshotStore;
  initDenyHookSynthesisStore?: () => DenyHookSynthesisStore;
  openWorktreeAllocator?: () => WorktreeAllocator;
  resolveDbPaths?: Record<string, () => string>;
};

type PurgeTarget = {
  name: string;
  optionKey: PurgeOpenerKey;
  opener: () => PurgeableStore;
  resolveDbPath: () => string;
  spec?: LedgerPurgeSpec;
  specs?: LedgerPurgeSpec[];
  // worktree-allocator's purge logic lives on the store object itself (a fixed-pool UPDATE, never a DELETE),
  // not a generic LedgerPurgeSpec -- so its dry-run preview needs its own read-only counting query instead of
  // the shared countStoreByRepo (#8320).
  countDryRun?: (db: DatabaseSync, repoFullName: string) => number;
};

// Mirrors worktree-allocator.ts's own purgeFreeByRepo match condition exactly (status = 'free' AND
// repo_full_name = ?) -- an active slot's row must never be counted as purgeable in dry-run either.
function countWorktreeAllocatorFreeByRepo(db: DatabaseSync, repoFullName: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM worktree_slots WHERE status = 'free' AND repo_full_name = ?")
    .get(repoFullName) as { count: number } | undefined;
  return Number(row?.count);
}

const REAL_PURGE_TARGETS: PurgeTarget[] = [
  { name: "claim-ledger", optionKey: "openClaimLedger", opener: openClaimLedger, resolveDbPath: resolveClaimLedgerDbPath, spec: CLAIM_LEDGER_PURGE_SPEC },
  { name: "event-ledger", optionKey: "initEventLedger", opener: initEventLedger, resolveDbPath: resolveEventLedgerDbPath, spec: EVENT_LEDGER_PURGE_SPEC },
  { name: "governor-ledger", optionKey: "initGovernorLedger", opener: initGovernorLedger, resolveDbPath: resolveGovernorLedgerDbPath, spec: GOVERNOR_LEDGER_PURGE_SPEC },
  { name: "prediction-ledger", optionKey: "initPredictionLedger", opener: initPredictionLedger, resolveDbPath: resolvePredictionLedgerDbPath, spec: PREDICTION_LEDGER_PURGE_SPEC },
  { name: "portfolio-queue", optionKey: "initPortfolioQueueStore", opener: initPortfolioQueueStore, resolveDbPath: resolvePortfolioQueueDbPath, spec: PORTFOLIO_QUEUE_PURGE_SPEC },
  { name: "run-state", optionKey: "initRunStateStore", opener: initRunStateStore, resolveDbPath: resolveRunStateDbPath, spec: RUN_STATE_PURGE_SPEC },
  { name: "contribution-profile-cache", optionKey: "initContributionProfileCache", opener: initContributionProfileCache, resolveDbPath: resolveContributionProfileCacheDbPath, spec: CONTRIBUTION_PROFILE_CACHE_PURGE_SPEC },
  // governor-state holds TWO repo-scoped tables in one DB file; its store.purgeByRepo deletes both against a
  // single handle (never reopening the file), and its dry-run count sums both via `specs` (#7091).
  { name: "governor-state", optionKey: "openGovernorState", opener: openGovernorState, resolveDbPath: resolveGovernorStateDbPath, specs: [GOVERNOR_REPUTATION_HISTORY_PURGE_SPEC, GOVERNOR_OWN_SUBMISSIONS_PURGE_SPEC] },
  { name: "policy-verdict-cache", optionKey: "initPolicyVerdictCacheStore", opener: initPolicyVerdictCacheStore, resolveDbPath: resolvePolicyVerdictCacheDbPath, spec: POLICY_VERDICT_CACHE_PURGE_SPEC },
  // Three more repo-scoped stores the earlier sweeps missed (#8009). deny-hook-synthesis's dry-run count works
  // on both pre- and post-forge-scope files: its live table is `deny_rule_proposals` either way, and the purge
  // filters on `repo_full_name` alone (all forge hosts), per its spec's own doc in store-maintenance.js.
  { name: "ranked-candidates", optionKey: "initRankedCandidatesStore", opener: initRankedCandidatesStore, resolveDbPath: resolveRankedCandidatesDbPath, spec: RANKED_CANDIDATES_PURGE_SPEC },
  { name: "replay-snapshot", optionKey: "openReplaySnapshotStore", opener: openReplaySnapshotStore, resolveDbPath: resolveReplaySnapshotDbPath, spec: REPLAY_SNAPSHOT_PURGE_SPEC },
  { name: "deny-hook-synthesis", optionKey: "initDenyHookSynthesisStore", opener: initDenyHookSynthesisStore, resolveDbPath: resolveDenyHookSynthesisDbPath, spec: DENY_HOOK_SYNTHESIS_PURGE_SPEC },
  // worktree_slots is a fixed pool of pre-allocated rows, not an append-only ledger -- no spec/specs field here;
  // the store's own purgeByRepo (an UPDATE that only ever touches a free slot) and countDryRun above are its
  // non-uniform equivalent, the same shape governor-state's `specs` field covers for its own non-uniform case.
  { name: "worktree-allocator", optionKey: "openWorktreeAllocator", opener: openWorktreeAllocator, resolveDbPath: resolveWorktreeAllocatorDbPath, countDryRun: countWorktreeAllocatorFreeByRepo },
];

export type ParsedPurgeArgs = { json: boolean; dryRun: boolean; repoFullName: string } | { error: string };

type ParsedRepoArg = { repoFullName: string } | { error: string };

function parseRepoArg(value: string | undefined, usage: string): ParsedRepoArg {
  if (!value) return { error: usage };
  const trimmed = value.trim();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) {
    return { error: "Repository must be in owner/repo form." };
  }
  return { repoFullName: `${owner}/${repo}` };
}

export function parsePurgeArgs(args: string[]): ParsedPurgeArgs {
  const options: { json: boolean; dryRun: boolean; repoFullName: string | null } = {
    json: false,
    dryRun: false,
    repoFullName: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--repo") {
      const repoArg = args[index + 1];
      // Only the flag-look-alike case is checked here ("--repo --json") -- a genuinely missing value (repoArg
      // undefined) falls through to parseRepoArg's own `!value` guard below, the single source of truth for that.
      if (repoArg !== undefined && repoArg.startsWith("-")) return { error: PURGE_USAGE };
      const repo = parseRepoArg(repoArg, PURGE_USAGE);
      if ("error" in repo) return repo;
      options.repoFullName = repo.repoFullName;
      index += 1;
      continue;
    }
    return { error: `Unknown option: ${token}` };
  }

  if (!options.repoFullName) return { error: PURGE_USAGE };
  return { json: options.json, dryRun: options.dryRun, repoFullName: options.repoFullName };
}

/** Read-only row count against an on-disk store file, for --dry-run. `{ readOnly: true }` (camelCase) is the
 *  only option node:sqlite recognizes for a driver-enforced read-only connection -- the lowercase `readonly`
 *  key is silently ignored. Never touches a store that doesn't exist yet (opening one -- even read-only --
 *  requires the file to already be there; a dry run must make zero writes). */
function countExistingRows(dbPath: string, countFn: (db: DatabaseSync) => number): number {
  if (!existsSync(dbPath)) return 0;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return countFn(db);
  } finally {
    db.close();
  }
}

export type PurgeDryRunStoreResult = { store: string; wouldPurge: number | null; error?: string };

export type PurgeDryRunResult = {
  outcome: "dry_run";
  repoFullName: string;
  stores: PurgeDryRunStoreResult[];
  attemptLogNote: string;
  attemptLogTotalRows: number;
};

function renderDryRunSummary(result: PurgeDryRunResult): string {
  const purgeableLine = result.stores
    .map((entry) => `${entry.store}=${entry.wouldPurge}`)
    .join(", ");
  return [
    `DRY RUN: would purge ${result.repoFullName} from: ${purgeableLine}. No writes were made.`,
    `${ATTEMPT_LOG_NOT_PURGEABLE_NOTE} (${result.attemptLogTotalRows} total row(s) currently in attempt-log, all repos).`,
  ].join("\n");
}

export function runPurgeDryRun(
  parsed: { repoFullName: string; json: boolean },
  options: PurgeCliOptions = {},
): number {
  const resolveDbPaths = options.resolveDbPaths ?? {};
  const stores: PurgeDryRunStoreResult[] = REAL_PURGE_TARGETS.map((target) => {
    const dbPath = (resolveDbPaths[target.name] ?? target.resolveDbPath)();
    try {
      // worktree-allocator's non-uniform match condition (free slots only) has its own counting query
      // (#8320) instead of a generic LedgerPurgeSpec; every other target scopes one table (`spec`) or --
      // for governor-state -- several in one file (`specs`), summed per-table against the single read-only
      // handle so the preview matches what a real purge removes.
      const wouldPurge = target.countDryRun
        ? countExistingRows(dbPath, (db) => target.countDryRun!(db, parsed.repoFullName))
        : countExistingRows(dbPath, (db) =>
            (target.specs ?? [target.spec!]).reduce((sum, spec) => sum + countStoreByRepo(db, spec, parsed.repoFullName), 0),
          );
      return { store: target.name, wouldPurge };
    } catch (error) {
      return { store: target.name, wouldPurge: null, error: describeError(error) };
    }
  });

  const attemptLogDbPath = (resolveDbPaths["attempt-log"] ?? resolveAttemptLogDbPath)();
  const attemptLogTotalRows = countExistingRows(attemptLogDbPath, (db) =>
    Number((db.prepare("SELECT COUNT(*) AS count FROM attempt_log_events").get() as { count: number }).count),
  );

  const result: PurgeDryRunResult = {
    outcome: "dry_run",
    repoFullName: parsed.repoFullName,
    stores,
    attemptLogNote: ATTEMPT_LOG_NOT_PURGEABLE_NOTE,
    attemptLogTotalRows,
  };

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderDryRunSummary(result));
  }
  return 0;
}

export type PurgeStoreResult = { store: string; purged: number | null; error?: string; note?: string };

function purgeOneStore(target: PurgeTarget, options: PurgeCliOptions, repoFullName: string): PurgeStoreResult {
  const ownsStore = options[target.optionKey] === undefined;
  let store: PurgeableStore | undefined;
  try {
    store = (options[target.optionKey] ?? target.opener)();
    const purged = store.purgeByRepo(repoFullName);
    return { store: target.name, purged };
  } catch (error) {
    return { store: target.name, purged: null, error: describeError(error) };
  } finally {
    if (ownsStore) store?.close();
  }
}

export type PurgeSummary = {
  outcome: "purged" | "partial";
  repoFullName: string;
  totalPurged: number;
  stores: PurgeStoreResult[];
  purgedAt: string;
};

function renderPurgeSummary(summary: PurgeSummary): string {
  const perStore = summary.stores
    .map((entry) => {
      if ("error" in entry) return `${entry.store}=ERROR(${entry.error})`;
      if (entry.purged === null) return `${entry.store}=skipped`;
      return `${entry.store}=${entry.purged}`;
    })
    .join(", ");
  return [
    `Purged ${summary.totalPurged} row(s) for ${summary.repoFullName} at ${summary.purgedAt}: ${perStore}.`,
    ATTEMPT_LOG_NOT_PURGEABLE_NOTE,
  ].join(" ");
}

export function runPurge(args: string[], options: PurgeCliOptions = {}): number {
  const parsed = parsePurgeArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  if (parsed.dryRun) {
    return runPurgeDryRun(parsed, options);
  }

  const perStoreResults: PurgeStoreResult[] = REAL_PURGE_TARGETS.map((target) =>
    purgeOneStore(target, options, parsed.repoFullName),
  );
  perStoreResults.push({ store: "attempt-log", purged: null, note: ATTEMPT_LOG_NOT_PURGEABLE_NOTE });

  const totalPurged = perStoreResults.reduce((sum, entry) => sum + (entry.purged ?? 0), 0);
  const hadError = perStoreResults.some((entry) => "error" in entry);
  const summary: PurgeSummary = {
    outcome: hadError ? "partial" : "purged",
    repoFullName: parsed.repoFullName,
    totalPurged,
    stores: perStoreResults,
    purgedAt: new Date().toISOString(),
  };

  // Audit-observable by design (#5564): print the summary in BOTH the success and partial-failure case, so a
  // purge -- or a purge that only partly succeeded -- is never silent.
  if (parsed.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(renderPurgeSummary(summary));
  }
  return hadError ? 2 : 0;
}
