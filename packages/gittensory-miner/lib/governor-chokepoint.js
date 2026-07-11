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
} from "@jsonbored/gittensory-engine";
import { appendGovernorEvent } from "./governor-ledger.js";

/**
 * Evaluate a write action against the full Governor precedence ladder, persist the resulting ledger event, and
 * advance rate-limit bucket/backoff state when the rate-limit stage actually ran (kill-switch and dry-run
 * short-circuit before rate-limit is evaluated, so bucket state is untouched in those cases).
 *
 * @param {import("@jsonbored/gittensory-engine").GovernorChokepointInput} input
 * @param {{ append?: typeof appendGovernorEvent }} [options]
 * @returns {{
 *   decision: import("@jsonbored/gittensory-engine").GovernorDecision,
 *   recorded: import("./governor-ledger.js").GovernorLedgerEntry,
 *   rateLimitBuckets: import("@jsonbored/gittensory-engine").WriteRateLimitBucketStore,
 *   rateLimitBackoffAttempts: import("@jsonbored/gittensory-engine").WriteRateLimitBackoffStore,
 * }}
 */
export function evaluateGovernorChokepointGate(input, options = {}) {
  const append = options.append ?? appendGovernorEvent;
  const decision = evaluateGovernorChokepoint(input);
  const recorded = append(decision.ledgerEvent);

  let rateLimitBuckets = input.rateLimitBuckets;
  let rateLimitBackoffAttempts = input.rateLimitBackoffAttempts;
  if (decision.detail.rateLimit) {
    if (decision.detail.rateLimit.allowed) {
      rateLimitBuckets = recordWriteRateLimitAllowed(
        input.rateLimitBuckets,
        input.actionClass,
        input.repoFullName,
        input.nowMs,
        input.rateLimitPolicies,
      );
      rateLimitBackoffAttempts = clearWriteRateLimitBackoff(input.rateLimitBackoffAttempts, input.actionClass, input.repoFullName);
    } else {
      rateLimitBackoffAttempts = recordWriteRateLimitDenied(input.rateLimitBackoffAttempts, input.actionClass, input.repoFullName);
    }
  }

  return { decision, recorded, rateLimitBuckets, rateLimitBackoffAttempts };
}
