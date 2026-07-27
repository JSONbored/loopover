import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, openIssue, openPr, parseManifest } from "./_shared";

// Duplicate cluster branch: another OPEN PR cites the same linked issue in its (author-controlled) body text,
// with no corroborating changed-file evidence resolved for either side (openPr never sets changedFiles). #9129:
// an UNCORROBORATED overlap is never a configured gate blocker regardless of duplicatePrGateMode -- an
// adversary could otherwise cite the same issue number in a throwaway sibling PR, no code required, and force
// this exact scenario to block/close the real PR. Only the separate, always-non-blocking
// duplicate_pr_risk_unconfirmed finding fires here; the gate passes.
export default definePredictedGateFixture({
  id: "duplicate-pr-block",
  title: "An uncorroborated duplicate-issue citation never blocks the predicted gate (#9129)",
  branch: "duplicate_pr_risk_unconfirmed via another open sibling citing the same linked issue, no diff corroboration",
  input: BASE_INPUT,
  manifest: parseManifest({ gate: { duplicates: "block" } }),
  repo: BASE_REPO,
  issues: [openIssue(7, "Uploads should retry on 5xx")],
  pullRequests: [openPr(42, "Retry uploads on 5xx responses", [7])],
  expected: {
    conclusion: "success",
    pack: "gittensor",
    blockerCodes: [],
    warningCodes: [],
    funnelPresent: false,
  },
});
