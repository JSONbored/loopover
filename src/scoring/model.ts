import {
  getLatestScoringModelSnapshot,
  persistScoringModelSnapshot,
} from "../db/repositories";
import { getLatestRegistrySnapshot } from "../registry/sync";
import { syncUnmodeledScoringConstantDrift } from "../upstream/unmodeled-scoring-drift";
import type { JsonValue, ScoringModelSnapshotRecord } from "../types";
import { errorMessage, nowIso } from "../utils/json";

export const DEFAULT_ISSUE_DISCOVERY_SHARE = 0.5;

export const DEFAULT_SCORING_CONSTANTS: Record<string, number> = {
  OSS_EMISSION_SHARE: 0.9,
  // Upstream name is ISSUES_TREASURY_EMISSION_SHARE (plural). The prior singular spelling never matched
  // upstream, freezing this at the local default and showing up as a false "unmodeled" drift warning (#806).
  ISSUES_TREASURY_EMISSION_SHARE: 0.1,
  // Lookback window used upstream for PR history; stored so it syncs and does not surface as unmodeled drift.
  PR_LOOKBACK_DAYS: 30,
  MERGED_PR_BASE_SCORE: 25,
  // Upstream MAX_CONTRIBUTION_BONUS is 5. This local value is only the fetch-failure fallback; keeping it at
  // 25 silently 5x-inflated the contribution bonus whenever the upstream fetch failed (#807).
  MAX_CONTRIBUTION_BONUS: 5,
  CONTRIBUTION_SCORE_FOR_FULL_BONUS: 1500,
  // Applied in preview.ts when computing totalTokenScore from components (#808).
  TEST_FILE_CONTRIBUTION_WEIGHT: 0.05,
  // Upstream-enforced eligibility floors for PR and issue-discovery history (#808).
  // These gate whether a validator counts a contributor's submissions, not the per-PR/issue score itself.
  // Stored here so they sync from upstream and no longer appear as unmodeled drift warnings.
  MIN_VALID_MERGED_PRS: 3,
  MIN_CREDIBILITY: 0.8,
  MIN_VALID_SOLVED_ISSUES: 3,
  MIN_ISSUE_CREDIBILITY: 0.8,
  MIN_TOKEN_SCORE_FOR_VALID_ISSUE: 5,
  // Open-issue spam gate constants — wired into the issue-discovery scoring lane in preview.ts (#808).
  OPEN_ISSUE_SPAM_BASE_THRESHOLD: 2,
  OPEN_ISSUE_SPAM_TOKEN_SCORE_PER_SLOT: 300,
  MAX_OPEN_ISSUE_THRESHOLD: 30,
  OPEN_PR_COLLATERAL_PERCENT: 0.2,
  MAX_OPEN_PR_REVIEW_COLLATERAL_MULTIPLIER: 2.0,
  MAX_LINES_SCORED_FOR_NON_CODE_EXT: 300,
  DEFAULT_ISSUE_DISCOVERY_SHARE,
  REVIEW_PENALTY_RATE: 0.15,
  STANDARD_ISSUE_MULTIPLIER: 1.33,
  MAINTAINER_ISSUE_MULTIPLIER: 1.66,
  EXCESSIVE_PR_PENALTY_BASE_THRESHOLD: 2,
  OPEN_PR_THRESHOLD_TOKEN_SCORE: 300,
  MAX_OPEN_PR_THRESHOLD: 30,
  SRC_TOK_SATURATION_SCALE: 58,
  // Upstream time-decay (#703): a merged PR's score decays on a sigmoid after a grace period. Modeled here
  // so they no longer surface as unmodeled drift (#690); APPLICATION is opt-in + default-off (see preview).
  TIME_DECAY_GRACE_PERIOD_HOURS: 12,
  TIME_DECAY_SIGMOID_MIDPOINT: 10,
  TIME_DECAY_SIGMOID_STEEPNESS_SCALAR: 0.4,
  TIME_DECAY_MIN_MULTIPLIER: 0.05,
};

export const DEFAULT_GITTENSOR_UPSTREAM_REPO = "entrius/gittensor";
export const DEFAULT_GITTENSOR_UPSTREAM_REF = "test";

function scoringUpstreamConfig(env: Env): { repo: string; ref: string } {
  return {
    repo: env.GITTENSOR_UPSTREAM_REPO || DEFAULT_GITTENSOR_UPSTREAM_REPO,
    ref: env.GITTENSOR_UPSTREAM_REF || DEFAULT_GITTENSOR_UPSTREAM_REF,
  };
}

function upstreamRawUrl(config: { repo: string; ref: string }, path: string): string {
  return `https://raw.githubusercontent.com/${config.repo}/${encodeURIComponent(config.ref)}/${path}`;
}

