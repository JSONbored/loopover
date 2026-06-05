import { describe, expect, it } from "vitest";
import { listPrVisibilitySkipAuditEvents, recordAuditEvent } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("skipped PR audit repository export", () => {
  it("bounds queries, scopes repositories, and skips malformed audit targets", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      targetKey: "owner/re_po#7",
      outcome: "completed",
      detail: null,
      createdAt: "2026-05-28T00:00:07.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      targetKey: "owner/reXpo#8",
      outcome: "completed",
      detail: "bot_author",
      createdAt: "2026-05-28T00:00:08.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      targetKey: null,
      outcome: "completed",
      detail: "missing_target",
      createdAt: "2026-05-28T00:00:09.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      targetKey: "bad-target",
      outcome: "completed",
      detail: "bad_target",
      createdAt: "2026-05-28T00:00:10.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      targetKey: "owner/re_po#0",
      outcome: "completed",
      detail: "bad_number",
      createdAt: "2026-05-28T00:00:11.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      targetKey: "owner/re_po#nan",
      outcome: "completed",
      detail: "bad_number",
      createdAt: "2026-05-28T00:00:12.000Z",
    });

    const emptyScope = await listPrVisibilitySkipAuditEvents(env, { repoFullNames: [] });
    expect(emptyScope).toMatchObject({ limit: 50, hasMore: false, items: [] });

    const scoped = await listPrVisibilitySkipAuditEvents(env, {
      limit: Number.NaN,
      repoFullNames: ["owner/re_po", "OWNER/re_po"],
    });
    expect(scoped.limit).toBe(1);
    expect(scoped.items).toEqual([
      {
        repoFullName: "owner/re_po",
        pullNumber: 7,
        reason: "skipped",
        outcome: "completed",
        createdAt: "2026-05-28T00:00:07.000Z",
      },
    ]);

    const unscoped = await listPrVisibilitySkipAuditEvents(env);
    expect(unscoped.limit).toBe(50);
    expect(unscoped.items.map((item) => item.pullNumber)).toEqual([8, 7]);
  });
});
