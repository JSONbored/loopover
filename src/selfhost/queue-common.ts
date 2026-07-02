import { createHash } from "node:crypto";

import { retryableJobDelayMs } from "../queue/retryable";
import {
  LOW_REST_RATE_LIMIT_REMAINING,
  MAINTENANCE_RESERVED_HEADROOM,
} from "../github/rate-limit";
import {
  githubRateLimitAdmissionKeyForInstallation,
  githubRateLimitAdmissionKeyForPublicToken,
  latestGitHubRestRateLimitObservation,
  type GitHubRateLimitAdmissionKey,
} from "../github/client";
import { githubWebhookCoalesceKey } from "../github/webhook-coalesce";
import type { GitHubWebhookPayload, JobMessage } from "../types";
import { extractPayloadType } from "./audit";

const DEFAULT_RATE_LIMIT_JITTER_MS = 5 * 60_000;
const DEFAULT_STARTUP_JITTER_MS = 3 * 60_000;
const DEFAULT_RECOVERY_JITTER_MS = 60_000;
const DEFAULT_SCHEDULED_ENQUEUE_JITTER_MS = 5 * 60_000;
const DEFAULT_STARTUP_JITTER_MIN_JOBS = 8;
const DEFAULT_PROCESSING_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_BACKGROUND_CONCURRENCY = 1;
export const FOREGROUND_QUEUE_PRIORITY_FLOOR = 8;

export type SelfHostQueueJobStatus = "pending" | "processing" | "dead";

export type SelfHostQueueSnapshotRow = {
  type: string;
  status: SelfHostQueueJobStatus;
  count: number;
  due: number;
};

export type SelfHostQueueSnapshot = {
  totals: Record<SelfHostQueueJobStatus, number> & { due: number };
  byType: SelfHostQueueSnapshotRow[];
};

export interface SelfHostQueueIntrospection {
  snapshot(): SelfHostQueueSnapshot | Promise<SelfHostQueueSnapshot>;
}

// Webhook-driven work (a fresh PR -> its review) jumps ahead of heavy background jobs. Per-PR review refreshes
// sit just below real webhooks, and sweep fan-out sits below those so stale surfaces are repaired during bursts.
// Bot-generated comment edits are background noise; keeping them with real webhooks lets panel edits starve repair.
const AGENT_REGATE_PRIORITY = 9;
const GITHUB_BUDGET_BACKGROUND_TYPES = new Set<string>([
  "agent-regate-sweep",
  "backfill-registered-repos",
  "backfill-repo-segment",
  "backfill-pr-details",
  "refresh-upstream-sources",
  "build-upstream-ruleset",
  "detect-upstream-drift",
  "refresh-upstream-drift",
  "file-upstream-drift-issues",
  "build-contributor-evidence",
  "build-contributor-decision-packs",
  "refresh-contributor-activity",
  "build-burden-forecasts",
  "rag-index-repo",
]);
const PRIORITY_BY_TYPE = new Map([
  ["agent-regate-pr", AGENT_REGATE_PRIORITY],
  ["recapture-preview", 9],
  ["agent-regate-sweep", 8],
]);

export function jobPriority(payload: string): number {
  const type = extractPayloadType(payload) ?? "";
  if (type === "github-webhook") return githubWebhookPriority(payload);
  if (type === "agent-regate-pr") return agentRegatePriority(payload);
  return PRIORITY_BY_TYPE.get(type) ?? 0;
}

function agentRegatePriority(payload: string): number {
  try {
    const message = JSON.parse(payload) as { deliveryId?: unknown };
    const deliveryId =
      typeof message.deliveryId === "string" ? message.deliveryId : "";
    if (deliveryId.startsWith("manual-regate:")) return 99;
  } catch {
    return AGENT_REGATE_PRIORITY;
  }
  return AGENT_REGATE_PRIORITY;
}

export function isForegroundJobPriority(priority: number): boolean {
  return priority >= FOREGROUND_QUEUE_PRIORITY_FLOOR;
}

