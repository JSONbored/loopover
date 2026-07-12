import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseFocusManifest,
  runIterateLoop,
  type AttemptLogEvent,
  type CodingAgentDriver,
  type CodingAgentDriverResult,
  type IssueRecord,
  type IterateLoopDeps,
  type IterateLoopInput,
  type PullRequestRecord,
  type RepositoryRecord,
  type SelfReviewContext,
  type SelfReviewSlopAssessment,
} from "../dist/index.js";

const REPO: RepositoryRecord = { fullName: "acme/widgets", owner: "acme", name: "widgets", isInstalled: true, isRegistered: true, isPrivate: false };

function openIssue(number: number, title: string): IssueRecord {
  return { repoFullName: "acme/widgets", number, title, state: "open", labels: [], linkedPrs: [] };
}

function openPr(number: number, title: string, linkedIssues: number[] = []): PullRequestRecord {
  return { repoFullName: "acme/widgets", number, title, state: "open", authorLogin: "someone-else", linkedIssues, labels: [] };
}

const noopSlop: SelfReviewSlopAssessment = { slopRisk: 0, band: "clean", findings: [] };

function baseReviewContext(overrides: Partial<SelfReviewContext> = {}): SelfReviewContext {
  return {
    manifest: parseFocusManifest({ gate: { duplicates: "block", linkedIssue: "advisory" } }),
    repo: REPO,
    issues: [openIssue(7, "Uploads should retry on 5xx")],
    pullRequests: [],
    ...overrides,
  };
}

/** Only the required identity fields set -- optional body/labels/linkedIssues/authorAssociation all omitted, so
 *  tests relying on this default exercise the "omitted" side of buildAttemptDiffState's conditional spreads. */
function baseInput(overrides: Partial<IterateLoopInput> = {}): IterateLoopInput {
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
    ...overrides,
  };
}

/** A diff state that matches issue #7 cleanly (title + body + linkedIssues) with no duplicate PR in the
 *  reviewContext -- the "genuinely passes" shape, mirroring self-review-adapter.test.ts's own BASE_DIFF_STATE. */
function passingInput(overrides: Partial<IterateLoopInput> = {}): IterateLoopInput {
  return baseInput({ body: "Closes #7", linkedIssues: [7], ...overrides });
}

function driverReturning(result: CodingAgentDriverResult): CodingAgentDriver {
  return { async run() { return result; } };
}

function okResult(changedFiles: string[] = ["src/upload.ts"], turnsUsed = 5): CodingAgentDriverResult {
  return { ok: true, changedFiles, summary: "added retry logic", turnsUsed };
}

/** Collects every logged attempt-log event alongside the deps object, so a test can assert on the audit trail
 *  without owning its own bespoke logger. */
function collectingDeps(overrides: Partial<IterateLoopDeps> = {}): { deps: IterateLoopDeps; events: AttemptLogEvent[] } {
  const events: AttemptLogEvent[] = [];
  const deps: IterateLoopDeps = {
    driver: driverReturning(okResult()),
    runSlopAssessment: () => noopSlop,
    appendAttemptLogEvent: (event) => {
      events.push(event);
    },
    ...overrides,
  };
  return { deps, events };
}

test("barrel: the public entrypoint re-exports the iterate-loop orchestrator (#2333)", () => {
  assert.equal(typeof runIterateLoop, "function");
});

test("immediate abandon: maxIterations <= 0 abandons before ever invoking the driver", async () => {
  let driverCalled = false;
  const { deps, events } = collectingDeps({ driver: { async run() { driverCalled = true; return okResult(); } } });
  const result = await runIterateLoop(baseInput({ maxIterations: 0 }), deps);

  assert.equal(result.outcome, "abandon");
  assert.equal(result.finalDecision.abandonReason, "max_iterations_reached");
  assert.equal(result.iterationsUsed, 0);
  assert.equal(result.totalTurnsUsed, 0);
  assert.deepEqual(result.iterations, []);
  assert.equal(driverCalled, false, "the driver must never run when no iterations are permitted");
  assert.equal(events.length, 1, "the immediate-abandon path still records exactly one audit event");
  assert.equal(events[0]?.eventType, "attempt_aborted");
});

