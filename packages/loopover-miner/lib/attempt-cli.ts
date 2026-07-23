// CLI dispatch for the real attempt pipeline (#5132, Wave 3.5 -- the final assembly). Wires bin/loopover-miner.js's
// `attempt` subcommand to real infrastructure end to end: worktree allocation + real git preparation
// (worktree-allocator.js + attempt-worktree.js), the four ledgers (claim/event/attempt-log/governor), the
// real coding-agent driver (#5131) and slop assessor (#5133), a live SelfReviewContext fetch (#5145), a real
// coding-task spec (#5239), the operator's AmsPolicySpec execution policy (#5249), rejectionSignaled (#5241),
// a real runMinerAttempt call -- the first point in this epic where a real coding agent actually runs, not
// just checks-and-reports-blocked -- and, only on a real "submitted" outcome, a real post-submission
// claim-conflict resolution (#4848, claim-conflict-resolver.js) for the narrow race window
// checkSubmissionFreshness cannot see (two miners submitting almost simultaneously).
//
// KNOWN, DOCUMENTED GAPS (not fabricated -- see attempt-input-builder.js's own header for the full list):
// governor.selfPlagiarismCandidate/selfPlagiarismRecentSubmissions are omitted (chokepoint.ts's own design treats
// that as "skip that stage entirely"). governor.convergenceInput is now a real per-issue portfolio-queue.js read
// (#5654) and governor.reputationHistory a real per-repo governor-state.js read (#5675), not placeholders.

import {
  createAttemptDbFork,
  discardAttemptDbFork,
  fingerprintFromChangedFiles,
  resolveCodingAgentModeFromConfig,
  resolveFirstConfiguredCodingAgentDriverName,
} from "@loopover/engine";
import type { AttemptDbFork, AttemptDbForkConfig, CodingAgentExecutionMode, FeasibilityVerdict, LocalWriteActionSpec } from "@loopover/engine";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { resolveAttemptDbForkConfig } from "./attempt-db-fork-config.js";
import { constructProductionCodingAgentDriver } from "./coding-agent-construction.js";
import { runSlopAssessment } from "./slop-assessment.js";
import { fetchLiveIssueSnapshot } from "./live-issue-snapshot.js";
import { executeLocalWrite } from "./execute-local-write.js";
import { openClaimLedger } from "./claim-ledger.js";
import type { ClaimEntry, ClaimLedger } from "./claim-ledger.js";
import { resolveMinerGoalSpec } from "./miner-goal-spec.js";
import { resolveClaimConflict } from "./claim-conflict-resolver.js";
import type { ClaimConflictResult, resolveClaimConflict as ResolveClaimConflictFn } from "./claim-conflict-resolver.js";
import { parsePrNumberFromExecResult } from "./pr-number-parse.js";
import { initEventLedger } from "./event-ledger.js";
import type { EventLedger } from "./event-ledger.js";
import { initAttemptLog } from "./attempt-log.js";
import type { AttemptLog } from "./attempt-log.js";
import { initGovernorLedger } from "./governor-ledger.js";
import type { GovernorLedger } from "./governor-ledger.js";
import { openWorktreeAllocator } from "./worktree-allocator.js";
import type { WorktreeAllocation, WorktreeAllocator } from "./worktree-allocator.js";
import { isValidRepoSegment } from "./repo-clone.js";
import { REJECTION_REASON_AI_USAGE_POLICY_BAN, REJECTION_REASON_OWN_SUBMISSION_REJECTED, resolveRejectionSignaled } from "./rejection-signal.js";
import type { resolveRejectionSignaled as ResolveRejectionSignaledFn } from "./rejection-signal.js";
import { cleanupAttemptWorktree, prepareAttemptWorktree } from "./attempt-worktree.js";
import type {
  cleanupAttemptWorktree as CleanupAttemptWorktreeFn,
  prepareAttemptWorktree as PrepareAttemptWorktreeFn,
  PrepareAttemptWorktreeResult,
} from "./attempt-worktree.js";
import { fetchSelfReviewContext } from "./self-review-context.js";
import type { SelfReviewContextFetch, fetchSelfReviewContext as FetchSelfReviewContextFn } from "./self-review-context.js";
import { buildCodingTaskSpec } from "./coding-task-spec.js";
import type { buildCodingTaskSpec as BuildCodingTaskSpecFn } from "./coding-task-spec.js";
import { resolveAmsPolicy } from "./ams-policy.js";
import type { resolveAmsPolicy as ResolveAmsPolicyFn } from "./ams-policy.js";
import {
  buildAmsAttemptFailedPayload,
  buildAmsAttemptStartedPayload,
  scheduleAmsNotificationEvents,
  type PublishAmsNotificationEventsOptions,
} from "./ams-notifications.js";
import { checkMinerKillSwitch, recordMinerKillSwitchTransition } from "./governor-kill-switch.js";
import type { checkMinerKillSwitch as CheckMinerKillSwitchFn } from "./governor-kill-switch.js";
import { captureMinerError } from "./sentry.js";
import { buildAttemptGovernorContext, buildAttemptLoopInput } from "./attempt-input-builder.js";
import { getAttemptHistory } from "./portfolio-queue.js";
import type { getAttemptHistory as GetAttemptHistoryFn } from "./portfolio-queue.js";
import { loadReputationHistory, recordOwnSubmission } from "./governor-state.js";
import type { recordOwnSubmission as RecordOwnSubmissionFn } from "./governor-state.js";
import { runMinerAttempt } from "./attempt-runner.js";
import type { AttemptDeps, AttemptResult as RunMinerAttemptResult, runMinerAttempt as RunMinerAttemptFn } from "./attempt-runner.js";
import { resolveGitHubToken } from "./github-token-resolution.js";
import { isDiscoveryPlaneEnabled, submitSoftClaim } from "./discovery-index-client.js";
import type { submitSoftClaim as SubmitSoftClaimFn } from "./discovery-index-client.js";
import type { resolveMinerGoalSpec as ResolveMinerGoalSpecFn } from "./miner-goal-spec.js";


