import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPullRequestDetailSyncState,
  upsertPullRequestDetailSyncState,
} from "../../src/db/repositories";
import {
  cachedFetchLivePullRequestHeadSha,
  cachedFetchLivePullRequestMergeState,
  cachedFetchLivePullRequestState,
  deserializeCachedCiAggregate,
  invalidateCiStateCache,
  invalidatePrStateCache,
  isCiStateCacheFresh,
  primeDurablePrStateCache,
  writeThroughCiStateCache,
} from "../../src/github/backfill";
import { clearGitHubResponseCacheForTest } from "../../src/github/client";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import { createTestEnv } from "../helpers/d1";
import type { LiveCiAggregate } from "../../src/github/backfill";
import type { PullRequestDetailSyncStateRecord } from "../../src/types";

function stubFetchTracking(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    urls.push(url);
    return handler(url, init);
  });
  return urls;
}

// Simulates a D1 write hiccup ONLY for pull_request_detail_sync_state upserts, so the cache's fail-open
// write-through can be exercised without a full DB outage. Module-scope (not describe-scoped) so both the
// PR-state and CI-state cache describe blocks below can share it.
function withPrStateWriteFailure(env: Env): Env {
  const db = env.DB as unknown as { prepare(sql: string): unknown; batch(statements: unknown[]): Promise<unknown> };
  return {
    ...env,
    DB: {
      prepare(sql: string) {
        if (sql.includes("pull_request_detail_sync_state") && sql.trim().toUpperCase().startsWith("INSERT")) {
          throw new Error("pull_request_detail_sync_state write failed");
        }
        return db.prepare.call(db, sql);
      },
      batch(statements: unknown[]) {
        return db.batch.call(db, statements);
      },
    } as unknown as D1Database,
  };
}

// Mirrors withPrStateWriteFailure but for the READ side -- exercises invalidateCiStateCache's own
// getPullRequestDetailSyncState(...).catch(() => null) fail-open arm (it must still write the invalidation
// even when it cannot read the prior row to preserve `status`).
function withPrStateReadFailure(env: Env): Env {
  const db = env.DB as unknown as { prepare(sql: string): unknown; batch(statements: unknown[]): Promise<unknown> };
  return {
    ...env,
    DB: {
      prepare(sql: string) {
        if (sql.includes("pull_request_detail_sync_state") && sql.trim().toUpperCase().startsWith("SELECT")) {
          throw new Error("pull_request_detail_sync_state read failed");
        }
        return db.prepare.call(db, sql);
      },
      batch(statements: unknown[]) {
        return db.batch.call(db, statements);
      },
    } as unknown as D1Database,
  };
}

