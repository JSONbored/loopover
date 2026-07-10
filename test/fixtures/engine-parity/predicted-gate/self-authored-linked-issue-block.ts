import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, openIssue, parseManifest } from "./_shared";

// selfAuthoredLinkedIssue branch: the linked issue #7 is authored by the same login opening the PR, and the
// repo opts into blocking self-authored linked issues. Advisory by default, so this only blocks on opt-in.
export default definePredictedGateFixture({
  id: "self-authored-linked-issue-block",
  title: "Self-authored linked issue blocks on opt-in",
  branch: "self_authored_linked_issue when gate.selfAuthoredLinkedIssue=block and issue #7 authorLogin equals the contributor",
  input: BASE_INPUT,
  manifest: parseManifest({ gate: { selfAuthoredLinkedIssue: "block" } }),
  repo: BASE_REPO,
  issues: [openIssue(7, "Uploads should retry on 5xx", "miner1")],
  pullRequests: [],
  expected: {
    conclusion: "failure",
    pack: "gittensor",
    blockerCodes: ["self_authored_linked_issue"],
    warningCodes: [],
    funnelPresent: false,
  },
});
