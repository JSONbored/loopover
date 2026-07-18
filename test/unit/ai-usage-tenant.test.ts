import { describe, expect, it } from "vitest";
import { listAiCostByTenantSince, listRowCountByTenantSince, recordAiUsageEvent, sumAiCostForTenantSince } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #7176: ai_usage_events gained a nullable installation_id tenant column for centralized hosted billing, plus a
// sumAiCostForTenantSince aggregate. These pin: the column is written when supplied and stays null otherwise
// (self-host unaffected), and the aggregate is correctly scoped by tenant + time window.
const base = {
  feature: "ai_review",
  model: "claude-sonnet-5",
  status: "ok",
  estimatedNeurons: 10,
  costUsd: 0.5,
};

async function installationOf(env: Env, id: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT installation_id FROM ai_usage_events WHERE id = ?").bind(id).first<{ installation_id: string | null }>();
  return row?.installation_id ?? null;
}

/** Insert one ai_usage_events row and backdate it, so time-window filters (sinceIso) are actually exercised
 *  instead of every row landing at "now". Shared by the per-tenant sum tests and the fleet-wide breakdown tests
 *  below, which seed the identical fixture shape. */
async function seedCostEvent(env: Env, installationId: string | null, costUsd: number, createdAt: string): Promise<void> {
  await recordAiUsageEvent(env, { ...base, costUsd, installationId });
  await env.DB.prepare("UPDATE ai_usage_events SET created_at = ? WHERE created_at = (SELECT max(created_at) FROM ai_usage_events)").bind(createdAt).run();
}

describe("ai_usage_events tenant column + billing aggregate (#7176)", () => {
  it("writes installation_id when a hosted caller supplies it", async () => {
    const env = createTestEnv();
    await recordAiUsageEvent(env, { ...base, installationId: "inst-42", metadata: {}, detail: "x" });
    const { results } = await env.DB.prepare("SELECT id, installation_id FROM ai_usage_events").all<{ id: string; installation_id: string | null }>();
    expect(results).toHaveLength(1);
    expect(results[0]!.installation_id).toBe("inst-42");
  });

  it("leaves installation_id null for a self-host caller that omits it (byte-identical to today)", async () => {
    const env = createTestEnv();
    await recordAiUsageEvent(env, { ...base });
    const { results } = await env.DB.prepare("SELECT id FROM ai_usage_events").all<{ id: string }>();
    expect(await installationOf(env, results[0]!.id)).toBeNull();
    // Explicit null is also accepted and stays null.
    await recordAiUsageEvent(env, { ...base, installationId: null });
    const rows = await env.DB.prepare("SELECT installation_id FROM ai_usage_events").all<{ installation_id: string | null }>().then((r) => r.results);
    expect(rows.every((r) => r.installation_id === null)).toBe(true);
  });

  it("sums cost per tenant since a timestamp, ignoring other tenants, older rows, and null-tenant self-host rows", async () => {
    const env = createTestEnv();
    // Two events for inst-1 after the window, one before it, one for inst-2, one self-host (null tenant).
    const since = "2026-07-10T00:00:00.000Z";
    await seedCostEvent(env, "inst-1", 1.25, "2026-07-11T00:00:00.000Z");
    await seedCostEvent(env, "inst-1", 0.75, "2026-07-12T00:00:00.000Z");
    await seedCostEvent(env, "inst-1", 9.0, "2026-07-01T00:00:00.000Z"); // before the window
    await seedCostEvent(env, "inst-2", 4.0, "2026-07-13T00:00:00.000Z"); // different tenant
    await seedCostEvent(env, null, 3.0, "2026-07-14T00:00:00.000Z"); // self-host, null tenant

    expect(await sumAiCostForTenantSince(env, "inst-1", since)).toBeCloseTo(2.0, 5);
    expect(await sumAiCostForTenantSince(env, "inst-2", since)).toBeCloseTo(4.0, 5);
    // A tenant with no rows sums to 0, not an error.
    expect(await sumAiCostForTenantSince(env, "inst-none", since)).toBe(0);
  });
});

