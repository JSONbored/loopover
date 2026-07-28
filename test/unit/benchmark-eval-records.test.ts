import { describe, expect, it } from "vitest";
import {
  BENCHMARK_RUN_SCORING_RULE_VERSION,
  buildBenchmarkEvalScoreRecord,
  buildBenchmarkEvalScoreRecords,
  deriveBenchmarkLeaderboard,
} from "../../src/review/benchmark-eval-records";
import { verifyEvalScoreRecordDigest, type EvalScoreRecord } from "../../src/review/eval-score-records";
import {
  deriveBenchmarkGroundTruth,
  scoreBenchmarkProposals,
  type BenchmarkProposal,
  type BenchmarkScoreReport,
  type BenchmarkWindow,
} from "@loopover/engine";

// #9265 (harness #9216, epic #8534): the leaderboard IS the validator-consumable feed. These tests pin the
// two properties that make that true rather than merely claimed — every emitted record validates as a
// spec-conformant EvalScoreRecord whose digest a third party can recompute, and the held-out cadence is
// enforced at THIS boundary so a board cannot leak membership by forgetting a check.

const FROZEN = "2026-07-01T00:00:00.000Z";
const SNAPSHOT = "a1".repeat(32);
const CHECKSUM = "b2".repeat(32);

const WINDOW: BenchmarkWindow = {
  benchmarkId: "bench-2026q3",
  snapshotRef: SNAPSHOT,
  opensAt: "2026-07-01T00:00:00.000Z",
  closesAt: "2026-09-30T00:00:00.000Z",
};

function reportFor(subjectId: string, outcomes: ReadonlyArray<["merge" | "close", "merge" | "close" | "abstain"]>): BenchmarkScoreReport {
  const ids = outcomes.map((_, index) => `owner/repo#${index}`);
  const groundTruth = deriveBenchmarkGroundTruth({
    snapshotRef: SNAPSHOT,
    frozenAt: FROZEN,
    horizonDays: 14,
    workUnitIds: ids,
    events: outcomes.map(([realized], index) => ({
      workUnitId: ids[index] as string,
      action: realized,
      occurredAt: "2026-07-03T00:00:00.000Z",
    })),
  });
  const proposals: BenchmarkProposal[] = outcomes.map(([, predicted], index) => ({
    schemaVersion: 1,
    benchmarkId: WINDOW.benchmarkId,
    snapshotRef: SNAPSHOT,
    workUnitId: ids[index] as string,
    subject: { kind: "agent", id: subjectId },
    prediction:
      predicted === "abstain"
        ? { kind: "abstain" }
        : { kind: "act", action: predicted === "close" ? { kind: "close", reasonClass: "defective" } : { kind: "merge" } },
  }));
  return scoreBenchmarkProposals({ subjectId, groundTruth, proposals });
}

function inputFor(subjectId: string, report: BenchmarkScoreReport, issuedAt = "2026-08-01T00:00:00.000Z") {
  return {
    subjectId,
    report,
    window: WINDOW,
    snapshotChecksum: CHECKSUM,
    splitSeed: "seed-2026q3",
    heldOutFraction: 0.25,
    issuedAt,
  };
}

