// LoopOver federated fleet intelligence (#1970) — the dashboard benchmark (#6481): "your gate precision vs
// peer median". Composes the already-shipped pipeline stages — export (#6478, federated-bundle.ts), transport
// (#6479, federated-collector.ts), and trust-gated import (#6480/#9148, federated-import.ts) — into the one
// comparison the maintainer dashboard renders.
//
// #9148 SPLIT THIS MODULE IN TWO, on a request-time/background-tick line:
//   - {@link buildFederatedBenchmark} is the REQUEST-TIME read path (called from the dashboard route). It
//     computes the LOCAL half live (a single local DB query, cheap) but reads the PEER half from a cache this
//     module writes on a background tick — it never pulls a peer collector itself. Before #9148, this
//     function made a live network call (with a rate limiter, a 5s timeout, and a 1-MB response ceiling) on
//     EVERY maintainer dashboard load; N maintainers hitting refresh was N requests/second at the peer
//     collector, and every load paid that request's full latency.
//   - {@link refreshFederatedBenchmarkCache} is the BACKGROUND-TICK write path (called from the federated
//     peer-sync queue job, src/queue/job-dispatch.ts's "federated-peer-sync" case). It does the actual pull +
//     trust-gate + persisted-watermark pipeline and writes the result to a `system_flags` cache row. This is
//     the only place in this module that touches the network.
//
// FAIL-SAFE BY COMPOSITION, not by a wrapping try/catch: buildFederatedBundle degrades to null on any error,
// pullPeerBundles degrades to [] on any error or when not opted in, and importPeerBundles/
// applyFederatedPeerWatermarks degrade their own way on failure (a DB read failure reads as "cache empty" /
// "every peer state unknown", never a thrown error). Neither function here needs its own catch as a result.
import { buildFederatedBundle, isFederatedIntelligenceEnabled, resolveFederatedWindowDays } from "./federated-bundle";
import { applyFederatedPeerWatermarks, importPeerBundles } from "./federated-import";
import { pullPeerBundles, pushFederatedBundle, type CollectorOpts } from "./federated-collector";
import { percentile } from "./analytics";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { resolveLoopOverSelfRepoFullName } from "../config/loopover-repo-focus-manifest";
import type { FocusManifest } from "../signals/focus-manifest";

export interface FederatedBenchmark {
  /** This instance's own P(merged & not reverted | gate said merge), from buildFederatedBundle. Null below
   *  MIN_DECIDED, exactly like the exported bundle field it reuses. Computed LIVE at request time — this is
   *  a single local DB query, not a network call, so there is no reason to cache it. */
  localMergePrecision: number | null;
  /** Median mergePrecision across every accepted (trust-gated, range-checked, fresh, per-instance-deduped,
   *  Sybil-capped — #9148) peer bundle that itself cleared MIN_DECIDED, as of the last background sync tick.
   *  Null when no peer has ever contributed one — an empty-state condition, not an error. */
  peerMedianMergePrecision: number | null;
  /** How many DISTINCT peer instances contributed to the median above, as of the last background sync tick. */
  peerCount: number;
  generatedAt: string;
}

/** system_flags key for the cached peer-half of the benchmark (#9148) — written only by
 *  {@link refreshFederatedBenchmarkCache}, read only by {@link buildFederatedBenchmark}. */
const FEDERATED_BENCHMARK_CACHE_FLAG_KEY = "orb:federated_benchmark_cache";

interface FederatedBenchmarkCache {
  peerMedianMergePrecision: number | null;
  peerCount: number;
  /** When the cache was last refreshed — surfaced so a stale-cache condition (sync tick disabled/broken) is
   *  at least visible in the raw system_flags row, even though the dashboard field above always reports its
   *  OWN generatedAt (the read time, not the cache's write time). */
  refreshedAt: string;
}

/** Fails safe to null on any error (missing row, corrupt JSON, a D1 outage) — a cache miss reads exactly like
 *  "opted in, no peer data yet", the same empty state #6481 already treats as normal rather than an error. */
