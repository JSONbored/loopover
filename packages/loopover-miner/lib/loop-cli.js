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
import { resolveGitHubToken } from "./github-token-resolution.js";
import { DEFAULT_AMS_POLICY_SPEC } from "@loopover/engine";
const LOOP_USAGE = "Usage: loopover-miner loop <owner/repo> [<owner/repo>...] | --search <query> --miner-login <login> [--base <branch>] [--live] [--dry-run] [--max-cycles <n>] [--cycle-delay-ms <ms>] [--json]";
const DEFAULT_CYCLE_DELAY_MS = 60_000;
const ISSUE_IDENTIFIER_PATTERN = /^issue:(\d+)$/;
function parseRepoTarget(value) {
    const trimmed = value.trim();
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
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
            if (!value || value.startsWith("-"))
                return { error: LOOP_USAGE };
            options.search = value;
            index += 1;
            continue;
        }
        if (token === "--miner-login") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: LOOP_USAGE };
            options.minerLogin = value;
            index += 1;
            continue;
        }
        if (token === "--base") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: LOOP_USAGE };
            options.base = value;
            index += 1;
            continue;
        }
        if (token === "--max-cycles") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: LOOP_USAGE };
            try {
                options.maxCycles = normalizeOptionalPositiveInt(value, "--max-cycles");
            }
            catch (error) {
                return { error: describeCliError(error) };
            }
            index += 1;
            continue;
        }
        if (token === "--cycle-delay-ms") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: LOOP_USAGE };
            try {
                options.cycleDelayMs = normalizeOptionalPositiveInt(value, "--cycle-delay-ms");
            }
            catch (error) {
                return { error: describeCliError(error) };
            }
            index += 1;
            continue;
        }
        if (token.startsWith("-"))
            return { error: `Unknown option: ${token}` };
        const target = parseRepoTarget(token);
        if (!target)
            return { error: `Repository must be in owner/repo form: ${token}` };
        targets.push(target);
    }
    if (options.search === null && targets.length === 0)
        return { error: LOOP_USAGE };
    if (options.search !== null && targets.length > 0)
        return { error: "Pass either repository targets or --search, not both." };
    if (!options.minerLogin)
        return { error: `--miner-login is required. ${LOOP_USAGE}` };
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
function defaultSleep(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
/**
 * Run one full discover -> claim -> attempt -> observe -> reenter cycle repeatedly until a kill-switch trips,
 * the run-loop boundary gate halts (non-convergence or a real budget/turn/elapsed cap), re-entry is declined,
 * or `--max-cycles` is reached. Fails closed: refuses to start at all if governor state cannot be loaded.
 */
export async function runLoop(args, options = {}) {
    const parsed = parseLoopArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    // Narrow for nested closures (TS resets control-flow narrowing inside nested functions).
    const loopArgs = parsed;
    const env = options.env ?? process.env;
    const sleepFn = options.sleepFn ?? defaultSleep;
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
        }
        else {
            const target = parsed.search !== null ? `--search ${parsed.search}` : parsed.targets.join(", ");
            console.log(`DRY RUN: would run an autonomous loop against ${target} for ${parsed.minerLogin} (base: ${parsed.base}, live: ${parsed.live}). No discovery, queue, or ledger writes were made.`);
        }
        return 0;
    }
    let governorState;
    try {
        governorState = (options.openGovernorState ?? openGovernorState)();
    }
    catch (error) {
        return reportCliFailure(parsed.json, `Loop refuses to start: governor state cannot be loaded: ${describeCliError(error)}`, 3);
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
    // where the GitHub token gets resolved, then threaded down explicitly to every real GitHub caller).
    // pollPrDisposition (unlike runDiscover, which falls back to process.env.GITHUB_TOKEN internally) has NO
    // such fallback -- an unresolved githubToken here would silently poll unauthenticated.
    // resolveGitHubToken (#6116): GITHUB_TOKEN env override wins outright, else a live token from the
    // authenticated `loopover-mcp login` session -- cached in memory for this process's lifetime.
    const githubToken = options.githubToken ?? (await resolveGitHubToken(env)) ?? "";
    async function runDiscoveryOnce() {
        await runDiscoverFn(discoverArgv(loopArgs), {
            initPortfolioQueue: () => portfolioQueue,
            githubToken,
            ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
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
        }
        else if (initialPauseState.paused) {
            haltReason = "paused";
            cycles.push({ cycle: 1, outcome: "halted", reason: haltReason });
        }
        else {
            await runDiscoveryOnce();
            claimed = portfolioQueue.dequeueNext();
        }
        let cycleIndex = haltReason !== null ? 1 : 0;
        while (haltReason === null && (parsed.maxCycles === undefined || cycleIndex < parsed.maxCycles)) {
            cycleIndex += 1;
            const killSwitch = checkKillSwitchFn({ env });
            if (killSwitch.active) {
                haltReason = `kill_switch_${killSwitch.scope}`;
                // Release the in-flight claim so left state is defined (#5670 / mirrors run-halt's markFailed).
                if (claimed) {
                    portfolioQueue.markFailed(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
                }
                cycles.push({
                    cycle: cycleIndex,
                    outcome: "halted",
                    reason: haltReason,
                    ...(claimed
                        ? { repoFullName: claimed.repoFullName, identifier: claimed.identifier }
                        : {}),
                });
                break;
            }
            const pauseState = governorState.loadPauseState();
            if (pauseState.paused) {
                haltReason = "paused";
                if (claimed) {
                    portfolioQueue.markFailed(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
                }
                cycles.push({
                    cycle: cycleIndex,
                    outcome: "halted",
                    reason: haltReason,
                    ...(claimed
                        ? { repoFullName: claimed.repoFullName, identifier: claimed.identifier }
                        : {}),
                });
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
            // Capture for the boundary-gate markFailed callback (claimed is reassigned later in the loop).
            const claimedEntry = claimed;
            const amsPolicy = await resolveAmsPolicyFn(claimedEntry.repoFullName, { env });
            // Real, SQLite-persisted per-item convergence history (#5677): the dequeueNext claim above already recorded
            // this attempt and the markDone/markFailed calls below record the outcome, so reading it back here shares one
            // source of truth with attempt-cli.js (#5654) and survives a loop-daemon restart instead of resetting.
            const convergenceInput = portfolioQueue.getAttemptHistory(claimedEntry.repoFullName, claimedEntry.identifier, claimedEntry.apiBaseUrl);
            // RunLoopOptions.resolveAmsPolicy types spec as Record<string, unknown>; fall back when fields are absent.
            const limits = amsPolicy.spec.capLimits ??
                DEFAULT_AMS_POLICY_SPEC.capLimits;
            const convergenceThresholds = amsPolicy.spec.convergenceThresholds ??
                DEFAULT_AMS_POLICY_SPEC.convergenceThresholds;
            const boundary = evaluateBoundaryGateFn({
                runHalted: false,
                usage,
                limits,
                convergence: convergenceInput,
                convergenceThresholds,
                inFlightItem: { repoFullName: claimedEntry.repoFullName, identifier: claimedEntry.identifier },
                // Echoes claimed.apiBaseUrl (#5563), NOT the callback's own repoFullName/identifier alone -- two forge
                // hosts can share an in-flight item with the same repo name+identifier.
                markFailed: (repoFullName, identifier) => portfolioQueue.markFailed(repoFullName, identifier, claimedEntry.apiBaseUrl),
            }, { append: (event) => governorLedger.appendGovernorEvent(event) });
            if (!boundary.canClaimNext) {
                haltReason = `boundary_${boundary.verdict.reason}`;
                cycles.push({ cycle: cycleIndex, outcome: "halted", reason: haltReason, repoFullName: claimedEntry.repoFullName, identifier: claimedEntry.identifier });
                break;
            }
            const cycleStartMs = nowMsFn();
            // Local result bag: AttemptCliResult is a discriminant union; CFA after the onResult callback
            // collapses typed bags to `never`, so keep this local untyped (runtime shape unchanged).
            let lastResult = null;
            const attemptArgv = [
                claimedEntry.repoFullName,
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
            // Mid-attempt kill-switch abandon (#5670): stop the outer loop immediately instead of waiting for the
            // next between-cycle probe, and treat the item like any other re-queued abandon via markFailed below.
            const killSwitchAbandon = lastResult?.abandonReason === "kill_switch_engaged";
            if (submitted || permanentBlock) {
                // Both terminal -- a submitted PR is done, and a repo-wide AI-usage-policy ban never resolves on retry --
                // so neither is re-queued. markDone also clears the persisted consecutive-failure streak.
                portfolioQueue.markDone(claimedEntry.repoFullName, claimedEntry.identifier, claimedEntry.apiBaseUrl);
            }
            else {
                // Any other blocked/abandoned/stale/governed outcome may resolve on a later retry, so requeue it; markFailed
                // records the re-enqueue + consecutive failure the non-convergence detector reads on the next cycle.
                portfolioQueue.markFailed(claimedEntry.repoFullName, claimedEntry.identifier, claimedEntry.apiBaseUrl);
            }
            if (killSwitchAbandon) {
                const liveKill = checkKillSwitchFn({ env });
                haltReason = liveKill.active ? `kill_switch_${liveKill.scope}` : "kill_switch_engaged";
                cycles.push({
                    cycle: cycleIndex,
                    outcome: "halted",
                    reason: haltReason,
                    repoFullName: claimedEntry.repoFullName,
                    identifier: claimedEntry.identifier,
                    attemptOutcome,
                });
                break;
            }
            let reentryOutcome = "other";
            let prNumber = null;
            let prDisposition = null;
            let ciConclusion = null;
            if (submitted) {
                prNumber = parsePrNumberFromExecResult(lastResult?.execResult, claimedEntry.repoFullName);
                if (prNumber !== null) {
                    // Real CI-status observation (#5394): recorded BEFORE the disposition poll below, so a submitted
                    // PR's check-run state is captured even while it's still open, not just at its eventual merge/close.
                    // ci-poller.js's real GitHub check-run polling is a heuristic proxy for the gate verdict; the
                    // authoritative terminal merge/close outcome comes from pollPrDispositionFn below, sourced directly
                    // from GitHub's own PR state rather than a server-internal endpoint (#5450).
                    const ciStatus = await pollCheckRunsFn(claimedEntry.repoFullName, prNumber, {
                        githubToken,
                        ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
                        ...(options.ciPollOptions ?? {}),
                    });
                    ciConclusion = ciStatus.conclusion;
                    eventLedger.appendEvent({
                        type: "ci_status_observed",
                        repoFullName: claimedEntry.repoFullName,
                        payload: { prNumber, conclusion: ciStatus.conclusion, checkCount: ciStatus.checks.length, source: "ci-poller" },
                    });
                    prDisposition = await pollPrDispositionFn(claimedEntry.repoFullName, prNumber, {
                        githubToken,
                        ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
                        ...(options.prDispositionOptions ?? {}),
                    });
                    if (prDisposition.state === "closed") {
                        recordPrOutcomeSnapshotFn({
                            repoFullName: claimedEntry.repoFullName,
                            prNumber,
                            decision: prDisposition.merged ? "merged" : "closed",
                            closedAt: prDisposition.closedAt,
                        }, { eventLedger });
                        // Real per-repo reputation history (#5675): a resolved terminal outcome updates the decided/unfavorable
                        // counts the Governor's self-reputation throttle reads on this repo's next attempt. `decided` always;
                        // `unfavorable` only on a closed-without-merge (rejection-state-machine.js's isRejectedPr, matching
                        // #5655's own-rejection classification). Forge-scoped by claimed.apiBaseUrl (#5563), like every other
                        // governor-state write here.
                        const priorReputation = governorState.loadReputationHistory(claimed.repoFullName, claimed.apiBaseUrl);
                        governorState.saveReputationHistory(claimed.repoFullName, {
                            decided: priorReputation.decided + 1,
                            unfavorable: priorReputation.unfavorable + (isRejectedPr(prDisposition) ? 1 : 0),
                        }, claimed.apiBaseUrl);
                        reentryOutcome = classifyPrDisposition(prDisposition);
                    }
                }
            }
            const loopSummary = buildLoopClosureSummaryFn({ eventLedger, portfolioQueue, runState }, { sinceSeq, repoFullName: claimed.repoFullName });
            sinceSeq = loopSummary.lastSeq;
            const reentry = attemptLoopReentryFn({ killSwitchScope: killSwitch.scope, repoFullName: claimed.repoFullName, outcome: reentryOutcome }, { eventLedger, portfolioQueue, runState, nowMs: nowMsFn(), sessionStartMs, loopSummary });
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
                // attemptLoopReentry's injectable .d.ts types dequeued.status as string; QueueEntry wants QueueStatus.
                claimed = reentry.dequeued;
                await sleepFn(parsed.cycleDelayMs);
            }
            else {
                await sleepFn(parsed.cycleDelayMs);
                await runDiscoveryOnce();
                claimed = portfolioQueue.dequeueNext();
            }
        }
        if (haltReason === null && parsed.maxCycles !== undefined) {
            haltReason = "max_cycles_reached";
            // The next cycle's item is primed (dequeued → 'in_progress') BEFORE the while-condition re-checks
            // maxCycles -- both at the initial priming above and at each cycle's tail -- so exhausting maxCycles
            // ends the run holding a claim no cycle ever processed. Release it, mirroring the kill-switch/pause
            // halts (#5670): dequeueNext() only pulls 'queued' rows, so an unreleased claim is invisible to every
            // future loop/attempt run until an out-of-band stale-lease sweep reclaims it.
            if (claimed) {
                portfolioQueue.markFailed(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
            }
        }
        // After the max-cycles release block above, haltReason is always set on a clean exit.
        const summary = { haltReason, cyclesRun: cycles.length, cycles };
        if (parsed.json) {
            console.log(JSON.stringify(summary, null, 2));
        }
        else {
            console.log(`Loop finished after ${cycles.length} cycle(s): ${haltReason}.`);
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
    finally {
        governorState.close();
        eventLedger.close();
        governorLedger.close();
        portfolioQueue.close();
        runState.close();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9vcC1jbGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJsb29wLWNsaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxzR0FBc0c7QUFDdEcsaUdBQWlHO0FBQ2pHLHlHQUF5RztBQUN6RyxtR0FBbUc7QUFDbkcsRUFBRTtBQUNGLHFHQUFxRztBQUNyRyx5R0FBeUc7QUFDekcscUZBQXFGO0FBQ3JGLDZHQUE2RztBQUM3RyxzREFBc0Q7QUFDdEQscUdBQXFHO0FBQ3JHLDBHQUEwRztBQUMxRyw4R0FBOEc7QUFDOUcsNkdBQTZHO0FBQzdHLDJEQUEyRDtBQUMzRCxFQUFFO0FBQ0YsdUdBQXVHO0FBQ3ZHLDBHQUEwRztBQUMxRyw4R0FBOEc7QUFDOUcsNEdBQTRHO0FBQzVHLCtHQUErRztBQUMvRyw2R0FBNkc7QUFDN0csK0VBQStFO0FBRS9FLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxNQUFNLDJCQUEyQixDQUFDO0FBQ2pFLE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUNsRixPQUFPLEVBQUUsMkJBQTJCLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUNyRSxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQUV4RCxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUUxRCxPQUFPLEVBQUUsZUFBZSxFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFFcEQsT0FBTyxFQUFFLHVCQUF1QixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFFL0QsT0FBTyxFQUFFLGlCQUFpQixFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFFbkQsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBQ2hELE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUU5QyxPQUFPLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxpQkFBaUIsQ0FB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O1FBQ0QsSUFBSSxLQUFLLEtBQUssVUFBVSxFQUFFLENBQUM7WUFDekIsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQztZQUM5QixJQUFJLENBQUMsS0FBSyxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDO2dCQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsVUFBVSxFQUFFLENBQUM7WUFDbEUsT0FBTyxDQUFDLE1BQU0sR0FBRyxLQUFLLENBQUM7WUFDdkIsS0FBSyxJQUFJLENBQUMsQ0FBQztZQUNYLFNBQVM7UUFDWCxDQUFDO1FBQ0QsSUFBSSxLQUFLLEtBQUssZUFBZSxFQUFFLENBQUM7WUFDOUIsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQztZQUM5QixJQUFJLENBQUMsS0FBSyxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDO2dCQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsVUFBVSxFQUFFLENBQUM7WUFDbEUsT0FBTyxDQUFDLFVBQVUsR0FBRyxLQUFLLENBQUM7WUFDM0IsS0FBSyxJQUFJLENBQUMsQ0FBQztZQUNYLFNBQVM7UUFDWCxDQUFDO1FBQ0QsSUFBSSxLQUFLLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDdkIsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQztZQUM5QixJQUFJLENBQUMsS0FBSyxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDO2dCQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsVUFBVSxFQUFFLENBQUM7WUFDbEUsT0FBTyxDQUFDLElBQUksR0FBRyxLQUFLLENBQUM7WUFDckIsS0FBSyxJQUFJLENBQUMsQ0FBQztZQUNYLFNBQVM7UUFDWCxDQUFDO1FBQ0QsSUFBSSxLQUFLLEtBQUssY0FBYyxFQUFFLENBQUM7WUFDN0IsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FB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