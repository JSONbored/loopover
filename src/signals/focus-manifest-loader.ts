import { listSignalSnapshots, persistSignalSnapshot } from "../db/repositories";
import { mapWithConcurrency } from "../queue/map-with-concurrency";
import type { JsonValue } from "../types";
import { nowIso } from "../utils/json";
import { contentLaneConfigToJson, experimentalConfigToJson, featuresConfigToJson, gateConfigToJson, MAX_FOCUS_MANIFEST_BYTES, parseFocusManifest, parseFocusManifestContent, repoDocGenerationConfigToJson, reviewConfigToJson, reviewRecapConfigToJson, maintainerRecapConfigToJson, opsConfigToJson, publicStatsConfigToJson, fairnessAnalyticsConfigToJson, draftFlowConfigToJson, upstreamDriftIssuesConfigToJson, sweepWatchdogConfigToJson, prReconciliationConfigToJson, activeReviewReconciliationConfigToJson, loopEscalationConfigToJson, federatedIntelligenceConfigToJson, settingsOverrideToJson, type FocusManifest, type FocusManifestSource, type RepoReviewContext } from "./focus-manifest";
import { LOOPOVER_REPO_FOCUS_MANIFEST_YAML, resolveLoopOverSelfRepoFullName } from "../config/loopover-repo-focus-manifest";
import type { LocalManifestLoadResult } from "../selfhost/private-config";

