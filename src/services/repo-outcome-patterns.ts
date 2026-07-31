import {
  getRepoSyncState,
  getRepository,
  listPullRequestDetailSyncStates,
  listPullRequests,
  listRecentMergedPullRequests,
  listRecentSignalSnapshotsForTargets,
  listRepoPullRequestFiles,
  listRepoPullRequestReviews,
  listSignalSnapshots,
} from "../db/repositories";
import { buildRepoOutcomePatterns, type RepoOutcomePatterns } from "../signals/engine";

export const REPO_OUTCOME_PATTERNS_SIGNAL = "repo-outcome-patterns";
export const REPO_OUTCOME_PATTERNS_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type RepoOutcomePatternsFreshness = "fresh" | "stale";

export type RepoOutcomePatternsResponse = {
  status: "ready";
  source: "snapshot" | "computed";
  repoFullName: string;
  generatedAt: string;
  ageSeconds: number;
  freshness: RepoOutcomePatternsFreshness;
  patterns: RepoOutcomePatterns;
};

export async function loadOrComputeRepoOutcomePatternsResponse(env: Env, fullName: string): Promise<RepoOutcomePatternsResponse | null> {
  const cached = (await listSignalSnapshots(env, REPO_OUTCOME_PATTERNS_SIGNAL, fullName))[0];
  if (cached) {
    const payload = cached.payload as unknown as RepoOutcomePatterns;
    const generatedAt = cached.generatedAt ?? payload.generatedAt ?? new Date().toISOString();
    const ageMs = snapshotAgeMs(generatedAt);
    return {
      status: "ready",
      source: "snapshot",
      repoFullName: fullName,
      generatedAt,
      ageSeconds: Math.max(0, Math.floor(ageMs / 1000)),
      freshness: ageMs > REPO_OUTCOME_PATTERNS_MAX_AGE_MS ? "stale" : "fresh",
      patterns: payload,
    };
  }
  const repo = await getRepository(env, fullName);
  if (!repo) return null;
  const patterns = await computeRepoOutcomePatterns(env, fullName, repo);
  return {
    status: "ready",
    source: "computed",
    repoFullName: fullName,
    generatedAt: patterns.generatedAt,
    ageSeconds: 0,
    freshness: "fresh",
    patterns,
  };
}

export async function loadRepoOutcomePatternsMap(env: Env, repositories: Array<{ fullName: string; isRegistered: boolean }>): Promise<Map<string, RepoOutcomePatterns>> {
  const map = new Map<string, RepoOutcomePatterns>();
  // #10024: one BULK read (batched internally at SIGNAL_SNAPSHOT_TARGET_KEY_SQL_BATCH keys/round-trip) instead
  // of one listSignalSnapshots query per registered repo, each of which pulled up to 100 full payloads to use
  // exactly one. listRecentSignalSnapshotsForTargets (not the Latest variant) is the one that selects
  // payload_json; maxPerTarget 1 = only the newest snapshot per repo. Mirrors repo-doc-refresh-runner's sweep.
  const fullNames = repositories.filter((repo) => repo.isRegistered).map((repo) => repo.fullName);
  const byTargetKey = await listRecentSignalSnapshotsForTargets(env, REPO_OUTCOME_PATTERNS_SIGNAL, fullNames, 1);
  for (const repo of repositories) {
    if (!repo.isRegistered) continue;
    // listRecentSignalSnapshotsForTargets keys by the exact targetKey string, so read by fullName and lowercase
    // on the way out to preserve the map's existing lowercased-key contract (decision-pack.ts's lookups).
    const latest = byTargetKey.get(repo.fullName)?.[0];
    if (latest) map.set(repo.fullName.toLowerCase(), latest.payload as unknown as RepoOutcomePatterns);
  }
  return map;
}

export async function computeRepoOutcomePatterns(env: Env, fullName: string, repo?: Awaited<ReturnType<typeof getRepository>>): Promise<RepoOutcomePatterns> {
  const [resolvedRepo, pullRequests, recentMergedPullRequests, files, reviews, detailSyncStates, syncState] = await Promise.all([
    repo ? Promise.resolve(repo) : getRepository(env, fullName),
    listPullRequests(env, fullName),
    listRecentMergedPullRequests(env, fullName),
    listRepoPullRequestFiles(env, fullName),
    listRepoPullRequestReviews(env, fullName),
    listPullRequestDetailSyncStates(env, fullName),
    getRepoSyncState(env, fullName),
  ]);
  return buildRepoOutcomePatterns({
    repo: resolvedRepo,
    repoFullName: fullName,
    pullRequests,
    recentMergedPullRequests,
    files,
    reviews,
    detailSyncStates,
    syncState,
  });
}

function snapshotAgeMs(generatedAt: string): number {
  const parsed = Date.parse(generatedAt);
  return Number.isFinite(parsed) ? Date.now() - parsed : Number.POSITIVE_INFINITY;
}
