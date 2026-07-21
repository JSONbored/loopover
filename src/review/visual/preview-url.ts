// Preview-URL discovery (reviewbot→loopover convergence — visual capture port).
//
// PORTED from reviewbot's src/core/github.ts (getLatestDeploymentStatus, extractPreviewUrl,
// findPreviewUrlFromChecks, findPreviewUrlFromPrComments, getPreviewBuildState) + the
// deployment_status → preview mapping from capabilities.ts `deploymentStatusTarget`.
//
// "after" = the PR's preview deploy. We discover its URL the provider-agnostic way:
//   1. the GitHub Deployments API (environment_url for the head SHA), then
//   2. a scan of the head SHA's commit statuses + check-runs for a *.workers.dev / *.pages.dev link, then
//   3. the Cloudflare Workers Builds bot's PR comment (where 2026-era Cloudflare publishes the link).
// getPreviewBuildState distinguishes "still building" (keep polling) from "failed" / "no build".
//
// loopover has no fetch-based GitHub JSON helper of its own (its src/github layer uses Octokit), so
// this module carries a small fetch helper mirroring reviewbot's. Callers pass an installation token
// (resolved via createInstallationToken). Every helper degrades to null/absent on failure — preview
// discovery must NEVER sink a review.

import { PRODUCT_USER_AGENT, timeoutFetch, type GitHubRateLimitAdmissionKey } from "../../github/client";

const DEFAULT_GITHUB_TIMEOUT_MS = 20_000;

export type GitHubRepo = { owner: string; repo: string };

export function parseRepo(value: string): GitHubRepo {
  const parts = value.trim().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Expected owner/repo repository name.");
  }
  return { owner: parts[0], repo: parts[1] };
}

class PreviewGitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PreviewGitHubError";
    this.status = status;
  }
}

type GithubJsonInit = { token?: string | undefined; apiVersion?: string | undefined; rateLimitAdmissionKey?: GitHubRateLimitAdmissionKey | undefined };

/** Minimal fetch→JSON helper that also surfaces the response's `Link` header for pagination (mirrors
 *  reviewbot's core/github.ts githubJson). Throws PreviewGitHubError on a non-2xx so callers can distinguish
 *  a 404 ("no deployments") from a transient outage. */
