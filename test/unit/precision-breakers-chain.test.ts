import { describe, expect, it } from "vitest";
import { applyPrecisionBreakers } from "../../src/queue/processors";
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
