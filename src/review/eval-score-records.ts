// EvalScoreRecord (#9266, epic #8534): the v1 consumable artifact spec'd on #9215 -- the shape a validator
// (or anyone) fetches from GET /v1/public/eval-scores and independently re-derives, rather than trusting.
// This module is pure: it reshapes ALREADY-COMPUTED data (PublicRulePrecision) into the spec'd record shape.
// It adds no new scoring and no new trust -- the numbers are the same ones `/v1/public/stats` already
// publishes, just committed to a corpus checksum and made independently re-derivable per-record.
import { canonicalJson, contentDigest } from "./decision-record";
import type { PublicRulePrecision } from "./public-rule-precision";

export const EVAL_SCORE_RECORD_SCHEMA_VERSION = 1 as const;

/** Semantics version for the `outcome_confirmed_precision` work-unit kind specifically (#9215 §5) --
 *  independent of this module's own package version. Bump ONLY when what the numbers MEAN changes (e.g. the
 *  reversal-provenance rules), never for an unrelated refactor. */
export const OUTCOME_CONFIRMED_PRECISION_SCORING_RULE_VERSION = "outcome-confirmed-precision-v1";

/** Sentinel subject for `outcome_confirmed_precision` records. This work-unit kind measures ORB's OWN gate
 *  rule performance -- there is no external agent being scored, unlike a future `benchmark_run` record
 *  (#9265) whose subject is the agent under evaluation. A fixed, documented id (rather than a null/omitted
 *  subject) keeps every EvalScoreRecord's shape uniform regardless of work-unit kind. */
export const ORB_GATE_SUBJECT_ID = "orb-gate";

export type EvalScoreRecordSubject = { kind: "agent"; id: string };

export type EvalScoreRecordWorkUnit =
  | { kind: "outcome_confirmed_precision"; ruleId: string }
  | { kind: "benchmark_run"; benchmarkId: string; snapshotRef: string };

export type EvalScoreRecordScore = {
  decided: number;
  confirmed: number;
  precision: number | null;
  recall: number | null;
  coverage: number | null;
  abstained: number;
};

export type EvalScoreRecordCommitments = {
  corpusChecksum: string;
  scoringRuleVersion: string;
  windowStart: string;
  windowEnd: string;
  splitSeed: string | null;
  heldOutFraction: number | null;
};

// Discriminated union, not #9215's own loosely-typed prose (`tier` + an optional `attestation`) -- the wire
// JSON is identical either way (an "attested" record still carries `attestation` as a sibling key), but this
// makes "attested without an envelope" a compile-time impossibility instead of a runtime-checked invariant.
export type EvalScoreRecordTrust =
  | { tier: "attested"; attestation: { envelopeDigest: string; measurement: string; runId: string } }
  | { tier: "reproducible" | "asserted" };

export type EvalScoreRecord = {
  schemaVersion: typeof EVAL_SCORE_RECORD_SCHEMA_VERSION;
  subject: EvalScoreRecordSubject;
  workUnit: EvalScoreRecordWorkUnit;
  score: EvalScoreRecordScore;
  commitments: EvalScoreRecordCommitments;
  trust: EvalScoreRecordTrust;
  issuedAt: string;
  recordDigest: string;
};

/** Everything about an EvalScoreRecord except its own digest -- the exact preimage `contentDigest` hashes,
 *  so `recordDigest` always commits to the record's OWN content and never to itself. */
type EvalScoreRecordDigestInput = Omit<EvalScoreRecord, "recordDigest">;

async function finalizeRecord(input: EvalScoreRecordDigestInput): Promise<EvalScoreRecord> {
  const recordDigest = await contentDigest(input);
  return { ...input, recordDigest };
}

/**
 * Build `EvalScoreRecord`s from the already-computed public rule-precision block. Returns an empty array
 * when there is no persisted backtest run yet (`latestBacktestRun === null`) -- per #9215's own requirement,
 * a record whose commitments cannot be independently re-derived (no corpus checksum to point at) is not
 * publishable, so this deliberately emits nothing rather than a record with a placeholder commitment.
 *
 * `recall` and `abstained` do not apply to this work-unit kind: ORB's gate rules fire deterministically (no
 * agent choosing to abstain) and this data measures precision, not a false-negative rate. `recall` is
 * `null` (genuinely inapplicable, never a misleading `0`); `abstained` is `0` (there is no abstention
 * concept here, so `0` is the correct value, not a masked null). PURE -- no IO, no clock (the caller
 * supplies `issuedAt`).
 */
export async function buildEvalScoreRecordsFromRulePrecision(precision: PublicRulePrecision, issuedAt: string): Promise<EvalScoreRecord[]> {
  if (!precision.latestBacktestRun) return [];
  const { corpusChecksum } = precision.latestBacktestRun;
  const windowStart = new Date(Date.parse(issuedAt) - precision.windowDays * 24 * 60 * 60 * 1000).toISOString();

  const records = await Promise.all(
    precision.rules.map((row) =>
      finalizeRecord({
        schemaVersion: EVAL_SCORE_RECORD_SCHEMA_VERSION,
        subject: { kind: "agent", id: ORB_GATE_SUBJECT_ID },
        workUnit: { kind: "outcome_confirmed_precision", ruleId: row.ruleId },
        score: {
          decided: row.decided,
          confirmed: row.confirmed,
          precision: row.precision,
          recall: null,
          coverage: null,
          abstained: 0,
        },
        commitments: {
          corpusChecksum,
          scoringRuleVersion: OUTCOME_CONFIRMED_PRECISION_SCORING_RULE_VERSION,
          windowStart,
          windowEnd: issuedAt,
          splitSeed: null,
          heldOutFraction: null,
        },
        trust: { tier: "reproducible" },
        issuedAt,
      }),
    ),
  );
  return records;
}

export type EvalScoreRecordFilter = { subject?: string; since?: string };

/** Filter already-built records by subject id and/or a minimum `issuedAt` -- pure, used identically by the
 *  route handler and by tests, so the two can never apply different filtering logic. An invalid `since`
 *  (fails to parse) excludes nothing, matching this system's general fail-open posture for optional query
 *  filters rather than erroring the whole response over one bad parameter. */
export function filterEvalScoreRecords(records: readonly EvalScoreRecord[], filter: EvalScoreRecordFilter): EvalScoreRecord[] {
  const sinceMs = filter.since ? Date.parse(filter.since) : Number.NaN;
  return records.filter((record) => {
    if (filter.subject && record.subject.id !== filter.subject) return false;
    if (!Number.isNaN(sinceMs) && Date.parse(record.issuedAt) < sinceMs) return false;
    return true;
  });
}

/** Recompute a record's digest and compare -- the exact check a consumer runs to verify a fetched record
 *  without trusting the transport. Exported so both this module's own tests and a future CLI/docs example
 *  exercise the identical recomputation, never a parallel reimplementation. */
export async function verifyEvalScoreRecordDigest(record: EvalScoreRecord): Promise<boolean> {
  const { recordDigest, ...rest } = record;
  return (await contentDigest(rest)) === recordDigest;
}

// Re-exported so callers that only import this module never need a second import from decision-record.ts
// just to canonicalize something alongside a record (e.g. logging, or a future signed-bundle wrapper).
export { canonicalJson, contentDigest };
