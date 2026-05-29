import {
  getRepositorySettings,
  getRepository,
  countOpenIssues,
  countOpenPullRequests,
  countRecentMergedPullRequests,
  countRepoLabels,
  getLatestRepoGithubTotalsSnapshot,
  getRepoSyncSegment,
  getRepoSyncState,
  listLatestGitHubRateLimitObservations,
  listOpenIssueNumbers,
  listOpenPullRequests,
  listInstallations,
  listPullRequestDetailSyncStates,
  listRepositories,
  markUnseenOpenIssuesClosed,
  markUnseenOpenPullRequestsClosed,
  persistRepoGithubTotalsSnapshot,
  recordGitHubRateLimitObservation,
  upsertInstallation,
  upsertCheckSummary,
  upsertContributor,
  upsertContributorRepoStat,
  upsertInstallationHealth,
  upsertIssueFromGitHub,
  upsertPullRequestFile,
  upsertPullRequestDetailSyncState,
  upsertPullRequestFromGitHub,
  upsertPullRequestReview,
  upsertRecentMergedPullRequest,
  upsertRepoLabel,
  upsertRepoSyncSegment,
  upsertRepoSyncState,
  upsertRepositoryFromGitHub,
  persistRepoSnapshot,
} from "../db/repositories";
import type {
  ContributorRepoStatRecord,
  GitHubRateLimitObservationRecord,
  GitHubIssuePayload,
  GitHubPullRequestPayload,
  GitHubRepositoryPayload,
  InstallationHealthRecord,
  InstallationRecord,
  JsonValue,
  PullRequestRecord,
  RecentMergedPullRequestRecord,
  RepoGithubTotalsSnapshotRecord,
  RepoSyncSegmentRecord,
  RepoSyncStateRecord,
  RepositoryRecord,
} from "../types";
import { errorMessage, nowIso, repoParts, strippedErrorMessage } from "../utils/json";
import { createInstallationToken, getAppInstallation } from "./app";

type GitHubLabelPayload = {
  name: string;
  color?: string;
  description?: string | null;
};

type GitHubFilePayload = {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  previous_filename?: string;
};

type GitHubReviewPayload = {
  id: number;
  user?: { login?: string };
  state?: string;
  author_association?: string;
  submitted_at?: string | null;
};

type GitHubCheckRunPayload = {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  details_url?: string | null;
  html_url?: string | null;
};

type BackfillLimits = {
  issues: number;
  pullRequests: number;
  recentMergedPullRequests: number;
  pullRequestDetails: number;
  repoConcurrency: number;
  detailConcurrency: number;
};

type BackfillMode = "light" | "full" | "resume";
type BackfillSegmentName = "labels" | "open_issues" | "open_pull_requests" | "recent_merged_pull_requests";

export type BackfillRegisteredReposResult = {
  ok: true;
  repoCount: number;
  repos: RepoBackfillResult[];
};

export type RepoBackfillResult = {
  repoFullName: string;
  status: "success" | "partial" | "capped" | "rate_limited" | "error" | "skipped";
  openIssues: number;
  openPullRequests: number;
  recentMergedPullRequests: number;
  warnings: string[];
  dataQuality?: {
    capped: boolean;
    rateLimited: boolean;
    partial: boolean;
    segmentStatuses: Record<string, string>;
  };
  errorSummary?: string;
};

export type RefreshContributorActivityResult = {
  ok: true;
  login: string;
  repoCount: number;
  updatedRepoStats: number;
  warnings: string[];
};

type GitHubGraphQlSearchNode = {
  __typename?: "PullRequest" | "Issue";
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  body?: string | null;
  updatedAt?: string | null;
  mergedAt?: string | null;
  labels?: { nodes?: Array<{ name?: string | null } | null> | null } | null;
};

type GitHubGraphQlSearchBucket = {
  issueCount?: number;
  nodes?: Array<GitHubGraphQlSearchNode | null> | null;
};

type GitHubGraphQlContributorSearchResponse = {
  data?: Record<string, GitHubGraphQlSearchBucket | undefined>;
  errors?: Array<{ message?: string }>;
};

type GitHubRepoTotalsResponse = {
  data?: {
    rateLimit?: { remaining?: number; resetAt?: string };
    repository?: {
      issues?: { totalCount?: number };
      openPullRequests?: { totalCount?: number };
      mergedPullRequests?: { totalCount?: number };
      closedPullRequests?: { totalCount?: number };
      labels?: { totalCount?: number };
    } | null;
  };
  errors?: Array<{ message?: string }>;
};

type GitHubOpenIssuesResponse = {
  data?: {
    repository?: {
      issues?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: Array<{
          number?: number;
          title?: string;
          state?: string;
          url?: string;
          body?: string | null;
          createdAt?: string | null;
          updatedAt?: string | null;
          authorAssociation?: string | null;
          author?: { login?: string | null } | null;
          labels?: { nodes?: Array<{ name?: string | null } | null> | null } | null;
        } | null>;
      };
    } | null;
    rateLimit?: { remaining?: number; resetAt?: string };
  };
  errors?: Array<{ message?: string }>;
};

type GitHubOpenPullRequestsResponse = {
  data?: {
    repository?: {
      pullRequests?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: Array<{
          number?: number;
          title?: string;
          state?: string;
          url?: string;
          body?: string | null;
          isDraft?: boolean | null;
          mergeable?: string | null;
          reviewDecision?: string | null;
          createdAt?: string | null;
          updatedAt?: string | null;
          authorAssociation?: string | null;
          author?: { login?: string | null } | null;
          headRefName?: string | null;
          baseRefName?: string | null;
          headRefOid?: string | null;
          labels?: { nodes?: Array<{ name?: string | null } | null> | null } | null;
        } | null>;
      };
    } | null;
    rateLimit?: { remaining?: number; resetAt?: string };
  };
  errors?: Array<{ message?: string }>;
};

type GitHubPullRequestDetailsResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        files?: {
          nodes?: Array<{
            path?: string | null;
            additions?: number | null;
            deletions?: number | null;
            changeType?: string | null;
          } | null> | null;
        } | null;
        reviews?: {
          nodes?: Array<{
            databaseId?: number | null;
            author?: { login?: string | null } | null;
            state?: string | null;
            authorAssociation?: string | null;
            submittedAt?: string | null;
          } | null> | null;
        } | null;
      } | null;
    } | null;
    rateLimit?: { remaining?: number; resetAt?: string };
  };
  errors?: Array<{ message?: string }>;
};

const MODE_LIMITS: Record<BackfillMode, BackfillLimits> = {
  light: {
    issues: 100,
    pullRequests: 100,
    recentMergedPullRequests: 200,
    pullRequestDetails: 12,
    repoConcurrency: 2,
    detailConcurrency: 4,
  },
  full: {
    issues: 1000,
    pullRequests: 1000,
    recentMergedPullRequests: 1000,
    pullRequestDetails: 50,
    repoConcurrency: 2,
    detailConcurrency: 4,
  },
  resume: {
    issues: 1000,
    pullRequests: 1000,
    recentMergedPullRequests: 1000,
    pullRequestDetails: 50,
    repoConcurrency: 2,
    detailConcurrency: 4,
  },
};

const DEFAULT_LIMITS: BackfillLimits = {
  issues: 100,
  pullRequests: 100,
  recentMergedPullRequests: 200,
  pullRequestDetails: 12,
  repoConcurrency: 2,
  detailConcurrency: 4,
};

const FRESH_SYNC_MS = 6 * 60 * 60 * 1000;
const ERROR_BACKOFF_MS = 60 * 60 * 1000;
const LOW_REST_RATE_LIMIT_REMAINING = 75;
const SEGMENT_PAGE_BUDGET: Record<BackfillMode, number> = { light: 2, full: 10, resume: 10 };
const PR_DETAIL_BATCH_SIZE: Record<BackfillMode, number> = { light: 12, full: 40, resume: 40 };
const CURRENT_OPEN_SCAN_MARKER = "gittensory-current-open-scan-v1";

export async function backfillRegisteredRepositories(
  env: Env,
  options: { repoFullName?: string; limits?: Partial<BackfillLimits>; requestedBy?: string; force?: boolean; mode?: BackfillMode } = {},
): Promise<BackfillRegisteredReposResult> {
  const repositories = (await listRepositories(env)).filter((repo) => repo.isRegistered && (!options.repoFullName || repo.fullName === options.repoFullName));
  const mode = options.mode ?? "light";
  const limits = { ...DEFAULT_LIMITS, ...MODE_LIMITS[mode], ...(options.limits ?? {}) };
  const repoResults = await mapWithConcurrency(repositories, limits.repoConcurrency, async (repo): Promise<RepoBackfillResult> => {
    const settings = await getRepositorySettings(env, repo.fullName);
    if (!settings.backfillEnabled) {
      const completedAt = nowIso();
      await upsertSkippedSegments(env, repo, mode, completedAt, ["Backfill is disabled for this repository."]);
      return {
        repoFullName: repo.fullName,
        status: "skipped",
        openIssues: 0,
        openPullRequests: 0,
        recentMergedPullRequests: 0,
        warnings: ["Backfill is disabled for this repository."],
      };
    }
    if (!repo.installationId && !env.GITHUB_PUBLIC_TOKEN) {
      const completedAt = nowIso();
      const warnings = ["GITHUB_PUBLIC_TOKEN is not configured; public GitHub backfill was skipped to avoid unauthenticated rate limits."];
      await upsertRepoSyncState(env, {
        repoFullName: repo.fullName,
        status: "skipped",
        sourceKind: "github",
        primaryLanguage: undefined,
        defaultBranch: repo.defaultBranch,
        isPrivate: repo.isPrivate,
        openIssuesCount: 0,
        openPullRequestsCount: 0,
        recentMergedPullRequestsCount: 0,
        lastStartedAt: completedAt,
        lastCompletedAt: completedAt,
        warnings,
      });
      await upsertSkippedSegments(env, repo, mode, completedAt, warnings);
      return {
        repoFullName: repo.fullName,
        status: "skipped",
        openIssues: 0,
        openPullRequests: 0,
        recentMergedPullRequests: 0,
        warnings,
      };
    }
    const syncState = await getRepoSyncState(env, repo.fullName);
    if (!options.force && syncState?.lastCompletedAt && syncState.status !== "never_synced") {
      const ageMs = Date.now() - Date.parse(syncState.lastCompletedAt);
      const freshSuccess =
        (syncState.status === "success" || syncState.status === "partial" || syncState.status === "capped") && Number.isFinite(ageMs) && ageMs < FRESH_SYNC_MS;
      const recentError = syncState.status === "error" && Number.isFinite(ageMs) && ageMs < ERROR_BACKOFF_MS;
      if (freshSuccess || recentError) {
        return {
          repoFullName: repo.fullName,
          status: "skipped",
          openIssues: syncState.openIssuesCount,
          openPullRequests: syncState.openPullRequestsCount,
          recentMergedPullRequests: syncState.recentMergedPullRequestsCount,
          warnings: [
            freshSuccess
              ? `Recent GitHub sync completed at ${syncState.lastCompletedAt}; use force=true for a manual refresh.`
              : `Recent GitHub sync error recorded at ${syncState.lastCompletedAt}; backing off unless force=true.`,
          ],
          ...(recentError && syncState.errorSummary ? { errorSummary: syncState.errorSummary } : {}),
        };
      }
    }
    return backfillRepository(env, repo, limits, mode);
  });
  return { ok: true, repoCount: repoResults.length, repos: repoResults.sort((left, right) => left.repoFullName.localeCompare(right.repoFullName)) };
}