async function githubJsonWithLink<T>(url: string, init: GithubJsonInit = {}): Promise<{ payload: T; link: string | null }> {
  const headers = new Headers();
  headers.set("accept", "application/vnd.github+json");
  headers.set("user-agent", PRODUCT_USER_AGENT);
  headers.set("x-github-api-version", init.apiVersion || "2022-11-28");
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  const response = await timeoutFetch(url, {
    headers,
    signal: AbortSignal.timeout(DEFAULT_GITHUB_TIMEOUT_MS),
    githubRateLimitAdmission: init.rateLimitAdmissionKey !== undefined,
    ...(init.rateLimitAdmissionKey ? { githubRateLimitAdmissionKey: init.rateLimitAdmissionKey } : {}),
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const message = typeof (payload as { message?: string })?.message === "string" ? (payload as { message: string }).message : `GitHub ${response.status}`;
    throw new PreviewGitHubError(response.status, message);
  }
  return { payload: payload as T, link: response.headers.get("link") };
}

async function githubJson<T>(url: string, init: GithubJsonInit = {}): Promise<T> {
  return (await githubJsonWithLink<T>(url, init)).payload;
}

// GitHub caps list endpoints at 100 items/page, so a single `per_page=100` read silently truncates: a PR with
// >100 discussion comments, or a commit with >100 check-runs, would push the Cloudflare Workers Builds bot's
// comment / check-run onto page 2+ and this discovery would then return null/"absent" as if it genuinely
// didn't exist (a truncated page-1 response is indistinguishable from an empty one). Walk the `Link: rel="next"`
// header instead, bounded so a pathological PR/commit (or a mock that always advertises a next page) can't turn
// one read into an unbounded fetch loop -- mirrors src/github/backfill.ts's githubPaginatedList/PR_DETAIL_MAX_PAGES
// and src/github/app.ts's workflow-run listing (MAX_WORKFLOW_RUN_LIST_PAGES), both bounded to 10.
const PREVIEW_LIST_MAX_PAGES = 10;

function hasNextPage(link: string | null): boolean {
  return Boolean(link?.split(",").some((part) => /rel="next"/.test(part)));
}

/**
 * Walk a GitHub list endpoint's `Link: rel="next"` pages, probing each page's items as it arrives and
 * returning the first non-null probe result. Bounded to PREVIEW_LIST_MAX_PAGES (see the note above) so a
 * pathological resource can never spin. A page fetch/parse failure propagates to the caller, whose own
 * try/catch degrades it to null/"absent" -- earlier pages were already probed, so a mid-pagination failure
 * falls back to what they yielded (nothing usable) rather than dropping a successful first page, mirroring
 * githubPaginatedList's own "a later-page failure keeps the pages already fetched" contract.
 */
async function findAcrossPages<TItem, TResult>(
  firstPageUrl: string,
  init: GithubJsonInit,
  selectItems: (payload: unknown) => TItem[],
  probe: (items: TItem[]) => TResult | null | Promise<TResult | null>,
): Promise<TResult | null> {
  for (let page = 1; page <= PREVIEW_LIST_MAX_PAGES; page += 1) {
    // Callers pass a `per_page=100` first-page URL; append the 1-based page cursor for page 2+ only (page 1 is
    // GitHub's default, so leaving it bare keeps that request byte-identical to the pre-pagination read).
    const url = page === 1 ? firstPageUrl : `${firstPageUrl}&page=${page}`;
    const { payload, link } = await githubJsonWithLink<unknown>(url, init);
    const found = await probe(selectItems(payload));
    if (found !== null) return found;
    if (!hasNextPage(link)) return null;
  }
  return null;
}

export type DeploymentLookup = { url: string | null; failed: boolean; error?: boolean };

/**
 * Resolve a PR's preview-deploy state via the GitHub Deployments API: walk the latest deployments for the
 * head SHA (or ref) and their statuses, returning the `environment_url` of the first usable
 * (success/in_progress) status; otherwise report `failed` when an attempt errored and none is still in
 * flight, or `error` on a non-404 read failure (so the caller keeps the loading state instead of mistaking
 * an outage for "no deploy"). Needs the app's deployments:read.
 */
export async function getLatestDeploymentStatus(params: {
  token: string;
  repo: GitHubRepo;
  sha?: string | undefined;
  ref?: string | undefined;
  apiVersion?: string | undefined;
  rateLimitAdmissionKey?: GitHubRateLimitAdmissionKey | undefined;
}): Promise<DeploymentLookup> {
  const base = `https://api.github.com/repos/${params.repo.owner}/${params.repo.repo}`;
  const selector = params.sha
    ? `sha=${encodeURIComponent(params.sha)}`
    : params.ref
      ? `ref=${encodeURIComponent(params.ref)}`
      : "";
  if (!selector) return { url: null, failed: false };
  const opts = { token: params.token, apiVersion: params.apiVersion, rateLimitAdmissionKey: params.rateLimitAdmissionKey };

  // sawFailure/sawPending accumulate across every deployment (and every page of them), so the final
  // failed-vs-still-coming verdict reflects all deployments, not just the first page (#7805).
  let sawFailure = false;
  let sawPending = false;

  // Scan one deployment's statuses across ALL pages (#7805): return its environment_url when a usable status is
  // found, else null after recording whether its latest status looked failed/pending.
  const findDeploymentUrl = (id: number): Promise<string | null> =>
    findAcrossPages<{ state?: string; environment_url?: string }, string>(
      `${base}/deployments/${id}/statuses?per_page=10`,
      opts,
      (payload) => (Array.isArray(payload) ? (payload as Array<{ state?: string; environment_url?: string }>) : []),
      (statuses) => {
        for (const status of statuses) {
          const ok = status.state === "success" || status.state === "in_progress";
          if (ok && status.environment_url) return status.environment_url;
        }
        // Only the first page's first entry is GitHub's "latest" status; later pages are older, so the
        // failed/pending bookkeeping keys off statuses[0] exactly as the pre-pagination single-page read did.
        const latest = statuses[0]?.state;
        if (latest === "failure" || latest === "error") sawFailure = true;
        else if (latest === "in_progress" || latest === "queued" || latest === "pending") sawPending = true;
        return null;
      },
    ).catch((error) => {
      console.log(JSON.stringify({ event: "deployment_status_error", deployment: id, message: String(error).slice(0, 200) }));
      return null;
    });

  let url: string | null;
  try {
    // Walk every page of deployments, and on each page scan each deployment's statuses; return the first usable
    // environment_url found, letting findAcrossPages stop as soon as a page yields one.
    url = await findAcrossPages<{ id?: number }, string>(
      `${base}/deployments?${selector}&per_page=10`,
      opts,
      (payload) => (Array.isArray(payload) ? (payload as Array<{ id?: number }>) : []),
      async (deployments) => {
        const ids = deployments.map((d) => d.id).filter((id): id is number => id != null);
        const statusUrls = await Promise.all(ids.map((id) => findDeploymentUrl(id)));
        return statusUrls.find((found): found is string => found !== null) ?? null;
      },
    );
  } catch (error) {
    // 404 → the ref genuinely has no deployments. Any other failure (403 missing scope, rate limit, 5xx) is
    // NOT "no preview"; report `error` so the caller keeps polling rather than showing a false terminal state.
    if (error instanceof PreviewGitHubError && error.status === 404) return { url: null, failed: false };
    console.log(JSON.stringify({ event: "deployment_lookup_error", repo: `${params.repo.owner}/${params.repo.repo}`, selector, message: String(error).slice(0, 200) }));
    return { url: null, failed: false, error: true };
  }
  if (url !== null) return { url, failed: false };
  return { url: null, failed: sawFailure && !sawPending };
}

// A Cloudflare Workers/Pages preview always lives on one of these hosts. Restricting the status/check scan to
// them is what makes it safe: the scan can NEVER mistake an unrelated check's link for the preview.
const PREVIEW_HOST_SUFFIXES = [".workers.dev", ".pages.dev"];

/** Pull the first Cloudflare-preview (`*.workers.dev` / `*.pages.dev`) origin out of an arbitrary string (a
 *  status target_url, a check details_url, or a check-run output that embeds the link). */
export function extractPreviewUrl(text: string | undefined | null): string | null {
  if (!text) return null;
  const matches = String(text).match(/https?:\/\/[^\s"'`<>()]+/gi);
  if (!matches) return null;
  for (const raw of matches) {
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      if (PREVIEW_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
        return `${url.protocol}//${url.host}`; // base origin — the route path is appended by capture
      }
    } catch {
      /* not a parseable URL — skip */
    }
  }
  return null;
}

/**
 * Resolve a per-PR preview URL the way Cloudflare Workers Builds surfaces it when it ISN'T a GitHub
 * Deployment: scan the head SHA's commit statuses and check-runs for a `*.workers.dev` / `*.pages.dev`
 * link (target_url, the check's details_url, or a URL embedded in the check-run output). Returns null on any
 * failure so the caller degrades to "no preview yet".
 */
export async function findPreviewUrlFromChecks(params: {
  token: string;
  repo: GitHubRepo;
  sha: string;
  apiVersion?: string | undefined;
  rateLimitAdmissionKey?: GitHubRateLimitAdmissionKey | undefined;
}): Promise<string | null> {
  const base = `https://api.github.com/repos/${params.repo.owner}/${params.repo.repo}`;
  const opts = { token: params.token, apiVersion: params.apiVersion, rateLimitAdmissionKey: params.rateLimitAdmissionKey };
  try {
    const combined = await githubJson<{ statuses?: Array<{ state?: string; target_url?: string }> }>(
      `${base}/commits/${encodeURIComponent(params.sha)}/status`,
      opts,
    ).catch(() => null);
    for (const status of combined?.statuses ?? []) {
      if (status.state && status.state !== "success") continue;
      const url = extractPreviewUrl(status.target_url);
      if (url) return url;
    }
    const checks = await githubJson<{ check_runs?: Array<{ status?: string; conclusion?: string; details_url?: string; output?: { summary?: string; text?: string } }> }>(
      `${base}/commits/${encodeURIComponent(params.sha)}/check-runs?per_page=100`,
      opts,
    ).catch(() => null);
    for (const run of checks?.check_runs ?? []) {
      if (run.status === "completed" && run.conclusion && run.conclusion !== "success") continue;
      const url = extractPreviewUrl(run.details_url) ?? extractPreviewUrl(run.output?.summary) ?? extractPreviewUrl(run.output?.text);
      if (url) return url;
    }
  } catch (error) {
    console.log(JSON.stringify({ event: "preview_from_checks_error", repo: `${params.repo.owner}/${params.repo.repo}`, message: String(error).slice(0, 200) }));
  }
  return null;
}

/**
 * Final preview-URL fallback: scan the PR's issue comments for the Cloudflare Workers Builds bot's comment,
 * which carries the per-PR `*.workers.dev` preview link. Restricted to the EXACT cloudflare bot login — the
 * `[bot]` suffix is reserved by GitHub for installed Apps and is unspoofable, so a malicious commenter can't
 * inject an attacker-controlled `*.workers.dev` URL that we'd then render server-side. Returns null on any
 * failure.
 */
export async function findPreviewUrlFromPrComments(params: {
  token: string;
  repo: GitHubRepo;
  prNumber: number;
  apiVersion?: string | undefined;
  rateLimitAdmissionKey?: GitHubRateLimitAdmissionKey | undefined;
}): Promise<string | null> {
  const base = `https://api.github.com/repos/${params.repo.owner}/${params.repo.repo}`;
  const opts = { token: params.token, apiVersion: params.apiVersion, rateLimitAdmissionKey: params.rateLimitAdmissionKey };
  try {
    return await findAcrossPages<{ user?: { login?: string }; body?: string }, string>(
      `${base}/issues/${params.prNumber}/comments?per_page=100`,
      opts,
      (payload) => (Array.isArray(payload) ? (payload as Array<{ user?: { login?: string }; body?: string }>) : []),
      (comments) => {
        // Newest first (the bot edits one comment in place).
        for (const c of [...comments].reverse()) {
          if ((c.user?.login ?? "").toLowerCase() !== "cloudflare-workers-and-pages[bot]") continue;
          const url = extractPreviewUrl(c.body);
          if (url) return url;
        }
        return null;
      },
    );
  } catch (error) {
    console.log(JSON.stringify({ event: "preview_from_comments_error", repo: `${params.repo.owner}/${params.repo.repo}`, message: String(error).slice(0, 200) }));
    return null;
  }
}

/**
 * State of the per-PR preview BUILD (Cloudflare Workers Builds check-run) for a head SHA, so capture can tell
 * "still building / its URL-comment is just lagging" (keep polling) apart from "failed" (show the terminal
 * failed card) and "no preview build at all" (don't poll). Returns 'absent' on any read failure (fail-safe:
 * never an infinite poll on a transient error).
 */
export async function getPreviewBuildState(params: {
  token: string;
  repo: GitHubRepo;
  sha: string;
  apiVersion?: string | undefined;
  rateLimitAdmissionKey?: GitHubRateLimitAdmissionKey | undefined;
}): Promise<"building" | "succeeded" | "failed" | "absent"> {
  const base = `https://api.github.com/repos/${params.repo.owner}/${params.repo.repo}`;
  const opts = { token: params.token, apiVersion: params.apiVersion, rateLimitAdmissionKey: params.rateLimitAdmissionKey };
  try {
    const state = await findAcrossPages<{ name?: string; status?: string; conclusion?: string }, "building" | "succeeded" | "failed">(
      `${base}/commits/${encodeURIComponent(params.sha)}/check-runs?per_page=100`,
      opts,
      (payload) => (payload as { check_runs?: Array<{ name?: string; status?: string; conclusion?: string }> })?.check_runs ?? [],
      (runs) => {
        const build = runs.find((r) => /workers builds|cloudflare/i.test(r.name ?? ""));
        if (!build) return null; // not on this page — keep walking until found, Link exhausts, or the page bound
        if (build.status !== "completed") return "building"; // queued / in_progress → the preview is coming
        return build.conclusion === "success" ? "succeeded" : "failed";
      },
    );
    return state ?? "absent";
  } catch {
    return "absent";
  }
}

/** A deployment_status webhook payload, narrowed to the fields the preview mapping reads. */
export type DeploymentStatusPayload = {
  deployment_status?: { state?: string; environment_url?: string } | undefined;
  deployment?: { sha?: string; ref?: string; payload?: string | { pr?: number } | null } | undefined;
};

/** The preview signal carried by a successful/failed deployment_status webhook, mapped without any API call. */
export type DeploymentPreview = { prNumber: number; headSha?: string; headRef?: string; previewUrl?: string; previewFailed?: boolean };

/**
 * Map a `deployment_status` webhook payload back to its PR + preview URL (PORTED from capabilities.ts
 * `deploymentStatusTarget`). The PR number is carried in the deployment payload (set by the ui-preview
 * workflow), so no token/lookup is needed. Returns null for an in-flight status (queued/in_progress/pending)
 * or a payload missing the PR number — neither carries new preview signal. A failed deploy returns
 * `previewFailed` with no URL so the caller can render the terminal "deploy failed" card.
 */
export function deploymentStatusToPreview(payload: DeploymentStatusPayload): DeploymentPreview | null {
  const status = payload.deployment_status;
  const deployment = payload.deployment;
  if (!status || !deployment) return null;
  const succeeded = status.state === "success" && !!status.environment_url;
  const failed = status.state === "failure" || status.state === "error";
  if (!succeeded && !failed) return null;

  let prNumber: number | undefined;
  const raw = deployment.payload;
  if (typeof raw === "string") {
    try {
      prNumber = (JSON.parse(raw) as { pr?: number }).pr;
    } catch {
      prNumber = undefined;
    }
  } else if (raw && typeof raw === "object") {
    prNumber = (raw as { pr?: number }).pr;
  }
  if (!prNumber) return null;

  return {
    prNumber,
    ...(deployment.sha ? { headSha: deployment.sha } : {}),
    ...(deployment.ref ? { headRef: deployment.ref } : {}),
    ...(succeeded ? { previewUrl: status.environment_url } : {}),
    ...(failed ? { previewFailed: true } : {}),
  };
}
