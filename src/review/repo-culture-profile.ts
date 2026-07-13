// Repo quality-culture profile (#2995): a lightweight, cached, per-repo signal derived from the repo's OWN
// commit/PR history -- typical PR size, comment-description density, and label-frequency norms -- fed into the
// AI review prompt as ADDITIVE grounding context. Distinct from `./repo-profile.ts` (#2999, the repo-doc/
// CLAUDE.md generation epic #2993), which derives an architecture/conventions/commands profile from the RAG code
// index; this module derives a "how does this repo actually merge PRs" profile from `recent_merged_pull_requests`
// instead, and is meant to be the ONE place that signal is computed so it never drifts between the review path
// (src/services/ai-review.ts / src/review/rag.ts) and the Autonomous Miner System's merge-bar inference -- both
// import `extractRepoCultureProfile` rather than growing their own heuristic.
//
// SHARED PRIMITIVE: no dependency on any one consumer. Pure + deterministic (no AI call) so it is
// fixture-testable and cheap to compute -- the diff/finding-tone judgment itself always stays AI, this module
// only supplies grounding facts about the repo's own history.
//
// CACHE: per-repo, persisted in the existing `signal_snapshots` table (the same mechanism
// `signals/focus-manifest-loader.ts` uses for the manifest cache) with a TTL, mirroring that module's
// read-cached/persist-on-miss shape. `staleByPrCount` ALSO invalidates the cache when the repo's merged-PR count
// has moved since the snapshot was taken (a cheap COUNT(*), no re-read of the rows themselves) -- so a burst of
// newly merged PRs refreshes the profile even inside the TTL window, matching the issue's "TTL OR new commits"
// invalidation ask with the simplest signal already available (countRecentMergedPullRequests, the same COUNT
// helper the backfill segment tracker already uses).
//
// FAIL SAFE ON SPARSE/MISSING DATA: fewer than MIN_SAMPLE_PULL_REQUESTS merged PRs (or none at all) returns the
// explicit `{ present: false, reason }` branch, never a partial/misleading guess -- callers must treat that as
// "no grounding to add", never a signal in itself, and NEVER a gate/scoring input (this is advisory prompt
// context only, per the issue's explicit "no new scored gate dimension" requirement).
import { listSignalSnapshots, persistSignalSnapshot, recordAuditEvent } from "../db/repositories";
import { countRecentMergedPullRequests, listRecentMergedPullRequests } from "../db/repositories";
import { incr } from "../selfhost/metrics";
import type { RecentMergedPullRequestRecord } from "../types";
import { nowIso } from "../utils/json";

/** Bumped whenever the profile SHAPE changes (not on every content tweak) -- both the review path and the miner's
 *  merge-bar inference consume this profile independently and must be able to evolve without a lockstep release. */
export const REPO_CULTURE_PROFILE_SCHEMA_VERSION = 1;

/** Below this many merged PRs, any derived norm is too noisy to be worth surfacing -- the extractor returns the
 *  explicit insufficient-data branch instead of a guess built on a handful of samples. */
export const MIN_SAMPLE_PULL_REQUESTS = 5;

/** Signal type this profile is cached under in `signal_snapshots` (mirrors REPO_FOCUS_MANIFEST_SIGNAL's naming). */
export const REPO_CULTURE_PROFILE_SIGNAL = "repo-culture-profile";

/** Default cache freshness window -- matches REPO_FOCUS_MANIFEST_MAX_AGE_MS's order of magnitude (a repo's merge
 *  norms drift slowly; there is no need to re-derive this on every review). */
export const REPO_CULTURE_PROFILE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type RepoCulturePrSizeBand = "tiny" | "small" | "medium" | "large";

export type RepoCulturePullRequestNorms = {
  /** Merged PRs the profile was derived from (capped by listRecentMergedPullRequests' own row limit). */
  sampleSize: number;
  /** Median changed-file count across the sample -- deliberately median, not mean, so a handful of huge
   *  refactor PRs can't drag the "typical" size away from what most contributions actually look like. */
  medianChangedFiles: number;
  /** The band the median falls into, for a compact prompt phrase ("this repo's merged PRs run small"). */
  medianSizeBand: RepoCulturePrSizeBand;
  /** Median PR description length (chars) -- a rough proxy for how much narrative context this repo's merged
   *  PRs typically carry (a repo that merges one-line-body PRs has a different bar than one that expects a
   *  filled-out template). */
  medianDescriptionLength: number;
};