export async function enqueueRepositoryOpenDataBackfill(
  env: Env,
  options: { repoFullName: string; requestedBy: "schedule" | "api" | "test"; mode?: BackfillMode; force?: boolean },
): Promise<{ ok: true; repoFullName: string; status: "queued" | "skipped"; totals?: RepoGithubTotalsSnapshotRecord; warnings: string[] }> {
  const repo = await getRepository(env, options.repoFullName);
  if (!repo?.isRegistered) return { ok: true, repoFullName: options.repoFullName, status: "skipped", warnings: ["Repository is not registered for Gittensory backfill."] };
  const mode = options.mode ?? "light";
  const settings = await getRepositorySettings(env, repo.fullName);
  if (!settings.backfillEnabled) return { ok: true, repoFullName: repo.fullName, status: "skipped", warnings: ["Backfill is disabled for this repository."] };
  const token = await tokenForRepo(env, repo);
  const sourceKind: RepoSyncSegmentRecord["sourceKind"] = repo.installationId && token !== env.GITHUB_PUBLIC_TOKEN ? "installation" : "github";
  const totals = token ? await refreshRepoGithubTotals(env, repo, token, sourceKind).catch(() => undefined) : undefined;
  const startedAt = nowIso();
  const previous = await getRepoSyncState(env, repo.fullName);
  await upsertRepoSyncState(env, {
    repoFullName: repo.fullName,
    status: "running",
    sourceKind,
    primaryLanguage: previous?.primaryLanguage,
    defaultBranch: previous?.defaultBranch ?? repo.defaultBranch,
    isPrivate: previous?.isPrivate ?? repo.isPrivate,
    openIssuesCount: previous?.openIssuesCount ?? totals?.openIssuesTotal ?? 0,
    openPullRequestsCount: previous?.openPullRequestsCount ?? totals?.openPullRequestsTotal ?? 0,
    recentMergedPullRequestsCount: previous?.recentMergedPullRequestsCount ?? 0,
    labelsSyncedAt: previous?.labelsSyncedAt,
    issuesSyncedAt: previous?.issuesSyncedAt,
    pullRequestsSyncedAt: previous?.pullRequestsSyncedAt,
    mergedPullRequestsSyncedAt: previous?.mergedPullRequestsSyncedAt,
    lastStartedAt: startedAt,
    lastCompletedAt: previous?.lastCompletedAt,
    warnings: previous?.warnings ?? [],
  });
  const segments: BackfillSegmentName[] = ["labels", "open_issues", "open_pull_requests", "recent_merged_pull_requests"];
  await Promise.all(
    segments.map((segment, index) =>
      env.JOBS.send(
        { type: "backfill-repo-segment", requestedBy: options.requestedBy, repoFullName: repo.fullName, segment, mode, ...(options.force === undefined ? {} : { force: options.force }) },
        { delaySeconds: index * 15 },
      ),
    ),
  );
  return {
    ok: true,
    repoFullName: repo.fullName,
    status: "queued",
    ...(totals ? { totals } : {}),
    warnings: totals ? [] : ["GitHub totals snapshot could not be refreshed before segment queueing."],
  };
}

export async function backfillRepositorySegment(
  env: Env,
  options: { repoFullName: string; segment: BackfillSegmentName; requestedBy?: string; mode?: BackfillMode; cursor?: string; force?: boolean },
): Promise<{ ok: true; repoFullName: string; segment: BackfillSegmentName; status: RepoSyncSegmentRecord["status"]; fetchedCount: number; expectedCount?: number | null; nextCursor?: string | null; warnings: string[] }> {
  const repo = await getRepository(env, options.repoFullName);
  if (!repo) return { ok: true, repoFullName: options.repoFullName, segment: options.segment, status: "skipped", fetchedCount: 0, warnings: ["Repository was not found."] };
  const mode = options.mode ?? "light";
  const token = await tokenForRepo(env, repo);
  const sourceKind: RepoSyncSegmentRecord["sourceKind"] = repo.installationId && token !== env.GITHUB_PUBLIC_TOKEN ? "installation" : "github";
  const resetAt = await shouldWaitForGitHubRateLimit(env);
  if (resetAt) {
    const previous = await getRepoSyncSegment(env, repo.fullName, options.segment);
    const segment = await completeSegment(env, repo, options.segment, sourceKind, mode, nowIso(), {
      status: "waiting_rate_limit",
      fetchedCount: previous?.fetchedCount ?? 0,
      expectedCount: previous?.expectedCount,
      pageCount: previous?.pageCount ?? 0,
      lastCursor: previous?.lastCursor,
      nextCursor: previous?.nextCursor ?? options.cursor,
      warnings: [`GitHub REST rate limit is low; retry after ${resetAt}.`],
      rateLimitResetAt: resetAt,
      errorSummary: `Waiting for GitHub rate limit reset at ${resetAt}.`,
    });
    await env.JOBS.send(
      { type: "backfill-repo-segment", requestedBy: options.requestedBy === "schedule" || options.requestedBy === "test" ? options.requestedBy : "api", repoFullName: repo.fullName, segment: options.segment, mode, force: true },
      { delaySeconds: delayUntil(resetAt) },
    );
    return segmentJobResult(repo.fullName, options.segment, segment);
  }
  const totals = (token ? await refreshRepoGithubTotals(env, repo, token, sourceKind).catch(() => undefined) : undefined) ?? (await getLatestRepoGithubTotalsSnapshot(env, repo.fullName));
  const result =
    options.segment === "labels"
      ? await backfillLabelsSegment(env, repo, token, sourceKind, mode, options.cursor, totals)
      : options.segment === "open_issues"
        ? await backfillOpenIssuesSegment(env, repo, token, sourceKind, mode, options.cursor, totals)
        : options.segment === "open_pull_requests"
          ? await backfillOpenPullRequestsSegment(env, repo, token, sourceKind, mode, options.cursor, totals)
          : await backfillRecentMergedSegment(env, repo, token, sourceKind, mode, options.cursor, totals);
  if ((result.status === "running" || result.status === "waiting_rate_limit") && (options.segment === "labels" || options.segment === "open_issues" || options.segment === "open_pull_requests")) {
    const delaySeconds = result.status === "waiting_rate_limit" && result.segment.rateLimitResetAt ? delayUntil(result.segment.rateLimitResetAt) : 20;
    await env.JOBS.send(
      { type: "backfill-repo-segment", requestedBy: options.requestedBy === "schedule" || options.requestedBy === "test" ? options.requestedBy : "api", repoFullName: repo.fullName, segment: options.segment, mode: "resume", force: true },
      { delaySeconds },
    );
  }
  if (options.segment === "open_pull_requests" && result.status === "complete") {
    await env.JOBS.send({ type: "backfill-pr-details", requestedBy: "api", repoFullName: repo.fullName, mode: "resume", cursor: 0 }, { delaySeconds: 10 });
  }
  await refreshRepoSyncStateFromSegments(env, repo, sourceKind);
  return segmentJobResult(repo.fullName, options.segment, result.segment);
}

export async function backfillOpenPullRequestDetails(
  env: Env,
  options: { repoFullName: string; mode?: BackfillMode; cursor?: number },
): Promise<{ ok: true; repoFullName: string; status: RepoSyncSegmentRecord["status"]; processed: number; nextCursor?: number; warnings: string[] }> {
  const repo = await getRepository(env, options.repoFullName);
  if (!repo) return { ok: true, repoFullName: options.repoFullName, status: "skipped", processed: 0, warnings: ["Repository was not found."] };
  const mode = options.mode ?? "light";
  const token = await tokenForRepo(env, repo);
  const sourceKind: RepoSyncSegmentRecord["sourceKind"] = repo.installationId && token !== env.GITHUB_PUBLIC_TOKEN ? "installation" : "github";
  const resetAt = await shouldWaitForGitHubRateLimit(env);
  if (resetAt) {
    const previous = await getRepoSyncSegment(env, repo.fullName, "pull_request_files");
    await env.JOBS.send({ type: "backfill-pr-details", requestedBy: "api", repoFullName: repo.fullName, mode, cursor: options.cursor ?? 0 }, { delaySeconds: delayUntil(resetAt) });
    await completeSegment(env, repo, "pull_request_files", sourceKind, mode, nowIso(), {
      status: "waiting_rate_limit",
      fetchedCount: previous?.fetchedCount ?? 0,
      expectedCount: previous?.expectedCount,
      pageCount: previous?.pageCount ?? 0,
      warnings: [`GitHub REST rate limit is low; retry PR detail sync after ${resetAt}.`],
      rateLimitResetAt: resetAt,
      errorSummary: `Waiting for GitHub rate limit reset at ${resetAt}.`,
    });
    return { ok: true, repoFullName: repo.fullName, status: "waiting_rate_limit", processed: 0, warnings: [`GitHub REST rate limit is low; retry after ${resetAt}.`] };
  }
  const openPullRequests = (await listOpenPullRequests(env, repo.fullName)).sort((left, right) => left.number - right.number);
  const detailStates = await listPullRequestDetailSyncStates(env, repo.fullName);
  const detailStateByPull = new Map(detailStates.map((state) => [state.pullNumber, state.status]));
  const openPullNumbers = new Set(openPullRequests.map((pr) => pr.number));
  const incompleteOpenPullRequests = openPullRequests.filter((pr) => detailStateByPull.get(pr.number) !== "complete");
  // Incomplete-target lists shrink after every batch, so cursoring over the
  // filtered list can skip newly retriable partial rows. Always take the next
  // oldest incomplete open PRs.
  const cursor = 0;
  const batch = incompleteOpenPullRequests.slice(cursor, cursor + PR_DETAIL_BATCH_SIZE[mode]);
  const warnings: string[] = [];
  await mapWithConcurrency(batch, 2, async (pr) => {
    await upsertPullRequestDetailSyncState(env, { repoFullName: repo.fullName, pullNumber: pr.number, status: "running" });
    const before = warnings.length;
    await fetchAndStorePullRequestDetails(env, repo.fullName, pr, token, warnings);
    const syncedAt = nowIso();
    const newWarnings = warnings.slice(before);
    await upsertPullRequestDetailSyncState(env, {
      repoFullName: repo.fullName,
      pullNumber: pr.number,
      status: newWarnings.length > 0 ? "partial" : "complete",
      filesSyncedAt: syncedAt,
      reviewsSyncedAt: syncedAt,
      checksSyncedAt: syncedAt,
      lastSyncedAt: syncedAt,
      errorSummary: newWarnings.at(-1),
    });
  });
  const refreshedDetailStates = await listPullRequestDetailSyncStates(env, repo.fullName);
  const completedCount = refreshedDetailStates.filter((state) => openPullNumbers.has(state.pullNumber) && state.status === "complete").length;
  const nextCursor = batch.length < incompleteOpenPullRequests.length ? 0 : undefined;
  const status: RepoSyncSegmentRecord["status"] = nextCursor !== undefined ? "running" : completedCount >= openPullRequests.length ? "complete" : "partial";
  await Promise.all(
    (["pull_request_files", "pull_request_reviews", "check_summaries"] as const).map((segment) =>
      completeSegment(env, repo, segment, sourceKind, mode, nowIso(), {
        status,
        fetchedCount: completedCount,
        expectedCount: openPullRequests.length,
        pageCount: 0,
        nextCursor: nextCursor === undefined ? undefined : String(nextCursor),
        warnings,
      }),
    ),
  );
  if (nextCursor !== undefined) {
    await env.JOBS.send({ type: "backfill-pr-details", requestedBy: "api", repoFullName: repo.fullName, mode: "resume", cursor: nextCursor }, { delaySeconds: 20 });
  }
  await refreshRepoSyncStateFromSegments(env, repo, sourceKind);
  return {
    ok: true,
    repoFullName: repo.fullName,
    status,
    processed: batch.length,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    warnings,
  };
}

