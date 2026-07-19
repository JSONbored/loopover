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
    const options = {
        json: false,
        branch: null,
        dryRun: false,
    };
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === undefined)
            continue;
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
 *  store's `normalizeApiBaseUrl`): omitted/blank → the github.com default, so a single-forge caller is
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
        .some((entry) => entry.identifier === identifier &&
        resolveManagedRowApiBaseUrl(entry.apiBaseUrl) === targetApiBaseUrl);
    if (!exists) {
        // Thread the SAME apiBaseUrl the CI poll above used, so the row is scoped to the host it was polled from
        // instead of silently defaulting to github.com.
        portfolioQueue.enqueue({
            repoFullName,
            identifier,
            priority: 0,
            ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}),
        });
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
        ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
        ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
        githubToken: options.githubToken ?? "",
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
        ...(options.minIntervalMs !== undefined ? { minIntervalMs: options.minIntervalMs } : {}),
        ...(options.maxIntervalMs !== undefined ? { maxIntervalMs: options.maxIntervalMs } : {}),
        ...(options.sleepFn !== undefined ? { sleepFn: options.sleepFn } : {}),
    });
    const payload = buildManagePollEventPayload(input.prNumber, pollResult, {
        ...(input.branch !== undefined ? { branch: input.branch } : {}),
        ...(options.lastPolledAt !== undefined ? { lastPolledAt: options.lastPolledAt } : {}),
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
                ...(options.pollCheckRuns !== undefined ? { pollCheckRuns: options.pollCheckRuns } : {}),
                ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
                githubToken: options.githubToken ?? (await resolveGitHubToken(process.env)) ?? "",
                ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
                ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
                ...(options.minIntervalMs !== undefined ? { minIntervalMs: options.minIntervalMs } : {}),
                ...(options.maxIntervalMs !== undefined ? { maxIntervalMs: options.maxIntervalMs } : {}),
                ...(options.sleepFn !== undefined ? { sleepFn: options.sleepFn } : {}),
                ...(options.lastPolledAt !== undefined ? { lastPolledAt: options.lastPolledAt } : {}),
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
            ...(options.pollCheckRuns !== undefined ? { pollCheckRuns: options.pollCheckRuns } : {}),
            ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
            githubToken: options.githubToken ?? (await resolveGitHubToken(process.env)) ?? "",
            ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
            ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
            ...(options.minIntervalMs !== undefined ? { minIntervalMs: options.minIntervalMs } : {}),
            ...(options.maxIntervalMs !== undefined ? { maxIntervalMs: options.maxIntervalMs } : {}),
            ...(options.sleepFn !== undefined ? { sleepFn: options.sleepFn } : {}),
            ...(options.lastPolledAt !== undefined ? { lastPolledAt: options.lastPolledAt } : {}),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFuYWdlLXBvbGwuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJtYW5hZ2UtcG9sbC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFFL0MsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBRXBELE9BQU8sRUFDTCxzQkFBc0IsRUFDdEIseUJBQXlCLEdBQzFCLE1BQU0sb0JBQW9CLENBQUM7QUFDNUIsT0FBTyxFQUFFLHVCQUF1QixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFFL0QsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFDekQsT0FBTyxFQUFFLFlBQVksRUFBRSxnQkFBZ0IsRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBQ2xGLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLDhCQUE4QixDQUFDO0FBRWxFLE1BQU0saUJBQWlCLEdBQ3JCLDZGQUE2RixDQUFDO0FBMERoRyxTQUFTLFlBQVksQ0FDbkIsS0FBeUIsRUFDekIsS0FBYTtJQUViLElBQUksQ0FBQyxLQUFLO1FBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsQ0FBQztJQUNwQyxNQUFNLE9BQU8sR0FBRyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDN0IsTUFBTSxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNoRCxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsSUFBSSxJQUFJLEtBQUssS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUMzQyxPQUFPLEVBQUUsS0FBSyxFQUFFLHdDQUF3QyxFQUFFLENBQUM7SUFDN0QsQ0FBQztJQUNELE9BQU8sRUFBRSxZQUFZLEVBQUUsR0FBRyxLQUFLLElBQUksSUFBSSxFQUFFLEVBQUUsQ0FBQztBQUM5QyxDQUFDO0FBRUQsTUFBTSxVQUFVLDhCQUE4QixDQUM1QyxVQUE2QztJQUU3QyxRQUFRLFVBQVUsRUFBRSxDQUFDO1FBQ25CLEtBQUssU0FBUztZQUNaLE9BQU8sTUFBTSxDQUFDO1FBQ2hCLEtBQUssU0FBUztZQUNaLE9BQU8sT0FBTyxDQUFDO1FBQ2pCO1lBQ0UsT0FBTyxVQUFVLENBQUM7SUFDdEIsQ0FBQztBQUNILENBQUM7QUFFRCxNQUFNLFVBQVUsMEJBQTBCLENBQUMsVUFBNkM7SUFDdEYsUUFBUSxVQUFVLEVBQUUsQ0FBQztRQUNuQixLQUFLLFNBQVM7WUFDWixPQUFPLE9BQU8sQ0FBQztRQUNqQixLQUFLLFNBQVM7WUFDWixPQUFPLFlBQVksQ0FBQztRQUN0QjtZQUNFLE9BQU8sTUFBTSxDQUFDO0lBQ2xCLENBQUM7QUFDSCxDQUFDO0FBRUQsTUFBTSxVQUFVLDJCQUEyQixDQUN6QyxRQUFnQixFQUNoQixVQUErQixFQUMvQixVQUE2RCxFQUFFO0lBRS9ELElBQUksQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxJQUFJLFFBQVEsSUFBSSxDQUFDO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDO0lBQ3ZGLElBQUksQ0FBQyxVQUFVLElBQUksT0FBTyxVQUFVLEtBQUssUUFBUTtRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMscUJBQXFCLENBQUMsQ0FBQztJQUMxRixNQUFNLE1BQU0sR0FBRyxPQUFPLE9BQU8sQ0FBQyxNQUFNLEtBQUssUUFBUSxJQUFJLE9BQU8sQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUMxRyxNQUFNLFlBQVksR0FDaEIsT0FBTyxPQUFPLENBQUMsWUFBWSxLQUFLLFFBQVEsSUFBSSxPQUFPLENBQUMsWUFBWSxDQUFDLElBQUksRUFBRTtRQUNyRSxDQUFDLENBQUMsT0FBTyxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUU7UUFDN0IsQ0FBQyxDQUFDLElBQUksSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLENBQUM7SUFDL0IsT0FBTztRQUNMLFFBQVE7UUFDUixNQUFNO1FBQ04sT0FBTyxFQUFFLFVBQVUsQ0FBQyxVQUFVO1FBQzlCLFdBQVcsRUFBRSw4QkFBOEIsQ0FBQyxVQUFVLENBQUMsVUFBVSxDQUFDO1FBQ2xFLE9BQU8sRUFBRSwwQkFBMEIsQ0FBQyxVQUFVLENBQUMsVUFBVSxDQUFDO1FBQzFELFlBQVk7S0FDYixDQUFDO0FBQ0osQ0FBQztBQUVELE1BQU0sVUFBVSxtQkFBbUIsQ0FBQyxPQUFpQixFQUFFO0lBQ3JELE1BQU0sT0FBTyxHQUE4RDtRQUN6RSxJQUFJLEVBQUUsS0FBSztRQUNYLE1BQU0sRUFBRSxJQUFJO1FBQ1osTUFBTSxFQUFFLEtBQUs7S0FDZCxDQUFDO0lBQ0YsTUFBTSxVQUFVLEdBQWEsRUFBRSxDQUFDO0lBRWhDLEtBQUssSUFBSSxLQUFLLEdBQUcsQ0FBQyxFQUFFLEtBQUssR0FBRyxJQUFJLENBQUMsTUFBTSxFQUFFLEtBQUssSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUNwRCxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDMUIsSUFBSSxLQUFLLEtBQUssU0FBUztZQUFFLFNBQVM7UUFDbEMsSUFBSSxLQUFLLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDdkIsT0FBTyxDQUFDLElBQUksR0FBRyxJQUFJLENBQUM7WUFDcEIsU0FBUztRQUNYLENBQUM7UUFDRCxrR0FBa0c7UUFDbEcsMkJBQTJCO1FBQzNCLElBQUksS0FBSyxLQUFLLFdBQVcsRUFBRSxDQUFDO1lBQzFCLE9BQU8sQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDO1lBQ3RCLFNBQVM7UUFDWCxDQUFDO1FBQ0QsSUFBSSxLQUFLLEtBQUssVUFBVSxFQUFFLENBQUM7WUFDekIsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQztZQUMvQixJQUFJLENBQUMsTUFBTSxJQUFJLE1BQU0sQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDO2dCQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsaUJBQWlCLEVBQUUsQ0FBQztZQUMzRSxPQUFPLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQztZQUN4QixLQUFLLElBQUksQ0FBQyxDQUFDO1lBQ1gsU0FBUztRQUNYLENBQUM7UUFDRCxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDO1lBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxtQkFBbUIsS0FBSyxFQUFFLEVBQUUsQ0FBQztRQUN4RSxVQUFVLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ3pCLENBQUM7SUFFRCxJQUFJLFVBQVUsQ0FBQyxNQUFNLEtBQUssQ0FBQztRQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsaUJBQWlCLEVBQUUsQ0FBQztJQUVqRSxNQUFNLElBQUksR0FBRyxZQUFZLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxFQUFFLGlCQUFpQixDQUFDLENBQUM7SUFDNUQsSUFBSSxPQUFPLElBQUksSUFBSTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBRWpDLE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUN2QyxJQUFJLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsSUFBSSxRQUFRLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDakQsT0FBTyxFQUFFLEtBQUssRUFBRSxpREFBaUQsRUFBRSxDQUFDO0lBQ3RFLENBQUM7SUFFRCxPQUFPO1FBQ0wsWUFBWSxFQUFFLElBQUksQ0FBQyxZQUFZO1FBQy9CLFFBQVE7UUFDUixHQUFHLE9BQU87S0FDWCxDQUFDO0FBQ0osQ0FBQztBQUVEOzswR0FFMEc7QUFDMUcsU0FBUywyQkFBMkIsQ0FBQyxVQUE4QjtJQUNqRSxPQUFPLE9BQU8sVUFBVSxLQUFLLFFBQVEsSUFBSSxVQUFVLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsb0JBQW9CLENBQUMsVUFBVSxDQUFDO0FBQ25ILENBQUM7QUFFRCxTQUFTLGtCQUFrQixDQUN6QixjQUFtQyxFQUNuQyxZQUFvQixFQUNwQixRQUFnQixFQUNoQixVQUE4QjtJQUU5QixNQUFNLFVBQVUsR0FBRyx5QkFBeUIsQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUN2RCw0R0FBNEc7SUFDNUcsMEdBQTBHO0lBQzFHLDBHQUEwRztJQUMxRyxvREFBb0Q7SUFDcEQsTUFBTSxnQkFBZ0IsR0FBRywyQkFBMkIsQ0FBQyxVQUFVLENBQUMsQ0FBQztJQUNqRSxNQUFNLE1BQU0sR0FBRyxjQUFjO1NBQzFCLFNBQVMsQ0FBQyxZQUFZLENBQUM7U0FDdkIsSUFBSSxDQUNILENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FDUixLQUFLLENBQUMsVUFBVSxLQUFLLFVBQVU7UUFDL0IsMkJBQTJCLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxLQUFLLGdCQUFnQixDQUNyRSxDQUFDO0lBQ0osSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ1oseUdBQXlHO1FBQ3pHLGdEQUFnRDtRQUNoRCxjQUFjLENBQUMsT0FBTyxDQUFDO1lBQ3JCLFlBQVk7WUFDWixVQUFVO1lBQ1YsUUFBUSxFQUFFLENBQUM7WUFDWCxHQUFHLENBQUMsVUFBVSxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRSxVQUFVLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1NBQ3BELENBQUMsQ0FBQztJQUNMLENBQUM7QUFDSCxDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsTUFBTSxDQUFDLEtBQUssVUFBVSx3QkFBd0IsQ0FDNUMsS0FBc0IsRUFDdEIsT0FBa0M7SUFFbEMsSUFBSSxDQUFDLEtBQUssSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQywyQkFBMkIsQ0FBQyxDQUFDO0lBQ3RGLE1BQU0sWUFBWSxHQUFHLE9BQU8sS0FBSyxDQUFDLFlBQVksS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUM3RixNQUFNLENBQUMsS0FBSyxFQUFFLElBQUksRUFBRSxLQUFLLENBQUMsR0FBRyxZQUFZLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ3JELElBQUksQ0FBQyxLQUFLLElBQUksQ0FBQyxJQUFJLElBQUksS0FBSyxLQUFLLFNBQVM7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHdCQUF3QixDQUFDLENBQUM7SUFDdEYsSUFBSSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxJQUFJLEtBQUssQ0FBQyxRQUFRLElBQUksQ0FBQztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsbUJBQW1CLENBQUMsQ0FBQztJQUVuRyxNQUFNLFdBQVcsR0FBRyxPQUFPLENBQUMsV0FBVyxDQUFDO0lBQ3hDLElBQUksQ0FBQyxXQUFXLElBQUksT0FBTyxXQUFXLENBQUMsV0FBVyxLQUFLLFVBQVUsRUFBRSxDQUFDO1FBQ2xFLE1BQU0sSUFBSSxLQUFLLENBQUMsc0JBQXNCLENBQUMsQ0FBQztJQUMxQyxDQUFDO0lBRUQsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLGNBQWMsQ0FBQztJQUM5QyxJQUFJLE9BQU8sQ0FBQyxjQUFjLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDekMsSUFBSSxDQUFDLGNBQWMsSUFBSSxPQUFPLGNBQWMsQ0FBQyxPQUFPLEtBQUssVUFBVSxFQUFFLENBQUM7WUFDcEUsTUFBTSxJQUFJLEtBQUssQ0FBQyx5QkFBeUIsQ0FBQyxDQUFDO1FBQzdDLENBQUM7SUFDSCxDQUFDO0lBRUQsTUFBTSxlQUFlLEdBQUcsT0FBTyxDQUFDLGFBQWEsSUFBSSxhQUFhLENBQUM7SUFDL0QsTUFBTSxVQUFVLEdBQUcsTUFBTSxlQUFlLENBQUMsWUFBWSxFQUFFLEtBQUssQ0FBQyxRQUFRLEVBQUU7UUFDckUsR0FBRyxDQUFDLE9BQU8sQ0FBQyxVQUFVLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLFVBQVUsRUFBRSxPQUFPLENBQUMsVUFBVSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUMvRSxHQUFHLENBQUMsT0FBTyxDQUFDLE9BQU8sS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsT0FBTyxFQUFFLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ3RFLFdBQVcsRUFBRSxPQUFPLENBQUMsV0FBVyxJQUFJLEVBQUU7UUFDdEMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxXQUFXLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLFdBQVcsRUFBRSxPQUFPLENBQUMsV0FBVyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUNsRixHQUFHLENBQUMsT0FBTyxDQUFDLGFBQWEsS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsYUFBYSxFQUFFLE9BQU8sQ0FBQyxhQUFhLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ3hGLEdBQUcsQ0FBQyxPQUFPLENBQUMsYUFBYSxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRSxhQUFhLEVBQUUsT0FBTyxDQUFDLGFBQWEsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7UUFDeEYsR0FBRyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLE9BQU8sRUFBRSxPQUFPLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztLQUN2RSxDQUFDLENBQUM7SUFFSCxNQUFNLE9BQU8sR0FBRywyQkFBMkIsQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLFVBQVUsRUFBRTtRQUN0RSxHQUFHLENBQUMsS0FBSyxDQUFDLE1BQU0sS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQy9ELEdBQUcsQ0FBQyxPQUFPLENBQUMsWUFBWSxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRSxZQUFZLEVBQUUsT0FBTyxDQUFDLFlBQVksRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7S0FDdEYsQ0FBQyxDQUFDO0lBRUgsSUFBSSxDQUFDLE9BQU8sQ0FBQyxrQkFBa0IsSUFBSSxJQUFJLENBQUMsSUFBSSxjQUFjLEVBQUUsQ0FBQztRQUMzRCxrQkFBa0IsQ0FBQyxjQUFjLEVBQUUsWUFBWSxFQUFFLEtBQUssQ0FBQyxRQUFRLEVBQUUsT0FBTyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQ3ZGLENBQUM7SUFFRCxNQUFNLEtBQUssR0FBRyxXQUFXLENBQUMsV0FBVyxDQUFDO1FBQ3BDLElBQUksRUFBRSxzQkFBc0I7UUFDNUIsWUFBWTtRQUNaLE9BQU87S0FDUixDQUFDLENBQUM7SUFFSCxPQUFPLEVBQUUsVUFBVSxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsS0FBb0IsRUFBRSxDQUFDO0FBQzlELENBQUM7QUFFRCxNQUFNLENBQUMsS0FBSyxVQUFVLGFBQWEsQ0FDakMsT0FBaUIsRUFBRSxFQUNuQixVQUFnQyxFQUFFO0lBRWxDLE1BQU0sTUFBTSxHQUFHLG1CQUFtQixDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3pDLElBQUksT0FBTyxJQUFJLE1BQU0sRUFBRSxDQUFDO1FBQ3RCLE9BQU8sZ0JBQWdCLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxFQUFFLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUM1RCxDQUFDO0lBRUQsd0dBQXdHO0lBQ3hHLDJHQUEyRztJQUMzRywrR0FBK0c7SUFDL0csMEdBQTBHO0lBQzFHLHlCQUF5QjtJQUN6QixJQUFJLE1BQU0sQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUNsQixNQUFNLGVBQWUsR0FBRyxFQUFFLFdBQVcsRUFBRSxHQUFHLEVBQUUsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUNwRCxJQUFJLENBQUM7WUFDSCxNQUFNLE1BQU0sR0FBRyxNQUFNLHdCQUF3QixDQUMzQyxFQUFFLFlBQVksRUFBRSxNQUFNLENBQUMsWUFBWSxFQUFFLFFBQVEsRUFBRSxNQUFNLENBQUMsUUFBUSxFQUFFLE1BQU0sRUFBRSxNQUFNLENBQUMsTUFBTSxFQUFFLEVBQ3ZGO2dCQUNFLFdBQVcsRUFBRSxlQUFlO2dCQUM1QixrQkFBa0IsRUFBRSxLQUFLO2dCQUN6QixHQUFHLENBQUMsT0FBTyxDQUFDLGFBQWEsS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsYUFBYSxFQUFFLE9BQU8sQ0FBQyxhQUFhLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO2dCQUN4RixHQUFHLENBQUMsT0FBTyxDQUFDLE9BQU8sS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsT0FBTyxFQUFFLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO2dCQUN0RSxXQUFXLEVBQUUsT0FBTyxDQUFDLFdBQVcsSUFBSSxDQUFDLE1BQU0sa0JBQWtCLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRTtnQkFDakYsR0FBRyxDQUFDLE9BQU8sQ0FBQyxVQUFVLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLFVBQVUsRUFBRSxPQUFPLENBQUMsVUFBVSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztnQkFDL0UsR0FBRyxDQUFDLE9BQU8sQ0FBQyxXQUFXLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLFdBQVcsRUFBRSxPQUFPLENBQUMsV0FBVyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztnQkFDbEYsR0FBRyxDQUFDLE9BQU8sQ0FBQyxhQUFhLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLGFBQWEsRUFBRSxPQUFPLENBQUMsYUFBYSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztnQkFDeEYsR0FBRyxDQUFDLE9BQU8sQ0FBQyxhQUFhLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLGFBQWEsRUFBRSxPQUFPLENBQUMsYUFBYSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztnQkFDeEYsR0FBRyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLE9BQU8sRUFBRSxPQUFPLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztnQkFDdEUsR0FBRyxDQUFDLE9BQU8sQ0FBQyxZQUFZLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLFlBQVksRUFBRSxPQUFPLENBQUMsWUFBWSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQzthQUN0RixDQUNGLENBQUM7WUFDRixNQUFNLFlBQVksR0FBRyxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsVUFBVSxFQUFFLE1BQU0sQ0FBQyxVQUFVLEVBQUUsT0FBTyxFQUFFLE1BQU0sQ0FBQyxPQUFPLEVBQUUsQ0FBQztZQUNwRyxJQUFJLE1BQU0sQ0FBQyxJQUFJLEVBQUUsQ0FBQztnQkFDaEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLFlBQVksRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUNyRCxDQUFDO2lCQUFNLENBQUM7Z0JBQ04sT0FBTyxDQUFDLEdBQUcsQ0FDVCxZQUFZLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxLQUFLLE1BQU0sQ0FBQyxPQUFPLENBQUMsV0FBVyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyx1REFBdUQsQ0FDbkosQ0FBQztZQUNKLENBQUM7WUFDRCxPQUFPLENBQUMsQ0FBQztRQUNYLENBQUM7UUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1lBQ2YsT0FBTyxnQkFBZ0IsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLGdCQUFnQixDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7UUFDaEUsQ0FBQztJQUNILENBQUM7SUFFRCxNQUFNLGVBQWUsR0FBRyxPQUFPLENBQUMsZUFBZSxLQUFLLFNBQVMsQ0FBQztJQUM5RCxNQUFNLGtCQUFrQixHQUFHLE9BQU8sQ0FBQyxrQkFBa0IsS0FBSyxTQUFTLENBQUM7SUFDcEUsTUFBTSxXQUFXLEdBQUcsQ0FBQyxPQUFPLENBQUMsZUFBZSxJQUFJLGVBQWUsQ0FBQyxFQUFFLENBQUM7SUFDbkUsTUFBTSxjQUFjLEdBQUcsQ0FBQyxPQUFPLENBQUMsa0JBQWtCLElBQUksdUJBQXVCLENBQUMsRUFBRSxDQUFDO0lBRWpGLElBQUksQ0FBQztRQUNILE1BQU0sTUFBTSxHQUFHLE1BQU0sd0JBQXdCLENBQzNDO1lBQ0UsWUFBWSxFQUFFLE1BQU0sQ0FBQyxZQUFZO1lBQ2pDLFFBQVEsRUFBRSxNQUFNLENBQUMsUUFBUTtZQUN6QixNQUFNLEVBQUUsTUFBTSxDQUFDLE1BQU07U0FDdEIsRUFDRDtZQUNFLFdBQVc7WUFDWCxjQUFjO1lBQ2Qsa0JBQWtCLEVBQUUsT0FBTyxDQUFDLGtCQUFrQixJQUFJLElBQUk7WUFDdEQsR0FBRyxDQUFDLE9BQU8sQ0FBQyxhQUFhLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLGFBQWEsRUFBRSxPQUFPLENBQUMsYUFBYSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztZQUN4RixHQUFHLENBQUMsT0FBTyxDQUFDLE9BQU8sS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsT0FBTyxFQUFFLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1lBQ3RFLFdBQVcsRUFBRSxPQUFPLENBQUMsV0FBVyxJQUFJLENBQUMsTUFBTSxrQkFBa0IsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFO1lBQ2pGLEdBQUcsQ0FBQyxPQUFPLENBQUMsVUFBVSxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRSxVQUFVLEVBQUUsT0FBTyxDQUFDLFVBQVUsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDL0UsR0FBRyxDQUFDLE9BQU8sQ0FBQyxXQUFXLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLFdBQVcsRUFBRSxPQUFPLENBQUMsV0FBVyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztZQUNsRixHQUFHLENBQUMsT0FBTyxDQUFDLGFBQWEsS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsYUFBYSxFQUFFLE9BQU8sQ0FBQyxhQUFhLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1lBQ3hGLEdBQUcsQ0FBQyxPQUFPLENBQUMsYUFBYSxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRSxhQUFhLEVBQUUsT0FBTyxDQUFDLGFBQWEsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDeEYsR0FBRyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLE9BQU8sRUFBRSxPQUFPLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztZQUN0RSxHQUFHLENBQUMsT0FBTyxDQUFDLFlBQVksS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsWUFBWSxFQUFFLE9BQU8sQ0FBQyxZQUFZLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1NBQ3RGLENBQ0YsQ0FBQztRQUVGLElBQUksTUFBTSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ2hCLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxNQUFNLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDL0MsQ0FBQzthQUFNLENBQUM7WUFDTixPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLEtBQUssTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLEdBQUcsQ0FBQyxDQUFDO1FBQ3JHLENBQUM7UUFDRCxPQUFPLENBQUMsQ0FBQztJQUNYLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2YsT0FBTyxnQkFBZ0IsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLGdCQUFnQixDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFDaEUsQ0FBQztZQUFTLENBQUM7UUFDVCxJQUFJLGVBQWU7WUFBRSxXQUFXLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDekMsSUFBSSxrQkFBa0I7WUFBRSxjQUFjLENBQUMsS0FBSyxFQUFFLENBQUM7SUFDakQsQ0FBQztBQUNILENBQUMifQ==