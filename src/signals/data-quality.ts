import type { BountyRecord, DataQuality, PullRequestDetailSyncStateRecord, RegistrySnapshot, RepoGithubTotalsSnapshotRecord, RepoSyncSegmentRecord, RepoSyncStateRecord, ScoringModelSnapshotRecord, SignalSnapshotRecord } from "../types";
import { nowIso } from "../utils/json";

const DEFAULT_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const FRESHNESS_SLO_MS = {
  registry: DEFAULT_STALE_MS,
  scoring_model: DEFAULT_STALE_MS,
  github_totals: DEFAULT_STALE_MS,
  repo_segments: DEFAULT_STALE_MS,
  decision_pack: 6 * 60 * 60 * 1000,
  bounty_data: 24 * 60 * 60 * 1000,
  signal_snapshot: 12 * 60 * 60 * 1000,
};
const LAUNCH_BLOCKING_FRESHNESS_AREAS = new Set<keyof typeof FRESHNESS_SLO_MS>(["registry", "scoring_model", "github_totals", "repo_segments"]);
const COMPLETE_SEGMENT_STATUSES = new Set<RepoSyncSegmentRecord["status"]>(["complete", "not_modified", "sampled"]);
const BLOCKING_SEGMENT_STATUSES = new Set<RepoSyncSegmentRecord["status"]>(["error", "rate_limited", "waiting_rate_limit", "skipped"]);
const REQUIRED_OPEN_SEGMENTS = new Set<RepoSyncSegmentRecord["segment"]>(["metadata", "labels", "open_issues", "open_pull_requests", "pull_request_files", "pull_request_reviews", "check_summaries"]);

export type SignalFidelity = {
  status: "complete" | "degraded" | "blocked" | "unknown";
  repoCount: number;
  completeRepos: number;
  degradedRepos: number;
  blockedRepos: number;
  partialRepos: string[];
  cappedRepos: string[];
  staleRepos: string[];
  rateLimitedRepos: string[];
  nextRecoverableAt?: string | null | undefined;
};

export type CoreSignalFidelity = {
  status: "complete" | "degraded" | "blocked" | "unknown";
  repoCount: number;
  completeRepos: number;
  degradedRepos: number;
  blockedRepos: number;
  incompleteRepos: string[];
  refreshingRepos: string[];
  waitingForRateLimitRepos: string[];
  historyCoverage: "sampled" | "counts_only" | "full";
};

export type FreshnessSloReport = {
  status: "fresh" | "degraded" | "blocked";
  generatedAt: string;
  staleCount: number;
  degradedCount: number;
  blockedCount: number;
  missingCount: number;
  launchBlockingCount: number;
  repairRecommended: boolean;
  items: Array<{ area: keyof typeof FRESHNESS_SLO_MS; targetKey: string; status: "fresh" | "stale" | "degraded" | "blocked" | "missing"; launchBlocking: boolean; ageSeconds?: number; sloSeconds: number; breachSeconds?: number; observedAt?: string | null; summary: string }>;
  warnings: string[];
};

