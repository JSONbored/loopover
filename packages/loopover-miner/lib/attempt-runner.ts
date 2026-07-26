import type {
  CodingAgentDriver,
  GovernorDecision,
  HandoffPacket,
  IterateLoopInput,
  IterateLoopResult,
  IterateLoopShouldAbort,
  LocalWriteActionSpec,
  SelfReviewAdapterDeps,
} from "@loopover/engine";
import { buildOpenPrSpec, fingerprintFromChangedFiles } from "@loopover/engine";
import { runIterateLoop } from "@loopover/engine";
import type {
  FreshnessAbortReason,
  LiveIssueSnapshot,
  SubmissionFreshnessClaimLedger,
} from "./submission-freshness-check.js";
import { checkSubmissionFreshness } from "./submission-freshness-check.js";
import type { GovernorChokepointInputPersisted } from "./governor-chokepoint-persisted.js";
import { evaluateGovernorChokepointGatePersisted } from "./governor-chokepoint-persisted.js";
import type { AppendGovernorEventInput, GovernorLedgerEntry } from "./governor-ledger.js";
import type { GovernorState } from "./governor-state.js";
import { listRecentOwnSubmissions } from "./governor-state.js";
import type {
  HarnessSubmissionCandidateInput,
  HarnessSubmissionDecision,
  HarnessSubmissionEventLedger,
} from "./harness-submission-trigger.js";
import { prepareOpenPrSubmission } from "./harness-submission-trigger.js";
import { captureMinerError } from "./sentry.js";

export const ATTEMPT_OUTCOMES: readonly ["abandon", "stale", "blocked", "governed", "submitted"] = Object.freeze([
  "abandon",
  "stale",
  "blocked",
  "governed",
  "submitted",
]);

// rateLimitBuckets/rateLimitBackoffAttempts/capUsage are optional here (via GovernorChokepointInputPersisted,
// not the engine's own GovernorChokepointInput) so a caller can omit them and let evaluateGovernorChokepointGatePersisted
// (#5134) auto-supply real persisted state -- forcing them required at this layer would make every caller
// hand-thread honest-but-stale zero defaults on every invocation, silently defeating that persistence.
export type AttemptGovernorContext = Omit<
  GovernorChokepointInputPersisted,
  "actionClass" | "repoFullName" | "nowMs" | "wouldBeAction"
>;

export type AttemptInput = {
  loopInput: IterateLoopInput;
  issueNumber: number;
  minerLogin: string;
  base: string;
  killSwitchScope: "global" | "repo" | "none";
  slopThreshold: "clean" | "low" | "elevated" | "high";
  submissionMode: "observe" | "enforce";
  maxConsecutiveGateBlocks?: number;
  draft?: boolean;
  governor: AttemptGovernorContext;
};

export type AttemptDeps = {
  /** #8807: pre-bound target-repo verification (worktree + detected stack captured by the caller). Runs the
   *  TARGET repo's own test/lint/build commands after handoff and BEFORE any submission read/write — a
   *  failed verification blocks the PR instead of trusting the coding agent's self-attestation. Optional:
   *  absent (older callers, tests) preserves the pre-#8807 flow byte-identically. Loosely typed at this
   *  public boundary like runSlopAssessment above; the real shape is TargetRepoVerificationResult. */
  verifyTargetRepo?: () => Promise<{ status: string } & Record<string, unknown>>;
  driver: CodingAgentDriver;
  runSlopAssessment: (input: unknown) => unknown;
  appendAttemptLogEvent: (event: unknown) => void;
  claimLedger: SubmissionFreshnessClaimLedger;
  fetchLiveIssueSnapshot: (repoFullName: string, issueNumber: number) => Promise<LiveIssueSnapshot | null>;
  eventLedger: HarnessSubmissionEventLedger;
  /** Injected governor-ledger append (mirrors evaluateGovernorChokepointGate's own `options.append`); omitted
   *  falls back to that function's own default (the real default governor ledger). */
  governorLedgerAppend?: (event: unknown) => unknown;
  /** Injected governor-state store (#5134); omitted falls back to evaluateGovernorChokepointGatePersisted's
   *  own default (opens + closes the real default governor-state store for this one call). */
  governorState?: GovernorState;
  sessionStartMs?: number;
  nowMs: number;
  executeLocalWrite: (spec: LocalWriteActionSpec) => Promise<unknown>;
  /** Mid-attempt kill-switch probe threaded into `runIterateLoop` (#5670). */
  shouldAbort?: () => IterateLoopShouldAbort;
  /** Live kill-switch scope resolver after handoff (#5670); defaults to the frozen attempt-start scope. */
  resolveKillSwitchScope?: () => "global" | "repo" | "none";
};

