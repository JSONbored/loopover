// Non-convergence DETECTOR (#4286): a pure classifier over one portfolio-queue item's attempt/outcome
// history. It answers whether that item is making progress, is merely stalled, or is stuck in a
// non-convergent loop (cycling queued → in_progress → queued without ever reaching `done`, per the
// re-enqueue-in-place behaviour at packages/gittensory-miner/lib/portfolio-queue.js:108-115).
//
// DETECTOR ONLY — no enforcement, no write-blocking, no IO, no Date.now(), no randomness. It takes typed
// counts and returns a typed verdict; it gates nothing on its own. The fail-closed Governor chokepoint that
// COMPOSES this signal with rate-limit + budget caps into one allow/deny decision is separate,
// maintainer-owned work tracked in #2340 (milestone 13) — explicitly not this module.
//
// Mirrors the pure-classifier-over-typed-input discipline of ../contributor-fit.ts (typed input in,
// { status, reasons } out, and "absence of history is not evidence of a problem").

export type PortfolioConvergenceStatus = "converging" | "stalled" | "non_convergent";

/** One queue item's attempt/outcome history. Plain counts — the caller already tracks or supplies these;
 *  this module invents no persistence (the queue table carries no attempt-history columns today). */
export type PortfolioConvergenceInput = {
  /** Total attempts made on this item so far. */
  attempts: number;
  /** Consecutive failed attempts since the last improvement (reset to 0 on any progress). */
  consecutiveFailures: number;
  /** Times the item was re-enqueued (queued → in_progress → queued) without ever reaching `done`. */
  reenqueues: number;
  /** Whether the item has ever reached a terminal `done` outcome. */
  reachedDone: boolean;
};

/** Streak lengths at (or above) which a still-unfinished item reads non-convergent. */
export type PortfolioConvergenceThresholds = {
  /** consecutiveFailures ≥ this ⇒ non_convergent. */
  maxConsecutiveFailures: number;
  /** reenqueues (without reaching done) ≥ this ⇒ non_convergent. */
  maxReenqueues: number;
};

/** Conservative defaults — a single failure or re-enqueue never trips these; only a sustained streak does. */
export const DEFAULT_PORTFOLIO_CONVERGENCE_THRESHOLDS: PortfolioConvergenceThresholds = {
  maxConsecutiveFailures: 3,
  maxReenqueues: 3,
};

export type PortfolioConvergenceVerdict = {
  status: PortfolioConvergenceStatus;
  reasons: string[];
};

/**
 * Classify one queue item's convergence from its attempt/outcome counts. Pure and deterministic.
 *
 * - Zero attempts (not yet tried) reads `converging` — a first attempt is not evidence of a stuck loop
 *   (the same non-judgment-on-absence rule ../contributor-fit.ts applies to a first attempt).
 * - An item that has reached `done` is `converging` by definition.
 * - A sustained streak — `consecutiveFailures` or `reenqueues` at/above its threshold — reads
 *   `non_convergent`. A single failure or re-enqueue below threshold reads `stalled`, not non-convergent.
 * - Attempts in progress with no failure streak read `converging`.
 */
export function classifyPortfolioConvergence(
  input: PortfolioConvergenceInput,
  thresholds: PortfolioConvergenceThresholds = DEFAULT_PORTFOLIO_CONVERGENCE_THRESHOLDS,
): PortfolioConvergenceVerdict {
  if (input.attempts <= 0) {
    return {
      status: "converging",
      reasons: ["No attempts yet; a first attempt is not evidence of a stuck loop."],
    };
  }
  if (input.reachedDone) {
    return { status: "converging", reasons: ["Item reached done."] };
  }

  const reasons: string[] = [];
  if (input.consecutiveFailures >= thresholds.maxConsecutiveFailures) {
    reasons.push(
      `${input.consecutiveFailures} consecutive failures (≥ ${thresholds.maxConsecutiveFailures}).`,
    );
  }
  if (input.reenqueues >= thresholds.maxReenqueues) {
    reasons.push(
      `re-enqueued ${input.reenqueues} times without reaching done (≥ ${thresholds.maxReenqueues}).`,
    );
  }
  if (reasons.length > 0) {
    return { status: "non_convergent", reasons };
  }

  if (input.consecutiveFailures > 0 || input.reenqueues > 0) {
    return {
      status: "stalled",
      reasons: [
        `${input.consecutiveFailures} consecutive failure(s), ${input.reenqueues} re-enqueue(s) — below the non-convergence threshold.`,
      ],
    };
  }

  return { status: "converging", reasons: ["Attempts in progress with no failure streak."] };
}
