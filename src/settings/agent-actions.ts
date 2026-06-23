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
  pr: {
    mergeableState?: string | null | undefined;
    reviewDecision?: string | null | undefined;
    slopRisk?: number | null | undefined;
    labels: string[];
    linkedDuplicateCount?: number | undefined;
  };
};

const isBlocking = (conclusion: GateCheckConclusion): boolean => conclusion === "failure" || conclusion === "action_required";

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

  const blocking = isBlocking(input.conclusion);
  const gatePassing = input.conclusion === "success";
  // A changed path matching a hard guardrail forces manual review: suppress the irreversible dispositions
  // (merge / close) AND the auto-approve that could later satisfy a merge. label + request_changes still run.
  // Fail SAFE on UNKNOWN paths: when guardrails are configured but the changed-file set is empty (cache not
  // yet/no-longer populated), we cannot prove the PR doesn't touch a guarded path, so treat it as a hit —
  // never auto-merge/close a PR whose diff we don't know. Repos with no guardrails stay permissive.
  const guardrailHit =
    input.hardGuardrailGlobs.length > 0 &&
    (input.changedPaths.length === 0 || changedPathsHittingGuardrail(input.changedPaths, input.hardGuardrailGlobs).length > 0);
  // Auto-merge-ready ONLY when the gate passes AND CI is green AND no guarded path is touched. A red, pending,
  // or unverified CI is never approved/merged.
  const readyToMerge = gatePassing && ciPassed && !guardrailHit;
  const ciReason = ciFailed ? `CI is failing${failingCheckNames.length ? ` (${failingCheckNames.join(", ")})` : ""}` : "";

  // 1) label — a blocking gate OR a red CI → changes-requested. A gate-passing PR that is not yet
  // auto-mergeable (guarded path, or CI not green/unverified) → needs-human-review (labeling it
  // `ready-to-merge` would promise an auto-merge that never happens). Only a gate-passing, CI-green,
  // non-guarded PR gets `ready-to-merge`. Idempotent: skip if the PR already carries the chosen label.
  if (acting("label")) {
    const label = blocking || ciFailed ? AGENT_LABEL_CHANGES : readyToMerge ? AGENT_LABEL_READY : AGENT_LABEL_NEEDS_REVIEW;
    const reason = ciFailed
      ? `verdict=${input.conclusion}; ${ciReason}`
      : !blocking && guardrailHit
        ? `verdict=${input.conclusion}; guarded path forces human review`
        : !blocking && !ciPassed
          ? `verdict=${input.conclusion}; CI not green yet — held for human`
          : `verdict=${input.conclusion}`;
    if (!hasLabel(input.pr.labels, label)) {
      actions.push({ actionClass: "label", requiresApproval: approval("label"), reason, label });
    }
  }

  // 2) review — approve XOR request-changes, never re-post the same state. A red CI forces request-changes
  // (citing the failing checks) and is NEVER approved; approve fires only when the gate passes AND CI is green
  // AND no guarded path is touched.
  if ((blocking || ciFailed) && acting("request_changes") && input.pr.reviewDecision !== "CHANGES_REQUESTED") {
    const lines = ciFailed ? [ciReason, ...input.blockerTitles] : [...input.blockerTitles];
    const summary = lines.length ? lines.map((line) => `- ${line}`).join("\n") : "- The Gittensory Gate is not satisfied.";
    const reason = ciFailed ? `CI failing${input.blockerTitles.length ? ` + ${input.blockerTitles.length} blocker(s)` : ""}` : `${input.blockerTitles.length || 1} blocker(s)`;
    actions.push({
      actionClass: "request_changes",
      requiresApproval: approval("request_changes"),
      reason,
      reviewBody: `Gittensory requests changes — ${ciFailed ? "CI is not green" : "the gate is not yet satisfied"}:\n\n${summary}`,
    });
  } else if (readyToMerge && acting("approve") && input.pr.reviewDecision !== "APPROVED") {
    actions.push({
      actionClass: "approve",
      requiresApproval: approval("approve"),
      reason: "gate passed, CI green",
      reviewBody: "Gittensory approves — the gate is satisfied and CI is green.",
    });
  }

  // 3) disposition — merge a clean, approved, CI-green PR; otherwise close clear noise OR a red-CI PR (citing
  // the failing checks). Owner + maintainer-automation PRs are NEVER closed (a red-CI owner PR is held via the
  // request_changes above, left open for the maintainer). Mutually exclusive with merge.
  const mergeableClean = input.pr.mergeableState === "clean";
  const canMerge = readyToMerge && acting("merge") && mergeableClean && approvalsSatisfied;
  if (canMerge) {
    actions.push({
      actionClass: "merge",
      requiresApproval: approval("merge"),
      reason: `gate passed, CI green, mergeable, ${autoMaintain.requireApprovals} approval(s) satisfied`,
      mergeMethod: autoMaintain.mergeMethod,
    });
  } else if (acting("close") && (ciFailed || !gatePassing) && !guardrailHit && !input.authorIsOwner && !input.authorIsAutomationBot) {
    const closeReasons: string[] = [];
    if (ciFailed) closeReasons.push(ciReason);
    if (input.pr.slopRisk != null && input.pr.slopRisk >= slopGateMinScore) closeReasons.push(`slop score ${input.pr.slopRisk} ≥ ${slopGateMinScore}`);
    if ((input.pr.linkedDuplicateCount ?? 0) > 0) closeReasons.push("duplicate of another open PR");
    if (closeReasons.length > 0) {
      actions.push({ actionClass: "close", requiresApproval: approval("close"), reason: closeReasons.join("; "), closeComment: closeMessage(closeReasons) });
    }
  }

  return actions;
}
