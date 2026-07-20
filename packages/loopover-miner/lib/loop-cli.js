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
    const trimmed = typeof value === "string" ? value.trim() : "";
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
                return { error: error instanceof Error ? error.message : String(error) };
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
                return { error: error instanceof Error ? error.message : String(error) };
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
    // Narrowed once here so nested closures (runDiscoveryOnce) see the non-error branch: TS control-flow
    // narrowing from the `in` guard above does not flow into a captured closure's body.
    const parsedRun = parsed;
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
        await runDiscoverFn(discoverArgv(parsedRun), {
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
            const amsPolicy = await resolveAmsPolicyFn(claimed.repoFullName, { env });
            // Real, SQLite-persisted per-item convergence history (#5677): the dequeueNext claim above already recorded
            // this attempt and the markDone/markFailed calls below record the outcome, so reading it back here shares one
            // source of truth with attempt-cli.js (#5654) and survives a loop-daemon restart instead of resetting.
            const convergenceInput = portfolioQueue.getAttemptHistory(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
            const boundary = evaluateBoundaryGateFn({
                runHalted: false,
                usage,
                limits: (amsPolicy.spec.capLimits ?? DEFAULT_AMS_POLICY_SPEC.capLimits),
                convergence: convergenceInput,
                convergenceThresholds: (amsPolicy.spec.convergenceThresholds ?? DEFAULT_AMS_POLICY_SPEC.convergenceThresholds),
                inFlightItem: { repoFullName: claimed.repoFullName, identifier: claimed.identifier },
                // Echoes claimed.apiBaseUrl (#5563), NOT the callback's own repoFullName/identifier alone -- two forge
                // hosts can share an in-flight item with the same repo name+identifier.
                markFailed: (repoFullName, identifier) => portfolioQueue.markFailed(repoFullName, identifier, claimed.apiBaseUrl),
            }, { append: (event) => governorLedger.appendGovernorEvent(event) });
            if (!boundary.canClaimNext) {
                haltReason = `boundary_${boundary.verdict.reason}`;
                cycles.push({ cycle: cycleIndex, outcome: "halted", reason: haltReason, repoFullName: claimed.repoFullName, identifier: claimed.identifier });
                break;
            }
            const cycleStartMs = nowMsFn();
            // Held on an object rather than a bare `let`: the value is assigned inside the runAttempt `onResult`
            // callback below, and TS's control-flow analysis would otherwise narrow a callback-only-assigned `let`
            // back to its `null` initializer at the reads after the await. A property read is not narrowed that way.
            const lastResultHolder = { value: null };
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
                    lastResultHolder.value = result;
                },
            });
            const cycleElapsedMs = nowMsFn() - cycleStartMs;
            usage = {
                // Real for the agent-sdk provider (its own SDK result message reports total_cost_usd, wired through
                // runMinerAttempt's real loopResult.totalCostUsd); the CLI-subprocess providers (claude-cli/codex-cli)
                // report no cost signal today, so this contributes 0 for those runs -- an honest absence, not a
                // fabricated number. A capLimits.budget dimension only ever meaningfully trips against agent-sdk spend.
                budgetSpent: usage.budgetSpent + (lastResultHolder.value?.totalCostUsd ?? 0),
                turnsTaken: usage.turnsTaken + (lastResultHolder.value?.totalTurnsUsed ?? 0),
                elapsedMs: usage.elapsedMs + cycleElapsedMs,
            };
            governorState.saveCapUsage(usage);
            const attemptOutcome = lastResultHolder.value?.outcome ?? "attempt_error";
            const submitted = attemptOutcome === "attempt_submitted";
            // A repo-wide AI-usage-policy ban will never resolve on retry -- stop re-queuing it (matches
            // rejection-signal.js's own "this repo bans automated contributions" semantics). Every other blocked/
            // abandoned/stale/governed outcome MAY resolve on a later retry (transient infra, contention, a
            // different iteration budget) and is requeued -- a genuinely stuck item is caught by non-convergence
            // (reenqueues threshold) rather than silently retried forever.
            const permanentBlock = attemptOutcome === "blocked_rejection_signaled";
            // Mid-attempt kill-switch abandon (#5670): stop the outer loop immediately instead of waiting for the
            // next between-cycle probe, and treat the item like any other re-queued abandon via markFailed below.
            const killSwitchAbandon = lastResultHolder.value?.abandonReason === "kill_switch_engaged";
            if (submitted || permanentBlock) {
                // Both terminal -- a submitted PR is done, and a repo-wide AI-usage-policy ban never resolves on retry --
                // so neither is re-queued. markDone also clears the persisted consecutive-failure streak.
                portfolioQueue.markDone(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
            }
            else {
                // Any other blocked/abandoned/stale/governed outcome may resolve on a later retry, so requeue it; markFailed
                // records the re-enqueue + consecutive failure the non-convergence detector reads on the next cycle.
                portfolioQueue.markFailed(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
            }
            if (killSwitchAbandon) {
                const liveKill = checkKillSwitchFn({ env });
                haltReason = liveKill.active ? `kill_switch_${liveKill.scope}` : "kill_switch_engaged";
                cycles.push({
                    cycle: cycleIndex,
                    outcome: "halted",
                    reason: haltReason,
                    repoFullName: claimed.repoFullName,
                    identifier: claimed.identifier,
                    attemptOutcome,
                });
                break;
            }
            let reentryOutcome = "other";
            let prNumber = null;
            let prDisposition = null;
            let ciConclusion = null;
            if (submitted) {
                prNumber = parsePrNumberFromExecResult(lastResultHolder.value?.execResult, claimed.repoFullName);
                if (prNumber !== null) {
                    // Real CI-status observation (#5394): recorded BEFORE the disposition poll below, so a submitted
                    // PR's check-run state is captured even while it's still open, not just at its eventual merge/close.
                    // ci-poller.js's real GitHub check-run polling is a heuristic proxy for the gate verdict; the
                    // authoritative terminal merge/close outcome comes from pollPrDispositionFn below, sourced directly
                    // from GitHub's own PR state rather than a server-internal endpoint (#5450).
                    const ciStatus = await pollCheckRunsFn(claimed.repoFullName, prNumber, {
                        githubToken,
                        ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
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
                        ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
                        ...(options.prDispositionOptions ?? {}),
                    });
                    if (prDisposition.state === "closed") {
                        recordPrOutcomeSnapshotFn({
                            repoFullName: claimed.repoFullName,
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
        const summary = { haltReason, cyclesRun: cycles.length, cycles };
        if (parsed.json) {
            console.log(JSON.stringify(summary, null, 2));
        }
        else {
            console.log(`Loop finished after ${cycles.length} cycle(s): ${haltReason ?? "unknown"}.`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9vcC1jbGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJsb29wLWNsaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxzR0FBc0c7QUFDdEcsaUdBQWlHO0FBQ2pHLHlHQUF5RztBQUN6RyxtR0FBbUc7QUFDbkcsRUFBRTtBQUNGLHFHQUFxRztBQUNyRyx5R0FBeUc7QUFDekcscUZBQXFGO0FBQ3JGLDZHQUE2RztBQUM3RyxzREFBc0Q7QUFDdEQscUdBQXFHO0FBQ3JHLDBHQUEwRztBQUMxRyw4R0FBOEc7QUFDOUcsNkdBQTZHO0FBQzdHLDJEQUEyRDtBQUMzRCxFQUFFO0FBQ0YsdUdBQXVHO0FBQ3ZHLDBHQUEwRztBQUMxRyw4R0FBOEc7QUFDOUcsNEdBQTRHO0FBQzVHLCtHQUErRztBQUMvRyw2R0FBNkc7QUFDN0csK0VBQStFO0FBRS9FLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxNQUFNLDJCQUEyQixDQUFDO0FBQ2pFLE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUNsRixPQUFPLEVBQUUsMkJBQTJCLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUNyRSxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQUN4RCxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUMxRCxPQUFPLEVBQUUsZUFBZSxFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFDcEQsT0FBTyxFQUFFLHVCQUF1QixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFDL0QsT0FBTyxFQUFFLGlCQUFpQixFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFDbkQsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBQ2hELE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUM5QyxPQUFPLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQUNuRCxPQUFPLEVBQUUsaUJBQWlCLEVBQUUscUJBQXFCLEVBQUUsTUFBTSw0QkFBNEIsQ0FBQztBQUN0RixPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFDL0MsT0FBTyxFQUFFLHVCQUF1QixFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFDMUQsT0FBTyxFQUFFLFlBQVksRUFBRSxNQUFNLDhCQUE4QixDQUFDO0FBQzVELE9BQU8sRUFBRSx1QkFBdUIsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBQzVELE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBQ3ZELE9BQU8sRUFBRSwyQkFBMkIsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBQ25FLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLDhCQUE4QixDQUFDO0FBQ2xFLE9BQU8sRUFBRSx1QkFBdUIsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBWTNELE1BQU0sVUFBVSxHQUNkLCtMQUErTCxDQUFDO0FBQ2xNLE1BQU0sc0JBQXNCLEdBQUcsTUFBTSxDQUFDO0FBQ3RDLE1BQU0sd0JBQXdCLEdBQUcsZUFBZSxDQUFDO0FBNkVqRCxTQUFTLGVBQWUsQ0FBQyxLQUFhO0lBQ3BDLE1BQU0sT0FBTyxHQUFHLE9BQU8sS0FBSyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDOUQsTUFBTSxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNoRCxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsSUFBSSxJQUFJLEtBQUssS0FBSyxTQUFTO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDeEQsT0FBTyxHQUFHLEtBQUssSUFBSSxJQUFJLEVBQUUsQ0FBQztBQUM1QixDQUFDO0FBRUQsU0FBUyw0QkFBNEIsQ0FBQyxLQUFhLEVBQUUsS0FBYTtJQUNoRSxNQUFNLFdBQVcsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDbEMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLFdBQVcsQ0FBQyxJQUFJLFdBQVcsR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUN2RixNQUFNLElBQUksS0FBSyxDQUFDLEdBQUcsS0FBSyxvQ0FBb0MsS0FBSyxFQUFFLENBQUMsQ0FBQztJQUN2RSxDQUFDO0lBQ0QsT0FBTyxXQUFXLENBQUM7QUFDckIsQ0FBQztBQUVELE1BQU0sVUFBVSxhQUFhLENBQUMsSUFBYztJQUMxQyxNQUFNLE9BQU8sR0FBRztRQUNkLElBQUksRUFBRSxLQUFLO1FBQ1gsVUFBVSxFQUFFLElBQXFCO1FBQ2pDLElBQUksRUFBRSxNQUFNO1FBQ1osSUFBSSxFQUFFLEtBQUs7UUFDWCxNQUFNLEVBQUUsS0FBSztRQUNiLE1BQU0sRUFBRSxJQUFxQjtRQUM3QixTQUFTLEVBQUUsU0FBK0I7UUFDMUMsWUFBWSxFQUFFLHNCQUFzQjtLQUNyQyxDQUFDO0lBQ0YsTUFBTSxPQUFPLEdBQWEsRUFBRSxDQUFDO0lBRTdCLEtBQUssSUFBSSxLQUFLLEdBQUcsQ0FBQyxFQUFFLEtBQUssR0FBRyxJQUFJLENBQUMsTUFBTSxFQUFFLEtBQUssSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUNwRCxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFFLENBQUM7UUFDM0IsSUFBSSxLQUFLLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDdkIsT0FBTyxDQUFDLElBQUksR0FBRyxJQUFJLENBQUM7WUFDcEIsU0FBUztRQUNYLENBQUM7UUFDRCxJQUFJLEtBQUssS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUN2QixPQUFPLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQztZQUNwQixTQUFTO1FBQ1gsQ0FBQztRQUNELDJHQUEyRztRQUMzRyx1R0FBdUc7UUFDdkcsSUFBSSxLQUFLLEtBQUssV0FBVyxFQUFFLENBQUM7WUFDMUIsT0FBTyxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUM7WUFDdEIsU0FBUztRQUNYLENBQUM7UUFDRCxJQUFJLEtBQUssS0FBSyxVQUFVLEVBQUUsQ0FBQztZQUN6QixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBQzlCLElBQUksQ0FBQyxLQUFLLElBQUksS0FBSyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUM7Z0JBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxVQUFVLEVBQUUsQ0FBQztZQUNsRSxPQUFPLENBQUMsTUFBTSxHQUFHLEtBQUssQ0FBQztZQUN2QixLQUFLLElBQUksQ0FBQyxDQUFDO1lBQ1gsU0FBUztRQUNYLENBQUM7UUFDRCxJQUFJLEtBQUssS0FBSyxlQUFlLEVBQUUsQ0FBQztZQUM5QixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBQzlCLElBQUksQ0FBQyxLQUFLLElBQUksS0FBSyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUM7Z0JBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxVQUFVLEVBQUUsQ0FBQztZQUNsRSxPQUFPLENBQUMsVUFBVSxHQUFHLEtBQUssQ0FBQztZQUMzQixLQUFLLElBQUksQ0FBQyxDQUFDO1lBQ1gsU0FBUztRQUNYLENBQUM7UUFDRCxJQUFJLEtBQUssS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUN2QixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBQzlCLElBQUksQ0FBQyxLQUFLLElBQUksS0FBSyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUM7Z0JBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxVQUFVLEVBQUUsQ0FBQztZQUNsRSxPQUFPLENBQUMsSUFBSSxHQUFHLEtBQUssQ0FBQztZQUNyQixLQUFLLElBQUksQ0FBQyxDQUFDO1lBQ1gsU0FBUztRQUNYLENBQUM7UUFDRCxJQUFJLEtBQUssS0FBSyxjQUFjLEVBQUUs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