import { describe, expect, it } from "vitest";
import {
  buildEvalScoreRecordsFromRulePrecision,
  EVAL_SCORE_RECORD_SCHEMA_VERSION,
  filterEvalScoreRecords,
  ORB_GATE_SUBJECT_ID,
  OUTCOME_CONFIRMED_PRECISION_SCORING_RULE_VERSION,
  verifyEvalScoreRecordDigest,
  EMPTY_CORPUS_CHECKSUM,
  type EvalScoreRecord,
} from "../../src/review/eval-score-records";
import { contentDigest, sha256Hex } from "../../src/review/decision-record";
import type { PublicRulePrecision } from "../../src/review/public-rule-precision";

const ISSUED_AT = "2026-07-27T12:00:00.000Z";

const PRECISION_WITH_FREEZE_POINT: PublicRulePrecision = {
  windowDays: 90,
  rules: [
    { ruleId: "ai_consensus_defect", decided: 25, confirmed: 20, precision: 0.8 },
    { ruleId: "sparse_rule", decided: 9, confirmed: 9, precision: null },
  ],
  reversals: { reopened: 2, reverted: 1, superseded: 3 },
  latestBacktestRun: { corpusChecksum: "abc123def456", at: "2026-07-27T10:00:00.000Z" },
};

describe("buildEvalScoreRecordsFromRulePrecision (#9266)", () => {
  it("returns an empty array when there is no persisted backtest run to commit to", async () => {
    const records = await buildEvalScoreRecordsFromRulePrecision({ ...PRECISION_WITH_FREEZE_POINT, latestBacktestRun: null }, ISSUED_AT);
    expect(records).toEqual([]);
  });

  it("refuses to publish records whose freeze point commits to an empty corpus", async () => {
    // Regression: production published decided=460/confirmed=287 alongside sha256("[]") -- a hash that is
    // byte-identical for every rule and every window, so it committed to nothing a consumer could re-derive.
    const records = await buildEvalScoreRecordsFromRulePrecision(
      { ...PRECISION_WITH_FREEZE_POINT, latestBacktestRun: { corpusChecksum: EMPTY_CORPUS_CHECKSUM, at: "2026-07-27T10:00:00.000Z" } },
      ISSUED_AT,
    );
    expect(records).toEqual([]);
  });

  it("EMPTY_CORPUS_CHECKSUM is the exporter's own checksum over zero cases", async () => {
    // scripts/backtest-corpus-export-core.ts hashes `JSON.stringify(cases.map(canonicalizeCase))`, which for
    // an empty list is the two-byte string "[]" -- re-derived here so the hard-coded constant cannot drift
    // from the exporter that produces the value it guards against. (That exporter's canonicalization and
    // canonicalJson coincide ONLY on the empty case, so this hashes the literal preimage rather than
    // round-tripping [] through either one.)
    expect(EMPTY_CORPUS_CHECKSUM).toBe(await sha256Hex("[]"));
  });

  it("builds one record per rule, committed to the freeze point's corpus checksum", async () => {
    const records = await buildEvalScoreRecordsFromRulePrecision(PRECISION_WITH_FREEZE_POINT, ISSUED_AT);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.commitments.corpusChecksum).toBe("abc123def456");
      expect(record.commitments.scoringRuleVersion).toBe(OUTCOME_CONFIRMED_PRECISION_SCORING_RULE_VERSION);
      expect(record.commitments.windowEnd).toBe(ISSUED_AT);
      expect(record.commitments.windowStart).toBe(new Date(Date.parse(ISSUED_AT) - 90 * 24 * 60 * 60 * 1000).toISOString());
      expect(record.commitments.splitSeed).toBeNull();
      expect(record.commitments.heldOutFraction).toBeNull();
      expect(record.schemaVersion).toBe(EVAL_SCORE_RECORD_SCHEMA_VERSION);
      expect(record.subject).toEqual({ kind: "agent", id: ORB_GATE_SUBJECT_ID });
      expect(record.trust).toEqual({ tier: "reproducible" });
      expect(record.issuedAt).toBe(ISSUED_AT);
    }
  });

  it("carries decided/confirmed/precision through verbatim, with recall null and abstained 0 (not applicable to this work-unit kind)", async () => {
    const records = await buildEvalScoreRecordsFromRulePrecision(PRECISION_WITH_FREEZE_POINT, ISSUED_AT);
    const withPrecision = records.find((r) => r.workUnit.kind === "outcome_confirmed_precision" && r.workUnit.ruleId === "ai_consensus_defect");
    expect(withPrecision?.score).toEqual({ decided: 25, confirmed: 20, precision: 0.8, recall: null, coverage: null, abstained: 0 });

    const sparse = records.find((r) => r.workUnit.kind === "outcome_confirmed_precision" && r.workUnit.ruleId === "sparse_rule");
    // Below the public sample floor: precision is null (never a misleading 0), decided/confirmed still real counts.
    expect(sparse?.score).toEqual({ decided: 9, confirmed: 9, precision: null, recall: null, coverage: null, abstained: 0 });
  });

  it("each record's recordDigest is the sha256 of its own canonical content (independently recomputable)", async () => {
    const records = await buildEvalScoreRecordsFromRulePrecision(PRECISION_WITH_FREEZE_POINT, ISSUED_AT);
    for (const record of records) {
      const { recordDigest, ...rest } = record;
      expect(await contentDigest(rest)).toBe(recordDigest);
    }
  });

  it("emits records sorted the same way the input rules array is ordered (no re-sort, no reordering surprise)", async () => {
    const records = await buildEvalScoreRecordsFromRulePrecision(PRECISION_WITH_FREEZE_POINT, ISSUED_AT);
    expect(records.map((r) => (r.workUnit.kind === "outcome_confirmed_precision" ? r.workUnit.ruleId : ""))).toEqual([
      "ai_consensus_defect",
      "sparse_rule",
    ]);
  });
});

