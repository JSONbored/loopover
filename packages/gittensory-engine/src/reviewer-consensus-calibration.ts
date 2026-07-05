// Opt-in structured reviewer-consensus calibration signal (#1955 calibration family).
//
// This module is the pure engine half of reviewer-consensus calibration. When a review runs more than one
// independent reviewer (multiple models, or the same model sampled multiple times), each reviewer casts a per-dimension
// verdict. This signal measures how much those reviewers AGREE per dimension: a high-agreement verdict is reliable,
// while a split verdict is unstable and the replay harness should weight it less. It is a companion to the pairwise
// judge (which measures order-stability of a single judge) at the level of independent reviewers.
//
// The hosted review stack decides whether a repo is currently opted in from its resolved `.gittensory.yml`/private
// config; the miner replay harness can then ingest only the structured per-dimension vote fields exposed here. No raw
// review text, secrets, trust values, rewards, rankings, or maintainer evidence is represented in this type surface.

import type { ObjectiveAnchorScore } from "./objective-anchor.js";
import type { PairwiseCalibrationScore } from "./pairwise-calibration.js";

export type ReviewerConsensusDimension =
  | "correctness"
  | "tests"
  | "security"
  | "maintainability"
  | "scope"
  | "freshness"
  | "ci"
  | "policy";

export type ReviewerConsensusVote = "pass" | "warn" | "fail";

export type ReviewerConsensusCalibrationManifest = {
  miner?: {
    calibration?: {
      /** Explicit maintainer opt-in. Default false. */
      shareStructuredReviewerConsensus?: unknown;
      /** Optional weight for the structured reviewer-consensus signal when composed into a replay score. */
      structuredReviewerConsensusWeight?: unknown;
    } | null;
  } | null;
  calibration?: {
    /** Back-compat/future-friendly alias, still explicit and default-off. */
    shareStructuredReviewerConsensus?: unknown;
    structuredReviewerConsensusWeight?: unknown;
  } | null;
};

export type ReviewerConsensusCalibrationConfig = {
  shareStructuredReviewerConsensus: boolean;
  structuredReviewerConsensusWeight: number;
  warnings: string[];
};

export type ReviewerConsensusDimensionInput = {
  dimension: ReviewerConsensusDimension | string;
  /** One verdict per independent reviewer. Unrecognized / abstention votes are dropped before agreement is measured. */
  votes: readonly (ReviewerConsensusVote | string)[];
};

export type ReviewerConsensusCalibrationSignalInput = {
  repoFullName: string;
  replayRunId: string;
  reviewRunId: string;
  optedIn: boolean;
  observedAt?: string | undefined;
  dimensions: readonly ReviewerConsensusDimensionInput[];
};

export type ReviewerConsensusDimensionSignal = {
  dimension: ReviewerConsensusDimension;
  voteCount: number;
  majorityOutcome: ReviewerConsensusVote;
  agreement: number;
  score: number;
};

export type ReviewerConsensusCalibrationSignal = {
  repoFullName: string;
  replayRunId: string;
  reviewRunId: string;
  observedAt: string | null;
  dimensions: ReviewerConsensusDimensionSignal[];
  score: number;
};

export type ReviewerConsensusCalibrationIngestion = {
  accepted: ReviewerConsensusCalibrationSignal[];
  rejected: Array<{
    repoFullName: string;
    replayRunId: string;
    reviewRunId: string;
    reason: "not_opted_in" | "empty_dimensions" | "invalid_repo" | "invalid_run_id";
  }>;
};

export type ReviewerConsensusCalibrationWeights = {
  objectiveAnchor?: number | undefined;
  pairwiseJudge?: number | undefined;
  structuredReviewerConsensus?: number | undefined;
};

export type ReviewerConsensusCompositeCalibrationScore = {
  compositeScore: number;
  objectiveAnchorScore: number;
  pairwiseJudgeScore: number | null;
  structuredReviewerConsensusScore: number | null;
  weights: {
    objectiveAnchor: number;
    pairwiseJudge: number;
    structuredReviewerConsensus: number;
  };
  audit: {
    contributingRepos: Array<{
      repoFullName: string;
      replayRunId: string;
      reviewRunId: string;
      observedAt: string | null;
      score: number;
      dimensions: ReviewerConsensusDimensionSignal[];
    }>;
    rejected: ReviewerConsensusCalibrationIngestion["rejected"];
  };
};