export function buildFreshnessSloReport(args: {
  registrySnapshot?: RegistrySnapshot | null;
  scoringSnapshot?: ScoringModelSnapshotRecord | null;
  repoCount?: number;
  syncStates?: RepoSyncStateRecord[];
  totals?: RepoGithubTotalsSnapshotRecord[];
  segments?: RepoSyncSegmentRecord[];
  signalSnapshots?: SignalSnapshotRecord[];
  bounties?: BountyRecord[];
  expectedDecisionPackKeys?: string[];
  nowMs?: number;
}): FreshnessSloReport {
  const nowMs = args.nowMs ?? Date.now();
  const items: FreshnessSloReport["items"] = [];
  const add = (area: keyof typeof FRESHNESS_SLO_MS, targetKey: string, observedAt: string | null | undefined, forced?: "blocked" | "degraded" | "missing") => {
    const observedMs = observedAt ? Date.parse(observedAt) : NaN;
    const validObservedAt = observedAt && Number.isFinite(observedMs) ? observedAt : null;
    // Compare staleness in milliseconds (matching isStale below), not on the floored-to-seconds age:
    // `ageSeconds * 1000 > SLO_MS` drops the sub-second remainder, so an age up to 999ms past the SLO is
    // wrongly reported "fresh". ageSeconds stays floored for display; the threshold check uses raw ms.
    const ageMs = validObservedAt ? Math.max(0, nowMs - observedMs) : undefined;
    const ageSeconds = ageMs !== undefined ? Math.floor(ageMs / 1000) : undefined;
    const status = forced ?? (!validObservedAt ? "missing" : ageMs !== undefined && ageMs > FRESHNESS_SLO_MS[area] ? "stale" : "fresh");
    const launchBlocking = status !== "fresh" && LAUNCH_BLOCKING_FRESHNESS_AREAS.has(area);
    items.push({ area, targetKey, status, launchBlocking, ...(ageSeconds !== undefined ? { ageSeconds, breachSeconds: Math.max(0, ageSeconds - Math.floor(FRESHNESS_SLO_MS[area] / 1000)) } : {}), sloSeconds: Math.floor(FRESHNESS_SLO_MS[area] / 1000), observedAt: validObservedAt, summary: `${area}:${targetKey} is ${status}` });
  };
  if ("registrySnapshot" in args) add("registry", "latest", args.registrySnapshot?.fetchedAt);
  if ("scoringSnapshot" in args) add("scoring_model", "latest", args.scoringSnapshot?.fetchedAt);
  if ("totals" in args && (args.repoCount ?? 0) > 0) add("github_totals", "registered_repos", oldest(args.totals?.map((total) => total.fetchedAt)), args.totals?.length ? undefined : "missing");
  if ((args.repoCount ?? 0) > 0) {
    const segmentBlocked = args.segments?.some((segment) => BLOCKING_SEGMENT_STATUSES.has(segment.status) && !hasEffectiveSegmentCoverage(segment)) || args.syncStates?.some((state) => ["error", "skipped", "rate_limited"].includes(state.status));
    const segmentDegraded = args.syncStates?.some((state) => !["success", "never_synced"].includes(state.status));
    add("repo_segments", "registered_repos", oldest(args.segments?.map((segment) => segment.completedAt ?? segment.updatedAt)), segmentBlocked ? "blocked" : segmentDegraded ? "degraded" : args.segments?.length ? undefined : "missing");
  }
  for (const [key, snapshots] of groupBy(args.signalSnapshots ?? [], (snapshot) => `${snapshot.signalType}\0${snapshot.targetKey}`)) {
    const type = snapshots[0]?.signalType ?? key;
    const targetKey = snapshots[0]?.targetKey ?? type;
    add(type === "contributor-decision-pack" ? "decision_pack" : "signal_snapshot", targetKey ?? type, newest(snapshots.map((snapshot) => snapshot.generatedAt)));
  }
  for (const key of args.expectedDecisionPackKeys ?? []) {
    if (!items.some((item) => item.area === "decision_pack" && item.targetKey === key)) add("decision_pack", key, null, "missing");
  }
  if (args.bounties?.length) add("bounty_data", "all_bounties", oldest(args.bounties.map((bounty) => bounty.updatedAt ?? bounty.discoveredAt)));
  const staleCount = items.filter((item) => item.status === "stale").length;
  const degradedCount = items.filter((item) => item.status === "degraded").length;
  const blockedCount = items.filter((item) => item.status === "blocked").length;
  const missingCount = items.filter((item) => item.status === "missing").length;
  const launchBlockingCount = items.filter((item) => item.launchBlocking).length;
  const status = blockedCount > 0 ? "blocked" : staleCount + degradedCount + missingCount > 0 ? "degraded" : "fresh";
  return { status, generatedAt: nowIso(), staleCount, degradedCount, blockedCount, missingCount, launchBlockingCount, repairRecommended: status !== "fresh", items, warnings: items.filter((item) => item.status !== "fresh").map((item) => item.summary) };
}

