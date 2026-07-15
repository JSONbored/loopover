// Live CI-aggregate / merge-state resolution and caching (#4013 step 6 -- extracted from processors.ts,
// sixth step of the file's own module-split sequence, after transient-locks.ts, signal-snapshot.ts,
// duplicate-detection.ts, slop-detection.ts, and review-evasion.ts). Pure move.
//
// LiveGithubFacts (the request-scoped memo these functions read/write) stays in processors.ts -- it is a
// foundational type used across dozens of unrelated call sites there, not specific to this concern -- so
// this file imports it back type-only (erased at compile time, so it creates no runtime circular
// dependency even though processors.ts also imports several functions FROM this file below).
// liveFactKey/liveFactTokenPart are exported because processors.ts's own primeLiveMergeState (a different,
// staying concern -- priming the memo from an already-known webhook payload value, no fetch involved)
// still needs them; cachedRequiredStatusContexts is exported for processors.ts's own one remaining direct
// caller. Every other function here is exported only when processors.ts's own webhook/disposition code
// calls it directly; the purely-internal orchestration helpers (cachedFetchLiveCiAggregate,
// fetchLiveCiAggregateWithRequiredContexts, expectedCiContextsKeyPart, resolvedRequiredContextsKeyPart,
// evictLiveFactOnReject) stay unexported, matching their original (never-exported) visibility.

import { getPullRequestDetailSyncState } from "../db/repositories";
import {
  cachedFetchLivePullRequestMergeState,
  CI_STATE_CACHE_METRIC,
  deserializeCachedCiAggregate,
  fetchLiveCiAggregatePreferGraphQl,
  fetchLivePullRequestMergeState,
  fetchRequiredStatusContexts,
  isCiStateCacheFresh,
  mergeRequiredCiContexts,
  writeThroughCiStateCache,
  type LiveCiAggregate,
} from "../github/backfill";
import type { GitHubRateLimitAdmissionKey } from "../github/client";
import { incr } from "../selfhost/metrics";
import type { LiveGithubFacts, RequiredStatusContextsLookup } from "./processors";

export function liveFactKey(...parts: Array<string | number | null | undefined>): string {
  return JSON.stringify(parts.map((part) => [typeof part, part]));
}

