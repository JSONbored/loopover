// Opt-in structured finding-severity calibration signal (#1955 calibration family).
//
// This module is the pure engine half of finding-severity calibration. The hosted review stack decides whether a
// repo is currently opted in from its resolved `.loopover.yml`/private config; the miner replay harness can then
// ingest only the structured per-severity-tier finding fields exposed here — how many findings the review raised at
// each severity tier (blocker/warning/advisory/nit) and how many of those were subsequently CONFIRMED (a true
// positive that pointed at a real, acted-on issue). No raw review text, secrets, trust values, rewards, rankings, or
// maintainer evidence are represented in this type surface.
//
// The score measures how well-CALIBRATED a review's severity assignments are: a confirmed blocker is worth much more
// than a confirmed nit, and a review that raises blockers which are then dismissed (false positives at the tier that
// most interrupts a maintainer) calibrates poorly. It composes with the objective-anchor and pairwise-judge signals
// exactly like the other calibration signals in this family.

import type { ObjectiveAnchorScore } from "./objective-anchor.js";
import type { PairwiseCalibrationScore } from "./pairwise-calibration.js";

export type FindingSeverityTier = "blocker" | "warning" | "advisory" | "nit";

export type FindingSeverityCalibrationManifest = {
  miner?: {
    calibration?: {
      /** Explicit maintainer opt-in. Default false. */
      shareStructuredFindingSeverity?: unknown;
      /** Optional weight for the structured finding-severity signal when composed into a replay score. */
      structuredFindingSeverityWeight?: unknown;
    } | null;
  } | null;
  calibration?: {
    /** Back-compat/future-friendly alias, still explicit and default-off. */
    shareStructuredFindingSeverity?: unknown;
    structuredFindingSeverityWeight?: unknown;
  } | null;
};

export type FindingSeverityCalibrationConfig = {
  shareStructuredFindingSeverity: boolean;
  structuredFindingSeverityWeight: number;
  warnings: string[];
};

export type FindingSeverityTierInput = {
  tier: FindingSeverityTier | string;
  /** Total findings the review raised at this tier. */
  total: number;
  /** How many of those were subsequently confirmed (true positives). Clamped to `[0, total]`. */
  confirmed?: number | undefined;
  /** Optional 0..1 confidence in the confirmation labelling for this tier. */
  confidence?: number | undefined;
};

export type FindingSeverityCalibrationSignalInput = {
  repoFullName: string;
  replayRunId: string;
  reviewRunId: string;
  optedIn: boolean;
  observedAt?: string | undefined;
  tiers: readonly FindingSeverityTierInput[];
};

export type FindingSeverityTierSignal = {
  tier: FindingSeverityTier;
  total: number;
  confirmed: number;
  confirmationRate: number;
  weight: number;
  score: number;
};

export type FindingSeverityCalibrationSignal = {
  repoFullName: string;
  replayRunId: string;
  reviewRunId: string;
  observedAt: string | null;
  tiers: FindingSeverityTierSignal[];
  score: number;
};

export type FindingSeverityCalibrationIngestion = {
  accepted: FindingSeverityCalibrationSignal[];
  rejected: Array<{
    repoFullName: string;
    replayRunId: string;
    reviewRunId: string;
    reason: "not_opted_in" | "empty_tiers" | "invalid_repo" | "invalid_run_id";
  }>;
};

export type FindingSeverityCalibrationWeights = {
  objectiveAnchor?: number | undefined;
  pairwiseJudge?: number | undefined;
  structuredFindingSeverity?: number | undefined;
};

export type FindingSeverityCompositeCalibrationScore = {
  compositeScore: number;
  objectiveAnchorScore: number;
  pairwiseJudgeScore: number | null;
  structuredFindingSeverityScore: number | null;
  weights: {
    objectiveAnchor: number;
    pairwiseJudge: number;
    structuredFindingSeverity: number;
  };
  audit: {
    contributingRepos: Array<{
      repoFullName: string;
      replayRunId: string;
      reviewRunId: string;
      observedAt: string | null;
      score: number;
      tiers: FindingSeverityTierSignal[];
    }>;
    rejected: FindingSeverityCalibrationIngestion["rejected"];
  };
};

const TIER_ORDER: FindingSeverityTier[] = ["blocker", "warning", "advisory", "nit"];

