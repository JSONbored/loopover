import { describe, expect, it } from "vitest";
import {
  loadSatisfactionFloorStatus,
  SATISFACTION_FLOOR_LOOSENING_EVENT_TYPE,
  SATISFACTION_FLOOR_OVERRIDE_FLAG_KEY,
} from "../../src/services/satisfaction-floor-loosening-run";
import { SATISFACTION_FLOOR_HARD_MINIMUM } from "../../src/services/satisfaction-floor-loosening";
import { LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR } from "../../src/services/linked-issue-satisfaction";
import { recordAuditEvent } from "../../src/db/repositories";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";

// Operator visibility for the loosening loop (#8161): the status read + its internal route. The loop's own
// behavior lives in satisfaction-floor-loosening-run.test.ts — this file pins the reporting surface.

const enabledEnv = () => createTestEnv({ SATISFACTION_FLOOR_AUTOTUNE_ENABLED: "true" as never });

async function setOverrideRow(env: Env, value: string) {
  await env.DB.prepare("INSERT INTO system_flags (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(SATISFACTION_FLOOR_OVERRIDE_FLAG_KEY, value)
    .run();
}

describe("loadSatisfactionFloorStatus (#8161)", () => {
  it("reports the shipped defaults on a fresh deployment: flag off, no override, live floor = shipped, empty history", async () => {
    const status = await loadSatisfactionFloorStatus(createTestEnv());
    expect(status).toEqual({
      flagEnabled: false,
      shippedFloor: LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR,
      liveFloor: LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR,
      storedOverride: null,
      applied: [],
    });
  });

  it("shows a lingering override row even while the flag is OFF, but liveFloor only follows it when ON", async () => {
    const offEnv = createTestEnv();
    await setOverrideRow(offEnv, "0.4");
    const offStatus = await loadSatisfactionFloorStatus(offEnv);
    expect(offStatus.storedOverride).toBe(0.4);
    expect(offStatus.flagEnabled).toBe(false);
    expect(offStatus.liveFloor).toBe(LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR); // flag off ⇒ shipped floor rules

    const onEnv = enabledEnv();
    await setOverrideRow(onEnv, "0.4");
    const onStatus = await loadSatisfactionFloorStatus(onEnv);
    expect(onStatus.liveFloor).toBe(0.4);
  });

  it("rejects out-of-bounds or unparseable stored values from BOTH storedOverride and liveFloor", async () => {
    for (const bad of ["0.9", String(SATISFACTION_FLOOR_HARD_MINIMUM - 0.05), "junk", String(LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR)]) {
      const env = enabledEnv();
      await setOverrideRow(env, bad);
      const status = await loadSatisfactionFloorStatus(env);
      expect(status.storedOverride).toBeNull();
      expect(status.liveFloor).toBe(LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR);
    }
  });

  it("projects the applied history newest-first with both split verdicts, and a corrupt row degrades to nulls instead of vanishing", async () => {
    const env = enabledEnv();
    await recordAuditEvent(env, {
      eventType: SATISFACTION_FLOOR_LOOSENING_EVENT_TYPE,
      actor: "loopover",
      targetKey: "linked_issue_scope_mismatch",
      outcome: "completed",
      metadata: {
        proposal: {
          currentFloor: 0.5,
          proposedFloor: 0.45,
          visibleCases: 24,
          heldOutCases: 7,
          visible: { verdict: "improved" },
          heldOut: { verdict: "unchanged" },
        },
      },
      createdAt: "2026-07-20T00:00:00.000Z",
    });
    await env.DB.prepare(
      "INSERT INTO audit_events (id, event_type, actor, target_key, outcome, detail, metadata_json, created_at) VALUES ('corrupt', ?, 'loopover', 'x', 'completed', '', 'not-json', '2026-07-21T00:00:00.000Z')",
    )
      .bind(SATISFACTION_FLOOR_LOOSENING_EVENT_TYPE)
      .run();

    // A parseable row whose proposal is not an object degrades the same way as unparseable JSON.
    await env.DB.prepare(
      "INSERT INTO audit_events (id, event_type, actor, target_key, outcome, detail, metadata_json, created_at) VALUES ('nonobject', ?, 'loopover', 'x', 'completed', '', '{\"proposal\": 5}', '2026-07-22T00:00:00.000Z')",
    )
      .bind(SATISFACTION_FLOOR_LOOSENING_EVENT_TYPE)
      .run();

    const status = await loadSatisfactionFloorStatus(env);
    expect(status.applied).toHaveLength(3);
    expect(status.applied[1]!.proposedFloor).toBeNull(); // the unparseable-JSON row
    expect(status.applied[0]).toEqual({
      at: "2026-07-22T00:00:00.000Z",
      currentFloor: null,
      proposedFloor: null,
      visibleCases: null,
      heldOutCases: null,
      visibleVerdict: null,
      heldOutVerdict: null,
    });
    expect(status.applied[2]).toEqual({
      at: "2026-07-20T00:00:00.000Z",
      currentFloor: 0.5,
      proposedFloor: 0.45,
      visibleCases: 24,
      heldOutCases: 7,
      visibleVerdict: "improved",
      heldOutVerdict: "unchanged",
    });
  });

  it("fails safe to defaults + empty history on a DB error", async () => {
    const env = enabledEnv();
    env.DB = { prepare: () => { throw new Error("boom"); } } as never;
    const status = await loadSatisfactionFloorStatus(env);
    expect(status.storedOverride).toBeNull();
    expect(status.applied).toEqual([]);
    expect(status.liveFloor).toBe(LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR);
  });
});

describe("GET /v1/internal/calibration/satisfaction-floor (#8161)", () => {
  it("401s without the internal token, and is NOT flag-gated: 200s with the flag off (visibility must survive a flag flip)", async () => {
    const app = createApp();
    const env = createTestEnv();
    expect((await app.request("/v1/internal/calibration/satisfaction-floor", {}, env)).status).toBe(401);
    const res = await app.request("/v1/internal/calibration/satisfaction-floor", { headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flagEnabled: boolean; liveFloor: number; applied: unknown[] };
    expect(body.flagEnabled).toBe(false);
    expect(body.liveFloor).toBe(LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR);
    expect(JSON.stringify(body)).not.toMatch(/reward|payout|trust|wallet|hotkey|issueText|modelResponse/i);
  });
});