export async function refreshContributorActivity(
  env: Env,
  login: string,
  options: { repoFullName?: string } = {},
): Promise<RefreshContributorActivityResult> {
  const warnings: string[] = [];
  const token = env.GITHUB_PUBLIC_TOKEN;
  if (!token) {
    return {
      ok: true,
      login,
      repoCount: 0,
      updatedRepoStats: 0,
      warnings: ["GITHUB_PUBLIC_TOKEN is not configured; contributor activity refresh was skipped."],
    };
  }

  const repositories = (await listRepositories(env)).filter((repo) => repo.isRegistered && (!options.repoFullName || repo.fullName === options.repoFullName));
  let updatedRepoStats = 0;
  for (const chunk of chunkArray(repositories, 4)) {
    const aliases = buildContributorActivityAliases(login, chunk);
    if (aliases.length === 0) continue;
    const query = buildContributorActivityQuery(aliases);
    let payload: GitHubGraphQlContributorSearchResponse;
    try {
      payload = await githubGraphQl<GitHubGraphQlContributorSearchResponse>(env, query, token);
    } catch (error) {
      warnings.push(`Contributor activity refresh failed for ${chunk.map((repo) => repo.fullName).join(", ")}: ${errorMessage(error)}`);
      continue;
    }
    if (payload.errors?.length) {
      warnings.push(...payload.errors.flatMap((error) => (error.message ? [error.message] : [])));
    }
    const data = payload.data ?? {};
    for (const repo of chunk) {
      const allPullRequests = data[activityAlias(repo.fullName, "all")];
      const mergedPullRequests = data[activityAlias(repo.fullName, "merged")];
      const openPullRequests = data[activityAlias(repo.fullName, "open")];
      const authoredIssues = data[activityAlias(repo.fullName, "issues")];
      const pullRequestCount = allPullRequests?.issueCount ?? 0;
      const mergedPullRequestCount = mergedPullRequests?.issueCount ?? 0;
      const openPullRequestCount = openPullRequests?.issueCount ?? 0;
      const issueCount = authoredIssues?.issueCount ?? 0;
      if (pullRequestCount + issueCount === 0) continue;

      const openNodes = compactNodes(openPullRequests);
      const labelNames = [
        ...labelsFromBucket(allPullRequests),
        ...labelsFromBucket(mergedPullRequests),
        ...labelsFromBucket(openPullRequests),
        ...labelsFromBucket(authoredIssues),
      ];
      await upsertContributorRepoStat(env, {
        login,
        repoFullName: repo.fullName,
        pullRequests: pullRequestCount,
        mergedPullRequests: mergedPullRequestCount,
        openPullRequests: openPullRequestCount,
        issues: issueCount,
        stalePullRequests: openNodes.filter((node) => node.updatedAt && daysSince(node.updatedAt) >= 14).length,
        unlinkedPullRequests: openNodes.filter((node) => extractLinkedIssueNumbers(node.body ?? "").length === 0).length,
        dominantLabels: topItems(labelNames, 8),
        lastActivityAt: latestDate([
          ...compactNodes(allPullRequests).map((node) => node.updatedAt ?? node.mergedAt),
          ...compactNodes(mergedPullRequests).map((node) => node.mergedAt ?? node.updatedAt),
          ...compactNodes(openPullRequests).map((node) => node.updatedAt),
          ...compactNodes(authoredIssues).map((node) => node.updatedAt),
        ]),
      });
      updatedRepoStats += 1;
    }
  }

  await upsertContributor(env, {
    login,
    githubProfile: { login },
    topLanguages: [],
    source: "github",
    lastSeenAt: nowIso(),
  });

  return { ok: true, login, repoCount: repositories.length, updatedRepoStats, warnings };
}

export const REQUIRED_INSTALLATION_PERMISSIONS: Record<string, string> = {
  metadata: "read",
  pull_requests: "read",
  issues: "write",
};
export const OPTIONAL_CHECK_RUN_PERMISSION: Record<string, string> = {
  checks: "write",
};

export const REQUIRED_INSTALLATION_EVENTS = ["issues", "issue_comment", "pull_request", "repository"] as const;
export const OPTIONAL_VISIBLE_INSTALLATION_EVENTS = ["installation_target"] as const;

export function enrichInstallationHealth(health: InstallationHealthRecord) {
  const missingPermissions = new Set(health.missingPermissions);
  const missingEvents = new Set(health.missingEvents);
  const requiredPermissions = {
    ...REQUIRED_INSTALLATION_PERMISSIONS,
    ...(missingPermissions.has("checks") ? OPTIONAL_CHECK_RUN_PERMISSION : {}),
  };
  return {
    ...health,
    requiredPermissions,
    optionalPermissions: OPTIONAL_CHECK_RUN_PERMISSION,
    requiredEvents: [...REQUIRED_INSTALLATION_EVENTS],
    optionalVisibleEvents: [...OPTIONAL_VISIBLE_INSTALLATION_EVENTS],
    permissionRemediation: Object.entries(requiredPermissions).map(([permission, access]) => ({
      permission,
      requiredAccess: access,
      currentAccess: health.permissions[permission] ?? "missing",
      ok: !missingPermissions.has(permission),
      action: missingPermissions.has(permission) ? `Set repository permission ${permission} to ${access}.` : "No change needed.",
    })),
    eventRemediation: REQUIRED_INSTALLATION_EVENTS.map((event) => ({
      event,
      ok: !missingEvents.has(event),
      action: missingEvents.has(event) ? `Subscribe to the ${event} webhook event.` : "No change needed.",
    })),
    repairSteps:
      health.status === "healthy"
        ? ["No repair needed."]
        : [
            "Update the GitHub App permissions and subscribed events.",
            "Approve the changed permissions or reinstall the app on the target account.",
            "Run refresh-installation-health after GitHub sends the updated installation payload.",
            "Recheck /v1/readiness and this installation health endpoint.",
          ],
  };
}

export async function refreshInstallationHealth(env: Env) {
  const [installations, repositories] = await Promise.all([listInstallations(env), listRepositories(env)]);
  const health = [];
  for (const installation of installations) {
    const { installation: currentInstallation, errorSummary } = await refreshStoredInstallation(env, installation);
    const installedRepos = repositories.filter((repo) => repo.installationId === currentInstallation.id && repo.isInstalled);
    const registeredInstalled = installedRepos.filter((repo) => repo.isRegistered);
    const installedSettings = await Promise.all(installedRepos.map((repo) => getRepositorySettings(env, repo.fullName)));
    const requiresChecks = installedSettings.some((settings) => settings.checkRunMode === "enabled");
    const requiredPermissions = {
      ...REQUIRED_INSTALLATION_PERMISSIONS,
      ...(requiresChecks ? OPTIONAL_CHECK_RUN_PERMISSION : {}),
    };
    const missingPermissions = Object.entries(requiredPermissions)
      .filter(([permission, expected]) => !permissionSatisfies(currentInstallation.permissions[permission], expected))
      .map(([permission]) => permission);
    const missingEvents = REQUIRED_INSTALLATION_EVENTS.filter((event) => !currentInstallation.events.includes(event));
    const status = errorSummary || missingPermissions.length > 0 || missingEvents.length > 0 ? "needs_attention" : "healthy";
    const record = {
      installationId: currentInstallation.id,
      accountLogin: currentInstallation.accountLogin,
      repositorySelection: currentInstallation.repositorySelection,
      installedReposCount: installedRepos.length,
      registeredInstalledCount: registeredInstalled.length,
      status,
      missingPermissions,
      missingEvents,
      permissions: currentInstallation.permissions,
      events: currentInstallation.events,
      checkedAt: nowIso(),
      errorSummary,
    } as const;
    await upsertInstallationHealth(env, record);
    health.push(enrichInstallationHealth(record));
  }
  return { ok: true, installations: health };
}

async function refreshStoredInstallation(env: Env, installation: InstallationRecord): Promise<{ installation: InstallationRecord; errorSummary?: string }> {
  try {
    const live = await getAppInstallation(env, installation.id);
    await upsertInstallation(env, { installation: live });
    return {
      installation: {
        ...installation,
        accountLogin: live.account?.login ?? installation.accountLogin,
        accountId: live.account?.id ?? installation.accountId,
        targetType: live.target_type ?? live.account?.type ?? installation.targetType,
        repositorySelection: live.repository_selection ?? installation.repositorySelection,
        permissions: live.permissions ?? {},
        events: live.events ?? [],
        suspendedAt: live.suspended_at ?? undefined,
        updatedAt: nowIso(),
      },
    };
  } catch (error) {
    return {
      installation,
      errorSummary: strippedErrorMessage(error, "Failed to refresh GitHub App installation metadata."),
    };
  }
}

function permissionSatisfies(current: string | undefined, expected: string): boolean {
  if (current === expected) return true;
  const order: Record<string, number> = { read: 1, write: 2, admin: 3 };
  return (order[current ?? ""] ?? 0) >= (order[expected] ?? Number.POSITIVE_INFINITY);
}

async function tokenForRepo(env: Env, repo: RepositoryRecord): Promise<string | undefined> {
  const installationToken = repo.installationId ? await createInstallationToken(env, repo.installationId).catch(() => undefined) : undefined;
  return installationToken ?? env.GITHUB_PUBLIC_TOKEN;
}

