import type { GovernorChokepointInput, GovernorDecision, WriteRateLimitBackoffStore, WriteRateLimitBucketStore } from "@loopover/engine";
import type { AppendGovernorEventInput, GovernorLedgerEntry } from "./governor-ledger.js";
export type EvaluateGovernorChokepointGateResult = {
    decision: GovernorDecision;
    recorded: GovernorLedgerEntry;
    rateLimitBuckets: WriteRateLimitBucketStore;
    rateLimitBackoffAttempts: WriteRateLimitBackoffStore;
};
/**
 * Evaluate a write action against the full Governor precedence ladder, persist the resulting ledger event, and
 * advance rate-limit bucket/backoff state only for the two outcomes that actually consumed (or were denied at)
 * the rate-limit stage: a final `"allow"` verdict advances the bucket, and a `"rate_limit"`-stage denial bumps
 * backoff. Every other stage -- kill-switch, dry-run, budget-cap, non-convergence, reputation-throttle,
 * self-plagiarism, internal_error -- denies for a reason unrelated to rate limiting and must leave bucket/backoff
 * state untouched, since no real write happened and the rate-limit stage's own "allowed" sub-verdict (still
 * present in `decision.detail.rateLimit` once that stage has cleared) does not mean the action was ultimately
 * allowed.
 */
export declare function evaluateGovernorChokepointGate(input: GovernorChokepointInput, options?: {
    append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry;
}): EvaluateGovernorChokepointGateResult;
