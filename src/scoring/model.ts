import {
  getLatestScoringModelSnapshot,
  persistScoringModelSnapshot,
} from "../db/repositories";
import { githubHeaders, timeoutFetch } from "../github/client";
import { getLatestRegistrySnapshot } from "../registry/sync";
import { resolveUpstreamCommitSha } from "../upstream/commit";
import { syncUnmodeledScoringConstantDrift } from "../upstream/unmodeled-scoring-drift";
import type { JsonValue, ScoringModelSnapshotRecord } from "../types";
import { errorMessage, nowIso } from "../utils/json";

// Deterministic constants/classifiers, extracted to `@jsonbored/gittensory-engine` (#2282) so the miner can
// run the same scoring-constant logic locally. Re-exported here (via relative source path — see
// src/scoring/preview.ts's shim comment for why) so every existing import of this module keeps working
// unchanged. The upstream-fetching, D1-persisting logic below is Cloudflare/D1-bound and cannot move into
// the engine package, so it stays here, importing its pure dependencies back from the engine.
export * from "../../packages/gittensory-engine/src/scoring/model";
import {
  DEFAULT_GITTENSOR_UPSTREAM_REPO,
  DEFAULT_GITTENSOR_UPSTREAM_REF,
  DEFAULT_SCORING_CONSTANTS,
  SCORING_CONSTANT_NAMES,
  parsePythonNumberConstants,
  findUnmodeledUpstreamConstants,
  detectActiveModel,
  hasSaturationConstants,
  hasDensityConstants,
  scoringSnapshotStalenessWarning,
} from "../../packages/gittensory-engine/src/scoring/model";

function scoringUpstreamConfig(env: Env): { repo: string; ref: string } {
  return {
    repo: env.GITTENSOR_UPSTREAM_REPO || DEFAULT_GITTENSOR_UPSTREAM_REPO,
    ref: env.GITTENSOR_UPSTREAM_REF || DEFAULT_GITTENSOR_UPSTREAM_REF,
  };
}

function upstreamRawUrl(config: { repo: string; ref: string }, path: string): string {
  return `https://raw.githubusercontent.com/${config.repo}/${encodeURIComponent(config.ref)}/${path}`;
}

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
  const upstreamSourceSha = await resolveUpstreamCommitSha(env, upstream);
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

export async function getOrCreateScoringModelSnapshot(env: Env): Promise<ScoringModelSnapshotRecord> {
  const snapshot = (await getLatestScoringModelSnapshot(env)) ?? (await refreshScoringModelSnapshot(env));
  // Surface staleness so previews do not silently use last-good/DEFAULT constants after a failed/old refresh (#810).
  const stalenessWarning = scoringSnapshotStalenessWarning(snapshot);
  return stalenessWarning ? { ...snapshot, warnings: [...snapshot.warnings, stalenessWarning] } : snapshot;
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

async function fetchText(url: string, token?: string): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  try {
    const response = await timeoutFetch(url, { headers: githubHeaders({ token, accept: "text/plain", apiVersion: false }) });
    if (!response.ok) return { ok: false, error: `${response.status} ${response.statusText}` };
    return { ok: true, value: await response.text() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function fetchJson(url: string, token?: string): Promise<{ ok: true; value: Record<string, JsonValue> } | { ok: false; error: string }> {
  try {
    const response = await timeoutFetch(url, { headers: githubHeaders({ token, accept: "application/json", apiVersion: false }) });
    if (!response.ok) return { ok: false, error: `${response.status} ${response.statusText}` };
    return { ok: true, value: (await response.json()) as Record<string, JsonValue> };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
