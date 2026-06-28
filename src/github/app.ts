import type { Advisory, GitHubWebhookPayload } from "../types";
import {
  fetchBrokeredInstallationToken,
  isOrbBrokerMode,
} from "../orb/broker-client";
import { makeInstallationOctokit } from "./client";
import { maintainerControlPanelUrl } from "./footer";
import type { AgentActionMode } from "../settings/agent-execution";
import { signRs256Jwt } from "../utils/crypto";
import { errorMessage } from "../utils/json";
import {
  evaluateGateCheck,
  formatCheckRunOutput,
  formatGateCheckOutput,
  type CheckRunAnnotationContext,
  type CheckRunOutput,
  type GateCheckConclusion,
  type GateCheckEvaluation,
  type GateCheckPolicy,
} from "../rules/advisory";

type CheckRunResponse = {
  id: number;
  html_url?: string;
};

type CheckRunListResponse = {
  check_runs?: Array<{
    id: number;
    html_url?: string;
    name?: string;
  }>;
};

export type CheckRunOutcome =
  | { kind: "published"; id: number; html_url?: string }
  | { kind: "permission_missing"; warning: string };

export const GITTENSORY_CONTEXT_CHECK_NAME = "Gittensory Context";
export const GITTENSORY_GATE_CHECK_NAME = "Gittensory Gate";

type GitHubCheckConclusion =
  | Advisory["conclusion"]
  | GateCheckConclusion
  | "skipped";
type GitHubCheckStatus = "queued" | "in_progress" | "completed";

/** Hard cap on a single GitHub API request. Without it a slow/half-open GitHub connection can hang the
 *  Worker — e.g. the Gate's own completing PATCH stalling after the pending check was posted, which leaves
 *  the check in_progress forever. A bounded timeout turns a hang into a catchable error the caller can
 *  finalize. Applied to every raw fetch here and to the Octokit instances (via a timeout-injecting fetch). */
const GITHUB_FETCH_TIMEOUT_MS = 12_000;

/** A short-TTL cache for safe GitHub GET responses (e.g. Redis on the self-host). Stores only status/body/
 *  content-type — never rate-limit or encoding headers. Set on the self-host; the Worker leaves it null. */
export interface CachedGitHubResponse {
  status: number;
  body: string;
  contentType: string;
}
export interface GitHubResponseCache {
  get(url: string): Promise<CachedGitHubResponse | null>;
  set(url: string, value: CachedGitHubResponse): Promise<void>;
}
let responseCache: GitHubResponseCache | null = null;
export function setGitHubResponseCache(
  cache: GitHubResponseCache | null,
): void {
  responseCache = cache;
}

/** Only cache safe GETs to the GitHub REST API. Never cache token-minting, rate-limit, or
 * authorization/permission endpoints whose response must reflect the live caller context. Exported for tests. */
export function isCacheableGithubUrl(url: string): boolean {
  if (!url.startsWith("https://api.github.com/")) return false;
  if (url.includes("/access_tokens") || url.includes("/rate_limit"))
    return false;
  return !/\/repos\/[^/]+\/[^/]+\/collaborators\/[^/]+\/permission(?:$|[?#])/.test(
    url,
  );
}

async function timeoutFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const url = String(input); // timeoutFetch is only ever called with string URLs (app template strings + octokit)
  const useCache =
    responseCache !== null && method === "GET" && isCacheableGithubUrl(url);
  if (useCache) {
    const hit = await responseCache!.get(url).catch(() => null); // a cache read must never break the fetch
    if (hit)
      return new Response(hit.body, {
        status: hit.status,
        headers: { "content-type": hit.contentType },
      });
  }
  const response = init?.signal
    ? await fetch(input, init)
    : await fetch(input, {
        ...(init ?? {}),
        signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      });
  if (useCache && response.status === 200) {
    try {
      const body = await response.clone().text(); // clone leaves the returned response readable
      await responseCache!.set(url, {
        status: 200,
        body,
        contentType: response.headers.get("content-type") ?? "application/json",
      });
    } catch {
      /* caching is best-effort */
    }
  }
  return response;
}

