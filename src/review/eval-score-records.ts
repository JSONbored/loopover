// EvalScoreRecord (#9266, epic #8534): the v1 consumable artifact spec'd on #9215 -- the shape a validator
// (or anyone) fetches from GET /v1/public/eval-scores and independently re-derives, rather than trusting.
// This module is pure: it reshapes ALREADY-COMPUTED data (PublicRulePrecision) into the spec'd record shape.
// It adds no new scoring and no new trust -- the numbers are the same ones `/v1/public/stats` already
// publishes, just committed to a corpus checksum and made independently re-derivable per-record.
import { canonicalJson, contentDigest } from "./decision-record";
import { EMPTY_CORPUS_CHECKSUM, type PublicRulePrecision } from "./public-rule-precision";

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

/** #9215's coverage definition -- `decided / (decided + abstained)` -- as the single implementation every
 *  work-unit kind derives from, so a record's published `coverage` and a validator's re-derivation of it can
 *  never disagree. `null` only when nothing was seen at all (`0/0` is undefined, not zero): that is the same
 *  guard-the-denominator-else-null shape {@link PublicRulePrecisionRow.precision} uses below its sample floor
 *  (`public-rule-precision.ts`), never a masked `0`. Exported so a future emitter (#9265's `benchmark_run`)
 *  states coverage by calling this rather than restating the formula. */
export function evalScoreCoverage(decided: number, abstained: number): number | null {
  const total = decided + abstained;
  return total > 0 ? decided / total : null;
}

/**
 * Build `EvalScoreRecord`s from the already-computed public rule-precision block. A rule is published only
 * when `corpusChecksumByRuleId` carries a usable commitment for it -- per #9215's own requirement, a record
 * whose commitments cannot be independently re-derived is not publishable, so this deliberately emits nothing
 * rather than a record with a placeholder commitment.
 *
 * #9805: that commitment is the checksum of the corpus `/v1/public/eval-corpus` publishes for that same rule,
 * over the same window. It is not a placeholder standing in for a real commitment: it is a hash over an
 * artifact the reader can download and re-hash themselves, which is exactly what the `reproducible` trust tier
 * asserts.
 *
 * #9962: it is also the ONLY commitment source. `precision.latestBacktestRun.corpusChecksum` used to take
 * precedence wherever a run was persisted, which was wrong three ways at once and wrong precisely on the
 * deployments that execute reviews (the hosted Worker has execution retired, so it never hit this path and the
 * defect stayed invisible there):
 *
 *   1. It is NOT DOWNLOADABLE. That checksum is `checksumCases` over the raw internal `BacktestCase[]` --
 *      `targetKey`, the full metadata bag, full-precision timestamps -- whereas the corpus a reader can fetch
 *      is the REDACTED one. The two hash different bytes by construction, so the published commitment could
 *      never match the published corpus, no matter how healthy the deployment. Pairing that with
 *      `trust.tier: "reproducible"` asserts a reproducibility the artifact cannot support.
 *   2. It is GLOBAL, not per rule. `loadPublicRulePrecision` selects it with `ORDER BY created_at DESC LIMIT 1`
 *      and no rule filter, so one rule's freeze point got stamped onto every record. This module already
 *      warned that stamping one checksum across every record would have every record but one committing to a
 *      different rule's cases, and called it latent "only because a single rule clears the publication floor";
 *      on a self-host ledger where seven rules clear it, it stopped being latent.
 *   3. It is UNWINDOWED. That same query has no `created_at >= ?` bound, so the run could predate the
 *      `windowStart`/`windowEnd` the record goes on to declare.
 *
 * `latestBacktestRun` remains published in its own right as the rule-precision block's freeze point (see
 * public-rule-precision.ts); it is only no longer misused as a public, re-derivable corpus commitment.
 *
 * The commitment is resolved PER RULE, not once for the whole batch. Each rule's score is computed over its
 * own corpus, so one checksum across every record would be a different rule's cases on all but one of them.
 *
 * Also omits a rule whose checksum is {@link EMPTY_CORPUS_CHECKSUM}. A hash over zero
 * cases is the same 32 bytes for every rule, every window, and every deployment, so it points at nothing a
 * consumer could re-derive the scores from -- it is a placeholder commitment wearing a real hash's clothes,
 * and pairing it with a `reproducible` trust tier claims a reproducibility the artifact cannot support. The
 * scores themselves come from a different dataset (live human-override events) and are unaffected by whether
 * a corpus was exported, so an empty corpus never means the numbers are zero -- it means they are
 * uncommitted, which is exactly the state #9215 says must not be published.
 *
 * `recall` and `abstained` do not apply to this work-unit kind: ORB's gate rules fire deterministically (no
 * agent choosing to abstain) and this data measures precision, not a false-negative rate. `recall` is
 * `null` (genuinely inapplicable, never a misleading `0`); `abstained` is `0` (there is no abstention
 * concept here, so `0` is the correct value, not a masked null). `coverage` follows from that `abstained`:
 * with no abstention concept the denominator is just `decided`, so every rule that decided anything covered
 * all of it and states `1` -- computed via {@link evalScoreCoverage}, never hardcoded, so it stays correct
 * for a kind that does abstain. It was previously `null` by symmetry with `recall`, which published "coverage
 * unknown" for a quantity the record's own `decided`/`abstained` pin down exactly, so a validator re-deriving
 * per #9215 computed `1` and disagreed with the field (#9643). Only `decided === 0` is genuinely undefined
 * (`0/0`) and stays `null`. PURE -- no IO, no clock (the caller supplies `issuedAt`).
 */
