import type { CodingAgentExecutionMode } from "@jsonbored/gittensory-engine";
import type { AttemptDeps, runMinerAttempt } from "./attempt-runner.js";
import type { ClaimLedger } from "./claim-ledger.js";
import type { EventLedger } from "./event-ledger.js";
import type { AttemptLog } from "./attempt-log.js";
import type { GovernorLedger } from "./governor-ledger.js";
import type { WorktreeAllocator } from "./worktree-allocator.js";
import type { resolveRejectionSignaled } from "./rejection-signal.js";
import type { SelfReviewContextFetch, fetchSelfReviewContext } from "./self-review-context.js";
import type { cleanupAttemptWorktree, prepareAttemptWorktree } from "./attempt-worktree.js";
import type { buildCodingTaskSpec } from "./coding-task-spec.js";
import type { resolveAmsPolicy } from "./ams-policy.js";
import type { checkMinerKillSwitch } from "./governor-kill-switch.js";

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
  resolveRejectionSignaled?: typeof resolveRejectionSignaled;
  fetchImpl?: SelfReviewContextFetch;
  prepareAttemptWorktree?: typeof prepareAttemptWorktree;
  cleanupAttemptWorktree?: typeof cleanupAttemptWorktree;
  fetchSelfReviewContext?: typeof fetchSelfReviewContext;
  buildCodingTaskSpec?: typeof buildCodingTaskSpec;
  resolveAmsPolicy?: typeof resolveAmsPolicy;
  checkMinerKillSwitch?: typeof checkMinerKillSwitch;
  runMinerAttempt?: typeof runMinerAttempt;
};

export function runAttempt(args: string[], options?: RunAttemptOptions): Promise<number>;
