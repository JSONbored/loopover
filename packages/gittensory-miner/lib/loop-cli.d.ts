import type { AttemptCliResult } from "./attempt-cli.js";
import type { PortfolioQueueStore } from "./portfolio-queue.js";
import type { GovernorState } from "./governor-state.js";
import type { EventLedger } from "./event-ledger.js";
import type { GovernorLedger } from "./governor-ledger.js";
import type { RunStateStore } from "./run-state.js";
import type { PollPrDispositionOptions } from "./pr-disposition-poller.js";

export type ParsedLoopArgs =
  | { error: string }
  | {
      targets: string[];
      search: string | null;
      minerLogin: string;
      base: string;
      live: boolean;
      maxCycles: number | undefined;
      cycleDelayMs: number;
      json: boolean;
    };

export function parseLoopArgs(args: string[]): ParsedLoopArgs;

export type LoopCycleSummary = {
  cycle: number;
  outcome: "idle_queue_empty" | "halted" | "attempted" | "skipped_malformed_identifier";
  reason?: string;
  repoFullName?: string;
  identifier?: string;
  attemptOutcome?: AttemptCliResult["outcome"] | "attempt_error";
  reentryOutcome?: "merged" | "disengaged" | "other";
  prNumber?: number | null;
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
  resolveAmsPolicy?: (repoFullName: string, options?: Record<string, unknown>) => Promise<{ spec: Record<string, unknown>; source: string; warnings: string[] }>;
  checkMinerKillSwitch?: (input?: { env?: Record<string, string | undefined>; repoPaused?: boolean }) => { scope: "global" | "repo" | "none"; active: boolean };
  evaluateRunLoopBoundaryGate?: (input: unknown, options?: unknown) => { verdict: { reason: string }; canClaimNext: boolean };
  pollPrDisposition?: (repoFullName: string, prNumber: number, options?: PollPrDispositionOptions) => Promise<{ state: "open" | "closed"; merged: boolean; closedAt: string | null; attempts: number }>;
  recordPrOutcomeSnapshot?: (input: unknown, options?: unknown) => unknown;
  buildLoopClosureSummary?: (sources: unknown, options?: unknown) => { sinceSeq: number | null; lastSeq: number };
  attemptLoopReentry?: (candidate: unknown, deps: unknown) => { decision: { reenter: boolean; reasons: string[] }; dequeued: { repoFullName: string; identifier: string; priority: number; status: string; enqueuedAt: string } | null };
  attemptOptions?: Record<string, unknown>;
  prDispositionOptions?: PollPrDispositionOptions;
};

export function runLoop(args: string[], options?: RunLoopOptions): Promise<number>;
