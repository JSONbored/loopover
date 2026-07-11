import { githubRateLimitAdmissionKeyForPublicToken, timeoutFetch, type GitHubRateLimitAdmissionKey } from "./client";

export type PublicContributorProfile = {
  login: string;
  name?: string | null | undefined;
  bio?: string | null | undefined;
  company?: string | null | undefined;
  publicRepos?: number | undefined;
  followers?: number | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  topLanguages: string[];
  source: "github" | "unavailable";
};

export type PublicRepoStats = {
  repoFullName: string;
  htmlUrl: string;
  stargazers_count: number;
  forks_count: number;
  fetched_at: string;
  source: "github" | "cache" | "stale_cache";
  stale: boolean;
};

type GitHubUserResponse = {
  login: string;
  name?: string | null;
  bio?: string | null;
  company?: string | null;
  public_repos?: number;
  followers?: number;
  created_at?: string;
  updated_at?: string;
};

type GitHubRepoResponse = {
  language?: string | null;
};

type GitHubPublicRepoResponse = {
  full_name?: string;
  html_url?: string;
  stargazers_count?: number;
  forks_count?: number;
};

type RepoStatsCacheEntry = {
  stats: PublicRepoStats;
  freshUntilMs: number;
  staleUntilMs: number;
};

const REPO_STATS_CACHE_TTL_MS = 1000 * 60 * 10;
const REPO_STATS_STALE_TTL_MS = 1000 * 60 * 60 * 24;
const repoStatsCache = new Map<string, RepoStatsCacheEntry>();

// Bound the api.github.com round trips so a hung response can't stall the 500-login evidence loop
// indefinitely (mirrors GITHUB_FETCH_TIMEOUT_MS in src/github/app.ts) (#790).
const GITHUB_PUBLIC_FETCH_TIMEOUT_MS = 12_000;
// Cap repo pagination at 500 repos (5 pages × 100) to prevent excessive API usage for users
// with very large public repo counts.
const MAX_REPO_PAGES = 5;

export async function fetchPublicContributorProfile(login: string, env?: Pick<Env, "GITHUB_PUBLIC_TOKEN">): Promise<PublicContributorProfile> {
  const safeLogin = encodeURIComponent(login);
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "gittensory/0.1",
    "x-github-api-version": "2022-11-28",
    // Authenticated requests lift the 60/hr unauthenticated ceiling to 5000/hr so the 500-login evidence
    // loop doesn't exhaust it and silently degrade (mirrors fetchPublicRepoStats) (#790).
    ...(env?.GITHUB_PUBLIC_TOKEN ? { authorization: `Bearer ${env.GITHUB_PUBLIC_TOKEN}` } : {}),
  };
  // #regression-safe-propagation: this is the single highest-volume unattributed GitHub caller found in a
  // fleet-wide audit -- the 500-login evidence batch (processors.ts) calls this once per login, each call
  // issuing up to 6 raw GETs, all on the SAME shared env.GITHUB_PUBLIC_TOKEN -- up to ~3000 requests/batch with
  // no rate-limit admission tracking at all, so a 403 anywhere in that batch silently fell into
  // `key_scope="unknown"` instead of the real "public" key_scope bucket (confirmed live: 837 scheduled + 279
  // exhausted secondary-rate-limit 403s in 90 minutes in production). Opting in costs nothing (no extra call)
  // and makes this loop's real impact on the shared public-token rate-limit bucket finally visible.
  const admissionKey: GitHubRateLimitAdmissionKey | undefined = env?.GITHUB_PUBLIC_TOKEN ? githubRateLimitAdmissionKeyForPublicToken() : undefined;
  try {
    const fetchWithTimeout = (url: string): Promise<Response> =>
      timeoutFetch(url, {
        headers,
        signal: AbortSignal.timeout(GITHUB_PUBLIC_FETCH_TIMEOUT_MS),
        githubRateLimitAdmission: admissionKey !== undefined,
        ...(admissionKey ? { githubRateLimitAdmissionKey: admissionKey } : {}),
      });
    const [userResponse, reposResponse] = await Promise.all([
      fetchWithTimeout(`https://api.github.com/users/${safeLogin}`),
      fetchWithTimeout(`https://api.github.com/users/${safeLogin}/repos?per_page=100&sort=updated`),
    ]);
    if (!userResponse.ok) throw new Error(`GitHub user lookup failed (${userResponse.status})`);
    const user = (await userResponse.json()) as GitHubUserResponse;
    const repos: GitHubRepoResponse[] = reposResponse.ok ? ((await reposResponse.json()) as GitHubRepoResponse[]) : [];
    let linkHeader = reposResponse.ok ? reposResponse.headers.get("link") : null;
    for (let page = 2; page <= MAX_REPO_PAGES && linkHeader?.includes('rel="next"'); page += 1) {
      const nextResponse = await fetchWithTimeout(`https://api.github.com/users/${safeLogin}/repos?per_page=100&sort=updated&page=${page}`);
      if (!nextResponse.ok) break;
      const batch = (await nextResponse.json()) as GitHubRepoResponse[];
      repos.push(...batch);
      linkHeader = nextResponse.headers.get("link");
    }
    const languageCounts = new Map<string, number>();
    for (const repo of repos) {
      if (!repo.language) continue;
      languageCounts.set(repo.language, (languageCounts.get(repo.language) ?? 0) + 1);
    }
    const topLanguages = [...languageCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([language]) => language);
    return {
      login: user.login,
      name: user.name,
      bio: user.bio,
      company: user.company,
      publicRepos: finiteCount(user.public_repos),
      followers: finiteCount(user.followers),
      createdAt: user.created_at,
      updatedAt: user.updated_at,
      topLanguages,
      source: "github",
    };
  } catch {
    return {
      login,
      topLanguages: [],
      source: "unavailable",
    };
  }
}

