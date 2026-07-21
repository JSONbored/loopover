import { describe, expect, it } from "vitest";

import {
  buildSettingsPreviewRequest,
  extractPreviewRepoOptions,
  findPreviewScenario,
  parseLinkedIssues,
  parsePreviewLabels,
  PREVIEW_SCENARIOS,
  splitRepoFullName,
  splitReviewabilityPr,
  type PreviewFormState,
} from "@/lib/maintainer-settings-preview";

describe("splitRepoFullName", () => {
  it("accepts a well-formed owner/repo pair", () => {
    expect(splitRepoFullName("acme/repo")).toEqual({ owner: "acme", repo: "repo" });
  });

  it("trims surrounding whitespace before splitting", () => {
    expect(splitRepoFullName("  acme/repo  ")).toEqual({ owner: "acme", repo: "repo" });
  });

  // Regression (#7783): the old `[owner, repo, extra]` destructuring only looked at the 3rd segment,
  // so any input whose 3rd `/`-segment was empty slipped through as a truncated owner/repo pair.
  it("rejects a trailing slash instead of silently truncating", () => {
    expect(splitRepoFullName("acme/repo/")).toBeNull();
  });

  it("rejects a double slash with a trailing segment", () => {
    expect(splitRepoFullName("acme/repo//x")).toBeNull();
  });

  it("rejects a pasted stale-copy suffix that the old guard accepted", () => {
    expect(splitRepoFullName("owner/repo//stale-copy")).toBeNull();
  });

  it("rejects any input with more than two segments", () => {
    expect(splitRepoFullName("a/b/c")).toBeNull();
    expect(splitRepoFullName("a/b/c/d")).toBeNull();
  });

  it("rejects fewer than two segments", () => {
    expect(splitRepoFullName("acme")).toBeNull();
    expect(splitRepoFullName("")).toBeNull();
    expect(splitRepoFullName("   ")).toBeNull();
  });

  it("rejects an empty owner or empty repo segment", () => {
    expect(splitRepoFullName("/repo")).toBeNull();
    expect(splitRepoFullName("acme/")).toBeNull();
    expect(splitRepoFullName("/")).toBeNull();
  });
});

describe("splitReviewabilityPr", () => {
  it("parses owner/repo#number into its parts", () => {
    expect(splitReviewabilityPr("acme/repo#123")).toEqual({
      owner: "acme",
      repo: "repo",
      number: 123,
    });
  });

  it("inherits splitRepoFullName's stricter validation for the repo half", () => {
    expect(splitReviewabilityPr("acme/repo//stale#123")).toBeNull();
  });

  it("rejects a missing, zero, negative, or non-integer issue number", () => {
    expect(splitReviewabilityPr("acme/repo")).toBeNull();
    expect(splitReviewabilityPr("acme/repo#0")).toBeNull();
    expect(splitReviewabilityPr("acme/repo#-1")).toBeNull();
    expect(splitReviewabilityPr("acme/repo#1.5")).toBeNull();
  });
});

describe("extractPreviewRepoOptions", () => {
  it("returns unique, sorted, well-formed repos and drops malformed rows", () => {
    expect(
      extractPreviewRepoOptions([
        { pr: "beta/two#5" },
        { pr: "alpha/one#1" },
        { pr: "alpha/one#2" },
        { pr: "not-a-repo#3" },
        { pr: "has space/repo#4" },
      ]),
    ).toEqual(["alpha/one", "beta/two"]);
  });
});

describe("parsePreviewLabels", () => {
  it("splits on commas, trims, drops blanks, and de-duplicates case-insensitively", () => {
    expect(parsePreviewLabels(" bug , Bug ,, feature ")).toEqual(["bug", "feature"]);
  });

  it("caps the result at 50 labels", () => {
    const many = Array.from({ length: 60 }, (_, index) => `label-${index}`).join(",");
    expect(parsePreviewLabels(many)).toHaveLength(50);
  });
});

describe("parseLinkedIssues", () => {
  it("parses hash-prefixed and whitespace/comma-separated positive integers, de-duplicated", () => {
    expect(parseLinkedIssues("#12, 34 12  56")).toEqual([12, 34, 56]);
  });

  it("drops zero, negative, and non-numeric tokens", () => {
    expect(parseLinkedIssues("#0, -3, abc, 7")).toEqual([7]);
  });
});

describe("findPreviewScenario", () => {
  it("returns the matching scenario", () => {
    expect(findPreviewScenario("bot-author").id).toBe("bot-author");
  });

  it("falls back to the first scenario for an unknown id", () => {
    expect(findPreviewScenario("nope" as never)).toBe(PREVIEW_SCENARIOS[0]);
  });
});

describe("buildSettingsPreviewRequest", () => {
  const baseForm: PreviewFormState = {
    repoFullName: "acme/repo",
    scenarioId: "confirmed-miner",
    title: "  My PR  ",
    labels: "bug, feature",
    linkedIssues: "#1 2",
    body: "  hello  ",
  };

  it("assembles the sample from the scenario, trimmed title/body, and parsed labels/issues", () => {
    expect(buildSettingsPreviewRequest(baseForm)).toEqual({
      sample: {
        authorLogin: "sample-miner",
        authorType: "User",
        authorAssociation: "CONTRIBUTOR",
        minerStatus: "confirmed",
        title: "My PR",
        labels: ["bug", "feature"],
        linkedIssues: [1, 2],
        body: "hello",
      },
    });
  });

  it("defaults a blank title and omits an empty body", () => {
    const result = buildSettingsPreviewRequest({ ...baseForm, title: "   ", body: "   " });
    expect(result.sample.title).toBe("Sample pull request");
    expect(result.sample).not.toHaveProperty("body");
  });
});
