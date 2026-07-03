import { test } from "node:test";
import assert from "node:assert/strict";

import { computeOpportunityCompetition } from "../dist/index.js";

test("barrel: the public entrypoint re-exports the competition scorer API", () => {
  assert.equal(typeof computeOpportunityCompetition, "function");
});

test("computeOpportunityCompetition: zero clusters or zero open PRs yields 0", () => {
  assert.equal(computeOpportunityCompetition(0, 0), 0);
  assert.equal(computeOpportunityCompetition(0, 5), 0);
});

test("computeOpportunityCompetition: zero open PR volume still caps at 1 when clusters are present", () => {
  assert.equal(computeOpportunityCompetition(3, 0), 1);
});

test("computeOpportunityCompetition: scales high-risk clusters against open PR volume", () => {
  assert.equal(computeOpportunityCompetition(2, 4), 0.5);
  assert.equal(computeOpportunityCompetition(4, 4), 1);
  assert.equal(computeOpportunityCompetition(10, 4), 1);
});

test("computeOpportunityCompetition: non-finite and negative inputs degrade safely", () => {
  assert.equal(computeOpportunityCompetition(Number.NaN, 4), 0);
  assert.equal(computeOpportunityCompetition(2, Number.POSITIVE_INFINITY), 1);
  assert.equal(computeOpportunityCompetition(-3, 4), 0);
  assert.equal(computeOpportunityCompetition(2, -1), 1);
});