const DIMENSION_ORDER: ReviewerConsensusDimension[] = [
  "correctness",
  "tests",
  "security",
  "maintainability",
  "scope",
  "freshness",
  "ci",
  "policy",
];

// Tie-break order when two outcomes draw the plurality: prefer the more severe outcome, so a genuine split never
// rounds a real `fail`/`warn` signal down to `pass`.
const VOTE_SEVERITY: Record<ReviewerConsensusVote, number> = {
  fail: 2,
  warn: 1,
  pass: 0,
};

const DEFAULT_STRUCTURED_REVIEWER_CONSENSUS_WEIGHT = 0.2;
const DEFAULT_COMPOSITE_WEIGHTS = {
  objectiveAnchor: 0.45,
  pairwiseJudge: 0.35,
  structuredReviewerConsensus: 0.2,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000_000) / 1_000_000;
}

function normalizeRepoFullName(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(trimmed)) return null;
  return trimmed;
}

function normalizeId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160 || /[\r\n\0]/u.test(trimmed)) return null;
  return trimmed;
}

function normalizeObservedAt(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function normalizeOptionalWeight(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(number) || number < 0) return undefined;
  return number;
}

function normalizeDimension(value: string): ReviewerConsensusDimension | null {
  const normalized = value.trim().toLowerCase().replace(/[_\s-]+/gu, "_");
  if (normalized === "quality" || normalized === "code_quality") return "correctness";
  if (normalized === "test" || normalized === "coverage") return "tests";
  if (normalized === "maintenance") return "maintainability";
  if (normalized === "size" || normalized === "blast_radius") return "scope";
  if (normalized === "rebase" || normalized === "up_to_date") return "freshness";
  if (normalized === "workflow" || normalized === "checks") return "ci";
  if ((DIMENSION_ORDER as string[]).includes(normalized)) return normalized as ReviewerConsensusDimension;
  return null;
}

function normalizeVote(value: string): ReviewerConsensusVote | null {
  const normalized = value.trim().toLowerCase().replace(/[_\s-]+/gu, "_");
  if (normalized === "ok" || normalized === "success" || normalized === "passed" || normalized === "approve") {
    return "pass";
  }
  if (normalized === "warning" || normalized === "advisory" || normalized === "hold" || normalized === "comment") {
    return "warn";
  }
  if (normalized === "block" || normalized === "blocked" || normalized === "failed" || normalized === "reject") {
    return "fail";
  }
  if ((["pass", "warn", "fail"] as string[]).includes(normalized)) return normalized as ReviewerConsensusVote;
  return null;
}

/**
 * Reduce a dimension's independent votes to a consensus signal: drop unrecognized/abstention votes, tally the rest,
 * pick the plurality outcome (ties broken toward the more severe outcome), and derive the agreement fraction. A
 * dimension left with no definite votes is dropped.
 */
function summarizeDimensionVotes(
  votes: readonly (ReviewerConsensusVote | string)[],
): { majorityOutcome: ReviewerConsensusVote; voteCount: number; agreement: number } | null {
  const counts: Record<ReviewerConsensusVote, number> = { pass: 0, warn: 0, fail: 0 };
  let voteCount = 0;
  for (const raw of votes) {
    const vote = normalizeVote(raw);
    if (!vote) continue;
    counts[vote] += 1;
    voteCount += 1;
  }
  if (voteCount === 0) return null;
  let majorityOutcome: ReviewerConsensusVote = "pass";
  let best = -1;
  for (const vote of ["fail", "warn", "pass"] as ReviewerConsensusVote[]) {
    const count = counts[vote];
    // Strictly greater wins; on a tie the earlier (more severe, per the iteration order) outcome is kept.
    if (count > best || (count === best && VOTE_SEVERITY[vote] > VOTE_SEVERITY[majorityOutcome])) {
      best = count;
      majorityOutcome = vote;
    }
  }
  return { majorityOutcome, voteCount, agreement: roundScore(best / voteCount) };
}

