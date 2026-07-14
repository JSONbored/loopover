// The autonomous supervising loop (#5135, Wave 3.5): the missing daemon/watch layer over the one-shot
// `discover`/`attempt` subcommands. Every existing piece it composes -- runDiscover, runAttempt,
// evaluateRunLoopBoundaryGate, attemptLoopReentry, buildLoopClosureSummary, governor-state.js -- already
// existed; this is the first caller that actually chains them into a real repeat-until-halted run.
//
// STRUCTURE (one cycle): kill-switch check -> pause-flag check (#4851, governor-state.js's persisted
// paused/reason/pausedAt) -> real-per-repo-policy-aware run-loop boundary gate (before claiming) -> real
// runAttempt -> real CI-status poll (ci-poller.js, #5394) + real PR-disposition poll
// (pr-disposition-poller.js, on a submitted outcome) -> real loop-closure summary -> real attemptLoopReentry
// decision. `attemptLoopReentry`'s own dequeue is the
// AUTHORITATIVE claim for every cycle after the first (its own doc: "if allowed -- dequeues the next
// candidate") -- this loop does not ALSO call portfolioQueue.dequeueNext() on a successful reentry, which
// would silently double-claim (the reentry's own claim would then leak as a permanently 'in_progress', never-
// attempted row). A manual dequeueNext() is used only to prime the very first cycle (no prior outcome exists
// yet to reenter from) and to refill after an empty queue.
//
// REAL, NOT FABRICATED: this loop is the first production caller of governor-state.js's `saveCapUsage`
// (turnsTaken from runMinerAttempt's own real `loopResult.totalTurnsUsed`, elapsedMs from real wall-clock
// measurement). Its per-identifier convergence history (attempts/consecutiveFailures/reenqueues) is the real,
// SQLite-persisted portfolio-queue attempt-history (portfolio-queue.js's getAttemptHistory, #5654) that the
// dequeueNext claim + markDone/markFailed calls below already maintain -- the same source a one-shot `attempt`
// invocation reads (#5654), so both share one source of truth and the counters survive a loop-daemon restart
// (crash/deploy/systemd bounce) instead of resetting with the process (#5677).

import { checkMinerKillSwitch } from "./governor-kill-switch.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { evaluateRunLoopBoundaryGate } from "./governor-run-halt.js";
import { openGovernorState } from "./governor-state.js";
import { initGovernorLedger } from "./governor-ledger.js";
import { initEventLedger } from "./event-ledger.js";
import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { initRunStateStore } from "./run-state.js";
import { runDiscover } from "./discover-cli.js";
import { runAttempt } from "./attempt-cli.js";
import { resolveAmsPolicy } from "./ams-policy.js";
import { pollPrDisposition, classifyPrDisposition } from "./pr-disposition-poller.js";
import { pollCheckRuns } from "./ci-poller.js";
import { recordPrOutcomeSnapshot } from "./pr-outcome.js";
import { isRejectedPr } from "./rejection-state-machine.js";
import { buildLoopClosureSummary } from "./loop-closure.js";
import { attemptLoopReentry } from "./loop-reentry.js";
import { parsePrNumberFromExecResult } from "./pr-number-parse.js";
import { DEFAULT_AMS_POLICY_SPEC } from "@loopover/engine";

const LOOP_USAGE =
  "Usage: loopover-miner loop <owner/repo> [<owner/repo>...] | --search <query> --miner-login <login> [--base <branch>] [--live] [--dry-run] [--max-cycles <n>] [--cycle-delay-ms <ms>] [--json]";
const DEFAULT_CYCLE_DELAY_MS = 60_000;
const ISSUE_IDENTIFIER_PATTERN = /^issue:(\d+)$/;

function parseRepoTarget(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) return null;
  return `${owner}/${repo}`;
}

function normalizeOptionalPositiveInt(value, label) {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || !Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`${label} must be a non-negative integer: ${value}`);
  }
  return parsedValue;
}

