import { describe, expect, it } from "vitest";
import { ATTEMPT_FREE_RETRY_DEADLINE_MS, RetryableJobError, isAttemptFreeRetry, isRetryableJobError, retryableJobDelayMs } from "../../src/queue/retryable";

describe("RetryableJobError", () => {
  it("clamps retryAfterMs between 1s and 1h with a 5m default", () => {
    expect(new RetryableJobError("retry", { retryKind: "rate_limit" }).retryAfterMs).toBe(5 * 60 * 1000);
    expect(new RetryableJobError("retry", { retryKind: "x", retryAfterMs: Number.NaN }).retryAfterMs).toBe(5 * 60 * 1000);
    expect(new RetryableJobError("retry", { retryKind: "x", retryAfterMs: 0 }).retryAfterMs).toBe(1_000);
    expect(new RetryableJobError("retry", { retryKind: "x", retryAfterMs: 500 }).retryAfterMs).toBe(1_000);
    expect(new RetryableJobError("retry", { retryKind: "x", retryAfterMs: 90_000 }).retryAfterMs).toBe(90_000);
    expect(new RetryableJobError("retry", { retryKind: "x", retryAfterMs: 9_999_999 }).retryAfterMs).toBe(60 * 60 * 1000);
  });

  it("identifies retryable errors for queue delay helpers", () => {
    const err = new RetryableJobError("backoff", { retryKind: "github", retryAfterMs: 2_000 });
    expect(isRetryableJobError(err)).toBe(true);
    expect(retryableJobDelayMs(err)).toBe(2_000);
    expect(isRetryableJobError(new Error("nope"))).toBe(false);
    expect(retryableJobDelayMs(new Error("nope"))).toBeNull();
  });
});

// #9465 regression: lock contention was charged an attempt like any other error, so with a flat 5s retry and
// maxRetries 5 a waiter DIED after ~25s -- against a lock designed to be held for minutes (the actuation lock's
// TTL is 600s and it spans a whole publish -> AI review -> maintain pass). Production confirmed it: the only
// dead-lettered jobs in a 7-day window were three actuation-lock contentions, one a `reopen-reclose`, whose
// single webhook-gated trigger and absent reconciler meant that enforcement was lost outright.
describe("attempt-free retry classification (#9465)", () => {
  it("treats per-PR actuation-lock contention as attempt-free", () => {
    expect(isAttemptFreeRetry(new RetryableJobError("contended", { retryKind: "pr_actuation_lock_contended" }))).toBe(true);
  });

  it("does NOT extend attempt-free treatment to other retryable kinds", () => {
    // Deliberately narrow: a genuine failure must still consume its budget and converge to a dead job.
    expect(isAttemptFreeRetry(new RetryableJobError("later", { retryKind: "rate_limit" }))).toBe(false);
    expect(isAttemptFreeRetry(new RetryableJobError("later", { retryKind: "some_other_kind" }))).toBe(false);
  });

  it("is false for a plain error and for a non-error value", () => {
    expect(isAttemptFreeRetry(new Error("boom"))).toBe(false);
    expect(isAttemptFreeRetry("boom")).toBe(false);
    expect(isAttemptFreeRetry(undefined)).toBe(false);
  });

  it("bounds attempt-free deferral well beyond the actuation lock's own TTL, so a holder never kills a waiter", () => {
    // PR_ACTUATION_LOCK_TTL_SECONDS is 600 (src/queue/transient-locks.ts). The deadline must exceed it, or a
    // holder running to its full TTL would still dead-letter the job waiting behind it -- the original bug.
    expect(ATTEMPT_FREE_RETRY_DEADLINE_MS).toBeGreaterThan(600 * 1000);
    // ...but remain finite, so a lock that is somehow never released still surfaces as a dead job.
    expect(Number.isFinite(ATTEMPT_FREE_RETRY_DEADLINE_MS)).toBe(true);
  });
});
