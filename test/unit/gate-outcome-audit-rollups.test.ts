import { describe, expect, it } from "vitest";
import { listGateOutcomeAuditEventRollups, recordAuditEvent } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("listGateOutcomeAuditEventRollups (#2203)", () => {
  it("counts repo-scoped merge/close/hold audit rows inside the window", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "agent.action.merge",
      actor: "loopover",
      targetKey: "octo/demo#1",
      outcome: "completed",
      createdAt: "2026-07-10T12:00:00.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "agent.action.close",
      actor: "loopover",
      targetKey: "octo/demo#2",
      outcome: "success",
      createdAt: "2026-07-10T13:00:00.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "agent.action.hold",
      actor: "loopover",
      targetKey: "octo/demo#3",
      outcome: "completed",
      createdAt: "2026-07-10T14:00:00.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "agent.action.merge",
      actor: "loopover",
      targetKey: "other/repo#9",
      outcome: "completed",
      createdAt: "2026-07-10T15:00:00.000Z",
    });

    const rollups = await listGateOutcomeAuditEventRollups(env, {
      repoFullNames: ["octo/demo"],
      sinceIso: "2026-07-01T00:00:00.000Z",
    });
    expect(rollups).toEqual(
      expect.arrayContaining([
        { eventType: "agent.action.merge", outcome: "completed", count: 1 },
        { eventType: "agent.action.close", outcome: "success", count: 1 },
        { eventType: "agent.action.hold", outcome: "completed", count: 1 },
      ]),
    );
    expect(rollups.some((row) => row.eventType === "agent.action.merge" && row.count > 1)).toBe(false);
  });

  it("returns an empty rollup list when the scoped repo list is empty", async () => {
    const env = createTestEnv();
    await expect(listGateOutcomeAuditEventRollups(env, { repoFullNames: [], sinceIso: "2026-07-01T00:00:00.000Z" })).resolves.toEqual([]);
  });

  it("ignores blank repo names after trimming", async () => {
    const env = createTestEnv();
    await expect(
      listGateOutcomeAuditEventRollups(env, { repoFullNames: ["  ", ""], sinceIso: "2026-07-01T00:00:00.000Z" }),
    ).resolves.toEqual([]);
  });
});
