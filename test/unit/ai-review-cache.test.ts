import { describe, expect, it, vi } from "vitest";
import { countPublishedAiReviewHeads, getCachedAiReview, getLatestPublishedAiReview, markAiReviewPublished, putCachedAiReview } from "../../src/db/repositories";
import { aiReviewCacheInputFingerprint, type AiReviewCacheInput } from "../../src/review/ai-review-cache-input";
import { createTestEnv } from "../helpers/d1";

const baseFingerprintInput = (): AiReviewCacheInput => ({
  title: "Fix the retry loop",
  mode: "block",
  byok: false,
  provider: null,
  model: null,
  aiReviewAllAuthors: false,
  aiReviewCloseConfidence: null,
  aiReviewCombine: null,
  aiReviewOnMerge: null,
  aiReviewReviewers: null,
  gatePack: null,
  reviewerPlan: null,
  selfHostProviderConfig: null,
  selfHostAiModelOverride: null,
  reviewFiles: [],
  profile: null,
  securityFocus: false,
  inlineComments: false,
  pathInstructions: [],
  pathGuidance: "",
  repoInstructions: null,
      excludePaths: [],
      pathFilters: [],
  changedPaths: ["src/changed.ts"],
  features: {
    grounding: false,
    rag: false,
    enrichment: false,
    reputation: false,
  },
});

