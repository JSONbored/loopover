import { initEventLedger } from "./event-ledger.js";
import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { initRunStateStore } from "./run-state.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
/** Event vocabulary for manage-phase PR snapshots written by manage poll. (#2325) */
export const MANAGE_PR_UPDATE_EVENT = "manage_pr_update";
export const MANAGED_PR_IDENTIFIER_PREFIX = "pr:";
export function parseManagedPrIdentifier(identifier) {
    if (typeof identifier !== "string")
        return null;
    const match = identifier.match(/^pr:(\d+)$/);
    if (!match)
        return null;
    const prNumber = Number(match[1]);
    return Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null;
}
export function formatManagedPrIdentifier(prNumber) {
    if (!Number.isInteger(prNumber) || prNumber <= 0)
        throw new Error("invalid_pr_number");
    return `${MANAGED_PR_IDENTIFIER_PREFIX}${prNumber}`;
}
function optionalString(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return trimmed || null;
}
function normalizeManageUpdatePayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return null;
    const p = payload;
    if (!Number.isInteger(p.prNumber) || p.prNumber <= 0)
        return null;
    return {
        prNumber: p.prNumber,
        branch: optionalString(p.branch),
        ciState: optionalString(p.ciState),
        gateVerdict: optionalString(p.gateVerdict),
        outcome: optionalString(p.outcome),
        lastPolledAt: optionalString(p.lastPolledAt),
    };
}
/** Index the latest manage snapshot per repo/PR from ascending ledger events. Pure. */
export function indexLatestManageUpdates(events) {
    const latest = new Map();
    for (const event of Array.isArray(events) ? events : []) {
        if (event?.type !== MANAGE_PR_UPDATE_EVENT)
            continue;
        if (typeof event.repoFullName !== "string" || !event.repoFullName.trim())
            continue;
        const normalized = normalizeManageUpdatePayload(event.payload);
        if (!normalized)
            continue;
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
        if (prNumber === null)
            continue;
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
        if (repoCmp !== 0)
            return repoCmp;
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
    if (value === null || value === undefined)
        return "-";
    return String(value);
}
export function renderManageStatusTable(rows) {
    if (!Array.isArray(rows) || rows.length === 0)
        return "no managed pull requests";
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
    const lines = rows.map((row) => [
        row.repoFullName.padEnd(24),
        String(row.prNumber).padStart(4),
        display(row.branch).padEnd(16),
        display(row.ciState).padEnd(10),
        display(row.gateVerdict).padEnd(10),
        display(row.outcome).padEnd(10),
        display(row.lastPolledAt).padEnd(20),
        display(row.queueStatus).padEnd(12),
        display(row.priority).padStart(4),
    ].join(" "));
    return [header, ...lines].join("\n");
}
/** One row per tracked repo (run state + PR count), the compact companion to {@link renderManageStatusTable}'s
 *  per-PR detail (#4279). */
export function renderRunPortfolioTable(portfolio) {
    if (!Array.isArray(portfolio) || portfolio.length === 0)
        return "no tracked repos";
    const header = [
        "repo".padEnd(24),
        "run-state".padEnd(12),
        "updated".padEnd(20),
        "prs".padStart(4),
    ].join(" ");
    const lines = portfolio.map((entry) => [
        entry.repoFullName.padEnd(24),
        display(entry.runState).padEnd(12),
        display(entry.runStateUpdatedAt).padEnd(20),
        String(entry.prCount).padStart(4),
    ].join(" "));
    return [header, ...lines].join("\n");
}
export function parseManageStatusArgs(args = []) {
    for (const token of args) {
        if (token === "--json")
            continue;
        if (token.startsWith("-"))
            return { error: `Unknown option: ${token}` };
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
        }
        else {
            console.log(`${renderManageStatusTable(rows)}\n\n${renderRunPortfolioTable(runPortfolio)}`);
        }
        return 0;
    }
    catch (error) {
        // Collecting/rendering manage status touches three SQLite stores; a read/render failure must surface as a
        // clean CLI error (honoring --json), not an unhandled throw -- matching runOrbExportCli / runQueueList (#7236).
        return reportCliFailure(parsed.json, describeCliError(error));
    }
    finally {
        if (ownsPortfolioQueue)
            portfolioQueue.close();
        if (ownsEventLedger)
            eventLedger.close();
        if (ownsRunStateStore)
            runStateStore.close();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFuYWdlLXN0YXR1cy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1hbmFnZS1zdGF0dXMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQ0EsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBRXBELE9BQU8sRUFBRSx1QkFBdUIsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBRS9ELE9BQU8sRUFBRSxpQkFBaUIsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBQ25ELE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUVsRixxRkFBcUY7QUFDckYsTUFBTSxDQUFDLE1BQU0sc0JBQXNCLEdBQUcsa0JBQWtCLENBQUM7QUFDekQsTUFBTSxDQUFDLE1BQU0sNEJBQTRCLEdBQUcsS0FBSyxDQUFDO0FBeUNsRCxNQUFNLFVBQVUsd0JBQXdCLENBQUMsVUFBa0I7SUFDekQsSUFBSSxPQUFPLFVBQVUsS0FBSyxRQUFRO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDaEQsTUFBTSxLQUFLLEdBQUcsVUFBVSxDQUFDLEtBQUssQ0FBQyxZQUFZLENBQUMsQ0FBQztJQUM3QyxJQUFJLENBQUMsS0FBSztRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3hCLE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNsQyxPQUFPLE1BQU0sQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLElBQUksUUFBUSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDdEUsQ0FBQztBQUVELE1BQU0sVUFBVSx5QkFBeUIsQ0FBQyxRQUFnQjtJQUN4RCxJQUFJLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsSUFBSSxRQUFRLElBQUksQ0FBQztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsbUJBQW1C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