// In-isolate installation-token cache. GitHub installation tokens are valid ~1h; minting a fresh one on EVERY
// call (the previous behavior) multiplied GitHub API usage enormously — each review path mints several tokens,
// and across the sweep + re-reviews that exhausted the hourly rate limit (observed min_remaining=0 → reviews
// errored → dead-lettered → missed syncs → stale head SHAs). Caching to ~1 mint/hour/installation removes that
// multiplier. The module-level Map persists across requests handled by the same Worker isolate; a 2-minute
// safety margin avoids handing out a token that expires mid-request.
const installationTokenCache = new Map<
  number,
  { token: string; expiresAtMs: number }
>();
const TOKEN_SAFETY_MARGIN_MS = 120_000;

/** A shared installation-token store (e.g. Redis on the self-host) so a multi-replica deployment mints ~1
 *  token/hour/installation across the FLEET, not per-replica. Set on the self-host; the Worker leaves it null
 *  and falls back to the in-isolate Map (unchanged behavior). */
export interface InstallationTokenStore {
  get(
    installationId: number,
  ): Promise<{ token: string; expiresAtMs: number } | null>;
  set(
    installationId: number,
    value: { token: string; expiresAtMs: number },
  ): Promise<void>;
}
let externalTokenStore: InstallationTokenStore | null = null;
export function setInstallationTokenStore(
  store: InstallationTokenStore | null,
): void {
  externalTokenStore = store;
}
async function readCachedToken(
  installationId: number,
): Promise<{ token: string; expiresAtMs: number } | null> {
  return externalTokenStore
    ? externalTokenStore.get(installationId)
    : (installationTokenCache.get(installationId) ?? null);
}
async function writeCachedToken(
  installationId: number,
  value: { token: string; expiresAtMs: number },
): Promise<void> {
  if (externalTokenStore) await externalTokenStore.set(installationId, value);
  else installationTokenCache.set(installationId, value);
}

// Single-flight the mint: on a cold cache, N concurrent jobs for the SAME install would each mint a token (a
// thundering herd — in broker mode the Orb re-mints N times → GitHub secondary-rate-limits the token endpoint →
// orb_broker_unavailable). Coalesce concurrent callers onto ONE in-flight mint, so a cold start / restart costs a
// single mint, not one-per-job. Keyed by installation; the entry self-deletes on settle (success OR failure).
const inFlightMints = new Map<number, Promise<string>>();

export async function createInstallationToken(
  env: Env,
  installationId: number,
): Promise<string> {
  const cached = await readCachedToken(installationId);
  if (cached && cached.expiresAtMs - TOKEN_SAFETY_MARGIN_MS > Date.now())
    return cached.token;
  const existing = inFlightMints.get(installationId);
  if (existing) return existing; // a concurrent caller is already minting for this install — join it
  const mint = mintInstallationToken(env, installationId, cached).finally(() => {
    inFlightMints.delete(installationId);
  });
  inFlightMints.set(installationId, mint);
  return mint;
}

/** Mint a fresh installation token (broker or local App-JWT) and cache it. `cached` is the expired/absent prior
 *  entry, consulted only for the brokered stale-token grace. Extracted from createInstallationToken so that
 *  function can single-flight concurrent cold-cache callers onto one mint (see inFlightMints). */
