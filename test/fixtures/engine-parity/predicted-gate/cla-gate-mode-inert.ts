import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, openIssue, parseManifest } from "./_shared";

// claGateMode branch: the CLA sub-gate only acts on a CLA finding, which is produced from live PR-thread
// signals the metadata-only predictor never has. So opting into claMode=block leaves the predicted verdict
// byte-identical to a clean pass. This fixture locks in that inertness (cf. manifest-blocked-path), so a future
// change that lets claMode act pre-merge is caught by the parity suite.
export default definePredictedGateFixture({
  id: "cla-gate-mode-inert",
  title: "claMode is inert in the metadata-only predictor",
  branch: "claGateMode=block with no CLA finding available pre-merge stays a clean pass",
  input: BASE_INPUT,
  manifest: parseManifest({ gate: { claMode: "block" } }),
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