// Fetch the HEAD commit SHA of the upstream ref for audit trail. Fail-open: a network hiccup or a
// missing administration token must never block the constants refresh itself.
async function fetchUpstreamRefSha(upstream: { repo: string; ref: string }, token: string | undefined): Promise<string | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${upstream.repo}/commits/${encodeURIComponent(upstream.ref)}`, { headers: githubHeaders(token, "application/vnd.github+json") });
    if (!response.ok) return null;
    const data = (await response.json()) as { sha?: string };
    return typeof data.sha === "string" && data.sha.length > 0 ? data.sha : null;
  } catch {
    return null;
  }
}

const SCORING_CONSTANT_NAMES = new Set([...Object.keys(DEFAULT_SCORING_CONSTANTS), "MIN_TOKEN_SCORE_FOR_BASE_SCORE", "MAX_CODE_DENSITY_MULTIPLIER"]);

// Sanity floor for a 200 constants.py body. A real upstream file defines ~30 recognized constants; an HTML
// interstitial, a Git-LFS pointer, or a truncated body parses to ~0. Below this, treat the body as non-source
// and fail closed rather than reverting live scoring to defaults under a "raw-github" label. (#audit-3.6)
const MIN_RECOGNIZED_SCORING_CONSTANTS = 8;

export async function refreshScoringModelSnapshot(env: Env): Promise<ScoringModelSnapshotRecord> {
  const warnings: string[] = [];
  const fetchedAt = nowIso();
  const upstream = scoringUpstreamConfig(env);
  // Pin the fetch to the upstream ref's immutable HEAD commit SHA so a force-push / branch-rename can't silently
  // change what every repo scores against: resolve ref → SHA first, then fetch the constants AT that SHA (an
  // atomic SHA↔constants binding, recorded in the payload). Best-effort — if the SHA can't be resolved (a
  // transient API error) fall back to the mutable ref so a refresh is never blocked purely on the SHA lookup.
  const upstreamSourceSha = await fetchUpstreamRefSha(upstream, env.GITHUB_PUBLIC_TOKEN);
  const fetchRef = upstreamSourceSha ?? upstream.ref;
  // Surface the unpinned fall-back: when the SHA can't be resolved we fetch from the MUTABLE ref, so a later
  // upstream force-push could change what every repo scores against with no other signal. (#audit-3.6/drift)
  if (!upstreamSourceSha) warnings.push(`Could not resolve upstream ${upstream.repo}@${upstream.ref} to an immutable commit SHA; fetched from the mutable ref (scoring is unpinned until the next successful resolve).`);
  const constantsUrl = upstreamRawUrl({ repo: upstream.repo, ref: fetchRef }, "gittensor/constants.py");
  const programmingLanguagesUrl = upstreamRawUrl({ repo: upstream.repo, ref: fetchRef }, "gittensor/validator/weights/programming_languages.json");
  const [registrySnapshot, constantsResult, languagesResult] = await Promise.all([
    getLatestRegistrySnapshot(env),
    fetchText(constantsUrl, env.GITHUB_PUBLIC_TOKEN),
    fetchJson(programmingLanguagesUrl, env.GITHUB_PUBLIC_TOKEN),
  ]);

  // Parse once. `recognizedCount` tells us whether a 200 body is a REAL constants.py or semantically garbage —
  // an HTML interstitial, a Git-LFS pointer, or a truncated body — which parses to ~0 known scoring constants.
  const parsedConstants = constantsResult.ok ? parsePythonNumberConstants(constantsResult.value) : {};
  const recognizedCount = Object.keys(parsedConstants).filter((name) => SCORING_CONSTANT_NAMES.has(name)).length;
  const constantsUsable = constantsResult.ok && recognizedCount >= MIN_RECOGNIZED_SCORING_CONSTANTS;

  // FAIL-CLOSED (#scoring-fail-closed, #audit-3.6): a failed OR semantically-garbage constants fetch must NEVER
  // silently overwrite the last verified upstream constants with hardcoded DEFAULT_SCORING_CONSTANTS — that would
  // move live scoring with no one noticing. Freeze the last-good snapshot instead (its age is surfaced by
  // scoringSnapshotStalenessWarning), and only bootstrap to defaults when there is no verified last-good.
  if (!constantsUsable) {
    const lastGood = await getLatestScoringModelSnapshot(env);
    if (lastGood && lastGood.sourceKind !== "fallback") {
      const reason = constantsResult.ok
        ? `parsed only ${recognizedCount} recognized constant(s) (expected ≥ ${MIN_RECOGNIZED_SCORING_CONSTANTS}) — body looks truncated or non-source`
        : constantsResult.error;
      const frozenNote = `Upstream scoring constants refresh failed (${reason}); froze the last-good snapshot rather than reverting to default constants.`;
      return { ...lastGood, warnings: [...lastGood.warnings, frozenNote] };
    }
  }

  let sourceKind: ScoringModelSnapshotRecord["sourceKind"] = "raw-github";
  let constants = { ...DEFAULT_SCORING_CONSTANTS };
  let activeModelConstants: Record<string, number> = {};
  let constantsPayload: Record<string, JsonValue> = {};

  if (constantsResult.ok && constantsUsable) {
    const parsed = parsedConstants;
    constants = { ...constants, ...parsed };
    activeModelConstants = parsed;
    const unmodeled = findUnmodeledUpstreamConstants(constantsResult.value);
    constantsPayload = { parsedConstantCount: Object.keys(parsed).length, sourceBytes: constantsResult.value.length, unmodeledUpstreamConstants: unmodeled };
    warnings.push(...activeModelWarnings(parsed));
    // Make staleness visible: upstream defines scoring constants gittensory does not yet model.
    if (unmodeled.length > 0) {
      warnings.push(
        `Upstream gittensor defines ${unmodeled.length} scoring constant(s) gittensory does not yet model: ${unmodeled.slice(0, 12).join(", ")}${unmodeled.length > 12 ? ", …" : ""}. Scoring may be behind upstream.`,
      );
    }
  } else {
    sourceKind = "fallback";
    warnings.push(
      constantsResult.ok
        ? `Scoring constants body parsed only ${recognizedCount} recognized constant(s) (expected ≥ ${MIN_RECOGNIZED_SCORING_CONSTANTS}); using default constants.`
        : `Scoring constants fetch failed: ${constantsResult.error}`,
    );
  }

  const programmingLanguages = languagesResult.ok ? languagesResult.value : {};
  if (!languagesResult.ok) warnings.push(`Programming language weights fetch failed: ${languagesResult.error}`);

  const snapshot: ScoringModelSnapshotRecord = {
    id: crypto.randomUUID(),
    sourceKind,
    sourceUrl: constantsUrl,
    fetchedAt,
    activeModel: detectActiveModel(activeModelConstants),
    constants,
    programmingLanguages: programmingLanguages as Record<string, JsonValue>,
    registrySnapshotId: registrySnapshot?.id,
    warnings,
    payload: {
      constants: constantsPayload,
      programmingLanguagesSourceUrl: programmingLanguagesUrl,
      registryRepoCount: registrySnapshot?.repoCount ?? 0,
      ...(upstreamSourceSha ? { upstreamSourceSha } : {}),
    },
  };
  await persistScoringModelSnapshot(env, snapshot);
  if (constantsResult.ok) {
    await syncUnmodeledScoringConstantDrift(env, {
      unmodeledConstants: findUnmodeledUpstreamConstants(constantsResult.value),
      source: { repo: upstream.repo, ref: fetchRef, commitSha: upstreamSourceSha },
    });
  }
  return snapshot;
}

// Mirror Pipeline B's UPSTREAM_STALE_MS (upstream/ruleset.ts): a served scoring snapshot older than this
// window means the last upstream refresh failed or has not run, so previews are quietly using last-good (or
// DEFAULT) constants with no other staleness signal on the scoring side (#810).
export const SCORING_SNAPSHOT_STALE_MS = 2 * 60 * 60 * 1000;

export function scoringSnapshotStalenessWarning(snapshot: Pick<ScoringModelSnapshotRecord, "fetchedAt">, now: number = Date.now()): string | null {
  if (Date.parse(snapshot.fetchedAt) + SCORING_SNAPSHOT_STALE_MS >= now) return null;
  return "Scoring constants snapshot is stale: the last upstream refresh is older than the freshness window, so scoring may be using last-good or default constants and be behind upstream.";
}

export async function getOrCreateScoringModelSnapshot(env: Env): Promise<ScoringModelSnapshotRecord> {
  const snapshot = (await getLatestScoringModelSnapshot(env)) ?? (await refreshScoringModelSnapshot(env));
  // Surface staleness so previews do not silently use last-good/DEFAULT constants after a failed/old refresh (#810).
  const stalenessWarning = scoringSnapshotStalenessWarning(snapshot);
  return stalenessWarning ? { ...snapshot, warnings: [...snapshot.warnings, stalenessWarning] } : snapshot;
}

export function parsePythonNumberConstants(source: string, options: { knownOnly?: boolean } = { knownOnly: true }): Record<string, number> {
  const constants: Record<string, number> = {};
  for (const line of source.split("\n")) {
    // Match Python numeric literals including underscore separators in integer and fractional parts
    // (1_000_000, 0.000_001, 3.14_15), floats, and exponents (1e-9, 5.8e1). The previous regex only
    // allowed `_` in the integer part, truncating 0.000_001 -> 0 and 3.14_15 -> 3.14 (#992).
    const match = line.match(/^([A-Z][A-Z0-9_]+)\s*=\s*([-+]?(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][-+]?\d+)?)/);
    if (!match) continue;
    const name = match[1]!;
    const raw = match[2]!;
    if (options.knownOnly !== false && !SCORING_CONSTANT_NAMES.has(name)) continue;
    // Number() rejects underscore separators, so strip them before parsing.
    constants[name] = Number(raw.replace(/_/g, ""));
  }
  return constants;
}

/**
 * Upstream operational/infra constants gittensory intentionally does not model in score previews.
 * They are not scoring dimensions — surfacing them as "unmodeled drift" is noise (#809).
 */
const NON_SCORING_UPSTREAM_CONSTANT_NAMES = new Set([
  "SECONDS_PER_DAY",
  "SECONDS_PER_HOUR",
  "GITHUB_HTTP_TIMEOUT_SECONDS",
  "MIRROR_HTTP_TIMEOUT_SECONDS",
  "MIRROR_MAX_ATTEMPTS",
  "TREE_SITTER_PARSE_TIMEOUT_MICROS",
  "SCORING_SUBPROCESS_BUDGET_S",
  "MAX_FILE_SIZE_BYTES",
  "RECYCLE_UID",
  "ISSUES_TREASURY_UID",
  "MAX_ISSUE_ID",
]);

/**
 * Numeric constant names upstream gittensor defines that gittensory's scoring engine does NOT model.
 * The normal parse is `knownOnly` (it keeps only constants we already encode), which silently hides
 * upstream ADDITIONS — e.g. a newly-introduced time-decay constant. Surfacing these makes scoring
 * staleness visible: if upstream adds a scoring dimension, an operator sees it instead of the gate
 * silently drifting behind. Detection only — it does not change any score.
 */
export function findUnmodeledConstantKeys(allConstants: Record<string, number>): string[] {
  return Object.keys(allConstants)
    .filter((name) => !SCORING_CONSTANT_NAMES.has(name) && !NON_SCORING_UPSTREAM_CONSTANT_NAMES.has(name))
    .sort();
}

export function findUnmodeledUpstreamConstants(source: string): string[] {
  return findUnmodeledConstantKeys(parsePythonNumberConstants(source, { knownOnly: false }));
}

/**
 * Owner-controlled global gate for applying upstream time-decay to score previews (#703). Default OFF: the
 * roadmap deferral requires the owner to review a before/after ranking diff before enabling. Even when on,
 * a fresh PR is unaffected (decay 1.0), so it only changes aged-PR projections.
 */
export function isTimeDecayEnabled(env: Env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SCORING_TIME_DECAY_ENABLED ?? "");
}

export function detectActiveModel(constants: Record<string, number>): ScoringModelSnapshotRecord["activeModel"] {
  if (hasSaturationConstants(constants)) return "pending_saturation_model";
  if (hasDensityConstants(constants)) {
    return "current_density_model";
  }
  return "unknown";
}

function activeModelWarnings(constants: Record<string, number>): string[] {
  const hasSaturation = hasSaturationConstants(constants);
  const hasDensity = hasDensityConstants(constants);
  if (hasSaturation && hasDensity) {
    return ["Scoring constants include both exponential saturation and density-era indicators; using exponential saturation as the active model."];
  }
  if (!hasSaturation && !hasDensity) return ["Scoring constants did not include a recognized active-model indicator."];
  return [];
}

function hasSaturationConstants(constants: Record<string, number>): boolean {
  return Number.isFinite(constants.SRC_TOK_SATURATION_SCALE);
}

function hasDensityConstants(constants: Record<string, number>): boolean {
  return Number.isFinite(constants.MAX_CODE_DENSITY_MULTIPLIER) && Number.isFinite(constants.MIN_TOKEN_SCORE_FOR_BASE_SCORE);
}

async function fetchText(url: string, token?: string): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, { headers: githubHeaders(token, "text/plain") });
    if (!response.ok) return { ok: false, error: `${response.status} ${response.statusText}` };
    return { ok: true, value: await response.text() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function fetchJson(url: string, token?: string): Promise<{ ok: true; value: Record<string, JsonValue> } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, { headers: githubHeaders(token, "application/json") });
    if (!response.ok) return { ok: false, error: `${response.status} ${response.statusText}` };
    return { ok: true, value: (await response.json()) as Record<string, JsonValue> };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function githubHeaders(token: string | undefined, accept: string): Record<string, string> {
  return {
    accept,
    "user-agent": "gittensory/0.1",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}
