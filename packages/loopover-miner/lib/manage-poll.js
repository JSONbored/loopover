import { pollCheckRuns } from "./ci-poller.js";
import { initEventLedger } from "./event-ledger.js";
import { MANAGE_PR_UPDATE_EVENT, formatManagedPrIdentifier, } from "./manage-status.js";
import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { DEFAULT_FORGE_CONFIG } from "./forge-config.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { resolveGitHubToken } from "./github-token-resolution.js";
const MANAGE_POLL_USAGE = "Usage: loopover-miner manage poll <owner/repo> <pr#> [--branch <name>] [--dry-run] [--json]";
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
export function mapPollConclusionToGateVerdict(conclusion) {
    switch (conclusion) {
        case "success":
            return "pass";
        case "failure":
            return "block";
        default:
            return "advisory";
    }
}
export function mapPollConclusionToOutcome(conclusion) {
    switch (conclusion) {
        case "success":
            return "ready";
        case "failure":
            return "needs-work";
        default:
            return "open";
    }
}
export function buildManagePollEventPayload(prNumber, pollResult, options = {}) {
    if (!Number.isInteger(prNumber) || prNumber <= 0)
        throw new Error("invalid_pr_number");
    if (!pollResult || typeof pollResult !== "object")
        throw new Error("invalid_poll_result");
    const branch = typeof options.branch === "string" && options.branch.trim() ? options.branch.trim() : null;
    const lastPolledAt = typeof options.lastPolledAt === "string" && options.lastPolledAt.trim()
        ? options.lastPolledAt.trim()
        : new Date().toISOString();
    return {
        prNumber,
        branch,
        ciState: pollResult.conclusion,
        gateVerdict: mapPollConclusionToGateVerdict(pollResult.conclusion),
        outcome: mapPollConclusionToOutcome(pollResult.conclusion),
        lastPolledAt,
    };
}
export function parseManagePollArgs(args = []) {
    const options = { json: false, branch: null, dryRun: false };
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        // #4847: still runs the real (read-only) CI-check-run poll, but skips the event-ledger append and
        // portfolio-queue enqueue.
        if (token === "--dry-run") {
            options.dryRun = true;
            continue;
        }
        if (token === "--branch") {
            const branch = args[index + 1];
            if (!branch || branch.startsWith("-"))
                return { error: MANAGE_POLL_USAGE };
            options.branch = branch;
            index += 1;
            continue;
        }
        if (token.startsWith("-"))
            return { error: `Unknown option: ${token}` };
        positional.push(token);
    }
    if (positional.length !== 2)
        return { error: MANAGE_POLL_USAGE };
    const repo = parseRepoArg(positional[0], MANAGE_POLL_USAGE);
    if ("error" in repo)
        return repo;
    const prNumber = Number(positional[1]);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
        return { error: "Pull request number must be a positive integer." };
    }
    return {
        repoFullName: repo.repoFullName,
        prNumber,
        ...options,
    };
}
/** The forge host a managed-PR row belongs to. Mirrors portfolio-queue-manager.js's own fold (and every
 *  store's `normalizeApiBaseUrl`): omitted/blank в†’ the github.com default, so a single-forge caller is
 *  unaffected. Used only to COMPARE hosts here; `enqueue` still does its own normalization/validation. */
