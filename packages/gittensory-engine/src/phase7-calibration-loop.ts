// Phase 7 historical-replay calibration loop (#3014).
//
// Pure engine contract for combining the historical-replay composite score with the passive pr_outcome signal,
// tracking calibration accuracy against the documented 62% baseline, and fail-closed gating of autonomy-level
// increases. The miner runtime owns scheduling replay runs and persisting ledger rows; this module owns the
// deterministic combine, freshness, threshold, and hold-reason logic.

import type { GateVerdictCompositeCalibrationScore } from "./gate-verdict-calibration.js";

/** Documented self-review calibration baseline from the Phase 7 roadmap (#2994). */
export const DOCUMENTED_CALIBRATION_BASELINE = 0.62;

export type CalibrationSignalSource = "historical_replay" | "pr_outcome";

export type ReplayHarnessStatus = "healthy" | "degraded" | "unavailable";

export type Phase7CalibrationManifest = {
  miner?: {
    calibration?: {
      /** Explicit opt-in for Phase 7 loop gating. Default false. */
      phase7LoopEnabled?: unknown;
      /** Combined calibration accuracy required before any autonomy-level increase. Default 0.70. */
      autonomyIncreaseMinAccuracy?: unknown;
      /** Maximum replay-run age before the harness is treated as stale. Default 168 hours. */
      replayFreshnessMaxAgeHours?: unknown;
      /** Weight for the historical-replay composite signal when composing the tracked metric. Default 0.5. */
      historicalReplayWeight?: unknown;
      /** Weight for the live pr_outcome signal when composing the tracked metric. Default 0.5. */
      prOutcomeWeight?: unknown;
      /** Minimum decided pr_outcome samples before the live signal contributes. Default 10. */
      prOutcomeMinDecided?: unknown;
    } | null;
  } | null;
  calibration?: {
    phase7LoopEnabled?: unknown;
    autonomyIncreaseMinAccuracy?: unknown;
    replayFreshnessMaxAgeHours?: unknown;
    historicalReplayWeight?: unknown;
    prOutcomeWeight?: unknown;
    prOutcomeMinDecided?: unknown;
  } | null;
};

export type Phase7CalibrationConfig = {
  phase7LoopEnabled: boolean;
  autonomyIncreaseMinAccuracy: number;
  replayFreshnessMaxAgeHours: number;
  historicalReplayWeight: number;
  prOutcomeWeight: number;
  prOutcomeMinDecided: number;
  warnings: string[];
};

export type PrOutcomeCalibrationInput = {
  mergeConfirmed: number;
  mergeFalse: number;
  closeConfirmed: number;
  closeFalse: number;
  hold?: number | undefined;
  observedAt?: string | undefined;
};

export type HistoricalReplayCalibrationInput = {
  compositeScore: number | GateVerdictCompositeCalibrationScore;
  replayRunId: string;
  observedAt: string;
  harnessStatus: ReplayHarnessStatus;
};

export type CalibrationSourceMetric = {
  source: CalibrationSignalSource;
  accuracy: number | null;
  sampleSize: number;
  observedAt: string | null;
  fresh: boolean;
  replayRunId?: string | undefined;
  harnessStatus?: ReplayHarnessStatus | undefined;
};

export type Phase7CalibrationLoopResult = {
  enabled: boolean;
  baselineAccuracy: number;
  combinedAccuracy: number | null;
  deltaFromBaseline: number | null;
  weights: {
    historicalReplay: number;
    prOutcome: number;
  };
  bySource: {
    historical_replay: CalibrationSourceMetric;
    pr_outcome: CalibrationSourceMetric;
  };
  replayHarnessHold: boolean;
  replayHarnessStatus: ReplayHarnessStatus | "missing";
  autonomyIncreasePermitted: boolean;
  holdReasons: string[];
  replayRunDue: boolean;
  audit: {
    contributingSources: CalibrationSignalSource[];
    rejectedSources: Array<{ source: CalibrationSignalSource; reason: string }>;
  };
};