test("paused mode: does not invoke the coding-agent driver (regression for pause gate bypass)", async () => {
  let driverCalled = false;
  const { deps, events } = collectingDeps({ driver: { async run() { driverCalled = true; return okResult(); } } });
  const result = await runIterateLoop(passingInput({ mode: "paused", maxIterations: 1 }), deps);

  assert.equal(driverCalled, false, "paused is a kill switch and must not call driver.run");
  assert.equal(result.outcome, "abandon");
  assert.equal(result.finalDecision.abandonReason, "self_review_ambiguous");
  assert.equal(result.iterationsUsed, 1);
  assert.equal(result.totalTurnsUsed, 0);
  assert.equal(result.iterations[0]?.driverResult.error, "coding_agent_paused");
  assert.equal(events.some((event) => event.eventType === "attempt_aborted" && event.actionClass === "codegen" && event.reason === "coding_agent_paused"), true);
});

test("dry_run mode: records a shadow coding-agent invocation without calling the driver (regression for dry-run gate bypass)", async () => {
  let driverCalled = false;
  const { deps, events } = collectingDeps({ driver: { async run() { driverCalled = true; return okResult(); } } });
  const result = await runIterateLoop(passingInput({ mode: "dry_run", maxIterations: 1 }), deps);

  assert.equal(driverCalled, false, "dry-run must not spawn the underlying coding-agent session");
  assert.equal(result.outcome, "handoff");
  assert.equal(result.iterationsUsed, 1);
  assert.equal(result.totalTurnsUsed, 0);
  assert.equal(result.iterations[0]?.driverResult.ok, true);
  assert.match(result.iterations[0]?.driverResult.summary ?? "", /dry-run: would invoke coding agent/);
  assert.equal(events.some((event) => event.eventType === "attempt_shadow" && event.actionClass === "codegen" && event.mode === "dry_run"), true);
});

test("handoff: a clean predicted-gate pass on the first iteration hands off, with a full HandoffPacket", async () => {
  const { deps, events } = collectingDeps({ driver: driverReturning(okResult(["src/upload.ts"], 5)) });
  const result = await runIterateLoop(passingInput({ maxIterations: 3 }), deps);

  assert.equal(result.outcome, "handoff");
  assert.equal(result.finalDecision.action, "handoff");
  assert.equal(result.iterationsUsed, 1);
  assert.equal(result.totalTurnsUsed, 5);
  assert.equal(result.iterations.length, 1);
  assert.ok(result.handoffPacket);
  assert.equal(result.handoffPacket?.worktreePath, "/tmp/attempt-1");
  assert.equal(result.handoffPacket?.branchRef, undefined, "branchRef is omitted (not just undefined-valued) when the input never set one");
  assert.equal(result.handoffPacket?.diffSummary, "added retry logic");
  assert.equal(result.handoffPacket?.selfReviewVerdict.predictedGateVerdict.conclusion, "success");
  assert.equal(result.handoffPacket?.selfReviewVerdict.passesPredictedGate, true);
  assert.equal(result.handoffPacket?.attemptLogReference, "attempt-1");

  assert.equal(events.filter((event) => event.eventType === "attempt_started").length, 1);
  assert.equal(events.filter((event) => event.eventType === "attempt_succeeded").length, 1);
});

test("handoff: a caller-supplied branchRef is threaded through to the HandoffPacket unchanged", async () => {
  const { deps } = collectingDeps({ driver: driverReturning(okResult()) });
  const result = await runIterateLoop(passingInput({ branchRef: "miner/attempt-1" }), deps);

  assert.equal(result.outcome, "handoff");
  assert.equal(result.handoffPacket?.branchRef, "miner/attempt-1");
});

test("handoff: labels and authorAssociation, when set, are threaded into the self-review verdict identically to a direct call", async () => {
  const { deps } = collectingDeps({ driver: driverReturning(okResult()) });
  const result = await runIterateLoop(
    passingInput({ labels: ["gittensor:feature"], authorAssociation: "CONTRIBUTOR" }),
    deps,
  );
  assert.equal(result.outcome, "handoff");
});

