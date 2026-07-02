import {
  getRepositorySettings,
  getRepository,
  getPullRequest,
  countOpenIssues,
  countOpenPullRequests,
  countRecentMergedPullRequests,
  deletePullRequestFiles,
  countRepoLabels,
  getInstallation,
  listRepoGithubTotalsSnapshotHistory,
  getRepoSyncSegment,
  getRepoSyncState,
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
  listRecentMergedPullRequests,
  upsertRecentMergedPullRequest,
  upsertRepoLabel,
  upsertRepoSyncSegment,
  upsertRepoSyncState,
  upsertRepositoryFromGitHub,
  persistRepoSnapshot,
  extractLinkedIssueNumbers,
} from "../db/repositories";
import { agentRequiresPrWrite } from "../settings/agent-execution";
import type {
  ContributorRepoStatRecord,
  GitHubRateLimitObservationRecord,
  GitHubIssuePayload,
  GitHubPullRequestPayload,
  GitHubRepositoryPayload,
  InstallationHealthRecord,
  InstallationRecord,
  JsonValue,
  PullRequestDetailSyncStateRecord,
  PullRequestFileRecord,
  PullRequestRecord,
  RecentMergedPullRequestRecord,
  RepoGithubTotalsSnapshotRecord,
  RepoSyncSegmentRecord,
  RepoSyncStateRecord,
  RepositoryRecord,
  RepositorySettings,
} from "../types";
import { errorMessage, nowIso, repoParts, strippedErrorMessage } from "../utils/json";
import { createInstallationToken, getAppInstallation } from "./app";
import {
  GITTENSORY_CONTEXT_CHECK_NAME,
  GITTENSORY_GATE_CHECK_NAME,
  GITTENSORY_LEGACY_GATE_CHECK_NAME,
} from "../review/check-names";
import { buildReviewThreadBlocker, type ReviewThreadBlocker } from "../review/review-thread-findings";
import { delayUntil, shouldWaitForGitHubRateLimit } from "./rate-limit";
import {
  githubRateLimitAdmissionKeyForPublicToken,
  githubRateLimitAdmissionKeyForToken,
  isGitHubResponseCacheReplay,
  timeoutFetch,
  type GitHubRateLimitAdmissionKey,
} from "./client";
import { fetchCachedGitHubGraphQl } from "./graphql-cache";
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
  app?: { id?: number | null; slug?: string | null } | null;
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
type GitHubConditionalValidators = { etag?: string | null | undefined; lastModified?: string | null | undefined };
type GitHubJsonResponse<T> = { data: T; link: string | null; etag: string | null; lastModified: string | null };
type GitHubJsonNotModifiedResponse = { notModified: true; link: string | null; etag: string | null; lastModified: string | null };
type GitHubJsonConditionalResponse<T> = GitHubJsonResponse<T> | GitHubJsonNotModifiedResponse;
type GitHubSegmentConditionalRequest = { previous: RepoSyncSegmentRecord; validators: GitHubConditionalValidators };

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
const SEGMENT_PAGE_BUDGET: Record<BackfillMode, number> = { light: 2, full: 10, resume: 10 };
const PR_DETAIL_BATCH_SIZE: Record<BackfillMode, number> = { light: 12, full: 40, resume: 40 };
const CURRENT_OPEN_SCAN_MARKER = "gittensory-current-open-scan-v1";
const FRESH_TOTALS_SNAPSHOT_MS = 10 * 60 * 1000;
const TOTALS_SNAPSHOT_LOOKBACK = 8;
const repoGithubTotalsRefreshes = new Map<string, Promise<RepoGithubTotalsSnapshotRecord | undefined>>();

function repoInstallationPayload(repo: RepositoryRecord): { installationId?: number } {
  return typeof repo.installationId === "number" ? { installationId: repo.installationId } : {};
}

function repoAdmissionKeyForToken(
  env: Env,
  repo: RepositoryRecord,
  token: string | undefined,
): GitHubRateLimitAdmissionKey | undefined {
  return githubRateLimitAdmissionKeyForToken(env, token, repo.installationId);
}

type GitHubRateLimitOptions = { rateLimitAdmissionKey?: GitHubRateLimitAdmissionKey };

function githubRateLimitOptions(admissionKey: GitHubRateLimitAdmissionKey | undefined): GitHubRateLimitOptions {
  return admissionKey ? { rateLimitAdmissionKey: admissionKey } : {};
}

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
  const totals = await repoGithubTotalsForBackfill(env, repo, token, sourceKind);
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
        { type: "backfill-repo-segment", requestedBy: options.requestedBy, repoFullName: repo.fullName, ...repoInstallationPayload(repo), segment, mode, ...(options.force === undefined ? {} : { force: options.force }) },
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
      { type: "backfill-repo-segment", requestedBy: options.requestedBy === "schedule" || options.requestedBy === "test" ? options.requestedBy : "api", repoFullName: repo.fullName, ...repoInstallationPayload(repo), segment: options.segment, mode, force: true },
      { delaySeconds: delayUntil(resetAt) },
    );
    return segmentJobResult(repo.fullName, options.segment, segment);
  }
  const totals = await repoGithubTotalsForBackfill(env, repo, token, sourceKind);
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
      { type: "backfill-repo-segment", requestedBy: options.requestedBy === "schedule" || options.requestedBy === "test" ? options.requestedBy : "api", repoFullName: repo.fullName, ...repoInstallationPayload(repo), segment: options.segment, mode: "resume", force: true },
      { delaySeconds },
    );
  }
  if (options.segment === "open_pull_requests" && (result.status === "complete" || result.status === "not_modified")) {
    await env.JOBS.send({ type: "backfill-pr-details", requestedBy: "api", repoFullName: repo.fullName, ...repoInstallationPayload(repo), mode: "resume", cursor: 0 }, { delaySeconds: 10 });
  }
  await refreshRepoSyncStateFromSegments(env, repo, sourceKind);
  return segmentJobResult(repo.fullName, options.segment, result.segment);
}

async function repoGithubTotalsForBackfill(
  env: Env,
  repo: RepositoryRecord,
  token: string | undefined,
  sourceKind: RepoSyncSegmentRecord["sourceKind"],
): Promise<RepoGithubTotalsSnapshotRecord | null | undefined> {
  const { fresh, fallback } = await usableRepoGithubTotalsSnapshot(env, repo.fullName, sourceKind);
  if (fresh) return fresh;
  return (await refreshRepoGithubTotalsCoalesced(env, repo, token, sourceKind)) ?? fallback;
}

async function usableRepoGithubTotalsSnapshot(
  env: Env,
  repoFullName: string,
  sourceKind: RepoSyncSegmentRecord["sourceKind"],
): Promise<{ fresh?: RepoGithubTotalsSnapshotRecord; fallback?: RepoGithubTotalsSnapshotRecord }> {
  const snapshots = await listRepoGithubTotalsSnapshotHistory(env, repoFullName, { limit: TOTALS_SNAPSHOT_LOOKBACK });
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index]!;
    if (snapshot.sourceKind !== sourceKind) continue;
    const fetchedAtMs = Date.parse(snapshot.fetchedAt);
    const ageMs = Date.now() - fetchedAtMs;
    if (!Number.isFinite(fetchedAtMs) || ageMs < 0) continue;
    if (ageMs <= FRESH_TOTALS_SNAPSHOT_MS) return { fresh: snapshot, fallback: snapshot };
    return { fallback: snapshot };
  }
  return {};
}