export function parseLoopArgs(args) {
  const options = {
    json: false,
    minerLogin: null,
    base: "main",
    live: false,
    dryRun: false,
    search: null,
    maxCycles: undefined,
    cycleDelayMs: DEFAULT_CYCLE_DELAY_MS,
  };
  const targets = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--live") {
      options.live = true;
      continue;
    }
    // #4847: see attempt-cli.js's own --dry-run comment -- distinct from --live's absence, this short-circuits
    // BEFORE governor state or any other store is opened, guaranteeing zero discovery/queue/ledger writes.
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--search") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return { error: LOOP_USAGE };
      options.search = value;
      index += 1;
      continue;
    }
    if (token === "--miner-login") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return { error: LOOP_USAGE };
      options.minerLogin = value;
      index += 1;
      continue;
    }
    if (token === "--base") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return { error: LOOP_USAGE };
      options.base = value;
      index += 1;
      continue;
    }
    if (token === "--max-cycles") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return { error: LOOP_USAGE };
      try {
        options.maxCycles = normalizeOptionalPositiveInt(value, "--max-cycles");
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
      index += 1;
      continue;
    }
    if (token === "--cycle-delay-ms") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return { error: LOOP_USAGE };
      try {
        options.cycleDelayMs = normalizeOptionalPositiveInt(value, "--cycle-delay-ms");
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    const target = parseRepoTarget(token);
    if (!target) return { error: `Repository must be in owner/repo form: ${token}` };
    targets.push(target);
  }

  if (options.search === null && targets.length === 0) return { error: LOOP_USAGE };
  if (options.search !== null && targets.length > 0) return { error: "Pass either repository targets or --search, not both." };
  if (!options.minerLogin) return { error: `--miner-login is required. ${LOOP_USAGE}` };

  return {
    targets,
    search: options.search,
    minerLogin: options.minerLogin,
    base: options.base,
    live: options.live,
    dryRun: options.dryRun,
    maxCycles: options.maxCycles,
    cycleDelayMs: options.cycleDelayMs,
    json: options.json,
  };
}

function discoverArgv(parsed) {
  return parsed.search !== null ? ["--search", parsed.search] : [...parsed.targets];
}