async function mintInstallationToken(
  env: Env,
  installationId: number,
  cached: { token: string; expiresAtMs: number } | null,
): Promise<string> {
  // Self-host broker mode: a brokered self-host holds no App private key, so source the installation token from
  // the central Orb (enrollment secret → short-lived token) instead of minting locally. Cloud sets no enrollment
  // secret, so this branch is inert there → byte-identical. The token caches the same way (the install id is the
  // self-host's single bound install). See src/orb/broker-client.
  if (isOrbBrokerMode(env)) {
    try {
      const brokered = await fetchBrokeredInstallationToken(env);
      await writeCachedToken(installationId, {
        token: brokered.token,
        expiresAtMs: brokered.expiresAtMs,
      });
      return brokered.token;
    } catch (error) {
      // Stale-token grace (#2): a brokered self-host holds no App key, so without this a single Orb mint failure
      // fails the review (→ retry/DLQ) and an Orb blip during the re-mint window stalls the fleet. If the cached
      // token is STILL within its real expiry, serve it — a valid token beats a stalled review (NO dangerous reuse:
      // an actually-expired token is never served). Otherwise emit an alertable structured log and rethrow so the
      // queue's retry/DLQ handles a genuine outage.
      if (cached && cached.expiresAtMs > Date.now()) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "orb_broker_degraded_serving_cached_token",
            installationId,
            expiresInMs: cached.expiresAtMs - Date.now(),
            error: errorMessage(error),
          }),
        );
        return cached.token;
      }
      console.error(
        JSON.stringify({
          level: "error",
          event: "orb_broker_unavailable",
          installationId,
          error: errorMessage(error),
        }),
      );
      throw error;
    }
  }
  const jwt = await createAppJwt(env);
  const response = await timeoutFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: githubHeaders(`Bearer ${jwt}`),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to create GitHub installation token (${response.status}): ${body.slice(0, 200)}`,
    );
  }
  const payload = (await response.json()) as {
    token?: string;
    expires_at?: string;
  };
  if (!payload.token)
    throw new Error(
      "GitHub installation token response did not include a token.",
    );
  const expiresAtMs = payload.expires_at
    ? Date.parse(payload.expires_at)
    : Date.now() + 50 * 60_000;
  await writeCachedToken(installationId, { token: payload.token, expiresAtMs });
  return payload.token;
}

/**
 * Dual-app webhook safety (#selfhost-app-id): TRUE when a delivery's installation belongs to a DIFFERENT
 * gittensory App than this backend's own (`GITHUB_APP_ID`), e.g. the cloud App and a self-host App installed on
 * the same account during the migration. FAIL-OPEN by construction — returns FALSE (process the webhook) whenever
 * we cannot be certain it is foreign: no configured own id, an unparseable own id, or an unknown installation
 * app_id (existing rows backfill lazily). It returns TRUE only on a POSITIVE numeric mismatch, so it can never
 * drop a legitimate delivery whose app_id is null/unknown. Signature verification (per-App webhook secret) is the
 * PRIMARY isolation; this is defense-in-depth for a shared-endpoint/secret misconfiguration. PURE.
 */
export function isForeignAppInstallation(
  ownAppId: string | undefined,
  installationAppId: number | null | undefined,
): boolean {
  if (
    !ownAppId ||
    installationAppId === null ||
    installationAppId === undefined
  )
    return false;
  const own = Number.parseInt(ownAppId, 10);
  if (!Number.isFinite(own)) return false;
  return own !== installationAppId;
}

/** Test-only: clear the in-isolate installation-token cache so each test starts fresh (the module-level Map
 *  otherwise leaks a cached token across test cases that share an installation id). */
export function clearInstallationTokenCacheForTest(): void {
  installationTokenCache.clear();
  externalTokenStore = null;
  responseCache = null;
}

export async function getAppInstallation(
  env: Env,
  installationId: number,
): Promise<NonNullable<GitHubWebhookPayload["installation"]>> {
  const jwt = await createAppJwt(env);
  const response = await timeoutFetch(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: githubHeaders(`Bearer ${jwt}`),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to fetch GitHub App installation (${response.status}): ${body.slice(0, 200)}`,
    );
  }
  const payload = (await response.json()) as NonNullable<
    GitHubWebhookPayload["installation"]
  >;
  if (!payload.id)
    throw new Error("GitHub installation response did not include an id.");
  return payload;
}

export type GitHubRepositoryCollaboratorPermission =
  | "admin"
  | "maintain"
  | "write"
  | "triage"
  | "read"
  | "none"
  | string;

