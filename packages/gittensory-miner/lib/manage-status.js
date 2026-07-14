import { initEventLedger } from "./event-ledger.js";
import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { initRunStateStore } from "./run-state.js";
import { argsWantJson, reportCliFailure } from "./cli-error.js";

/** Event vocabulary for manage-phase PR snapshots written by manage poll. (#2325) */
export const MANAGE_PR_UPDATE_EVENT = "manage_pr_update";
export const MANAGED_PR_IDENTIFIER_PREFIX = "pr:";

export function parseManagedPrIdentifier(identifier) {
  if (typeof identifier !== "string") return null;
  const match = identifier.match(/^pr:(\d+)$/);
  if (!match) return null;
  const prNumber = Number(match[1]);
  return Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null;
}

export function formatManagedPrIdentifier(prNumber) {
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error("invalid_pr_number");
  return `${MANAGED_PR_IDENTIFIER_PREFIX}${prNumber}`;
}

function optionalString(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeManageUpdatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (!Number.isInteger(payload.prNumber) || payload.prNumber <= 0) return null;
  return {
    prNumber: payload.prNumber,
    branch: optionalString(payload.branch),
    ciState: optionalString(payload.ciState),
    gateVerdict: optionalString(payload.gateVerdict),
    outcome: optionalString(payload.outcome),
    lastPolledAt: optionalString(payload.lastPolledAt),
  };
}

/** Index the latest manage snapshot per repo/PR from ascending ledger events. Pure. */
export function indexLatestManageUpdates(events) {
  const latest = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== MANAGE_PR_UPDATE_EVENT) continue;
    if (typeof event.repoFullName !== "string" || !event.repoFullName.trim()) continue;
    const normalized = normalizeManageUpdatePayload(event.payload);
    if (!normalized) continue;
    const key = `${event.repoFullName}:${normalized.prNumber}`;
    latest.set(key, { ...normalized, repoFullName: event.repoFullName });
  }
  return latest;
}

/**
 * Aggregate managed PR rows from the local portfolio queue and append-only event ledger. Read-only — never calls
 * GitHub or mutates local stores. (#2325)
 */
export function collectManageStatus(sources) {
  const portfolioQueue = sources?.portfolioQueue;
  const eventLedger = sources?.eventLedger;
  if (!portfolioQueue || typeof portfolioQueue.listQueue !== "function") {
    throw new Error("invalid_portfolio_queue");
  }
  if (!eventLedger || typeof eventLedger.readEvents !== "function") {
    throw new Error("invalid_event_ledger");
  }

  const rowsByKey = new Map();
  for (const entry of portfolioQueue.listQueue(null)) {
    const prNumber = parseManagedPrIdentifier(entry.identifier);
    if (prNumber === null) continue;
    const key = `${entry.repoFullName}:${prNumber}`;
    rowsByKey.set(key, {
      repoFullName: entry.repoFullName,
      prNumber,
      branch: null,
      ciState: null,
      gateVerdict: null,
      outcome: null,
      lastPolledAt: null,
      queueStatus: entry.status,
      priority: entry.priority,
    });
  }

  for (const [key, update] of indexLatestManageUpdates(eventLedger.readEvents())) {
    const existing = rowsByKey.get(key);
    rowsByKey.set(key, {
      repoFullName: update.repoFullName,
      prNumber: update.prNumber,
      branch: update.branch,
      ciState: update.ciState,
      gateVerdict: update.gateVerdict,
      outcome: update.outcome,
      lastPolledAt: update.lastPolledAt,
      queueStatus: existing?.queueStatus ?? null,
      priority: existing?.priority ?? null,
    });
  }

  return [...rowsByKey.values()].sort((left, right) => {
    const repoCmp = left.repoFullName.localeCompare(right.repoFullName);
    if (repoCmp !== 0) return repoCmp;
    return left.prNumber - right.prNumber;
  });
}

/**
 * Fold each tracked repo's current discover/plan/prepare run state alongside its managed PR rows into one
 * "run portfolio" row per repo (#4279). `collectManageStatus` alone is PR-scoped only and never surfaces the
 * run-state signal, so a repo actively discovering/planning with zero PRs yet is otherwise invisible. A repo
 * appears here if it has EITHER a recorded run state OR at least one managed PR row.
 */
