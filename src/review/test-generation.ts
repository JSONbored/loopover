// Boundary-safe test generation (#2189, config slice of #1972) — the review.test_generation gate that decides
// whether a missing-test-evidence finding is ALSO accompanied by a gittensory_generate_tests local-write action
// spec (src/mcp/local-write-tools.ts's buildTestGenSpec + detectTestConvention, #2187/#2188). Default OFF at
// BOTH layers, mirroring isInlineCommentsEnabled (src/review/inline-comments.ts): the operator flag
// GITTENSORY_REVIEW_TEST_GENERATION AND the per-repo `.gittensory.yml` review.test_generation toggle — the
// caller ANDs both to decide whether to build the spec at all. Config resolution only; the caller that actually
// builds/attaches the spec to a missing-test-evidence finding is a separate slice.

/** True when the operator enabled test generation globally. Flag-OFF (default) ⇒ the caller never builds a
 *  test-gen spec, so this feature is unreachable regardless of any repo's manifest. Truthy follows the
 *  codebase convention (same regex as isInlineCommentsEnabled / isSafetyEnabled). */
export function isTestGenerationEnabled(env: { GITTENSORY_REVIEW_TEST_GENERATION?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_TEST_GENERATION ?? "");
}

/** PURE: should a missing-test-evidence finding be accompanied by a test-gen action spec for this PR? True ONLY
 *  when BOTH gates pass — the per-repo `.gittensory.yml` toggle (`manifestToggle`) AND the operator flag — so
 *  the feature is off by default at every layer, mirroring shouldRequestInlineFindings's two-of-three shape
 *  (this slice has no cutover-allowlist third gate). */
export function shouldOfferTestGenerationSpec(
  env: { GITTENSORY_REVIEW_TEST_GENERATION?: string | undefined },
  manifestToggle: boolean | undefined,
): boolean {
  return manifestToggle === true && isTestGenerationEnabled(env);
}