export const REPO_FOCUS_MANIFEST_SIGNAL = "repo-focus-manifest";
export const REPO_PUBLIC_FOCUS_MANIFEST_SIGNAL = "repo-public-focus-manifest";
export const REPO_FOCUS_MANIFEST_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Per-request ceiling for each raw-content candidate fetch (#7071), matching the bounded-fetch convention in
// src/review/** (e.g. alerts.ts's AbortSignal.timeout(10_000)) so a slow raw.githubusercontent.com response
// can't stall manifest resolution on the cold-cache path.
const MANIFEST_FETCH_TIMEOUT_MS = 10_000;
export const REPO_FOCUS_MANIFEST_MAX_CONCURRENT_LOADS = 4;

/**
 * Public-repo manifest candidate paths, tried in order via {@link fetchRepoFocusManifestFile}. The loader returns
 * the first candidate that responds `200 OK`: root beats `.github/` within the same extension, and `.yml` beats
 * `.json`. Deliberately does NOT add a `.loopover.yaml` variant here — only the self-host loader in
 * `../selfhost/private-config.ts` accepts `.yaml`.
 */
export const MANIFEST_FILE_CANDIDATES = [
  ".loopover.yml",
  ".github/loopover.yml",
  ".loopover.json",
  ".github/loopover.json",
] as const;

/**
 * Async source for the raw manifest text of a single repo. Returns null when no manifest is
 * published. Allows tests and the persisted-record path to swap out the public-GitHub fetcher.
 * Self-host readers may return {@link LocalManifestLoadResult} with `review.shared_config` provenance (#2046).
 */
export type RepoFocusManifestFetcher = (repoFullName: string) => Promise<string | LocalManifestLoadResult | null>;

/**
 * Optional container-private per-repo config reader (self-host LOOPOVER_REPO_CONFIG_DIR). When registered it
 * takes priority over — and fully REPLACES — the public `.loopover.yml` for the normal
 * (non-preview) load, so a self-host operator sets review policy privately and contributors can't read or game it. Registered once at boot
 * by the Node entry (server.ts); the filesystem access lives inside that injected closure, keeping THIS module
 * Workers-safe. Unset (cloud, or a self-host without the dir) ⇒ behavior is byte-identical to the public fetch.
 */
let localManifestReader: RepoFocusManifestFetcher | null = null;
export function setLocalManifestReader(reader: RepoFocusManifestFetcher | null): void {
  localManifestReader = reader;
}

/**
 * Async source for a repo's review CONTEXT (#review-skills): the `review/CLAUDE.md` guide + `review/skills/*.md` rubric
 * modules from the container-private config dir. Registered once at boot by the Node entry (server.ts); the filesystem
 * access lives inside that injected closure, keeping THIS module Workers-safe. Unset (cloud, or a self-host without the
 * dir) ⇒ the loader returns an empty context and the reviewer prompt is byte-identical.
 */
export type RepoReviewContextReader = (
  repoFullName: string,
) => Promise<RepoReviewContext>;
let localReviewContextReader: RepoReviewContextReader | null = null;
export function setLocalReviewContextReader(
  reader: RepoReviewContextReader | null,
): void {
  localReviewContextReader = reader;
}

/** Load the per-repo review context via the registered reader. Local file reads are cheap, so this is NOT cached.
 *  Unset reader ⇒ empty context; a read error degrades to empty (the reviewer prompt stays byte-identical). */
export async function loadRepoReviewContext(
  repoFullName: string,
): Promise<RepoReviewContext> {
  if (!localReviewContextReader) return { guide: null, skills: [] };
  try {
    return await localReviewContextReader(repoFullName);
  } catch {
    return { guide: null, skills: [] };
  }
}

/**
 * True iff a container-private local manifest is registered (self-host only -- always false in cloud,
 * where no reader is ever set) AND resolves non-null for `repoFullName`. A read error degrades to false,
 * matching every other local-reader consumer's fail-safe-empty behavior. Used by the repo-rename webhook
 * handler (#repo-rename-migration) to detect the ONE thing a rename can't migrate on its own: the
 * operator's own container-private per-repo config folder, which this module derives from the CURRENT
 * repo name and can only read, never write (the mount is read-only from the app's own perspective).
 */
export async function hasLocalManifest(repoFullName: string): Promise<boolean> {
  if (!localManifestReader) return false;
  try {
    return (await localManifestReader(repoFullName)) !== null;
  } catch {
    return false;
  }
}

/**
 * Fetch a maintainer-owned manifest file from the public GitHub raw endpoint. Network or HTTP
 * failures resolve to null so the loader falls back to deterministic signals.
 */
export async function fetchRepoFocusManifestFile(repoFullName: string): Promise<string | null> {
  const slash = repoFullName.indexOf("/");
  if (slash <= 0 || slash === repoFullName.length - 1) return null;
  const owner = repoFullName.slice(0, slash);
  const name = repoFullName.slice(slash + 1);
  for (const path of MANIFEST_FILE_CANDIDATES) {
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/HEAD/${path}`;
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "loopover" },
        signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        const text = await readBoundedResponseText(response);
        if (text !== null) return text;
      }
    } catch {
      // try the next candidate path
    }
  }
  return null;
}

/**
 * Load the repo-owned focus manifest for a single repo. Reads a fresh persisted snapshot first
 * (the "API-backed repo settings record" path); on a miss or stale snapshot, fetches the
 * `.loopover.json` file from the repo's default branch and caches the result. Missing or malformed
 * manifests degrade to a safe empty manifest with warnings rather than throwing.
 */
export async function loadRepoFocusManifest(
  env: Env,
  repoFullName: string,
  options: { fetcher?: RepoFocusManifestFetcher; maxAgeMs?: number; refresh?: boolean } = {},
): Promise<FocusManifest> {
  return loadRepoFocusManifestWithCachePolicy(env, repoFullName, options);
}

/**
 * Load only the repo-published focus manifest. This intentionally ignores maintainer/API-backed
 * records so contributor-facing previews cannot infer private gate policy while still benefiting
 * from fresh public repo-file cache entries.
 */
export async function loadPublicRepoFocusManifest(
  env: Env,
  repoFullName: string,
  options: { fetcher?: RepoFocusManifestFetcher; maxAgeMs?: number; refresh?: boolean } = {},
): Promise<FocusManifest> {
  return loadRepoFocusManifestWithCachePolicy(env, repoFullName, options, { publicOnly: true });
}

async function loadRepoFocusManifestWithCachePolicy(
  env: Env,
  repoFullName: string,
  options: { fetcher?: RepoFocusManifestFetcher; maxAgeMs?: number; refresh?: boolean } = {},
  cachePolicy: { publicOnly?: boolean } = {},
): Promise<FocusManifest> {
  // Container-private per-repo config (self-host) takes priority over the public `.loopover.yml`:
  // read fresh from local fs each call (cheap, no network) so operator edits apply immediately. NEVER consulted on the publicOnly
  // (contributor-preview) path, and never persisted — so private policy can't leak into previews or the cache.
  if (!cachePolicy.publicOnly && localManifestReader) {
    const localRaw = await localManifestReader(repoFullName);
    const localLoad = normalizeLocalManifestFetch(localRaw);
    if (localLoad.content !== null) {
      const manifest = parseFocusManifestContent(localLoad.content, "api_record");
      if (localLoad.sharedConfigSource || localLoad.warnings.length > 0) {
        return {
          ...manifest,
          review: localLoad.sharedConfigSource
            ? { ...manifest.review, sharedConfigSource: localLoad.sharedConfigSource }
            : manifest.review,
          warnings: localLoad.warnings.length > 0 ? [...manifest.warnings, ...localLoad.warnings] : manifest.warnings,
        };
      }
      return manifest;
    }
  }
  const fetcher = options.fetcher ?? fetchRepoFocusManifestFile;
  const maxAgeMs = options.maxAgeMs ?? REPO_FOCUS_MANIFEST_MAX_AGE_MS;
  if (!options.refresh) {
    const cached = await readCachedManifest(env, repoFullName, maxAgeMs, cachePolicy);
    if (cached) return cached;
  }
  let manifest: FocusManifest;
  try {
    let content = await fetcher(repoFullName);
    if (content !== null && typeof content === "object") content = content.content;
    if ((content === null || content === undefined) && isLoopOverSelfRepo(repoFullName, env)) {
      content = LOOPOVER_REPO_FOCUS_MANIFEST_YAML;
    }
    manifest = content === null || content === undefined ? parseFocusManifest(null) : parseFocusManifestContent(content, "repo_file");
  } catch {
    manifest = parseFocusManifest(null);
  }
  if (cachePolicy.publicOnly) {
    await persistRepoFocusManifest(env, repoFullName, manifest, REPO_PUBLIC_FOCUS_MANIFEST_SIGNAL);
  } else {
    // Persist even an ABSENT manifest (negative cache): effective settings are resolved from
    // `.loopover.yml` on every webhook, so a repo without one must not re-fetch the raw file each time.
    // The TTL still refreshes it, so a newly-added manifest is picked up on the next window.
    await persistRepoFocusManifest(env, repoFullName, manifest);
  }
  return manifest;
}

/** Bulk loader used by decision-pack and agent-planning paths to fetch many repos in parallel. */
export async function loadRepoFocusManifests(
  env: Env,
  repoFullNames: string[],
  options: { fetcher?: RepoFocusManifestFetcher; maxAgeMs?: number } = {},
): Promise<Map<string, FocusManifest>> {
  const entries = await mapWithConcurrencyLimit(repoFullNames, REPO_FOCUS_MANIFEST_MAX_CONCURRENT_LOADS, async (name) =>
    [name.toLowerCase(), await loadRepoFocusManifest(env, name, options)] as const,
  );
  return new Map(entries);
}

async function readBoundedResponseText(response: Response): Promise<string | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_FOCUS_MANIFEST_BYTES) return null;
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_FOCUS_MANIFEST_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

/** Bounded-concurrency fan-out: runs `mapper` over `items` with at most `limit` in flight at once (#3899).
 *  Delegates to the canonical `mapWithConcurrency` (#6602) so the worker-pool loop lives in exactly one place;
 *  the name and `(items, limit, mapper)` signature are preserved for existing callers. */
export async function mapWithConcurrencyLimit<T, U>(items: T[], limit: number, mapper: (item: T) => Promise<U>): Promise<U[]> {
  return mapWithConcurrency(items, limit, mapper);
}

/**
 * Persist a maintainer-supplied manifest (e.g. from a maintainer API/console) so subsequent
 * decision-pack and branch-analysis paths pick it up without refetching the repo file.
 */
export async function upsertRepoFocusManifest(env: Env, repoFullName: string, raw: unknown, source: FocusManifestSource = "api_record"): Promise<FocusManifest> {
  const manifest = parseFocusManifest(raw, source);
  await persistRepoFocusManifest(env, repoFullName, manifest);
  return manifest;
}

async function readCachedManifest(env: Env, repoFullName: string, maxAgeMs: number, options: { publicOnly?: boolean } = {}): Promise<FocusManifest | null> {
  if (options.publicOnly) {
    return (
      (await readCachedManifestSnapshot(env, REPO_PUBLIC_FOCUS_MANIFEST_SIGNAL, repoFullName, maxAgeMs, options)) ??
      // Back-compat: public previews may reuse old repo-file snapshots written before the dedicated public cache
      // existed, but must still ignore maintainer/API-backed records.
      (await readCachedManifestSnapshot(env, REPO_FOCUS_MANIFEST_SIGNAL, repoFullName, maxAgeMs, { ...options, requireRepoFileSource: true }))
    );
  }
  return readCachedManifestSnapshot(env, REPO_FOCUS_MANIFEST_SIGNAL, repoFullName, maxAgeMs, options);
}

async function readCachedManifestSnapshot(
  env: Env,
  signalType: string,
  repoFullName: string,
  maxAgeMs: number,
  options: { publicOnly?: boolean; requireRepoFileSource?: boolean } = {},
): Promise<FocusManifest | null> {
  const [latest] = await listSignalSnapshots(env, signalType, repoFullName);
  if (!latest) return null;
  const manifest = parseFocusManifest(latest.payload);
  const explicitSource =
    latest.payload !== null && typeof latest.payload === "object" && !Array.isArray(latest.payload)
      ? (latest.payload as Record<string, JsonValue>).source
      : undefined;
  if (options.requireRepoFileSource) {
    if (explicitSource !== "repo_file") return null;
  }
  if (options.publicOnly) {
    if (explicitSource === "api_record") return null;
  }
  if (explicitSource === "api_record") return manifest;
  if (snapshotAgeMs(latest.generatedAt) > maxAgeMs) return null;
  return manifest;
}

async function persistRepoFocusManifest(env: Env, repoFullName: string, manifest: FocusManifest, signalType = REPO_FOCUS_MANIFEST_SIGNAL): Promise<void> {
  await persistSignalSnapshot(env, {
    id: crypto.randomUUID(),
    signalType,
    targetKey: repoFullName,
    repoFullName,
    payload: manifestToJson(manifest),
    generatedAt: nowIso(),
  });
}

function manifestToJson(manifest: FocusManifest): Record<string, JsonValue> {
  return {
    source: manifest.source,
    wantedPaths: manifest.wantedPaths,
    preferredLabels: manifest.preferredLabels,
    linkedIssuePolicy: manifest.linkedIssuePolicy,
    testExpectations: manifest.testExpectations,
    issueDiscoveryPolicy: manifest.issueDiscoveryPolicy,
    maintainerNotes: manifest.maintainerNotes,
    publicNotes: manifest.publicNotes,
    gate: gateConfigToJson(manifest.gate),
    settings: settingsOverrideToJson(manifest.settings),
    review: reviewConfigToJson(manifest.review),
    features: featuresConfigToJson(manifest.features),
    experimental: experimentalConfigToJson(manifest.experimental),
    contentLane: contentLaneConfigToJson(manifest.contentLane),
    repoDocGeneration: repoDocGenerationConfigToJson(manifest.repoDocGeneration),
    reviewRecap: reviewRecapConfigToJson(manifest.reviewRecap),
    maintainerRecap: maintainerRecapConfigToJson(manifest.maintainerRecap),
    ops: opsConfigToJson(manifest.ops),
    publicStats: publicStatsConfigToJson(manifest.publicStats),
    fairnessAnalytics: fairnessAnalyticsConfigToJson(manifest.fairnessAnalytics),
    draftFlow: draftFlowConfigToJson(manifest.draftFlow),
    upstreamDriftIssues: upstreamDriftIssuesConfigToJson(manifest.upstreamDriftIssues),
    sweepWatchdog: sweepWatchdogConfigToJson(manifest.sweepWatchdog),
    prReconciliation: prReconciliationConfigToJson(manifest.prReconciliation),
    activeReviewReconciliation: activeReviewReconciliationConfigToJson(manifest.activeReviewReconciliation),
    loopEscalation: loopEscalationConfigToJson(manifest.loopEscalation),
    federatedIntelligence: federatedIntelligenceConfigToJson(manifest.federatedIntelligence),
  };
}

function snapshotAgeMs(generatedAt: string | null | undefined): number {
  if (!generatedAt) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(generatedAt);
  return Number.isFinite(parsed) ? Date.now() - parsed : Number.POSITIVE_INFINITY;
}

function isLoopOverSelfRepo(repoFullName: string, env: Env): boolean {
  return repoFullName.toLowerCase() === resolveLoopOverSelfRepoFullName(env).toLowerCase();
}

function normalizeLocalManifestFetch(raw: string | LocalManifestLoadResult | null): LocalManifestLoadResult {
  if (raw === null) return { content: null, sharedConfigSource: null, warnings: [] };
  if (typeof raw === "string") return { content: raw, sharedConfigSource: null, warnings: [] };
  return raw;
}
