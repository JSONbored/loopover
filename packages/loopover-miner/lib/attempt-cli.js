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
import { fingerprintFromChangedFiles, resolveCodingAgentModeFromConfig, resolveFirstConfiguredCodingAgentDriverName } from "@loopover/engine";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { constructProductionCodingAgentDriver } from "./coding-agent-construction.js";
import { runSlopAssessment } from "./slop-assessment.js";
import { fetchLiveIssueSnapshot } from "./live-issue-snapshot.js";
import { executeLocalWrite } from "./execute-local-write.js";
import { openClaimLedger } from "./claim-ledger.js";
import { resolveMinerGoalSpec } from "./miner-goal-spec.js";
import { resolveClaimConflict } from "./claim-conflict-resolver.js";
import { parsePrNumberFromExecResult } from "./pr-number-parse.js";
import { initEventLedger } from "./event-ledger.js";
import { initAttemptLog } from "./attempt-log.js";
import { initGovernorLedger } from "./governor-ledger.js";
import { openWorktreeAllocator } from "./worktree-allocator.js";
import { isValidRepoSegment } from "./repo-clone.js";
import { REJECTION_REASON_AI_USAGE_POLICY_BAN, REJECTION_REASON_OWN_SUBMISSION_REJECTED, resolveRejectionSignaled } from "./rejection-signal.js";
import { cleanupAttemptWorktree, prepareAttemptWorktree } from "./attempt-worktree.js";
import { fetchSelfReviewContext } from "./self-review-context.js";
import { buildCodingTaskSpec } from "./coding-task-spec.js";
import { resolveAmsPolicy } from "./ams-policy.js";
import { checkMinerKillSwitch, recordMinerKillSwitchTransition } from "./governor-kill-switch.js";
import { captureMinerError } from "./sentry.js";
import { buildAttemptGovernorContext, buildAttemptLoopInput } from "./attempt-input-builder.js";
import { getAttemptHistory } from "./portfolio-queue.js";
import { loadReputationHistory, recordOwnSubmission } from "./governor-state.js";
import { runMinerAttempt } from "./attempt-runner.js";
import { resolveGitHubToken } from "./github-token-resolution.js";
import { isDiscoveryPlaneEnabled, submitSoftClaim } from "./discovery-index-client.js";
const ATTEMPT_USAGE = "Usage: loopover-miner attempt <owner/repo> <issue#> --miner-login <login> [--base <branch>] [--live] [--dry-run] [--json]";
function parseRepoTarget(value) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo))
        return null;
    return `${owner}/${repo}`;
}
export function parseAttemptArgs(args) {
    const options = { json: false, minerLogin: null, base: "main", live: false, dryRun: false };
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
            if (!value || value.startsWith("-"))
                return { error: ATTEMPT_USAGE };
            options.minerLogin = value;
            index += 1;
            continue;
        }
        if (token === "--base") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: ATTEMPT_USAGE };
            options.base = value;
            index += 1;
            continue;
        }
        if (token.startsWith("-"))
            return { error: `Unknown option: ${token}` };
        positional.push(token);
    }
    if (positional.length !== 2)
        return { error: ATTEMPT_USAGE };
    const repoFullName = parseRepoTarget(positional[0]);
    if (!repoFullName)
        return { error: `Repository must be in owner/repo form: ${positional[0]}` };
    const issueNumber = Number(positional[1]);
    if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        return { error: `Issue number must be a positive integer: ${positional[1]}` };
    }
    if (!options.minerLogin)
        return { error: `--miner-login is required. ${ATTEMPT_USAGE}` };
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
export function buildAttemptDeps(env, ledgers) {
    return {
        driver: constructProductionCodingAgentDriver(env),
        runSlopAssessment: (input) => runSlopAssessment(input),
        appendAttemptLogEvent: (event) => ledgers.attemptLog.appendAttemptLogEvent(event),
        // The real ClaimLedger is a valid claim ledger for AttemptDeps' narrower SubmissionFreshnessClaimLedger view;
        // its listClaims types `status` as the concrete ClaimStatus rather than the view's looser `string`, so the
        // structural check needs an explicit bridge (runtime shape is identical).
        claimLedger: ledgers.claimLedger,
        // resolveGitHubToken (#6116): GITHUB_TOKEN env override wins outright, else a live token from the
        // authenticated `loopover-mcp login` session -- cached in memory, so repeat calls within this process
        // don't repeatedly hit the session-fetch endpoint after the first successful resolution.
        fetchLiveIssueSnapshot: async (repoFullName, issueNumber) => fetchLiveIssueSnapshot(repoFullName, issueNumber, { githubToken: (await resolveGitHubToken(env)) }),
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
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    const env = options.env ?? process.env;
    const nowMs = options.nowMs ?? Date.now();
    const resolveMode = options.resolveCodingAgentModeFromConfig ?? resolveCodingAgentModeFromConfig;
    const mode = resolveMode({ env, agentDryRun: !parsed.live });
    if (mode === "paused") {
        return reportCliFailure(parsed.json, `Coding-agent execution is globally paused (MINER_CODING_AGENT_PAUSED). Not running attempt for ${parsed.repoFullName}#${parsed.issueNumber}.`, 3);
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
        }
        else {
            console.log(`DRY RUN: would attempt ${parsed.repoFullName}#${parsed.issueNumber} for ${parsed.minerLogin} (mode: ${mode}, base: ${parsed.base}). No worktree, claim, or ledger writes were made.`);
        }
        options.onResult?.(dryRunResult);
        return 0;
    }
    let allocator = null;
    let claimLedger = null;
    let eventLedger = null;
    let attemptLog = null;
    let governorLedger = null;
    let allocation = null;
    let worktreeResult = null;
    let claimedIssue = false;
    let claimRecord = null;
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
        const rejectionSignal = await resolveRejection(parsed.repoFullName, { fetchImpl: options.fetchImpl });
        if (rejectionSignal) {
            const reason = rejectionSignal === true ? REJECTION_REASON_AI_USAGE_POLICY_BAN : rejectionSignal;
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
            }
            else {
                console.error(reason === REJECTION_REASON_OWN_SUBMISSION_REJECTED
                    ? `Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: this miner was previously rejected on this repo.`
                    : `Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: this repo's AI-usage policy bans automated/AI-authored contributions.`);
            }
            options.onResult?.(rejectedResult);
            return 5;
        }
        allocation = allocator.acquire(attemptId, parsed.repoFullName);
        let deps;
        try {
            const buildDeps = options.buildAttemptDeps ?? buildAttemptDeps;
            deps = buildDeps(env, { claimLedger, eventLedger, attemptLog, governorLedger, nowMs });
        }
        catch (error) {
            const reason = describeCliError(error);
            return reportCliFailure(parsed.json, `Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: ${reason}`, 3);
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
            }
            else {
                console.error(`Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: real worktree preparation failed: ${reason}`);
            }
            options.onResult?.(worktreeFailureResult);
            return 6;
        }
        // Real SelfReviewContext (#5145): issue/PR/manifest data at live-gate fidelity for the target repo.
        const fetchReviewContext = options.fetchSelfReviewContext ?? fetchSelfReviewContext;
        const reviewContext = await fetchReviewContext(parsed.repoFullName, {
            githubToken: (await resolveGitHubToken(env)),
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
            // Same narrower-view bridge as AttemptDeps.claimLedger above: buildCodingTaskSpec only needs a listClaims
            // reader (CodingTaskClaimLedger), whose `status: string` is looser than the real ledger's ClaimStatus.
            claimLedger: claimLedger,
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
            }
            else {
                console.error(`Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: feasibility verdict "${codingTaskSpec.verdict}" (${[...codingTaskSpec.feasibility.avoidReasons, ...codingTaskSpec.feasibility.raiseReasons].join(", ")}).`);
            }
            options.onResult?.(infeasibleResult);
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
        const recordKillTransition = options.recordMinerKillSwitchTransition ??
            recordMinerKillSwitchTransition;
        let killSwitchScope = checkKillSwitch({ env, repoPaused }).scope;
        let previousKillSwitchScope = killSwitchScope;
        const resolveLiveKillSwitch = () => {
            // Re-read the YAML flag each probe so an on-disk unpause/pause is reflected mid-attempt (#5670).
            const liveRepoPaused = resolveGoalSpec(worktreeResult.repoPath).spec.killSwitch.paused;
            const live = checkKillSwitch({ env, repoPaused: liveRepoPaused });
            if (live.scope !== previousKillSwitchScope) {
                try {
                    recordKillTransition({
                        repoFullName: parsed.repoFullName,
                        actionClass: "attempt",
                        previousScope: previousKillSwitchScope,
                        scope: live.scope,
                    });
                }
                catch (error) {
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
            if (!live.active)
                return false;
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
        const readReputationHistory = options.loadReputationHistory ?? loadReputationHistory;
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
        const claimResult = claimLedger.claimIssueWithinCap(parsed.repoFullName, parsed.issueNumber, `attempt:${attemptId}`, undefined, minerGoalSpec.spec.maxConcurrentClaims);
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
            }
            else {
                console.error(`Attempt for ${parsed.repoFullName}#${parsed.issueNumber} is blocked: this repo's maxConcurrentClaims cap (${minerGoalSpec.spec.maxConcurrentClaims}) is already met (${claimResult.activeClaimCount} active claim(s)).`);
            }
            // `blocked_max_concurrent_claims` (#6758) is an internal cap-rejection outcome the public AttemptCliResult
            // union does not enumerate; the onResult hook still receives the real structured payload here, so bridge
            // its shape without widening the exported result type.
            options.onResult?.(blockedResult);
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
            await submitClaim(claimRecord, { env });
        }
        const runAttemptPipeline = options.runMinerAttempt ?? runMinerAttempt;
        let result;
        try {
            result = await runAttemptPipeline({
                loopInput,
                issueNumber: parsed.issueNumber,
                minerLogin: parsed.minerLogin,
                base: parsed.base,
                killSwitchScope,
                slopThreshold: amsPolicy.spec.slopThreshold,
                submissionMode: amsPolicy.spec.submissionMode,
                governor,
            }, {
                ...deps,
                shouldAbort,
                resolveKillSwitchScope: () => resolveLiveKillSwitch().scope,
            });
        }
        catch (error) {
            // A real attempt that CRASHED is exactly the case that most needs its worktree kept for post-mortem
            // inspection, so record the failure explicitly before unwinding. Without this, `attemptOk` stayed
            // `undefined` and the finally block's `?? true` default (meant for the earlier blocked paths that never
            // ran anything in the worktree) deleted it -- inverting shouldRetainWorktree's documented policy.
            worktreeResult.attemptOk = false;
            throw error;
        }
        worktreeResult.attemptOk = result.outcome === "submitted";
        // Real claim-conflict resolution (#4848): only meaningful once a real PR exists, so this only ever runs
        // on a real "submitted" outcome. checkSubmissionFreshness (inside runMinerAttempt) already caught the
        // common pre-submission case; this closes the narrower TOCTOU window where two miners raced past that
        // check almost simultaneously -- see claim-conflict-resolver.js's own header for why the adjudicator
        // can only run POST-submission (it needs a real PR number on both sides of the election).
        let claimConflict;
        if (result.outcome === "submitted") {
            const selfPrNumber = parsePrNumberFromExecResult(result.execResult, parsed.repoFullName);
            if (selfPrNumber !== null) {
                const resolveConflict = options.resolveClaimConflict ?? resolveClaimConflict;
                claimConflict = await resolveConflict({
                    repoFullName: parsed.repoFullName,
                    issueNumber: parsed.issueNumber,
                    selfPrNumber,
                    selfClaimedAt: claimRecord.claimedAt,
                    minerLogin: parsed.minerLogin,
                }, { fetchLiveIssueSnapshot: deps.fetchLiveIssueSnapshot, executeLocalWrite: deps.executeLocalWrite });
            }
            // Real own-submission history (#5655 follow-up): governor-state.js's recordOwnSubmission/
            // listRecentOwnSubmissions store (#5134) existed and was already READ by resolveOwnRejectionHistory
            // (#5655), but nothing ever WROTE to it -- attempt-runner.js's own header names this exact gap
            // ("real persistence primitives... but isn't auto-loaded here yet"). Left unfixed, that trigger is a
            // silent no-op in every real deployment: an empty table always resolves "no prior submissions found."
            // The fingerprint is the real changed-files set from the loop's own handoff packet (never fabricated) --
            // omitted (not recorded as an empty placeholder) when the packet reports no changed files at all. A
            // logging failure must never fail an otherwise-successful attempt, matching the summary-event write below.
            const changedFiles = result.loopResult.handoffPacket?.changedFiles?.map((file) => file.path) ?? [];
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
                }
                catch (error) {
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
        }
        catch (error) {
            // A logging failure must never fail an otherwise-successful attempt (kept), but was previously silent --
            // per docs/observability.md this row feeds the Grafana per-provider cost/usage dashboard, so a failure
            // here silently drops the attempt from operator-facing metrics with nobody told (#6011).
            captureMinerError(error, { kind: "attempt_outcome_summary_append_failed", attemptId, repoFullName: parsed.repoFullName });
        }
        if (parsed.json) {
            console.log(JSON.stringify(finalResult, null, 2));
        }
        else {
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
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
    finally {
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
        if (claimedIssue && claimLedger)
            claimLedger.releaseClaim(parsed.repoFullName, parsed.issueNumber);
        // Paired hosted release (#7168): same call-site opt-in gate as the claim submission above. Only fires when
        // the initial claim submission actually ran (claimRecord is only set once claimedIssue is), so a run that
        // never reached the claim point (e.g. blocked_max_concurrent_claims) has nothing to release remotely.
        if (claimedIssue && claimRecord && isDiscoveryPlaneEnabled(env)) {
            const submitClaim = options.submitSoftClaim ?? submitSoftClaim;
            await submitClaim({ ...claimRecord, status: "released" }, { env });
        }
        if (allocation && allocator)
            allocator.release(attemptId);
        allocator?.close();
        claimLedger?.close();
        eventLedger?.close();
        attemptLog?.close();
        governorLedger?.close();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXR0ZW1wdC1jbGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhdHRlbXB0LWNsaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxvSEFBb0g7QUFDcEgscUdBQXFHO0FBQ3JHLDBHQUEwRztBQUMxRyw2R0FBNkc7QUFDN0csOEdBQThHO0FBQzlHLDJHQUEyRztBQUMzRyxxR0FBcUc7QUFDckcsMkZBQTJGO0FBQzNGLHFGQUFxRjtBQUNyRixFQUFFO0FBQ0YsMEdBQTBHO0FBQzFHLGtIQUFrSDtBQUNsSCxpSEFBaUg7QUFDakgsMkdBQTJHO0FBRTNHLE9BQU8sRUFBRSwyQkFBMkIsRUFBRSxnQ0FBZ0MsRUFBRSwyQ0FBMkMsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQzlJLE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUNsRixPQUFPLEVBQUUsb0NBQW9DLEVBQUUsTUFBTSxnQ0FBZ0MsQ0FBQztBQUN0RixPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUN6RCxPQUFPLEVBQUUsc0JBQXNCLEVBQUUsTUFBTSwwQkFBMEIsQ0FBQztBQUNsRSxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSwwQkFBMEIsQ0FBQztBQUM3RCxPQUFPLEVBQUUsZUFBZSxFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFDcEQsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFDNUQsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sOEJBQThCLENBQUM7QUFDcEUsT0FBTyxFQUFFLDJCQUEyQixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFDbkUsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBQ3BELE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUNsRCxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxzQkFB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