import type { AgentActionClass, AutoMaintainPolicy, AutoMergeMethod, AutonomyPolicy } from "../types";
import type { GateCheckConclusion } from "../rules/advisory";
import { DEFAULT_AUTO_MAINTAIN_POLICY, autonomyRequiresApproval, isActingAutonomyLevel, resolveAutonomy } from "./autonomy";
import { changedPathsHittingGuardrail } from "../signals/change-guardrail";

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
  };
};

function hasLabel(labels: string[], name: string): boolean {
  return labels.some((label) => label.toLowerCase() === name.toLowerCase());
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

  // App/infra-neutral verdicts (not evaluated yet) never drive an action.
  if (input.conclusion === "neutral" || input.conclusion === "skipped") return actions;

  // CI state over ALL of the PR's checks (required OR not — codecov/patch included) — reviewbot's ci_red
  // parity. A red CI is NEVER approved/merged and is itself a close-worthy signal (non-owner); while CI is
  // still running we take NO action and wait for the check-completion webhook to re-run this planner.
  const ciPassed = input.ciState === "passed";
  const ciFailed = input.ciState === "failed";
  // Settle-before-decide: never approve / merge / close on a half-finished CI run.
  if (input.ciState === "pending") return actions;

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
  const canMerge = reviewGood && !guardrailHit && acting("merge") && mergeableClean && approvalsSatisfied && !mergeTerminallyBlocked;
  // A guarded/CRUCIAL path (CI, the review engine, visual) → ALWAYS held for the owner, never auto-actioned —
  // not auto-approved, not auto-merged, AND not auto-closed. Operator decision (#hold-crucial-on-reject): a
  // hallucinated reject on a crucial PR must NOT auto-close a good change (the #1528 near-miss); the owner
  // verifies and closes/merges. The BULK (non-guarded) contributor PRs still auto-close one-shot on a bad
  // verdict / conflict — only the small crucial set is held. Owner/automation PRs are never closed regardless.
  const willClose = !guardrailHit && isContributor && acting("close") && (!reviewGood || isConflict);
  // Linked-issue HARD-RULE close (#linked-issue-hard-rules). A DETERMINISTIC verdict about the LINKED ISSUE
  // (owner-assigned / missing point-label / maintainer-only) — NOT an AI verdict, so there is no hallucination
  // to guard against: this close fires REGARDLESS of `guardrailHit`. It still only ever closes a CONTRIBUTOR
  // PR (the `isContributor` guard owns the owner/automation exemption) and respects the `close` autonomy class.
  // It takes PRECEDENCE over merge/approve below: a PR linking an ineligible issue must never auto-merge.
  const linkedIssueHardRule = input.linkedIssueHardRule;
  const willCloseForLinkedIssue = linkedIssueHardRule?.violated === true && isContributor && acting("close");
  const ciReason = ciFailed
    ? `CI is failing${failingCheckNames.length ? ` (${failingCheckNames.join(", ")})` : ""}`
    : ciUnverified
      ? "CI could not be verified"
      : "";

  // 1) label — ready-to-merge (review-good, unguarded) / needs-human-review (review-good but guarded) /
  // changes-requested (not review-good → will be closed for a contributor, held for the owner). A pending
  // linked-issue hard-rule close forces the changes-requested label regardless of the gate verdict (the PR is
  // about to be closed for an ineligible linked issue). Idempotent.
  if (acting("label")) {
    const label = willCloseForLinkedIssue || !reviewGood ? AGENT_LABEL_CHANGES : guardrailHit ? AGENT_LABEL_NEEDS_REVIEW : AGENT_LABEL_READY;
    const reason = willCloseForLinkedIssue
      ? `linked-issue hard rule: ${linkedIssueHardRule?.reason ?? "ineligible linked issue"}`
      : !reviewGood
        ? `verdict=${input.conclusion}${ciReason ? `; ${ciReason}` : ""}`
        : guardrailHit
          ? `verdict=${input.conclusion}; guarded path → owner safety review`
          : `verdict=${input.conclusion}; CI green`;
    if (!hasLabel(input.pr.labels, label)) {
      actions.push({ actionClass: "label", requiresApproval: approval("label"), reason, label });
    }
  }

  // 2) review — APPROVE a review-good PR only when it is NOT on a guarded path; a guarded PR falls through to the
  // owner's manual safety review (never auto-approved). The bot NEVER posts a formal CHANGES_REQUESTED review: a
  // blocking review counts against required approvals and STRANDS a PR when it later goes green (a stale
  // request-changes keeps it un-mergeable forever). A not-good CONTRIBUTOR PR is CLOSED below; a not-good
  // OWNER/automation PR is HELD via the needs-human label + the (non-blocking) unified review comment — never a
  // formal request-changes. (#no-request-changes) Either merge/approve, or close, with the rare manual hold left
  // open + commented, never blocked.
  if (reviewGood && !guardrailHit && !willCloseForLinkedIssue && acting("approve") && input.pr.reviewDecision !== "APPROVED") {
    actions.push({
      actionClass: "approve",
      requiresApproval: approval("approve"),
      reason: "gate passed, CI green",
      reviewBody: "Gittensory approves — the gate is satisfied and CI is green.",
    });
  }

  // 3) disposition — LINKED-ISSUE HARD-RULE CLOSE (deterministic, fires even on a guarded path; precedes
  // merge) / MERGE (review-good, unguarded, mergeable, approvals) / CLOSE (not-good OR conflicting CONTRIBUTOR
  // PR, one-shot) / MANUAL (guarded, or any not-good OWNER/automation PR — held, never closed). Mutually
  // exclusive.
  if (willCloseForLinkedIssue) {
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
    if (ciFailed || ciUnverified) closeReasons.push(ciReason);
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