const DEFAULT_CONFIG: Omit<Phase7CalibrationConfig, "warnings"> = {
  phase7LoopEnabled: false,
  autonomyIncreaseMinAccuracy: 0.7,
  replayFreshnessMaxAgeHours: 168,
  historicalReplayWeight: 0.5,
  prOutcomeWeight: 0.5,
  prOutcomeMinDecided: 10,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000_000) / 1_000_000;
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "disabled"].includes(normalized)) return false;
  return undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(number)) return undefined;
  return number;
}

function normalizeOptionalPositiveInt(value: unknown, fallback: number): number {
  const number = normalizeOptionalNumber(value);
  if (number === undefined || number <= 0) return fallback;
  return Math.max(1, Math.floor(number));
}

function normalizeObservedAt(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parseNow(value: string | Date | null | undefined): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = normalizeObservedAt(typeof value === "string" ? value : undefined);
  return parsed ? new Date(parsed) : new Date();
}

function normalizeReplayRunId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160 || /[\r\n\0]/u.test(trimmed)) return null;
  return trimmed;
}

function normalizeCompositeWeights(config: Phase7CalibrationConfig): { historicalReplay: number; prOutcome: number } {
  const raw = {
    historicalReplay: finiteNonNegative(config.historicalReplayWeight, DEFAULT_CONFIG.historicalReplayWeight),
    prOutcome: finiteNonNegative(config.prOutcomeWeight, DEFAULT_CONFIG.prOutcomeWeight),
  };
  const total = raw.historicalReplay + raw.prOutcome;
  if (total <= 0) {
    return { historicalReplay: DEFAULT_CONFIG.historicalReplayWeight, prOutcome: DEFAULT_CONFIG.prOutcomeWeight };
  }
  return {
    historicalReplay: raw.historicalReplay / total,
    prOutcome: raw.prOutcome / total,
  };
}

function markdownSafe(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").replace(/[\\`*_[\]<>|]/gu, "\\$&");
}

function markdownList(values: readonly string[]): string {
  if (values.length === 0) return "- none";
  return values.map((value) => `- ${markdownSafe(value)}`).join("\n");
}

/**
 * Resolve the explicit Phase 7 loop config from a parsed `.gittensory-miner.yml`-style object. Default is disabled
 * and fail-closed when enabled but inputs are missing or degraded.
 */