function parseIssueNumberFromIdentifier(identifier) {
  const match = typeof identifier === "string" ? identifier.match(ISSUE_IDENTIFIER_PATTERN) : null;
  return match ? Number(match[1]) : null;
}

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
export async function runLoop(args, options = {}) {
  const parsed = parseLoopArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  const env = options.env ?? process.env;
  const sleepFn = options.sleepFn ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const nowMsFn = () => options.nowMs ?? Date.now();
  const sessionStartMs = nowMsFn();

  // #4847: reports what a real loop invocation would target and returns BEFORE governor state or any other
  // store (event/governor ledger, portfolio queue, run state) is opened -- a provable zero-write path, not just
  // "opened but didn't write." The loop's own discovery call enqueues newly-found candidates into the LOCAL
  // portfolio queue even before any attempt happens, so a faithful dry run cannot call it either.
  if (parsed.dryRun) {
    const dryRunResult = {
      outcome: "dry_run",
      targets: parsed.targets,
      search: parsed.search,
      minerLogin: parsed.minerLogin,
      base: parsed.base,
      live: parsed.live,
      maxCycles: parsed.maxCycles ?? null,
    };
    if (parsed.json) {
      console.log(JSON.stringify(dryRunResult, null, 2));
    } else {
      const target = parsed.search !== null ? `--search ${parsed.search}` : parsed.targets.join(", ");
      console.log(
        `DRY RUN: would run an autonomous loop against ${target} for ${parsed.minerLogin} (base: ${parsed.base}, live: ${parsed.live}). No discovery, queue, or ledger writes were made.`,
      );
    }
    return 0;
  }

  let governorState;
  try {
    governorState = (options.openGovernorState ?? openGovernorState)();
  } catch (error) {
    return reportCliFailure(
      parsed.json,
      `Loop refuses to start: governor state cannot be loaded: ${describeCliError(error)}`,
      3,
    );
  }

  const eventLedger = (options.initEventLedger ?? initEventLedger)();
  const governorLedger = (options.initGovernorLedger ?? initGovernorLedger)();
  const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
  const runState = (options.initRunStateStore ?? initRunStateStore)();

  const runDiscoverFn = options.runDiscover ?? runDiscover;
  const runAttemptFn = options.runAttempt ?? runAttempt;
  const resolveAmsPolicyFn = options.resolveAmsPolicy ?? resolveAmsPolicy;
  const checkKillSwitchFn = options.checkMinerKillSwitch ?? checkMinerKillSwitch;
  const evaluateBoundaryGateFn = options.evaluateRunLoopBoundaryGate ?? evaluateRunLoopBoundaryGate;
  const pollPrDispositionFn = options.pollPrDisposition ?? pollPrDisposition;
  const pollCheckRunsFn = options.pollCheckRuns ?? pollCheckRuns;
  const recordPrOutcomeSnapshotFn = options.recordPrOutcomeSnapshot ?? recordPrOutcomeSnapshot;
  const buildLoopClosureSummaryFn = options.buildLoopClosureSummary ?? buildLoopClosureSummary;
  const attemptLoopReentryFn = options.attemptLoopReentry ?? attemptLoopReentry;

  // Resolved ONCE, at the CLI-entrypoint layer, mirroring manage-poll.js's own runManagePoll (its
  // recordManagePollSnapshot callee has no env fallback of its own either -- the top-level CLI function is
  // where `process.env.GITHUB_TOKEN` gets read, then threaded down explicitly to every real GitHub caller).
  // pollPrDisposition (unlike runDiscover, which falls back to process.env.GITHUB_TOKEN internally) has NO
  // such fallback -- an unresolved githubToken here would silently poll unauthenticated.
  const githubToken = options.githubToken ?? env.GITHUB_TOKEN ?? "";

  async function runDiscoveryOnce() {
    await runDiscoverFn(discoverArgv(parsed), {
      initPortfolioQueue: () => portfolioQueue,
      githubToken,
      apiBaseUrl: options.apiBaseUrl,
      nowMs: nowMsFn(),
    });
  }

  let usage = governorState.loadCapUsage();
  const cycles = [];
  let sinceSeq = eventLedger.readEvents({}).at(-1)?.seq ?? 0;
  let haltReason = null;

  try {
    // Checked BEFORE any work at all -- including the very first discovery call -- so an already-active kill
    // switch OR an already-active pause (#4851) halts the loop without ever touching GitHub or the queue. The
    // pause flag is real, persisted, operator/governor-writable state on governorState (toggled via
    // `loopover-miner governor pause`/`resume`) -- unlike the kill switch, a paused run resumes simply by being
    // re-invoked: every piece of per-cycle state this loop reads (portfolioQueue, runState, governorState's own
    // cap usage) is already durable, so clearing the flag and restarting continues exactly where it left off.
    const initialKillSwitch = checkKillSwitchFn({ env });
    const initialPauseState = governorState.loadPauseState();
    let claimed = null;
    if (initialKillSwitch.active) {
      haltReason = `kill_switch_${initialKillSwitch.scope}`;
      cycles.push({ cycle: 1, outcome: "halted", reason: haltReason });
    } else if (initialPauseState.paused) {
      haltReason = "paused";
      cycles.push({ cycle: 1, outcome: "halted", reason: haltReason });
    } else {
      await runDiscoveryOnce();
      claimed = portfolioQueue.dequeueNext();
    }

    let cycleIndex = haltReason !== null ? 1 : 0;
    while (haltReason === null && (parsed.maxCycles === undefined || cycleIndex < parsed.maxCycles)) {
      cycleIndex += 1;

      const killSwitch = checkKillSwitchFn({ env });
      if (killSwitch.active) {
        haltReason = `kill_switch_${killSwitch.scope}`;
        cycles.push({ cycle: cycleIndex, outcome: "halted", reason: haltReason });
        break;
      }

      const pauseState = governorState.loadPauseState();
      if (pauseState.paused) {
        haltReason = "paused";
        cycles.push({ cycle: cycleIndex, outcome: "halted", reason: haltReason });
        break;
      }

      if (!claimed) {
        cycles.push({ cycle: cycleIndex, outcome: "idle_queue_empty" });
        await sleepFn(parsed.cycleDelayMs);
        await runDiscoveryOnce();
        claimed = portfolioQueue.dequeueNext();
        continue;
      }

      const issueNumber = parseIssueNumberFromIdentifier(claimed.identifier);
      if (issueNumber === null) {
        // Never produced by enqueueRankedDiscovery in practice (always "issue:N") -- fail soft rather than
        // crash the whole run: this exact item can never be attempted, so it will never resolve on retry.
        portfolioQueue.markDone(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
        cycles.push({ cycle: cycleIndex, outcome: "skipped_malformed_identifier", identifier: claimed.identifier });
        claimed = portfolioQueue.dequeueNext();
        continue;
      }

      const amsPolicy = await resolveAmsPolicyFn(claimed.repoFullName, { env });
      // Real, SQLite-persisted per-item convergence history (#5677): the dequeueNext claim above already recorded
      // this attempt and the markDone/markFailed calls below record the outcome, so reading it back here shares one
      // source of truth with attempt-cli.js (#5654) and survives a loop-daemon restart instead of resetting.
      const convergenceInput = portfolioQueue.getAttemptHistory(
        claimed.repoFullName,
        claimed.identifier,
        claimed.apiBaseUrl,
      );

      const boundary = evaluateBoundaryGateFn(
        {
          runHalted: false,
          usage,
          limits: amsPolicy.spec.capLimits ?? DEFAULT_AMS_POLICY_SPEC.capLimits,
          convergence: convergenceInput,
          convergenceThresholds: amsPolicy.spec.convergenceThresholds ?? DEFAULT_AMS_POLICY_SPEC.convergenceThresholds,
          inFlightItem: { repoFullName: claimed.repoFullName, identifier: claimed.identifier },
          // Echoes claimed.apiBaseUrl (#5563), NOT the callback's own repoFullName/identifier alone -- two forge
          // hosts can share an in-flight item with the same repo name+identifier.
          markFailed: (repoFullName, identifier) => portfolioQueue.markFailed(repoFullName, identifier, claimed.apiBaseUrl),
        },
        { append: (event) => governorLedger.appendGovernorEvent(event) },
      );

      if (!boundary.canClaimNext) {
        haltReason = `boundary_${boundary.verdict.reason}`;
        cycles.push({ cycle: cycleIndex, outcome: "halted", reason: haltReason, repoFullName: claimed.repoFullName, identifier: claimed.identifier });
        break;
      }

      const cycleStartMs = nowMsFn();
      let lastResult = null;
      const attemptArgv = [
        claimed.repoFullName,
        String(issueNumber),
        "--miner-login",
        parsed.minerLogin,
        "--base",
        parsed.base,
        ...(parsed.live ? ["--live"] : []),
      ];
      await runAttemptFn(attemptArgv, {
        ...(options.attemptOptions ?? {}),
        env,
        onResult: (result) => {
          lastResult = result;
        },
      });
      const cycleElapsedMs = nowMsFn() - cycleStartMs;

      usage = {
        // Real for the agent-sdk provider (its own SDK result message reports total_cost_usd, wired through
        // runMinerAttempt's real loopResult.totalCostUsd); the CLI-subprocess providers (claude-cli/codex-cli)
        // report no cost signal today, so this contributes 0 for those runs -- an honest absence, not a
        // fabricated number. A capLimits.budget dimension only ever meaningfully trips against agent-sdk spend.
        budgetSpent: usage.budgetSpent + (lastResult?.totalCostUsd ?? 0),
        turnsTaken: usage.turnsTaken + (lastResult?.totalTurnsUsed ?? 0),
        elapsedMs: usage.elapsedMs + cycleElapsedMs,
      };
      governorState.saveCapUsage(usage);

      const attemptOutcome = lastResult?.outcome ?? "attempt_error";
      const submitted = attemptOutcome === "attempt_submitted";
      // A repo-wide AI-usage-policy ban will never resolve on retry -- stop re-queuing it (matches
      // rejection-signal.js's own "this repo bans automated contributions" semantics). Every other blocked/
      // abandoned/stale/governed outcome MAY resolve on a later retry (transient infra, contention, a
      // different iteration budget) and is requeued -- a genuinely stuck item is caught by non-convergence
      // (reenqueues threshold) rather than silently retried forever.
      const permanentBlock = attemptOutcome === "blocked_rejection_signaled";

      if (submitted || permanentBlock) {
        // Both terminal -- a submitted PR is done, and a repo-wide AI-usage-policy ban never resolves on retry --
        // so neither is re-queued. markDone also clears the persisted consecutive-failure streak.
        portfolioQueue.markDone(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
      } else {
        // Any other blocked/abandoned/stale/governed outcome may resolve on a later retry, so requeue it; markFailed
        // records the re-enqueue + consecutive failure the non-convergence detector reads on the next cycle.
        portfolioQueue.markFailed(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
      }

      let reentryOutcome = "other";
      let prNumber = null;
      let prDisposition = null;
      let ciConclusion = null;
      if (submitted) {
        prNumber = parsePrNumberFromExecResult(lastResult?.execResult, claimed.repoFullName);
        if (prNumber !== null) {
          // Real CI-status observation (#5394): recorded BEFORE the disposition poll below, so a submitted
          // PR's check-run state is captured even while it's still open, not just at its eventual merge/close.
          // ci-poller.js's real GitHub check-run polling is a heuristic proxy for the gate verdict; the
          // authoritative terminal merge/close outcome comes from pollPrDispositionFn below, sourced directly
          // from GitHub's own PR state rather than a server-internal endpoint (#5450).
          const ciStatus = await pollCheckRunsFn(claimed.repoFullName, prNumber, {
            githubToken,
            apiBaseUrl: options.apiBaseUrl,
            ...(options.ciPollOptions ?? {}),
          });
          ciConclusion = ciStatus.conclusion;
          eventLedger.appendEvent({
            type: "ci_status_observed",
            repoFullName: claimed.repoFullName,
            payload: { prNumber, conclusion: ciStatus.conclusion, checkCount: ciStatus.checks.length, source: "ci-poller" },
          });

          prDisposition = await pollPrDispositionFn(claimed.repoFullName, prNumber, {
            githubToken,
            apiBaseUrl: options.apiBaseUrl,
            ...(options.prDispositionOptions ?? {}),
          });
          if (prDisposition.state === "closed") {
            recordPrOutcomeSnapshotFn(
              {
                repoFullName: claimed.repoFullName,
                prNumber,
                decision: prDisposition.merged ? "merged" : "closed",
                closedAt: prDisposition.closedAt,
              },
              { eventLedger },
            );
            // Real per-repo reputation history (#5675): a resolved terminal outcome updates the decided/unfavorable
            // counts the Governor's self-reputation throttle reads on this repo's next attempt. `decided` always;
            // `unfavorable` only on a closed-without-merge (rejection-state-machine.js's isRejectedPr, matching
            // #5655's own-rejection classification). Forge-scoped by claimed.apiBaseUrl (#5563), like every other
            // governor-state write here.
            const priorReputation = governorState.loadReputationHistory(claimed.repoFullName, claimed.apiBaseUrl);
            governorState.saveReputationHistory(
              claimed.repoFullName,
              {
                decided: priorReputation.decided + 1,
                unfavorable: priorReputation.unfavorable + (isRejectedPr(prDisposition) ? 1 : 0),
              },
              claimed.apiBaseUrl,
            );
            reentryOutcome = classifyPrDisposition(prDisposition);
          }
        }
      }

      const loopSummary = buildLoopClosureSummaryFn(
        { eventLedger, portfolioQueue, runState },
        { sinceSeq, repoFullName: claimed.repoFullName },
      );
      sinceSeq = loopSummary.lastSeq;

      const reentry = attemptLoopReentryFn(
        { killSwitchScope: killSwitch.scope, repoFullName: claimed.repoFullName, outcome: reentryOutcome },
        { eventLedger, portfolioQueue, runState, nowMs: nowMsFn(), sessionStartMs, loopSummary },
      );

      cycles.push({
        cycle: cycleIndex,
        outcome: "attempted",
        repoFullName: claimed.repoFullName,
        identifier: claimed.identifier,
        attemptOutcome,
        reentryOutcome,
        prNumber,
        ciConclusion,
        reentered: reentry.decision.reenter,
        reasons: reentry.decision.reasons,
      });

      if (!reentry.decision.reenter) {
        haltReason = `reentry_declined:${reentry.decision.reasons.join(",")}`;
        break;
      }

      if (reentry.dequeued) {
        claimed = reentry.dequeued;
        await sleepFn(parsed.cycleDelayMs);
      } else {
        await sleepFn(parsed.cycleDelayMs);
        await runDiscoveryOnce();
        claimed = portfolioQueue.dequeueNext();
      }
    }

    if (haltReason === null && parsed.maxCycles !== undefined) {
      haltReason = "max_cycles_reached";
    }

    const summary = { haltReason, cyclesRun: cycles.length, cycles };
    if (parsed.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`Loop finished after ${cycles.length} cycle(s): ${haltReason ?? "unknown"}.`);
    }
    return 0;
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  } finally {
    governorState.close();
    eventLedger.close();
    governorLedger.close();
    portfolioQueue.close();
    runState.close();
  }
}
