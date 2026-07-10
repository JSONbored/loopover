import type { Advisory, GitHubWebhookPayload } from "../types";
import {
  fetchBrokeredInstallationToken,
  isOrbBrokerMode,
} from "../orb/broker-client";
import { recordGitHubRateLimitObservation, updateInstallationPermissions } from "../db/repositories";
import { recordClockSkewFromResponse } from "../selfhost/clock-skew";
import {
  clearGitHubResponseCacheForTest,
  githubHeaders,
  githubRateLimitAdmissionKeyForInstallation,
  makeInstallationOctokit,
  timeoutFetch,
  type GitHubRateLimitAdmissionKey,
} from "./client";
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
import {
  GITTENSORY_CONTEXT_CHECK_NAME,
  GITTENSORY_GATE_CHECK_NAME,
  GITTENSORY_LEGACY_GATE_CHECK_NAME,
} from "../review/check-names";

export {
  GITTENSORY_CONTEXT_CHECK_NAME,
  GITTENSORY_GATE_CHECK_NAME,
  GITTENSORY_LEGACY_GATE_CHECK_NAME,
} from "../review/check-names";
export type { CachedGitHubResponse, GitHubResponseCache } from "./client";
export {
  isCacheableGithubUrl,
  isRateLimitedResponse,
  rateLimitRetryMs,
  setGitHubResponseCache,
} from "./client";
export {
  fetchCachedGitHubGraphQl,
  githubGraphQlCacheTtlSeconds,
  graphqlCacheClassForQuery,
  graphqlOperationName,
  isCacheableGraphQlQuery,
  isCacheableGraphQlResponseBody,
} from "./graphql-cache";

type CheckRunResponse = {
  id: number;
  html_url?: string;
  dryRunSuppressed?: boolean;
};

type CheckRunListResponse = {
  check_runs?: Array<{
    id: number;
    html_url?: string;
    name?: string;
    status?: GitHubCheckStatus | string | null;
    conclusion?: string | null;
  }>;
};

export type CheckRunOutcome =
  | { kind: "published"; id: number; html_url?: string }
  | { kind: "permission_missing"; warning: string };

type GitHubCheckConclusion =
  | Advisory["conclusion"]
  | GateCheckConclusion
  | "skipped";
type GitHubCheckStatus = "queued" | "in_progress" | "completed";

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
  options: { forceRefresh?: boolean } = {},
): Promise<string> {
  const cached = await readCachedToken(installationId);
  if (!options.forceRefresh && cached && cached.expiresAtMs - TOKEN_SAFETY_MARGIN_MS > Date.now())
    return cached.token;
  if (options.forceRefresh) return mintInstallationToken(env, installationId, cached, true);
  const existing = inFlightMints.get(installationId);
  if (existing) return existing; // a concurrent caller is already minting for this install — join it
  const mint = mintInstallationToken(env, installationId, cached).finally(() => {
    inFlightMints.delete(installationId);
  });
  inFlightMints.set(installationId, mint);
  return mint;
}

export function githubErrorStatus(error: unknown): number | null {
  const err = error as {
    status?: number;
    response?: { status?: number } | null;
  };
  return err.status ?? err.response?.status ?? null;
}

export function isGitHubBadCredentialsError(error: unknown): boolean {
  const status = githubErrorStatus(error);
  return status === 401 || /bad credentials/i.test(errorMessage(error));
}

function isGitHubInstallationPermissionError(error: unknown): boolean {
  return githubErrorStatus(error) === 403 && /resource not accessible by integration|not have permission/i.test(errorMessage(error));
}

async function expireCachedInstallationToken(
  installationId: number,
  rejectedToken: string,
): Promise<void> {
  const cached = await readCachedToken(installationId).catch(() => null);
  if (cached && cached.token !== rejectedToken) return;
  await writeCachedToken(installationId, { token: "", expiresAtMs: 0 });
}

export async function withInstallationTokenRetry<T>(
  env: Env,
  installationId: number,
  operation: (token: string) => Promise<T>,
): Promise<T> {
  const token = await createInstallationToken(env, installationId);
  try {
    return await operation(token);
  } catch (error) {
    const refreshForPermission = isGitHubInstallationPermissionError(error);
    if (!isGitHubBadCredentialsError(error) && !refreshForPermission) throw error;
    await expireCachedInstallationToken(installationId, token).catch(
      () => undefined,
    );
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "github_installation_token_rejected",
        installationId,
        status: githubErrorStatus(error),
        reason: refreshForPermission ? "permission_scope" : "bad_credentials",
        message: errorMessage(error).slice(0, 200),
      }),
    );
    const freshToken = await createInstallationToken(env, installationId, { forceRefresh: refreshForPermission });
    return await operation(freshToken);
  }
}