export function freshnessAuditMetadata(report: FreshnessSloReport) {
  return {
    status: report.status,
    staleCount: report.staleCount,
    degradedCount: report.degradedCount,
    blockedCount: report.blockedCount,
    missingCount: report.missingCount,
    launchBlockingCount: report.launchBlockingCount,
    repairRecommended: report.repairRecommended,
    affectedAreas: [...new Set(report.items.filter((item) => item.status !== "fresh").map((item) => item.area))],
  };
}

export function buildRepoDataQuality(
  repoFullName: string,
  syncState: RepoSyncStateRecord | null | undefined,
  segments: RepoSyncSegmentRecord[],
  options: { staleMs?: number; nowMs?: number } = {},
): DataQuality {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const nowMs = options.nowMs ?? Date.now();
  const scopedSegments = segments.filter((segment) => segment.repoFullName === repoFullName);
  const incompleteSegments = scopedSegments
    .filter((segment) => !hasEffectiveSegmentCoverage(segment))
    .map((segment) => segment.segment)
    .sort();
  const cappedSegments = scopedSegments.filter((segment) => segment.status === "capped").map((segment) => segment.segment).sort();
  const rateLimitedSegments = scopedSegments
    .filter((segment) => segment.status === "rate_limited" && !hasEffectiveSegmentCoverage(segment))
    .map((segment) => segment.segment)
    .sort();
  const waitingRateLimitSegments = scopedSegments
    .filter((segment) => segment.status === "waiting_rate_limit" && !hasEffectiveSegmentCoverage(segment))
    .map((segment) => segment.segment)
    .sort();
  const staleSegments = scopedSegments
    .filter((segment) => segment.status === "stale" || isStale(segment.completedAt ?? syncState?.lastCompletedAt, staleMs, nowMs))
    .map((segment) => segment.segment)
    .sort();
  const stateStatus = syncState?.status;
  const hasEffectiveCoverage = scopedSegments.length > 0 && scopedSegments.every((segment) => hasEffectiveSegmentCoverage(segment));
  const activeStateWarnings = stateStatus === "success" && hasEffectiveCoverage ? [] : (syncState?.warnings ?? []);
  const allBlockingSegmentsRecovered =
    scopedSegments.length > 0 && scopedSegments.every((segment) => !BLOCKING_SEGMENT_STATUSES.has(segment.status) || hasEffectiveSegmentCoverage(segment));
  const stateBlocked = stateStatus === "error" || stateStatus === "skipped" || (stateStatus === "rate_limited" && !allBlockingSegmentsRecovered);
  const statePartial = stateStatus === "partial" || stateStatus === "capped";
  const segmentBlocked = scopedSegments.some((segment) => BLOCKING_SEGMENT_STATUSES.has(segment.status) && !hasEffectiveSegmentCoverage(segment));
  const blocked = stateBlocked || segmentBlocked;
  const partial = statePartial || incompleteSegments.length > 0;
  const stale = stateStatus === "stale" || isStale(syncState?.lastCompletedAt ?? syncState?.updatedAt, staleMs, nowMs) || staleSegments.length > 0;
  const capped = cappedSegments.length > 0 || stateStatus === "capped" || Boolean(activeStateWarnings.some((warning) => /cap|capped/i.test(warning)));
  const rateLimited =
    rateLimitedSegments.length > 0 ||
    waitingRateLimitSegments.length > 0 ||
    (stateStatus === "rate_limited" && !allBlockingSegmentsRecovered) ||
    Boolean(activeStateWarnings.some((warning) => /rate.?limit/i.test(warning)));
  const status: DataQuality["status"] = !syncState
    ? "unknown"
    : blocked
      ? "blocked"
      : partial || stale || capped || rateLimited
        ? "degraded"
        : "complete";
  const activeSyncWarnings = status === "complete" ? [] : (syncState?.warnings ?? []);
  const warnings = [
    ...(!syncState ? [`No repository sync state is available for ${repoFullName}.`] : []),
    ...(partial ? [`Repository sync for ${repoFullName} is incomplete or partial.`] : []),
    ...(capped ? [`Repository sync for ${repoFullName} hit a local pagination cap; large-queue signals may be undercounted.`] : []),
    ...(stale ? [`Repository sync for ${repoFullName} is stale; recommendations should be treated as lower confidence.`] : []),
    ...(rateLimited ? [`Repository sync for ${repoFullName} encountered GitHub rate limiting.`] : []),
    ...(status !== "complete" && syncState?.errorSummary ? [`Latest sync error for ${repoFullName}: ${syncState.errorSummary}`] : []),
  ];
  return {
    status,
    generatedAt: nowIso(),
    repoFullName,
    stale,
    partial,
    capped,
    rateLimited,
    segmentCount: scopedSegments.length,
    incompleteSegments,
    cappedSegments,
    staleSegments,
    rateLimitedSegments: [...new Set([...rateLimitedSegments, ...waitingRateLimitSegments])],
    warnings: [...new Set([...warnings, ...activeSyncWarnings])],
    syncState: syncState
      ? {
          status: syncState.status,
          lastCompletedAt: syncState.lastCompletedAt,
          updatedAt: syncState.updatedAt,
          warnings: syncState.warnings,
        }
      : undefined,
  };
}