export function queueBackgroundConcurrency(
  totalConcurrency: number,
  configured: unknown = process.env.QUEUE_BACKGROUND_CONCURRENCY,
): number {
  const total = Number.isFinite(totalConcurrency)
    ? Math.max(0, Math.floor(totalConcurrency))
    : 0;
  const raw =
    configured === undefined || configured === null || configured === ""
      ? DEFAULT_BACKGROUND_CONCURRENCY
      : Number(configured);
  const parsed =
    Number.isFinite(raw) && raw >= 0
      ? Math.floor(raw)
      : DEFAULT_BACKGROUND_CONCURRENCY;
  return Math.min(parsed, total);
}

export function isGitHubBudgetBackgroundJob(message: JobMessage): boolean {
  if (message.type === "agent-regate-pr") {
    if (typeof message.deliveryId !== "string") return false;
    return !message.deliveryId.startsWith("manual-regate:");
  }
  return GITHUB_BUDGET_BACKGROUND_TYPES.has(message.type);
}

export function buildSelfHostQueueSnapshot(
  rows: Iterable<{ payload?: unknown; status?: unknown; run_after?: unknown; runAfter?: unknown }>,
  nowMs = Date.now(),
): SelfHostQueueSnapshot {
  const totals = { pending: 0, processing: 0, dead: 0, due: 0 };
  const byKey = new Map<string, SelfHostQueueSnapshotRow>();
  for (const row of rows) {
    const status = queueStatus(row.status);
    if (!status) continue;
    const type = typeof row.payload === "string" ? (extractPayloadType(row.payload) ?? "unknown") : "unknown";
    const runAfter = queueRunAfterMs(row.run_after ?? row.runAfter);
    const due = status === "pending" && (runAfter === null || runAfter <= nowMs) ? 1 : 0;
    const key = `${type}\0${status}`;
    const current = byKey.get(key) ?? { type, status, count: 0, due: 0 };
    current.count += 1;
    current.due += due;
    byKey.set(key, current);
    totals[status] += 1;
    totals.due += due;
  }
  return {
    totals,
    byType: [...byKey.values()].sort((a, b) => a.type.localeCompare(b.type) || a.status.localeCompare(b.status)),
  };
}

export function queueSnapshotBacklog(
  snapshot: SelfHostQueueSnapshot | null | undefined,
  types: readonly string[],
  statuses: readonly SelfHostQueueJobStatus[] = ["pending", "processing"],
): number {
  if (!snapshot) return 0;
  const typeSet = new Set(types);
  const statusSet = new Set(statuses);
  return snapshot.byType.reduce(
    (sum, row) => sum + (typeSet.has(row.type) && statusSet.has(row.status) ? row.count : 0),
    0,
  );
}

export async function queueSnapshotFromBinding(binding: Queue): Promise<SelfHostQueueSnapshot | null> {
  const snapshot = (binding as Queue & Partial<SelfHostQueueIntrospection>).snapshot;
  if (typeof snapshot !== "function") return null;
  return snapshot.call(binding);
}

function queueStatus(value: unknown): SelfHostQueueJobStatus | null {
  return value === "pending" || value === "processing" || value === "dead" ? value : null;
}

function queueRunAfterMs(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : null;
  return parsed !== null && Number.isFinite(parsed) ? parsed : null;
}

function githubObservedRateLimitDelayMs(
  observation:
    | { remaining?: unknown; reset_at?: unknown; resetAt?: unknown }
    | null
    | undefined,
  floor: number,
  nowMs = Date.now(),
): number | null {
  const rawRemaining = observation?.remaining;
  const remaining =
    typeof rawRemaining === "number"
      ? normalizedNumber(rawRemaining)
      : typeof rawRemaining === "string"
        ? normalizedNumber(Number(rawRemaining))
        : null;
  const resetAt =
    typeof observation?.reset_at === "string"
      ? observation.reset_at
      : typeof observation?.resetAt === "string"
        ? observation.resetAt
        : null;
  if (remaining === null || !resetAt) return null;
  if (remaining > floor) return null;
  const ms = Date.parse(resetAt) - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.max(30_000, Math.min(900_000, (Math.ceil(ms / 1000) + 15) * 1000));
}