function normalizeDimensions(
  dimensions: readonly ReviewerConsensusDimensionInput[],
): ReviewerConsensusDimensionSignal[] {
  const byDimension = new Map<ReviewerConsensusDimension, (ReviewerConsensusVote | string)[]>();
  for (const item of dimensions) {
    const dimension = normalizeDimension(item.dimension);
    if (!dimension) continue;
    const existing = byDimension.get(dimension);
    if (existing) {
      existing.push(...item.votes);
    } else {
      byDimension.set(dimension, [...item.votes]);
    }
  }
  return DIMENSION_ORDER.flatMap((dimension) => {
    const votes = byDimension.get(dimension);
    if (!votes) return [];
    const summary = summarizeDimensionVotes(votes);
    if (!summary) return [];
    return [
      {
        dimension,
        voteCount: summary.voteCount,
        majorityOutcome: summary.majorityOutcome,
        agreement: summary.agreement,
        score: summary.agreement,
      },
    ];
  });
}

/**
 * The per-PR consensus score: the vote-count-weighted mean of the per-dimension agreement fractions, so a dimension
 * with more reviewers carries more weight than one with a single reviewer. Returns null when no dimension carries a
 * definite vote (already rejected upstream).
 */
function scoreDimensions(dimensions: readonly ReviewerConsensusDimensionSignal[]): number | null {
  let weightedAgreement = 0;
  let voteSum = 0;
  for (const dimension of dimensions) {
    weightedAgreement += dimension.voteCount * dimension.agreement;
    voteSum += dimension.voteCount;
  }
  if (voteSum <= 0) return null;
  return roundScore(weightedAgreement / voteSum);
}

function averageSignals(signals: readonly ReviewerConsensusCalibrationSignal[]): number | null {
  if (signals.length === 0) return null;
  return roundScore(signals.reduce((sum, signal) => sum + signal.score, 0) / signals.length);
}

function isReviewerConsensusCalibrationIngestion(value: unknown): value is ReviewerConsensusCalibrationIngestion {
  return isRecord(value) && Array.isArray(value.accepted) && Array.isArray(value.rejected);
}

function sanitizeReviewerConsensusCalibrationIngestion(
  ingestion: ReviewerConsensusCalibrationIngestion,
): ReviewerConsensusCalibrationIngestion {
  const accepted: ReviewerConsensusCalibrationSignal[] = [];
  const rejected: ReviewerConsensusCalibrationIngestion["rejected"] = [];

  for (const signal of ingestion.accepted) {
    if (!isRecord(signal) || !Array.isArray(signal.dimensions)) continue;
    const repoFullName = typeof signal.repoFullName === "string" ? normalizeRepoFullName(signal.repoFullName) : null;
    const replayRunId = typeof signal.replayRunId === "string" ? normalizeId(signal.replayRunId) : null;
    const reviewRunId = typeof signal.reviewRunId === "string" ? normalizeId(signal.reviewRunId) : null;
    if (!repoFullName || !replayRunId || !reviewRunId) continue;
    const dimensions = signal.dimensions.flatMap((dimension): ReviewerConsensusDimensionSignal[] => {
      if (
        !isRecord(dimension) ||
        typeof dimension.dimension !== "string" ||
        typeof dimension.voteCount !== "number" ||
        typeof dimension.majorityOutcome !== "string" ||
        typeof dimension.agreement !== "number"
      ) {
        return [];
      }
      const normalizedDimension = normalizeDimension(dimension.dimension);
      const majorityOutcome = normalizeVote(dimension.majorityOutcome);
      if (
        !normalizedDimension ||
        !majorityOutcome ||
        !Number.isFinite(dimension.voteCount) ||
        dimension.voteCount <= 0 ||
        !Number.isInteger(dimension.voteCount) ||
        !Number.isFinite(dimension.agreement)
      ) {
        return [];
      }
      const agreement = roundScore(dimension.agreement);
      return [
        {
          dimension: normalizedDimension,
          voteCount: dimension.voteCount,
          majorityOutcome,
          agreement,
          score: agreement,
        },
      ];
    });
    const score = scoreDimensions(dimensions);
    if (dimensions.length === 0 || score === null) continue;
    accepted.push({
      repoFullName,
      replayRunId,
      reviewRunId,
      observedAt: typeof signal.observedAt === "string" ? normalizeObservedAt(signal.observedAt) : null,
      dimensions,
      score,
    });
  }

  for (const row of ingestion.rejected) {
    if (!isRecord(row)) continue;
    const repoFullName =
      typeof row.repoFullName === "string"
        ? (normalizeRepoFullName(row.repoFullName) ?? normalizeId(row.repoFullName))
        : null;
    const replayRunId = typeof row.replayRunId === "string" ? normalizeId(row.replayRunId) : null;
    const reviewRunId = typeof row.reviewRunId === "string" ? normalizeId(row.reviewRunId) : null;
    const reason = row.reason;
    if (
      !repoFullName ||
      !replayRunId ||
      !reviewRunId ||
      !["not_opted_in", "empty_dimensions", "invalid_repo", "invalid_run_id"].includes(reason as string)
    ) {
      continue;
    }
    rejected.push({ repoFullName, replayRunId, reviewRunId, reason });
  }

  return { accepted, rejected };
}