export function buildCoreSignalFidelity(
  repoCount: number,
  states: RepoSyncStateRecord[],
  segments: RepoSyncSegmentRecord[],
  totals: RepoGithubTotalsSnapshotRecord[],
  detailStates: PullRequestDetailSyncStateRecord[] = [],
): CoreSignalFidelity {
  const repoNames = [...new Set([...states.map((state) => state.repoFullName), ...segments.map((segment) => segment.repoFullName), ...totals.map((total) => total.repoFullName)])].sort();
  const totalsByRepo = new Map(totals.map((total) => [total.repoFullName, total]));
  const segmentsByRepo = groupByRepo(segments);
  const detailsByRepo = groupByRepo(detailStates);
  const incompleteRepos: string[] = [];
  const refreshingRepos: string[] = [];
  const waitingForRateLimitRepos: string[] = [];
  const blockedRepos: string[] = [];
  let completeRepos = 0;
  let hasHistoricalSample = false;
  let hasFullHistory = repoNames.length > 0;

  for (const repoFullName of repoNames) {
    const state = states.find((record) => record.repoFullName === repoFullName);
    const repoTotals = totalsByRepo.get(repoFullName);
    const repoSegments = segmentsByRepo.get(repoFullName) ?? [];
    const repoDetails = detailsByRepo.get(repoFullName) ?? [];
    const requiredSegments = repoSegments.filter((segment) => REQUIRED_OPEN_SEGMENTS.has(segment.segment));
    const historySegment = repoSegments.find((segment) => segment.segment === "recent_merged_pull_requests");
    if ((historySegment?.fetchedCount ?? 0) > 0) hasHistoricalSample = true;
    if (!historySegment || !repoTotals || historySegment.status !== "complete" || historySegment.fetchedCount < repoTotals.mergedPullRequestsTotal) hasFullHistory = false;

    const repoWaiting = requiredSegments.some((segment) => {
      const expected = expectedForRequiredSegment(segment, repoTotals);
      return (segment.status === "waiting_rate_limit" || segment.status === "rate_limited") && !hasCompleteCountCoverage(segment, expected);
    });
    const repoRefreshing = requiredSegments.some((segment) => segment.status === "running" || segment.status === "refreshing");
    const repoHardBlocked = state?.status === "error" || state?.status === "skipped";
    const repoStateRateLimited = state?.status === "rate_limited";
    const missingRequired = !state || !repoTotals || REQUIRED_OPEN_SEGMENTS.size > requiredSegments.length;
    const openIssues = repoSegments.find((segment) => segment.segment === "open_issues");
    const openPullRequests = repoSegments.find((segment) => segment.segment === "open_pull_requests");
    const labels = repoSegments.find((segment) => segment.segment === "labels");
    const detailCompleteCount = repoDetails.filter((detail) => detail.status === "complete").length;
    const requiredIncomplete =
      missingRequired ||
      !isCompleteCount(openIssues, repoTotals?.openIssuesTotal) ||
      !isCompleteCount(openPullRequests, repoTotals?.openPullRequestsTotal) ||
      !isCompleteCount(labels, repoTotals?.labelsTotal) ||
      detailCompleteCount < (repoTotals?.openPullRequestsTotal ?? 0) ||
      requiredSegments.some((segment) => !hasUsableRequiredSegmentCoverage(segment, expectedForRequiredSegment(segment, repoTotals)));
    const repoBlocked = repoWaiting || repoHardBlocked || (repoStateRateLimited && requiredIncomplete);

    if (repoBlocked) blockedRepos.push(repoFullName);
    if (repoRefreshing) refreshingRepos.push(repoFullName);
    if (repoWaiting) waitingForRateLimitRepos.push(repoFullName);
    if (requiredIncomplete) incompleteRepos.push(repoFullName);
    if (!repoBlocked && !requiredIncomplete) completeRepos += 1;
  }

  const missingRepoCount = Math.max(repoCount - repoNames.length, 0);
  const status: CoreSignalFidelity["status"] =
    repoCount === 0 || repoNames.length === 0
      ? "unknown"
      : blockedRepos.length > 0
        ? "blocked"
        : incompleteRepos.length > 0 || missingRepoCount > 0
          ? "degraded"
          : "complete";
  return {
    status,
    repoCount,
    completeRepos,
    degradedRepos: incompleteRepos.filter((repo) => !blockedRepos.includes(repo)).length + missingRepoCount,
    blockedRepos: blockedRepos.length,
    incompleteRepos,
    refreshingRepos,
    waitingForRateLimitRepos,
    historyCoverage: hasFullHistory ? "full" : hasHistoricalSample ? "sampled" : "counts_only",
  };
}

