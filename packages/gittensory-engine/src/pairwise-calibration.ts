// Deterministic pairwise-judge calibration combiner (#3013).
//
// The model invocation itself belongs to the miner runtime. This engine module owns the pure part: interpret the
// two order-swapped judge outputs, discard unstable pairs, cap retries, expose instability metrics, and combine the
// surviving judge score with the objective-anchor score.

import type { ObjectiveAnchorScore } from "./objective-anchor.js";

export type PairwiseCalibrationVerdict = "replay_better" | "revealed_better" | "tie" | "incomparable";

export type PairwiseCalibrationAttempt = {
  /** Judge result when replayed output is shown first and revealed history second. */
  replayFirst: PairwiseCalibrationVerdict;
  /** Judge result when revealed history is shown first and replayed output second. */
  revealedFirst: PairwiseCalibrationVerdict;
};

export type PairwiseCalibrationWeights = {
  objectiveAnchor?: number | undefined;
  pairwiseJudge?: number | undefined;
};

export type PairwiseCalibrationResolvedSample = {
  stable: boolean;
  exhausted: boolean;
  attemptsUsed: number;
  maxAttempts: number;
  verdict: PairwiseCalibrationVerdict | "unstable";
  pairwiseScore: number | null;
};

export type PairwiseCalibrationScore = {
  compositeScore: number;
  objectiveAnchorScore: number;
  pairwiseJudgeScore: number | null;
  weights: { objectiveAnchor: number; pairwiseJudge: number };
  samples: PairwiseCalibrationResolvedSample[];
  metrics: {
    totalSamples: number;
    stableSamples: number;
    unstableSamples: number;
    exhaustedSamples: number;
    orderInstabilityRate: number;
  };
};

const DEFAULT_PAIRWISE_WEIGHTS = {
  objectiveAnchor: 0.5,
  pairwiseJudge: 0.5,
};

function finiteNonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function normalizePairwiseWeights(weights: PairwiseCalibrationWeights | undefined): {
  objectiveAnchor: number;
  pairwiseJudge: number;
} {
  const raw = {
    objectiveAnchor: finiteNonNegative(weights?.objectiveAnchor, DEFAULT_PAIRWISE_WEIGHTS.objectiveAnchor),
    pairwiseJudge: finiteNonNegative(weights?.pairwiseJudge, DEFAULT_PAIRWISE_WEIGHTS.pairwiseJudge),
  };
  const total = raw.objectiveAnchor + raw.pairwiseJudge;
  if (total <= 0) return DEFAULT_PAIRWISE_WEIGHTS;
  return {
    objectiveAnchor: raw.objectiveAnchor / total,
    pairwiseJudge: raw.pairwiseJudge / total,
  };
}

function invertedVerdict(verdict: PairwiseCalibrationVerdict): PairwiseCalibrationVerdict {
  if (verdict === "replay_better") return "revealed_better";
  if (verdict === "revealed_better") return "replay_better";
  return verdict;
}

function verdictScore(verdict: PairwiseCalibrationVerdict): number | null {
  if (verdict === "replay_better") return 1;
  if (verdict === "tie") return 0.5;
  if (verdict === "revealed_better") return 0;
  return null;
}

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000_000) / 1_000_000;
}

export function resolvePairwiseCalibrationSample(input: {
  attempts: readonly PairwiseCalibrationAttempt[];
  maxAttempts?: number | undefined;
}): PairwiseCalibrationResolvedSample {
  const requestedMaxAttempts = input.maxAttempts ?? input.attempts.length;
  const maxAttempts = Math.max(1, Math.floor(requestedMaxAttempts || 1));
  const attempts = input.attempts.slice(0, maxAttempts);
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]!;
    const stable = attempt.replayFirst === invertedVerdict(attempt.revealedFirst);
    if (stable) {
      const score = verdictScore(attempt.replayFirst);
      if (score !== null) {
        return {
          stable: true,
          exhausted: false,
          attemptsUsed: index + 1,
          maxAttempts,
          verdict: attempt.replayFirst,
          pairwiseScore: score,
        };
      }
    }
  }
  return {
    stable: false,
    exhausted: attempts.length >= maxAttempts,
    attemptsUsed: attempts.length,
    maxAttempts,
    verdict: "unstable",
    pairwiseScore: null,
  };
}

export function computePairwiseCalibrationScore(input: {
  objectiveAnchor: number | ObjectiveAnchorScore;
  samples: readonly { attempts: readonly PairwiseCalibrationAttempt[]; maxAttempts?: number | undefined }[];
  weights?: PairwiseCalibrationWeights | undefined;
}): PairwiseCalibrationScore {
  const objectiveAnchorScore =
    typeof input.objectiveAnchor === "number" ? roundScore(input.objectiveAnchor) : input.objectiveAnchor.score;
  const samples = input.samples.map(resolvePairwiseCalibrationSample);
  const stableScores = samples
    .map((sample) => sample.pairwiseScore)
    .filter((score): score is number => score !== null);
  const pairwiseJudgeScore =
    stableScores.length === 0 ? null : roundScore(stableScores.reduce((sum, score) => sum + score, 0) / stableScores.length);
  const weights = normalizePairwiseWeights(input.weights);
  const compositeScore =
    pairwiseJudgeScore === null
      ? objectiveAnchorScore
      : roundScore(objectiveAnchorScore * weights.objectiveAnchor + pairwiseJudgeScore * weights.pairwiseJudge);
  const unstableSamples = samples.filter((sample) => !sample.stable).length;
  const exhaustedSamples = samples.filter((sample) => sample.exhausted).length;
  return {
    compositeScore,
    objectiveAnchorScore,
    pairwiseJudgeScore,
    weights,
    samples,
    metrics: {
      totalSamples: samples.length,
      stableSamples: stableScores.length,
      unstableSamples,
      exhaustedSamples,
      orderInstabilityRate: samples.length === 0 ? 0 : roundScore(unstableSamples / samples.length),
    },
  };
}
