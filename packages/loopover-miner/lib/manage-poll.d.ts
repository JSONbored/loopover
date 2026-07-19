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
export type ParsedManagePollArgs = {
    repoFullName: string;
    prNumber: number;
    branch: string | null;
    dryRun: boolean;
    json: boolean;
} | {
    error: string;
};
type ManagePollSnapshotOptions = {
    eventLedger: {
        appendEvent(event: unknown): LedgerEntry | null;
    };
    portfolioQueue?: PortfolioQueueStore;
    ensurePortfolioRow?: boolean;
    pollCheckRuns?: (repoFullName: string, prNumber: number, options?: PollCheckRunsOptions) => Promise<PollCheckRunsResult>;
    lastPolledAt?: string;
} & PollCheckRunsOptions;
type RunManagePollOptions = {
    initEventLedger?: () => EventLedger;
    initPortfolioQueue?: () => PortfolioQueueStore;
    ensurePortfolioRow?: boolean;
    pollCheckRuns?: (repoFullName: string, prNumber: number, options?: PollCheckRunsOptions) => Promise<PollCheckRunsResult>;
    githubToken?: string;
    lastPolledAt?: string;
} & PollCheckRunsOptions;
export declare function mapPollConclusionToGateVerdict(conclusion: PollCheckRunsResult["conclusion"]): string;
export declare function mapPollConclusionToOutcome(conclusion: PollCheckRunsResult["conclusion"]): string;
export declare function buildManagePollEventPayload(prNumber: number, pollResult: PollCheckRunsResult, options?: {
    branch?: string | null;
    lastPolledAt?: string;
}): ManagePollEventPayload;
export declare function parseManagePollArgs(args?: string[]): ParsedManagePollArgs;
/**
 * Poll GitHub check runs for a managed PR and append a `manage_pr_update` snapshot to the local event ledger.
 * Completes the manage-status data path introduced in #2325 / #3070 using the CI poller from #2323.
 */
export declare function recordManagePollSnapshot(input: ManagePollInput, options: ManagePollSnapshotOptions): Promise<ManagePollRecordResult>;
export declare function runManagePoll(args?: string[], options?: RunManagePollOptions): Promise<number>;
export {};
