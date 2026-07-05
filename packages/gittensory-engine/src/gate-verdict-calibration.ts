// Opt-in structured gate-verdict calibration signal (#3015).
//
// This module is the pure engine half of cross-product calibration. The hosted review stack can decide whether a
// repo is currently opted in from its resolved `.gittensory.yml`/private config; the miner replay harness can then
// ingest only the structured per-dimension verdict fields exposed here. No raw review text, secrets, trust values,
// rewards, rankings, or maintainer evidence are represented in this type surface.

import type { ObjectiveAnchorScore } from "./objective-anchor.js";
import type { PairwiseCalibrationScore } from "./pairwise-calibration.js";

export type GateVerdictCalibrationDimension =
  | "correctness"
  | "tests"
  | "security"
  | "maintainability"
  | "scope"
  | "freshness"
  | "ci"
  | "policy";

export type GateVerdictCalibrationOutcome = "pass" | "warn" | "fail" | "unknown";

export type GateVerdictCalibrationManifest = {
  miner?: {
    calibration?: {
      /** Explicit maintainer opt-in. Default false. */
      shareStructuredGateVerdicts?: unknown;
      /** Optional weight for the structured gate-verdict signal when composed into a replay score. */
      structuredGateVerdictWeight?: unknown;
    } | null;
  } | null;
  calibration?: {
    /** Back-compat/future-friendly alias, still explicit and default-off. */
    shareStructuredGateVerdicts?: unknown;
    structuredGateVerdictWeight?: unknown;
  } | null;
};

export type GateVerdictCalibrationConfig = {
  shareStructuredGateVerdicts: boolean;
  structuredGateVerdictWeight: number;
  warnings: string[];
};

export type GateVerdictCalibrationDimensionInput = {
  dimension: GateVerdictCalibrationDimension | string;
  outcome: GateVerdictCalibrationOutcome | string;
  confidence?: number | undefined;
};

export type GateVerdictCalibrationSignalInput = {
  repoFullName: string;
  replayRunId: string;
  gateRunId: string;
  optedIn: boolean;
  observedAt?: string | undefined;
  dimensions: readonly GateVerdictCalibrationDimensionInput[];
};

export type GateVerdictCalibrationDimensionSignal = {
  dimension: GateVerdictCalibrationDimension;
  outcome: GateVerdictCalibrationOutcome;
  confidence: number;
  score: number;
};

export type GateVerdictCalibrationSignal = {
  repoFullName: string;
  replayRunId: string;
  gateRunId: string;
  observedAt: string | null;
  dimensions: GateVerdictCalibrationDimensionSignal[];
  score: number;
};

export type GateVerdictCalibrationIngestion = {
  accepted: GateVerdictCalibrationSignal[];
  rejected: Array<{
    repoFullName: string;
    replayRunId: string;
    gateRunId: string;
    reason: "not_opted_in" | "empty_dimensions" | "invalid_repo" | "invalid_run_id";
  }>;
};

export type GateVerdictCalibrationWeights = {
  objectiveAnchor?: number | undefined;
  pairwiseJudge?: number | undefined;
  structuredGateVerdict?: number | undefined;
};

export type GateVerdictCompositeCalibrationScore = {
  compositeScore: number;
  objectiveAnchorScore: number;
  pairwiseJudgeScore: number | null;
  structuredGateVerdictScore: number | null;
  weights: {
    objectiveAnchor: number;
    pairwiseJudge: number;
    structuredGateVerdict: number;
  };
  audit: {
    contributingRepos: Array<{
      repoFullName: string;
      replayRunId: string;
      gateRunId: string;
      observedAt: string | null;
      score: number;
      dimensions: GateVerdictCalibrationDimensionSignal[];
    }>;
    rejected: GateVerdictCalibrationIngestion["rejected"];
  };
};

const DIMENSION_ORDER: GateVerdictCalibrationDimension[] = [
  "correctness",
  "tests",
  "security",
  "maintainability",
  "scope",
  "freshness",
  "ci",
  "policy",
];

const OUTCOME_SCORE: Record<GateVerdictCalibrationOutcome, number> = {
  pass: 1,
  warn: 0.5,
  fail: 0,
  unknown: 0,
};

