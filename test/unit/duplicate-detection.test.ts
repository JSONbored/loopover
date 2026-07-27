import { describe, expect, it } from "vitest";
import { linkedIssueDuplicatePullRequestRecordsForGate, linkedIssueDuplicatePullRequestsForGate } from "../../src/queue/duplicate-detection";
import type { PullRequestRecord } from "../../src/types";

function pr(over: Partial<PullRequestRecord> & { number: number }): PullRequestRecord {
  return {
    repoFullName: "acme/widgets",
    title: `PR ${over.number}`,
    state: "open",
    labels: [],
    linkedIssues: [],
    ...over,
  };
}

describe("linkedIssueDuplicatePullRequestRecordsForGate", () => {
  it("returns [] when the PR links no issue and has no copycat match", () => {
    expect(linkedIssueDuplicatePullRequestRecordsForGate(pr({ number: 9, linkedIssues: [] }), [pr({ number: 5, linkedIssues: [1] })])).toEqual([]);
  });

  it("returns the linked-issue-overlapping open sibling (byte-identical to before #9033 with no copycat args)", () => {
    const sibling = pr({ number: 5, linkedIssues: [1] });
    const result = linkedIssueDuplicatePullRequestRecordsForGate(pr({ number: 9, linkedIssues: [1] }), [sibling]);
    expect(result.map((p) => p.number)).toEqual([5]);
  });

  it("excludes the PR itself and any non-open sibling from the linked-issue overlap", () => {
    const self = pr({ number: 9, linkedIssues: [1] });
    const closedSibling = pr({ number: 4, state: "closed", linkedIssues: [1] });
    expect(linkedIssueDuplicatePullRequestRecordsForGate(self, [self, closedSibling])).toEqual([]);
  });

  // #9033: a cross-issue content match.
  it("returns undefined-free [] for a copycat match when copycatGateMode is off (or absent)", () => {
    const candidate = pr({ number: 9, linkedIssues: [1], copycatScore: 95, copycatMatchedPullNumber: 12 });
    const sibling = pr({ number: 12, linkedIssues: [999] }); // DIFFERENT linked issue
    expect(linkedIssueDuplicatePullRequestRecordsForGate(candidate, [sibling], "off", null)).toEqual([]);
    expect(linkedIssueDuplicatePullRequestRecordsForGate(candidate, [sibling])).toEqual([]);
  });

  it("includes the copycat-matched sibling even though it cites a DIFFERENT linked issue, once copycatGateMode would act", () => {
    const candidate = pr({ number: 9, linkedIssues: [1], copycatScore: 95, copycatMatchedPullNumber: 12 });
    const sibling = pr({ number: 12, linkedIssues: [999] });
    const result = linkedIssueDuplicatePullRequestRecordsForGate(candidate, [sibling], "warn", 85);
    expect(result.map((p) => p.number)).toEqual([12]);
  });

  it("does not include a copycat match whose score is below the resolved threshold", () => {
    const candidate = pr({ number: 9, linkedIssues: [1], copycatScore: 40, copycatMatchedPullNumber: 12 });
    const sibling = pr({ number: 12, linkedIssues: [999] });
    expect(linkedIssueDuplicatePullRequestRecordsForGate(candidate, [sibling], "warn", 85)).toEqual([]);
  });

  it("does not include a copycat match that points at a CLOSED PR (only open siblings can be a duplicate-cluster member)", () => {
    const candidate = pr({ number: 9, linkedIssues: [1], copycatScore: 95, copycatMatchedPullNumber: 12 });
    const closedMatch = pr({ number: 12, state: "closed", linkedIssues: [999] });
    expect(linkedIssueDuplicatePullRequestRecordsForGate(candidate, [closedMatch], "warn", 85)).toEqual([]);
  });

  it("dedupes when a sibling is BOTH a linked-issue overlap AND the copycat match — appears once, sorted by number", () => {
    const candidate = pr({ number: 9, linkedIssues: [1], copycatScore: 95, copycatMatchedPullNumber: 5 });
    const both = pr({ number: 5, linkedIssues: [1] });
    const other = pr({ number: 20, linkedIssues: [1] });
    const result = linkedIssueDuplicatePullRequestRecordsForGate(candidate, [other, both], "warn", 85);
    expect(result.map((p) => p.number)).toEqual([5, 20]);
  });

  it("linkedIssueDuplicatePullRequestsForGate mirrors the record helper, mapped to PR numbers, threading the copycat args through", () => {
    const candidate = pr({ number: 9, linkedIssues: [1], copycatScore: 95, copycatMatchedPullNumber: 12 });
    const sibling = pr({ number: 12, linkedIssues: [999] });
    expect(linkedIssueDuplicatePullRequestsForGate(candidate, [sibling], "warn", 85)).toEqual([12]);
    expect(linkedIssueDuplicatePullRequestsForGate(candidate, [sibling])).toEqual([]);
  });
});