async function readFederatedBenchmarkCache(db: D1Database): Promise<FederatedBenchmarkCache | null> {
  try {
    const row = await db.prepare("SELECT value FROM system_flags WHERE key = ?").bind(FEDERATED_BENCHMARK_CACHE_FLAG_KEY).first<{ value: string }>();
    if (!row?.value) return null;
    const parsed: unknown = JSON.parse(row.value);
    if (parsed === null || typeof parsed !== "object") return null;
    const cache = parsed as Partial<FederatedBenchmarkCache>;
    if (typeof cache.peerCount !== "number" || typeof cache.refreshedAt !== "string") return null;
    return {
      peerMedianMergePrecision: typeof cache.peerMedianMergePrecision === "number" ? cache.peerMedianMergePrecision : null,
      peerCount: cache.peerCount,
      refreshedAt: cache.refreshedAt,
    };
  } catch {
    return null;
  }
}

/** Best-effort write. A write failure must never fail the sync tick — the next tick simply overwrites the
 *  still-stale cache again. */
async function writeFederatedBenchmarkCache(db: D1Database, cache: FederatedBenchmarkCache): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO system_flags (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
    .bind(FEDERATED_BENCHMARK_CACHE_FLAG_KEY, JSON.stringify(cache))
    .run()
    .catch(() => undefined);
}

/**
 * Build the local-vs-peer-median benchmark for the maintainer dashboard — the REQUEST-TIME read path (#9148).
 *
 * Returns null — touching nothing beyond the opt-in check — when federated intelligence is not enabled for
 * this deployment. Otherwise ALWAYS computes the local half live (a single, fast, local DB query) and reads
 * the peer half from the background-tick cache; it never pulls a peer collector itself. A cache miss (no
 * sync tick has run yet, e.g. right after opting in) reads as peerCount 0 / a null median — the SAME
 * empty-state shape a genuinely peerless deployment already renders, not an error and not a missing panel.
 */
