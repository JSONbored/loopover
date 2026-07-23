import { describe, expect, it } from "vitest";
import { buildSatisfactionFloorLooseningRecs, LOOSENING_REC_PROJECT } from "../../src/review/loosening-recs";
import type { SatisfactionFloorLooseningProposal } from "../../src/services/satisfaction-floor-loosening";

function proposal(overrides: Partial<SatisfactionFloorLooseningProposal> = {}): SatisfactionFloorLooseningProposal {
  return {
    ruleId: "linked_issue_scope_mismatch",
    currentFloor: 0.5,
    proposedFloor: 0.45,
    visibleCases: 24,
    heldOutCases: 7,
    visible: {
      ruleId: "linked_issue_scope_mismatch",
      baseline: { ruleId: "linked_issue_scope_mismatch", caseCount: 24, truePositive: 1, falsePositive: 4, trueNegative: 19, falseNegative: 0, precision: 0.2, recall: 1 },
      candidate: { ruleId: "linked_issue_scope_mismatch", caseCount: 24, truePositive: 1, falsePositive: 0, trueNegative: 23, falseNegative: 0, precision: 1, recall: 1 },
      regressedAxes: [],
      improvedAxes: ["precision"],
      verdict: "improved",
    },
    heldOut: {
      ruleId: "linked_issue_scope_mismatch",
      baseline: { ruleId: "linked_issue_scope_mismatch", caseCount: 7, truePositive: 0, falsePositive: 0, trueNegative: 7, falseNegative: 0, precision: null, recall: null },
      candidate: { ruleId: "linked_issue_scope_mismatch", caseCount: 7, truePositive: 0, falsePositive: 0, trueNegative: 7, falseNegative: 0, precision: null, recall: null },
      regressedAxes: [],
      improvedAxes: [],
      verdict: "unchanged",
    },
    ...overrides,
  };
}

describe("buildSatisfactionFloorLooseningRecs (#8160)", () => {
  it("returns [] with no proposal and no applied history", () => {
    expect(buildSatisfactionFloorLooseningRecs({ flagEnabled: false, proposal: null, lastAppliedAt: null })).toEqual([]);
  });

  it("surfaces a backtest-cleared proposal as a good-severity rec with both split verdicts, sample sizes, and precision movement", () => {
    const recs = buildSatisfactionFloorLooseningRecs({ flagEnabled: false, proposal: proposal(), lastAppliedAt: null });
    expect(recs).toHaveLength(1);
    const [rec] = recs;
    expect(rec!.project).toBe(LOOSENING_REC_PROJECT);
    expect(rec!.severity).toBe("good");
    expect(rec!.message).toContain("0.5 → 0.45");
    expect(rec!.message).toContain("Visible split improved (24 case(s), precision 20% → 100%)");
    expect(rec!.message).toContain("held-out split unchanged (7 case(s))");
    // Null precision renders as the em-dash convention, never a fake number.
    const nullPrecision = buildSatisfactionFloorLooseningRecs({
      flagEnabled: false,
      proposal: proposal({ visible: { ...proposal().visible, baseline: { ...proposal().visible.baseline, precision: null } } }),
      lastAppliedAt: null,
    });
    expect(nullPrecision[0]!.message).toContain("precision — →");
  });

  it("the action line matches the flag state, and the rec NEVER carries an overridePayload (the tightening-only channel)", () => {
    const off = buildSatisfactionFloorLooseningRecs({ flagEnabled: false, proposal: proposal(), lastAppliedAt: null });
    expect(off[0]!.message).toContain("SATISFACTION_FLOOR_AUTOTUNE_ENABLED");
    const on = buildSatisfactionFloorLooseningRecs({ flagEnabled: true, proposal: proposal(), lastAppliedAt: null });
    expect(on[0]!.message).toContain("hourly tick will apply");
    for (const rec of [...off, ...on]) expect(rec.overridePayload).toBeUndefined();
  });

  it("reports a recently applied loosening as an info rec pointing at the operator status surface, alongside a proposal when both exist", () => {
    const both = buildSatisfactionFloorLooseningRecs({ flagEnabled: true, proposal: proposal(), lastAppliedAt: "2026-07-23T05:00:00.000Z" });
    expect(both.map((rec) => rec.severity)).toEqual(["good", "info"]);
    expect(both[1]!.message).toContain("2026-07-23T05:00:00.000Z");
    expect(both[1]!.message).toContain("/v1/internal/calibration/satisfaction-floor");

    const appliedOnly = buildSatisfactionFloorLooseningRecs({ flagEnabled: true, proposal: null, lastAppliedAt: "2026-07-23T05:00:00.000Z" });
    expect(appliedOnly).toHaveLength(1);
    expect(appliedOnly[0]!.severity).toBe("info");
  });
});
