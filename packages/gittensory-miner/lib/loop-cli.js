// The autonomous supervising loop (#5135, Wave 3.5): the missing daemon/watch layer over the one-shot
// `discover`/`attempt` subcommands. Every existing piece it composes -- runDiscover, runAttempt,
// evaluateRunLoopBoundaryGate, attemptLoopReentry, buildLoopClosureSummary, governor-state.js -- already
// existed; this is the first caller that actually chains them into a real repeat-until-halted run.
//
// STRUCTURE (one cycle): kill-switch check -> real-per-repo-policy-aware run-loop boundary gate (before
// claiming) -> real runAttempt -> real PR-disposition poll (pr-disposition-poller.js, on a submitted outcome)
// -> real loop-closure summary -> real attemptLoopReentry decision. `attemptLoopReentry`'s own dequeue is the
// AUTHORITATIVE claim for every cycle after the first (its own doc: "if allowed -- dequeues the next
// candidate") -- this loop does not ALSO call portfolioQueue.dequeueNext() on a successful reentry, which
// would silently double-claim (the reentry's own claim would then leak as a permanently 'in_progress', never-
// attempted row). A manual dequeueNext() is used only to prime the very first cycle (no prior outcome exists
// yet to reenter from) and to refill after an empty queue.
//
// REAL, NOT FABRICATED: this loop is the first production caller of governor-state.js's `saveCapUsage`
// (turnsTaken from runMinerAttempt's own real `loopResult.totalTurnsUsed`, elapsedMs from real wall-clock
// measurement) and of a genuine per-identifier convergence history (attempts/consecutiveFailures/reenqueues
// tracked in this process's own memory across its own cycles) -- both were previously honest zero/placeholder
// literals (see attempt-input-builder.js's own header) because a ONE-SHOT `attempt` CLI invocation has no
// cross-call history to draw on. A long-running loop genuinely does.
//
// DOCUMENTED GAP: convergence/cap-usage history is IN-MEMORY, scoped to this loop process's own lifetime (cap
// usage itself persists across restarts via governor-state.js; per-identifier convergence counters do not --
// a durable version needs attempt-log.js to grow a repo+issue index, the same separate schema change
// attempt-input-builder.js's header already flags as out of scope here).

import { checkMinerKillSwitch } from "./governor-kill-switch.js";
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
import { recordPrOutcomeSnapshot } from "./pr-outcome.js";
import { buildLoopClosureSummary } from "./loop-closure.js";
import { attemptLoopReentry } from "./loop-reentry.js";
import { DEFAULT_AMS_POLICY_SPEC } from "@jsonbored/gittensory-engine";

const LOOP_USAGE =
  "Usage: gittensory-miner loop <owner/repo> [<owner/repo>...] | --search <query> --miner-login <login> [--base <branch>] [--live] [--max-cycles <n>] [--cycle-delay-ms <ms>] [--json]";
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
  const options = { json: false, minerLogin: null, base: "main", live: false, search: null, maxCycles: undefined, cycleDelayMs: DEFAULT_CYCLE_DELAY_MS };
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

/** `gh pr create` (local-write-tools.ts's `buildOpenPrSpec` -- no `--json` flag) prints the created PR's own
 *  URL to stdout on success; this is `gh`'s real, documented, stable CLI behavior, not an invented contract.
 *  Scoped to the exact target repo so an unrelated URL elsewhere in stdout/stderr noise can never match. */
function parsePrNumberFromExecResult(execResult, repoFullName) {
  if (!execResult || execResult.timedOut || execResult.code !== 0 || typeof execResult.stdout !== "string") {
    return null;
  }
  const escapedRepo = repoFullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = execResult.stdout.match(new RegExp(`github\\.com/${escapedRepo}/pull/(\\d+)`));
  if (!match) return null;
  const prNumber = Number(match[1]);
  return Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null;
}

function convergenceKey(repoFullName, identifier) {
  return `${repoFullName}:${identifier}`;
}

function zeroConvergence() {
  return { attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false };
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
 *   recordPrOutcomeSnapshot?: typeof recordPrOutcomeSnapshot,
 *   buildLoopClosureSummary?: typeof buildLoopClosureSummary,
 *   attemptLoopReentry?: typeof attemptLoopReentry,
 *   attemptOptions?: Record<string, unknown>,
 *   prDispositionOptions?: Record<string, unknown>,
 * }} [options]
 * @returns {Promise<number>}
 */
