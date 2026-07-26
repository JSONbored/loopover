import { describe, expect, it } from "vitest";
import { parseTargetKey, planPrOutcomeBackfill, type TerminalActionRow } from "../../scripts/backfill-pr-outcomes-core";
import { runBackfill } from "../../scripts/backfill-pr-outcomes";

// #8823: the historical half of the lost-ground-truth fix. The planning core decides WHAT to backfill from
// completed terminal actions; a wrong decision here would inject fabricated ground truth into calibration,
// so every skip arm is asserted explicitly.
describe("parseTargetKey", () => {
  it("accepts the canonical owner/repo#N shape", () => {
    expect(parseTargetKey("JSONbored/loopover#8428")).toEqual({ project: "JSONbored/loopover", pullNumber: 8428 });
  });

  it("rejects the LEGACY project:pull_request:owner/repo#N shape the fleet export already excludes", () => {
    expect(parseTargetKey("JSONbored/awesome-claude:pull_request:JSONbored/awesome-claude#2516")).toBeNull();
  });

  it("rejects malformed keys rather than guessing", () => {
    expect(parseTargetKey("no-hash")).toBeNull();
    expect(parseTargetKey("#123")).toBeNull(); // no project
    expect(parseTargetKey("owner/repo#")).toBeNull(); // no number
    expect(parseTargetKey("owner/repo#abc")).toBeNull(); // non-numeric
    expect(parseTargetKey("owner/repo#0")).toBeNull(); // PR numbers are 1-based
    expect(parseTargetKey("ownerrepo#12")).toBeNull(); // missing the slash
  });
});

describe("planPrOutcomeBackfill (#8823)", () => {
  const row = (targetKey: string, eventType: string, createdAt: string): TerminalActionRow => ({ targetKey, eventType, createdAt });

  it("maps merge → merged and close → closed for targets with no recorded outcome", () => {
    const plan = planPrOutcomeBackfill(
      [row("o/r#1", "agent.action.merge", "2026-07-20T00:00:00Z"), row("o/r#2", "agent.action.close", "2026-07-21T00:00:00Z")],
      new Set(),
    );
    expect(plan.entries).toEqual([
      { targetKey: "o/r#1", project: "o/r", pullNumber: 1, decision: "merged", createdAt: "2026-07-20T00:00:00Z" },
      { targetKey: "o/r#2", project: "o/r", pullNumber: 2, decision: "closed", createdAt: "2026-07-21T00:00:00Z" },
    ]);
  });

  it("NEVER re-writes a target that already has a pr_outcome (the webhook got through)", () => {
    const plan = planPrOutcomeBackfill([row("o/r#1", "agent.action.close", "2026-07-20T00:00:00Z")], new Set(["o/r#1"]));
    expect(plan.entries).toEqual([]);
    expect(plan.skipped.alreadyRecorded).toBe(1);
  });

  it("skips legacy/unparseable target keys and non-terminal action types instead of fabricating an outcome", () => {
    const plan = planPrOutcomeBackfill(
      [
        row("o/r:pull_request:o/r#5", "agent.action.close", "2026-07-20T00:00:00Z"),
        row("o/r#6", "agent.action.label", "2026-07-20T00:00:00Z"),
      ],
      new Set(),
    );
    expect(plan.entries).toEqual([]);
    expect(plan.skipped).toEqual({ alreadyRecorded: 0, unparseable: 1, unknownAction: 1 });
  });

  it("when a target has BOTH actions the LATEST wins — the effect that survived — regardless of input order", () => {
    const late = row("o/r#9", "agent.action.merge", "2026-07-22T00:00:00Z");
    const early = row("o/r#9", "agent.action.close", "2026-07-20T00:00:00Z");
    expect(planPrOutcomeBackfill([early, late], new Set()).entries[0]).toMatchObject({ decision: "merged" });
    expect(planPrOutcomeBackfill([late, early], new Set()).entries[0]).toMatchObject({ decision: "merged" });
    // Equal timestamps keep the first-seen row rather than flapping on input order.
    const tie = planPrOutcomeBackfill([row("o/r#9", "agent.action.close", "2026-07-22T00:00:00Z"), late], new Set());
    expect(tie.entries[0]).toMatchObject({ decision: "closed" });
  });

  it("emits a deterministic (createdAt, then targetKey) order so a dry run matches the real run", () => {
    const plan = planPrOutcomeBackfill(
      [
        row("o/r#3", "agent.action.close", "2026-07-22T00:00:00Z"),
        row("o/r#1", "agent.action.close", "2026-07-20T00:00:00Z"),
        row("o/r#2", "agent.action.close", "2026-07-22T00:00:00Z"),
      ],
      new Set(),
    );
    expect(plan.entries.map((e) => e.targetKey)).toEqual(["o/r#1", "o/r#2", "o/r#3"]);
  });

  it("returns an empty plan (never throws) for no input at all", () => {
    expect(planPrOutcomeBackfill([], new Set())).toEqual({ entries: [], skipped: { alreadyRecorded: 0, unparseable: 0, unknownAction: 0 } });
  });
});

describe("runBackfill IO wrapper (#8823)", () => {
  function fakeDb(actions: Array<Record<string, unknown>>, recorded: string[]) {
    const writes: unknown[][] = [];
    return {
      writes,
      db: {
        all: async (sql: string) => (sql.includes("audit_events") ? actions : recorded.map((targetId) => ({ targetId }))),
        run: async (_sql: string, binds?: unknown[]) => {
          writes.push(binds ?? []);
          return undefined;
        },
      },
    };
  }

  it("DRY RUN reports the plan and writes nothing", async () => {
    const { db, writes } = fakeDb(
      [{ targetKey: "o/r#1", eventType: "agent.action.close", createdAt: "2026-07-20T00:00:00Z" }],
      [],
    );
    const lines: string[] = [];
    expect(await runBackfill(db, false, (l) => lines.push(l))).toBe(1);
    expect(writes).toHaveLength(0);
    expect(lines.join("\n")).toContain("DRY RUN");
    expect(lines.join("\n")).toContain("would write o/r#1 -> closed");
  });

  it("--apply writes exactly the planned rows and is idempotent on a second run", async () => {
    const actions = [
      { targetKey: "o/r#1", eventType: "agent.action.close", createdAt: "2026-07-20T00:00:00Z" },
      { targetKey: "o/r#2", eventType: "agent.action.merge", createdAt: "2026-07-21T00:00:00Z" },
    ];
    const first = fakeDb(actions, []);
    expect(await runBackfill(first.db, true, () => undefined)).toBe(2);
    expect(first.writes.map((w) => [w[2], w[3]])).toEqual([
      ["o/r#1", "closed"],
      ["o/r#2", "merged"],
    ]);
    // Re-run with those targets now recorded -> nothing to do.
    const second = fakeDb(actions, ["o/r#1", "o/r#2"]);
    expect(await runBackfill(second.db, true, () => undefined)).toBe(0);
    expect(second.writes).toHaveLength(0);
  });

  it("truncates the dry-run listing past 20 entries instead of flooding the operator", async () => {
    const actions = Array.from({ length: 25 }, (_, i) => ({
      targetKey: `o/r#${i + 1}`,
      eventType: "agent.action.close",
      createdAt: `2026-07-${String((i % 9) + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    const { db } = fakeDb(actions, []);
    const lines: string[] = [];
    expect(await runBackfill(db, false, (l) => lines.push(l))).toBe(25);
    expect(lines.join("\n")).toContain("and 5 more");
  });
});
