import type { JsonValue, RepoGithubTotalsSnapshotRecord, SignalSnapshotRecord } from "../types";
import type { QueueHealth } from "../signals/engine";
import { nowIso } from "../utils/json";

export const QUEUE_TREND_WINDOWS_DAYS = [7, 14, 30] as const;
export const QUEUE_TREND_HISTORY_DAYS = 35;

export type QueueTrendWindow = {
  windowDays: 7 | 14 | 30;
  status: "ready" | "unavailable";
  observedDays: number;
  baselineAt: string | null;
  latestAt: string | null;
  pullRequestGrowth: number | null;
  issueGrowth: number | null;
  mergedPullRequests: number | null;
  closedUnmergedPullRequests: number | null;
  reviewVelocityPerDay: number | null;
  stalePullRequestRate: number | null;
  stalePullRequestRateDelta: number | null;
  duplicateTrend: number | null;
  summary: string;
};

export type QueueTrendReport = {
  repoFullName: string;
  status: "ready" | "unavailable";
  generatedAt: string;
  source: "snapshot";
  windows: QueueTrendWindow[];
  warnings: string[];
  summary: string;
};

type QueueHealthTrendPoint = {
  generatedAt: string;
  openPullRequests: number;
  stalePullRequests: number;
  collisionClusters: number;
};

export function buildQueueTrendReport(args: {
  repoFullName: string;
  totalsSnapshots: RepoGithubTotalsSnapshotRecord[];
  queueHealthSnapshots?: SignalSnapshotRecord[] | undefined;
  currentQueueHealth?: QueueHealth | undefined;
  generatedAt?: string | undefined;
}): QueueTrendReport {
  const generatedAt = args.generatedAt ?? nowIso();
  const totals = sortTotals(args.totalsSnapshots);
  const queuePoints = sortQueuePoints([
    ...(args.queueHealthSnapshots ?? []).flatMap(queuePointFromSignalSnapshot),
    ...(args.currentQueueHealth ? [queuePointFromQueueHealth(args.currentQueueHealth)] : []),
  ]);
  const windows = QUEUE_TREND_WINDOWS_DAYS.map((windowDays) => buildWindow(windowDays, totals, queuePoints));
  const readyWindows = windows.filter((window) => window.status === "ready");
  const warnings = trendWarnings(windows);
  return {
    repoFullName: args.repoFullName,
    status: readyWindows.length > 0 ? "ready" : "unavailable",
    generatedAt,
    source: "snapshot",
    windows,
    warnings,
    summary: readyWindows.length > 0
      ? `${readyWindows.length} queue trend window(s) available for ${args.repoFullName}. ${warnings[0] ?? "No major queue trend warning detected."}`
      : `Queue trend history is unavailable for ${args.repoFullName}; at least two totals snapshots spanning a requested window are required.`,
  };
}

export function buildUnavailableQueueTrendReport(repoFullName: string, generatedAt = nowIso()): QueueTrendReport {
  const windows = QUEUE_TREND_WINDOWS_DAYS.map((windowDays) => unavailableWindow(windowDays, "Missing queue trend snapshot."));
  return {
    repoFullName,
    status: "unavailable",
    generatedAt,
    source: "snapshot",
    windows,
    warnings: ["Queue trend snapshot is missing; run the signal snapshot job after GitHub totals history is available."],
    summary: `Queue trend history is unavailable for ${repoFullName}.`,
  };
}

function buildWindow(windowDays: 7 | 14 | 30, totals: RepoGithubTotalsSnapshotRecord[], queuePoints: QueueHealthTrendPoint[]): QueueTrendWindow {
  const latest = totals.at(-1);
  if (!latest) return unavailableWindow(windowDays, "Missing GitHub totals snapshots.");
  const latestMs = Date.parse(latest.fetchedAt);
  const targetMs = latestMs - windowDays * 24 * 60 * 60 * 1000;
  const baseline = [...totals].reverse().find((snapshot) => Date.parse(snapshot.fetchedAt) <= targetMs);
  if (!baseline) return unavailableWindow(windowDays, `Need at least ${windowDays} days of totals history.`);
  // Baseline is the newest snapshot at or before (latest - windowDays), so observedDays >= windowDays.
  const observedDays = round((latestMs - Date.parse(baseline.fetchedAt)) / (24 * 60 * 60 * 1000));
  const mergedPullRequests = Math.max(0, latest.mergedPullRequestsTotal - baseline.mergedPullRequestsTotal);
  const closedUnmergedPullRequests = Math.max(0, latest.closedUnmergedPullRequestsTotal - baseline.closedUnmergedPullRequestsTotal);
  const latestQueue = latestQueuePoint(queuePoints);
  const baselineQueue = latestQueue ? baselineQueuePoint(queuePoints, latestQueue.generatedAt, windowDays) : null;
  const stalePullRequestRate = latestQueue ? staleRate(latestQueue) : null;
  const baselineStaleRate = baselineQueue ? staleRate(baselineQueue) : null;
  const duplicateTrend = latestQueue && baselineQueue ? latestQueue.collisionClusters - baselineQueue.collisionClusters : null;
  const reviewVelocityPerDay = round((mergedPullRequests + closedUnmergedPullRequests) / observedDays);
  const pullRequestGrowth = latest.openPullRequestsTotal - baseline.openPullRequestsTotal;
  return {
    windowDays,
    status: "ready",
    observedDays,
    baselineAt: baseline.fetchedAt,
    latestAt: latest.fetchedAt,
    pullRequestGrowth,
    issueGrowth: latest.openIssuesTotal - baseline.openIssuesTotal,
    mergedPullRequests,
    closedUnmergedPullRequests,
    reviewVelocityPerDay,
    stalePullRequestRate,
    stalePullRequestRateDelta: stalePullRequestRate !== null && baselineStaleRate !== null ? round(stalePullRequestRate - baselineStaleRate) : null,
    duplicateTrend,
    summary: `${windowDays}d trend: PR queue ${signed(pullRequestGrowth)}, review velocity ${reviewVelocityPerDay}/day.`,
  };
}

