import type { AttemptCliResult } from "./attempt-cli.js";
import type { PortfolioQueueStore } from "./portfolio-queue.js";
import type { GovernorState } from "./governor-state.js";
import type { EventLedger } from "./event-ledger.js";
import type { GovernorLedger } from "./governor-ledger.js";
import type { RunStateStore } from "./run-state.js";
import type { PollPrDispositionOptions } from "./pr-disposition-poller.js";
import type { CheckRunConclusion, PollCheckRunsOptions } from "./ci-poller.js";
export type ParsedLoopArgs = {
    error: string;
} | {
    targets: string[];
    search: string | null;
    minerLogin: string;
    base: string;
    live: boolean;
    dryRun: boolean;
    maxCycles: number | undefined;
    cycleDelayMs: number;
    json: boolean;
};
export type LoopCycleSummary = {
    cycle: number;
    outcome: "idle_queue_empty" | "halted" | "attempted" | "skipped_malformed_identifier";
    reason?: string;
    repoFullName?: string;
    identifier?: string;
    attemptOutcome?: AttemptCliResult["outcome"] | "attempt_error";
    reentryOutcome?: "merged" | "disengaged" | "other";
    prNumber?: number | null;
    ciConclusion?: CheckRunConclusion | null;
    reentered?: boolean;
    reasons?: string[];
};
export type RunLoopOptions = {
    env?: Record<string, string | undefined>;
    nowMs?: number;
    githubToken?: string;
    apiBaseUrl?: string;
    sleepFn?: (delayMs: number) => Promise<void>;
    openGovernorState?: () => GovernorState;
    initEventLedger?: () => EventLedger;
    initGovernorLedger?: () => GovernorLedger;
    initPortfolioQueue?: () => PortfolioQueueStore;
    initRunStateStore?: () => RunStateStore;
    runDiscover?: (args: string[], options?: Record<string, unknown>) => Promise<number>;
    runAttempt?: (args: string[], options?: Record<string, unknown>) => Promise<number>;
    resolveAmsPolicy?: (repoFullName: string, options?: Record<string, unknown>) => Promise<{
        spec: Record<string, unknown>;
        source: string;
        warnings: string[];
    }>;
    checkMinerKillSwitch?: (input?: {
        env?: Record<string, string | undefined>;
        repoPaused?: boolean;
    }) => {
        scope: "global" | "repo" | "none";
        active: boolean;
    };
    evaluateRunLoopBoundaryGate?: (input: unknown, options?: unknown) => {
        verdict: {
            reason: string;
        };
        canClaimNext: boolean;
    };
    pollPrDisposition?: (repoFullName: string, prNumber: number, options?: PollPrDispositionOptions) => Promise<{
        state: "open" | "closed";
        merged: boolean;
        closedAt: string | null;
        attempts: number;
    }>;
    pollCheckRuns?: (repoFullName: string, prNumber: number, options?: PollCheckRunsOptions) => Promise<{
        conclusion: CheckRunConclusion;
        checks: unknown[];
        headSha: string;
        attempts: number;
    }>;
    recordPrOutcomeSnapshot?: (input: unknown, options?: unknown) => unknown;
    buildLoopClosureSummary?: (sources: unknown, options?: unknown) => {
        sinceSeq: number | null;
        lastSeq: number;
    };
    attemptLoopReentry?: (candidate: unknown, deps: unknown) => {
        decision: {
            reenter: boolean;
            reasons: string[];
        };
        dequeued: {
            repoFullName: string;
            identifier: string;
            priority: number;
            status: string;
            enqueuedAt: string;
        } | null;
    };
    attemptOptions?: Record<string, unknown>;
    prDispositionOptions?: PollPrDispositionOptions;
    ciPollOptions?: PollCheckRunsOptions;
};
export declare function parseLoopArgs(args: string[]): ParsedLoopArgs;
/**
 * Run one full discover -> claim -> attempt -> observe -> reenter cycle repeatedly until a kill-switch trips,
 * the run-loop boundary gate halts (non-convergence or a real budget/turn/elapsed cap), re-entry is declined,
 * or `--max-cycles` is reached. Fails closed: refuses to start at all if governor state cannot be loaded.
 *
 * @param {string[]} args
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   nowMs?: number,
 *   githubToken?: string,
 *   apiBaseUrl?: string,
 *   sleepFn?: (delayMs: number) => Promise<void>,
 *   openGovernorState?: typeof openGovernorState,
 *   initEventLedger?: typeof initEventLedger,
 *   initGovernorLedger?: typeof initGovernorLedger,
 *   initPortfolioQueue?: () => import("./portfolio-queue.js").PortfolioQueueStore,
 *   initRunStateStore?: typeof initRunStateStore,
 *   runDiscover?: typeof runDiscover,
 *   runAttempt?: typeof runAttempt,
 *   resolveAmsPolicy?: typeof resolveAmsPolicy,
 *   checkMinerKillSwitch?: typeof checkMinerKillSwitch,
 *   evaluateRunLoopBoundaryGate?: typeof evaluateRunLoopBoundaryGate,
 *   pollPrDisposition?: typeof pollPrDisposition,
 *   pollCheckRuns?: typeof pollCheckRuns,
 *   recordPrOutcomeSnapshot?: typeof recordPrOutcomeSnapshot,
 *   buildLoopClosureSummary?: typeof buildLoopClosureSummary,
 *   attemptLoopReentry?: typeof attemptLoopReentry,
 *   attemptOptions?: Record<string, unknown>,
 *   prDispositionOptions?: Record<string, unknown>,
 *   ciPollOptions?: Record<string, unknown>,
 * }} [options]
 * @returns {Promise<number>}
 */
export declare function runLoop(args: string[], options?: RunLoopOptions): Promise<number>;
