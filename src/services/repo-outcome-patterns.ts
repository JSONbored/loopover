import {
  getRepoSyncState,
  getRepository,
  listPullRequestDetailSyncStates,
  listPullRequests,
  listRecentMergedPullRequests,
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
  await Promise.all(
    repositories
      .filter((repo) => repo.isRegistered)
      .map(async (repo) => {
        const latest = (await listSignalSnapshots(env, REPO_OUTCOME_PATTERNS_SIGNAL, repo.fullName))[0];
        if (latest) map.set(repo.fullName.toLowerCase(), latest.payload as unknown as RepoOutcomePatterns);
      }),
  );
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
