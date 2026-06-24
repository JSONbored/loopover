import type { AgentActionClass, AutoMaintainPolicy, AutoMergeMethod, AutonomyPolicy } from "../types";
import type { GateCheckConclusion } from "../rules/advisory";
import { DEFAULT_AUTO_MAINTAIN_POLICY, autonomyRequiresApproval, isActingAutonomyLevel, resolveAutonomy } from "./autonomy";
import { changedPathsHittingGuardrail } from "../signals/change-guardrail";
import { AGENT_LABEL_PENDING_CLOSURE } from "../review/linked-issue-hard-rules";

// High-slop threshold default when a repo hasn't set slopGateMinScore (mirrors the gate's `high` band).
const DEFAULT_SLOP_GATE_MIN_SCORE = 60;

// The maintainer auto-maintain decision layer (#778): given the gate verdict + the PR's current state + the
// repo's autonomy config, decide which GitHub state actions to take. PURE and deterministic — the executor
// owns the gate stack (mode / permission / auth) and the actual GitHub mutation. Conservative by design:
// every action is independently gated by its own autonomy class, and the irreversible ones (merge / close)
// demand strong positive signals.

// The bucket labels the layer applies to reflect the gate verdict. Namespaced so a maintainer can filter on
// them and they never collide with project labels.
export const AGENT_LABEL_READY = "gittensory:ready-to-merge";
export const AGENT_LABEL_CHANGES = "gittensory:changes-requested";
// A PR that PASSES the gate but touches a hard-guardrail path is NOT ready to auto-merge — it is withheld
// for a human (the merge/approve/close dispositions are suppressed below). Labeling it `ready-to-merge`
// would be misleading (the label promises an auto-merge that never happens), so a guarded passing PR gets
// this distinct "needs a human" label instead. Blocking verdicts keep AGENT_LABEL_CHANGES.
export const AGENT_LABEL_NEEDS_REVIEW = "gittensory:needs-human-review";

// Maintainer-managed automation accounts whose PRs are never auto-closed. A recurring accumulator (e.g.
// github-actions[bot] opening automation/readme-refresh) or a dependency PR must not be killed by a duplicate
// or slop heuristic — the maintainer owns its lifecycle. (reviewbot wrongly auto-closed such an accumulator,
// awesome-claude #4192.) Still eligible for auto-merge when clean + passing.
const PROTECTED_AUTOCLOSE_AUTHORS = new Set(["github-actions[bot]", "dependabot[bot]", "renovate[bot]"]);
export function isProtectedAutomationAuthor(login: string | null | undefined): boolean {
  return login != null && PROTECTED_AUTOCLOSE_AUTHORS.has(login.toLowerCase());
}

export type PlannedAgentAction = {
  actionClass: AgentActionClass;
  // auto_with_approval → the action is staged for a human approval (the #779 queue) instead of executing now.
  requiresApproval: boolean;
  reason: string;
  // Action-specific payload (only the field for this actionClass is set):
  label?: string;
  // For a `label` action: whether to ADD (default) or REMOVE the label. The flag-then-close double-check adds
  // the pending-closure label on Pass 1 and removes it when the violation resolves; all other label actions add.
  labelOp?: "add" | "remove";
  // For a `label` action: an OPTIONAL issue comment posted alongside the label mutation (the flag-then-close
  // warning on Pass 1, or the "resolved" note on flag-clear). Kept on the `label` action so the flag uses the
  // already-held Issues-API `label` autonomy class (no new action class / no write-permission gate).
  comment?: string;
  reviewBody?: string;
  mergeMethod?: AutoMergeMethod;
  closeComment?: string;
  expectedHeadSha?: string;
};

