import { initEventLedger } from "./event-ledger.js";
import { initPortfolioQueueStore } from "./portfolio-queue.js";

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

export function parseManageStatusArgs(args = []) {
  for (const token of args) {
    if (token === "--json") continue;
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    return { error: "Usage: gittensory-miner manage status [--json]" };
  }
  return { json: args.includes("--json") };
}

export function runManageStatus(args = [], options = {}) {
  const parsed = parseManageStatusArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  const ownsPortfolioQueue = options.initPortfolioQueue === undefined;
  const ownsEventLedger = options.initEventLedger === undefined;
  const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
  const eventLedger = (options.initEventLedger ?? initEventLedger)();
  try {
    const rows = collectManageStatus({ portfolioQueue, eventLedger });
    if (parsed.json) {
      console.log(JSON.stringify({ rows }, null, 2));
    } else {
      console.log(renderManageStatusTable(rows));
    }
    return 0;
  } finally {
    if (ownsPortfolioQueue) portfolioQueue.close();
    if (ownsEventLedger) eventLedger.close();
  }
}
