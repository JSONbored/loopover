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
