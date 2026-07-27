import { errorMessage } from "../utils/json";

// RC3 terminal-fail merges. A merge mutation that fails for one of these reasons can NEVER complete for the
// current commit, so retrying it every sweep is pointless and noisy — classify it once and let the executor
// mark the PR terminally merge-blocked (held for a human) instead of looping forever.
//
//   • 401 Bad credentials → the installation token was rejected: the App was suspended or its private key was
//     rotated mid-flight. withInstallationTokenRetry (src/github/app.ts) already evicts-and-retries ONCE on a
//     401 inside the merge call itself, so a 401 reaching HERE means that retry also failed — a genuinely,
//     persistently unauthorized installation, not a one-off stale-token race. Burning the full MERGE_RETRY_CAP
//     against the same known-bad credential wastes calls for nothing; fail fast instead (#2264).
//   • 403 Resource not accessible by integration → GitHub returned a generic branch-protection / ruleset /
//     installation-visibility rejection. The executor already checked the concrete App permissions before the
//     merge call, so this is retryable first: required checks, conversation resolution, and permission snapshots
//     can converge shortly after the review/check publication boundary.
//   • 405 Method Not Allowed → merge not allowed (e.g. required reviews/checks policy forbids an App merge).
//   • 409 Conflict → a required status check is absent / head moved into a non-mergeable state.
//   • merge-conflict text → the branch genuinely conflicts with base; only the contributor can resolve it.
//
// A failure that matches none of these is treated as POSSIBLY transient (e.g. "Base branch was modified" — a
// benign TOCTOU race that a re-attempt against the new base resolves), so the executor retries it up to
// MERGE_RETRY_CAP before escalating to the same terminal hold.
export const MERGE_RETRY_CAP = 5;

/** True when the merge error TEXT describes a real content conflict (vs a behind-but-clean branch). Exported
 *  for reuse by the update_branch action class (LOOPOVER-24): update-branch performs a real merge internally,
 *  so it fails with this SAME message shape, and the classification is identical -- the branch owner, not the
 *  bot, must resolve it. */
export function isMergeConflictMessage(message: string): boolean {
  return /merge conflict|not mergeable|cannot be merged|has conflicts|conflicts? with the base/i.test(message);
}

/** True for the 422 "There are no new commits on the base branch." update-branch rejection (LOOPOVER-24,
 *  regressed shape): the readiness check saw mergeable_state "behind" but the head already contained every
 *  base commit by the time update-branch fired -- a stale-mergeable-state race, not a failure. The PR is in
 *  exactly the state update_branch exists to reach, so the executor treats it as benign (audit-only, no
 *  Sentry capture), same as {@link isMergeConflictMessage}'s update_branch carve-out. */
export function isNoNewBaseCommitsMessage(message: string): boolean {
  return /no new commits on the base branch/i.test(message);
}

/** True for the transient "Base branch was modified. Review and try the merge again." 405 — a benign
 *  TOCTOU race (the base advanced between plan and merge) that a re-attempt against the new base resolves. */
function isBaseBranchMovedMessage(message: string): boolean {
  return /base branch was modified/i.test(message);
}

/** True for the transient "Merge already in progress" 405 (GITTENSORY-1K) — another merge request for the
 *  SAME PR (a manual click, a concurrent duplicate job) is already being processed by GitHub. Not a policy
 *  rejection: the in-flight merge either lands (making this retry a no-op once the PR is no longer open) or
 *  fails (making a retry the right move), so it resolves the same way isBaseBranchMovedMessage's TOCTOU race
 *  does — re-attempt rather than hold. */
function isMergeAlreadyInProgressMessage(message: string): boolean {
  return /merge already in progress/i.test(message);
}

function isConvergenceForbiddenMessage(message: string): boolean {
  return /resource not accessible by integration|secondary rate limit|api rate limit|abuse detection/i.test(message);
}

