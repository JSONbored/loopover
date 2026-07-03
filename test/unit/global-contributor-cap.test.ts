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
  it("lists open PRs + open issues for one author across EVERY repo THIS INSTALLATION tracks, not just one", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo-a", full_name: "org/repo-a", owner: { login: "org" } }, 123);
    await upsertRepositoryFromGitHub(env, { name: "repo-b", full_name: "org/repo-b", owner: { login: "org" } }, 123);
    await upsertRepositoryFromGitHub(env, { name: "repo-c", full_name: "org/repo-c", owner: { login: "org" } }, 123);
    await upsertPullRequestFromGitHub(env, "org/repo-a", { number: 1, title: "a1", state: "open", user: { login: "farmer99" } });
    await upsertPullRequestFromGitHub(env, "org/repo-b", { number: 2, title: "b1", state: "open", user: { login: "farmer99" } });
    await upsertIssueFromGitHub(env, "org/repo-c", { number: 3, title: "c1", state: "open", user: { login: "farmer99" } });
    // A closed item and a different author's item must NOT count toward the total.
    await upsertPullRequestFromGitHub(env, "org/repo-a", { number: 4, title: "a2 (closed)", state: "closed", user: { login: "farmer99" } });
    await upsertPullRequestFromGitHub(env, "org/repo-a", { number: 5, title: "a3 (other author)", state: "open", user: { login: "someone-else" } });

    const rows = await listOpenItemsForAuthorAcrossInstall(env, 123, "farmer99");
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        { repoFullName: "org/repo-a", number: 1, kind: "pull_request" },
        { repoFullName: "org/repo-b", number: 2, kind: "pull_request" },
        { repoFullName: "org/repo-c", number: 3, kind: "issue" },
      ]),
    );
  });

  it("is case-insensitive on the author login (mirrors loginMatches/findBlacklistEntry elsewhere)", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo-a", full_name: "org/repo-a", owner: { login: "org" } }, 123);
    await upsertPullRequestFromGitHub(env, "org/repo-a", { number: 1, title: "a1", state: "open", user: { login: "Farmer99" } });
    expect(await listOpenItemsForAuthorAcrossInstall(env, 123, "farmer99")).toHaveLength(1);
    expect(await listOpenItemsForAuthorAcrossInstall(env, 123, "FARMER99")).toHaveLength(1);
  });

  it("returns [] for an author with no open items anywhere", async () => {
    const env = createTestEnv();
    expect(await listOpenItemsForAuthorAcrossInstall(env, 123, "nobody")).toEqual([]);
  });

  it("returns [] for an installation that tracks no repos yet (gate finding: no repoNames means no rows to scope against, not an unscoped fetch-everything)", async () => {
    const env = createTestEnv();
    expect(await listOpenItemsForAuthorAcrossInstall(env, 999, "farmer99")).toEqual([]);
  });

  it("REGRESSION (cross-tenant leak fix): an author's open items on a DIFFERENT installation do not count toward this installation's cap, even though both installations share the same D1 database", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo-a", full_name: "org-a/repo-a", owner: { login: "org-a" } }, 123);
    await upsertRepositoryFromGitHub(env, { name: "repo-b", full_name: "org-b/repo-b", owner: { login: "org-b" } }, 456);
    // farmer99 has open items on BOTH installations -- only installation 123's own item may count toward 123's cap.
    await upsertPullRequestFromGitHub(env, "org-a/repo-a", { number: 1, title: "a1", state: "open", user: { login: "farmer99" } });
    await upsertPullRequestFromGitHub(env, "org-b/repo-b", { number: 2, title: "b1", state: "open", user: { login: "farmer99" } });
    await upsertIssueFromGitHub(env, "org-b/repo-b", { number: 3, title: "b2", state: "open", user: { login: "farmer99" } });

    expect(await listOpenItemsForAuthorAcrossInstall(env, 123, "farmer99")).toHaveLength(1);
    expect(await listOpenItemsForAuthorAcrossInstall(env, 456, "farmer99")).toHaveLength(2);
  });

  it("audits (never silently drops) when an installation's own repo set hits the list limit (gate finding)", async () => {
    const env = createTestEnv();
    const LIMIT = 20_000;
    const now = new Date().toISOString();
    const values = Array.from({ length: LIMIT }, (_, i) => `('org/repo-${i}', 'org', 'repo-${i}', 123, '${now}', '${now}')`).join(",");
    await env.DB.prepare(`INSERT INTO repositories (full_name, owner, name, installation_id, created_at, updated_at) VALUES ${values}`).run();
    await upsertPullRequestFromGitHub(env, "org/repo-0", { number: 1, title: "a1", state: "open", user: { login: "farmer99" } });

    expect(await listOpenItemsForAuthorAcrossInstall(env, 123, "farmer99")).toHaveLength(1);

    const audit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
      .bind("agent.global_open_item_cap.repo_list_truncated", "installation:123")
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("does NOT audit a repo-list truncation when the installation's repo count is well under the limit", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo-a", full_name: "org/repo-a", owner: { login: "org" } }, 123);

    expect(await listOpenItemsForAuthorAcrossInstall(env, 123, "farmer99")).toEqual([]);

    const audit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.global_open_item_cap.repo_list_truncated'").first<{ n: number }>();
    expect(audit?.n ?? 0).toBe(0);
  });

  // #2562 gate-review follow-up: an author's open items across the install hit the AUTHOR_OPEN_ITEM_LIST_LIMIT
  // truncation guard (distinct from the repo-list limit above).
  it("audits (never silently drops) when an author's open items across the install hit the list limit", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo-a", full_name: "org/repo-a", owner: { login: "org" } }, 123);
    const LIMIT = 20_000;
    const now = new Date().toISOString();
    const prValues = Array.from({ length: LIMIT }, (_, i) => `('pr-${i}', 'org/repo-a', ${i + 1}, 'PR ${i}', 'open', 'farmer99', '[]', '${now}', '${now}')`).join(",");
    await env.DB.prepare(`INSERT INTO pull_requests (id, repo_full_name, number, title, state, author_login, labels_json, created_at, updated_at) VALUES ${prValues}`).run();

    const rows = await listOpenItemsForAuthorAcrossInstall(env, 123, "farmer99");
    expect(rows).toHaveLength(LIMIT);

    const audit = await env.DB.prepare("select count(*) as n from audit_events where event_type = ? and target_key = ?")
      .bind("agent.global_open_item_cap.author_items_truncated", "farmer99@installation:123")
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });
});
