import { describe, expect, it } from "vitest";
import { agentDispositionLabels, applyPrecisionBreakers, precisionBreakerDowngradeDirections } from "../../src/queue/processors";
import { AGENT_LABEL_CHANGES, AGENT_LABEL_NEEDS_REVIEW, AGENT_LABEL_READY, type PlannedAgentAction } from "../../src/settings/agent-actions";

// The processors chaining at maybeRunAgentMaintenance:
//   breakerOnPlan = applyPrecisionBreakers(planned, isHoldOnly, isCloseHoldOnly)
// Both flag reads are independent + fail-open at the call site; this exercises the composed transform.

const mergeAction: PlannedAgentAction = { actionClass: "merge", requiresApproval: false, reason: "ready", mergeMethod: "squash" };
const readyLabel: PlannedAgentAction = { actionClass: "label", requiresApproval: false, reason: "ready", label: AGENT_LABEL_READY, labelOp: "add" };
const heuristicClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "CI failing", closeKind: "heuristic" };
const changesLabel: PlannedAgentAction = { actionClass: "label", requiresApproval: false, reason: "verdict=failure", label: AGENT_LABEL_CHANGES, labelOp: "add" };

describe("applyPrecisionBreakers — chaining the merge + close precision breakers", () => {
  it("close is downgraded when closeHoldOnly=true (merge breaker off)", () => {
    const out = applyPrecisionBreakers([changesLabel, heuristicClose], false, true);
    expect(out.some((a) => a.actionClass === "close")).toBe(false); // heuristic close dropped
    expect(out.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW && a.labelOp === "add")).toBe(true);
    expect(out.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_CHANGES)).toBe(true); // changes-requested KEPT
  });

  it("passthrough when both breakers are off (byte-identical common path)", () => {
    const plan = [readyLabel, mergeAction];
    expect(applyPrecisionBreakers(plan, false, false)).toBe(plan);
  });

  it("merge is downgraded when holdOnly=true (close breaker off) without touching a heuristic close", () => {
    const out = applyPrecisionBreakers([readyLabel, mergeAction], true, false);
    expect(out.some((a) => a.actionClass === "merge")).toBe(false); // merge dropped
    expect(out.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_READY)).toBe(false); // ready label dropped
    expect(out.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW && a.labelOp === "add")).toBe(true);
  });

  it("both breakers active do not interfere: merge AND a heuristic close are each downgraded", () => {
    // A (contrived) plan carrying both a merge and a heuristic close exercises both transforms in one pass.
    const out = applyPrecisionBreakers([readyLabel, mergeAction, changesLabel, heuristicClose], true, true);
    expect(out.some((a) => a.actionClass === "merge")).toBe(false);
    expect(out.some((a) => a.actionClass === "close")).toBe(false);
    expect(out.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_READY)).toBe(false);
    expect(out.some((a) => a.actionClass === "label" && a.label === AGENT_LABEL_CHANGES)).toBe(true); // KEPT
    // needs-human-review added exactly once (the second downgrade is idempotent on the label).
    expect(out.filter((a) => a.actionClass === "label" && a.label === AGENT_LABEL_NEEDS_REVIEW)).toHaveLength(1);
  });
});