export function resolvePhase7CalibrationConfig(
  manifest: Phase7CalibrationManifest | Record<string, unknown> | null | undefined,
): Phase7CalibrationConfig {
  const warnings: string[] = [];
  const root = isRecord(manifest) ? manifest : {};
  const miner = isRecord(root.miner) ? root.miner : {};
  const minerCalibration = isRecord(miner.calibration) ? miner.calibration : {};
  const topCalibration = isRecord(root.calibration) ? root.calibration : {};

  const enabledRaw = minerCalibration.phase7LoopEnabled ?? topCalibration.phase7LoopEnabled ?? undefined;
  const enabled = normalizeBoolean(enabledRaw);
  if (enabledRaw !== undefined && enabled === undefined) {
    warnings.push("miner.calibration.phase7LoopEnabled must be a boolean-like value; defaulting to false.");
  }

  const minAccuracyRaw =
    minerCalibration.autonomyIncreaseMinAccuracy ?? topCalibration.autonomyIncreaseMinAccuracy ?? undefined;
  const minAccuracy = normalizeOptionalNumber(minAccuracyRaw);
  if (minAccuracyRaw !== undefined && (minAccuracy === undefined || minAccuracy < 0 || minAccuracy > 1)) {
    warnings.push(
      "miner.calibration.autonomyIncreaseMinAccuracy must be a finite number in [0, 1]; using default 0.70.",
    );
  }

  const freshnessRaw =
    minerCalibration.replayFreshnessMaxAgeHours ?? topCalibration.replayFreshnessMaxAgeHours ?? undefined;
  const freshness = normalizeOptionalNumber(freshnessRaw);
  if (freshnessRaw !== undefined && (freshness === undefined || freshness <= 0)) {
    warnings.push("miner.calibration.replayFreshnessMaxAgeHours must be a positive finite number; using default 168.");
  }

  const replayWeightRaw =
    minerCalibration.historicalReplayWeight ?? topCalibration.historicalReplayWeight ?? undefined;
  const replayWeight = normalizeOptionalNumber(replayWeightRaw);
  if (replayWeightRaw !== undefined && (replayWeight === undefined || replayWeight < 0)) {
    warnings.push("miner.calibration.historicalReplayWeight must be a non-negative finite number; using default 0.5.");
  }

  const prOutcomeWeightRaw = minerCalibration.prOutcomeWeight ?? topCalibration.prOutcomeWeight ?? undefined;
  const prOutcomeWeight = normalizeOptionalNumber(prOutcomeWeightRaw);
  if (prOutcomeWeightRaw !== undefined && (prOutcomeWeight === undefined || prOutcomeWeight < 0)) {
    warnings.push("miner.calibration.prOutcomeWeight must be a non-negative finite number; using default 0.5.");
  }

  const minDecidedRaw = minerCalibration.prOutcomeMinDecided ?? topCalibration.prOutcomeMinDecided ?? undefined;
  const minDecided = normalizeOptionalPositiveInt(minDecidedRaw, DEFAULT_CONFIG.prOutcomeMinDecided);
  if (minDecidedRaw !== undefined && normalizeOptionalNumber(minDecidedRaw) === undefined) {
    warnings.push("miner.calibration.prOutcomeMinDecided must be a positive integer; using default 10.");
  }

  return {
    phase7LoopEnabled: enabled === true,
    autonomyIncreaseMinAccuracy:
      minAccuracy !== undefined && minAccuracy >= 0 && minAccuracy <= 1
        ? roundScore(minAccuracy)
        : DEFAULT_CONFIG.autonomyIncreaseMinAccuracy,
    replayFreshnessMaxAgeHours:
      freshness !== undefined && freshness > 0 ? freshness : DEFAULT_CONFIG.replayFreshnessMaxAgeHours,
    historicalReplayWeight:
      replayWeight !== undefined && replayWeight >= 0 ? replayWeight : DEFAULT_CONFIG.historicalReplayWeight,
    prOutcomeWeight:
      prOutcomeWeight !== undefined && prOutcomeWeight >= 0 ? prOutcomeWeight : DEFAULT_CONFIG.prOutcomeWeight,
    prOutcomeMinDecided: minDecided,
    warnings,
  };
}

/** Derive live pr_outcome calibration accuracy from a gate-eval-style confusion matrix. Pure. */
export function computePrOutcomeCalibrationAccuracy(input: PrOutcomeCalibrationInput): {
  accuracy: number | null;
  sampleSize: number;
} {
  const mergeConfirmed = finiteNonNegative(input.mergeConfirmed, 0);
  const mergeFalse = finiteNonNegative(input.mergeFalse, 0);
  const closeConfirmed = finiteNonNegative(input.closeConfirmed, 0);
  const closeFalse = finiteNonNegative(input.closeFalse, 0);
  const sampleSize = mergeConfirmed + mergeFalse + closeConfirmed + closeFalse;
  if (sampleSize <= 0) return { accuracy: null, sampleSize: 0 };
  return {
    accuracy: roundScore((mergeConfirmed + closeConfirmed) / sampleSize),
    sampleSize,
  };
}

/** True when a replay run is still fresh relative to the configured max age. Pure. */
export function isHistoricalReplayRunFresh(input: {
  observedAt: string;
  maxAgeHours: number;
  now?: string | Date | null | undefined;
}): boolean {
  const observed = normalizeObservedAt(input.observedAt);
  if (!observed) return false;
  const maxAgeHours = finiteNonNegative(input.maxAgeHours, DEFAULT_CONFIG.replayFreshnessMaxAgeHours);
  if (maxAgeHours <= 0) return false;
  const ageMs = parseNow(input.now).getTime() - new Date(observed).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return false;
  return ageMs <= maxAgeHours * 3_600_000;
}

