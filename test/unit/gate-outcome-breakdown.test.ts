import { describe, expect, it } from "vitest";
import {
  buildGateOutcomeBreakdown,
  classifyGateOutcomeAuditBucket,
  GATE_OUTCOME_BREAKDOWN_WINDOW_DAYS,
} from "../../src/services/gate-outcome-breakdown";

const FORBIDDEN_PUBLIC_TERMS =
  /wallet|hotkey|coldkey|mnemonic|reward|payout|farming|raw trust|trust score|scoreability|credibility|private ranking/i;

describe("buildGateOutcomeBreakdown (#2203)", () => {
  it("folds merge/close/hold audit rollups into counts and rates when all buckets are present", () => {
    const result = buildGateOutcomeBreakdown({
      generatedAt: "2026-07-11T00:00:00.000Z",
      rollups: [
        { eventType: "agent.action.merge", outcome: "completed", count: 6 },
        { eventType: "agent.action.close", outcome: "success", count: 3 },
        { eventType: "agent.action.hold", outcome: "completed", count: 1 },
      ],
    });
    expect(result).toMatchObject({
      windowDays: GATE_OUTCOME_BREAKDOWN_WINDOW_DAYS,
      counts: { autoMerged: 6, autoClosed: 3, held: 1 },
      total: 10,
      rates: { autoMerged: 60, autoClosed: 30, held: 10 },
    });
    expect(result.summary).toContain("6 auto-merged");
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("leaves a zero bucket at count 0 while still computing rates for the others", () => {
    const result = buildGateOutcomeBreakdown({
      generatedAt: "2026-07-11T00:00:00.000Z",
      rollups: [
        { eventType: "agent.action.merge", outcome: "completed", count: 4 },
        { eventType: "agent.action.hold", outcome: "completed", count: 1 },
      ],
    });
    expect(result.counts).toEqual({ autoMerged: 4, autoClosed: 0, held: 1 });
    expect(result.rates.autoClosed).toBe(0);
    expect(result.rates.autoMerged).toBe(80);
  });

  it("returns null rates and an empty summary branch when there are no gate-outcome events", () => {
    const result = buildGateOutcomeBreakdown({ generatedAt: "2026-07-11T00:00:00.000Z", rollups: [] });
    expect(result.total).toBe(0);
    expect(result.rates).toEqual({ autoMerged: null, autoClosed: null, held: null });
    expect(result.summary).toContain("No gate-outcome audit events");
  });

  it("classifyGateOutcomeAuditBucket ignores dry-run or non-terminal merge/close/hold rows", () => {
    expect(classifyGateOutcomeAuditBucket({ eventType: "agent.action.merge", outcome: "dry_run" })).toBeNull();
    expect(classifyGateOutcomeAuditBucket({ eventType: "agent.action.close", outcome: "denied" })).toBeNull();
    expect(classifyGateOutcomeAuditBucket({ eventType: "agent.action.hold", outcome: "dry_run" })).toBeNull();
    expect(classifyGateOutcomeAuditBucket({ eventType: "agent.action.hold", outcome: "denied" })).toBeNull();
    expect(classifyGateOutcomeAuditBucket({ eventType: "agent.action.approve", outcome: "completed" })).toBeNull();
    expect(classifyGateOutcomeAuditBucket({ eventType: "agent.action.hold", outcome: "completed" })).toBe("held");
  });

  it("skips unrecognized audit rollups when folding counts", () => {
    const result = buildGateOutcomeBreakdown({
      generatedAt: "2026-07-11T00:00:00.000Z",
      rollups: [
        { eventType: "agent.action.merge", outcome: "completed", count: 2 },
        { eventType: "agent.action.merge", outcome: "dry_run", count: 9 },
      ],
    });
    expect(result.counts.autoMerged).toBe(2);
    expect(result.total).toBe(2);
  });

  it("honors an explicit windowDays override in the summary", () => {
    const result = buildGateOutcomeBreakdown({
      generatedAt: "2026-07-11T00:00:00.000Z",
      windowDays: 7,
      rollups: [],
    });
    expect(result.windowDays).toBe(7);
    expect(result.summary).toContain("7 day(s)");
  });
});
