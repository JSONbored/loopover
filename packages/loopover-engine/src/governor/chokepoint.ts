// The Governor chokepoint (#2340): the single fail-closed decision point every miner write action MUST pass
// through before executing a `LocalWriteActionSpec` (`src/mcp/local-write-tools.ts`: open_pr, file_issue,
// apply_labels, post_eligibility_comment, create_branch, delete_branch, generate_tests). This composes the
// previously-built pure calculators into one verdict -- it is the reason Phase 5 exists.
//
// PRECEDENCE ("safest wins", mirroring `resolveAgentActionMode` in `src/settings/agent-execution.ts`):
//   global kill-switch > per-repo pause > dry-run > rate-limit > budget/turn/termination cap > non-convergence
//   > self-reputation throttle > self-plagiarism > allow.
// The issue's own deliverable names rate-limit, budget caps, and non-convergence explicitly. This module also
// composes self-reputation-throttle and self-plagiarism, per those two calculators' OWN doc comments
// (`reputation-throttle.ts`: "the chokepoint can record WHY a submission cadence was scaled"; `self-plagiarism.ts`:
// "the Governor open_pr chokepoint (#2340) composes this verdict with rate-limit, budget caps, and
// non-convergence") -- both already ship a `*LedgerEvent` builder keyed on their own boolean
// throttled/allowed field, so composing them here reuses an existing, already-reviewed gate semantic rather
// than inventing a new one. Both are evaluated only for `actionClass === "open_pr"` (their own ledger builders
// hardcode/scope to PR submissions; a label-apply or branch-delete has no diff fingerprint or "submission
// cadence" to throttle).
//
// FAIL CLOSED: any stage that throws (malformed caller input escaping this module's typed boundary) denies
// immediately with `stage: "internal_error"`, never falls through to `allow`.
//
// PURE: no IO, no bucket/ledger persistence. This returns a verdict only; the miner-lib wrapper
// (`packages/loopover-miner/lib/governor-chokepoint.js`) owns mutating rate-limit buckets and appending the
// returned ledger event, mirroring the existing engine-pure/miner-lib-stateful split every sibling module uses.

import type { GovernorLedgerEvent, GovernorLedgerEventType } from "../governor-ledger.js";
import type { PortfolioConvergenceInput, PortfolioConvergenceThresholds, PortfolioConvergenceVerdict } from "../portfolio/non-convergence.js";
import { classifyPortfolioConvergence, DEFAULT_PORTFOLIO_CONVERGENCE_THRESHOLDS } from "../portfolio/non-convergence.js";
import { minerActionModeExecutes, resolveMinerActionMode, type MinerActionMode } from "./action-mode.js";
import type { GovernorCapLimits, GovernorCapReport, GovernorCapUsage } from "./budget-cap.js";
import { evaluateGovernorCaps } from "./budget-cap.js";
import { isMinerKillSwitchActive, resolveMinerKillSwitch, type MinerKillSwitchScope } from "./kill-switch.js";
import type { RepoOutcomeHistory, SelfReputationThresholds, SelfReputationThrottleDecision } from "./reputation-throttle.js";
import { DEFAULT_SELF_REPUTATION_THRESHOLDS, selfReputationThrottle } from "./reputation-throttle.js";
import type { OwnSubmissionRecord, SelfPlagiarismCandidate, SelfPlagiarismConfig, SelfPlagiarismVerdict } from "./self-plagiarism.js";
import { DEFAULT_SELF_PLAGIARISM_CONFIG, selfPlagiarismCheck } from "./self-plagiarism.js";
import type { WriteRateLimitBackoffStore, WriteRateLimitBucketStore, WriteRateLimitPolicies, WriteRateLimitVerdict } from "./write-rate-limit.js";
import { DEFAULT_WRITE_RATE_LIMIT_POLICIES, evaluateWriteRateLimit } from "./write-rate-limit.js";

/** Which stage of the precedence ladder produced the final verdict. */
export type GovernorDecisionStage =
  | "kill_switch"
  | "dry_run"
  | "rate_limit"
  | "budget_cap"
  | "non_convergence"
  | "reputation_throttle"
  | "self_plagiarism"
  | "allow"
  | "internal_error";

