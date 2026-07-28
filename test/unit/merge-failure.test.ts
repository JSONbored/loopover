import { describe, expect, it } from "vitest";
import { classifyMergeFailure, isMergeConflictMessage, isNoNewBaseCommitsMessage, isWorkflowScopeRefusalMessage, MERGE_RETRY_CAP } from "../../src/services/merge-failure";

/** Build an Octokit-style RequestError: an Error carrying an HTTP `.status`. */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("classifyMergeFailure", () => {
  it("retries the transient 405 'Base branch was modified' TOCTOU race instead of holding it", () => {
    const result = classifyMergeFailure(httpError(405, "Base branch was modified. Review and try the merge again."));
    expect(result.terminal).toBe(false);
    expect(result.reason).toMatch(/base branch moved/i);
  });

  it("REGRESSION (#5003, GITTENSORY-1K): retries the transient 405 'Merge already in progress' race instead of holding it", () => {
    const result = classifyMergeFailure(httpError(405, "Merge already in progress"));
    expect(result.terminal).toBe(false);
    expect(result.reason).toMatch(/already in progress/i);
  });

  it("still treats a policy 405 (required reviews/checks) as terminal", () => {
    const result = classifyMergeFailure(httpError(405, "At least 1 approving review is required by reviewers with write access."));
    expect(result.terminal).toBe(true);
    expect(result.reason).toMatch(/405/);
  });

  it("treats a 401 (installation token rejected) as terminal, distinct from a generic rejection (#2264)", () => {
    // withInstallationTokenRetry already evicts-and-retries once on a 401 inside the merge call itself, so a 401
    // reaching classifyMergeFailure means that retry also failed — a persistently unauthorized installation, not
    // a one-off stale-token race. Must fail fast (terminal) rather than burn the full MERGE_RETRY_CAP.
    const result = classifyMergeFailure(httpError(401, "Bad credentials"));
    expect(result.terminal).toBe(true);
    expect(result.reason).toMatch(/installation token rejected/i);
    expect(result.reason).toMatch(/suspended or key rotated/i);
  });

  it("retries GitHub's generic 403 merge rejection because branch protection can still converge", () => {
    for (const message of ["Resource not accessible by integration", "secondary rate limit", "API rate limit exceeded", "abuse detection mechanism triggered"]) {
      const result = classifyMergeFailure(httpError(403, message));
      expect(result.terminal).toBe(false);
      expect(result.reason).toMatch(/converging/i);
    }
  });

  it("treats non-convergence 403s, 409, and real merge-conflict text as terminal", () => {
    expect(classifyMergeFailure(httpError(403, "Repository does not allow squash merges")).terminal).toBe(true);
    expect(classifyMergeFailure(httpError(409, "Required status check is expected.")).terminal).toBe(true);
    expect(classifyMergeFailure(new Error("The branch has conflicts that must be resolved")).terminal).toBe(true);
  });

  it("treats an unclassified/non-HTTP failure as possibly transient", () => {
    expect(classifyMergeFailure(new Error("network timeout")).terminal).toBe(false);
  });

  it("exposes a positive retry cap for the executor", () => {
    expect(MERGE_RETRY_CAP).toBeGreaterThan(0);
  });
});

describe("isNoNewBaseCommitsMessage", () => {
  it("REGRESSION (LOOPOVER-24, regressed shape): matches GitHub's 422 'no new commits on the base branch' text", () => {
    expect(isNoNewBaseCommitsMessage("There are no new commits on the base branch. - https://docs.github.com/rest/pulls/pulls#update-a-pull-request-branch")).toBe(true);
  });

  it("does not match unrelated update-branch failures (conflicts, transients)", () => {
    expect(isNoNewBaseCommitsMessage("merge conflict between base and head")).toBe(false);
    expect(isNoNewBaseCommitsMessage("network timeout")).toBe(false);
  });
});

// #9498: 48 of 82 update_branch failures in one 7-day window were this class, across 14 PRs, with one PR
// retried NINE times against an outcome that can never succeed. Crucially it is NOT limited to PRs that touch
// workflow files: update_branch merges the base INTO the head, so any workflow change on the default branch
// since the PR forked makes the resulting merge a workflow write -- 4 of the 5 worst offenders touched none.
describe("isWorkflowScopeRefusalMessage (#9498)", () => {
  it.each([
    ["refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission"],
    ["Refusing to allow a GitHub App to create or update workflow file"],
    ["refusing to allow an integration to create or update workflow .github/workflows/release.yml"],
    ["refusing to allow an OAuth App to create or update workflow"],
  ])("recognises %s", (message) => {
    expect(isWorkflowScopeRefusalMessage(message)).toBe(true);
  });

  it.each([
    ["merge conflict between base and head"],
    ["There are no new commits on the base branch."],
    ["Base branch was modified. Review and try the merge again."],
    ["Resource not accessible by integration"],
    [""],
  ])("does NOT misclassify %s", (message) => {
    // Deliberately narrow: a generic permission error must keep its existing handling, and the sibling
    // update_branch shapes must keep theirs.
    expect(isWorkflowScopeRefusalMessage(message)).toBe(false);
  });

  it("INVARIANT: does not overlap the other update_branch classifiers", () => {
    const workflowRefusal = "refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml`";
    expect(isMergeConflictMessage(workflowRefusal)).toBe(false);
    expect(isNoNewBaseCommitsMessage(workflowRefusal)).toBe(false);
  });
});