export type AttemptResult =
  | { outcome: "abandon"; loopResult: IterateLoopResult }
  | { outcome: "verification_failed"; verification: unknown; loopResult: IterateLoopResult }
  | { outcome: "stale"; reason: FreshnessAbortReason; loopResult: IterateLoopResult }
  | { outcome: "blocked"; decision: HarnessSubmissionDecision; loopResult: IterateLoopResult }
  | { outcome: "governed"; decision: GovernorDecision; loopResult: IterateLoopResult }
  | { outcome: "submitted"; spec: LocalWriteActionSpec; execResult: unknown; loopResult: IterateLoopResult };

// The real driving-loop entrypoint (#2337): the missing link between #2333's iterate-loop orchestrator and an
// actual, executed open_pr write. Composes, in order: runIterateLoop (create -> score -> self-review -> decide,
// #2333) -> on handoff, checkSubmissionFreshness (#3007) -> prepareOpenPrSubmission (#2336/#2337) -> the
// Governor chokepoint (#2340, which itself composes kill-switch, dry-run, rate-limit, budget caps, non-
// convergence, self-reputation-throttle, and self-plagiarism -- see chokepoint.ts's own module doc comment for
// the exact precedence ladder) -> on allowed:true, builds the REAL open_pr command via the now-shared
// buildOpenPrSpec (@loopover/engine, moved from root src/mcp/local-write-tools.ts) and executes it.
//
// WORKTREE LIFECYCLE IS NOT THIS MODULE'S JOB: runIterateLoop already takes a plain `workingDirectory` string
// (packages/loopover-engine/src/miner/iterate-loop.ts's own IterateLoopInput), deliberately agnostic about
// where it came from. Allocating one is the caller's job, via the already-built slot allocator
// (worktree-allocator.js, #4297) -- this module composes the create/review/gate/submit sequence #2337 is
// actually about, not worktree allocation policy, which is a separate, already-solved concern.
//
// `deps.runSlopAssessment` stays INJECTED rather than imported here (this module composes the sequence and is
// agnostic about the scorer behind the seam), but it is no longer unwired: slop-assessment.js (#5133) is its
// real production binding -- a direct pass-through to the engine's own buildSlopAssessment -- and attempt-cli.js
// wires that binding in on the production path. The seam was injected-but-unwired when this module was written
// only because the deterministic scorer was not yet portable; #5133 extracted src/signals/slop.ts's PR-side
// scorer into packages/loopover-engine/src/signals/slop.ts (byte-parity-verified against the live gate's own
// copy), closing the gap this header used to document. This function still requires a real implementation be
// injected rather than silently stubbing a result that would either always pass (unsafe) or always fail
// (useless).
//
// `input.governor`'s cross-attempt state (rate-limit buckets, backoff attempts, budget-cap usage) DOES now
// persist across separate process invocations (#5134, governor-state.js), via
// evaluateGovernorChokepointGatePersisted -- callers no longer need to hand-thread honest empty/zero defaults
// on every invocation; `capUsage` is loaded from that same store but its post-attempt save stays the caller's
// job (see governor-chokepoint-persisted.js's own header for why: nothing computes "the next capUsage" from a
// verdict, only the attempt's real outcome does). Self-plagiarism state is now wired here (#5676): the
// prospective submission's real diff `selfPlagiarismCandidate` (fingerprintFromChangedFiles over the handoff
// packet's changed files) and the miner's real `selfPlagiarismRecentSubmissions` (governor-state.js's
// listRecentOwnSubmissions) are computed late -- right before the chokepoint call, after handoff, where the
// changed files first exist -- and passed in, so chokepoint.ts's selfPlagiarismCheck finally runs on real data.
// `input.governor.reputationHistory` remains a caller-supplied optional field, not auto-loaded here yet.

