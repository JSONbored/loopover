import {
  getLatestScoringModelSnapshot,
  persistScoringModelSnapshot,
} from "../db/repositories";
import { getLatestRegistrySnapshot } from "../registry/sync";
import type { JsonValue, ScoringModelSnapshotRecord } from "../types";
import { errorMessage, nowIso } from "../utils/json";

export const DEFAULT_SCORING_CONSTANTS: Record<string, number> = {
  OSS_EMISSION_SHARE: 0.9,
  ISSUE_TREASURY_EMISSION_SHARE: 0.1,
  PR_LOOKBACK_DAYS: 30,
  MERGED_PR_BASE_SCORE: 25,
  MAX_CONTRIBUTION_BONUS: 25,
  CONTRIBUTION_SCORE_FOR_FULL_BONUS: 1500,
  TEST_FILE_CONTRIBUTION_WEIGHT: 0.05,
  MIN_VALID_MERGED_PRS: 3,
  MIN_CREDIBILITY: 0.8,
  MIN_VALID_SOLVED_ISSUES: 3,
  MIN_ISSUE_CREDIBILITY: 0.8,
  MIN_TOKEN_SCORE_FOR_VALID_ISSUE: 5,
  OPEN_ISSUE_SPAM_BASE_THRESHOLD: 2,
  OPEN_ISSUE_SPAM_TOKEN_SCORE_PER_SLOT: 300,
  MAX_OPEN_ISSUE_THRESHOLD: 30,
  OPEN_PR_COLLATERAL_PERCENT: 0.2,
  REVIEW_PENALTY_RATE: 0.15,
  STANDARD_ISSUE_MULTIPLIER: 1.33,
  MAINTAINER_ISSUE_MULTIPLIER: 1.66,
  EXCESSIVE_PR_PENALTY_BASE_THRESHOLD: 2,
  OPEN_PR_THRESHOLD_TOKEN_SCORE: 300,
  MAX_OPEN_PR_THRESHOLD: 30,
  SRC_TOK_SATURATION_SCALE: 58,
};

export const SCORING_CONSTANTS_URL =
  "https://raw.githubusercontent.com/entrius/gittensor/test/gittensor/constants.py";
export const PROGRAMMING_LANGUAGES_URL =
  "https://raw.githubusercontent.com/entrius/gittensor/test/gittensor/validator/weights/programming_languages.json";

const SCORING_CONSTANT_NAMES = new Set([...Object.keys(DEFAULT_SCORING_CONSTANTS), "MIN_TOKEN_SCORE_FOR_BASE_SCORE", "MAX_CODE_DENSITY_MULTIPLIER"]);

export async function refreshScoringModelSnapshot(env: Env): Promise<ScoringModelSnapshotRecord> {
  const warnings: string[] = [];
  const fetchedAt = nowIso();
  const [registrySnapshot, constantsResult, languagesResult] = await Promise.all([
    getLatestRegistrySnapshot(env),
    fetchText(SCORING_CONSTANTS_URL, env.GITHUB_PUBLIC_TOKEN),
    fetchJson(PROGRAMMING_LANGUAGES_URL, env.GITHUB_PUBLIC_TOKEN),
  ]);

  let sourceKind: ScoringModelSnapshotRecord["sourceKind"] = "raw-github";
  let constants = { ...DEFAULT_SCORING_CONSTANTS };
  let activeModelConstants: Record<string, number> = {};
  let constantsPayload: Record<string, JsonValue> = {};

  if (constantsResult.ok) {
    const parsed = parsePythonNumberConstants(constantsResult.value);
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
    warnings.push(`Scoring constants fetch failed: ${constantsResult.error}`);
  }

  const programmingLanguages = languagesResult.ok ? languagesResult.value : {};
  if (!languagesResult.ok) warnings.push(`Programming language weights fetch failed: ${languagesResult.error}`);

  const snapshot: ScoringModelSnapshotRecord = {
    id: crypto.randomUUID(),
    sourceKind,
    sourceUrl: SCORING_CONSTANTS_URL,
    fetchedAt,
    activeModel: detectActiveModel(activeModelConstants),
    constants,
    programmingLanguages: programmingLanguages as Record<string, JsonValue>,
    registrySnapshotId: registrySnapshot?.id,
    warnings,
    payload: {
      constants: constantsPayload,
      programmingLanguagesSourceUrl: PROGRAMMING_LANGUAGES_URL,
      registryRepoCount: registrySnapshot?.repoCount ?? 0,
    },
  };
  await persistScoringModelSnapshot(env, snapshot);
  return snapshot;
}

export async function getOrCreateScoringModelSnapshot(env: Env): Promise<ScoringModelSnapshotRecord> {
  return (await getLatestScoringModelSnapshot(env)) ?? refreshScoringModelSnapshot(env);
}

export function parsePythonNumberConstants(source: string, options: { knownOnly?: boolean } = { knownOnly: true }): Record<string, number> {
  const constants: Record<string, number> = {};
  for (const line of source.split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]+)\s*=\s*([-+]?\d+(?:\.\d+)?)/);
    if (!match) continue;
    const name = match[1]!;
    const raw = match[2]!;
    if (options.knownOnly !== false && !SCORING_CONSTANT_NAMES.has(name)) continue;
    constants[name] = Number(raw);
  }
  return constants;
}

/**
 * Numeric constant names upstream gittensor defines that gittensory's scoring engine does NOT model.
 * The normal parse is `knownOnly` (it keeps only constants we already encode), which silently hides
 * upstream ADDITIONS — e.g. a newly-introduced time-decay constant. Surfacing these makes scoring
 * staleness visible: if upstream adds a scoring dimension, an operator sees it instead of the gate
 * silently drifting behind. Detection only — it does not change any score.
 */
export function findUnmodeledUpstreamConstants(source: string): string[] {
  const all = parsePythonNumberConstants(source, { knownOnly: false });
  return Object.keys(all)
    .filter((name) => !SCORING_CONSTANT_NAMES.has(name))
    .sort();
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
