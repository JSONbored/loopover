// CLI dispatch for the real attempt pipeline (#5132, Wave 3.5). Wires bin/gittensory-miner.js's `attempt`
// subcommand to real infrastructure: worktree allocation (worktree-allocator.js's first real, non-test
// caller), the four ledgers (claim/event/attempt-log/governor), the real coding-agent driver (#5131) and
// slop assessor (#5133), the fetchLiveIssueSnapshot/executeLocalWrite built alongside this file, and mode
// resolution.
//
// KNOWN, DELIBERATE GAP: runMinerAttempt requires `loopInput.reviewContext: SelfReviewContext` (issue/PR/
// manifest data at live-gate fidelity, tracked by #5145) AND a full coding-task spec (title/instructions/
// acceptanceCriteriaPath, derived from the target issue -- no builder for that exists anywhere in this
// package either, a second gap discovered while building this file and noted on #5132). Rather than
// fabricate placeholder data for either -- which would let a self-review pass "look real" while checking
// nothing -- this command builds and verifies every OTHER real dependency, then reports the block clearly
// instead of calling runMinerAttempt with an invalid or fabricated input.

import { resolveCodingAgentModeFromConfig } from "@jsonbored/gittensory-engine";
import { constructProductionCodingAgentDriver } from "./coding-agent-construction.js";
import { runSlopAssessment } from "./slop-assessment.js";
import { fetchLiveIssueSnapshot } from "./live-issue-snapshot.js";
import { executeLocalWrite } from "./execute-local-write.js";
import { openClaimLedger } from "./claim-ledger.js";
import { initEventLedger } from "./event-ledger.js";
import { initAttemptLog } from "./attempt-log.js";
import { initGovernorLedger } from "./governor-ledger.js";
import { openWorktreeAllocator } from "./worktree-allocator.js";
import { resolveRejectionSignaled } from "./rejection-signal.js";
import { cleanupAttemptWorktree, prepareAttemptWorktree } from "./attempt-worktree.js";

const ATTEMPT_USAGE = "Usage: gittensory-miner attempt <owner/repo> <issue#> --miner-login <login> [--base <branch>] [--live] [--json]";

function parseRepoTarget(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) return null;
  return `${owner}/${repo}`;
}

export function parseAttemptArgs(args) {
  const options = { json: false, minerLogin: null, base: "main", live: false };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
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
  const repoFullName = parseRepoTarget(positional[0]);
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
    json: options.json,
  };
}

/**
 * Assemble a real AttemptDeps object: every field wired to a genuine implementation (the #5131 driver, the
 * #5133 slop assessor, the four real ledgers passed in, and the fetchLiveIssueSnapshot/executeLocalWrite
 * built alongside this file). Throws if the coding-agent driver is unconfigured (fails closed, matching
 * constructProductionCodingAgentDriver's own contract) -- callers should report that clearly rather than
 * silently falling back to a driver that could never run.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{
 *   claimLedger: import("./claim-ledger.js").ClaimLedger,
 *   eventLedger: import("./event-ledger.js").EventLedger,
 *   attemptLog: import("./attempt-log.js").AttemptLog,
 *   governorLedger: import("./governor-ledger.js").GovernorLedger,
 *   nowMs: number,
 * }} ledgers
 * @returns {import("./attempt-runner.js").AttemptDeps}
 */
export function buildAttemptDeps(env, ledgers) {
  return {
    driver: constructProductionCodingAgentDriver(env),
    runSlopAssessment: (input) => runSlopAssessment(input),
    appendAttemptLogEvent: (event) => ledgers.attemptLog.appendAttemptLogEvent(event),
    claimLedger: ledgers.claimLedger,
    fetchLiveIssueSnapshot: (repoFullName, issueNumber) => fetchLiveIssueSnapshot(repoFullName, issueNumber, { githubToken: env.GITHUB_TOKEN }),
    eventLedger: ledgers.eventLedger,
    governorLedgerAppend: (event) => ledgers.governorLedger.appendGovernorEvent(event),
    nowMs: ledgers.nowMs,
    executeLocalWrite: (spec) => executeLocalWrite(spec),
  };
}

/**
 * Run the `attempt` CLI subcommand. Checks resolveRejectionSignaled first (before consuming a worktree
 * slot), acquires a concurrency slot (worktree-allocator.js), assembles real AttemptDeps, then prepares a
 * REAL git worktree (attempt-worktree.js: clone/fetch + `git worktree add`) -- then, since no SelfReviewContext
 * fetcher or coding-task-spec builder exists yet, reports the block instead of calling runMinerAttempt with
 * fabricated data, and cleans up the now-unused worktree. See this file's header for why.
 */
