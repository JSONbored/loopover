import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWorkboard } from "../../src/api/workboard";
import { normalizeGittBountySnapshot } from "../../src/bounties/ingest";
import { fetchPublicContributorProfile } from "../../src/github/public";
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

  it("normalizes non-numeric public_repos/followers from the users API to 0 (finiteCount)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      // GitHub can return null/absent counts for some account shapes, or a BYOK proxy may malform them;
      // these must degrade to a finite 0 instead of propagating null/string onto the evidence surface.
      if (url.endsWith("/users/nullcounts")) {
        return Response.json({ login: "nullcounts", public_repos: null, followers: "42", created_at: "2026-01-01T00:00:00Z" });
      }
      if (url.includes("/users/nullcounts/repos?")) {
        return Response.json([]);
      }
      return new Response("not found", { status: 404 });
    });

    const profile = await fetchPublicContributorProfile("nullcounts");
    expect(profile).toMatchObject({ login: "nullcounts", source: "github", publicRepos: 0, followers: 0 });
  });

  it("paginates past 100 repos so contributors with large portfolios get accurate topLanguages", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/users/prolific")) return Response.json({ login: "prolific", public_repos: 150 });
      if (url.includes("/prolific/repos?") && !url.includes("page=2")) {
        // page 1: 100 TypeScript repos with a Link header pointing to page 2
        return Response.json(
          Array.from({ length: 100 }, () => ({ language: "TypeScript" })),
          { headers: { link: '<https://api.github.com/users/prolific/repos?page=2>; rel="next"' } },
        );
      }
      if (url.includes("/prolific/repos?") && url.includes("page=2")) {
        // page 2: 50 Rust repos only reachable via pagination
        return Response.json(Array.from({ length: 50 }, () => ({ language: "Rust" })));
      }
      return new Response("not found", { status: 404 });
    });

    const profile = await fetchPublicContributorProfile("prolific");
    expect(profile.topLanguages[0]).toBe("TypeScript");
    expect(profile.topLanguages).toContain("Rust");
  });

  it("uses a fresh timeout signal for each paginated public GitHub request", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/users/slowpager")) return Response.json({ login: "slowpager", public_repos: 220 });
      if (url.includes("/slowpager/repos?") && !url.includes("page=2") && !url.includes("page=3")) {
        return Response.json(Array.from({ length: 100 }, () => ({ language: "TypeScript" })), {
          headers: { link: '<https://api.github.com/users/slowpager/repos?page=2>; rel="next"' },
        });
      }
      if (url.includes("/slowpager/repos?") && url.includes("page=2")) {
        return Response.json(Array.from({ length: 100 }, () => ({ language: "Rust" })), {
          headers: { link: '<https://api.github.com/users/slowpager/repos?page=3>; rel="next"' },
        });
      }
      if (url.includes("/slowpager/repos?") && url.includes("page=3")) {
        return Response.json(Array.from({ length: 20 }, () => ({ language: "Go" })));
      }
      return new Response("not found", { status: 404 });
    });

    const profile = await fetchPublicContributorProfile("slowpager");
    expect(profile.topLanguages).toEqual(expect.arrayContaining(["TypeScript", "Rust", "Go"]));
    // One timeout per request: user + page1 + page2 + page3.
    expect(timeoutSpy).toHaveBeenCalledTimes(4);
    timeoutSpy.mockRestore();
  });

  it("stops paginating repos when a subsequent page returns a non-ok response", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/users/partialdev")) return Response.json({ login: "partialdev", public_repos: 200 });
      if (url.includes("/partialdev/repos?") && !url.includes("page=2")) {
        // page 1: 100 Go repos with a Link header
        return Response.json(
          Array.from({ length: 100 }, () => ({ language: "Go" })),
          { headers: { link: '<https://api.github.com/users/partialdev/repos?page=2>; rel="next"' } },
        );
      }
      if (url.includes("/partialdev/repos?") && url.includes("page=2")) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response("not found", { status: 404 });
    });

    const profile = await fetchPublicContributorProfile("partialdev");
    // page 1 repos are preserved despite page 2 failing
    expect(profile.source).toBe("github");
    expect(profile.topLanguages).toContain("Go");
  });

  it("authenticates public profile requests with GITHUB_PUBLIC_TOKEN to lift the rate ceiling (#790)", async () => {
    const authHeaders: Array<string | null> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      authHeaders.push(new Headers(init?.headers).get("authorization"));
      const url = input.toString();
      if (url.endsWith("/users/dev")) return Response.json({ login: "dev", public_repos: 0, followers: 0 });
      return Response.json([]);
    });
    await fetchPublicContributorProfile("dev", { GITHUB_PUBLIC_TOKEN: "public-token" });
    expect(authHeaders).toEqual(["Bearer public-token", "Bearer public-token"]);

    authHeaders.length = 0;
    await fetchPublicContributorProfile("dev");
    expect(authHeaders).toEqual([null, null]);
  });
});
