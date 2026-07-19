// Read-only portfolio-queue dashboard (#4287). Aggregates the miner's OWN local portfolio-queue backlog
// (packages/loopover-miner/lib/portfolio-queue.js) into summary stats — counts by status globally and per repo,
// plus the oldest queued item's age. Same three-layer shape as manage-status.js (pure collect → pure render → thin
// CLI glue), but scoped to the backlog/queue rather than per-PR manage state. 100% client-side, read-only — it never
// mutates queue state and never gates or enforces anything.
//
// The extension-panel half named in the issue is a forward dependency, not delivered here: the miner's queue is a
// local SQLite file with no local-reachable channel a GitHub-page content script can read today. The pure
// collector below is factored so it is directly reusable once such a channel exists.
import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { argsWantJson, reportCliFailure } from "./cli-error.js";
const QUEUE_STATUS_KEYS = ["queued", "in_progress", "done"];
function emptyCounts() {
    return { queued: 0, in_progress: 0, done: 0 };
}
function isQueueStatusKey(status) {
    return typeof status === "string" && QUEUE_STATUS_KEYS.includes(status);
}
/**
 * Pure aggregator over an injected portfolio-queue store (mirrors manage-status.js's `collectManageStatus`).
 * Read-only. Returns global + per-repo status counts and, when a clock is supplied via `options.nowMs`, the age in
 * ms of the oldest still-`queued` item (null when no clock is given or nothing is queued).
 */