/** Recommend whether a new historical-replay run should be scheduled/triggered. Pure. */
export function shouldScheduleHistoricalReplayRun(input: {
  config: Phase7CalibrationConfig | Phase7CalibrationManifest | Record<string, unknown> | null | undefined;
  lastReplayObservedAt?: string | null | undefined;
  harnessStatus?: ReplayHarnessStatus | "missing" | undefined;
  now?: string | Date | null | undefined;
}): { due: boolean; reason: string } {
  const config =
    input.config && "phase7LoopEnabled" in input.config
      ? (input.config as Phase7CalibrationConfig)
      : resolvePhase7CalibrationConfig(input.config);
  if (!config.phase7LoopEnabled) {
    return { due: false, reason: "phase7_loop_disabled" };
  }
  if (input.harnessStatus === "unavailable" || input.harnessStatus === "degraded") {
    return { due: true, reason: `replay_harness_${input.harnessStatus}` };
  }
  if (!input.lastReplayObservedAt) {
    return { due: true, reason: "no_replay_run_recorded" };
  }
  if (
    !isHistoricalReplayRunFresh({
      observedAt: input.lastReplayObservedAt,
      maxAgeHours: config.replayFreshnessMaxAgeHours,
      now: input.now,
    })
  ) {
    return { due: true, reason: "replay_run_stale" };
  }
  return { due: false, reason: "replay_run_fresh" };
}

function extractHistoricalReplayScore(
  compositeScore: number | GateVerdictCompositeCalibrationScore,
): number {
  if (typeof compositeScore === "number") return roundScore(compositeScore);
  return roundScore(compositeScore.compositeScore);
}

/**
 * Combine historical-replay and pr_outcome calibration signals into the tracked Phase 7 metric, record provenance,
 * and evaluate fail-closed autonomy-level increase eligibility.
 */