describe("benchmark EvalScoreRecord emission (#9265)", () => {
  it("emits a spec-conformant record with no benchmark-specific shape and a verifiable digest", async () => {
    const report = reportFor("agent-a", [["merge", "merge"], ["close", "close"], ["merge", "close"], ["close", "abstain"]]);
    const record = await buildBenchmarkEvalScoreRecord(inputFor("agent-a", report));

    expect(record.schemaVersion).toBe(1);
    expect(record.subject).toEqual({ kind: "agent", id: "agent-a" });
    expect(record.workUnit).toEqual({ kind: "benchmark_run", benchmarkId: "bench-2026q3", snapshotRef: SNAPSHOT });
    // No extra top-level fields beyond the spec's own (#9265 requirement 1).
    expect(Object.keys(record).sort()).toEqual(
      ["commitments", "issuedAt", "recordDigest", "schemaVersion", "score", "subject", "trust", "workUnit"],
    );
    // The digest is recomputable by a consumer through the SAME verifier the other record kind uses.
    expect(await verifyEvalScoreRecordDigest(record)).toBe(true);
  });

  it("REGRESSION: the commitments block is fully populated — a record nobody can re-derive is not publishable", async () => {
    const report = reportFor("agent-a", [["merge", "merge"], ["close", "close"]]);
    const record = await buildBenchmarkEvalScoreRecord(inputFor("agent-a", report));
    expect(record.commitments).toEqual({
      corpusChecksum: CHECKSUM,
      scoringRuleVersion: BENCHMARK_RUN_SCORING_RULE_VERSION,
      windowStart: WINDOW.opensAt,
      windowEnd: WINDOW.closesAt,
      splitSeed: "seed-2026q3",
      heldOutFraction: 0.25,
    });
    // Every field is present and none is a placeholder — the point of the block.
    for (const value of Object.values(record.commitments)) expect(value === null || value === "").toBe(false);
  });

  it("maps the multi-class report onto the spec's fixed score fields: macro is the published headline", async () => {
    // Two merges and two closes; the agent gets one of each right and abstains on none.
    const report = reportFor("agent-a", [["merge", "merge"], ["merge", "close"], ["close", "close"], ["close", "merge"]]);
    const record = await buildBenchmarkEvalScoreRecord(inputFor("agent-a", report));
    expect(record.score.precision).toBe(report.macro.precision);
    expect(record.score.recall).toBe(report.macro.recall);
    expect(record.score.decided).toBe(4);
    expect(record.score.abstained).toBe(0);
    expect(record.score.coverage).toBe(1);
    // `confirmed` is the number the agent actually got right — 2 of 4 here.
    expect(record.score.confirmed).toBe(2);
  });

  it("an agent that decided nothing yields null metrics and a zero confirmed count, never a fabricated 0 score", async () => {
    const report = reportFor("agent-a", [["merge", "abstain"], ["close", "abstain"]]);
    const record = await buildBenchmarkEvalScoreRecord(inputFor("agent-a", report));
    expect(record.score).toMatchObject({ decided: 0, confirmed: 0, precision: null, recall: null, coverage: 0, abstained: 2 });
    expect(await verifyEvalScoreRecordDigest(record)).toBe(true);
  });

  it("REGRESSION: trust is `reproducible` without an envelope and `attested` only with a real one", async () => {
    const report = reportFor("agent-a", [["merge", "merge"]]);
    const plain = await buildBenchmarkEvalScoreRecord(inputFor("agent-a", report));
    expect(plain.trust).toEqual({ tier: "reproducible" });
    const attestation = { envelopeDigest: "c3".repeat(32), measurement: "d4".repeat(32), runId: "e5".repeat(16) };
    const attested = await buildBenchmarkEvalScoreRecord({ ...inputFor("agent-a", report), attestation });
    expect(attested.trust).toEqual({ tier: "attested", attestation });
    // The tier is part of the digest preimage, so a tier claim cannot be edited after issuance.
    expect(attested.recordDigest).not.toBe(plain.recordDigest);
  });
});

