// #6741: buildPublicPrBodyDraft moved to @loopover/engine so the CLI stdio mirror can share it.
// Re-export from the engine SOURCE path (not the published dist) so vitest/Codecov attribute
// coverage to packages/loopover-engine/src/pr-body-draft.ts — same pattern as src/rules/predicted-gate.ts.
export {
  EXCLUDED_PRIVATE_PR_BODY_FIELDS,
  buildPublicPrBodyDraft,
  type PrBodyDraftSection,
  type PrBodyDraftSource,
  type PublicPrBodyDraft,
} from "../../packages/loopover-engine/src/pr-body-draft.js";
