import { describe, expect, it } from "vitest";
import { __contributorOpenPrMonitorInternals } from "../../src/signals/contributor-open-pr-monitor";
import type { PullRequestRecord } from "../../src/types";

function pr(number: number, title: string, labels: string[] = []): PullRequestRecord {
  return {
    repoFullName: "acme/widgets",
    number,
    title,
    state: "open",
    authorLogin: "contributor",
    labels,
    linkedIssues: [],
  } as PullRequestRecord;
}

describe("duplicate-prone title grouping", () => {
  it("does not group unrelated titles whose normalized form is empty", () => {
    const flagged = __contributorOpenPrMonitorInternals.duplicatePronePullNumbers([pr(1, "..."), pr(2, "🎉🎉🎉")]);
    expect([...flagged]).toEqual([]);
  });

  it("still groups matching non-empty normalized titles", () => {
    const flagged = __contributorOpenPrMonitorInternals.duplicatePronePullNumbers([pr(3, "Fix bug"), pr(4, "fix   bug!!")]);
    expect([...flagged].sort((a, b) => a - b)).toEqual([3, 4]);
  });

  it("still flags explicit wip and duplicate labels", () => {
    const flagged = __contributorOpenPrMonitorInternals.duplicatePronePullNumbers([pr(5, "...", ["wip"]), pr(6, "🎉", ["duplicate"])]);
    expect([...flagged].sort((a, b) => a - b)).toEqual([5, 6]);
  });
});
