import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, openIssue, parseManifest } from "./_shared";

// Legacy focus-manifest blockedPaths are inert. Path holds are configured through
// settings.hardGuardrailGlobs, not manifestPolicy.
export default definePredictedGateFixture({
  id: "manifest-blocked-path",
  title: "Legacy blocked manifest path is ignored",
  branch: "legacy blockedPaths with changedPaths supplied and manifestPolicy:block",
  input: BASE_INPUT,
  manifest: parseManifest({ gate: { manifestPolicy: "block" }, blockedPaths: ["dist/**"] }),
  repo: BASE_REPO,
  issues: [openIssue(7, "Uploads should retry on 5xx")],
  pullRequests: [],
  changedPaths: ["dist/bundle.js"],
  expected: {
    conclusion: "success",
    pack: "gittensor",
    blockerCodes: [],
    warningCodes: [],
    funnelPresent: false,
    noteExcludes: ["Provide the PR's changed paths"],
  },
});
