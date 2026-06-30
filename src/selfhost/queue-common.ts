import { retryableJobDelayMs } from "../queue/retryable";
import {
  LOW_REST_RATE_LIMIT_REMAINING,
  MAINTENANCE_RESERVED_HEADROOM,
} from "../github/rate-limit";
import {
  githubRateLimitAdmissionKeyForInstallation,
  latestGitHubRestRateLimitObservation,
  type GitHubRateLimitAdmissionKey,
} from "../github/client";
import { githubWebhookCoalesceKey } from "../github/webhook-coalesce";
import type { GitHubWebhookPayload, JobMessage } from "../types";
import { extractPayloadType } from "./audit";

const DEFAULT_RATE_LIMIT_JITTER_MS = 5 * 60_000;
const DEFAULT_STARTUP_JITTER_MS = 3 * 60_000;
const DEFAULT_RECOVERY_JITTER_MS = 60_000;
const DEFAULT_STARTUP_JITTER_MIN_JOBS = 8;
const DEFAULT_PROCESSING_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_BACKGROUND_CONCURRENCY = 1;
export const FOREGROUND_QUEUE_PRIORITY_FLOOR = 8;

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
  if (!exact) return true;
  const fallbackMs = observationMs(fallback);
  const exactMs = observationMs(exact);
  if (fallbackMs === null) return false;
  return exactMs === null || fallbackMs > exactMs;
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

export type GitHubRateLimitKeyScope = "installation" | "global" | "other";
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
  if (!admissionKey) return "global";
  return admissionKey.startsWith("installation:") ? "installation" : "other";
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
  return {
    kind: "background",
    admissionKey: githubRateLimitAdmissionKeyForJob(message),
  };
}

export function matchesGitHubRateLimitAdmissionTarget(
  candidate: GitHubRateLimitAdmissionTarget | null,
  blocked: GitHubRateLimitAdmissionTarget,
): boolean {
  if (candidate === null) return false;
  // Null-key GitHub jobs are legacy/unknown actor work; park them with a depleted known bucket,
  // and park all GitHub-budget work when the depleted bucket itself is unknown.
  if (blocked.admissionKey === null) return true;
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

export function jobCoalesceKey(payload: string): string | null {
  try {
    const message = JSON.parse(payload) as {
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
      payload?: GitHubWebhookPayload | null;
    };
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
      case "build-contributor-decision-packs":
        return keyOf(type, normalizedLogin(message.login) ?? "all");
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
  return paths.length > 0 ? JSON.stringify(paths) : null;
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