type CommonAttemptResultFields = {
  repoFullName: string;
  issueNumber: number;
  minerLogin: string;
  base: string;
  mode: CodingAgentExecutionMode;
  attemptId: string;
};

/** The result runAttempt reports at every real return point, threaded to `options.onResult` (in addition to
 *  the plain exit-code return runAttempt itself still returns, unchanged, so bin/loopover-miner.js's own
 *  `process.exit(exitCode)` usage never breaks) -- the loop orchestrator's real caller for this data. */
export type AttemptCliResult =
  | (CommonAttemptResultFields & { outcome: "dry_run" })
  | (CommonAttemptResultFields & { outcome: "blocked_rejection_signaled"; reason: string })
  | (CommonAttemptResultFields & { outcome: "blocked_worktree_preparation_failed"; reason: string })
  | (CommonAttemptResultFields & {
      outcome: "blocked_infeasible";
      reason: string;
      verdict: FeasibilityVerdict;
      avoidReasons: string[];
      raiseReasons: string[];
    })
  | (CommonAttemptResultFields & {
      outcome: `attempt_${RunMinerAttemptResult["outcome"]}`;
      submissionMode: "observe" | "enforce";
      totalTurnsUsed: number;
      totalCostUsd: number;
      totalTokensUsed: number;
      iterationsUsed: number;
      reason?: string;
      decision?: unknown;
      spec?: LocalWriteActionSpec;
      execResult?: unknown;
      claimConflict?: ClaimConflictResult;
    });

export type ParsedAttemptArgs =
  | { error: string }
  | {
      repoFullName: string;
      issueNumber: number;
      minerLogin: string;
      base: string;
      live: boolean;
      dryRun: boolean;
      json: boolean;
    };

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
  resolveRejectionSignaled?: typeof ResolveRejectionSignaledFn;
  fetchImpl?: SelfReviewContextFetch;
  prepareAttemptWorktree?: typeof PrepareAttemptWorktreeFn;
  cleanupAttemptWorktree?: typeof CleanupAttemptWorktreeFn;
  fetchSelfReviewContext?: typeof FetchSelfReviewContextFn;
  buildCodingTaskSpec?: typeof BuildCodingTaskSpecFn;
  resolveAmsPolicy?: typeof ResolveAmsPolicyFn;
  /** Neon branch-per-attempt disposable DB fork (#7858). Defaults to reading LOOPOVER_MINER_NEON_* env vars
   *  (attempt-db-fork-config.js) and, only when all three are set, the real @loopover/engine fork functions.
   *  An operator who hasn't configured Neon sees zero behavior change -- resolveAttemptDbForkConfig returns
   *  null and neither fork function is ever called. */
  resolveAttemptDbForkConfig?: typeof resolveAttemptDbForkConfig;
  createAttemptDbFork?: typeof createAttemptDbFork;
  discardAttemptDbFork?: typeof discardAttemptDbFork;
  checkMinerKillSwitch?: typeof CheckMinerKillSwitchFn;
  resolveMinerGoalSpec?: typeof ResolveMinerGoalSpecFn;
  runMinerAttempt?: typeof RunMinerAttemptFn;
  resolveClaimConflict?: typeof ResolveClaimConflictFn;
  recordOwnSubmission?: typeof RecordOwnSubmissionFn;
  getAttemptHistory?: typeof GetAttemptHistoryFn;
  /** Hosted soft-claim coordination at work-start/work-end, when the plane is enabled (#7168). Defaults to
   *  discovery-index-client.js's own submitSoftClaim. */
  submitSoftClaim?: typeof SubmitSoftClaimFn;
  /** AMS badge notifications (#7657). Defaults to scheduleAmsNotificationEvents (session POST / inject). */
  scheduleAmsNotifications?: (
    events: Parameters<typeof scheduleAmsNotificationEvents>[0],
    options?: PublishAmsNotificationEventsOptions,
  ) => void;
  /** Invoked with the real structured result at every return point, in addition to (never instead of) the
   *  plain exit-code return -- the loop orchestrator's real hook into what actually happened. */
  onResult?: (result: AttemptCliResult) => void;
};

const ATTEMPT_USAGE =
  "Usage: loopover-miner attempt <owner/repo> <issue#> --miner-login <login> [--base <branch>] [--live] [--dry-run] [--json]";

function parseRepoTarget(value: string): string | null {
  const trimmed = value.trim();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) return null;
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) return null;
  return `${owner}/${repo}`;
}

export function parseAttemptArgs(args: string[]): ParsedAttemptArgs {
  const options: {
    json: boolean;
    minerLogin: string | null;
    base: string;
    live: boolean;
    dryRun: boolean;
  } = { json: false, minerLogin: null, base: "main", live: false, dryRun: false };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--json") {
      options.json = true;
      continue;
    }
    // Opt-in only: resolveCodingAgentModeFromConfig's own default (no agentDryRun override) is "live", not
    // "dry_run" -- so #5132's "dry-run is default" acceptance criteria (#2342) has to be enforced HERE, by
    // requiring an explicit --live flag before this command will ever request live mode.
    if (token === "--live") {
      options.live = true;
      continue;
    }
    // #4847: distinct from --live's absence above -- --live only ever gated the coding-agent DRIVER's mode,
    // but a non---live run still opened every store and made real worktree/claim/ledger writes. --dry-run
    // short-circuits BEFORE any of that infrastructure is even opened, guaranteeing zero writes rather than
    // merely skipping the driver.
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--miner-login") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return { error: ATTEMPT_USAGE };
      options.minerLogin = value;
      index += 1;
      continue;
    }
    if (token === "--base") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return { error: ATTEMPT_USAGE };
      options.base = value;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    positional.push(token);
  }

  if (positional.length !== 2) return { error: ATTEMPT_USAGE };
  const repoFullName = parseRepoTarget(positional[0]!);
  if (!repoFullName) return { error: `Repository must be in owner/repo form: ${positional[0]}` };
  const issueNumber = Number(positional[1]);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    return { error: `Issue number must be a positive integer: ${positional[1]}` };
  }
  if (!options.minerLogin) return { error: `--miner-login is required. ${ATTEMPT_USAGE}` };

  return {
    repoFullName,
    issueNumber,
    minerLogin: options.minerLogin,
    base: options.base,
    live: options.live,
    dryRun: options.dryRun,
    json: options.json,
  };
}

