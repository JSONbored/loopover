// Benchmark leaderboard artifacts as spec-conformant EvalScoreRecords (#9265, harness #9216, epic #8534).
//
// #9216 requirement 5 is explicit: leaderboard artifacts are EXACTLY the eval-interface's consumable score
// records — no parallel format. So this module emits `EvalScoreRecord`s with `workUnit.kind ===
// "benchmark_run"` through the SAME `finalizeRecord`/digest path the `outcome_confirmed_precision` records
// already use, and the leaderboard view is derived from those records and nothing else.
//
// That last point is the structural one: there is no second query path from the scorer to the board. A
// number on the leaderboard is, by construction, a field of a record a third party can fetch, re-derive and
// digest-verify — so the published board and the consumable feed cannot disagree, because they are the same
// data read twice.
//
// Two policies are enforced HERE rather than left to a caller's discipline:
//
//   HELD-OUT CADENCE (#9263 decision 2). The emitter is where publication cadence is enforced, because it
//   is the last point before a number becomes public. A held-out record is simply not emitted while the
//   window is open — not emitted-and-filtered, not emitted-with-a-flag. A leaderboard therefore cannot leak
//   held-out membership by forgetting to check something.
//
//   TRUST TIER FROM THE ACTUAL EXECUTION (#9265 requirement 3). `attested` requires a real attestation
//   envelope to be handed in; absent one the tier is `reproducible`, never optimistically upgraded. The
//   record type's own discriminated union makes "attested without an envelope" unrepresentable, so this is
//   a compile-time guarantee rather than a runtime check that could be skipped.
import {
  EVAL_SCORE_RECORD_SCHEMA_VERSION,
  canonicalJson,
  contentDigest,
  type EvalScoreRecord,
  type EvalScoreRecordTrust,
} from "./eval-score-records";
import type { BenchmarkScoreReport, BenchmarkWindow } from "@loopover/engine";
import { heldOutPublicationDecision } from "@loopover/engine";

/** Semantics version for the `benchmark_run` work-unit kind (#9215 §5) — independent of any package
 *  version. Bump ONLY when what the numbers MEAN changes (the aggregation choice, the coverage rule, the
 *  ground-truth settlement rules), never for an unrelated refactor. */
export const BENCHMARK_RUN_SCORING_RULE_VERSION = "benchmark-run-v1";

/** Which slice a record scores. Carried in the leaderboard view (not the record) because the record's own
 *  commitments already pin the split via `splitSeed`/`heldOutFraction`, and adding a top-level field would
 *  violate #9265 requirement 1's "no extra top-level fields". */
export type BenchmarkSlice = "visible" | "held_out";

export type BenchmarkRecordInput = {
  subjectId: string;
  report: BenchmarkScoreReport;
  window: BenchmarkWindow;
  /** #9259's content-addressed snapshot checksum — the commitment that lets a third party re-derive. */
  snapshotChecksum: string;
  splitSeed: string;
  heldOutFraction: number;
  /** Real envelope evidence, or absent. Absent ⇒ `reproducible`; never asserted optimistically. */
  attestation?: { envelopeDigest: string; measurement: string; runId: string } | undefined;
  issuedAt: string;
};

function trustFrom(attestation: BenchmarkRecordInput["attestation"]): EvalScoreRecordTrust {
  return attestation ? { tier: "attested", attestation } : { tier: "reproducible" };
}

/**
 * Build ONE spec-conformant `EvalScoreRecord` for a benchmark run.
 *
 * The score block maps the multi-class report onto #9215's fixed fields without inventing any: `precision`
 * and `recall` are the MACRO numbers (#9262's recorded headline decision — the number that answers the
 * benchmark's actual question), `decided`/`abstained`/`coverage` come straight from the report's coverage
 * block, and `confirmed` is the count of decided units the agent got right. Nothing benchmark-specific is
 * bolted onto the record; a consumer that already reads `outcome_confirmed_precision` records reads these
 * with the same code.
 */
export async function buildBenchmarkEvalScoreRecord(input: BenchmarkRecordInput): Promise<EvalScoreRecord> {
  const { report } = input;
  // Micro (== accuracy under single-label scoring) times the decided count recovers the number correct,
  // which is exactly what `confirmed` means for this work-unit kind: decided units that matched reality.
  const confirmed = report.micro.accuracy === null ? 0 : Math.round(report.micro.accuracy * report.coverage.decided);
  const withoutDigest: Omit<EvalScoreRecord, "recordDigest"> = {
    schemaVersion: EVAL_SCORE_RECORD_SCHEMA_VERSION,
    subject: { kind: "agent", id: input.subjectId },
    workUnit: { kind: "benchmark_run", benchmarkId: input.window.benchmarkId, snapshotRef: report.snapshotRef },
    score: {
      decided: report.coverage.decided,
      confirmed,
      precision: report.macro.precision,
      recall: report.macro.recall,
      coverage: report.coverage.coverage,
      abstained: report.coverage.abstained,
    },
    commitments: {
      corpusChecksum: input.snapshotChecksum,
      scoringRuleVersion: BENCHMARK_RUN_SCORING_RULE_VERSION,
      windowStart: input.window.opensAt,
      windowEnd: input.window.closesAt,
      splitSeed: input.splitSeed,
      heldOutFraction: input.heldOutFraction,
    },
    trust: trustFrom(input.attestation),
    issuedAt: input.issuedAt,
  };
  return { ...withoutDigest, recordDigest: await contentDigest(withoutDigest) };
}

