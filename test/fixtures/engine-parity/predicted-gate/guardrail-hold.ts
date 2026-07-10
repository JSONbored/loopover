import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, openIssue, parseManifest } from "./_shared";

// guardrailHit branch: a changed path matches a settings.hardGuardrailGlobs pattern, so the predictor previews
// the manual-review guardrail HOLD (neutral verdict), the way the live gate holds guarded-path changes.
export default definePredictedGateFixture({
  id: "guardrail-hold",
  title: "Guarded-path change previews a manual-review hold",
  branch: "guardrail_hold when settings.hardGuardrailGlobs matches a changed path",
  input: BASE_INPUT,
  manifest: parseManifest({ settings: { hardGuardrailGlobs: ["migrations/**"] } }),
  repo: BASE_REPO,
  issues: [openIssue(7, "Uploads should retry on 5xx")],
  pullRequests: [],
  changedPaths: ["migrations/0001_add_retry_column.sql"],
  expected: {
    conclusion: "neutral",
    pack: "gittensor",
    blockerCodes: [],
    warningCodes: ["guardrail_hold"],
    funnelPresent: false,
  },
});