function normalizeCompositeWeights(weights: ReviewerConsensusCalibrationWeights | undefined): {
  objectiveAnchor: number;
  pairwiseJudge: number;
  structuredReviewerConsensus: number;
} {
  const raw = {
    objectiveAnchor: finiteNonNegative(weights?.objectiveAnchor, DEFAULT_COMPOSITE_WEIGHTS.objectiveAnchor),
    pairwiseJudge: finiteNonNegative(weights?.pairwiseJudge, DEFAULT_COMPOSITE_WEIGHTS.pairwiseJudge),
    structuredReviewerConsensus: finiteNonNegative(
      weights?.structuredReviewerConsensus,
      DEFAULT_COMPOSITE_WEIGHTS.structuredReviewerConsensus,
    ),
  };
  const total = raw.objectiveAnchor + raw.pairwiseJudge + raw.structuredReviewerConsensus;
  // Preserve explicitly-zeroed weights rather than substituting the defaults: a caller that zeroes every component
  // must reach the objective-only fallback in the composite scorer, not silently get the default 45/35/20 blend.
  if (total <= 0) return { objectiveAnchor: 0, pairwiseJudge: 0, structuredReviewerConsensus: 0 };
  return {
    objectiveAnchor: raw.objectiveAnchor / total,
    pairwiseJudge: raw.pairwiseJudge / total,
    structuredReviewerConsensus: raw.structuredReviewerConsensus / total,
  };
}

function markdownSafe(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").replace(/[\\`*_[\]<>|]/gu, "\\$&");
}

function markdownList(values: readonly string[]): string {
  if (values.length === 0) return "- none";
  return values.map((value) => `- ${markdownSafe(value)}`).join("\n");
}

function renderDimensionRows(dimensions: readonly ReviewerConsensusDimensionSignal[]): string {
  if (dimensions.length === 0) return "| Dimension | Votes | Majority | Agreement |\n| --- | ---: | --- | ---: |\n";
  return [
    "| Dimension | Votes | Majority | Agreement |",
    "| --- | ---: | --- | ---: |",
    ...dimensions.map(
      (dimension) =>
        `| ${markdownSafe(dimension.dimension)} | ${dimension.voteCount} | ${markdownSafe(
          dimension.majorityOutcome,
        )} | ${dimension.agreement.toFixed(6)} |`,
    ),
  ].join("\n");
}

function renderContributingRepo(
  signal: ReviewerConsensusCompositeCalibrationScore["audit"]["contributingRepos"][number],
): string {
  return [
    `### ${markdownSafe(signal.repoFullName)}`,
    "",
    `- replayRunId: ${markdownSafe(signal.replayRunId)}`,
    `- reviewRunId: ${markdownSafe(signal.reviewRunId)}`,
    `- observedAt: ${signal.observedAt ? markdownSafe(signal.observedAt) : "n/a"}`,
    `- score: ${signal.score.toFixed(6)}`,
    "",
    renderDimensionRows(signal.dimensions),
  ].join("\n");
}

function renderRejectedRow(row: ReviewerConsensusCalibrationIngestion["rejected"][number]): string {
  return `| ${markdownSafe(row.repoFullName)} | ${markdownSafe(row.replayRunId)} | ${markdownSafe(
    row.reviewRunId,
  )} | ${markdownSafe(row.reason)} |`;
}

/**
 * Resolve the explicit per-repo opt-in from a parsed `.gittensory.yml`-style object. Default is opted out. The
 * preferred path is `miner.calibration.shareStructuredReviewerConsensus`;
 * `calibration.shareStructuredReviewerConsensus` is accepted as a narrow alias so private-config surfaces can place
 * the field at top level if needed.
 */