/** POST the App-installations access-token endpoint with a given JWT. Extracted so mintInstallationToken can
 *  issue the same request twice — once with the cached JWT, once with a freshly-signed one on a 401 (#2453).
 *  Also samples clock skew (#3811) from the response's Date header: this JWT-authenticated mint is exactly
 *  the call that fails first when the local clock drifts, so no extra network round-trip is needed to check it. */
async function requestInstallationTokenWithJwt(
  jwt: string,
  installationId: number,
): Promise<Response> {
  const response = await timeoutFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: githubHeaders({ token: jwt, json: true }),
    },
  );
  recordClockSkewFromResponse(response);
  return response;
}

/** Mint a fresh installation token (broker or local App-JWT) and cache it. `cached` is the expired/absent prior
 *  entry, consulted only for the brokered stale-token grace. Extracted from createInstallationToken so that
 *  function can single-flight concurrent cold-cache callers onto one mint (see inFlightMints). */
async function mintInstallationToken(
  env: Env,
  installationId: number,
  cached: { token: string; expiresAtMs: number } | null,
  forceRefresh = false,
): Promise<string> {
  // Self-host broker mode: a brokered self-host holds no App private key, so source the installation token from
  // the central Orb (enrollment secret → short-lived token) instead of minting locally. Cloud sets no enrollment
  // secret, so this branch is inert there → byte-identical. The token caches the same way (the install id is the
  // self-host's single bound install). See src/orb/broker-client.
  if (isOrbBrokerMode(env)) {
    try {
      const brokered = await fetchBrokeredInstallationToken(env, fetch, { forceRefresh });
      await writeCachedToken(installationId, {
        token: brokered.token,
        expiresAtMs: brokered.expiresAtMs,
      });
      if (brokered.installationId === installationId && Object.keys(brokered.permissions).length > 0) {
        await updateInstallationPermissions(env, installationId, brokered.permissions).catch((error) => {
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "github_installation_permissions_update_failed",
              installationId,
              message: errorMessage(error).slice(0, 200),
            }),
          );
        });
      }
      return brokered.token;
    } catch (error) {
      // Stale-token grace (#2): a brokered self-host holds no App key, so without this a single Orb mint failure
      // fails the review (→ retry/DLQ) and an Orb blip during the re-mint window stalls the fleet. If the cached
      // token is STILL within its real expiry, serve it — a valid token beats a stalled review (NO dangerous reuse:
      // an actually-expired token is never served). Otherwise emit an alertable structured log and rethrow so the
      // queue's retry/DLQ handles a genuine outage.
      if (!forceRefresh && cached && cached.expiresAtMs > Date.now()) {
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
  let response = await requestInstallationTokenWithJwt(jwt, installationId);
  if (response.status === 401) {
    // The cached App JWT itself was rejected (a transient GitHub-side validation hiccup, a clock-skew edge case,
    // or a brief App suspend/reinstate) while env.GITHUB_APP_PRIVATE_KEY is unchanged. Unlike installation tokens
    // (evicted + retried once by withInstallationTokenRetry), the App JWT had no eviction path at all: every mint
    // attempt across EVERY installation on the instance kept reusing the SAME poisoned cache entry for up to
    // APP_JWT_REUSE_MS (8 minutes), stalling merges/comments/check-runs/approvals fleet-wide (#2453). Evict + retry
    // once with a freshly-signed JWT, mirroring withInstallationTokenRetry's identical bounded-once pattern.
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "github_app_jwt_rejected",
        appId: env.GITHUB_APP_ID,
        status: response.status,
      }),
    );
    expireCachedAppJwt(env.GITHUB_APP_ID);
    const freshJwt = await createAppJwt(env);
    response = await requestInstallationTokenWithJwt(freshJwt, installationId);
    if (response.status === 401) {
      // The freshly-signed retry JWT was ALSO rejected. createAppJwt caches optimistically -- before this POST
      // proves the JWT valid -- so without this the just-rejected JWT would sit in the cache and keep poisoning
      // every mint fleet-wide for up to APP_JWT_REUSE_MS, exactly the bug this whole retry exists to fix
      // (flagged by the gate's own review of #2453). Evict again; the throw below still surfaces this failure to
      // the caller, but the NEXT mint attempt (this one or any other installation's) gets a fresh JWT instead of
      // replaying the poisoned one.
      expireCachedAppJwt(env.GITHUB_APP_ID);
    }
  }
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
  appJwtCache.clear();
  clearGitHubResponseCacheForTest();
}

