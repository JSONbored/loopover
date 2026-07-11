import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRunLoopHaltGovernorLedgerEvent,
  detectNonConvergence,
  evaluateBudgetCaps,
  evaluateRunLoopHalt,
} from "../dist/index.js";

test("barrel: the public entrypoint re-exports run-loop halt enforcement (#2347)", () => {
  assert.equal(typeof evaluateRunLoopHalt, "function");
  assert.equal(typeof detectNonConvergence, "function");
  assert.equal(typeof evaluateBudgetCaps, "function");
  assert.equal(typeof buildRunLoopHaltGovernorLedgerEvent, "function");
});

test("evaluateRunLoopHalt: either signal tripping halts the run", () => {
  const healthy = evaluateRunLoopHalt({
    runHalted: false,
    usage: { budgetSpent: 1, turnsTaken: 1, elapsedMs: 1_000 },
    limits: { budget: 100, turns: 5, elapsedMs: 60_000 },
    convergence: { attempts: 1, consecutiveFailures: 0, reenqueues: 0, reachedDone: false },
  });
  assert.equal(healthy.shouldHalt, false);

  const budgetHalt = evaluateRunLoopHalt({
    runHalted: false,
    usage: { budgetSpent: 100, turnsTaken: 1, elapsedMs: 1_000 },
    limits: { budget: 100, turns: 5, elapsedMs: 60_000 },
    convergence: { attempts: 1, consecutiveFailures: 0, reenqueues: 0, reachedDone: false },
  });
  assert.equal(budgetHalt.shouldHalt, true);

  assert.equal(
    detectNonConvergence({ attempts: 4, consecutiveFailures: 3, reenqueues: 0, reachedDone: false }).tripped,
    true,
  );
  assert.equal(evaluateBudgetCaps({ budgetSpent: 1, turnsTaken: 1, elapsedMs: 1_000 }, {
    budget: 100,
    turns: 5,
    elapsedMs: 60_000,
  }).verdict, "allowed");
});