describe("filterEvalScoreRecords", () => {
  const record = (ruleId: string, issuedAt: string, subjectId = ORB_GATE_SUBJECT_ID): EvalScoreRecord => ({
    schemaVersion: EVAL_SCORE_RECORD_SCHEMA_VERSION,
    subject: { kind: "agent", id: subjectId },
    workUnit: { kind: "outcome_confirmed_precision", ruleId },
    score: { decided: 10, confirmed: 8, precision: 0.8, recall: null, coverage: null, abstained: 0 },
    commitments: {
      corpusChecksum: "x",
      scoringRuleVersion: OUTCOME_CONFIRMED_PRECISION_SCORING_RULE_VERSION,
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: issuedAt,
      splitSeed: null,
      heldOutFraction: null,
    },
    trust: { tier: "reproducible" },
    issuedAt,
    recordDigest: "deadbeef",
  });

  it("returns everything when no filter is given", () => {
    const records = [record("a", "2026-07-01T00:00:00.000Z"), record("b", "2026-07-02T00:00:00.000Z")];
    expect(filterEvalScoreRecords(records, {})).toEqual(records);
  });

  it("filters by exact subject id", () => {
    const records = [record("a", "2026-07-01T00:00:00.000Z", "orb-gate"), record("b", "2026-07-01T00:00:00.000Z", "some-other-agent")];
    expect(filterEvalScoreRecords(records, { subject: "orb-gate" })).toEqual([records[0]]);
  });

  it("filters out records issued before the since timestamp", () => {
    const records = [record("old", "2026-01-01T00:00:00.000Z"), record("new", "2026-07-01T00:00:00.000Z")];
    expect(filterEvalScoreRecords(records, { since: "2026-06-01T00:00:00.000Z" })).toEqual([records[1]]);
  });

  it("excludes nothing on an unparseable since value (fail-open on a malformed optional filter)", () => {
    const records = [record("a", "2026-01-01T00:00:00.000Z")];
    expect(filterEvalScoreRecords(records, { since: "not-a-date" })).toEqual(records);
  });

  it("combines subject and since filters", () => {
    const records = [
      record("a", "2026-07-01T00:00:00.000Z", "orb-gate"),
      record("b", "2026-01-01T00:00:00.000Z", "orb-gate"),
      record("c", "2026-07-01T00:00:00.000Z", "other"),
    ];
    expect(filterEvalScoreRecords(records, { subject: "orb-gate", since: "2026-06-01T00:00:00.000Z" })).toEqual([records[0]]);
  });
});

describe("verifyEvalScoreRecordDigest", () => {
  it("returns true for a record whose digest matches its own content", async () => {
    const [record] = await buildEvalScoreRecordsFromRulePrecision(PRECISION_WITH_FREEZE_POINT, ISSUED_AT);
    expect(await verifyEvalScoreRecordDigest(record as EvalScoreRecord)).toBe(true);
  });

  it("returns false for a record whose content was tampered with after the digest was computed", async () => {
    const [record] = await buildEvalScoreRecordsFromRulePrecision(PRECISION_WITH_FREEZE_POINT, ISSUED_AT);
    const tampered: EvalScoreRecord = { ...(record as EvalScoreRecord), issuedAt: "2099-01-01T00:00:00.000Z" };
    expect(await verifyEvalScoreRecordDigest(tampered)).toBe(false);
  });
});