export type AgentActionPlanInput = {
  conclusion: GateCheckConclusion;
  blockerTitles: string[];
  autonomy: AutonomyPolicy | null | undefined;
  // Optional so the trigger can pass raw repo settings; both fall back to conservative defaults here.
  autoMaintain?: AutoMaintainPolicy | undefined;
  slopGateMinScore?: number | null | undefined;
  // Convergence safety (hard-guardrail port, #4196 incident class): the PR's changed paths + the repo's
  // hard-guardrail globs. Any changed path matching a guardrail glob forces MANUAL review — gittensory will
  // neither auto-merge, auto-approve, nor auto-close such a PR; it falls through to a human.
  changedPaths: string[];
  hardGuardrailGlobs: string[];
  // True when the PR author is the repo owner (e.g. JSONbored). Standing rule: owner PRs are NEVER
  // auto-closed. They may still auto-merge when clean + passing.
  authorIsOwner: boolean;
  // True when the PR author is a maintainer-managed automation account (e.g. github-actions[bot] opening an
  // accumulator like automation/readme-refresh, or dependabot/renovate). These are NEVER auto-closed — a noise
  // heuristic (duplicate/slop) must not kill a recurring maintainer-managed PR. They may still auto-merge.
  authorIsAutomationBot: boolean;
  // Live CI aggregate over ALL of the PR's checks — required OR not, including non-required ones like
  // codecov/patch and every commit-status (reviewbot parity). "passed" = every check completed and none
  // failed; "failed" = at least one check failed; "pending" = at least one check still running; "unverified"
  // = no checks reported (or CI can't be verified, e.g. a fork PR whose workflows await approval). The
  // disposition layer NEVER approves/merges unless "passed", CLOSES a non-owner PR on "failed" (citing the
  // failing checks) / HOLDS the owner's, and DEFERS every action while "pending" (settle-before-decide — the
  // check-completion webhook re-runs this planner once CI settles).
  ciState: "passed" | "failed" | "pending" | "unverified";
  // The names of the failing checks, surfaced in the close/request-changes reason so the contributor knows
  // WHY (e.g. "codecov/patch"). Empty unless ciState === "failed".
  failingCheckNames?: string[] | undefined;
  // Linked-issue HARD-RULE result (#linked-issue-hard-rules). A DETERMINISTIC verdict about the issue(s) this PR
  // links (owner-assigned / missing point-label / maintainer-only), pre-computed by the trigger. When
  // `violated`, a CONTRIBUTOR PR is one-shot CLOSED citing `reason` — and because it is deterministic (no
  // hallucination risk), that close fires REGARDLESS of a hard-guardrail path hit (the guard exists only for
  // AI verdicts). It still NEVER fires for the owner or automation bots (the `isContributor` guard). Absent /
  // not-violated ⇒ no effect.
  linkedIssueHardRule?: { violated: boolean; reason: string | null } | undefined;
  // Flag-then-close double-check for the linked-issue hard rule (#linked-issue-verify-before-close). When
  // `verifyBeforeClose` is true (the default), a violation FLAGS the PR (pending-closure label + warning comment)
  // on first detection and only CLOSES on a LATER evaluation when the violation STILL holds AND the PR already
  // carries the pending-closure label (a label-based two-pass state machine). When false, the close fires
  // immediately (the original GAP-5 behavior). Absent ⇒ immediate close (back-compat for callers that don't
  // pass it). `closeDelaySeconds` is surfaced in the flag comment so the contributor knows the verification
  // window. The presence of the label is read from `input.pr.labels`.
  linkedIssueVerify?: { verifyBeforeClose: boolean; closeDelaySeconds: number } | undefined;
  pr: {
    mergeableState?: string | null | undefined;
    reviewDecision?: string | null | undefined;
    slopRisk?: number | null | undefined;
    labels: string[];
    linkedDuplicateCount?: number | undefined;
    // RC3 terminal-fail merges: the live head SHA + the SHA at which a prior merge was terminally blocked
    // (perms/required-check/conflict). When they match, the merge can't complete for this commit → suppress it.
    headSha?: string | null | undefined;
    mergeBlockedSha?: string | null | undefined;
    // Re-approval idempotency: the head SHA the bot last auto-approved. When it equals the live headSha this
    // exact commit is already bot-approved → suppress the `approve` disposition (a GitHub App's own approval
    // does NOT reliably flip reviewDecision to APPROVED, so without this the bot re-approves every sweep). A new
    // commit makes the live head differ → the bot may approve the new code (correct).
    approvedHeadSha?: string | null | undefined;
  };
};

