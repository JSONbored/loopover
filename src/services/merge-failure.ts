import { errorMessage } from "../utils/json";

// RC3 terminal-fail merges. A merge mutation that fails for one of these reasons can NEVER complete for the
// current commit, so retrying it every sweep is pointless and noisy — classify it once and let the executor
// mark the PR terminally merge-blocked (held for a human) instead of looping forever.
//
//   • 403 Resource not accessible by integration → the App lacks pull_requests:write / the branch is
//     protected against the App. A human must re-consent or merge.
//   • 405 Method Not Allowed → merge not allowed (e.g. required reviews/checks policy forbids an App merge).
//   • 409 Conflict → a required status check is absent / head moved into a non-mergeable state.
//   • merge-conflict text → the branch genuinely conflicts with base; only the contributor can resolve it.
//
// A failure that matches none of these is treated as POSSIBLY transient (e.g. "Base branch was modified" — a
// benign TOCTOU race that a re-attempt against the new base resolves), so the executor retries it up to
// MERGE_RETRY_CAP before escalating to the same terminal hold.
export const MERGE_RETRY_CAP = 5;

const TERMINAL_MERGE_STATUSES = new Set([403, 405, 409]);

/** True when the merge error TEXT describes a real content conflict (vs a behind-but-clean branch). */
function isMergeConflictMessage(message: string): boolean {
  return /merge conflict|not mergeable|cannot be merged|has conflicts|conflicts? with the base/i.test(message);
}

/** True for the transient "Base branch was modified. Review and try the merge again." 405 — a benign
 *  TOCTOU race (the base advanced between plan and merge) that a re-attempt against the new base resolves. */
function isBaseBranchMovedMessage(message: string): boolean {
  return /base branch was modified/i.test(message);
}

/** Read the HTTP status off an Octokit RequestError (it sets `.status`); undefined for non-HTTP errors. */
function httpStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

/** Classify a failed merge. `terminal: true` → never re-plan this merge for the current commit (hold for a
 *  human). `terminal: false` → possibly transient; the caller retries up to MERGE_RETRY_CAP. `reason` is a
 *  short human-readable summary persisted on the PR + audit record. */
export function classifyMergeFailure(error: unknown): { terminal: boolean; reason: string } {
  const message = errorMessage(error);
  const status = httpStatus(error);
  if (status === 403) return { terminal: true, reason: `merge forbidden (403 — pull_requests:write or branch protection): ${message}` };
  // A 405 "Base branch was modified" is a benign TOCTOU race, not a policy rejection — retry against the new base
  // (the executor caps retries at MERGE_RETRY_CAP before escalating to the same terminal hold).
  if (status === 405 && isBaseBranchMovedMessage(message)) return { terminal: false, reason: `base branch moved during merge — retrying: ${message}` };
  if (status === 405) return { terminal: true, reason: `merge not allowed (405 — repo merge policy forbids an automated merge): ${message}` };
  if (status === 409) return { terminal: true, reason: `merge conflict / required check absent (409): ${message}` };
  if (status !== undefined && TERMINAL_MERGE_STATUSES.has(status)) return { terminal: true, reason: `merge rejected (${status}): ${message}` };
  if (isMergeConflictMessage(message)) return { terminal: true, reason: `branch conflicts with base — contributor must rebase: ${message}` };
  return { terminal: false, reason: message };
}
