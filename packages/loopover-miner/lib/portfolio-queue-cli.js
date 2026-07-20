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
    const options = {
        json: false,
        dryRun: false,
        globalWipCap: undefined,
        perRepoWipCap: undefined,
    };
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
    const options = { json: false, dryRun: false, apiBaseUrl: undefined };
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
    const options = { json: false, dryRun: false, globalWipCap: 1, perRepoWipCap: 1 };
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
 * @param queueEntries - every row, any status (e.g. store.listQueue()'s output).
 * @param leaseEntries - in-flight rows only (store.listInProgress()'s output).
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicG9ydGZvbGlvLXF1ZXVlLWNsaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInBvcnRmb2xpby1xdWV1ZS1jbGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLHVCQUF1QixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFDL0QsT0FBTyxFQUFFLHlCQUF5QixFQUFFLE1BQU0sOEJBQThCLENBQUM7QUFDekUsT0FBTyxFQUFFLHFCQUFxQixFQUFFLE1BQU0sMEJBQTBCLENBQUM7QUFDakUsT0FBTyxFQUFFLFlBQVksRUFBRSxnQkFBZ0IsRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBSWxGLE1BQU0sZ0JBQWdCLEdBQUcsaUVBQWlFLENBQUM7QUFDM0YsTUFBTSxnQkFBZ0IsR0FDcEIsK0ZBQStGLENBQUM7QUFDbEcsTUFBTSxnQkFBZ0IsR0FDcEIsd0dBQXdHLENBQUM7QUFDM0csTUFBTSxtQkFBbUIsR0FDdkIsMkdBQTJHLENBQUM7QUFDOUcsTUFBTSxtQkFBbUIsR0FDdkIsMkdBQTJHLENBQUM7QUFDOUcsTUFBTSx1QkFBdUIsR0FDM0Isc0dBQXNHLENBQUM7QUFFekcsU0FBUyxZQUFZLENBQUMsS0FBeUIsRUFBRSxLQUFhO0lBQzVELElBQUksQ0FBQyxLQUFLO1FBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsQ0FBQztJQUNwQyxNQUFNLE9BQU8sR0FBRyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDN0IsTUFBTSxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNoRCxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsSUFBSSxJQUFJLEtBQUssS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUMzQyxPQUFPLEVBQUUsS0FBSyxFQUFFLHdDQUF3QyxFQUFFLENBQUM7SUFDN0QsQ0FBQztJQUNELE9BQU8sRUFB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