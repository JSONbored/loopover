import type { CodingAgentExecutionMode } from "@jsonbored/gittensory-engine";
import type { AttemptDeps } from "./attempt-runner.js";
import type { ClaimLedger } from "./claim-ledger.js";
import type { EventLedger } from "./event-ledger.js";
import type { AttemptLog } from "./attempt-log.js";
import type { GovernorLedger } from "./governor-ledger.js";
import type { WorktreeAllocator } from "./worktree-allocator.js";

export type ParsedAttemptArgs =
  | { error: string }
  | { repoFullName: string; issueNumber: number; minerLogin: string; base: string; live: boolean; json: boolean };

export function parseAttemptArgs(args: string[]): ParsedAttemptArgs;

export function buildAttemptDeps(
  env: Record<string, string | undefined>,
  ledgers: { claimLedger: ClaimLedger; eventLedger: EventLedger; attemptLog: AttemptLog; governorLedger: GovernorLedger; nowMs: number },
): AttemptDeps;

export type RunAttemptOptions = {
  env?: Record<string, string | undefined>;
  nowMs?: number;
  attemptId?: string;
  resolveCodingAgentModeFromConfig?: (config: { env?: Record<string, string | undefined> }) => CodingAgentExecutionMode;
  openWorktreeAllocator?: () => WorktreeAllocator;
  openClaimLedger?: () => ClaimLedger;
  initEventLedger?: () => EventLedger;
  initAttemptLog?: () => AttemptLog;
  initGovernorLedger?: () => GovernorLedger;
  buildAttemptDeps?: typeof buildAttemptDeps;
};

export function runAttempt(args: string[], options?: RunAttemptOptions): Promise<number>;