describe("held-out publication cadence enforced at the emitter (#9265 requirement 4)", () => {
  const visibleReport = reportFor("agent-a", [["merge", "merge"], ["close", "close"]]);
  const heldOutReport = reportFor("agent-a", [["merge", "close"], ["close", "merge"]]);

  it("REGRESSION: while the window is open the held-out record is NEVER BUILT, not built-and-filtered", async () => {
    const { records, heldOutPublication } = await buildBenchmarkEvalScoreRecords({
      visible: inputFor("agent-a", visibleReport),
      heldOut: inputFor("agent-a", heldOutReport),
      now: "2026-08-15T00:00:00.000Z",
    });
    expect(records.map((entry) => entry.slice)).toEqual(["visible"]);
    expect(heldOutPublication).toEqual({ publish: false, reason: "window_open_between_cadences" });
    // Nothing in the emitted payload traces to the held-out slice. Probed by the held-out record's own
    // digest -- a 64-hex value unique to that exact content, so this cannot pass by coincidence the way a
    // bare number could (a held-out precision of 0 is a substring of almost any JSON).
    const wouldHaveBeen = await buildBenchmarkEvalScoreRecord(inputFor("agent-a", heldOutReport));
    expect(JSON.stringify(records)).not.toContain(wouldHaveBeen.recordDigest);
    expect(wouldHaveBeen.recordDigest).not.toBe(records[0]?.record.recordDigest);
  });

  it("at evaluation close both slices publish, each as its own spec-conformant record", async () => {
    const { records, heldOutPublication } = await buildBenchmarkEvalScoreRecords({
      visible: inputFor("agent-a", visibleReport),
      heldOut: inputFor("agent-a", heldOutReport),
      now: "2026-10-05T00:00:00.000Z",
    });
    expect(records.map((entry) => entry.slice)).toEqual(["visible", "held_out"]);
    expect(heldOutPublication).toEqual({ publish: true, reason: "evaluation_closed" });
    for (const { record } of records) expect(await verifyEvalScoreRecordDigest(record)).toBe(true);
  });

  it("a scheduled cadence boundary publishes held-out; a day either side does not", async () => {
    const cadenced = { ...WINDOW, heldOutPublishEveryDays: 30 };
    const args = {
      visible: { ...inputFor("agent-a", visibleReport), window: cadenced },
      heldOut: { ...inputFor("agent-a", heldOutReport), window: cadenced },
    };
    const onBoundary = await buildBenchmarkEvalScoreRecords({ ...args, now: "2026-07-31T00:00:00.000Z" });
    expect(onBoundary.records).toHaveLength(2);
    const offBoundary = await buildBenchmarkEvalScoreRecords({ ...args, now: "2026-08-01T00:00:00.000Z" });
    expect(offBoundary.records).toHaveLength(1);
  });
});

