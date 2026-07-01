import { describe, expect, it, vi } from "vitest";
import { getCachedAiReview, putCachedAiReview } from "../../src/db/repositories";
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
  gatePack: null,
  reviewerPlan: null,
  selfHostProviderConfig: null,
  baseSha: null,
  reviewFiles: [],
  profile: null,
  inlineComments: false,
  pathInstructions: [],
  pathGuidance: "",
  repoInstructions: null,
  excludePaths: [],
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
});