export async function getAppInstallation(
  env: Env,
  installationId: number,
): Promise<NonNullable<GitHubWebhookPayload["installation"]>> {
  const jwt = await createAppJwt(env);
  const admissionKey = githubRateLimitAdmissionKeyForInstallation(installationId);
  const path = `/app/installations/${installationId}`;
  // Deliberately NOT passed as timeoutFetch's githubRateLimitAdmissionKey option here: that option also drives the
  // GET response-cache key (responseCacheKey, ./client), and `installation:{id}` collides across different calling
  // Apps for the same installation id -- this endpoint's response depends on WHICH App's JWT is asking, so the
  // cache must stay keyed off the Authorization header (the no-admission-key fallback) to preserve per-App-identity
  // isolation (#1940). recordGitHubRateLimitObservation below records the SAME admissionKey directly instead.
  const response = await timeoutFetch(`https://api.github.com${path}`, {
    headers: githubHeaders({ token: jwt, json: true }),
  });
  // #4506: refreshInstallationHealthRecords's per-installation loop (backfill.ts) makes one of these calls per
  // installation, but this call lives outside backfill.ts's module boundary -- and backfill.ts already imports
  // getAppInstallation FROM this file, so importing its recordGitHubResponse back here would cycle. Mirrors that
  // function's header-parsing inline instead (see its doc comment, backfill.ts, for the full write-path rationale).
  // Recorded before the ok-check: an exhausted/rate-limited (non-2xx) response's headers are exactly the signal
  // shouldWaitForGitHubRateLimit needs to back off later jobs.
  const resetHeader = response.headers.get("x-ratelimit-reset");
  await recordGitHubRateLimitObservation(env, {
    repoFullName: null,
    admissionKey,
    resource: "rest",
    path,
    statusCode: response.status,
    limitValue: parseNullableRateLimitHeader(response.headers.get("x-ratelimit-limit")),
    remaining: parseNullableRateLimitHeader(response.headers.get("x-ratelimit-remaining")),
    resetAt: resetHeader && Number.isFinite(Number(resetHeader)) ? new Date(Number(resetHeader) * 1000).toISOString() : undefined,
  });
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

function parseNullableRateLimitHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
    {
      headers: githubHeaders({ token, json: true }),
      githubRateLimitAdmission: true,
      githubRateLimitAdmissionKey: githubRateLimitAdmissionKeyForInstallation(installationId),
    },
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

/** Account-age throttle (#2561, anti-abuse): `GET /users/{login}` for `created_at`, so a repo can flag a
 *  freshly-created account as friction/visibility for the classic ban-evasion pattern (a banned login gets a
 *  fresh account the same day). `/users/{login}` is already classified "metadata" by `resolveGitHubCacheClass`
 *  (src/github/client.ts), so this reuses the existing response cache with no new caching infra. Returns null
 *  (fail-open) on any non-2xx/network error -- a lookup failure must never invent a "new account" finding. */
export async function getGithubUserCreatedAt(
  env: Env,
  installationId: number,
  login: string,
): Promise<string | null> {
  if (!login) return null;
  try {
    const token = await createInstallationToken(env, installationId);
    const response = await timeoutFetch(
      `https://api.github.com/users/${encodeURIComponent(login)}`,
      {
        headers: githubHeaders({ token, json: true }),
        githubRateLimitAdmission: true,
        githubRateLimitAdmissionKey: githubRateLimitAdmissionKeyForInstallation(installationId),
      },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as { created_at?: unknown };
    return typeof payload.created_at === "string" ? payload.created_at : null;
  } catch {
    return null;
  }
}

/** Sentinel result for cancelInFlightWorkflowRunsForHeadSha (#2462) -- mirrors CheckRunOutcome's shape (a
 *  typed "degraded, not thrown" result) so a missing `actions: write` grant never has to be distinguished
 *  from a genuine network/API failure by the caller via exception type-narrowing. */
export type CancelWorkflowRunsOutcome =
  | { kind: "cancelled"; cancelledCount: number; totalFound: number }
  | { kind: "permission_missing"; warning: string }
  | { kind: "error"; warning: string };

// A rate-limit / secondary-limit 403 is NOT a permission gap -- mirrors isCheckRunPermissionError's own
// exclusion (src/github/app.ts, isRateLimitedError check) so a burst-load 403 is never misrecorded as a
// permanent actions:write scope gap. Operates on the RAW response body's `message` field (not a thrown
// Octokit error) since these wrappers use plain timeoutFetch, not an Octokit client.
function isActionsPermissionMissingMessage(message: string): boolean {
  if (/secondary rate limit|\babuse\b|api rate limit exceeded|rate limit/i.test(message)) return false;
  return /resource not accessible by integration|not have permission/i.test(message) || message === "";
}

async function actionsApiErrorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === "string" ? body.message : "";
}

function actionsPermissionMissingResult(message: string): { kind: "permission_missing"; warning: string } {
  return {
    kind: "permission_missing",
    warning: `GitHub App Actions: write permission is missing (${message || "resource not accessible by integration"}). Enable it in the GitHub App settings and re-approve the installation.`,
  };
}

type ActionsRunFetchOptions = {
  headers: HeadersInit;
  githubRateLimitAdmission: true;
  githubRateLimitAdmissionKey: GitHubRateLimitAdmissionKey;
};

// GitHub's default page size (30) means a repo whose head SHA has more than one page of matching runs would
// silently leave page-2+ runs uncancelled while cancelInFlightWorkflowRunsForHeadSha reports totalFound/
// cancelledCount as if the listing were complete (gate finding). per_page=100 + follow Link: rel="next" until
// exhausted; bounded to MAX_WORKFLOW_RUN_LIST_PAGES so a pathological repo can't turn one webhook into an
// unbounded fetch loop (mirrors src/github/backfill.ts's githubPaginatedList/PR_DETAIL_MAX_PAGES bound).
const MAX_WORKFLOW_RUN_LIST_PAGES = 10;

function hasNextWorkflowRunPage(link: string | null): boolean {
  return Boolean(link?.split(",").some((part) => /rel="next"/.test(part)));
}

// Split out of cancelInFlightWorkflowRunsForHeadSha (a named function, not an inline for-of body) so v8's
// per-branch coverage tracking attributes hits correctly across repeated loop iterations with early returns
// -- an inline loop body with early `return`s inside a `for` inside an `async function` can under-report the
// "condition false" side of a branch even when it demonstrably executes (confirmed via a live debug trace).
type WorkflowRunListItem = {
  id: number;
  event?: string | null;
  pull_requests?: Array<{ number?: number | null } | null> | null;
};

function workflowRunBelongsToPull(run: WorkflowRunListItem, pullNumber: number): boolean {
  return (run.event === "pull_request" || run.event === "pull_request_target") && (run.pull_requests ?? []).some((pull) => pull?.number === pullNumber);
}

async function listWorkflowRunIdsForStatus(
  repoPath: string,
  headSha: string,
  pullNumber: number,
  status: "in_progress" | "queued",
  fetchOptions: ActionsRunFetchOptions,
): Promise<{ kind: "ids"; ids: number[] } | { kind: "permission_missing"; warning: string } | { kind: "error"; warning: string }> {
  const ids: number[] = [];
  for (let page = 1; page <= MAX_WORKFLOW_RUN_LIST_PAGES; page += 1) {
    const response = await timeoutFetch(
      `https://api.github.com/repos/${repoPath}/actions/runs?head_sha=${encodeURIComponent(headSha)}&status=${status}&per_page=100&page=${page}`,
      fetchOptions,
    );
    if (!response.ok) {
      const message = await actionsApiErrorMessage(response);
      if (response.status === 403 && isActionsPermissionMissingMessage(message)) {
        return actionsPermissionMissingResult(message);
      }
      return { kind: "error", warning: `Failed to list workflow runs (${response.status}): ${message || "unknown error"}` };
    }
    const payload = (await response.json()) as { workflow_runs?: WorkflowRunListItem[] };
    ids.push(...(payload.workflow_runs ?? []).filter((run) => workflowRunBelongsToPull(run, pullNumber)).map((run) => run.id));
    if (!hasNextWorkflowRunPage(response.headers.get("link"))) break;
  }
  return { kind: "ids", ids };
}

// Same extraction rationale as listWorkflowRunIdsForStatus above. Mirrors that function's error shape (#gate
// finding): a non-403 (or a 403 that isn't actually a permission gap -- rate limits, abuse detection) is a
// genuine `error`, carrying the real status + message, not a bare untyped "not a permission problem" with
// nothing for the caller to log or surface -- the prior shape let the caller's loop silently drop a 500/404/422
// on the floor instead of ever reaching an `error` branch at all.
async function cancelOneWorkflowRun(
  repoPath: string,
  runId: number,
  fetchOptions: ActionsRunFetchOptions,
): Promise<{ kind: "cancelled" } | { kind: "permission_missing"; warning: string } | { kind: "error"; warning: string }> {
  const response = await timeoutFetch(`https://api.github.com/repos/${repoPath}/actions/runs/${runId}/cancel`, { ...fetchOptions, method: "POST" });
  // 202 = cancellation accepted; 409 = already completed/cancelling -- both are non-failures here (the run is
  // no longer going to keep burning minutes either way). Only a genuine 403 signals a scope gap.
  if (response.ok || response.status === 409) return { kind: "cancelled" };
  const message = await actionsApiErrorMessage(response);
  if (response.status === 403 && isActionsPermissionMissingMessage(message)) {
    return actionsPermissionMissingResult(message);
  }
  return { kind: "error", warning: `Failed to cancel workflow run ${runId} (${response.status}): ${message || "unknown error"}` };
}

/** List then cancel every in-progress/queued Actions run at a PR's head SHA (#2462): a PR auto-closed for
 *  exceeding the per-contributor open-item cap should also stop burning CI minutes on its in-flight runs.
 *  Needs `actions: write` (list needs `actions: read`, effectively granted alongside write) -- an
 *  installation that hasn't granted it gets a typed `permission_missing` result, never a thrown error, so
 *  this can run as a best-effort side effect AFTER a close has already succeeded without risking that
 *  success being misrecorded as a failure. Greenfield: no existing Actions-API wrapper to extend. */
export async function cancelInFlightWorkflowRunsForHeadSha(
  env: Env,
  installationId: number,
  repoFullName: string,
  headSha: string,
  pullNumber: number,
): Promise<CancelWorkflowRunsOutcome> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return { kind: "error", warning: `Invalid repository full name: ${repoFullName}` };
  const repoPath = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  try {
    const token = await createInstallationToken(env, installationId);
    const fetchOptions: ActionsRunFetchOptions = {
      headers: githubHeaders({ token, json: true }),
      githubRateLimitAdmission: true,
      githubRateLimitAdmissionKey: githubRateLimitAdmissionKeyForInstallation(installationId),
    };
    const runIds = new Set<number>();
    for (const status of ["in_progress", "queued"] as const) {
      const listed = await listWorkflowRunIdsForStatus(repoPath, headSha, pullNumber, status, fetchOptions);
      if (listed.kind !== "ids") return listed;
      for (const id of listed.ids) runIds.add(id);
    }
    if (runIds.size === 0) return { kind: "cancelled", cancelledCount: 0, totalFound: 0 };
    let cancelledCount = 0;
    for (const runId of runIds) {
      const result = await cancelOneWorkflowRun(repoPath, runId, fetchOptions);
      // #gate finding: ANY non-cancelled result (permission_missing OR a genuine error) must stop and surface
      // immediately, exactly like listWorkflowRunIdsForStatus's own `listed.kind !== "ids"` check above --
      // silently `continue`-ing past a real 500/404/422 let the final return still claim `kind: "cancelled"`
      // with an undercounted cancelledCount, auditing a partial failure as a clean success.
      if (result.kind === "cancelled") cancelledCount += 1;
      else return result;
    }
    return { kind: "cancelled", cancelledCount, totalFound: runIds.size };
  } catch (error) {
    return { kind: "error", warning: error instanceof Error ? error.message : "unknown error" };
  }
}