export async function getRepositoryCollaboratorPermission(
  env: Env,
  installationId: number,
  repoFullName: string,
  login: string,
): Promise<GitHubRepositoryCollaboratorPermission | null> {
  const [owner, name] = repoFullName.split("/");
  if (!owner || !name || !login) return null;
  const token = await createInstallationToken(env, installationId);
  const response = await timeoutFetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/collaborators/${encodeURIComponent(login)}/permission`,
    { headers: githubHeaders(`Bearer ${token}`) },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to fetch GitHub collaborator permission (${response.status}): ${body.slice(0, 200)}`,
    );
  }
  const payload = (await response.json()) as {
    permission?: GitHubRepositoryCollaboratorPermission;
  };
  return payload.permission ?? null;
}

async function createAppJwt(env: Env): Promise<string> {
  if (!env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GitHub App credentials are not configured.");
  }
  const now = Math.floor(Date.now() / 1000);
  return signRs256Jwt(
    {
      iss: env.GITHUB_APP_ID,
      iat: now - 60,
      exp: now + 540,
    },
    env.GITHUB_APP_PRIVATE_KEY,
  );
}

export async function createOrUpdateCheckRun(
  env: Env,
  installationId: number,
  repoFullName: string,
  advisory: Advisory,
  detailLevel: "minimal" | "standard" | "deep" = "minimal",
  annotationContext?: CheckRunAnnotationContext,
  mode: AgentActionMode = "live",
): Promise<CheckRunOutcome | null> {
  return createOrUpdateNamedCheckRun(
    env,
    installationId,
    repoFullName,
    advisory,
    {
      name: GITTENSORY_CONTEXT_CHECK_NAME,
      conclusion: advisory.conclusion,
      output: formatCheckRunOutput(advisory, detailLevel, annotationContext),
      mode,
    },
  );
}

export async function createOrUpdateGateCheckRun(
  env: Env,
  installationId: number,
  repoFullName: string,
  advisory: Advisory,
  policy: GateCheckPolicy = {},
  options: {
    checkRunId?: number | undefined;
    gate?: GateCheckEvaluation | undefined;
  } = {},
  mode: AgentActionMode = "live",
): Promise<CheckRunOutcome | null> {
  // Prefer the AUTHORITATIVE pre-computed evaluation when the caller has one (#5 / audit): the surface/content
  // lane can OVERRIDE the generic verdict (surface_lane_reject → failure, surface_lane_manual → action_required),
  // and re-deriving here via evaluateGateCheck would discard that override — publishing a GREEN check while the
  // PR is actually auto-closed/held. Callers without a surface lane omit `gate` and re-derive as before (identical).
  const gate = options.gate ?? evaluateGateCheck(advisory, policy);
  return createOrUpdateNamedCheckRun(
    env,
    installationId,
    repoFullName,
    advisory,
    {
      name: GITTENSORY_GATE_CHECK_NAME,
      status: "completed",
      conclusion: gate.conclusion,
      output: formatGateCheckOutput(gate),
      checkRunId: options.checkRunId,
      mode,
    },
  );
}

export async function createOrUpdatePendingGateCheckRun(
  env: Env,
  installationId: number,
  repoFullName: string,
  advisory: Advisory,
  mode: AgentActionMode = "live",
): Promise<CheckRunOutcome | null> {
  return createOrUpdateNamedCheckRun(
    env,
    installationId,
    repoFullName,
    advisory,
    {
      name: GITTENSORY_GATE_CHECK_NAME,
      status: "in_progress",
      output: {
        title: "Gittensory Gate is evaluating",
        summary:
          "Gittensory is running deterministic public PR hygiene checks.",
        text: "The Gate blocks every author on the repo's configured hard blockers (duplicate PRs by default); on everything else, and while state is still syncing, it stays advisory.",
      },
      mode,
    },
  );
}

