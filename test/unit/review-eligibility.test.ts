import { describe, expect, it } from "vitest";
import { decideReviewEligibility } from "../../src/review/review-eligibility";

describe("decideReviewEligibility", () => {
  it("keeps authors eligible when no ignore list is configured", () => {
    expect(decideReviewEligibility({ authorLogin: "dependabot[bot]" })).toEqual({
      eligible: true,
      skipReason: null,
      matchedPattern: null,
    });
    expect(decideReviewEligibility({ authorLogin: "renovate", ignoreAuthors: [] })).toEqual({
      eligible: true,
      skipReason: null,
      matchedPattern: null,
    });
  });

  it("keeps missing or blank authors eligible for the caller's existing missing-author handling", () => {
    for (const authorLogin of [null, undefined, "", "   "]) {
      expect(decideReviewEligibility({ authorLogin, ignoreAuthors: ["*"] })).toEqual({
        eligible: true,
        skipReason: null,
        matchedPattern: null,
      });
    }
  });

  it("matches exact login globs case-insensitively", () => {
    expect(decideReviewEligibility({ authorLogin: "Dependabot", ignoreAuthors: ["dependabot"] })).toEqual({
      eligible: false,
      skipReason: "ignored_author",
      matchedPattern: "dependabot",
    });
    expect(decideReviewEligibility({ authorLogin: "renovate", ignoreAuthors: ["DEPENDABOT", "RENOVATE"] })).toEqual({
      eligible: false,
      skipReason: "ignored_author",
      matchedPattern: "RENOVATE",
    });
  });

  it("matches bracketed bot logins with manifest glob semantics", () => {
    expect(decideReviewEligibility({ authorLogin: "dependabot[bot]", ignoreAuthors: ["*[bot]"] })).toMatchObject({
      eligible: false,
      skipReason: "ignored_author",
      matchedPattern: "*[bot]",
    });
    expect(decideReviewEligibility({ authorLogin: "renovate[bot]", ignoreAuthors: ["renovate*"] })).toMatchObject({
      eligible: false,
      skipReason: "ignored_author",
      matchedPattern: "renovate*",
    });
  });

  it("uses ordered multi-star matching instead of a regular expression", () => {
    expect(decideReviewEligibility({ authorLogin: "renovate-release-bot", ignoreAuthors: ["ren*release*bot"] })).toMatchObject({
      eligible: false,
      matchedPattern: "ren*release*bot",
    });
    expect(decideReviewEligibility({ authorLogin: "release-renovate-bot", ignoreAuthors: ["ren*release*bot"] })).toEqual({
      eligible: true,
      skipReason: null,
      matchedPattern: null,
    });
  });

  it("trims configured patterns before matching and reporting", () => {
    expect(decideReviewEligibility({ authorLogin: "dependabot[bot]", ignoreAuthors: ["  dependabot*  "] })).toEqual({
      eligible: false,
      skipReason: "ignored_author",
      matchedPattern: "dependabot*",
    });
  });

  it("ignores blank patterns defensively", () => {
    expect(decideReviewEligibility({ authorLogin: "renovate", ignoreAuthors: ["", "   "] })).toEqual({
      eligible: true,
      skipReason: null,
      matchedPattern: null,
    });
  });

  it("returns the first matching pattern for diagnostics", () => {
    expect(decideReviewEligibility({ authorLogin: "renovate[bot]", ignoreAuthors: ["dependabot*", "*[bot]", "renovate*"] })).toEqual({
      eligible: false,
      skipReason: "ignored_author",
      matchedPattern: "*[bot]",
    });
  });

  it("treats a nullish ignore list as the default empty list", () => {
    expect(decideReviewEligibility({ authorLogin: "renovate", ignoreAuthors: null })).toEqual({
      eligible: true,
      skipReason: null,
      matchedPattern: null,
    });
    expect(decideReviewEligibility({ authorLogin: "renovate", ignoreAuthors: undefined })).toEqual({
      eligible: true,
      skipReason: null,
      matchedPattern: null,
    });
  });
});

