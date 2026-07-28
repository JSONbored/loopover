const DEFAULT_RETRY_AFTER_MS = 5 * 60 * 1000;
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

function clampRetryAfterMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(
    MAX_RETRY_AFTER_MS,
    Math.max(MIN_RETRY_AFTER_MS, Math.round(value)),
  );
}

export class RetryableJobError extends Error {
  readonly retryAfterMs: number;
  readonly retryKind: string;

  constructor(
    message: string,
    opts: { retryAfterMs?: number | undefined; retryKind: string },
  ) {
    super(message);
    this.name = "RetryableJobError";
    this.retryAfterMs = clampRetryAfterMs(
      opts.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
    );
    this.retryKind = opts.retryKind;
  }
}

export function isRetryableJobError(
  error: unknown,
): error is RetryableJobError {
  return error instanceof RetryableJobError;
}

export function retryableJobDelayMs(error: unknown): number | null {
  if (!isRetryableJobError(error)) return null;
  return error.retryAfterMs;
}

/** Retry kinds that must NOT consume the job's attempt budget (#9465). */
const ATTEMPT_FREE_RETRY_KINDS = new Set(["pr_actuation_lock_contended"]);

/**
 * #9465: is this error a "come back in a moment" condition rather than a failure?
 *
 * Lock contention was charged an attempt like any other error, so with a flat 5s retry and maxRetries 5 a job
 * DIED after roughly 25 seconds of contention -- while the lock it was waiting on is designed to be held for
 * minutes (PR_ACTUATION_LOCK_TTL_SECONDS is 600, and the section it guards spans an entire publish -> AI review
 * -> maintain pass). Confirmed in production: the only jobs in the dead-letter queue over a 7-day window were
 * three actuation-lock contentions, one of which was a `reopen-reclose` -- a policy enforcement with a single
 * webhook-gated trigger and no reconciler, so that enforcement was lost outright.
 *
 * The queue already models this correctly for the other "not our turn yet" condition: a GitHub rate-limit
 * failure re-pends WITHOUT incrementing attempts (`deferred_by='rate_limit'`). This extends the same treatment
 * to lock contention, bounded by {@link ATTEMPT_FREE_RETRY_DEADLINE_MS} so a genuinely wedged lock still
 * surfaces as a dead job rather than looping forever.
 */
export function isAttemptFreeRetry(error: unknown): boolean {
  return isRetryableJobError(error) && ATTEMPT_FREE_RETRY_KINDS.has(error.retryKind);
}

/** How long a job may keep deferring attempt-free before it starts consuming its budget again. Comfortably
 *  exceeds the 600s actuation-lock TTL, so a holder that runs to its full TTL never kills a waiter, while a
 *  lock that is somehow never released still converges to a dead job an operator can see. */
export const ATTEMPT_FREE_RETRY_DEADLINE_MS = 15 * 60 * 1000;