/** Read the HTTP status off an Octokit RequestError (it sets `.status`); undefined for non-HTTP errors. */
function httpStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * How long a merge held for an `infra`-scoped cause stays suppressed before the planner is allowed to try the
 * merge again for the SAME commit (#9012). Long enough that a re-probe cannot hot-loop against a still-broken
 * installation (each expiry costs at most one merge call per PR per window), short enough that a token rotation
 * or a secondary-rate-limit window does not strand a green, approved PR for the rest of its life.
 */
export const INFRA_MERGE_BLOCK_TTL_MS = 30 * 60 * 1000;

/**
 * Which *thing* a terminal merge failure is terminal ABOUT (#9012).
 *
 *   • `"commit"` — the failure is a property of this commit and only a new commit can change it: a real base
 *     conflict, a repo merge policy that forbids an App merge, an absent required check. Re-probing cannot
 *     help, so the block persists until the head advances. This is the pre-#9012 behavior for every class.
 *   • `"infra"` — the failure is a property of the INSTALLATION or of GitHub's current state, not of the code:
 *     a rejected token (App suspended, key rotated) or an exhausted secondary-rate-limit window. These are
 *     fleet-wide and self-healing — every in-flight merge fails at once and every one of them recovers at once.
 *     Persisting a head-scoped block for such a cause strands green, approved PRs permanently, since the only
 *     documented escape is a contributor pushing a commit they have no reason to push. So an infra block gets
 *     an expiry (INFRA_MERGE_BLOCK_TTL_MS) instead: still terminal for THIS pass — no hot-looping against a
 *     known-bad credential, which is the whole point of failing fast on a 401 — but re-probed once the window
 *     passes, so recovery is autonomous.
 */
export type MergeFailureScope = "commit" | "infra";

/** Classify a failed merge. `terminal: true` → do not re-plan this merge now (hold for a human, subject to
 *  `scope`). `terminal: false` → possibly transient; the caller retries up to MERGE_RETRY_CAP. `reason` is a
 *  short human-readable summary persisted on the PR + audit record. `scope` says whether a terminal block is
 *  commit-scoped (clears only on a new commit) or infra-scoped (also clears on a TTL re-probe) — see
 *  MergeFailureScope. It is meaningful on the non-terminal classes too: the executor carries it through the
 *  retry-cap exhaustion path, so a sustained rate-limit window that burns MERGE_RETRY_CAP still recovers on
 *  its own rather than terminally stranding everything that passed through it. */
export function classifyMergeFailure(error: unknown): { terminal: boolean; reason: string; scope: MergeFailureScope } {
  const message = errorMessage(error);
  const status = httpStatus(error);
  if (status === 401) return { terminal: true, scope: "infra", reason: `installation token rejected: App suspended or key rotated (401): ${message}` };
  if (status === 403 && isConvergenceForbiddenMessage(message))
    return { terminal: false, scope: "infra", reason: `merge forbidden for now (403 — branch protection or GitHub permission visibility may still be converging): ${message}` };
  if (status === 403) return { terminal: true, scope: "commit", reason: `merge forbidden (403): ${message}` };
  // A 405 "Base branch was modified" is a benign TOCTOU race, not a policy rejection — retry against the new base
  // (the executor caps retries at MERGE_RETRY_CAP before escalating to the same terminal hold).
  if (status === 405 && isBaseBranchMovedMessage(message)) return { terminal: false, scope: "commit", reason: `base branch moved during merge — retrying: ${message}` };
  if (status === 405 && isMergeAlreadyInProgressMessage(message)) return { terminal: false, scope: "commit", reason: `a merge for this PR was already in progress — retrying: ${message}` };
  if (status === 405) return { terminal: true, scope: "commit", reason: `merge not allowed (405 — repo merge policy forbids an automated merge): ${message}` };
  if (status === 409) return { terminal: true, scope: "commit", reason: `merge conflict / required check absent (409): ${message}` };
  if (isMergeConflictMessage(message)) return { terminal: true, scope: "commit", reason: `branch conflicts with base — contributor must rebase: ${message}` };
  return { terminal: false, scope: "commit", reason: message };
}

/** Whether a persisted merge block still suppresses the `merge` disposition, given the live head and clock
 *  (#9012). Pure, so the planner stays clock-free: the caller resolves this and passes through only a block
 *  that is still in effect. A block with no expiry is commit-scoped and lasts until the head advances; one with
 *  an expiry is infra-scoped and additionally lapses at that instant. An unparseable expiry is treated as
 *  expired: a malformed timestamp must not be the thing that strands a green PR forever, which is the exact
 *  failure this fix exists to remove. */
export function isMergeBlockInEffect(
  block: { mergeBlockedSha?: string | null | undefined; mergeBlockedUntil?: string | null | undefined },
  headSha: string | null | undefined,
  nowMs: number,
): boolean {
  if (block.mergeBlockedSha == null || headSha == null || block.mergeBlockedSha !== headSha) return false;
  if (block.mergeBlockedUntil == null) return true;
  const expiry = Date.parse(block.mergeBlockedUntil);
  return Number.isFinite(expiry) && nowMs < expiry;
}

/** The merge-block head SHA the planner should see: the stored one while the block is still in effect, else
 *  `null` (#9012). The planner compares this to the live head and is deliberately clock-free, so resolving the
 *  infra-scoped expiry has to happen out here, on the way in. Returning `null` rather than omitting the field
 *  matches how an unblocked PR already looks to the planner, so a lapsed block is indistinguishable from never
 *  having been blocked — which is exactly the intent: re-probe it like any other mergeable PR. */
export function activeMergeBlockedSha(
  block: { mergeBlockedSha?: string | null | undefined; mergeBlockedUntil?: string | null | undefined },
  headSha: string | null | undefined,
  nowMs: number,
): string | null {
  // Normalized before the check, not inside the true arm: an absent block is `undefined` on the record but
  // `null` on the wire the planner reads, and folding that in here keeps this a total function over both.
  const blockedSha = block.mergeBlockedSha ?? null;
  return isMergeBlockInEffect(block, headSha, nowMs) ? blockedSha : null;
}