test("runs with only the required identity fields set, without crashing regardless of the resulting verdict", async () => {
  const { deps } = collectingDeps({ driver: driverReturning(okResult()) });
  const result = await runIterateLoop(baseInput({ maxIterations: 1 }), deps);

  assert.equal(result.iterationsUsed, 1);
  assert.ok(result.outcome === "handoff" || result.outcome === "abandon");
});

test("continue then handoff: a duplicate-PR blocker on iteration 1 clears by iteration 2, and the loop hands off", async () => {
  const pullRequests: PullRequestRecord[] = [openPr(42, "Retry uploads on 5xx responses", [7])];
  let callCount = 0;
  const driver: CodingAgentDriver = {
    async run() {
      callCount += 1;
      if (callCount === 1) return okResult(["src/upload.ts"], 3);
      pullRequests.length = 0;
      return okResult(["src/upload.ts"], 4);
    },
  };
  const { deps, events } = collectingDeps({ driver });
  const input = passingInput({ maxIterations: 5, reviewContext: baseReviewContext({ pullRequests }) });
  const result = await runIterateLoop(input, deps);

  assert.equal(result.outcome, "handoff");
  assert.equal(result.iterationsUsed, 2);
  assert.equal(callCount, 2);
  assert.equal(result.totalTurnsUsed, 7);
  assert.equal(events.filter((event) => event.eventType === "attempt_tool_edit").length, 1, "iteration 1's continue is logged as attempt_tool_edit");
});

test("abandon (no_progress): a self-review that keeps failing with the identical blocker set stops iterating", async () => {
  const pullRequests: PullRequestRecord[] = [openPr(42, "Retry uploads on 5xx responses", [7])];
  const { deps, events } = collectingDeps({ driver: driverReturning(okResult(["src/upload.ts"], 2)) });
  const input = passingInput({ maxIterations: 5, reviewContext: baseReviewContext({ pullRequests }) });
  const result = await runIterateLoop(input, deps);

  assert.equal(result.outcome, "abandon");
  assert.equal(result.finalDecision.abandonReason, "no_progress");
  assert.equal(result.iterationsUsed, 2, "iteration 1 continues (no prior to compare); iteration 2 sees the identical blocker set");
  assert.equal(events.filter((event) => event.eventType === "attempt_failed").length, 1);
});

test("abandon (max_iterations_reached): the loop's own ceiling stops it even on the very first iteration", async () => {
  const pullRequests: PullRequestRecord[] = [openPr(42, "Retry uploads on 5xx responses", [7])];
  let callCount = 0;
  const { deps } = collectingDeps({ driver: { async run() { callCount += 1; return okResult(); } } });
  const input = passingInput({ maxIterations: 1, reviewContext: baseReviewContext({ pullRequests }) });
  const result = await runIterateLoop(input, deps);

  assert.equal(result.outcome, "abandon");
  assert.equal(result.finalDecision.abandonReason, "max_iterations_reached");
  assert.equal(callCount, 1, "the driver runs exactly once, for the one permitted iteration");
});

test("a fractional maxIterations truncates toward the lower integer, not silently allowing a partial extra iteration", async () => {
  const pullRequests: PullRequestRecord[] = [openPr(42, "Retry uploads on 5xx responses", [7])];
  let callCount = 0;
  const { deps } = collectingDeps({ driver: { async run() { callCount += 1; return okResult(); } } });
  const input = passingInput({ maxIterations: 1.5, reviewContext: baseReviewContext({ pullRequests }) });
  const result = await runIterateLoop(input, deps);

  assert.equal(result.outcome, "abandon");
  assert.equal(result.finalDecision.abandonReason, "max_iterations_reached");
  assert.equal(callCount, 1, "1.5 truncates to 1, not 2 -- the driver must not run a fractional extra iteration");
  assert.equal(result.iterationsUsed, 1);
});

