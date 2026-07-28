import { test } from "node:test";
import assert from "node:assert/strict";

import { applyStepResult, buildPlanDag, markStepRunning, nextReadySteps, planProgress, validatePlanDag } from "../dist/index.js";

// The plan-DAG state machine moved into this package in #9537 so the Worker and the stdio MCP server
// could stop keeping two copies of it. Its behavioural tests moved with it: the engine uploads its
// own coverage, so a test that lives in the root suite leaves this file uncovered there no matter how
// thoroughly the root exercises it through the re-export.

const chain = () =>
  buildPlanDag([
    { id: "a", title: "close stale PR" },
    { id: "b", title: "land PR 2", dependsOn: ["a"] },
    { id: "c", title: "open direct PR", dependsOn: ["b"] },
  ]);

test("buildPlanDag normalizes defaults, clamps maxAttempts, and drops self/duplicate deps", () => {
  const plan = buildPlanDag([
    { id: "a", title: "one", maxAttempts: 99 },
    { id: "b", title: "two", maxAttempts: 0, dependsOn: ["a", "a", "b"], actionClass: "merge" },
  ]);
  assert.equal(plan.steps[0]!.status, "pending");
  assert.equal(plan.steps[0]!.attempts, 0);
  assert.equal(plan.steps[0]!.maxAttempts, 10, "clamped to the ceiling");
  assert.equal(plan.steps[1]!.maxAttempts, 1, "clamped to the floor");
  assert.deepEqual(plan.steps[1]!.dependsOn, ["a"], "self-dep and duplicate dropped");
  assert.equal(plan.steps[1]!.actionClass, "merge");
  assert.equal(plan.steps[0]!.actionClass, undefined, "omitted rather than set to undefined");
});

test("validatePlanDag accepts a well-formed chain", () => {
  assert.deepEqual(validatePlanDag(chain()), { valid: true, errors: [] });
});

test("validatePlanDag reports duplicate ids, unknown deps, and cycles", () => {
  const duplicate = validatePlanDag({ steps: [...chain().steps, chain().steps[0]!] });
  assert.equal(duplicate.valid, false);
  assert.ok(duplicate.errors.includes("duplicate step ids"));

  const dangling = validatePlanDag(buildPlanDag([{ id: "a", title: "one", dependsOn: ["ghost"] }]));
  assert.equal(dangling.valid, false);
  assert.ok(dangling.errors.some((error) => error.includes("unknown step ghost")));

  const cyclic = validatePlanDag({
    steps: [
      { id: "a", title: "one", dependsOn: ["b"], status: "pending", attempts: 0, maxAttempts: 1 },
      { id: "b", title: "two", dependsOn: ["a"], status: "pending", attempts: 0, maxAttempts: 1 },
    ],
  });
  assert.equal(cyclic.valid, false);
  assert.ok(cyclic.errors.includes("plan has a dependency cycle"));
});

test("nextReadySteps returns only steps whose dependencies are done", () => {
  const plan = chain();
  assert.deepEqual(nextReadySteps(plan).map((step) => step.id), ["a"]);
  const advanced = applyStepResult(plan, "a", { outcome: "completed" });
  assert.deepEqual(nextReadySteps(advanced).map((step) => step.id), ["b"]);
  // A skipped dependency counts as done: the harness chose not to run it, not to fail it.
  const skipped = applyStepResult(advanced, "b", { outcome: "skipped" });
  assert.deepEqual(nextReadySteps(skipped).map((step) => step.id), ["c"]);
});

test("markStepRunning only moves a pending step, and ignores an unknown id", () => {
  const plan = markStepRunning(chain(), "a");
  assert.equal(plan.steps[0]!.status, "running");
  assert.equal(markStepRunning(plan, "a").steps[0]!.status, "running", "already running is a no-op");
  assert.deepEqual(markStepRunning(plan, "ghost"), plan);
});

test("applyStepResult retries a failure until maxAttempts is exhausted, then stays failed", () => {
  const plan = buildPlanDag([{ id: "a", title: "one", maxAttempts: 2 }]);
  const first = applyStepResult(plan, "a", { outcome: "failed", error: "boom" });
  assert.equal(first.steps[0]!.status, "pending", "retried");
  assert.equal(first.steps[0]!.attempts, 1);
  assert.equal(first.steps[0]!.lastError, "boom");

  const second = applyStepResult(first, "a", { outcome: "failed" });
  assert.equal(second.steps[0]!.status, "failed", "attempts exhausted");
  assert.equal(second.steps[0]!.lastError, "step failed", "default message when none supplied");

  assert.deepEqual(applyStepResult(second, "a", { outcome: "completed" }), second, "terminal is terminal");
});

test("applyStepResult clears the last error on a terminal success or skip, and ignores an unknown id", () => {
  const plan = buildPlanDag([{ id: "a", title: "one" }]);
  assert.equal(applyStepResult(plan, "a", { outcome: "completed" }).steps[0]!.lastError, null);
  assert.equal(applyStepResult(plan, "a", { outcome: "skipped" }).steps[0]!.lastError, null);
  assert.deepEqual(applyStepResult(plan, "ghost", { outcome: "completed" }), plan);
  const done = applyStepResult(plan, "a", { outcome: "completed" });
  assert.deepEqual(applyStepResult(done, "a", { outcome: "failed" }), done, "a completed step is not retried");
});

test("planProgress aggregates counts and resolves the overall status", () => {
  assert.equal(planProgress({ steps: [] }).status, "pending", "an empty plan is pending, not completed");

  const plan = chain();
  assert.deepEqual(planProgress(plan), { total: 3, completed: 0, failed: 0, running: 0, pending: 3, skipped: 0, status: "pending" });
  assert.equal(planProgress(markStepRunning(plan, "a")).status, "running");

  const failed = applyStepResult(plan, "a", { outcome: "failed" });
  assert.equal(planProgress(failed).status, "failed", "failure outranks the running/pending states");

  const allDone = ["a", "b", "c"].reduce((acc, id) => applyStepResult(acc, id, { outcome: "completed" }), plan);
  assert.equal(planProgress(allDone).status, "completed");

  // Blocked: nothing running, nothing failed, and nothing whose dependencies are satisfied.
  const blocked = { steps: [{ id: "a", title: "one", dependsOn: ["ghost"], status: "pending" as const, attempts: 0, maxAttempts: 1 }] };
  assert.equal(planProgress(blocked).status, "blocked");
});