// Durable, webhook-invalidated cache for the bare PR-state read (#2537). Mirrors
// backfill-file-hydration-scoping.test.ts's helpers/structure for the sibling files cache.
describe("durable PR-state cache (#2537)", () => {
  afterEach(() => {
    clearGitHubResponseCacheForTest();
    resetMetrics();
    vi.unstubAllGlobals();
  });

  // REGRESSION (#2595 review defect): the three cached readers below share ONE prStateFetchedAt column as their
  // freshness stamp. Before this fix, each reader wrote through ONLY the one field it cared about, so a write
  // from reader A would make reader B's UN-fetched field look "fresh" to a subsequent call -- silently returning
  // undefined for a field that was simply never populated, not confirmed empty on GitHub. The fix fetches the
  // full PR payload (all three narrow fetchers already hit the exact same endpoint) and writes all three fields
  // through together on every live fetch, so this cross-field false-freshness can no longer happen.
  it("REGRESSION (#2595): a live fetch from ONE cached reader also warms the OTHER TWO, since they share one fetchedAt stamp", async () => {
    const env = createTestEnv();
    let fetchCount = 0;
    stubFetchTracking((url) => {
      if (url.includes("/pulls/40")) {
        fetchCount += 1;
        return Response.json({ number: 40, mergeable_state: "clean", state: "open", head: { sha: "shared-sha" } });
      }
      return new Response("not found", { status: 404 });
    });

    // Only the mergeable_state reader is called...
    const mergeableState = await cachedFetchLivePullRequestMergeState(env, "owner/repo", 40, "tok");
    expect(mergeableState).toBe("clean");
    expect(fetchCount).toBe(1);

    // ...yet the OTHER two fields are now cache HITS too, without a second GitHub call, and return the REAL
    // fetched values -- not a false "confirmed fresh, but never actually fetched" undefined.
    const state = await cachedFetchLivePullRequestState(env, "owner/repo", 40, "tok");
    const headSha = await cachedFetchLivePullRequestHeadSha(env, "owner/repo", 40, "tok");
    expect(state).toBe("open");
    expect(headSha).toBe("shared-sha");
    expect(fetchCount).toBe(1); // no additional GitHub calls were needed
  });

  describe("cachedFetchLivePullRequestMergeState", () => {
    it("cache miss on first read — fetches live and writes the row through", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      const urls = stubFetchTracking((url) => (url.includes("/pulls/10") ? Response.json({ number: 10, mergeable_state: "clean" }) : new Response("not found", { status: 404 })));

      const result = await cachedFetchLivePullRequestMergeState(env, "owner/repo", 10, "tok");

      expect(result).toBe("clean");
      expect(urls.some((url) => url.includes("/pulls/10"))).toBe(true);
      expect(await getPullRequestDetailSyncState(env, "owner/repo", 10)).toMatchObject({ prMergeableState: "clean" });
    });

    it("fail-open: a write-through hiccup still returns the live value (the cache is an optimization, not a dependency)", async () => {
      const env = withPrStateWriteFailure(createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" }));
      stubFetchTracking((url) => (url.includes("/pulls/14") ? Response.json({ number: 14, mergeable_state: "clean" }) : new Response("not found", { status: 404 })));

      const result = await cachedFetchLivePullRequestMergeState(env, "owner/repo", 14, "tok");

      expect(result).toBe("clean");
    });

    it("cache hit on unchanged state — never calls GitHub", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, {
        repoFullName: "owner/repo",
        pullNumber: 11,
        status: "complete",
        prMergeableState: "blocked",
        prStateFetchedAt: new Date().toISOString(),
      });
      const urls = stubFetchTracking(() => new Response("must not be called", { status: 500 }));

      const result = await cachedFetchLivePullRequestMergeState(env, "owner/repo", 11, "tok");

      expect(result).toBe("blocked");
      expect(urls).toHaveLength(0);
    });

    it("cache expiry — a stale row past the TTL is treated as a miss (fetch IS called)", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, {
        repoFullName: "owner/repo",
        pullNumber: 12,
        status: "complete",
        prMergeableState: "blocked",
        prStateFetchedAt: "2020-01-01T00:00:00.000Z",
      });
      const urls = stubFetchTracking((url) => (url.includes("/pulls/12") ? Response.json({ number: 12, mergeable_state: "clean" }) : new Response("not found", { status: 404 })));

      const result = await cachedFetchLivePullRequestMergeState(env, "owner/repo", 12, "tok");

      expect(result).toBe("clean");
      expect(urls.some((url) => url.includes("/pulls/12"))).toBe(true);
    });

    it("an undefined live read still stamps prStateFetchedAt, so the next read within the TTL is a cache hit returning undefined, not a fetch", async () => {
      const env = createTestEnv();
      let fetchCount = 0;
      stubFetchTracking((url) => {
        if (url.includes("/pulls/13")) {
          fetchCount += 1;
          return Response.json({ number: 13 }); // no mergeable_state field
        }
        return new Response("not found", { status: 404 });
      });

      const first = await cachedFetchLivePullRequestMergeState(env, "owner/repo", 13, "tok");
      expect(first).toBeUndefined();
      expect(fetchCount).toBe(1);
      expect(await getPullRequestDetailSyncState(env, "owner/repo", 13)).toMatchObject({ prMergeableState: null });

      const second = await cachedFetchLivePullRequestMergeState(env, "owner/repo", 13, "tok");
      expect(second).toBeUndefined();
      expect(fetchCount).toBe(1); // still 1 — served from cache, not re-fetched
    });
  });

  describe("cachedFetchLivePullRequestState", () => {
    it("cache miss then cache hit", async () => {
      const env = createTestEnv();
      let fetchCount = 0;
      stubFetchTracking((url) => {
        if (url.includes("/pulls/20")) {
          fetchCount += 1;
          return Response.json({ number: 20, state: "open" });
        }
        return new Response("not found", { status: 404 });
      });

      const first = await cachedFetchLivePullRequestState(env, "owner/repo", 20, "tok");
      const second = await cachedFetchLivePullRequestState(env, "owner/repo", 20, "tok");

      expect(first).toBe("open");
      expect(second).toBe("open");
      expect(fetchCount).toBe(1);
    });

    it("a cache hit whose stored prState is null (nullish live read) returns undefined, not null", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, {
        repoFullName: "owner/repo",
        pullNumber: 21,
        status: "complete",
        prState: null,
        prStateFetchedAt: new Date().toISOString(),
      });
      const urls = stubFetchTracking(() => new Response("must not be called", { status: 500 }));

      const result = await cachedFetchLivePullRequestState(env, "owner/repo", 21, "tok");

      expect(result).toBeUndefined();
      expect(urls).toHaveLength(0);
    });

    it("a cache-miss live fetch whose payload omits state returns undefined (nullish fallback on a fresh fetch, not a cache hit)", async () => {
      const env = createTestEnv();
      let fetchCount = 0;
      stubFetchTracking((url) => {
        if (url.includes("/pulls/22")) {
          fetchCount += 1;
          return Response.json({ number: 22 }); // no state field
        }
        return new Response("not found", { status: 404 });
      });

      const result = await cachedFetchLivePullRequestState(env, "owner/repo", 22, "tok");

      expect(result).toBeUndefined();
      expect(fetchCount).toBe(1);
      expect(await getPullRequestDetailSyncState(env, "owner/repo", 22)).toMatchObject({ prState: null });
    });
  });

  describe("cachedFetchLivePullRequestHeadSha", () => {
    it("cache miss then cache hit, and does not serve a cached row missing headSha", async () => {
      const env = createTestEnv();
      // A row that is fresh (prStateFetchedAt set) but has no headSha yet must still be treated as a miss.
      await upsertPullRequestDetailSyncState(env, {
        repoFullName: "owner/repo",
        pullNumber: 30,
        status: "complete",
        prStateFetchedAt: new Date().toISOString(),
      });
      let fetchCount = 0;
      stubFetchTracking((url) => {
        if (url.includes("/pulls/30")) {
          fetchCount += 1;
          return Response.json({ number: 30, head: { sha: "live-sha" } });
        }
        return new Response("not found", { status: 404 });
      });

      const first = await cachedFetchLivePullRequestHeadSha(env, "owner/repo", 30, "tok");
      expect(first).toBe("live-sha");
      expect(fetchCount).toBe(1);

      const second = await cachedFetchLivePullRequestHeadSha(env, "owner/repo", 30, "tok");
      expect(second).toBe("live-sha");
      expect(fetchCount).toBe(1);
    });

    // REGRESSION (#2595 review defect): the three cached readers share ONE prStateFetchedAt stamp, so a live
    // fetch triggered by ANY of them must write through ALL THREE fields together -- otherwise a field this
    // reader doesn't care about (mergeable_state/state) would look "fresh" to a later, different reader despite
    // never having been fetched. A fresh full-payload fetch that carries no head.sha still writes the OTHER two
    // fields through (and still never CLEARS a prior headSha -- the PARTIAL-UPDATE CONTRACT is preserved).
    it("writes mergeable_state/state through even when the live head SHA is undefined, and never clears a prior headSha", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, {
        repoFullName: "owner/repo",
        pullNumber: 31,
        status: "never_synced",
        headSha: "prior-sha",
        prStateFetchedAt: "2020-01-01T00:00:00.000Z", // stale -- forces a live re-fetch
      });
      stubFetchTracking(() => Response.json({ number: 31, mergeable_state: "clean", state: "open" })); // no head.sha

      const result = await cachedFetchLivePullRequestHeadSha(env, "owner/repo", 31, "tok");

      expect(result).toBeUndefined(); // no head.sha in the live payload
      const row = await getPullRequestDetailSyncState(env, "owner/repo", 31);
      expect(row?.headSha).toBe("prior-sha"); // NOT cleared -- omitted, not written as null
      expect(row?.prMergeableState).toBe("clean"); // written through together with this call's own fetch
      expect(row?.prState).toBe("open");
      expect(row?.prStateFetchedAt).not.toBe("2020-01-01T00:00:00.000Z"); // the shared stamp advanced
    });

    it("still creates a row (with the other fields null) on a fresh PR whose live payload carries no head.sha at all", async () => {
      const env = createTestEnv();
      stubFetchTracking(() => Response.json({ number: 32 })); // no head.sha, no mergeable_state, no state

      const result = await cachedFetchLivePullRequestHeadSha(env, "owner/repo", 32, "tok");

      expect(result).toBeUndefined();
      const row = await getPullRequestDetailSyncState(env, "owner/repo", 32);
      expect(row?.headSha).toBeNull(); // never had one to preserve
      expect(row?.prMergeableState).toBeNull();
      expect(row?.prState).toBeNull();
      expect(row?.prStateFetchedAt).not.toBeNull(); // the fetch DID succeed (confirmed-empty, not "never fetched")
    });
  });

  describe("primeDurablePrStateCache", () => {
    it("does nothing when the live payload is undefined (upstream fetchLivePullRequest failed)", async () => {
      const env = createTestEnv();

      await primeDurablePrStateCache(env, "owner/repo", 60, undefined);

      expect(await getPullRequestDetailSyncState(env, "owner/repo", 60)).toBeNull();
    });

    it("writes mergeable_state/state/headSha through from an already-fetched live payload", async () => {
      const env = createTestEnv();

      await primeDurablePrStateCache(env, "owner/repo", 61, { mergeable_state: "dirty", state: "open", head: { sha: "primed-sha" } });

      expect(await getPullRequestDetailSyncState(env, "owner/repo", 61)).toMatchObject({
        prMergeableState: "dirty",
        prState: "open",
        headSha: "primed-sha",
        prStateFetchedAt: expect.any(String),
      });
    });

    it("stores a nullish mergeable_state/state from the live payload as null, not undefined", async () => {
      const env = createTestEnv();

      await primeDurablePrStateCache(env, "owner/repo", 62, { head: { sha: "primed-sha-2" } });

      expect(await getPullRequestDetailSyncState(env, "owner/repo", 62)).toMatchObject({
        prMergeableState: null,
        prState: null,
        headSha: "primed-sha-2",
      });
    });

    it("PARTIAL-UPDATE CONTRACT: omits headSha (does not clear a prior one) when the live payload carries no head.sha", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, {
        repoFullName: "owner/repo",
        pullNumber: 63,
        status: "complete",
        headSha: "files-cache-sha",
        filesSyncedAt: "2026-05-20T00:00:00.000Z",
      });

      await primeDurablePrStateCache(env, "owner/repo", 63, { mergeable_state: "clean", state: "open" });

      expect(await getPullRequestDetailSyncState(env, "owner/repo", 63)).toMatchObject({
        prMergeableState: "clean",
        prState: "open",
        headSha: "files-cache-sha",
        filesSyncedAt: "2026-05-20T00:00:00.000Z",
      });
    });

    it("REGRESSION: clears filesSyncedAt when a PR-state-only write advances headSha", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, {
        repoFullName: "owner/repo",
        pullNumber: 65,
        status: "complete",
        headSha: "old-benign-head",
        filesSyncedAt: "2026-05-20T00:00:00.000Z",
      });

      await primeDurablePrStateCache(env, "owner/repo", 65, { mergeable_state: "clean", state: "open", head: { sha: "new-unreviewed-head" } });

      expect(await getPullRequestDetailSyncState(env, "owner/repo", 65)).toMatchObject({
        prMergeableState: "clean",
        prState: "open",
        headSha: "new-unreviewed-head",
        filesSyncedAt: null,
      });
    });

    it("keeps filesSyncedAt when a PR-state-only write repeats the files-cache headSha", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, {
        repoFullName: "owner/repo",
        pullNumber: 66,
        status: "complete",
        headSha: "already-synced-head",
        filesSyncedAt: "2026-05-20T00:00:00.000Z",
      });

      await primeDurablePrStateCache(env, "owner/repo", 66, { mergeable_state: "clean", state: "open", head: { sha: "already-synced-head" } });

      expect(await getPullRequestDetailSyncState(env, "owner/repo", 66)).toMatchObject({
        headSha: "already-synced-head",
        filesSyncedAt: "2026-05-20T00:00:00.000Z",
      });
    });

    it("primes the cache so a subsequent cachedFetchLivePullRequestMergeState reads the primed value without a network call", async () => {
      const env = createTestEnv();
      let fetchCount = 0;
      stubFetchTracking(() => {
        fetchCount += 1;
        return Response.json({ number: 64, mergeable_state: "should-not-be-fetched" });
      });

      await primeDurablePrStateCache(env, "owner/repo", 64, { mergeable_state: "primed-dirty", head: { sha: "sha-64" } });
      const result = await cachedFetchLivePullRequestMergeState(env, "owner/repo", 64, "tok");

      expect(result).toBe("primed-dirty");
      expect(fetchCount).toBe(0);
    });
  });

  describe("invalidatePrStateCache", () => {
    it("clears prMergeableState/prState/prStateFetchedAt and forces the next read to miss", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, {
        repoFullName: "owner/repo",
        pullNumber: 40,
        status: "complete",
        prMergeableState: "clean",
        prState: "open",
        prStateFetchedAt: new Date().toISOString(),
      });

      await invalidatePrStateCache(env, "owner/repo", 40);

      expect(await getPullRequestDetailSyncState(env, "owner/repo", 40)).toMatchObject({
        prMergeableState: null,
        prState: null,
        prStateFetchedAt: null,
      });

      const urls = stubFetchTracking((url) => (url.includes("/pulls/40") ? Response.json({ number: 40, mergeable_state: "dirty" }) : new Response("not found", { status: 404 })));
      const result = await cachedFetchLivePullRequestMergeState(env, "owner/repo", 40, "tok");
      expect(result).toBe("dirty");
      expect(urls.some((url) => url.includes("/pulls/40"))).toBe(true);
    });

    it("defaults status to never_synced when no prior row exists", async () => {
      const env = createTestEnv();
      await invalidatePrStateCache(env, "owner/repo", 41);
      expect(await getPullRequestDetailSyncState(env, "owner/repo", 41)).toMatchObject({ status: "never_synced" });
    });
  });

  describe("write-through preserves status (regression: must not force status: complete)", () => {
    it("a cachedFetchLivePullRequest* write does not clear an in-progress files sync's status/filesSyncedAt", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, {
        repoFullName: "owner/repo",
        pullNumber: 50,
        status: "partial",
        headSha: "sha-a",
        filesSyncedAt: "2026-05-20T00:00:00.000Z",
      });
      stubFetchTracking((url) => (url.includes("/pulls/50") ? Response.json({ number: 50, mergeable_state: "clean" }) : new Response("not found", { status: 404 })));

      await cachedFetchLivePullRequestMergeState(env, "owner/repo", 50, "tok");

      expect(await getPullRequestDetailSyncState(env, "owner/repo", 50)).toMatchObject({
        status: "partial",
        headSha: "sha-a",
        filesSyncedAt: "2026-05-20T00:00:00.000Z",
        prMergeableState: "clean",
      });
    });
  });

  describe("isPrStateCacheFresh branch coverage (via cachedFetchLivePullRequestMergeState)", () => {
    it("null fetchedAt ⇒ treated as stale (miss)", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, { repoFullName: "owner/repo", pullNumber: 60, status: "complete", prMergeableState: "clean", prStateFetchedAt: null });
      const urls = stubFetchTracking((url) => (url.includes("/pulls/60") ? Response.json({ number: 60, mergeable_state: "dirty" }) : new Response("not found", { status: 404 })));

      const result = await cachedFetchLivePullRequestMergeState(env, "owner/repo", 60, "tok");
      expect(result).toBe("dirty");
      expect(urls.some((url) => url.includes("/pulls/60"))).toBe(true);
    });

    it("unparseable fetchedAt string ⇒ treated as stale (NaN branch, miss)", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, { repoFullName: "owner/repo", pullNumber: 61, status: "complete", prMergeableState: "clean", prStateFetchedAt: "not-a-date" });
      const urls = stubFetchTracking((url) => (url.includes("/pulls/61") ? Response.json({ number: 61, mergeable_state: "dirty" }) : new Response("not found", { status: 404 })));

      const result = await cachedFetchLivePullRequestMergeState(env, "owner/repo", 61, "tok");
      expect(result).toBe("dirty");
      expect(urls.some((url) => url.includes("/pulls/61"))).toBe(true);
    });

    it("fresh fetchedAt ⇒ hit (no fetch)", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, { repoFullName: "owner/repo", pullNumber: 62, status: "complete", prMergeableState: "clean", prStateFetchedAt: new Date().toISOString() });
      const urls = stubFetchTracking(() => new Response("must not be called", { status: 500 }));

      const result = await cachedFetchLivePullRequestMergeState(env, "owner/repo", 62, "tok");
      expect(result).toBe("clean");
      expect(urls).toHaveLength(0);
    });

    it("expired fetchedAt ⇒ miss (fetch called)", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, { repoFullName: "owner/repo", pullNumber: 63, status: "complete", prMergeableState: "clean", prStateFetchedAt: "2020-01-01T00:00:00.000Z" });
      const urls = stubFetchTracking((url) => (url.includes("/pulls/63") ? Response.json({ number: 63, mergeable_state: "dirty" }) : new Response("not found", { status: 404 })));

      const result = await cachedFetchLivePullRequestMergeState(env, "owner/repo", 63, "tok");
      expect(result).toBe("dirty");
      expect(urls.some((url) => url.includes("/pulls/63"))).toBe(true);
    });
  });

  describe("metrics", () => {
    it("records miss then hit for mergeable_state across a cold then warm read", async () => {
      resetMetrics();
      const env = createTestEnv();
      stubFetchTracking((url) => (url.includes("/pulls/70") ? Response.json({ number: 70, mergeable_state: "clean" }) : new Response("not found", { status: 404 })));

      await cachedFetchLivePullRequestMergeState(env, "owner/repo", 70, "tok");
      await cachedFetchLivePullRequestMergeState(env, "owner/repo", 70, "tok");

      const metrics = await renderMetrics();
      expect(metrics).toContain('loopover_pr_state_cache_total{field="mergeable_state",result="miss"} 1');
      expect(metrics).toContain('loopover_pr_state_cache_total{field="mergeable_state",result="hit"} 1');
      expect(metrics).toContain('loopover_pr_state_cache_total{field="write",result="set"} 1');
    });
  });
});

