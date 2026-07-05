import { pollCheckRuns } from "./ci-poller.js";
import { initEventLedger } from "./event-ledger.js";
import {
  MANAGE_PR_UPDATE_EVENT,
  formatManagedPrIdentifier,
} from "./manage-status.js";
import { initPortfolioQueueStore } from "./portfolio-queue.js";

const MANAGE_POLL_USAGE =
  "Usage: gittensory-miner manage poll <owner/repo> <pr#> [--branch <name>] [--json]";

function parseRepoArg(value, usage) {
  if (!value) return { error: usage };
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
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error("invalid_pr_number");
  if (!pollResult || typeof pollResult !== "object") throw new Error("invalid_poll_result");
  const branch = typeof options.branch === "string" && options.branch.trim() ? options.branch.trim() : null;
  const lastPolledAt =
    typeof options.lastPolledAt === "string" && options.lastPolledAt.trim()
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
  const options = { json: false, branch: null };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--branch") {
      const branch = args[index + 1];
      if (!branch || branch.startsWith("-")) return { error: MANAGE_POLL_USAGE };
      options.branch = branch;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    positional.push(token);
  }

  if (positional.length !== 2) return { error: MANAGE_POLL_USAGE };

  const repo = parseRepoArg(positional[0], MANAGE_POLL_USAGE);
  if ("error" in repo) return repo;

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

function ensureManagedPrRow(portfolioQueue, repoFullName, prNumber) {
  const identifier = formatManagedPrIdentifier(prNumber);
  const exists = portfolioQueue
    .listQueue(repoFullName)
    .some((entry) => entry.identifier === identifier);
  if (!exists) {
    portfolioQueue.enqueue({ repoFullName, identifier, priority: 0 });
  }
}

/**
 * Poll GitHub check runs for a managed PR and append a `manage_pr_update` snapshot to the local event ledger.
 * Completes the manage-status data path introduced in #2325 / #3070 using the CI poller from #2323.
 */
export async function recordManagePollSnapshot(input, options = {}) {
  if (!input || typeof input !== "object") throw new Error("invalid_manage_poll_input");
  const repoFullName = typeof input.repoFullName === "string" ? input.repoFullName.trim() : "";
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0) throw new Error("invalid_pr_number");

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
    ensureManagedPrRow(portfolioQueue, repoFullName, input.prNumber);
  }

  const event = eventLedger.appendEvent({
    type: MANAGE_PR_UPDATE_EVENT,
    repoFullName,
    payload,
  });

  return { pollResult, payload, event };
}

export async function runManagePoll(args = [], options = {}) {
  const parsed = parseManagePollArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  const ownsEventLedger = options.initEventLedger === undefined;
  const ownsPortfolioQueue = options.initPortfolioQueue === undefined;
  const eventLedger = (options.initEventLedger ?? initEventLedger)();
  const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();

  try {
    const result = await recordManagePollSnapshot(
      {
        repoFullName: parsed.repoFullName,
        prNumber: parsed.prNumber,
        branch: parsed.branch,
      },
      {
        eventLedger,
        portfolioQueue,
        ensurePortfolioRow: options.ensurePortfolioRow ?? true,
        pollCheckRuns: options.pollCheckRuns,
        fetchFn: options.fetchFn,
        githubToken: options.githubToken ?? process.env.GITHUB_TOKEN ?? "",
        apiBaseUrl: options.apiBaseUrl,
        maxAttempts: options.maxAttempts,
        minIntervalMs: options.minIntervalMs,
        maxIntervalMs: options.maxIntervalMs,
        sleepFn: options.sleepFn,
        lastPolledAt: options.lastPolledAt,
      },
    );

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${result.payload.ciState} (${result.payload.gateVerdict}/${result.payload.outcome})`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    if (ownsEventLedger) eventLedger.close();
    if (ownsPortfolioQueue) portfolioQueue.close();
  }
}
