import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, parseManifest } from "./_shared";

// #9167: the merge-readiness composite always OVERRIDES the sub-gates it covers (linkedIssue/duplicates/
// slop) when set to advisory or block -- including an explicitly-authored stricter sub-gate mode. A
// "fill in only if left unset" variant was considered and reverted: every sub-gate mode is already a
// concrete, DB-defaulted value by the time it reaches GateCheckPolicy (never actually undefined there), so
// that variant could never fire in practice -- "explicitly authored" vs. "resolved to the shipped default"
// is indistinguishable at that layer. The demotion this fixture exercises is made VISIBLE instead, via
// config-lint.ts's mergeReadinessCompositeWarnings, which operates on the raw pre-default manifest where
// "unset" is a real, meaningful state.
export default definePredictedGateFixture({
  id: "merge-readiness-composite-demotes-explicit-block",
  title: "Composite merge-readiness advisory mode demotes an explicitly-configured block sub-gate",
  branch: "missing_linked_issue does not block when gate.mergeReadiness=advisory overrides an explicit gate.linkedIssue=block",
  input: { ...BASE_INPUT, body: "No linked issue yet", linkedIssues: [] },
  manifest: parseManifest({ gate: { mergeReadiness: "advisory", linkedIssue: "block" } }),
  repo: BASE_REPO,
  issues: [],
  pullRequests: [],
  expected: {
    conclusion: "success",
    pack: "gittensor",
    blockerCodes: [],
    warningCodes: ["missing_linked_issue"],
    funnelPresent: false,
  },
});
