// Governor write-rate-limit enforcement (#2344): composes the pure `evaluateLocalRateLimit` calculator with
// global + per-repo buckets and jittered retry scheduling for the local Governor chokepoint. Maintains bucket
// math only — callers own persistence/scheduling; this module returns updated in-memory state snapshots.

import type { GovernorLedgerEvent } from "../governor-ledger.js";
import {
  evaluateLocalRateLimit,
  jitteredBackoffMs,
  type LocalRateBucket,
  type LocalRateLimitConfig,
  type LocalRateLimitDecision,
} from "./rate-limit.js";

/** Conservative jitter base when a write is over-limit (not hard-coded at call sites). */
export const DEFAULT_WRITE_RATE_LIMIT_BACKOFF_BASE_MS = 1_000;

const PERMISSIVE_CONFIG: Readonly<LocalRateLimitConfig> = Object.freeze({
  limit: 1_000_000,
  windowMs: 60_000,
});

export type WriteRateLimitPolicies = {
  /** Per actionClass global ceiling across all repos. */
  global: Readonly<Record<string, LocalRateLimitConfig>>;
  /** Per actionClass per-repo ceiling. */
  perRepo: Readonly<Record<string, LocalRateLimitConfig>>;
  /** Jitter backoff base when a write is rate-limited. */
  backoffBaseMs: number;
};

export const DEFAULT_WRITE_RATE_LIMIT_POLICIES: Readonly<WriteRateLimitPolicies> = Object.freeze({
  global: Object.freeze({
    open_pr: Object.freeze({ limit: 30, windowMs: 60_000 }),
    comment: Object.freeze({ limit: 60, windowMs: 60_000 }),
  }),
  perRepo: Object.freeze({
    open_pr: Object.freeze({ limit: 3, windowMs: 60_000 }),
    comment: Object.freeze({ limit: 10, windowMs: 60_000 }),
  }),
  backoffBaseMs: DEFAULT_WRITE_RATE_LIMIT_BACKOFF_BASE_MS,
});

export type WriteRateLimitBucketStore = {
  global: Record<string, LocalRateBucket>;
  perRepo: Record<string, LocalRateBucket>;
};

/** Burst-attempt counter keyed by `${actionClass}:${repo}` for jittered backoff growth. */
export type WriteRateLimitBackoffStore = Record<string, number>;

export type WriteRateLimitBlockedBy = "global" | "per_repo";

export type WriteRateLimitVerdict = {
  allowed: boolean;
  blockedBy: WriteRateLimitBlockedBy | null;
  global: LocalRateLimitDecision;
  perRepo: LocalRateLimitDecision;
  /** When blocked: milliseconds until the caller should retry (window wait ∪ jittered backoff). */
  retryAfterMs: number;
  backoffAttempt: number;
  reason: string;
};

export function writeRateLimitRepoKey(actionClass: string, repoFullName: string): string {
  return `${actionClass.trim()}:${repoFullName.trim().toLowerCase()}`;
}

function policyFor(
  policies: WriteRateLimitPolicies,
  actionClass: string,
  scope: "global" | "perRepo",
): LocalRateLimitConfig {
  const table = scope === "global" ? policies.global : policies.perRepo;
  return table[actionClass] ?? PERMISSIVE_CONFIG;
}

function emptyBucket(nowMs: number): LocalRateBucket {
  return { count: 0, windowStartMs: nowMs };
}

function incrementBucket(
  bucket: LocalRateBucket,
  config: LocalRateLimitConfig,
  nowMs: number,
): LocalRateBucket {
  const windowMs = Number.isFinite(config.windowMs) ? Math.max(0, Math.floor(config.windowMs)) : 0;
  const windowStartMs = Number.isFinite(bucket.windowStartMs) ? bucket.windowStartMs : nowMs;
  const windowElapsed = nowMs - windowStartMs >= windowMs;
  const effectiveCount = windowElapsed ? 0 : Math.max(0, Math.floor(bucket.count));
  return {
    count: effectiveCount + 1,
    windowStartMs: windowElapsed ? nowMs : windowStartMs,
  };
}

/**
 * Consult global and per-repo rolling-window buckets before a governor write. Both must permit the event;
 * a repo under its own limit can still be blocked by the global ceiling.
 */