function observationMs(
  observation:
    | { observed_at?: unknown; observedAt?: unknown; observedAtMs?: unknown }
    | null
    | undefined,
): number | null {
  if (typeof observation?.observedAtMs === "number" && Number.isFinite(observation.observedAtMs)) {
    return observation.observedAtMs;
  }
  const raw =
    typeof observation?.observed_at === "string"
      ? observation.observed_at
      : typeof observation?.observedAt === "string"
        ? observation.observedAt
        : null;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

type AdmissionObservation = {
  admission_key?: unknown;
  admissionKey?: unknown;
  remaining?: unknown;
  reset_at?: unknown;
  resetAt?: unknown;
  observed_at?: unknown;
  observedAt?: unknown;
  observedAtMs?: unknown;
};

function observationAdmissionKey(
  observation: AdmissionObservation | null | undefined,
): GitHubRateLimitAdmissionKey | null | undefined {
  if (typeof observation?.admission_key === "string") {
    return observation.admission_key as GitHubRateLimitAdmissionKey;
  }
  if (typeof observation?.admissionKey === "string") {
    return observation.admissionKey as GitHubRateLimitAdmissionKey;
  }
  if (observation?.admission_key === null || observation?.admissionKey === null) {
    return null;
  }
  return undefined;
}

function newerRateLimitObservation(
  current: AdmissionObservation | null | undefined,
  candidate: AdmissionObservation,
): AdmissionObservation | null {
  if (!current) return candidate;
  const currentMs = observationMs(current);
  const candidateMs = observationMs(candidate);
  if (candidateMs === null) return currentMs === null ? candidate : current;
  if (currentMs === null) return candidate;
  return candidateMs > currentMs ? candidate : current;
}

function rateLimitAdmissionDelayForObservation(
  kind: GitHubRateLimitAdmissionKind,
  observation: AdmissionObservation | null | undefined,
  nowMs: number,
): number | null {
  return kind === "webhook"
    ? githubWebhookRateLimitDelayMs(observation, nowMs)
    : githubBackgroundRateLimitDelayMs(observation, nowMs);
}

function fallbackObservationCanOverrideExact(
  fallback: AdmissionObservation | null,
  exact: AdmissionObservation | null,
): boolean {
  if (!fallback) return false;
  // A null/unkeyed fallback row is frequently a DIFFERENT bucket entirely (a public token, another
  // consumer's traffic, or a pre-migration write that never carried an admission_key) -- we have no
  // evidence it reports on the SAME budget as this admission key. That untrustworthiness applies
  // regardless of which direction the fallback's reading points: it must not suppress a healthy exact
  // observation (the original bug), but it must equally not CLEAR a genuine exact exhaustion either --
  // both are the same category of false signal, just pointing opposite ways. Once an exact observation
  // exists for this key, it alone governs; the exact reading's own reset_at already bounds how long an
  // exhaustion can block admission, so there is no correctness reason to let an unrelated bucket
  // override it in either direction. Fallback governs ONLY when no exact observation exists at all.
  return !exact;
}

export function githubRateLimitAdmissionKeyForJob(message: JobMessage): GitHubRateLimitAdmissionKey | null {
  const installationId =
    message.type === "github-webhook"
      ? message.payload?.installation?.id
      : "installationId" in message
        ? message.installationId
        : null;
  return typeof installationId === "number" && Number.isFinite(installationId)
    ? githubRateLimitAdmissionKeyForInstallation(installationId)
    : null;
}

export type GitHubRateLimitAdmissionKind = "background" | "webhook";

export type GitHubRateLimitAdmissionTarget = {
  kind: GitHubRateLimitAdmissionKind;
  admissionKey: GitHubRateLimitAdmissionKey | null;
};

export type GitHubRateLimitKeyScope = "installation" | "public" | "global" | "unknown" | "other";
export type GitHubRateLimitMetricLabels = {
  job_type: string;
  key_scope: GitHubRateLimitKeyScope;
  kind: GitHubRateLimitAdmissionKind | "unknown";
};
export type GitHubRateLimitMetricContext = {
  labels: GitHubRateLimitMetricLabels;
  spanAttributes: {
    "github.rate_limit.kind": GitHubRateLimitAdmissionKind | "unknown";
    "github.rate_limit.key_scope": GitHubRateLimitKeyScope;
  };
  logFields: {
    jobType: string;
    key_scope: GitHubRateLimitKeyScope;
    kind: GitHubRateLimitAdmissionKind | "unknown";
  };
};

export function githubRateLimitAdmissionKeyScope(
  admissionKey: GitHubRateLimitAdmissionKey | null | undefined,
): GitHubRateLimitKeyScope {
  if (!admissionKey) return "unknown";
  if (admissionKey.startsWith("installation:")) return "installation";
  if (admissionKey === githubRateLimitAdmissionKeyForPublicToken()) return "public";
  if (admissionKey.startsWith("global:")) return "global";
  return "other";
}

export function githubRateLimitMetricLabels(
  message: JobMessage,
  target: GitHubRateLimitAdmissionTarget | null | undefined,
): GitHubRateLimitMetricLabels {
  return {
    job_type: message.type,
    key_scope: githubRateLimitAdmissionKeyScope(target?.admissionKey),
    kind: target?.kind ?? "unknown",
  };
}

export function githubRateLimitMetricContext(
  message: JobMessage,
  target: GitHubRateLimitAdmissionTarget | null | undefined,
): GitHubRateLimitMetricContext {
  const labels = githubRateLimitMetricLabels(message, target);
  return {
    labels,
    spanAttributes: {
      "github.rate_limit.kind": labels.kind,
      "github.rate_limit.key_scope": labels.key_scope,
    },
    logFields: {
      jobType: labels.job_type,
      key_scope: labels.key_scope,
      kind: labels.kind,
    },
  };
}

export function githubRateLimitAdmissionTargetForJob(
  message: JobMessage,
): GitHubRateLimitAdmissionTarget | null {
  if (message.type === "github-webhook") {
    return {
      kind: "webhook",
      admissionKey: githubRateLimitAdmissionKeyForJob(message),
    };
  }
  if (!isGitHubBudgetBackgroundJob(message)) return null;
  const admissionKey = githubRateLimitAdmissionKeyForJob(message);
  return {
    kind: "background",
    admissionKey: admissionKey ?? githubRateLimitAdmissionKeyForPublicToken(),
  };
}

export function matchesGitHubRateLimitAdmissionTarget(
  candidate: GitHubRateLimitAdmissionTarget | null,
  blocked: GitHubRateLimitAdmissionTarget,
): boolean {
  if (candidate === null) return false;
  // A null-key CANDIDATE is legacy/unknown-actor work whose true bucket we can't prove is unaffected,
  // so it still parks alongside any confirmed exhaustion (known-keyed or null-keyed alike). But a
  // null-key BLOCKED target (the job that actually failed had no admissionKey) does NOT justify
  // parking every OTHER concretely-keyed installation's work too -- we only know ONE unscoped bucket
  // is exhausted, not that a SPECIFIC installation's own budget is affected. Scoping this the same way
  // as a keyed blocked target avoids the same false-positive class as a stale unkeyed observation
  // pinning a healthy installation's webhooks (mirrors fallbackObservationCanOverrideExact above).
  return candidate.admissionKey === blocked.admissionKey || candidate.admissionKey === null;
}

export function githubRateLimitAdmissionDelayMs(
  kind: GitHubRateLimitAdmissionKind,
  admissionKey: GitHubRateLimitAdmissionKey | null | undefined,
  persisted: AdmissionObservation | readonly AdmissionObservation[] | null | undefined,
  nowMs = Date.now(),
): number | null {
  const local = admissionKey ? latestGitHubRestRateLimitObservation(admissionKey) : null;
  const candidates = Array.isArray(persisted) ? persisted : [persisted];
  const keyedCandidateMayOmitKey = Boolean(admissionKey) && !Array.isArray(persisted);
  let exact: AdmissionObservation | null = local;
  let fallback: AdmissionObservation | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const candidateKey = observationAdmissionKey(candidate);
    if (admissionKey && (candidateKey === admissionKey || (candidateKey === undefined && keyedCandidateMayOmitKey))) {
      exact = newerRateLimitObservation(exact, candidate);
    } else if (candidateKey === null || candidateKey === undefined) {
      fallback = newerRateLimitObservation(fallback, candidate);
    }
  }
  const observation = fallbackObservationCanOverrideExact(fallback, exact)
    ? fallback
    : exact;
  return rateLimitAdmissionDelayForObservation(kind, observation, nowMs);
}

