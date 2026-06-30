// Preview-URL discovery (reviewbot→gittensory convergence — visual capture port).
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
// gittensory has no fetch-based GitHub JSON helper of its own (its src/github layer uses Octokit), so
// this module carries a small fetch helper mirroring reviewbot's. Callers pass an installation token
// (resolved via createInstallationToken). Every helper degrades to null/absent on failure — preview
// discovery must NEVER sink a review.

import { timeoutFetch, type GitHubRateLimitAdmissionKey } from "../../github/client";

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

/** Minimal fetch→JSON helper (mirrors reviewbot's core/github.ts githubJson). Throws PreviewGitHubError on a
 *  non-2xx so callers can distinguish a 404 ("no deployments") from a transient outage. */
async function githubJson<T>(
  url: string,
  init: { token?: string | undefined; apiVersion?: string | undefined; rateLimitAdmissionKey?: GitHubRateLimitAdmissionKey | undefined } = {},
): Promise<T> {
  const headers = new Headers();
  headers.set("accept", "application/vnd.github+json");
  headers.set("user-agent", "gittensory/0.1");
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
  return payload as T;
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
  let deployments: Array<{ id?: number }>;
  try {
    deployments = await githubJson<Array<{ id?: number }>>(`${base}/deployments?${selector}&per_page=10`, {
      token: params.token,
      apiVersion: params.apiVersion,
      rateLimitAdmissionKey: params.rateLimitAdmissionKey,
    });
  } catch (error) {
    // 404 → the ref genuinely has no deployments. Any other failure (403 missing scope, rate limit, 5xx) is
    // NOT "no preview"; report `error` so the caller keeps polling rather than showing a false terminal state.
    if (error instanceof PreviewGitHubError && error.status === 404) return { url: null, failed: false };
    console.log(JSON.stringify({ ev: "deployment_lookup_error", repo: `${params.repo.owner}/${params.repo.repo}`, selector, message: String(error).slice(0, 200) }));
    return { url: null, failed: false, error: true };
  }
  const ids = deployments.map((d) => d.id).filter((id): id is number => id != null);
  const statusLists = await Promise.all(
    ids.map((id) =>
      githubJson<Array<{ state?: string; environment_url?: string }>>(`${base}/deployments/${id}/statuses?per_page=10`, {
        token: params.token,
        apiVersion: params.apiVersion,
        rateLimitAdmissionKey: params.rateLimitAdmissionKey,
      }).catch((error) => {
        console.log(JSON.stringify({ ev: "deployment_status_error", deployment: id, message: String(error).slice(0, 200) }));
        return [] as Array<{ state?: string; environment_url?: string }>;
      }),
    ),
  );
  let sawFailure = false;
  let sawPending = false;
  for (const statuses of statusLists) {
    for (const status of statuses) {
      const ok = status.state === "success" || status.state === "in_progress";
      if (ok && status.environment_url) return { url: status.environment_url, failed: false };
    }
    const latest = statuses[0]?.state;
    if (latest === "failure" || latest === "error") sawFailure = true;
    else if (latest === "in_progress" || latest === "queued" || latest === "pending") sawPending = true;
  }
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
    console.log(JSON.stringify({ ev: "preview_from_checks_error", repo: `${params.repo.owner}/${params.repo.repo}`, message: String(error).slice(0, 200) }));
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
  try {
    const comments = await githubJson<Array<{ user?: { login?: string }; body?: string }>>(
      `${base}/issues/${params.prNumber}/comments?per_page=100`,
      { token: params.token, apiVersion: params.apiVersion, rateLimitAdmissionKey: params.rateLimitAdmissionKey },
    ).catch(() => null);
    if (!Array.isArray(comments)) return null;
    // Newest first (the bot edits one comment in place).
    for (const c of [...comments].reverse()) {
      if ((c.user?.login ?? "").toLowerCase() !== "cloudflare-workers-and-pages[bot]") continue;
      const url = extractPreviewUrl(c.body);
      if (url) return url;
    }
  } catch (error) {
    console.log(JSON.stringify({ ev: "preview_from_comments_error", repo: `${params.repo.owner}/${params.repo.repo}`, message: String(error).slice(0, 200) }));
  }
  return null;
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
  try {
    const checks = await githubJson<{ check_runs?: Array<{ name?: string; status?: string; conclusion?: string }> }>(
      `${base}/commits/${encodeURIComponent(params.sha)}/check-runs?per_page=100`,
      { token: params.token, apiVersion: params.apiVersion, rateLimitAdmissionKey: params.rateLimitAdmissionKey },
    ).catch(() => null);
    const build = (checks?.check_runs ?? []).find((r) => /workers builds|cloudflare/i.test(r.name ?? ""));
    if (!build) return "absent";
    if (build.status !== "completed") return "building"; // queued / in_progress → the preview is coming
    return build.conclusion === "success" ? "succeeded" : "failed";
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