test("abandon (cost_ceiling_reached): a maxTurns budget breach stops the loop even with iterations still available", async () => {
  const pullRequests: PullRequestRecord[] = [openPr(42, "Retry uploads on 5xx responses", [7])];
  const { deps } = collectingDeps({ driver: driverReturning(okResult(["src/upload.ts"], 50)) });
  const input = passingInput({ maxIterations: 10, budget: { maxTurns: 20 }, reviewContext: baseReviewContext({ pullRequests }) });
  const result = await runIterateLoop(input, deps);

  assert.equal(result.outcome, "abandon");
  assert.equal(result.finalDecision.abandonReason, "cost_ceiling_reached");
  assert.equal(result.iterationsUsed, 1);
  assert.deepEqual(result.budgetBreaches, ["turns"]);
  assert.equal(result.finalMeterTotals.turns, 50);
});

test("abandon (cost_ceiling_reached): a maxCostUsd budget breach reports costUsd as the breached axis", async () => {
  const pullRequests: PullRequestRecord[] = [openPr(42, "Retry uploads on 5xx responses", [7])];
  const { deps } = collectingDeps({ driver: driverReturning({ ok: true, changedFiles: ["src/upload.ts"], summary: "x", turnsUsed: 1, costUsd: 6 }) });
  const input = passingInput({ maxIterations: 10, budget: { maxCostUsd: 5 }, reviewContext: baseReviewContext({ pullRequests }) });
  const result = await runIterateLoop(input, deps);

  assert.equal(result.outcome, "abandon");
  assert.equal(result.finalDecision.abandonReason, "cost_ceiling_reached");
  assert.deepEqual(result.budgetBreaches, ["costUsd"]);
  assert.equal(result.finalMeterTotals.costUsd, 6);
});

test("abandon (cost_ceiling_reached): a maxWallClockMs budget breach uses the real injected clock, not a fabricated duration", async () => {
  const pullRequests: PullRequestRecord[] = [openPr(42, "Retry uploads on 5xx responses", [7])];
  let call = 0;
  const timestamps = [1_000, 1_000 + 90_000]; // 90s elapsed on the one iteration
  const { deps } = collectingDeps({ driver: driverReturning(okResult(["src/upload.ts"], 1)) });
  const input = passingInput({ maxIterations: 10, budget: { maxWallClockMs: 60_000 }, reviewContext: baseReviewContext({ pullRequests }) });
  const result = await runIterateLoop(input, {
    ...deps,
    nowMs: () => timestamps[call++] ?? timestamps[timestamps.length - 1]!,
  });

  assert.equal(result.outcome, "abandon");
  assert.equal(result.finalDecision.abandonReason, "cost_ceiling_reached");
  assert.deepEqual(result.budgetBreaches, ["wallClockMs"]);
  assert.equal(result.finalMeterTotals.wallClockMs, 90_000);
});

test("continue: budget omitted never trips the cost ceiling, regardless of turns/cost spent", async () => {
  const { deps } = collectingDeps({ driver: driverReturning({ ok: true, changedFiles: ["src/upload.ts"], summary: "x", turnsUsed: 1_000_000, costUsd: 999 }) });
  const result = await runIterateLoop(passingInput({ budget: undefined }), deps);
  assert.equal(result.outcome, "handoff");
  assert.deepEqual(result.budgetBreaches, []);
});

test("finalMeterTotals.tokens is always an honest 0 -- no driver reports a real token count", async () => {
  const { deps } = collectingDeps({ driver: driverReturning(okResult()) });
  const result = await runIterateLoop(passingInput(), deps);
  assert.equal(result.finalMeterTotals.tokens, 0);
});

test("immediate abandon: finalMeterTotals/budgetBreaches are the honest zero/empty shape when the driver never ran", async () => {
  const { deps } = collectingDeps();
  const result = await runIterateLoop(baseInput({ maxIterations: 0 }), deps);
  assert.deepEqual(result.finalMeterTotals, { tokens: 0, turns: 0, wallClockMs: 0, costUsd: 0 });
  assert.deepEqual(result.budgetBreaches, []);
});

test("REGRESSION: a passing self-review on the same iteration that breaches budget still hands off (pass wins the precedence ladder)", async () => {
  const { deps } = collectingDeps({ driver: driverReturning(okResult(["src/upload.ts"], 999)) });
  const result = await runIterateLoop(passingInput({ maxIterations: 1, budget: { maxTurns: 1 } }), deps);
  assert.equal(result.outcome, "handoff");
});