async function refreshRepoGithubTotals(
  env: Env,
  repo: RepositoryRecord,
  token: string,
  sourceKind: RepoSyncSegmentRecord["sourceKind"],
): Promise<RepoGithubTotalsSnapshotRecord> {
  const { owner, name } = repoParts(repo.fullName);
  const query = `query GittensoryRepoTotals {
    rateLimit { remaining resetAt }
    repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      issues(states: OPEN) { totalCount }
      openPullRequests: pullRequests(states: OPEN) { totalCount }
      mergedPullRequests: pullRequests(states: MERGED) { totalCount }
      closedPullRequests: pullRequests(states: CLOSED) { totalCount }
      labels { totalCount }
    }
  }`;
  const response = await githubGraphQl<GitHubRepoTotalsResponse>(env, query, token);
  const repository = response.data?.repository;
  if (!repository) throw new Error(`GitHub totals query did not return repository data for ${repo.fullName}.`);
  const snapshot: RepoGithubTotalsSnapshotRecord = {
    id: crypto.randomUUID(),
    repoFullName: repo.fullName,
    openIssuesTotal: repository.issues?.totalCount ?? 0,
    openPullRequestsTotal: repository.openPullRequests?.totalCount ?? 0,
    mergedPullRequestsTotal: repository.mergedPullRequests?.totalCount ?? 0,
    closedUnmergedPullRequestsTotal: repository.closedPullRequests?.totalCount ?? 0,
    labelsTotal: repository.labels?.totalCount ?? 0,
    sourceKind,
    fetchedAt: nowIso(),
    rateLimitRemaining: response.data?.rateLimit?.remaining,
    rateLimitResetAt: response.data?.rateLimit?.resetAt,
    payload: response as unknown as Record<string, JsonValue>,
  };
  await persistRepoGithubTotalsSnapshot(env, snapshot);
  return snapshot;
}

async function backfillLabelsSegment(
  env: Env,
  repo: RepositoryRecord,
  token: string | undefined,
  sourceKind: RepoSyncSegmentRecord["sourceKind"],
  mode: BackfillMode,
  cursor: string | undefined,
  totals: RepoGithubTotalsSnapshotRecord | null | undefined,
): Promise<{ status: RepoSyncSegmentRecord["status"]; segment: RepoSyncSegmentRecord }> {
  const configuredLabels = new Set(Object.keys(repo.registryConfig?.labelMultipliers ?? {}));
  return fetchPagedSegment<GitHubLabelPayload>(
    env,
    repo,
    "labels",
    "/labels",
    token,
    sourceKind,
    mode,
    cursor,
    totals?.labelsTotal,
    async (labels) => {
      await mapWithConcurrency(labels, 8, async (label) =>
        upsertRepoLabel(env, {
          repoFullName: repo.fullName,
          name: label.name,
          color: label.color,
          description: label.description,
          isConfigured: configuredLabels.has(label.name),
          observedCount: 0,
          payload: label as unknown as Record<string, JsonValue>,
          lastSeenAt: nowIso(),
        }),
      );
      return labels.length;
    },
    { countPersisted: () => countRepoLabels(env, repo.fullName) },
  );
}

async function backfillOpenIssuesSegment(
  env: Env,
  repo: RepositoryRecord,
  token: string | undefined,
  sourceKind: RepoSyncSegmentRecord["sourceKind"],
  mode: BackfillMode,
  cursor: string | undefined,
  totals: RepoGithubTotalsSnapshotRecord | null | undefined,
): Promise<{ status: RepoSyncSegmentRecord["status"]; segment: RepoSyncSegmentRecord }> {
  const result = await fetchPagedSegment<GitHubIssuePayload>(
    env,
    repo,
    "open_issues",
    "/issues?state=open&sort=created&direction=asc",
    token,
    sourceKind,
    mode,
    cursor,
    totals?.openIssuesTotal,
    async (payloads, scanStartedAt) => {
      const issuePayloads = payloads.filter((issue) => !issue.pull_request);
      await mapWithConcurrency(issuePayloads, 8, async (issue) => upsertIssueFromGitHub(env, repo.fullName, issue, { seenOpenAt: scanStartedAt }));
      return issuePayloads.length;
    },
    {
      countPersisted: () => countOpenIssues(env, repo.fullName),
      reconcileOnComplete: (scanStartedAt) => markUnseenOpenIssuesClosed(env, repo.fullName, scanStartedAt),
      ...(token ? { supplementOnUnderCount: (scanStartedAt: string) => supplementOpenIssuesFromGraphQl(env, repo, token, scanStartedAt) } : {}),
    },
  );
  return result;
}

async function backfillOpenPullRequestsSegment(
  env: Env,
  repo: RepositoryRecord,
  token: string | undefined,
  sourceKind: RepoSyncSegmentRecord["sourceKind"],
  mode: BackfillMode,
  cursor: string | undefined,
  totals: RepoGithubTotalsSnapshotRecord | null | undefined,
): Promise<{ status: RepoSyncSegmentRecord["status"]; segment: RepoSyncSegmentRecord }> {
  return fetchPagedSegment<GitHubPullRequestPayload>(
    env,
    repo,
    "open_pull_requests",
    "/pulls?state=open&sort=created&direction=asc",
    token,
    sourceKind,
    mode,
    cursor,
    totals?.openPullRequestsTotal,
    async (payloads, scanStartedAt) => {
      await mapWithConcurrency(payloads, 8, async (pr) => upsertPullRequestFromGitHub(env, repo.fullName, pr, { seenOpenAt: scanStartedAt }));
      return payloads.length;
    },
    {
      countPersisted: () => countOpenPullRequests(env, repo.fullName),
      reconcileOnComplete: (scanStartedAt) => markUnseenOpenPullRequestsClosed(env, repo.fullName, scanStartedAt),
      ...(token ? { supplementOnUnderCount: (scanStartedAt: string) => supplementOpenPullRequestsFromGraphQl(env, repo, token, scanStartedAt), supplementDescription: "open pull request row(s)" } : {}),
    },
  );
}

async function backfillRecentMergedSegment(
  env: Env,
  repo: RepositoryRecord,
  token: string | undefined,
  sourceKind: RepoSyncSegmentRecord["sourceKind"],
  mode: BackfillMode,
  cursor: string | undefined,
  totals: RepoGithubTotalsSnapshotRecord | null | undefined,
): Promise<{ status: RepoSyncSegmentRecord["status"]; segment: RepoSyncSegmentRecord }> {
  return fetchPagedSegment<GitHubPullRequestPayload>(
    env,
    repo,
    "recent_merged_pull_requests",
    "/pulls?state=closed&sort=updated&direction=desc",
    token,
    sourceKind,
    mode,
    cursor,
    totals?.mergedPullRequestsTotal,
    async (payloads) => {
      const merged = payloads.filter((pr) => Boolean(pr.merged_at));
      await mapWithConcurrency(merged, 8, async (pr) => {
        await upsertRecentMergedPullRequest(env, toRecentMergedPullRequest(repo.fullName, pr, []));
      });
      return merged.length;
    },
    { progressiveHistory: true, countPersisted: () => countRecentMergedPullRequests(env, repo.fullName) },
  );
}

async function fetchPagedSegment<T>(
  env: Env,
  repo: RepositoryRecord,
  segmentName: BackfillSegmentName,
  path: string,
  token: string | undefined,
  sourceKind: RepoSyncSegmentRecord["sourceKind"],
  mode: BackfillMode,
  cursor: string | undefined,
  expectedCount: number | undefined,
  persistPage: (payloads: T[], scanStartedAt: string) => Promise<number>,
  options: {
    progressiveHistory?: boolean;
    countPersisted?: () => Promise<number>;
    reconcileOnComplete?: (scanStartedAt: string) => Promise<number>;
    supplementOnUnderCount?: (scanStartedAt: string) => Promise<number>;
    supplementDescription?: string;
  } = {},
): Promise<{ status: RepoSyncSegmentRecord["status"]; segment: RepoSyncSegmentRecord }> {
  const previous = mode === "resume" ? await getRepoSyncSegment(env, repo.fullName, segmentName) : null;
  const requiresCurrentOpenScan = Boolean(options.reconcileOnComplete);
  const canResumePreviousScan =
    mode === "resume" &&
    (!requiresCurrentOpenScan || previous?.etag === CURRENT_OPEN_SCAN_MARKER) &&
    Boolean(previous?.startedAt) &&
    (previous?.status === "running" || previous?.status === "partial" || previous?.status === "waiting_rate_limit");
  const startedAt = canResumePreviousScan ? previous?.startedAt ?? nowIso() : nowIso();
  await markSegmentRunning(env, repo, segmentName, sourceKind, mode, startedAt);
  const startPage =
    canResumePreviousScan && cursor && Number.isFinite(Number(cursor))
      ? Number(cursor)
      : canResumePreviousScan && previous?.nextCursor && Number.isFinite(Number(previous.nextCursor))
        ? Number(previous.nextCursor)
        : 1;
  const priorFetched = canResumePreviousScan ? (previous?.fetchedCount ?? 0) : 0;
  let fetchedThisRun = 0;
  let lastCursor: string | undefined;
  let nextCursor: string | undefined;
  let pageCount = 0;
  let hasMore = false;
  let rateLimitResetAt: string | undefined;
  const warnings: string[] = [];
  let status: RepoSyncSegmentRecord["status"] = "complete";
  try {
    for (let page = startPage; page < startPage + SEGMENT_PAGE_BUDGET[mode]; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const pagePath = `${path}${separator}per_page=100&page=${page}`;
      const result = await githubJsonWithHeaders<T[]>(env, repo.fullName, pagePath, token);
      lastCursor = String(page);
      pageCount += 1;
      fetchedThisRun += await persistPage(result.data, startedAt);
      hasMore = hasNextPage(result.link);
      if (!hasMore) break;
      nextCursor = String(page + 1);
    }
  } catch (error) {
    if (error instanceof GitHubApiError && error.rateLimited) {
      status = "waiting_rate_limit";
      rateLimitResetAt = error.rateLimitResetAt ?? undefined;
      warnings.push(`GitHub sync is waiting for rate-limit recovery for ${path}: ${error.message}`);
    } else {
      status = fetchedThisRun > 0 ? "partial" : "error";
      warnings.push(`GitHub sync failed for ${path}: ${errorMessage(error)}`);
    }
  }
  let fetchedCount = options.countPersisted ? await options.countPersisted() : priorFetched + fetchedThisRun;
  if ((status === "error" || status === "partial") && expectedCount !== undefined && fetchedCount >= expectedCount) {
    status = "complete";
    hasMore = false;
    nextCursor = undefined;
    warnings.push(`GitHub segment ${segmentName} met the expected total after a late page error; preserving complete persisted coverage.`);
  }
  if (status === "complete") {
    if (hasMore && options.progressiveHistory) {
      status = "sampled";
    } else if (hasMore) {
      status = "running";
    } else {
      fetchedCount = await supplementUnderCountIfNeeded(options, startedAt, fetchedCount, expectedCount, warnings);
      if (expectedCount !== undefined && fetchedCount < expectedCount) {
        status = "partial";
        warnings.push(`GitHub segment ${segmentName} fetched ${fetchedCount} item(s), below expected total ${expectedCount}.`);
      }
    }
  }
  if (status === "complete" && !hasMore && options.reconcileOnComplete) {
    const reconciled = await options.reconcileOnComplete(startedAt);
    if (reconciled > 0) warnings.push(`Marked ${reconciled} stale open ${segmentName === "open_issues" ? "issue" : "pull request"} row(s) closed after a complete GitHub open-data crawl.`);
    fetchedCount = options.countPersisted ? await options.countPersisted() : fetchedCount;
    fetchedCount = await supplementUnderCountIfNeeded(options, startedAt, fetchedCount, expectedCount, warnings);
    if (expectedCount !== undefined && fetchedCount < expectedCount) {
      status = "partial";
      warnings.push(`GitHub segment ${segmentName} fetched ${fetchedCount} item(s), below expected total ${expectedCount}.`);
    }
  }
  const segment = await completeSegment(env, repo, segmentName, sourceKind, mode, startedAt, {
    status,
    fetchedCount,
    expectedCount,
    pageCount,
    lastCursor,
    nextCursor,
    etag: requiresCurrentOpenScan ? CURRENT_OPEN_SCAN_MARKER : undefined,
    warnings,
    errorSummary: status === "error" || status === "waiting_rate_limit" || status === "partial" ? warnings.at(-1) : undefined,
    rateLimitResetAt,
  });
  return { status, segment };
}

