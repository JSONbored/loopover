import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { initPortfolioQueueManager } from "./portfolio-queue-manager.js";
import { runPortfolioDashboard } from "./portfolio-dashboard.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
const QUEUE_LIST_USAGE = "Usage: loopover-miner queue list [--repo <owner/repo>] [--json]";
const QUEUE_NEXT_USAGE = "Usage: loopover-miner queue next [--global-wip <n>] [--per-repo-wip <n>] [--dry-run] [--json]";
const QUEUE_DONE_USAGE = "Usage: loopover-miner queue done <owner/repo> <identifier> [--api-base-url <url>] [--dry-run] [--json]";
const QUEUE_RELEASE_USAGE = "Usage: loopover-miner queue release <owner/repo> <identifier> [--api-base-url <url>] [--dry-run] [--json]";
const QUEUE_REQUEUE_USAGE = "Usage: loopover-miner queue requeue <owner/repo> <identifier> [--api-base-url <url>] [--dry-run] [--json]";
const QUEUE_CLAIM_BATCH_USAGE = "Usage: loopover-miner queue claim-batch [--global-wip <n>] [--per-repo-wip <n>] [--dry-run] [--json]";
function parseRepoArg(value, usage) {
    if (!value)
        return { error: usage };
    const trimmed = value.trim();
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined) {
        return { error: "Repository must be in owner/repo form." };
    }
    return { repoFullName: `${owner}/${repo}` };
}
export function parseQueueListArgs(args) {
    const options = { json: false, repoFullName: null };
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        if (token === "--repo") {
            const repoArg = args[index + 1];
            if (!repoArg || repoArg.startsWith("-")) {
                return { error: QUEUE_LIST_USAGE };
            }
            const repo = parseRepoArg(repoArg, QUEUE_LIST_USAGE);
            if ("error" in repo)
                return repo;
            options.repoFullName = repo.repoFullName;
            index += 1;
            continue;
        }
        if (token.startsWith("-")) {
            return { error: `Unknown option: ${token}` };
        }
        positional.push(token);
    }
    if (positional.length > 0) {
        return { error: QUEUE_LIST_USAGE };
    }
    return options;
}
// #4850: --global-wip/--per-repo-wip are OMITTED (undefined) by default -- queue next stays uncapped, byte-
// identical to its pre-#4850 behavior, unless an operator explicitly opts in. Mirrors queue claim-batch's own
// flag names (portfolio-queue-manager.js's WIP-cap-aware claimer), but claim-batch's OWN default of 1/1 is not
// reused here: claim-batch's whole purpose is cap enforcement, while queue next has always been a plain
// highest-priority dequeue and must not silently start capping existing callers that never asked for it.
export function parseQueueNextArgs(args) {
    const options = { json: false, dryRun: false, globalWipCap: undefined, perRepoWipCap: undefined };
    const positional = [];
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
        if (token === "--global-wip" || token === "--per-repo-wip") {
            const value = Number(args[index + 1]);
            if (args[index + 1] === undefined || !Number.isFinite(value) || value < 0) {
                return { error: QUEUE_NEXT_USAGE };
            }
            if (token === "--global-wip")
                options.globalWipCap = value;
            else
                options.perRepoWipCap = value;
            index += 1;
            continue;
        }
        if (token.startsWith("-")) {
            return { error: `Unknown option: ${token}` };
        }
        positional.push(token);
    }
    if (positional.length > 0) {
        return { error: QUEUE_NEXT_USAGE };
    }
    return options;
}
/**
 * Pick at most one atomically-claimable target from the store's already-priority-ordered active rows (queued
 * AND in_progress interleaved, exactly `batchClaim`'s own `entries` shape). `caps` of `null` replicates the
 * pre-#4850 behavior: the single highest-priority queued row, unconditionally. When caps are set, refuses to
 * select anything once the global or the target row's own per-repo in-progress count has reached its cap --
 * "stops claiming once the cap is reached" (#4850), not a diversifying batch selection (that remains
 * claim-batch's job via the engine's own `nextEligibleItems`).
 * @param {Array<{ repoFullName: string, identifier: string, apiBaseUrl: string, status: string }>} entries
 * @param {{ globalWipCap: number, perRepoWipCap: number } | null} caps
 */