// #9805: on a deployment with review execution retired (the hosted Worker), no backtest run is ever
// persisted, so this surface served [] while /v1/public/eval-corpus published a complete, downloadable
// corpus for the same rule over the same window. The fallback commits each record to THAT corpus.
describe("per-rule corpus commitments when no backtest run is persisted (#9805)", () => {
  const precisionOf = (rules: PublicRulePrecision["rules"], latestBacktestRun: PublicRulePrecision["latestBacktestRun"] = null): PublicRulePrecision => ({
    windowDays: 90,
    rules,
    reversals: { reopened: 0, reverted: 0, superseded: 0 },
    latestBacktestRun,
  });
  const rule = (ruleId: string): PublicRulePrecision["rules"][number] =>
    ({ ruleId, decided: 40, confirmed: 25, precision: 0.625 }) as PublicRulePrecision["rules"][number];

  it("REGRESSION: publishes a record per rule instead of [], committing to that rule's published corpus", async () => {
    const records = await buildEvalScoreRecordsFromRulePrecision(
      precisionOf([rule("ai_consensus_defect")]),
      ISSUED_AT,
      new Map([["ai_consensus_defect", "a".repeat(64)]]),
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.commitments.corpusChecksum).toBe("a".repeat(64));
    expect(records[0]!.trust.tier).toBe("reproducible");
    await expect(verifyEvalScoreRecordDigest(records[0]!)).resolves.toBe(true);
  });

  it("REGRESSION: two rules get their OWN checksums -- one run's checksum stamped across every record was the latent bug", async () => {
    const records = await buildEvalScoreRecordsFromRulePrecision(
      precisionOf([rule("rule_a"), rule("rule_b")]),
      ISSUED_AT,
      new Map([
        ["rule_a", "a".repeat(64)],
        ["rule_b", "b".repeat(64)],
      ]),
    );
    const byRule = new Map(records.map((r) => [(r.workUnit as { ruleId: string }).ruleId, r.commitments.corpusChecksum]));
    expect(byRule.get("rule_a")).toBe("a".repeat(64));
    expect(byRule.get("rule_b")).toBe("b".repeat(64));
    expect(byRule.get("rule_a")).not.toBe(byRule.get("rule_b"));
  });

  it("omits only the rule with no commitment, still publishing the others", async () => {
    const records = await buildEvalScoreRecordsFromRulePrecision(
      precisionOf([rule("has_corpus"), rule("no_corpus")]),
      ISSUED_AT,
      new Map([["has_corpus", "c".repeat(64)]]),
    );
    expect(records.map((r) => (r.workUnit as { ruleId: string }).ruleId)).toEqual(["has_corpus"]);
  });

  it("refuses the empty-corpus checksum even when supplied as a fallback", async () => {
    const records = await buildEvalScoreRecordsFromRulePrecision(
      precisionOf([rule("ai_consensus_defect")]),
      ISSUED_AT,
      new Map([["ai_consensus_defect", EMPTY_CORPUS_CHECKSUM]]),
    );
    expect(records).toEqual([]);
  });

  it("INVARIANT: a persisted backtest run still WINS, so self-host behaviour is unchanged", async () => {
    const records = await buildEvalScoreRecordsFromRulePrecision(
      precisionOf([rule("ai_consensus_defect")], { corpusChecksum: "d".repeat(64), at: ISSUED_AT }),
      ISSUED_AT,
      new Map([["ai_consensus_defect", "e".repeat(64)]]),
    );
    expect(records[0]!.commitments.corpusChecksum).toBe("d".repeat(64));
  });

  it("falls back when the persisted run's checksum is the empty-corpus one, rather than publishing nothing", async () => {
    // The run exists but commits to nothing; the rule's real corpus does. Preferring the run here would keep
    // the surface empty for no benefit.
    const records = await buildEvalScoreRecordsFromRulePrecision(
      precisionOf([rule("ai_consensus_defect")], { corpusChecksum: EMPTY_CORPUS_CHECKSUM, at: ISSUED_AT }),
      ISSUED_AT,
      new Map([["ai_consensus_defect", "f".repeat(64)]]),
    );
    expect(records[0]!.commitments.corpusChecksum).toBe("f".repeat(64));
  });

  it("still returns [] with neither a run nor any commitment -- the #9215 rule is unchanged", async () => {
    expect(await buildEvalScoreRecordsFromRulePrecision(precisionOf([rule("ai_consensus_defect")]), ISSUED_AT)).toEqual([]);
  });
});