function resolveManagedRowApiBaseUrl(apiBaseUrl) {
    return typeof apiBaseUrl === "string" && apiBaseUrl.trim() ? apiBaseUrl.trim() : DEFAULT_FORGE_CONFIG.apiBaseUrl;
}
function ensureManagedPrRow(portfolioQueue, repoFullName, prNumber, apiBaseUrl) {
    const identifier = formatManagedPrIdentifier(prNumber);
    // `listQueue(repoFullName)` is forge-BLIND, so the existence check has to compare the host too: the queue's
    // composite (api_base_url, repo_full_name, identifier) key exists precisely so two hosts serving the same
    // owner/repo name never collide (#5563). Without this scoping, the same repo+PR-number already tracked on
    // ANOTHER host suppresses this host's row entirely.
    const targetApiBaseUrl = resolveManagedRowApiBaseUrl(apiBaseUrl);
    const exists = portfolioQueue
        .listQueue(repoFullName)
        .some((entry) => entry.identifier === identifier && resolveManagedRowApiBaseUrl(entry.apiBaseUrl) === targetApiBaseUrl);
    if (!exists) {
        // Thread the SAME apiBaseUrl the CI poll above used, so the row is scoped to the host it was polled from
        // instead of silently defaulting to github.com.
        portfolioQueue.enqueue({ repoFullName, identifier, priority: 0, apiBaseUrl });
    }
}
/**
 * Poll GitHub check runs for a managed PR and append a `manage_pr_update` snapshot to the local event ledger.
 * Completes the manage-status data path introduced in #2325 / #3070 using the CI poller from #2323.
 */
