// Local-store backup/restore for the miner (#4872). No backup/restore tooling existed for AMS state, unlike
// the main product's dedicated backup scripts -- docs/operations-runbook.md already told operators to hand-run
// `tar -czf ...` (or SQLite's own `.backup` command, since "never copy a live SQLite file" while the miner is
// running) as part of the upgrade checklist; this formalizes that into a real command using the SAME safe
// mechanism the runbook already recommends: node:sqlite's `backup()`, which uses SQLite's online backup API
// and is safe to run against a store the miner still has open, unlike a naive file copy of a live database.
// Mirrors migrate-cli.js's store list and per-store isolation (one bad store never aborts the whole sweep).
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { resolveLaptopStateDbPath } from "./laptop-init.js";
import { resolveClaimLedgerDbPath } from "./claim-ledger.js";
import { resolveEventLedgerDbPath } from "./event-ledger.js";
import { resolveGovernorLedgerDbPath } from "./governor-ledger.js";
import { resolvePredictionLedgerDbPath } from "./prediction-ledger.js";
import { resolvePortfolioQueueDbPath } from "./portfolio-queue.js";
import { resolveRunStateDbPath } from "./run-state.js";
import { resolvePlanStoreDbPath } from "./plan-store.js";

const STORES = [
  { name: "laptop-state", resolveDbPath: resolveLaptopStateDbPath },
  { name: "event-ledger", resolveDbPath: resolveEventLedgerDbPath },
  { name: "governor-ledger", resolveDbPath: resolveGovernorLedgerDbPath },
  { name: "prediction-ledger", resolveDbPath: resolvePredictionLedgerDbPath },
  { name: "portfolio-queue", resolveDbPath: resolvePortfolioQueueDbPath },
  { name: "claim-ledger", resolveDbPath: resolveClaimLedgerDbPath },
  { name: "run-state", resolveDbPath: resolveRunStateDbPath },
  { name: "plan-store", resolveDbPath: resolvePlanStoreDbPath },
];

function backupFileName(storeName) {
  return `${storeName}.sqlite3`;
}

/**
 * Back up one store's EXISTING on-disk file, using node:sqlite's online backup API (safe against a store the
 * miner still has open -- never a raw file copy of a live database). A store that does not exist yet is
 * skipped, not created.
 */
async function backupStore({ name, resolveDbPath }, destDir, env) {
  // sourcePath/destPath are resolved INSIDE the same try as the backup itself: resolveDbPath is caller-supplied
  // (injectable for tests) and could throw, and that must still surface as one failed store result rather than
  // an uncaught exception aborting the whole sweep (the same class of bug migrate-cli.js's own migrateStore
  // fixed for #4871 -- resolution must never happen outside the try).
  let sourcePath;
  let destPath;
  let sourceDb;
  try {
    sourcePath = resolveDbPath(env);
    destPath = join(destDir, backupFileName(name));
    if (!existsSync(sourcePath)) {
      return { name, ok: true, status: "skipped", detail: "not created yet", sourcePath, destPath };
    }
    sourceDb = new DatabaseSync(sourcePath, { readOnly: true });
    const pagesCopied = await backup(sourceDb, destPath);
    chmodSync(destPath, 0o600);
    return { name, ok: true, status: "backed-up", detail: `${pagesCopied} page(s)`, sourcePath, destPath };
  } catch (error) {
    return {
      name,
      ok: false,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
      sourcePath: sourcePath ?? null,
      destPath: destPath ?? null,
    };
  } finally {
    sourceDb?.close();
  }
}

/**
 * Restore one store's file from a previously-created backup directory into its real, live path. The backup
 * file itself is static (not a live database), so a plain file copy is safe here -- unlike backing up a live
 * store, restoring never needs the online backup API. Refuses to overwrite an existing destination file unless
 * `force` is set, so a restore can never silently clobber current state by accident. A store with no matching
 * backup file in `srcDir` is skipped.
 */
function restoreStore({ name, resolveDbPath }, srcDir, env, force) {
  // sourcePath is a plain join() of caller-controlled strings -- it cannot itself throw, so it's resolved
  // once, up front, and is always defined by the time the catch below runs. destPath's resolution (via the
  // injectable, possibly-throwing resolveDbPath) happens INSIDE the try for the same reason backupStore's does.
  const sourcePath = join(srcDir, backupFileName(name));
  let destPath;
  try {
    destPath = resolveDbPath(env);
    if (!existsSync(sourcePath)) {
      return { name, ok: true, status: "skipped", detail: "no backup file found", sourcePath, destPath };
    }
    if (existsSync(destPath) && !force) {
      return {
        name,
        ok: false,
        status: "exists",
        detail: `${destPath} already exists; pass --force to overwrite`,
        sourcePath,
        destPath,
      };
    }
    mkdirSync(dirname(destPath), { recursive: true, mode: 0o700 });
    copyFileSync(sourcePath, destPath);
    chmodSync(destPath, 0o600);
    return { name, ok: true, status: "restored", detail: destPath, sourcePath, destPath };
  } catch (error) {
    return {
      name,
      ok: false,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
      sourcePath,
      destPath: destPath ?? null,
    };
  }
}

/** `stores` is injectable so tests can exercise a store descriptor's failure paths (e.g. a non-Error throw)
 *  without depending on real node:sqlite/node:fs error shapes; defaults to the real eight-store list. */
export async function runBackupChecks(destDir, env = process.env, stores = STORES) {
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const results = [];
  for (const store of stores) results.push(await backupStore(store, destDir, env));
  return results;
}

export function runRestoreChecks(srcDir, env = process.env, force = false, stores = STORES) {
  return stores.map((store) => restoreStore(store, srcDir, env, force));
}

function printResults(results, jsonOutput, ok) {
  if (jsonOutput) {
    console.log(JSON.stringify({ ok, stores: results }, null, 2));
    return;
  }
  for (const result of results) {
    console.log(`${result.ok ? result.status.padEnd(10) : "FAIL      "} ${result.name}: ${result.detail}`);
  }
}

export async function runBackup(args = [], env = process.env) {
  const jsonOutput = args.includes("--json");
  const destDir = args.find((arg) => !arg.startsWith("-"));
  if (!destDir) {
    console.error("Usage: gittensory-miner backup <destDir> [--json]");
    return 2;
  }
  const results = await runBackupChecks(destDir, env);
  const failed = results.filter((result) => !result.ok);
  printResults(results, jsonOutput, failed.length === 0);
  if (failed.length > 0 && !jsonOutput) console.error(`backup: ${failed.length} store(s) failed`);
  return failed.length === 0 ? 0 : 1;
}

export function runRestore(args = [], env = process.env) {
  const jsonOutput = args.includes("--json");
  const force = args.includes("--force");
  const srcDir = args.find((arg) => !arg.startsWith("-"));
  if (!srcDir) {
    console.error("Usage: gittensory-miner restore <srcDir> [--force] [--json]");
    return 2;
  }
  const results = runRestoreChecks(srcDir, env, force);
  const failed = results.filter((result) => !result.ok);
  printResults(results, jsonOutput, failed.length === 0);
  if (failed.length > 0 && !jsonOutput) console.error(`restore: ${failed.length} store(s) failed`);
  return failed.length === 0 ? 0 : 1;
}