describe("precisionBreakerDowngradeDirections — bounded-cardinality breaker-downgrade observability (#terminal-outcome-audit)", () => {
  it("empty when neither breaker is engaged (the common, byte-identical path)", () => {
    const planned = [readyLabel, mergeAction];
    expect(precisionBreakerDowngradeDirections(planned, applyPrecisionBreakers(planned, false, false))).toEqual([]);
  });

  it("['merge'] when the merge breaker dropped a would-merge", () => {
    const planned = [readyLabel, mergeAction];
    expect(precisionBreakerDowngradeDirections(planned, applyPrecisionBreakers(planned, true, false))).toEqual(["merge"]);
  });

  it("['close'] when the close breaker dropped a heuristic would-close", () => {
    const planned = [changesLabel, heuristicClose];
    expect(precisionBreakerDowngradeDirections(planned, applyPrecisionBreakers(planned, false, true))).toEqual(["close"]);
  });

  it("['merge', 'close'] (stable order) when both breakers downgrade in the same pass", () => {
    const planned = [readyLabel, mergeAction, changesLabel, heuristicClose];
    expect(precisionBreakerDowngradeDirections(planned, applyPrecisionBreakers(planned, true, true))).toEqual(["merge", "close"]);
  });

  it("empty when closeHoldOnly is engaged but the only close present is concrete-evidence-exempt (not actually downgraded)", () => {
    const concreteClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "hard blocker", closeKind: "heuristic", closeConcreteEvidence: true };
    const planned = [concreteClose];
    expect(precisionBreakerDowngradeDirections(planned, applyPrecisionBreakers(planned, false, true))).toEqual([]);
  });

  it("empty when holdOnly is engaged but no merge was ever planned (nothing to downgrade)", () => {
    const planned = [changesLabel];
    expect(precisionBreakerDowngradeDirections(planned, applyPrecisionBreakers(planned, true, true))).toEqual([]);
  });

  // REGRESSION (gate review finding, round 2): a plan can carry TWO close actions — a KEPT deterministic close
  // (e.g. linked-issue-hard-rule, per downgradeCloseToHold's own "when BOTH a heuristic and a deterministic
  // close are present, drops ONLY the heuristic one" contract) alongside a DROPPED heuristic one. A coarse
  // `!breakerOnPlan.some(actionClass === "close")` check would never fire here, since the surviving
  // deterministic close keeps a "close" action in breakerOnPlan even though the breaker DID rewrite the plan.
  it("['close'] when a KEPT deterministic close and a DROPPED heuristic close are both present in the same plan", () => {
    const deterministicClose: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "ineligible issue", closeKind: "linked-issue-hard-rule" };
    const planned = [deterministicClose, heuristicClose];
    const breakerOnPlan = applyPrecisionBreakers(planned, false, true);
    // Sanity: the deterministic close really does survive alongside the dropped heuristic one.
    expect(breakerOnPlan.some((a) => a.actionClass === "close" && a.closeKind === "linked-issue-hard-rule")).toBe(true);
    expect(breakerOnPlan.some((a) => a.actionClass === "close" && a.closeKind === "heuristic")).toBe(false);
    expect(precisionBreakerDowngradeDirections(planned, breakerOnPlan)).toEqual(["close"]);
  });
});

describe("agentDispositionLabels — bounded {actionClass, blockerClass} for gittensory_agent_disposition_total (#terminal-outcome-audit)", () => {
  it("actionClass is 'merge' when the final plan still contains a merge action", () => {
    expect(agentDispositionLabels([mergeAction], [], null)).toEqual({ actionClass: "merge", blockerClass: "none" });
  });

  it("actionClass is 'close' when the final plan still contains a close action (and no merge)", () => {
    expect(agentDispositionLabels([heuristicClose], [], null)).toEqual({ actionClass: "close", blockerClass: "none" });
  });

  it("actionClass is 'hold' when the final plan has neither a merge nor a close action (the previously-silent bucket)", () => {
    expect(agentDispositionLabels([changesLabel], [], null)).toEqual({ actionClass: "hold", blockerClass: "none" });
  });

  it("actionClass is 'hold' for a genuinely EMPTY plan (nothing was ever planned — the most common real hold shape)", () => {
    expect(agentDispositionLabels([], [], null)).toEqual({ actionClass: "hold", blockerClass: "none" });
  });

  it("blockerClass is the first gate-blocker code when the gate reported one", () => {
    expect(agentDispositionLabels([], ["secret_leak", "duplicate_pr_risk"], null)).toEqual({ actionClass: "hold", blockerClass: "secret_leak" });
  });

  it("blockerClass is 'none' for a clean PR held for a non-blocker reason (e.g. CI still pending)", () => {
    expect(agentDispositionLabels([], [], null)).toEqual({ actionClass: "hold", blockerClass: "none" });
  });

  // REGRESSION (gate-flagged gap): gate.blockers is always [] for a `neutral` conclusion (guardrail/size/
  // manifest-blocked/AI-inconclusive holds all report through `warnings`, never `blockers`), so a real, nameable
  // hold used to flatten to blockerClass: "none" -- indistinguishable from a clean PR waiting on pending CI.
  it("blockerClass falls back to holdReasonCode when the gate reported no blockers (a neutral-conclusion hold)", () => {
    expect(agentDispositionLabels([], [], "guardrail_hold")).toEqual({ actionClass: "hold", blockerClass: "guardrail_hold" });
  });

  it("blockerClass prefers a real gate-blocker code over holdReasonCode when both are somehow present", () => {
    expect(agentDispositionLabels([], ["secret_leak"], "guardrail_hold")).toEqual({ actionClass: "hold", blockerClass: "secret_leak" });
  });

  it("blockerClass is 'none' only when BOTH gateBlockerCodes and holdReasonCode are empty/null", () => {
    expect(agentDispositionLabels([], [], null)).toEqual({ actionClass: "hold", blockerClass: "none" });
  });

  it("prefers 'merge' over 'close' when (hypothetically) both are present in the final plan", () => {
    expect(agentDispositionLabels([mergeAction, heuristicClose], [], null).actionClass).toBe("merge");
  });
});