export function computePhase7CalibrationLoop(input: {
  config?: Phase7CalibrationConfig | Phase7CalibrationManifest | Record<string, unknown> | null | undefined;
  prOutcome?: PrOutcomeCalibrationInput | null | undefined;
  historicalReplay?: HistoricalReplayCalibrationInput | null | undefined;
  now?: string | Date | null | undefined;
}): Phase7CalibrationLoopResult {
  const config =
    input.config && "phase7LoopEnabled" in input.config
      ? (input.config as Phase7CalibrationConfig)
      : resolvePhase7CalibrationConfig(input.config);
  const weights = normalizeCompositeWeights(config);
  const now = parseNow(input.now);
  const holdReasons: string[] = [];
  const contributingSources: CalibrationSignalSource[] = [];
  const rejectedSources: Phase7CalibrationLoopResult["audit"]["rejectedSources"] = [];

  const prOutcomeDerived = input.prOutcome ? computePrOutcomeCalibrationAccuracy(input.prOutcome) : null;
  const prOutcomeMetric: CalibrationSourceMetric = {
    source: "pr_outcome",
    accuracy: prOutcomeDerived?.accuracy ?? null,
    sampleSize: prOutcomeDerived?.sampleSize ?? 0,
    observedAt: normalizeObservedAt(input.prOutcome?.observedAt),
    fresh: true,
  };
  if (prOutcomeDerived && prOutcomeDerived.sampleSize >= config.prOutcomeMinDecided && prOutcomeDerived.accuracy !== null) {
    contributingSources.push("pr_outcome");
  } else if (input.prOutcome) {
    rejectedSources.push({
      source: "pr_outcome",
      reason:
        prOutcomeDerived && prOutcomeDerived.sampleSize > 0
          ? "insufficient_pr_outcome_samples"
          : "no_pr_outcome_signal",
    });
  }

  let replayHarnessStatus: ReplayHarnessStatus | "missing" = "missing";
  let replayHarnessHold = false;
  let historicalReplayMetric: CalibrationSourceMetric = {
    source: "historical_replay",
    accuracy: null,
    sampleSize: 0,
    observedAt: null,
    fresh: false,
  };

  if (input.historicalReplay) {
    const replayRunId = normalizeReplayRunId(input.historicalReplay.replayRunId);
    const observedAt = normalizeObservedAt(input.historicalReplay.observedAt);
    replayHarnessStatus = input.historicalReplay.harnessStatus;
    const fresh =
      observedAt !== null &&
      isHistoricalReplayRunFresh({
        observedAt,
        maxAgeHours: config.replayFreshnessMaxAgeHours,
        now,
      });
    const accuracy = extractHistoricalReplayScore(input.historicalReplay.compositeScore);
    historicalReplayMetric = {
      source: "historical_replay",
      accuracy,
      sampleSize: 1,
      observedAt,
      fresh,
      replayRunId: replayRunId ?? undefined,
      harnessStatus: input.historicalReplay.harnessStatus,
    };

    if (input.historicalReplay.harnessStatus !== "healthy") {
      replayHarnessHold = true;
      holdReasons.push(`replay_harness_${input.historicalReplay.harnessStatus}`);
      rejectedSources.push({
        source: "historical_replay",
        reason: `replay_harness_${input.historicalReplay.harnessStatus}`,
      });
    } else if (!replayRunId || !observedAt) {
      replayHarnessHold = true;
      holdReasons.push("invalid_replay_run_metadata");
      rejectedSources.push({ source: "historical_replay", reason: "invalid_replay_run_metadata" });
    } else if (!fresh) {
      replayHarnessHold = true;
      holdReasons.push("replay_run_stale");
      rejectedSources.push({ source: "historical_replay", reason: "replay_run_stale" });
    } else {
      contributingSources.push("historical_replay");
    }
  } else if (config.phase7LoopEnabled) {
    replayHarnessHold = true;
    holdReasons.push("no_historical_replay_signal");
    rejectedSources.push({ source: "historical_replay", reason: "no_historical_replay_signal" });
  }

  const usable = {
    historical_replay:
      historicalReplayMetric.accuracy !== null &&
      contributingSources.includes("historical_replay")
        ? { accuracy: historicalReplayMetric.accuracy, weight: weights.historicalReplay }
        : null,
    pr_outcome:
      prOutcomeMetric.accuracy !== null && contributingSources.includes("pr_outcome")
        ? { accuracy: prOutcomeMetric.accuracy, weight: weights.prOutcome }
        : null,
  };

  const weightTotal =
    (usable.historical_replay?.weight ?? 0) + (usable.pr_outcome?.weight ?? 0);
  const combinedAccuracy =
    weightTotal <= 0
      ? null
      : roundScore(
          ((usable.historical_replay?.accuracy ?? 0) * (usable.historical_replay?.weight ?? 0) +
            (usable.pr_outcome?.accuracy ?? 0) * (usable.pr_outcome?.weight ?? 0)) /
            weightTotal,
        );

  const deltaFromBaseline =
    combinedAccuracy === null ? null : roundScore(combinedAccuracy - DOCUMENTED_CALIBRATION_BASELINE);

  const schedule = shouldScheduleHistoricalReplayRun({
    config,
    lastReplayObservedAt: historicalReplayMetric.observedAt,
    harnessStatus: replayHarnessStatus,
    now,
  });

  let autonomyIncreasePermitted = true;
  if (config.phase7LoopEnabled) {
    autonomyIncreasePermitted = false;
    if (replayHarnessHold) {
      // fail-closed: degraded/unavailable/stale/missing replay blocks increases without silent pr_outcome fallback
    } else if (combinedAccuracy === null) {
      holdReasons.push("no_combined_calibration_signal");
    } else if (combinedAccuracy < config.autonomyIncreaseMinAccuracy) {
      holdReasons.push("calibration_below_threshold");
    } else if (!contributingSources.includes("historical_replay") || !contributingSources.includes("pr_outcome")) {
      holdReasons.push("missing_required_signal_source");
    } else {
      autonomyIncreasePermitted = true;
    }
  }

  if (!autonomyIncreasePermitted && holdReasons.length === 0) {
    holdReasons.push("phase7_loop_hold");
  }

  return {
    enabled: config.phase7LoopEnabled,
    baselineAccuracy: DOCUMENTED_CALIBRATION_BASELINE,
    combinedAccuracy,
    deltaFromBaseline,
    weights,
    bySource: {
      historical_replay: historicalReplayMetric,
      pr_outcome: prOutcomeMetric,
    },
    replayHarnessHold,
    replayHarnessStatus,
    autonomyIncreasePermitted,
    holdReasons: [...new Set(holdReasons)],
    replayRunDue: schedule.due,
    audit: {
      contributingSources,
      rejectedSources,
    },
  };
}