/** Action classes that carry a per-submission diff fingerprint / outcome-cadence concept. Reputation-throttle
 *  and self-plagiarism are evaluated only for these -- a label-apply or branch-delete has neither. */
const SELF_SUBMISSION_ACTION_CLASSES: ReadonlySet<string> = new Set(["open_pr"]);

export type GovernorChokepointInput = {
  actionClass: string;
  repoFullName: string;
  nowMs: number;
  /** Full would-be action spec, logged verbatim on a dry-run shadow (#2342) or a final denial's audit payload. */
  wouldBeAction: Record<string, unknown>;

  // Kill-switch (#2341) + action-mode (#2342).
  killSwitchGlobal: boolean;
  killSwitchRepoPaused?: boolean | null | undefined;
  liveModeGlobalOptIn: boolean;
  liveModeRepoOptIn?: unknown;

  // Rate limit (#2344).
  rateLimitBuckets: WriteRateLimitBucketStore;
  rateLimitBackoffAttempts: WriteRateLimitBackoffStore;
  rateLimitPolicies?: WriteRateLimitPolicies | undefined;
  rateLimitRandomFn?: (() => number) | undefined;

  // Budget/turn/termination caps.
  capUsage: GovernorCapUsage;
  capLimits: GovernorCapLimits;

  // Non-convergence.
  convergenceInput: PortfolioConvergenceInput;
  convergenceThresholds?: PortfolioConvergenceThresholds | undefined;

  // Self-reputation throttle + self-plagiarism -- both OPTIONAL: omitted (or actionClass !== "open_pr") skips
  // the stage entirely rather than fabricating a verdict.
  reputationHistory?: RepoOutcomeHistory | undefined;
  reputationThresholds?: SelfReputationThresholds | undefined;
  selfPlagiarismCandidate?: SelfPlagiarismCandidate | undefined;
  selfPlagiarismRecentSubmissions?: readonly OwnSubmissionRecord[] | undefined;
  selfPlagiarismConfig?: SelfPlagiarismConfig | undefined;
};

export type GovernorDecisionDetail = {
  killSwitchScope: MinerKillSwitchScope;
  mode: MinerActionMode;
  rateLimit?: WriteRateLimitVerdict;
  budgetCap?: GovernorCapReport;
  convergence?: PortfolioConvergenceVerdict;
  reputation?: SelfReputationThrottleDecision;
  selfPlagiarism?: SelfPlagiarismVerdict;
  /** #9062: the rate-limit policies actually used to reach `rateLimit` -- identical to the caller-supplied
   *  `rateLimitPolicies` (or the engine default) UNLESS a non-floored reputation throttle scaled the
   *  per-repo window. Present once the rate-limit stage has run (mirrors `rateLimit`'s own presence). The
   *  stateful miner-lib wrapper (`governor-chokepoint.js`) reads this back to advance the SAME bucket
   *  arithmetic post-decision that produced this verdict -- reusing the caller's raw, un-scaled policy there
   *  instead would silently disagree with the decision it is recording state for. */
  effectiveRateLimitPolicies?: WriteRateLimitPolicies;
};

export type GovernorDecision = {
  /** True only when every consulted stage allowed AND the resolved mode is `"live"`. */
  allowed: boolean;
  mode: MinerActionMode;
  stage: GovernorDecisionStage;
  reason: string;
  detail: GovernorDecisionDetail;
  /** The single row to append to the governor ledger for this chokepoint invocation. */
  ledgerEvent: GovernorLedgerEvent;
};

/** #9062: stretch the PER-REPO rate-limit window for `actionClass` by `1 / cadenceFactor` so a throttled
 *  miner's write cadence on THIS repo degrades proportionally instead of being denied outright --
 *  reputation-throttle.ts's own doc comment promises "a recovering ratio restores it -- never a hard
 *  permanent ban", so consuming `cadenceFactor` here (rather than discarding it, as before) is what actually
 *  delivers that contract for the common (non-floored) `"throttled"` case. Only the per-repo scope is
 *  scaled: `RepoOutcomeHistory` is scoped to ONE repo, so a bad ratio there must not also slow the miner's
 *  unrelated global write velocity across every other repo it works on. Never called with
 *  `cadenceFactor >= 1` (the caller only invokes this once it has already checked that). */
