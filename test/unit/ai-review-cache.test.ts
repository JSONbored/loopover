import { describe, expect, it } from "vitest";
import { getCachedAiReview, putCachedAiReview } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

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
});