function trendWarnings(windows: QueueTrendWindow[]): string[] {
  const warnings: string[] = [];
  for (const window of windows.filter((entry) => entry.status === "ready")) {
    if ((window.pullRequestGrowth ?? 0) >= 5) warnings.push(`${window.windowDays}d PR queue grew by ${window.pullRequestGrowth}; review load is increasing.`);
    if ((window.stalePullRequestRate ?? 0) >= 0.35) warnings.push(`${window.windowDays}d stale PR rate is ${Math.round((window.stalePullRequestRate ?? 0) * 100)}%.`);
    if ((window.duplicateTrend ?? 0) > 0) warnings.push(`${window.windowDays}d duplicate cluster count increased by ${window.duplicateTrend}.`);
  }
  return [...new Set(warnings)].slice(0, 5);
}

function queuePointFromSignalSnapshot(snapshot: SignalSnapshotRecord): QueueHealthTrendPoint[] {
  const signals = readSignals(snapshot.payload);
  return signals && snapshot.generatedAt ? [{ ...signals, generatedAt: snapshot.generatedAt }] : [];
}

function queuePointFromQueueHealth(queueHealth: QueueHealth): QueueHealthTrendPoint {
  return {
    generatedAt: queueHealth.generatedAt,
    openPullRequests: queueHealth.signals.openPullRequests,
    stalePullRequests: queueHealth.signals.stalePullRequests,
    collisionClusters: queueHealth.signals.collisionClusters,
  };
}

function readSignals(payload: Record<string, JsonValue>): Omit<QueueHealthTrendPoint, "generatedAt"> | null {
  const signals = isRecord(payload.signals) ? payload.signals : null;
  if (!signals) return null;
  return {
    openPullRequests: numberValue(signals.openPullRequests),
    stalePullRequests: numberValue(signals.stalePullRequests),
    collisionClusters: numberValue(signals.collisionClusters),
  };
}

function baselineQueuePoint(points: QueueHealthTrendPoint[], latestAt: string, windowDays: number): QueueHealthTrendPoint | null {
  const latestMs = Date.parse(latestAt);
  const targetMs = latestMs - windowDays * 24 * 60 * 60 * 1000;
  return [...points].reverse().find((point) => Date.parse(point.generatedAt) <= targetMs) ?? null;
}

function latestQueuePoint(points: QueueHealthTrendPoint[]): QueueHealthTrendPoint | null {
  return points.at(-1) ?? null;
}

function unavailableWindow(windowDays: 7 | 14 | 30, summary: string): QueueTrendWindow {
  return {
    windowDays,
    status: "unavailable",
    observedDays: 0,
    baselineAt: null,
    latestAt: null,
    pullRequestGrowth: null,
    issueGrowth: null,
    mergedPullRequests: null,
    closedUnmergedPullRequests: null,
    reviewVelocityPerDay: null,
    stalePullRequestRate: null,
    stalePullRequestRateDelta: null,
    duplicateTrend: null,
    summary,
  };
}

function staleRate(point: QueueHealthTrendPoint): number {
  return point.openPullRequests > 0 ? round(point.stalePullRequests / point.openPullRequests) : 0;
}

function sortTotals(snapshots: RepoGithubTotalsSnapshotRecord[]): RepoGithubTotalsSnapshotRecord[] {
  const sorted = snapshots
    .filter((snapshot) => Number.isFinite(Date.parse(snapshot.fetchedAt)))
    .sort((left, right) => Date.parse(left.fetchedAt) - Date.parse(right.fetchedAt));
  const collapsed: RepoGithubTotalsSnapshotRecord[] = [];
  for (const snapshot of sorted) {
    const previous = collapsed.at(-1);
    if (previous?.fetchedAt === snapshot.fetchedAt) {
      collapsed[collapsed.length - 1] = snapshot;
      continue;
    }
    collapsed.push(snapshot);
  }
  return collapsed;
}

function sortQueuePoints(points: QueueHealthTrendPoint[]): QueueHealthTrendPoint[] {
  return points.filter((point) => Number.isFinite(Date.parse(point.generatedAt))).sort((left, right) => Date.parse(left.generatedAt) - Date.parse(right.generatedAt));
}

function numberValue(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
