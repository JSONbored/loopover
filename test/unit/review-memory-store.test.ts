import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_REVIEW_SUPPRESSIONS_PER_REPO, listReviewSuppressions, recordReviewSuppression } from "../../src/db/repositories";
import * as repositoriesModule from "../../src/db/repositories";
import { clearReviewSuppressionCacheForTest, getCachedReviewSuppressions, invalidateReviewSuppressionCache } from "../../src/review/review-memory-wire";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import { createTestEnv } from "../helpers/d1";

// Review memory (#2178, data-model slice of #1964): insert/list repository accessors over the
// review_suppression table (migrations/0114). No recording-trigger and no apply-during-review logic here --
// those are separate slices (#2180/#2181) -- this only covers the store itself.
describe("review-memory suppression store (#2178)", () => {
  async function rawRow(env: Env, repoFullName: string, category: string, pathGlob: string, patternHash: string) {
    return env.DB.prepare("select id, created_at, created_by from review_suppression where repo_full_name = ? and category = ? and path_glob = ? and pattern_hash = ?")
      .bind(repoFullName, category, pathGlob, patternHash)
      .first<{ id: string; created_at: string; created_by: string | null }>();
  }

  async function rawCount(env: Env, repoFullName: string): Promise<number> {
    const row = await env.DB.prepare("select count(*) as n from review_suppression where repo_full_name = ?")
      .bind(repoFullName)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  it("records a suppression signal and lists it back for the repo", async () => {
    const env = createTestEnv();
    const record = await recordReviewSuppression(env, {
      repoFullName: "owner/repo",
      category: "ai_review_split",
      pathGlob: "src/foo/**",
      patternHash: "hash-1",
      createdBy: "maintainer1",
    });
    expect(record).toMatchObject({
      repoFullName: "owner/repo",
      category: "ai_review_split",
      pathGlob: "src/foo/**",
      patternHash: "hash-1",
      createdBy: "maintainer1",
    });
    const listed = await listReviewSuppressions(env, "owner/repo");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ category: "ai_review_split", patternHash: "hash-1" });
  });

  it("defaults pathGlob to empty string (repo-wide) and createdBy to null when omitted", async () => {
    const env = createTestEnv();
    const record = await recordReviewSuppression(env, {
      repoFullName: "owner/repo",
      category: "ai_review_inconclusive",
      patternHash: "hash-2",
    });
    expect(record.pathGlob).toBe("");
    expect(record.createdBy).toBeNull();
  });

  it("listReviewSuppressions is empty for a repo with no rows at all", async () => {
    const env = createTestEnv();
    expect(await listReviewSuppressions(env, "owner/nothing-here")).toEqual([]);
  });

  it("re-recording the SAME key upserts (bumps createdAt/createdBy) instead of creating a duplicate row", async () => {
    const env = createTestEnv();
    await recordReviewSuppression(env, { repoFullName: "owner/repo", category: "ai_review_split", pathGlob: "src/**", patternHash: "hash-3", createdBy: "maintainer1" });
    const firstRow = await rawRow(env, "owner/repo", "ai_review_split", "src/**", "hash-3");
    await recordReviewSuppression(env, { repoFullName: "owner/repo", category: "ai_review_split", pathGlob: "src/**", patternHash: "hash-3", createdBy: "maintainer2" });
    const secondRow = await rawRow(env, "owner/repo", "ai_review_split", "src/**", "hash-3");
    expect(secondRow?.id).toBe(firstRow?.id); // same row, not a new insert
    expect(secondRow?.created_by).toBe("maintainer2"); // most recent dismissal wins
    const listed = await listReviewSuppressions(env, "owner/repo");
    expect(listed).toHaveLength(1);
  });

  it("a DIFFERENT category, pathGlob, or patternHash is a distinct row, not an upsert of an existing one", async () => {
    const env = createTestEnv();
    await recordReviewSuppression(env, { repoFullName: "owner/repo", category: "ai_review_split", pathGlob: "src/**", patternHash: "hash-a" });
    await recordReviewSuppression(env, { repoFullName: "owner/repo", category: "ai_consensus_defect", pathGlob: "src/**", patternHash: "hash-a" });
    await recordReviewSuppression(env, { repoFullName: "owner/repo", category: "ai_review_split", pathGlob: "test/**", patternHash: "hash-a" });
    await recordReviewSuppression(env, { repoFullName: "owner/repo", category: "ai_review_split", pathGlob: "src/**", patternHash: "hash-b" });
    expect(await listReviewSuppressions(env, "owner/repo")).toHaveLength(4);
  });

  it("scopes listing strictly to the given repo -- another repo's rows never leak in", async () => {
    const env = createTestEnv();
    await recordReviewSuppression(env, { repoFullName: "owner/repo-a", category: "ai_review_split", patternHash: "hash-1" });
    await recordReviewSuppression(env, { repoFullName: "owner/repo-b", category: "ai_review_split", patternHash: "hash-1" });
    expect(await listReviewSuppressions(env, "owner/repo-a")).toHaveLength(1);
    expect(await listReviewSuppressions(env, "owner/repo-b")).toHaveLength(1);
  });

  it("enforces the per-repo bound: once a repo exceeds MAX_REVIEW_SUPPRESSIONS_PER_REPO rows, the OLDEST are evicted", async () => {
    const env = createTestEnv();
    // Fake timers force each insert's real createdAt (nowIso()) to be strictly increasing -- on real clocks, a
    // fast in-memory D1 can otherwise complete several of these calls within the same millisecond, tying
    // createdAt and leaving "which one is oldest" to the #4501 id tiebreak (a random UUID) rather than the
    // insertion sequence this test's own assertions rely on.
    vi.useFakeTimers();
    try {
      const start = new Date("2026-01-01T00:00:00.000Z");
      // Insert one MORE than the cap, each a distinct key so none upsert into another.
      for (let i = 0; i < MAX_REVIEW_SUPPRESSIONS_PER_REPO + 1; i += 1) {
        vi.setSystemTime(new Date(start.getTime() + i * 1000));
        await recordReviewSuppression(env, { repoFullName: "owner/repo", category: "ai_review_split", patternHash: `hash-${i}` });
      }
    } finally {
      vi.useRealTimers();
    }
    // REGRESSION: assert the underlying table itself shrank back to the cap, via a raw count query --
    // listReviewSuppressions clamps its OWN `limit` param to MAX_REVIEW_SUPPRESSIONS_PER_REPO (see the test
    // below), which would mask a completely broken eviction (e.g. a query that silently no-ops) by returning
    // exactly MAX rows regardless of how many actually remain in the table.
    expect(await rawCount(env, "owner/repo")).toBe(MAX_REVIEW_SUPPRESSIONS_PER_REPO);
    const listed = await listReviewSuppressions(env, "owner/repo", MAX_REVIEW_SUPPRESSIONS_PER_REPO + 5);
    expect(listed.length).toBe(MAX_REVIEW_SUPPRESSIONS_PER_REPO);
    // The very first inserted key ("hash-0") is the oldest and must have been evicted.
    expect(listed.some((row) => row.patternHash === "hash-0")).toBe(false);
    // The most recently inserted key must survive.
    expect(listed.some((row) => row.patternHash === `hash-${MAX_REVIEW_SUPPRESSIONS_PER_REPO}`)).toBe(true);
  });

  it("does NOT prune when a repo is at or under the cap (REGRESSION: pruneReviewSuppressionsOverCap's early-return branch)", async () => {
    const env = createTestEnv();
    for (let i = 0; i < 3; i += 1) {
      await recordReviewSuppression(env, { repoFullName: "owner/repo", category: "ai_review_split", patternHash: `hash-${i}` });
    }
    expect(await rawCount(env, "owner/repo")).toBe(3);
  });

  it("REGRESSION: a prune-query failure is swallowed -- recordReviewSuppression still returns the newly recorded row instead of throwing", async () => {
    const env = createTestEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      // Only the prune-cap query selects a bare `id` ordered by created_at -- the read-back select() in
      // recordReviewSuppression itself selects the full row with no ORDER BY, so this pattern isolates the
      // cap-eviction query without breaking the insert/read-back this same call also performs.
      if (/select\s+"id"\s+from\s+"review_suppression".*order by.*created_at.*desc/i.test(sql)) {
        throw new Error("d1 down");
      }
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const record = await recordReviewSuppression(env, { repoFullName: "owner/repo", category: "ai_review_split", patternHash: "hash-1" });
    expect(record).toMatchObject({ repoFullName: "owner/repo", patternHash: "hash-1" });
  });

  it("listReviewSuppressions clamps an out-of-range limit into [1, MAX_REVIEW_SUPPRESSIONS_PER_REPO]", async () => {
    const env = createTestEnv();
    await recordReviewSuppression(env, { repoFullName: "owner/repo", category: "ai_review_split", patternHash: "hash-1" });
    await recordReviewSuppression(env, { repoFullName: "owner/repo", category: "ai_consensus_defect", patternHash: "hash-2" });
    expect(await listReviewSuppressions(env, "owner/repo", 0)).toHaveLength(1);
    expect(await listReviewSuppressions(env, "owner/repo", 999_999)).toHaveLength(2);
  });

  async function insertRawSuppression(env: Env, id: string, repoFullName: string, patternHash: string, createdAt: string) {
    await env.DB.prepare(
      "insert into review_suppression (id, repo_full_name, category, path_glob, pattern_hash, created_at) values (?, ?, 'ai_review_split', '', ?, ?)",
    )
      .bind(id, repoFullName, patternHash, createdAt)
      .run();
  }

  it("INVARIANT (#4501): listReviewSuppressions orders same-createdAt rows deterministically by id, regardless of insertion order", async () => {
    const env = createTestEnv();
    // Same bug class as #4481 (listPullRequestFiles): without an id tiebreak, rows tied on createdAt have no
    // guaranteed order. Inserted here in a SCRAMBLED (non-id-sorted) order on purpose.
    for (const id of ["id-b", "id-d", "id-a", "id-c"]) {
      await insertRawSuppression(env, id, "owner/repo", id, "2026-06-01T00:00:00.000Z");
    }
    const listed = await listReviewSuppressions(env, "owner/repo");
    expect(listed.map((row) => row.id)).toEqual(["id-d", "id-c", "id-b", "id-a"]); // id DESC tiebreak
  });

  it("REGRESSION (#4501): eviction at the cap boundary is governed by the id tiebreak, not insertion order, when several suppressions share one createdAt", async () => {
    const env = createTestEnv();
    const repoFullName = "owner/repo";
    // 496 rows with distinct, more-recent timestamps than the tied group below -- fills the table right up to
    // where the tied group straddles the MAX_REVIEW_SUPPRESSIONS_PER_REPO cap boundary.
    const newerStartMs = Date.parse("2026-06-01T00:00:00.000Z");
    const NEWER_COUNT = 496;
    await env.DB.batch(
      Array.from({ length: NEWER_COUNT }, (_, index) =>
        env.DB.prepare(
          "insert into review_suppression (id, repo_full_name, category, path_glob, pattern_hash, created_at) values (?, ?, 'ai_review_split', '', ?, ?)",
        ).bind(`newer-${index}`, repoFullName, `newer-hash-${index}`, new Date(newerStartMs + index * 1000).toISOString()),
      ),
    );
    // 5 suppressions from ONE `@gittensory resolve` whole-PR Promise.all batch -- identical (same-millisecond)
    // createdAt, inserted here in a SCRAMBLED (non-id-sorted) order to prove the eviction outcome doesn't
    // depend on it.
    const tiedCreatedAt = "2026-01-01T00:00:00.000Z";
    const scrambledTiedIds = ["tied-c", "tied-e", "tied-a", "tied-d", "tied-b"];
    await env.DB.batch(
      scrambledTiedIds.map((id) =>
        env.DB.prepare(
          "insert into review_suppression (id, repo_full_name, category, path_glob, pattern_hash, created_at) values (?, ?, 'ai_review_split', '', ?, ?)",
        ).bind(id, repoFullName, id, tiedCreatedAt),
      ),
    );
    // Trigger the internal prune pass exactly how production reaches it: one more recorded suppression. Its
    // real (current) createdAt is newest of all, so it and the 496 "newer" rows above are always kept -- the
    // cap boundary lands squarely inside the 5-row tied group.
    await recordReviewSuppression(env, { repoFullName, category: "ai_review_split", patternHash: "trigger-hash" });

    const listed = await listReviewSuppressions(env, repoFullName, MAX_REVIEW_SUPPRESSIONS_PER_REPO);
    const survivingTiedIds = new Set(scrambledTiedIds.filter((id) => listed.some((row) => row.id === id)));
    // 1 trigger + 496 newer + 5 tied = 502 total; the cap keeps the newest 500 -- exactly 2 of the 5 tied rows
    // are evicted, deterministically the two with the LOWEST id (desc(id) ranks the highest id first among ties).
    expect(survivingTiedIds).toEqual(new Set(["tied-e", "tied-d", "tied-c"]));
    expect(await rawCount(env, repoFullName)).toBe(MAX_REVIEW_SUPPRESSIONS_PER_REPO);
  });
});

