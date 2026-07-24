// Root-level vitest coverage twin for `packages/loopover-engine/src/miner/self-review-adapter.ts` (#8348).
//
// The self-review adapter (#2334) turns an attempt's live worktree diff state into the same inputs
// `buildPredictedGateVerdict` and an injected slop-assessment function expect, so the miner's self-review pass
// is byte-identical in shape to the live maintainer gate. It is fully exercised by the engine package's own
// `node --test` suite (`packages/loopover-engine/test/self-review-adapter.test.ts`), but that runner is not part
// of the root vitest run Codecov reads `codecov/patch` from, so it reports as ~0% covered despite being
// genuinely tested (same blind spot as #6250). This twin imports the adapter functions via the engine barrel
// and mirrors every scenario the package suite covers — matching the sibling pattern in
// `test/unit/calibration-dashboard.test.ts`. It uses `buildPredictedGateVerdict` + `parseFocusManifest` and an
// INJECTED `runSlopAssessment` fake exactly as the package suite does; the real `src/signals/slop.ts` is never
// imported, and no source file is modified.
import { describe, expect, it } from "vitest";
import {
  buildPredictedGateVerdict,
  buildSelfReviewChangedPaths,
  buildSelfReviewPredictedGateInput,
  buildSelfReviewSlopInput,
  parseFocusManifest,
  runSelfReview,
  SELF_REVIEW_PASSING_CONCLUSION,
} from "../../packages/loopover-engine/src/index";
import type {
  AttemptDiffState,
  IssueRecord,
  PullRequestRecord,
  RepositoryRecord,
  SelfReviewContext,
  SelfReviewSlopAssessment,
} from "../../packages/loopover-engine/src/index";

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

describe("barrel: the self-review adapter is re-exported from the engine entrypoint (#2334)", () => {
  it("exposes the adapter functions and the passing-conclusion literal", () => {
    expect(typeof buildSelfReviewPredictedGateInput).toBe("function");
    expect(typeof buildSelfReviewChangedPaths).toBe("function");
    expect(typeof buildSelfReviewSlopInput).toBe("function");
    expect(typeof runSelfReview).toBe("function");
    expect(SELF_REVIEW_PASSING_CONCLUSION).toBe("success");
  });
});

describe("buildSelfReviewPredictedGateInput — conditional spreads on optional identity fields", () => {
  it("maps identity fields, omitting keys the diff state left undefined (present body/linkedIssues, omitted labels/authorAssociation)", () => {
    const input = buildSelfReviewPredictedGateInput(BASE_DIFF_STATE);
    expect(input).toEqual({
      repoFullName: "acme/widgets",
      contributorLogin: "miner1",
      title: "Add retry to the upload client",
      body: "Closes #7",
      linkedIssues: [7],
    });
    expect("labels" in input).toBe(false);
    expect("authorAssociation" in input).toBe(false);
  });

  it("includes labels and authorAssociation when the diff state sets them", () => {
    const input = buildSelfReviewPredictedGateInput({
      ...BASE_DIFF_STATE,
      labels: ["gittensor:feature"],
      authorAssociation: "CONTRIBUTOR",
    });
    expect(input.labels).toEqual(["gittensor:feature"]);
    expect(input.authorAssociation).toBe("CONTRIBUTOR");
  });

  it("omits body and linkedIssues when the diff state leaves them undefined", () => {
    const input = buildSelfReviewPredictedGateInput({
      repoFullName: "acme/widgets",
      contributorLogin: "miner1",
      title: "Add retry to the upload client",
      changedFiles: [],
    });
    expect("body" in input).toBe(false);
    expect("linkedIssues" in input).toBe(false);
  });
});

describe("buildSelfReviewChangedPaths", () => {
  it("extracts the real changed file paths in order", () => {
    const paths = buildSelfReviewChangedPaths({
      ...BASE_DIFF_STATE,
      changedFiles: [{ path: "src/a.ts" }, { path: "src/b.ts", additions: 5 }],
    });
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns an empty array for an empty changedFiles list", () => {
    expect(buildSelfReviewChangedPaths({ ...BASE_DIFF_STATE, changedFiles: [] })).toEqual([]);
  });
});

describe("buildSelfReviewSlopInput — `??` description fallback and hasLinkedIssue derivation", () => {
  it("derives hasLinkedIssue from a non-empty linkedIssues array, threads inDuplicateCluster, and keeps a present body as the description", () => {
    const withIssue = buildSelfReviewSlopInput(BASE_DIFF_STATE, baseContext({ inDuplicateCluster: true }));
    expect(withIssue.hasLinkedIssue).toBe(true);
    expect(withIssue.inDuplicateCluster).toBe(true);
    expect(withIssue.description).toBe("Closes #7");
  });

  it("an empty linkedIssues array yields hasLinkedIssue false, and an undefined body normalizes to null via `?? null`", () => {
    const withoutIssue = buildSelfReviewSlopInput({ ...BASE_DIFF_STATE, linkedIssues: [], body: undefined }, baseContext());
    expect(withoutIssue.hasLinkedIssue).toBe(false);
    expect(withoutIssue.description).toBe(null);
  });

  it("an entirely undefined linkedIssues exercises the `?.length ?? 0` fallback chain distinctly from the empty-array case", () => {
    const undefinedIssues = buildSelfReviewSlopInput({ ...BASE_DIFF_STATE, linkedIssues: undefined }, baseContext());
    expect(undefinedIssues.hasLinkedIssue).toBe(false);
  });
});

