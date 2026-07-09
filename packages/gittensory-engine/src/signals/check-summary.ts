import type { CheckSummaryRecord } from "../scoring/types.js";

/** Conclusion/status values that mark a single cached check as failing or attention-needing. */
const FAILING_CHECK_STATES = ["failure", "failed", "timed_out", "cancelled", "action_required", "startup_failure"];

/**
 * Canonical "is this ONE cached check failing?" predicate, shared so every surface (readiness, the maintainer
 * queue digest, reward-risk reviewability) classifies a check identically. A cached check may carry its outcome
 * on `conclusion` (check runs) OR only on `status` (commit-status rows and runs that errored before concluding),
 * so fall back to `status` when `conclusion` is absent, and case-fold both — GitHub conclusions are lowercase,
 * but cached/commit statuses are not guaranteed to be.
 */
export function isFailingCheckSummary(check: CheckSummaryRecord): boolean {
  return FAILING_CHECK_STATES.includes((check.conclusion ?? check.status).toLowerCase());
}
