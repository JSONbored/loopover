import { describe, expect, it } from "vitest";
import { resolveCopycatDuplicateSibling } from "../../src/signals/copycat-duplicate";
import type { PullRequestRecord } from "../../src/types";

function openPr(number: number): PullRequestRecord {
  return { repoFullName: "acme/widgets", number, title: `PR ${number}`, state: "open", labels: [], linkedIssues: [] };
}

// #9033: resolveCopycatDuplicateSibling is the bridge between the copycat containment engine's persisted
// per-PR verdict and the duplicate-cluster election, which otherwise never learns about a cross-issue content
// match at all.
describe("resolveCopycatDuplicateSibling (#9033)", () => {
  it("returns undefined when copycatGateMode is off, even with a high score and a real matched PR", () => {
    const pr = { copycatScore: 95, copycatMatchedPullNumber: 12 };
    expect(resolveCopycatDuplicateSibling(pr, [openPr(12)], "off", null)).toBeUndefined();
  });

  it("returns undefined when copycatGateMode is undefined (absent-means-off convention)", () => {
    const pr = { copycatScore: 95, copycatMatchedPullNumber: 12 };
    expect(resolveCopycatDuplicateSibling(pr, [openPr(12)], undefined, null)).toBeUndefined();
  });

  it("returns undefined when there is no matched PR at all", () => {
    const pr = { copycatScore: 0, copycatMatchedPullNumber: null };
    expect(resolveCopycatDuplicateSibling(pr, [openPr(12)], "warn", null)).toBeUndefined();
  });

  it("returns undefined when the score is below the resolved threshold", () => {
    const pr = { copycatScore: 40, copycatMatchedPullNumber: 12 };
    expect(resolveCopycatDuplicateSibling(pr, [openPr(12)], "warn", 85)).toBeUndefined();
  });

  it("returns the matched sibling when the score clears the threshold under warn mode", () => {
    const pr = { copycatScore: 90, copycatMatchedPullNumber: 12 };
    const sibling = openPr(12);
    expect(resolveCopycatDuplicateSibling(pr, [sibling], "warn", 85)).toBe(sibling);
  });

  it("returns the matched sibling when the score clears the threshold under label/block mode too", () => {
    const pr = { copycatScore: 90, copycatMatchedPullNumber: 12 };
    const sibling = openPr(12);
    expect(resolveCopycatDuplicateSibling(pr, [sibling], "label", 85)).toBe(sibling);
    expect(resolveCopycatDuplicateSibling(pr, [sibling], "block", 85)).toBe(sibling);
  });

  it("returns undefined when the matched PR number does not correspond to a still-OPEN sibling (e.g. it was a merged-PR match)", () => {
    const pr = { copycatScore: 95, copycatMatchedPullNumber: 999 };
    expect(resolveCopycatDuplicateSibling(pr, [openPr(12)], "warn", 85)).toBeUndefined();
  });

  it("falls back to the engine default threshold (85) when copycatGateMinScore is null", () => {
    const highEnough = { copycatScore: 85, copycatMatchedPullNumber: 12 };
    const tooLow = { copycatScore: 84, copycatMatchedPullNumber: 12 };
    const sibling = openPr(12);
    expect(resolveCopycatDuplicateSibling(highEnough, [sibling], "warn", null)).toBe(sibling);
    expect(resolveCopycatDuplicateSibling(tooLow, [sibling], "warn", null)).toBeUndefined();
  });
});
