import { describe, expect, it } from "vitest";
import { isReviewRecapDue } from "../../src/review/review-recap-schedule";

const NOW = "2026-07-08T00:00:00.000Z";

describe("isReviewRecapDue (#1963)", () => {
  it("treats a repo with no prior attempt as due", () => {
    expect(isReviewRecapDue(null, 7, NOW)).toBe(true);
  });

  it("is not due when the last attempt is inside the cadence window", () => {
    const lastAttemptedAt = "2026-07-07T12:00:00.000Z";
    expect(isReviewRecapDue(lastAttemptedAt, 7, NOW)).toBe(false);
  });

  it("is due exactly on the cadence boundary", () => {
    const lastAttemptedAt = "2026-07-01T00:00:00.000Z";
    expect(isReviewRecapDue(lastAttemptedAt, 7, NOW)).toBe(true);
  });

  it("is due when the last attempt is older than the cadence", () => {
    const lastAttemptedAt = "2026-06-20T00:00:00.000Z";
    expect(isReviewRecapDue(lastAttemptedAt, 7, NOW)).toBe(true);
  });

  it("respects shorter cadence values independently", () => {
    const lastAttemptedAt = "2026-07-07T00:00:00.000Z";
    expect(isReviewRecapDue(lastAttemptedAt, 1, NOW)).toBe(true);
    expect(isReviewRecapDue(lastAttemptedAt, 2, NOW)).toBe(false);
  });

  it("treats unparseable timestamps as due (fail-open rate limiter)", () => {
    expect(isReviewRecapDue("not-a-date", 7, NOW)).toBe(true);
  });

  it("treats an unparseable now timestamp as due", () => {
    expect(isReviewRecapDue("2026-07-01T00:00:00.000Z", 7, "not-a-date")).toBe(true);
  });
});