export function githubBackgroundRateLimitDelayMs(
  observation:
    | { remaining?: unknown; reset_at?: unknown; resetAt?: unknown }
    | null
    | undefined,
  nowMs = Date.now(),
): number | null {
  return githubObservedRateLimitDelayMs(observation, MAINTENANCE_RESERVED_HEADROOM, nowMs);
}

export function githubWebhookRateLimitDelayMs(
  observation:
    | { remaining?: unknown; reset_at?: unknown; resetAt?: unknown }
    | null
    | undefined,
  nowMs = Date.now(),
): number | null {
  return githubObservedRateLimitDelayMs(observation, LOW_REST_RATE_LIMIT_REMAINING, nowMs);
}

export function githubRateLimitAdmissionRemainingFloor(kind: "background" | "webhook"): number {
  return kind === "webhook" ? LOW_REST_RATE_LIMIT_REMAINING : MAINTENANCE_RESERVED_HEADROOM;
}

function githubWebhookPriority(payload: string): number {
  try {
    const message = JSON.parse(payload) as {
      eventName?: unknown;
      payload?: {
        action?: unknown;
        sender?: { login?: unknown; type?: unknown } | null;
      } | null;
    };
    const eventName = typeof message.eventName === "string" ? message.eventName : "";
    const action = typeof message.payload?.action === "string" ? message.payload.action : "";
    const senderLogin =
      typeof message.payload?.sender?.login === "string"
        ? message.payload.sender.login.toLowerCase()
        : "";
    const senderType =
      typeof message.payload?.sender?.type === "string"
        ? message.payload.sender.type.toLowerCase()
        : "";
    if (
      eventName === "issue_comment" &&
      action === "edited" &&
      (senderType === "bot" || senderLogin.endsWith("[bot]"))
    )
      return 0;
  } catch {
    return 0;
  }
  return 10;
}

