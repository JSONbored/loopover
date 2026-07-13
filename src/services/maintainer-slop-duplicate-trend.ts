import type { JsonValue, SignalSnapshotRecord } from "../types";
import type { QueueHealth } from "../signals/engine";
import { isoWeekStart } from "./public-quality-metrics";

// Maintainer slop + duplicate flag-rate trend (#2202). Shapes queue-health signal snapshots (and optional
// live queue-health points) into weekly slop-flag and duplicate-flag RATES for the maintainer dashboard card.
// Public-safe: band labels and observable rates only — never raw slop-risk or credibility numbers.

export const SLOP_DUPLICATE_TREND_WEEKS = 8;
/** Max queue-health snapshots read per repo when shaping the maintainer trend card — two per week of history. */
export const SLOP_DUPLICATE_TREND_SNAPSHOT_LIMIT = SLOP_DUPLICATE_TREND_WEEKS * 2;
const MS_PER_WEEK = 7 * 86_400_000;
const MIN_OPEN_PRS_FOR_RATE = 1;
const SLOP_BAND_LOW_MAX_PCT = 25;
const SLOP_BAND_ELEVATED_MAX_PCT = 60;

export type SlopBandLabel = "clean" | "low" | "elevated" | "high";

export type SlopDuplicateTrendWeek = {
  /** UTC Monday (YYYY-MM-DD) that starts the bucket. */
  weekStart: string;
  /** Share of open PRs flagged elevated/high slop; null when no open PR sample. */
  slopFlagRatePct: number | null;
  /** Dominant slop band label for the week (from the aggregate flag rate, not raw risk scores). */
  slopBandLabel: SlopBandLabel | null;
  /** Share of open PRs in a high-risk duplicate cluster; null when no open PR sample. */
  duplicateFlagRatePct: number | null;
};

export type MaintainerSlopDuplicateTrend = {
  generatedAt: string;
  stale: boolean;
  weeks: SlopDuplicateTrendWeek[];
  summary: string;
};

export type MaintainerSlopDuplicateTrendRepoInput = {
  repoFullName: string;
  queueHealthSnapshots?: SignalSnapshotRecord[] | undefined;
  currentQueueHealth?: QueueHealth | undefined;
};

type TrendPoint = {
  generatedAt: string;
  repoFullName: string;
  openPullRequests: number;
  slopFlaggedPullRequests: number;
  duplicateFlaggedPullRequests: number;
};

export function buildMaintainerSlopDuplicateTrend(args: {
  repos: MaintainerSlopDuplicateTrendRepoInput[];
  generatedAt: string;
  stale?: boolean;
  nowMs?: number;
  weeks?: number;
}): MaintainerSlopDuplicateTrend {
  const weeks = args.weeks ?? SLOP_DUPLICATE_TREND_WEEKS;
  const nowMs = args.nowMs ?? Date.parse(args.generatedAt);
  const currentStartMs = Date.parse(isoWeekStart(nowMs));
  const oldestStartMs = currentStartMs - (weeks - 1) * MS_PER_WEEK;
  const points = collectTrendPoints(args.repos);
  const trendWeeks = Array.from({ length: weeks }, (_, offset) => {
    const weekStart = isoWeekStart(oldestStartMs + offset * MS_PER_WEEK);
    const weekEndMs = oldestStartMs + (offset + 1) * MS_PER_WEEK;
    const weekStartMs = oldestStartMs + offset * MS_PER_WEEK;
    const totals = aggregateWeek(points, weekStartMs, weekEndMs);
    const slopFlagRatePct = ratePct(totals.slopFlaggedPullRequests, totals.openPullRequests);
    const duplicateFlagRatePct = ratePct(totals.duplicateFlaggedPullRequests, totals.openPullRequests);
    return {
      weekStart,
      slopFlagRatePct,
      slopBandLabel: slopBandLabelFromRate(slopFlagRatePct),
      duplicateFlagRatePct,
    };
  });
  const shapedRepos = args.repos.length;
  const hasSignal = trendWeeks.some(
    (week) => week.slopFlagRatePct !== null || week.duplicateFlagRatePct !== null,
  );
  return {
    generatedAt: args.generatedAt,
    stale: args.stale ?? false,
    weeks: trendWeeks,
    summary: hasSignal
      ? `${weeks}-week slop + duplicate flag rates across ${shapedRepos} shaped repo(s).`
      : `No queue-health snapshot history yet for slop + duplicate trends across ${shapedRepos} shaped repo(s).`,
  };
}