/** Evaluate autonomy-level increase eligibility from a computed loop result. Pure alias for callers that split steps. */
export function evaluateAutonomyIncreaseEligibility(result: Phase7CalibrationLoopResult): {
  permitted: boolean;
  holdReasons: string[];
  replayHarnessHold: boolean;
} {
  return {
    permitted: result.autonomyIncreasePermitted,
    holdReasons: result.holdReasons,
    replayHarnessHold: result.replayHarnessHold,
  };
}

/**
 * Render a deterministic, public-safe Markdown report for a Phase 7 calibration loop evaluation. Includes the
 * tracked metric, baseline delta, per-source breakdown, replay cadence recommendation, and hold reasons.
 */
export function renderPhase7CalibrationAuditMarkdown(result: Phase7CalibrationLoopResult): string {
  const formatAccuracy = (value: number | null): string => (value === null ? "n/a" : `${(value * 100).toFixed(2)}%`);
  const lines = [
    "# Phase 7 Calibration Loop",
    "",
    `- loop enabled: ${result.enabled}`,
    `- documented baseline: ${(result.baselineAccuracy * 100).toFixed(2)}%`,
    `- combined calibration accuracy: ${formatAccuracy(result.combinedAccuracy)}`,
    `- delta from baseline: ${
      result.deltaFromBaseline === null ? "n/a" : `${(result.deltaFromBaseline * 100).toFixed(2)} percentage points`
    }`,
    `- autonomy increase permitted: ${result.autonomyIncreasePermitted}`,
    `- replay harness hold: ${result.replayHarnessHold}`,
    `- replay harness status: ${result.replayHarnessStatus}`,
    `- replay run due: ${result.replayRunDue}`,
    "",
    "## Effective Weights",
    "",
    `- historical_replay: ${result.weights.historicalReplay.toFixed(6)}`,
    `- pr_outcome: ${result.weights.prOutcome.toFixed(6)}`,
    "",
    "## Signal Sources",
    "",
    "### historical_replay",
    "",
    `- accuracy: ${formatAccuracy(result.bySource.historical_replay.accuracy)}`,
    `- sampleSize: ${result.bySource.historical_replay.sampleSize}`,
    `- observedAt: ${result.bySource.historical_replay.observedAt ?? "n/a"}`,
    `- fresh: ${result.bySource.historical_replay.fresh}`,
    `- replayRunId: ${result.bySource.historical_replay.replayRunId ? markdownSafe(result.bySource.historical_replay.replayRunId) : "n/a"}`,
    `- harnessStatus: ${result.bySource.historical_replay.harnessStatus ?? "n/a"}`,
    "",
    "### pr_outcome",
    "",
    `- accuracy: ${formatAccuracy(result.bySource.pr_outcome.accuracy)}`,
    `- sampleSize: ${result.bySource.pr_outcome.sampleSize}`,
    `- observedAt: ${result.bySource.pr_outcome.observedAt ?? "n/a"}`,
    "",
    "## Hold Reasons",
    "",
    markdownList(result.holdReasons),
    "",
    "## Contributing Sources",
    "",
    markdownList(result.audit.contributingSources),
    "",
    "## Rejected Sources",
    "",
  ];

  if (result.audit.rejectedSources.length === 0) {
    lines.push("- none");
  } else {
    lines.push(
      "| Source | Reason |",
      "| --- | --- |",
      ...result.audit.rejectedSources.map(
        (row) => `| ${markdownSafe(row.source)} | ${markdownSafe(row.reason)} |`,
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}
