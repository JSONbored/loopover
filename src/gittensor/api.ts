import type { ContributorRepoStatRecord } from "../types";
import { errorMessage } from "../utils/json";

const GITTENSOR_API_BASE = "https://api.gittensor.io";
const GITTENSOR_MIRROR_API_BASE = "https://mirror.gittensor.io/api/v1";

type GittensorMinerSummaryResponse = {
  uid?: number;
  hotkey?: string;
  githubUsername?: string;
  githubId?: string;
  failedReason?: string | null;
  totalOpenPrs?: number;
  totalClosedPrs?: number;
  totalMergedPrs?: number;
  totalPrs?: number;
  uniqueReposCount?: number;
  isEligible?: boolean;
  credibility?: number;
  eligibleRepoCount?: number;
  issueDiscoveryScore?: number;
  issueTokenScore?: number;
  issueCredibility?: number;
  isIssueEligible?: boolean;
  issueEligibleRepoCount?: number;
  totalSolvedIssues?: number;
  totalValidSolvedIssues?: number;
  totalClosedIssues?: number;
  totalOpenIssues?: number;
  evaluatedAt?: string;
  updatedAt?: string;
  alphaPerDay?: number;
  taoPerDay?: number;
  usdPerDay?: number;
};

type ConfirmedGittensorMinerSummaryResponse = GittensorMinerSummaryResponse & {
  githubId: string;
  githubUsername: string;
};

type GittensorMinerDetailResponse = GittensorMinerSummaryResponse & {
  repositories?: GittensorRepositoryEvaluationResponse[];
};

type GittensorRepositoryEvaluationResponse = {
  repositoryFullName?: unknown;
  totalOpenPrs?: number | string;
  totalClosedPrs?: number | string;
  totalMergedPrs?: number | string;
  totalPrs?: number | string;
  totalOpenIssues?: number | string;
  totalClosedIssues?: number | string;
  totalSolvedIssues?: number | string;
  totalValidSolvedIssues?: number | string;
  isEligible?: boolean;
  isIssueEligible?: boolean;
  credibility?: number | string;
  issueCredibility?: number | string;
  totalScore?: number | string;
  baseTotalScore?: number | string;
};

type GittensorPullRequestResponse = {
  pullRequestNumber?: number;
  pullRequestTitle?: string;
  repository?: string;
  prState?: string;
  mergedAt?: string | null;
  author?: string;
  githubId?: string;
  label?: string | null;
  score?: string | number;
  baseScore?: string | number;
  collateralScore?: string | number;
  tokenScore?: string | number;
  reviewQualityMultiplier?: string | number;
  labelMultiplier?: string | number;
  codeDensity?: string | number;
};

type GittensorMinerIssuesResponse = {
  issues?: Array<{
    repo_full_name?: string;
    issue_number?: number;
    state?: string;
    author_association?: string | null;
    labels?: Array<{ name?: string | null }>;
    solved_by_pr?: number | null;
  }>;
};

export type GittensorContributorSnapshot = {
  source: "gittensor_api";
  githubId: string;
  githubUsername: string;
  uid?: number | undefined;
  hotkey?: string | undefined;
  failedReason?: string | null | undefined;
  evaluatedAt?: string | undefined;
  updatedAt?: string | undefined;
  isEligible: boolean;
  credibility: number;
  eligibleRepoCount: number;
  issueDiscoveryScore: number;
  issueTokenScore: number;
  issueCredibility: number;
  isIssueEligible: boolean;
  issueEligibleRepoCount: number;
  alphaPerDay: number;
  taoPerDay: number;
  usdPerDay: number;
  totals: {
    pullRequests: number;
    mergedPullRequests: number;
    openPullRequests: number;
    closedPullRequests: number;
    openIssues: number;
    closedIssues: number;
    solvedIssues: number;
    validSolvedIssues: number;
  };
  repositories: Array<{
    repoFullName: string;
    pullRequests: number;
    mergedPullRequests: number;
    openPullRequests: number;
    closedPullRequests: number;
    openIssues: number;
    closedIssues: number;
    solvedIssues: number;
    validSolvedIssues: number;
    isEligible: boolean;
    isIssueEligible: boolean;
    credibility: number;
    issueCredibility: number;
    totalScore: number;
    baseTotalScore: number;
  }>;
  pullRequests: Array<{
    repoFullName: string;
    number: number;
    title: string;
    state: string;
    mergedAt?: string | null | undefined;
    label?: string | null | undefined;
    score: number;
    baseScore: number;
    tokenScore: number;
  }>;
  issueMirrorAvailable?: boolean | undefined;
  issues?: Array<{
    repoFullName: string;
    number: number;
    state: string;
    solvedByPullRequest?: number | null | undefined;
    labels: string[];
  }> | undefined;
  issueLabels: string[];
};

