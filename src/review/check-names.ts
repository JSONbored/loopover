import type { ReviewCheckMode } from "../types";

export const GITTENSORY_CONTEXT_CHECK_NAME = "Gittensory Context";
export const GITTENSORY_GATE_CHECK_NAME = "Gittensory Orb Review Agent";
export const GITTENSORY_LEGACY_GATE_CHECK_NAME = "Gittensory Gate";

/** Single point of truth for whether `reviewCheckMode` publishes the Gittensory Orb Review Agent check-run
 *  (#2852). `required` and `visible` both publish -- they are identical on the API-call side; the distinction
 *  is purely about how the operator should configure GitHub branch protection (visible = never required). Only
 *  `disabled` skips the check-run create/update calls entirely. */
export function shouldPublishReviewCheck(reviewCheckMode: ReviewCheckMode): boolean {
  return reviewCheckMode !== "disabled";
}