function scaleRateLimitPerRepoWindow(policies: WriteRateLimitPolicies, actionClass: string, cadenceFactor: number): WriteRateLimitPolicies {
  const perRepoConfig = policies.perRepo[actionClass];
  if (!perRepoConfig) return policies;
  // Defensive floor: cadenceFactor is documented as "never 0" by resolveSelfReputationThresholds's clamped
  // minCadenceFactor, but that field has no enforced lower bound of its own -- guard the division regardless
  // of what a caller-supplied threshold override might set it to.
  const safeFactor = cadenceFactor > 0 ? cadenceFactor : 0.001;
  return {
    ...policies,
    perRepo: {
      ...policies.perRepo,
      [actionClass]: { ...perRepoConfig, windowMs: Math.round(perRepoConfig.windowMs / safeFactor) },
    },
  };
}

function denyResult(input: {
  stage: GovernorDecisionStage;
  reason: string;
  mode: MinerActionMode;
  detail: GovernorDecisionDetail;
  eventType: GovernorLedgerEventType;
  actionClass: string;
  repoFullName: string;
  extraPayload?: Record<string, unknown>;
}): GovernorDecision {
  return {
    allowed: false,
    mode: input.mode,
    stage: input.stage,
    reason: input.reason,
    detail: input.detail,
    ledgerEvent: {
      eventType: input.eventType,
      repoFullName: input.repoFullName,
      actionClass: input.actionClass,
      decision: input.eventType === "kill_switch" ? "paused" : input.eventType === "throttled" ? "throttle" : "deny",
      reason: input.reason,
      payload: { stage: input.stage, ...input.extraPayload },
    },
  };
}

/**
 * Evaluate every write action against the full precedence ladder and return one fail-closed verdict. See the
 * module doc comment for the exact stage order and which stages are conditional on `actionClass`.
 */
