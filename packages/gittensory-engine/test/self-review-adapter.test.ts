import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPredictedGateVerdict,
  buildSelfReviewChangedPaths,
  buildSelfReviewPredictedGateInput,
  buildSelfReviewSlopInput,
  parseFocusManifest,
  runSelfReview,
  SELF_REVIEW_PASSING_CONCLUSION,
  type AttemptDiffState,
  type IssueRecord,
  type PullRequestRecord,
  type RepositoryRecord,
  type SelfReviewContext,
  type SelfReviewSlopAssessment,
} from "../dist/index.js";

const REPO: RepositoryRecord = { fullName: "acme/widgets", owner: "acme", name: "widgets", isInstalled: true, isRegistered: true, isPrivate: false };

function openIssue(number: number, title: string): IssueRecord {
  return { repoFullName: "acme/widgets", number, title, state: "open", labels: [], linkedPrs: [] };
}

function openPr(number: number, title: string, linkedIssues: number[] = []): PullRequestRecord {
  return { repoFullName: "acme/widgets", number, title, state: "open", authorLogin: "someone-else", linkedIssues, labels: [] };
}

const BASE_DIFF_STATE: AttemptDiffState = {
  repoFullName: "acme/widgets",
  contributorLogin: "miner1",
  title: "Add retry to the upload client",
  body: "Closes #7",
  linkedIssues: [7],
  changedFiles: [{ path: "src/upload.ts", additions: 10, deletions: 2 }],
};

function baseContext(overrides: Partial<SelfReviewContext> = {}): SelfReviewContext {
  return {
    manifest: parseFocusManifest({ gate: { duplicates: "block", linkedIssue: "advisory" } }),
    repo: REPO,
    issues: [openIssue(7, "Uploads should retry on 5xx")],
    pullRequests: [],
    ...overrides,
  };
}

const noopSlop: SelfReviewSlopAssessment = { slopRisk: 0, band: "clean", findings: [] };

test("barrel: the public entrypoint re-exports the self-review adapter (#2334)", () => {
  assert.equal(typeof buildSelfReviewPredictedGateInput, "function");
  assert.equal(typeof buildSelfReviewChangedPaths, "function");
  assert.equal(typeof buildSelfReviewSlopInput, "function");
  assert.equal(typeof runSelfReview, "function");
  assert.equal(SELF_REVIEW_PASSING_CONCLUSION, "success");
});

test("buildSelfReviewPredictedGateInput: maps identity fields, omitting keys the diff state left undefined", () => {
  const input = buildSelfReviewPredictedGateInput(BASE_DIFF_STATE);
  assert.deepEqual(input, {
    repoFullName: "acme/widgets",
    contributorLogin: "miner1",
    title: "Add retry to the upload client",
    body: "Closes #7",
    linkedIssues: [7],
  });
  assert.ok(!("labels" in input), "labels must be omitted, not set to undefined, when the diff state has none");
});

test("buildSelfReviewPredictedGateInput: includes labels and authorAssociation when the diff state sets them", () => {
  const input = buildSelfReviewPredictedGateInput({
    ...BASE_DIFF_STATE,
    labels: ["gittensor:feature"],
    authorAssociation: "CONTRIBUTOR",
  });
  assert.deepEqual(input.labels, ["gittensor:feature"]);
  assert.equal(input.authorAssociation, "CONTRIBUTOR");
});

test("buildSelfReviewPredictedGateInput: omits body and linkedIssues when the diff state leaves them undefined", () => {
  const input = buildSelfReviewPredictedGateInput({
    repoFullName: "acme/widgets",
    contributorLogin: "miner1",
    title: "Add retry to the upload client",
    changedFiles: [],
  });
  assert.ok(!("body" in input));
  assert.ok(!("linkedIssues" in input));
});

test("buildSelfReviewChangedPaths: extracts the real changed file paths", () => {
  const paths = buildSelfReviewChangedPaths({
    ...BASE_DIFF_STATE,
    changedFiles: [{ path: "src/a.ts" }, { path: "src/b.ts", additions: 5 }],
  });
  assert.deepEqual(paths, ["src/a.ts", "src/b.ts"]);
});

test("buildSelfReviewSlopInput: derives hasLinkedIssue from the diff state and threads context.inDuplicateCluster", () => {
  const withIssue = buildSelfReviewSlopInput(BASE_DIFF_STATE, baseContext({ inDuplicateCluster: true }));
  assert.equal(withIssue.hasLinkedIssue, true);
  assert.equal(withIssue.inDuplicateCluster, true);
  assert.equal(withIssue.description, "Closes #7");

  const withoutIssue = buildSelfReviewSlopInput({ ...BASE_DIFF_STATE, linkedIssues: [], body: undefined }, baseContext());
  assert.equal(withoutIssue.hasLinkedIssue, false);
  assert.equal(withoutIssue.description, null, "an undefined body normalizes to null, matching SlopAssessmentInput's own nullable field");

  // linkedIssues entirely UNDEFINED (not just an empty array) exercises the `?.length ?? 0` fallback chain
  // distinctly from the empty-array case above.
  const undefinedIssues = buildSelfReviewSlopInput({ ...BASE_DIFF_STATE, linkedIssues: undefined }, baseContext());
  assert.equal(undefinedIssues.hasLinkedIssue, false);
});