/**
 * Emit the publishable records for one submission, enforcing #9263's held-out cadence at this boundary.
 *
 * The visible-slice record always emits. The held-out record emits ONLY when the cadence allows it, and
 * when it does not, it is never built at all — so there is no in-memory held-out record for a downstream
 * bug to serialize. `heldOutPublication` is returned so a caller can explain the absence to a submitter
 * ("published at evaluation close") rather than leaving a silent gap that reads like a missing score.
 */
export async function buildBenchmarkEvalScoreRecords(input: {
  visible: BenchmarkRecordInput;
  heldOut: BenchmarkRecordInput;
  now: string;
}): Promise<{
  records: Array<{ slice: BenchmarkSlice; record: EvalScoreRecord }>;
  heldOutPublication: ReturnType<typeof heldOutPublicationDecision>;
}> {
  const decision = heldOutPublicationDecision(input.visible.window, input.now);
  const records: Array<{ slice: BenchmarkSlice; record: EvalScoreRecord }> = [
    { slice: "visible", record: await buildBenchmarkEvalScoreRecord(input.visible) },
  ];
  if (decision.publish) {
    records.push({ slice: "held_out", record: await buildBenchmarkEvalScoreRecord(input.heldOut) });
  }
  return { records, heldOutPublication: decision };
}

export type LeaderboardRow = {
  subjectId: string;
  benchmarkId: string;
  snapshotRef: string;
  /** The macro headline the board ranks on (#9262). `null` ranks LAST — an unmeasurable score is not a
   *  zero score, but it is also not a rankable one, and silently sorting it as 0 would invent a claim. */
  precision: number | null;
  recall: number | null;
  coverage: number | null;
  decided: number;
  abstained: number;
  trustTier: EvalScoreRecord["trust"]["tier"];
  issuedAt: string;
  recordDigest: string;
};

/**
 * Derive the leaderboard from records ONLY — there is deliberately no separate query path, so the board and
 * the consumable feed cannot disagree.
 *
 * Ranking: macro precision descending, `null` last; ties broken by coverage descending (an agent that
 * answered more of the benchmark at the same precision is doing more work), then by `issuedAt` ascending so
 * the earlier claim to a position keeps it. Immutability is respected rather than worked around: when a
 * subject has several records for the same benchmark, the LATEST `issuedAt` wins, because a corrected score
 * is a new record, never a mutation.
 */
export function deriveBenchmarkLeaderboard(records: readonly EvalScoreRecord[], benchmarkId: string): LeaderboardRow[] {
  const latestBySubject = new Map<string, EvalScoreRecord>();
  for (const record of records) {
    if (record.workUnit.kind !== "benchmark_run" || record.workUnit.benchmarkId !== benchmarkId) continue;
    const current = latestBySubject.get(record.subject.id);
    if (!current || Date.parse(record.issuedAt) > Date.parse(current.issuedAt)) latestBySubject.set(record.subject.id, record);
  }
  const rows: LeaderboardRow[] = [];
  for (const record of latestBySubject.values()) {
    /* v8 ignore next -- filtered to benchmark_run above; the guard only narrows the union for the compiler. */
    if (record.workUnit.kind !== "benchmark_run") continue;
    rows.push({
      subjectId: record.subject.id,
      benchmarkId: record.workUnit.benchmarkId,
      snapshotRef: record.workUnit.snapshotRef,
      precision: record.score.precision,
      recall: record.score.recall,
      coverage: record.score.coverage,
      decided: record.score.decided,
      abstained: record.score.abstained,
      trustTier: record.trust.tier,
      issuedAt: record.issuedAt,
      recordDigest: record.recordDigest,
    });
  }
  return rows.sort((a, b) => {
    if (a.precision !== b.precision) {
      if (a.precision === null) return 1;
      if (b.precision === null) return -1;
      return b.precision - a.precision;
    }
    const aCoverage = a.coverage ?? -1;
    const bCoverage = b.coverage ?? -1;
    if (aCoverage !== bCoverage) return bCoverage - aCoverage;
    return Date.parse(a.issuedAt) - Date.parse(b.issuedAt);
  });
}

export { canonicalJson };