/** Map an aggregate slop flag rate to a public band label (never a raw credibility score). */
export function slopBandLabelFromRate(ratePct: number | null): SlopBandLabel | null {
  if (ratePct == null) return null;
  if (ratePct <= 0) return "clean";
  if (ratePct < SLOP_BAND_LOW_MAX_PCT) return "low";
  if (ratePct < SLOP_BAND_ELEVATED_MAX_PCT) return "elevated";
  return "high";
}

export function trendPointFromQueueHealth(queueHealth: QueueHealth): Omit<TrendPoint, "repoFullName"> {
  return {
    generatedAt: queueHealth.generatedAt,
    openPullRequests: queueHealth.signals.openPullRequests,
    slopFlaggedPullRequests: queueHealth.signals.slopFlaggedPullRequests,
    duplicateFlaggedPullRequests: queueHealth.signals.duplicateFlaggedPullRequests,
  };
}

function collectTrendPoints(repos: MaintainerSlopDuplicateTrendRepoInput[]): TrendPoint[] {
  const points: TrendPoint[] = [];
  for (const repo of repos) {
    for (const snapshot of repo.queueHealthSnapshots ?? []) {
      const extracted = trendPointFromSignalSnapshot(snapshot);
      if (extracted) points.push({ repoFullName: repo.repoFullName, ...extracted });
    }
    if (repo.currentQueueHealth) {
      points.push({ repoFullName: repo.repoFullName, ...trendPointFromQueueHealth(repo.currentQueueHealth) });
    }
  }
  return points.filter((point) => Number.isFinite(Date.parse(point.generatedAt)));
}

function aggregateWeek(
  points: TrendPoint[],
  weekStartMs: number,
  weekEndMs: number,
): { openPullRequests: number; slopFlaggedPullRequests: number; duplicateFlaggedPullRequests: number } {
  const latestByRepo = new Map<string, TrendPoint>();
  for (const point of points) {
    const ms = Date.parse(point.generatedAt);
    if (ms < weekStartMs || ms >= weekEndMs) continue;
    const existing = latestByRepo.get(point.repoFullName);
    if (!existing || Date.parse(existing.generatedAt) < ms) latestByRepo.set(point.repoFullName, point);
  }
  let openPullRequests = 0;
  let slopFlaggedPullRequests = 0;
  let duplicateFlaggedPullRequests = 0;
  for (const point of latestByRepo.values()) {
    openPullRequests += point.openPullRequests;
    slopFlaggedPullRequests += point.slopFlaggedPullRequests;
    duplicateFlaggedPullRequests += point.duplicateFlaggedPullRequests;
  }
  return { openPullRequests, slopFlaggedPullRequests, duplicateFlaggedPullRequests };
}

function trendPointFromSignalSnapshot(
  snapshot: SignalSnapshotRecord,
): Omit<TrendPoint, "repoFullName"> | null {
  if (!snapshot.generatedAt) return null;
  const signals = readQueueHealthSignals(snapshot.payload);
  return signals ? { generatedAt: snapshot.generatedAt, ...signals } : null;
}

function readQueueHealthSignals(
  payload: Record<string, JsonValue>,
): Omit<TrendPoint, "generatedAt" | "repoFullName"> | null {
  const signals = isRecord(payload.signals) ? payload.signals : null;
  if (!signals) return null;
  const openPullRequests = numberValue(signals.openPullRequests);
  const collisionClusters = numberValue(signals.collisionClusters);
  const slopFlaggedPullRequests = numberValue(signals.slopFlaggedPullRequests);
  const duplicateFlaggedPullRequests =
    signals.duplicateFlaggedPullRequests !== undefined
      ? numberValue(signals.duplicateFlaggedPullRequests)
      : legacyDuplicateFlagged(openPullRequests, collisionClusters);
  return {
    openPullRequests,
    slopFlaggedPullRequests,
    duplicateFlaggedPullRequests,
  };
}

/** Pre-#2202 queue-health snapshots only stored collision cluster counts — approximate flagged PRs. */
function legacyDuplicateFlagged(openPullRequests: number, collisionClusters: number): number {
  if (openPullRequests <= 0 || collisionClusters <= 0) return 0;
  return Math.min(openPullRequests, collisionClusters * 2);
}

function ratePct(flagged: number, openPullRequests: number): number | null {
  if (openPullRequests < MIN_OPEN_PRS_FOR_RATE) return null;
  return roundPct((flagged / openPullRequests) * 100);
}

function roundPct(value: number): number {
  return Math.round(value * 10) / 10;
}

function numberValue(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