export function liveFactTokenPart(token: string | undefined): string {
  if (!token) return "token:none";
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `token:${token.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

// Stable, order-independent cache-key fragment for settings.expectedCiContexts (#selfhost-ci-verification):
// a config change must never reuse a stale required-contexts/live-CI cache entry from before the change, and
// two equal sets in different orders must hit the SAME cache entry rather than needlessly duplicating fetches.
function expectedCiContextsKeyPart(expectedCiContexts: ReadonlyArray<string> | null | undefined): string {
  if (!expectedCiContexts || expectedCiContexts.length === 0) return "";
  return [...expectedCiContexts].sort().join("\0");
}

// Stable, order-independent cache-key fragment for the RESOLVED required-contexts set (#selfhost-ci-verification):
// unlike expectedCiContextsKeyPart above (the raw, unresolved settings.expectedCiContexts config), this reflects
// mergeRequiredCiContexts' actual output -- live branch-protection required contexts unioned with config. The
// durable cross-job CI-state cache (cachedFetchLiveCiAggregate) MUST key on this, not on the raw config: branch
// protection can change server-side while expectedCiContexts config stays put, and a stale durable row keyed only
// on the unchanged config would keep serving an aggregate computed against the old required-context set.
function resolvedRequiredContextsKeyPart(requiredContexts: ReadonlySet<string> | null | undefined): string {
  if (!requiredContexts || requiredContexts.size === 0) return "";
  return JSON.stringify([...requiredContexts].sort());
}

// #4372: stable, order-independent cache-key fragment for settings.advisoryCheckRuns. The advisory list changes
// the aggregate (which checks are excluded from ciState/hasPending), so a config change must invalidate both the
// request-scoped memo AND the durable cross-job CI-state cache — otherwise a stale entry from before the change
// would keep gating on (or excluding) the wrong checks. Two equal lists in any order collapse to one key.
function advisoryCheckRunsKeyPart(advisoryCheckRuns: ReadonlyArray<{ name: string; appSlug: string }> | null | undefined): string {
  if (!advisoryCheckRuns || advisoryCheckRuns.length === 0) return "";
  return JSON.stringify(advisoryCheckRuns.map((c) => `${c.name}\0${c.appSlug}`).sort());
}

// RC2 + #selfhost-ci-verification: the EFFECTIVE required-status-check contexts for this repo/baseRef, merging
// live branch-protection required contexts with the maintainer-configured settings.expectedCiContexts fallback
// (mergeRequiredCiContexts — branch protection stays authoritative when readable; expectedCiContexts is the
// SOLE source when it is null/empty). Downstream callers (fetchLiveCiAggregate et al.) never distinguish the
// two sources — they only see one effective required-contexts set, same as before this field existed.
export function cachedRequiredStatusContexts(
  env: Env,
  repoFullName: string,
  facts: LiveGithubFacts,
  baseRef: string | null | undefined,
  token: string | undefined,
  expectedCiContexts: ReadonlyArray<string> | null | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<RequiredStatusContextsLookup> {
  const key = liveFactKey(repoFullName, baseRef, liveFactTokenPart(token), expectedCiContextsKeyPart(expectedCiContexts));
  const cached = facts.requiredContexts.get(key);
  if (cached) return cached;
  let branchProtectionFetchFailed = false;
  const next = evictLiveFactOnReject(
    facts.requiredContexts,
    key,
    fetchRequiredStatusContexts(env, repoFullName, baseRef, token, admissionKey, () => {
      branchProtectionFetchFailed = true;
    }).then((branchProtectionContexts) => ({
      requiredContexts: mergeRequiredCiContexts(branchProtectionContexts, expectedCiContexts),
      resolved: !branchProtectionFetchFailed,
    })),
  );
  facts.requiredContexts.set(key, next);
  return next;
}

function evictLiveFactOnReject<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  promise: Promise<T>,
): Promise<T> {
  return promise.catch((error) => {
    cache.delete(key);
    throw error;
  });
}

/**
 * Cached read of the live CI aggregate, backed by pull_request_detail_sync_state (#selfhost-ci-verification,
 * sibling to the #2537 PR-state cache in backfill.ts). A fresh cache row (webhook-invalidated on
 * check_run/check_suite `completed` via invalidateCiStateCache, capped at CI_STATE_CACHE_MAX_AGE_MS) is served
 * without a GitHub call; otherwise fetches live via fetchLiveCiAggregatePreferGraphQl and write-throughs the
 * result via writeThroughCiStateCache. Fail-open throughout: any cache read/write hiccup falls back to /
 * degrades to a live fetch, never blocks it.
 *
 * `forceRefresh` (set by refreshLiveCiAggregate below, mirroring refreshLiveMergeState's OWN "never durable-
 * cached" contract for merge-state): skips the freshness CHECK entirely (the existing row is still fetched, to
 * carry its `status` field into the write-through's previousState, but is never treated as a hit), so this always
 * fetches live -- a "refresh" caller needs a genuinely fresh read even within the SAME job pass (e.g. re-checking
 * CI right after this pass's own gate/check-run publication, which can flip a status GitHub hasn't sent a webhook
 * for yet). The WRITE-through still happens on a forced refresh, so a LATER pass/job still benefits from this read.
 *
 * Deliberately implemented HERE, not in backfill.ts (where writeThroughCiStateCache/isCiStateCacheFresh/
 * deserializeCachedCiAggregate live) -- a same-module call from backfill.ts to its own
 * fetchLiveCiAggregatePreferGraphQl would be invisible to `vi.spyOn(backfillModule,
 * "fetchLiveCiAggregatePreferGraphQl")`, which many existing tests already rely on to intercept the CROSS-module
 * call this file has always made. Keeping the orchestration here preserves that exact, already-tested call shape.
 *
 * NEVER call this from an act-boundary merge/close decision -- services/agent-approval-queue.ts and
 * services/agent-action-executor.ts call fetchLiveCiAggregate/fetchLiveCiAggregatePreferGraphQl directly, by
 * design, and must keep doing so.
 */
async function cachedFetchLiveCiAggregate(
  env: Env,
  args: {
    repoFullName: string;
    prNumber: number;
    headSha: string | null | undefined;
    token: string | undefined;
    requiredContexts: ReadonlySet<string> | null | undefined;
    requiredContextsKey: string;
    advisoryCheckRuns: ReadonlyArray<{ name: string; appSlug: string }> | null | undefined;
    forceRefresh: boolean;
    // False when the caller's own required-context lookup FAILED (not merely resolved to "none configured") --
    // that fail-open aggregate must never be persisted under the normal key, or a transient lookup error would
    // mask the repo's real required-context state for every other reader until the entry's TTL expires (#selfhost-
    // ci-verification gate review finding). The live-fetched aggregate is still returned to THIS caller either way.
    requiredContextsResolved: boolean;
    admissionKey?: GitHubRateLimitAdmissionKey | undefined;
  },
): Promise<LiveCiAggregate> {
  const cached = await getPullRequestDetailSyncState(env, args.repoFullName, args.prNumber).catch(() => null);
  if (!args.forceRefresh && cached && isCiStateCacheFresh(cached, args.headSha, args.requiredContextsKey)) {
    const deserialized = deserializeCachedCiAggregate(cached);
    if (deserialized) {
      incr(CI_STATE_CACHE_METRIC, { field: "aggregate", result: "hit" });
      return deserialized;
    }
  }
  incr(CI_STATE_CACHE_METRIC, { field: "aggregate", result: args.forceRefresh ? "forced" : "miss" });
  const live = await fetchLiveCiAggregatePreferGraphQl(env, args.repoFullName, args.headSha, args.token, args.requiredContexts, args.admissionKey, args.advisoryCheckRuns);
  if (args.requiredContextsResolved) {
    await writeThroughCiStateCache(env, args.repoFullName, args.prNumber, cached, args.headSha, args.requiredContextsKey, live);
  }
  return live;
}

function fetchLiveCiAggregateWithRequiredContexts(
  env: Env,
  args: {
    repoFullName: string;
    facts: LiveGithubFacts;
    prNumber: number;
    headSha: string | null | undefined;
    baseRef: string | null | undefined;
    token: string | undefined;
    expectedCiContexts: ReadonlyArray<string> | null | undefined;
    advisoryCheckRuns: ReadonlyArray<{ name: string; appSlug: string }> | null | undefined;
    forceRefresh: boolean;
    admissionKey?: GitHubRateLimitAdmissionKey | undefined;
  },
): Promise<LiveCiAggregate> {
  // CI refresh callers need fresh check/status state; branch protection contexts move slowly enough to stay
  // request-cached. When the #1941 flag is on, fetchLiveCiAggregatePreferGraphQl collapses the check/status reads
  // into one GraphQL rollup (reusing these requiredContexts), else it uses the proven REST aggregate.
  // cachedFetchLiveCiAggregate (#selfhost-ci-verification) is the durable, cross-job snapshot cache sibling to
  // this request-scoped LiveGithubFacts memo -- it is only ever consulted here, on a LiveGithubFacts miss.
  return cachedRequiredStatusContexts(env, args.repoFullName, args.facts, args.baseRef, args.token, args.expectedCiContexts, args.admissionKey)
    .catch(() => ({ requiredContexts: null, resolved: false }))
    .then(({ requiredContexts, resolved }) =>
      cachedFetchLiveCiAggregate(env, {
        repoFullName: args.repoFullName,
        prNumber: args.prNumber,
        headSha: args.headSha,
        token: args.token,
        requiredContexts,
        // #4372: the advisory-check-runs config changes the aggregate but is NOT part of the resolved required
        // contexts, so fold its fingerprint into the durable cache key alongside them — else a config change
        // would keep serving a stale aggregate computed against the old advisory list.
        requiredContextsKey: `${resolvedRequiredContextsKeyPart(requiredContexts)}|adv:${advisoryCheckRunsKeyPart(args.advisoryCheckRuns)}`,
        advisoryCheckRuns: args.advisoryCheckRuns,
        forceRefresh: args.forceRefresh,
        requiredContextsResolved: resolved,
        admissionKey: args.admissionKey,
      }),
    );
}

export function cachedLiveCiAggregate(
  env: Env,
  args: {
    repoFullName: string;
    facts: LiveGithubFacts;
    prNumber: number;
    headSha: string | null | undefined;
    baseRef: string | null | undefined;
    token: string | undefined;
    expectedCiContexts: ReadonlyArray<string> | null | undefined;
    advisoryCheckRuns: ReadonlyArray<{ name: string; appSlug: string }> | null | undefined;
    admissionKey?: GitHubRateLimitAdmissionKey | undefined;
  },
): Promise<LiveCiAggregate> {
  const key = liveFactKey(args.repoFullName, args.headSha, args.baseRef, liveFactTokenPart(args.token), `${expectedCiContextsKeyPart(args.expectedCiContexts)}|adv:${advisoryCheckRunsKeyPart(args.advisoryCheckRuns)}`);
  const cached = args.facts.ciAggregates.get(key);
  if (cached) return cached;
  const next = evictLiveFactOnReject(
    args.facts.ciAggregates,
    key,
    fetchLiveCiAggregateWithRequiredContexts(env, {
      repoFullName: args.repoFullName,
      facts: args.facts,
      prNumber: args.prNumber,
      headSha: args.headSha,
      baseRef: args.baseRef,
      token: args.token,
      expectedCiContexts: args.expectedCiContexts,
      advisoryCheckRuns: args.advisoryCheckRuns,
      forceRefresh: false,
      admissionKey: args.admissionKey,
    }),
  );
  args.facts.ciAggregates.set(key, next);
  return next;
}

export function refreshLiveCiAggregate(
  env: Env,
  args: {
    repoFullName: string;
    facts: LiveGithubFacts;
    prNumber: number;
    headSha: string | null | undefined;
    baseRef: string | null | undefined;
    token: string | undefined;
    expectedCiContexts: ReadonlyArray<string> | null | undefined;
    advisoryCheckRuns: ReadonlyArray<{ name: string; appSlug: string }> | null | undefined;
    admissionKey?: GitHubRateLimitAdmissionKey | undefined;
  },
): Promise<LiveCiAggregate> {
  const key = liveFactKey(args.repoFullName, args.headSha, args.baseRef, liveFactTokenPart(args.token), `${expectedCiContextsKeyPart(args.expectedCiContexts)}|adv:${advisoryCheckRunsKeyPart(args.advisoryCheckRuns)}`);
  const next = evictLiveFactOnReject(
    args.facts.ciAggregates,
    key,
    fetchLiveCiAggregateWithRequiredContexts(env, {
      repoFullName: args.repoFullName,
      facts: args.facts,
      prNumber: args.prNumber,
      headSha: args.headSha,
      baseRef: args.baseRef,
      token: args.token,
      expectedCiContexts: args.expectedCiContexts,
      advisoryCheckRuns: args.advisoryCheckRuns,
      forceRefresh: true,
      admissionKey: args.admissionKey,
    }),
  );
  args.facts.ciAggregates.set(key, next);
  args.facts.forcedCiAggregateKeys.add(key);
  return next;
}

export function cachedLiveMergeState(
  env: Env,
  repoFullName: string,
  facts: LiveGithubFacts,
  prNumber: number,
  token: string | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<string | undefined> {
  const key = liveFactKey(repoFullName, prNumber, liveFactTokenPart(token));
  const cached = facts.mergeStates.get(key);
  if (cached) return cached;
  // #2537: on a request-local miss, check the DURABLE cross-webhook cache before hitting GitHub — this is the
  // readiness/freshness-guard path, not the act-boundary disposition (that's refreshLiveMergeState below, which
  // NEVER routes through the durable cache). A durable hit is itself memoized request-locally for the rest of
  // this pass via facts.mergeStates, same as a live fetch would be.
  const next = evictLiveFactOnReject(
    facts.mergeStates,
    key,
    cachedFetchLivePullRequestMergeState(env, repoFullName, prNumber, token, admissionKey),
  );
  facts.mergeStates.set(key, next);
  return next;
}

// #4220 contradiction: the stored pr.mergeableState lags GitHub's async recompute, so a base-conflicting PR could
// read clean here (safe to merge) while the disposition reads the live dirty and auto-CLOSES it. This ALWAYS
// force-refetches live from GitHub and MUST NEVER be routed through the durable pull_request_detail_sync_state
// cache added by #2537 — both act-boundary-adjacent callers (runAgentMaintenancePlanAndExecute's disposition
// input, and the unified-comment mirror) depend on this staying live and uncached.
export function refreshLiveMergeState(
  env: Env,
  repoFullName: string,
  facts: LiveGithubFacts,
  prNumber: number,
  token: string | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<string | undefined> {
  const key = liveFactKey(repoFullName, prNumber, liveFactTokenPart(token));
  const next = evictLiveFactOnReject(
    facts.mergeStates,
    key,
    fetchLivePullRequestMergeState(env, repoFullName, prNumber, token, admissionKey),
  );
  facts.mergeStates.set(key, next);
  facts.forcedMergeStateKeys.add(key);
  return next;
}

// #4498: reuses THIS PASS's own already-FORCED-live-refreshed value when an earlier refreshLiveMergeState/
// refreshLiveCiAggregate call in the SAME webhook pass (sharing the SAME `facts` object and key -- e.g.
// maybePublishPrPublicSurface's own post-gate-publish refresh) already populated the request-local memo,
// instead of re-fetching the identical resource from GitHub a second time. Deliberately NOT a plain "is
// something in facts.mergeStates/ciAggregates for this key" check: cachedLiveMergeState/cachedLiveCiAggregate
// (the READINESS-path reader) populate the SAME map/key from the DURABLE cross-webhook cache on their own
// request-local miss -- a durable-cache HIT there can be an OLDER webhook's snapshot, exactly what
// refreshLiveMergeState's #4220 doc comment above prohibits for this act-boundary-adjacent disposition input.
// So this only reuses a memoized value when its key is ALSO in forcedMergeStateKeys/forcedCiAggregateKeys --
// i.e. it was written by a FORCED (genuinely-live-this-pass) call, never by a cached-path reader. On a genuine
// miss (no forced call has run yet this pass) this falls through to a REAL live refresh, so behavior can only
// ever improve (fewer calls) over the pre-fix code, never go staler.
export function reuseOrRefreshLiveMergeState(
  env: Env,
  repoFullName: string,
  facts: LiveGithubFacts,
  prNumber: number,
  token: string | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<string | undefined> {
  const key = liveFactKey(repoFullName, prNumber, liveFactTokenPart(token));
  const cached = facts.forcedMergeStateKeys.has(key) ? facts.mergeStates.get(key) : undefined;
  if (cached) return cached;
  return refreshLiveMergeState(env, repoFullName, facts, prNumber, token, admissionKey);
}

export function reuseOrRefreshLiveCiAggregate(
  env: Env,
  repoFullName: string,
  facts: LiveGithubFacts,
  prNumber: number,
  headSha: string | null | undefined,
  baseRef: string | null | undefined,
  token: string | undefined,
  expectedCiContexts: ReadonlyArray<string> | null | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
  // #4372: trailing/optional so existing positional callers stay byte-identical (advisoryCheckRuns undefined ⇒
  // exclusion off, today's behavior). Folded into the memo key alongside expectedCiContexts, like the entry points.
  advisoryCheckRuns?: ReadonlyArray<{ name: string; appSlug: string }> | null,
): Promise<LiveCiAggregate> {
  const key = liveFactKey(repoFullName, headSha, baseRef, liveFactTokenPart(token), `${expectedCiContextsKeyPart(expectedCiContexts)}|adv:${advisoryCheckRunsKeyPart(advisoryCheckRuns)}`);
  const cached = facts.forcedCiAggregateKeys.has(key) ? facts.ciAggregates.get(key) : undefined;
  if (cached) return cached;
  return refreshLiveCiAggregate(env, { repoFullName, facts, prNumber, headSha, baseRef, token, expectedCiContexts, advisoryCheckRuns, admissionKey });
}
