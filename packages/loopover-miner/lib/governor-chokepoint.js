// The Governor chokepoint gate (#2340). Wraps the pure `evaluateGovernorChokepoint` engine decision with the
// two stateful side effects every caller needs: persisting the resulting ledger event, and (only when the
// rate-limit stage actually ran) advancing/backing-off the rate-limit bucket state. This is the ONLY sanctioned
// call site a real write action (open_pr, file_issue, apply_labels, post_eligibility_comment, create_branch,
// delete_branch, generate_tests) should be gated through.

import {
  clearWriteRateLimitBackoff,
  evaluateGovernorChokepoint,
  recordWriteRateLimitAllowed,
  recordWriteRateLimitDenied,
} from "@loopover/engine";
import { appendGovernorEvent } from "./governor-ledger.js";

/**
 * Evaluate a write action against the full Governor precedence ladder, persist the resulting ledger event, and
 * advance rate-limit bucket/backoff state only for the two outcomes that actually consumed (or were denied at)
 * the rate-limit stage: a final `"allow"` verdict advances the bucket, and a `"rate_limit"`-stage denial bumps
 * backoff. Every other stage -- kill-switch, dry-run, budget-cap, non-convergence, reputation-throttle,
 * self-plagiarism, internal_error -- denies for a reason unrelated to rate limiting and must leave bucket/backoff
 * state untouched, since no real write happened and the rate-limit stage's own "allowed" sub-verdict (still
 * present in `decision.detail.rateLimit` once that stage has cleared) does not mean the action was ultimately
 * allowed.
 *
 * @param {import("@loopover/engine").GovernorChokepointInput} input
 * @param {{ append?: typeof appendGovernorEvent }} [options]
 * @returns {{
 *   decision: import("@loopover/engine").GovernorDecision,
 *   recorded: import("./governor-ledger.js").GovernorLedgerEntry,
 *   rateLimitBuckets: import("@loopover/engine").WriteRateLimitBucketStore,
 *   rateLimitBackoffAttempts: import("@loopover/engine").WriteRateLimitBackoffStore,
 * }}
 */
export function evaluateGovernorChokepointGate(input, options = {}) {
  const append = options.append ?? appendGovernorEvent;
  const decision = evaluateGovernorChokepoint(input);
  const recorded = append(decision.ledgerEvent);

  let rateLimitBuckets = input.rateLimitBuckets;
  let rateLimitBackoffAttempts = input.rateLimitBackoffAttempts;
  if (decision.stage === "allow") {
    rateLimitBuckets = recordWriteRateLimitAllowed(
      input.rateLimitBuckets,
      input.actionClass,
      input.repoFullName,
      input.nowMs,
      input.rateLimitPolicies,
    );
    rateLimitBackoffAttempts = clearWriteRateLimitBackoff(input.rateLimitBackoffAttempts, input.actionClass, input.repoFullName);
  } else if (decision.stage === "rate_limit") {
    rateLimitBackoffAttempts = recordWriteRateLimitDenied(input.rateLimitBackoffAttempts, input.actionClass, input.repoFullName);
  }

  return { decision, recorded, rateLimitBuckets, rateLimitBackoffAttempts };
}
