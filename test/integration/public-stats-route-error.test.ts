import { describe, expect, it, vi } from "vitest";

// Force the (otherwise fail-safe) stats computation to throw, so the route's defensive 503 catch is exercised.
vi.mock("../../src/review/public-stats", () => ({
  isPublicStatsEnabled: () => true,
  getPublicStats: () => Promise.reject(new Error("stats boom")),
}));

import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";

describe("GET /v1/public/stats — error path", () => {
  it("returns 503 when stats computation throws", async () => {
    const env = createTestEnv({ GITTENSORY_PUBLIC_STATS: "1" });
    const res = await createApp().request("/v1/public/stats", {}, env);
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toEqual({
      error: "public_stats_unavailable",
    });
  });
});