test("runSelfReview: a genuinely passing synthetic diff matches calling buildPredictedGateVerdict directly", () => {
  const context = baseContext();
  const result = runSelfReview(BASE_DIFF_STATE, context, { runSlopAssessment: () => noopSlop });

  assert.equal(result.predictedGateVerdict.conclusion, "success");
  assert.equal(result.passesPredictedGate, true);
  assert.deepEqual(result.changedPaths, ["src/upload.ts"]);

  const direct = buildPredictedGateVerdict({
    input: buildSelfReviewPredictedGateInput(BASE_DIFF_STATE),
    manifest: context.manifest,
    repo: context.repo,
    issues: context.issues,
    pullRequests: context.pullRequests,
    changedPaths: ["src/upload.ts"],
  });
  assert.deepEqual(result.predictedGateVerdict, direct, "the adapter's verdict must be byte-identical to a direct buildPredictedGateVerdict call with the same inputs");
});

test("runSelfReview: a genuinely blocked synthetic diff (duplicate PR) matches calling buildPredictedGateVerdict directly, and passesPredictedGate is false", () => {
  const context = baseContext({ pullRequests: [openPr(42, "Retry uploads on 5xx responses", [7])] });
  const result = runSelfReview(BASE_DIFF_STATE, context, { runSlopAssessment: () => noopSlop });

  assert.equal(result.predictedGateVerdict.conclusion, "failure");
  assert.equal(result.passesPredictedGate, false);
  assert.ok(result.predictedGateVerdict.blockers.some((b) => b.code === "duplicate_pr_risk"));

  const direct = buildPredictedGateVerdict({
    input: buildSelfReviewPredictedGateInput(BASE_DIFF_STATE),
    manifest: context.manifest,
    repo: context.repo,
    issues: context.issues,
    pullRequests: context.pullRequests,
    changedPaths: ["src/upload.ts"],
  });
  assert.deepEqual(result.predictedGateVerdict, direct);
});

test("runSelfReview: never treats a non-success conclusion as passing -- the hard defense-in-depth requirement", () => {
  // Exercise BOTH branches of the pass/fail boundary this issue's deliverables call out explicitly: a clear
  // pass reads true, and a real (not synthetic) blocked verdict reads false. This is deliberately redundant
  // with the two tests above -- the issue asks for the hard requirement to be independently, explicitly
  // asserted, not just incidentally covered by other assertions.
  const passing = runSelfReview(BASE_DIFF_STATE, baseContext(), { runSlopAssessment: () => noopSlop });
  assert.equal(passing.passesPredictedGate, true);

  const blocked = runSelfReview(BASE_DIFF_STATE, baseContext({ pullRequests: [openPr(42, "dup", [7])] }), {
    runSlopAssessment: () => noopSlop,
  });
  assert.notEqual(blocked.predictedGateVerdict.conclusion, SELF_REVIEW_PASSING_CONCLUSION);
  assert.equal(blocked.passesPredictedGate, false);
});

test("runSelfReview: threads changedPaths through so path-dependent checks are evaluated, not silently skipped", () => {
  // A manifest with a wantedPaths preference the diff's changed file does NOT match -- only observable if
  // changedPaths was genuinely passed through to buildPredictedGateVerdict, not omitted.
  const context = baseContext({
    manifest: parseFocusManifest({ duplicates: "block", linkedIssue: "advisory", wantedPaths: ["docs/**"] } as never),
  });
  const result = runSelfReview(BASE_DIFF_STATE, context, { runSlopAssessment: () => noopSlop });
  assert.equal(result.changedPaths.length, 1);
  assert.equal(result.changedPaths[0], "src/upload.ts");
});

test("runSelfReview: forwards optional context fields (bounties, issueQuality, confirmedContributor) through to buildPredictedGateVerdict", () => {
  const context = baseContext({ confirmedContributor: true, bounties: [], issueQuality: null });
  const result = runSelfReview(BASE_DIFF_STATE, context, { runSlopAssessment: () => noopSlop });

  assert.equal(result.predictedGateVerdict.confirmedContributor, true);

  const direct = buildPredictedGateVerdict({
    input: buildSelfReviewPredictedGateInput(BASE_DIFF_STATE),
    manifest: context.manifest,
    repo: context.repo,
    issues: context.issues,
    pullRequests: context.pullRequests,
    bounties: [],
    issueQuality: null,
    confirmedContributor: true,
    changedPaths: ["src/upload.ts"],
  });
  assert.deepEqual(result.predictedGateVerdict, direct);
});

test("runSelfReview: passes the exact constructed slop input to the injected dependency and returns its result unchanged", () => {
  let received: unknown;
  const distinctiveSlop: SelfReviewSlopAssessment = { slopRisk: 42, band: "elevated", findings: [{ code: "x", title: "t", severity: "warning", detail: "d" }] };
  const result = runSelfReview(BASE_DIFF_STATE, baseContext(), {
    runSlopAssessment: (input) => {
      received = input;
      return distinctiveSlop;
    },
  });

  assert.deepEqual(received, buildSelfReviewSlopInput(BASE_DIFF_STATE, baseContext()));
  assert.deepEqual(result.slopAssessment, distinctiveSlop);
});
