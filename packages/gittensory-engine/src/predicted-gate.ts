// Predicted-gate type surface + pure helpers, extracted to `@jsonbored/gittensory-engine` (#2276) so a miner can
// model its own "will my PR pass the gate?" verdict locally with the same shapes the maintainer gate uses. This is
// the TYPES-AND-PURE-HELPERS-FIRST slice; `buildPredictedGateVerdict` itself moves in the follow-up keystone
// (#2283) once its signal dependencies are also extracted. `src/rules/predicted-gate.ts` re-exports these so
// there is exactly one definition.
//
// The engine package stays isolated from `src/` (see this package's tsconfig: `rootDir: "src"`, `types: []`), so
// the two small union shapes this surface needs from `src/types.ts` (`GatePolicyPack`) and
// `src/rules/advisory.ts` (`GateCheckConclusion`) are mirrored here rather than imported across the boundary —
// `src/` stays canonical, keep these in sync by hand (mirrors the `scoring/types.ts` convention from #2282).
// Likewise `publicSafeFinding` takes its redaction function as an argument so the engine never reaches back into
// `src/github/commands` for `sanitizePublicComment` (that sanitizer moves to the engine with
// `buildPredictedGateVerdict` in #2283).

/** Which policy pack a repo's public config selects. Local mirror of `src/types.ts`'s `GatePolicyPack` — keep in sync. */
export type GatePolicyPack = "gittensor" | "oss-anti-slop";

/** Gate check-run conclusion. Local mirror of `src/rules/advisory.ts`'s `GateCheckConclusion` — keep in sync. */
export type GateCheckConclusion = "success" | "failure" | "action_required" | "neutral" | "skipped";

/**
 * Pre-submission "will my PR pass the gate?" prediction for a MINER, computed BEFORE a PR exists.
 *
 * Parity: it runs the EXACT same engine the maintainer PR pipeline runs — buildPullRequestAdvisory +
 * evaluateGateCheck over a synthetic PR built from the contributor's local branch metadata. The verdict a
 * miner sees pre-submission is therefore the same verdict the gate would compute post-submission.
 *
 * Boundary: the gate POLICY is sourced ONLY from the repo's PUBLIC `.gittensory.yml` (`manifest.gate`) +
 * safe defaults — never the maintainer's private dashboard/DB settings. The `.gittensory.yml` is in the
 * repo and publicly viewable, so this leaks nothing a contributor could not already read. The result is
 * explicitly labelled "predicted" and notes that private overrides and AI-consensus blockers are not
 * evaluated pre-submission.
 */
export type PredictedGateVerdict = {
  predicted: true;
  basis: "public_config";
  /** Which policy pack the repo's public config selects (#692/#693). Under `oss-anti-slop` the predicted
   *  verdict applies to ANY author (no confirmed-contributor gate) — so an agent on a non-Gittensor repo
   *  gets a meaningful "will this pass?" answer with no Gittensor account. */
  pack: GatePolicyPack;
  conclusion: GateCheckConclusion;
  title: string;
  summary: string;
  readinessScore: number | null;
  confirmedContributor: boolean | undefined;
  blockers: Array<{ code: string; title: string; detail: string; action?: string | undefined }>;
  warnings: Array<{ code: string; title: string; detail: string; action?: string | undefined }>;
  /** Opt-in conversion funnel (#694): present only under the `oss-anti-slop` pack — a non-Gittensor
   *  adopter's path to "earn on Gittensor". `null` under `gittensor` (the contributor is already there). */
  funnel: { message: string; registerUrl: string } | null;
  note: string;
};

const PREDICTED_GATE_NOTE_BASE =
  "Predicted from the repo's public .gittensory.yml gate config + safe defaults. The maintainer may have " +
  "private dashboard overrides not reflected here, and the dual-model AI-consensus blocker is only " +
  "evaluated on a real PR. ";
// The slop score is ALWAYS disclaimed: it needs the diff CONTENT, which the metadata-only oracle never receives.
const PREDICTED_GATE_NOTE_SLOP = "The slop score is NOT evaluated pre-submission (it needs the diff content) and may still fail the real gate. ";
// Disclaimed only when the caller did NOT supply changed paths — then path-dependent gates can't be predicted.
const PREDICTED_GATE_NOTE_NO_PATHS =
  "Provide the PR's changed paths to also predict the focus-manifest path policy, the size/guardrail hold, and " +
  "any pre-merge check scoped to changed paths; without them only path-independent title/description/label " +
  "pre-merge checks are predicted. ";
// Shown instead of NO_PATHS once changed paths ARE supplied (#2458): the size hold can now be predicted, but only
// from file COUNT — line-diff stats are never sent to this metadata-only predictor, so a PR with many changed
// LINES across few files can still under-predict the hold the live gate would actually apply.
const PREDICTED_GATE_NOTE_SIZE_FILES_ONLY =
  "The size-hold prediction uses changed FILE count only, not changed LINE count (line-diff stats are not " +
  "available pre-submission), so it may under-predict a hold for a PR with many changed lines across few files. ";
const PREDICTED_GATE_NOTE_GATE_EQUALITY =
  "Every author is gated the same: a configured hard blocker fails the gate regardless of confirmed-contributor " +
  "status (which affects only on-chain scoring).";

/** Compose the predicted-gate note. Slop is always disclaimed; the path-policy/path-gated disclaimer drops once
 *  the caller supplies changed paths (#11-13/#18), replaced by the size-prediction file-count-only caveat (#2458). */
export function predictedGateNote(hasChangedPaths: boolean): string {
  return (
    PREDICTED_GATE_NOTE_BASE +
    PREDICTED_GATE_NOTE_SLOP +
    (hasChangedPaths ? PREDICTED_GATE_NOTE_SIZE_FILES_ONLY : PREDICTED_GATE_NOTE_NO_PATHS) +
    PREDICTED_GATE_NOTE_GATE_EQUALITY
  );
}

export type PredictedGateInput = {
  repoFullName: string;
  contributorLogin: string;
  title: string;
  body?: string | undefined;
  labels?: string[] | undefined;
  linkedIssues?: number[] | undefined;
  authorAssociation?: string | undefined;
};

/** Redact a gate finding's public-facing text for a predicted verdict. The `sanitize` function is injected
 *  (rather than imported) so this engine module stays isolated from `src/github/commands`; the backend binds it
 *  to `sanitizePublicComment`. */
export function publicSafeFinding(
  finding: { code: string; title: string; detail: string; action?: string | undefined },
  sanitize: (value: string) => string,
) {
  return {
    code: finding.code,
    title: sanitize(finding.title),
    detail: sanitize(finding.detail),
    action: finding.action ? sanitize(finding.action) : undefined,
  };
}
