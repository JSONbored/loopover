import { describe, expect, it } from "vitest";
import { isConvergenceRepoAllowed } from "../../src/review/cutover-gate";

describe("isConvergenceRepoAllowed — per-repo review allowlist", () => {
  it("empty / unset / whitespace-only allowlist → false for every repo (the dormant default)", () => {
    expect(isConvergenceRepoAllowed({}, "JSONbored/gittensory")).toBe(false);
    expect(isConvergenceRepoAllowed({ GITTENSORY_REVIEW_REPOS: undefined }, "JSONbored/gittensory")).toBe(false);
    expect(isConvergenceRepoAllowed({ GITTENSORY_REVIEW_REPOS: "" }, "JSONbored/gittensory")).toBe(false);
    expect(isConvergenceRepoAllowed({ GITTENSORY_REVIEW_REPOS: "   " }, "JSONbored/gittensory")).toBe(false);
    expect(isConvergenceRepoAllowed({ GITTENSORY_REVIEW_REPOS: " , ,, " }, "JSONbored/gittensory")).toBe(false);
  });

  it("activates a listed repo (exact owner/repo match)", () => {
    expect(isConvergenceRepoAllowed({ GITTENSORY_REVIEW_REPOS: "JSONbored/gittensory" }, "JSONbored/gittensory")).toBe(true);
  });

  it("does NOT activate an unlisted repo", () => {
    expect(isConvergenceRepoAllowed({ GITTENSORY_REVIEW_REPOS: "JSONbored/gittensory" }, "JSONbored/awesome-claude")).toBe(false);
  });

  it("is case-insensitive (GitHub repo full-names are case-insensitive)", () => {
    expect(isConvergenceRepoAllowed({ GITTENSORY_REVIEW_REPOS: "JSONbored/Gittensory" }, "jsonbored/gittensory")).toBe(true);
    expect(isConvergenceRepoAllowed({ GITTENSORY_REVIEW_REPOS: "jsonbored/gittensory" }, "JSONbored/GITTENSORY")).toBe(true);
  });

  it("handles a multi-repo list with surrounding whitespace + stray commas", () => {
    const env = { GITTENSORY_REVIEW_REPOS: " JSONbored/gittensory , JSONbored/awesome-claude ,, " };
    expect(isConvergenceRepoAllowed(env, "JSONbored/gittensory")).toBe(true);
    expect(isConvergenceRepoAllowed(env, "JSONbored/awesome-claude")).toBe(true);
    expect(isConvergenceRepoAllowed(env, "JSONbored/metagraphed")).toBe(false);
  });

  it("an empty / whitespace `repoFullName` never matches", () => {
    expect(isConvergenceRepoAllowed({ GITTENSORY_REVIEW_REPOS: "JSONbored/gittensory" }, "")).toBe(false);
    expect(isConvergenceRepoAllowed({ GITTENSORY_REVIEW_REPOS: "JSONbored/gittensory" }, "   ")).toBe(false);
  });

  it("requires a FULL owner/repo match (a bare owner or partial does not match)", () => {
    const env = { GITTENSORY_REVIEW_REPOS: "JSONbored/gittensory" };
    expect(isConvergenceRepoAllowed(env, "JSONbored")).toBe(false);
    expect(isConvergenceRepoAllowed(env, "gittensory")).toBe(false);
    expect(isConvergenceRepoAllowed(env, "JSONbored/gittensory-ui")).toBe(false);
  });
});
