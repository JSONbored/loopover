import { describe, expect, it } from "vitest";
import { isRepoDocRefreshDue } from "../../src/review/repo-doc-refresh-schedule";

const NOW = "2026-07-11T00:00:00.000Z";

describe("isRepoDocRefreshDue (#3003)", () => {
  it("is always due when never attempted before (null marker)", () => {
    expect(isRepoDocRefreshDue(null, 7, NOW)).toBe(true);
  });

  it("is NOT due when less than the interval has elapsed", () => {
    const lastAttemptedAt = "2026-07-05T00:00:00.000Z"; // 6 days before NOW
    expect(isRepoDocRefreshDue(lastAttemptedAt, 7, NOW)).toBe(false);
  });

  it("is due exactly at the interval boundary (inclusive)", () => {
    const lastAttemptedAt = "2026-07-04T00:00:00.000Z"; // exactly 7 days before NOW
    expect(isRepoDocRefreshDue(lastAttemptedAt, 7, NOW)).toBe(true);
  });

  it("is due when more than the interval has elapsed", () => {
    const lastAttemptedAt = "2026-06-01T00:00:00.000Z";
    expect(isRepoDocRefreshDue(lastAttemptedAt, 7, NOW)).toBe(true);
  });

  it("respects a custom (non-default) interval", () => {
    const lastAttemptedAt = "2026-07-10T00:00:00.000Z"; // 1 day before NOW
    expect(isRepoDocRefreshDue(lastAttemptedAt, 1, NOW)).toBe(true);
    expect(isRepoDocRefreshDue(lastAttemptedAt, 2, NOW)).toBe(false);
  });

  it("fails open (due) when lastAttemptedAt is not a parseable date", () => {
    expect(isRepoDocRefreshDue("not-a-date", 7, NOW)).toBe(true);
  });

  it("fails open (due) when now is not a parseable date", () => {
    expect(isRepoDocRefreshDue("2026-07-01T00:00:00.000Z", 7, "not-a-date")).toBe(true);
  });
});