export function collectPortfolioDashboard(sources, options = {}) {
    const portfolioQueue = sources?.portfolioQueue;
    if (!portfolioQueue || typeof portfolioQueue.listQueue !== "function")
        throw new Error("invalid_portfolio_queue");
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : null;
    const byStatus = emptyCounts();
    const perRepo = new Map();
    let total = 0;
    let oldestQueuedMs = null;
    for (const raw of portfolioQueue.listQueue(null)) {
        const entry = raw;
        const status = entry?.status;
        if (!isQueueStatusKey(status))
            continue;
        const repoFullName = typeof entry.repoFullName === "string" ? entry.repoFullName : "";
        // #7225: key per-repo backlogs by (apiBaseUrl, repoFullName) so two forge hosts sharing a repo name keep
        // independent counts instead of silently merging. The composite map key uses "\n" — never valid in either
        // component — so distinct (host, repo) pairs can never collide.
        const apiBaseUrl = typeof entry.apiBaseUrl === "string" ? entry.apiBaseUrl : "";
        total += 1;
        byStatus[status] += 1;
        const key = `${apiBaseUrl}\n${repoFullName}`;
        let repo = perRepo.get(key);
        if (!repo) {
            repo = { apiBaseUrl, repoFullName, byStatus: emptyCounts(), total: 0 };
            perRepo.set(key, repo);
        }
        repo.byStatus[status] += 1;
        repo.total += 1;
        if (status === "queued") {
            const ms = Date.parse(String(entry.enqueuedAt));
            if (Number.isFinite(ms) && (oldestQueuedMs === null || ms < oldestQueuedMs))
                oldestQueuedMs = ms;
        }
    }
    const repos = [...perRepo.values()].sort((left, right) => left.repoFullName.localeCompare(right.repoFullName) || left.apiBaseUrl.localeCompare(right.apiBaseUrl));
    const oldestQueuedAgeMs = nowMs !== null && oldestQueuedMs !== null ? Math.max(0, nowMs - oldestQueuedMs) : null;
    return { total, byStatus, repos, oldestQueuedAgeMs };
}
/** Plain-text render of a dashboard summary (mirrors manage-status.js's `renderManageStatusTable`). */
export function renderPortfolioDashboardTable(summary) {
    if (!summary || summary.total === 0)
        return "portfolio queue is empty";
    const age = summary.oldestQueuedAgeMs !== null ? `  oldest-queued: ${Math.round(summary.oldestQueuedAgeMs / 60000)}m` : "";
    const header = [
        "repo".padEnd(28),
        "host".padEnd(30),
        "queued".padStart(7),
        "in_prog".padStart(8),
        "done".padStart(6),
        "total".padStart(6),
    ].join(" ");
    const lines = summary.repos.map((repo) => [
        repo.repoFullName.padEnd(28),
        String(repo.apiBaseUrl).padEnd(30),
        String(repo.byStatus.queued).padStart(7),
        String(repo.byStatus.in_progress).padStart(8),
        String(repo.byStatus.done).padStart(6),
        String(repo.total).padStart(6),
    ].join(" "));
    return [
        `total: ${summary.total}  queued: ${summary.byStatus.queued}  in_progress: ${summary.byStatus.in_progress}  done: ${summary.byStatus.done}${age}`,
        "",
        header,
        ...lines,
    ].join("\n");
}
export function parsePortfolioDashboardArgs(args = []) {
    for (const token of args) {
        if (token === "--json")
            continue;
        if (token.startsWith("-"))
            return { error: `Unknown option: ${token}` };
        return { error: "Usage: loopover-miner queue dashboard [--json]" };
    }
    return { json: args.includes("--json") };
}
/** CLI glue for `loopover-miner queue dashboard [--json]` (mirrors manage-status.js's `runManageStatus`). */
export function runPortfolioDashboard(args = [], options = {}) {
    const parsed = parsePortfolioDashboardArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    const ownsQueue = options.initPortfolioQueue === undefined;
    const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
    try {
        const summary = collectPortfolioDashboard({ portfolioQueue }, { nowMs: Number.isFinite(options.nowMs) ? options.nowMs : Date.now() });
        console.log(parsed.json ? JSON.stringify(summary, null, 2) : renderPortfolioDashboardTable(summary));
        return 0;
    }
    finally {
        if (ownsQueue)
            portfolioQueue.close();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicG9ydGZvbGlvLWRhc2hib2FyZC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInBvcnRmb2xpby1kYXNoYm9hcmQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsd0dBQXdHO0FBQ3hHLGdIQUFnSDtBQUNoSCxtSEFBbUg7QUFDbkgscUhBQXFIO0FBQ3JILDREQUE0RDtBQUM1RCxFQUFFO0FBQ0Ysa0hBQWtIO0FBQ2xILDBHQUEwRztBQUMxRyxxRkFBcUY7QUFFckYsT0FBTyxFQUFFLHVCQUF1QixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFDL0QsT0FBTyxFQUFFLFlBQVksRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBRWhFLE1BQU0saUJBQWlCLEdBQUcsQ0FBQyxRQUFRLEVBQUUsYUFBYSxFQUFFLE1BQU0sQ0FBVSxDQUFDO0FBNEJyRSxTQUFTLFdBQVc7SUFDbEIsT0FBTyxFQUFFLE1BQU0sRUFBRSxDQUFDLEVBQUUsV0FBVyxFQUFFLENBQUMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxFQUFFLENBQUM7QUFDaEQsQ0FBQztBQUVELFNBQVMsZ0JBQWdCLENBQUMsTUFBZTtJQUN2QyxPQUFPLE9BQU8sTUFBTSxLQUFLLFFBQVEsSUFBSyxpQkFBdUMsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUM7QUFDakcsQ0FBQztBQUVEOzs7O0dBSUc7QUFDSCxNQUFNLFVBQVUseUJBQXlCLENBQ3ZDLE9BQWtDLEVBQ2xDLFVBQThCLEVBQUU7SUFFaEMsTUFBTSxjQUFjLEdBQUcsT0FBTyxFQUFFLGNBQWMsQ0FBQztJQUMvQyxJQUFJLENBQUMsY0FBYyxJQUFJLE9BQU8sY0FBYyxDQUFDLFNBQVMsS0FBSyxVQUFVO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyx5QkFBeUIsQ0FBQyxDQUFDO0lBQ2xILE1BQU0sS0FBSyxHQUFHLE1BQU0sQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBRSxPQUFP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