// The App JWT is valid ~9 min (iat backdated 60s, exp +540s). Re-signing (RS256) it on EVERY call is wasteful CPU
// AND defeats response caching of App-level reads (/app/installations/{id}): the rotating JWT changes the
// auth-scoped response-cache key on every call, so the metadata cache class never hits for its heaviest caller
// (refresh-installation-health / the per-repo backfill). Reuse a minted JWT for a margin of its validity so
// repeated App-JWT reads share ONE signature and ONE stable cache key. A Map keyed by App id — so a process that
// alternates between App identities keeps a JWT per App instead of evicting one for another — with the private key
// held in the entry so a same-App CREDENTIAL ROTATION invalidates immediately and never serves a JWT signed by the
// now-revoked old key (a stale-key JWT would fail every App-level read once the old key is revoked). (#1940)
const APP_JWT_REUSE_MS = 8 * 60_000;
const appJwtCache = new Map<string, { privateKey: string; jwt: string; expiresAtMs: number }>();

/** Evict the cached App JWT for `appId` so the NEXT createAppJwt call re-signs, instead of continuing to serve a
 *  JWT GitHub just rejected for up to APP_JWT_REUSE_MS more (#2453). Mirrors expireCachedInstallationToken's
 *  identical eviction-on-rejection pattern for installation tokens. */