export function evaluateWriteRateLimit(input: {
  actionClass: string;
  repoFullName: string;
  buckets: WriteRateLimitBucketStore;
  backoffAttempts: WriteRateLimitBackoffStore;
  policies?: WriteRateLimitPolicies;
  nowMs: number;
  randomFn?: () => number;
}): WriteRateLimitVerdict {
  const policies = input.policies ?? DEFAULT_WRITE_RATE_LIMIT_POLICIES;
  const randomFn = input.randomFn ?? (() => 0.5);
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : 0;
  const repoKey = writeRateLimitRepoKey(input.actionClass, input.repoFullName);
  const backoffAttempt = input.backoffAttempts[repoKey] ?? 0;

  const globalBucket = input.buckets.global[input.actionClass] ?? emptyBucket(nowMs);
  const perRepoBucket = input.buckets.perRepo[repoKey] ?? emptyBucket(nowMs);
  const globalConfig = policyFor(policies, input.actionClass, "global");
  const perRepoConfig = policyFor(policies, input.actionClass, "perRepo");

  const global = evaluateLocalRateLimit(globalBucket, globalConfig, nowMs);
  const perRepo = evaluateLocalRateLimit(perRepoBucket, perRepoConfig, nowMs);

  if (global.allowed && perRepo.allowed) {
    return {
      allowed: true,
      blockedBy: null,
      global,
      perRepo,
      retryAfterMs: 0,
      backoffAttempt,
      reason: "under_limit",
    };
  }

  const blockedBy: WriteRateLimitBlockedBy = global.allowed ? "per_repo" : "global";
  const windowWait = Math.max(global.retryAfterMs, perRepo.retryAfterMs);
  const jitterWait = jitteredBackoffMs(policies.backoffBaseMs, backoffAttempt, randomFn);
  return {
    allowed: false,
    blockedBy,
    global,
    perRepo,
    retryAfterMs: Math.max(windowWait, jitterWait),
    backoffAttempt,
    reason: blockedBy === "global" ? "global_rate_limit" : "per_repo_rate_limit",
  };
}

/** Record a permitted write against both bucket scopes. */
export function recordWriteRateLimitAllowed(
  buckets: WriteRateLimitBucketStore,
  actionClass: string,
  repoFullName: string,
  nowMs: number,
  policies: WriteRateLimitPolicies = DEFAULT_WRITE_RATE_LIMIT_POLICIES,
): WriteRateLimitBucketStore {
  const repoKey = writeRateLimitRepoKey(actionClass, repoFullName);
  const globalConfig = policyFor(policies, actionClass, "global");
  const perRepoConfig = policyFor(policies, actionClass, "perRepo");
  const globalBucket = buckets.global[actionClass] ?? emptyBucket(nowMs);
  const perRepoBucket = buckets.perRepo[repoKey] ?? emptyBucket(nowMs);
  return {
    global: {
      ...buckets.global,
      [actionClass]: incrementBucket(globalBucket, globalConfig, nowMs),
    },
    perRepo: {
      ...buckets.perRepo,
      [repoKey]: incrementBucket(perRepoBucket, perRepoConfig, nowMs),
    },
  };
}

/** Bump the jitter backoff attempt after a throttled write (does not mutate rate buckets). */
export function recordWriteRateLimitDenied(
  backoffAttempts: WriteRateLimitBackoffStore,
  actionClass: string,
  repoFullName: string,
): WriteRateLimitBackoffStore {
  const key = writeRateLimitRepoKey(actionClass, repoFullName);
  return { ...backoffAttempts, [key]: (backoffAttempts[key] ?? 0) + 1 };
}

/** Clear backoff attempts after a successful write. */
export function clearWriteRateLimitBackoff(
  backoffAttempts: WriteRateLimitBackoffStore,
  actionClass: string,
  repoFullName: string,
): WriteRateLimitBackoffStore {
  const key = writeRateLimitRepoKey(actionClass, repoFullName);
  if (!(key in backoffAttempts)) return backoffAttempts;
  const next = { ...backoffAttempts };
  delete next[key];
  return next;
}

/** Governor-ledger row for a write-rate-limit decision (#2344 deliverable). */
export function buildWriteRateLimitGovernorLedgerEvent(
  repoFullName: string,
  actionClass: string,
  verdict: WriteRateLimitVerdict,
): GovernorLedgerEvent {
  return {
    eventType: verdict.allowed ? "allowed" : "throttled",
    repoFullName,
    actionClass,
    decision: verdict.allowed ? "allow" : "throttle",
    reason: verdict.reason,
    payload: verdict.allowed
      ? {}
      : {
          blockedBy: verdict.blockedBy,
          retryAfterMs: verdict.retryAfterMs,
          backoffAttempt: verdict.backoffAttempt,
          globalResetAtMs: verdict.global.resetAtMs,
          perRepoResetAtMs: verdict.perRepo.resetAtMs,
        },
  };
}