const DEFAULT_STRUCTURED_GATE_WEIGHT = 0.2;
const DEFAULT_COMPOSITE_WEIGHTS = {
  objectiveAnchor: 0.45,
  pairwiseJudge: 0.35,
  structuredGateVerdict: 0.2,
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

function normalizeDimension(value: string): GateVerdictCalibrationDimension | null {
  const normalized = value.trim().toLowerCase().replace(/[_\s-]+/gu, "_");
  if (normalized === "quality" || normalized === "code_quality") return "correctness";
  if (normalized === "test" || normalized === "coverage") return "tests";
  if (normalized === "maintainability" || normalized === "maintenance") return "maintainability";
  if (normalized === "size" || normalized === "blast_radius") return "scope";
  if (normalized === "rebase" || normalized === "up_to_date") return "freshness";
  if (normalized === "workflow" || normalized === "checks") return "ci";
  if ((DIMENSION_ORDER as string[]).includes(normalized)) return normalized as GateVerdictCalibrationDimension;
  return null;
}

function normalizeOutcome(value: string): GateVerdictCalibrationOutcome | null {
  const normalized = value.trim().toLowerCase().replace(/[_\s-]+/gu, "_");
  if (normalized === "ok" || normalized === "success" || normalized === "passed") return "pass";
  if (normalized === "warning" || normalized === "advisory" || normalized === "hold") return "warn";
  if (normalized === "block" || normalized === "blocked" || normalized === "failed") return "fail";
  if ((["pass", "warn", "fail", "unknown"] as string[]).includes(normalized)) {
    return normalized as GateVerdictCalibrationOutcome;
  }
  return null;
}

function clampConfidence(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normalizeDimensions(
  dimensions: readonly GateVerdictCalibrationDimensionInput[],
): GateVerdictCalibrationDimensionSignal[] {
  const byDimension = new Map<GateVerdictCalibrationDimension, GateVerdictCalibrationDimensionSignal>();
  for (const item of dimensions) {
    const dimension = normalizeDimension(item.dimension);
    const outcome = normalizeOutcome(item.outcome);
    if (!dimension || !outcome) continue;
    const confidence = clampConfidence(item.confidence);
    const score = roundScore(OUTCOME_SCORE[outcome] * confidence);
    const existing = byDimension.get(dimension);
    if (!existing || score < existing.score) {
      byDimension.set(dimension, { dimension, outcome, confidence, score });
    }
  }
  return DIMENSION_ORDER.flatMap((dimension) => {
    const signal = byDimension.get(dimension);
    return signal ? [signal] : [];
  });
}

function averageSignals(signals: readonly GateVerdictCalibrationSignal[]): number | null {
  if (signals.length === 0) return null;
  return roundScore(signals.reduce((sum, signal) => sum + signal.score, 0) / signals.length);
}

function isGateVerdictCalibrationIngestion(value: unknown): value is GateVerdictCalibrationIngestion {
  return isRecord(value) && Array.isArray(value.accepted) && Array.isArray(value.rejected);
}

function sanitizeGateVerdictCalibrationIngestion(
  ingestion: GateVerdictCalibrationIngestion,
): GateVerdictCalibrationIngestion {
  const accepted: GateVerdictCalibrationSignal[] = [];
  const rejected: GateVerdictCalibrationIngestion["rejected"] = [];

  for (const signal of ingestion.accepted) {
    if (!isRecord(signal) || !Array.isArray(signal.dimensions)) continue;
    const repoFullName = typeof signal.repoFullName === "string" ? normalizeRepoFullName(signal.repoFullName) : null;
    const replayRunId = typeof signal.replayRunId === "string" ? normalizeId(signal.replayRunId) : null;
    const gateRunId = typeof signal.gateRunId === "string" ? normalizeId(signal.gateRunId) : null;
    if (!repoFullName || !replayRunId || !gateRunId) continue;
    const dimensionInputs = signal.dimensions.flatMap((dimension): GateVerdictCalibrationDimensionInput[] => {
      if (!isRecord(dimension) || typeof dimension.dimension !== "string" || typeof dimension.outcome !== "string") {
        return [];
      }
      return [
        {
          dimension: dimension.dimension,
          outcome: dimension.outcome,
          confidence: typeof dimension.confidence === "number" ? dimension.confidence : undefined,
        },
      ];
    });
    const dimensions = normalizeDimensions(dimensionInputs);
    if (dimensions.length === 0) continue;
    accepted.push({
      repoFullName,
      replayRunId,
      gateRunId,
      observedAt: typeof signal.observedAt === "string" ? normalizeObservedAt(signal.observedAt) : null,
      dimensions,
      score: roundScore(dimensions.reduce((sum, item) => sum + item.score, 0) / dimensions.length),
    });
  }

  for (const row of ingestion.rejected) {
    if (!isRecord(row)) continue;
    const repoFullName = typeof row.repoFullName === "string" ? normalizeRepoFullName(row.repoFullName) : null;
    const replayRunId = typeof row.replayRunId === "string" ? normalizeId(row.replayRunId) : null;
    const gateRunId = typeof row.gateRunId === "string" ? normalizeId(row.gateRunId) : null;
    const reason = row.reason;
    if (
      !repoFullName ||
      !replayRunId ||
      !gateRunId ||
      !["not_opted_in", "empty_dimensions", "invalid_repo", "invalid_run_id"].includes(reason as string)
    ) {
      continue;
    }
    rejected.push({ repoFullName, replayRunId, gateRunId, reason });
  }

  return { accepted, rejected };
}

function normalizeCompositeWeights(weights: GateVerdictCalibrationWeights | undefined): {
  objectiveAnchor: number;
  pairwiseJudge: number;
  structuredGateVerdict: number;
} {
  const raw = {
    objectiveAnchor: finiteNonNegative(weights?.objectiveAnchor, DEFAULT_COMPOSITE_WEIGHTS.objectiveAnchor),
    pairwiseJudge: finiteNonNegative(weights?.pairwiseJudge, DEFAULT_COMPOSITE_WEIGHTS.pairwiseJudge),
    structuredGateVerdict: finiteNonNegative(
      weights?.structuredGateVerdict,
      DEFAULT_COMPOSITE_WEIGHTS.structuredGateVerdict,
    ),
  };
  const total = raw.objectiveAnchor + raw.pairwiseJudge + raw.structuredGateVerdict;
  if (total <= 0) return DEFAULT_COMPOSITE_WEIGHTS;
  return {
    objectiveAnchor: raw.objectiveAnchor / total,
    pairwiseJudge: raw.pairwiseJudge / total,
    structuredGateVerdict: raw.structuredGateVerdict / total,
  };
}

function markdownSafe(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").replace(/[\\`*_[\]<>|]/gu, "\\$&");
}

function markdownList(values: readonly string[]): string {
  if (values.length === 0) return "- none";
  return values.map((value) => `- ${markdownSafe(value)}`).join("\n");
}

function renderDimensionRows(dimensions: readonly GateVerdictCalibrationDimensionSignal[]): string {
  if (dimensions.length === 0) return "| Dimension | Outcome | Confidence | Score |\n| --- | --- | ---: | ---: |\n";
  return [
    "| Dimension | Outcome | Confidence | Score |",
    "| --- | --- | ---: | ---: |",
    ...dimensions.map(
      (dimension) =>
        `| ${markdownSafe(dimension.dimension)} | ${markdownSafe(dimension.outcome)} | ${dimension.confidence.toFixed(
          6,
        )} | ${dimension.score.toFixed(6)} |`,
    ),
  ].join("\n");
}

function renderContributingRepo(signal: GateVerdictCompositeCalibrationScore["audit"]["contributingRepos"][number]): string {
  return [
    `### ${markdownSafe(signal.repoFullName)}`,
    "",
    `- replayRunId: ${markdownSafe(signal.replayRunId)}`,
    `- gateRunId: ${markdownSafe(signal.gateRunId)}`,
    `- observedAt: ${signal.observedAt ? markdownSafe(signal.observedAt) : "n/a"}`,
    `- score: ${signal.score.toFixed(6)}`,
    "",
    renderDimensionRows(signal.dimensions),
  ].join("\n");
}

function renderRejectedRow(row: GateVerdictCalibrationIngestion["rejected"][number]): string {
  return `| ${markdownSafe(row.repoFullName)} | ${markdownSafe(row.replayRunId)} | ${markdownSafe(row.gateRunId)} | ${markdownSafe(
    row.reason,
  )} |`;
}

/**
 * Resolve the explicit per-repo opt-in from a parsed `.gittensory.yml`-style object. Default is opted out. The
 * preferred path is `miner.calibration.shareStructuredGateVerdicts`; `calibration.shareStructuredGateVerdicts` is
 * accepted as a narrow alias so private-config surfaces can place the field at top level if needed.
 */
export function resolveGateVerdictCalibrationConfig(
  manifest: GateVerdictCalibrationManifest | Record<string, unknown> | null | undefined,
): GateVerdictCalibrationConfig {
  const warnings: string[] = [];
  const root = isRecord(manifest) ? manifest : {};
  const miner = isRecord(root.miner) ? root.miner : {};
  const minerCalibration = isRecord(miner.calibration) ? miner.calibration : {};
  const topCalibration = isRecord(root.calibration) ? root.calibration : {};
  const optInRaw =
    minerCalibration.shareStructuredGateVerdicts ?? topCalibration.shareStructuredGateVerdicts ?? undefined;
  const optIn = normalizeBoolean(optInRaw);
  if (optInRaw !== undefined && optIn === undefined) {
    warnings.push("miner.calibration.shareStructuredGateVerdicts must be a boolean-like value; defaulting to false.");
  }
  const weightRaw = minerCalibration.structuredGateVerdictWeight ?? topCalibration.structuredGateVerdictWeight;
  const weight = normalizeOptionalWeight(weightRaw);
  if (weightRaw !== undefined && weight === undefined) {
    warnings.push("miner.calibration.structuredGateVerdictWeight must be a non-negative finite number; using default.");
  }
  return {
    shareStructuredGateVerdicts: optIn === true,
    structuredGateVerdictWeight: weight ?? DEFAULT_STRUCTURED_GATE_WEIGHT,
    warnings,
  };
}

/**
 * Ingest only currently opted-in structured gate-verdict signals. The opt-in check happens at ingestion time, so a
 * maintainer opt-out immediately prevents additional calibration rows from contributing even if older collected data
 * exists elsewhere.
 */
export function ingestGateVerdictCalibrationSignals(
  signals: readonly GateVerdictCalibrationSignalInput[],
): GateVerdictCalibrationIngestion {
  const accepted: GateVerdictCalibrationSignal[] = [];
  const rejected: GateVerdictCalibrationIngestion["rejected"] = [];
  for (const signal of signals) {
    const repoFullName = normalizeRepoFullName(signal.repoFullName);
    const replayRunId = normalizeId(signal.replayRunId);
    const gateRunId = normalizeId(signal.gateRunId);
    if (!repoFullName) {
      rejected.push({
        repoFullName: signal.repoFullName,
        replayRunId: signal.replayRunId,
        gateRunId: signal.gateRunId,
        reason: "invalid_repo",
      });
      continue;
    }
    if (!replayRunId || !gateRunId) {
      rejected.push({
        repoFullName,
        replayRunId: signal.replayRunId,
        gateRunId: signal.gateRunId,
        reason: "invalid_run_id",
      });
      continue;
    }
    if (!signal.optedIn) {
      rejected.push({ repoFullName, replayRunId, gateRunId, reason: "not_opted_in" });
      continue;
    }
    const dimensions = normalizeDimensions(signal.dimensions);
    if (dimensions.length === 0) {
      rejected.push({ repoFullName, replayRunId, gateRunId, reason: "empty_dimensions" });
      continue;
    }
    accepted.push({
      repoFullName,
      replayRunId,
      gateRunId,
      observedAt: normalizeObservedAt(signal.observedAt),
      dimensions,
      score: roundScore(dimensions.reduce((sum, item) => sum + item.score, 0) / dimensions.length),
    });
  }
  return { accepted, rejected };
}

export function computeGateVerdictCompositeCalibrationScore(input: {
  objectiveAnchor: number | ObjectiveAnchorScore;
  pairwise: number | PairwiseCalibrationScore | null;
  gateVerdicts: GateVerdictCalibrationIngestion | readonly GateVerdictCalibrationSignalInput[];
  weights?: GateVerdictCalibrationWeights | undefined;
}): GateVerdictCompositeCalibrationScore {
  const ingestion = isGateVerdictCalibrationIngestion(input.gateVerdicts)
    ? sanitizeGateVerdictCalibrationIngestion(input.gateVerdicts)
    : ingestGateVerdictCalibrationSignals(input.gateVerdicts);
  const objectiveAnchorScore =
    typeof input.objectiveAnchor === "number" ? roundScore(input.objectiveAnchor) : input.objectiveAnchor.score;
  const pairwiseJudgeScore =
    input.pairwise === null
      ? null
      : typeof input.pairwise === "number"
        ? roundScore(input.pairwise)
        : input.pairwise.pairwiseJudgeScore;
  const structuredGateVerdictScore = averageSignals(ingestion.accepted);
  const rawWeights = normalizeCompositeWeights(input.weights);
  const usableWeights = {
    objectiveAnchor: rawWeights.objectiveAnchor,
    pairwiseJudge: pairwiseJudgeScore === null ? 0 : rawWeights.pairwiseJudge,
    structuredGateVerdict: structuredGateVerdictScore === null ? 0 : rawWeights.structuredGateVerdict,
  };
  const total = usableWeights.objectiveAnchor + usableWeights.pairwiseJudge + usableWeights.structuredGateVerdict;
  const weights =
    total <= 0
      ? { objectiveAnchor: 1, pairwiseJudge: 0, structuredGateVerdict: 0 }
      : {
          objectiveAnchor: usableWeights.objectiveAnchor / total,
          pairwiseJudge: usableWeights.pairwiseJudge / total,
          structuredGateVerdict: usableWeights.structuredGateVerdict / total,
        };
  const compositeScore = roundScore(
    objectiveAnchorScore * weights.objectiveAnchor +
      (pairwiseJudgeScore ?? 0) * weights.pairwiseJudge +
      (structuredGateVerdictScore ?? 0) * weights.structuredGateVerdict,
  );
  return {
    compositeScore,
    objectiveAnchorScore,
    pairwiseJudgeScore,
    structuredGateVerdictScore,
    weights,
    audit: {
      contributingRepos: ingestion.accepted.map((signal) => ({
        repoFullName: signal.repoFullName,
        replayRunId: signal.replayRunId,
        gateRunId: signal.gateRunId,
        observedAt: signal.observedAt,
        score: signal.score,
        dimensions: signal.dimensions,
      })),
      rejected: ingestion.rejected,
    },
  };
}

/**
 * Render a deterministic, public-safe Markdown report for a structured gate-verdict calibration result. The report is
 * local-run evidence: it includes aggregate scores, normalized weights, opted-in contributors, and rejected rows, but
 * never accepts or emits raw review text or private scoring fields.
 */
export function renderGateVerdictCalibrationAuditMarkdown(result: GateVerdictCompositeCalibrationScore): string {
  const lines = [
    "# Structured Gate-Verdict Calibration",
    "",
    `Composite score: ${result.compositeScore.toFixed(6)}`,
    "",
    "## Component Scores",
    "",
    `- objectiveAnchor: ${result.objectiveAnchorScore.toFixed(6)}`,
    `- pairwiseJudge: ${result.pairwiseJudgeScore === null ? "n/a" : result.pairwiseJudgeScore.toFixed(6)}`,
    `- structuredGateVerdict: ${
      result.structuredGateVerdictScore === null ? "n/a" : result.structuredGateVerdictScore.toFixed(6)
    }`,
    "",
    "## Effective Weights",
    "",
    `- objectiveAnchor: ${result.weights.objectiveAnchor.toFixed(6)}`,
    `- pairwiseJudge: ${result.weights.pairwiseJudge.toFixed(6)}`,
    `- structuredGateVerdict: ${result.weights.structuredGateVerdict.toFixed(6)}`,
    "",
    "## Contributing Repos",
    "",
    result.audit.contributingRepos.length === 0
      ? "_No opted-in structured gate-verdict signals contributed._"
      : result.audit.contributingRepos.map(renderContributingRepo).join("\n\n"),
    "",
    "## Rejected Rows",
    "",
  ];

  if (result.audit.rejected.length === 0) {
    lines.push("- none");
  } else {
    lines.push(
      "| Repo | Replay run | Gate run | Reason |",
      "| --- | --- | --- | --- |",
      ...result.audit.rejected.map(renderRejectedRow),
    );
  }

  const contributingRepos = result.audit.contributingRepos.map((repo) => repo.repoFullName);
  lines.push("", "## Contributing Repo Summary", "", markdownList(contributingRepos));
  return `${lines.join("\n")}\n`;
}
