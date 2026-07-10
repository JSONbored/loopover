import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, openIssue, parseManifest } from "./_shared";

// aiReviewGateMode branch: the AI-review sub-gate acts on an AI-reviewer finding, which is produced only by the
// live dual-model review, never by this metadata-only predictor. So aiReviewMode=block leaves the predicted
// verdict byte-identical to a clean pass. This fixture locks in that inertness (cf. manifest-blocked-path).
export default definePredictedGateFixture({
  id: "ai-review-gate-mode-inert",
  title: "aiReviewMode is inert in the metadata-only predictor",
  branch: "aiReviewGateMode=block with no AI finding available pre-merge stays a clean pass",
  input: BASE_INPUT,
  manifest: parseManifest({ gate: { aiReviewMode: "block" } }),
  repo: BASE_REPO,
  issues: [openIssue(7, "Uploads should retry on 5xx")],
  pullRequests: [],
  expected: {
    conclusion: "success",
    pack: "gittensor",
    blockerCodes: [],
    warningCodes: [],
    funnelPresent: false,
  },
});
