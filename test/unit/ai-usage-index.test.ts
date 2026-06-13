import { describe, expect, it } from "vitest";
import { createTestEnv } from "../helpers/d1";

describe("ai_usage_events budget index", () => {
  it("creates the (status, created_at) index and the budget query uses it (SEARCH, not SCAN)", async () => {
    const env = createTestEnv();

    const idx = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
      .bind("ai_usage_events_status_created_idx")
      .first<{ name: string }>();
    expect(idx?.name).toBe("ai_usage_events_status_created_idx");

    // sumAiEstimatedNeuronsSince: WHERE status='ok' AND created_at >= ? — must SEARCH via the new index.
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT coalesce(sum(estimated_neurons),0) FROM ai_usage_events WHERE created_at >= ? AND status = 'ok'",
    )
      .bind("2026-01-01T00:00:00.000Z")
      .all<{ detail: string }>();
    const detail = (plan.results ?? []).map((row) => row.detail).join(" ");
    expect(detail).toContain("ai_usage_events_status_created_idx");
    expect(detail).not.toContain("SCAN ai_usage_events ");
  });
});
