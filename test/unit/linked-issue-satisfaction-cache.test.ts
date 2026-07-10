import { describe, expect, it, vi } from "vitest";
import { getCachedLinkedIssueSatisfaction, hasPublishedLinkedIssueSatisfaction, putCachedLinkedIssueSatisfaction } from "../../src/db/repositories";
import { linkedIssueSatisfactionCacheInputFingerprint } from "../../src/review/linked-issue-satisfaction-cache-input";
import { createTestEnv } from "../helpers/d1";

const fp = () => linkedIssueSatisfactionCacheInputFingerprint({ byok: false, provider: null, model: null });

describe("linked-issue satisfaction cache (#1961/#3906)", () => {
  it("misses on a nullish head SHA (read returns null; write is a no-op)", async () => {
    const env = createTestEnv();
    const fingerprint = await fp();
    expect(await getCachedLinkedIssueSatisfaction(env, "o/r", 1, null, 5, fingerprint)).toBeNull();
    expect(await getCachedLinkedIssueSatisfaction(env, "o/r", 1, undefined, 5, fingerprint)).toBeNull();
    await putCachedLinkedIssueSatisfaction(env, "o/r", 1, null, 5, fingerprint, { status: "ok", result: null, estimatedNeurons: 5 }); // no-op, no throw
    expect(await getCachedLinkedIssueSatisfaction(env, "o/r", 1, "sha", 5, fingerprint)).toBeNull(); // nothing was stored
  });

  it("reuses a stored assessment ONLY on the same (repo, pull, head SHA, linked issue number)", async () => {
    const env = createTestEnv();
    const fingerprint = await fp();
    await putCachedLinkedIssueSatisfaction(env, "o/r", 7, "sha1", 42, fingerprint, {
      status: "ok",
      result: { status: "addressed", rationale: "looks done", confidence: 0.9 },
      estimatedNeurons: 12,
    });
    expect(await getCachedLinkedIssueSatisfaction(env, "o/r", 7, "sha1", 42, fingerprint)).toEqual({
      status: "ok",
      result: { status: "addressed", rationale: "looks done", confidence: 0.9 },
      estimatedNeurons: 12,
    });
    expect(await getCachedLinkedIssueSatisfaction(env, "o/r", 7, "sha2", 42, fingerprint)).toBeNull(); // new head SHA → miss
    expect(await getCachedLinkedIssueSatisfaction(env, "o/r", 8, "sha1", 42, fingerprint)).toBeNull(); // different PR → miss
    expect(await getCachedLinkedIssueSatisfaction(env, "o/r2", 7, "sha1", 42, fingerprint)).toBeNull(); // different repo → miss
    // Same (repo, pull, head) but a DIFFERENT primary linked issue number → miss. This is the dimension that
    // distinguishes this cache from ai_slop_cache: a PR's cited primary issue can change between passes.
    expect(await getCachedLinkedIssueSatisfaction(env, "o/r", 7, "sha1", 99, fingerprint)).toBeNull();
  });

  it("misses when the input fingerprint does not match (e.g. BYOK toggled on/off since the row was written)", async () => {
    const env = createTestEnv();
    const freeFingerprint = await linkedIssueSatisfactionCacheInputFingerprint({ byok: false, provider: null, model: null });
    const byokFingerprint = await linkedIssueSatisfactionCacheInputFingerprint({ byok: true, provider: "anthropic", model: "claude-sonnet-5" });
    expect(freeFingerprint).not.toBe(byokFingerprint);

    await putCachedLinkedIssueSatisfaction(env, "o/r", 9, "sha1", 1, freeFingerprint, { status: "ok", result: { status: "partial", rationale: "r", confidence: 0.7 }, estimatedNeurons: 6 });
    expect(await getCachedLinkedIssueSatisfaction(env, "o/r", 9, "sha1", 1, byokFingerprint)).toBeNull();
    expect(await getCachedLinkedIssueSatisfaction(env, "o/r", 9, "sha1", 1, freeFingerprint)).toEqual({ status: "ok", result: { status: "partial", rationale: "r", confidence: 0.7 }, estimatedNeurons: 6 });
  });

  it("upserts — a re-run at the same key replaces the stored assessment", async () => {
    const env = createTestEnv();
    const fingerprint = await fp();
    await putCachedLinkedIssueSatisfaction(env, "o/r", 10, "sha1", 1, fingerprint, { status: "ok", result: { status: "partial", rationale: "first pass", confidence: 0.6 }, estimatedNeurons: 3 });
    await putCachedLinkedIssueSatisfaction(env, "o/r", 10, "sha1", 1, fingerprint, { status: "ok", result: { status: "addressed", rationale: "second pass", confidence: 0.95 }, estimatedNeurons: 9 });
    expect(await getCachedLinkedIssueSatisfaction(env, "o/r", 10, "sha1", 1, fingerprint)).toEqual({
      status: "ok",
      result: { status: "addressed", rationale: "second pass", confidence: 0.95 },
      estimatedNeurons: 9,
    });
  });

  it("round-trips a null result (no usable model output surfaced)", async () => {
    const env = createTestEnv();
    const fingerprint = await fp();
    await putCachedLinkedIssueSatisfaction(env, "o/r", 11, "sha1", 1, fingerprint, { status: "ok", result: null, estimatedNeurons: 6 });
    expect(await getCachedLinkedIssueSatisfaction(env, "o/r", 11, "sha1", 1, fingerprint)).toEqual({ status: "ok", result: null, estimatedNeurons: 6 });
  });

  it("stores an ISO created_at value on insert and conflict update", async () => {
    const env = createTestEnv();
    const fingerprint = await fp();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-07T09:00:00.123Z"));
      await putCachedLinkedIssueSatisfaction(env, "o/r", 12, "sha1", 1, fingerprint, { status: "ok", result: null, estimatedNeurons: 6 });
      const inserted = await env.DB.prepare("SELECT created_at AS createdAt FROM linked_issue_satisfaction_cache WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ? AND linked_issue_number = ?")
        .bind("o/r", 12, "sha1", 1)
        .first<{ createdAt: string }>();
      expect(inserted?.createdAt).toBe("2026-07-07T09:00:00.123Z");

      vi.setSystemTime(new Date("2026-07-07T09:05:00.456Z"));
      await putCachedLinkedIssueSatisfaction(env, "o/r", 12, "sha1", 1, fingerprint, { status: "ok", result: { status: "addressed", rationale: "r", confidence: 0.9 }, estimatedNeurons: 9 });
      const updated = await env.DB.prepare("SELECT created_at AS createdAt FROM linked_issue_satisfaction_cache WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ? AND linked_issue_number = ?")
        .bind("o/r", 12, "sha1", 1)
        .first<{ createdAt: string }>();
      expect(updated?.createdAt).toBe("2026-07-07T09:05:00.456Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hasPublishedLinkedIssueSatisfaction (#one-shot-review-cadence)", () => {
  it("is false when no row exists for the PR + linked issue number", async () => {
    const env = createTestEnv();
    expect(await hasPublishedLinkedIssueSatisfaction(env, "o/r", 20, 1)).toBe(false);
  });

  it("is true once ANY row exists for that issue number, regardless of head SHA", async () => {
    const env = createTestEnv();
    const fingerprint = await fp();
    await putCachedLinkedIssueSatisfaction(env, "o/r", 21, "sha1", 5, fingerprint, { status: "ok", result: { status: "addressed", rationale: "r", confidence: 0.9 }, estimatedNeurons: 4 });
    expect(await hasPublishedLinkedIssueSatisfaction(env, "o/r", 21, 5)).toBe(true);
  });

  it("scopes to (repo, pull, linkedIssueNumber) -- a newly-linked (never-assessed) issue still reads false even though the PR already has a pass for a DIFFERENT issue", async () => {
    const env = createTestEnv();
    const fingerprint = await fp();
    await putCachedLinkedIssueSatisfaction(env, "o/r", 22, "sha1", 5, fingerprint, { status: "ok", result: { status: "addressed", rationale: "r", confidence: 0.9 }, estimatedNeurons: 4 });
    expect(await hasPublishedLinkedIssueSatisfaction(env, "o/r", 22, 6)).toBe(false); // different (newly-linked) issue on the SAME PR
    expect(await hasPublishedLinkedIssueSatisfaction(env, "o/r", 23, 5)).toBe(false); // different PR
    expect(await hasPublishedLinkedIssueSatisfaction(env, "o/r2", 22, 5)).toBe(false); // different repo
  });
});

describe("linkedIssueSatisfactionCacheInputFingerprint", () => {
  it("is stable for the same input", async () => {
    const a = await linkedIssueSatisfactionCacheInputFingerprint({ byok: false, provider: null, model: null });
    const b = await linkedIssueSatisfactionCacheInputFingerprint({ byok: false, provider: null, model: null });
    expect(a).toBe(b);
  });

  it("differs when byok flips", async () => {
    const free = await linkedIssueSatisfactionCacheInputFingerprint({ byok: false, provider: null, model: null });
    const byok = await linkedIssueSatisfactionCacheInputFingerprint({ byok: true, provider: null, model: null });
    expect(free).not.toBe(byok);
  });

  it("differs when the BYOK provider changes", async () => {
    const anthropic = await linkedIssueSatisfactionCacheInputFingerprint({ byok: true, provider: "anthropic", model: null });
    const openai = await linkedIssueSatisfactionCacheInputFingerprint({ byok: true, provider: "openai", model: null });
    expect(anthropic).not.toBe(openai);
  });

  it("differs when the BYOK model changes", async () => {
    const sonnet = await linkedIssueSatisfactionCacheInputFingerprint({ byok: true, provider: "anthropic", model: "claude-sonnet-5" });
    const opus = await linkedIssueSatisfactionCacheInputFingerprint({ byok: true, provider: "anthropic", model: "claude-opus-5" });
    expect(sonnet).not.toBe(opus);
  });

  it("treats a nullish provider/model the same as an absent one", async () => {
    const withUndefined = await linkedIssueSatisfactionCacheInputFingerprint({ byok: false, provider: undefined, model: undefined });
    const withNull = await linkedIssueSatisfactionCacheInputFingerprint({ byok: false, provider: null, model: null });
    expect(withUndefined).toBe(withNull);
  });

  it("differs when mutable prompt text changes (regression for stale linked-issue gate cache)", async () => {
    const before = await linkedIssueSatisfactionCacheInputFingerprint({
      byok: false,
      provider: null,
      model: null,
      issueText: "Need an SSE endpoint",
      prTitle: "Add SSE endpoint",
      prBody: "Closes the SSE issue",
      diff: "+app.get('/stream', sse)",
    });
    const editedIssue = await linkedIssueSatisfactionCacheInputFingerprint({
      byok: false,
      provider: null,
      model: null,
      issueText: "Need a GraphQL subscription",
      prTitle: "Add SSE endpoint",
      prBody: "Closes the SSE issue",
      diff: "+app.get('/stream', sse)",
    });
    const editedPr = await linkedIssueSatisfactionCacheInputFingerprint({
      byok: false,
      provider: null,
      model: null,
      issueText: "Need an SSE endpoint",
      prTitle: "Add GraphQL subscription",
      prBody: "Closes the GraphQL issue",
      diff: "+app.get('/stream', sse)",
    });
    expect(editedIssue).not.toBe(before);
    expect(editedPr).not.toBe(before);
  });

  it("never collides with the ai_slop_cache fingerprint namespace even for identical inputs", async () => {
    const { aiSlopCacheInputFingerprint } = await import("../../src/review/ai-slop-cache-input");
    const slop = await aiSlopCacheInputFingerprint({ byok: false, provider: null, model: null });
    const satisfaction = await linkedIssueSatisfactionCacheInputFingerprint({ byok: false, provider: null, model: null });
    expect(slop).not.toBe(satisfaction);
  });
});
