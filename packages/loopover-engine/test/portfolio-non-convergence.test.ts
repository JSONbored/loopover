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

// #6173: this classifier feeds the same fail-closed ladder as governor/budget-cap.ts and
// governor/rate-limit.ts, which normalize every numeric input so malformed data can never decide a verdict in
// the wrong direction. Unnormalized, a NaN/negative count failed every `>=` and the trailing `> 0` check and
// quietly reported "converging" — the allow-equivalent verdict — and printed NaN into the reasons a maintainer
// reads. These mirror governor-budget-cap.test.ts's own malformed-input test.

test("#6173: a malformed threshold fails CLOSED — non_convergent, exactly as a malformed ceiling makes budget-cap read exceeded", () => {
  // budget-cap's convention: a non-finite limit clamps to 0, so `used >= limit` (0 >= 0) reads exceeded.
  // Here the same clamp makes `consecutiveFailures >= maxConsecutiveFailures` (0 >= 0) read non_convergent.
  const v = classifyPortfolioConvergence(
    { ...base, attempts: 1, consecutiveFailures: Number.NaN, reenqueues: -3 },
    { maxConsecutiveFailures: Number.NaN, maxReenqueues: Number.POSITIVE_INFINITY },
  );
  assert.equal(v.status, "non_convergent");
  assert.notEqual(v.status, "converging");
});

test("#6173: NaN/negative counts never reach the verdict or the reasons as NaN", () => {
  const v = classifyPortfolioConvergence({ ...base, attempts: 4, consecutiveFailures: Number.NaN, reenqueues: -2 });
  // NaN/-2 clamp to 0, so against the real defaults this is an honest "no streak" — not a fabricated one…
  assert.equal(v.status, "converging");
  // …and no NaN/negative ever leaks into the operator-facing text.
  assert.doesNotMatch(v.reasons.join(" "), /NaN|-\d/);
});

test("#6173: a non-finite attempts count reads converging, not a live streak", () => {
  // Unnormalized, `NaN <= 0` was false, so a NaN attempts count fell PAST the no-attempts guard and got
  // classified on the streak counters of an item that had never actually been attempted.
  const v = classifyPortfolioConvergence({ ...base, attempts: Number.NaN, consecutiveFailures: 5, reenqueues: 5 });
  assert.equal(v.status, "converging");
  assert.match(v.reasons.join(" "), /first attempt/i);
});

test("#6173: a fractional count is floored, matching rate-limit.ts's integer discipline", () => {
  const v = classifyPortfolioConvergence({ ...base, attempts: 3, consecutiveFailures: 3.9 });
  assert.equal(v.status, "non_convergent");
  assert.match(v.reasons.join(" "), /3 consecutive failures/);
});

test("#6173: legitimate input is unaffected by normalization", () => {
  assert.equal(classifyPortfolioConvergence({ ...base, attempts: 1, consecutiveFailures: 1 }).status, "stalled");
  assert.equal(classifyPortfolioConvergence({ ...base, attempts: 3, consecutiveFailures: 3 }).status, "non_convergent");
  assert.equal(classifyPortfolioConvergence({ ...base, attempts: 5 }).status, "converging");
});
