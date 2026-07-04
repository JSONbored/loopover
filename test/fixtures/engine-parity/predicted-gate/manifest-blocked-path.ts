import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, openIssue, parseManifest } from "./_shared";

// Legacy focus-manifest blockedPaths remain a compatibility alias for hard guardrail holds.
export default definePredictedGateFixture({
  id: "manifest-blocked-path",
  title: "Legacy blocked manifest path is held",
  branch: "legacy blockedPaths with changedPaths supplied and manifestPolicy:block",
  input: BASE_INPUT,
  manifest: parseManifest({ gate: { manifestPolicy: "block" }, blockedPaths: ["dist/**"] }),
  repo: BASE_REPO,
  issues: [openIssue(7, "Uploads should retry on 5xx")],
  pullRequests: [],
  changedPaths: ["dist/bundle.js"],
  expected: {
    conclusion: "neutral",
    pack: "gittensor",
    blockerCodes: [],
    warningCodes: ["guardrail_hold"],
    funnelPresent: false,
    noteExcludes: ["Provide the PR's changed paths"],
  },
});
