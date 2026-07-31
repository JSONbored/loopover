import { describe, expect, it } from "vitest";

import {
  AGENT_LABEL_NEEDS_REVIEW,
  downgradeMergeToHold,
  withManualReviewHoldLabel,
  type PlannedAgentAction,
} from "../../src/settings/agent-actions";
import { applyCloseAuditHoldout } from "../../src/review/close-audit-holdout";

// #10164: a plan must never contain BOTH an add and a remove of the same label.
//
// Three post-plan transforms surface the manual-review hold -- the merge circuit-breaker, the close
// circuit-breaker, and the close-audit holdout (#8831). All three checked idempotency by looking for an
// existing ADD (`labelOp !== "remove"`), which by construction cannot see a planned REMOVE. So when the
// planner had already decided to release the label (section 1b, whenever nothing it knows about still wants a
// hold), the transform appended an add NEXT TO that remove and the executor performed both.
//
// Observed in production on JSONbored/loopover#10155: the label cycled roughly every 90 seconds -- four
// add/remove pairs in eight minutes -- burning write quota and notifying subscribers on each flip. It was
// latent until #10116 made section 1b's release actually fire for these PRs.
//
// The planner cannot prevent this from its side: these run AFTER planning, so their reasons are not knowable
// to `noManualReviewHoldWanted` (whose comment nonetheless claims to list "every reason that would ADD this
// label"). Resolving it where the add happens is what makes it structural.

const releasePlanned: PlannedAgentAction = {
  actionClass: "label",
  autonomyClass: "merge",
  requiresApproval: false,
  reason: 'manual-review hold resolved — clearing the "manual-review" label the bot applied',
  label: AGENT_LABEL_NEEDS_REVIEW,
  labelOp: "remove",
};

const holdLabels = (plan: PlannedAgentAction[]) =>
  plan.filter((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW);

describe("manual-review label flap (#10164)", () => {
  it("REGRESSION: the close-audit holdout drops a planned release instead of racing it", () => {
    // The exact production shape: planner released the label, holdout diverts the close and re-adds it.
    const planned: PlannedAgentAction[] = [
      { actionClass: "close", requiresApproval: false, reason: "heuristic close", closeKind: "heuristic" },
      releasePlanned,
    ];
    const out = applyCloseAuditHoldout(planned);
    const labelOps = holdLabels(out);
    expect(labelOps).toHaveLength(1);
    expect(labelOps[0]?.labelOp).toBe("add");
    expect(out.some((a) => a.actionClass === "close")).toBe(false);
  });

  it("REGRESSION: the merge circuit-breaker does the same", () => {
    const planned: PlannedAgentAction[] = [
      { actionClass: "merge", requiresApproval: false, reason: "green" },
      releasePlanned,
    ];
    const labelOps = holdLabels(downgradeMergeToHold(planned, true));
    expect(labelOps).toHaveLength(1);
    expect(labelOps[0]?.labelOp).toBe("add");
  });

  it("INVARIANT: no transform ever emits both operations for the same label", () => {
    // Stated over all three rather than per-transform, so a fourth added later is covered by the same rule
    // the moment it routes through withManualReviewHoldLabel.
    const withClose: PlannedAgentAction[] = [
      { actionClass: "close", requiresApproval: false, reason: "heuristic close", closeKind: "heuristic" },
      releasePlanned,
    ];
    const plans = [
      applyCloseAuditHoldout(withClose),
      downgradeMergeToHold([{ actionClass: "merge", requiresApproval: false, reason: "green" }, releasePlanned], true),
      withManualReviewHoldLabel([releasePlanned], {}, { autonomyClass: "close", requiresApproval: false, reason: "any hold" }),
    ];
    for (const [i, plan] of plans.entries()) {
      const ops = new Set(holdLabels(plan).map((a) => a.labelOp));
      expect(ops.has("add") && ops.has("remove"), `plan ${i} contains both ops`).toBe(false);
    }
  });

  it("stays idempotent: an add already in the plan is not duplicated", () => {
    const alreadyAdding: PlannedAgentAction = {
      actionClass: "label", autonomyClass: "close", requiresApproval: false,
      reason: "already held", label: AGENT_LABEL_NEEDS_REVIEW, labelOp: "add",
    };
    expect(holdLabels(withManualReviewHoldLabel([alreadyAdding], {}, { autonomyClass: "close", requiresApproval: false, reason: "second hold" }))).toHaveLength(1);
  });

  it("leaves OTHER labels' removes alone — only this label's release is dropped", () => {
    // Over-broad filtering here would silently defeat the stale-disposition-label cleanup.
    const otherRemove: PlannedAgentAction = {
      actionClass: "label", autonomyClass: "review_state_label", requiresApproval: false,
      reason: "stale sibling", label: "ready-to-merge", labelOp: "remove",
    };
    const out = withManualReviewHoldLabel([otherRemove, releasePlanned], {}, { autonomyClass: "close", requiresApproval: false, reason: "hold" });
    expect(out).toContainEqual(otherRemove);
  });

  it("is a no-op when the repo has no manual-review label configured", () => {
    const plan: PlannedAgentAction[] = [releasePlanned];
    expect(withManualReviewHoldLabel(plan, { manualReviewLabel: null }, { autonomyClass: "close", requiresApproval: false, reason: "hold" })).toBe(plan);
  });
});
