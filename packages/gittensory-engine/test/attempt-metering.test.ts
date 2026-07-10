import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accumulateAttemptUsage,
  meterAttemptUsage,
  evaluateAttemptBudget,
  type AttemptUsage,
} from "../dist/index.js";

const u = (tokens: number, turns: number, wallClockMs: number, costUsd: number): AttemptUsage => ({
  tokens,
  turns,
  wallClockMs,
  costUsd,
});

test("accumulateAttemptUsage folds one increment into a running total without mutating inputs", () => {
  const total = u(100, 1, 500, 0.5);
  const result = accumulateAttemptUsage(total, u(50, 1, 250, 0.25));
  assert.deepEqual(result, u(150, 2, 750, 0.75)); // binary-exact cost values
  assert.deepEqual(total, u(100, 1, 500, 0.5)); // input unchanged
});

test("meterAttemptUsage sums a sequence of increments from zero", () => {
  const totals = meterAttemptUsage([u(100, 1, 500, 0.5), u(50, 1, 250, 0.25), u(25, 1, 100, 0.125)]);
  assert.deepEqual(totals, u(175, 3, 850, 0.875));
});

test("meterAttemptUsage of an empty sequence is all-zero", () => {
  assert.deepEqual(meterAttemptUsage([]), u(0, 0, 0, 0));
});

test("evaluateAttemptBudget: totals under every ceiling are within budget", () => {
  const v = evaluateAttemptBudget(u(100, 2, 500, 0.05), {
    maxTokens: 1000,
    maxTurns: 10,
    maxWallClockMs: 60000,
    maxCostUsd: 1,
  });
  assert.equal(v.withinBudget, true);
  assert.deepEqual(v.breaches, []);
});

test("evaluateAttemptBudget: a total exactly at a ceiling is a breach (>= boundary)", () => {
  const v = evaluateAttemptBudget(u(1000, 0, 0, 0), { maxTokens: 1000 });
  assert.equal(v.withinBudget, false);
  assert.deepEqual(v.breaches, ["tokens"]);
});

test("evaluateAttemptBudget: a total just under the ceiling is within budget", () => {
  const v = evaluateAttemptBudget(u(999, 0, 0, 0), { maxTokens: 1000 });
  assert.equal(v.withinBudget, true);
  assert.deepEqual(v.breaches, []);
});

test("evaluateAttemptBudget: each axis breaches independently", () => {
  assert.deepEqual(evaluateAttemptBudget(u(0, 5, 0, 0), { maxTurns: 5 }).breaches, ["turns"]);
  assert.deepEqual(evaluateAttemptBudget(u(0, 0, 60000, 0), { maxWallClockMs: 60000 }).breaches, ["wallClockMs"]);
  assert.deepEqual(evaluateAttemptBudget(u(0, 0, 0, 2), { maxCostUsd: 1.5 }).breaches, ["costUsd"]);
});

test("evaluateAttemptBudget: multiple axes over ceiling all surface, in order", () => {
  const v = evaluateAttemptBudget(u(2000, 20, 0, 0), { maxTokens: 1000, maxTurns: 10 });
  assert.equal(v.withinBudget, false);
  assert.deepEqual(v.breaches, ["tokens", "turns"]);
});

test("evaluateAttemptBudget: an omitted ceiling never breaches, even at huge totals", () => {
  const v = evaluateAttemptBudget(u(1e9, 1e6, 1e9, 1e6), {});
  assert.equal(v.withinBudget, true);
  assert.deepEqual(v.breaches, []);
  assert.equal(v.totals.tokens, 1e9); // verdict echoes the totals
});

test("evaluateAttemptBudget: a breach mid-attempt is detectable from accumulated totals", () => {
  const budget = { maxTurns: 3 };
  const steps = [u(10, 1, 100, 0), u(10, 1, 100, 0), u(10, 1, 100, 0)];
  let total = meterAttemptUsage([]);
  const withinAfterEachStep = steps.map((s) => {
    total = accumulateAttemptUsage(total, s);
    return evaluateAttemptBudget(total, budget).withinBudget;
  });
  assert.deepEqual(withinAfterEachStep, [true, true, false]); // breach at the 3rd turn
});
