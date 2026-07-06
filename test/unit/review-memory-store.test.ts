import { describe, expect, it } from "vitest";
import { MAX_REVIEW_SUPPRESSIONS_PER_REPO, listReviewSuppressions, recordReviewSuppression } from "../../src/db/repositories";
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
    // Insert one MORE than the cap, each a distinct key so none upsert into another.
    for (let i = 0; i < MAX_REVIEW_SUPPRESSIONS_PER_REPO + 1; i += 1) {
      await recordReviewSuppression(env, { repoFullName: "owner/repo", category: "ai_review_split", patternHash: `hash-${i}` });
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
});
