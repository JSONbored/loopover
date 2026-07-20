import { describe, expect, it } from "vitest";
import { createTestEnv } from "../helpers/d1";

// Regression test for #7430: pruneRelayPending (src/orb/relay.ts) filters/deletes by created_at alone
// (a fleet-wide TTL sweep, not scoped to one installation_id). Neither pre-existing index on
// orb_relay_pending leads with created_at, so both queries fell back to a full table scan -- occasionally
// exceeding the orb-relay-drain pull's 30s timeout budget under fleet load.
describe("orb_relay_pending created_at index", () => {
  it("creates the created_at index and pruneRelayPending's queries use it (SEARCH, not SCAN)", async () => {
    const env = createTestEnv();

    const idx = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
      .bind("idx_orb_relay_pending_created_at")
      .first<{ name: string }>();
    expect(idx?.name).toBe("idx_orb_relay_pending_created_at");

    // The drop-log sample SELECT: WHERE created_at < ? ORDER BY created_at, delivery_id LIMIT ?.
    const selectPlan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT delivery_id, event_name, installation_id FROM orb_relay_pending WHERE created_at < datetime('now', '-' || ? || ' hours') ORDER BY created_at, delivery_id LIMIT ?",
    )
      .bind(24, 20)
      .all<{ detail: string }>();
    const selectDetail = (selectPlan.results ?? []).map((row) => row.detail).join(" ");
    expect(selectDetail).toContain("idx_orb_relay_pending_created_at");
    expect(selectDetail).not.toContain("SCAN orb_relay_pending");

    // The prune DELETE: WHERE created_at < ?.
    const deletePlan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN DELETE FROM orb_relay_pending WHERE created_at < datetime('now', '-' || ? || ' hours')",
    )
      .bind(24)
      .all<{ detail: string }>();
    const deleteDetail = (deletePlan.results ?? []).map((row) => row.detail).join(" ");
    expect(deleteDetail).toContain("idx_orb_relay_pending_created_at");
    expect(deleteDetail).not.toContain("SCAN orb_relay_pending");
  });
});
