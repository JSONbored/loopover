import { describe, expect, it } from "vitest";
import { planDecisionLabelBackfill, type CandidateRow } from "../../scripts/backfill-decision-labels-core";
import { buildBundle } from "../../scripts/backfill-decision-labels";
import { canonicalJson, contentDigest } from "../../src/review/decision-record";

// The backfill's contracts: acted closes stage as close_arm (merged outcome = definitive incorrect),
// AI-judgment-only holds stage as holdout_close, everything else is skipped with its reason counted,
// and one target contributes at most one pair with the acted decision winning.

function candidate(overrides: Partial<CandidateRow>): CandidateRow {
  return {
    targetId: "o/r#1",
    project: "o/r",
    pullNumber: 1,
    decision: "close",
    headSha: "sha1",
    decidedAt: "2026-07-01T00:00:00.000Z",
    findingsJson: JSON.stringify([{ code: "ai_consensus_defect", confidence: 0.9, title: "defect" }]),
    realizedOutcome: "closed",
    ...overrides,
  };
}

describe("planDecisionLabelBackfill", () => {
  it("stages an acted close as close_arm carrying the shaping finding's confidence", () => {
    const plan = planDecisionLabelBackfill([candidate({})]);
    expect(plan.staged).toHaveLength(1);
    expect(plan.staged[0]).toMatchObject({
      stratum: "close_arm",
      verdict: "close",
      aiConfidence: 0.9,
      reasonCode: "ai_consensus_defect",
      outcome: "closed",
      definitiveAdjudication: null,
    });
  });

  it("a closed-then-MERGED target is the definitive incorrect-close class", () => {
    const plan = planDecisionLabelBackfill([candidate({ realizedOutcome: "merged" })]);
    expect(plan.staged[0]!.definitiveAdjudication).toBe("incorrect");
    expect(plan.staged[0]!.outcome).toBe("merged");
  });

  it("stages a hold as holdout_close ONLY when every blocker code was an AI judgment; outcome stays null", () => {
    const pure = candidate({ decision: "hold", blockerCodesJson: JSON.stringify(["ai_consensus_defect"]) });
    const mixed = candidate({
      targetId: "o/r#2",
      pullNumber: 2,
      decision: "hold",
      blockerCodesJson: JSON.stringify(["ai_consensus_defect", "ci_failing"]),
    });
    const absent = candidate({ targetId: "o/r#3", pullNumber: 3, decision: "hold", blockerCodesJson: null });
    const empty = candidate({ targetId: "o/r#4", pullNumber: 4, decision: "hold", blockerCodesJson: "[]" });
    const garbled = candidate({ targetId: "o/r#5", pullNumber: 5, decision: "hold", blockerCodesJson: "{nope" });
    const plan = planDecisionLabelBackfill([pure, mixed, absent, empty, garbled]);
    expect(plan.staged).toHaveLength(1);
    expect(plan.staged[0]).toMatchObject({ stratum: "holdout_close", outcome: null, definitiveAdjudication: null });
    expect(plan.skipped.mixedBlockerHold).toBe(4);
  });

  it("selects the FIRST AI-judgment finding (the live gate.blockers.find contract), skipping non-judgment codes", () => {
    const plan = planDecisionLabelBackfill([
      candidate({
        findingsJson: JSON.stringify([
          { code: "slop_signal", confidence: 0.99, title: "not a judgment" },
          { code: "ai_review_split", confidence: 0.62, title: "split" },
          { code: "ai_consensus_defect", confidence: 0.97, title: "later" },
        ]),
      }),
    ]);
    expect(plan.staged[0]).toMatchObject({ aiConfidence: 0.62, reasonCode: "ai_review_split" });
  });

  it("skips candidates with no usable confidence: missing, non-numeric, out of range, or no judgment finding", () => {
    const plan = planDecisionLabelBackfill([
      candidate({ findingsJson: JSON.stringify([{ code: "ai_consensus_defect", title: "no confidence" }]) }),
      candidate({ targetId: "o/r#2", pullNumber: 2, findingsJson: JSON.stringify([{ code: "ai_consensus_defect", confidence: "high" }]) }),
      candidate({ targetId: "o/r#3", pullNumber: 3, findingsJson: JSON.stringify([{ code: "ai_consensus_defect", confidence: 1.7 }]) }),
      candidate({ targetId: "o/r#4", pullNumber: 4, findingsJson: JSON.stringify([{ code: "readiness_low" }]) }),
    ]);
    expect(plan.staged).toHaveLength(0);
    expect(plan.skipped.noShapingFinding).toBe(4);
  });

  it("counts unparseable findings and missing head shas separately", () => {
    const plan = planDecisionLabelBackfill([
      candidate({ findingsJson: "{broken" }),
      candidate({ targetId: "o/r#2", pullNumber: 2, findingsJson: JSON.stringify({ not: "an array" }) }),
      candidate({ targetId: "o/r#3", pullNumber: 3, headSha: null }),
      candidate({ targetId: "o/r#4", pullNumber: 4, headSha: "  " }),
    ]);
    expect(plan.staged).toHaveLength(0);
    expect(plan.skipped.unparseableFindings).toBe(2);
    expect(plan.skipped.missingHeadSha).toBe(2);
  });

  it("one pair per target: the ACTED close wins over the same target's hold regardless of input order", () => {
    const hold = candidate({ decision: "hold", blockerCodesJson: JSON.stringify(["ai_consensus_defect"]) });
    const close = candidate({ findingsJson: JSON.stringify([{ code: "ai_consensus_defect", confidence: 0.8, title: "t" }]) });
    const plan = planDecisionLabelBackfill([hold, close]);
    expect(plan.staged).toHaveLength(1);
    expect(plan.staged[0]).toMatchObject({ stratum: "close_arm", aiConfidence: 0.8 });
    expect(plan.skipped.duplicateTarget).toBe(1);
  });
});

describe("buildBundle", () => {
  it("emits records whose digest matches their canonical JSON, backfill-sentinel config, and pending labels", async () => {
    const bundle = await buildBundle([candidate({}), candidate({ targetId: "o/r#7", pullNumber: 7, decision: "hold", blockerCodesJson: '["ai_consensus_defect"]' })], "2026-07-26T12:00:00.000Z");
    const records = bundle.records as Array<Record<string, string | number>>;
    const labels = bundle.labels as Array<Record<string, unknown>>;
    expect(records).toHaveLength(2);
    for (const row of records) {
      const record = JSON.parse(String(row.record_json)) as Record<string, unknown>;
      expect(await contentDigest(record)).toBe(row.record_digest);
      expect(canonicalJson(record)).toBe(row.record_json);
      expect(record.configDigest).toBe("backfill:unavailable");
      expect(record.schemaVersion).toBe("3"); // v3 (#8962): + salvageability
    }
    expect(records[0]).toMatchObject({ id: "record:o/r#1@sha1", action: "close", created_at: "2026-07-01T00:00:00.000Z" });
    expect(records[1]).toMatchObject({ action: "hold" });
    const parsed = JSON.parse(String(records[0]!.record_json)) as { aiConfidence: number };
    expect(parsed.aiConfidence).toBe(0.9);
    expect(labels[0]).toMatchObject({
      id: "audit:o/r#1",
      status: "pending",
      stratum: "close_arm",
      rubric_version: "1",
      sampled_at: "2026-07-26T12:00:00.000Z",
      adjudication: null,
    });
    expect(labels[1]).toMatchObject({ stratum: "holdout_close", outcome: null });
    expect((bundle.worklist as unknown[]).length).toBe(2);
  });
});
