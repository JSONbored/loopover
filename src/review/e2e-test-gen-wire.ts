// Convergence (E2E test generation) wiring (#4190, part of the #4189 epic): the master kill-switch for the
// `e2eTests` converged feature — an opt-in capability that generates Playwright E2E tests for a PR at a
// maintainer's request. This file is deliberately minimal for now (just the env flag), mirroring the shape of
// `rag-wire.ts`/`grounding-wire.ts` at the same stage of their own rollout — the generation/render/dispatch
// logic lands in later, separate PRs (#4191-#4197) once this flag exists for them to gate on.
//
// Single env switch: GITTENSORY_REVIEW_E2E_TESTS. Default OFF (unset/"false") — when OFF the feature never
// runs anywhere, regardless of any per-repo `.gittensory.yml` override (see `resolveConvergedFeature` in
// `./feature-activation`). Truthy follows the codebase convention (`/^(1|true|yes|on)$/i`, same as
// isRagEnabled / isGroundingEnabled / isSafetyEnabled).

/** True when E2E test generation is enabled at the deployment level. Flag-OFF (default) → the feature is
 *  never active for any repo, regardless of a per-repo `features.e2eTests` override. */
export function isE2eTestGenerationEnabled(env: { GITTENSORY_REVIEW_E2E_TESTS?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_E2E_TESTS ?? "");
}