export function selectNextEligibleTarget(entries, caps) {
    const topQueued = entries.find((entry) => entry.status === "queued");
    if (!topQueued)
        return [];
    if (!caps) {
        return [{ repoFullName: topQueued.repoFullName, identifier: topQueued.identifier, apiBaseUrl: topQueued.apiBaseUrl }];
    }
    const globalActiveCount = entries.filter((entry) => entry.status === "in_progress").length;
    if (globalActiveCount >= caps.globalWipCap)
        return [];
    // Host-scope the per-repo active count (#7224): a same-named repo on a DIFFERENT forge host is a distinct backlog
    // (the store keys rows by apiBaseUrl too, #5563), so an in-progress item on host A must not consume host B's
    // per-repo WIP budget. Single-host is unchanged: every entry shares one apiBaseUrl, so the added match is always true.
    const repoActiveCount = entries.filter((entry) => entry.status === "in_progress" &&
        entry.repoFullName === topQueued.repoFullName &&
        entry.apiBaseUrl === topQueued.apiBaseUrl).length;
    if (repoActiveCount >= caps.perRepoWipCap)
        return [];
    return [{ repoFullName: topQueued.repoFullName, identifier: topQueued.identifier, apiBaseUrl: topQueued.apiBaseUrl }];
}
/** Shared `<owner/repo> <identifier> [--api-base-url <url>] [--json]` parse for the item-targeting subcommands
 *  (done/release/requeue). `usage` is the command-specific message surfaced on a malformed argv. */