function expireCachedAppJwt(appId: string): void {
  appJwtCache.delete(appId);
}

/** Exported for the /ready GitHub App auth probe (#2497): a successful mint proves GITHUB_APP_PRIVATE_KEY is
 *  set and parses as a valid signing key (importPkcs8PrivateKey/crypto.subtle.sign both throw on a malformed
 *  key) without spending a live GitHub API call on every health-check tick. It can't detect a key that GitHub
 *  has since revoked (only a real API call would), but it catches the common "unset/invalid key" failure mode
 *  that otherwise leaves /ready reporting 200 while the review pipeline is completely dead. */
export async function createAppJwt(env: Env): Promise<string> {
  if (!env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GitHub App credentials are not configured.");
  }
  const nowMs = Date.now();
  const cached = appJwtCache.get(env.GITHUB_APP_ID);
  if (cached && cached.privateKey === env.GITHUB_APP_PRIVATE_KEY && cached.expiresAtMs > nowMs) {
    return cached.jwt;
  }
  const now = Math.floor(nowMs / 1000);
  const jwt = await signRs256Jwt(
    {
      iss: env.GITHUB_APP_ID,
      iat: now - 60,
      exp: now + 540,
    },
    env.GITHUB_APP_PRIVATE_KEY,
  );
  appJwtCache.set(env.GITHUB_APP_ID, {
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    jwt,
    expiresAtMs: nowMs + APP_JWT_REUSE_MS,
  });
  return jwt;
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
  // lane can OVERRIDE the generic verdict (surface_lane_reject → failure, surface_lane_manual → neutral),
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
      supersedeLegacyNames: [GITTENSORY_LEGACY_GATE_CHECK_NAME],
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
        title: "Gittensory Orb Review Agent is evaluating",
        summary:
          "Gittensory is running deterministic public PR hygiene checks.",
        text: "The review agent blocks every author on the repo's configured hard blockers (duplicate PRs by default); on everything else, and while state is still syncing, it stays advisory.",
      },
      updateExisting: "in_progress_only",
      supersedeLegacyNames: [GITTENSORY_LEGACY_GATE_CHECK_NAME],
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
  options: { checkRunId?: number | undefined } = {},
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
      checkRunId: options.checkRunId,
      output: {
        title: "Gittensory Orb Review Agent skipped",
        summary: reason,
        text: "Gittensory does not post late first comments on closed or merged pull requests.",
      },
      supersedeLegacyNames: [GITTENSORY_LEGACY_GATE_CHECK_NAME],
      mode,
    },
  );
}