// Short in-isolate TTL cache over listReviewSuppressions (#4508), mirroring rag.ts's chunkCountCache.
describe("getCachedReviewSuppressions / invalidateReviewSuppressionCache (#4508)", () => {
  it("INVARIANT: a repeated read within the TTL for the same repo makes ZERO additional D1 reads", async () => {
    clearReviewSuppressionCacheForTest();
    const env = createTestEnv();
    await recordReviewSuppression(env, { repoFullName: "owner/repo", category: "ai_review_split", patternHash: "hash-1" });
    const t0 = 1_000_000;
    const first = await getCachedReviewSuppressions(env, "owner/repo", t0);
    expect(first).toHaveLength(1);

    const spy = vi.spyOn(repositoriesModule, "listReviewSuppressions");
    const second = await getCachedReviewSuppressions(env, "owner/repo", t0 + 30_000); // well within the 60s TTL
    // Read the assertion BEFORE mockRestore() — mockRestore() also resets recorded calls.
    expect(spy).not.toHaveBeenCalled(); // reused the cached set — no fresh listReviewSuppressions call
    spy.mockRestore();

    expect(second).toEqual(first);
  });

  it("REGRESSION: a fresh suppression recorded between two renders IS reflected in the very next render, not masked by a stale cache entry", async () => {
    clearReviewSuppressionCacheForTest();
    const env = createTestEnv();
    const t0 = 2_000_000;
    const before = await getCachedReviewSuppressions(env, "owner/live-repo", t0);
    expect(before).toHaveLength(0); // cold cache, nothing recorded yet — this populates the cache with an empty set

    // A maintainer runs `@gittensory resolve` between the two renders, well within the cache's TTL.
    await recordReviewSuppression(env, { repoFullName: "owner/live-repo", category: "ai_review_split", patternHash: "hash-fresh" });
    invalidateReviewSuppressionCache("owner/live-repo");

    const after = await getCachedReviewSuppressions(env, "owner/live-repo", t0 + 5_000); // still within the 60s TTL
    expect(after).toHaveLength(1); // the fresh write is visible — NOT masked by the stale empty cached set
    expect(after[0]).toMatchObject({ patternHash: "hash-fresh" });
  });

  it("cache expires naturally past the TTL even without an explicit invalidation", async () => {
    clearReviewSuppressionCacheForTest();
    const env = createTestEnv();
    const t0 = 3_000_000;
    await getCachedReviewSuppressions(env, "owner/repo", t0); // populates the cache with an empty set

    await recordReviewSuppression(env, { repoFullName: "owner/repo", category: "ai_review_split", patternHash: "hash-late" });
    // No invalidateReviewSuppressionCache call here — relies on TTL expiry alone.
    const afterTtl = await getCachedReviewSuppressions(env, "owner/repo", t0 + 60_001);
    expect(afterTtl).toHaveLength(1);
  });

  it("caches independently per repoFullName", async () => {
    clearReviewSuppressionCacheForTest();
    const env = createTestEnv();
    await recordReviewSuppression(env, { repoFullName: "owner/repo-a", category: "ai_review_split", patternHash: "hash-a" });
    const t0 = 4_000_000;
    const a = await getCachedReviewSuppressions(env, "owner/repo-a", t0);
    const b = await getCachedReviewSuppressions(env, "owner/repo-b", t0);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });
});