describe("AI review cache (#1)", () => {
  it("misses on a nullish head SHA (read returns null; write is a no-op)", async () => {
    const env = createTestEnv();
    expect(await getCachedAiReview(env, "o/r", 1, null, "advisory")).toBeNull();
    expect(await getCachedAiReview(env, "o/r", 1, undefined, "advisory")).toBeNull();
    await putCachedAiReview(env, "o/r", 1, null, "advisory", { notes: "x", reviewerCount: 1 }); // no-op, no throw
    expect(await getCachedAiReview(env, "o/r", 1, "sha", "advisory")).toBeNull(); // nothing was stored
  });

  it("reuses a stored review ONLY on the same (repo, pull, head SHA, mode)", async () => {
    const env = createTestEnv();
    await putCachedAiReview(env, "o/r", 7, "sha1", "block", { notes: "the review", reviewerCount: 2 });
    expect(await getCachedAiReview(env, "o/r", 7, "sha1", "block")).toEqual({ notes: "the review", reviewerCount: 2, findings: [] });
    expect(await getCachedAiReview(env, "o/r", 7, "sha1", "advisory")).toBeNull(); // mode changed → miss
    expect(await getCachedAiReview(env, "o/r", 7, "sha2", "block")).toBeNull(); // new head SHA → miss
    expect(await getCachedAiReview(env, "o/r", 8, "sha1", "block")).toBeNull(); // different PR → miss
  });

  it("upserts — a re-run at the same key replaces the stored review (+ mode)", async () => {
    const env = createTestEnv();
    await putCachedAiReview(env, "o/r", 7, "sha1", "advisory", { notes: "first", reviewerCount: 1 });
    await putCachedAiReview(env, "o/r", 7, "sha1", "block", {
      notes: "second",
      reviewerCount: 2,
      findings: [{ code: "ai_review_split", severity: "critical", title: "Split", detail: "One reviewer blocked." }],
    });
    expect(await getCachedAiReview(env, "o/r", 7, "sha1", "block")).toEqual({
      notes: "second",
      reviewerCount: 2,
      findings: [{ code: "ai_review_split", severity: "critical", title: "Split", detail: "One reviewer blocked." }],
    });
  });

  it("stores ISO created_at values on insert and conflict update", async () => {
    const env = createTestEnv();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-30T09:00:00.123Z"));
      await putCachedAiReview(env, "o/r", 8, "sha1", "advisory", { notes: "first", reviewerCount: 1 });
      const inserted = await env.DB.prepare("SELECT created_at AS createdAt FROM ai_review_cache WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ?")
        .bind("o/r", 8, "sha1")
        .first<{ createdAt: string }>();
      expect(inserted?.createdAt).toBe("2026-06-30T09:00:00.123Z");
      expect(inserted?.createdAt).not.toContain(" ");

      vi.setSystemTime(new Date("2026-06-30T09:05:00.456Z"));
      await putCachedAiReview(env, "o/r", 8, "sha1", "block", { notes: "second", reviewerCount: 2 });
      const updated = await env.DB.prepare("SELECT created_at AS createdAt FROM ai_review_cache WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ?")
        .bind("o/r", 8, "sha1")
        .first<{ createdAt: string }>();
      expect(updated?.createdAt).toBe("2026-06-30T09:05:00.456Z");
      expect(updated?.createdAt).not.toContain(" ");
    } finally {
      vi.useRealTimers();
    }
  });

  it("round-trips structured review metadata and replaces it on upsert", async () => {
    const env = createTestEnv();
    await putCachedAiReview(env, "o/r", 9, "sha1", "advisory", {
      notes: "first",
      reviewerCount: 1,
      metadata: { rag: { enabled: true, injected: true, retrievedPaths: ["src/a.ts"] } },
    });
    expect(await getCachedAiReview(env, "o/r", 9, "sha1", "advisory")).toEqual({
      notes: "first",
      reviewerCount: 1,
      findings: [],
      metadata: { rag: { enabled: true, injected: true, retrievedPaths: ["src/a.ts"] } },
    });

    await putCachedAiReview(env, "o/r", 9, "sha1", "advisory", {
      notes: "second",
      reviewerCount: 2,
      metadata: { rag: { enabled: true, injected: false, retrievedPaths: [] } },
    });
    expect(await getCachedAiReview(env, "o/r", 9, "sha1", "advisory")).toEqual({
      notes: "second",
      reviewerCount: 2,
      findings: [],
      metadata: { rag: { enabled: true, injected: false, retrievedPaths: [] } },
    });
  });

  it("misses old cache rows when callers require an input fingerprint", async () => {
    const env = createTestEnv();
    await putCachedAiReview(env, "o/r", 10, "sha1", "block", {
      notes: "old review",
      reviewerCount: 1,
    });

    expect(await getCachedAiReview(env, "o/r", 10, "sha1", "block", "ai-review-input:v1:new")).toBeNull();
    expect(await getCachedAiReview(env, "o/r", 10, "sha1", "block")).toEqual({
      notes: "old review",
      reviewerCount: 1,
      findings: [],
    });
  });

  it("reuses fingerprinted cache rows only when the review input fingerprint matches", async () => {
    const env = createTestEnv();
    const matching = await aiReviewCacheInputFingerprint({
      ...baseFingerprintInput(),
      repoInstructions: "Use the current repository review guide.",
    });
    const repeated = await aiReviewCacheInputFingerprint({
      ...baseFingerprintInput(),
      repoInstructions: "Use the current repository review guide.",
    });
    const changed = await aiReviewCacheInputFingerprint({
      ...baseFingerprintInput(),
      repoInstructions: "Use an older repository review guide.",
    });
    expect(repeated).toBe(matching);
    expect(changed).not.toBe(matching);

    await putCachedAiReview(env, "o/r", 11, "sha1", "block", {
      notes: "fresh review",
      reviewerCount: 2,
      metadata: { inputFingerprint: matching },
    });

    expect(await getCachedAiReview(env, "o/r", 11, "sha1", "block", changed)).toBeNull();
    expect(await getCachedAiReview(env, "o/r", 11, "sha1", "block", matching)).toEqual({
      notes: "fresh review",
      reviewerCount: 2,
      findings: [],
      metadata: { inputFingerprint: matching },
    });
  });

  describe("non-cacheable rows (#regate-churn bounded-cooldown reuse)", () => {
    it("defaults a row to cacheable when review.cacheable is omitted (unchanged behavior)", async () => {
      const env = createTestEnv();
      await putCachedAiReview(env, "o/r", 20, "sha1", "block", { notes: "clean review", reviewerCount: 1 });
      const row = await env.DB.prepare("SELECT cacheable FROM ai_review_cache WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ?")
        .bind("o/r", 20, "sha1")
        .first<{ cacheable: number }>();
      expect(row?.cacheable).toBe(1);
      expect(await getCachedAiReview(env, "o/r", 20, "sha1", "block")).toEqual({ notes: "clean review", reviewerCount: 1, findings: [] });
    });

    it("persists a non-cacheable outcome but the STRICT read (no options) still misses it, same as before this column existed", async () => {
      const env = createTestEnv();
      await putCachedAiReview(env, "o/r", 21, "sha1", "block", { notes: "consensus defect", reviewerCount: 2, cacheable: false });
      const row = await env.DB.prepare("SELECT cacheable FROM ai_review_cache WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ?")
        .bind("o/r", 21, "sha1")
        .first<{ cacheable: number }>();
      expect(row?.cacheable).toBe(0); // the attempt WAS persisted
      expect(await getCachedAiReview(env, "o/r", 21, "sha1", "block")).toBeNull(); // but never a durable hit
    });

    it("misses a non-cacheable row when the caller does not opt into allowNonCacheable", async () => {
      const env = createTestEnv();
      await putCachedAiReview(env, "o/r", 22, "sha1", "block", { notes: "held", reviewerCount: 1, cacheable: false });
      expect(await getCachedAiReview(env, "o/r", 22, "sha1", "block", undefined, {})).toBeNull();
    });

    it("reuses a non-cacheable row within the cooldown when allowNonCacheable + maxAgeMs are given", async () => {
      const env = createTestEnv();
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
        await putCachedAiReview(env, "o/r", 23, "sha1", "block", { notes: "consensus defect", reviewerCount: 2, cacheable: false });

        vi.setSystemTime(new Date("2026-07-01T00:10:00.000Z")); // 10 minutes later, within a 30-minute cooldown
        expect(
          await getCachedAiReview(env, "o/r", 23, "sha1", "block", undefined, { allowNonCacheable: true, maxAgeMs: 30 * 60 * 1000 }),
        ).toEqual({ notes: "consensus defect", reviewerCount: 2, findings: [] });
      } finally {
        vi.useRealTimers();
      }
    });

    it("falls through to a miss once a non-cacheable row ages past maxAgeMs", async () => {
      const env = createTestEnv();
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
        await putCachedAiReview(env, "o/r", 24, "sha1", "block", { notes: "consensus defect", reviewerCount: 2, cacheable: false });

        vi.setSystemTime(new Date("2026-07-01T00:31:00.000Z")); // 31 minutes later, past a 30-minute cooldown
        expect(
          await getCachedAiReview(env, "o/r", 24, "sha1", "block", undefined, { allowNonCacheable: true, maxAgeMs: 30 * 60 * 1000 }),
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a genuinely cacheable row is unaffected by allowNonCacheable/maxAgeMs (unbounded reuse, as before)", async () => {
      const env = createTestEnv();
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
        await putCachedAiReview(env, "o/r", 25, "sha1", "block", { notes: "clean review", reviewerCount: 1, cacheable: true });

        vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z")); // a month later — far past any non-cacheable cooldown
        expect(
          await getCachedAiReview(env, "o/r", 25, "sha1", "block", undefined, { allowNonCacheable: true, maxAgeMs: 30 * 60 * 1000 }),
        ).toEqual({ notes: "clean review", reviewerCount: 1, findings: [] });
      } finally {
        vi.useRealTimers();
      }
    });

    it("still enforces the mode + input-fingerprint match on a non-cacheable reuse", async () => {
      const env = createTestEnv();
      await putCachedAiReview(env, "o/r", 26, "sha1", "block", {
        notes: "held",
        reviewerCount: 1,
        cacheable: false,
        metadata: { inputFingerprint: "fp-v1" },
      });
      const opts = { allowNonCacheable: true, maxAgeMs: 30 * 60 * 1000 };
      expect(await getCachedAiReview(env, "o/r", 26, "sha1", "advisory", undefined, opts)).toBeNull(); // mode mismatch
      expect(await getCachedAiReview(env, "o/r", 26, "sha1", "block", "fp-v2", opts)).toBeNull(); // fingerprint mismatch
      expect(await getCachedAiReview(env, "o/r", 26, "sha1", "block", "fp-v1", opts)).toEqual({
        notes: "held",
        reviewerCount: 1,
        findings: [],
        metadata: { inputFingerprint: "fp-v1" },
      });
    });

    it("treats a missing maxAgeMs as a zero-width cooldown (any elapsed time is stale)", async () => {
      const env = createTestEnv();
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
        await putCachedAiReview(env, "o/r", 28, "sha1", "block", { notes: "held", reviewerCount: 1, cacheable: false });

        vi.setSystemTime(new Date("2026-07-01T00:00:01.000Z")); // 1 second later
        expect(await getCachedAiReview(env, "o/r", 28, "sha1", "block", undefined, { allowNonCacheable: true })).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("fails closed (treats as stale) when the elapsed age is negative — a clock-skewed created_at", async () => {
      const env = createTestEnv();
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
        await putCachedAiReview(env, "o/r", 29, "sha1", "block", { notes: "held", reviewerCount: 1, cacheable: false });

        vi.setSystemTime(new Date("2026-06-30T23:59:00.000Z")); // "now" moved BEFORE the row's created_at
        expect(
          await getCachedAiReview(env, "o/r", 29, "sha1", "block", undefined, { allowNonCacheable: true, maxAgeMs: 30 * 60 * 1000 }),
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("fails closed (treats as stale) when created_at cannot be parsed as a date", async () => {
      const env = createTestEnv();
      await putCachedAiReview(env, "o/r", 30, "sha1", "block", { notes: "held", reviewerCount: 1, cacheable: false });
      await env.DB.prepare("UPDATE ai_review_cache SET created_at = ? WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ?")
        .bind("not-a-date", "o/r", 30, "sha1")
        .run();
      expect(
        await getCachedAiReview(env, "o/r", 30, "sha1", "block", undefined, { allowNonCacheable: true, maxAgeMs: 30 * 60 * 1000 }),
      ).toBeNull();
    });

    it("upserting a fresh cacheable review over a prior non-cacheable row makes it a durable hit again", async () => {
      const env = createTestEnv();
      await putCachedAiReview(env, "o/r", 27, "sha1", "block", { notes: "consensus defect", reviewerCount: 2, cacheable: false });
      expect(await getCachedAiReview(env, "o/r", 27, "sha1", "block")).toBeNull();

      await putCachedAiReview(env, "o/r", 27, "sha1", "block", { notes: "resolved, clean review", reviewerCount: 2, cacheable: true });
      expect(await getCachedAiReview(env, "o/r", 27, "sha1", "block")).toEqual({
        notes: "resolved, clean review",
        reviewerCount: 2,
        findings: [],
      });
    });
  });

  describe("published_at — a published row is immune to the non-cacheable cooldown (#regate-churn)", () => {
    it("bypasses maxAgeMs entirely once markAiReviewPublished stamps the row, even long past the cooldown", async () => {
      const env = createTestEnv();
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
        await putCachedAiReview(env, "o/r", 40, "sha1", "block", { notes: "dynamic-context review", reviewerCount: 1, cacheable: false });
        await markAiReviewPublished(env, "o/r", 40, "sha1");

        vi.setSystemTime(new Date("2026-07-01T05:00:00.000Z")); // 5 hours later — far past the 30-minute cooldown
        expect(
          await getCachedAiReview(env, "o/r", 40, "sha1", "block", undefined, { allowNonCacheable: true, maxAgeMs: 30 * 60 * 1000 }),
        ).toEqual({ notes: "dynamic-context review", reviewerCount: 1, findings: [] });
      } finally {
        vi.useRealTimers();
      }
    });

    it("still misses an UNPUBLISHED non-cacheable row past the cooldown (unchanged behavior)", async () => {
      const env = createTestEnv();
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
        await putCachedAiReview(env, "o/r", 41, "sha1", "block", { notes: "dynamic-context review", reviewerCount: 1, cacheable: false });

        vi.setSystemTime(new Date("2026-07-01T00:31:00.000Z"));
        expect(
          await getCachedAiReview(env, "o/r", 41, "sha1", "block", undefined, { allowNonCacheable: true, maxAgeMs: 30 * 60 * 1000 }),
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("still requires allowNonCacheable even when published — the caller's own opt-in is unaffected", async () => {
      const env = createTestEnv();
      await putCachedAiReview(env, "o/r", 42, "sha1", "block", { notes: "held", reviewerCount: 1, cacheable: false });
      await markAiReviewPublished(env, "o/r", 42, "sha1");
      expect(await getCachedAiReview(env, "o/r", 42, "sha1", "block")).toBeNull();
    });

    it("still enforces mode + input-fingerprint match on a published non-cacheable reuse", async () => {
      const env = createTestEnv();
      await putCachedAiReview(env, "o/r", 43, "sha1", "block", { notes: "held", reviewerCount: 1, cacheable: false, metadata: { inputFingerprint: "fp-v1" } });
      await markAiReviewPublished(env, "o/r", 43, "sha1");
      const opts = { allowNonCacheable: true, maxAgeMs: 30 * 60 * 1000 };
      expect(await getCachedAiReview(env, "o/r", 43, "sha1", "advisory", undefined, opts)).toBeNull(); // mode mismatch
      expect(await getCachedAiReview(env, "o/r", 43, "sha1", "block", "fp-v2", opts)).toBeNull(); // fingerprint mismatch (content actually changed)
      expect(await getCachedAiReview(env, "o/r", 43, "sha1", "block", "fp-v1", opts)).toEqual({ notes: "held", reviewerCount: 1, findings: [], metadata: { inputFingerprint: "fp-v1" } });
    });

    it("is a no-op with no matching row (nullish head SHA, or a head that was never written)", async () => {
      const env = createTestEnv();
      await expect(markAiReviewPublished(env, "o/r", 44, null)).resolves.toBeUndefined();
      await expect(markAiReviewPublished(env, "o/r", 44, "never-written-sha")).resolves.toBeUndefined();
    });

    it("is idempotent — a second call never rewrites an already-published timestamp", async () => {
      const env = createTestEnv();
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
        await putCachedAiReview(env, "o/r", 45, "sha1", "block", { notes: "held", reviewerCount: 1, cacheable: false });
        await markAiReviewPublished(env, "o/r", 45, "sha1");
        const first = await env.DB.prepare("SELECT published_at AS publishedAt FROM ai_review_cache WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ?").bind("o/r", 45, "sha1").first<{ publishedAt: string }>();

        vi.setSystemTime(new Date("2026-07-01T01:00:00.000Z"));
        await markAiReviewPublished(env, "o/r", 45, "sha1");
        const second = await env.DB.prepare("SELECT published_at AS publishedAt FROM ai_review_cache WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ?").bind("o/r", 45, "sha1").first<{ publishedAt: string }>();

        expect(second?.publishedAt).toBe(first?.publishedAt);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a fresh write (a real subject change) resets published_at back to unpublished", async () => {
      const env = createTestEnv();
      await putCachedAiReview(env, "o/r", 46, "sha1", "block", { notes: "held", reviewerCount: 1, cacheable: false });
      await markAiReviewPublished(env, "o/r", 46, "sha1");
      // Same head SHA, but a genuinely different review content overwrites the row (e.g. a corrected retry) —
      // the NEW content has not been published yet, so the stale publish marker must not leak onto it.
      await putCachedAiReview(env, "o/r", 46, "sha1", "block", { notes: "revised", reviewerCount: 1, cacheable: false });
      const row = await env.DB.prepare("SELECT published_at AS publishedAt FROM ai_review_cache WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ?").bind("o/r", 46, "sha1").first<{ publishedAt: string | null }>();
      expect(row?.publishedAt).toBeNull();
      expect(await getCachedAiReview(env, "o/r", 46, "sha1", "block", undefined, { allowNonCacheable: true, maxAgeMs: 30 * 60 * 1000 })).toEqual({ notes: "revised", reviewerCount: 1, findings: [] });
    });
  });

  describe("getLatestPublishedAiReview — maintainer-gated freeze reuse across a head-SHA change (#regate-churn)", () => {
    it("misses when nothing has ever been published for this PR", async () => {
      const env = createTestEnv();
      await putCachedAiReview(env, "o/r", 50, "sha1", "block", { notes: "unpublished", reviewerCount: 1 });
      expect(await getLatestPublishedAiReview(env, "o/r", 50, "block")).toBeNull();
    });

    it("returns the most recently PUBLISHED review across DIFFERENT head SHAs (a contributor push while held)", async () => {
      const env = createTestEnv();
      await putCachedAiReview(env, "o/r", 51, "sha1", "block", { notes: "first review", reviewerCount: 1 });
      await markAiReviewPublished(env, "o/r", 51, "sha1");
      // A newer head SHA exists (the contributor pushed again), but was never independently published.
      await putCachedAiReview(env, "o/r", 51, "sha2", "block", { notes: "never published", reviewerCount: 1 });

      expect(await getLatestPublishedAiReview(env, "o/r", 51, "block")).toEqual({ notes: "first review", reviewerCount: 1, findings: [] });
    });

    it("respects the ai_review_mode filter, same as getCachedAiReview", async () => {
      const env = createTestEnv();
      await putCachedAiReview(env, "o/r", 52, "sha1", "advisory", { notes: "advisory mode", reviewerCount: 1 });
      await markAiReviewPublished(env, "o/r", 52, "sha1");
      expect(await getLatestPublishedAiReview(env, "o/r", 52, "block")).toBeNull();
      expect(await getLatestPublishedAiReview(env, "o/r", 52, "advisory")).toEqual({ notes: "advisory mode", reviewerCount: 1, findings: [] });
    });

    it("round-trips findings and metadata like getCachedAiReview", async () => {
      const env = createTestEnv();
      await putCachedAiReview(env, "o/r", 53, "sha1", "block", {
        notes: "held review",
        reviewerCount: 2,
        findings: [{ code: "ai_review_split", severity: "critical", title: "Split", detail: "One reviewer blocked." }],
        metadata: { inputFingerprint: "fp-v1" },
      });
      await markAiReviewPublished(env, "o/r", 53, "sha1");
      expect(await getLatestPublishedAiReview(env, "o/r", 53, "block")).toEqual({
        notes: "held review",
        reviewerCount: 2,
        findings: [{ code: "ai_review_split", severity: "critical", title: "Split", detail: "One reviewer blocked." }],
        metadata: { inputFingerprint: "fp-v1" },
      });
    });

    it("picks the LATEST published head when more than one head was independently published", async () => {
      const env = createTestEnv();
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
        await putCachedAiReview(env, "o/r", 54, "sha1", "block", { notes: "older published review", reviewerCount: 1 });
        await markAiReviewPublished(env, "o/r", 54, "sha1");

        vi.setSystemTime(new Date("2026-07-01T01:00:00.000Z"));
        await putCachedAiReview(env, "o/r", 54, "sha2", "block", { notes: "newer published review", reviewerCount: 1 });
        await markAiReviewPublished(env, "o/r", 54, "sha2");

        expect(await getLatestPublishedAiReview(env, "o/r", 54, "block")).toEqual({ notes: "newer published review", reviewerCount: 1, findings: [] });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("countPublishedAiReviewHeads — auto_pause_after_reviewed_commits (#2042)", () => {
    it("returns 0 when no published reviews exist for the PR", async () => {
      const env = createTestEnv();
      await putCachedAiReview(env, "o/r", 60, "sha1", "block", { notes: "unpublished", reviewerCount: 1 });
      expect(await countPublishedAiReviewHeads(env, "o/r", 60)).toBe(0);
      expect(await countPublishedAiReviewHeads(env, "o/r", 99)).toBe(0);
    });

    it("counts distinct published head SHAs and ignores unpublished rows", async () => {
      const env = createTestEnv();
      await putCachedAiReview(env, "o/r", 61, "sha1", "block", { notes: "first", reviewerCount: 1 });
      await markAiReviewPublished(env, "o/r", 61, "sha1");
      await putCachedAiReview(env, "o/r", 61, "sha2", "block", { notes: "second", reviewerCount: 1 });
      await markAiReviewPublished(env, "o/r", 61, "sha2");
      await putCachedAiReview(env, "o/r", 61, "sha3", "block", { notes: "pending", reviewerCount: 1 });
      expect(await countPublishedAiReviewHeads(env, "o/r", 61)).toBe(2);
    });

    it("returns 0 when the count query yields no row (fail-safe)", async () => {
      const env = createTestEnv();
      const prepareSpy = vi.spyOn(env.DB, "prepare").mockReturnValue({
        bind: () => ({ first: async () => null }),
      } as never);
      expect(await countPublishedAiReviewHeads(env, "o/r", 62)).toBe(0);
      prepareSpy.mockRestore();
    });
  });
});
