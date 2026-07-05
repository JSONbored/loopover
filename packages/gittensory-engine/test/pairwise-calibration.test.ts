import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computePairwiseCalibrationScore,
  resolvePairwiseCalibrationSample,
  scoreObjectiveAnchor,
} from "../dist/index.js";

test("barrel: exports the pairwise calibration APIs (#3013)", () => {
  assert.equal(typeof resolvePairwiseCalibrationSample, "function");
  assert.equal(typeof computePairwiseCalibrationScore, "function");
});

test("resolvePairwiseCalibrationSample accepts a stable replay-better order swap", () => {
  const result = resolvePairwiseCalibrationSample({
    attempts: [{ replayFirst: "replay_better", revealedFirst: "revealed_better" }],
  });

  assert.deepEqual(result, {
    stable: true,
    exhausted: false,
    attemptsUsed: 1,
    maxAttempts: 1,
    verdict: "replay_better",
    pairwiseScore: 1,
  });
});

test("resolvePairwiseCalibrationSample accepts stable tie and revealed-better outcomes", () => {
  assert.equal(
    resolvePairwiseCalibrationSample({
      attempts: [{ replayFirst: "tie", revealedFirst: "tie" }],
    }).pairwiseScore,
    0.5,
  );
  assert.equal(
    resolvePairwiseCalibrationSample({
      attempts: [{ replayFirst: "revealed_better", revealedFirst: "replay_better" }],
    }).pairwiseScore,
    0,
  );
});

test("resolvePairwiseCalibrationSample discards order-flipping judgments", () => {
  const result = resolvePairwiseCalibrationSample({
    attempts: [{ replayFirst: "replay_better", revealedFirst: "replay_better" }],
  });

  assert.equal(result.stable, false);
  assert.equal(result.exhausted, true);
  assert.equal(result.verdict, "unstable");
  assert.equal(result.pairwiseScore, null);
});

test("resolvePairwiseCalibrationSample retries until the first stable non-incomparable verdict", () => {
  const result = resolvePairwiseCalibrationSample({
    attempts: [
      { replayFirst: "replay_better", revealedFirst: "replay_better" },
      { replayFirst: "incomparable", revealedFirst: "incomparable" },
      { replayFirst: "tie", revealedFirst: "tie" },
    ],
    maxAttempts: 3,
  });

  assert.equal(result.stable, true);
  assert.equal(result.exhausted, false);
  assert.equal(result.attemptsUsed, 3);
  assert.equal(result.verdict, "tie");
  assert.equal(result.pairwiseScore, 0.5);
});

test("resolvePairwiseCalibrationSample respects the retry cap boundary", () => {
  const result = resolvePairwiseCalibrationSample({
    attempts: [
      { replayFirst: "replay_better", revealedFirst: "replay_better" },
      { replayFirst: "tie", revealedFirst: "tie" },
    ],
    maxAttempts: 1,
  });

  assert.equal(result.stable, false);
  assert.equal(result.exhausted, true);
  assert.equal(result.attemptsUsed, 1);
  assert.equal(result.pairwiseScore, null);
});

test("computePairwiseCalibrationScore combines objective-anchor and stable pairwise scores", () => {
  const objectiveAnchor = scoreObjectiveAnchor({
    replayed: { paths: ["src/review/a.ts"], labels: ["feature"] },
    revealed: { paths: ["src/review/b.ts"], labels: ["feature"] },
  });
  const result = computePairwiseCalibrationScore({
    objectiveAnchor,
    samples: [
      { attempts: [{ replayFirst: "replay_better", revealedFirst: "revealed_better" }] },
      { attempts: [{ replayFirst: "tie", revealedFirst: "tie" }] },
    ],
    weights: { objectiveAnchor: 1, pairwiseJudge: 3 },
  });

  assert.equal(objectiveAnchor.score, 0.55);
  assert.equal(result.pairwiseJudgeScore, 0.75);
  assert.deepEqual(result.weights, { objectiveAnchor: 0.25, pairwiseJudge: 0.75 });
  assert.equal(result.compositeScore, 0.7);
  assert.deepEqual(result.metrics, {
    totalSamples: 2,
    stableSamples: 2,
    unstableSamples: 0,
    exhaustedSamples: 0,
    orderInstabilityRate: 0,
  });
});

test("computePairwiseCalibrationScore tracks order-instability rate and excludes unstable samples", () => {
  const result = computePairwiseCalibrationScore({
    objectiveAnchor: 0.25,
    samples: [
      { attempts: [{ replayFirst: "replay_better", revealedFirst: "revealed_better" }] },
      { attempts: [{ replayFirst: "replay_better", revealedFirst: "replay_better" }] },
      { attempts: [{ replayFirst: "revealed_better", revealedFirst: "replay_better" }] },
    ],
  });

  assert.equal(result.pairwiseJudgeScore, 0.5);
  assert.equal(result.compositeScore, 0.375);
  assert.deepEqual(result.metrics, {
    totalSamples: 3,
    stableSamples: 2,
    unstableSamples: 1,
    exhaustedSamples: 1,
    orderInstabilityRate: 0.333333,
  });
});

test("computePairwiseCalibrationScore falls back to objective-anchor when every pairwise sample is unstable", () => {
  const result = computePairwiseCalibrationScore({
    objectiveAnchor: 0.42,
    samples: [{ attempts: [{ replayFirst: "incomparable", revealedFirst: "incomparable" }] }],
  });

  assert.equal(result.pairwiseJudgeScore, null);
  assert.equal(result.compositeScore, 0.42);
});

test("computePairwiseCalibrationScore normalizes invalid weights without producing NaN", () => {
  const result = computePairwiseCalibrationScore({
    objectiveAnchor: 1,
    samples: [{ attempts: [{ replayFirst: "revealed_better", revealedFirst: "replay_better" }] }],
    weights: { objectiveAnchor: Number.NaN, pairwiseJudge: -1 },
  });

  assert.deepEqual(result.weights, { objectiveAnchor: 0.5, pairwiseJudge: 0.5 });
  assert.equal(result.compositeScore, 0.5);
});