/**
 * Assemble a real AttemptDeps object: every field wired to a genuine implementation (the #5131 driver, the
 * #5133 slop assessor, the four real ledgers passed in, and the fetchLiveIssueSnapshot/executeLocalWrite
 * built alongside this file). Throws if the coding-agent driver is unconfigured (fails closed, matching
 * constructProductionCodingAgentDriver's own contract) -- callers should report that clearly rather than
 * silently falling back to a driver that could never run.
 */
export function buildAttemptDeps(
  env: Record<string, string | undefined>,
  ledgers: { claimLedger: ClaimLedger; eventLedger: EventLedger; attemptLog: AttemptLog; governorLedger: GovernorLedger; nowMs: number },
): AttemptDeps {
  // AttemptDeps' claimLedger/callback parameter types are looser structural stubs than the real ledgers
  // (pre-existing .d.ts drift on attempt-runner); cast preserves the same runtime wiring the .js had.
  return {
    driver: constructProductionCodingAgentDriver(env),
    runSlopAssessment: (input) => runSlopAssessment(input as Parameters<typeof runSlopAssessment>[0]),
    appendAttemptLogEvent: (event) => {
      ledgers.attemptLog.appendAttemptLogEvent(event as Parameters<AttemptLog["appendAttemptLogEvent"]>[0]);
    },
    claimLedger: ledgers.claimLedger as AttemptDeps["claimLedger"],
    // resolveGitHubToken (#6116): GITHUB_TOKEN env override wins outright, else a live token from the
    // authenticated `loopover-mcp login` session -- cached in memory, so repeat calls within this process
    // don't repeatedly hit the session-fetch endpoint after the first successful resolution.
    fetchLiveIssueSnapshot: async (repoFullName: string, issueNumber: number) => {
      // resolveGitHubToken returns string | null; exactOptionalPropertyTypes forbids explicit undefined.
      const githubToken = await resolveGitHubToken(env as NodeJS.ProcessEnv);
      return fetchLiveIssueSnapshot(
        repoFullName,
        issueNumber,
        githubToken !== null ? { githubToken } : {},
      );
    },
    eventLedger: ledgers.eventLedger,
    governorLedgerAppend: (event) =>
      ledgers.governorLedger.appendGovernorEvent(event as Parameters<GovernorLedger["appendGovernorEvent"]>[0]),
    nowMs: ledgers.nowMs,
    executeLocalWrite: (spec) => executeLocalWrite(spec as Parameters<typeof executeLocalWrite>[0]),
  };
}

/**
 * Run the `attempt` CLI subcommand end to end: resolveRejectionSignaled (before consuming a worktree slot) ->
 * acquire a concurrency slot -> assemble real AttemptDeps -> prepare a REAL git worktree -> fetch a real
 * SelfReviewContext -> build a real coding-task spec (blocks on an infeasible verdict) -> resolve the real
 * AmsPolicySpec execution policy -> assemble the real IterateLoopInput + Governor context -> call
 * runMinerAttempt for real. The worktree is cleaned up (or retained, per the real outcome) in `finally`.
 * See this file's header for the documented gaps (real convergence history).
 */