export async function createOrUpdateSkippedGateCheckRun(
  env: Env,
  installationId: number,
  repoFullName: string,
  advisory: Advisory,
  reason = "PR closed before full evaluation.",
  mode: AgentActionMode = "live",
): Promise<CheckRunOutcome | null> {
  return createOrUpdateNamedCheckRun(
    env,
    installationId,
    repoFullName,
    advisory,
    {
      name: GITTENSORY_GATE_CHECK_NAME,
      status: "completed",
      conclusion: "skipped",
      output: {
        title: "Gittensory Gate skipped",
        summary: reason,
        text: "Gittensory does not post late first comments on closed or merged pull requests.",
      },
      mode,
    },
  );
}

/**
 * Finalize a previously-posted pending Gate check to a NEUTRAL (non-blocking) terminal state when the
 * evaluation could not finish (a transient error/timeout in the work between posting the pending check and
 * completing it). This guarantees the "Gittensory Gate is evaluating" run never hangs in_progress forever;
 * it does not block the PR and re-runs on the next push. Targets the known pending check_run id so it
 * updates the SAME run rather than creating a second one.
 */
export async function createOrUpdateErroredGateCheckRun(
  env: Env,
  installationId: number,
  repoFullName: string,
  advisory: Advisory,
  options: { checkRunId?: number | undefined } = {},
  mode: AgentActionMode = "live",
): Promise<CheckRunOutcome | null> {
  return createOrUpdateNamedCheckRun(
    env,
    installationId,
    repoFullName,
    advisory,
    {
      name: GITTENSORY_GATE_CHECK_NAME,
      status: "completed",
      conclusion: "neutral",
      output: {
        title: "Gittensory Gate — could not finish evaluating",
        summary:
          "A transient error interrupted gate evaluation. This does NOT block the PR and re-runs automatically on the next push.",
        text: "Gittensory finalizes the Gate to a neutral, non-blocking state when evaluation is interrupted, so the check never hangs in_progress. Push a new commit or use the 'Re-run Gittensory review' checkbox to re-evaluate.",
      },
      checkRunId: options.checkRunId,
      mode,
    },
  );
}

/**
 * Finalize the current Gate check to a NEUTRAL (non-blocking) terminal state because a maintainer ran
 * `@gittensory gate-override`. This applies to THIS commit only: the override is not persisted anywhere,
 * so the next push re-evaluates the Gate from scratch (no permanent bypass). Called WITHOUT a checkRunId
 * so createOrUpdateNamedCheckRun resolves the current Gate run by advisory.headSha.
 */
export async function createOrUpdateOverriddenGateCheckRun(
  env: Env,
  installationId: number,
  repoFullName: string,
  advisory: Advisory,
  options: { actor: string; reason: string; checkRunId?: number | undefined },
  mode: AgentActionMode = "live",
): Promise<CheckRunOutcome | null> {
  return createOrUpdateNamedCheckRun(
    env,
    installationId,
    repoFullName,
    advisory,
    {
      name: GITTENSORY_GATE_CHECK_NAME,
      status: "completed",
      conclusion: "neutral",
      output: {
        title: `Gittensory Gate — overridden by @${options.actor}`,
        summary:
          "A maintainer set the Gate to neutral for THIS commit only. This does NOT permanently bypass the Gate; a new push re-evaluates it.",
        text: `Overridden by @${options.actor}: ${options.reason}`,
      },
      checkRunId: options.checkRunId,
      mode,
    },
  );
}