function assertFn(value: unknown, name: string): void {
  if (typeof value !== "function") throw new Error(`invalid_${name}`);
}

function assertDeps(deps: unknown): asserts deps is AttemptDeps {
  if (!deps || typeof deps !== "object") throw new Error("invalid_attempt_deps");
  const candidate = deps as Record<string, unknown>;
  assertFn(candidate.runSlopAssessment, "run_slop_assessment");
  assertFn(candidate.appendAttemptLogEvent, "append_attempt_log_event");
  assertFn(candidate.fetchLiveIssueSnapshot, "fetch_live_issue_snapshot");
  assertFn(candidate.executeLocalWrite, "execute_local_write");
  const driver = candidate.driver as { run?: unknown } | undefined;
  if (!driver || typeof driver.run !== "function") throw new Error("invalid_driver");
  const claimLedger = candidate.claimLedger as { listClaims?: unknown } | undefined;
  if (!claimLedger || typeof claimLedger.listClaims !== "function") throw new Error("invalid_claim_ledger");
  const eventLedger = candidate.eventLedger as { appendEvent?: unknown } | undefined;
  if (!eventLedger || typeof eventLedger.appendEvent !== "function") throw new Error("invalid_event_ledger");
  if (typeof candidate.nowMs !== "number" || !Number.isFinite(candidate.nowMs)) throw new Error("invalid_now_ms");
}

function assertInput(input: unknown): asserts input is AttemptInput {
  if (!input || typeof input !== "object") throw new Error("invalid_attempt_input");
  const candidate = input as Record<string, unknown>;
  if (!candidate.loopInput || typeof candidate.loopInput !== "object") throw new Error("invalid_loop_input");
  if (!Number.isInteger(candidate.issueNumber) || (candidate.issueNumber as number) < 1) {
    throw new Error("invalid_issue_number");
  }
  if (typeof candidate.minerLogin !== "string" || !candidate.minerLogin.trim()) throw new Error("invalid_miner_login");
  if (typeof candidate.base !== "string" || !candidate.base.trim()) throw new Error("invalid_base");
  if (!["global", "repo", "none"].includes(candidate.killSwitchScope as string)) {
    throw new Error("invalid_kill_switch_scope");
  }
  if (!["clean", "low", "elevated", "high"].includes(candidate.slopThreshold as string)) {
    throw new Error("invalid_slop_threshold");
  }
  if (!["observe", "enforce"].includes(candidate.submissionMode as string)) throw new Error("invalid_submission_mode");
  if (!candidate.governor || typeof candidate.governor !== "object") throw new Error("invalid_governor_context");
}

/**
 * Run one full attempt end to end: iterate-loop -> (on handoff) freshness -> submission-gate -> Governor
 * chokepoint -> (on allowed:true) build + execute the real open_pr command. Fails closed (throws) on malformed
 * input/deps, mirroring every sibling module in this pipeline.
 */
