import type { ReviewCheckMode } from "../types";

export const GITTENSORY_CONTEXT_CHECK_NAME = "Gittensory Context";
export const GITTENSORY_GATE_CHECK_NAME = "Gittensory Orb Review Agent";
/** Pre-rename check-run name ("Gittensory Gate"). NOT dead code: any self-hosted repo that still has an
 *  old-named check-run stuck pending from before the rename (e.g. a self-hoster who upgrades mid-flight,
 *  or a check-run left open across a deploy) would otherwise show a permanently-pending, never-completed
 *  status on GitHub. `finalizeLegacyPendingCheckRuns` in src/github/app.ts uses this name to find and
 *  complete (neutral, "superseded") any such stale legacy-named run once the new-named one finishes. Keep
 *  this until self-hosters can no longer be upgrading across the rename boundary. */
export const GITTENSORY_LEGACY_GATE_CHECK_NAME = "Gittensory Gate";

/** Single point of truth for whether `reviewCheckMode` publishes the Gittensory Orb Review Agent check-run
 *  (#2852). `required` and `visible` both publish -- they are identical on the API-call side; the distinction
 *  is purely about how the operator should configure GitHub branch protection (visible = never required). Only
 *  `disabled` skips the check-run create/update calls entirely. */
export function shouldPublishReviewCheck(reviewCheckMode: ReviewCheckMode): boolean {
  return reviewCheckMode !== "disabled";
}