export function collectRunPortfolio(sources) {
  const runStateStore = sources?.runStateStore;
  if (!runStateStore || typeof runStateStore.listRunStates !== "function") {
    throw new Error("invalid_run_state_store");
  }
  const prsByRepo = new Map();
  for (const row of collectManageStatus(sources)) {
    const list = prsByRepo.get(row.repoFullName) ?? [];
    list.push(row);
    prsByRepo.set(row.repoFullName, list);
  }
  // NOTE (#5563): keyed by repoFullName alone, not apiBaseUrl -- this dashboard fold predates multi-forge run
  // states and produces exactly ONE row per repo name. If the same repo name has a recorded run state on two
  // different hosts, only one (the later entry in listRunStates' order) survives here; the other's row is still
  // intact in the store, just not surfaced in this particular view. Safe (no data loss, no write), just a display
  // limitation -- broadening this fold to be host-aware is a separate, larger dashboard-shape change.
  const runStateByRepo = new Map(runStateStore.listRunStates().map((entry) => [entry.repoFullName, entry]));

  const repoFullNames = new Set([...prsByRepo.keys(), ...runStateByRepo.keys()]);
  return [...repoFullNames].sort((left, right) => left.localeCompare(right)).map((repoFullName) => {
    const prs = prsByRepo.get(repoFullName) ?? [];
    const runState = runStateByRepo.get(repoFullName);
    return {
      repoFullName,
      runState: runState?.state ?? null,
      runStateUpdatedAt: runState?.updatedAt ?? null,
      prCount: prs.length,
      prs,
    };
  });
}

function display(value) {
  if (value === null || value === undefined) return "-";
  return String(value);
}

export function renderManageStatusTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "no managed pull requests";
  const header = [
    "repo".padEnd(24),
    "pr".padStart(4),
    "branch".padEnd(16),
    "ci".padEnd(10),
    "gate".padEnd(10),
    "outcome".padEnd(10),
    "last-polled".padEnd(20),
    "queue".padEnd(12),
    "pri".padStart(4),
  ].join(" ");
  const lines = rows.map((row) =>
    [
      row.repoFullName.padEnd(24),
      String(row.prNumber).padStart(4),
      display(row.branch).padEnd(16),
      display(row.ciState).padEnd(10),
      display(row.gateVerdict).padEnd(10),
      display(row.outcome).padEnd(10),
      display(row.lastPolledAt).padEnd(20),
      display(row.queueStatus).padEnd(12),
      display(row.priority).padStart(4),
    ].join(" "),
  );
  return [header, ...lines].join("\n");
}

/** One row per tracked repo (run state + PR count), the compact companion to {@link renderManageStatusTable}'s
 *  per-PR detail (#4279). */
export function renderRunPortfolioTable(portfolio) {
  if (!Array.isArray(portfolio) || portfolio.length === 0) return "no tracked repos";
  const header = [
    "repo".padEnd(24),
    "run-state".padEnd(12),
    "updated".padEnd(20),
    "prs".padStart(4),
  ].join(" ");
  const lines = portfolio.map((entry) =>
    [
      entry.repoFullName.padEnd(24),
      display(entry.runState).padEnd(12),
      display(entry.runStateUpdatedAt).padEnd(20),
      String(entry.prCount).padStart(4),
    ].join(" "),
  );
  return [header, ...lines].join("\n");
}

export function parseManageStatusArgs(args = []) {
  for (const token of args) {
    if (token === "--json") continue;
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    return { error: "Usage: loopover-miner manage status [--json]" };
  }
  return { json: args.includes("--json") };
}

export function runManageStatus(args = [], options = {}) {
  const parsed = parseManageStatusArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  const ownsPortfolioQueue = options.initPortfolioQueue === undefined;
  const ownsEventLedger = options.initEventLedger === undefined;
  const ownsRunStateStore = options.initRunStateStore === undefined;
  const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
  const eventLedger = (options.initEventLedger ?? initEventLedger)();
  const runStateStore = (options.initRunStateStore ?? initRunStateStore)();
  try {
    const rows = collectManageStatus({ portfolioQueue, eventLedger });
    const runPortfolio = collectRunPortfolio({ portfolioQueue, eventLedger, runStateStore });
    if (parsed.json) {
      // Additive only (#4279): `rows` keeps its existing shape unchanged; `runPortfolio` is a new key so an
      // existing consumer parsing this JSON for `rows` alone sees byte-identical output.
      console.log(JSON.stringify({ rows, runPortfolio }, null, 2));
    } else {
      console.log(`${renderManageStatusTable(rows)}\n\n${renderRunPortfolioTable(runPortfolio)}`);
    }
    return 0;
  } finally {
    if (ownsPortfolioQueue) portfolioQueue.close();
    if (ownsEventLedger) eventLedger.close();
    if (ownsRunStateStore) runStateStore.close();
  }
}