// Durable, webhook-invalidated cache for the CI-state aggregate (#selfhost-ci-verification), sibling to the
// #2537 PR-state cache above. The read-cache-then-live-fetch-then-write-through ORCHESTRATION
// (cachedFetchLiveCiAggregate) is private to queue/processors.ts (see its own doc comment for why: a same-module
// call to fetchLiveCiAggregatePreferGraphQl would be invisible to many existing tests' `vi.spyOn` on this
// module's export) — its behavior is exercised indirectly via processJob() in queue.test.ts. This file covers
// the pure/DB-level building blocks that DO live here and ARE exported.
describe("durable CI-state cache (#selfhost-ci-verification)", () => {
  afterEach(() => {
    resetMetrics();
  });

  const sampleAggregate: LiveCiAggregate = {
    ciState: "failed",
    hasPending: false,
    hasVisiblePending: false,
    hasMissingRequiredContext: false,
    failingDetails: [{ name: "ci/build", summary: "failed", detailsUrl: "https://ci.example.test/1" }],
    nonRequiredFailingDetails: [],
    ciCompletenessWarning: null,
  };

  describe("isCiStateCacheFresh", () => {
    it("is fresh: fetched within the TTL, head_sha matches, required-contexts key matches", () => {
      const cached: Pick<PullRequestDetailSyncStateRecord, "ciHeadSha" | "ciRequiredContextsKey" | "ciStateFetchedAt"> = {
        ciHeadSha: "sha1",
        ciRequiredContextsKey: "build test",
        ciStateFetchedAt: new Date().toISOString(),
      };
      expect(isCiStateCacheFresh(cached, "sha1", "build test")).toBe(true);
    });

    it("is stale once the TTL has expired", () => {
      const cached = { ciHeadSha: "sha1", ciRequiredContextsKey: "", ciStateFetchedAt: "2020-01-01T00:00:00.000Z" };
      expect(isCiStateCacheFresh(cached, "sha1", "")).toBe(false);
    });

    it("is a miss when ciStateFetchedAt is null/missing (never cached)", () => {
      expect(isCiStateCacheFresh({ ciHeadSha: "sha1", ciRequiredContextsKey: "", ciStateFetchedAt: null }, "sha1", "")).toBe(false);
      expect(isCiStateCacheFresh(null, "sha1", "")).toBe(false);
      expect(isCiStateCacheFresh(undefined, "sha1", "")).toBe(false);
    });

    it("is a miss on a malformed fetchedAt timestamp", () => {
      expect(isCiStateCacheFresh({ ciHeadSha: "sha1", ciRequiredContextsKey: "", ciStateFetchedAt: "not-a-date" }, "sha1", "")).toBe(false);
    });

    it("is a miss when the cached head_sha no longer matches (a new commit since this row was cached), even within the TTL", () => {
      const cached = { ciHeadSha: "sha-old", ciRequiredContextsKey: "", ciStateFetchedAt: new Date().toISOString() };
      expect(isCiStateCacheFresh(cached, "sha-new", "")).toBe(false);
    });

    it("is a miss when the required-contexts key no longer matches (a settings change), even within the TTL", () => {
      const cached = { ciHeadSha: "sha1", ciRequiredContextsKey: "old-key", ciStateFetchedAt: new Date().toISOString() };
      expect(isCiStateCacheFresh(cached, "sha1", "new-key")).toBe(false);
    });

    it("treats a null cached head_sha and an undefined queried head_sha as equal (both mean 'no head sha')", () => {
      const cached = { ciHeadSha: null, ciRequiredContextsKey: "", ciStateFetchedAt: new Date().toISOString() };
      expect(isCiStateCacheFresh(cached, undefined, "")).toBe(true);
    });

    it("treats a null cached required-contexts key and an empty-string queried key as equal (both mean 'unconfigured')", () => {
      const cached = { ciHeadSha: "sha1", ciRequiredContextsKey: null, ciStateFetchedAt: new Date().toISOString() };
      expect(isCiStateCacheFresh(cached, "sha1", "")).toBe(true);
    });
  });

  describe("deserializeCachedCiAggregate", () => {
    it("round-trips a valid cached row back into the exact LiveCiAggregate shape", () => {
      const cached = {
        ciState: "failed" as const,
        ciHasPending: false,
        ciHasVisiblePending: false,
        ciHasMissingRequiredContext: false,
        ciFailingDetailsJson: JSON.stringify(sampleAggregate.failingDetails),
        ciNonRequiredFailingDetailsJson: JSON.stringify(sampleAggregate.nonRequiredFailingDetails),
        ciCompletenessWarning: null,
      };
      expect(deserializeCachedCiAggregate(cached)).toEqual(sampleAggregate);
    });

    it("returns null when ciState is missing/null (never cached)", () => {
      expect(
        deserializeCachedCiAggregate({
          ciState: null,
          ciHasPending: null,
          ciHasVisiblePending: null,
          ciHasMissingRequiredContext: null,
          ciFailingDetailsJson: null,
          ciNonRequiredFailingDetailsJson: null,
          ciCompletenessWarning: null,
        }),
      ).toBeNull();
    });

    it("fails open to null on malformed JSON in ciFailingDetailsJson (never throws)", () => {
      expect(
        deserializeCachedCiAggregate({
          ciState: "passed",
          ciHasPending: false,
          ciHasVisiblePending: false,
          ciHasMissingRequiredContext: false,
          ciFailingDetailsJson: "{not valid json",
          ciNonRequiredFailingDetailsJson: "[]",
          ciCompletenessWarning: null,
        }),
      ).toBeNull();
    });

    it("fails open to null when ciFailingDetailsJson parses to valid JSON that is NOT an array (corrupted row shape)", () => {
      // JSON.parse succeeds here (it's valid JSON), so this exercises the Array.isArray guard specifically,
      // not the catch block above -- a corrupted/malformed row must never hand callers a wrong shape.
      expect(
        deserializeCachedCiAggregate({
          ciState: "passed",
          ciHasPending: false,
          ciHasVisiblePending: false,
          ciHasMissingRequiredContext: false,
          ciFailingDetailsJson: '{"not":"an array"}',
          ciNonRequiredFailingDetailsJson: "[]",
          ciCompletenessWarning: null,
        }),
      ).toBeNull();
    });

    it("fails open to null when ciNonRequiredFailingDetailsJson parses to valid JSON that is NOT an array (corrupted row shape)", () => {
      expect(
        deserializeCachedCiAggregate({
          ciState: "passed",
          ciHasPending: false,
          ciHasVisiblePending: false,
          ciHasMissingRequiredContext: false,
          ciFailingDetailsJson: "[]",
          ciNonRequiredFailingDetailsJson: '"just a string"',
          ciCompletenessWarning: null,
        }),
      ).toBeNull();
    });

    it("defaults hasPending/hasVisiblePending/hasMissingRequiredContext to false and the JSON arrays to [] when null", () => {
      expect(
        deserializeCachedCiAggregate({
          ciState: "passed",
          ciHasPending: null,
          ciHasVisiblePending: null,
          ciHasMissingRequiredContext: null,
          ciFailingDetailsJson: null,
          ciNonRequiredFailingDetailsJson: null,
          ciCompletenessWarning: null,
        }),
      ).toEqual({
        ciState: "passed",
        hasPending: false,
        hasVisiblePending: false,
        hasMissingRequiredContext: false,
        failingDetails: [],
        nonRequiredFailingDetails: [],
        ciCompletenessWarning: null,
      });
    });
  });

  describe("writeThroughCiStateCache", () => {
    it("writes every CI field, preserving the row's existing status rather than forcing one", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, { repoFullName: "owner/repo", pullNumber: 80, status: "partial" });

      await writeThroughCiStateCache(env, "owner/repo", 80, { status: "partial" }, "sha1", "build test", sampleAggregate);

      const row = await getPullRequestDetailSyncState(env, "owner/repo", 80);
      expect(row).toMatchObject({
        status: "partial",
        ciHeadSha: "sha1",
        ciState: "failed",
        ciHasPending: false,
        ciHasVisiblePending: false,
        ciHasMissingRequiredContext: false,
        ciRequiredContextsKey: "build test",
      });
      expect(JSON.parse(row?.ciFailingDetailsJson ?? "[]")).toEqual(sampleAggregate.failingDetails);
      expect(typeof row?.ciStateFetchedAt).toBe("string");
    });

    it("defaults status to never_synced when no prior row exists", async () => {
      const env = createTestEnv();
      await writeThroughCiStateCache(env, "owner/repo", 81, null, "sha1", "", sampleAggregate);
      expect(await getPullRequestDetailSyncState(env, "owner/repo", 81)).toMatchObject({ status: "never_synced" });
    });

    it("preserves unrelated existing columns (prMergeableState, the files-cache headSha) on write", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, {
        repoFullName: "owner/repo",
        pullNumber: 82,
        status: "complete",
        headSha: "files-cache-sha",
        prMergeableState: "clean",
      });

      await writeThroughCiStateCache(env, "owner/repo", 82, { status: "complete" }, "sha1", "", sampleAggregate);

      expect(await getPullRequestDetailSyncState(env, "owner/repo", 82)).toMatchObject({
        headSha: "files-cache-sha",
        prMergeableState: "clean",
        ciState: "failed",
      });
    });

    it("fail-open: a write hiccup is swallowed, never throws", async () => {
      const env = withPrStateWriteFailure(createTestEnv());
      await expect(writeThroughCiStateCache(env, "owner/repo", 83, null, "sha1", "", sampleAggregate)).resolves.toBeUndefined();
    });

    it("stores a null ciHeadSha when the live read had no resolvable head SHA (nullish fallback, not just a truthy sha)", async () => {
      const env = createTestEnv();
      await writeThroughCiStateCache(env, "owner/repo", 85, null, null, "", sampleAggregate);
      expect(await getPullRequestDetailSyncState(env, "owner/repo", 85)).toMatchObject({ ciHeadSha: null, ciState: "failed" });
    });

    it("records the write metric", async () => {
      resetMetrics();
      const env = createTestEnv();
      await writeThroughCiStateCache(env, "owner/repo", 84, null, "sha1", "", sampleAggregate);
      expect(await renderMetrics()).toContain('loopover_ci_state_cache_total{field="write",result="set"} 1');
    });
  });

  describe("invalidateCiStateCache", () => {
    it("clears ciState/ciStateFetchedAt, preserving unrelated columns", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, {
        repoFullName: "owner/repo",
        pullNumber: 90,
        status: "complete",
        prMergeableState: "clean",
        ciHeadSha: "sha1",
        ciState: "failed",
        ciStateFetchedAt: new Date().toISOString(),
      });

      await invalidateCiStateCache(env, "owner/repo", 90);

      expect(await getPullRequestDetailSyncState(env, "owner/repo", 90)).toMatchObject({
        ciState: null,
        ciStateFetchedAt: null,
        prMergeableState: "clean",
        status: "complete",
      });
    });

    it("clears regardless of prior value (even a fresh, just-written cache entry)", async () => {
      const env = createTestEnv();
      await writeThroughCiStateCache(env, "owner/repo", 91, null, "sha1", "", sampleAggregate);
      expect(await getPullRequestDetailSyncState(env, "owner/repo", 91)).toMatchObject({ ciState: "failed" });

      await invalidateCiStateCache(env, "owner/repo", 91);

      expect(await getPullRequestDetailSyncState(env, "owner/repo", 91)).toMatchObject({ ciState: null, ciStateFetchedAt: null });
    });

    it("is a no-op (does not throw) when no row exists yet, defaulting status to never_synced", async () => {
      const env = createTestEnv();
      await expect(invalidateCiStateCache(env, "owner/repo", 92)).resolves.toBeUndefined();
      expect(await getPullRequestDetailSyncState(env, "owner/repo", 92)).toMatchObject({ status: "never_synced", ciState: null });
    });

    it("fail-open: a read hiccup on the prior-row lookup still lets the invalidation write proceed, defaulting status to never_synced", async () => {
      // readFailEnv wraps the SAME underlying D1 instance as baseEnv, breaking only SELECTs -- invalidateCiStateCache's
      // OWN getPullRequestDetailSyncState(...).catch(() => null) must swallow that and still issue the INSERT
      // (which is unaffected), so a read via the unwrapped baseEnv afterward proves the write actually landed.
      const baseEnv = createTestEnv();
      const readFailEnv = withPrStateReadFailure(baseEnv);
      await expect(invalidateCiStateCache(readFailEnv, "owner/repo", 93)).resolves.toBeUndefined();
      expect(await getPullRequestDetailSyncState(baseEnv, "owner/repo", 93)).toMatchObject({ status: "never_synced", ciState: null });
    });
  });
});