export function attachDataQuality<T extends Record<string, unknown>>(payload: T, dataQuality: DataQuality): T & { dataQuality: DataQuality } {
  return { ...payload, dataQuality };
}

export function buildSignalFidelity(repoCount: number, states: RepoSyncStateRecord[], segments: RepoSyncSegmentRecord[]): SignalFidelity {
  const segmentRepos = new Map<string, RepoSyncSegmentRecord[]>();
  for (const segment of segments) {
    const existing = segmentRepos.get(segment.repoFullName) ?? [];
    existing.push(segment);
    segmentRepos.set(segment.repoFullName, existing);
  }
  const repoNames = [...new Set([...states.map((state) => state.repoFullName), ...segments.map((segment) => segment.repoFullName)])].sort();
  const qualities = repoNames.map((repoFullName) =>
    buildRepoDataQuality(
      repoFullName,
      states.find((state) => state.repoFullName === repoFullName),
      segmentRepos.get(repoFullName) ?? [],
    ),
  );
  const partialRepos = qualities.filter((quality) => quality.partial || quality.status === "unknown").map((quality) => quality.repoFullName ?? "");
  const cappedRepos = qualities.filter((quality) => quality.capped).map((quality) => quality.repoFullName ?? "");
  const staleRepos = qualities.filter((quality) => quality.stale).map((quality) => quality.repoFullName ?? "");
  const rateLimitedRepos = qualities.filter((quality) => quality.rateLimited).map((quality) => quality.repoFullName ?? "");
  const blockedRepos = qualities.filter((quality) => quality.status === "blocked").map((quality) => quality.repoFullName ?? "");
  const rateLimitResetValues = segments.flatMap((segment) =>
    (segment.status === "rate_limited" || segment.status === "waiting_rate_limit") && segment.rateLimitResetAt && !hasEffectiveSegmentCoverage(segment) ? [segment.rateLimitResetAt] : [],
  );
  const missingRepoCount = Math.max(repoCount - states.length, 0);
  const status: SignalFidelity["status"] =
    repoCount === 0 || qualities.length === 0
      ? "unknown"
      : blockedRepos.length > 0
        ? "blocked"
        : missingRepoCount > 0 || partialRepos.length > 0 || cappedRepos.length > 0 || staleRepos.length > 0 || rateLimitedRepos.length > 0
          ? "degraded"
          : "complete";
  return {
    status,
    repoCount,
    completeRepos: qualities.filter((quality) => quality.status === "complete").length,
    degradedRepos: qualities.filter((quality) => quality.status === "degraded" || quality.status === "unknown").length + missingRepoCount,
    blockedRepos: blockedRepos.length,
    partialRepos,
    cappedRepos,
    staleRepos,
    rateLimitedRepos,
    nextRecoverableAt: rateLimitResetValues.sort()[0],
  };
}

