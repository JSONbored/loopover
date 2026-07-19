import { pollCheckRuns } from "./ci-poller.js";
import type { PollCheckRunsOptions, PollCheckRunsResult } from "./ci-poller.js";
import { initEventLedger } from "./event-ledger.js";
import type { EventLedger, LedgerEntry } from "./event-ledger.js";
import {
  MANAGE_PR_UPDATE_EVENT,
  formatManagedPrIdentifier,
} from "./manage-status.js";
import { initPortfolioQueueStore } from "./portfolio-queue.js";
import type { PortfolioQueueStore } from "./portfolio-queue.js";
import { DEFAULT_FORGE_CONFIG } from "./forge-config.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { resolveGitHubToken } from "./github-token-resolution.js";

const MANAGE_POLL_USAGE =
  "Usage: loopover-miner manage poll <owner/repo> <pr#> [--branch <name>] [--dry-run] [--json]";

export type ManagePollInput = {
  repoFullName: string;
  prNumber: number;
  branch?: string | null;
};

export type ManagePollEventPayload = {
  prNumber: number;
  branch: string | null;
  ciState: PollCheckRunsResult["conclusion"];
  gateVerdict: string;
  outcome: string;
  lastPolledAt: string;
};

export type ManagePollRecordResult = {
  pollResult: PollCheckRunsResult;
  payload: ManagePollEventPayload;
  event: LedgerEntry;
};

export type ParsedManagePollArgs =
  | {
      repoFullName: string;
      prNumber: number;
      branch: string | null;
      dryRun: boolean;
      json: boolean;
    }
  | { error: string };

type ManagePollSnapshotOptions = {
  eventLedger: { appendEvent(event: unknown): LedgerEntry | null };
  portfolioQueue?: PortfolioQueueStore;
  ensurePortfolioRow?: boolean;
  pollCheckRuns?: (
    repoFullName: string,
    prNumber: number,
    options?: PollCheckRunsOptions,
  ) => Promise<PollCheckRunsResult>;
  lastPolledAt?: string;
} & PollCheckRunsOptions;

type RunManagePollOptions = {
  initEventLedger?: () => EventLedger;
  initPortfolioQueue?: () => PortfolioQueueStore;
  ensurePortfolioRow?: boolean;
  pollCheckRuns?: (
    repoFullName: string,
    prNumber: number,
    options?: PollCheckRunsOptions,
  ) => Promise<PollCheckRunsResult>;
  githubToken?: string;
  lastPolledAt?: string;
} & PollCheckRunsOptions;

function parseRepoArg(
  value: string | undefined,
  usage: string,
): { repoFullName: string } | { error: string } {
  if (!value) return { error: usage };
  const trimmed = value.trim();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) {
    return { error: "Repository must be in owner/repo form." };
  }
  return { repoFullName: `${owner}/${repo}` };
}

export function mapPollConclusionToGateVerdict(
  conclusion: PollCheckRunsResult["conclusion"],
): string {
  switch (conclusion) {
    case "success":
      return "pass";
    case "failure":
      return "block";
    default:
      return "advisory";
  }
}

export function mapPollConclusionToOutcome(conclusion: PollCheckRunsResult["conclusion"]): string {
  switch (conclusion) {
    case "success":
      return "ready";
    case "failure":
      return "needs-work";
    default:
      return "open";
  }
}

export function buildManagePollEventPayload(
  prNumber: number,
  pollResult: PollCheckRunsResult,
  options: { branch?: string | null; lastPolledAt?: string } = {},
): ManagePollEventPayload {
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

export function parseManagePollArgs(args: string[] = []): ParsedManagePollArgs {
  const options: { json: boolean; branch: string | null; dryRun: boolean } = {
    json: false,
    branch: null,
    dryRun: false,
  };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
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

/** The forge host a managed-PR row belongs to. Mirrors portfolio-queue-manager.js's own fold (and every
 *  store's `normalizeApiBaseUrl`): omitted/blank → the github.com default, so a single-forge caller is
 *  unaffected. Used only to COMPARE hosts here; `enqueue` still does its own normalization/validation. */
function resolveManagedRowApiBaseUrl(apiBaseUrl: string | undefined): string {
  return typeof apiBaseUrl === "string" && apiBaseUrl.trim() ? apiBaseUrl.trim() : DEFAULT_FORGE_CONFIG.apiBaseUrl;
}

function ensureManagedPrRow(
  portfolioQueue: PortfolioQueueStore,
  repoFullName: string,
  prNumber: number,
  apiBaseUrl: string | undefined,
): void {
  const identifier = formatManagedPrIdentifier(prNumber);
  // `listQueue(repoFullName)` is forge-BLIND, so the existence check has to compare the host too: the queue's
  // composite (api_base_url, repo_full_name, identifier) key exists precisely so two hosts serving the same
  // owner/repo name never collide (#5563). Without this scoping, the same repo+PR-number already tracked on
  // ANOTHER host suppresses this host's row entirely.
  const targetApiBaseUrl = resolveManagedRowApiBaseUrl(apiBaseUrl);
  const exists = portfolioQueue
    .listQueue(repoFullName)
    .some(
      (entry) =>
        entry.identifier === identifier &&
        resolveManagedRowApiBaseUrl(entry.apiBaseUrl) === targetApiBaseUrl,
    );
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
export async function recordManagePollSnapshot(
  input: ManagePollInput,
  options: ManagePollSnapshotOptions,
): Promise<ManagePollRecordResult> {
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

  return { pollResult, payload, event: event as LedgerEntry };
}

export async function runManagePoll(
  args: string[] = [],
  options: RunManagePollOptions = {},
): Promise<number> {
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
      const result = await recordManagePollSnapshot(
        { repoFullName: parsed.repoFullName, prNumber: parsed.prNumber, branch: parsed.branch },
        {
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
        },
      );
      const dryRunResult = { outcome: "dry_run", pollResult: result.pollResult, payload: result.payload };
      if (parsed.json) {
        console.log(JSON.stringify(dryRunResult, null, 2));
      } else {
        console.log(
          `DRY RUN: ${result.payload.ciState} (${result.payload.gateVerdict}/${result.payload.outcome}). No event-ledger or portfolio-queue write was made.`,
        );
      }
      return 0;
    } catch (error) {
      return reportCliFailure(parsed.json, describeCliError(error));
    }
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
        ...(options.pollCheckRuns !== undefined ? { pollCheckRuns: options.pollCheckRuns } : {}),
        ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
        githubToken: options.githubToken ?? (await resolveGitHubToken(process.env)) ?? "",
        ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
        ...(options.minIntervalMs !== undefined ? { minIntervalMs: options.minIntervalMs } : {}),
        ...(options.maxIntervalMs !== undefined ? { maxIntervalMs: options.maxIntervalMs } : {}),
        ...(options.sleepFn !== undefined ? { sleepFn: options.sleepFn } : {}),
        ...(options.lastPolledAt !== undefined ? { lastPolledAt: options.lastPolledAt } : {}),
      },
    );

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${result.payload.ciState} (${result.payload.gateVerdict}/${result.payload.outcome})`);
    }
    return 0;
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  } finally {
    if (ownsEventLedger) eventLedger.close();
    if (ownsPortfolioQueue) portfolioQueue.close();
  }
}