async function supplementUnderCountIfNeeded(
  options: {
    countPersisted?: () => Promise<number>;
    supplementOnUnderCount?: (scanStartedAt: string) => Promise<number>;
    supplementDescription?: string;
  },
  scanStartedAt: string,
  fetchedCount: number,
  expectedCount: number | undefined,
  warnings: string[],
): Promise<number> {
  if (expectedCount === undefined || fetchedCount >= expectedCount || !options.supplementOnUnderCount) return fetchedCount;
  try {
    const supplemented = await options.supplementOnUnderCount(scanStartedAt);
    if (supplemented > 0) warnings.push(`Supplemented ${supplemented} ${options.supplementDescription ?? "open issue row(s)"} from GitHub GraphQL because REST pagination undercounted the authoritative total.`);
    return options.countPersisted ? await options.countPersisted() : fetchedCount + supplemented;
  } catch (error) {
    warnings.push(`GitHub GraphQL supplement failed after REST undercount: ${errorMessage(error)}`);
    return fetchedCount;
  }
}

async function supplementOpenIssuesFromGraphQl(env: Env, repo: RepositoryRecord, token: string, seenOpenAt: string): Promise<number> {
  const existingNumbers = new Set(await listOpenIssueNumbers(env, repo.fullName));
  const { owner, name } = repoParts(repo.fullName);
  let after = "";
  let supplemented = 0;
  for (;;) {
    const query = `query GittensoryOpenIssuesSupplement {
      repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
        issues(states: OPEN, first: 100${after}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number
            title
            state
            url
            body
            createdAt
            updatedAt
            authorAssociation
            author { login }
            labels(first: 30) { nodes { name } }
          }
        }
      }
      rateLimit { remaining resetAt }
    }`;
    const response = await githubGraphQl<GitHubOpenIssuesResponse>(env, query, token);
    const issues = response.data?.repository?.issues;
    for (const issue of issues?.nodes ?? []) {
      if (!issue?.number || existingNumbers.has(issue.number)) continue;
      const payload: GitHubIssuePayload = {
        number: issue.number,
        title: issue.title ?? `Issue #${issue.number}`,
        state: String(issue.state ?? "OPEN").toLowerCase(),
        labels: (issue.labels?.nodes ?? []).flatMap((label) => (label?.name ? [{ name: label.name }] : [])),
        ...(issue.url ? { html_url: issue.url } : {}),
        ...(issue.createdAt === undefined ? {} : { created_at: issue.createdAt }),
        ...(issue.updatedAt === undefined ? {} : { updated_at: issue.updatedAt }),
        ...(issue.author?.login ? { user: { login: issue.author.login } } : {}),
        ...(issue.authorAssociation ? { author_association: issue.authorAssociation } : {}),
        ...(issue.body === undefined ? {} : { body: issue.body }),
      };
      await upsertIssueFromGitHub(env, repo.fullName, payload, { seenOpenAt });
      existingNumbers.add(issue.number);
      supplemented += 1;
    }
    if (!issues?.pageInfo?.hasNextPage) break;
    after = `, after: ${JSON.stringify(issues.pageInfo.endCursor)}`;
  }
  return supplemented;
}

async function supplementOpenPullRequestsFromGraphQl(env: Env, repo: RepositoryRecord, token: string, seenOpenAt: string): Promise<number> {
  const existingNumbers = new Set((await listOpenPullRequests(env, repo.fullName)).map((pr) => pr.number));
  const { owner, name } = repoParts(repo.fullName);
  let after = "";
  let supplemented = 0;
  for (;;) {
    const query = `query GittensoryOpenPullRequestsSupplement {
      repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
        pullRequests(states: OPEN, first: 100${after}, orderBy: { field: CREATED_AT, direction: ASC }) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number
            title
            state
            url
            body
            isDraft
            mergeable
            reviewDecision
            createdAt
            updatedAt
            authorAssociation
            author { login }
            headRefName
            baseRefName
            headRefOid
            labels(first: 30) { nodes { name } }
          }
        }
      }
      rateLimit { remaining resetAt }
    }`;
    const response = await githubGraphQl<GitHubOpenPullRequestsResponse>(env, query, token);
    const pullRequests = response.data?.repository?.pullRequests;
    for (const pr of pullRequests?.nodes ?? []) {
      if (!pr?.number || existingNumbers.has(pr.number)) continue;
      const payload: GitHubPullRequestPayload = {
        number: pr.number,
        title: pr.title ?? `Pull request #${pr.number}`,
        state: String(pr.state ?? "OPEN").toLowerCase(),
        labels: (pr.labels?.nodes ?? []).flatMap((label) => (label?.name ? [{ name: label.name }] : [])),
        ...(pr.url ? { html_url: pr.url } : {}),
        ...(pr.createdAt === undefined ? {} : { created_at: pr.createdAt }),
        ...(pr.updatedAt === undefined ? {} : { updated_at: pr.updatedAt }),
        ...(pr.body === undefined ? {} : { body: pr.body }),
        ...(pr.isDraft === undefined ? {} : { draft: pr.isDraft }),
        ...(pr.mergeable === undefined ? {} : { mergeableState: pr.mergeable }),
        ...(pr.reviewDecision === undefined ? {} : { reviewDecision: pr.reviewDecision }),
        ...(pr.author?.login ? { user: { login: pr.author.login } } : {}),
        ...(pr.authorAssociation ? { author_association: pr.authorAssociation } : {}),
        head: { ...(pr.headRefOid ? { sha: pr.headRefOid } : {}), ...(pr.headRefName ? { ref: pr.headRefName } : {}) },
        base: { ...(pr.baseRefName ? { ref: pr.baseRefName } : {}) },
      };
      await upsertPullRequestFromGitHub(env, repo.fullName, payload, { seenOpenAt });
      existingNumbers.add(pr.number);
      supplemented += 1;
    }
    if (!pullRequests?.pageInfo?.hasNextPage || !pullRequests.pageInfo.endCursor) break;
    after = `, after: ${JSON.stringify(pullRequests.pageInfo.endCursor)}`;
  }
  return supplemented;
}

async function refreshRepoSyncStateFromSegments(env: Env, repo: RepositoryRecord, sourceKind: RepoSyncSegmentRecord["sourceKind"]): Promise<void> {
  const [previous, totals, metadata, labels, openIssues, openPullRequests, recentMerged, files, reviews, checks] = await Promise.all([
    getRepoSyncState(env, repo.fullName),
    getLatestRepoGithubTotalsSnapshot(env, repo.fullName),
    getRepoSyncSegment(env, repo.fullName, "metadata"),
    getRepoSyncSegment(env, repo.fullName, "labels"),
    getRepoSyncSegment(env, repo.fullName, "open_issues"),
    getRepoSyncSegment(env, repo.fullName, "open_pull_requests"),
    getRepoSyncSegment(env, repo.fullName, "recent_merged_pull_requests"),
    getRepoSyncSegment(env, repo.fullName, "pull_request_files"),
    getRepoSyncSegment(env, repo.fullName, "pull_request_reviews"),
    getRepoSyncSegment(env, repo.fullName, "check_summaries"),
  ]);
  const required = [metadata, labels, openIssues, openPullRequests, files, reviews, checks].filter(Boolean) as RepoSyncSegmentRecord[];
  const waiting = required.some((segment) => segment.status === "waiting_rate_limit" || segment.status === "rate_limited");
  const running = required.some((segment) => segment.status === "running" || segment.status === "refreshing");
  const errored = required.some((segment) => segment.status === "error");
  const incomplete = required.some((segment) => segment.status !== "complete" && segment.status !== "not_modified");
  const status: RepoSyncStateRecord["status"] = waiting ? "rate_limited" : errored ? "error" : running ? "running" : incomplete ? "partial" : "success";
  const warnings = [...new Set(required.flatMap((segment) => segment.warnings))];
  const completedAt = running || waiting ? previous?.lastCompletedAt : nowIso();
  await upsertRepoSyncState(env, {
    repoFullName: repo.fullName,
    status,
    sourceKind,
    primaryLanguage: previous?.primaryLanguage,
    defaultBranch: previous?.defaultBranch ?? repo.defaultBranch,
    isPrivate: previous?.isPrivate ?? repo.isPrivate,
    openIssuesCount: openIssues?.fetchedCount ?? previous?.openIssuesCount ?? totals?.openIssuesTotal ?? 0,
    openPullRequestsCount: openPullRequests?.fetchedCount ?? previous?.openPullRequestsCount ?? totals?.openPullRequestsTotal ?? 0,
    recentMergedPullRequestsCount: recentMerged?.fetchedCount ?? previous?.recentMergedPullRequestsCount ?? 0,
    labelsSyncedAt: labels?.status === "complete" ? labels.completedAt : previous?.labelsSyncedAt,
    issuesSyncedAt: openIssues?.status === "complete" ? openIssues.completedAt : previous?.issuesSyncedAt,
    pullRequestsSyncedAt: openPullRequests?.status === "complete" ? openPullRequests.completedAt : previous?.pullRequestsSyncedAt,
    mergedPullRequestsSyncedAt: recentMerged?.status === "complete" || recentMerged?.status === "sampled" ? recentMerged.completedAt : previous?.mergedPullRequestsSyncedAt,
    lastStartedAt: previous?.lastStartedAt,
    lastCompletedAt: completedAt,
    errorSummary: warnings.at(-1),
    warnings,
  });
}

async function shouldWaitForGitHubRateLimit(env: Env): Promise<string | undefined> {
  const observations = await listLatestGitHubRateLimitObservations(env, 10);
  const rest = observations.find((observation) => observation.resource === "rest" && observation.remaining !== null && observation.remaining !== undefined);
  if (!rest?.resetAt || rest.remaining === null || rest.remaining === undefined || rest.remaining > LOW_REST_RATE_LIMIT_REMAINING) return undefined;
  return Date.parse(rest.resetAt) > Date.now() ? rest.resetAt : undefined;
}