export async function recordManagePollSnapshot(input, options) {
    if (!input || typeof input !== "object")
        throw new Error("invalid_manage_poll_input");
    const repoFullName = typeof input.repoFullName === "string" ? input.repoFullName.trim() : "";
    const [owner, repo, extra] = repoFullName.split("/");
    if (!owner || !repo || extra !== undefined)
        throw new Error("invalid_repo_full_name");
    if (!Number.isInteger(input.prNumber) || input.prNumber <= 0)
        throw new Error("invalid_pr_number");
    const eventLedger = options.eventLedger;
    if (!eventLedger || typeof eventLedger.appendEvent !== "function") {
        throw new Error("invalid_event_ledger");
    }
    const portfolioQueue = options.portfolioQueue;
    if (options.portfolioQueue !== undefined) {
        if (!portfolioQueue || typeof portfolioQueue.enqueue !== "function") {
            throw new Error("invalid_portfolio_queue");
        }
    }
    const pollCheckRunsFn = options.pollCheckRuns ?? pollCheckRuns;
    const pollResult = await pollCheckRunsFn(repoFullName, input.prNumber, {
        apiBaseUrl: options.apiBaseUrl,
        fetchFn: options.fetchFn,
        githubToken: options.githubToken ?? "",
        maxAttempts: options.maxAttempts,
        minIntervalMs: options.minIntervalMs,
        maxIntervalMs: options.maxIntervalMs,
        sleepFn: options.sleepFn,
    });
    const payload = buildManagePollEventPayload(input.prNumber, pollResult, {
        branch: input.branch,
        lastPolledAt: options.lastPolledAt,
    });
    if ((options.ensurePortfolioRow ?? true) && portfolioQueue) {
        ensureManagedPrRow(portfolioQueue, repoFullName, input.prNumber, options.apiBaseUrl);
    }
    const event = eventLedger.appendEvent({
        type: MANAGE_PR_UPDATE_EVENT,
        repoFullName,
        payload,
    });
    return { pollResult, payload, event: event };
}
export async function runManagePoll(args = [], options = {}) {
    const parsed = parseManagePollArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    // #4847: the CI-check-run poll itself is a real, read-only GitHub signal -- the useful "what would this
    // record?" output -- so a dry run still performs it for real. It never opens the event ledger or portfolio
    // queue, though: a no-op event ledger is fed through recordManagePollSnapshot so its own real payload-building
    // logic still runs, just without ever writing to local storage (ensurePortfolioRow: false skips the queue
    // enqueue the same way).
    if (parsed.dryRun) {
        const noopEventLedger = { appendEvent: () => null };
        try {
            const result = await recordManagePollSnapshot({ repoFullName: parsed.repoFullName, prNumber: parsed.prNumber, branch: parsed.branch }, {
                eventLedger: noopEventLedger,
                ensurePortfolioRow: false,
                pollCheckRuns: options.pollCheckRuns,
                fetchFn: options.fetchFn,
                githubToken: options.githubToken ?? (await resolveGitHubToken(process.env)) ?? "",
                apiBaseUrl: options.apiBaseUrl,
                maxAttempts: options.maxAttempts,
                minIntervalMs: options.minIntervalMs,
                maxIntervalMs: options.maxIntervalMs,
                sleepFn: options.sleepFn,
                lastPolledAt: options.lastPolledAt,
            });
            const dryRunResult = { outcome: "dry_run", pollResult: result.pollResult, payload: result.payload };
            if (parsed.json) {
                console.log(JSON.stringify(dryRunResult, null, 2));
            }
            else {
                console.log(`DRY RUN: ${result.payload.ciState} (${result.payload.gateVerdict}/${result.payload.outcome}). No event-ledger or portfolio-queue write was made.`);
            }
            return 0;
        }
        catch (error) {
            return reportCliFailure(parsed.json, describeCliError(error));
        }
    }
    const ownsEventLedger = options.initEventLedger === undefined;
    const ownsPortfolioQueue = options.initPortfolioQueue === undefined;
    const eventLedger = (options.initEventLedger ?? initEventLedger)();
    const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
    try {
        const result = await recordManagePollSnapshot({
            repoFullName: parsed.repoFullName,
            prNumber: parsed.prNumber,
            branch: parsed.branch,
        }, {
            eventLedger,
            portfolioQueue,
            ensurePortfolioRow: options.ensurePortfolioRow ?? true,
            pollCheckRuns: options.pollCheckRuns,
            fetchFn: options.fetchFn,
            githubToken: options.githubToken ?? (await resolveGitHubToken(process.env)) ?? "",
            apiBaseUrl: options.apiBaseUrl,
            maxAttempts: options.maxAttempts,
            minIntervalMs: options.minIntervalMs,
            maxIntervalMs: options.maxIntervalMs,
            sleepFn: options.sleepFn,
            lastPolledAt: options.lastPolledAt,
        });
        if (parsed.json) {
            console.log(JSON.stringify(result, null, 2));
        }
        else {
            console.log(`${result.payload.ciState} (${result.payload.gateVerdict}/${result.payload.outcome})`);
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
    finally {
        if (ownsEventLedger)
            eventLedger.close();
        if (ownsPortfolioQueue)
            portfolioQueue.close();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFuYWdlLXBvbGwuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJtYW5hZ2UtcG9sbC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFFL0MsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBRXBELE9BQU8sRUFDTCxzQkFBc0IsRUFDdEIseUJBQXlCLEdBQzFCLE1BQU0sb0JBQW9CLENBQUM7QUFDNUIsT0FBTyxFQUFFLHVCQUF1QixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFFL0QsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFDekQsT0FBTyxFQUFFLFlBQVksRUFBRSxnQkFBZ0IsRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBQ2xGLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLDhCQUE4QixDQUFDO0FBU2xFLE1BQU0saUJBQWlCLEdBQ3JCLDZGQUE2RixDQUFDO0FBRWhHLFNBQVMsWUFBWSxDQUFDLEtBQXlCLEVBQUUsS0FBYTtJQUM1RCxJQUFJLENBQUMsS0FBSztRQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLENBQUM7SUFDcEMsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO0lBQzdCLE1BQU0sQ0FBQyxLQUFLLEVBQUUsSUFBSSxFQUFFLEtBQUssQ0FBQyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDaEQsSUFBSSxDQUFDLEtBQUssSUFBSSxDQUFDLElBQUksSUFBSSxLQUFLLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDM0MsT0FBTyxFQUFFLEtBQUssRUFBRSx3Q0FBd0MsRUFBRSxDQUFDO0lBQzdELENBQUM7SUFDRCxPQUFPLEVBQUUsWUFBWSxFQUFFLEdBQUcsS0FBSyxJQUFJLElBQUksRUFBRSxFQUFFLENBQUM7QUFD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