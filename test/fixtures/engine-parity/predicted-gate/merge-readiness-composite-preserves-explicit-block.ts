import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, parseManifest } from "./_shared";

// #9167 regression: mergeReadinessGateMode composite must not DEMOTE an explicitly-configured block
// sub-gate. Before #9167 this exact combination (mergeReadiness: advisory + linkedIssue: block) would
// have unconditionally overridden linkedIssueGateMode to "advisory", so a missing linked issue would
// never have blocked -- silently weaker than what the manifest visibly authored. Now the composite only
// fills in a sub-gate mode left unset; an explicit `block` always wins, so this still blocks.
export default definePredictedGateFixture({
  id: "merge-readiness-composite-preserves-explicit-block",
  title: "Composite merge-readiness advisory mode does not demote an explicitly-configured block sub-gate",
  branch: "missing_linked_issue still blocks when gate.mergeReadiness=advisory but gate.linkedIssue=block is explicit",
  input: { ...BASE_INPUT, body: "No linked issue yet", linkedIssues: [] },
  manifest: parseManifest({ gate: { mergeReadiness: "advisory", linkedIssue: "block" } }),
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
