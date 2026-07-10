import { describe, expect, it } from "vitest";
import { buildLoopClosureSummary } from "../../packages/gittensory-miner/lib/loop-closure.js";

// A mock event ledger that honors the real `readEvents({ since, repoFullName })` cursor contract (strictly-greater
// seq, optional repo filter), so the sinceSeq cycle boundary is exercised through the same shape as the SQLite one.
function mockEventLedger(events: Array<{ seq: number; type?: unknown; repoFullName?: string }>): { readEvents: (filter?: { since?: number; repoFullName?: string }) => typeof events } {
  return {
    readEvents: (filter = {}) =>
      events.filter(
        (event) =>
          (filter.since === undefined || event.seq > filter.since) &&
          (filter.repoFullName === undefined || event.repoFullName === filter.repoFullName),
      ),
  };
}
const mockQueue = (entries: Array<{ status?: unknown }>): { listQueue: () => typeof entries } => ({ listQueue: () => entries });

describe("buildLoopClosureSummary (#4282 loop-closure summary)", () => {
  it("rejects sources missing a usable event ledger or portfolio queue", () => {
    expect(() => buildLoopClosureSummary({ portfolioQueue: mockQueue([]) } as never)).toThrow("invalid_event_ledger");
    expect(() => buildLoopClosureSummary({ eventLedger: mockEventLedger([]) } as never)).toThrow("invalid_portfolio_queue");
  });

  it("summarizes an empty cycle (nothing happened) as zeroed tallies", () => {
    const summary = buildLoopClosureSummary({ eventLedger: mockEventLedger([]), portfolioQueue: mockQueue([]) });
    expect(summary).toEqual({
      sinceSeq: null,
      lastSeq: 0,
      events: { total: 0, byType: {} },
      queue: { total: 0, byStatus: {} },
      runState: null,
    });
  });

  it("tallies a mix of event types generically and reports the cycle's last seq", () => {
    const summary = buildLoopClosureSummary(
      {
        eventLedger: mockEventLedger([
          { seq: 1, type: "discovered_issue", repoFullName: "acme/widgets" },
          { seq: 2, type: "discovered_issue", repoFullName: "acme/widgets" },
          { seq: 3, type: "plan_built", repoFullName: "acme/widgets" },
          { seq: 4, type: "pr_opened", repoFullName: "acme/widgets" },
        ]),
        portfolioQueue: mockQueue([{ status: "managing" }, { status: "managing" }, { status: "done" }]),
        runState: { getRunState: () => "idle" },
      },
      { repoFullName: "acme/widgets" },
    );
    expect(summary.events).toEqual({ total: 4, byType: { discovered_issue: 2, plan_built: 1, pr_opened: 1 } });
    expect(summary.queue).toEqual({ total: 3, byStatus: { managing: 2, done: 1 } });
    expect(summary.lastSeq).toBe(4);
    expect(summary.runState).toBe("idle");
  });

  it("uses sinceSeq as the cycle boundary — prior-cycle events are excluded", () => {
    const ledger = mockEventLedger([
      { seq: 1, type: "discovered_issue" }, // prior cycle
      { seq: 2, type: "discovered_issue" }, // prior cycle
      { seq: 3, type: "plan_built" }, // this cycle
      { seq: 4, type: "pr_prepared" }, // this cycle
    ]);
    const summary = buildLoopClosureSummary({ eventLedger: ledger, portfolioQueue: mockQueue([]) }, { sinceSeq: 2 });
    expect(summary.sinceSeq).toBe(2);
    expect(summary.events).toEqual({ total: 2, byType: { plan_built: 1, pr_prepared: 1 } });
    expect(summary.lastSeq).toBe(4); // boundary for the next cycle
  });

  it("falls back to 'unknown' for events/queue entries with a missing or non-string kind, and ignores a non-integer seq", () => {
    const summary = buildLoopClosureSummary({
      eventLedger: mockEventLedger([{ seq: 5, type: "discovered_issue" }, { seq: Number.NaN, type: undefined }]),
      portfolioQueue: mockQueue([{ status: "pending" }, { status: undefined }]),
    });
    expect(summary.events.byType).toEqual({ discovered_issue: 1, unknown: 1 });
    expect(summary.queue.byStatus).toEqual({ pending: 1, unknown: 1 });
    expect(summary.lastSeq).toBe(5); // the NaN-seq event never advances lastSeq
  });

  it("treats a run-state source that reports no state as null, and omits run-state entirely when not supplied", () => {
    const nullState = buildLoopClosureSummary({ eventLedger: mockEventLedger([]), portfolioQueue: mockQueue([]), runState: { getRunState: () => null } });
    expect(nullState.runState).toBeNull();
    const noSource = buildLoopClosureSummary({ eventLedger: mockEventLedger([]), portfolioQueue: mockQueue([]) });
    expect(noSource.runState).toBeNull();
  });

  it("is deterministic: same sources + options yield identical output", () => {
    const sources = { eventLedger: mockEventLedger([{ seq: 1, type: "discovered_issue" }]), portfolioQueue: mockQueue([{ status: "managing" }]) };
    expect(buildLoopClosureSummary(sources, { sinceSeq: 0 })).toEqual(buildLoopClosureSummary(sources, { sinceSeq: 0 }));
  });
});