function hasLabel(labels: string[], name: string): boolean {
  return labels.some((label) => label.toLowerCase() === name.toLowerCase());
}

/**
 * Accuracy circuit-breaker (#self-improve / GAP-4): when auto-merge is DISABLED for a repo (the auto-tuner
 * engaged the holdonly flag after merge precision dropped, or a human set it), DOWNGRADE a would-MERGE into a
 * human HOLD — drop the `merge` action and surface the needs-human-review label so the PR is held for a person
 * instead of auto-merged. Mirrors reviewbot non-content-gate.ts (~212: a would-merge becomes a hold under the
 * breaker; close/label/approve are untouched).
 *
 * PURE + idempotent: with `holdOnly` false this returns the plan UNCHANGED (byte-identical, the common path);
 * with it true and no merge planned it is also a no-op. Only ever makes the system MORE cautious.
 */
export function downgradeMergeToHold(planned: PlannedAgentAction[], holdOnly: boolean): PlannedAgentAction[] {
  if (!holdOnly || !planned.some((action) => action.actionClass === "merge")) return planned;
  const next = planned.filter((action) => action.actionClass !== "merge");
  // The dropped merge implies the PR is review-good — re-label it needs-human-review (replacing a stale
  // ready-to-merge promise) so the held PR is clearly flagged for a person. Idempotent: only add when absent.
  const alreadyNeedsReview = next.some((action) => action.actionClass === "label" && action.label === AGENT_LABEL_NEEDS_REVIEW && action.labelOp !== "remove");
  const stagedMerge = planned.find((action) => action.actionClass === "merge");
  if (!alreadyNeedsReview) {
    next.push({
      actionClass: "label",
      requiresApproval: stagedMerge?.requiresApproval ?? false,
      reason: "accuracy circuit-breaker engaged (merge precision dropped) — would-merge held for human review",
      label: AGENT_LABEL_NEEDS_REVIEW,
      labelOp: "add",
    });
  }
  // Drop any ready-to-merge label add (the auto-merge it promised is now suppressed).
  return next.filter((action) => !(action.actionClass === "label" && action.label === AGENT_LABEL_READY && action.labelOp !== "remove"));
}

function closeMessage(reasons: string[]): string {
  return `Gittensory is closing this pull request on the maintainer's behalf (${reasons.join("; ")}). This is an automated maintenance action — if you believe it's mistaken, reopen the PR or ping a maintainer and it will be reviewed.`;
}

/**
 * Plan the maintainer auto-maintain actions for one PR. Returns a COHERENT set (never both approve and
 * request-changes; never both merge and close), each entry already filtered to an acting autonomy class.
 * Ordered least → most irreversible: label, then the review, then the disposition.
 */
