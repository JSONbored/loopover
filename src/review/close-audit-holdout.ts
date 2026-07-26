// Randomized close-audit holdout (#8831, epic #8828 Phase 2) — the selective-labels fix.
//
// WHY: when the bot closes a PR we never observe whether merging would have been fine, so close-precision is
// estimated only on the closes humans happened to contest — a biased sample (Lakkaraju et al., KDD 2017).
// ORB is deterministic, so every off-policy estimator is undefined (propensities are 0/1, no overlap). The
// ONLY fix is randomization: a small fraction ε of would-AUTO-close PRs is HELD for human adjudication
// instead, with the draw and ε logged — the propensity record that makes counterfactual evaluation
// well-defined for the first time.
//
// PLACEMENT CONTRACT: the draw consumes the FINAL post-breaker plan — it runs after every gate/breaker
// decision is made and can therefore never influence the decision itself, only whether the already-decided
// close executes or is diverted to a human. ε = 0 (the default) returns the plan untouched with zero I/O —
// byte-identical to today.
//
// SCOPE: heuristic closes only. Policy closes (contributor cap, blacklist, copycat, review-nag,
// linked-issue hard rule) are enforcement, not quality predictions (#8827) — holding one for an accuracy
// audit would suspend enforcement for no measurement gain. Staged (auto_with_approval) closes already get a
// human; only autonomy-auto closes need the instrument.
import { DECISION_AUDIT_RUBRIC_VERSION } from "./decision-audit";
import { recordAuditEvent } from "../db/repositories";
import { incr } from "../selfhost/metrics";
import { resolveAgentDispositionLabels, type AgentDispositionLabelSettings, type PlannedAgentAction } from "../settings/agent-actions";
import { errorMessage, nowIso } from "../utils/json";

/** A planned close the holdout may divert: heuristic (quality) closes executing WITHOUT a human in the loop. */
export function holdoutEligibleClose(planned: PlannedAgentAction[]): PlannedAgentAction | undefined {
  return planned.find((action) => action.actionClass === "close" && action.closeKind === "heuristic" && action.requiresApproval !== true);
}

/** PURE plan transform: drop the eligible close(s) and surface the manual-review label, mirroring
 *  downgradeCloseToHold's conversion exactly (drop + idempotent label add, never a merge/approve). */
export function applyCloseAuditHoldout(planned: PlannedAgentAction[], labelSettings: AgentDispositionLabelSettings = {}): PlannedAgentAction[] {
  const isEligible = (action: PlannedAgentAction): boolean => action.actionClass === "close" && action.closeKind === "heuristic" && action.requiresApproval !== true;
  const labels = resolveAgentDispositionLabels(labelSettings);
  const next = planned.filter((action) => !isEligible(action));
  const alreadyNeedsReview = labels.manualReview !== null && next.some((action) => action.actionClass === "label" && action.label === labels.manualReview && action.labelOp !== "remove");
  if (labels.manualReview !== null && !alreadyNeedsReview) {
    next.push({
      actionClass: "label",
      // Authorized by `close` — the class actually being diverted (#label-scoping, mirrors downgradeCloseToHold).
      autonomyClass: "close",
      requiresApproval: false,
      reason: "close-audit holdout drew this PR — would-close held for human adjudication (#8831)",
      label: labels.manualReview,
      labelOp: "add",
    });
  }
  return next;
}

/**
 * The full holdout step: eligibility → draw → (on fire) divert the plan, persist the propensity record and
 * the pending adjudication label row. Returns the (possibly diverted) plan.
 *
 * Best-effort persistence with a HARD ordering rule: the plan is only diverted when the propensity record
 * WROTE — a hold whose draw was never logged is invisible to every downstream estimator and would silently
 * bias coverage, so on a write failure the close proceeds unheld (the instrument, not the gate, degrades).
 */
export async function maybeApplyCloseAuditHoldout(
  env: Env,
  input: {
    repoFullName: string;
    pullNumber: number;
    planned: PlannedAgentAction[];
    /** gate.closeAuditHoldoutPct — percent 0-20; absent/0/invalid disables. */
    epsilonPct: number | null | undefined;
    /** True only when close autonomy resolves to full-auto — staged closes already get a human. */
    closeAutonomyIsAuto: boolean;
    labelSettings?: AgentDispositionLabelSettings;
    rng?: () => number;
  },
): Promise<PlannedAgentAction[]> {
  const epsilonPct = input.epsilonPct ?? 0;
  if (epsilonPct <= 0 || !input.closeAutonomyIsAuto) return input.planned;
  const eligible = holdoutEligibleClose(input.planned);
  if (eligible === undefined) return input.planned;

  const draw = (input.rng ?? Math.random)();
  if (draw >= epsilonPct / 100) return input.planned;

  const targetId = `${input.repoFullName}#${input.pullNumber}`;
  try {
    // Propensity record FIRST (the ordering rule above). The label row rides the same try: the adjudication
    // queue entry and the propensity log land together or the close proceeds unheld.
    await recordAuditEvent(env, {
      eventType: "decision_audit_holdout",
      actor: null,
      targetKey: targetId,
      outcome: "completed",
      detail: `would-close held for adjudication (ε=${epsilonPct}%)`,
      // closeKind is pinned by holdoutEligibleClose's predicate — only heuristic closes are ever eligible.
      metadata: { repoFullName: input.repoFullName, pullNumber: input.pullNumber, epsilonPct, draw, counterfactualAction: "close", closeKind: "heuristic" },
    });
    await env.DB.prepare(
      `INSERT OR IGNORE INTO decision_audit_labels (id, project, target_id, verdict, outcome, stratum, rubric_version, sampled_at)
       VALUES (?, ?, ?, 'close', NULL, 'holdout_close', ?, ?)`,
    )
      .bind(`audit:${targetId}`.slice(0, 190), input.repoFullName.slice(0, 200), targetId, DECISION_AUDIT_RUBRIC_VERSION, nowIso())
      .run();
  } catch (error) {
    console.warn(JSON.stringify({ event: "close_audit_holdout_record_error", target: targetId, message: errorMessage(error).slice(0, 160) }));
    return input.planned; // unlogged hold = biased instrument; the decided close proceeds instead
  }
  incr("loopover_close_audit_holdouts_total");
  return applyCloseAuditHoldout(input.planned, input.labelSettings);
}