function isStale(value: string | null | undefined, staleMs: number, nowMs: number): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && nowMs - parsed > staleMs;
}

function groupByRepo<T extends { repoFullName: string }>(records: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const existing = grouped.get(record.repoFullName) ?? [];
    existing.push(record);
    grouped.set(record.repoFullName, existing);
  }
  return grouped;
}

function groupBy<T>(records: T[], keyFor: (record: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const key = keyFor(record);
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  return grouped;
}

function oldest(values: Array<string | null | undefined> | undefined): string | null | undefined {
  return values?.filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value)))).sort()[0];
}

function newest(values: Array<string | null | undefined> | undefined): string | null | undefined {
  return values?.filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value)))).sort().at(-1);
}

function isCompleteCount(segment: RepoSyncSegmentRecord | undefined, expected: number | null | undefined): boolean {
  return Boolean(segment && hasCompleteCountCoverage(segment, expected) && hasUsableRequiredSegmentCoverage(segment, expected));
}

function hasUsableRequiredSegmentCoverage(segment: RepoSyncSegmentRecord, expected?: number | null): boolean {
  if (segment.status === "complete" || segment.status === "not_modified") return true;
  if ((segment.status === "waiting_rate_limit" || segment.status === "rate_limited") && hasCompleteCountCoverage(segment, expected)) return true;
  return (segment.status === "running" || segment.status === "refreshing") && Boolean(segment.completedAt);
}

function hasEffectiveSegmentCoverage(segment: RepoSyncSegmentRecord): boolean {
  return COMPLETE_SEGMENT_STATUSES.has(segment.status) || hasCompleteCountCoverage(segment, segment.expectedCount);
}

function hasCompleteCountCoverage(segment: RepoSyncSegmentRecord, expected: number | null | undefined): boolean {
  return Boolean(segment.completedAt && expected !== null && expected !== undefined && segment.fetchedCount >= expected);
}

function expectedForRequiredSegment(segment: RepoSyncSegmentRecord, repoTotals: RepoGithubTotalsSnapshotRecord | undefined): number | null | undefined {
  if (!repoTotals) return segment.expectedCount;
  switch (segment.segment) {
    case "metadata":
      return 1;
    case "labels":
      return repoTotals.labelsTotal;
    case "open_issues":
      return repoTotals.openIssuesTotal;
    case "open_pull_requests":
    case "pull_request_files":
    case "pull_request_reviews":
    case "check_summaries":
      return repoTotals.openPullRequestsTotal;
    default:
      return segment.expectedCount;
  }
}