/**
 * Finalize a previously-posted pending Gate check to a NEUTRAL (non-blocking) terminal state when the
 * evaluation could not finish (a transient error/timeout in the work between posting the pending check and
 * completing it). This guarantees the "Gittensory Orb Review Agent is evaluating" run never hangs in_progress forever;
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
        title: "Gittensory Orb Review Agent — could not finish evaluating",
        summary:
          "A transient error interrupted gate evaluation. This does NOT block the PR and re-runs automatically on the next push.",
        text: "Gittensory finalizes the review-agent check to a neutral, non-blocking state when evaluation is interrupted, so the check never hangs in_progress. Push a new commit or use the 'Re-run Gittensory review' checkbox to re-evaluate.",
      },
      checkRunId: options.checkRunId,
      supersedeLegacyNames: [GITTENSORY_LEGACY_GATE_CHECK_NAME],
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
        title: `Gittensory Orb Review Agent — overridden by @${options.actor}`,
        summary:
          "A maintainer set the review-agent check to neutral for THIS commit only. This does NOT permanently bypass the review agent; a new push re-evaluates it.",
        text: `Overridden by @${options.actor}: ${options.reason}`,
      },
      checkRunId: options.checkRunId,
      supersedeLegacyNames: [GITTENSORY_LEGACY_GATE_CHECK_NAME],
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
    updateExisting?: "any" | "in_progress_only" | "never" | undefined;
    supersedeLegacyNames?: readonly string[] | undefined;
    mode?: AgentActionMode | undefined;
  },
): Promise<CheckRunOutcome | null> {
  if (!advisory.headSha) return null;
  // Narrow once into a const so the postNewCheckRun closure below sees a string, not string | undefined.
  const headSha = advisory.headSha;
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo)
    throw new Error(`Invalid repository full name: ${repoFullName}`);

  return await withInstallationTokenRetry(env, installationId, async (token) => {
    // makeInstallationOctokit injects the shared per-request timeout (a stalled PATCH can never orphan the
    // in_progress check) AND suppresses the check-run writes under a non-live mode (dry-run / pause / freeze).
    const octokit = makeInstallationOctokit(env, token, check.mode, githubRateLimitAdmissionKeyForInstallation(installationId));
    // Point the merge-box "Details" link at the repo's Gittensory maintainer panel instead of GitHub's generic
    // check page. Spread conditionally so a URL-construction failure (null) just omits it. (#audit-details-url)
    const detailsUrl = maintainerControlPanelUrl(env, repoFullName);
    const detailsUrlBody = detailsUrl ? { details_url: detailsUrl } : {};

    // POST a fresh check-run THIS App owns. Used for a brand-new run AND as the cross-app fallback below.
    const postNewCheckRun = async (): Promise<CheckRunOutcome | null> => {
      const response = await octokit.request(
        "POST /repos/{owner}/{repo}/check-runs",
        {
          owner,
          repo,
          name: check.name,
          head_sha: headSha,
          status: check.status ?? "completed",
          ...(check.conclusion ? { conclusion: check.conclusion } : {}),
          output: check.output,
          ...detailsUrlBody,
        },
      );
      return publishedOutcome(response.data as CheckRunResponse);
    };
    // PATCH an existing run by id. If that run was created by a PRIOR GitHub App (install migrated / reinstalled under a
    // new app_id), GitHub 403s "can only be modified by the GitHub App that created it" — that stale run is unreachable,
    // so fall through (null) to POST a fresh one this App owns instead of failing the gate forever. (#cross-app-checkrun)
    const patchCheckRun = async (id: number): Promise<CheckRunOutcome | null> => {
      try {
        const response = await octokit.request(
          "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
          {
            owner,
            repo,
            check_run_id: id,
            name: check.name,
            status: check.status ?? "completed",
            ...(check.conclusion ? { conclusion: check.conclusion } : {}),
            output: outputForCheckRunUpdate(check.output),
            ...detailsUrlBody,
          },
        );
        return publishedOutcome(response.data as CheckRunResponse);
      } catch (error) {
        if (!isCrossAppCheckRunError(error)) throw error;
        console.log(
          JSON.stringify({
            level: "info",
            event: "check_run_cross_app_repost",
            repository: `${owner}/${repo}`,
            staleCheckRunId: id,
          }),
        );
        return null;
      }
    };
    const finalizeLegacyPendingCheckRuns = async (): Promise<void> => {
      const legacyNames = check.supersedeLegacyNames ?? [];
      if (legacyNames.length === 0 || check.checkRunId) return;
      for (const legacyName of legacyNames) {
        try {
          const existing = await octokit.request(
            "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
            {
              owner,
              repo,
              ref: headSha,
              check_name: legacyName,
              filter: "latest",
              per_page: 1,
            },
          );
          const legacyRun = (existing.data as CheckRunListResponse)
            .check_runs?.[0];
          if (
            !legacyRun ||
            (legacyRun.name && legacyRun.name !== legacyName) ||
            (legacyRun.status ?? "").toLowerCase() === "completed"
          )
            continue;
          await octokit.request(
            "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
            {
              owner,
              repo,
              check_run_id: legacyRun.id,
              name: legacyName,
              status: "completed",
              conclusion: "neutral",
              output: outputForCheckRunUpdate({
                title: `${GITTENSORY_GATE_CHECK_NAME} superseded this legacy check`,
                summary:
                  "This legacy check name was completed after the review-agent check was renamed.",
                text: `Use ${GITTENSORY_GATE_CHECK_NAME} for current Gittensory review results.`,
              }),
              ...detailsUrlBody,
            },
          );
        } catch (error) {
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "legacy_gate_check_finalize_failed",
              repository: `${owner}/${repo}`,
              legacyName,
              error: errorMessage(error),
            }),
          );
        }
      }
    };
    const finish = async (outcome: CheckRunOutcome | null): Promise<CheckRunOutcome | null> => {
      if (outcome) await finalizeLegacyPendingCheckRuns();
      return outcome;
    };

    try {
      if (check.checkRunId) {
        const out = await patchCheckRun(check.checkRunId);
        if (out) return await finish(out);
      } else if (check.updateExisting !== "never") {
        const existing = await octokit.request(
          "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
          {
            owner,
            repo,
            ref: headSha,
            check_name: check.name,
            filter: "latest",
            per_page: 1,
          },
        );
        const existingCheckRun = (existing.data as CheckRunListResponse)
          .check_runs?.[0];
        if (
          existingCheckRun &&
          (check.updateExisting !== "in_progress_only" ||
            (existingCheckRun.status ?? "").toLowerCase() !== "completed")
        ) {
          const out = await patchCheckRun(existingCheckRun.id);
          if (out) return await finish(out);
        }
      }
      return await finish(await postNewCheckRun());
    } catch (error) {
      if (isCheckRunPermissionError(error)) {
        // Capture the ACTUAL response (status + body). A 403 here is often NOT a real permission gap (the App has
        // Checks:write) — it can be a per-PR access quirk (e.g. a fork-head commit the App can't write to) — and this
        // log is the only way to tell why, instead of an opaque "permission missing". Surfaces to Sentry with a real
        // message via console.error (#review-403-context).
        const e = error as { status?: number; message?: string };
        console.error(
          JSON.stringify({
            level: "error",
            event: "check_run_post_denied",
            repository: `${owner}/${repo}`,
            status: e.status ?? null,
            message: (e.message ?? "Resource not accessible by integration").slice(
              0,
              300,
            ),
          }),
        );
        return {
          kind: "permission_missing",
          warning:
            "GitHub App Checks: write permission is missing. Enable it in the GitHub App settings and re-approve the installation.",
        };
      }
      throw error;
    }
  });
}

function outputForCheckRunUpdate(output: CheckRunOutput): CheckRunOutput {
  if (!output.annotations || output.annotations.length === 0) return output;
  const { annotations: _annotations, ...safeOutput } = output;
  return safeOutput;
}

function publishedOutcome(data: CheckRunResponse): CheckRunOutcome | null {
  if (data.dryRunSuppressed) return null;
  const outcome: { kind: "published"; id: number; html_url?: string } = {
    kind: "published",
    id: data.id,
  };
  if (data.html_url) outcome.html_url = data.html_url;
  return outcome;
}

/** A check-run created by a PRIOR GitHub App (the install was migrated / reinstalled under a new app_id) cannot be
 *  PATCHed by THIS App — GitHub 403s "Invalid app_id N - check run can only be modified by the GitHub App that
 *  created it". That stale run is unreachable, so the caller reposts a fresh one this App owns. (#cross-app-checkrun) */