describe("getCachedReviewSuppressions: cache hit/miss telemetry (#4448)", () => {
  afterEach(() => resetMetrics());

  async function auditEvent(env: Env, eventType: string, repoFullName: string) {
    return env.DB.prepare("SELECT outcome, target_key FROM audit_events WHERE event_type = ? AND target_key = ?")
      .bind(eventType, repoFullName)
      .first<{ outcome: string; target_key: string }>();
  }

  it("INVARIANT: a cache HIT (within TTL) fires exactly the hit counter/audit-event pair, and NOT the miss pair", async () => {
    clearReviewSuppressionCacheForTest();
    const env = createTestEnv();
    const t0 = 5_000_000;
    await getCachedReviewSuppressions(env, "owner/telemetry-repo", t0); // first call: a miss (cold cache)
    resetMetrics();
    await env.DB.prepare("DELETE FROM audit_events").run(); // isolate to the SECOND call's telemetry only

    const second = await getCachedReviewSuppressions(env, "owner/telemetry-repo", t0 + 30_000); // within the 60s TTL
    expect(second).toEqual([]);

    const rendered = await renderMetrics();
    expect(rendered).toContain("gittensory_review_memory_cache_hit_total 1");
    expect(rendered).not.toContain("gittensory_review_memory_cache_miss_total");
    const hitEvent = await auditEvent(env, "github_app.review_memory_cache_hit", "owner/telemetry-repo");
    expect(hitEvent?.outcome).toBe("completed");
    expect(await auditEvent(env, "github_app.review_memory_cache_miss", "owner/telemetry-repo")).toBeUndefined();
  });

  it("INVARIANT: a cache MISS (cold cache) fires exactly the miss counter/audit-event pair, and NOT the hit pair", async () => {
    clearReviewSuppressionCacheForTest();
    const env = createTestEnv();
    const first = await getCachedReviewSuppressions(env, "owner/telemetry-repo-2", 6_000_000);
    expect(first).toEqual([]);

    const rendered = await renderMetrics();
    expect(rendered).toContain("gittensory_review_memory_cache_miss_total 1");
    expect(rendered).not.toContain("gittensory_review_memory_cache_hit_total");
    const missEvent = await auditEvent(env, "github_app.review_memory_cache_miss", "owner/telemetry-repo-2");
    expect(missEvent?.outcome).toBe("completed");
    expect(await auditEvent(env, "github_app.review_memory_cache_hit", "owner/telemetry-repo-2")).toBeUndefined();
  });

  it("REGRESSION: TTL expiry is correctly counted as a miss, not silently uninstrumented", async () => {
    clearReviewSuppressionCacheForTest();
    const env = createTestEnv();
    const t0 = 7_000_000;
    await getCachedReviewSuppressions(env, "owner/telemetry-repo-3", t0); // populates the cache
    resetMetrics();
    await env.DB.prepare("DELETE FROM audit_events").run();

    await getCachedReviewSuppressions(env, "owner/telemetry-repo-3", t0 + 60_001); // past the 60s TTL

    const rendered = await renderMetrics();
    expect(rendered).toContain("gittensory_review_memory_cache_miss_total 1");
    expect(rendered).not.toContain("gittensory_review_memory_cache_hit_total");
  });

  it("swallows a failing cache-hit audit-event write without throwing, still returning the cached suppression list", async () => {
    clearReviewSuppressionCacheForTest();
    const env = createTestEnv();
    const t0 = 8_000_000;
    await recordReviewSuppression(env, { repoFullName: "owner/telemetry-repo-4", category: "ai_review_split", patternHash: "hash-swallow" });
    await getCachedReviewSuppressions(env, "owner/telemetry-repo-4", t0); // populates the cache

    const writeSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockRejectedValueOnce(new Error("D1 write error"));
    const second = await getCachedReviewSuppressions(env, "owner/telemetry-repo-4", t0 + 30_000); // a cache hit
    writeSpy.mockRestore();

    expect(second).toHaveLength(1); // the failed audit write never surfaces to the caller
  });
});
