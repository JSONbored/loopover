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
  const approvalsSatisfied = autoMaintain.requireApprovals === 0 || input.pr.reviewDecision === "APPROVED";
  const level = (actionClass: AgentActionClass) => resolveAutonomy(input.autonomy, actionClass);
  const acting = (actionClass: AgentActionClass) => isActingAutonomyLevel(level(actionClass));
  const approval = (actionClass: AgentActionClass) => autonomyRequiresApproval(level(actionClass));

  // App/infra-neutral verdicts (not evaluated yet) never drive an action.
  if (input.conclusion === "neutral" || input.conclusion === "skipped") return actions;

  const blocking = isBlocking(input.conclusion);
  const passing = input.conclusion === "success";
  // A changed path matching a hard guardrail forces manual review: suppress the irreversible dispositions
  // (merge / close) AND the auto-approve that could later satisfy a merge. label + request_changes still run.
  const guardrailHit = changedPathsHittingGuardrail(input.changedPaths, input.hardGuardrailGlobs).length > 0;

  // 1) label — reflect the verdict bucket. After the neutral/skipped return above, a non-blocking verdict is
  // necessarily `success`. Idempotent: skip if the PR already carries the label.
  if (acting("label")) {
    const label = blocking ? AGENT_LABEL_CHANGES : AGENT_LABEL_READY;
    if (!hasLabel(input.pr.labels, label)) {
      actions.push({ actionClass: "label", requiresApproval: approval("label"), reason: `verdict=${input.conclusion}`, label });
    }
  }

  // 2) review — approve XOR request-changes, and never re-post the same state.
  if (blocking && acting("request_changes") && input.pr.reviewDecision !== "CHANGES_REQUESTED") {
    const summary = input.blockerTitles.length ? input.blockerTitles.map((title) => `- ${title}`).join("\n") : "- The Gittensory Gate is not satisfied.";
    actions.push({
      actionClass: "request_changes",
      requiresApproval: approval("request_changes"),
      reason: `${input.blockerTitles.length || 1} blocker(s)`,
      reviewBody: `Gittensory requests changes — the gate is not yet satisfied:\n\n${summary}`,
    });
  } else if (passing && acting("approve") && !guardrailHit && input.pr.reviewDecision !== "APPROVED") {
    actions.push({
      actionClass: "approve",
      requiresApproval: approval("approve"),
      reason: "gate passed",
      reviewBody: "Gittensory approves — the gate is satisfied.",
    });
  }

  // 3) disposition — merge a clean, approved, passing PR; otherwise close clear noise. Mutually exclusive.
  const mergeableClean = input.pr.mergeableState === "clean";
  const canMerge = passing && acting("merge") && mergeableClean && approvalsSatisfied && !guardrailHit;
  if (canMerge) {
    actions.push({
      actionClass: "merge",
      requiresApproval: approval("merge"),
      reason: `gate passed, mergeable, ${autoMaintain.requireApprovals} approval(s) satisfied`,
      mergeMethod: autoMaintain.mergeMethod,
    });
  } else if (acting("close") && !passing && !guardrailHit && !input.authorIsOwner) {
    const noiseReasons: string[] = [];
    if (input.pr.slopRisk != null && input.pr.slopRisk >= slopGateMinScore) noiseReasons.push(`slop score ${input.pr.slopRisk} ≥ ${slopGateMinScore}`);
    if ((input.pr.linkedDuplicateCount ?? 0) > 0) noiseReasons.push("duplicate of another open PR");
    if (noiseReasons.length > 0) {
      actions.push({ actionClass: "close", requiresApproval: approval("close"), reason: noiseReasons.join("; "), closeComment: closeMessage(noiseReasons) });
    }
  }

  return actions;
}