async function createOrUpdateNamedCheckRun(
  env: Env,
  installationId: number,
  repoFullName: string,
  advisory: Advisory,
  check: {
    name: string;
    status?: GitHubCheckStatus | undefined;
    conclusion?: GitHubCheckConclusion | undefined;
    output: CheckRunOutput;
    checkRunId?: number | undefined;
    mode?: AgentActionMode | undefined;
  },
): Promise<CheckRunOutcome | null> {
  if (!advisory.headSha) return null;
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo)
    throw new Error(`Invalid repository full name: ${repoFullName}`);

  const token = await createInstallationToken(env, installationId);
  // makeInstallationOctokit injects the shared per-request timeout (a stalled PATCH can never orphan the
  // in_progress check) AND suppresses the check-run writes under a non-live mode (dry-run / pause / freeze).
  const octokit = makeInstallationOctokit(env, token, check.mode);
  // Point the merge-box "Details" link at the repo's Gittensory maintainer panel instead of GitHub's generic
  // check page. Spread conditionally so a URL-construction failure (null) just omits it. (#audit-details-url)
  const detailsUrl = maintainerControlPanelUrl(env, repoFullName);
  const detailsUrlBody = detailsUrl ? { details_url: detailsUrl } : {};

  try {
    if (check.checkRunId) {
      const response = await octokit.request(
        "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
        {
          owner,
          repo,
          check_run_id: check.checkRunId,
          name: check.name,
          /* v8 ignore next 2 -- Exported check helpers always provide status/conclusion for known-id finalization. */
          status: check.status ?? "completed",
          ...(check.conclusion ? { conclusion: check.conclusion } : {}),
          output: outputForCheckRunUpdate(check.output),
          ...detailsUrlBody,
        },
      );
      const data = response.data as CheckRunResponse;
      return publishedOutcome(data);
    }

    const existing = await octokit.request(
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      {
        owner,
        repo,
        ref: advisory.headSha,
        check_name: check.name,
        filter: "latest",
        per_page: 1,
      },
    );
    const existingCheckRun = (existing.data as CheckRunListResponse)
      .check_runs?.[0];
    if (existingCheckRun) {
      const response = await octokit.request(
        "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
        {
          owner,
          repo,
          check_run_id: existingCheckRun.id,
          name: check.name,
          status: check.status ?? "completed",
          ...(check.conclusion ? { conclusion: check.conclusion } : {}),
          output: outputForCheckRunUpdate(check.output),
          ...detailsUrlBody,
        },
      );
      const data = response.data as CheckRunResponse;
      return publishedOutcome(data);
    }

    const response = await octokit.request(
      "POST /repos/{owner}/{repo}/check-runs",
      {
        owner,
        repo,
        name: check.name,
        head_sha: advisory.headSha,
        status: check.status ?? "completed",
        ...(check.conclusion ? { conclusion: check.conclusion } : {}),
        output: check.output,
        ...detailsUrlBody,
      },
    );
    const data = response.data as CheckRunResponse;
    return publishedOutcome(data);
  } catch (error) {
    if (isCheckRunPermissionError(error)) {
      return {
        kind: "permission_missing",
        warning:
          "GitHub App Checks: write permission is missing. Enable it in the GitHub App settings and re-approve the installation.",
      };
    }
    throw error;
  }
}

function outputForCheckRunUpdate(output: CheckRunOutput): CheckRunOutput {
  if (!output.annotations || output.annotations.length === 0) return output;
  const { annotations: _annotations, ...safeOutput } = output;
  return safeOutput;
}

function publishedOutcome(data: CheckRunResponse): CheckRunOutcome {
  const outcome: { kind: "published"; id: number; html_url?: string } = {
    kind: "published",
    id: data.id,
  };
  if (data.html_url) outcome.html_url = data.html_url;
  return outcome;
}

function isCheckRunPermissionError(error: unknown): boolean {
  /* v8 ignore next -- Octokit wraps thrown fetch values in HttpError objects before this helper sees them. */
  if (typeof error !== "object" || error === null) return false;
  const e = error as { status?: number; message?: string };
  if (e.status === 403) return true;
  return (
    typeof e.message === "string" &&
    /resource not accessible by integration|not have permission/i.test(
      e.message,
    )
  );
}

export function getInstallationId(
  payload: GitHubWebhookPayload,
): number | null {
  return payload.installation?.id ?? null;
}

function githubHeaders(authorization: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization,
    "content-type": "application/json",
    "user-agent": "gittensory/0.1",
    "x-github-api-version": "2022-11-28",
  };
}
