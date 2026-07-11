// Governor write-rate-limit gate (#2344). Consults global + per-repo buckets before a write action, schedules
// jittered retries on throttle, and records outcomes to the append-only governor ledger.

import {
  buildWriteRateLimitGovernorLedgerEvent,
  clearWriteRateLimitBackoff,
  evaluateWriteRateLimit,
  recordWriteRateLimitAllowed,
  recordWriteRateLimitDenied,
} from "@jsonbored/gittensory-engine";
import { appendGovernorEvent } from "./governor-ledger.js";

/**
 * Evaluate write-rate limits for a governor write action and persist the decision.
 *
 * @param {object} input
 * @param {string} input.actionClass governor write class (e.g. open_pr, comment)
 * @param {string} input.repoFullName target repo
 * @param {import("@jsonbored/gittensory-engine").WriteRateLimitBucketStore} input.buckets
 * @param {import("@jsonbored/gittensory-engine").WriteRateLimitBackoffStore} input.backoffAttempts
 * @param {number} input.nowMs clock reading in epoch ms
 * @param {import("@jsonbored/gittensory-engine").WriteRateLimitPolicies} [input.policies]
 * @param {() => number} [input.randomFn] injected jitter source (defaults to mid-band draw)
 * @param {{ append?: typeof appendGovernorEvent }} [options]
 */
export function evaluateWriteRateLimitGate(input, options = {}) {
  const append = options.append ?? appendGovernorEvent;
  const verdict = evaluateWriteRateLimit(input);
  const recorded = append(
    buildWriteRateLimitGovernorLedgerEvent(input.repoFullName, input.actionClass, verdict),
  );

  if (verdict.allowed) {
    return {
      verdict,
      recorded,
      buckets: recordWriteRateLimitAllowed(
        input.buckets,
        input.actionClass,
        input.repoFullName,
        input.nowMs,
        input.policies,
      ),
      backoffAttempts: clearWriteRateLimitBackoff(
        input.backoffAttempts,
        input.actionClass,
        input.repoFullName,
      ),
      retryAtMs: null,
    };
  }

  return {
    verdict,
    recorded,
    buckets: input.buckets,
    backoffAttempts: recordWriteRateLimitDenied(
      input.backoffAttempts,
      input.actionClass,
      input.repoFullName,
    ),
    retryAtMs: input.nowMs + verdict.retryAfterMs,
  };
}