function segmentJobResult(
  repoFullName: string,
  segmentName: BackfillSegmentName,
  segment: RepoSyncSegmentRecord,
): { ok: true; repoFullName: string; segment: BackfillSegmentName; status: RepoSyncSegmentRecord["status"]; fetchedCount: number; expectedCount?: number | null; nextCursor?: string | null; warnings: string[] } {
  return {
    ok: true,
    repoFullName,
    segment: segmentName,
    status: segment.status,
    fetchedCount: segment.fetchedCount,
    ...(segment.expectedCount === undefined ? {} : { expectedCount: segment.expectedCount }),
    ...(segment.nextCursor === undefined ? {} : { nextCursor: segment.nextCursor }),
    warnings: segment.warnings,
  };
}

function delayUntil(iso: string): number {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return 60;
  return Math.max(30, Math.min(900, Math.ceil(ms / 1000) + 15));
}

async function backfillRepository(env: Env, repo: RepositoryRecord, limits: BackfillLimits, mode: BackfillMode): Promise<RepoBackfillResult> {
  const startedAt = nowIso();
  const warnings: string[] = [];
  const segmentResults: RepoSyncSegmentRecord[] = [];
  await upsertRepoSyncState(env, {
    repoFullName: repo.fullName,
    status: "running",
    sourceKind: repo.installationId ? "installation" : "github",
    primaryLanguage: undefined,
    defaultBranch: repo.defaultBranch,
    isPrivate: repo.isPrivate,
    openIssuesCount: 0,
    openPullRequestsCount: 0,
    recentMergedPullRequestsCount: 0,
    lastStartedAt: startedAt,
    warnings,
  });

  try {
    const installationToken = repo.installationId ? await createInstallationToken(env, repo.installationId).catch(() => undefined) : undefined;
    const token = installationToken ?? env.GITHUB_PUBLIC_TOKEN;
    const sourceKind = installationToken ? "installation" : "github";
    await markSegmentRunning(env, repo, "metadata", sourceKind, mode, startedAt);
    const metadata = await githubJson<GitHubRepositoryPayload & { open_issues_count?: number; language?: string | null }>(env, repo.fullName, "", token);
    segmentResults.push(
      await completeSegment(env, repo, "metadata", sourceKind, mode, startedAt, {
        status: "complete",
        fetchedCount: 1,
        expectedCount: 1,
        warnings: [],
      }),
    );
    await upsertRepositoryFromGitHub(env, metadata, repo.installationId ?? undefined);

    const [labels, issuePage, pullRequestPage, recentMergedPage] = await Promise.all([
      syncLabels(env, repo, token, sourceKind, mode, warnings),
      githubPaged<GitHubIssuePayload>(env, repo, "open_issues", "/issues?state=open&sort=created&direction=asc", limits.issues, token, mode),
      githubPaged<GitHubPullRequestPayload>(env, repo, "open_pull_requests", "/pulls?state=open&sort=created&direction=asc", limits.pullRequests, token, mode),
      githubPaged<GitHubPullRequestPayload>(
        env,
        repo,
        "recent_merged_pull_requests",
        "/pulls?state=closed&sort=updated&direction=desc",
        limits.recentMergedPullRequests,
        token,
        mode,
      ),
    ]);
    const labelItems = labels.items;
    segmentResults.push(labels.segment, issuePage.segment, pullRequestPage.segment, recentMergedPage.segment);
    warnings.push(...labels.warnings, ...issuePage.warnings, ...pullRequestPage.warnings, ...recentMergedPage.warnings);

    const issues = issuePage.items.filter((issue) => !issue.pull_request);
    const pullRequests = pullRequestPage.items;
    const recentMerged = recentMergedPage.items.filter((pr) => Boolean(pr.merged_at));

    await mapWithConcurrency(issues, 16, async (issue) => upsertIssueFromGitHub(env, repo.fullName, issue, { seenOpenAt: startedAt }));
    const normalizedPullRequests = await mapWithConcurrency(pullRequests, 16, async (pr) => upsertPullRequestFromGitHub(env, repo.fullName, pr, { seenOpenAt: startedAt }));

    const mergedFileWarningStart = warnings.length;
    await mapWithConcurrency(recentMerged, limits.detailConcurrency, async (pr) => {
      const changedFiles = await fetchPullRequestFiles(env, repo.fullName, pr.number, token, warnings).catch(() => []);
      await upsertRecentMergedPullRequest(env, toRecentMergedPullRequest(repo.fullName, pr, changedFiles));
    });

    const detailTargets = normalizedPullRequests.slice(0, limits.pullRequestDetails);
    const detailWarningStart = warnings.length;
    await mapWithConcurrency(detailTargets, limits.detailConcurrency, async (pr) => {
      await fetchAndStorePullRequestDetails(env, repo.fullName, pr, token, warnings);
    });
    const fileWarnings = warnings.slice(mergedFileWarningStart).filter((warning) => /File sync failed/i.test(warning));
    const reviewWarnings = warnings.slice(detailWarningStart).filter((warning) => /Review sync failed/i.test(warning));
    const checkWarnings = warnings.slice(detailWarningStart).filter((warning) => /Check sync failed/i.test(warning));
    segmentResults.push(
      await completeSegment(env, repo, "pull_request_files", sourceKind, mode, startedAt, {
        status: fileWarnings.length > 0 ? "partial" : "complete",
        fetchedCount: recentMerged.length + detailTargets.length,
        expectedCount: recentMerged.length + detailTargets.length,
        warnings: fileWarnings,
      }),
      await completeSegment(env, repo, "pull_request_reviews", sourceKind, mode, startedAt, {
        status: reviewWarnings.length > 0 ? "partial" : "complete",
        fetchedCount: detailTargets.length,
        expectedCount: detailTargets.length,
        warnings: reviewWarnings,
      }),
      await completeSegment(env, repo, "check_summaries", sourceKind, mode, startedAt, {
        status: checkWarnings.length > 0 ? "partial" : "complete",
        fetchedCount: detailTargets.length,
        expectedCount: detailTargets.length,
        warnings: checkWarnings,
      }),
    );

    const configuredLabels = new Set(Object.keys(repo.registryConfig?.labelMultipliers ?? {}));
    const observedCounts = countObservedLabels([...issues, ...pullRequests, ...recentMerged]);
    for (const label of labelItems) {
      await upsertRepoLabel(env, {
        repoFullName: repo.fullName,
        name: label.name,
        color: label.color,
        description: label.description,
        isConfigured: configuredLabels.has(label.name),
        observedCount: observedCounts.get(label.name) ?? 0,
        payload: label as unknown as Record<string, JsonValue>,
        lastSeenAt: nowIso(),
      });
    }
    for (const configured of configuredLabels) {
      if (labelItems.some((label) => label.name === configured)) continue;
      await upsertRepoLabel(env, {
        repoFullName: repo.fullName,
        name: configured,
        isConfigured: true,
        observedCount: observedCounts.get(configured) ?? 0,
        payload: {},
        lastSeenAt: nowIso(),
      });
    }

    await upsertContributorStats(env, repo.fullName, normalizedPullRequests, issues, recentMerged);
    const completedAt = nowIso();
    const dataQuality = summarizeSegments(segmentResults, warnings);
    const status = dataQuality.rateLimited ? "rate_limited" : dataQuality.capped ? "capped" : dataQuality.partial || warnings.length > 0 ? "partial" : "success";
    await upsertRepoSyncState(env, {
      repoFullName: repo.fullName,
      status,
      sourceKind,
      primaryLanguage: metadata.language,
      defaultBranch: metadata.default_branch,
      isPrivate: metadata.private,
      openIssuesCount: issuePage.fetchedCount,
      openPullRequestsCount: pullRequestPage.fetchedCount,
      recentMergedPullRequestsCount: recentMergedPage.fetchedCount,
      labelsSyncedAt: completedAt,
      issuesSyncedAt: completedAt,
      pullRequestsSyncedAt: completedAt,
      mergedPullRequestsSyncedAt: completedAt,
      lastStartedAt: startedAt,
      lastCompletedAt: completedAt,
      warnings,
    });
    await persistRepoSnapshot(env, {
      id: crypto.randomUUID(),
      repoFullName: repo.fullName,
      snapshotKind: "github-backfill",
      sourceKind,
      fetchedAt: completedAt,
      primaryLanguage: metadata.language,
      defaultBranch: metadata.default_branch,
      openIssuesCount: issuePage.fetchedCount,
      openPullRequestsCount: pullRequestPage.fetchedCount,
      recentMergedPullRequestsCount: recentMergedPage.fetchedCount,
      payload: {
        open_issues_count: metadata.open_issues_count ?? null,
        limits,
        mode,
        warnings,
        dataQuality,
      },
    });
    return {
      repoFullName: repo.fullName,
      status,
      openIssues: issuePage.fetchedCount,
      openPullRequests: pullRequestPage.fetchedCount,
      recentMergedPullRequests: recentMergedPage.fetchedCount,
      warnings,
      dataQuality,
    };
  } catch (error) {
    const errorSummary = errorMessage(error);
    const rateLimitResetAt = error instanceof GitHubApiError ? error.rateLimitResetAt : undefined;
    const status = error instanceof GitHubApiError && error.rateLimited ? "rate_limited" : "error";
    await completeSegment(env, repo, "metadata", repo.installationId ? "installation" : "github", mode, startedAt, {
      status,
      fetchedCount: 0,
      expectedCount: 1,
      warnings,
      errorSummary,
      rateLimitResetAt,
    });
    await upsertRepoSyncState(env, {
      repoFullName: repo.fullName,
      status,
      sourceKind: repo.installationId ? "installation" : "github",
      primaryLanguage: undefined,
      defaultBranch: repo.defaultBranch,
      isPrivate: repo.isPrivate,
      openIssuesCount: 0,
      openPullRequestsCount: 0,
      recentMergedPullRequestsCount: 0,
      lastStartedAt: startedAt,
      lastCompletedAt: nowIso(),
      errorSummary,
      warnings,
    });
    return {
      repoFullName: repo.fullName,
      status,
      openIssues: 0,
      openPullRequests: 0,
      recentMergedPullRequests: 0,
      warnings,
      dataQuality: { capped: false, partial: false, rateLimited: status === "rate_limited", segmentStatuses: { metadata: status } },
      errorSummary,
    };
  }
}

async function fetchAndStorePullRequestDetails(
  env: Env,
  repoFullName: string,
  pr: PullRequestRecord,
  token: string | undefined,
  warnings: string[],
): Promise<void> {
  const [files, reviews, checks] = await Promise.all([fetchPullRequestFiles(env, repoFullName, pr.number, token, warnings), fetchPullRequestReviews(env, repoFullName, pr.number, token, warnings), fetchPullRequestChecks(env, repoFullName, pr, token)]);

  for (const file of files) {
    await upsertPullRequestFile(env, {
      repoFullName,
      pullNumber: pr.number,
      path: file.filename,
      status: file.status,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      changes: file.changes ?? 0,
      previousFilename: file.previous_filename,
      payload: file as unknown as Record<string, JsonValue>,
    });
  }
  for (const review of reviews) {
    await upsertPullRequestReview(env, {
      id: `${repoFullName}#${pr.number}#${review.id}`,
      repoFullName,
      pullNumber: pr.number,
      reviewerLogin: review.user?.login,
      state: review.state ?? "UNKNOWN",
      authorAssociation: review.author_association,
      submittedAt: review.submitted_at,
      payload: review as unknown as Record<string, JsonValue>,
    });
  }
  for (const check of checks.check_runs ?? []) {
    await upsertCheckSummary(env, {
      id: `${repoFullName}#${pr.headSha ?? "unknown"}#${check.name}`,
      repoFullName,
      pullNumber: pr.number,
      headSha: pr.headSha,
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      startedAt: check.started_at,
      completedAt: check.completed_at,
      detailsUrl: check.details_url ?? check.html_url,
      payload: check as unknown as Record<string, JsonValue>,
    });
  }
}

