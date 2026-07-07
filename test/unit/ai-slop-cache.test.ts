import { describe, expect, it, vi } from "vitest";
import { getCachedAiSlopAdvisory, putCachedAiSlopAdvisory } from "../../src/db/repositories";
import { aiSlopCacheInputFingerprint } from "../../src/review/ai-slop-cache-input";
import { createTestEnv } from "../helpers/d1";

const fp = () => aiSlopCacheInputFingerprint({ byok: false, provider: null, model: null });

describe("AI slop advisory cache (#ai-slop-cache)", () => {
  it("misses on a nullish head SHA (read returns null; write is a no-op)", async () => {
    const env = createTestEnv();
    const fingerprint = await fp();
    expect(await getCachedAiSlopAdvisory(env, "o/r", 1, null, fingerprint)).toBeNull();
    expect(await getCachedAiSlopAdvisory(env, "o/r", 1, undefined, fingerprint)).toBeNull();
    await putCachedAiSlopAdvisory(env, "o/r", 1, null, fingerprint, { status: "ok", band: null, finding: null, estimatedNeurons: 5 }); // no-op, no throw
    expect(await getCachedAiSlopAdvisory(env, "o/r", 1, "sha", fingerprint)).toBeNull(); // nothing was stored
  });

  it("reuses a stored advisory ONLY on the same (repo, pull, head SHA)", async () => {
    const env = createTestEnv();
    const fingerprint = await fp();
    await putCachedAiSlopAdvisory(env, "o/r", 7, "sha1", fingerprint, { status: "ok", band: "elevated", finding: null, estimatedNeurons: 12 });
    expect(await getCachedAiSlopAdvisory(env, "o/r", 7, "sha1", fingerprint)).toEqual({ status: "ok", band: "elevated", finding: null, estimatedNeurons: 12 });
    expect(await getCachedAiSlopAdvisory(env, "o/r", 7, "sha2", fingerprint)).toBeNull(); // new head SHA → miss
    expect(await getCachedAiSlopAdvisory(env, "o/r", 8, "sha1", fingerprint)).toBeNull(); // different PR → miss
    expect(await getCachedAiSlopAdvisory(env, "o/r2", 7, "sha1", fingerprint)).toBeNull(); // different repo → miss
  });

  it("misses when the input fingerprint does not match (e.g. BYOK toggled on/off since the row was written)", async () => {
    const env = createTestEnv();
    const freeFingerprint = await aiSlopCacheInputFingerprint({ byok: false, provider: null, model: null });
    const byokFingerprint = await aiSlopCacheInputFingerprint({ byok: true, provider: "anthropic", model: "claude-sonnet-5" });
    expect(freeFingerprint).not.toBe(byokFingerprint);

    await putCachedAiSlopAdvisory(env, "o/r", 9, "sha1", freeFingerprint, { status: "ok", band: "low", finding: null, estimatedNeurons: 6 });
    expect(await getCachedAiSlopAdvisory(env, "o/r", 9, "sha1", byokFingerprint)).toBeNull();
    expect(await getCachedAiSlopAdvisory(env, "o/r", 9, "sha1", freeFingerprint)).toEqual({ status: "ok", band: "low", finding: null, estimatedNeurons: 6 });
  });

  it("upserts — a re-run at the same key replaces the stored advisory", async () => {
    const env = createTestEnv();
    const fingerprint = await fp();
    await putCachedAiSlopAdvisory(env, "o/r", 10, "sha1", fingerprint, { status: "ok", band: "clean", finding: null, estimatedNeurons: 3 });
    await putCachedAiSlopAdvisory(env, "o/r", 10, "sha1", fingerprint, {
      status: "ok",
      band: "high",
      finding: { code: "ai_slop_advisory", title: "t", severity: "warning", detail: "d" },
      estimatedNeurons: 9,
    });
    expect(await getCachedAiSlopAdvisory(env, "o/r", 10, "sha1", fingerprint)).toEqual({
      status: "ok",
      band: "high",
      finding: { code: "ai_slop_advisory", title: "t", severity: "warning", detail: "d" },
      estimatedNeurons: 9,
    });
  });

  it("round-trips a null band and a null finding (a clean-band advisory with no surfaced finding)", async () => {
    const env = createTestEnv();
    const fingerprint = await fp();
    await putCachedAiSlopAdvisory(env, "o/r", 11, "sha1", fingerprint, { status: "ok", band: "clean", finding: null, estimatedNeurons: 6 });
    expect(await getCachedAiSlopAdvisory(env, "o/r", 11, "sha1", fingerprint)).toEqual({ status: "ok", band: "clean", finding: null, estimatedNeurons: 6 });
  });

  it("stores an ISO created_at value on insert and conflict update", async () => {
    const env = createTestEnv();
    const fingerprint = await fp();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-06T09:00:00.123Z"));
      await putCachedAiSlopAdvisory(env, "o/r", 12, "sha1", fingerprint, { status: "ok", band: "low", finding: null, estimatedNeurons: 6 });
      const inserted = await env.DB.prepare("SELECT created_at AS createdAt FROM ai_slop_cache WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ?")
        .bind("o/r", 12, "sha1")
        .first<{ createdAt: string }>();
      expect(inserted?.createdAt).toBe("2026-07-06T09:00:00.123Z");

      vi.setSystemTime(new Date("2026-07-06T09:05:00.456Z"));
      await putCachedAiSlopAdvisory(env, "o/r", 12, "sha1", fingerprint, { status: "ok", band: "high", finding: null, estimatedNeurons: 9 });
      const updated = await env.DB.prepare("SELECT created_at AS createdAt FROM ai_slop_cache WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ?")
        .bind("o/r", 12, "sha1")
        .first<{ createdAt: string }>();
      expect(updated?.createdAt).toBe("2026-07-06T09:05:00.456Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("aiSlopCacheInputFingerprint", () => {
  it("is stable for the same input", async () => {
    const a = await aiSlopCacheInputFingerprint({ byok: false, provider: null, model: null });
    const b = await aiSlopCacheInputFingerprint({ byok: false, provider: null, model: null });
    expect(a).toBe(b);
  });

  it("differs when byok flips", async () => {
    const free = await aiSlopCacheInputFingerprint({ byok: false, provider: null, model: null });
    const byok = await aiSlopCacheInputFingerprint({ byok: true, provider: null, model: null });
    expect(free).not.toBe(byok);
  });

  it("differs when the BYOK provider changes", async () => {
    const anthropic = await aiSlopCacheInputFingerprint({ byok: true, provider: "anthropic", model: null });
    const openai = await aiSlopCacheInputFingerprint({ byok: true, provider: "openai", model: null });
    expect(anthropic).not.toBe(openai);
  });

  it("differs when the BYOK model changes", async () => {
    const sonnet = await aiSlopCacheInputFingerprint({ byok: true, provider: "anthropic", model: "claude-sonnet-5" });
    const opus = await aiSlopCacheInputFingerprint({ byok: true, provider: "anthropic", model: "claude-opus-5" });
    expect(sonnet).not.toBe(opus);
  });

  it("treats a nullish provider/model the same as an absent one", async () => {
    const withUndefined = await aiSlopCacheInputFingerprint({ byok: false, provider: undefined, model: undefined });
    const withNull = await aiSlopCacheInputFingerprint({ byok: false, provider: null, model: null });
    expect(withUndefined).toBe(withNull);
  });
});