/** A diagnosable message for a job failure, including the ROOT CAUSE — not just the wrapper's own text.
 *  Drizzle's DrizzleQueryError (thrown on every failed query, both queue backends) sets its OWN `.message` to a
 *  generic "Failed query: <sql>\nparams: <params>" and stashes the actual driver error — a Postgres SQLSTATE
 *  deadlock/serialization failure, a SQLite busy/constraint code, a connection reset, etc. — on `.cause`.
 *  Logging only `error.message` for a query failure is undiagnosable: every failure looks identical (the same
 *  query + params) regardless of the actual reason, which is exactly the information needed to tell a transient
 *  lock/connection blip apart from a genuine data or schema bug. Includes the cause's `.code` (Postgres SQLSTATE
 *  / SQLite result code) when present, since that is the canonical, greppable identifier for the failure class. */
export function errorMessageWithCause(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const cause = error.cause;
  if (!(cause instanceof Error)) return error.message;
  const code = (cause as { code?: unknown }).code;
  const codeSuffix = typeof code === "string" && code.length > 0 ? ` [${code}]` : "";
  return `${error.message} — caused by: ${cause.message}${codeSuffix}`;
}

const DEFAULT_GITHUB_RATE_LIMIT_RETRY_MS = 5 * 60_000;
const MAX_GITHUB_RATE_LIMIT_RETRY_MS = 65 * 60_000;

export function githubRateLimitRetryDelayMs(
  error: unknown,
  nowMs = Date.now(),
): number | null {
  if (typeof error !== "object" || error === null) return null;
  const err = error as {
    status?: unknown;
    message?: unknown;
    response?: { headers?: Headers | Record<string, unknown> | null } | null;
  };
  const status = typeof err.status === "number" ? err.status : null;
  const message = typeof err.message === "string" ? err.message : "";
  const headers = err.response?.headers ?? null;
  const retryAfter = numberHeader(headers, "retry-after");
  if (retryAfter !== null)
    return clampRetryDelay(retryAfter * 1000);

  const remaining = stringHeader(headers, "x-ratelimit-remaining");
  const reset = numberHeader(headers, "x-ratelimit-reset");
  if (remaining === "0" && reset !== null) {
    const delay = reset * 1000 - nowMs + 5_000;
    return clampRetryDelay(delay);
  }

  if (
    (status === 403 || status === 429) &&
    /secondary rate limit|\babuse\b|api rate limit exceeded|rate limit/i.test(
      message,
    )
  )
    return DEFAULT_GITHUB_RATE_LIMIT_RETRY_MS;

  return null;
}