export async function buildEvalScoreRecordsFromRulePrecision(
  precision: PublicRulePrecision,
  issuedAt: string,
  // The per-rule commitments, supplied by the caller so this module stays PURE. Only rules whose published
  // corpus is a usable commitment belong in here -- buildPublicCorpusCommitments drops degraded reads, empty
  // corpora and truncated ones before building it, because a truncated corpus's checksum covers a subset of
  // the cases the score covers. Defaulted to an empty map so a caller with nothing to commit publishes nothing
  // (#9962: this is now the sole source, so the default means "no records", never "fall back to the run").
  corpusChecksumByRuleId: ReadonlyMap<string, string> = new Map(),
): Promise<EvalScoreRecord[]> {
  const windowStart = new Date(Date.parse(issuedAt) - precision.windowDays * 24 * 60 * 60 * 1000).toISOString();

  // A rule with no usable commitment is OMITTED rather than published with a placeholder -- the #9215
  // requirement this module has always enforced, now applied per rule instead of to the whole batch.
  const publishable = precision.rules.flatMap((row) => {
    const corpusChecksum = corpusChecksumByRuleId.get(row.ruleId) ?? null;
    return corpusChecksum === null || corpusChecksum === EMPTY_CORPUS_CHECKSUM ? [] : [{ row, corpusChecksum }];
  });

  const records = await Promise.all(
    publishable.map(({ row, corpusChecksum }) =>
      finalizeRecord({
        schemaVersion: EVAL_SCORE_RECORD_SCHEMA_VERSION,
        subject: { kind: "agent", id: ORB_GATE_SUBJECT_ID },
        workUnit: { kind: "outcome_confirmed_precision", ruleId: row.ruleId },
        score: {
          decided: row.decided,
          confirmed: row.confirmed,
          precision: row.precision,
          recall: null,
          // Same literal `0` the sibling `abstained` publishes, passed rather than re-stated, so the two can
          // never drift into a record whose coverage contradicts its own abstention count.
          coverage: evalScoreCoverage(row.decided, 0),
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

// `| undefined` is explicit (not just `?:`) because the root tsconfig sets exactOptionalPropertyTypes and
// the route handler passes `c.req.query(...)`'s `string | undefined` results straight through.
export type EvalScoreRecordFilter = { subject?: string | undefined; since?: string | undefined };

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
export { EMPTY_CORPUS_CHECKSUM };
