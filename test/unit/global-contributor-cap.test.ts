import { describe, expect, it } from "vitest";
import { resolveGlobalContributorOpenItemCap } from "../../src/settings/global-contributor-cap";
import { listOpenItemsForAuthorAcrossInstall, upsertIssueFromGitHub, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
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

describe("listOpenItemsForAuthorAcrossInstall (#2562)", () => {
  it("lists one author's open PRs + open issues across every repo THIS INSTALLATION tracks, excludes closed items/other authors/other installations, and matches case-insensitively", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo-a", full_name: "owner/repo-a", owner: { login: "owner" } }, 123);
    await upsertRepositoryFromGitHub(env, { name: "repo-b", full_name: "owner/repo-b", owner: { login: "owner" } }, 123);
    // farmer99's open items, spread across TWO different repos this install (123) gates.
    await upsertPullRequestFromGitHub(env, "owner/repo-a", { number: 1, title: "PR one", state: "open", user: { login: "farmer99" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "owner/repo-b", { number: 2, title: "PR two", state: "open", user: { login: "farmer99" }, labels: [], body: "y" });
    await upsertIssueFromGitHub(env, "owner/repo-a", { number: 3, title: "Issue one", state: "open", user: { login: "farmer99" }, labels: [], body: "z" });
    // A CLOSED item from farmer99 — must be excluded.
    await upsertPullRequestFromGitHub(env, "owner/repo-b", { number: 4, title: "PR three (closed)", state: "closed", user: { login: "farmer99" }, labels: [], body: "w" });
    // An OPEN item from a DIFFERENT author — must be excluded.
    await upsertIssueFromGitHub(env, "owner/repo-a", { number: 5, title: "Someone else's issue", state: "open", user: { login: "other-author" }, labels: [], body: "v" });
    // Gate finding (#2562): an open item from farmer99 on a repo belonging to a DIFFERENT installation, in the
    // SAME D1 database, must be excluded -- this is exactly the cross-installation boundary the fix enforces.
    await upsertRepositoryFromGitHub(env, { name: "other-install-repo", full_name: "other-owner/other-install-repo", owner: { login: "other-owner" } }, 456);
    await upsertPullRequestFromGitHub(env, "other-owner/other-install-repo", { number: 6, title: "Farmer PR on a different installation", state: "open", user: { login: "farmer99" }, labels: [], body: "u" });

    // 2 open PRs + 1 open issue for farmer99, across repo-a and repo-b combined -- NOT the 4th, cross-install one.
    const rows = await listOpenItemsForAuthorAcrossInstall(env, 123, "farmer99");
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        { repoFullName: "owner/repo-a", number: 1, kind: "pull_request" },
        { repoFullName: "owner/repo-b", number: 2, kind: "pull_request" },
        { repoFullName: "owner/repo-a", number: 3, kind: "issue" },
      ]),
    );
    expect(rows.some((row) => row.repoFullName === "other-owner/other-install-repo")).toBe(false);
    // The OTHER installation sees only its own repo's item.
    expect(await listOpenItemsForAuthorAcrossInstall(env, 456, "farmer99")).toEqual([{ repoFullName: "other-owner/other-install-repo", number: 6, kind: "pull_request" }]);
    // Case-insensitive: a differently-cased login still matches the same rows.
    expect(await listOpenItemsForAuthorAcrossInstall(env, 123, "FARMER99")).toHaveLength(3);
    // An author with no open items anywhere lists nothing.
    expect(await listOpenItemsForAuthorAcrossInstall(env, 123, "nobody")).toEqual([]);
    // An installation with no repos registered at all lists nothing (never throws, never scans the whole DB).
    expect(await listOpenItemsForAuthorAcrossInstall(env, 999, "farmer99")).toEqual([]);
  });

  it("audits (never silently drops) when an author's open items across the install hit the list limit (#regate-review)", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo-a", full_name: "owner/repo-a", owner: { login: "owner" } }, 123);
    const LIMIT = 20_000;
    const now = new Date().toISOString();
    const prValues = Array.from({ length: LIMIT }, (_, i) => `('pr-${i}', 'owner/repo-a', ${i + 1}, 'PR ${i}', 'open', 'farmer99', '[]', '${now}', '${now}')`).join(",");
    await env.DB.prepare(
      `INSERT INTO pull_requests (id, repo_full_name, number, title, state, author_login, labels_json, created_at, updated_at) VALUES ${prValues}`,
    ).run();
    // Issue numbers also hit the limit — both the PR side AND the issue side of the truncation check must fire.
    const issueValues = Array.from({ length: LIMIT }, (_, i) => `('issue-${i}', 'owner/repo-a', ${i + 1}, 'Issue ${i}', 'open', 'farmer99', '[]', '${now}', '${now}')`).join(",");
    await env.DB.prepare(
      `INSERT INTO issues (id, repo_full_name, number, title, state, author_login, labels_json, created_at, updated_at) VALUES ${issueValues}`,
    ).run();

    const rows = await listOpenItemsForAuthorAcrossInstall(env, 123, "farmer99");
    expect(rows).toHaveLength(LIMIT * 2); // both PR and issue results truncated at the limit each, not silently fewer

    const audit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
      .bind("agent.global_open_item_cap.author_items_truncated", "farmer99@installation:123")
      .first<{ n: number }>();
    expect(audit?.n).toBe(2); // one row for the PR truncation, one for the issue truncation
  });

  it("audits when an installation's own repo set hits the list limit (#regate-review)", async () => {
    const env = createTestEnv();
    const LIMIT = 20_000;
    const now = new Date().toISOString();
    const values = Array.from({ length: LIMIT }, (_, i) => `('owner/repo-${i}', 'owner', 'repo-${i}', 123, '${now}', '${now}')`).join(",");
    await env.DB.prepare(
      `INSERT INTO repositories (full_name, owner, name, installation_id, created_at, updated_at) VALUES ${values}`,
    ).run();

    const rows = await listOpenItemsForAuthorAcrossInstall(env, 123, "nobody-in-particular");
    expect(rows).toEqual([]); // no open items for this author, but the repo-list truncation must still be audited

    const audit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
      .bind("agent.global_open_item_cap.repo_list_truncated", "installation:123")
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });
});