export async function runMinerAttempt(input: AttemptInput, deps: AttemptDeps): Promise<AttemptResult> {
  assertInput(input);
  assertDeps(deps);

  const loopResult = await runIterateLoop(input.loopInput, {
    driver: deps.driver,
    // AttemptDeps deliberately keeps this loosely typed (`(input: unknown) => unknown`) at the public boundary --
    // the real, narrower shape (SelfReviewAdapterDeps["runSlopAssessment"]) is an engine-internal detail callers
    // shouldn't need to import just to satisfy this dependency's type.
    runSlopAssessment: deps.runSlopAssessment as SelfReviewAdapterDeps["runSlopAssessment"],
    appendAttemptLogEvent: deps.appendAttemptLogEvent,
    ...(typeof deps.shouldAbort === "function" ? { shouldAbort: deps.shouldAbort } : {}),
  });

  if (loopResult.outcome === "abandon") {
    return { outcome: "abandon", loopResult };
  }

  // Populated by design whenever outcome !== "abandon" (IterateLoopOutcome is only ever "handoff" | "abandon",
  // and handoffPacket is only ever set on "handoff") -- runIterateLoop's own type keeps the field optional
  // because it models both outcomes in one result shape.
  const handoffPacket = loopResult.handoffPacket as HandoffPacket;

  // Re-check kill-switch AFTER handoff and BEFORE any write (#5670) when a live resolver is supplied.
  // Without a live resolver, preserve pre-#5670 behavior: the frozen attempt-start scope is threaded into
  // prepareOpenPrSubmission / the submission gate (which itself denies active kill scopes).
  if (typeof deps.resolveKillSwitchScope === "function") {
    const liveKillSwitchScope = deps.resolveKillSwitchScope();
    if (liveKillSwitchScope !== "none") {
      return {
        outcome: "abandon",
        loopResult: {
          ...loopResult,
          outcome: "abandon",
          finalDecision: {
            action: "abandon",
            abandonReason: "kill_switch_engaged",
            reason: `Kill-switch (${liveKillSwitchScope}) engaged after handoff; refusing to open a PR.`,
          },
          handoffPacket: undefined,
        },
      };
    }
  }

  // #8807: the independent quality gate — the target repo's own commands against the worktree. Placed
  // BEFORE the freshness read so a failing build never spends GitHub API budget. A "skipped" or "passed"
  // result proceeds; only a real command failure blocks. Deliberately NOT re-entering the iterate loop in
  // this change: the loop's internal self-review iterations already ran, and never-submit-known-bad is the
  // trust win — feeding the failure back as loop input is the tracked follow-up on the issue.
  if (typeof deps.verifyTargetRepo === "function") {
    const verification = await deps.verifyTargetRepo();
    if (verification.status === "failed") {
      return { outcome: "verification_failed", verification, loopResult };
    }
  }

  const freshness = await checkSubmissionFreshness(
    { repoFullName: input.loopInput.repoFullName, issueNumber: input.issueNumber, minerLogin: input.minerLogin },
    { claimLedger: deps.claimLedger, fetchLiveIssueSnapshot: deps.fetchLiveIssueSnapshot, eventLedger: deps.eventLedger },
  );
  if (!freshness.fresh) {
    return { outcome: "stale", reason: freshness.reason, loopResult };
  }

  const submission = await prepareOpenPrSubmission(
    {
      killSwitchScope: input.killSwitchScope,
      repoFullName: input.loopInput.repoFullName,
      // HandoffPacket's optional fields are typed `| undefined` (engine's exactOptionalPropertyTypes style);
      // HarnessSubmissionCandidateInput's narrower local field type omits that -- both describe the same real
      // shape, so the cast just bridges the two independently-declared-but-compatible types.
      handoffPacket: handoffPacket as HarnessSubmissionCandidateInput["handoffPacket"],
      slopThreshold: input.slopThreshold,
      mode: input.submissionMode,
      // Spread-omit rather than pass `undefined` explicitly -- PrepareOpenPrSubmissionCandidate's optional
      // fields don't declare `| undefined`, and exactOptionalPropertyTypes treats those as different.
      ...(input.maxConsecutiveGateBlocks !== undefined
        ? { maxConsecutiveGateBlocks: input.maxConsecutiveGateBlocks }
        : {}),
      base: input.base,
      title: input.loopInput.title,
      body: input.loopInput.body ?? "",
      ...(input.draft !== undefined ? { draft: input.draft } : {}),
    },
    { eventLedger: deps.eventLedger, ...(deps.sessionStartMs !== undefined ? { sessionStartMs: deps.sessionStartMs } : {}) },
  );
  if (!submission.ready) {
    return { outcome: "blocked", decision: submission.decision, loopResult };
  }

  // Late-augment the self-plagiarism inputs (#5676): the prospective submission's real diff fingerprint and the
  // miner's real recent-submission history only exist HERE, after handoff -- attempt-cli.js's single early
  // governor snapshot (buildAttemptGovernorContext) is built before any changed files exist, so it cannot carry
  // them. This finally feeds chokepoint.ts's selfPlagiarismCheck, which was previously always skipped for lack of
  // data. Read the history from the SAME governor-state store the chokepoint itself uses (deps.governorState when
  // provided, else the persisted default via the module-level export). Fail open on a read failure so a
  // history-store hiccup never blocks an otherwise-allowed real submission.
  /* v8 ignore next -- buildHandoffPacket always populates changedFiles; the `?? []` only guards a hand-built packet */
  const changedFilePaths = (handoffPacket.changedFiles ?? []).map((file) => file.path);
  const selfPlagiarismCandidate = {
    repoFullName: input.loopInput.repoFullName,
    fingerprint: fingerprintFromChangedFiles(changedFilePaths),
    // The prospective submission's own time is "now" -- selfPlagiarismCheck needs a real submittedAt on the
    // candidate (it denies a candidate lacking one) and uses it for earliest-claimant election vs the priors.
    submittedAt: new Date(deps.nowMs).toISOString(),
  };
  let selfPlagiarismRecentSubmissions: ReturnType<GovernorState["listRecentOwnSubmissions"]>;
  try {
    selfPlagiarismRecentSubmissions = deps.governorState
      ? deps.governorState.listRecentOwnSubmissions({ repoFullName: input.loopInput.repoFullName })
      : listRecentOwnSubmissions({ repoFullName: input.loopInput.repoFullName });
  } catch (error) {
    // Fail-open is deliberate (see the comment above) -- this only makes the fallback VISIBLE. A broken
    // governor-state store silently disabling the self-plagiarism safety check had zero trace anywhere (#6011).
    captureMinerError(error, { kind: "self_plagiarism_history_read_failed", repoFullName: input.loopInput.repoFullName });
    selfPlagiarismRecentSubmissions = [];
  }

  const governed = evaluateGovernorChokepointGatePersisted(
    {
      actionClass: "open_pr",
      repoFullName: input.loopInput.repoFullName,
      nowMs: deps.nowMs,
      wouldBeAction: submission.openPrInput,
      ...input.governor,
      selfPlagiarismCandidate,
      selfPlagiarismRecentSubmissions,
    },
    {
      // AttemptDeps deliberately keeps governorLedgerAppend loosely typed (`(event: unknown) => unknown`) at the
      // public boundary, same as runSlopAssessment above -- cast to the engine-internal signature here.
      ...(deps.governorLedgerAppend
        ? { append: deps.governorLedgerAppend as (event: AppendGovernorEventInput) => GovernorLedgerEntry }
        : {}),
      ...(deps.governorState ? { governorState: deps.governorState } : {}),
    },
  );
  if (!governed.decision.allowed) {
    return { outcome: "governed", decision: governed.decision, loopResult };
  }

  const spec = buildOpenPrSpec(submission.openPrInput);
  const execResult = await deps.executeLocalWrite(spec);
  return { outcome: "submitted", spec, execResult, loopResult };
}