function parseRepoIdentifierArgs(args, usage) {
    const options = {
        json: false,
        dryRun: false,
        apiBaseUrl: undefined,
    };
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        // #4847: reports what a real mutation would do and returns before opening the portfolio queue at all.
        if (token === "--dry-run") {
            options.dryRun = true;
            continue;
        }
        // #5563: scope the target to a non-default forge host, so it doesn't collide with (or get confused for) a
        // same-named repo on the default github.com host.
        if (token === "--api-base-url") {
            const value = args[index + 1];
            if (!value || value.startsWith("-")) {
                return { error: usage };
            }
            options.apiBaseUrl = value;
            index += 1;
            continue;
        }
        if (token.startsWith("-")) {
            return { error: `Unknown option: ${token}` };
        }
        positional.push(token);
    }
    if (positional.length !== 2) {
        return { error: usage };
    }
    const repo = parseRepoArg(positional[0], usage);
    if ("error" in repo)
        return repo;
    const identifier = positional[1]?.trim();
    if (!identifier) {
        return { error: usage };
    }
    return {
        repoFullName: repo.repoFullName,
        identifier,
        dryRun: options.dryRun,
        json: options.json,
        apiBaseUrl: options.apiBaseUrl,
    };
}
export function parseQueueDoneArgs(args) {
    return parseRepoIdentifierArgs(args, QUEUE_DONE_USAGE);
}
export function parseQueueReleaseArgs(args) {
    return parseRepoIdentifierArgs(args, QUEUE_RELEASE_USAGE);
}
export function parseQueueRequeueArgs(args) {
    return parseRepoIdentifierArgs(args, QUEUE_REQUEUE_USAGE);
}
function display(value) {
    if (value === null || value === undefined)
        return "-";
    return String(value);
}
export function renderQueueTable(entries) {
    if (!Array.isArray(entries) || entries.length === 0)
        return "no portfolio queue entries";
    const header = [
        "repo".padEnd(24),
        "identifier".padEnd(16),
        // #7225: surface the host so a reader of the plain-text table can supply the `--api-base-url` a follow-up
        // done/release/requeue needs to disambiguate two rows sharing a repo+identifier across forge hosts.
        "host".padEnd(30),
        "status".padEnd(12),
        "pri".padStart(4),
        "enqueued-at".padEnd(24),
    ].join(" ");
    const lines = entries.map((entry) => [
        entry.repoFullName.padEnd(24),
        entry.identifier.padEnd(16),
        display(entry.apiBaseUrl).padEnd(30),
        entry.status.padEnd(12),
        display(entry.priority).padStart(4),
        display(entry.enqueuedAt).padEnd(24),
    ].join(" "));
    return [header, ...lines].join("\n");
}
function withPortfolioQueue(options, run) {
    const ownsStore = options.initPortfolioQueue === undefined;
    const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
    try {
        return run(portfolioQueue);
    }
    finally {
        if (ownsStore)
            portfolioQueue.close();
    }
}
export function runQueueList(args, options = {}) {
    const parsed = parseQueueListArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    try {
        return withPortfolioQueue(options, (portfolioQueue) => {
            const entries = portfolioQueue.listQueue(parsed.repoFullName);
            if (parsed.json) {
                console.log(JSON.stringify({ entries }, null, 2));
            }
            else {
                console.log(renderQueueTable(entries));
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export function runQueueNext(args, options = {}) {
    const parsed = parseQueueNextArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    const capsRequested = parsed.globalWipCap !== undefined || parsed.perRepoWipCap !== undefined;
    if (parsed.dryRun) {
        const dryRunResult = capsRequested
            ? { outcome: "dry_run", globalWipCap: parsed.globalWipCap, perRepoWipCap: parsed.perRepoWipCap }
            : { outcome: "dry_run" };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult, null, 2));
        }
        else if (capsRequested) {
            console.log(`DRY RUN: would dequeue the highest-priority queued item within WIP caps (global-wip: ${parsed.globalWipCap ?? "unset"}, per-repo-wip: ${parsed.perRepoWipCap ?? "unset"}). No portfolio-queue write was made.`);
        }
        else {
            console.log("DRY RUN: would dequeue the highest-priority queued item. No portfolio-queue write was made.");
        }
        return 0;
    }
    try {
        return withPortfolioQueue(options, (portfolioQueue) => {
            let entry;
            if (capsRequested) {
                // Unset dimensions stay genuinely uncapped (Infinity), not silently defaulted to 1 like claim-batch.
                const caps = {
                    globalWipCap: parsed.globalWipCap ?? Number.POSITIVE_INFINITY,
                    perRepoWipCap: parsed.perRepoWipCap ?? Number.POSITIVE_INFINITY,
                };
                const claimed = portfolioQueue.batchClaim((entries) => selectNextEligibleTarget(entries, caps));
                entry = claimed[0] ?? null;
            }
            else {
                entry = portfolioQueue.dequeueNext();
            }
            if (parsed.json) {
                console.log(JSON.stringify({ entry }, null, 2));
            }
            else {
                console.log(entry ? entry.identifier : "none");
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export function runQueueDone(args, options = {}) {
    const parsed = parseQueueDoneArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    if (parsed.dryRun) {
        const dryRunResult = { outcome: "dry_run", repoFullName: parsed.repoFullName, identifier: parsed.identifier };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult, null, 2));
        }
        else {
            console.log(`DRY RUN: would mark ${parsed.repoFullName} ${parsed.identifier} done. No portfolio-queue write was made.`);
        }
        return 0;
    }
    try {
        return withPortfolioQueue(options, (portfolioQueue) => {
            const entry = portfolioQueue.markDone(parsed.repoFullName, parsed.identifier, parsed.apiBaseUrl);
            if (!entry) {
                return reportCliFailure(parsed.json, "queue_entry_not_found");
            }
            if (parsed.json) {
                console.log(JSON.stringify({ entry }, null, 2));
            }
            else {
                console.log(entry.status);
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
/** `release <owner/repo> <identifier>`: manually give up a CLAIMED (in_progress) item, returning it to the queue
 *  (the manual counterpart to the automated stuck-lease sweep). Exit 2 when there is no in-flight item to release. */
export function runQueueRelease(args, options = {}) {
    const parsed = parseQueueReleaseArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    if (parsed.dryRun) {
        const dryRunResult = { outcome: "dry_run", repoFullName: parsed.repoFullName, identifier: parsed.identifier };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult, null, 2));
        }
        else {
            console.log(`DRY RUN: would release ${parsed.repoFullName} ${parsed.identifier} back to the queue. No portfolio-queue write was made.`);
        }
        return 0;
    }
    try {
        return withPortfolioQueue(options, (portfolioQueue) => {
            const entry = portfolioQueue.reclaimStuckItem(parsed.repoFullName, parsed.identifier, parsed.apiBaseUrl);
            if (!entry) {
                return reportCliFailure(parsed.json, "queue_entry_not_in_progress");
            }
            if (parsed.json) {
                console.log(JSON.stringify({ entry }, null, 2));
            }
            else {
                console.log(entry.status);
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
/** `requeue <owner/repo> <identifier>`: manually put a COMPLETED (done) item back on the queue so it is picked up
 *  again, keeping its original FIFO position. Exit 2 when there is no done item to requeue (already queued,
 *  in-flight — release it instead — or absent). */
export function runQueueRequeue(args, options = {}) {
    const parsed = parseQueueRequeueArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    if (parsed.dryRun) {
        const dryRunResult = { outcome: "dry_run", repoFullName: parsed.repoFullName, identifier: parsed.identifier };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult, null, 2));
        }
        else {
            console.log(`DRY RUN: would requeue ${parsed.repoFullName} ${parsed.identifier}. No portfolio-queue write was made.`);
        }
        return 0;
    }
    try {
        return withPortfolioQueue(options, (portfolioQueue) => {
            const entry = portfolioQueue.requeueItem(parsed.repoFullName, parsed.identifier, parsed.apiBaseUrl);
            if (!entry) {
                return reportCliFailure(parsed.json, "queue_entry_not_requeuable");
            }
            if (parsed.json) {
                console.log(JSON.stringify({ entry }, null, 2));
            }
            else {
                console.log(entry.status);
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export function parseQueueClaimBatchArgs(args) {
    const options = {
        json: false,
        dryRun: false,
        globalWipCap: 1,
        perRepoWipCap: 1,
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
        if (token === "--global-wip" || token === "--per-repo-wip") {
            const value = Number(args[index + 1]);
            if (args[index + 1] === undefined || !Number.isFinite(value) || value < 0) {
                return { error: QUEUE_CLAIM_BATCH_USAGE };
            }
            if (token === "--global-wip")
                options.globalWipCap = value;
            else
                options.perRepoWipCap = value;
            index += 1;
            continue;
        }
        return { error: QUEUE_CLAIM_BATCH_USAGE };
    }
    return options;
}
/** Claim the next caps-aware batch via the WIP-cap-aware batch claimer (portfolio-queue-manager.js), which also
 *  reclaims any leases orphaned by a crashed process first (#4833 wires the previously caller-less claimer). */
export function runQueueClaimBatch(args, options = {}) {
    const parsed = parseQueueClaimBatchArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    if (parsed.dryRun) {
        const dryRunResult = { outcome: "dry_run", globalWipCap: parsed.globalWipCap, perRepoWipCap: parsed.perRepoWipCap };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult, null, 2));
        }
        else {
            console.log(`DRY RUN: would claim a batch (global-wip: ${parsed.globalWipCap}, per-repo-wip: ${parsed.perRepoWipCap}). No portfolio-queue write was made.`);
        }
        return 0;
    }
    // Open the manager INSIDE the try so a store open failure returns 2 instead of crashing; the finally guards the
    // close with `?.` since the initializer may have thrown before assigning.
    const ownsManager = options.initPortfolioQueueManager === undefined;
    let manager;
    try {
        manager = (options.initPortfolioQueueManager ?? initPortfolioQueueManager)({
            caps: { globalWipCap: parsed.globalWipCap, perRepoWipCap: parsed.perRepoWipCap },
        });
        const claimed = manager.claimNextBatch();
        if (parsed.json) {
            console.log(JSON.stringify({ claimed }, null, 2));
        }
        else {
            console.log(claimed.length === 0 ? "none" : claimed.map((entry) => entry.identifier).join("\n"));
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
    finally {
        if (ownsManager)
            manager?.close();
    }
}
const QUEUE_METRICS_USAGE = "Usage: loopover-miner queue metrics";
// Prometheus metric names for the portfolio-queue gauges (#5186). Mirrors the `loopover_miner_*` naming and
// HELP/TYPE/label conventions of event-ledger-cli.js's renderEventLedgerMetrics / the engine's
// renderMinerPredictionMetrics, rather than importing across the package boundary.
export const QUEUE_ITEMS = "loopover_miner_portfolio_queue_items";
export const QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS = "loopover_miner_portfolio_queue_oldest_in_progress_lease_age_seconds";
/** HELP-text escaping — backslash + newline (mirrors miner-prediction-metrics.ts's escapeHelpText). */
function escapeMetricsHelpText(help) {
    return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
/**
 * Render portfolio-queue backlog health as Prometheus text-exposition gauges: current item count per status, and
 * the age of the OLDEST still-in-flight lease -- the concrete "is anything stuck" signal a
 * `loopover_queue_oldest_maintenance_pending_age_seconds`-style alert rule can threshold on (#5186). Pure and
 * side-effect-free: the caller supplies the rows and `nowMs` (no internal clock read, matching
 * store-maintenance.js's pruneLedgerByRetention convention) and prints the result. Deterministic (status series
 * sorted); always emits HELP/TYPE so an empty queue is still a well-formed exposition document, and the lease-age
 * gauge reads 0 (never stuck) rather than being omitted when nothing is in-flight.
 * @param {Array<{ status: string }>} queueEntries - every row, any status (e.g. store.listQueue()'s output).
 * @param {Array<{ leasedAt: string | null }>} leaseEntries - in-flight rows only (store.listInProgress()'s output).
 * @param {number} nowMs
 */
export function renderPortfolioQueueMetrics(queueEntries, leaseEntries, nowMs) {
    const countByStatus = new Map();
    for (const entry of queueEntries) {
        countByStatus.set(entry.status, (countByStatus.get(entry.status) ?? 0) + 1);
    }
    let oldestLeaseAgeSeconds = 0;
    for (const lease of leaseEntries) {
        const leasedAtMs = Date.parse(lease.leasedAt ?? "");
        if (!Number.isFinite(leasedAtMs))
            continue;
        const ageSeconds = Math.max(0, (nowMs - leasedAtMs) / 1000);
        if (ageSeconds > oldestLeaseAgeSeconds)
            oldestLeaseAgeSeconds = ageSeconds;
    }
    const lines = [
        `# HELP ${QUEUE_ITEMS} ${escapeMetricsHelpText("Current portfolio-queue item count, by status.")}`,
        `# TYPE ${QUEUE_ITEMS} gauge`,
    ];
    for (const [status, count] of [...countByStatus.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`${QUEUE_ITEMS}{status="${status}"} ${count}`);
    }
    lines.push(`# HELP ${QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS} ${escapeMetricsHelpText("Age in seconds of the oldest still-in-flight (in_progress) claim lease. 0 when nothing is in-flight.")}`);
    lines.push(`# TYPE ${QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS} gauge`);
    lines.push(`${QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS} ${oldestLeaseAgeSeconds}`);
    return `${lines.join("\n")}\n`;
}
export function runQueueMetrics(args, options = {}) {
    if (args.length > 0) {
        return reportCliFailure(argsWantJson(args), QUEUE_METRICS_USAGE);
    }
    try {
        return withPortfolioQueue(options, (portfolioQueue) => {
            const nowMs = typeof options.nowMs === "number" && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
            // renderPortfolioQueueMetrics returns a newline-terminated document; console.log re-adds the terminator, so
            // trim it to emit exactly one trailing newline (mirrors metrics-cli.js's runMetrics).
            console.log(renderPortfolioQueueMetrics(portfolioQueue.listQueue(), portfolioQueue.listInProgress(), nowMs).trimEnd());
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(argsWantJson(args), describeCliError(error));
    }
}
export function runQueueCli(subcommand, args, options = {}) {
    if (subcommand === "list")
        return runQueueList(args, options);
    if (subcommand === "next")
        return runQueueNext(args, options);
    if (subcommand === "done")
        return runQueueDone(args, options);
    if (subcommand === "release")
        return runQueueRelease(args, options);
    if (subcommand === "requeue")
        return runQueueRequeue(args, options);
    if (subcommand === "claim-batch")
        return runQueueClaimBatch(args, options);
    if (subcommand === "metrics")
        return runQueueMetrics(args, options);
    if (subcommand === "dashboard")
        return runPortfolioDashboard(args, options);
    return reportCliFailure(argsWantJson(args), `Unknown queue subcommand: ${subcommand ?? ""}. ${QUEUE_LIST_USAGE}`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicG9ydGZvbGlvLXF1ZXVlLWNsaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInBvcnRmb2xpby1xdWV1ZS1jbGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLHVCQUF1QixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFFL0QsT0FBTyxFQUFFLHlCQUF5QixFQUFFLE1BQU0sOEJBQThCLENBQUM7QUFFekUsT0FBTyxFQUFFLHFCQUFxQixFQUFFLE1BQU0sMEJBQTBCLENBQUM7QUFDakUsT0FBTyxFQUFFLFlBQVksRUFBRSxnQkFBZ0IsRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBRWxGLE1BQU0sZ0JBQWdCLEdBQUcsaUVBQWlFLENBQUM7QUFDM0YsTUFBTSxnQkFBZ0IsR0FDcEIsK0ZBQStGLENBQUM7QUFDbEcsTUFBTSxnQkFBZ0IsR0FDcEIsd0dBQXdHLENBQUM7QUFDM0csTUFBTSxtQkFBbUIsR0FDdkIsMkdBQTJHLENBQUM7QUFDOUcsTUFBTSxtQkFBbUIsR0FDdkIsMkdBQTJHLENBQUM7QUFDOUcsTUFBTSx1QkFBdUIsR0FDM0Isc0dBQXNHLENBQUM7QUFtQ3pHLFNBQVMsWUFBWSxDQUFDLEtBQXlCLEVBQUUsS0FBYTtJQUM1RCxJQUFJLENBQUMsS0FBSztRQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLENBQUM7SUFDcEMsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO0lBQzdCLE1BQU0sQ0FBQyxLQUFLLEVBQUUsSUFBSSxFQUFFLEtBQUssQ0FBQyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDaEQsSUFBSSxDQUFDLEtBQUssSUFBSSxDQUFDLElBQUksSUFBSSxLQUFLLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDM0MsT0FBTyxFQUFFLEtBQUssRUFBRSx3Q0FBd0MsRUFBRSxDQUFDO0lBQzdELENBQUM7SUFDRCxPQUFPLEVB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