export function resolveReviewerConsensusCalibrationConfig(
  manifest: ReviewerConsensusCalibrationManifest | Record<string, unknown> | null | undefined,
): ReviewerConsensusCalibrationConfig {
  const warnings: string[] = [];
  const root = isRecord(manifest) ? manifest : {};
  const miner = isRecord(root.miner) ? root.miner : {};
  const minerCalibration = isRecord(miner.calibration) ? miner.calibration : {};
  const topCalibration = isRecord(root.calibration) ? root.calibration : {};
  const optInRaw =
    minerCalibration.shareStructuredReviewerConsensus ?? topCalibration.shareStructuredReviewerConsensus ?? undefined;
  const optIn = normalizeBoolean(optInRaw);
  if (optInRaw !== undefined && optIn === undefined) {
    warnings.push(
      "miner.calibration.shareStructuredReviewerConsensus must be a boolean-like value; defaulting to false.",
    );
  }
  const weightRaw =
    minerCalibration.structuredReviewerConsensusWeight ?? topCalibration.structuredReviewerConsensusWeight;
  const weight = normalizeOptionalWeight(weightRaw);
  if (weightRaw !== undefined && weight === undefined) {
    warnings.push(
      "miner.calibration.structuredReviewerConsensusWeight must be a non-negative finite number; using default.",
    );
  }
  return {
    shareStructuredReviewerConsensus: optIn === true,
    structuredReviewerConsensusWeight: weight ?? DEFAULT_STRUCTURED_REVIEWER_CONSENSUS_WEIGHT,
    warnings,
  };
}

/**
 * Ingest only currently opted-in structured reviewer-consensus signals. The opt-in check happens at ingestion time, so
 * a maintainer opt-out immediately prevents additional calibration rows from contributing even if older collected data
 * exists elsewhere.
 */
export function ingestReviewerConsensusCalibrationSignals(
  signals: readonly ReviewerConsensusCalibrationSignalInput[],
): ReviewerConsensusCalibrationIngestion {
  const accepted: ReviewerConsensusCalibrationSignal[] = [];
  const rejected: ReviewerConsensusCalibrationIngestion["rejected"] = [];
  for (const signal of signals) {
    const repoFullName = normalizeRepoFullName(signal.repoFullName);
    const replayRunId = normalizeId(signal.replayRunId);
    const reviewRunId = normalizeId(signal.reviewRunId);
    if (!repoFullName) {
      rejected.push({
        repoFullName: signal.repoFullName,
        replayRunId: signal.replayRunId,
        reviewRunId: signal.reviewRunId,
        reason: "invalid_repo",
      });
      continue;
    }
    if (!replayRunId || !reviewRunId) {
      rejected.push({
        repoFullName,
        replayRunId: signal.replayRunId,
        reviewRunId: signal.reviewRunId,
        reason: "invalid_run_id",
      });
      continue;
    }
    if (!signal.optedIn) {
      rejected.push({ repoFullName, replayRunId, reviewRunId, reason: "not_opted_in" });
      continue;
    }
    const dimensions = normalizeDimensions(signal.dimensions);
    const score = scoreDimensions(dimensions);
    if (dimensions.length === 0 || score === null) {
      rejected.push({ repoFullName, replayRunId, reviewRunId, reason: "empty_dimensions" });
      continue;
    }
    accepted.push({
      repoFullName,
      replayRunId,
      reviewRunId,
      observedAt: normalizeObservedAt(signal.observedAt),
      dimensions,
      score,
    });
  }
  return { accepted, rejected };
}