export async function runAttempt(args, options = {}) {
  const parsed = parseAttemptArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  const resolveMode = options.resolveCodingAgentModeFromConfig ?? resolveCodingAgentModeFromConfig;
  const mode = resolveMode({ env, agentDryRun: !parsed.live });

  if (mode === "paused") {
    console.error(
      `Coding-agent execution is globally paused (MINER_CODING_AGENT_PAUSED). Not running attempt for ${parsed.repoFullName}#${parsed.issueNumber}.`,
    );
    return 3;
  }

  const attemptId = options.attemptId ?? `${parsed.repoFullName.replace("/", "_")}-${parsed.issueNumber}-${nowMs}`;

  let allocator = null;
  let claimLedger = null;
  let eventLedger = null;
  let attemptLog = null;
  let governorLedger = null;
  let allocation = null;
  let worktreeResult = null;

  try {
    allocator = (options.openWorktreeAllocator ?? openWorktreeAllocator)();
    claimLedger = (options.openClaimLedger ?? openClaimLedger)();
    eventLedger = (options.initEventLedger ?? initEventLedger)();
    attemptLog = (options.initAttemptLog ?? initAttemptLog)();
    governorLedger = (options.initGovernorLedger ?? initGovernorLedger)();

    // Checked before acquiring a worktree slot: a banned repo should never consume one. This resolves the
    // first of rejectionSignaled's two documented triggers (an explicit AI-usage-policy ban, #5132 follow-up)
    // -- the second (a prior own-submission rejection on this exact repo) remains a documented gap, see
    // rejection-signal.js's own header for why.
    const resolveRejection = options.resolveRejectionSignaled ?? resolveRejectionSignaled;
    const rejectionSignaled = await resolveRejection(parsed.repoFullName, { fetchImpl: options.fetchImpl });
    if (rejectionSignaled) {
      const reason = "ai_usage_policy_ban";
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
          `Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: this repo's AI-usage policy bans automated/AI-authored contributions.`,
        );
      }
      return 5;
    }

    allocation = allocator.acquire(attemptId, parsed.repoFullName);

    try {
      const buildDeps = options.buildAttemptDeps ?? buildAttemptDeps;
      buildDeps(env, { claimLedger, eventLedger, attemptLog, governorLedger, nowMs });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: ${reason}`);
      return 3;
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
      return 6;
    }

    const reason = "missing_self_review_context_and_task_spec";
    const blockedResult = {
      outcome: "blocked_missing_prerequisite",
      reason,
      trackingIssue: 5145,
      repoFullName: parsed.repoFullName,
      issueNumber: parsed.issueNumber,
      minerLogin: parsed.minerLogin,
      base: parsed.base,
      mode,
      attemptId,
      worktreePath: worktreeResult.worktreePath,
    };

    // "attempt_aborted" is the closest fit in ATTEMPT_LOG_EVENT_TYPES's fixed vocabulary
    // (@jsonbored/gittensory-engine) for "never started because a hard prerequisite is missing".
    attemptLog.appendAttemptLogEvent({
      eventType: "attempt_aborted",
      attemptId,
      actionClass: "open_pr",
      mode,
      reason,
      payload: { repoFullName: parsed.repoFullName, issueNumber: parsed.issueNumber, trackingIssue: 5145 },
    });
    eventLedger.appendEvent({
      type: "attempt_blocked",
      repoFullName: parsed.repoFullName,
      payload: { issueNumber: parsed.issueNumber, reason, trackingIssue: 5145 },
    });

    if (parsed.json) {
      console.log(JSON.stringify(blockedResult, null, 2));
    } else {
      console.log(
        `Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: no SelfReviewContext fetcher or coding-task-spec builder yet (tracked by #5145). Worktree, ledgers, driver, live-issue fetch, and local-write execution are wired and ready; runMinerAttempt was not invoked.`,
      );
    }
    return 4;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    // No real attempt ever ran in this worktree (every path above stops before invoking runMinerAttempt) --
    // there's nothing to postmortem, so it's always cleaned up (`attemptOk: true`), matching
    // cleanupAttemptWorktree's own retention policy for a worktree with no failure to inspect.
    if (worktreeResult?.ok) {
      const cleanupWorktree = options.cleanupAttemptWorktree ?? cleanupAttemptWorktree;
      await cleanupWorktree(worktreeResult.repoPath, worktreeResult.worktreePath, true);
    }
    if (allocation && allocator) allocator.release(attemptId);
    allocator?.close();
    claimLedger?.close();
    eventLedger?.close();
    attemptLog?.close();
    governorLedger?.close();
  }
}
