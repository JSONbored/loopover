// Loosening recommendations for the tuning advisor (#8160, sub-issue of epic #8121). auto-tune.ts's
// computeTuningRecommendations deliberately emits loosening advice as prose with no payload (autonomous
// loosening was the regression risk the loop existed to avoid — see OverridePayload's own doc). The #8121
// narrow start made ONE loosening measurable (the satisfaction floor, backtest-gated); this module surfaces
// that loop's state as TuningRec entries alongside the tightening recs, so the advisor's reader sees a
// backtest-cleared loosening opportunity — or a recently-applied one — in the same ranked list.
//
// HARD BOUNDARY (the issue's own): these recs NEVER carry an `overridePayload`. That field is the
// tightening-only auto-apply channel (runAutoApplyRecommendations consumes it); a loosening must only ever
// be applied by the flag-gated loop itself (satisfaction-floor-loosening-run.ts), never promoted by the
// advisor's apply path. PURE — no IO; the caller supplies the loop's state.
import type { TuningRec } from "./auto-tune";
import type { SatisfactionFloorLooseningProposal } from "../services/satisfaction-floor-loosening";
import type { KnobLooseningProposal } from "../services/loosening-knobs";

/** The advisor list is per-project elsewhere; the satisfaction floor is deployment-global, so its recs use
 *  this fixed pseudo-project label rather than impersonating any repo. */
export const LOOSENING_REC_PROJECT = "global:satisfaction-floor";

export type SatisfactionFloorRecInput = {
  flagEnabled: boolean;
  proposal: SatisfactionFloorLooseningProposal | null;
  /** created_at of the most recent applied loosening (calibration.satisfaction_floor_loosened), or null. */
  lastAppliedAt: string | null;
};

const pct = (value: number | null): string => (value == null ? "—" : `${Math.round(value * 100)}%`);

/**
 * Build the loosening TuningRecs from the loop's current state. At most two entries, never a payload:
 *   • a backtest-cleared PROPOSAL → severity `good` — the positive "evidence says this can loosen" signal,
 *     with both split verdicts + sample sizes inline and the action that matches the flag state (flip the
 *     flag vs. wait for the hourly tick);
 *   • a recently APPLIED loosening → severity `info`, pointing at the operator status surface (#8161).
 * No state ⇒ []. Pure and deterministic.
 */
export function buildSatisfactionFloorLooseningRecs(input: SatisfactionFloorRecInput): TuningRec[] {
  const recs: TuningRec[] = [];
  if (input.proposal) {
    const { proposal } = input;
    const action = input.flagEnabled
      ? "The autotune flag is ON — the hourly tick will apply this step automatically."
      : "The autotune flag is OFF — set SATISFACTION_FLOOR_AUTOTUNE_ENABLED (or POST /v1/internal/calibration/loosen-satisfaction-floor after flipping it) to let the loop act.";
    recs.push({
      project: LOOSENING_REC_PROJECT,
      severity: "good",
      message:
        `Backtest-cleared LOOSENING available: satisfaction confidence floor ${proposal.currentFloor} → ${proposal.proposedFloor}. ` +
        `Visible split ${proposal.visible.verdict} (${proposal.visibleCases} case(s), precision ${pct(proposal.visible.baseline.precision)} → ${pct(proposal.visible.candidate.precision)}); ` +
        `held-out split ${proposal.heldOut.verdict} (${proposal.heldOutCases} case(s)). ${action}`,
      // Deliberately NO overridePayload: that channel is tightening-only (see the module doc).
    });
  }
  if (input.lastAppliedAt) {
    recs.push({
      project: LOOSENING_REC_PROJECT,
      severity: "info",
      message: `A backtest-gated loosening was applied at ${input.lastAppliedAt} — see GET /v1/internal/calibration/satisfaction-floor for the live floor and full evidence history.`,
    });
  }
  return recs;
}

/**
 * Recs for REPORT-ONLY registry knobs (#8159): the evidence surfaces exactly like a live knob's proposal,
 * but the action line states plainly that this knob's apply is not wired — enabling it is a per-knob,
 * reviewed decision (its consumption plumbing changes real authority), never a flag flip. Same hard
 * boundary: no overridePayload, ever.
 */
/** Reliability-curve view beside the ladder (#8227): one info-severity rec per live knob whose DERIVED
 *  floor suggestion differs from its live value — evidence shown, authority unchanged (the ladder machinery
 *  still owns movement; ladder replacement is #8227's recorded soak decision, not this rec). */
export function buildKnobReliabilityRecs(
  statuses: readonly { knobId: string; liveValue: number; reliability: { suggestion: number | null } | null }[],
): TuningRec[] {
  const recs: TuningRec[] = [];
  for (const status of statuses) {
    const suggestion = status.reliability?.suggestion ?? null;
    if (suggestion === null || suggestion === status.liveValue) continue;
    recs.push({
      project: `global:${status.knobId}`,
      severity: "info",
      message:
        `Reliability-curve view for ${status.knobId}: the derived floor at the 0.9 precision bar is ${suggestion} ` +
        `vs live ${status.liveValue}. Curve-derived suggestions are SURFACING ONLY — the bounded candidate ladder ` +
        "still owns any movement; treat a persistent gap as soak evidence for the ladder-replacement decision.",
    });
  }
  return recs;
}

export function buildReportOnlyKnobRecs(proposals: readonly KnobLooseningProposal[]): TuningRec[] {
  return proposals.map((proposal) => ({
    project: `global:${proposal.knobId}`,
    severity: "good" as const,
    message:
      `Backtest-cleared LOOSENING evidence for ${proposal.knobId} (report-only): ${proposal.currentValue} → ${proposal.proposedValue}. ` +
      `Visible split ${proposal.visible.verdict} (${proposal.visibleCases} case(s), precision ${pct(proposal.visible.baseline.precision)} → ${pct(proposal.visible.candidate.precision)}); ` +
      `held-out split ${proposal.heldOut.verdict} (${proposal.heldOutCases} case(s)). ` +
      "This knob has no override consumer yet — applying requires shipping its consumption plumbing as its own reviewed change.",
  }));
}
