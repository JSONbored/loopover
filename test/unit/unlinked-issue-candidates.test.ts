import { describe, expect, it } from "vitest";
import { findUnlinkedIssueCandidates, type CandidateOpenIssue } from "../../src/signals/unlinked-issue-candidates";

function issue(overrides: Partial<CandidateOpenIssue> & { number: number }): CandidateOpenIssue {
  return { title: "", body: null, labels: [], ...overrides };
}

describe("findUnlinkedIssueCandidates", () => {
  it("returns nothing when there are no open issues", () => {
    expect(findUnlinkedIssueCandidates({ prTitle: "fix timeout handling", prBody: null, changedPaths: [], openIssues: [] })).toEqual([]);
  });

  it("returns nothing when token overlap is below the minimum and no path is mentioned", () => {
    const result = findUnlinkedIssueCandidates({
      prTitle: "tweak formatting",
      prBody: "minor cleanup",
      changedPaths: ["src/utils/format.ts"],
      openIssues: [issue({ number: 1, title: "unrelated topic entirely", body: "totally different subject matter" })],
    });
    expect(result).toEqual([]);
  });

  it("qualifies via distinctive token overlap alone (no path mention)", () => {
    const result = findUnlinkedIssueCandidates({
      prTitle: "fix timeout handling in webhook retry logic",
      prBody: null,
      changedPaths: [],
      openIssues: [issue({ number: 1, title: "webhook retry logic times out under load", body: "the timeout handling needs a fix" })],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.issue.number).toBe(1);
    expect(result[0]?.pathMentioned).toBe(false);
    expect(result[0]?.matchedTokens.length).toBeGreaterThanOrEqual(3);
    expect(result[0]?.score).toBe(result[0]?.matchedTokens.length);
  });

  it("qualifies via a full changed-path mention alone, even with zero token overlap", () => {
    const result = findUnlinkedIssueCandidates({
      prTitle: "xyz",
      prBody: "abc",
      changedPaths: ["src/queue/processors.ts"],
      openIssues: [issue({ number: 2, title: "totally unrelated wording", body: "something is wrong in src/queue/processors.ts specifically" })],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.pathMentioned).toBe(true);
    expect(result[0]?.score).toBe(5);
  });

  it("qualifies via a basename-only mention when the basename is long enough", () => {
    const result = findUnlinkedIssueCandidates({
      prTitle: "xyz",
      prBody: "abc",
      changedPaths: ["src/queue/processors.ts"],
      openIssues: [issue({ number: 3, title: "bug", body: "processors.ts seems to double-count on retry" })],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.pathMentioned).toBe(true);
  });

  it("does not match on a too-short basename, regardless of body content", () => {
    // basename "db" is only 2 chars (< MIN_TOKEN_LENGTH), so the length check short-circuits the match
    // before ever scanning the body for it — too generic a fragment to trust as evidence.
    const result = findUnlinkedIssueCandidates({
      prTitle: "xyz",
      prBody: "abc",
      changedPaths: ["src/db"],
      openIssues: [issue({ number: 4, title: "bug", body: "db might be involved" })],
    });
    expect(result).toEqual([]);
  });

  it("does not path-match when the issue body is empty (null body)", () => {
    const result = findUnlinkedIssueCandidates({
      prTitle: "xyz",
      prBody: "abc",
      changedPaths: ["src/queue/processors.ts"],
      openIssues: [issue({ number: 5, title: "processors.ts", body: null })],
    });
    // title-only "processors.ts" token doesn't clear MIN_TOKEN_OVERLAP (only one token), and pathMentioned
    // is false because the body (used for the path scan) is empty.
    expect(result).toEqual([]);
  });

  it("combines token overlap AND a path mention into a higher score", () => {
    const result = findUnlinkedIssueCandidates({
      prTitle: "fix retry loop duplicate counting bug",
      prBody: null,
      changedPaths: ["src/queue/processors.ts"],
      openIssues: [issue({ number: 6, title: "retry loop duplicate counting", body: "reproduced in src/queue/processors.ts" })],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.pathMentioned).toBe(true);
    expect(result[0]?.score).toBeGreaterThan(5);
  });

  it("ranks by score descending, then by lower issue number on a tie", () => {
    const result = findUnlinkedIssueCandidates({
      prTitle: "fix retry loop duplicate counting bug",
      prBody: null,
      changedPaths: [],
      openIssues: [
        issue({ number: 20, title: "retry loop duplicate counting problem", body: null }),
        issue({ number: 5, title: "retry loop duplicate counting problem", body: null }),
      ],
    });
    expect(result.map((m) => m.issue.number)).toEqual([5, 20]);
  });

  it("caps the result at the top 3 qualifying candidates", () => {
    const openIssues = Array.from({ length: 5 }, (_, i) =>
      issue({ number: i + 1, title: "webhook retry timeout handling logic", body: null }),
    );
    const result = findUnlinkedIssueCandidates({
      prTitle: "fix webhook retry timeout handling logic",
      prBody: null,
      changedPaths: [],
      openIssues,
    });
    expect(result).toHaveLength(3);
  });

  it("filters out short tokens and stopwords from both the PR and issue text", () => {
    // "the", "with", "into" are stopwords; "fix", "bug" are below MIN_TOKEN_LENGTH (4) or are stopwords —
    // none of these should count toward the overlap even though they appear in both texts.
    const result = findUnlinkedIssueCandidates({
      prTitle: "fix the bug with the retry logic into a queue",
      prBody: null,
      changedPaths: [],
      openIssues: [issue({ number: 1, title: "the bug with into a queue and retry", body: null })],
    });
    expect(result).toEqual([]);
  });

  it("treats an undefined PR body the same as a null one", () => {
    const result = findUnlinkedIssueCandidates({
      prTitle: "fix webhook retry timeout handling logic",
      prBody: undefined,
      changedPaths: [],
      openIssues: [issue({ number: 1, title: "webhook retry timeout handling logic", body: null })],
    });
    expect(result).toHaveLength(1);
  });
});
