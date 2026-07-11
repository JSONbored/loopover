import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { attemptLoopReentry, countConsecutiveDisengagements, countReentriesSince, LOOP_REENTRY_DECISION_EVENT } from "../../packages/gittensory-miner/lib/loop-reentry.js";
import { initEventLedger } from "../../packages/gittensory-miner/lib/event-ledger.js";
import { initPortfolioQueueStore } from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import { initRunStateStore } from "../../packages/gittensory-miner/lib/run-state.js";
import { recordPrOutcomeSnapshot } from "../../packages/gittensory-miner/lib/pr-outcome.js";

const roots: string[] = [];
const closers: Array<{ close(): void }> = [];

function tempPath(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `gittensory-miner-${prefix}-`));
  roots.push(root);
  return join(root, "db.sqlite3");
}

function tempEventLedger() {
  const ledger = initEventLedger(tempPath("loop-reentry-events"));
  closers.push(ledger);
  return ledger;
}

function tempPortfolioQueue() {
  const queue = initPortfolioQueueStore(tempPath("loop-reentry-queue"));
  closers.push(queue);
  return queue;
}

function tempRunState() {
  const store = initRunStateStore(tempPath("loop-reentry-runstate"));
  closers.push(store);
  return store;
}

afterEach(() => {
  for (const closer of closers.splice(0)) closer.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("attemptLoopReentry (#2338)", () => {
  it("merged outcome: re-entry fires once, dequeuing the next candidate and transitioning run-state to discovering", () => {
    const eventLedger = tempEventLedger();
    const portfolioQueue = tempPortfolioQueue();
    const runState = tempRunState();
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue-42" });

    const result = attemptLoopReentry(
      { killSwitchScope: "none", repoFullName: "acme/widgets", outcome: "merged" },
      { eventLedger, portfolioQueue, runState },
    );

    expect(result.decision.reenter).toBe(true);
    expect(result.decision.reasons).toEqual([]);
    expect(result.dequeued?.identifier).toBe("issue-42");
    expect(runState.getRunState("acme/widgets")).toBe("discovering");

    const events = eventLedger.readEvents({ repoFullName: "acme/widgets" });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(LOOP_REENTRY_DECISION_EVENT);
    expect(events[0]?.payload).toMatchObject({ reentered: true, outcome: "merged", dequeuedIdentifier: "issue-42" });
  });

  it("rejected outcome with a high repeated-blocker (consecutive disengagement) tally: re-entry is suppressed and the repo stays paused", () => {
    const eventLedger = tempEventLedger();
    const portfolioQueue = tempPortfolioQueue();
    const runState = tempRunState();
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue-99" });

    // Seed three consecutive closed-without-merge outcomes for this repo -- at the default ceiling.
    for (let prNumber = 1; prNumber <= 3; prNumber += 1) {
      recordPrOutcomeSnapshot(
        { repoFullName: "acme/widgets", prNumber, decision: "closed", closedAt: new Date().toISOString(), reason: "stale" },
        { eventLedger },
      );
    }
    expect(countConsecutiveDisengagements(eventLedger, "acme/widgets")).toBe(3);

    const result = attemptLoopReentry(
      { killSwitchScope: "none", repoFullName: "acme/widgets", outcome: "disengaged" },
      { eventLedger, portfolioQueue, runState },
    );

    expect(result.decision.reenter).toBe(false);
    expect(result.decision.reasons).toEqual(["repo_paused_after_consecutive_disengagements:3>=3"]);
    expect(result.dequeued).toBeNull();
    expect(runState.getRunState("acme/widgets")).toBeNull();

    // The candidate remains queued -- it was never dequeued.
    expect(portfolioQueue.listQueue("acme/widgets")).toHaveLength(1);

    const events = eventLedger.readEvents({ repoFullName: "acme/widgets" });
    const decisionEvents = events.filter((event) => event.type === LOOP_REENTRY_DECISION_EVENT);
    expect(decisionEvents).toHaveLength(1);
    expect(decisionEvents[0]?.payload).toMatchObject({ reentered: false, dequeuedIdentifier: null });
  });

  it("a single merged outcome after a run of closed outcomes resets the consecutive-disengagement streak to zero", () => {
    const eventLedger = tempEventLedger();
    for (let prNumber = 1; prNumber <= 2; prNumber += 1) {
      recordPrOutcomeSnapshot({ repoFullName: "acme/widgets", prNumber, decision: "closed", closedAt: new Date().toISOString(), reason: "stale" }, { eventLedger });
    }
    recordPrOutcomeSnapshot({ repoFullName: "acme/widgets", prNumber: 3, decision: "merged", closedAt: new Date().toISOString() }, { eventLedger });

    expect(countConsecutiveDisengagements(eventLedger, "acme/widgets")).toBe(0);
  });

  it("the hourly rate cap suppresses re-entry independent of the per-repo circuit breaker, and does not move the run-state or dequeue", () => {
    const eventLedger = tempEventLedger();
    const portfolioQueue = tempPortfolioQueue();
    const runState = tempRunState();
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue-1" });

    const now = Date.now();
    for (let i = 0; i < 4; i += 1) {
      eventLedger.appendEvent({
        type: LOOP_REENTRY_DECISION_EVENT,
        repoFullName: "other/repo",
        payload: { reentered: true },
      });
    }
    expect(countReentriesSince(eventLedger, now - 60 * 60 * 1000)).toBe(4);

    const result = attemptLoopReentry(
      { killSwitchScope: "none", repoFullName: "acme/widgets", outcome: "merged", maxReentriesPerHour: 4 },
      { eventLedger, portfolioQueue, runState, nowMs: now },
    );

    expect(result.decision.reenter).toBe(false);
    expect(result.decision.reasons).toEqual(["hourly_reentry_cap_reached:4>=4"]);
    expect(runState.getRunState("acme/widgets")).toBeNull();
    expect(portfolioQueue.listQueue("acme/widgets")).toHaveLength(1);
  });

  it("the session rate cap suppresses re-entry independent of the hourly cap, and does not move the run-state or dequeue", () => {
    const eventLedger = tempEventLedger();
    const portfolioQueue = tempPortfolioQueue();
    const runState = tempRunState();
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue-1" });

    for (let i = 0; i < 20; i += 1) {
      eventLedger.appendEvent({ type: LOOP_REENTRY_DECISION_EVENT, repoFullName: "other/repo", payload: { reentered: true } });
    }

    const result = attemptLoopReentry(
      { killSwitchScope: "none", repoFullName: "acme/widgets", outcome: "merged", maxReentriesPerHour: 1_000, maxReentriesPerSession: 20 },
      { eventLedger, portfolioQueue, runState, sessionStartMs: 0 },
    );

    expect(result.decision.reenter).toBe(false);
    expect(result.decision.reasons).toEqual(["session_reentry_cap_reached:20>=20"]);
    expect(runState.getRunState("acme/widgets")).toBeNull();
  });

  it("fails closed on a malformed candidate or missing dependency rather than silently allowing", () => {
    const eventLedger = tempEventLedger();
    const portfolioQueue = tempPortfolioQueue();

    expect(() => attemptLoopReentry(null as never, { eventLedger, portfolioQueue })).toThrow("invalid_loop_reentry_candidate");
    expect(() => attemptLoopReentry({ repoFullName: "acme/widgets", outcome: "merged" } as never, { eventLedger, portfolioQueue })).toThrow("invalid_kill_switch_scope");
    expect(() => attemptLoopReentry({ killSwitchScope: "bogus", repoFullName: "acme/widgets", outcome: "merged" } as never, { eventLedger, portfolioQueue })).toThrow("invalid_kill_switch_scope");
    expect(() => attemptLoopReentry({ killSwitchScope: "none", outcome: "merged" } as never, { eventLedger, portfolioQueue })).toThrow("invalid_repo_full_name");
    expect(() => attemptLoopReentry({ killSwitchScope: "none", repoFullName: "", outcome: "merged" }, { eventLedger, portfolioQueue })).toThrow("invalid_repo_full_name");
    expect(() => attemptLoopReentry({ killSwitchScope: "none", repoFullName: "acme/widgets", outcome: "bogus" as never }, { eventLedger, portfolioQueue })).toThrow("invalid_outcome");
    expect(() => attemptLoopReentry({ killSwitchScope: "none", repoFullName: "acme/widgets", outcome: "merged" }, null as never)).toThrow("invalid_loop_reentry_deps");
    expect(() => attemptLoopReentry({ killSwitchScope: "none", repoFullName: "acme/widgets", outcome: "merged" }, { eventLedger } as never)).toThrow("invalid_portfolio_queue");
    expect(() => attemptLoopReentry({ killSwitchScope: "none", repoFullName: "acme/widgets", outcome: "merged" }, { portfolioQueue } as never)).toThrow("invalid_event_ledger");
  });

  it("kill-switch (#2339): an active kill-switch blocks re-entry unconditionally, without dequeuing or moving run-state", () => {
    const eventLedger = tempEventLedger();
    const portfolioQueue = tempPortfolioQueue();
    const runState = tempRunState();
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue-1" });

    const result = attemptLoopReentry(
      { killSwitchScope: "global", repoFullName: "acme/widgets", outcome: "merged" },
      { eventLedger, portfolioQueue, runState },
    );

    expect(result.decision).toEqual({ reenter: false, reasons: ["global_kill_switch_active"] });
    expect(result.dequeued).toBeNull();
    expect(runState.getRunState("acme/widgets")).toBeNull();
    expect(portfolioQueue.listQueue("acme/widgets")).toHaveLength(1);
    expect(result.event.payload).toMatchObject({ killSwitchScope: "global" });
  });

  it("threads a caller-supplied loopSummary verbatim into the audit event payload for traceability", () => {
    const eventLedger = tempEventLedger();
    const portfolioQueue = tempPortfolioQueue();
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue-1" });
    const loopSummary = { sinceSeq: 10, lastSeq: 42, events: { total: 3, byType: { pr_outcome: 1 } }, queue: { total: 1, byStatus: { queued: 1 } }, runState: "idle" };

    const result = attemptLoopReentry({ killSwitchScope: "none", repoFullName: "acme/widgets", outcome: "merged" }, { eventLedger, portfolioQueue, loopSummary });

    expect(result.event.payload.loopSummary).toEqual(loopSummary);
  });

  it("records a null loopSummary in the audit payload when the caller supplies none", () => {
    const eventLedger = tempEventLedger();
    const portfolioQueue = tempPortfolioQueue();
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue-1" });

    const result = attemptLoopReentry({ killSwitchScope: "none", repoFullName: "acme/widgets", outcome: "merged" }, { eventLedger, portfolioQueue });

    expect(result.event.payload.loopSummary).toBeNull();
  });

  it("proceeds without a runState dependency (it is optional) and without touching it", () => {
    const eventLedger = tempEventLedger();
    const portfolioQueue = tempPortfolioQueue();
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue-1" });

    const result = attemptLoopReentry({ killSwitchScope: "none", repoFullName: "acme/widgets", outcome: "merged" }, { eventLedger, portfolioQueue });
    expect(result.decision.reenter).toBe(true);
    expect(result.dequeued?.identifier).toBe("issue-1");
  });
});
