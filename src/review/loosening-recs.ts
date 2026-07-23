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
