// Public, anonymously-downloadable eval corpus (#9636). The verifiability walkthrough
// (apps/loopover-ui/content/docs/verify-this-review.mdx) tells a skeptic to "export the same corpus the
// numbers come from" -- but the only exporter is scripts/backtest-corpus-export.ts, which shells out to
// `wrangler d1 execute --remote` against the deployment's own database and needs THAT deployment's
// Cloudflare credentials. Step 1 was never runnable by a third party, which made the page's "nothing
// needs an API key" claim false. This is the read path that makes it true.
//
// REDACTION IS THE WHOLE DESIGN. A raw BacktestCase carries `targetKey` (literally `owner/repo#number`)
// and the firing's entire `metadata` bag. public-rule-precision.ts's own header states this surface
// publishes "no target keys, no repos, no confidence distributions, no corpus content" -- so publishing
// the raw corpus would leak exactly what the rest of the surface is careful to withhold, for PRIVATE
// repositories included. Two facts make redaction cheap rather than lossy:
//   1. `scoreBacktest` never reads `targetKey`. It only needs `ruleId` + `label` plus whatever the
//      caller's classifier reads. So the identity field can be dropped outright, not hashed -- a hash
//      would still be a stable per-PR identifier and still correlatable, for no replay benefit.
//   2. `buildConfidenceThresholdClassifier` reads `metadata.confidence` (backtest-threshold.ts:21), so
//      that one key is kept NESTED exactly where the shipped classifier looks. Flattening it to a
//      top-level field would make every replay silently degrade to the `?? 1` fallback and classify
//      every case "confirmed" -- a wrong answer that looks like a working one.
//
// Timestamps are published truncated to the DAY. Nothing in the replay path reads them (they exist for
// a human sanity-checking the window), while full-precision pairs are the one remaining vector for
// correlating a case back to a specific private-repo PR by lining it up against that repo's timeline.
//
// The checksum commits to THIS artifact -- the redacted, published bytes -- not to the internal manifest
// scripts/backtest-corpus-export.ts produces. That is the correct commitment: a reader can only re-derive
// what they can actually download, and a checksum over a preimage nobody can obtain verifies nothing
// (the exact failure #9636 fixed on the eval-score records).
import { buildBacktestCorpus } from "@loopover/engine/calibration/backtest-corpus";
import { canonicalJson, sha256Hex } from "./decision-record";
import { NON_ATTRIBUTABLE_OVERRIDE_PROVENANCES, PUBLIC_PRECISION_WINDOW_DAYS } from "./public-rule-precision";
import { createSignalStore, MAX_RULE_HISTORY_LIMIT } from "./signal-tracking-wire";

/** Hard cap on published cases. The window is already bounded, but an unbounded array on an
 *  unauthenticated route is a footgun the moment a rule gets noisy; a truncated corpus is reported
 *  honestly via `truncated` rather than silently trimmed. */
// #9805: was 5_000, which could never bind. The corpus is built from a rule-history read that
// listAuditEventsByType hard-clamps to MAX_RULE_HISTORY_LIMIT rows, so a cap above that ceiling is
// unreachable and `truncated` was structurally always false -- while /v1/public/stats counts `decided` with
// an UNBOUNDED SQL COUNT(*). The two surfaces therefore agreed only while the window stayed under the read
// bound, and would have silently diverged after that: a complete-looking corpus serving a prefix of the
// cases the published precision was computed over. Pinned to the real ceiling so the cap and the read agree.
export const PUBLIC_EVAL_CORPUS_MAX_CASES = MAX_RULE_HISTORY_LIMIT;

/** One published case: a {@link BacktestCase} minus `targetKey`, with `metadata` narrowed to the single
 *  key the shipped classifier reads. `metadata` is omitted entirely (never `undefined`) when the firing
 *  recorded no confidence, matching BacktestCase's own optional-property discipline. */
export type PublicEvalCorpusCase = {
  ruleId: string;
  outcome: string;
  label: "reversed" | "confirmed";
  firedAt: string;
  decidedAt: string;
  metadata?: { confidence: number };
};

export type PublicEvalCorpus = {
  ruleId: string;
  windowDays: number;
  caseCount: number;
  truncated: boolean;
  checksum: string;
  cases: PublicEvalCorpusCase[];
};