export type RepoCultureLabelNorm = {
  label: string;
  /** Fraction (0-1) of the sampled merged PRs carrying this label -- rounded to 2 decimal places. */
  frequency: number;
};

export type RepoCultureProfile =
  | {
      version: typeof REPO_CULTURE_PROFILE_SCHEMA_VERSION;
      present: false;
      repoFullName: string;
      generatedAt: string;
      reason: string;
    }
  | {
      version: typeof REPO_CULTURE_PROFILE_SCHEMA_VERSION;
      present: true;
      repoFullName: string;
      generatedAt: string;
      pullRequestNorms: RepoCulturePullRequestNorms;
      /** Top labels by frequency across the sample, most common first (ties broken alphabetically). Capped at
       *  MAX_LABEL_NORMS entries so a label-happy repo can't bloat the prompt. Empty when no merged PR in the
       *  sample carries any label. */
      commonLabels: RepoCultureLabelNorm[];
    };

const MAX_LABEL_NORMS = 8;

function insufficientData(repoFullName: string, generatedAt: string, reason: string): RepoCultureProfile {
  return { version: REPO_CULTURE_PROFILE_SCHEMA_VERSION, present: false, repoFullName, generatedAt, reason };
}

/** Band a changed-file count into a compact size label for the prompt phrase. Thresholds mirror common PR-size
 *  bot conventions (e.g. a repo that treats >30 files as "needs splitting"), not a precise measurement. */
export function prSizeBand(changedFiles: number): RepoCulturePrSizeBand {
  if (changedFiles <= 3) return "tiny";
  if (changedFiles <= 10) return "small";
  if (changedFiles <= 30) return "medium";
  return "large";
}

/** Median of a non-empty numeric array (caller guarantees non-empty; an empty array would be a caller bug, not a
 *  data condition -- there is no meaningful "median of nothing" to degrade to). Sorts a COPY (never mutates the
 *  caller's array). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // `sorted` is non-empty (guaranteed by every call site below, which all filter to sampleSize > 0 first) and
  // `mid` is always a valid index into it, so both reads are defined; the `?? 0` fallbacks below are a
  // noUncheckedIndexedAccess type-level guard, not a reachable data path.
  if (sorted.length % 2 === 1) {
    /* v8 ignore next -- noUncheckedIndexedAccess fallback, unreachable: mid is always a valid index into non-empty sorted */
    return sorted[mid] ?? 0;
  }
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  /* v8 ignore next 2 -- noUncheckedIndexedAccess fallback, unreachable: mid-1 and mid are always valid indices here */
  return ((lower ?? 0) + (upper ?? 0)) / 2;
}

/** Extract the PR description text from a stored `payload` (the raw GitHub REST pull payload) -- "" when absent
 *  or not a string, so a sparse/legacy row degrades to a 0-length description rather than throwing. */
function descriptionLength(pr: RecentMergedPullRequestRecord): number {
  const body = (pr.payload as { body?: unknown } | undefined)?.body;
  return typeof body === "string" ? body.length : 0;
}

function deriveLabelNorms(prs: RecentMergedPullRequestRecord[]): RepoCultureLabelNorm[] {
  const counts = new Map<string, number>();
  for (const pr of prs) {
    for (const label of pr.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, frequency: Math.round((count / prs.length) * 100) / 100 }))
    .sort((a, b) => b.frequency - a.frequency || a.label.localeCompare(b.label))
    .slice(0, MAX_LABEL_NORMS);
}

/**
 * Derive the quality-culture profile PURELY from already-fetched merged-PR rows (no I/O) -- the deterministic
 * core, unit-tested directly and reused by `extractRepoCultureProfile` below.
 */
export function deriveRepoCultureProfile(repoFullName: string, prs: RecentMergedPullRequestRecord[], generatedAt: string): RepoCultureProfile {
  if (prs.length < MIN_SAMPLE_PULL_REQUESTS) {
    return insufficientData(repoFullName, generatedAt, `only ${prs.length} merged pull request(s) on record (need at least ${MIN_SAMPLE_PULL_REQUESTS})`);
  }
  const medianChangedFiles = median(prs.map((pr) => pr.changedFiles.length));
  const pullRequestNorms: RepoCulturePullRequestNorms = {
    sampleSize: prs.length,
    medianChangedFiles,
    medianSizeBand: prSizeBand(medianChangedFiles),
    medianDescriptionLength: median(prs.map(descriptionLength)),
  };
  return {
    version: REPO_CULTURE_PROFILE_SCHEMA_VERSION,
    present: true,
    repoFullName,
    generatedAt,
    pullRequestNorms,
    commonLabels: deriveLabelNorms(prs),
  };
}