export function planAgentMaintenanceActions(input: AgentActionPlanInput): PlannedAgentAction[] {
  const actions: PlannedAgentAction[] = [];
  const autoMaintain = input.autoMaintain ?? DEFAULT_AUTO_MAINTAIN_POLICY;
  const slopGateMinScore = input.slopGateMinScore ?? DEFAULT_SLOP_GATE_MIN_SCORE;
  // Branch-protection-aware: required approvals are satisfied when the repo asks for none, or GitHub already
  // resolved the PR's reviews to APPROVED.
  const failingCheckNames = input.failingCheckNames ?? [];
  const approvalsSatisfied = autoMaintain.requireApprovals === 0 || input.pr.reviewDecision === "APPROVED";
  const level = (actionClass: AgentActionClass) => resolveAutonomy(input.autonomy, actionClass);
  const acting = (actionClass: AgentActionClass) => isActingAutonomyLevel(level(actionClass));
  const approval = (actionClass: AgentActionClass) => autonomyRequiresApproval(level(actionClass));

  // Only a SKIPPED gate (genuinely not evaluated) drives no action. A NEUTRAL gate (advisory-only blockers on a
  // non-confirmed contributor, or eval-not-ready) is gate-NON-BLOCKING: it flows to the disposition so the PR is
  // merged (clean+green) or HELD with a label — never left silently undecided. (#harm-stop neutral-silent-stuck)
  if (input.conclusion === "skipped") return actions;

  // CI state over ALL of the PR's checks (required OR not — codecov/patch included) — reviewbot's ci_red
  // parity. A red CI is NEVER approved/merged and is itself a close-worthy signal (non-owner); while CI is
  // still running we take NO action and wait for the check-completion webhook to re-run this planner.
  const ciPassed = input.ciState === "passed";
  const ciFailed = input.ciState === "failed";
  // Settle-before-decide: never approve / merge / close on a half-finished CI run.
  if (input.ciState === "pending") return actions;

  // Only SUCCESS earns the review-good auto-merge. A NEUTRAL gate flows (no longer silently returns []) but is
  // NOT auto-merged — it falls through to a HELD + labeled state for review. (Auto-merging neutral / non-confirmed
  // contributor PRs is a separate trust/policy decision, deliberately NOT bundled into the harm-stop.) (#harm-stop)
  const gatePassing = input.conclusion === "success";
  // A changed path matching a hard guardrail forces manual review (suppresses auto-MERGE / auto-approve / auto-close).
  // Fail SAFE on UNKNOWN paths (#1062): when guardrails are configured but the changed-file set is empty (cache
  // not yet / no longer populated), we cannot prove the PR doesn't touch a guarded path, so treat it as a hit —
  // never auto-merge, auto-approve, or auto-close a PR whose diff we don't know. Repos with no guardrails
  // configured stay permissive.
  const guardrailHit =
    input.hardGuardrailGlobs.length > 0 &&
    (input.changedPaths.length === 0 || changedPathsHittingGuardrail(input.changedPaths, input.hardGuardrailGlobs).length > 0);
  // Canonical (reviewbot non-content-gate) policy, tuned to the operator's minimize-manual goal: merge-or-close
  // with high accuracy; manual review is the RARE exception. A PR is "review-good" when the gate passes AND CI is
  // green — that's the only thing that earns an auto-merge or an approve. Everything else, for a CONTRIBUTOR, is a
  // one-shot CLOSE (taopedia model: resolve + open a fresh PR). The guardrail is handled SEPARATELY: it converts
  // every would-approve/would-merge/would-close disposition into a manual hold (owner safety review).
  const ciUnverified = input.ciState === "unverified";
  const reviewGood = gatePassing && ciPassed;
  const isContributor = !input.authorIsOwner && !input.authorIsAutomationBot;
  const mergeableClean = input.pr.mergeableState === "clean";
  const isConflict = input.pr.mergeableState === "dirty"; // conflicts with base — can't merge as-is
  // RC3: a prior merge attempt failed terminally for THIS exact head SHA (403/405/409/conflict) → never re-plan
  // the merge; it can't complete for this commit. A new commit makes the live head differ from mergeBlockedSha.
  const mergeTerminallyBlocked = input.pr.mergeBlockedSha != null && input.pr.headSha != null && input.pr.mergeBlockedSha === input.pr.headSha;
  // Re-approval idempotency: this exact commit is already bot-approved when the stored approved-head SHA equals
  // the live head SHA → never re-post an approval for it (a GitHub App's own approval does not reliably flip
  // reviewDecision to APPROVED, so reviewDecision alone can't dedup). A new commit makes the heads differ →
  // approve may fire again. Absent approved-head SHA (never approved by the bot) ⇒ not idempotent-skipped.
  const alreadyApprovedThisHead = input.pr.approvedHeadSha != null && input.pr.headSha != null && input.pr.approvedHeadSha === input.pr.headSha;
  const canMerge = reviewGood && !guardrailHit && acting("merge") && mergeableClean && approvalsSatisfied && !mergeTerminallyBlocked;
  // A guarded/CRUCIAL path (CI, the review engine, visual) → ALWAYS held for the owner, never auto-actioned —
  // not auto-approved, not auto-merged, AND not auto-closed. Operator decision (#hold-crucial-on-reject): a
  // hallucinated reject on a crucial PR must NOT auto-close a good change (the #1528 near-miss); the owner
  // verifies and closes/merges. The BULK (non-guarded) contributor PRs still auto-close one-shot on a bad
  // verdict / conflict — only the small crucial set is held. Owner/automation PRs are never closed regardless.
  // CLOSE a contributor PR ONLY on a REAL adverse signal — a confirmed gate FAILURE, a red required CI, or a base
  // CONFLICT. NEVER close merely because CI is UNVERIFIED (a fork whose Actions await approval, or unreadable
  // checks) or otherwise not-yet-mergeable — those are HELD for review, not killed (#harm-stop fork-false-close).
  // Owner/automation PRs are never closed (isContributor); guarded paths are held (guardrailHit).
  const willClose = !guardrailHit && isContributor && acting("close") && (input.conclusion === "failure" || ciFailed || isConflict);
  // Linked-issue HARD-RULE close (#linked-issue-hard-rules). A DETERMINISTIC verdict about the LINKED ISSUE
  // (owner-assigned / missing point-label / maintainer-only) — NOT an AI verdict, so there is no hallucination
  // to guard against: this close fires REGARDLESS of `guardrailHit`. It still only ever closes a CONTRIBUTOR
  // PR (the `isContributor` guard owns the owner/automation exemption) and respects the `close` autonomy class.
  // It takes PRECEDENCE over merge/approve below: a PR linking an ineligible issue must never auto-merge.
  const linkedIssueHardRule = input.linkedIssueHardRule;
  // Base condition: a CONTRIBUTOR PR links an issue tripping a deterministic hard rule AND the `close` autonomy
  // class is acting. (The owner/automation exemption lives in `isContributor`.)
  const linkedIssueViolated = linkedIssueHardRule?.violated === true && isContributor && acting("close");
  // Flag-then-close double-check (#linked-issue-verify-before-close). Default behavior when the caller doesn't
  // pass the config is IMMEDIATE close (back-compat). When verifyBeforeClose is on, the close is a TWO-PASS
  // label-state machine: Pass 1 flags (adds the pending-closure label + a warning comment) and Pass 2 — the next
  // evaluation, with the violation still present AND the label already on the PR — closes.
  const verifyBeforeClose = input.linkedIssueVerify?.verifyBeforeClose === true;
  const closeDelaySeconds = input.linkedIssueVerify?.closeDelaySeconds ?? 0;
  const pendingClosureLabelPresent = hasLabel(input.pr.labels, AGENT_LABEL_PENDING_CLOSURE);
  // Pass 1 is only safe when the pending-closure state can be written immediately. If labels are disabled or
  // approval-gated, holding would fail open because Pass 2 is keyed on a label that cannot appear yet; fall back
  // to the original immediate close in that case.
  const canApplyPendingClosureFlagNow = acting("label") && !approval("label");
  // Pass 1 — violation present, verify-mode on, label NOT yet on the PR, and the state label can be applied now
  // → FLAG (label + comment), do NOT close.
  const flagForLinkedIssue = linkedIssueViolated && verifyBeforeClose && !pendingClosureLabelPresent && canApplyPendingClosureFlagNow;
  // Close NOW when: verify-mode OFF (immediate, original GAP-5), OR Pass 2 (violation persists AND the
  // pending-closure label is already present from a prior pass), OR verification cannot safely persist its flag.
  const willCloseForLinkedIssue = linkedIssueViolated && (!verifyBeforeClose || pendingClosureLabelPresent || !canApplyPendingClosureFlagNow);
  // The violation has CLEARED (no longer violated) but the PR still carries a pending-closure flag from a prior
  // pass → remove the stale flag (never close). Independent of `isContributor`/`close` autonomy: clearing a stale
  // label is always safe and must happen even if the rule/author no longer qualifies for a close.
  const clearLinkedIssueFlag = linkedIssueHardRule?.violated !== true && pendingClosureLabelPresent;
  // True whenever a pending linked-issue close is in flight (flag OR close) — drives the changes-requested label
  // and suppresses approve/merge below (a PR about to be closed for an ineligible issue must never auto-merge).
  const linkedIssueCloseInFlight = flagForLinkedIssue || willCloseForLinkedIssue;
  const ciReason = ciFailed
    ? `CI is failing${failingCheckNames.length ? ` (${failingCheckNames.join(", ")})` : ""}`
    : ciUnverified
      ? "CI could not be verified"
      : "";

  // 1) label — ready-to-merge (review-good, unguarded) / needs-human-review (review-good but guarded) /
  // changes-requested (not review-good → will be closed for a contributor, held for the owner). A pending
  // linked-issue hard-rule close (flag OR close pass) forces the changes-requested label regardless of the gate
  // verdict (the PR is about to be closed for an ineligible linked issue). Idempotent.
  if (acting("label")) {
    const label = linkedIssueCloseInFlight || !reviewGood ? AGENT_LABEL_CHANGES : guardrailHit ? AGENT_LABEL_NEEDS_REVIEW : AGENT_LABEL_READY;
    const reason = linkedIssueCloseInFlight
      ? `linked-issue hard rule: ${linkedIssueHardRule?.reason ?? "ineligible linked issue"}`
      : !reviewGood
        ? `verdict=${input.conclusion}${ciReason ? `; ${ciReason}` : ""}`
        : guardrailHit
          ? `verdict=${input.conclusion}; guarded path → owner safety review`
          : `verdict=${input.conclusion}; CI green`;
    if (!hasLabel(input.pr.labels, label)) {
      actions.push({ actionClass: "label", requiresApproval: approval("label"), reason, label });
    }
    // Flag-then-close double-check, Pass 1: add the pending-closure label + a warning comment citing the specific
    // rule and the verification window. The label's presence is the state that, persisting to the next pass with
    // the violation still present, triggers the close. Idempotent (the flag only fires when the label is absent).
    if (flagForLinkedIssue) {
      const ruleReason = linkedIssueHardRule?.reason ?? "the linked issue is not eligible for a community PR";
      const window = closeDelaySeconds > 0 ? `~${closeDelaySeconds}s` : "the next verification";
      actions.push({
        actionClass: "label",
        requiresApproval: approval("label"),
        reason: `linked-issue hard rule (flagged for verification): ${ruleReason}`,
        label: AGENT_LABEL_PENDING_CLOSURE,
        labelOp: "add",
        comment: `⚠️ This PR links an ineligible issue (${ruleReason}) and will be closed on re-verification in ${window} unless the linked issue changes.`,
      });
    }
    // Violation CLEARED but a stale pending-closure flag remains → remove it (+ a resolved note). Never closes.
    if (clearLinkedIssueFlag) {
      actions.push({
        actionClass: "label",
        requiresApproval: approval("label"),
        reason: "linked-issue hard rule resolved — clearing the pending-closure flag",
        label: AGENT_LABEL_PENDING_CLOSURE,
        labelOp: "remove",
        comment: "✓ The linked-issue hard-rule violation is resolved — this PR is no longer pending closure.",
      });
    }
  }

  // 2) review — APPROVE a review-good PR only when it is NOT on a guarded path; a guarded PR falls through to the
  // owner's manual safety review (never auto-approved). The bot NEVER posts a formal CHANGES_REQUESTED review: a
  // blocking review counts against required approvals and STRANDS a PR when it later goes green (a stale
  // request-changes keeps it un-mergeable forever). A not-good CONTRIBUTOR PR is CLOSED below; a not-good
  // OWNER/automation PR is HELD via the needs-human label + the (non-blocking) unified review comment — never a
  // formal request-changes. (#no-request-changes) Either merge/approve, or close, with the rare manual hold left
  // open + commented, never blocked.
  if (reviewGood && !guardrailHit && !linkedIssueCloseInFlight && acting("approve") && input.pr.reviewDecision !== "APPROVED" && !alreadyApprovedThisHead) {
    actions.push({
      actionClass: "approve",
      requiresApproval: approval("approve"),
      reason: "gate passed, CI green",
      reviewBody: "Gittensory approves — the gate is satisfied and CI is green.",
    });
  }

  // 3) disposition — FLAG-HOLD (linked-issue Pass 1: flagged this pass, verification pending → NO disposition) /
  // LINKED-ISSUE HARD-RULE CLOSE (deterministic, fires even on a guarded path; precedes merge) / MERGE
  // (review-good, unguarded, mergeable, approvals) / CLOSE (not-good OR conflicting CONTRIBUTOR PR, one-shot) /
  // MANUAL (guarded, or any not-good OWNER/automation PR — held, never closed). Mutually exclusive.
  if (flagForLinkedIssue) {
    // Pass 1 of the flag-then-close double-check: the PR was flagged in the label section above and is HELD this
    // pass — no merge, no close. The NEXT evaluation (violation still present + the label now on the PR) closes.
    // Falling through here also suppresses the general `willClose` path so a flagged red-CI PR isn't closed until
    // the verification pass confirms the linked-issue violation.
  } else if (willCloseForLinkedIssue) {
    // A contributor linked an issue that violates a deterministic hard rule (owner-assigned / missing
    // point-label / maintainer-only). Close one-shot, citing the SPECIFIC rule + issue so the contributor knows
    // exactly why. This is the FIRST disposition branch: it wins over an otherwise-mergeable verdict (a PR for
    // an ineligible issue must never auto-merge) and fires REGARDLESS of `guardrailHit` (deterministic, not AI).
    const reason = linkedIssueHardRule?.reason ?? "the linked issue is not eligible for a community PR";
    actions.push({ actionClass: "close", requiresApproval: approval("close"), reason, closeComment: closeMessage([reason]) });
  } else if (canMerge) {
    actions.push({
      actionClass: "merge",
      requiresApproval: approval("merge"),
      reason: `gate passed, CI green, mergeable, ${autoMaintain.requireApprovals} approval(s) satisfied`,
      mergeMethod: autoMaintain.mergeMethod,
    });
  } else if (willClose) {
    // Contributor PR that is NOT review-good (gate blockers / red / unverified CI) OR conflicts with base →
    // CLOSE one-shot when no hard guardrail requires manual review. Cite the concrete reasons.
    const closeReasons: string[] = [];
    if (ciFailed) closeReasons.push(ciReason);
    if (isConflict) closeReasons.push("conflicts with the base branch — resolve and open a fresh PR");
    for (const blockerTitle of input.blockerTitles) closeReasons.push(blockerTitle);
    if (input.pr.slopRisk != null && input.pr.slopRisk >= slopGateMinScore) closeReasons.push(`slop score ${input.pr.slopRisk} ≥ ${slopGateMinScore}`);
    if ((input.pr.linkedDuplicateCount ?? 0) > 0) closeReasons.push("duplicate of another open PR");
    if (closeReasons.length === 0) closeReasons.push("the review gate is not satisfied");
    actions.push({ actionClass: "close", requiresApproval: approval("close"), reason: closeReasons.join("; "), closeComment: closeMessage(closeReasons) });
  }
  // else: guarded → manual (needs-human/changes label above); not-good OWNER/automation → held
  // (request-changes above); review-good-but-not-yet-mergeable → held briefly (rebase/approve resolves it next pass).

  return actions;
}
