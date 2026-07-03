import { describe, expect, it } from "vitest";
import { resolveGlobalContributorOpenItemCap } from "../../src/settings/global-contributor-cap";
import { countOpenItemsForAuthorAcrossRepos, upsertIssueFromGitHub, upsertPullRequestFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("resolveGlobalContributorOpenItemCap (#2562)", () => {
  it("is off by default when the env var is unset", () => {
    expect(resolveGlobalContributorOpenItemCap({})).toBeNull();
    expect(resolveGlobalContributorOpenItemCap({ GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: undefined })).toBeNull();
  });

  it("parses a valid positive-integer string", () => {
    expect(resolveGlobalContributorOpenItemCap({ GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "20" })).toBe(20);
    expect(resolveGlobalContributorOpenItemCap({ GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "1" })).toBe(1);
  });

  it("drops a fractional/non-positive/non-numeric value to null (no cap), never coerced", () => {
    expect(resolveGlobalContributorOpenItemCap({ GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "2.5" })).toBeNull();
    expect(resolveGlobalContributorOpenItemCap({ GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "0" })).toBeNull();
    expect(resolveGlobalContributorOpenItemCap({ GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "-3" })).toBeNull();
    expect(resolveGlobalContributorOpenItemCap({ GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "not-a-number" })).toBeNull();
    expect(resolveGlobalContributorOpenItemCap({ GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "" })).toBeNull();
    expect(resolveGlobalContributorOpenItemCap({ GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP: "   " })).toBeNull();
  });
});

describe("countOpenItemsForAuthorAcrossRepos (#2562)", () => {
  it("sums open PRs + open issues for one author across EVERY repo in the database, not just one", async () => {
    const env = createTestEnv();
    await upsertPullRequestFromGitHub(env, "org/repo-a", { number: 1, title: "a1", state: "open", user: { login: "farmer99" } });
    await upsertPullRequestFromGitHub(env, "org/repo-b", { number: 2, title: "b1", state: "open", user: { login: "farmer99" } });
    await upsertIssueFromGitHub(env, "org/repo-c", { number: 3, title: "c1", state: "open", user: { login: "farmer99" } });
    // A closed item and a different author's item must NOT count toward the total.
    await upsertPullRequestFromGitHub(env, "org/repo-a", { number: 4, title: "a2 (closed)", state: "closed", user: { login: "farmer99" } });
    await upsertPullRequestFromGitHub(env, "org/repo-a", { number: 5, title: "a3 (other author)", state: "open", user: { login: "someone-else" } });

    expect(await countOpenItemsForAuthorAcrossRepos(env, "farmer99")).toBe(3);
  });

  it("is case-insensitive on the author login (mirrors loginMatches/findBlacklistEntry elsewhere)", async () => {
    const env = createTestEnv();
    await upsertPullRequestFromGitHub(env, "org/repo-a", { number: 1, title: "a1", state: "open", user: { login: "Farmer99" } });
    expect(await countOpenItemsForAuthorAcrossRepos(env, "farmer99")).toBe(1);
    expect(await countOpenItemsForAuthorAcrossRepos(env, "FARMER99")).toBe(1);
  });

  it("returns 0 for an author with no open items anywhere", async () => {
    const env = createTestEnv();
    expect(await countOpenItemsForAuthorAcrossRepos(env, "nobody")).toBe(0);
  });
});