describe("review eligibility glob matrix", () => {
  const cases: Array<{
    name: string;
    authorLogin: string;
    ignoreAuthors: string[];
    ignored: boolean;
    matchedPattern: string | null;
  }> = [
    { name: "exact bot", authorLogin: "dependabot", ignoreAuthors: ["dependabot"], ignored: true, matchedPattern: "dependabot" },
    { name: "exact mixed case", authorLogin: "Dependabot", ignoreAuthors: ["dependabot"], ignored: true, matchedPattern: "dependabot" },
    { name: "exact non-match", authorLogin: "dependabot-preview", ignoreAuthors: ["dependabot"], ignored: false, matchedPattern: null },
    { name: "suffix bot marker", authorLogin: "dependabot[bot]", ignoreAuthors: ["*[bot]"], ignored: true, matchedPattern: "*[bot]" },
    { name: "suffix marker case-folds", authorLogin: "Dependabot[Bot]", ignoreAuthors: ["*[bot]"], ignored: true, matchedPattern: "*[bot]" },
    { name: "prefix wildcard", authorLogin: "renovate-release", ignoreAuthors: ["renovate*"], ignored: true, matchedPattern: "renovate*" },
    { name: "prefix wildcard non-match", authorLogin: "my-renovate", ignoreAuthors: ["renovate*"], ignored: false, matchedPattern: null },
    { name: "suffix wildcard", authorLogin: "team-renovate", ignoreAuthors: ["*renovate"], ignored: true, matchedPattern: "*renovate" },
    { name: "suffix wildcard non-match", authorLogin: "renovate-team", ignoreAuthors: ["*renovate"], ignored: false, matchedPattern: null },
    { name: "middle wildcard", authorLogin: "app/github-actions", ignoreAuthors: ["app/*"], ignored: true, matchedPattern: "app/*" },
    { name: "globstar slash root", authorLogin: "renovate", ignoreAuthors: ["**/renovate"], ignored: true, matchedPattern: "**/renovate" },
    { name: "globstar slash nested", authorLogin: "apps/renovate", ignoreAuthors: ["**/renovate"], ignored: true, matchedPattern: "**/renovate" },
    { name: "ordered pieces", authorLogin: "bot-release-nightly", ignoreAuthors: ["bot*release*nightly"], ignored: true, matchedPattern: "bot*release*nightly" },
    { name: "ordered pieces reject reorder", authorLogin: "release-bot-nightly", ignoreAuthors: ["bot*release*nightly"], ignored: false, matchedPattern: null },
    { name: "first matching pattern wins", authorLogin: "github-actions[bot]", ignoreAuthors: ["dependabot*", "*[bot]", "github-actions*"], ignored: true, matchedPattern: "*[bot]" },
    { name: "blank before match", authorLogin: "renovate", ignoreAuthors: ["", "renovate"], ignored: true, matchedPattern: "renovate" },
    { name: "space before match", authorLogin: "renovate", ignoreAuthors: ["   ", " renovate "], ignored: true, matchedPattern: "renovate" },
    { name: "dash literal", authorLogin: "release-please[bot]", ignoreAuthors: ["release-please*"], ignored: true, matchedPattern: "release-please*" },
    { name: "underscore literal", authorLogin: "ci_bot", ignoreAuthors: ["ci_*"], ignored: true, matchedPattern: "ci_*" },
    { name: "dot literal", authorLogin: "github-actions.bot", ignoreAuthors: ["github-actions.*"], ignored: true, matchedPattern: "github-actions.*" },
    { name: "plus literal", authorLogin: "bot+deps", ignoreAuthors: ["bot+*"], ignored: true, matchedPattern: "bot+*" },
    { name: "regex meta stays literal", authorLogin: "botx", ignoreAuthors: ["bot."], ignored: false, matchedPattern: null },
    { name: "question mark stays literal", authorLogin: "bot1", ignoreAuthors: ["bot?"], ignored: false, matchedPattern: null },
    { name: "slash exact", authorLogin: "apps/renovate", ignoreAuthors: ["apps/renovate"], ignored: true, matchedPattern: "apps/renovate" },
    { name: "slash prefix", authorLogin: "apps/renovate/nightly", ignoreAuthors: ["apps/renovate"], ignored: true, matchedPattern: "apps/renovate" },
    { name: "slash prefix non-match", authorLogin: "apps/renovate-nightly", ignoreAuthors: ["apps/renovate"], ignored: false, matchedPattern: null },
    { name: "double star is collapsed wildcard", authorLogin: "bot-anything-here", ignoreAuthors: ["bot**here"], ignored: true, matchedPattern: "bot**here" },
    { name: "all wildcard", authorLogin: "alice", ignoreAuthors: ["*"], ignored: true, matchedPattern: "*" },
    { name: "single char with wildcard", authorLogin: "a", ignoreAuthors: ["*"], ignored: true, matchedPattern: "*" },
    { name: "empty effective list", authorLogin: "alice", ignoreAuthors: [], ignored: false, matchedPattern: null },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const decision = decideReviewEligibility({
        authorLogin: testCase.authorLogin,
        ignoreAuthors: testCase.ignoreAuthors,
      });
      expect(decision.eligible).toBe(!testCase.ignored);
      expect(decision.matchedPattern).toBe(testCase.matchedPattern);
      expect(decision.skipReason).toBe(testCase.ignored ? "ignored_author" : null);
    });
  }
});