async function refreshRepoGithubTotalsCoalesced(
  env: Env,
  repo: RepositoryRecord,
  token: string | undefined,
  sourceKind: RepoSyncSegmentRecord["sourceKind"],
): Promise<RepoGithubTotalsSnapshotRecord | undefined> {
  if (!token) return undefined;
  const key = `${sourceKind}:${repo.fullName}`;
  const inFlight = repoGithubTotalsRefreshes.get(key);
  if (inFlight) return inFlight;
  const refresh = refreshRepoGithubTotals(env, repo, token, sourceKind)
    .catch(() => undefined)
    .finally(() => {
      repoGithubTotalsRefreshes.delete(key);
    });
  repoGithubTotalsRefreshes.set(key, refresh);
  return refresh;
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
    await env.JOBS.send({ type: "backfill-pr-details", requestedBy: "api", repoFullName: repo.fullName, ...repoInstallationPayload(repo), mode, cursor: options.cursor ?? 0 }, { delaySeconds: delayUntil(resetAt) });
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
  const admissionKey = repoAdmissionKeyForToken(env, repo, token);
  await mapWithConcurrency(batch, 2, async (pr) => {
    await upsertPullRequestDetailSyncState(env, { repoFullName: repo.fullName, pullNumber: pr.number, status: "running" });
    const before = warnings.length;
    await fetchAndStorePullRequestDetails(env, repo.fullName, pr, token, warnings, admissionKey);
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
  const refreshedStateByPull = new Map(refreshedDetailStates.map((state) => [state.pullNumber, state.status]));
  const completedCount = refreshedDetailStates.filter((state) => openPullNumbers.has(state.pullNumber) && state.status === "complete").length;
  // Only keep cursoring over the oldest incomplete PRs if this batch actually shrank the incomplete
  // list. The cursor is fixed at 0, so a full batch of persistently-"partial" PRs (e.g. repeated
  // detail-fetch failures) never completes and never drops out; without this guard `nextCursor` would
  // stay 0 and re-queue the identical failing batch forever, starving every later PR. Stop as "partial"
  // when no progress is made; a later backfill run can retry once the transient failures clear.
  const incompleteAfter = openPullRequests.filter((pr) => refreshedStateByPull.get(pr.number) !== "complete").length;
  const madeProgress = incompleteAfter < incompleteOpenPullRequests.length;
  const nextCursor = batch.length < incompleteOpenPullRequests.length && madeProgress ? 0 : undefined;
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
    await env.JOBS.send({ type: "backfill-pr-details", requestedBy: "api", repoFullName: repo.fullName, ...repoInstallationPayload(repo), mode: "resume", cursor: nextCursor }, { delaySeconds: 20 });
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

export async function refreshPullRequestDetails(
  env: Env,
  repoFullName: string,
  pullNumber: number,
): Promise<{ ok: true; repoFullName: string; pullNumber: number; status: PullRequestDetailSyncStateRecord["status"]; warnings: string[] }> {
  const [repo, pr] = await Promise.all([getRepository(env, repoFullName), getPullRequest(env, repoFullName, pullNumber)]);
  if (!repo || !pr) {
    return { ok: true, repoFullName, pullNumber, status: "partial", warnings: ["Repository or pull request was not found."] };
  }
  const token = await tokenForRepo(env, repo);
  const admissionKey = repoAdmissionKeyForToken(env, repo, token);
  const warnings: string[] = [];
  await upsertPullRequestDetailSyncState(env, { repoFullName, pullNumber, status: "running" });
  await fetchAndStorePullRequestDetails(env, repoFullName, pr, token, warnings, admissionKey);
  const syncedAt = nowIso();
  const status: PullRequestDetailSyncStateRecord["status"] = warnings.length > 0 ? "partial" : "complete";
  await upsertPullRequestDetailSyncState(env, {
    repoFullName,
    pullNumber,
    status,
    filesSyncedAt: syncedAt,
    reviewsSyncedAt: syncedAt,
    checksSyncedAt: syncedAt,
    lastSyncedAt: syncedAt,
    errorSummary: warnings.at(-1),
  });
  return { ok: true, repoFullName, pullNumber, status, warnings };
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
      payload = await githubGraphQl<GitHubGraphQlContributorSearchResponse>(
        env,
        query,
        token,
        githubRateLimitAdmissionKeyForPublicToken(),
      );
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
      // allPullRequests, mergedPullRequests, and openPullRequests are overlapping views of the same
      // PR set -- deduplicate by URL before extracting labels to avoid counting a PR's labels multiple times.
      const seenUrls = new Set<string>();
      const uniquePrNodes = [...compactNodes(allPullRequests), ...compactNodes(mergedPullRequests), ...compactNodes(openPullRequests)].filter(
        (node) => node.url && !seenUrls.has(node.url) && seenUrls.add(node.url),
      );
      const labelNames = [
        ...uniquePrNodes.flatMap((node) => (node.labels?.nodes ?? []).flatMap((label) => (label?.name ? [label.name] : []))),
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
// Conditionally required: an installation whose autonomy ACTS on PR state (merge/close/approve/request_changes/
// update_branch) needs `pull_requests: write`, not the baseline `read`. Without this, install-health reported
// "healthy" for a repo configured to act that could only ever 403 at runtime. Mirrors the checks:write pattern.
// (#audit-install-health)
export const OPTIONAL_PR_WRITE_PERMISSION: Record<string, string> = {
  pull_requests: "write",
};

export const REQUIRED_INSTALLATION_EVENTS = ["issues", "issue_comment", "pull_request", "repository"] as const;
export const OPTIONAL_VISIBLE_INSTALLATION_EVENTS = ["installation_target", "installation_repositories"] as const;

type InstallationModeImpact = {
  mode: "comment" | "label" | "check_run" | "gate_check";
  enabled: boolean;
  affectedRepoCount: number;
  requiredPermissions: Array<{ permission: string; requiredAccess: string; missing: boolean; optional: boolean }>;
  summary: string;
  action: string;
};

type InstallationEventDiagnostic = {
  event: string;
  missing: boolean;
  optional: boolean;
  summary: string;
  action: string;
};

export function enrichInstallationHealth(health: InstallationHealthRecord) {
  const missingPermissions = new Set(health.missingPermissions);
  const requiredEventSet = new Set<string>(REQUIRED_INSTALLATION_EVENTS);
  const normalizedMissingEvents = health.missingEvents.filter((event) => requiredEventSet.has(event));
  const missingEvents = new Set(normalizedMissingEvents);
  const status =
    health.status === "needs_attention" && missingPermissions.size === 0 && missingEvents.size === 0 && !health.errorSummary
      ? "healthy"
      : health.status;
  const requiredPermissions = {
    ...REQUIRED_INSTALLATION_PERMISSIONS,
    ...(missingPermissions.has("checks") ? OPTIONAL_CHECK_RUN_PERMISSION : {}),
    // Persisted health stores only the missing permission name. If pull_requests is already granted at read level,
    // a missing pull_requests entry can only mean an acting autonomy needs write; otherwise preserve baseline read.
    ...(missingPermissions.has("pull_requests") && permissionSatisfies(health.permissions.pull_requests, "read") ? OPTIONAL_PR_WRITE_PERMISSION : {}),
  };
  return {
    ...health,
    status,
    missingEvents: normalizedMissingEvents,
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

export async function buildInstallationRepairDiagnostics(env: Env, health: InstallationHealthRecord) {
  const installedRepos = (await listRepositories(env)).filter((repo) => repo.installationId === health.installationId && repo.isInstalled);
  const installedSettings = await Promise.all(installedRepos.map((repo) => getRepositorySettings(env, repo.fullName)));
  const commentRepoCount = installedSettings.filter(usesCommentMode).length;
  const labelRepoCount = installedSettings.filter(usesLabelMode).length;
  const checkRunRepoCount = installedSettings.filter((settings) => settings.checkRunMode === "enabled").length;
  const gateCheckRepoCount = installedSettings.filter((settings) => settings.gateCheckMode === "enabled").length;
  const requiresPrWrite = installedSettings.some((settings) => agentRequiresPrWrite(settings.autonomy));
  const missingPermissions = new Set(health.missingPermissions);
  const requiredEventSet = new Set<string>(REQUIRED_INSTALLATION_EVENTS);
  const missingEvents = new Set(health.missingEvents.filter((event) => requiredEventSet.has(event)));
  const requiredPermissions = {
    ...REQUIRED_INSTALLATION_PERMISSIONS,
    ...(checkRunRepoCount > 0 || gateCheckRepoCount > 0 ? OPTIONAL_CHECK_RUN_PERMISSION : {}),
    ...(requiresPrWrite ? OPTIONAL_PR_WRITE_PERMISSION : {}), // acting autonomy → pull_requests:write (#audit-install-health)
  };
  const optionalPermissions = checkRunRepoCount > 0 || gateCheckRepoCount > 0 ? {} : OPTIONAL_CHECK_RUN_PERMISSION;
  const modeImpacts: InstallationModeImpact[] = [
    buildPermissionModeImpact({
      mode: "comment",
      enabled: commentRepoCount > 0,
      affectedRepoCount: commentRepoCount,
      permission: "issues",
      requiredAccess: "write",
      missing: missingPermissions.has("issues"),
      summary: "PR comments use GitHub issue comment endpoints, so comment mode requires Issues: write.",
    }),
    buildPermissionModeImpact({
      mode: "label",
      enabled: labelRepoCount > 0,
      affectedRepoCount: labelRepoCount,
      permission: "issues",
      requiredAccess: "write",
      missing: missingPermissions.has("issues"),
      summary: "PR labels use GitHub issue label endpoints, so label mode requires Issues: write.",
    }),
    buildPermissionModeImpact({
      mode: "check_run",
      enabled: checkRunRepoCount > 0,
      affectedRepoCount: checkRunRepoCount,
      permission: "checks",
      requiredAccess: "write",
      missing: checkRunRepoCount > 0 && missingPermissions.has("checks"),
      optional: checkRunRepoCount === 0,
      summary:
        checkRunRepoCount > 0
          ? "Check run mode is enabled for at least one installed repo, so Checks: write is required."
          : "Checks: write is optional unless check run mode is enabled for an installed repo.",
    }),
    buildPermissionModeImpact({
      mode: "gate_check",
      enabled: gateCheckRepoCount > 0,
      affectedRepoCount: gateCheckRepoCount,
      permission: "checks",
      requiredAccess: "write",
      missing: gateCheckRepoCount > 0 && missingPermissions.has("checks"),
      optional: gateCheckRepoCount === 0,
      summary:
        gateCheckRepoCount > 0
          ? "Review-agent check mode is enabled for at least one installed repo, so Checks: write is required."
          : "Checks: write is optional unless review-agent check mode is enabled for an installed repo.",
    }),
  ];
  const eventDiagnostics: InstallationEventDiagnostic[] = [
    ...REQUIRED_INSTALLATION_EVENTS.map((event) => ({
      event,
      missing: missingEvents.has(event),
      optional: false,
      summary: `Gittensory expects the ${event} webhook event for installation health and GitHub App automation.`,
      action: missingEvents.has(event) ? `Subscribe to the ${event} webhook event, then approve or reinstall the app.` : "No change needed.",
    })),
    ...OPTIONAL_VISIBLE_INSTALLATION_EVENTS.map((event) => ({
      event,
      missing: missingEvents.has(event),
      optional: true,
      summary:
        event === "installation_repositories"
          ? "GitHub sends installation repository add/remove events automatically; it is not a selectable subscription event in the app settings UI."
          : `The ${event} webhook event can appear in GitHub metadata, but it is not required for Gittensory PR automation.`,
      action: "No manual subscription is required.",
    })),
  ];
  return {
    generatedAt: nowIso(),
    installation: enrichInstallationHealth(health),
    installedRepos: installedRepos.map((repo, index) => ({
      repoFullName: repo.fullName,
      isRegistered: repo.isRegistered,
      settings: summarizeRepairSettings(installedSettings[index] as RepositorySettings),
    })),
    requiredPermissions,
    optionalPermissions,
    requiredEvents: [...REQUIRED_INSTALLATION_EVENTS],
    optionalEvents: [...OPTIONAL_VISIBLE_INSTALLATION_EVENTS],
    modeImpacts,
    eventDiagnostics,
    repairSteps:
      health.status === "healthy"
        ? ["No repair needed."]
        : [
            "Update the GitHub App permissions and subscribed events listed in diagnostics.",
            "Approve the changed permissions or reinstall the app on the target account.",
            `Run POST /v1/installations/${health.installationId}/repair/refresh after GitHub applies the changes.`,
            `Recheck GET /v1/installations/${health.installationId}/repair.`,
          ],
    refresh: {
      method: "POST",
      path: `/v1/installations/${health.installationId}/repair/refresh`,
      lastCheckedAt: health.checkedAt,
    },
  };
}

function buildPermissionModeImpact(args: {
  mode: InstallationModeImpact["mode"];
  enabled: boolean;
  affectedRepoCount: number;
  permission: string;
  requiredAccess: string;
  missing: boolean;
  summary: string;
  optional?: boolean;
}): InstallationModeImpact {
  const optional = args.optional ?? false;
  return {
    mode: args.mode,
    enabled: args.enabled,
    affectedRepoCount: args.affectedRepoCount,
    requiredPermissions: [{ permission: args.permission, requiredAccess: args.requiredAccess, missing: args.missing, optional }],
    summary: args.summary,
    action: args.missing ? `Set repository permission ${args.permission} to ${args.requiredAccess}, then approve or reinstall the app.` : "No change needed.",
  };
}

function usesCommentMode(settings: RepositorySettings): boolean {
  if (settings.commentMode === "off") return false;
  return settings.publicSurface === "comment_and_label" || settings.publicSurface === "comment_only";
}

function usesLabelMode(settings: RepositorySettings): boolean {
  return settings.autoLabelEnabled && (settings.publicSurface === "comment_and_label" || settings.publicSurface === "label_only");
}

function summarizeRepairSettings(settings: RepositorySettings) {
  return {
    publicSurface: settings.publicSurface,
    commentMode: settings.commentMode,
    publicAudienceMode: settings.publicAudienceMode,
    checkRunMode: settings.checkRunMode,
    gateCheckMode: settings.gateCheckMode,
    autoLabelEnabled: settings.autoLabelEnabled,
  };
}

export async function refreshInstallationHealth(env: Env) {
  const [installations, repositories] = await Promise.all([listInstallations(env), listRepositories(env)]);
  return refreshInstallationHealthRecords(env, installations, repositories);
}

export async function refreshInstallationHealthForInstallation(env: Env, installationId: number) {
  const [installation, repositories] = await Promise.all([getInstallation(env, installationId), listRepositories(env)]);
  if (!installation) return null;
  const refreshed = await refreshInstallationHealthRecords(env, [installation], repositories);
  return refreshed.installations[0] ?? null;
}

async function refreshInstallationHealthRecords(env: Env, installations: InstallationRecord[], repositories: RepositoryRecord[]) {
  const health = [];
  for (const installation of installations) {
    const { installation: currentInstallation, errorSummary } = await refreshStoredInstallation(env, installation);
    const installedRepos = repositories.filter((repo) => repo.installationId === currentInstallation.id && repo.isInstalled);
    const registeredInstalled = installedRepos.filter((repo) => repo.isRegistered);
    const installedSettings = await Promise.all(installedRepos.map((repo) => getRepositorySettings(env, repo.fullName)));
    const requiresChecks = installedSettings.some((settings) => settings.checkRunMode === "enabled");
    const requiresPrWrite = installedSettings.some((settings) => agentRequiresPrWrite(settings.autonomy));
    const requiredPermissions = {
      ...REQUIRED_INSTALLATION_PERMISSIONS,
      ...(requiresChecks ? OPTIONAL_CHECK_RUN_PERMISSION : {}),
      // An acting autonomy upgrades the pull_requests requirement read -> write (spread last so it wins). (#audit-install-health)
      ...(requiresPrWrite ? OPTIONAL_PR_WRITE_PERMISSION : {}),
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
  /* v8 ignore next -- Unknown GitHub permission strings are treated as insufficient; known permission ordering is covered. */
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
  const response = await githubGraphQl<GitHubRepoTotalsResponse>(
    env,
    query,
    token,
    repoAdmissionKeyForToken(env, repo, token),
  );
  const repository = response.data?.repository;
  /* v8 ignore next -- GitHub GraphQL should return repository data for an existing repo; this is provider anomaly handling. */
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
      // Hydrate each merged PR's changed files (like the monolithic backfill path) so
      // recent_merged_pull_requests.changedFiles is populated instead of always empty.
      const warnings: string[] = [];
      const admissionKey = repoAdmissionKeyForToken(env, repo, token);
      await hydrateMergedPullRequestFiles(env, repo.fullName, merged, token, warnings, 8, admissionKey);
      return merged.length;
    },
    { progressiveHistory: true, countPersisted: () => countRecentMergedPullRequests(env, repo.fullName) },
  );
}

// A merged PR is immutable, so its changed-file list never changes once stored. Skip the per-PR `/pulls/{n}/files`
// fetch — the N+1 REST fan-out that dominated this segment's GitHub cost — for any merged PR ALREADY hydrated,
// re-upserting only the cheap metadata (the upsert preserves the stored files when passed an empty list). One
// `listRecentMergedPullRequests` read per batch replaces up to one `/files` fetch per merged PR. (#1941)
async function hydrateMergedPullRequestFiles(
  env: Env,
  repoFullName: string,
  merged: GitHubPullRequestPayload[],
  token: string | undefined,
  warnings: string[],
  concurrency: number,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<void> {
  const alreadyHydrated = new Set(
    (await listRecentMergedPullRequests(env, repoFullName))
      .filter((record) => record.changedFiles.length > 0)
      .map((record) => record.number),
  );
  await mapWithConcurrency(merged, concurrency, async (pr) => {
    // fetchPullRequestFiles never throws — it returns [] (and records a warning) on any fetch failure.
    const changedFiles = alreadyHydrated.has(pr.number)
      ? []
      : await fetchPullRequestFiles(env, repoFullName, pr.number, token, warnings, admissionKey);
    await upsertRecentMergedPullRequest(env, toRecentMergedPullRequest(repoFullName, pr, changedFiles));
  });
}

function isNotModifiedResponse<T>(result: GitHubJsonConditionalResponse<T>): result is GitHubJsonNotModifiedResponse {
  return "notModified" in result && result.notModified;
}

function conditionalRequestForSegment(
  previous: RepoSyncSegmentRecord | null,
  expectedCount: number | undefined,
  options: { allowEtag: boolean },
): GitHubSegmentConditionalRequest | undefined {
  if (!previous) return undefined;
  if (!isFreshSegmentStatus(previous.status)) return undefined;
  if (previous.lastCursor !== "1") return undefined;
  if (previous.nextCursor) return undefined;
  if (expectedCount !== undefined && previous.expectedCount !== expectedCount) return undefined;
  const etag = options.allowEtag && previous.etag !== CURRENT_OPEN_SCAN_MARKER ? previous.etag : undefined;
  const lastModified = previous.lastModified;
  return etag || lastModified ? { previous, validators: { etag, lastModified } } : undefined;
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
  // Load the prior segment for EVERY mode, not just resume (#1942): a scheduled light/full crawl can then send the
  // stored ETag/If-Modified-Since as a conditional request, so an unchanged single-page list returns a 0-body 304
  // instead of a full re-list — the largest avoidable GitHub cost on the backfill cadence. Resume PAGINATION stays
  // gated on `canResumePreviousScan` (mode === "resume") below, and the open-scan segments that must reconcile
  // GitHub-side closes still force `allowEtag: false`, so this only enables the 304 fast-path where it is safe.
  const previous = await getRepoSyncSegment(env, repo.fullName, segmentName);
  const requiresCurrentOpenScan = Boolean(options.reconcileOnComplete);
  const canResumePreviousScan =
    mode === "resume" &&
    (!requiresCurrentOpenScan || previous?.etag === CURRENT_OPEN_SCAN_MARKER) &&
    Boolean(previous?.startedAt) &&
    (previous?.status === "running" || previous?.status === "partial" || previous?.status === "waiting_rate_limit");
  /* v8 ignore next -- canResumePreviousScan requires a prior startedAt; nowIso fallback protects legacy segment rows. */
  const startedAt = canResumePreviousScan ? previous?.startedAt ?? nowIso() : nowIso();
  await markSegmentRunning(env, repo, segmentName, sourceKind, mode, startedAt);
  const startPage =
    canResumePreviousScan && cursor && Number.isFinite(Number(cursor))
      ? Number(cursor)
      : canResumePreviousScan && previous?.nextCursor && Number.isFinite(Number(previous.nextCursor))
        ? Number(previous.nextCursor)
        : 1;
  /* v8 ignore next -- Resumable segment rows normally carry fetchedCount; zero fallback protects legacy/manual rows. */
  const priorFetched = canResumePreviousScan ? (previous?.fetchedCount ?? 0) : 0;
  let fetchedThisRun = 0;
  let lastCursor: string | undefined;
  let nextCursor: string | undefined;
  let pageCount = 0;
  let hasMore = false;
  let rateLimitResetAt: string | undefined;
  let etag: string | null | undefined;
  let lastModified: string | null | undefined;
  const warnings: string[] = [];
  let status: RepoSyncSegmentRecord["status"] = "complete";
  const conditionalRequest =
    startPage === 1
      ? conditionalRequestForSegment(previous, expectedCount, { allowEtag: !requiresCurrentOpenScan })
      : undefined;
  const admissionKey = repoAdmissionKeyForToken(env, repo, token);
  try {
    for (let page = startPage; page < startPage + SEGMENT_PAGE_BUDGET[mode]; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const pagePath = `${path}${separator}per_page=100&page=${page}`;
      let result: GitHubJsonResponse<T[]>;
      if (conditionalRequest && page === 1) {
        const conditionalResult = await githubJsonWithHeaders<T[]>(env, repo.fullName, pagePath, token, {
          validators: conditionalRequest.validators,
          allowNotModified: true,
          ...githubRateLimitOptions(admissionKey),
        });
        if (isNotModifiedResponse(conditionalResult)) {
          const previousSegment = conditionalRequest.previous;
          status = "not_modified";
          lastCursor = "1";
          pageCount = previousSegment.pageCount;
          etag = requiresCurrentOpenScan ? CURRENT_OPEN_SCAN_MARKER : conditionalResult.etag ?? previousSegment.etag;
          lastModified = conditionalResult.lastModified ?? previousSegment.lastModified;
          hasMore = false;
          nextCursor = undefined;
          break;
        }
        result = conditionalResult;
      } else {
        result = await githubJsonWithHeaders<T[]>(env, repo.fullName, pagePath, token, githubRateLimitOptions(admissionKey));
      }
      etag = result.etag ?? etag;
      lastModified = result.lastModified ?? lastModified;
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
      /* v8 ignore next -- Missing reset headers are a GitHub anomaly; waiting-rate-limit behavior is covered with reset values. */
      rateLimitResetAt = error.rateLimitResetAt ?? undefined;
      warnings.push(`GitHub sync is waiting for rate-limit recovery for ${path}: ${error.message}`);
    } else {
      status = fetchedThisRun > 0 ? "partial" : "error";
      warnings.push(`GitHub sync failed for ${path}: ${errorMessage(error)}`);
    }
  }
  /* v8 ignore next -- Most segment callers supply countPersisted; arithmetic fallback protects simple/custom segments. */
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
    /* v8 ignore next -- Reconciled open-data segments provide countPersisted; fallback protects custom segment callers. */
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
    etag: requiresCurrentOpenScan ? CURRENT_OPEN_SCAN_MARKER : etag,
    lastModified,
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
    /* v8 ignore next -- Under-count supplements normally re-count persisted rows; arithmetic fallback protects custom callers. */
    return options.countPersisted ? await options.countPersisted() : fetchedCount + supplemented;
  } catch (error) {
    warnings.push(`GitHub GraphQL supplement failed after REST undercount: ${errorMessage(error)}`);
    return fetchedCount;
  }
}

async function supplementOpenIssuesFromGraphQl(env: Env, repo: RepositoryRecord, token: string, seenOpenAt: string): Promise<number> {
  /* v8 ignore start -- Defensive GitHub GraphQL payload normalization is covered by sparse-payload backfill tests. */
  const existingNumbers = new Set(await listOpenIssueNumbers(env, repo.fullName));
  const { owner, name } = repoParts(repo.fullName);
  const admissionKey = repoAdmissionKeyForToken(env, repo, token);
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
    const response = await githubGraphQl<GitHubOpenIssuesResponse>(env, query, token, admissionKey);
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
  /* v8 ignore stop */
}

async function supplementOpenPullRequestsFromGraphQl(env: Env, repo: RepositoryRecord, token: string, seenOpenAt: string): Promise<number> {
  /* v8 ignore start -- Defensive GitHub GraphQL payload normalization is covered by sparse-payload backfill tests. */
  const existingNumbers = new Set((await listOpenPullRequests(env, repo.fullName)).map((pr) => pr.number));
  const { owner, name } = repoParts(repo.fullName);
  const admissionKey = repoAdmissionKeyForToken(env, repo, token);
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
    const response = await githubGraphQl<GitHubOpenPullRequestsResponse>(env, query, token, admissionKey);
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
  /* v8 ignore stop */
}

// Terminal segment states that count as synced. `sampled` is the terminal state of the
// recent_merged_pull_requests progressive-history crawl (no other segment produces it), and
// is already treated as synced for mergedPullRequestsSyncedAt; treating it as terminal here
// keeps a sampled history from perpetually marking the repo `partial`.
function isTerminalSegmentStatus(status: RepoSyncSegmentRecord["status"]): boolean {
  return status === "complete" || status === "not_modified" || status === "sampled";
}

function isFreshSegmentStatus(status: RepoSyncSegmentRecord["status"]): boolean {
  return status === "complete" || status === "not_modified";
}

async function refreshRepoSyncStateFromSegments(env: Env, repo: RepositoryRecord, sourceKind: RepoSyncSegmentRecord["sourceKind"]): Promise<void> {
  const [previous, totalsSnapshot, metadata, labels, openIssues, openPullRequests, recentMerged, files, reviews, checks] = await Promise.all([
    getRepoSyncState(env, repo.fullName),
    usableRepoGithubTotalsSnapshot(env, repo.fullName, sourceKind),
    getRepoSyncSegment(env, repo.fullName, "metadata"),
    getRepoSyncSegment(env, repo.fullName, "labels"),
    getRepoSyncSegment(env, repo.fullName, "open_issues"),
    getRepoSyncSegment(env, repo.fullName, "open_pull_requests"),
    getRepoSyncSegment(env, repo.fullName, "recent_merged_pull_requests"),
    getRepoSyncSegment(env, repo.fullName, "pull_request_files"),
    getRepoSyncSegment(env, repo.fullName, "pull_request_reviews"),
    getRepoSyncSegment(env, repo.fullName, "check_summaries"),
  ]);
  const totals = totalsSnapshot.fallback;
  // Include recent_merged_pull_requests so an unfinished merged-history crawl (running /
  // waiting_rate_limit / error / other non-terminal) is reflected in the repo status instead
  // of being silently rolled up as `success` and then skipped by the freshness check.
  const required = [metadata, labels, openIssues, openPullRequests, recentMerged, files, reviews, checks].filter(Boolean) as RepoSyncSegmentRecord[];
  const waiting = required.some((segment) => segment.status === "waiting_rate_limit" || segment.status === "rate_limited");
  const running = required.some((segment) => segment.status === "running" || segment.status === "refreshing");
  const errored = required.some((segment) => segment.status === "error");
  const incomplete = required.some((segment) => !isTerminalSegmentStatus(segment.status));
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
    labelsSyncedAt: labels && isFreshSegmentStatus(labels.status) ? labels.completedAt : previous?.labelsSyncedAt,
    issuesSyncedAt: openIssues && isFreshSegmentStatus(openIssues.status) ? openIssues.completedAt : previous?.issuesSyncedAt,
    pullRequestsSyncedAt: openPullRequests && isFreshSegmentStatus(openPullRequests.status) ? openPullRequests.completedAt : previous?.pullRequestsSyncedAt,
    mergedPullRequestsSyncedAt: recentMerged && (isFreshSegmentStatus(recentMerged.status) || recentMerged.status === "sampled") ? recentMerged.completedAt : previous?.mergedPullRequestsSyncedAt,
    lastStartedAt: previous?.lastStartedAt,
    lastCompletedAt: completedAt,
    errorSummary: warnings.at(-1),
    warnings,
  });
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
    const admissionKey = repoAdmissionKeyForToken(env, repo, token);
    await markSegmentRunning(env, repo, "metadata", sourceKind, mode, startedAt);
    const metadata = await githubJson<GitHubRepositoryPayload & { open_issues_count?: number; language?: string | null }>(
      env,
      repo.fullName,
      "",
      token,
      admissionKey,
    );
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
    await hydrateMergedPullRequestFiles(env, repo.fullName, recentMerged, token, warnings, limits.detailConcurrency, admissionKey);

    const detailTargets = normalizedPullRequests.slice(0, limits.pullRequestDetails);
    const detailWarningStart = warnings.length;
    await mapWithConcurrency(detailTargets, limits.detailConcurrency, async (pr) => {
      await fetchAndStorePullRequestDetails(env, repo.fullName, pr, token, warnings, admissionKey);
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

    /* v8 ignore next -- Registry config is present for registered backfills; empty fallback protects manually inserted repositories. */
    const configuredLabels = new Set(Object.keys(repo.registryConfig?.labelMultipliers ?? {}));
    const observedCounts = countObservedLabels([...issues, ...pullRequests, ...recentMerged]);
    for (const label of labelItems) {
      await upsertRepoLabel(env, {
        repoFullName: repo.fullName,
        name: label.name,
        color: label.color,
        description: label.description,
        isConfigured: configuredLabels.has(label.name),
        /* v8 ignore next -- Missing observed label counts normalize to zero; observed-count persistence is covered by backfill tests. */
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
    /* v8 ignore next -- Final sync status is response shaping over segment states covered by segment/backfill tests. */
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
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<void> {
  const warningStart = warnings.length;
  const [files, reviews, checks] = await Promise.all([
    fetchPullRequestFiles(env, repoFullName, pr.number, token, warnings, admissionKey),
    fetchPullRequestReviews(env, repoFullName, pr.number, token, warnings, admissionKey),
    fetchPullRequestChecks(env, repoFullName, pr, token, warnings, admissionKey),
  ]);
  const fileSyncFailed = warnings.slice(warningStart).some((warning) => warning.startsWith(`File sync failed for #${pr.number}:`));

  if (!fileSyncFailed) {
    await deletePullRequestFiles(env, repoFullName, pr.number);
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

// GitHub caps list endpoints at 100 items/page, so a single `per_page=100` fetch silently truncates a
// large PR's files/reviews/checks — which then undercounts churn/size and the slop padding detector.
// Walk the `Link` header instead, bounded so a pathological PR can't spin. A page-1 failure returns
// undefined (the caller can fall back to GraphQL); a later-page failure keeps the pages already fetched
// rather than dropping a successful first page.
const PR_DETAIL_MAX_PAGES = 10;

async function githubPaginatedList<T>(
  env: Env,
  repoFullName: string,
  path: string,
  token: string | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<T[] | undefined> {
  const items: T[] = [];
  for (let page = 1; page <= PR_DETAIL_MAX_PAGES; page += 1) {
    // Callers pass query-less resource paths (/pulls/N/files, /pulls/N/reviews), so the page params start the query.
    const result = await githubJsonWithHeaders<T[]>(env, repoFullName, `${path}?per_page=100&page=${page}`, token, githubRateLimitOptions(admissionKey)).catch(() => undefined);
    if (!result) return page === 1 ? undefined : items;
    items.push(...result.data);
    if (!hasNextPage(result.link)) break;
  }
  return items;
}

async function fetchPullRequestFiles(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  token: string | undefined,
  warnings: string[],
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<GitHubFilePayload[]> {
  const files = await githubPaginatedList<GitHubFilePayload>(env, repoFullName, `/pulls/${pullNumber}/files`, token, admissionKey);
  if (files) return files;
  const fallback = token ? await fetchPullRequestDetailsFromGraphQl(env, repoFullName, pullNumber, token, admissionKey).catch(() => undefined) : undefined;
  if (fallback) return fallback.files;
  warnings.push(`File sync failed for #${pullNumber}: GitHub REST and GraphQL detail fetches failed.`);
  return [];
}

/** Map a raw GitHub file payload to the stored {@link PullRequestFileRecord} shape (the same mapping
 *  `fetchAndStorePullRequestDetails` does when it persists a synced PR's files). */
function toPullRequestFileRecordFromGitHub(repoFullName: string, pullNumber: number, file: GitHubFilePayload): PullRequestFileRecord {
  return {
    repoFullName,
    pullNumber,
    path: file.filename,
    status: file.status,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    changes: file.changes ?? 0,
    previousFilename: file.previous_filename,
    payload: file as unknown as Record<string, JsonValue>,
  };
}

/**
 * Inline, best-effort file fetch for the REVIEW path (convergence). The PR-opened webhook can fire the review
 * BEFORE the async detail-sync has populated `pull_request_files`, leaving the AI review + grounding + unified
 * comment with an EMPTY diff ("0 files / No diff provided"). When `listPullRequestFiles` is empty at review
 * time, the caller falls back here: fetch the PR's files straight from GitHub (REST → GraphQL, same paths the
 * detail-sync uses), persist them (so the rest of the same review run + any later read reuse them), and return
 * them mapped to the stored record shape.
 *
 * Fail-safe by construction: a fetch failure returns `[]` (never throws), so the review degrades to the same
 * empty-diff state it has today rather than breaking. The persist is best-effort and only runs when the fetch
 * actually returned files (a failed REST+GraphQL fetch must not wipe a row another sync just wrote).
 */
export async function fetchAndStorePullRequestFilesForReview(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  token: string | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<PullRequestFileRecord[]> {
  const warnings: string[] = [];
  const files = await fetchPullRequestFiles(env, repoFullName, pullNumber, token, warnings, admissionKey).catch(() => [] as GitHubFilePayload[]);
  if (files.length === 0) return [];
  const records = files.map((file) => toPullRequestFileRecordFromGitHub(repoFullName, pullNumber, file));
  // Persist so the AI review, grounding, gate, check-run, and unified-comment reads in THIS run (and any later
  // read) reuse the synced files. Best-effort: a write hiccup must never sink the review — we still return the
  // freshly-fetched records the caller needs.
  for (const record of records) {
    await upsertPullRequestFile(env, record).catch(() => undefined);
  }
  return records;
}

async function fetchPullRequestReviews(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  token: string | undefined,
  warnings: string[],
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<GitHubReviewPayload[]> {
  const reviews = await githubPaginatedList<GitHubReviewPayload>(env, repoFullName, `/pulls/${pullNumber}/reviews`, token, admissionKey);
  if (reviews) return reviews;
  const fallback = token ? await fetchPullRequestDetailsFromGraphQl(env, repoFullName, pullNumber, token, admissionKey).catch(() => undefined) : undefined;
  if (fallback) return fallback.reviews;
  warnings.push(`Review sync failed for #${pullNumber}: GitHub REST and GraphQL detail fetches failed.`);
  return [];
}

async function fetchPullRequestChecks(
  env: Env,
  repoFullName: string,
  pr: PullRequestRecord,
  token: string | undefined,
  warnings: string[],
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<{ check_runs?: GitHubCheckRunPayload[] }> {
  if (!pr.headSha) return { check_runs: [] };
  // Same pagination as files/reviews, but the check-runs endpoint wraps the list in { check_runs }.
  const checkRuns: GitHubCheckRunPayload[] = [];
  for (let page = 1; page <= PR_DETAIL_MAX_PAGES; page += 1) {
    const result = await githubJsonWithHeaders<{ check_runs?: GitHubCheckRunPayload[] }>(
      env,
      repoFullName,
      `/commits/${pr.headSha}/check-runs?per_page=100&page=${page}`,
      token,
      githubRateLimitOptions(admissionKey),
    ).catch(() => undefined);
    if (!result) {
      if (page === 1) {
        warnings.push(`Check sync failed for #${pr.number}: GitHub REST check-run fetch failed.`);
        return { check_runs: [] };
      }
      break;
    }
    checkRuns.push(...(result.data.check_runs ?? []));
    if (!hasNextPage(result.link)) break;
  }
  return { check_runs: checkRuns };
}

// NOTE: "action_required" is deliberately NOT here. A fork PR awaiting maintainer "Approve and run" surfaces its
// required checks with conclusion="action_required" — that is NOT a failure, it is awaiting-approval. Treating it
// as failing made ciState="failed" → the agent one-shot CLOSED the fork ("CI is failing") even though no check
// ever ran. Excluded here, an action_required check falls through to anyPending → ciState="pending" → the PR is
// DEFERRED/held (never closed) until its runs are approved (manually, or auto-approved by fork CI auto-approval). (#fork-action-required)
const CI_FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "startup_failure"]);
const CI_PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
// The bot's OWN check-runs — it posts these (in_progress, then concluded) as PART OF reviewing. They are NOT
// "CI to wait on": counting them self-deadlocks (the review waits for all CI to finish; these only finish when
// the very review they're blocking runs → the PR defers forever). Excluded from the CI aggregate entirely.
// (#gate-self-deadlock — froze green-CI PRs as "CI still running". The Gate alone wasn't enough: the Context
// check is posted the same way and re-created the deadlock, so exclude ALL bot-owned checks.)
const BOT_OWNED_CHECK_NAMES = new Set<string>([
  GITTENSORY_GATE_CHECK_NAME,
  GITTENSORY_LEGACY_GATE_CHECK_NAME,
  GITTENSORY_CONTEXT_CHECK_NAME,
]);

const GITHUB_ACTIONS_VALIDATE_AGGREGATE_CONTEXT = "validate";
const GITHUB_ACTIONS_VALIDATE_AGGREGATE_PREREQUISITES = new Set([
  "changes",
  "security",
  "validate-code",
]);

function isOwnGitHubAppCheckRun(env: Env, run: { name: string; app?: { slug?: string | null } | null }): boolean {
  const appSlug = typeof run.app?.slug === "string" ? run.app.slug.trim().toLowerCase() : "";
  const ownSlug = env.GITHUB_APP_SLUG.trim().toLowerCase();
  return ownSlug.length > 0 && appSlug === ownSlug && BOT_OWNED_CHECK_NAMES.has(run.name);
}

function normalizeCiContextName(name: string): string {
  const trimmed = name.trim();
  const slashIndex = trimmed.lastIndexOf("/");
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1).trim() : trimmed;
}

function missingConventionalValidateAggregate(contextNames: ReadonlySet<string>): boolean {
  const normalized = new Set<string>();
  for (const name of contextNames) normalized.add(normalizeCiContextName(name));
  if (normalized.has(GITHUB_ACTIONS_VALIDATE_AGGREGATE_CONTEXT)) return false;
  for (const prerequisite of GITHUB_ACTIONS_VALIDATE_AGGREGATE_PREREQUISITES) {
    if (!normalized.has(prerequisite)) return false;
  }
  return true;
}

export type LiveCiAggregate = {
  ciState: "passed" | "failed" | "pending" | "unverified";
  // Any non-bot CI source that is still pending, inferred missing, or unreadable. This is deliberately broader
  // than ciState: a non-required pending check must not fail the gate, but review execution should still wait
  // until every visible CI signal has settled.
  hasPending: boolean;
  // A currently visible check-run/status/suite is still queued, waiting, or in_progress. Unlike inferred missing
  // contexts or unreadable pages, this is active CI and must not be overridden by the stale-CI surfacing cap.
  hasVisiblePending: boolean;
  // Checks that FAIL the gate. Any completed red check/status is adverse, required or not; required contexts are
  // still used for absent/pending detection so missing required CI cannot silently pass.
  failingDetails: Array<{ name: string; summary?: string; detailsUrl?: string }>;
  // Historical compatibility: non-required red checks are now folded into failingDetails so this stays empty.
  nonRequiredFailingDetails: Array<{ name: string; summary?: string; detailsUrl?: string }>;
  // Informational-only (#2137): set when the aggregate resolved to "passed" with no branch-protection required
  // contexts configured (`enforceRequiredOnly` false) — meaning a workflow that never triggers on this commit at
  // all (e.g. path-filtered out, or a broken YAML trigger) is indistinguishable from one that doesn't exist, and
  // would silently pass as long as at least one OTHER check ran and passed. NEVER changes ciState/disposition —
  // a self-hosted repo without an expected-checks list would otherwise get stuck "pending" forever on a workflow
  // that structurally can never complete. Surfaced to the operator as a nudge toward configuring branch
  // protection or an expected-checks list, not a gate blocker.
  ciCompletenessWarning: string | null;
};

/**
 * RC2 best-effort fetch of the base branch's branch-protection REQUIRED status-check contexts. Returns the set
 * of required context names (covering both the legacy `contexts` array and the newer `checks[].context` shape),
 * or `null` when none can be determined: a 404 (no protection / no required checks), a 403 (token lacks
 * `administration:read`, common for installations/forks), or any other error. `null`/empty makes
 * fetchLiveCiAggregate fall back to folding ALL red checks into the gate, so a fetch failure can never silently
 * pass a required red check.
 */
export async function fetchRequiredStatusContexts(
  env: Env,
  repoFullName: string,
  baseRef: string | null | undefined,
  token: string | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<Set<string> | null> {
  if (!baseRef) return null;
  const result = await githubJsonWithHeaders<{ contexts?: Array<string | null> | null; checks?: Array<{ context?: string | null }> | null }>(
    env,
    repoFullName,
    `/branches/${encodeURIComponent(baseRef)}/protection/required_status_checks`,
    token,
    githubRateLimitOptions(admissionKey),
  ).catch(() => undefined);
  if (!result) return null; // 404 / 403 (no admin:read) / error → conservative fold-all.
  const names = new Set<string>();
  for (const ctx of result.data.contexts ?? []) {
    if (typeof ctx === "string" && ctx.trim().length > 0) names.add(ctx);
  }
  for (const check of result.data.checks ?? []) {
    if (typeof check?.context === "string" && check.context.trim().length > 0) names.add(check.context);
  }
  return names;
}

// Minimal structural shape the CI reducer needs from a check-run — a superset of the REST GitHubCheckRunPayload
// (so REST payloads assign directly) AND buildable from the GraphQL CheckRun node (which has no `id`).
type LiveCiCheckRun = {
  name: string;
  status?: string | null;
  conclusion?: string | null;
  details_url?: string | null;
  output?: { title?: unknown; summary?: unknown };
  app?: { slug?: string | null } | null;
};
type LiveCiStatus = { context?: string | null; state?: string | null; description?: string | null; target_url?: string | null };
type LiveCiSuite = { status?: string | null; app?: { slug?: string | null } | null };

/**
 * Pure reduction of a head SHA's check-runs + classic statuses (+ a lazily-fetched check-suite backstop) into the
 * gate's LiveCiAggregate. Extracted so the REST fetch path (fetchLiveCiAggregate) and the GraphQL rollup path
 * (fetchLiveCiAggregateViaGraphQl) produce BYTE-IDENTICAL verdicts from ONE set of rules — only the data source
 * differs (#1941), which is what keeps the flag-gated GraphQL path semantically equivalent to the proven REST one.
 * `fetchSuites` is invoked ONLY when the cheaper sources are fully settled (no failure, no pending, no incomplete
 * read), mirroring the REST path's conditional suites read so neither path pays for it on an already-decided PR; it
 * returns the suite list, or null when that read is unreadable (fail-closed).
 */
async function reduceLiveCiAggregate(
  env: Env,
  inputs: {
    checkRuns: ReadonlyArray<LiveCiCheckRun>;
    statuses: ReadonlyArray<LiveCiStatus>;
    requiredContexts: ReadonlySet<string> | null | undefined;
    checkRunsIncomplete: boolean;
    statusIncomplete: boolean;
    fetchSuites: () => Promise<ReadonlyArray<LiveCiSuite> | null>;
  },
): Promise<LiveCiAggregate> {
  const { checkRuns, statuses, requiredContexts, checkRunsIncomplete, statusIncomplete, fetchSuites } = inputs;
  const enforceRequiredOnly = requiredContexts != null && requiredContexts.size > 0;
  const isRequired = (name: string): boolean => !enforceRequiredOnly || requiredContexts!.has(name);
  const failingDetails: LiveCiAggregate["failingDetails"] = [];
  const nonRequiredFailingDetails: LiveCiAggregate["nonRequiredFailingDetails"] = [];
  let total = 0;
  let anyPending = false;
  let anyVisiblePending = false;
  let anyRequiredVisiblePending = false;
  let sawFirstPartyCheckRun = false;
  const seenContextNames = new Set<string>();

  // 1) Check-runs (GitHub Actions jobs, CodeQL, app checks).
  for (const run of checkRuns) {
    seenContextNames.add(run.name); // mark BEFORE bot-check skip: a bot-owned required context is "seen"
    if ((run.app?.slug ?? "").toLowerCase() === "github-actions") sawFirstPartyCheckRun = true;
    if (isOwnGitHubAppCheckRun(env, run)) continue; // never wait on the bot's own Gate/Context check-runs
    total += 1;
    const conclusion = (run.conclusion ?? "").toLowerCase();
    const status = (run.status ?? "").toLowerCase();
    if (conclusion ? CI_FAILING_CONCLUSIONS.has(conclusion) : false) {
      const summary = [run.output?.title, run.output?.summary].find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim().slice(0, 200);
      failingDetails.push({ name: run.name, ...(summary ? { summary } : {}), ...(run.details_url ? { detailsUrl: run.details_url } : {}) });
    } else if (conclusion ? CI_PASSING_CONCLUSIONS.has(conclusion) : status === "completed") {
      // concluded and not failing → passing
    } else {
      anyVisiblePending = true;
      if (isRequired(run.name)) {
        anyPending = true; // queued / in_progress / not yet concluded — only a REQUIRED check holds the gate
        anyRequiredVisiblePending = true;
      }
    }
  }

  // 2) Classic commit-statuses (codecov/patch, codecov/project, and any other status-API context).
  for (const ctx of statuses) {
    const name = ctx.context ?? "status";
    total += 1;
    seenContextNames.add(name);
    const state = (ctx.state ?? "").toLowerCase();
    if (state === "failure" || state === "error") {
      const summary = typeof ctx.description === "string" ? ctx.description.trim().slice(0, 200) : "";
      failingDetails.push({ name, ...(summary ? { summary } : {}), ...(ctx.target_url ? { detailsUrl: ctx.target_url } : {}) });
    } else if (state === "success") {
      // passing
    } else {
      anyVisiblePending = true;
      if (isRequired(name)) {
        anyPending = true; // pending — only a REQUIRED context holds the gate
        anyRequiredVisiblePending = true;
      }
    }
  }

  // A required context that never appeared in any result is not safe to treat as passed — count it as pending.
  if (enforceRequiredOnly) {
    for (const ctx of requiredContexts!) {
      if (!seenContextNames.has(ctx)) anyPending = true;
    }
  }

  // Fold-all mode: a dependent aggregate check can briefly be absent after its prerequisites settled → pending.
  if (!enforceRequiredOnly && missingConventionalValidateAggregate(seenContextNames)) {
    anyPending = true;
  }

  // Check-suite hardening: read the check-SUITES too before certifying a commit settled (only when the cheaper
  // sources found no failure, no pending, and no incomplete page, so it never adds a call to an already-decided PR).
  if (failingDetails.length === 0 && !anyPending && !anyVisiblePending && !checkRunsIncomplete && !statusIncomplete) {
    const suites = await fetchSuites();
    if (!suites) {
      // Unreadable suites: fail CLOSED (pending) only when we ALSO never saw a first-party run and checks exist.
      if (!enforceRequiredOnly && !sawFirstPartyCheckRun && total > 0) anyPending = true;
    } else if (suites.some((suite) => (suite.app?.slug ?? "").toLowerCase() === "github-actions" && (suite.status ?? "").toLowerCase() !== "completed")) {
      anyPending = true; // a first-party GitHub Actions workflow has not completed
      anyVisiblePending = true;
      // Check suites do not expose required context names. With branch-protection contexts available, keep suite-only
      // pending CI eligible for the stale cap instead of treating every optional first-party workflow as required.
      if (!enforceRequiredOnly) anyRequiredVisiblePending = true;
    }
  }

  let ciState: LiveCiAggregate["ciState"] = failingDetails.length > 0 ? "failed" : anyPending ? "pending" : total > 0 ? "passed" : "unverified";
  // Fail CLOSED on incomplete visibility: an OBSERVED failure is authoritative and preserved.
  if ((checkRunsIncomplete || statusIncomplete) && ciState !== "failed") ciState = "pending";
  const hasPending = anyVisiblePending || anyPending || checkRunsIncomplete || statusIncomplete || ciState === "pending";
  // #2137 interim mitigation: without required-context branch protection, a workflow that never triggers at all
  // (path-filtered, or a broken trigger) is indistinguishable from one that doesn't exist, and folds into
  // "passed" as long as some OTHER check ran and passed. Never changes ciState (a self-hosted repo with no
  // expected-checks config would otherwise get stuck "pending" forever on a workflow that can structurally never
  // complete) — informational only, for the operator to notice and configure branch protection / an
  // expected-checks list against.
  const ciCompletenessWarning =
    !enforceRequiredOnly && ciState === "passed"
      ? "CI resolved to passed with no branch-protection required checks configured — gittensory cannot verify every expected workflow ran on this commit (a path-filtered or misconfigured workflow that never triggers is indistinguishable from one that doesn't exist). Configure branch protection or an expected-checks list for full CI-completeness verification."
      : null;
  return { ciState, hasPending, hasVisiblePending: anyRequiredVisiblePending, failingDetails, nonRequiredFailingDetails, ciCompletenessWarning };
}

/**
 * Fetch the head SHA's LIVE CI aggregate over BOTH GitHub Check-runs AND classic commit-statuses. This is the
 * reviewbot `getAllChecksState` parity that the converged auto-maintain path needs: codecov (codecov/patch,
 * codecov/project) and many other tools post a classic COMMIT-STATUS, not a check-run — fetching only
 * `/check-runs` (what the backfill sync does) misses them entirely, which is why a red codecov was reported as
 * "CI green". Any completed red check/status is adverse and fails the aggregate, required or not. Branch
 * protection contexts are still used for required-context absence/pending detection. Best-effort: a fetch error
 * degrades that source to empty.
 */
export async function fetchLiveCiAggregate(
  env: Env,
  repoFullName: string,
  headSha: string | null | undefined,
  token: string | undefined,
  // Branch-protection REQUIRED contexts are the trust boundary for required-context absence/pending detection.
  // Completed red checks/statuses still fail the aggregate even when they are not branch-protection-required.
  requiredContexts?: ReadonlySet<string> | null,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<LiveCiAggregate> {
  if (!headSha) return { ciState: "unverified", hasPending: false, hasVisiblePending: false, failingDetails: [], nonRequiredFailingDetails: [], ciCompletenessWarning: null };
  // Check-runs + classic statuses are accumulated across pages here; the single classification lives in
  // reduceLiveCiAggregate so the REST and GraphQL paths reach byte-identical verdicts (#1941).
  const checkRuns: LiveCiCheckRun[] = [];
  let checkRunsIncomplete = false;
  for (let page = 1; page <= PR_DETAIL_MAX_PAGES; page += 1) {
    const result = await githubJsonWithHeaders<{ check_runs?: Array<LiveCiCheckRun> }>(
      env,
      repoFullName,
      `/commits/${headSha}/check-runs?per_page=100&page=${page}`,
      token,
      githubRateLimitOptions(admissionKey),
    ).catch(() => undefined);
    // A failed check-runs fetch (page 1 or mid-pagination) leaves the check set partially read — fail closed.
    if (!result) {
      checkRunsIncomplete = true;
      break;
    }
    checkRuns.push(...(result.data.check_runs ?? []));
    if (!hasNextPage(result.link)) break;
  }
  // The combined status endpoint caps at 100/page, so accumulate every page before the reducer processes them.
  const statuses: LiveCiStatus[] = [];
  let statusIncomplete = false;
  for (let page = 1; page <= PR_DETAIL_MAX_PAGES; page += 1) {
    const statusResult = await githubJsonWithHeaders<{ statuses?: Array<LiveCiStatus> }>(
      env,
      repoFullName,
      `/commits/${headSha}/status?per_page=100&page=${page}`,
      token,
      githubRateLimitOptions(admissionKey),
    ).catch(() => undefined);
    if (!statusResult) {
      statusIncomplete = true;
      break;
    }
    statuses.push(...(statusResult.data.statuses ?? []));
    if (!hasNextPage(statusResult.link)) break;
  }
  return reduceLiveCiAggregate(env, {
    checkRuns,
    statuses,
    requiredContexts,
    checkRunsIncomplete,
    statusIncomplete,
    // Lazily read the check-SUITES backstop only when the reducer finds the cheaper sources fully settled; a fetch
    // error returns null so the reducer fails closed exactly as the inline path did.
    fetchSuites: async () => {
      const suitesResult = await githubJsonWithHeaders<{ check_suites?: Array<LiveCiSuite> }>(
        env,
        repoFullName,
        `/commits/${headSha}/check-suites?per_page=100`,
        token,
        githubRateLimitOptions(admissionKey),
      ).catch(() => undefined);
      return suitesResult ? (suitesResult.data.check_suites ?? []) : null;
    },
  });
}

/** #1941 flag: route the live CI aggregate through the GraphQL status rollup. OFF by default (byte-identical
 *  deploy); a truthy value opts a deployment in, and the GraphQL path still falls back to REST on any uncertainty. */
export function isStatusRollupGraphQlEnabled(env: { GITHUB_STATUS_ROLLUP_GRAPHQL?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITHUB_STATUS_ROLLUP_GRAPHQL ?? "");
}

/**
 * GraphQL equivalent of {@link fetchLiveCiAggregate}: ONE bounded query returns the head commit's statusCheckRollup
 * (check-runs AND classic statuses, unified) plus its check-suites — replacing the paginated /check-runs + /status
 * + /check-suites REST reads with a single call against the SEPARATE GraphQL points bucket (#1941). It reuses the
 * caller's REST-resolved `requiredContexts` (so required-context semantics are identical) and the SAME
 * reduceLiveCiAggregate rules, so the verdict is byte-identical to the REST path. Returns null — so the caller
 * falls back to the proven REST path — on ANY uncertainty: missing token/owner, a GraphQL error, an unexpected
 * shape, or >100 rollup contexts (a single page cannot enumerate them; the REST path paginates).
 */
export async function fetchLiveCiAggregateViaGraphQl(
  env: Env,
  repoFullName: string,
  headSha: string | null | undefined,
  token: string | undefined,
  requiredContexts?: ReadonlySet<string> | null,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<LiveCiAggregate | null> {
  if (!headSha || !token) return null;
  const [owner, name] = repoFullName.split("/");
  if (!owner || !name) return null;
  const query = `query GittensoryLiveCiRollup { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { object(oid: ${JSON.stringify(headSha)}) { ... on Commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name conclusion status detailsUrl title summary checkSuite { app { slug } } } ... on StatusContext { context state description targetUrl } } pageInfo { hasNextPage } } } checkSuites(first: 100) { nodes { status app { slug } } } } } } }`;
  const result = await githubGraphQl<{
    data?: {
      repository?: {
        object?: {
          statusCheckRollup?: {
            contexts?: {
              nodes?: Array<{
                __typename?: string;
                name?: string | null;
                conclusion?: string | null;
                status?: string | null;
                detailsUrl?: string | null;
                title?: string | null;
                summary?: string | null;
                checkSuite?: { app?: { slug?: string | null } | null } | null;
                context?: string | null;
                state?: string | null;
                description?: string | null;
                targetUrl?: string | null;
              }>;
              pageInfo?: { hasNextPage?: boolean };
            } | null;
          } | null;
          checkSuites?: { nodes?: Array<{ status?: string | null; app?: { slug?: string | null } | null }> };
        } | null;
      } | null;
    };
    errors?: unknown[];
  }>(env, query, token, admissionKey).catch(() => null);
  if (!result) return null; // GraphQL fetch/HTTP error → fall back to REST
  // A 200 with a top-level `errors` array is a PARTIAL result (a field resolver failed): the data is half-populated
  // and must NOT be read as a settled/empty rollup — fall back so a partial error can't mask a failing or pending
  // check as "no checks" and let the gate merge on it.
  if (Array.isArray(result.errors) && result.errors.length > 0) return null;
  const commit = result.data?.repository?.object;
  // A resolved Commit ALWAYS returns a `checkSuites` connection whose `nodes` is an array. If it is absent or not an
  // array, the object is not a Commit (or the shape is unexpected) → fall back rather than normalize the gap to
  // empty inputs (the exact failure the doc above promises to avoid).
  const suiteNodes = commit?.checkSuites?.nodes;
  if (!commit || !Array.isArray(suiteNodes)) return null;
  const rollup = commit.statusCheckRollup;
  const contexts = rollup?.contexts;
  // statusCheckRollup is null for a check-less commit (legitimate → empty inputs → "unverified"). A NON-null rollup
  // must carry a well-formed `contexts.nodes` array; a present-but-malformed connection → fall back to REST.
  if (rollup && !Array.isArray(contexts?.nodes)) return null;
  if (contexts?.pageInfo?.hasNextPage) return null; // >100 contexts: not fully enumerated → let REST paginate
  const checkRuns: LiveCiCheckRun[] = [];
  const statuses: LiveCiStatus[] = [];
  for (const node of contexts?.nodes ?? []) {
    if (node.__typename === "CheckRun") {
      // Field-name mapping only (detailsUrl→details_url, title/summary→output.*, checkSuite.app→app); the reducer
      // lowercases GraphQL's UPPERCASE conclusion/status enums, so no case handling is needed here.
      checkRuns.push({
        name: node.name ?? "",
        conclusion: node.conclusion ?? null,
        status: node.status ?? null,
        details_url: node.detailsUrl ?? null,
        output: { title: node.title ?? undefined, summary: node.summary ?? undefined },
        app: { slug: node.checkSuite?.app?.slug ?? null },
      });
    } else if (node.__typename === "StatusContext") {
      statuses.push({ context: node.context ?? null, state: node.state ?? null, description: node.description ?? null, target_url: node.targetUrl ?? null });
    }
  }
  const suites: LiveCiSuite[] = suiteNodes.map((suite) => ({ status: suite.status ?? null, app: { slug: suite.app?.slug ?? null } }));
  return reduceLiveCiAggregate(env, {
    checkRuns,
    statuses,
    requiredContexts,
    checkRunsIncomplete: false,
    statusIncomplete: false,
    fetchSuites: async () => suites, // already fetched in the same query — never a second round-trip
  });
}

/**
 * The gate's CI-aggregate entrypoint. When the #1941 flag is ON, try the GraphQL statusCheckRollup path and use it
 * UNLESS it returns null (any uncertainty — see fetchLiveCiAggregateViaGraphQl), otherwise the proven REST
 * aggregate; flag OFF → always REST (byte-identical). Kept as its own function (not inline at the call site) so the
 * flag + fallback branches are unit-testable in isolation.
 */
export async function fetchLiveCiAggregatePreferGraphQl(
  env: Env,
  repoFullName: string,
  headSha: string | null | undefined,
  token: string | undefined,
  requiredContexts?: ReadonlySet<string> | null,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<LiveCiAggregate> {
  if (isStatusRollupGraphQlEnabled(env)) {
    // fetchLiveCiAggregateViaGraphQl handles all its own errors and returns null on any uncertainty (it never
    // rejects), so a null result — not a throw — is the fall-back-to-REST signal.
    const rollup = await fetchLiveCiAggregateViaGraphQl(env, repoFullName, headSha, token, requiredContexts, admissionKey);
    if (rollup) return rollup;
  }
  return fetchLiveCiAggregate(env, repoFullName, headSha, token, requiredContexts, admissionKey);
}

/**
 * Fetch a PR's LIVE `mergeable_state` (clean / dirty / blocked / unstable / behind / has_hooks / unknown). The
 * STORED value lags GitHub's async recompute — e.g. right after gittensory[bot]'s own APPROVE flips a `blocked`
 * PR to `clean`, the stored row is still `blocked`, which stops an otherwise-eligible PR from auto-merging
 * (observed: green+approved PRs stuck OPEN at `mergeState=CLEAN`). The auto-maintain planner uses this so the
 * merge decision sees the CURRENT state. `unknown` (GitHub still computing) ⇒ caller treats as not-yet-clean and
 * a later trigger / the sweep retries. Best-effort: a fetch error returns undefined (caller falls back to stored).
 */
export async function fetchLivePullRequestMergeState(
  env: Env,
  repoFullName: string,
  prNumber: number,
  token: string | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<string | undefined> {
  const result = await githubJsonWithHeaders<{ mergeable_state?: string | null }>(env, repoFullName, `/pulls/${prNumber}`, token, githubRateLimitOptions(admissionKey)).catch(() => undefined);
  return result?.data.mergeable_state ?? undefined;
}

/** The PR's LIVE state ("open" / "closed") via REST `GET /pulls/{n}`. The stored open-PR cache lags GitHub, so a
 *  sibling closed/merged on GitHub can still read `open` locally; the duplicate-winner election (#dup-winner /
 *  audit #15) confirms a lower sibling's live state before treating this PR as a cluster loser. Best-effort:
 *  returns undefined on any error so the caller fails open to the stored state. */
export async function fetchLivePullRequestState(
  env: Env,
  repoFullName: string,
  prNumber: number,
  token: string | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<string | undefined> {
  const result = await githubJsonWithHeaders<{ state?: string | null }>(env, repoFullName, `/pulls/${prNumber}`, token, githubRateLimitOptions(admissionKey)).catch(() => undefined);
  return result?.data.state ?? undefined;
}

/** The PR's LIVE head commit SHA via REST `GET /pulls/{n}`. The stored `pr.headSha` lags GitHub when a commit
 *  lands between a webhook and its processing; the gate-override command (#16 / audit) re-fetches the live head
 *  so the neutral check-run targets the commit a maintainer is actually looking at, not a phantom old SHA.
 *  Best-effort: returns undefined on any error so the caller fails open to the stored head. */
export async function fetchLivePullRequestHeadSha(
  env: Env,
  repoFullName: string,
  prNumber: number,
  token: string | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<string | undefined> {
  const result = await githubJsonWithHeaders<{ head?: { sha?: string | null } | null }>(env, repoFullName, `/pulls/${prNumber}`, token, githubRateLimitOptions(admissionKey)).catch(() => undefined);
  return result?.data.head?.sha ?? undefined;
}

/** The PR's FULL live payload via REST `GET /pulls/{n}`, ready to feed `upsertPullRequestFromGitHub`. The scheduled
 *  re-gate sweep uses this to RESYNC a stored PR to its live head when a `synchronize` webhook was lost (e.g. the
 *  self-host relay was down), so the re-review runs on the current head + fresh files instead of a stale cached diff
 *  the AI fail-closes as INCOHERENT_DIFF (#sweep-resync). Best-effort: returns undefined on any error so the caller
 *  fails open to the stored PR (the sweep must never stall on a hiccup). */
export async function fetchLivePullRequest(
  env: Env,
  repoFullName: string,
  prNumber: number,
  token: string | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<GitHubPullRequestPayload | undefined> {
  const result = await githubJsonWithHeaders<GitHubPullRequestPayload>(env, repoFullName, `/pulls/${prNumber}`, token, githubRateLimitOptions(admissionKey)).catch(() => undefined);
  return result?.data ?? undefined;
}

/** Resolve the OPEN PRs associated with a commit SHA via the REST `GET /repos/{owner}/{repo}/commits/{sha}/pulls`
 *  endpoint. This is the only PR↔commit resolution that works for FORK (cross-repo) PRs, whose CI-completion
 *  webhooks (`check_suite`/`check_run`) carry an EMPTY `pull_requests[]`. Returns the de-duplicated open PR numbers.
 *  Best-effort: an empty/whitespace SHA or any API error yields `[]` (the caller must never stall a PR on a hiccup). */
export async function fetchOpenPullRequestNumbersForCommit(
  env: Env,
  repoFullName: string,
  commitSha: string,
  token: string | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<number[]> {
  const sha = commitSha.trim();
  if (!sha) return [];
  // GET /commits/{sha}/pulls returns the PRs (incl. cross-repo forks) whose head is this commit, on the default
  // `application/vnd.github+json` accept that githubRestHeaders already sends.
  const result = await githubJsonWithHeaders<Array<{ number?: number | null; state?: string | null }>>(
    env,
    repoFullName,
    `/commits/${encodeURIComponent(sha)}/pulls?per_page=100`,
    token,
    githubRateLimitOptions(admissionKey),
  ).catch(() => undefined);
  if (!result) return [];
  const numbers = result.data
    .filter((pr) => pr?.state === "open")
    .map((pr) => pr?.number)
    .filter((value): value is number => typeof value === "number");
  return [...new Set(numbers)];
}

/** RC1 (idempotent reviews): the PR's LIVE reviewDecision (APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED) via
 *  GraphQL. The STORED reviewDecision is only written by the open-PR backfill and goes stale, so the action
 *  planner's approve/request-changes dedup was blind and re-posted a review every cycle — the re-review loop.
 *  Refreshing it live makes the dedup accurate. Best-effort: returns undefined on any error (caller falls back
 *  to the stored value). */
export async function fetchLivePullRequestReviewDecision(
  env: Env,
  repoFullName: string,
  prNumber: number,
  token: string | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<string | undefined> {
  if (!token) return undefined;
  const [owner, name] = repoFullName.split("/");
  if (!owner || !name) return undefined;
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${prNumber}) { reviewDecision } } }`;
  const result = await githubGraphQl<{ data?: { repository?: { pullRequest?: { reviewDecision?: string | null } | null } | null } }>(
    env,
    query,
    token,
    admissionKey,
  ).catch(() => undefined);
  return result?.data?.repository?.pullRequest?.reviewDecision ?? undefined;
}

type GitHubReviewThreadNode = {
  isResolved?: boolean | null;
  isOutdated?: boolean | null;
  path?: string | null;
  line?: number | null;
  comments?: {
    nodes?: Array<{
      body?: string | null;
      url?: string | null;
      author?: { login?: string | null } | null;
      authorAssociation?: string | null;
    } | null> | null;
  } | null;
};

type GitHubReviewThreadConnection = {
  nodes?: Array<GitHubReviewThreadNode | null> | null;
  pageInfo?: {
    hasNextPage?: boolean | null;
    endCursor?: string | null;
  } | null;
};

type GitHubReviewThreadResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: GitHubReviewThreadConnection | null;
      } | null;
    } | null;
  };
};

/** Fetch unresolved GitHub review threads that should block merge readiness. GraphQL is required because REST
 *  review comments do not expose thread resolution; if GraphQL is unavailable this fails open to [] rather than
 *  guessing. Only maintainer/collaborator comments or known scanner-bot comments can create blockers, so
 *  public review comments from untrusted actors cannot influence merge/close state. */
export async function fetchLiveReviewThreadBlockers(
  env: Env,
  repoFullName: string,
  prNumber: number,
  token: string | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<ReviewThreadBlocker[]> {
  if (!token) return [];
  const [owner, name] = repoFullName.split("/");
  if (!owner || !name) return [];
  const threads: Array<GitHubReviewThreadNode | null> = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  for (;;) {
    const after: string = cursor ? `, after: ${JSON.stringify(cursor)}` : "";
    const query: string = `query GittensoryPullRequestReviewThreads {
      repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
        pullRequest(number: ${prNumber}) {
          reviewThreads(first: 50${after}) {
            nodes {
              isResolved
              isOutdated
              path
              line
              comments(first: 20) {
                nodes {
                  body
                  url
                  author { login }
                  authorAssociation
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }`;
    const result: GitHubReviewThreadResponse | undefined = await githubGraphQl<GitHubReviewThreadResponse>(
      env,
      query,
      token,
      admissionKey,
    ).catch(() => undefined);
    const connection: GitHubReviewThreadConnection | null | undefined = result?.data?.repository?.pullRequest?.reviewThreads;
    if (!connection?.nodes) {
      if (threads.length === 0) return [];
      break;
    }
    threads.push(...connection.nodes);
    if (connection.pageInfo?.hasNextPage !== true) break;
    const nextCursor: string | null | undefined = connection.pageInfo.endCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  const blockers: ReviewThreadBlocker[] = [];
  const memberPermissionCache = new Map<string, Promise<boolean>>();
  for (const thread of threads) {
    if (!thread || thread.isResolved !== false || thread.isOutdated === true) continue;
    const rawComments = (thread.comments?.nodes ?? [])
      .flatMap((comment) =>
        comment
          ? [
              {
                body: comment.body,
                url: comment.url,
                authorLogin: comment.author?.login,
                authorAssociation: comment.authorAssociation,
              },
            ]
          : [],
      );
    const comments: typeof rawComments = [];
    for (const comment of rawComments) {
      if (
        await isAuthorizedReviewThreadAuthor(
          env,
          repoFullName,
          token,
          memberPermissionCache,
          admissionKey,
          comment.authorLogin,
          comment.authorAssociation,
        )
      ) {
        comments.push(comment);
      }
    }
    const blocker = buildReviewThreadBlocker({
      path: thread.path,
      line: thread.line,
      comments,
    });
    if (blocker) blockers.push(blocker);
  }
  return blockers;
}

async function isAuthorizedReviewThreadAuthor(
  env: Env,
  repoFullName: string,
  token: string,
  memberPermissionCache: Map<string, Promise<boolean>>,
  admissionKey: GitHubRateLimitAdmissionKey | undefined,
  login: string | null | undefined,
  association: string | null | undefined,
): Promise<boolean> {
  if (isOwnReviewThreadAuthor(login)) return false;
  if (isTrustedScannerReviewThreadAuthor(login)) return true;
  if (isMaintainerReviewThreadAuthor(association)) return true;
  return isVerifiedMemberReviewThreadAuthor(env, repoFullName, token, memberPermissionCache, admissionKey, login, association);
}

const MAINTAINER_REVIEW_THREAD_ASSOCIATIONS = new Set(["OWNER", "COLLABORATOR"]);
function isMaintainerReviewThreadAuthor(association: string | null | undefined): boolean {
  return typeof association === "string" && MAINTAINER_REVIEW_THREAD_ASSOCIATIONS.has(association);
}

const REPOSITORY_WRITE_REVIEW_THREAD_PERMISSIONS = new Set(["admin", "maintain", "write"]);
// Raw GitHub review-comment MEMBER can mean org membership, so verify repo permission before trusting it.
function isVerifiedMemberReviewThreadAuthor(
  env: Env,
  repoFullName: string,
  token: string,
  memberPermissionCache: Map<string, Promise<boolean>>,
  admissionKey: GitHubRateLimitAdmissionKey | undefined,
  login: string | null | undefined,
  association: string | null | undefined,
): Promise<boolean> {
  if (association !== "MEMBER" || typeof login !== "string") return Promise.resolve(false);
  const normalizedLogin = login.trim();
  if (normalizedLogin === "") return Promise.resolve(false);
  const cacheKey = normalizedLogin.toLowerCase();
  const cached = memberPermissionCache.get(cacheKey);
  if (cached) return cached;
  const verified = githubJsonWithHeaders<{ permission?: string | null }>(
    env,
    repoFullName,
    `/collaborators/${encodeURIComponent(normalizedLogin)}/permission`,
    token,
    githubRateLimitOptions(admissionKey),
  )
    .then((result) => {
      const permission = result.data.permission;
      return typeof permission === "string" && REPOSITORY_WRITE_REVIEW_THREAD_PERMISSIONS.has(permission.toLowerCase());
    })
    .catch(() => false);
  memberPermissionCache.set(cacheKey, verified);
  return verified;
}

// External scanner GitHub App bot logins allowed to create review-thread blockers.
const TRUSTED_SCANNER_REVIEW_THREAD_AUTHORS = new Set(["superagent[bot]", "superagent-security[bot]", "superagent-security-dev[bot]", "brin[bot]"]);
function isTrustedScannerReviewThreadAuthor(login: string | null | undefined): boolean {
  return typeof login === "string" && TRUSTED_SCANNER_REVIEW_THREAD_AUTHORS.has(login.toLowerCase());
}

// Match only OUR OWN app bot login (a `gittensory` / `gittensory-orb[bot]` PREFIX), never a third-party slug
// that merely ENDS in `-gittensory[bot]`. Anchored to `^`: a `\b` boundary also fires after a hyphen, so the
// prior `\bgittensory…` misclassified e.g. `evil-gittensory[bot]` as our own author and dropped its
// review-thread comment as a self-authored non-blocker (fail-open) instead of evaluating it as external.
export function isOwnReviewThreadAuthor(login: string | null | undefined): boolean {
  return /^gittensory[-\w]*\[bot\]$/i.test(login ?? "") || /^(gittensory|gittensory-orb)$/i.test(login ?? "");
}

/** The deterministic linked-issue facts the hard-rule evaluator needs (labels / assignees / open-state). */
export type LinkedIssueFactsResult = { number: number; labels: string[]; assignees: string[]; state: string; authorLogin: string | null };

/** Tri-state outcome of fetching one linked issue's facts (#2136). `not_found` is a CONFIRMED 404 seen with a
 *  genuine, repo-scoped token — GitHub told an authenticated caller this issue number does not exist. `fetch_error`
 *  is everything else that prevented a read (network, 5xx, rate-limit, malformed body, or a 404 seen with only
 *  the public/anonymous token, which GitHub also returns for a real-but-inaccessible private issue) — a genuine
 *  outage or an unproven access gap, not confirmed evidence about the issue itself. Callers that treat an
 *  ALL-not_found result as significant (the linked-issue hard rule) must never extend that same treatment to
 *  fetch_error, or a GitHub outage would spuriously look like a fabricated reference. */
export type LinkedIssueFactsFetch =
  | { status: "found"; facts: LinkedIssueFactsResult }
  | { status: "not_found" }
  | { status: "fetch_error" };

/**
 * FETCH the facts for one linked issue via the REST issues endpoint. Distinguishes a CONFIRMED-nonexistent
 * issue (404) from a transient fetch failure (#2136) — a deterministic auto-close must never fire on a
 * transient failure, but a fabricated issue number is real, verifiable information the hard-rule evaluator
 * needs. Uses the same authenticated REST client + public-token 404-fallback as the other live fetches. (Note:
 * GitHub's issues endpoint also returns pull requests, which carry a `pull_request` field; a PR number passed
 * here would simply fail the rules — we only treat real issues' labels/assignees.)
 *
 * GitHub returns 404 for BOTH a genuinely nonexistent issue and a real-but-inaccessible one (private repo, no
 * grant) — it deliberately doesn't distinguish the two, to avoid leaking a private repo's existence to a caller
 * without access. So a 404 is only trustworthy as CONFIRMED absence when `token` is a genuine, repo-scoped
 * credential; the public/anonymous fallback token proves nothing about access. Without that, treat the 404 as
 * `fetch_error` (fails open) rather than risk closing a PR over a real linked issue our token just can't see.
 */
export async function fetchLinkedIssueFacts(
  env: Env,
  repoFullName: string,
  issueNumber: number,
  token: string | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<LinkedIssueFactsFetch> {
  let result;
  try {
    result = await githubJsonWithHeaders<{
      number?: number;
      state?: string | null;
      labels?: Array<{ name?: string | null } | string | null> | null;
      assignees?: Array<{ login?: string | null } | null> | null;
      user?: { login?: string | null } | null;
    }>(env, repoFullName, `/issues/${issueNumber}`, token, githubRateLimitOptions(admissionKey));
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.statusCode !== 404) return { status: "fetch_error" };
    const hasProvenAccess = Boolean(token) && token !== env.GITHUB_PUBLIC_TOKEN;
    return { status: hasProvenAccess ? "not_found" : "fetch_error" };
  }
  const data = result.data;
  const labels = (data.labels ?? []).flatMap((label) => {
    if (typeof label === "string") return label.length > 0 ? [label] : [];
    return label?.name ? [label.name] : [];
  });
  const assignees = (data.assignees ?? []).flatMap((assignee) => (assignee?.login ? [assignee.login] : []));
  return {
    status: "found",
    facts: {
      number: data.number ?? issueNumber,
      labels,
      assignees,
      state: String(data.state ?? "open").toLowerCase(),
      authorLogin: data.user?.login ?? null,
    },
  };
}

async function fetchPullRequestDetailsFromGraphQl(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  token: string,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<{ files: GitHubFilePayload[]; reviews: GitHubReviewPayload[] }> {
  /* v8 ignore start -- GitHub detail GraphQL sparse-node fallbacks are exercised through PR detail hydration tests. */
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
  const response = await githubGraphQl<GitHubPullRequestDetailsResponse>(env, query, token, admissionKey);
  const pullRequest = response.data?.repository?.pullRequest;
  if (!pullRequest) throw new GitHubApiError(`GitHub GraphQL failed for ${repoFullName} pull request #${pullNumber}: pull request not found`, 404, null, null, null, "");
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
  /* v8 ignore stop */
}

async function upsertContributorStats(
  env: Env,
  repoFullName: string,
  pullRequests: PullRequestRecord[],
  issues: GitHubIssuePayload[],
  recentMerged: GitHubPullRequestPayload[],
): Promise<void> {
  /* v8 ignore start -- Contributor-stat payload fallbacks normalize optional GitHub fields already covered by backfill round trips. */
  // Canonical case-insensitive login key so one user across mixed casings collapses to one row (#791).
  const loginByKey = new Map<string, string>();
  const addLogin = (value: string | null | undefined): void => {
    const key = value?.toLowerCase();
    if (key && !loginByKey.has(key)) loginByKey.set(key, value as string);
  };
  for (const pr of pullRequests) addLogin(pr.authorLogin);
  for (const pr of recentMerged) addLogin(pr.user?.login);
  for (const issue of issues) addLogin(issue.user?.login);

  for (const [loginKey, login] of loginByKey) {
    const authoredPullRequests = pullRequests.filter((pr) => pr.authorLogin?.toLowerCase() === loginKey);
    const authoredMerged = recentMerged.filter((pr) => pr.user?.login?.toLowerCase() === loginKey);
    const authoredIssues = issues.filter((issue) => issue.user?.login?.toLowerCase() === loginKey);
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
  /* v8 ignore stop */
}

function toRecentMergedPullRequest(repoFullName: string, pr: GitHubPullRequestPayload, files: GitHubFilePayload[]): RecentMergedPullRequestRecord {
  /* v8 ignore start -- Optional GitHub payload defaults are defensive normalization for sparse REST rows. */
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
  /* v8 ignore stop */
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
  const items: GitHubLabelPayload[] = [];
  const admissionKey = repoAdmissionKeyForToken(env, repo, token);
  try {
    for (let page = 1; ; page += 1) {
      const result = await githubJsonWithHeaders<GitHubLabelPayload[]>(env, repo.fullName, `/labels?per_page=100&page=${page}`, token, githubRateLimitOptions(admissionKey));
      items.push(...result.data);
      if (!hasNextPage(result.link)) break;
    }
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
      fetchedCount: items.length,
      warnings: [warning],
      errorSummary: warning,
      rateLimitResetAt: error instanceof GitHubApiError ? error.rateLimitResetAt : undefined,
    });
    return { items, warnings: [warning], segment };
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
  const admissionKey = repoAdmissionKeyForToken(env, repo, token);
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
    // Hold `per_page` CONSTANT for the whole crawl. GitHub's `page` offset is `(page-1)*per_page`, so it is
    // only valid if `per_page` never changes mid-crawl. The previous code recomputed it from the shrinking
    // budget (`min(100, limit - items.length)`), which broke offsets past page 1 whenever `limit` was not a
    // multiple of 100 (per_page=50 on page 2 re-read items 51-100 instead of 101-150). Using
    // `min(100, limit)` keeps the request/cursor grid stable: a small `limit` fetches exactly `limit` per
    // page (so a page-precision resume cursor advances by one page), and a large `limit` fetches full 100s.
    const perPage = Math.min(100, limit);
    for (let page = startPage; items.length < limit; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const pagePath = `${path}${separator}per_page=${perPage}&page=${page}`;
      const result = await githubJsonWithHeaders<T[]>(env, repo.fullName, pagePath, token, githubRateLimitOptions(admissionKey));
      etag = result.etag ?? etag;
      lastModified = result.lastModified ?? lastModified;
      lastCursor = String(page);
      pageCount += 1;
      const remaining = limit - items.length;
      // A page can only overrun `remaining` once we have already consumed at least one full page (so `page`
      // has advanced past the crawl's start): resume from THIS page to pick up its unconsumed tail. On the
      // first page `remaining >= perPage >= result.data.length`, so this is false and the cursor advances,
      // which is why a small-`limit` (per_page = limit) crawl can never stall on its own start page.
      const truncatedPage = result.data.length > remaining;
      items.push(...result.data.slice(0, remaining));
      const hasNext = hasNextPage(result.link);
      if (items.length >= limit && (hasNext || truncatedPage)) {
        nextCursor = String(truncatedPage ? page : page + 1);
        status = "capped";
        warnings.push(`GitHub sync reached local cap of ${limit} item(s) for ${path}; next page cursor is ${nextCursor}.`);
        break;
      }
      if (result.data.length < perPage || !hasNext) break;
      nextCursor = String(page + 1);
    }
  } catch (error) {
    status = error instanceof GitHubApiError && error.rateLimited ? "rate_limited" : items.length > 0 ? "partial" : "error";
    rateLimitResetAt = error instanceof GitHubApiError ? error.rateLimitResetAt : undefined;
    warnings.push(`GitHub sync failed for ${path}: ${errorMessage(error)}`);
  }

  // A fully drained fetch has no next page: drop the speculative cursor so an exact-`limit` final page
  // reads as "complete", not "capped". Genuine overflow is already capped with its cursor in the loop.
  if (status === "complete") {
    nextCursor = undefined;
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

async function githubJson<T>(
  env: Env,
  repoFullName: string,
  path: string,
  token?: string,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<T> {
  return (await githubJsonWithHeaders<T>(env, repoFullName, path, token, githubRateLimitOptions(admissionKey))).data;
}

type GitHubJsonRequestOptions = {
  validators?: GitHubConditionalValidators;
  rateLimitAdmissionKey?: GitHubRateLimitAdmissionKey;
};
type GitHubJsonStandardOptions = GitHubJsonRequestOptions & { allowNotModified?: false };
type GitHubJsonConditionalOptions = GitHubJsonRequestOptions & { allowNotModified: true };

async function githubJsonWithHeaders<T>(
  env: Env,
  repoFullName: string,
  path: string,
  token?: string,
): Promise<GitHubJsonResponse<T>>;
async function githubJsonWithHeaders<T>(
  env: Env,
  repoFullName: string,
  path: string,
  token: string | undefined,
  options: GitHubJsonConditionalOptions,
): Promise<GitHubJsonConditionalResponse<T>>;
async function githubJsonWithHeaders<T>(
  env: Env,
  repoFullName: string,
  path: string,
  token: string | undefined,
  options: GitHubJsonStandardOptions,
): Promise<GitHubJsonResponse<T>>;
async function githubJsonWithHeaders<T>(
  env: Env,
  repoFullName: string,
  path: string,
  token?: string,
  options?: GitHubJsonConditionalOptions | GitHubJsonStandardOptions,
): Promise<GitHubJsonConditionalResponse<T> | GitHubJsonResponse<T>> {
  const { owner, name } = repoParts(repoFullName);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${path}`;
  let response = await timeoutFetch(url, {
    headers: githubRestHeaders(token, options?.validators),
    ...(options?.rateLimitAdmissionKey ? { githubRateLimitAdmission: true, githubRateLimitAdmissionKey: options.rateLimitAdmissionKey } : {}),
  });
  if (!isGitHubResponseCacheReplay(response)) {
    await recordGitHubResponse(env, repoFullName, path, response, "rest", options?.rateLimitAdmissionKey);
  }
  if (response.status === 304 && options?.allowNotModified) return notModifiedResponse(response);
  if (response.status === 404 && token && token === env.GITHUB_PUBLIC_TOKEN) {
    response = await timeoutFetch(url, { headers: githubRestHeaders(undefined, options?.validators) });
    // Do not persist unauthenticated fallback rate-limit headers into the shared REST backoff state.
    // GitHub's unauthenticated REST bucket is capped below LOW_REST_RATE_LIMIT_REMAINING, so recording
    // successful fallback responses can incorrectly stall later token-backed segment jobs.
  }
  if (response.status === 304 && options?.allowNotModified) return notModifiedResponse(response);
  if (!response.ok) {
    const body = await response.text();
    throw new GitHubApiError(
      `GitHub API failed for ${repoFullName}${path} (${response.status}): ${body.slice(0, 180)}`,
      response.status,
      response.headers.get("x-ratelimit-reset"),
      response.headers.get("x-ratelimit-remaining"),
      response.headers.get("retry-after"),
      body,
    );
  }
  return {
    data: (await response.json()) as T,
    link: response.headers.get("link"),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

function notModifiedResponse(response: Response): GitHubJsonNotModifiedResponse {
  return {
    notModified: true,
    link: response.headers.get("link"),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

function githubRestHeaders(token?: string, validators?: GitHubConditionalValidators): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "gittensory/0.1",
    "x-github-api-version": "2022-11-28",
    ...(validators?.etag ? { "if-none-match": validators.etag } : {}),
    ...(validators?.lastModified ? { "if-modified-since": validators.lastModified } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function githubGraphQl<T>(
  env: Env,
  query: string,
  token: string,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<T> {
  const response = await fetchCachedGitHubGraphQl(query, token, admissionKey);
  if (!isGitHubResponseCacheReplay(response)) {
    await recordGitHubResponse(env, null, "/graphql", response, "graphql", admissionKey);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new GitHubApiError(
      `GitHub GraphQL failed (${response.status}): ${body.slice(0, 180)}`,
      response.status,
      response.headers.get("x-ratelimit-reset"),
      response.headers.get("x-ratelimit-remaining"),
      response.headers.get("retry-after"),
      body,
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
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<void> {
  const resetHeader = response.headers.get("x-ratelimit-reset");
  const resetAt = resetHeader && Number.isFinite(Number(resetHeader)) ? new Date(Number(resetHeader) * 1000).toISOString() : undefined;
  await recordGitHubRateLimitObservation(env, {
    repoFullName,
    admissionKey,
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

// Mirror of app.ts's isRateLimitedResponse, reconstructed from the status, rate-limit headers, and body that
// a backfill REST/GraphQL failure carries. A 403/429 signals a rate limit ONLY when it has a Retry-After
// header, an exhausted x-ratelimit-remaining, or a secondary-limit/abuse body. A bare 403 — "Resource not
// accessible by integration", a missing scope, branch protection — is a real permission/other error: it must
// surface as an error (or partial) rather than being recorded as a rate-limit wait and triggering backoff.
// Exported for tests.
export function isRateLimitedGitHubFailure(args: {
  statusCode: number;
  retryAfter: string | null;
  remaining: string | null;
  body: string;
}): boolean {
  if (args.statusCode !== 403 && args.statusCode !== 429) return false;
  if (args.retryAfter != null) return true;
  if (args.remaining === "0") return true;
  return /secondary rate limit|\babuse\b|api rate limit exceeded/i.test(args.body);
}

class GitHubApiError extends Error {
  readonly rateLimitResetAt: string | undefined;
  readonly rateLimited: boolean;

  constructor(message: string, readonly statusCode: number, resetHeader: string | null, remainingHeader: string | null, retryAfterHeader: string | null, body: string) {
    super(message);
    this.name = "GitHubApiError";
    this.rateLimited = isRateLimitedGitHubFailure({ statusCode, retryAfter: retryAfterHeader, remaining: remainingHeader, body });
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
  /* v8 ignore start -- Label-count fallback handles sparse GitHub rows; full backfill tests cover observed label persistence. */
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const label of record.labels ?? []) {
      if (!label.name) continue;
      counts.set(label.name, (counts.get(label.name) ?? 0) + 1);
    }
  }
  return counts;
  /* v8 ignore stop */
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
  // Drop unparseable values before the lexicographic max: a malformed/sentinel timestamp whose first char
  // sorts after "2" (e.g. "bad-date", "pending") would otherwise outrank a real 2026-... ISO stamp and be
  // persisted as lastActivityAt. Mirrors the guarded newest()/oldest() in signals/data-quality.ts.
  return values.filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value)))).sort().at(-1) ?? undefined;
}

function daysSince(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 0;
  return Math.floor((Date.now() - time) / 86_400_000);
}