export function nonConsumingRetryDelayMs(error: unknown): number | null {
  return githubRateLimitRetryDelayMs(error);
}

export function consumingRetryDelayMs(
  error: unknown,
  defaultDelayMs: number,
): number {
  return retryableJobDelayMs(error) ?? defaultDelayMs;
}

export function rateLimitRetryDelayWithJitter(
  delayMs: number,
  seed: string,
): number {
  return delayMs + deterministicJitterMs(seed, queueRateLimitJitterMs());
}

export function queueStartupJitterMs(): number {
  return envDurationMs("QUEUE_STARTUP_JITTER_MS", DEFAULT_STARTUP_JITTER_MS);
}

export function queueRecoveryJitterMs(): number {
  return envDurationMs("QUEUE_RECOVERY_JITTER_MS", DEFAULT_RECOVERY_JITTER_MS);
}

export function queueProcessingTimeoutMs(): number {
  return envDurationMs(
    "QUEUE_PROCESSING_TIMEOUT_MS",
    DEFAULT_PROCESSING_TIMEOUT_MS,
  );
}

export function queueStartupJitterMinJobs(): number {
  const raw = Number(process.env.QUEUE_STARTUP_JITTER_MIN_JOBS ?? DEFAULT_STARTUP_JITTER_MIN_JOBS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_STARTUP_JITTER_MIN_JOBS;
}

export function deterministicJitterMs(seed: string, maxJitterMs: number): number {
  if (!Number.isFinite(maxJitterMs) || maxJitterMs <= 0) return 0;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0) % (Math.floor(maxJitterMs) + 1);
}

export function scheduledEnqueueJitterMs(): number {
  return envDurationMs(
    "SCHEDULED_ENQUEUE_JITTER_MS",
    DEFAULT_SCHEDULED_ENQUEUE_JITTER_MS,
  );
}

// The every-tick priority scheduled jobs enqueue immediately; the periodic maintenance jobs are deterministically
// phase-spread across the jitter window so a top-of-hour cron tick does not flush every heavy per-repo fan-out
// parent in the same instant (which drains the shared GitHub REST bucket and trips the secondary rate limit). The
// re-gate sweep and its Orb-relay retry run every ~2-min tick and drive timely merges/closes, so they stay
// immediate; everything else (the 30-min, hourly, and six-hourly maintenance set) is offset by a stable per-type
// slot. Deterministic (hash of the job type), so a type always lands in the same slot and the enqueued SET is
// unchanged — only the run_after timing is spread, and the per-repo children each parent fans out inherit that
// offset (their own index stagger is relative to when the parent runs). (#1948)
const IMMEDIATE_SCHEDULED_JOB_TYPES = new Set<string>([
  "agent-regate-sweep",
  "retry-orb-relay",
]);

export function scheduledEnqueueDelaySeconds(jobType: string): number {
  if (IMMEDIATE_SCHEDULED_JOB_TYPES.has(jobType)) return 0;
  return Math.floor(
    deterministicJitterMs(jobType, scheduledEnqueueJitterMs()) / 1000,
  );
}

type CoalesceMessage = {
  type?: unknown;
  eventName?: unknown;
  requestedBy?: unknown;
  repoFullName?: unknown;
  prNumber?: unknown;
  attempt?: unknown;
  force?: unknown;
  mode?: unknown;
  segment?: unknown;
  cursor?: unknown;
  login?: unknown;
  day?: unknown;
  days?: unknown;
  dryRun?: unknown;
  variant?: unknown;
  paths?: unknown;
  runId?: unknown;
  deliveryId?: unknown;
  draftId?: unknown;
  event?: { dedupKey?: unknown } | null;
  logins?: unknown;
  payload?: GitHubWebhookPayload | null;
};

