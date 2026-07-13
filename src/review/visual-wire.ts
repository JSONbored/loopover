// Convergence (visual capture) feature flag wiring.
//
// Single env switch: GITTENSORY_REVIEW_SCREENSHOTS. Default OFF (unset/"false") — when OFF the processor
// never calls buildCapture, so the review path is byte-identical to today. Truthy follows the codebase
// convention (`/^(1|true|yes|on)$/i`, same as isSafetyEnabled / isUnifiedReviewCommentEnabled).
//
// `screenshots` is a `ConvergedFeatureKey` (#4616): per-repo activation — the global flag here AND (a per-repo
// `.gittensory.yml` `features.screenshots` override OR the `GITTENSORY_REVIEW_REPOS` cutover allowlist
// default) — is resolved by `resolveConvergedFeature` / `convergedFeatureActive` in `./feature-activation`,
// the SAME shared resolver every other converged feature goes through; this file only owns the flag itself
// (`FEATURE_GLOBAL_FLAG`'s `screenshots` entry). Before #4616 this file also exported a hand-rolled
// `screenshotsAllowed` (env flag AND allowlist, no `features:` override at all — screenshots was not yet a
// `ConvergedFeatureKey`); call sites now call `resolveConvergedFeature(env, manifest, "screenshots",
// repoFullName)` directly, exactly like `e2eTests`' own call sites already did before this change.
//
// `review.visual.enabled` / `review.visual.production_url` (#3609/#3610/#4083) are a SEPARATE, richer per-repo
// config layer (route/preview-URL details, plus an always-available additional force-off) that narrows
// capture AFTER this key decides whether it is attempted for the repo at all — see resolveVisualCaptureConfig
// in src/queue/processors.ts. That layer's existing force-off-only semantics are unchanged by #4616.

import { dualPrefixEnvFlag } from "../utils/env";

/** True when the visual-capture global flag is enabled. Flag-OFF (default) → no capture is attempted. */
export function isScreenshotsEnabled(env: {
  GITTENSORY_REVIEW_SCREENSHOTS?: string | undefined;
  LOOPOVER_REVIEW_SCREENSHOTS?: string | undefined;
}): boolean {
  return dualPrefixEnvFlag(env as unknown as Record<string, string | undefined>, "REVIEW_SCREENSHOTS");
}