export async function runAttempt(args: string[], options: RunAttemptOptions = {}): Promise<number> {
  const parsed = parseAttemptArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  const resolveMode = options.resolveCodingAgentModeFromConfig ?? resolveCodingAgentModeFromConfig;
  // resolveCodingAgentModeFromConfig accepts agentDryRun at runtime; RunAttemptOptions injectable omits it (.d.ts drift).
  const mode = resolveMode({ env, agentDryRun: !parsed.live } as { env?: Record<string, string | undefined> });

  if (mode === "paused") {
    return reportCliFailure(
      parsed.json,
      `Coding-agent execution is globally paused (MINER_CODING_AGENT_PAUSED). Not running attempt for ${parsed.repoFullName}#${parsed.issueNumber}.`,
      3,
    );
  }

  const attemptId = options.attemptId ?? `${parsed.repoFullName.replace("/", "_")}-${parsed.issueNumber}-${nowMs}`;

  // #4847: reports what a real run would do and returns BEFORE any store (allocator/claim/event/attempt-log/
  // governor ledger) is even opened, so this is a provable zero-write path -- not just "opened but didn't
  // write to" the local stores, and nowhere near the real worktree clone, claim, or coding-agent driver.
  if (parsed.dryRun) {
    const dryRunResult = {
      outcome: "dry_run",
      repoFullName: parsed.repoFullName,
      issueNumber: parsed.issueNumber,
      minerLogin: parsed.minerLogin,
      base: parsed.base,
      mode,
      attemptId,
    };
    if (parsed.json) {
      console.log(JSON.stringify(dryRunResult, null, 2));
    } else {
      console.log(
        `DRY RUN: would attempt ${parsed.repoFullName}#${parsed.issueNumber} for ${parsed.minerLogin} (mode: ${mode}, base: ${parsed.base}). No worktree, claim, or ledger writes were made.`,
      );
    }
    options.onResult?.(dryRunResult as AttemptCliResult);
    return 0;
  }

  let allocator: WorktreeAllocator | null = null;
  let claimLedger: ClaimLedger | null = null;
  let eventLedger: EventLedger | null = null;
  let attemptLog: AttemptLog | null = null;
  let governorLedger: GovernorLedger | null = null;
  let allocation: WorktreeAllocation | null = null;
  let worktreeResult: (PrepareAttemptWorktreeResult & { attemptOk?: boolean }) | null = null;
  let claimedIssue = false;
  let claimRecord: ClaimEntry | null = null;
  // #7858: resolved once so create/discard always agree on the same config, even if env somehow changed
  // mid-attempt (it never does in practice -- this just avoids re-reading env twice for the same answer).
  const dbForkConfig: AttemptDbForkConfig | null = (options.resolveAttemptDbForkConfig ?? resolveAttemptDbForkConfig)(env);
  let dbFork: AttemptDbFork | null = null;

  try {
    allocator = (options.openWorktreeAllocator ?? openWorktreeAllocator)();
    claimLedger = (options.openClaimLedger ?? openClaimLedger)();
    eventLedger = (options.initEventLedger ?? initEventLedger)();
    attemptLog = (options.initAttemptLog ?? initAttemptLog)();
    governorLedger = (options.initGovernorLedger ?? initGovernorLedger)();

    // Checked before acquiring a worktree slot: a rejection-signaled repo should never consume one.
    // resolveRejectionSignaled resolves both documented triggers (#5132 policy ban, #5655 own-rejection
    // history) and returns a trigger-specific reason string for accurate audit-trail labeling.
    const resolveRejection = options.resolveRejectionSignaled ?? resolveRejectionSignaled;
    // Pass fetchImpl through even when unset (same shape the .js always produced); cast for
    // exactOptionalPropertyTypes vs RejectionSignaledOptions (pre-existing optional-prop drift).
    const rejectionSignal = await resolveRejection(parsed.repoFullName, {
      fetchImpl: options.fetchImpl,
    } as Parameters<typeof resolveRejectionSignaled>[1]);
    if (rejectionSignal) {
      const reason =
        rejectionSignal === true ? REJECTION_REASON_AI_USAGE_POLICY_BAN : rejectionSignal;
      attemptLog.appendAttemptLogEvent({
        eventType: "attempt_aborted",
        attemptId,
        actionClass: "open_pr",
        mode,
        reason,
        payload: { repoFullName: parsed.repoFullName, issueNumber: parsed.issueNumber },
      });
      eventLedger.appendEvent({
        type: "attempt_blocked",
        repoFullName: parsed.repoFullName,
        payload: { issueNumber: parsed.issueNumber, reason },
      });
      const rejectedResult = {
        outcome: "blocked_rejection_signaled",
        reason,
        repoFullName: parsed.repoFullName,
        issueNumber: parsed.issueNumber,
        minerLogin: parsed.minerLogin,
        base: parsed.base,
        mode,
        attemptId,
      };
      if (parsed.json) {
        console.log(JSON.stringify(rejectedResult, null, 2));
      } else {
        console.error(
          reason === REJECTION_REASON_OWN_SUBMISSION_REJECTED
            ? `Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: this miner was previously rejected on this repo.`
            : `Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: this repo's AI-usage policy bans automated/AI-authored contributions.`,
        );
      }
      options.onResult?.(rejectedResult as AttemptCliResult);
      return 5;
    }

    allocation = allocator.acquire(attemptId, parsed.repoFullName);

    // #7858: only when the operator has configured Neon (dbForkConfig !== null) -- otherwise a complete
    // no-op, zero behavior change. A failure here ABORTS the attempt rather than proceeding without
    // isolation: this feature exists specifically so the coding agent's writes never reach the tenant's real
    // database, so silently continuing on a fork failure would defeat the entire safety property it provides.
    if (dbForkConfig) {
      try {
        const createFork = options.createAttemptDbFork ?? createAttemptDbFork;
        dbFork = await createFork(dbForkConfig, attemptId);
      } catch (error) {
        const reason = describeCliError(error);
        return reportCliFailure(
          parsed.json,
          `Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: could not create the disposable DB fork: ${reason}`,
          3,
        );
      }
    }

    let deps;
    try {
      const buildDeps = options.buildAttemptDeps ?? buildAttemptDeps;
      deps = buildDeps(env, { claimLedger, eventLedger, attemptLog, governorLedger, nowMs });
    } catch (error) {
      const reason = describeCliError(error);
      return reportCliFailure(
        parsed.json,
        `Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: ${reason}`,
        3,
      );
    }

    // Real worktree preparation (repo-clone.js + attempt-worktree.js, #5237): the allocator above only
    // reserves a concurrency SLOT (worktree-allocator.js's own `slot-N` placeholder dirs never receive real
    // git content) -- this is the step that actually clones/fetches the target repo and creates a real
    // `git worktree` for this attempt. Its own path, NOT the allocator's slot path, is the real
    // workingDirectory a future runMinerAttempt call must use.
    const prepareWorktree = options.prepareAttemptWorktree ?? prepareAttemptWorktree;
    worktreeResult = await prepareWorktree(parsed.repoFullName, attemptId, { baseBranch: parsed.base, env });
    if (!worktreeResult.ok) {
      const reason = worktreeResult.error;
      attemptLog.appendAttemptLogEvent({
        eventType: "attempt_aborted",
        attemptId,
        actionClass: "open_pr",
        mode,
        reason,
        payload: { repoFullName: parsed.repoFullName, issueNumber: parsed.issueNumber },
      });
      eventLedger.appendEvent({
        type: "attempt_blocked",
        repoFullName: parsed.repoFullName,
        payload: { issueNumber: parsed.issueNumber, reason },
      });
      const worktreeFailureResult = {
        outcome: "blocked_worktree_preparation_failed",
        reason,
        repoFullName: parsed.repoFullName,
        issueNumber: parsed.issueNumber,
        minerLogin: parsed.minerLogin,
        base: parsed.base,
        mode,
        attemptId,
      };
      if (parsed.json) {
        console.log(JSON.stringify(worktreeFailureResult, null, 2));
      } else {
        console.error(`Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: real worktree preparation failed: ${reason}`);
      }
      options.onResult?.(worktreeFailureResult as AttemptCliResult);
      return 6;
    }

    // Real SelfReviewContext (#5145): issue/PR/manifest data at live-gate fidelity for the target repo.
    const fetchReviewContext = options.fetchSelfReviewContext ?? fetchSelfReviewContext;
    const reviewGithubToken = await resolveGitHubToken(env as NodeJS.ProcessEnv);
    const reviewContext = await fetchReviewContext(parsed.repoFullName, {
      ...(reviewGithubToken !== null ? { githubToken: reviewGithubToken } : {}),
      contributorLogin: parsed.minerLogin,
      linkedIssues: [parsed.issueNumber],
    });

    // The target issue's own real record, when present in the fetched context. When absent (e.g. already
    // closed, or genuinely not found), buildCodingTaskSpec's own feasibility check reports target_not_found
    // and this placeholder's empty title/body are never surfaced anywhere -- not fabricated content, just an
    // inert shape for a verdict that immediately blocks.
    const targetIssue = reviewContext.issues.find((candidate) => candidate.number === parsed.issueNumber) ?? {
      number: parsed.issueNumber,
      title: "",
      body: null,
      labels: [],
    };

    const buildTaskSpec = options.buildCodingTaskSpec ?? buildCodingTaskSpec;
    // CodingTaskClaimLedger's listClaims filter types status as plain string (pre-existing .d.ts drift).
    const codingTaskSpec = buildTaskSpec({
      repoFullName: parsed.repoFullName,
      issue: targetIssue,
      context: { issues: reviewContext.issues, pullRequests: reviewContext.pullRequests },
      claimLedger: claimLedger as Parameters<typeof buildCodingTaskSpec>[0]["claimLedger"],
      workingDirectory: worktreeResult.worktreePath,
    });

    if (!codingTaskSpec.ready) {
      const reason = `infeasible_${codingTaskSpec.verdict}`;
      attemptLog.appendAttemptLogEvent({
        eventType: "attempt_aborted",
        attemptId,
        actionClass: "open_pr",
        mode,
        reason,
        payload: { repoFullName: parsed.repoFullName, issueNumber: parsed.issueNumber, feasibility: codingTaskSpec.feasibility },
      });
      eventLedger.appendEvent({
        type: "attempt_blocked",
        repoFullName: parsed.repoFullName,
        payload: { issueNumber: parsed.issueNumber, reason },
      });
      const infeasibleResult = {
        outcome: "blocked_infeasible",
        reason,
        verdict: codingTaskSpec.verdict,
        avoidReasons: codingTaskSpec.feasibility.avoidReasons,
        raiseReasons: codingTaskSpec.feasibility.raiseReasons,
        repoFullName: parsed.repoFullName,
        issueNumber: parsed.issueNumber,
        minerLogin: parsed.minerLogin,
        base: parsed.base,
        mode,
        attemptId,
      };
      if (parsed.json) {
        console.log(JSON.stringify(infeasibleResult, null, 2));
      } else {
        console.error(
          `Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: feasibility verdict "${codingTaskSpec.verdict}" (${[...codingTaskSpec.feasibility.avoidReasons, ...codingTaskSpec.feasibility.raiseReasons].join(", ")}).`,
        );
      }
      options.onResult?.(infeasibleResult as AttemptCliResult);
      return 4;
    }

    const amsPolicy = await (options.resolveAmsPolicy ?? resolveAmsPolicy)(parsed.repoFullName, { env });

    // Real per-repo pause (#5392): read straight from the already-cloned worktree's own .loopover-miner.yml
    // (resolveMinerGoalSpec never throws -- a missing/malformed file degrades to killSwitch.paused: false, so
    // this can't fail this attempt on its own). Threaded into BOTH checkMinerKillSwitch (killSwitchScope, used
    // by the freshness/submission gate) and the governor context (killSwitchRepoPaused, used by the Governor
    // chokepoint) -- the same two places the GLOBAL kill switch already reaches.
    const resolveGoalSpec = options.resolveMinerGoalSpec ?? resolveMinerGoalSpec;
    const minerGoalSpec = resolveGoalSpec(worktreeResult.repoPath);
    const repoPaused = minerGoalSpec.spec.killSwitch.paused;

    const checkKillSwitch = options.checkMinerKillSwitch ?? checkMinerKillSwitch;
    // recordMinerKillSwitchTransition is used at runtime but omitted from RunAttemptOptions (.d.ts drift).
    const recordKillTransition =
      (options as RunAttemptOptions & { recordMinerKillSwitchTransition?: typeof recordMinerKillSwitchTransition })
        .recordMinerKillSwitchTransition ?? recordMinerKillSwitchTransition;
    let killSwitchScope = checkKillSwitch({ env, repoPaused }).scope;
    let previousKillSwitchScope = killSwitchScope;

    // Captured after the ok-check above so the mid-attempt kill-switch probe can't see a null worktreeResult.
    const preparedWorktree = worktreeResult;
    const resolveLiveKillSwitch = () => {
      // Re-read the YAML flag each probe so an on-disk unpause/pause is reflected mid-attempt (#5670).
      const liveRepoPaused = resolveGoalSpec(preparedWorktree.repoPath).spec.killSwitch.paused;
      const live = checkKillSwitch({ env, repoPaused: liveRepoPaused });
      if (live.scope !== previousKillSwitchScope) {
        try {
          recordKillTransition({
            repoFullName: parsed.repoFullName,
            actionClass: "attempt",
            previousScope: previousKillSwitchScope,
            scope: live.scope,
          });
        } catch (error) {
          // Ledger append must never crash an aborting attempt (kept), but was previously silent -- a
          // kill-switch flip mid-attempt (a compliance-relevant event) could vanish with no record (#6011).
          captureMinerError(error, { kind: "kill_switch_transition_record_failed", repoFullName: parsed.repoFullName, scope: live.scope });
        }
        previousKillSwitchScope = live.scope;
      }
      killSwitchScope = live.scope;
      return live;
    };

    const shouldAbort = () => {
      const live = resolveLiveKillSwitch();
      if (!live.active) return false;
      return {
        abort: true,
        reason: `Kill-switch (${live.scope}) engaged mid-attempt; abandoning without starting another driver iteration.`,
      };
    };

    const loopInput = buildAttemptLoopInput({
      codingTaskSpec,
      reviewContext,
      worktreePath: worktreeResult.worktreePath,
      attemptId,
      mode,
      repoFullName: parsed.repoFullName,
      minerLogin: parsed.minerLogin,
      rejectionSignaled: false,
      amsPolicySpec: amsPolicy.spec,
      branchRef: worktreeResult.branchName,
    });

    // Real per-issue attempt history (#5654): portfolio-queue.js's own claim/reclaim/requeue/done counters,
    // keyed the same way opportunity-fanout.js enqueues issue-shaped candidates (`issue:<number>`). No
    // apiBaseUrl: this file has no multi-forge host context of its own today, so this reads (and every
    // pre-#5563 single-forge caller already reads) the github.com default.
    const readAttemptHistory = options.getAttemptHistory ?? getAttemptHistory;
    const convergenceInput = readAttemptHistory(parsed.repoFullName, `issue:${parsed.issueNumber}`);
    // Real per-repo reputation history (#5675): the miner's own decided/unfavorable outcome streak for this repo,
    // read from governor-state.js so the chokepoint's self-reputation throttle sees real data instead of nothing.
    // loadReputationHistory is used at runtime but omitted from RunAttemptOptions (.d.ts drift).
    const readReputationHistory =
      (options as RunAttemptOptions & { loadReputationHistory?: typeof loadReputationHistory }).loadReputationHistory ??
      loadReputationHistory;
    const reputationHistory = readReputationHistory(parsed.repoFullName);
    const governor = buildAttemptGovernorContext(env, amsPolicy.spec, repoPaused, convergenceInput, reputationHistory);

    // Real maxConcurrentClaims enforcement (#6758): the repo's .loopover-miner.yml cap is honored ATOMICALLY by
    // the ledger's count-and-claim, not by a listActiveClaims pre-check here. The old check-then-act split -- read
    // the count in this file, then record the claim in a separate claimLedger call -- let two sibling miner
    // processes racing the same repo both pass a stale sub-cap count and both claim, exceeding the cap.
    // claimIssueWithinCap fuses the count and the insert into one transaction; the loser gets `claimed: false`
    // and is reported below rather than silently dropped. This is also the real soft-claim (#5393): once it
    // returns claimed, a sibling process sees it via claimLedger.listActiveClaims while this attempt is in
    // flight, it is released in `finally` on every terminal outcome (mirroring the worktree allocation slot's
    // acquire-then-always-release), and its claimedAt feeds the post-submission conflict check further down (#4848).
    const claimResult = claimLedger.claimIssueWithinCap(
      parsed.repoFullName,
      parsed.issueNumber,
      `attempt:${attemptId}`,
      undefined,
      minerGoalSpec.spec.maxConcurrentClaims,
    );
    if (!claimResult.claimed) {
      const reason = "max_concurrent_claims_exceeded";
      attemptLog.appendAttemptLogEvent({
        eventType: "attempt_aborted",
        attemptId,
        actionClass: "open_pr",
        mode,
        reason,
        payload: {
          repoFullName: parsed.repoFullName,
          issueNumber: parsed.issueNumber,
          maxConcurrentClaims: minerGoalSpec.spec.maxConcurrentClaims,
          activeClaimCount: claimResult.activeClaimCount,
        },
      });
      eventLedger.appendEvent({
        type: "attempt_blocked",
        repoFullName: parsed.repoFullName,
        payload: { issueNumber: parsed.issueNumber, reason },
      });
      const blockedResult = {
        outcome: "blocked_max_concurrent_claims",
        reason,
        maxConcurrentClaims: minerGoalSpec.spec.maxConcurrentClaims,
        activeClaimCount: claimResult.activeClaimCount,
        repoFullName: parsed.repoFullName,
        issueNumber: parsed.issueNumber,
        minerLogin: parsed.minerLogin,
        base: parsed.base,
        mode,
        attemptId,
      };
      if (parsed.json) {
        console.log(JSON.stringify(blockedResult, null, 2));
      } else {
        console.error(
          `Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: this repo's maxConcurrentClaims cap (${minerGoalSpec.spec.maxConcurrentClaims}) is already met (${claimResult.activeClaimCount} active claim(s)).`,
        );
      }
      // blocked_max_concurrent_claims is a real runtime outcome omitted from AttemptCliResult (.d.ts drift).
      options.onResult?.(blockedResult as AttemptCliResult);
      return 11;
    }

    claimRecord = claimResult.claim;
    claimedIssue = true;
    // Hosted soft-claim coordination (#7168), opt-in via LOOPOVER_MINER_DISCOVERY_PLANE -- gated HERE at the
    // call site (not left to submitSoftClaim's own internal check alone) so a disabled plane costs zero calls,
    // matching discover-cli.js's supplementWithDiscoveryIndex gating; a caller-injected options.submitSoftClaim
    // (tests, or a future programmatic caller) can't accidentally bypass the opt-in this way either. Awaited
    // (not fire-and-forget) so a sibling instance racing the same issue is genuinely less likely to start
    // duplicate work in the window before this attempt's claim reaches the shared index -- the whole point of
    // coordinating BEFORE work begins, not after.
    if (isDiscoveryPlaneEnabled(env)) {
      const submitClaim = options.submitSoftClaim ?? submitSoftClaim;
      await submitClaim(claimRecord as Parameters<typeof SubmitSoftClaimFn>[0], { env });
    }

    const runAttemptPipeline = options.runMinerAttempt ?? runMinerAttempt;
    const scheduleAmsNotifications = options.scheduleAmsNotifications ?? scheduleAmsNotificationEvents;
    // AMS badge notify (#7657): attempt start — fire-and-forget through the hosted evaluate → deliver path.
    scheduleAmsNotifications(
      [
        buildAmsAttemptStartedPayload({
          recipientLogin: parsed.minerLogin,
          repoFullName: parsed.repoFullName,
          issueNumber: parsed.issueNumber,
          attemptId,
        }),
      ],
      { env: env as NodeJS.ProcessEnv },
    );
    let result;
    try {
      result = await runAttemptPipeline(
        {
          loopInput,
          issueNumber: parsed.issueNumber,
          minerLogin: parsed.minerLogin,
          base: parsed.base,
          killSwitchScope,
          slopThreshold: amsPolicy.spec.slopThreshold,
          submissionMode: amsPolicy.spec.submissionMode,
          governor,
        },
        {
          ...deps,
          shouldAbort,
          resolveKillSwitchScope: () => resolveLiveKillSwitch().scope,
        },
      );
    } catch (error) {
      // A real attempt that CRASHED is exactly the case that most needs its worktree kept for post-mortem
      // inspection, so record the failure explicitly before unwinding. Without this, `attemptOk` stayed
      // `undefined` and the finally block's `?? true` default (meant for the earlier blocked paths that never
      // ran anything in the worktree) deleted it -- inverting shouldRetainWorktree's documented policy.
      worktreeResult.attemptOk = false;
      scheduleAmsNotifications(
        [
          buildAmsAttemptFailedPayload({
            recipientLogin: parsed.minerLogin,
            repoFullName: parsed.repoFullName,
            issueNumber: parsed.issueNumber,
            attemptId,
            reason: "attempt_crashed",
          }),
        ],
        { env: env as NodeJS.ProcessEnv },
      );
      throw error;
    }

    worktreeResult.attemptOk = result.outcome === "submitted";
    if (result.outcome !== "submitted") {
      scheduleAmsNotifications(
        [
          buildAmsAttemptFailedPayload({
            recipientLogin: parsed.minerLogin,
            repoFullName: parsed.repoFullName,
            issueNumber: parsed.issueNumber,
            attemptId,
            reason: result.outcome,
          }),
        ],
        { env: env as NodeJS.ProcessEnv },
      );
    }

    // Real claim-conflict resolution (#4848): only meaningful once a real PR exists, so this only ever runs
    // on a real "submitted" outcome. checkSubmissionFreshness (inside runMinerAttempt) already caught the
    // common pre-submission case; this closes the narrower TOCTOU window where two miners raced past that
    // check almost simultaneously -- see claim-conflict-resolver.js's own header for why the adjudicator
    // can only run POST-submission (it needs a real PR number on both sides of the election).
    let claimConflict: ClaimConflictResult | undefined;
    if (result.outcome === "submitted") {
      const selfPrNumber = parsePrNumberFromExecResult(
        result.execResult as Parameters<typeof parsePrNumberFromExecResult>[0],
        parsed.repoFullName,
      );
      if (selfPrNumber !== null) {
        const resolveConflict = options.resolveClaimConflict ?? resolveClaimConflict;
        claimConflict = await resolveConflict(
          {
            repoFullName: parsed.repoFullName,
            issueNumber: parsed.issueNumber,
            selfPrNumber,
            selfClaimedAt: claimRecord.claimedAt,
            minerLogin: parsed.minerLogin,
          },
          { fetchLiveIssueSnapshot: deps.fetchLiveIssueSnapshot, executeLocalWrite: deps.executeLocalWrite },
        );
      }

      // Real own-submission history (#5655 follow-up): governor-state.js's recordOwnSubmission/
      // listRecentOwnSubmissions store (#5134) existed and was already READ by resolveOwnRejectionHistory
      // (#5655), but nothing ever WROTE to it -- attempt-runner.js's own header names this exact gap
      // ("real persistence primitives... but isn't auto-loaded here yet"). Left unfixed, that trigger is a
      // silent no-op in every real deployment: an empty table always resolves "no prior submissions found."
      // The fingerprint is the real changed-files set from the loop's own handoff packet (never fabricated) --
      // omitted (not recorded as an empty placeholder) when the packet reports no changed files at all. A
      // logging failure must never fail an otherwise-successful attempt, matching the summary-event write below.
      const changedFiles = result.loopResult.handoffPacket?.changedFiles?.map((file: { path: string }) => file.path) ?? [];
      const fingerprint = fingerprintFromChangedFiles(changedFiles);
      if (fingerprint) {
        try {
          const record = options.recordOwnSubmission ?? recordOwnSubmission;
          record({
            repoFullName: parsed.repoFullName,
            fingerprint,
            submittedAt: new Date(nowMs).toISOString(),
            pullRequestNumber: selfPrNumber,
            issueNumber: parsed.issueNumber,
          });
        } catch (error) {
          // A logging failure must never fail an otherwise-successful attempt (kept), but was previously
          // silent -- if this write fails AFTER a real PR has already opened, future self-plagiarism checks go
          // permanently blind to this exact submission with nobody told (#6011).
          captureMinerError(error, { kind: "record_own_submission_failed", repoFullName: parsed.repoFullName, pullRequestNumber: selfPrNumber });
        }
      }
    }

    const finalResult = {
      outcome: `attempt_${result.outcome}`,
      repoFullName: parsed.repoFullName,
      issueNumber: parsed.issueNumber,
      minerLogin: parsed.minerLogin,
      base: parsed.base,
      mode,
      attemptId,
      submissionMode: amsPolicy.spec.submissionMode,
      // Every runMinerAttempt outcome carries a real loopResult (#5135's loop needs its genuine turn-usage and
      // cost to save real GovernorCapUsage via governor-state.js's saveCapUsage -- nothing else in the codebase
      // calls it yet). Surfaced flat rather than the whole loopResult object, matching this result's own
      // shallow shape. costUsd is real only for the agent-sdk provider (its own SDK result message reports
      // total_cost_usd); CLI-subprocess providers (claude-cli/codex-cli) report no cost signal today, so this
      // is 0 for those -- an honest absence, not a fabricated number.
      totalTurnsUsed: result.loopResult.totalTurnsUsed,
      totalCostUsd: result.loopResult.totalCostUsd,
      // Real accumulated tokens (#5653) -- read from finalMeterTotals rather than a flat totalTokensUsed field
      // (IterateLoopResult has no such flat field, unlike turns/cost). 0 when no driver reported a token signal
      // on any iteration this attempt ran, never fabricated.
      totalTokensUsed: result.loopResult.finalMeterTotals.tokens,
      iterationsUsed: result.loopResult.iterationsUsed,
      ...(result.outcome === "abandon" && result.loopResult.finalDecision?.abandonReason
        ? { abandonReason: result.loopResult.finalDecision.abandonReason }
        : {}),
      ...("reason" in result ? { reason: result.reason } : {}),
      ...("decision" in result ? { decision: result.decision } : {}),
      ...("spec" in result ? { spec: result.spec } : {}),
      ...("execResult" in result ? { execResult: result.execResult } : {}),
      // Present only on a real "submitted" outcome whose PR number was recoverable from execResult -- omitted
      // (not fabricated as "checked: false") on every other outcome, and on a submitted outcome where the new
      // PR's number genuinely couldn't be parsed (an honest gap, not silently swallowed).
      ...(claimConflict !== undefined ? { claimConflict } : {}),
    };

    // One summary row per completed attempt (#5185), for the Grafana per-provider usage dashboard the redacted
    // AMS reporting export exposes -- distinct from the per-iteration attempt_started/attempt_tool_edit/... trail
    // iterate-loop.ts already writes. No fallback for an unconfigured provider: buildAttemptDeps already fails
    // closed (throws) on the same env before a worktree is even allocated, so reaching this point guarantees
    // resolveFirstConfiguredCodingAgentDriverName(env) resolves a real name. costUsd/tokensUsed are both real,
    // driver-reported accumulated totals (#5653) -- 0 when no iteration's driver reported a signal, never
    // fabricated. A logging failure must never fail an otherwise-successful attempt -- mirrors iterate-loop.ts's
    // own safeAppendAttemptLogEvent non-fatal handling.
    try {
      attemptLog.appendAttemptLogEvent({
        eventType: "attempt_outcome_summary",
        attemptId,
        actionClass: finalResult.outcome,
        mode,
        reason: `attempt finished with outcome: ${result.outcome}`,
        provider: resolveFirstConfiguredCodingAgentDriverName(env),
        costUsd: finalResult.totalCostUsd,
        tokensUsed: finalResult.totalTokensUsed,
      });
    } catch (error) {
      // A logging failure must never fail an otherwise-successful attempt (kept), but was previously silent --
      // per docs/observability.md this row feeds the Grafana per-provider cost/usage dashboard, so a failure
      // here silently drops the attempt from operator-facing metrics with nobody told (#6011).
      captureMinerError(error, { kind: "attempt_outcome_summary_append_failed", attemptId, repoFullName: parsed.repoFullName });
    }

    if (parsed.json) {
      console.log(JSON.stringify(finalResult, null, 2));
    } else {
      console.log(`Attempt for ${parsed.repoFullName}#${parsed.issueNumber} finished with outcome: ${result.outcome}.`);
    }
    options.onResult?.(finalResult as AttemptCliResult);

    switch (result.outcome) {
      case "submitted":
        return 0;
      case "abandon":
        return 7;
      case "stale":
        return 8;
      case "blocked":
        return 9;
      case "governed":
        return 10;
      default:
        return 2;
    }
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  } finally {
    // worktreeResult.attemptOk is set to the REAL runMinerAttempt outcome (submitted = true) once that call
    // happens, and explicitly to `false` when that call THROWS -- a crashed attempt is precisely what needs a
    // retained worktree to postmortem, so it must never fall through to the `?? true` default below. Every
    // earlier blocked path (rejection/worktree-prep-failure/infeasible) never sets it, since nothing ran in
    // the worktree to postmortem -- those are the cases that default to `true` (nothing to retain), matching
    // cleanupAttemptWorktree's own retention policy (a failed REAL attempt is what gets retained).
    if (worktreeResult?.ok) {
      const cleanupWorktree = options.cleanupAttemptWorktree ?? cleanupAttemptWorktree;
      await cleanupWorktree(worktreeResult.repoPath, worktreeResult.worktreePath, worktreeResult.attemptOk ?? true);
    }
    // Every terminal outcome past the claim point (submitted/abandon/stale/blocked/governed, or an
    // unexpected throw) releases the soft-claim -- a claim that outlives its own attempt process would
    // wrongly tell a sibling miner this issue is still in flight.
    if (claimedIssue && claimLedger) claimLedger.releaseClaim(parsed.repoFullName, parsed.issueNumber);
    // Paired hosted release (#7168): same call-site opt-in gate as the claim submission above. Only fires when
    // the initial claim submission actually ran (claimRecord is only set once claimedIssue is), so a run that
    // never reached the claim point (e.g. blocked_max_concurrent_claims) has nothing to release remotely.
    if (claimedIssue && claimRecord && isDiscoveryPlaneEnabled(env)) {
      const submitClaim = options.submitSoftClaim ?? submitSoftClaim;
      await submitClaim({ ...claimRecord, status: "released" } as Parameters<typeof SubmitSoftClaimFn>[0], { env });
    }
    if (allocation && allocator) allocator.release(attemptId);
    // #7858: discard the disposable DB fork on every terminal outcome, mirroring the worktree release above.
    // Never merged back into the parent -- a hard requirement #7649 ratified explicitly. A discard failure
    // must never crash the rest of this cleanup sequence (same discipline as the kill-switch ledger append
    // above) -- it leaks one Neon branch rather than losing the claim/ledger release that follows it, and is
    // still surfaced to Sentry so an operator can clean it up by hand.
    if (dbFork && dbForkConfig) {
      try {
        const discardFork = options.discardAttemptDbFork ?? discardAttemptDbFork;
        await discardFork(dbForkConfig, attemptId);
      } catch (error) {
        captureMinerError(error, { kind: "attempt_db_fork_discard_failed", repoFullName: parsed.repoFullName, attemptId, branchId: dbFork.branchId });
      }
    }
    allocator?.close();
    claimLedger?.close();
    eventLedger?.close();
    attemptLog?.close();
    governorLedger?.close();
  }
}