function parseCoalesceMessage(payload: string): CoalesceMessage | null {
  try {
    return JSON.parse(payload) as CoalesceMessage;
  } catch {
    return null;
  }
}

function ragIndexFullKey(repo: string): string {
  return keyOf("rag-index-repo", repo, "full");
}

function ragIndexRepoKeyPrefix(repo: string): string {
  return keyOf("rag-index-repo", repo, "");
}

export function jobCoalesceSupersededKeyPrefix(payload: string): string | null {
  const message = parseCoalesceMessage(payload);
  if (message?.type !== "rag-index-repo") return null;
  const repo = normalizedRepo(message.repoFullName);
  if (!repo || normalizedPathScope(message.paths)) return null;
  return ragIndexRepoKeyPrefix(repo);
}

export function jobCoalesceAbsorbedByKey(payload: string): string | null {
  const message = parseCoalesceMessage(payload);
  if (message?.type !== "rag-index-repo") return null;
  const repo = normalizedRepo(message.repoFullName);
  if (!repo || !normalizedPathScope(message.paths)) return null;
  return ragIndexFullKey(repo);
}

export function jobCoalesceKey(payload: string): string | null {
  try {
    const message = parseCoalesceMessage(payload);
    if (!message) return null;
    const type = typeof message.type === "string" ? message.type : "";
    if (type === "agent-regate-pr") {
      const repo = normalizedRepo(message.repoFullName);
      const pr = normalizedNumber(message.prNumber);
      return repo && pr !== null ? `agent-regate-pr:${repo}#${pr}` : null;
    }
    if (type === "agent-regate-sweep") {
      const repo = normalizedRepo(message.repoFullName);
      return `agent-regate-sweep:${repo ?? "all"}`;
    }
    if (type === "recapture-preview") {
      const repo = normalizedRepo(message.repoFullName);
      const pr = normalizedNumber(message.prNumber);
      const attempt = normalizedNumber(message.attempt);
      return repo && pr !== null && attempt !== null
        ? `recapture-preview:${repo}#${pr}:${attempt}`
        : null;
    }
    switch (type) {
      case "refresh-registry":
      case "refresh-installation-health":
      case "refresh-scoring-model":
      case "refresh-upstream-sources":
      case "build-upstream-ruleset":
      case "detect-upstream-drift":
      case "refresh-upstream-drift":
      case "file-upstream-drift-issues":
      case "repair-data-fidelity":
      case "ops-alerts":
      case "selftune":
      case "retry-orb-relay":
        return type;
      case "backfill-registered-repos":
        return keyOf(
          type,
          normalizedRepo(message.repoFullName) ?? "all",
          normalizedEnum(message.mode) ?? "default",
          boolFlag(message.force),
        );
      case "backfill-repo-segment":
        return keyOf(
          type,
          normalizedRepo(message.repoFullName) ?? "unknown",
          normalizedEnum(message.segment) ?? "unknown",
          normalizedEnum(message.mode) ?? "default",
          boolFlag(message.force),
          normalizedCursor(message.cursor) ?? "start",
        );
      case "backfill-pr-details":
        return keyOf(
          type,
          normalizedRepo(message.repoFullName) ?? "unknown",
          normalizedEnum(message.mode) ?? "default",
          normalizedCursor(message.cursor) ?? "start",
        );
      case "generate-signal-snapshots":
      case "build-burden-forecasts":
        return keyOf(type, normalizedRepo(message.repoFullName) ?? "all");
      case "build-contributor-evidence":
      case "build-contributor-decision-packs": {
        const login = normalizedLogin(message.login);
        if (login) return keyOf(type, login);
        // A fanned-out batch (a non-empty `logins` array) keys by its FIRST login: batches are disjoint slices of the
        // derived set, so heads are unique and a duplicate re-enqueue of the same batch still coalesces. A batch must
        // NEVER fall through to the "all" key below — that is the scheduled TRIGGER's slot, so collapsing a batch into
        // it would drop the batch's work — so a batch with no usable head is left uncoalesced (null) instead.
        if (Array.isArray(message.logins) && message.logins.length > 0) {
          const batchHead = normalizedLogin(message.logins[0]);
          return batchHead ? keyOf(type, "batch", batchHead) : null;
        }
        // The scheduled trigger (no login, no batch) coalesces to a single slot.
        return keyOf(type, "all");
      }
      case "refresh-contributor-activity":
        return keyOf(
          type,
          normalizedLogin(message.login) ?? "unknown",
          normalizedRepo(message.repoFullName) ?? "all",
        );
      case "rollup-product-usage":
        return keyOf(
          type,
          normalizedDate(message.day) ?? "latest",
          normalizedCursor(message.days) ?? "default",
        );
      case "prune-retention":
        return keyOf(type, boolFlag(message.dryRun));
      case "generate-weekly-value-report":
        return keyOf(
          type,
          normalizedEnum(message.variant) ?? "operator",
          normalizedCursor(message.days) ?? "default",
        );
      case "rag-index-repo":
        return keyOf(
          type,
          normalizedRepo(message.repoFullName) ?? "all",
          normalizedPathScope(message.paths) ?? "full",
        );
      // Event-driven jobs carry a stable per-invocation id, so coalescing only ever merges a DUPLICATE re-enqueue of
      // the SAME job (e.g. a webhook redelivery / retry) — never two distinct invocations, which have distinct ids.
      // No id (a malformed payload) → null (uncoalesced), never a shared key that could drop a distinct job. (#1942)
      case "run-agent": {
        const runId = normalizedId(message.runId);
        return runId ? keyOf(type, runId) : null;
      }
      case "notify-deliver": {
        const deliveryId = normalizedId(message.deliveryId);
        return deliveryId ? keyOf(type, deliveryId) : null;
      }
      case "notify-evaluate": {
        const dedupKey = normalizedId(message.event?.dedupKey);
        return dedupKey ? keyOf(type, dedupKey) : null;
      }
      case "submit-draft": {
        const draftId = normalizedId(message.draftId);
        return draftId ? keyOf(type, draftId) : null;
      }
    }
    if (type !== "github-webhook") return null;
    const eventName =
      typeof message.eventName === "string" ? message.eventName : "";
    return message.payload
      ? githubWebhookCoalesceKey(eventName, message.payload)
      : null;
  } catch {
    return null;
  }
}

function clampRetryDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return DEFAULT_GITHUB_RATE_LIMIT_RETRY_MS;
  return Math.min(Math.ceil(delayMs), MAX_GITHUB_RATE_LIMIT_RETRY_MS);
}

function queueRateLimitJitterMs(): number {
  return envDurationMs("QUEUE_RATE_LIMIT_JITTER_MS", DEFAULT_RATE_LIMIT_JITTER_MS);
}

function envDurationMs(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

function normalizedRepo(value: unknown): string | null {
  return typeof value === "string" && value.includes("/")
    ? value.trim().toLowerCase()
    : null;
}

function normalizedNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : null;
}

function normalizedLogin(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : null;
}

function normalizedEnum(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : null;
}

function normalizedCursor(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.floor(value));
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// A stable, case-preserving opaque id (runId / deliveryId / draftId / dedupKey) for coalesce keys.
function normalizedId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedDate(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
    ? value.trim()
    : null;
}

function normalizedPathScope(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const paths = [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim()),
    ),
  ].sort();
  if (paths.length === 0) return null;
  return `sha256:${createHash("sha256").update(JSON.stringify(paths)).digest("hex")}`;
}

function boolFlag(value: unknown): string {
  return value === true ? "1" : "0";
}

function keyOf(type: string, ...parts: string[]): string {
  return `${type}:${parts.join(":")}`;
}

function numberHeader(
  headers: Headers | Record<string, unknown> | null,
  key: string,
): number | null {
  const raw = stringHeader(headers, key);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringHeader(
  headers: Headers | Record<string, unknown> | null,
  key: string,
): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    const value = (headers as Headers).get(key);
    return value === null ? null : String(value);
  }
  const value =
    (headers as Record<string, unknown>)[key] ??
    (headers as Record<string, unknown>)[key.toLowerCase()];
  return value == null ? null : String(value);
}