/** Round-trip a profile through the `signal_snapshots.payload_json` JSON column. Structural, not validated --
 *  the cache is only ever written by `extractRepoCultureProfile` itself, so a hand-edited/foreign row degrading
 *  to a re-derive on the next miss (rather than a thrown parse error) is the correct fail-safe behavior. */
function profileFromJson(payload: Record<string, unknown>): RepoCultureProfile | null {
  if (payload.present === false) {
    return {
      version: REPO_CULTURE_PROFILE_SCHEMA_VERSION,
      present: false,
      repoFullName: String(payload.repoFullName ?? ""),
      generatedAt: String(payload.generatedAt ?? ""),
      reason: String(payload.reason ?? ""),
    };
  }
  if (payload.present === true && payload.pullRequestNorms && typeof payload.pullRequestNorms === "object") {
    const norms = payload.pullRequestNorms as Record<string, unknown>;
    return {
      version: REPO_CULTURE_PROFILE_SCHEMA_VERSION,
      present: true,
      repoFullName: String(payload.repoFullName ?? ""),
      generatedAt: String(payload.generatedAt ?? ""),
      pullRequestNorms: {
        sampleSize: Number(norms.sampleSize ?? 0),
        medianChangedFiles: Number(norms.medianChangedFiles ?? 0),
        medianSizeBand: (norms.medianSizeBand as RepoCulturePrSizeBand | undefined) ?? "tiny",
        medianDescriptionLength: Number(norms.medianDescriptionLength ?? 0),
      },
      commonLabels: Array.isArray(payload.commonLabels)
        ? (payload.commonLabels as Array<{ label?: unknown; frequency?: unknown }>).map((entry) => ({
            label: String(entry.label ?? ""),
            frequency: Number(entry.frequency ?? 0),
          }))
        : [],
    };
  }
  return null; // malformed/foreign row → treat as a cache miss, never throw
}

/** `sampleCountAtGeneration` is the ACTUAL merged-PR count at derive time (not derived from the profile shape) so
 *  the invalidation check below works identically whether the profile is `present: true` (which also carries a
 *  `sampleSize`) or `present: false` (insufficient data, which has no norms object at all) -- an insufficient-data
 *  repo still deserves a real cache hit until its merged-PR count actually changes, not a re-derive on every call. */
function profileToJson(profile: RepoCultureProfile, sampleCountAtGeneration: number): Record<string, unknown> {
  return profile.present
    ? {
        version: profile.version,
        present: true,
        repoFullName: profile.repoFullName,
        generatedAt: profile.generatedAt,
        pullRequestNorms: profile.pullRequestNorms,
        commonLabels: profile.commonLabels,
        sampleCountAtGeneration,
      }
    : { version: profile.version, present: false, repoFullName: profile.repoFullName, generatedAt: profile.generatedAt, reason: profile.reason, sampleCountAtGeneration };
}

function snapshotAgeMs(generatedAt: string | null | undefined): number {
  if (!generatedAt) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(generatedAt);
  return Number.isFinite(parsed) ? Date.now() - parsed : Number.POSITIVE_INFINITY;
}

/** Read a cached profile snapshot, honoring BOTH invalidation policies: a TTL (`maxAgeMs`) and a merged-PR-count
 *  drift check (a cheap COUNT(*), not a re-read of the rows) -- either one being stale forces a miss. Fail-safe:
 *  any storage error degrades to a cache miss (the caller re-derives), never throws. */
async function readCachedCultureProfile(env: Env, repoFullName: string, maxAgeMs: number): Promise<RepoCultureProfile | null> {
  try {
    const [latest] = await listSignalSnapshots(env, REPO_CULTURE_PROFILE_SIGNAL, repoFullName);
    if (!latest) return null;
    if (snapshotAgeMs(latest.generatedAt) > maxAgeMs) return null;
    const profile = profileFromJson(latest.payload as Record<string, unknown>);
    if (!profile) return null;
    const sampleCountAtGeneration = Number((latest.payload as Record<string, unknown>).sampleCountAtGeneration ?? -1);
    const currentCount = await countRecentMergedPullRequests(env, repoFullName);
    if (currentCount !== sampleCountAtGeneration) return null; // new merged PRs since the snapshot → re-derive
    return profile;
  } catch {
    return null;
  }
}