describe("runSelfReview", () => {
  it("a genuinely passing synthetic diff matches calling buildPredictedGateVerdict directly, and passesPredictedGate is true", () => {
    const context = baseContext();
    const result = runSelfReview(BASE_DIFF_STATE, context, { runSlopAssessment: () => noopSlop });

    expect(result.predictedGateVerdict.conclusion).toBe("success");
    expect(result.passesPredictedGate).toBe(true);
    expect(result.changedPaths).toEqual(["src/upload.ts"]);

    const direct = buildPredictedGateVerdict({
      input: buildSelfReviewPredictedGateInput(BASE_DIFF_STATE),
      manifest: context.manifest,
      repo: context.repo,
      issues: context.issues,
      pullRequests: context.pullRequests,
      changedPaths: ["src/upload.ts"],
    });
    expect(result.predictedGateVerdict).toEqual(direct);
  });

  it("a genuinely blocked synthetic diff (duplicate PR) is a failure conclusion and passesPredictedGate is false", () => {
    const context = baseContext({ pullRequests: [openPr(42, "Retry uploads on 5xx responses", [7])] });
    const result = runSelfReview(BASE_DIFF_STATE, context, { runSlopAssessment: () => noopSlop });

    expect(result.predictedGateVerdict.conclusion).toBe("failure");
    expect(result.passesPredictedGate).toBe(false);
    expect(result.predictedGateVerdict.blockers.some((b) => b.code === "duplicate_pr_risk")).toBe(true);

    const direct = buildPredictedGateVerdict({
      input: buildSelfReviewPredictedGateInput(BASE_DIFF_STATE),
      manifest: context.manifest,
      repo: context.repo,
      issues: context.issues,
      pullRequests: context.pullRequests,
      changedPaths: ["src/upload.ts"],
    });
    expect(result.predictedGateVerdict).toEqual(direct);
  });

  it("never treats a non-success conclusion as passing — the hard defense-in-depth requirement (both boundary arms)", () => {
    const passing = runSelfReview(BASE_DIFF_STATE, baseContext(), { runSlopAssessment: () => noopSlop });
    expect(passing.passesPredictedGate).toBe(true);

    const blocked = runSelfReview(BASE_DIFF_STATE, baseContext({ pullRequests: [openPr(42, "dup", [7])] }), {
      runSlopAssessment: () => noopSlop,
    });
    expect(blocked.predictedGateVerdict.conclusion).not.toBe(SELF_REVIEW_PASSING_CONCLUSION);
    expect(blocked.passesPredictedGate).toBe(false);
  });

  it("threads changedPaths through so path-dependent checks are evaluated, not silently skipped", () => {
    const context = baseContext({
      manifest: parseFocusManifest({ duplicates: "block", linkedIssue: "advisory", wantedPaths: ["docs/**"] } as never),
    });
    const result = runSelfReview(BASE_DIFF_STATE, context, { runSlopAssessment: () => noopSlop });
    expect(result.changedPaths).toEqual(["src/upload.ts"]);
  });

  it("forwards the optional context fields (bounties, issueQuality, confirmedContributor) through to buildPredictedGateVerdict", () => {
    const context = baseContext({ confirmedContributor: true, bounties: [], issueQuality: null });
    const result = runSelfReview(BASE_DIFF_STATE, context, { runSlopAssessment: () => noopSlop });

    expect(result.predictedGateVerdict.confirmedContributor).toBe(true);

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
    expect(result.predictedGateVerdict).toEqual(direct);
  });

  it("passes the exact constructed slop input to the injected dependency and returns its result unchanged", () => {
    let received: unknown;
    const distinctiveSlop: SelfReviewSlopAssessment = {
      slopRisk: 42,
      band: "elevated",
      findings: [{ code: "x", title: "t", severity: "warning", detail: "d" }],
    };
    const result = runSelfReview(BASE_DIFF_STATE, baseContext(), {
      runSlopAssessment: (input) => {
        received = input;
        return distinctiveSlop;
      },
    });

    expect(received).toEqual(buildSelfReviewSlopInput(BASE_DIFF_STATE, baseContext()));
    expect(result.slopAssessment).toEqual(distinctiveSlop);
  });
});
