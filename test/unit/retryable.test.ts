import { describe, expect, it } from "vitest";
import { RetryableJobError, isRetryableJobError, retryableJobDelayMs } from "../../src/queue/retryable";

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