export async function buildFederatedBenchmark(
  manifest: Pick<FocusManifest, "federatedIntelligence"> | null | undefined,
  db: D1Database,
  opts: { now?: number; windowDays?: number } = {},
): Promise<FederatedBenchmark | null> {
  if (!isFederatedIntelligenceEnabled(manifest)) return null;

  const now = Number.isFinite(opts.now) ? (opts.now as number) : Date.now();
  // exactOptionalPropertyTypes forbids `windowDays: undefined` — only include the key when a real value was
  // passed, so an omitted opts.windowDays falls through to buildFederatedBundle's own default instead of
  // being overridden with an explicit undefined.
  const localBundle = await buildFederatedBundle(manifest, db, opts.windowDays === undefined ? { now } : { now, windowDays: opts.windowDays });
  const cached = await readFederatedBenchmarkCache(db);

  return {
    localMergePrecision: localBundle?.mergePrecision ?? null,
    peerMedianMergePrecision: cached?.peerMedianMergePrecision ?? null,
    peerCount: cached?.peerCount ?? 0,
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * Pull + trust-gate + persist every peer bundle this instance can reach, then cache the resulting median for
 * {@link buildFederatedBenchmark} to read — the BACKGROUND-TICK write path (#9148). Called only from the
 * federated peer-sync queue job, never from any request path.
 *
 * A no-op (cache untouched) when not opted in — an opted-out instance never overwrites a stale cache with a
 * fresh "no data" result, so re-enabling later doesn't need to wait out a sync tick to see its last known
 * peer state disappear for no reason. Every stage below already fails safe on its own (see this file's header
 * comment), so this function needs no wrapping try/catch either.
 */
export async function refreshFederatedBenchmarkCache(
  manifest: Pick<FocusManifest, "federatedIntelligence"> | null | undefined,
  db: D1Database,
  opts: { now?: number; windowDays?: number } & CollectorOpts = {},
): Promise<void> {
  if (!isFederatedIntelligenceEnabled(manifest)) return;

  const now = Number.isFinite(opts.now) ? (opts.now as number) : Date.now();
  const localWindowDays = resolveFederatedWindowDays(opts.windowDays);
  const config = manifest?.federatedIntelligence;

  const peerBundles = await pullPeerBundles(manifest, opts);
  const stateless = importPeerBundles(manifest, peerBundles, { now, localWindowDays });
  const { accepted } = config ? await applyFederatedPeerWatermarks(db, stateless, config.peerKeys, { now }) : stateless;

  // MEDIAN, NOT MEAN (mirrors analytics.ts's own fleet aggregation, see federated-import.ts's header comment):
  // a bounded number of outliers cannot drag a median arbitrarily, so re-deriving a mean here would quietly
  // weaken the same poisoning-resistance property the import side already relies on holding by construction.
  // `accepted` is deduped one-bundle-per-instanceId by importPeerBundles (#9148), so this count is already a
  // count of distinct CONTRIBUTING INSTANCES, not raw bundles — the bug the peerCount doc used to warn about.
  const peerMergePrecisions = accepted
    .map((bundle) => bundle.mergePrecision)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  await writeFederatedBenchmarkCache(db, {
    peerMedianMergePrecision: percentile(peerMergePrecisions, 50),
    peerCount: peerMergePrecisions.length,
    refreshedAt: new Date(now).toISOString(),
  });
}

/**
 * The full federated peer-sync tick (#9148/#9166): refreshes the peer-median cache AND pushes this instance's
 * own bundle to the operator's configured collector, in parallel. This is the function the "federated-peer-
 * sync" queue job calls; it is the concrete wiring #9166 deferred ("pushFederatedBundle wiring into a real
 * tick lands with the #9148 commit, which introduces the background refresh job this naturally slots into").
 *
 * `Promise.allSettled` rather than `Promise.all`: a push failure must never skip the pull-side refresh (and
 * vice versa) — the two directions are independent and each already fails safe to a falsy/empty result on
 * its own, so there is nothing here worth rejecting the whole tick over.
 */
export async function runFederatedPeerSyncTick(
  manifest: Pick<FocusManifest, "federatedIntelligence"> | null | undefined,
  db: D1Database,
  opts: { now?: number; windowDays?: number } & CollectorOpts = {},
): Promise<void> {
  await Promise.allSettled([refreshFederatedBenchmarkCache(manifest, db, opts), pushFederatedBundle(manifest, db, opts)]);
}

/** Config-as-code override for the SCHEDULER's own enqueue gate (#9148) — mirrors resolveOpsManifestOverride
 *  (src/review/ops-wire.ts) exactly: a short in-isolate TTL cache over the loopover self-repo's manifest, so
 *  the cron tick doesn't pay a full manifest load on every 2-minute pass just to decide whether to enqueue a
 *  job the processor will re-check anyway (defense in depth — the queue job-dispatch case loads the full
 *  manifest itself before doing any real work, exactly like ops-alerts does). A load failure degrades to
 *  `{ enabled: false }`, so a manifest hiccup can only ever under-enqueue, never wrongly arm the sync. */
export type FederatedIntelligenceManifestOverride = { present: boolean; enabled: boolean };

const FEDERATED_MANIFEST_OVERRIDE_CACHE_TTL_MS = 60_000;
let federatedManifestOverrideCache: { override: FederatedIntelligenceManifestOverride; at: number } | null = null;

export async function resolveFederatedIntelligenceManifestOverride(env: Env, nowMs: number = Date.now()): Promise<FederatedIntelligenceManifestOverride> {
  const hit = federatedManifestOverrideCache;
  if (hit && nowMs - hit.at < FEDERATED_MANIFEST_OVERRIDE_CACHE_TTL_MS) return hit.override;
  try {
    const manifest = await loadRepoFocusManifest(env, resolveLoopOverSelfRepoFullName(env));
    const config = manifest.federatedIntelligence;
    const override = { present: config.present, enabled: config.enabled === true };
    federatedManifestOverrideCache = { override, at: nowMs };
    return override;
  } catch {
    const override = { present: false, enabled: false };
    federatedManifestOverrideCache = { override, at: nowMs };
    return override;
  }
}

/** Test-only: clears the cached override, mirroring clearOpsManifestOverrideCacheForTest — without this, a
 *  test suite running many cases would leak one test's cached override into the next. */
export function clearFederatedIntelligenceManifestOverrideCacheForTest(): void {
  federatedManifestOverrideCache = null;
}
