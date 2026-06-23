// Convergence (visual capture) feature flag + per-repo gate wiring.
//
// Single env switch: GITTENSORY_REVIEW_SCREENSHOTS. Default OFF (unset/"false") — when OFF the processor
// never calls buildCapture, so the review path is byte-identical to today. Truthy follows the codebase
// convention (`/^(1|true|yes|on)$/i`, same as isSafetyEnabled / isUnifiedReviewCommentEnabled).
//
// As with every other per-PR converged feature, capture runs on a given PR's repo ONLY IF the global flag is
// ON *AND* the repo is in the per-repo cutover allowlist (GITTENSORY_REVIEW_REPOS). The AND with
// isConvergenceRepoAllowed is MANDATORY — it lets the cutover roll forward/back one repo at a time and keeps
// a globally-on-but-not-listed deploy dormant.

import { isConvergenceRepoAllowed } from "./cutover-gate";

/** True when the visual-capture global flag is enabled. Flag-OFF (default) → no capture is attempted. */
export function isScreenshotsEnabled(env: { GITTENSORY_REVIEW_SCREENSHOTS?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_SCREENSHOTS ?? "");
}

/**
 * True when visual capture is allowed for `repoFullName`: the global flag is ON *AND* the repo is in the
 * per-repo cutover allowlist. Both must hold — a globally-on flag alone never activates capture for an
 * unlisted repo (the dormant default).
 */
export function screenshotsAllowed(
  env: { GITTENSORY_REVIEW_SCREENSHOTS?: string | undefined; GITTENSORY_REVIEW_REPOS?: string | undefined },
  repoFullName: string,
): boolean {
  return isScreenshotsEnabled(env) && isConvergenceRepoAllowed(env, repoFullName);
}
