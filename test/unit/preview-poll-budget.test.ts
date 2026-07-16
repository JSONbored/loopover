import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PREVIEW_POLL_ATTEMPTS, previewPollAttemptCount, recordPreviewPollAttempt } from "../../src/review/visual/preview-poll-budget";
import { createTestEnv } from "../helpers/d1";

const HEAD_SHA = "budget-head-sha-1234567890";

function memoryBudgetStore(options: { failGet?: boolean; failPut?: boolean; forcedValue?: string } = {}): R2Bucket {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      if (options.failGet) throw new Error("simulated budget-marker read failure");
      // forcedValue bypasses the real per-key store entirely -- used to simulate a corrupted/malformed stored
      // marker without needing to know the module's own private R2-key derivation.
      if (options.forcedValue !== undefined) return { body: new Response(options.forcedValue).body } as unknown as R2ObjectBody;
      const value = store.get(key);
      return value === undefined ? null : ({ body: new Response(value).body } as unknown as R2ObjectBody);
    },
    async put(key: string, value: unknown) {
      if (options.failPut) throw new Error("simulated budget-marker write failure");
      store.set(key, await new Response(value as BodyInit).text());
      return { key } as unknown as R2Object;
    },
  } as unknown as R2Bucket;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("previewPollAttemptCount / recordPreviewPollAttempt (#6323 -- durable per-headSha preview-poll budget)", () => {
  it("0 when REVIEW_AUDIT isn't configured", async () => {
    const env = createTestEnv();
    await expect(previewPollAttemptCount(env, HEAD_SHA)).resolves.toBe(0);
  });

  it("0 when no marker has ever been recorded", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryBudgetStore() });
    await expect(previewPollAttemptCount(env, HEAD_SHA)).resolves.toBe(0);
  });

  it("1 immediately after a single recordPreviewPollAttempt", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryBudgetStore() });
    await recordPreviewPollAttempt(env, HEAD_SHA);
    await expect(previewPollAttemptCount(env, HEAD_SHA)).resolves.toBe(1);
  });

  it("accumulates across repeated attempts, matching MAX_PREVIEW_POLL_ATTEMPTS' own scale", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryBudgetStore() });
    for (let i = 0; i < MAX_PREVIEW_POLL_ATTEMPTS; i += 1) {
      await recordPreviewPollAttempt(env, HEAD_SHA);
    }
    await expect(previewPollAttemptCount(env, HEAD_SHA)).resolves.toBe(MAX_PREVIEW_POLL_ATTEMPTS);
  });

  it("tracks DIFFERENT head SHAs independently -- a new push resets the budget", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryBudgetStore() });
    await recordPreviewPollAttempt(env, "old-head-sha");
    await recordPreviewPollAttempt(env, "old-head-sha");
    await expect(previewPollAttemptCount(env, "old-head-sha")).resolves.toBe(2);
    await expect(previewPollAttemptCount(env, "new-head-sha")).resolves.toBe(0);
  });

  it("0 once the marker is older than the max age (an abandoned/long-stale PR)", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryBudgetStore() });
    vi.useFakeTimers();
    try {
      await recordPreviewPollAttempt(env, HEAD_SHA);
      vi.advanceTimersByTime(25 * 60 * 60 * 1000); // past the 24-hour max age
      await expect(previewPollAttemptCount(env, HEAD_SHA)).resolves.toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the original firstAttemptAt across increments -- the max age expires from the FIRST attempt, not the latest", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryBudgetStore() });
    vi.useFakeTimers();
    try {
      await recordPreviewPollAttempt(env, HEAD_SHA);
      vi.advanceTimersByTime(23 * 60 * 60 * 1000); // still within the 24h window
      await recordPreviewPollAttempt(env, HEAD_SHA); // a SECOND attempt, ~23h after the first
      await expect(previewPollAttemptCount(env, HEAD_SHA)).resolves.toBe(2);
      vi.advanceTimersByTime(2 * 60 * 60 * 1000); // now ~25h after the FIRST attempt (past max age)
      // If firstAttemptAt were wrongly reset on the second write, this would still read as fresh (count 2).
      // It must instead expire, proving the ORIGINAL firstAttemptAt was preserved.
      await expect(previewPollAttemptCount(env, HEAD_SHA)).resolves.toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("0 when the stored marker isn't valid JSON at all", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryBudgetStore({ forcedValue: "{not valid json" }) });
    await expect(previewPollAttemptCount(env, HEAD_SHA)).resolves.toBe(0);
  });

  it("0 when the stored marker is missing its count/firstAttemptAt fields", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryBudgetStore({ forcedValue: JSON.stringify({ unrelated: true }) }) });
    await expect(previewPollAttemptCount(env, HEAD_SHA)).resolves.toBe(0);
  });

  it("previewPollAttemptCount fails open (0) when the R2 read itself throws", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryBudgetStore({ failGet: true }) });
    await expect(previewPollAttemptCount(env, HEAD_SHA)).resolves.toBe(0);
  });

  it("recordPreviewPollAttempt never throws when REVIEW_AUDIT isn't configured", async () => {
    const env = createTestEnv();
    await expect(recordPreviewPollAttempt(env, HEAD_SHA)).resolves.toBeUndefined();
  });

  it("recordPreviewPollAttempt never throws (best-effort) when the R2 write itself fails", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryBudgetStore({ failPut: true }) });
    await expect(recordPreviewPollAttempt(env, HEAD_SHA)).resolves.toBeUndefined();
  });

  it("recordPreviewPollAttempt never throws (best-effort) when the read INSIDE the write path fails", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryBudgetStore({ failGet: true }) });
    await expect(recordPreviewPollAttempt(env, HEAD_SHA)).resolves.toBeUndefined();
  });
});
