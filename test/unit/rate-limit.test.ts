import { afterEach, describe, expect, it, vi } from "vitest";
import { LOW_REST_RATE_LIMIT_REMAINING, MAINTENANCE_RESERVED_HEADROOM, delayUntil, shouldWaitForGitHubRateLimit } from "../../src/github/rate-limit";
import { recordGitHubRateLimitObservation } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const NOW = "2026-06-24T12:00:00.000Z";
const nowMs = Date.parse(NOW);
const inIso = (ms: number): string => new Date(nowMs + ms).toISOString();

async function seedRest(env: ReturnType<typeof createTestEnv>, remaining: number | null, resetAt: string | null): Promise<void> {
  await recordGitHubRateLimitObservation(env, { repoFullName: "owner/repo", resource: "rest", path: "/x", statusCode: 200, limitValue: 5000, remaining, resetAt, observedAt: NOW });
}

describe("rate-limit headroom (#audit-rate-headroom)", () => {
  afterEach(() => vi.useRealTimers());

  it("the maintenance floor reserves more headroom than the backfill floor", () => {
    expect(MAINTENANCE_RESERVED_HEADROOM).toBeGreaterThan(LOW_REST_RATE_LIMIT_REMAINING);
  });

  describe("shouldWaitForGitHubRateLimit", () => {
    it("returns undefined when there is no REST observation", async () => {
      const env = createTestEnv();
      expect(await shouldWaitForGitHubRateLimit(env)).toBeUndefined();
    });

    it("returns undefined when remaining is above the floor (headroom)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW));
      const env = createTestEnv();
      await seedRest(env, 500, inIso(3_600_000));
      expect(await shouldWaitForGitHubRateLimit(env)).toBeUndefined(); // 500 > 75
    });

    it("returns the resetAt when remaining is at/below the floor and the reset is in the future", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW));
      const env = createTestEnv();
      const resetAt = inIso(3_600_000);
      await seedRest(env, 50, resetAt);
      expect(await shouldWaitForGitHubRateLimit(env)).toBe(resetAt); // 50 <= 75
    });

    it("returns undefined when the reset is already in the past (no point waiting)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW));
      const env = createTestEnv();
      await seedRest(env, 50, inIso(-60_000)); // reset 1m ago
      expect(await shouldWaitForGitHubRateLimit(env)).toBeUndefined();
    });

    it("returns undefined when the REST observation has no resetAt", async () => {
      const env = createTestEnv();
      await seedRest(env, 50, null);
      expect(await shouldWaitForGitHubRateLimit(env)).toBeUndefined();
    });

    it("honors a higher maintenance floor — yields at 120 remaining for maintenance but not for the default backfill floor", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW));
      const env = createTestEnv();
      const resetAt = inIso(3_600_000);
      await seedRest(env, 120, resetAt);
      expect(await shouldWaitForGitHubRateLimit(env, MAINTENANCE_RESERVED_HEADROOM)).toBe(resetAt); // 120 <= 150 → wait
      expect(await shouldWaitForGitHubRateLimit(env)).toBeUndefined(); // 120 > 75 default → headroom
    });
  });

  describe("delayUntil", () => {
    it("delays until the reset plus a 15s margin, clamped to [30, 900]", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW));
      expect(delayUntil(inIso(100_000))).toBe(115); // 100s + 15s margin
      expect(delayUntil(inIso(5_000))).toBe(30); // floor: 5s + 15s = 20 → clamped up to 30
      expect(delayUntil(inIso(100_000_000))).toBe(900); // ceiling
    });

    it("uses a conservative 60s for an unparseable reset", () => {
      expect(delayUntil("not-a-date")).toBe(60);
    });
  });
});