async function persistCultureProfile(env: Env, repoFullName: string, profile: RepoCultureProfile, sampleCountAtGeneration: number): Promise<void> {
  try {
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_CULTURE_PROFILE_SIGNAL,
      targetKey: repoFullName,
      repoFullName,
      payload: profileToJson(profile, sampleCountAtGeneration) as Record<string, import("../types").JsonValue>,
      generatedAt: nowIso(),
    });
  } catch {
    // Cache-write failure never fails the caller — the next call simply re-derives (fail-safe, mirrors
    // focus-manifest-loader's persistRepoFocusManifest, which has the same swallow-on-write-error shape).
  }
}

export type ExtractRepoCultureProfileOptions = {
  /** Override the generated-at timestamp (tests only; defaults to nowIso()). */
  now?: string;
  /** Override the cache TTL (tests only; defaults to REPO_CULTURE_PROFILE_MAX_AGE_MS). */
  maxAgeMs?: number;
  /** Skip the cache read entirely and force a fresh derive (still writes the fresh result to cache). */
  refresh?: boolean;
};

/**
 * Extract (or reuse a cached) quality-culture profile for a repo. THE shared entry point: both the review
 * path (via `./repo-culture-profile-wire.ts`) and the Autonomous Miner System's merge-bar inference call this
 * directly so neither grows a divergent heuristic. Cache hit ⇒ one D1 read + one COUNT (no row re-scan); cache
 * miss/stale ⇒ one full `recent_merged_pull_requests` read, derive, then persist for next time. Never throws --
 * a storage error on the read/derive path degrades to the insufficient-data branch (the caller still gets a
 * well-formed profile object, just an empty one).
 */
export async function extractRepoCultureProfile(env: Env, repoFullName: string, options: ExtractRepoCultureProfileOptions = {}): Promise<RepoCultureProfile> {
  const generatedAt = options.now ?? nowIso();
  const maxAgeMs = options.maxAgeMs ?? REPO_CULTURE_PROFILE_MAX_AGE_MS;
  if (!options.refresh) {
    const cached = await readCachedCultureProfile(env, repoFullName, maxAgeMs);
    if (cached) {
      // #4509: mirrors the ai_review cache's hit/miss instrumentation (processors.ts) exactly -- this cache
      // works correctly (unlike the #4481 linked_issue_satisfaction bug class) but previously had zero
      // hit/miss telemetry, one of the six capability gaps #4448 identified. readCachedCultureProfile's null
      // return covers EVERY invalidation reason uniformly (no snapshot, TTL expiry, drift, malformed row), so
      // this single hit/miss branch point correctly counts the merged-PR-count drift path as a miss too.
      incr("loopover_repo_culture_profile_cache_hit_total");
      await recordAuditEvent(env, {
        eventType: "github_app.repo_culture_profile_cache_hit",
        targetKey: repoFullName,
        outcome: "completed",
        detail: "reused a cached repo-culture profile instead of re-deriving from merged-PR history",
        metadata: { repoFullName },
      }).catch(() => undefined);
      return cached;
    }
  }
  incr("loopover_repo_culture_profile_cache_miss_total");
  await recordAuditEvent(env, {
    eventType: "github_app.repo_culture_profile_cache_miss",
    targetKey: repoFullName,
    outcome: "completed",
    detail: "no reusable cached repo-culture profile; deriving fresh from merged-PR history",
    metadata: { repoFullName },
  }).catch(() => undefined);
  try {
    const prs = await listRecentMergedPullRequests(env, repoFullName);
    const sampleCountAtGeneration = await countRecentMergedPullRequests(env, repoFullName);
    const profile = deriveRepoCultureProfile(repoFullName, prs, generatedAt);
    await persistCultureProfile(env, repoFullName, profile, sampleCountAtGeneration);
    return profile;
  } catch {
    return insufficientData(repoFullName, generatedAt, "repo merged-pull-request history is unavailable (storage read failed)");
  }
}