export function computeReviewerConsensusCompositeCalibrationScore(input: {
  objectiveAnchor: number | ObjectiveAnchorScore;
  pairwise: number | PairwiseCalibrationScore | null;
  reviewerConsensus: ReviewerConsensusCalibrationIngestion | readonly ReviewerConsensusCalibrationSignalInput[];
  weights?: ReviewerConsensusCalibrationWeights | undefined;
}): ReviewerConsensusCompositeCalibrationScore {
  const ingestion = isReviewerConsensusCalibrationIngestion(input.reviewerConsensus)
    ? sanitizeReviewerConsensusCalibrationIngestion(input.reviewerConsensus)
    : ingestReviewerConsensusCalibrationSignals(input.reviewerConsensus);
  const objectiveAnchorScore =
    typeof input.objectiveAnchor === "number" ? roundScore(input.objectiveAnchor) : input.objectiveAnchor.score;
  const pairwiseJudgeScore =
    input.pairwise === null
      ? null
      : typeof input.pairwise === "number"
        ? roundScore(input.pairwise)
        : input.pairwise.pairwiseJudgeScore;
  const structuredReviewerConsensusScore = averageSignals(ingestion.accepted);
  const rawWeights = normalizeCompositeWeights(input.weights);
  const usableWeights = {
    objectiveAnchor: rawWeights.objectiveAnchor,
    pairwiseJudge: pairwiseJudgeScore === null ? 0 : rawWeights.pairwiseJudge,
    structuredReviewerConsensus:
      structuredReviewerConsensusScore === null ? 0 : rawWeights.structuredReviewerConsensus,
  };
  const total =
    usableWeights.objectiveAnchor + usableWeights.pairwiseJudge + usableWeights.structuredReviewerConsensus;
  const weights =
    total <= 0
      ? { objectiveAnchor: 1, pairwiseJudge: 0, structuredReviewerConsensus: 0 }
      : {
          objectiveAnchor: usableWeights.objectiveAnchor / total,
          pairwiseJudge: usableWeights.pairwiseJudge / total,
          structuredReviewerConsensus: usableWeights.structuredReviewerConsensus / total,
        };
  const compositeScore = roundScore(
    objectiveAnchorScore * weights.objectiveAnchor +
      (pairwiseJudgeScore ?? 0) * weights.pairwiseJudge +
      (structuredReviewerConsensusScore ?? 0) * weights.structuredReviewerConsensus,
  );
  return {
    compositeScore,
    objectiveAnchorScore,
    pairwiseJudgeScore,
    structuredReviewerConsensusScore,
    weights,
    audit: {
      contributingRepos: ingestion.accepted.map((signal) => ({
        repoFullName: signal.repoFullName,
        replayRunId: signal.replayRunId,
        reviewRunId: signal.reviewRunId,
        observedAt: signal.observedAt,
        score: signal.score,
        dimensions: signal.dimensions,
      })),
      rejected: ingestion.rejected,
    },
  };
}

/**
 * Render a deterministic, public-safe Markdown report for a structured reviewer-consensus calibration result. The
 * report is local-run evidence: it includes aggregate scores, normalized weights, opted-in contributors, and rejected
 * rows, but never accepts or emits raw review text or private scoring fields.
 */
export function renderReviewerConsensusCalibrationAuditMarkdown(
  result: ReviewerConsensusCompositeCalibrationScore,
): string {
  const lines = [
    "# Structured Reviewer-Consensus Calibration",
    "",
    `Composite score: ${result.compositeScore.toFixed(6)}`,
    "",
    "## Component Scores",
    "",
    `- objectiveAnchor: ${result.objectiveAnchorScore.toFixed(6)}`,
    `- pairwiseJudge: ${result.pairwiseJudgeScore === null ? "n/a" : result.pairwiseJudgeScore.toFixed(6)}`,
    `- structuredReviewerConsensus: ${
      result.structuredReviewerConsensusScore === null ? "n/a" : result.structuredReviewerConsensusScore.toFixed(6)
    }`,
    "",
    "## Effective Weights",
    "",
    `- objectiveAnchor: ${result.weights.objectiveAnchor.toFixed(6)}`,
    `- pairwiseJudge: ${result.weights.pairwiseJudge.toFixed(6)}`,
    `- structuredReviewerConsensus: ${result.weights.structuredReviewerConsensus.toFixed(6)}`,
    "",
    "## Contributing Repos",
    "",
    result.audit.contributingRepos.length === 0
      ? "_No opted-in structured reviewer-consensus signals contributed._"
      : result.audit.contributingRepos.map(renderContributingRepo).join("\n\n"),
    "",
    "## Rejected Rows",
    "",
  ];

  if (result.audit.rejected.length === 0) {
    lines.push("- none");
  } else {
    lines.push(
      "| Repo | Replay run | Review run | Reason |",
      "| --- | --- | --- | --- |",
      ...result.audit.rejected.map(renderRejectedRow),
    );
  }

  const contributingRepos = result.audit.contributingRepos.map((repo) => repo.repoFullName);
  lines.push("", "## Contributing Repo Summary", "", markdownList(contributingRepos));
  return `${lines.join("\n")}\n`;
}
