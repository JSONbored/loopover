import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWorkboard } from "../../src/api/workboard";
import { normalizeGittBountySnapshot } from "../../src/bounties/ingest";
import { clearPublicRepoStatsCacheForTests, fetchPublicContributorProfile, fetchPublicRepoStats } from "../../src/github/public";
import { jsonString, normalizeRepoFullName, parseJson, repoParts } from "../../src/utils/json";
import type { IssueRecord, RepositoryRecord } from "../../src/types";

describe("small adapters and normalizers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps JSON helpers predictable on missing and malformed values", () => {
    expect(parseJson(undefined, { ok: true })).toEqual({ ok: true });
    expect(parseJson("{bad", ["fallback"])).toEqual(["fallback"]);
    expect(parseJson('{"ok":true}', { ok: false })).toEqual({ ok: true });
    expect(jsonString(undefined)).toBe("null");
    expect(normalizeRepoFullName(" owner/repo ")).toBe("owner/repo");
    expect(repoParts("owner/name/with/slash")).toEqual({ owner: "owner", name: "name/with/slash" });
    expect(repoParts("")).toEqual({ owner: "", name: "" });
  });

  it("normalizes gitt bounty snapshots and drops incomplete rows", () => {
    expect(normalizeGittBountySnapshot({})).toEqual([]);
    const records = normalizeGittBountySnapshot({
      success: true,
      issues: [
        {},
        {
          id: 33,
          repository_full_name: "JSONbored/gittensory",
          issue_number: 12,
          status: "Completed",
          bounty_amount: 0.5,
          target_bounty: 1,
          active: false,
          note: null,
          nested: { ignored: true },
        },
        {
          id: "35",
          repository_full_name: "JSONbored/gittensory",
          issue_number: 13,
          status: "Active",
          bounty_alpha: "1.2500",
        },
        { id: 34, repository_full_name: "JSONbored/gittensory", status: "Active" },
        { id: 36, repository_full_name: "JSONbored/gittensory", issue_number: 14, status: "Cancelled", active: undefined },
      ],
    });

    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ id: "33", amountText: "0.5", sourceUrl: "gitt://issues/33" });
    expect(records[0]?.payload).toMatchObject({ active: false, note: null, target_bounty: 1 });
    expect(records[0]?.payload).not.toHaveProperty("nested");
    expect(records[1]).toMatchObject({ id: "35", amountText: "1.2500", sourceUrl: "gitt://issues/35" });
    expect(records[2]).toMatchObject({ id: "36", amountText: undefined, sourceUrl: "gitt://issues/36" });
    expect(records[2]?.payload).not.toHaveProperty("active");
  });

  it("builds workboard holds and maintainer-authored context", () => {
    const repo: RepositoryRecord = {
      fullName: "JSONbored/gittensory",
      owner: "JSONbored",
      name: "gittensory",
      isInstalled: true,
      isRegistered: false,
      isPrivate: true,
    };
    const issues: IssueRecord[] = [
      {
        repoFullName: repo.fullName,
        number: 1,
        title: "Add queue health endpoint",
        state: "open",
        authorLogin: "maintainer",
        authorAssociation: "OWNER",
        labels: [],
        linkedPrs: [7],
      },
    ];

    expect(buildWorkboard(null, issues)).toEqual([]);
    const item = buildWorkboard(repo, issues)[0];
    expect(item).toMatchObject({ fit: "hold", issueNumber: 1 });
    expect(item?.reasons).toEqual(expect.arrayContaining(["Repository is not present in the latest registry snapshot.", "Issue already has linked pull requests.", "Issue was opened by a maintainer-associated account."]));

    const registeredRepo = { ...repo, isRegistered: true, isPrivate: false };
    const baseIssue = issues[0]!;
    expect(
      buildWorkboard(registeredRepo, [
        { ...baseIssue, number: 2, linkedPrs: [], authorAssociation: "CONTRIBUTOR" },
        { ...baseIssue, number: 3, linkedPrs: [9], authorAssociation: "CONTRIBUTOR" },
      ]),
    ).toEqual([
      expect.objectContaining({ fit: "good", reasons: ["Open issue with no linked pull request detected by Gittensory."] }),
      expect.objectContaining({ fit: "caution", reasons: ["Issue already has linked pull requests."] }),
    ]);
  });

  it("fetches public contributor profile languages and handles unavailable GitHub responses", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/users/oktofeesh1")) {
        return Response.json({ login: "oktofeesh1", name: "Okto", public_repos: 12, followers: 3, created_at: "2026-01-01T00:00:00Z" });
      }
      if (url.endsWith("/users/norepos")) {
        return Response.json({ login: "norepos", public_repos: 0, followers: 0 });
      }
      if (url.includes("/users/norepos/repos?")) {
        return new Response("repos unavailable", { status: 503 });
      }
      if (url.includes("/repos?")) {
        return Response.json([{ language: "TypeScript" }, { language: "Python" }, { language: "TypeScript" }, { language: "Python" }, { language: "Ruby" }, { language: null }]);
      }
      return new Response("not found", { status: 404 });
    });

    const profile = await fetchPublicContributorProfile("oktofeesh1");
    expect(profile).toMatchObject({ login: "oktofeesh1", source: "github", topLanguages: ["Python", "TypeScript", "Ruby"] });
    await expect(fetchPublicContributorProfile("norepos")).resolves.toMatchObject({ login: "norepos", source: "github", topLanguages: [] });

    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    await expect(fetchPublicContributorProfile("missing")).resolves.toMatchObject({ login: "missing", source: "unavailable", topLanguages: [] });
  });
});

describe("fetchPublicRepoStats edge cases", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearPublicRepoStatsCacheForTests();
  });

  it("throws on dot-dot repo name", async () => {
    const env = { GITHUB_PUBLIC_TOKEN: "token" } as Pick<Env, "GITHUB_PUBLIC_TOKEN">;
    await expect(fetchPublicRepoStats(env, "JSONbored", "..")).rejects.toThrow("invalid_github_repo");
  });

  it("falls back to path-derived repoFullName and htmlUrl when GitHub omits them", async () => {
    const env = { GITHUB_PUBLIC_TOKEN: "token" } as Pick<Env, "GITHUB_PUBLIC_TOKEN">;
    vi.stubGlobal("fetch", async () => Response.json({ stargazers_count: 7, forks_count: 2 }));
    const stats = await fetchPublicRepoStats(env, "JSONbored", "gittensory");
    expect(stats.repoFullName).toBe("JSONbored/gittensory");
    expect(stats.htmlUrl).toBe("https://github.com/JSONbored/gittensory");
    expect(stats.stargazers_count).toBe(7);
  });
});
