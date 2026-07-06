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
    { name: "skip_labels", autoReview: { skip_labels: ["do-not-review", "wip"] } },
    { name: "skip_docs_only: true", autoReview: { skip_docs_only: true } },
    { name: "skip_docs_only: false", autoReview: { skip_docs_only: false } },
    { name: "max_added_lines", autoReview: { max_added_lines: 500 } },
    { name: "max_files", autoReview: { max_files: 25 } },
    { name: "base_branches", autoReview: { base_branches: ["main", "release/**"] } },
    { name: "auto_pause_after_reviewed_commits", autoReview: { auto_pause_after_reviewed_commits: 3 } },
    {
      name: "all knobs together",
      autoReview: {
        skip_drafts: true,
        ignore_authors: ["*[bot]"],
        ignore_title_keywords: ["WIP"],
        skip_labels: ["do-not-review"],
        skip_docs_only: true,
        max_added_lines: 500,
        max_files: 25,
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

describe("review.auto_review malformed config (#2071)", () => {
  it("warns and resets on a non-mapping auto_review value", () => {
    const bad = parseFocusManifest({ review: { auto_review: "nope" } });
    expect(bad.review.autoReview).toEqual({ ...EMPTY_AUTO_REVIEW_CONFIG });
    expect(bad.warnings.some((w) => /auto_review.*must be a mapping/.test(w))).toBe(true);
    expect(decideReviewEligibility({ authorLogin: "renovate", ignoreAuthors: bad.review.autoReview.ignoreAuthors })).toEqual({
      eligible: true,
      skipReason: null,
      matchedPattern: null,
    });
  });

  it("warns on non-list ignore_authors and keeps defaults byte-identical", () => {
    const bad = parseFocusManifest({ review: { auto_review: { ignore_authors: "dependabot" } } });
    expect(bad.review.autoReview.ignoreAuthors).toEqual([]);
    expect(bad.warnings.some((w) => /ignore_authors.*must be a list/.test(w))).toBe(true);
  });

  it("warns on negative auto_pause_after_reviewed_commits and drops the knob", () => {
    const bad = parseFocusManifest({ review: { auto_review: { auto_pause_after_reviewed_commits: -1 } } });
    expect(bad.review.autoReview.autoPauseAfterReviewedCommits).toBeNull();
    expect(bad.warnings.some((w) => /auto_pause_after_reviewed_commits.*non-negative integer/.test(w))).toBe(true);
  });
});

describe("evaluateAutoReviewSkipReason predicate precedence (#2071)", () => {
  const allTriggers: AutoReviewEligibilityInput = {
    isDraft: true,
    author: "dependabot[bot]",
    title: "WIP: bump deps",
    labels: [],
    changedPaths: [],
    addedLineCount: 0,
    changedFileCount: 0,
    baseRef: "develop",
    reviewedCommitCount: 5,
  };

  const allConfigured: AutoReviewConfig = {
    ...EMPTY_AUTO_REVIEW_CONFIG,
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
      name: "skip label when earlier filters are off",
      config: { ...allConfigured, skipDrafts: false, ignoreAuthors: [], ignoreTitleKeywords: [], skipLabels: ["do-not-review"] },
      input: { ...allTriggers, isDraft: false, author: "alice", title: "feat: widget", labels: ["Do-Not-Review"] },
      reason: "review skipped (label)",
    },
    {
      name: "docs only when earlier filters are off",
      config: { ...allConfigured, skipDrafts: false, ignoreAuthors: [], ignoreTitleKeywords: [], skipDocsOnly: true },
      input: { ...allTriggers, isDraft: false, author: "alice", title: "docs: readme", changedPaths: ["README.md"] },
      reason: "review skipped (docs only)",
    },
    {
      name: "too large when added-line cap exceeded and earlier filters are off",
      config: { ...allConfigured, skipDrafts: false, ignoreAuthors: [], ignoreTitleKeywords: [], skipDocsOnly: false, maxAddedLines: 10 },
      input: { ...allTriggers, isDraft: false, author: "alice", title: "feat", baseRef: "main", addedLineCount: 11 },
      reason: "review skipped (too large)",
    },
    {
      name: "too large when changed-file cap exceeded and earlier filters are off",
      config: { ...allConfigured, skipDrafts: false, ignoreAuthors: [], ignoreTitleKeywords: [], skipDocsOnly: false, maxFiles: 2 },
      input: { ...allTriggers, isDraft: false, author: "alice", title: "feat", baseRef: "main", changedFileCount: 3 },
      reason: "review skipped (too large)",
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
        labels: [],
        changedPaths: [],
        addedLineCount: 0,
        changedFileCount: 0,
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
      } else {
        expect(decision.skipReason).toBeNull();
        expect(decision.matchedPattern).toBeNull();
      }
    });
  }
});
