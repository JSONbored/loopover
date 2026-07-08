import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyPortfolioConvergence,
  DEFAULT_PORTFOLIO_CONVERGENCE_THRESHOLDS,
  type PortfolioConvergenceInput,
} from "../dist/index.js";

const base: PortfolioConvergenceInput = {
  attempts: 0,
  consecutiveFailures: 0,
  reenqueues: 0,
  reachedDone: false,
};

test("zero attempts reads converging — a first attempt is not evidence of a stuck loop", () => {
  const v = classifyPortfolioConvergence({ ...base, attempts: 0 });
  assert.equal(v.status, "converging");
  assert.match(v.reasons.join(" "), /first attempt/i);
});

test("a single failure is stalled, never non_convergent", () => {
  const v = classifyPortfolioConvergence({ ...base, attempts: 1, consecutiveFailures: 1 });
  assert.equal(v.status, "stalled");
  assert.notEqual(v.status, "non_convergent");
});

test("a single re-enqueue below threshold is stalled (the reenqueues arm of the stalled OR)", () => {
  const v = classifyPortfolioConvergence({ ...base, attempts: 2, reenqueues: 1 });
  assert.equal(v.status, "stalled");
});

test("attempts in progress with no failure streak reads converging", () => {
  const v = classifyPortfolioConvergence({ ...base, attempts: 5, consecutiveFailures: 0, reenqueues: 0 });
  assert.equal(v.status, "converging");
  assert.match(v.reasons.join(" "), /no failure streak/i);
});

test("an item that reached done reads converging regardless of prior failures", () => {
  const v = classifyPortfolioConvergence({ attempts: 4, consecutiveFailures: 9, reenqueues: 9, reachedDone: true });
  assert.equal(v.status, "converging");
  assert.match(v.reasons.join(" "), /done/i);
});

test("a consecutive-failure streak at threshold reads non_convergent", () => {
  const v = classifyPortfolioConvergence({ ...base, attempts: 3, consecutiveFailures: 3 });
  assert.equal(v.status, "non_convergent");
  assert.match(v.reasons.join(" "), /consecutive failures/i);
});

test("repeated re-enqueue without reaching done reads non_convergent", () => {
  const v = classifyPortfolioConvergence({ ...base, attempts: 3, reenqueues: 3 });
  assert.equal(v.status, "non_convergent");
  assert.match(v.reasons.join(" "), /re-enqueued/i);
});

test("both streaks past threshold surface both reasons", () => {
  const v = classifyPortfolioConvergence({ ...base, attempts: 6, consecutiveFailures: 4, reenqueues: 5 });
  assert.equal(v.status, "non_convergent");
  assert.equal(v.reasons.length, 2);
});

test("thresholds are configurable — a stricter cap trips sooner, and the default is exported", () => {
  const strict = classifyPortfolioConvergence(
    { ...base, attempts: 1, consecutiveFailures: 1 },
    { maxConsecutiveFailures: 1, maxReenqueues: 1 },
  );
  assert.equal(strict.status, "non_convergent");
  assert.equal(DEFAULT_PORTFOLIO_CONVERGENCE_THRESHOLDS.maxConsecutiveFailures, 3);
});