async function fetchPullRequestFiles(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  token: string | undefined,
  warnings: string[],
): Promise<GitHubFilePayload[]> {
  const files = await githubJson<GitHubFilePayload[]>(env, repoFullName, `/pulls/${pullNumber}/files?per_page=100`, token).catch(() => undefined);
  if (files) return files;
  const fallback = token ? await fetchPullRequestDetailsFromGraphQl(env, repoFullName, pullNumber, token).catch(() => undefined) : undefined;
  if (fallback) return fallback.files;
  warnings.push(`File sync failed for #${pullNumber}: GitHub REST and GraphQL detail fetches failed.`);
  return [];
}

async function fetchPullRequestReviews(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  token: string | undefined,
  warnings: string[],
): Promise<GitHubReviewPayload[]> {
  const reviews = await githubJson<GitHubReviewPayload[]>(env, repoFullName, `/pulls/${pullNumber}/reviews?per_page=100`, token).catch(() => undefined);
  if (reviews) return reviews;
  const fallback = token ? await fetchPullRequestDetailsFromGraphQl(env, repoFullName, pullNumber, token).catch(() => undefined) : undefined;
  if (fallback) return fallback.reviews;
  warnings.push(`Review sync failed for #${pullNumber}: GitHub REST and GraphQL detail fetches failed.`);
  return [];
}

async function fetchPullRequestChecks(
  env: Env,
  repoFullName: string,
  pr: PullRequestRecord,
  token: string | undefined,
): Promise<{ check_runs?: GitHubCheckRunPayload[] }> {
  if (!pr.headSha) return { check_runs: [] };
  return githubJson<{ check_runs?: GitHubCheckRunPayload[] }>(env, repoFullName, `/commits/${pr.headSha}/check-runs?per_page=100`, token).catch(() => ({ check_runs: [] }));
}

async function fetchPullRequestDetailsFromGraphQl(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  token: string,
): Promise<{ files: GitHubFilePayload[]; reviews: GitHubReviewPayload[] }> {
  const { owner, name } = repoParts(repoFullName);
  const query = `query GittensoryPullRequestDetails {
    repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      pullRequest(number: ${pullNumber}) {
        files(first: 100) {
          nodes { path additions deletions changeType }
        }
        reviews(first: 100) {
          nodes { databaseId author { login } state authorAssociation submittedAt }
        }
      }
    }
    rateLimit { remaining resetAt }
  }`;
  const response = await githubGraphQl<GitHubPullRequestDetailsResponse>(env, query, token);
  const pullRequest = response.data?.repository?.pullRequest;
  if (!pullRequest) throw new GitHubApiError(`GitHub GraphQL failed for ${repoFullName} pull request #${pullNumber}: pull request not found`, 404, null, null);
  const files: GitHubFilePayload[] = (pullRequest.files?.nodes ?? []).flatMap((file) => {
    if (!file?.path) return [];
    const additions = Number(file.additions ?? 0);
    const deletions = Number(file.deletions ?? 0);
    return [
      {
        filename: file.path,
        status: String(file.changeType ?? "modified").toLowerCase(),
        additions,
        deletions,
        changes: additions + deletions,
      },
    ];
  });
  const reviews: GitHubReviewPayload[] = (pullRequest.reviews?.nodes ?? []).flatMap((review) => {
    if (!review?.databaseId) return [];
    return [
      {
        id: review.databaseId,
        ...(review.author?.login ? { user: { login: review.author.login } } : {}),
        ...(review.state ? { state: review.state } : {}),
        ...(review.authorAssociation ? { author_association: review.authorAssociation } : {}),
        ...(review.submittedAt === undefined ? {} : { submitted_at: review.submittedAt }),
      },
    ];
  });
  return { files, reviews };
}

async function upsertContributorStats(
  env: Env,
  repoFullName: string,
  pullRequests: PullRequestRecord[],
  issues: GitHubIssuePayload[],
  recentMerged: GitHubPullRequestPayload[],
): Promise<void> {
  const logins = new Set<string>();
  for (const pr of pullRequests) if (pr.authorLogin) logins.add(pr.authorLogin);
  for (const pr of recentMerged) if (pr.user?.login) logins.add(pr.user.login);
  for (const issue of issues) if (issue.user?.login) logins.add(issue.user.login);

  for (const login of logins) {
    const authoredPullRequests = pullRequests.filter((pr) => pr.authorLogin === login);
    const authoredMerged = recentMerged.filter((pr) => pr.user?.login === login);
    const authoredIssues = issues.filter((issue) => issue.user?.login === login);
    const labels = [...authoredPullRequests.flatMap((pr) => pr.labels), ...authoredIssues.flatMap((issue) => (issue.labels ?? []).flatMap((label) => (label.name ? [label.name] : [])))];
    const stat: ContributorRepoStatRecord = {
      login,
      repoFullName,
      pullRequests: authoredPullRequests.length + authoredMerged.length,
      mergedPullRequests: authoredMerged.length,
      openPullRequests: authoredPullRequests.filter((pr) => pr.state === "open").length,
      issues: authoredIssues.length,
      stalePullRequests: authoredPullRequests.filter((pr) => pr.updatedAt && daysSince(pr.updatedAt) >= 14).length,
      unlinkedPullRequests: authoredPullRequests.filter((pr) => pr.linkedIssues.length === 0).length,
      dominantLabels: topItems(labels, 8),
      lastActivityAt: latestDate([
        ...authoredPullRequests.map((pr) => pr.updatedAt ?? pr.createdAt),
        ...authoredMerged.map((pr) => pr.merged_at ?? undefined),
        ...authoredIssues.map((issue) => issue.updated_at ?? issue.created_at),
      ]),
    };
    await upsertContributor(env, {
      login,
      githubProfile: { login },
      topLanguages: [],
      source: "github",
      lastSeenAt: nowIso(),
    });
    await upsertContributorRepoStat(env, stat);
  }
}

function toRecentMergedPullRequest(repoFullName: string, pr: GitHubPullRequestPayload, files: GitHubFilePayload[]): RecentMergedPullRequestRecord {
  return {
    repoFullName,
    number: pr.number,
    title: pr.title,
    authorLogin: pr.user?.login,
    htmlUrl: pr.html_url,
    mergedAt: pr.merged_at,
    labels: (pr.labels ?? []).flatMap((label) => (label.name ? [label.name] : [])),
    linkedIssues: extractLinkedIssueNumbers(pr.body ?? ""),
    changedFiles: files.map((file) => file.filename),
    payload: pr as unknown as Record<string, JsonValue>,
  };
}

async function syncLabels(
  env: Env,
  repo: RepositoryRecord,
  token: string | undefined,
  sourceKind: RepoSyncSegmentRecord["sourceKind"],
  mode: BackfillMode,
  _warnings: string[],
): Promise<{ items: GitHubLabelPayload[]; warnings: string[]; segment: RepoSyncSegmentRecord }> {
  const startedAt = nowIso();
  await markSegmentRunning(env, repo, "labels", sourceKind, mode, startedAt);
  try {
    const items = await githubJson<GitHubLabelPayload[]>(env, repo.fullName, "/labels?per_page=100", token);
    const segment = await completeSegment(env, repo, "labels", sourceKind, mode, startedAt, {
      status: "complete",
      fetchedCount: items.length,
      expectedCount: items.length,
      warnings: [],
    });
    return { items, warnings: [], segment };
  } catch (error) {
    const warning = `Label sync failed: ${errorMessage(error)}`;
    const segment = await completeSegment(env, repo, "labels", sourceKind, mode, startedAt, {
      status: error instanceof GitHubApiError && error.rateLimited ? "rate_limited" : "partial",
      fetchedCount: 0,
      warnings: [warning],
      errorSummary: warning,
      rateLimitResetAt: error instanceof GitHubApiError ? error.rateLimitResetAt : undefined,
    });
    return { items: [], warnings: [warning], segment };
  }
}

async function githubPaged<T>(
  env: Env,
  repo: RepositoryRecord,
  segmentName: RepoSyncSegmentRecord["segment"],
  path: string,
  limit: number,
  token: string | undefined,
  mode: BackfillMode,
): Promise<{ items: T[]; warnings: string[]; segment: RepoSyncSegmentRecord; fetchedCount: number }> {
  const startedAt = nowIso();
  const sourceKind: RepoSyncSegmentRecord["sourceKind"] = repo.installationId ? "installation" : "github";
  const previous = mode === "resume" ? await getRepoSyncSegment(env, repo.fullName, segmentName) : null;
  await markSegmentRunning(env, repo, segmentName, sourceKind, mode, startedAt);
  const startPage = mode === "resume" && previous?.nextCursor && Number.isFinite(Number(previous.nextCursor)) ? Number(previous.nextCursor) : 1;
  const priorFetched = mode === "resume" ? (previous?.fetchedCount ?? 0) : 0;
  const items: T[] = [];
  const warnings: string[] = [];
  let pageCount = 0;
  let nextCursor: string | undefined;
  let lastCursor: string | undefined;
  let etag: string | null | undefined;
  let lastModified: string | null | undefined;
  let rateLimitResetAt: string | null | undefined;
  let status: RepoSyncSegmentRecord["status"] = "complete";

  try {
    for (let page = startPage; items.length < limit; page += 1) {
      const pageLimit = Math.min(100, limit - items.length);
      const separator = path.includes("?") ? "&" : "?";
      const pagePath = `${path}${separator}per_page=${pageLimit}&page=${page}`;
      const result = await githubJsonWithHeaders<T[]>(env, repo.fullName, pagePath, token);
      etag = result.etag ?? etag;
      lastModified = result.lastModified ?? lastModified;
      lastCursor = String(page);
      pageCount += 1;
      items.push(...result.data);
      const hasNext = hasNextPage(result.link);
      if (result.data.length < pageLimit || !hasNext) break;
      nextCursor = String(page + 1);
      if (items.length >= limit) {
        status = "capped";
        warnings.push(`GitHub sync reached local cap of ${limit} item(s) for ${path}; next page cursor is ${nextCursor}.`);
      }
    }
  } catch (error) {
    status = error instanceof GitHubApiError && error.rateLimited ? "rate_limited" : items.length > 0 ? "partial" : "error";
    rateLimitResetAt = error instanceof GitHubApiError ? error.rateLimitResetAt : undefined;
    warnings.push(`GitHub sync failed for ${path}: ${errorMessage(error)}`);
  }

  if (status === "complete" && items.length >= limit && limit > 0) {
    status = "capped";
    nextCursor = nextCursor ?? String(startPage + Math.max(pageCount, 1));
    warnings.push(`GitHub sync reached local cap of ${limit} item(s) for ${path}.`);
  }
  const fetchedCount = priorFetched + items.length;
  const segment = await completeSegment(env, repo, segmentName, sourceKind, mode, startedAt, {
    status,
    fetchedCount,
    expectedCount: status === "complete" ? fetchedCount : undefined,
    pageCount,
    lastCursor,
    nextCursor,
    etag,
    lastModified,
    warnings,
    errorSummary: status === "error" || status === "rate_limited" ? warnings.at(-1) : undefined,
    rateLimitResetAt,
  });
  return { items, warnings, segment, fetchedCount };
}

