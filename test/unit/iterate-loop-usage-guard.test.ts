import { describe, expect, it } from "vitest";

import {
  parseFocusManifest,
  runIterateLoop,
  type AttemptLogEvent,
  type CodingAgentDriver,
  type CodingAgentDriverResult,
  type IterateLoopDeps,
  type IterateLoopInput,
  type SelfReviewContext,
  type SelfReviewSlopAssessment,
} from "../../packages/loopover-engine/src/index";

// Codecov measures packages/loopover-engine/src/** via the vitest suite (NOT the engine's own node --test
// suite), so runIterateLoop's #5827 finiteNonNegativeUsage guard needs coverage here, importing from src.

const REPO = { fullName: "acme/widgets", owner: "acme", name: "widgets", isInstalled: true, isRegistered: true, isPrivate: false };
const noopSlop: SelfReviewSlopAssessment = { slopRisk: 0, band: "clean", findings: [] };

function baseReviewContext(): SelfReviewContext {
  return {
    manifest: parseFocusManifest({ gate: { duplicates: "block", linkedIssue: "advisory" } }),
    repo: REPO,
    issues: [{ repoFullName: "acme/widgets", number: 7, title: "Uploads should retry on 5xx", state: "open", labels: [], linkedPrs: [] }],
    pullRequests: [],
  };
}

function passingInput(overrides: Partial<IterateLoopInput> = {}): IterateLoopInput {
  return {
    attemptId: "attempt-1",
    workingDirectory: "/tmp/attempt-1",
    acceptanceCriteriaPath: "/tmp/attempt-1/acceptance-criteria.json",
    instructions: "Add retry to the upload client",
    mode: "live",
    maxIterations: 3,
    maxTurnsPerIteration: 20,
    repoFullName: "acme/widgets",
    contributorLogin: "miner1",
    title: "Add retry to the upload client",
    reviewContext: baseReviewContext(),
    rejectionSignaled: false,
    body: "Closes #7",
    linkedIssues: [7],
    ...overrides,
  };
}

function driverReturning(result: CodingAgentDriverResult): CodingAgentDriver {
  return { async run() { return result; } };
}

function collectingDeps(driver: CodingAgentDriver): { deps: IterateLoopDeps; events: AttemptLogEvent[] } {
  const events: AttemptLogEvent[] = [];
  const deps: IterateLoopDeps = {
    driver,
    runSlopAssessment: () => noopSlop,
    appendAttemptLogEvent: (event) => {
      events.push(event);
    },
  };
  return { deps, events };
}

describe("runIterateLoop usage guard (#5827)", () => {
  it("does not reject uncaught when a driver reports an out-of-contract usage value; still logs a decision", async () => {
    for (const badTurns of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { deps, events } = collectingDeps(driverReturning({ ok: true, changedFiles: ["src/upload.ts"], summary: "x", turnsUsed: badTurns as number }));
      const result = await runIterateLoop(passingInput(), deps);

      expect(result.outcome).toBe("handoff");
      expect(events.some((event) => event.actionClass === "iterate_loop")).toBe(true);
      expect(result.finalMeterTotals.turns).toBe(0); // poisoned axis clamped, not propagated
    }
  });

  it("clamps only the out-of-contract axis, preserving a valid axis on the same iteration", async () => {
    const { deps } = collectingDeps(driverReturning({ ok: true, changedFiles: ["src/upload.ts"], summary: "x", turnsUsed: Number.NaN, costUsd: 0.02 }));
    const result = await runIterateLoop(passingInput(), deps);

    expect(result.outcome).toBe("handoff");
    expect(result.finalMeterTotals.turns).toBe(0);
    expect(result.finalMeterTotals.costUsd).toBe(0.02);
  });

  it("clamps out-of-contract turnsUsed/costUsd out of the totalTurnsUsed/totalCostUsd accumulators too (#7246)", async () => {
    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const { deps } = collectingDeps(driverReturning({ ok: true, changedFiles: ["src/upload.ts"], summary: "x", turnsUsed: bad as number, costUsd: bad as number }));
      const result = await runIterateLoop(passingInput(), deps);
      // Before #7246 these used only `?? 0`, so NaN/negative/Infinity flowed straight into the running totals.
      expect(result.totalTurnsUsed).toBe(0);
      expect(result.totalCostUsd).toBe(0);
      expect(Number.isFinite(result.totalTurnsUsed)).toBe(true);
      expect(Number.isFinite(result.totalCostUsd)).toBe(true);
    }
  });

  it("abandons immediately on a NaN or Infinity maxIterations rather than corrupting iterationsUsed or looping unbounded (#8860)", async () => {
    for (const badMax of [Number.NaN, Number.POSITIVE_INFINITY]) {
      let driverCalled = false;
      const { deps } = collectingDeps({ async run() { driverCalled = true; return { ok: true, changedFiles: ["src/upload.ts"], summary: "x" }; } });
      const result = await runIterateLoop(passingInput({ maxIterations: badMax as number }), deps);

      expect(result.outcome).toBe("abandon");
      expect(result.finalDecision.abandonReason).toBe("max_iterations_reached");
      expect(result.iterationsUsed).toBe(0);
      expect(Number.isNaN(result.iterationsUsed)).toBe(false);
      expect(driverCalled).toBe(false);
    }
  });
});