export async function fetchGittensorContributorSnapshot(login: string): Promise<GittensorContributorSnapshot | null> {
  try {
    const detection = await fetchOfficialGittensorMiner(login);
    return detection.status === "confirmed" ? detection.snapshot : null;
  } catch {
    /* v8 ignore next -- fetchOfficialGittensorMiner converts network failures into an unavailable status; this is a last-resort guard. */
    return null;
  }
}

export type OfficialGittensorMinerDetection =
  | { status: "confirmed"; snapshot: GittensorContributorSnapshot }
  | { status: "not_found" }
  | { status: "unavailable"; error: string };

export async function fetchOfficialGittensorMiner(login: string): Promise<OfficialGittensorMinerDetection> {
  try {
    const miners = await fetchJson<GittensorMinerSummaryResponse[]>(`${GITTENSOR_API_BASE}/miners`);
    const normalizedLogin = login.toLowerCase();
    const miner = miners.find((candidate) => candidate.githubUsername?.toLowerCase() === normalizedLogin);
    if (!miner?.githubId || !miner.githubUsername) return { status: "not_found" };
    return { status: "confirmed", snapshot: await buildGittensorContributorSnapshot({ ...miner, githubId: miner.githubId, githubUsername: miner.githubUsername }) };
  } catch (error) {
    return { status: "unavailable", error: errorMessage(error, "unknown Gittensor API error") };
  }
}

export function contributorRepoStatsFromGittensor(snapshot: GittensorContributorSnapshot | null): ContributorRepoStatRecord[] {
  if (!snapshot) return [];
  return snapshot.repositories.map((repo) => ({
    login: snapshot.githubUsername.toLowerCase(),
    repoFullName: repo.repoFullName,
    pullRequests: repo.pullRequests,
    mergedPullRequests: repo.mergedPullRequests,
    openPullRequests: repo.openPullRequests,
    issues: repo.openIssues + repo.closedIssues,
    stalePullRequests: 0,
    unlinkedPullRequests: 0,
    dominantLabels: [],
    lastActivityAt: snapshot.updatedAt ?? snapshot.evaluatedAt,
  }));
}

async function buildGittensorContributorSnapshot(miner: ConfirmedGittensorMinerSummaryResponse): Promise<GittensorContributorSnapshot> {
  const [detailResult, pullRequestsResult, issuesResult] = await Promise.allSettled([
    fetchJson<GittensorMinerDetailResponse>(`${GITTENSOR_API_BASE}/miners/${encodeURIComponent(miner.githubId)}`),
    fetchJson<GittensorPullRequestResponse[]>(`${GITTENSOR_API_BASE}/miners/${encodeURIComponent(miner.githubId)}/prs`),
    fetchJson<GittensorMinerIssuesResponse>(`${GITTENSOR_MIRROR_API_BASE}/miners/${encodeURIComponent(miner.githubId)}/issues`),
  ]);
  const detail = detailResult.status === "fulfilled" ? detailResult.value : {};
  const pullRequests = pullRequestsResult.status === "fulfilled" ? pullRequestsResult.value : [];
  const issues = issuesResult.status === "fulfilled" ? issuesResult.value.issues ?? [] : [];
  const source = { ...miner, ...detail };

  return {
    source: "gittensor_api",
    githubId: miner.githubId,
    githubUsername: miner.githubUsername,
    uid: source.uid,
    hotkey: source.hotkey,
    failedReason: source.failedReason,
    evaluatedAt: source.evaluatedAt,
    updatedAt: source.updatedAt,
    isEligible: Boolean(source.isEligible),
    credibility: asNumber(source.credibility),
    eligibleRepoCount: asNumber(source.eligibleRepoCount),
    issueDiscoveryScore: asNumber(source.issueDiscoveryScore),
    issueTokenScore: asNumber(source.issueTokenScore),
    issueCredibility: asNumber(source.issueCredibility, 1),
    isIssueEligible: Boolean(source.isIssueEligible),
    issueEligibleRepoCount: asNumber(source.issueEligibleRepoCount),
    alphaPerDay: asNumber(source.alphaPerDay),
    taoPerDay: asNumber(source.taoPerDay),
    usdPerDay: asNumber(source.usdPerDay),
    totals: {
      pullRequests: asNumber(source.totalPrs),
      mergedPullRequests: asNumber(source.totalMergedPrs),
      openPullRequests: asNumber(source.totalOpenPrs),
      closedPullRequests: asNumber(source.totalClosedPrs),
      openIssues: asNumber(source.totalOpenIssues),
      closedIssues: asNumber(source.totalClosedIssues),
      solvedIssues: asNumber(source.totalSolvedIssues),
      validSolvedIssues: asNumber(source.totalValidSolvedIssues),
    },
    repositories: (detail.repositories ?? []).map(toRepositoryEvaluation).filter((repo) => repo.repoFullName && repo.pullRequests + repo.openIssues + repo.closedIssues > 0),
    pullRequests: pullRequests.map(toPullRequest).filter((pr) => pr.repoFullName && pr.number > 0),
    issueMirrorAvailable: issuesResult.status === "fulfilled",
    issues: issues.map(toIssue).filter((issue) => issue.repoFullName && issue.number > 0),
    issueLabels: issues.flatMap((issue) => (issue.labels ?? []).flatMap((label) => (label.name ? [label.name] : []))),
  };
}