describe("listAiCostByTenantSince (#4916): fleet-wide per-tenant breakdown for the operator dashboard", () => {
  it("groups by tenant, sums correctly, and orders highest-cost-first", async () => {
    const env = createTestEnv();
    const since = "2026-07-10T00:00:00.000Z";
    await seedCostEvent(env, "inst-1", 1.25, "2026-07-11T00:00:00.000Z");
    await seedCostEvent(env, "inst-1", 0.75, "2026-07-12T00:00:00.000Z"); // inst-1 total: 2.0
    await seedCostEvent(env, "inst-2", 4.0, "2026-07-13T00:00:00.000Z"); // inst-2 total: 4.0 (highest)
    await seedCostEvent(env, "inst-3", 0.5, "2026-07-13T00:00:00.000Z"); // inst-3 total: 0.5 (lowest)

    const rows = await listAiCostByTenantSince(env, since);

    expect(rows).toEqual([
      { installationId: "inst-2", totalCostUsd: 4.0 },
      { installationId: "inst-1", totalCostUsd: 2.0 },
      { installationId: "inst-3", totalCostUsd: 0.5 },
    ]);
  });

  it("excludes self-host rows (null installation_id) and rows outside the time window", async () => {
    const env = createTestEnv();
    const since = "2026-07-10T00:00:00.000Z";
    await seedCostEvent(env, "inst-1", 2.0, "2026-07-11T00:00:00.000Z"); // in window
    await seedCostEvent(env, "inst-1", 9.0, "2026-07-01T00:00:00.000Z"); // before the window
    await seedCostEvent(env, null, 5.0, "2026-07-11T00:00:00.000Z"); // self-host, must never appear

    const rows = await listAiCostByTenantSince(env, since);

    expect(rows).toEqual([{ installationId: "inst-1", totalCostUsd: 2.0 }]);
  });

  it("returns an empty list, not an error, when there are no hosted rows at all (the self-host default)", async () => {
    const env = createTestEnv();
    expect(await listAiCostByTenantSince(env, "2026-07-10T00:00:00.000Z")).toEqual([]);
  });
});

describe("listRowCountByTenantSince (#4890): per-tenant storage breakdown for the operator dashboard", () => {
  it("groups by tenant, counts correctly, and orders highest-count-first", async () => {
    const env = createTestEnv();
    const since = "2026-07-10T00:00:00.000Z";
    await seedCostEvent(env, "inst-1", 1.25, "2026-07-11T00:00:00.000Z");
    await seedCostEvent(env, "inst-1", 0.75, "2026-07-12T00:00:00.000Z"); // inst-1: 2 rows
    await seedCostEvent(env, "inst-2", 4.0, "2026-07-13T00:00:00.000Z");
    await seedCostEvent(env, "inst-2", 4.0, "2026-07-13T00:00:00.000Z");
    await seedCostEvent(env, "inst-2", 4.0, "2026-07-13T00:00:00.000Z"); // inst-2: 3 rows (highest)
    await seedCostEvent(env, "inst-3", 0.5, "2026-07-13T00:00:00.000Z"); // inst-3: 1 row (lowest)

    const rows = await listRowCountByTenantSince(env, since);

    expect(rows).toEqual([
      { installationId: "inst-2", rowCount: 3 },
      { installationId: "inst-1", rowCount: 2 },
      { installationId: "inst-3", rowCount: 1 },
    ]);
  });

  it("excludes self-host rows (null installation_id) and rows outside the time window", async () => {
    const env = createTestEnv();
    const since = "2026-07-10T00:00:00.000Z";
    await seedCostEvent(env, "inst-1", 2.0, "2026-07-11T00:00:00.000Z"); // in window
    await seedCostEvent(env, "inst-1", 9.0, "2026-07-01T00:00:00.000Z"); // before the window
    await seedCostEvent(env, null, 5.0, "2026-07-11T00:00:00.000Z"); // self-host, must never appear

    const rows = await listRowCountByTenantSince(env, since);

    expect(rows).toEqual([{ installationId: "inst-1", rowCount: 1 }]);
  });

  it("returns an empty list, not an error, when there are no hosted rows at all (the self-host default)", async () => {
    const env = createTestEnv();
    expect(await listRowCountByTenantSince(env, "2026-07-10T00:00:00.000Z")).toEqual([]);
  });
});
