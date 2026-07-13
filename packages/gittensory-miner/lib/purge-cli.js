// `gittensory-miner purge` (#5564): an explicit, operator-invoked right-to-be-forgotten path across the local
// ledgers. Deletes every row for one repo from the four stores that have a real `repoColumn` (claim-ledger,
// event-ledger, governor-ledger, prediction-ledger), via each store's own `purgeByRepo` method (which reuses
// `store-maintenance.js`'s shared, identifier-guarded `purgeStoreByRepo`). `attempt-log.js` is deliberately
// reported as not-purgeable rather than silently skipped or approximated: its payload is a free-form
// `Record<string, unknown>` with no dedicated repo column, so a precise per-repo match isn't possible there
// without risking false matches -- see store-maintenance.js's own purge-spec doc comment.
//
// Every purge is audit-observable by design (#5564's own acceptance criteria): the real (non-dry-run) path
// always prints a per-store summary, even under --json, so a purge can never be silent. A failure in one store
// does not prevent reporting what succeeded in the others -- see purgeOneStore's own per-store try/catch.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openClaimLedger, resolveClaimLedgerDbPath } from "./claim-ledger.js";
import { initEventLedger, resolveEventLedgerDbPath } from "./event-ledger.js";
import { initGovernorLedger, resolveGovernorLedgerDbPath } from "./governor-ledger.js";
import { initPredictionLedger, resolvePredictionLedgerDbPath } from "./prediction-ledger.js";
import { resolveAttemptLogDbPath } from "./attempt-log.js";
import {
  CLAIM_LEDGER_PURGE_SPEC,
  EVENT_LEDGER_PURGE_SPEC,
  GOVERNOR_LEDGER_PURGE_SPEC,
  PREDICTION_LEDGER_PURGE_SPEC,
  countStoreByRepo,
  describeError,
} from "./store-maintenance.js";

const PURGE_USAGE = "Usage: gittensory-miner purge --repo <owner/repo> [--dry-run] [--json]";

export const ATTEMPT_LOG_NOT_PURGEABLE_NOTE =
  "attempt-log has no repoFullName column and cannot be purged by repo (#5564); its rows are unaffected";

const REAL_PURGE_TARGETS = [
  { name: "claim-ledger", optionKey: "openClaimLedger", opener: openClaimLedger, resolveDbPath: resolveClaimLedgerDbPath, spec: CLAIM_LEDGER_PURGE_SPEC },
  { name: "event-ledger", optionKey: "initEventLedger", opener: initEventLedger, resolveDbPath: resolveEventLedgerDbPath, spec: EVENT_LEDGER_PURGE_SPEC },
  { name: "governor-ledger", optionKey: "initGovernorLedger", opener: initGovernorLedger, resolveDbPath: resolveGovernorLedgerDbPath, spec: GOVERNOR_LEDGER_PURGE_SPEC },
  { name: "prediction-ledger", optionKey: "initPredictionLedger", opener: initPredictionLedger, resolveDbPath: resolvePredictionLedgerDbPath, spec: PREDICTION_LEDGER_PURGE_SPEC },
];

function parseRepoArg(value, usage) {
  if (!value) return { error: usage };
  const trimmed = value.trim();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) {
    return { error: "Repository must be in owner/repo form." };
  }
  return { repoFullName: `${owner}/${repo}` };
}

export function parsePurgeArgs(args) {
  const options = { json: false, dryRun: false, repoFullName: null };

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
  return options;
}

/** Read-only row count against an on-disk store file, for --dry-run. `{ readOnly: true }` (camelCase) is the
 *  only option node:sqlite recognizes for a driver-enforced read-only connection -- the lowercase `readonly`
 *  key is silently ignored. Never touches a store that doesn't exist yet (opening one -- even read-only --
 *  requires the file to already be there; a dry run must make zero writes). */
function countExistingRows(dbPath, countFn) {
  if (!existsSync(dbPath)) return 0;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return countFn(db);
  } finally {
    db.close();
  }
}

function renderDryRunSummary(result) {
  const purgeableLine = result.stores
    .map((entry) => `${entry.store}=${entry.wouldPurge}`)
    .join(", ");
  return [
    `DRY RUN: would purge ${result.repoFullName} from: ${purgeableLine}. No writes were made.`,
    `${ATTEMPT_LOG_NOT_PURGEABLE_NOTE} (${result.attemptLogTotalRows} total row(s) currently in attempt-log, all repos).`,
  ].join("\n");
}

export function runPurgeDryRun(parsed, options = {}) {
  const resolveDbPaths = options.resolveDbPaths ?? {};
  const stores = REAL_PURGE_TARGETS.map((target) => {
    const dbPath = (resolveDbPaths[target.name] ?? target.resolveDbPath)();
    try {
      const wouldPurge = countExistingRows(dbPath, (db) => countStoreByRepo(db, target.spec, parsed.repoFullName));
      return { store: target.name, wouldPurge };
    } catch (error) {
      return { store: target.name, wouldPurge: null, error: describeError(error) };
    }
  });

  const attemptLogDbPath = (resolveDbPaths["attempt-log"] ?? resolveAttemptLogDbPath)();
  const attemptLogTotalRows = countExistingRows(attemptLogDbPath, (db) =>
    Number(db.prepare("SELECT COUNT(*) AS count FROM attempt_log_events").get().count),
  );

  const result = {
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

function purgeOneStore(target, options, repoFullName) {
  const ownsStore = options[target.optionKey] === undefined;
  let store;
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

function renderPurgeSummary(summary) {
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

export function runPurge(args, options = {}) {
  const parsed = parsePurgeArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  if (parsed.dryRun) {
    return runPurgeDryRun(parsed, options);
  }

  const perStoreResults = REAL_PURGE_TARGETS.map((target) => purgeOneStore(target, options, parsed.repoFullName));
  perStoreResults.push({ store: "attempt-log", purged: null, note: ATTEMPT_LOG_NOT_PURGEABLE_NOTE });

  const totalPurged = perStoreResults.reduce((sum, entry) => sum + (entry.purged ?? 0), 0);
  const hadError = perStoreResults.some((entry) => "error" in entry);
  const summary = {
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