export async function fetchPublicRepoStats(
  env: Pick<Env, "GITHUB_PUBLIC_TOKEN" | "PUBLIC_REPO_STATS_ALLOWLIST">,
  owner: string,
  repo: string,
): Promise<PublicRepoStats> {
  const repoFullName = publicRepoFullName(env, owner, repo);
  const cacheKey = repoFullName.toLowerCase();
  const nowMs = Date.now();
  const cached = repoStatsCache.get(cacheKey);
  if (cached && cached.freshUntilMs > nowMs) return { ...cached.stats, source: "cache", stale: false };

  try {
    const stats = await fetchRepoStatsFromGitHub(env, repoFullName, nowMs);
    repoStatsCache.set(cacheKey, { stats, freshUntilMs: nowMs + REPO_STATS_CACHE_TTL_MS, staleUntilMs: nowMs + REPO_STATS_STALE_TTL_MS });
    return stats;
  } catch (error) {
    if (cached && cached.staleUntilMs > nowMs) return { ...cached.stats, source: "stale_cache", stale: true };
    throw error;
  }
}

export function clearPublicRepoStatsCacheForTests(): void {
  repoStatsCache.clear();
}

// Parses PUBLIC_REPO_STATS_ALLOWLIST into a lowercased "owner/repo" set, mirroring publicStatsProjects's
// comma-separated parsing in src/review/public-stats.ts. Empty/unset -> empty set -> no allowlist restriction
// (#4612): a self-hosted fork's own repo works out of the box, with no code change, exactly like the sibling
// badge.svg route already does for any installed repo.
function publicRepoStatsAllowlist(env: Pick<Env, "PUBLIC_REPO_STATS_ALLOWLIST">): Set<string> {
  const allowlist = new Set<string>();
  for (const entry of (env.PUBLIC_REPO_STATS_ALLOWLIST ?? "").split(",")) {
    const project = entry.trim().toLowerCase();
    if (project) allowlist.add(project);
  }
  return allowlist;
}

function publicRepoFullName(env: Pick<Env, "PUBLIC_REPO_STATS_ALLOWLIST">, owner: string, repo: string): string {
  const ownerName = owner.trim();
  const repoName = repo.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(ownerName)) throw new Error("invalid_github_repo");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repoName) || repoName === "." || repoName === "..") throw new Error("invalid_github_repo");
  const normalizedOwnerName = ownerName.toLowerCase();
  const normalizedRepoName = repoName.toLowerCase();
  const normalizedFullName = `${normalizedOwnerName}/${normalizedRepoName}`;
  const allowlist = publicRepoStatsAllowlist(env);
  if (allowlist.size > 0 && !allowlist.has(normalizedFullName)) throw new Error("invalid_github_repo");
  return normalizedFullName;
}

async function fetchRepoStatsFromGitHub(env: Pick<Env, "GITHUB_PUBLIC_TOKEN">, repoFullName: string, nowMs: number): Promise<PublicRepoStats> {
  const [owner, repo] = repoFullName.split("/") as [string, string];
  // #regression-safe-propagation: same shared-public-token attribution gap as fetchPublicContributorProfile
  // above, fixed the same way -- a rate-limited response here previously fell into key_scope="unknown".
  const admissionKey: GitHubRateLimitAdmissionKey | undefined = env.GITHUB_PUBLIC_TOKEN ? githubRateLimitAdmissionKeyForPublicToken() : undefined;
  const response = await timeoutFetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "gittensory/0.1",
      "x-github-api-version": "2022-11-28",
      ...(env.GITHUB_PUBLIC_TOKEN ? { authorization: `Bearer ${env.GITHUB_PUBLIC_TOKEN}` } : {}),
    },
    githubRateLimitAdmission: admissionKey !== undefined,
    ...(admissionKey ? { githubRateLimitAdmissionKey: admissionKey } : {}),
  });
  if (!response.ok) throw new Error(`github_repo_stats_unavailable:${response.status}`);
  const body = (await response.json()) as GitHubPublicRepoResponse;
  return {
    repoFullName: typeof body.full_name === "string" && body.full_name ? body.full_name : repoFullName,
    htmlUrl: typeof body.html_url === "string" && body.html_url ? body.html_url : `https://github.com/${repoFullName}`,
    stargazers_count: finiteCount(body.stargazers_count),
    forks_count: finiteCount(body.forks_count),
    fetched_at: new Date(nowMs).toISOString(),
    source: "github",
    stale: false,
  };
}

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}
