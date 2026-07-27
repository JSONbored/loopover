import assert from "node:assert/strict";
import { test } from "node:test";

import { buildProgressSnapshot, progressChanged, type LoopProgressState } from "../dist/index.js";

function running(overrides: Partial<LoopProgressState> = {}): LoopProgressState {
  return { iteration: 2, maxIterations: 5, phase: "coding", status: "running", ...overrides };
}

test("barrel: the public entrypoint re-exports the progress snapshot helpers (#4800)", () => {
  assert.equal(typeof buildProgressSnapshot, "function");
  assert.equal(typeof progressChanged, "function");
});

// #9323: maxIterations and percentComplete are displayed axes too, so progressChanged must push when either
// moves — the root vitest suite covers this, but engine source is also graded by this node:test suite under
// c8 (#9064). Without the same coverage here the two Codecov flags disagree on the new lines' hit state.
test("progressChanged: pushes when the iteration budget (maxIterations) is raised mid-run", () => {
  const prev = buildProgressSnapshot(running({ iteration: 2, maxIterations: 5, recentActivity: [{ step: "a" }] }));
  const next = buildProgressSnapshot(running({ iteration: 2, maxIterations: 10, recentActivity: [{ step: "a" }] }));
  // Same iteration/phase/status/activity, but the budget (and therefore the displayed percent) moved.
  assert.equal(next.maxIterations, 10);
  assert.equal(prev.percentComplete, 40);
  assert.equal(next.percentComplete, 20);
  assert.equal(progressChanged(prev, next), true);
});

test("progressChanged: pushes when only the derived percentComplete differs", () => {
  const prev = buildProgressSnapshot(running({ recentActivity: [{ step: "a" }] }));
  // maxIterations held equal so the maxIterations guard falls through to the percentComplete one.
  assert.equal(progressChanged(prev, { ...prev, percentComplete: (prev.percentComplete ?? 0) + 10 }), true);
});

test("progressChanged: does not push when every displayed axis (maxIterations/percentComplete included) holds", () => {
  const prev = buildProgressSnapshot(running({ recentActivity: [{ step: "a" }] }));
  const next = buildProgressSnapshot(running({ recentActivity: [{ step: "a" }] }));
  assert.equal(next.maxIterations, prev.maxIterations);
  assert.equal(next.percentComplete, prev.percentComplete);
  assert.equal(progressChanged(prev, next), false);
});
