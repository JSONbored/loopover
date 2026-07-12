// CLI dispatch for the real attempt pipeline (#5132, Wave 3.5 -- the final assembly). Wires bin/gittensory-miner.js's
// `attempt` subcommand to real infrastructure end to end: worktree allocation + real git preparation
// (worktree-allocator.js + attempt-worktree.js), the four ledgers (claim/event/attempt-log/governor), the
// real coding-agent driver (#5131) and slop assessor (#5133), a live SelfReviewContext fetch (#5145), a real
// coding-task spec (#5239), the operator's AmsPolicySpec execution policy (#5249), rejectionSignaled (#5241),
// and finally a real runMinerAttempt call -- the first point in this epic where a real coding agent actually
// runs, not just checks-and-reports-blocked.
//
// KNOWN, DOCUMENTED GAPS (not fabricated -- see attempt-input-builder.js's own header for the full list):
// governor.convergenceInput is an honest first-attempt-shaped literal, not a real per-issue attempt-history
// query (attempt-log.js's schema has no repo+issue index, and reenqueue counts aren't tracked anywhere yet).

import { resolveCodingAgentModeFromConfig } from "@jsonbored/gittensory-engine";
import { constructProductionCodingAgentDriver } from "./coding-agent-construction.js";
import { runSlopAssessment } from "./slop-assessment.js";
import { fetchLiveIssueSnapshot } from "./live-issue-snapshot.js";
import { executeLocalWrite } from "./execute-local-write.js";
import { openClaimLedger } from "./claim-ledger.js";
import { resolveMinerGoalSpec } from "./miner-goal-spec.js";
import { initEventLedger } from "./event-ledger.js";
import { initAttemptLog } from "./attempt-log.js";
import { initGovernorLedger } from "./governor-ledger.js";
import { openWorktreeAllocator } from "./worktree-allocator.js";
import { resolveRejectionSignaled } from "./rejection-signal.js";
import { cleanupAttemptWorktree, prepareAttemptWorktree } from "./attempt-worktree.js";
import { fetchSelfReviewContext } from "./self-review-context.js";
import { buildCodingTaskSpec } from "./coding-task-spec.js";
import { resolveAmsPolicy } from "./ams-policy.js";
import { checkMinerKillSwitch } from "./governor-kill-switch.js";
import { buildAttemptGovernorContext, buildAttemptLoopInput } from "./attempt-input-builder.js";
import { runMinerAttempt } from "./attempt-runner.js";

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
 * Run the `attempt` CLI subcommand end to end: resolveRejectionSignaled (before consuming a worktree slot) ->
 * acquire a concurrency slot -> assemble real AttemptDeps -> prepare a REAL git worktree -> fetch a real
 * SelfReviewContext -> build a real coding-task spec (blocks on an infeasible verdict) -> resolve the real
 * AmsPolicySpec execution policy -> assemble the real IterateLoopInput + Governor context -> call
 * runMinerAttempt for real. The worktree is cleaned up (or retained, per the real outcome) in `finally`.
 * See this file's header for the documented gaps (real convergence history).
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
  let claimedIssue = false;

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
      options.onResult?.(rejectedResult);
      return 5;
    }

    allocation = allocator.acquire(attemptId, parsed.repoFullName);

    let deps;
    try {
      const buildDeps = options.buildAttemptDeps ?? buildAttemptDeps;
      deps = buildDeps(env, { claimLedger, eventLedger, attemptLog, governorLedger, nowMs });
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
      options.onResult?.(worktreeFailureResult);
      return 6;
    }

    // Real SelfReviewContext (#5145): issue/PR/manifest data at live-gate fidelity for the target repo.
    const fetchReviewContext = options.fetchSelfReviewContext ?? fetchSelfReviewContext;
    const reviewContext = await fetchReviewContext(parsed.repoFullName, {
      githubToken: env.GITHUB_TOKEN,
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
    const codingTaskSpec = buildTaskSpec({
      repoFullName: parsed.repoFullName,
      issue: targetIssue,
      context: { issues: reviewContext.issues, pullRequests: reviewContext.pullRequests },
      claimLedger,
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
      options.onResult?.(infeasibleResult);
      return 4;
    }

    const amsPolicy = await (options.resolveAmsPolicy ?? resolveAmsPolicy)(parsed.repoFullName, { env });

    // Real per-repo pause (#5392): read straight from the already-cloned worktree's own .gittensory-miner.yml
    // (resolveMinerGoalSpec never throws -- a missing/malformed file degrades to killSwitch.paused: false, so
    // this can't fail this attempt on its own). Threaded into BOTH checkMinerKillSwitch (killSwitchScope, used
    // by the freshness/submission gate) and the governor context (killSwitchRepoPaused, used by the Governor
    // chokepoint) -- the same two places the GLOBAL kill switch already reaches.
    const resolveGoalSpec = options.resolveMinerGoalSpec ?? resolveMinerGoalSpec;
    const minerGoalSpec = resolveGoalSpec(worktreeResult.repoPath);
    const repoPaused = minerGoalSpec.spec.killSwitch.paused;

    const checkKillSwitch = options.checkMinerKillSwitch ?? checkMinerKillSwitch;
    const killSwitchScope = checkKillSwitch({ env, repoPaused }).scope;

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
    const governor = buildAttemptGovernorContext(env, amsPolicy.spec, repoPaused);

    // Real soft-claim (#5393): recorded once we've committed to a real attempt (past feasibility), so a
    // sibling miner process on this machine sees it via claimLedger.listClaims/listActiveClaims while this
    // attempt is in flight. Released in `finally` on every terminal outcome -- mirrors the worktree
    // allocation slot's own acquire-then-always-release pattern below.
    claimLedger.claimIssue(parsed.repoFullName, parsed.issueNumber, `attempt:${attemptId}`);
    claimedIssue = true;

    const runAttemptPipeline = options.runMinerAttempt ?? runMinerAttempt;
    const result = await runAttemptPipeline(
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
      deps,
    );

    worktreeResult.attemptOk = result.outcome === "submitted";
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
      iterationsUsed: result.loopResult.iterationsUsed,
      ...("reason" in result ? { reason: result.reason } : {}),
      ...("decision" in result ? { decision: result.decision } : {}),
      ...("spec" in result ? { spec: result.spec } : {}),
      ...("execResult" in result ? { execResult: result.execResult } : {}),
    };

    if (parsed.json) {
      console.log(JSON.stringify(finalResult, null, 2));
    } else {
      console.log(`Attempt for ${parsed.repoFullName}#${parsed.issueNumber} finished with outcome: ${result.outcome}.`);
    }
    options.onResult?.(finalResult);

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
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    // worktreeResult.attemptOk is set to the REAL runMinerAttempt outcome (submitted = true) once that call
    // happens; every earlier blocked path (rejection/worktree-prep-failure/infeasible) never sets it, since
    // nothing ran in the worktree to postmortem -- those default to `true` (nothing to retain), matching
    // cleanupAttemptWorktree's own retention policy (a failed REAL attempt is what gets retained).
    if (worktreeResult?.ok) {
      const cleanupWorktree = options.cleanupAttemptWorktree ?? cleanupAttemptWorktree;
      await cleanupWorktree(worktreeResult.repoPath, worktreeResult.worktreePath, worktreeResult.attemptOk ?? true);
    }
    // Every terminal outcome past the claim point (submitted/abandon/stale/blocked/governed, or an
    // unexpected throw) releases the soft-claim -- a claim that outlives its own attempt process would
    // wrongly tell a sibling miner this issue is still in flight.
    if (claimedIssue && claimLedger) claimLedger.releaseClaim(parsed.repoFullName, parsed.issueNumber);
    if (allocation && allocator) allocator.release(attemptId);
    allocator?.close();
    claimLedger?.close();
    eventLedger?.close();
    attemptLog?.close();
    governorLedger?.close();
  }
}
