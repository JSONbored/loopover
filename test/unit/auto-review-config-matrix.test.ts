// Consolidated `review.auto_review` round-trip and predicate-precedence matrix (#2071).
import { describe, expect, it } from "vitest";
import { decideReviewEligibility } from "../../src/review/review-eligibility";
import {
  EMPTY_AUTO_REVIEW_CONFIG,
  evaluateAutoReviewSkipReason,
  parseFocusManifest,
  reviewConfigToJson,
  type AutoReviewConfig,
  type AutoReviewEligibilityInput,
} from "../../src/signals/focus-manifest";

describe("review.auto_review parse ↔ reviewConfigToJson round-trip (#2071)", () => {
  it("omits auto_review when every field is the byte-identical default", () => {
    expect(reviewConfigToJson(parseFocusManifest({}).review)).toBeNull();
    expect(reviewConfigToJson(parseFocusManifest({ review: {} }).review)).toBeNull();
    expect(reviewConfigToJson(parseFocusManifest({ review: { auto_review: {} } }).review)).toBeNull();
  });

  const roundTripCases: Array<{ name: string; autoReview: Record<string, unknown> }> = [
    { name: "skip_drafts: true", autoReview: { skip_drafts: true } },
    { name: "skip_drafts: false", autoReview: { skip_drafts: false } },
    { name: "ignore_authors", autoReview: { ignore_authors: ["*[bot]", "dependabot[bot]"] } },
    { name: "ignore_title_keywords", autoReview: { ignore_title_keywords: ["WIP", "draft"] } },
    { name: "base_branches", autoReview: { base_branches: ["main", "release/**"] } },
    { name: "auto_pause_after_reviewed_commits", autoReview: { auto_pause_after_reviewed_commits: 3 } },
    {
      name: "all knobs together",
      autoReview: {
        skip_drafts: true,
        ignore_authors: ["*[bot]"],
        ignore_title_keywords: ["WIP"],
        base_branches: ["main"],
        auto_pause_after_reviewed_commits: 2,
      },
    },
  ];

  for (const testCase of roundTripCases) {
    it(`round-trips ${testCase.name}`, () => {
      const parsed = parseFocusManifest({ review: { auto_review: testCase.autoReview } });
      const json = reviewConfigToJson(parsed.review);
      expect(json).not.toBeNull();
      const reparsed = parseFocusManifest({ review: json as Record<string, unknown> });
      expect(reparsed.review.autoReview).toEqual(parsed.review.autoReview);
      expect(reviewConfigToJson(reparsed.review)).toEqual(json);
    });
  }
});

describe("evaluateAutoReviewSkipReason predicate precedence (#2071)", () => {
  const allTriggers: AutoReviewEligibilityInput = {
    isDraft: true,
    author: "dependabot[bot]",
    title: "WIP: bump deps",
    baseRef: "develop",
    reviewedCommitCount: 5,
  };

  const allConfigured: AutoReviewConfig = {
    skipDrafts: true,
    ignoreAuthors: ["*[bot]"],
    ignoreTitleKeywords: ["wip"],
    baseBranches: ["main"],
    autoPauseAfterReviewedCommits: 1,
  };

  const precedenceCases: Array<{
    name: string;
    config: AutoReviewConfig;
    input: AutoReviewEligibilityInput;
    reason: string | null;
  }> = [
    {
      name: "draft wins when every predicate would match",
      config: allConfigured,
      input: allTriggers,
      reason: "review skipped (draft)",
    },
    {
      name: "ignored author when draft filter is off",
      config: { ...allConfigured, skipDrafts: false },
      input: { ...allTriggers, isDraft: false },
      reason: "review skipped (ignored author)",
    },
    {
      name: "WIP title when draft and author filters are off",
      config: { ...allConfigured, skipDrafts: false, ignoreAuthors: [] },
      input: { ...allTriggers, isDraft: false, author: "alice" },
      reason: "review skipped (WIP title)",
    },
    {
      name: "base branch when earlier filters are off",
      config: { ...allConfigured, skipDrafts: false, ignoreAuthors: [], ignoreTitleKeywords: [] },
      input: { ...allTriggers, isDraft: false, author: "alice", title: "chore: bump" },
      reason: "review skipped (base branch out of scope)",
    },
    {
      name: "commit threshold when earlier filters are off",
      config: {
        ...EMPTY_AUTO_REVIEW_CONFIG,
        autoPauseAfterReviewedCommits: 2,
      },
      input: { ...allTriggers, isDraft: false, author: "alice", title: "feat", baseRef: "main", reviewedCommitCount: 2 },
      reason: "review paused (commit threshold)",
    },
    {
      name: "eligible when every configured filter is off or non-matching",
      config: allConfigured,
      input: {
        isDraft: false,
        author: "alice",
        title: "feat: add widget",
        baseRef: "main",
        reviewedCommitCount: 0,
      },
      reason: null,
    },
  ];

  for (const testCase of precedenceCases) {
    it(testCase.name, () => {
      expect(evaluateAutoReviewSkipReason(testCase.config, testCase.input)).toBe(testCase.reason);
    });
  }
});

describe("decideReviewEligibility aligns with auto_review ignore_authors (#2071)", () => {
  const cases: Array<{ authorLogin: string; ignoreAuthors: string[]; eligible: boolean }> = [
    { authorLogin: "dependabot[bot]", ignoreAuthors: ["*[bot]"], eligible: false },
    { authorLogin: "alice", ignoreAuthors: ["*[bot]"], eligible: true },
    { authorLogin: "renovate", ignoreAuthors: ["renovate", "dependabot"], eligible: false },
    { authorLogin: "", ignoreAuthors: ["*"], eligible: true },
  ];

  for (const testCase of cases) {
    it(`${testCase.authorLogin || "(blank)"} with [${testCase.ignoreAuthors.join(", ")}]`, () => {
      const decision = decideReviewEligibility({
        authorLogin: testCase.authorLogin,
        ignoreAuthors: testCase.ignoreAuthors,
      });
      expect(decision.eligible).toBe(testCase.eligible);
      if (!testCase.eligible) {
        expect(decision.skipReason).toBe("ignored_author");
      }
    });
  }
});
