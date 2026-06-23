import { describe, expect, it } from "vitest";
import { classifyMergeFailure, MERGE_RETRY_CAP } from "../../src/services/merge-failure";

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

  it("still treats a policy 405 (required reviews/checks) as terminal", () => {
    const result = classifyMergeFailure(httpError(405, "At least 1 approving review is required by reviewers with write access."));
    expect(result.terminal).toBe(true);
    expect(result.reason).toMatch(/405/);
  });

  it("treats 403, 409, and real merge-conflict text as terminal", () => {
    expect(classifyMergeFailure(httpError(403, "Resource not accessible by integration")).terminal).toBe(true);
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
