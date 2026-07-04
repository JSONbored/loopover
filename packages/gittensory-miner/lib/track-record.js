// Portable, client-side track-record summary for first-contact maintainer trust (#3008).
//
// A brand-new miner identity is, to a maintainer, indistinguishable from a spam account. This module computes a
// small, portable, non-gameable summary — merge rate, tenure, and a zero-incident attestation — a miner can present
// in a PR body on first contact, derived ENTIRELY from verifiable public outcomes (its own merged/closed PR history
// and any public moderation record). It NEVER derives from, and by construction can never surface, any internal
// scoring/reward/trust/ranking state: the rendered output is assembled only from an explicit field allowlist, so a
// caller that hands in a record polluted with internal fields still gets a clean, public-only summary. Pure and
// deterministic — tenure is measured against an injected `nowIso`, not the wall clock.

// The ONLY record fields the rendered summary is ever built from. The renderer reads nothing outside this set, so
// no internal metric (trust score, reward, ranking, weight) can reach the output even if present on the input.
export const PUBLIC_SUMMARY_FIELDS = Object.freeze([
  "mergedCount",
  "closedCount",
  "mergeRatePercent",
  "tenureDays",
  "cleanRecord",
]);

const MS_PER_DAY = 86_400_000;

function nonNegativeInt(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function parseEpochMs(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Compute the verifiable track record from public PR outcomes only. `mergedCount`/`closedCount` are real
// merged-vs-closed-without-merge counts (not self-reported); tenure is derived from a verifiable start point
// (`firstMergedAtIso`) against an injected `nowIso`; the clean-record attestation is checked against a provided
// public incident list, never asserted unconditionally.
export function computeTrackRecord(input) {
  const mergedCount = nonNegativeInt(input?.mergedCount);
  const closedCount = nonNegativeInt(input?.closedCount);
  const attempts = mergedCount + closedCount;
  // Merge rate from ACTUAL outcomes; no attempts → 0, never a divide-by-zero or an invented number.
  const mergeRatePercent = attempts === 0 ? 0 : Math.round((mergedCount / attempts) * 100);

  const firstMs = parseEpochMs(input?.firstMergedAtIso);
  const nowMs = parseEpochMs(input?.nowIso);
  // Tenure only when both endpoints are known and coherent (start not after now); otherwise 0 (unknown), never
  // a negative or fabricated span.
  const tenureDays =
    firstMs === null || nowMs === null || nowMs < firstMs ? 0 : Math.floor((nowMs - firstMs) / MS_PER_DAY);

  // Clean ONLY when a real, empty incident list is provided. A missing/unknown list is NOT a clean claim — the
  // attestation must be earned against the public moderation record, not defaulted to true.
  const incidents = Array.isArray(input?.incidents) ? input.incidents : null;
  const cleanRecord = incidents !== null && incidents.length === 0;

  return { mergedCount, closedCount, mergeRatePercent, tenureDays, cleanRecord };
}

// Reduce any record to ONLY the public allowlist fields — the hard guard. Even if `record` carries internal
// scoring/reward/trust fields, the returned object (and therefore anything rendered from it) contains none of them.
export function toPublicSummary(record) {
  return {
    mergedCount: nonNegativeInt(record?.mergedCount),
    closedCount: nonNegativeInt(record?.closedCount),
    mergeRatePercent: nonNegativeInt(record?.mergeRatePercent),
    tenureDays: nonNegativeInt(record?.tenureDays),
    cleanRecord: record?.cleanRecord === true,
  };
}

// Render a short, deterministic, single-line block for a PR description or first comment. Built strictly from
// `toPublicSummary`, so it can only ever contain public merge/tenure/incident facts. Inclusion is configurable
// per miner (`options.enabled === false` → empty string), since some operators prefer not to self-report at all.
export function renderTrackRecordSummary(record, options = {}) {
  if (options.enabled === false) return "";
  const s = toPublicSummary(record);
  const incidentClause = s.cleanRecord
    ? "no code-of-conduct incidents"
    : "code-of-conduct incidents on record";
  return (
    `Track record: ${s.mergeRatePercent}% merge rate ` +
    `(${s.mergedCount} merged / ${s.closedCount} closed) · ` +
    `${s.tenureDays} days active · ${incidentClause}`
  );
}
