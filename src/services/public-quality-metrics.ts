// Public per-repo review-quality metrics (#2568). Reuses the gate-block false-positive ledger
// (services/gate-precision.ts, the same signal ops-wire.ts surfaces) and slop/outcome calibration
// already collected for maintainers — but exposes ONLY public-safe aggregate counts and rates.
//
// HARD whitelist: no raw trust scores, reward values, contributor logins, or PR content. Opt-in per repo
// via `publicQualityMetrics` (default OFF). Pure builders are clock-injected for deterministic tests.

import { listGateOutcomes, listPullRequests } from "../db/repositories";
import type { GateOutcomeRecord, PullRequestRecord } from "../types";
import { nowIso } from "../utils/json";
import { buildGatePrecisionReport, loadGatePrecisionReport, type GatePrecisionReport } from "./gate-precision";
import { buildSlopOutcomeCalibration, buildRepoOutcomeCalibration, type SlopOutcomeCalibration } from "./outcome-calibration";

export const PUBLIC_QUALITY_TREND_WEEKS = 8;
/** Below this per-week gate-block sample the weekly false-positive rate is too noisy to publish. */
export const MIN_GATE_TREND_SAMPLE = 3;

export type PublicQualityTrendWeek = {
  /** UTC Monday (YYYY-MM-DD) that starts the bucket. */
  weekStart: string;
  gateBlocked: number;
  gateBlockedThenMerged: number;
  gateFalsePositiveRate: number | null;
  outcomesMerged: number;
  outcomesClosed: number;
  mergeRatioPct: number | null;
};

export type PublicQualityGateTypeRow = {
  gateType: string;
  blocked: number;
  blockedThenMerged: number;
  falsePositiveRate: number | null;
  precisionPct: number | null;
};

export type PublicQualityMetricsPayload = {
  repoFullName: string;
  generatedAt: string;
  gate: {
    blocked: number;
    blockedThenMerged: number;
    falsePositiveRate: number | null;
    precisionPct: number | null;
    topGateTypes: PublicQualityGateTypeRow[];
  };
  outcomes: {
    merged: number;
    closed: number;
    mergeRatioPct: number | null;
  };
  slop: {
    totalResolved: number;
    overallMergeRate: number | null;
    discriminates: boolean | null;
  };
  trend: PublicQualityTrendWeek[];
};

const MS_PER_WEEK = 7 * 86_400_000;

function roundPct(value: number): number {
  return Math.round(value * 1000) / 10;
}

function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Public precision complement of a false-positive rate; null when the rate is unknown. */
export function gatePrecisionPct(falsePositiveRate: number | null): number | null {
  if (falsePositiveRate == null) return null;
  return roundPct(1 - falsePositiveRate);
}

/** Share of terminal outcomes that merged; null when there is no decided signal. */
export function mergeRatioPct(merged: number, closed: number): number | null {
  const decided = merged + closed;
  if (decided <= 0) return null;
  return roundPct(merged / decided);
}

function terminalOutcome(pr: PullRequestRecord): "merged" | "closed" | null {
  if (pr.mergedAt) return "merged";
  if (pr.state === "closed") return "closed";
  return null;
}

function parseStamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** UTC Monday (YYYY-MM-DD) containing `ms`. */
export function isoWeekStart(ms: number): string {
  const d = new Date(ms);
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function weekBucketIndex(currentStartMs: number, eventMs: number, weeks: number): number | null {
  const oldestStart = currentStartMs - (weeks - 1) * MS_PER_WEEK;
  if (eventMs < oldestStart) return null;
  const weekOffset = Math.floor((eventMs - oldestStart) / MS_PER_WEEK);
  if (weekOffset < 0 || weekOffset >= weeks) return null;
  return weekOffset;
}

type TrendBucket = {
  gateBlocked: number;
  gateBlockedThenMerged: number;
  outcomesMerged: number;
  outcomesClosed: number;
};

function emptyBucket(): TrendBucket {
  return { gateBlocked: 0, gateBlockedThenMerged: 0, outcomesMerged: 0, outcomesClosed: 0 };
}

/** Weekly gate false-positive and merge-vs-close trend over trailing `weeks` (default 8). Pure. */
export function buildPublicQualityTrend(
  gateOutcomes: GateOutcomeRecord[],
  pullRequests: PullRequestRecord[],
  nowMs: number,
  weeks: number = PUBLIC_QUALITY_TREND_WEEKS,
): PublicQualityTrendWeek[] {
  const prByNumber = new Map(pullRequests.map((pr) => [pr.number, pr]));
  const currentStartMs = Date.parse(isoWeekStart(nowMs));
  const oldestStartMs = currentStartMs - (weeks - 1) * MS_PER_WEEK;
  const buckets = Array.from({ length: weeks }, () => emptyBucket());

  for (const outcome of gateOutcomes) {
    const stamp = parseStamp(outcome.blockedAt ?? outcome.updatedAt);
    if (stamp == null) continue;
    const idx = weekBucketIndex(currentStartMs, stamp, weeks);
    if (idx == null) continue;
    const bucket = buckets[idx] as TrendBucket;
    bucket.gateBlocked += 1;
    const pr = prByNumber.get(outcome.pullNumber);
    if (pr && terminalOutcome(pr) === "merged") bucket.gateBlockedThenMerged += 1;
  }

  for (const pr of pullRequests) {
    const terminal = terminalOutcome(pr);
    if (!terminal) continue;
    const stamp = parseStamp(terminal === "merged" ? pr.mergedAt : pr.updatedAt ?? pr.createdAt);
    if (stamp == null) continue;
    const idx = weekBucketIndex(currentStartMs, stamp, weeks);
    if (idx == null) continue;
    const bucket = buckets[idx] as TrendBucket;
    if (terminal === "merged") bucket.outcomesMerged += 1;
    else bucket.outcomesClosed += 1;
  }

  return buckets.map((bucket, offset) => {
    const weekStart = isoWeekStart(oldestStartMs + offset * MS_PER_WEEK);
    return {
      weekStart,
      gateBlocked: bucket.gateBlocked,
      gateBlockedThenMerged: bucket.gateBlockedThenMerged,
      gateFalsePositiveRate:
        bucket.gateBlocked >= MIN_GATE_TREND_SAMPLE
          ? roundRate(bucket.gateBlockedThenMerged / bucket.gateBlocked)
          : null,
      outcomesMerged: bucket.outcomesMerged,
      outcomesClosed: bucket.outcomesClosed,
      mergeRatioPct: mergeRatioPct(bucket.outcomesMerged, bucket.outcomesClosed),
    };
  });
}

function topPublicGateTypes(gatePrecision: GatePrecisionReport): PublicQualityGateTypeRow[] {
  return gatePrecision.perGateType
    .filter((row) => row.blocked > 0)
    .slice(0, 5)
    .map((row) => ({
      gateType: row.gateType,
      blocked: row.blocked,
      blockedThenMerged: row.blockedThenMerged,
      falsePositiveRate: row.falsePositiveRate,
      precisionPct: gatePrecisionPct(row.falsePositiveRate),
    }));
}

/** Assemble the public-safe per-repo quality payload from existing telemetry. Pure. */
export function buildPublicQualityMetrics(args: {
  repoFullName: string;
  generatedAt: string;
  gatePrecision: GatePrecisionReport;
  slopCalibration: SlopOutcomeCalibration;
  gateOutcomes: GateOutcomeRecord[];
  pullRequests: PullRequestRecord[];
  nowMs?: number;
}): PublicQualityMetricsPayload {
  const nowMs = args.nowMs ?? Date.now();
  let merged = 0;
  let closed = 0;
  for (const pr of args.pullRequests) {
    const terminal = terminalOutcome(pr);
    if (terminal === "merged") merged += 1;
    else if (terminal === "closed") closed += 1;
  }

  const falsePositiveRate = args.gatePrecision.overall.falsePositiveRate;
  return {
    repoFullName: args.repoFullName,
    generatedAt: args.generatedAt,
    gate: {
      blocked: args.gatePrecision.overall.blocked,
      blockedThenMerged: args.gatePrecision.overall.blockedThenMerged,
      falsePositiveRate,
      precisionPct: gatePrecisionPct(falsePositiveRate),
      topGateTypes: topPublicGateTypes(args.gatePrecision),
    },
    outcomes: {
      merged,
      closed,
      mergeRatioPct: mergeRatioPct(merged, closed),
    },
    slop: {
      totalResolved: args.slopCalibration.totalResolved,
      overallMergeRate:
        args.slopCalibration.overallMergeRate != null
          ? roundPct(args.slopCalibration.overallMergeRate)
          : null,
      discriminates: args.slopCalibration.discriminates,
    },
    trend: buildPublicQualityTrend(args.gateOutcomes, args.pullRequests, nowMs),
  };
}

/** Load a repo's gate/outcome telemetry and assemble the public quality payload. */
export async function loadPublicQualityMetrics(env: Env, repoFullName: string): Promise<PublicQualityMetricsPayload> {
  const [gatePrecision, calibration, pullRequests, gateOutcomes] = await Promise.all([
    loadGatePrecisionReport(env, repoFullName),
    buildRepoOutcomeCalibration(env, repoFullName),
    listPullRequests(env, repoFullName),
    listGateOutcomes(env, { repoFullName }),
  ]);
  return buildPublicQualityMetrics({
    repoFullName,
    generatedAt: nowIso(),
    gatePrecision,
    slopCalibration: calibration.slop,
    gateOutcomes,
    pullRequests,
  });
}

/** Convenience for tests: build from raw gate rows + PRs without I/O. */
export function buildPublicQualityMetricsFromRecords(
  repoFullName: string,
  gateOutcomes: GateOutcomeRecord[],
  pullRequests: PullRequestRecord[],
  generatedAt: string,
  nowMs: number,
): PublicQualityMetricsPayload {
  const gatePrecision: GatePrecisionReport = {
    repoFullName,
    generatedAt,
    windowDays: null,
    ...buildGatePrecisionReport(gateOutcomes, pullRequests, { repoFullName }),
  };
  return buildPublicQualityMetrics({
    repoFullName,
    generatedAt,
    gatePrecision,
    slopCalibration: buildSlopOutcomeCalibration(pullRequests),
    gateOutcomes,
    pullRequests,
    nowMs,
  });
}