// Severity weight for scoring: a confirmed blocker is worth far more than a confirmed nit, and a dismissed blocker
// (false positive at the most disruptive tier) is penalized far more than a dismissed nit.
const TIER_WEIGHT: Record<FindingSeverityTier, number> = {
  blocker: 1,
  warning: 0.6,
  advisory: 0.3,
  nit: 0.1,
};

const DEFAULT_STRUCTURED_FINDING_SEVERITY_WEIGHT = 0.2;
const DEFAULT_COMPOSITE_WEIGHTS = {
  objectiveAnchor: 0.45,
  pairwiseJudge: 0.35,
  structuredFindingSeverity: 0.2,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function finiteNonNegativeInt(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
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

function clampConfidence(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normalizeTier(value: string): FindingSeverityTier | null {
  const normalized = value.trim().toLowerCase().replace(/[_\s-]+/gu, "_");
  if (normalized === "block" || normalized === "blocked" || normalized === "blocking" || normalized === "critical") {
    return "blocker";
  }
  if (normalized === "warn" || normalized === "warnings" || normalized === "major") return "warning";
  if (
    normalized === "info" ||
    normalized === "informational" ||
    normalized === "suggestion" ||
    normalized === "advice"
  ) {
    return "advisory";
  }
  if (normalized === "nitpick" || normalized === "minor" || normalized === "trivial" || normalized === "style") {
    return "nit";
  }
  if ((TIER_ORDER as string[]).includes(normalized)) return normalized as FindingSeverityTier;
  return null;
}

/**
 * Aggregate raw per-tier inputs into one normalized signal per tier: sum totals, sum confirmed (each entry's
 * confirmed is clamped to its own total), drop tiers whose total is zero, and derive the confirmation rate and the
 * severity-weighted per-tier score. Confidence discounts the effective confirmation the same way it does for the
 * gate-verdict signal. Deterministic and returned in TIER_ORDER.
 */
function normalizeTiers(tiers: readonly FindingSeverityTierInput[]): FindingSeverityTierSignal[] {
  const byTier = new Map<FindingSeverityTier, { total: number; confirmed: number }>();
  for (const item of tiers) {
    const tier = normalizeTier(item.tier);
    if (!tier) continue;
    const total = finiteNonNegativeInt(item.total);
    if (total <= 0) continue;
    const confirmedRaw = Math.min(total, finiteNonNegativeInt(item.confirmed));
    // A low confidence in the confirmation labelling shrinks the credited confirmations toward zero (never above the
    // raw count), so an unverified "all confirmed" claim cannot inflate the calibration score.
    const confirmed = Math.min(total, Math.round(confirmedRaw * clampConfidence(item.confidence)));
    const existing = byTier.get(tier);
    if (existing) {
      existing.total += total;
      existing.confirmed += confirmed;
    } else {
      byTier.set(tier, { total, confirmed });
    }
  }
  return TIER_ORDER.flatMap((tier) => {
    const bucket = byTier.get(tier);
    if (!bucket) return [];
    const confirmed = Math.min(bucket.total, bucket.confirmed);
    const confirmationRate = roundScore(confirmed / bucket.total);
    return [
      {
        tier,
        total: bucket.total,
        confirmed,
        confirmationRate,
        weight: TIER_WEIGHT[tier],
        score: confirmationRate,
      },
    ];
  });
}

/**
 * The per-PR calibration score: the severity-and-volume-weighted mean of the per-tier confirmation rates, so a
 * confirmed blocker moves the score far more than a confirmed nit, and a tier with more findings carries more weight
 * than a tier with a single finding. Returns null when there is no weighted volume (which only happens for an empty
 * tier list, already rejected upstream).
 */
function scoreTiers(tiers: readonly FindingSeverityTierSignal[]): number | null {
  let weightedRate = 0;
  let weightSum = 0;
  for (const tier of tiers) {
    const weight = tier.weight * tier.total;
    weightedRate += weight * tier.confirmationRate;
    weightSum += weight;
  }
  if (weightSum <= 0) return null;
  return roundScore(weightedRate / weightSum);
}

function averageSignals(signals: readonly FindingSeverityCalibrationSignal[]): number | null {
  if (signals.length === 0) return null;
  return roundScore(signals.reduce((sum, signal) => sum + signal.score, 0) / signals.length);
}

function isFindingSeverityCalibrationIngestion(value: unknown): value is FindingSeverityCalibrationIngestion {
  return isRecord(value) && Array.isArray(value.accepted) && Array.isArray(value.rejected);
}

function sanitizeFindingSeverityCalibrationIngestion(
  ingestion: FindingSeverityCalibrationIngestion,
): FindingSeverityCalibrationIngestion {
  const accepted: FindingSeverityCalibrationSignal[] = [];
  const rejected: FindingSeverityCalibrationIngestion["rejected"] = [];

  for (const signal of ingestion.accepted) {
    if (!isRecord(signal) || !Array.isArray(signal.tiers)) continue;
    const repoFullName = typeof signal.repoFullName === "string" ? normalizeRepoFullName(signal.repoFullName) : null;
    const replayRunId = typeof signal.replayRunId === "string" ? normalizeId(signal.replayRunId) : null;
    const reviewRunId = typeof signal.reviewRunId === "string" ? normalizeId(signal.reviewRunId) : null;
    if (!repoFullName || !replayRunId || !reviewRunId) continue;
    const tierInputs = signal.tiers.flatMap((tier): FindingSeverityTierInput[] => {
      if (
        !isRecord(tier) ||
        typeof tier.tier !== "string" ||
        typeof tier.total !== "number" ||
        typeof tier.confirmed !== "number"
      ) {
        return [];
      }
      return [
        {
          tier: tier.tier,
          total: tier.total,
          confirmed: tier.confirmed,
        },
      ];
    });
    const tiers = normalizeTiers(tierInputs);
    const score = scoreTiers(tiers);
    if (tiers.length === 0 || score === null) continue;
    accepted.push({
      repoFullName,
      replayRunId,
      reviewRunId,
      observedAt: typeof signal.observedAt === "string" ? normalizeObservedAt(signal.observedAt) : null,
      tiers,
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
      !["not_opted_in", "empty_tiers", "invalid_repo", "invalid_run_id"].includes(reason as string)
    ) {
      continue;
    }
    rejected.push({ repoFullName, replayRunId, reviewRunId, reason });
  }

  return { accepted, rejected };
}

function normalizeCompositeWeights(weights: FindingSeverityCalibrationWeights | undefined): {
  objectiveAnchor: number;
  pairwiseJudge: number;
  structuredFindingSeverity: number;
} {
  const raw = {
    objectiveAnchor: finiteNonNegative(weights?.objectiveAnchor, DEFAULT_COMPOSITE_WEIGHTS.objectiveAnchor),
    pairwiseJudge: finiteNonNegative(weights?.pairwiseJudge, DEFAULT_COMPOSITE_WEIGHTS.pairwiseJudge),
    structuredFindingSeverity: finiteNonNegative(
      weights?.structuredFindingSeverity,
      DEFAULT_COMPOSITE_WEIGHTS.structuredFindingSeverity,
    ),
  };
  const total = raw.objectiveAnchor + raw.pairwiseJudge + raw.structuredFindingSeverity;
  // Preserve explicitly-zeroed weights rather than substituting the defaults: a caller that zeroes every component
  // must reach the objective-only fallback in the composite scorer, not silently get the default 45/35/20 blend
  // (converges with reviewer-consensus-calibration.ts's already-correct behavior; #6170).
  if (total <= 0) return { objectiveAnchor: 0, pairwiseJudge: 0, structuredFindingSeverity: 0 };
  return {
    objectiveAnchor: raw.objectiveAnchor / total,
    pairwiseJudge: raw.pairwiseJudge / total,
    structuredFindingSeverity: raw.structuredFindingSeverity / total,
  };
}

function markdownSafe(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").replace(/[\\`*_[\]<>|]/gu, "\\$&");
}

function markdownList(values: readonly string[]): string {
  if (values.length === 0) return "- none";
  return values.map((value) => `- ${markdownSafe(value)}`).join("\n");
}

function renderTierRows(tiers: readonly FindingSeverityTierSignal[]): string {
  if (tiers.length === 0) return "| Tier | Total | Confirmed | Rate | Weight |\n| --- | ---: | ---: | ---: | ---: |\n";
  return [
    "| Tier | Total | Confirmed | Rate | Weight |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...tiers.map(
      (tier) =>
        `| ${markdownSafe(tier.tier)} | ${tier.total} | ${tier.confirmed} | ${tier.confirmationRate.toFixed(
          6,
        )} | ${tier.weight.toFixed(6)} |`,
    ),
  ].join("\n");
}

function renderContributingRepo(
  signal: FindingSeverityCompositeCalibrationScore["audit"]["contributingRepos"][number],
): string {
  return [
    `### ${markdownSafe(signal.repoFullName)}`,
    "",
    `- replayRunId: ${markdownSafe(signal.replayRunId)}`,
    `- reviewRunId: ${markdownSafe(signal.reviewRunId)}`,
    `- observedAt: ${signal.observedAt ? markdownSafe(signal.observedAt) : "n/a"}`,
    `- score: ${signal.score.toFixed(6)}`,
    "",
    renderTierRows(signal.tiers),
  ].join("\n");
}

function renderRejectedRow(row: FindingSeverityCalibrationIngestion["rejected"][number]): string {
  return `| ${markdownSafe(row.repoFullName)} | ${markdownSafe(row.replayRunId)} | ${markdownSafe(
    row.reviewRunId,
  )} | ${markdownSafe(row.reason)} |`;
}

/**
 * Resolve the explicit per-repo opt-in from a parsed `.loopover.yml`-style object. Default is opted out. The
 * preferred path is `miner.calibration.shareStructuredFindingSeverity`; `calibration.shareStructuredFindingSeverity`
 * is accepted as a narrow alias so private-config surfaces can place the field at top level if needed.
 */
export function resolveFindingSeverityCalibrationConfig(
  manifest: FindingSeverityCalibrationManifest | Record<string, unknown> | null | undefined,
): FindingSeverityCalibrationConfig {
  const warnings: string[] = [];
  const root = isRecord(manifest) ? manifest : {};
  const miner = isRecord(root.miner) ? root.miner : {};
  const minerCalibration = isRecord(miner.calibration) ? miner.calibration : {};
  const topCalibration = isRecord(root.calibration) ? root.calibration : {};
  const optInRaw =
    minerCalibration.shareStructuredFindingSeverity ?? topCalibration.shareStructuredFindingSeverity ?? undefined;
  const optIn = normalizeBoolean(optInRaw);
  if (optInRaw !== undefined && optIn === undefined) {
    warnings.push(
      "miner.calibration.shareStructuredFindingSeverity must be a boolean-like value; defaulting to false.",
    );
  }
  const weightRaw =
    minerCalibration.structuredFindingSeverityWeight ?? topCalibration.structuredFindingSeverityWeight;
  const weight = normalizeOptionalWeight(weightRaw);
  if (weightRaw !== undefined && weight === undefined) {
    warnings.push(
      "miner.calibration.structuredFindingSeverityWeight must be a non-negative finite number; using default.",
    );
  }
  return {
    shareStructuredFindingSeverity: optIn === true,
    structuredFindingSeverityWeight: weight ?? DEFAULT_STRUCTURED_FINDING_SEVERITY_WEIGHT,
    warnings,
  };
}

/**
 * Ingest only currently opted-in structured finding-severity signals. The opt-in check happens at ingestion time, so
 * a maintainer opt-out immediately prevents additional calibration rows from contributing even if older collected
 * data exists elsewhere.
 */
export function ingestFindingSeverityCalibrationSignals(
  signals: readonly FindingSeverityCalibrationSignalInput[],
): FindingSeverityCalibrationIngestion {
  const accepted: FindingSeverityCalibrationSignal[] = [];
  const rejected: FindingSeverityCalibrationIngestion["rejected"] = [];
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
    const tiers = normalizeTiers(signal.tiers);
    const score = scoreTiers(tiers);
    if (tiers.length === 0 || score === null) {
      rejected.push({ repoFullName, replayRunId, reviewRunId, reason: "empty_tiers" });
      continue;
    }
    accepted.push({
      repoFullName,
      replayRunId,
      reviewRunId,
      observedAt: normalizeObservedAt(signal.observedAt),
      tiers,
      score,
    });
  }
  return { accepted, rejected };
}

export function computeFindingSeverityCompositeCalibrationScore(input: {
  objectiveAnchor: number | ObjectiveAnchorScore;
  pairwise: number | PairwiseCalibrationScore | null;
  findingSeverity: FindingSeverityCalibrationIngestion | readonly FindingSeverityCalibrationSignalInput[];
  weights?: FindingSeverityCalibrationWeights | undefined;
}): FindingSeverityCompositeCalibrationScore {
  const ingestion = isFindingSeverityCalibrationIngestion(input.findingSeverity)
    ? sanitizeFindingSeverityCalibrationIngestion(input.findingSeverity)
    : ingestFindingSeverityCalibrationSignals(input.findingSeverity);
  const objectiveAnchorScore =
    typeof input.objectiveAnchor === "number" ? roundScore(input.objectiveAnchor) : input.objectiveAnchor.score;
  const pairwiseJudgeScore =
    input.pairwise === null
      ? null
      : typeof input.pairwise === "number"
        ? roundScore(input.pairwise)
        : input.pairwise.pairwiseJudgeScore;
  const structuredFindingSeverityScore = averageSignals(ingestion.accepted);
  const rawWeights = normalizeCompositeWeights(input.weights);
  const usableWeights = {
    objectiveAnchor: rawWeights.objectiveAnchor,
    pairwiseJudge: pairwiseJudgeScore === null ? 0 : rawWeights.pairwiseJudge,
    structuredFindingSeverity: structuredFindingSeverityScore === null ? 0 : rawWeights.structuredFindingSeverity,
  };
  const total =
    usableWeights.objectiveAnchor + usableWeights.pairwiseJudge + usableWeights.structuredFindingSeverity;
  const weights =
    total <= 0
      ? { objectiveAnchor: 1, pairwiseJudge: 0, structuredFindingSeverity: 0 }
      : {
          objectiveAnchor: usableWeights.objectiveAnchor / total,
          pairwiseJudge: usableWeights.pairwiseJudge / total,
          structuredFindingSeverity: usableWeights.structuredFindingSeverity / total,
        };
  const compositeScore = roundScore(
    objectiveAnchorScore * weights.objectiveAnchor +
      (pairwiseJudgeScore ?? 0) * weights.pairwiseJudge +
      (structuredFindingSeverityScore ?? 0) * weights.structuredFindingSeverity,
  );
  return {
    compositeScore,
    objectiveAnchorScore,
    pairwiseJudgeScore,
    structuredFindingSeverityScore,
    weights,
    audit: {
      contributingRepos: ingestion.accepted.map((signal) => ({
        repoFullName: signal.repoFullName,
        replayRunId: signal.replayRunId,
        reviewRunId: signal.reviewRunId,
        observedAt: signal.observedAt,
        score: signal.score,
        tiers: signal.tiers,
      })),
      rejected: ingestion.rejected,
    },
  };
}

/**
 * Render a deterministic, public-safe Markdown report for a structured finding-severity calibration result. The
 * report is local-run evidence: it includes aggregate scores, normalized weights, opted-in contributors, and rejected
 * rows, but never accepts or emits raw review text or private scoring fields.
 */
export function renderFindingSeverityCalibrationAuditMarkdown(
  result: FindingSeverityCompositeCalibrationScore,
): string {
  const lines = [
    "# Structured Finding-Severity Calibration",
    "",
    `Composite score: ${result.compositeScore.toFixed(6)}`,
    "",
    "## Component Scores",
    "",
    `- objectiveAnchor: ${result.objectiveAnchorScore.toFixed(6)}`,
    `- pairwiseJudge: ${result.pairwiseJudgeScore === null ? "n/a" : result.pairwiseJudgeScore.toFixed(6)}`,
    `- structuredFindingSeverity: ${
      result.structuredFindingSeverityScore === null ? "n/a" : result.structuredFindingSeverityScore.toFixed(6)
    }`,
    "",
    "## Effective Weights",
    "",
    `- objectiveAnchor: ${result.weights.objectiveAnchor.toFixed(6)}`,
    `- pairwiseJudge: ${result.weights.pairwiseJudge.toFixed(6)}`,
    `- structuredFindingSeverity: ${result.weights.structuredFindingSeverity.toFixed(6)}`,
    "",
    "## Contributing Repos",
    "",
    result.audit.contributingRepos.length === 0
      ? "_No opted-in structured finding-severity signals contributed._"
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