export async function runLoop(args, options = {}) {
  const parsed = parseLoopArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  const env = options.env ?? process.env;
  const sleepFn = options.sleepFn ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const nowMsFn = () => options.nowMs ?? Date.now();
  const sessionStartMs = nowMsFn();

  let governorState;
  try {
    governorState = (options.openGovernorState ?? openGovernorState)();
  } catch (error) {
    console.error(
      `Loop refuses to start: governor state cannot be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 3;
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
  const convergenceHistory = new Map();
  const cycles = [];
  let sinceSeq = eventLedger.readEvents({}).at(-1)?.seq ?? 0;
  let haltReason = null;

  try {
    // Checked BEFORE any work at all -- including the very first discovery call -- so an already-active kill
    // switch halts the loop without ever touching GitHub or the queue.
    const initialKillSwitch = checkKillSwitchFn({ env });
    let claimed = null;
    if (initialKillSwitch.active) {
      haltReason = `kill_switch_${initialKillSwitch.scope}`;
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
        portfolioQueue.markDone(claimed.repoFullName, claimed.identifier);
        cycles.push({ cycle: cycleIndex, outcome: "skipped_malformed_identifier", identifier: claimed.identifier });
        claimed = portfolioQueue.dequeueNext();
        continue;
      }

      const key = convergenceKey(claimed.repoFullName, claimed.identifier);
      const amsPolicy = await resolveAmsPolicyFn(claimed.repoFullName, { env });
      const convergenceInput = convergenceHistory.get(key) ?? zeroConvergence();

      const boundary = evaluateBoundaryGateFn(
        {
          runHalted: false,
          usage,
          limits: amsPolicy.spec.capLimits ?? DEFAULT_AMS_POLICY_SPEC.capLimits,
          convergence: convergenceInput,
          convergenceThresholds: amsPolicy.spec.convergenceThresholds ?? DEFAULT_AMS_POLICY_SPEC.convergenceThresholds,
          inFlightItem: { repoFullName: claimed.repoFullName, identifier: claimed.identifier },
          markFailed: (repoFullName, identifier) => portfolioQueue.markFailed(repoFullName, identifier),
        },
        { append: (event) => governorLedger.appendGovernorEvent(event) },
      );

      if (!boundary.canClaimNext) {
        haltReason = `boundary_${boundary.verdict.reason}`;
        cycles.push({ cycle: cycleIndex, outcome: "halted", reason: haltReason, repoFullName: claimed.repoFullName, identifier: claimed.identifier });
        break;
      }

      convergenceInput.attempts += 1;
      convergenceHistory.set(key, convergenceInput);

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
        budgetSpent: usage.budgetSpent,
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

      if (submitted) {
        portfolioQueue.markDone(claimed.repoFullName, claimed.identifier);
        convergenceInput.reachedDone = true;
        convergenceInput.consecutiveFailures = 0;
      } else if (permanentBlock) {
        portfolioQueue.markDone(claimed.repoFullName, claimed.identifier);
        convergenceInput.consecutiveFailures += 1;
      } else {
        portfolioQueue.markFailed(claimed.repoFullName, claimed.identifier);
        convergenceInput.consecutiveFailures += 1;
        convergenceInput.reenqueues += 1;
      }
      convergenceHistory.set(key, convergenceInput);

      let reentryOutcome = "other";
      let prNumber = null;
      let prDisposition = null;
      if (submitted) {
        prNumber = parsePrNumberFromExecResult(lastResult?.execResult, claimed.repoFullName);
        if (prNumber !== null) {
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
            reentryOutcome = classifyPrDisposition(prDisposition);
          }
        }
      }

      const loopSummary = buildLoopClosureSummaryFn(
        { eventLedger, portfolioQueue, runState },
        { sinceSeq, repoFullName: claimed.repoFullName },
      );
      sinceSeq = loopSummary.lastSeq;

      if (submitted && prDisposition?.state !== "closed") {
        const reason = prNumber === null ? "submitted_pr_number_unresolved" : "submitted_pr_disposition_unresolved";
        cycles.push({
          cycle: cycleIndex,
          outcome: "attempted",
          repoFullName: claimed.repoFullName,
          identifier: claimed.identifier,
          attemptOutcome,
          reentryOutcome,
          prNumber,
          reentered: false,
          reasons: [reason],
        });
        haltReason = `reentry_declined:${reason}`;
        break;
      }

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
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    governorState.close();
    eventLedger.close();
    governorLedger.close();
    portfolioQueue.close();
    runState.close();
  }
}
