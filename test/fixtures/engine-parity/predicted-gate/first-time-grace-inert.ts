import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, openIssue, parseManifest } from "./_shared";

// firstTimeContributorGrace branch: grace is threaded as compatibility context but is deliberately no longer
// read by the gate evaluator (blocker findings are not softened by it). So enabling it leaves the predicted
// verdict byte-identical to a clean pass. This fixture locks in that no-op so a future re-activation is caught.
export default definePredictedGateFixture({
  id: "first-time-grace-inert",
  title: "firstTimeContributorGrace does not change the predicted verdict",
  branch: "gate.firstTimeContributorGrace=true is compatibility context only and softens nothing",
  input: BASE_INPUT,
  manifest: parseManifest({ gate: { firstTimeContributorGrace: true } }),
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