async function githubJson<T>(env: Env, repoFullName: string, path: string, token?: string): Promise<T> {
  return (await githubJsonWithHeaders<T>(env, repoFullName, path, token)).data;
}

async function githubJsonWithHeaders<T>(
  env: Env,
  repoFullName: string,
  path: string,
  token?: string,
): Promise<{ data: T; link: string | null; etag: string | null; lastModified: string | null }> {
  const { owner, name } = repoParts(repoFullName);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${path}`;
  let response = await fetch(url, { headers: githubRestHeaders(token) });
  await recordGitHubResponse(env, repoFullName, path, response, "rest");
  if (response.status === 404 && token && token === env.GITHUB_PUBLIC_TOKEN) {
    response = await fetch(url, { headers: githubRestHeaders() });
    if (response.status !== 403) await recordGitHubResponse(env, repoFullName, path, response, "rest");
  }
  if (!response.ok) {
    const body = await response.text();
    throw new GitHubApiError(
      `GitHub API failed for ${repoFullName}${path} (${response.status}): ${body.slice(0, 180)}`,
      response.status,
      response.headers.get("x-ratelimit-reset"),
      response.headers.get("x-ratelimit-remaining"),
    );
  }
  return {
    data: (await response.json()) as T,
    link: response.headers.get("link"),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

function githubRestHeaders(token?: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "gittensory/0.1",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function githubGraphQl<T>(env: Env, query: string, token: string): Promise<T> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "gittensory/0.1",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query }),
  });
  await recordGitHubResponse(env, null, "/graphql", response, "graphql");
  if (!response.ok) {
    const body = await response.text();
    throw new GitHubApiError(
      `GitHub GraphQL failed (${response.status}): ${body.slice(0, 180)}`,
      response.status,
      response.headers.get("x-ratelimit-reset"),
      response.headers.get("x-ratelimit-remaining"),
    );
  }
  return (await response.json()) as T;
}

async function markSegmentRunning(
  env: Env,
  repo: RepositoryRecord,
  segment: RepoSyncSegmentRecord["segment"],
  sourceKind: RepoSyncSegmentRecord["sourceKind"],
  mode: BackfillMode,
  startedAt: string,
): Promise<void> {
  const previous = await getRepoSyncSegment(env, repo.fullName, segment);
  await upsertRepoSyncSegment(env, {
    repoFullName: repo.fullName,
    segment,
    status: "running",
    sourceKind,
    mode,
    fetchedCount: previous?.fetchedCount ?? 0,
    expectedCount: previous?.expectedCount,
    pageCount: previous?.pageCount ?? 0,
    lastCursor: previous?.lastCursor,
    nextCursor: previous?.nextCursor,
    startedAt,
    completedAt: previous?.completedAt,
    staleAt: previous?.staleAt,
    rateLimitResetAt: previous?.rateLimitResetAt,
    etag: previous?.etag,
    lastModified: previous?.lastModified,
    warnings: [],
  });
}

async function completeSegment(
  env: Env,
  repo: RepositoryRecord,
  segment: RepoSyncSegmentRecord["segment"],
  sourceKind: RepoSyncSegmentRecord["sourceKind"],
  mode: BackfillMode,
  startedAt: string,
  result: {
    status: RepoSyncSegmentRecord["status"];
    fetchedCount: number;
    expectedCount?: number | null | undefined;
    pageCount?: number | undefined;
    lastCursor?: string | null | undefined;
    nextCursor?: string | null | undefined;
    etag?: string | null | undefined;
    lastModified?: string | null | undefined;
    warnings: string[];
    errorSummary?: string | null | undefined;
    rateLimitResetAt?: string | null | undefined;
  },
): Promise<RepoSyncSegmentRecord> {
  const record: RepoSyncSegmentRecord = {
    repoFullName: repo.fullName,
    segment,
    status: result.status,
    sourceKind,
    mode,
    lastCursor: result.lastCursor,
    nextCursor: result.nextCursor,
    fetchedCount: result.fetchedCount,
    expectedCount: result.expectedCount,
    pageCount: result.pageCount ?? 0,
    startedAt,
    completedAt: nowIso(),
    staleAt: result.status === "stale" ? nowIso() : undefined,
    rateLimitResetAt: result.rateLimitResetAt,
    etag: result.etag,
    lastModified: result.lastModified,
    warnings: result.warnings,
    errorSummary: result.errorSummary,
  };
  await upsertRepoSyncSegment(env, record);
  return record;
}

async function upsertSkippedSegments(env: Env, repo: RepositoryRecord, mode: BackfillMode, completedAt: string, warnings: string[]): Promise<void> {
  const sourceKind: RepoSyncSegmentRecord["sourceKind"] = repo.installationId ? "installation" : "github";
  await Promise.all(
    (["metadata", "labels", "open_issues", "open_pull_requests", "recent_merged_pull_requests", "pull_request_files", "pull_request_reviews", "check_summaries"] as const).map(
      (segment) =>
        upsertRepoSyncSegment(env, {
          repoFullName: repo.fullName,
          segment,
          status: "skipped",
          sourceKind,
          mode,
          fetchedCount: 0,
          pageCount: 0,
          startedAt: completedAt,
          completedAt,
          warnings,
        }),
    ),
  );
}

function summarizeSegments(
  segments: RepoSyncSegmentRecord[],
  warnings: string[],
): NonNullable<RepoBackfillResult["dataQuality"]> {
  const segmentStatuses = Object.fromEntries(segments.map((segment) => [segment.segment, segment.status]));
  return {
    capped: segments.some((segment) => segment.status === "capped") || warnings.some((warning) => /cap|capped/i.test(warning)),
    rateLimited: segments.some((segment) => segment.status === "rate_limited") || warnings.some((warning) => /rate.?limit/i.test(warning)),
    partial: segments.some((segment) => segment.status !== "complete" && segment.status !== "not_modified") || warnings.length > 0,
    segmentStatuses,
  };
}

async function recordGitHubResponse(
  env: Env,
  repoFullName: string | null,
  path: string,
  response: Response,
  resource: "rest" | "graphql",
): Promise<void> {
  const resetHeader = response.headers.get("x-ratelimit-reset");
  const resetAt = resetHeader && Number.isFinite(Number(resetHeader)) ? new Date(Number(resetHeader) * 1000).toISOString() : undefined;
  await recordGitHubRateLimitObservation(env, {
    repoFullName,
    resource,
    path,
    statusCode: response.status,
    limitValue: parseNullableInt(response.headers.get("x-ratelimit-limit")),
    remaining: parseNullableInt(response.headers.get("x-ratelimit-remaining")),
    resetAt,
  });
}

function hasNextPage(link: string | null): boolean {
  return Boolean(link?.split(",").some((part) => /rel="next"/.test(part)));
}

function parseNullableInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index] as T, index);
      }
    }),
  );
  return results;
}

class GitHubApiError extends Error {
  readonly rateLimitResetAt: string | undefined;
  readonly rateLimited: boolean;

  constructor(message: string, readonly statusCode: number, resetHeader: string | null, remainingHeader: string | null) {
    super(message);
    this.name = "GitHubApiError";
    this.rateLimited = statusCode === 403 || statusCode === 429 || remainingHeader === "0";
    this.rateLimitResetAt = resetHeader && Number.isFinite(Number(resetHeader)) ? new Date(Number(resetHeader) * 1000).toISOString() : undefined;
  }
}

function buildContributorActivityAliases(login: string, repositories: RepositoryRecord[]): Array<{ alias: string; query: string }> {
  return repositories.flatMap((repo) => [
    {
      alias: activityAlias(repo.fullName, "all"),
      query: `repo:${repo.fullName} author:${login} type:pr sort:updated-desc`,
    },
    {
      alias: activityAlias(repo.fullName, "merged"),
      query: `repo:${repo.fullName} author:${login} type:pr is:merged sort:updated-desc`,
    },
    {
      alias: activityAlias(repo.fullName, "open"),
      query: `repo:${repo.fullName} author:${login} type:pr is:open sort:updated-desc`,
    },
    {
      alias: activityAlias(repo.fullName, "issues"),
      query: `repo:${repo.fullName} author:${login} type:issue sort:updated-desc`,
    },
  ]);
}

function buildContributorActivityQuery(aliases: Array<{ alias: string; query: string }>): string {
  const fields = aliases
    .map(
      ({ alias, query }) => `
        ${alias}: search(query: ${JSON.stringify(query)}, type: ISSUE, first: 20) {
          issueCount
          nodes {
            __typename
            ... on PullRequest {
              number
              title
              url
              state
              body
              updatedAt
              mergedAt
              labels(first: 10) { nodes { name } }
            }
            ... on Issue {
              number
              title
              url
              state
              body
              updatedAt
              labels(first: 10) { nodes { name } }
            }
          }
        }`,
    )
    .join("\n");
  return `query GittensoryContributorActivity {${fields}\n}`;
}

function activityAlias(repoFullName: string, kind: "all" | "merged" | "open" | "issues"): string {
  return `r_${repoFullName.replace(/[^A-Za-z0-9_]/g, "_")}_${kind}`;
}

function compactNodes(bucket: GitHubGraphQlSearchBucket | undefined): GitHubGraphQlSearchNode[] {
  return (bucket?.nodes ?? []).filter((node): node is GitHubGraphQlSearchNode => Boolean(node));
}

function labelsFromBucket(bucket: GitHubGraphQlSearchBucket | undefined): string[] {
  return compactNodes(bucket).flatMap((node) => (node.labels?.nodes ?? []).flatMap((label) => (label?.name ? [label.name] : [])));
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function countObservedLabels(records: Array<{ labels?: Array<{ name?: string }> }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const label of record.labels ?? []) {
      if (!label.name) continue;
      counts.set(label.name, (counts.get(label.name) ?? 0) + 1);
    }
  }
  return counts;
}

function extractLinkedIssueNumbers(text: string): number[] {
  const matches = [...text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)];
  return [...new Set(matches.map((match) => Number(match[1])).filter((value) => Number.isInteger(value) && value > 0))];
}

function topItems(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function latestDate(values: Array<string | null | undefined>): string | undefined {
  return values.filter(Boolean).sort().at(-1) ?? undefined;
}

function daysSince(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 0;
  return Math.floor((Date.now() - time) / 86_400_000);
}