describe("leaderboard derived from records only (#9265 requirement: no separate query path)", () => {
  async function recordFor(subjectId: string, outcomes: Parameters<typeof reportFor>[1], issuedAt?: string): Promise<EvalScoreRecord> {
    return buildBenchmarkEvalScoreRecord(inputFor(subjectId, reportFor(subjectId, outcomes), issuedAt));
  }

  it("ranks by macro precision, ties broken by coverage then by the earlier claim", async () => {
    const strong = await recordFor("agent-strong", [["merge", "merge"], ["close", "close"]]);
    const weak = await recordFor("agent-weak", [["merge", "close"], ["close", "merge"]]);
    const board = deriveBenchmarkLeaderboard([weak, strong], "bench-2026q3");
    expect(board.map((row) => row.subjectId)).toEqual(["agent-strong", "agent-weak"]);
    // Every published cell traces to a record field, including the digest that verifies it.
    expect(board[0]?.recordDigest).toBe(strong.recordDigest);
    expect(board[0]?.trustTier).toBe("reproducible");
    expect(board[0]?.snapshotRef).toBe(SNAPSHOT);
  });

  it("a null precision ranks LAST rather than sorting as 0 — unmeasurable is not zero", async () => {
    const scored = await recordFor("agent-scored", [["merge", "merge"]]);
    const abstainer = await recordFor("agent-abstainer", [["merge", "abstain"], ["close", "abstain"]]);
    const board = deriveBenchmarkLeaderboard([abstainer, scored], "bench-2026q3");
    expect(board.map((row) => row.subjectId)).toEqual(["agent-scored", "agent-abstainer"]);
    expect(board[1]?.precision).toBeNull();
  });

  it("REGRESSION: a corrected score is a NEW record — the latest issuedAt wins, never a mutation", async () => {
    const first = await recordFor("agent-a", [["merge", "close"], ["close", "merge"]], "2026-08-01T00:00:00.000Z");
    const corrected = await recordFor("agent-a", [["merge", "merge"], ["close", "close"]], "2026-08-09T00:00:00.000Z");
    const board = deriveBenchmarkLeaderboard([first, corrected], "bench-2026q3");
    expect(board).toHaveLength(1);
    expect(board[0]?.recordDigest).toBe(corrected.recordDigest);
    expect(board[0]?.issuedAt).toBe("2026-08-09T00:00:00.000Z");
    // Order of arrival must not matter — the same set in reverse yields the same board.
    expect(deriveBenchmarkLeaderboard([corrected, first], "bench-2026q3")).toEqual(board);
  });

  it("the full ranking comparator: null-vs-null falls through to coverage, then to the earlier claim", async () => {
    // Two agents that both abstained on everything: precision is null on BOTH sides, so the null-vs-null
    // arm must fall through to coverage rather than treating them as incomparable.
    const wideAbstainer = await recordFor("agent-wide", [["merge", "merge"], ["close", "abstain"]], "2026-08-05T00:00:00.000Z");
    const totalAbstainer = await recordFor("agent-total", [["merge", "abstain"], ["close", "abstain"]], "2026-08-02T00:00:00.000Z");
    const byCoverage = deriveBenchmarkLeaderboard([totalAbstainer, wideAbstainer], "bench-2026q3");
    // Higher coverage wins even though its issuedAt is later — coverage outranks the tiebreak below it.
    expect(byCoverage.map((row) => row.subjectId)).toEqual(["agent-wide", "agent-total"]);

    // Identical precision AND identical coverage: the earlier claim keeps the position.
    const earlier = await recordFor("agent-earlier", [["merge", "merge"], ["close", "close"]], "2026-08-01T00:00:00.000Z");
    const later = await recordFor("agent-later", [["merge", "merge"], ["close", "close"]], "2026-08-20T00:00:00.000Z");
    const byClaim = deriveBenchmarkLeaderboard([later, earlier], "bench-2026q3");
    expect(byClaim.map((row) => row.subjectId)).toEqual(["agent-earlier", "agent-later"]);
    // Both orderings of the same input agree — the comparator is a total order, not arrival-dependent.
    expect(deriveBenchmarkLeaderboard([earlier, later], "bench-2026q3")).toEqual(byClaim);

    // A record with NULL coverage (an agent scored against a benchmark with no scoreable units at all)
    // sorts below one that at least faced the corpus, even though both have null precision — the `?? -1`
    // fallback, which must not collide with a genuine coverage of 0.
    const facedNothing = await recordFor("agent-nothing", [], "2026-08-04T00:00:00.000Z");
    expect(facedNothing.score.coverage).toBeNull();
    expect(totalAbstainer.score.coverage).toBe(0);
    // Asserted from BOTH argument positions so each side's own `?? -1` fallback is exercised.
    expect(deriveBenchmarkLeaderboard([facedNothing, totalAbstainer], "bench-2026q3").map((row) => row.subjectId))
      .toEqual(["agent-total", "agent-nothing"]);
    expect(deriveBenchmarkLeaderboard([totalAbstainer, facedNothing], "bench-2026q3").map((row) => row.subjectId))
      .toEqual(["agent-total", "agent-nothing"]);

    // And a null-precision row sorts last from BOTH argument positions, not just one.
    const scored = await recordFor("agent-scored", [["merge", "merge"]], "2026-08-03T00:00:00.000Z");
    expect(deriveBenchmarkLeaderboard([scored, totalAbstainer], "bench-2026q3").map((row) => row.subjectId))
      .toEqual(["agent-scored", "agent-total"]);
    expect(deriveBenchmarkLeaderboard([totalAbstainer, scored], "bench-2026q3").map((row) => row.subjectId))
      .toEqual(["agent-scored", "agent-total"]);
  });

  it("records for another benchmark, or of another work-unit kind, are excluded", async () => {
    const mine = await recordFor("agent-a", [["merge", "merge"]]);
    const otherBenchmark: EvalScoreRecord = {
      ...mine,
      subject: { kind: "agent", id: "agent-b" },
      workUnit: { kind: "benchmark_run", benchmarkId: "some-other-bench", snapshotRef: SNAPSHOT },
    };
    const otherKind: EvalScoreRecord = {
      ...mine,
      subject: { kind: "agent", id: "orb-gate" },
      workUnit: { kind: "outcome_confirmed_precision", ruleId: "missing_linked_issue" },
    };
    const board = deriveBenchmarkLeaderboard([mine, otherBenchmark, otherKind], "bench-2026q3");
    expect(board.map((row) => row.subjectId)).toEqual(["agent-a"]);
  });

  it("an empty record set yields an empty board rather than an error", () => {
    expect(deriveBenchmarkLeaderboard([], "bench-2026q3")).toEqual([]);
  });
});