export function isCrossAppCheckRunError(error: unknown): boolean {
  /* v8 ignore next -- Octokit wraps thrown fetch values in HttpError objects before this helper sees them. */
  if (typeof error !== "object" || error === null) return false;
  const e = error as { message?: string };
  return (
    typeof e.message === "string" &&
    /can only be modified by the GitHub App that created it|invalid app_id/i.test(
      e.message,
    )
  );
}

/** Mirror of {@link isRateLimitedResponse} for a THROWN Octokit error (has .status, .message, .response.headers).
 *  A rate-limit 403/429 is not a permission gap — used to keep it out of isCheckRunPermissionError. */
function isRateLimitedError(error: {
  status?: number;
  message?: string;
  response?: { headers?: Record<string, unknown> };
}): boolean {
  if (error.status !== 403 && error.status !== 429) return false;
  const headers = error.response?.headers ?? {};
  if (headers["retry-after"] != null) return true;
  if (headers["x-ratelimit-remaining"] === "0") return true;
  return (
    typeof error.message === "string" &&
    /secondary rate limit|\babuse\b|api rate limit exceeded/i.test(error.message)
  );
}

export function isGitHubRateLimitedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as {
    status?: number;
    message?: string;
    response?: { headers?: Record<string, unknown> };
  };
  if (isRateLimitedError(e)) return true;
  return (
    e.status === undefined &&
    typeof e.message === "string" &&
    /secondary rate limit|\babuse\b|api rate limit exceeded|rate limit/i.test(
      e.message,
    )
  );
}

/** Exported for tests. */
export function isCheckRunPermissionError(error: unknown): boolean {
  /* v8 ignore next -- Octokit wraps thrown fetch values in HttpError objects before this helper sees them. */
  if (typeof error !== "object" || error === null) return false;
  const e = error as {
    status?: number;
    message?: string;
    response?: { headers?: Record<string, unknown> };
  };
  // A rate-limit / secondary-limit 403 is NOT a permission gap — never record it as one (the App has Checks:write;
  // a 403 under burst load is the abuse limit). timeoutFetch already retries these inline; an EXHAUSTED one surfaces
  // here and must PROPAGATE (→ queue retry), not be swallowed as a permanent permission_missing. (#ratelimit-resilience)
  if (isRateLimitedError(e)) return false;
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