export function evaluateGovernorChokepoint(input: GovernorChokepointInput): GovernorDecision {
  const killSwitchScope = resolveMinerKillSwitch({ global: input.killSwitchGlobal, repoPaused: input.killSwitchRepoPaused });
  const mode = resolveMinerActionMode({
    killSwitchScope,
    repoLiveModeOptIn: input.liveModeRepoOptIn,
    globalLiveModeOptIn: input.liveModeGlobalOptIn,
  });
  const baseDetail: GovernorDecisionDetail = { killSwitchScope, mode };

  if (isMinerKillSwitchActive(killSwitchScope)) {
    return denyResult({
      stage: "kill_switch",
      reason: `${killSwitchScope}_kill_switch_active`,
      mode,
      detail: baseDetail,
      eventType: "kill_switch",
      actionClass: input.actionClass,
      repoFullName: input.repoFullName,
    });
  }

  if (!minerActionModeExecutes(mode)) {
    // dry_run: shadow-log the would-be action without evaluating (or executing) anything further. The other
    // stages are intentionally NOT consulted here -- the ladder's own documented order places dry-run before
    // rate-limit, and a caller wanting a full "what-would-the-full-verdict-be" preview can call this function
    // again with a synthetic live opt-in in a non-production dry-run harness.
    return {
      allowed: false,
      mode,
      stage: "dry_run",
      reason: "dry_run_mode_active",
      detail: baseDetail,
      ledgerEvent: {
        eventType: "allowed",
        repoFullName: input.repoFullName,
        actionClass: input.actionClass,
        decision: "dry_run",
        reason: "dry_run_mode_active",
        payload: { wouldBeAction: input.wouldBeAction },
      },
    };
  }

  const isSelfSubmissionAction = SELF_SUBMISSION_ACTION_CLASSES.has(input.actionClass);

  // #9062: computed here -- BEFORE rate-limit -- rather than after budget/convergence (where its own HARD
  // DENY for `reason === "floored"` still stays, preserving the ladder's documented precedence for that
  // path) so a non-floored `cadenceFactor` can scale the per-repo rate-limit window below. Discarding
  // cadenceFactor and hard-denying on ANY throttled verdict (the pre-#9062 behavior) is exactly what turned a
  // recoverable soft throttle into a permanent self-ban: submissions are the miner's only source of new
  // decided outcomes, so a miner that can never submit can never dilute a bad ratio back down.
  let reputation: SelfReputationThrottleDecision | undefined;
  if (isSelfSubmissionAction && input.reputationHistory !== undefined) {
    try {
      reputation = selfReputationThrottle(input.reputationHistory, input.reputationThresholds ?? DEFAULT_SELF_REPUTATION_THRESHOLDS);
    } catch (error) {
      return denyResult({
        stage: "internal_error",
        reason: `reputation_throttle_calculator_error: ${error instanceof Error ? error.message : String(error)}`,
        mode,
        detail: baseDetail,
        eventType: "denied",
        actionClass: input.actionClass,
        repoFullName: input.repoFullName,
      });
    }
  }
  const rateLimitPolicies =
    reputation && reputation.cadenceFactor < 1
      ? scaleRateLimitPerRepoWindow(input.rateLimitPolicies ?? DEFAULT_WRITE_RATE_LIMIT_POLICIES, input.actionClass, reputation.cadenceFactor)
      : input.rateLimitPolicies;

  let rateLimit: WriteRateLimitVerdict;
  try {
    rateLimit = evaluateWriteRateLimit({
      actionClass: input.actionClass,
      repoFullName: input.repoFullName,
      buckets: input.rateLimitBuckets,
      backoffAttempts: input.rateLimitBackoffAttempts,
      nowMs: input.nowMs,
      ...(rateLimitPolicies ? { policies: rateLimitPolicies } : {}),
      ...(input.rateLimitRandomFn ? { randomFn: input.rateLimitRandomFn } : {}),
    });
  } catch (error) {
    return denyResult({
      stage: "internal_error",
      reason: `rate_limit_calculator_error: ${error instanceof Error ? error.message : String(error)}`,
      mode,
      detail: baseDetail,
      eventType: "denied",
      actionClass: input.actionClass,
      repoFullName: input.repoFullName,
    });
  }
  const detailWithRateLimit: GovernorDecisionDetail = {
    ...baseDetail,
    rateLimit,
    effectiveRateLimitPolicies: rateLimitPolicies ?? DEFAULT_WRITE_RATE_LIMIT_POLICIES,
  };
  if (!rateLimit.allowed) {
    return denyResult({
      stage: "rate_limit",
      reason: rateLimit.reason,
      mode,
      detail: detailWithRateLimit,
      eventType: "throttled",
      actionClass: input.actionClass,
      repoFullName: input.repoFullName,
      extraPayload: {
        retryAfterMs: rateLimit.retryAfterMs,
        blockedBy: rateLimit.blockedBy,
        // Surfaced only when the reputation throttle actually degraded this window, so an operator reading
        // the ledger can tell "genuinely busy" apart from "a reputation-scaled cadence caught up with it".
        ...(reputation && reputation.cadenceFactor < 1 ? { reputationCadenceFactor: reputation.cadenceFactor } : {}),
      },
    });
  }

  let budgetCap: GovernorCapReport;
  try {
    budgetCap = evaluateGovernorCaps(input.capUsage, input.capLimits);
  } catch (error) {
    return denyResult({
      stage: "internal_error",
      reason: `budget_cap_calculator_error: ${error instanceof Error ? error.message : String(error)}`,
      mode,
      detail: detailWithRateLimit,
      eventType: "denied",
      actionClass: input.actionClass,
      repoFullName: input.repoFullName,
    });
  }
  const detailWithBudget: GovernorDecisionDetail = { ...detailWithRateLimit, budgetCap };
  if (budgetCap.verdict !== "allowed") {
    return denyResult({
      stage: "budget_cap",
      reason: `budget_cap_${budgetCap.verdict}`,
      mode,
      detail: detailWithBudget,
      eventType: budgetCap.verdict,
      actionClass: input.actionClass,
      repoFullName: input.repoFullName,
      extraPayload: { budget: budgetCap.budget, turns: budgetCap.turns, termination: budgetCap.termination },
    });
  }

  let convergence: PortfolioConvergenceVerdict;
  try {
    convergence = classifyPortfolioConvergence(input.convergenceInput, input.convergenceThresholds ?? DEFAULT_PORTFOLIO_CONVERGENCE_THRESHOLDS);
  } catch (error) {
    return denyResult({
      stage: "internal_error",
      reason: `non_convergence_calculator_error: ${error instanceof Error ? error.message : String(error)}`,
      mode,
      detail: detailWithBudget,
      eventType: "denied",
      actionClass: input.actionClass,
      repoFullName: input.repoFullName,
    });
  }
  const detailWithConvergence: GovernorDecisionDetail = { ...detailWithBudget, convergence };
  if (convergence.status === "non_convergent") {
    return denyResult({
      stage: "non_convergence",
      reason: convergence.reasons.join(" "),
      mode,
      detail: detailWithConvergence,
      eventType: "denied",
      actionClass: input.actionClass,
      repoFullName: input.repoFullName,
    });
  }

  // #9062: `reputation` was already computed above (before rate-limit, so its cadenceFactor could scale that
  // stage's per-repo window). Its own hard-deny stays at its documented ladder position -- AFTER budget/
  // convergence -- but is now reserved for `reason === "floored"` only: the extreme, near-certain-abuse case.
  // A plain `"throttled"` verdict already had its cadence effect folded into the rate-limit evaluation above,
  // so it no longer denies here at all -- it either already got caught by the tightened rate limit, or it
  // didn't need to be, and either way the miner keeps submitting (at a degraded cadence) instead of being
  // structurally unable to ever generate the new clean outcomes that would dilute its ratio back down.
  let detailWithReputation = detailWithConvergence;
  if (reputation) {
    detailWithReputation = { ...detailWithConvergence, reputation };
    if (reputation.reason === "floored") {
      return denyResult({
        stage: "reputation_throttle",
        reason: reputation.reason,
        mode,
        detail: detailWithReputation,
        eventType: "throttled",
        actionClass: input.actionClass,
        repoFullName: input.repoFullName,
        extraPayload: { cadenceFactor: reputation.cadenceFactor, unfavorableRatio: reputation.unfavorableRatio },
      });
    }
  }

  let finalDetail = detailWithReputation;
  // Same `!== undefined` reasoning as the reputation-throttle stage above.
  if (isSelfSubmissionAction && input.selfPlagiarismCandidate !== undefined) {
    let selfPlagiarism: SelfPlagiarismVerdict;
    try {
      selfPlagiarism = selfPlagiarismCheck(
        input.selfPlagiarismCandidate,
        input.selfPlagiarismRecentSubmissions ?? [],
        input.selfPlagiarismConfig ?? DEFAULT_SELF_PLAGIARISM_CONFIG,
      );
    } catch (error) {
      return denyResult({
        stage: "internal_error",
        reason: `self_plagiarism_calculator_error: ${error instanceof Error ? error.message : String(error)}`,
        mode,
        detail: detailWithReputation,
        eventType: "denied",
        actionClass: input.actionClass,
        repoFullName: input.repoFullName,
      });
    }
    finalDetail = { ...detailWithReputation, selfPlagiarism };
    if (!selfPlagiarism.allowed) {
      return denyResult({
        stage: "self_plagiarism",
        reason: selfPlagiarism.reason,
        mode,
        detail: finalDetail,
        eventType: selfPlagiarism.eventType,
        actionClass: input.actionClass,
        repoFullName: input.repoFullName,
        extraPayload: { similarity: selfPlagiarism.similarity ?? null },
      });
    }
  }

  return {
    allowed: true,
    mode,
    stage: "allow",
    reason: "all_governor_checks_passed",
    detail: finalDetail,
    ledgerEvent: {
      eventType: "allowed",
      repoFullName: input.repoFullName,
      actionClass: input.actionClass,
      decision: "allow",
      reason: "all_governor_checks_passed",
      payload: {},
    },
  };
}