test("abandon (rejection_signaled): wins even over a self-review that would otherwise cleanly pass", async () => {
  const { deps, events } = collectingDeps({ driver: driverReturning(okResult()) });
  const result = await runIterateLoop(passingInput({ rejectionSignaled: true }), deps);

  assert.equal(result.outcome, "abandon");
  assert.equal(result.finalDecision.abandonReason, "rejection_signaled");
  assert.equal(result.iterationsUsed, 1, "the driver still runs once before the policy is consulted -- rejection can arrive mid-loop, not just up front");
  assert.equal(events.filter((event) => event.eventType === "attempt_aborted").length, 1);
});

test("abandon (self_review_ambiguous): a driver run that completes but reports ok:false, with an error message set", async () => {
  const { deps } = collectingDeps({ driver: driverReturning({ ok: false, changedFiles: [], summary: "", error: "worktree corrupted" }) });
  const result = await runIterateLoop(passingInput({ maxIterations: 1 }), deps);

  assert.equal(result.outcome, "abandon");
  assert.equal(result.finalDecision.abandonReason, "self_review_ambiguous");
  assert.match(result.finalDecision.reason, /worktree corrupted/);
});

test("abandon (self_review_ambiguous): a driver run that reports ok:false with NO error message still formats a reason", async () => {
  const { deps } = collectingDeps({ driver: driverReturning({ ok: false, changedFiles: [], summary: "" }) });
  const result = await runIterateLoop(passingInput({ maxIterations: 1 }), deps);

  assert.equal(result.finalDecision.abandonReason, "self_review_ambiguous");
  assert.match(result.finalDecision.reason, /driver run did not complete successfully\./);
});

test("abandon (self_review_ambiguous): the driver throwing a real Error is normalized, not left to propagate", async () => {
  const { deps } = collectingDeps({
    driver: { async run() { throw new Error("subprocess crashed"); } },
  });
  const result = await runIterateLoop(passingInput({ maxIterations: 1 }), deps);

  assert.equal(result.finalDecision.abandonReason, "self_review_ambiguous");
  assert.match(result.finalDecision.reason, /driver_threw: subprocess crashed/);
});

test("abandon (self_review_ambiguous): the driver throwing a non-Error value still formats a reason via String(error)", async () => {
  const { deps } = collectingDeps({
    driver: { async run() { throw "disk full"; } },
  });
  const result = await runIterateLoop(passingInput({ maxIterations: 1 }), deps);

  assert.match(result.finalDecision.reason, /driver_threw: disk full/);
});

test("abandon (self_review_ambiguous): runSelfReview itself throwing a real Error is caught, not left to propagate", async () => {
  const { deps } = collectingDeps({
    driver: driverReturning(okResult()),
    runSlopAssessment: () => {
      throw new Error("slop assessment blew up");
    },
  });
  const result = await runIterateLoop(passingInput({ maxIterations: 1 }), deps);

  assert.equal(result.finalDecision.abandonReason, "self_review_ambiguous");
  assert.match(result.finalDecision.reason, /self_review_error: slop assessment blew up/);
});

test("abandon (self_review_ambiguous): runSelfReview throwing a non-Error value still formats a reason via String(error)", async () => {
  const { deps } = collectingDeps({
    driver: driverReturning(okResult()),
    runSlopAssessment: () => {
      throw "synthetic non-Error failure";
    },
  });
  const result = await runIterateLoop(passingInput({ maxIterations: 1 }), deps);

  assert.match(result.finalDecision.reason, /self_review_error: synthetic non-Error failure/);
});

test("a logging failure never crashes the loop or alters its decision", async () => {
  const { deps } = collectingDeps({
    driver: driverReturning(okResult()),
    appendAttemptLogEvent: () => {
      throw new Error("ledger unavailable");
    },
  });
  const result = await runIterateLoop(passingInput(), deps);

  assert.equal(result.outcome, "handoff", "the tool call is still decided correctly even though every audit write failed");
});