/** ISO instant truncated to its UTC day. See the module header for why. */
function toUtcDay(iso: string): string {
  const parsed = Date.parse(iso);
  // A row whose timestamp doesn't parse keeps its original string rather than becoming "Invalid Date":
  // the value is already only advisory here, and silently emitting a broken date would be worse.
  if (!Number.isFinite(parsed)) return iso;
  return `${new Date(parsed).toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** PURE. Strip a raw case down to its publishable shape. */
export function redactBacktestCase(input: {
  ruleId: string;
  outcome: string;
  label: "reversed" | "confirmed";
  firedAt: string;
  decidedAt: string;
  metadata?: Record<string, unknown> | undefined;
}): PublicEvalCorpusCase {
  const confidence = input.metadata?.["confidence"];
  return {
    ruleId: input.ruleId,
    outcome: input.outcome,
    label: input.label,
    firedAt: toUtcDay(input.firedAt),
    decidedAt: toUtcDay(input.decidedAt),
    ...(typeof confidence === "number" ? { metadata: { confidence } } : {}),
  };
}

/** PURE. Deterministic order for the checksum. `targetKey` -- the natural tiebreak -- is deliberately
 *  gone, so ordering falls back to the published fields themselves; two genuinely identical cases are
 *  interchangeable, so a stable total order over those fields is sufficient and reproducible. */
export function sortPublicEvalCorpusCases(cases: readonly PublicEvalCorpusCase[]): PublicEvalCorpusCase[] {
  return [...cases].sort(
    (a, b) =>
      a.firedAt.localeCompare(b.firedAt) ||
      a.decidedAt.localeCompare(b.decidedAt) ||
      a.outcome.localeCompare(b.outcome) ||
      a.label.localeCompare(b.label) ||
      (a.metadata?.confidence ?? -1) - (b.metadata?.confidence ?? -1),
  );
}

/** PURE. Apply {@link PUBLIC_EVAL_CORPUS_MAX_CASES}, reporting truncation rather than silently trimming.
 *  Split out from the loader so both arms are exercised directly -- driving the truthy side through the
 *  real store would mean seeding thousands of fired/override pairs for one boolean. */
export function applyPublicEvalCorpusCap(cases: readonly PublicEvalCorpusCase[]): { cases: PublicEvalCorpusCase[]; truncated: boolean } {
  const truncated = cases.length > PUBLIC_EVAL_CORPUS_MAX_CASES;
  return { cases: truncated ? cases.slice(0, PUBLIC_EVAL_CORPUS_MAX_CASES) : [...cases], truncated };
}

/** The published checksum: SHA-256 over the canonical JSON of the published `cases` array. Uses the same
 *  canonicalJson + Web Crypto pair every other digest in this system uses, so a consumer needs one
 *  serialization rule, not two. */
export async function checksumPublicEvalCorpus(cases: readonly PublicEvalCorpusCase[]): Promise<string> {
  return sha256Hex(canonicalJson(cases));
}

/**
 * Load one rule's publishable corpus over the same trailing window `/v1/public/stats`'s rulePrecision
 * block reports. Fail-safe: a read error yields an empty corpus (checksummed as such), never a thrown
 * public endpoint -- the same degradation contract as loadPublicRulePrecision.
 */
export async function loadPublicEvalCorpus(env: Env, ruleId: string, nowMs: number = Date.now()): Promise<PublicEvalCorpus> {
  const sinceMs = nowMs - PUBLIC_PRECISION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  let fired: Awaited<ReturnType<ReturnType<typeof createSignalStore>["queryRuleHistory"]>>["fired"] = [];
  let overrides: Awaited<ReturnType<ReturnType<typeof createSignalStore>["queryRuleHistory"]>>["overrides"] = [];
  // A read that came back at its bound almost certainly left rows behind, and a corpus that silently omits
  // them must say so -- committing a published score to a prefix, while claiming completeness, is exactly the
  // unverifiable-artifact problem this endpoint exists to solve.
  let saturated = false;
  try {
    ({ fired, overrides, saturated } = await createSignalStore(env).queryRuleHistory(ruleId, sinceMs, MAX_RULE_HISTORY_LIMIT));
  } catch {
    // Fall through to an empty corpus rather than 500ing an unauthenticated route.
  }

  // Same exclusion the published per-rule precision applies: an override whose verdict was a human
  // decision about a DIFFERENT rule cannot support a claim about this one, so it must not appear in the
  // corpus backing that claim either -- otherwise the corpus and the precision it explains disagree.
  const attributable = overrides.filter((override) => {
    const provenance = override.metadata?.["provenance"];
    return typeof provenance !== "string" || !(NON_ATTRIBUTABLE_OVERRIDE_PROVENANCES as readonly string[]).includes(provenance);
  });

  const { cases, truncated } = applyPublicEvalCorpusCap(sortPublicEvalCorpusCases(buildBacktestCorpus(ruleId, fired, attributable).map(redactBacktestCase)));

  return {
    ruleId,
    windowDays: PUBLIC_PRECISION_WINDOW_DAYS,
    caseCount: cases.length,
    // Either bound truncates: the cap on the built cases, or the read that fed it. Reporting only the former
    // is what made this field always-false.
    truncated: truncated || saturated,
    checksum: await checksumPublicEvalCorpus(cases),
    cases,
  };
}

/**
 * #9805: the publishable commitment for each of `ruleIds` -- the checksum of the corpus this deployment
 * serves at `/v1/public/eval-corpus?ruleId=...`, for rules whose corpus can actually back a claim.
 *
 * A rule is OMITTED (rather than mapped to a checksum a reader would be misled by) when:
 *
 *   • the corpus is empty -- `checksumPublicEvalCorpus([])` is the same 32 bytes for every rule, every
 *     window and every deployment, so it commits to nothing re-derivable. This is also where a failed read
 *     lands, since loadPublicEvalCorpus degrades to an empty corpus rather than throwing a public route;
 *   • the corpus is TRUNCATED at PUBLIC_EVAL_CORPUS_MAX_CASES -- the checksum would then cover a prefix of
 *     the window while the record's `decided`/`confirmed` cover all of it. A reader who re-derived scores
 *     from the published cases would get different numbers and reasonably conclude the published ones were
 *     wrong. Omitting the record says "not committed"; publishing it would say something false.
 *
 * Sequential rather than Promise.all: each call is its own D1 read over a 90-day window, and the rule list
 * is the handful that clear the publication floor -- fanning them out buys nothing and makes the read
 * burst on an unauthenticated route.
 */
export async function buildPublicCorpusCommitments(
  env: Env,
  ruleIds: readonly string[],
  nowMs: number = Date.now(),
): Promise<Map<string, string>> {
  const commitments = new Map<string, string>();
  for (const ruleId of ruleIds) {
    const corpus = await loadPublicEvalCorpus(env, ruleId, nowMs);
    if (corpus.caseCount === 0 || corpus.truncated) continue;
    commitments.set(ruleId, corpus.checksum);
  }
  return commitments;
}
