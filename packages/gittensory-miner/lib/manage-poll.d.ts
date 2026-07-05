import type { PollCheckRunsOptions, PollCheckRunsResult } from "./ci-poller.js";
import type { EventLedger, LedgerEntry } from "./event-ledger.js";
import type { PortfolioQueueStore } from "./portfolio-queue.js";

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
      json: boolean;
    }
  | { error: string };

export function mapPollConclusionToGateVerdict(
  conclusion: PollCheckRunsResult["conclusion"],
): string;

export function mapPollConclusionToOutcome(conclusion: PollCheckRunsResult["conclusion"]): string;

export function buildManagePollEventPayload(
  prNumber: number,
  pollResult: PollCheckRunsResult,
  options?: { branch?: string | null; lastPolledAt?: string },
): ManagePollEventPayload;

export function parseManagePollArgs(args?: string[]): ParsedManagePollArgs;

export function recordManagePollSnapshot(
  input: ManagePollInput,
  options: {
    eventLedger: EventLedger;
    portfolioQueue?: PortfolioQueueStore;
    ensurePortfolioRow?: boolean;
    pollCheckRuns?: (
      repoFullName: string,
      prNumber: number,
      options?: PollCheckRunsOptions,
    ) => Promise<PollCheckRunsResult>;
    lastPolledAt?: string;
  } & PollCheckRunsOptions,
): Promise<ManagePollRecordResult>;

export function runManagePoll(
  args?: string[],
  options?: {
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
  } & PollCheckRunsOptions,
): Promise<number>;
