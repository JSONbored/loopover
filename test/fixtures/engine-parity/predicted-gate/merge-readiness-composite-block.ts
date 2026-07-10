import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, parseManifest } from "./_shared";

// mergeReadinessGateMode branch: the composite merge-readiness mode drives the linked-issue / duplicate / slop
// sub-gates at once. With it set to block and no linked issue, the missing-linked-issue sub-gate becomes blocking.
export default definePredictedGateFixture({
  id: "merge-readiness-composite-block",
  title: "Composite merge-readiness mode blocks a missing linked issue",
  branch: "missing_linked_issue promoted to blocking when gate.mergeReadiness=block and no issue is linked",
  input: { ...BASE_INPUT, body: "No linked issue yet", linkedIssues: [] },
  manifest: parseManifest({ gate: { mergeReadiness: "block" } }),
  repo: BASE_REPO,
  issues: [],
  pullRequests: [],
  expected: {
    conclusion: "failure",
    pack: "gittensor",
    blockerCodes: ["missing_linked_issue"],
    warningCodes: [],
    funnelPresent: false,
  },
});