/** Hard cap on a single Gittensor API request so a slow/half-open upstream connection can never hang the
 *  Worker indefinitely (it would otherwise stall the webhook between posting and completing the Gate
 *  check, leaving the check in_progress forever — see the gate-finalization fix). */
const GITTENSOR_FETCH_TIMEOUT_MS = 10_000;

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "gittensory/0.1",
    },
    signal: AbortSignal.timeout(GITTENSOR_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Gittensor API failed for ${url} (${response.status})`);
  return (await response.json()) as T;
}

function toRepositoryEvaluation(repo: GittensorRepositoryEvaluationResponse): GittensorContributorSnapshot["repositories"][number] {
  return {
    repoFullName: asString(repo.repositoryFullName),
    pullRequests: asNumber(repo.totalPrs),
    mergedPullRequests: asNumber(repo.totalMergedPrs),
    openPullRequests: asNumber(repo.totalOpenPrs),
    closedPullRequests: asNumber(repo.totalClosedPrs),
    openIssues: asNumber(repo.totalOpenIssues),
    closedIssues: asNumber(repo.totalClosedIssues),
    solvedIssues: asNumber(repo.totalSolvedIssues),
    validSolvedIssues: asNumber(repo.totalValidSolvedIssues),
    isEligible: Boolean(repo.isEligible),
    isIssueEligible: Boolean(repo.isIssueEligible),
    credibility: asNumber(repo.credibility),
    issueCredibility: asNumber(repo.issueCredibility),
    totalScore: asNumber(repo.totalScore),
    baseTotalScore: asNumber(repo.baseTotalScore),
  };
}

function toPullRequest(pr: GittensorPullRequestResponse): GittensorContributorSnapshot["pullRequests"][number] {
  return {
    repoFullName: pr.repository ?? "",
    number: asNumber(pr.pullRequestNumber),
    title: pr.pullRequestTitle ?? "",
    state: pr.prState ?? "UNKNOWN",
    mergedAt: pr.mergedAt,
    label: pr.label,
    score: asNumber(pr.score),
    baseScore: asNumber(pr.baseScore),
    tokenScore: asNumber(pr.tokenScore),
  };
}

function toIssue(issue: NonNullable<GittensorMinerIssuesResponse["issues"]>[number]): NonNullable<GittensorContributorSnapshot["issues"]>[number] {
  return {
    repoFullName: issue.repo_full_name ?? "",
    number: asNumber(issue.issue_number),
    state: issue.state ?? "UNKNOWN",
    solvedByPullRequest: issue.solved_by_pr ?? null,
    labels: (issue.labels ?? []).flatMap((label) => (label.name ? [label.name] : [])),
  };
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}
