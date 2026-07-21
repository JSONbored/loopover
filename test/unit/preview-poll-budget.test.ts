import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PREVIEW_POLL_ATTEMPTS, previewPollAttemptCount, recordPreviewPollAttempt } from "../../src/review/visual/preview-poll-budget";
import { createTestEnv } from "../helpers/d1";

const HEAD_SHA = "budget-head-sha-1234567890";

// An etag-aware in-memory R2 stand-in: each key holds its value plus a monotonic etag, `get` surfaces the
// current httpEtag, and `put` honors the compare-and-swap conditions recordPreviewPollAttempt relies on
// (#7780) -- `etagMatches` writes only when the etag is unchanged, `etagDoesNotMatch: "*"` writes only when
// the object is still absent -- returning null (no write) on a precondition miss exactly as real R2 does.
// `onPut` is an optional hook fired at the START of every put, used to interleave two concurrent writers.
function memoryBudgetStore(
  options: { failGet?: boolean; failPut?: boolean; forcedValue?: string; onPut?: (key: string) => Promise<void> | void } = {},
): R2Bucket {
  const store = new Map<string, { value: string; etag: string }>();
  let etagSeq = 0;
  return {
    async get(key: string) {
      if (options.failGet) throw new Error("simulated budget-marker read failure");
      // forcedValue bypasses the real per-key store entirely -- used to simulate a corrupted/malformed stored
      // marker without needing to know the module's own private R2-key derivation.
      if (options.forcedValue !== undefined) return { body: new Response(options.forcedValue).body, httpEtag: "forced-etag" } as unknown as R2ObjectBody;
      const entry = store.get(key);
      return entry === undefined ? null : ({ body: new Response(entry.value).body, httpEtag: entry.etag } as unknown as R2ObjectBody);
    },
    async put(key: string, value: unknown, putOptions?: R2PutOptions) {
      if (options.onPut) await options.onPut(key);
      if (options.failPut) throw new Error("simulated budget-marker write failure");
      const onlyIf = putOptions?.onlyIf as R2Conditional | undefined;
      const current = store.get(key);
      // Enforce the two compare-and-swap preconditions the production code sends; a miss returns null (real R2
      // signals "not written" by returning null rather than throwing).
      if (onlyIf?.etagMatches !== undefined && current?.etag !== onlyIf.etagMatches) return null;
      if (onlyIf?.etagDoesNotMatch === "*" && current !== undefined) return null;
      etagSeq += 1;
      const etag = `etag-${etagSeq}`;
      store.set(key, { value: await new Response(value as BodyInit).text(), etag });
      return { key, etag } as unknown as R2Object;
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

  it("does NOT lose an increment when two triggers race for the same head SHA -- both are counted (#7780)", async () => {
    // Interleave two concurrent recordPreviewPollAttempt calls so BOTH read the marker before EITHER writes --
    // the classic read-modify-write TOCTOU. The first put to reach the store is stalled at a barrier until the
    // second writer has read (and is about to write); whichever writes second must have re-read the newer
    // count via the compare-and-swap retry, so the final count reflects BOTH increments, not one.
    let releaseFirstPut: () => void = () => {};
    const firstPutStalled = new Promise<void>((resolve) => {
      releaseFirstPut = resolve;
    });
    let putCalls = 0;
    const onPut = async () => {
      putCalls += 1;
      // Only the very first put blocks; every later put (the retry, and the second writer) runs immediately.
      if (putCalls === 1) await firstPutStalled;
    };
    const env = createTestEnv({ REVIEW_AUDIT: memoryBudgetStore({ onPut }) });

    const first = recordPreviewPollAttempt(env, HEAD_SHA); // reads count=0, stalls at its put barrier
    // Let the first writer reach (and block at) its put before the second even starts, guaranteeing both read
    // count=0 against the same (absent) etag.
    await new Promise((r) => setTimeout(r, 0));
    const second = recordPreviewPollAttempt(env, HEAD_SHA); // reads count=0 too, writes count=1 (wins the CAS)
    await second;
    releaseFirstPut(); // the first writer's stalled put now runs; its etagDoesNotMatch:"*" precondition misses
    await first; // ...so it retries, re-reads count=1, and writes count=2

    await expect(previewPollAttemptCount(env, HEAD_SHA)).resolves.toBe(2);
  });

  it("gives up after the bounded CAS retries under sustained contention, without throwing (#7780)", async () => {
    // A pathological store whose conditional put NEVER succeeds (every etagDoesNotMatch precondition is treated
    // as a miss): recordPreviewPollAttempt must exhaust its bounded retries and degrade to "this attempt didn't
    // count" -- the same safe failure direction as a genuine write failure -- rather than throw or loop forever.
    let putAttempts = 0;
    const store = {
      async get() {
        return null; // always "no marker yet" -> the write path always uses etagDoesNotMatch:"*"
      },
      async put() {
        putAttempts += 1;
        return null; // precondition perpetually "misses" -> forces the retry loop to run to exhaustion
      },
    } as unknown as R2Bucket;
    const env = createTestEnv({ REVIEW_AUDIT: store });
    await expect(recordPreviewPollAttempt(env, HEAD_SHA)).resolves.toBeUndefined();
    expect(putAttempts).toBe(3); // BUDGET_CAS_MAX_ATTEMPTS
  });
});
