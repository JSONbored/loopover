import { afterEach, describe, expect, it, vi } from "vitest";
import { clearGitHubResponseCacheForTest, githubRateLimitAdmissionKeyForInstallation, latestGitHubRestRateLimitObservation } from "../../src/github/client";
import { extractPreviewUrl, findPreviewUrlFromPrComments, getLatestDeploymentStatus, getPreviewBuildState } from "../../src/review/visual/preview-url";

/** GitHub's `Link` header for a page that advertises a next page (the exact shape findAcrossPages walks). */
const NEXT_LINK = '<https://api.github.com/resource?per_page=100&page=99>; rel="next", <https://api.github.com/resource?per_page=100&page=99>; rel="last"';
const REPO = { owner: "o", repo: "r" };
const isPage2 = (input: RequestInfo | URL) => /[?&]page=2\b/.test(String(input));

afterEach(() => {
  clearGitHubResponseCacheForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("preview-url GitHub reads", () => {
  it("records REST admission telemetry only for installation-token preview lookups", async () => {
    const key = githubRateLimitAdmissionKeyForInstallation(123);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    vi.stubGlobal("fetch", async () =>
      Response.json(
        { check_runs: [] },
        {
          headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "42",
            "x-ratelimit-reset": String(Date.parse("2026-06-24T12:10:00.000Z") / 1000),
          },
        },
      ),
    );

    await expect(
      getPreviewBuildState({ token: "dummy-user-token", repo: { owner: "o", repo: "r" }, sha: "abc123" }),
    ).resolves.toBe("absent");
    expect(latestGitHubRestRateLimitObservation(key)).toBeNull();

    await expect(
      getPreviewBuildState({
        token: "dummy-installation-token",
        repo: { owner: "o", repo: "r" },
        sha: "abc123",
        rateLimitAdmissionKey: key,
      }),
    ).resolves.toBe("absent");
    expect(latestGitHubRestRateLimitObservation(key)).toEqual({
      remaining: 42,
      resetAt: "2026-06-24T12:10:00.000Z",
      observedAtMs: Date.parse("2026-06-24T12:00:00.000Z"),
    });
  });
});

describe("preview-url pagination (#7450)", () => {
  it("findPreviewUrlFromPrComments follows Link: rel=next and finds the bot comment on page 2", async () => {
    const page1 = Array.from({ length: 100 }, (_v, i) => ({ user: { login: `user${i}` }, body: "just chatter" }));
    const page2 = [{ user: { login: "cloudflare-workers-and-pages[bot]" }, body: "Preview ready: https://pr-9.app.workers.dev/route" }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      isPage2(input) ? Response.json(page2) : Response.json(page1, { headers: { link: NEXT_LINK } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(findPreviewUrlFromPrComments({ token: "t", repo: REPO, prNumber: 9 })).resolves.toBe("https://pr-9.app.workers.dev");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/issues/9/comments?per_page=100");
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("&page="); // page 1 stays the bare pre-pagination read
    expect(String(fetchMock.mock.calls[1]![0])).toContain("&page=2");
  });

  it("findPreviewUrlFromPrComments stops as soon as the bot comment is found, without fetching further pages", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json([{ user: { login: "cloudflare-workers-and-pages[bot]" }, body: "https://pr-1.app.workers.dev" }], { headers: { link: NEXT_LINK } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(findPreviewUrlFromPrComments({ token: "t", repo: REPO, prNumber: 1 })).resolves.toBe("https://pr-1.app.workers.dev");
    expect(fetchMock).toHaveBeenCalledTimes(1); // early exit despite the advertised next page
  });

  it("findPreviewUrlFromPrComments returns null when no bot comment exists and there is no next page", async () => {
    vi.stubGlobal("fetch", async () => Response.json([{ user: { login: "someone" }, body: "hi" }]));
    await expect(findPreviewUrlFromPrComments({ token: "t", repo: REPO, prNumber: 2 })).resolves.toBeNull();
  });

  it("findPreviewUrlFromPrComments treats a non-array comments payload as empty", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ message: "unexpected shape" }));
    await expect(findPreviewUrlFromPrComments({ token: "t", repo: REPO, prNumber: 5 })).resolves.toBeNull();
  });

  it("findPreviewUrlFromPrComments degrades to null when a later-page fetch fails, never throwing", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (isPage2(input)) throw new Error("network down");
      return Response.json([{ user: { login: "x" }, body: "hi" }], { headers: { link: NEXT_LINK } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(findPreviewUrlFromPrComments({ token: "t", repo: REPO, prNumber: 3 })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("findPreviewUrlFromPrComments is bounded: a pathological always-Link:next response can't loop unboundedly", async () => {
    const fetchMock = vi.fn(async () => Response.json([{ user: { login: "x" }, body: "hi" }], { headers: { link: NEXT_LINK } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(findPreviewUrlFromPrComments({ token: "t", repo: REPO, prNumber: 4 })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(10); // PREVIEW_LIST_MAX_PAGES
  });

  it("findPreviewUrlFromPrComments skips a user-less comment and a bot comment with no preview link, then returns the real one", async () => {
    // Order matters: the scan reverses each page (newest first), so the url-bearing bot comment (index 0) is
    // examined LAST -- the user-less comment and the link-less bot comment are examined first.
    vi.stubGlobal("fetch", async () =>
      Response.json([
        { user: { login: "cloudflare-workers-and-pages[bot]" }, body: "Preview: https://pr-7.app.workers.dev" },
        { user: { login: "cloudflare-workers-and-pages[bot]" }, body: "build started, no link yet" }, // bot, no URL -> if(url) is false
        { body: "a comment with no user object at all" }, // user absent -> `c.user?.login ?? ""` is ""
      ]),
    );
    await expect(findPreviewUrlFromPrComments({ token: "t", repo: REPO, prNumber: 7 })).resolves.toBe("https://pr-7.app.workers.dev");
  });

  it("getPreviewBuildState ignores a nameless check-run and still classifies the Workers Builds one", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        check_runs: [
          { status: "completed", conclusion: "success" }, // no name -> `r.name ?? ""` -> regex miss
          { name: "Cloudflare Workers Builds", status: "completed", conclusion: "success" },
        ],
      }),
    );
    await expect(getPreviewBuildState({ token: "t", repo: REPO, sha: "nameless" })).resolves.toBe("succeeded");
  });

  it("getPreviewBuildState follows Link: rel=next and finds the Workers Builds check on page 2", async () => {
    const page1 = { check_runs: Array.from({ length: 100 }, () => ({ name: "unit tests", status: "completed", conclusion: "success" })) };
    const page2 = { check_runs: [{ name: "Cloudflare Workers Builds", status: "in_progress" }] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      isPage2(input) ? Response.json(page2) : Response.json(page1, { headers: { link: NEXT_LINK } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(getPreviewBuildState({ token: "t", repo: REPO, sha: "abc" })).resolves.toBe("building");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("getPreviewBuildState classifies a completed Workers Builds check as succeeded or failed", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ check_runs: [{ name: "cloudflare pages", status: "completed", conclusion: "success" }] }));
    await expect(getPreviewBuildState({ token: "t", repo: REPO, sha: "s1" })).resolves.toBe("succeeded");
    vi.stubGlobal("fetch", async () => Response.json({ check_runs: [{ name: "cloudflare pages", status: "completed", conclusion: "failure" }] }));
    await expect(getPreviewBuildState({ token: "t", repo: REPO, sha: "s2" })).resolves.toBe("failed");
  });

  it("getPreviewBuildState treats a payload without a check_runs array as absent", async () => {
    vi.stubGlobal("fetch", async () => Response.json({}));
    await expect(getPreviewBuildState({ token: "t", repo: REPO, sha: "s3" })).resolves.toBe("absent");
  });

  it("getPreviewBuildState is bounded and degrades to absent on a later-page failure", async () => {
    const spin = vi.fn(async () => Response.json({ check_runs: [] }, { headers: { link: NEXT_LINK } }));
    vi.stubGlobal("fetch", spin);
    await expect(getPreviewBuildState({ token: "t", repo: REPO, sha: "spin" })).resolves.toBe("absent");
    expect(spin).toHaveBeenCalledTimes(10); // PREVIEW_LIST_MAX_PAGES

    const failLater = vi.fn(async (input: RequestInfo | URL) => {
      if (isPage2(input)) throw new Error("boom");
      return Response.json({ check_runs: [] }, { headers: { link: NEXT_LINK } });
    });
    vi.stubGlobal("fetch", failLater);
    await expect(getPreviewBuildState({ token: "t", repo: REPO, sha: "fail" })).resolves.toBe("absent");
    expect(failLater).toHaveBeenCalledTimes(2);
  });

  it("getLatestDeploymentStatus finds a deployment whose environment_url sits on page 2 of the deployments list (#7805)", async () => {
    // Page 1: 100 deployments none of which carry a usable status; page 2: the deployment with the real URL.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/deployments?")) {
        if (isPage2(input)) return Response.json([{ id: 777 }]);
        return Response.json(
          Array.from({ length: 100 }, (_v, i) => ({ id: i + 1 })),
          { headers: { link: NEXT_LINK } },
        );
      }
      // Deployment 777's statuses carry the preview URL; every page-1 deployment's statuses are empty.
      if (url.includes("/deployments/777/statuses")) {
        return Response.json([{ state: "success", environment_url: "https://p2.pages.dev/" }]);
      }
      return Response.json([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(getLatestDeploymentStatus({ token: "t", repo: REPO, sha: "abc" })).resolves.toEqual({
      url: "https://p2.pages.dev/",
      failed: false,
    });
    // Page 1 + page 2 of deployments were both fetched (the bug was that page 2 was never read).
    expect(fetchMock.mock.calls.some((c) => isPage2(c[0]))).toBe(true);
  });

  it("getLatestDeploymentStatus finds a usable status on page 2 of a deployment's statuses (#7805)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/deployments?")) return Response.json([{ id: 42 }]);
      if (url.includes("/deployments/42/statuses")) {
        if (isPage2(input)) return Response.json([{ state: "success", environment_url: "https://s2.workers.dev/" }]);
        // Page 1: 100 older statuses, none usable, advertising a next page.
        return Response.json(
          Array.from({ length: 100 }, () => ({ state: "queued" })),
          { headers: { link: NEXT_LINK } },
        );
      }
      return Response.json([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(getLatestDeploymentStatus({ token: "t", repo: REPO, sha: "abc" })).resolves.toEqual({
      url: "https://s2.workers.dev/",
      failed: false,
    });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/statuses") && isPage2(c[0]))).toBe(true);
  });

  it("getLatestDeploymentStatus reports failed when a deployment's latest status is a failure and none are pending (#7805)", async () => {
    // No usable environment_url anywhere, and the single deployment's latest (statuses[0]) is a hard failure:
    // sawFailure is set, sawPending stays false, so the terminal verdict is failed:true.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/deployments?")) return Response.json([{ id: 5 }]);
      if (url.includes("/deployments/5/statuses")) return Response.json([{ state: "failure" }, { state: "success" }]);
      return Response.json([]);
    });
    await expect(getLatestDeploymentStatus({ token: "t", repo: REPO, sha: "abc" })).resolves.toEqual({
      url: null,
      failed: true,
    });
  });

  it("getLatestDeploymentStatus is NOT failed when another deployment is still pending, even if one failed (#7805)", async () => {
    // Two deployments: one failed, one still in_progress. sawPending being set suppresses the failed verdict, so
    // the caller keeps polling rather than declaring a false terminal failure.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/deployments?")) return Response.json([{ id: 1 }, { id: 2 }]);
      if (url.includes("/deployments/1/statuses")) return Response.json([{ state: "error" }]);
      if (url.includes("/deployments/2/statuses")) return Response.json([{ state: "in_progress" }]);
      return Response.json([]);
    });
    await expect(getLatestDeploymentStatus({ token: "t", repo: REPO, sha: "abc" })).resolves.toEqual({
      url: null,
      failed: false,
    });
  });

  it("getLatestDeploymentStatus swallows a per-deployment statuses-fetch error and treats that deployment as URL-less (#7805)", async () => {
    // A statuses read throwing must not abort the whole lookup: findDeploymentUrl's .catch degrades that one
    // deployment to null, so the overall result is a clean "no URL yet, not failed".
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/deployments?")) return Response.json([{ id: 9 }]);
      if (url.includes("/deployments/9/statuses")) throw new Error("statuses network down");
      return Response.json([]);
    });
    await expect(getLatestDeploymentStatus({ token: "t", repo: REPO, sha: "abc" })).resolves.toEqual({
      url: null,
      failed: false,
    });
  });

  it("getLatestDeploymentStatus skips a deployment whose id is absent, leaving no statuses to inspect (#7805)", async () => {
    // The id filter drops an id-less deployment entry, so there is nothing to fetch statuses for -> no URL, not
    // failed. (A statuses fetch for a real id is never issued here.)
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/deployments?")) return Response.json([{ notAnId: true }]);
      return Response.json([]);
    });
    await expect(getLatestDeploymentStatus({ token: "t", repo: REPO, sha: "abc" })).resolves.toEqual({
      url: null,
      failed: false,
    });
  });

  it("getLatestDeploymentStatus treats a non-array deployments payload as an empty page (#7805)", async () => {
    // Array.isArray(payload) ? ... : [] -- the deployments list read returning a non-array object degrades to an
    // empty page rather than throwing.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/deployments?")) return Response.json({ message: "unexpected non-array deployments shape" });
      return Response.json([]);
    });
    await expect(getLatestDeploymentStatus({ token: "t", repo: REPO, sha: "abc" })).resolves.toEqual({
      url: null,
      failed: false,
    });
  });

  it("getLatestDeploymentStatus treats a non-array statuses payload for a deployment as empty (#7805)", async () => {
    // The inner Array.isArray(payload) ? ... : [] guard: a deployment's /statuses returning a non-array object is
    // treated as "no statuses", so that deployment contributes no URL and no failed/pending signal.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/deployments?")) return Response.json([{ id: 3 }]);
      if (url.includes("/deployments/3/statuses")) return Response.json({ message: "unexpected non-array statuses shape" });
      return Response.json([]);
    });
    await expect(getLatestDeploymentStatus({ token: "t", repo: REPO, sha: "abc" })).resolves.toEqual({
      url: null,
      failed: false,
    });
  });

  it("getLatestDeploymentStatus builds a ref-scoped deployments query when given a ref instead of a sha (#7805)", async () => {
    // The selector ternary's ref arm: with params.ref (and no sha) the deployments list is queried by ref=..., and
    // a usable status still resolves to its environment_url.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/deployments?")) return Response.json([{ id: 8 }]);
      if (url.includes("/deployments/8/statuses")) return Response.json([{ state: "success", environment_url: "https://ref.pages.dev/" }]);
      return Response.json([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(getLatestDeploymentStatus({ token: "t", repo: REPO, ref: "feature-branch" })).resolves.toEqual({
      url: "https://ref.pages.dev/",
      failed: false,
    });
    // The deployments query was scoped by ref=..., not sha=...
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/deployments?ref=feature-branch"))).toBe(true);
  });

  it("getLatestDeploymentStatus returns error:true when the deployments read fails with a non-404 status (#7805)", async () => {
    // A 403/5xx (not a 404 "genuinely no deployments") must surface error:true so the caller keeps polling rather
    // than showing a false terminal "no preview" state.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/deployments?")) return new Response("forbidden", { status: 403 });
      return Response.json([]);
    });
    await expect(getLatestDeploymentStatus({ token: "t", repo: REPO, sha: "abc" })).resolves.toEqual({
      url: null,
      failed: false,
      error: true,
    });
  });

  it("getLatestDeploymentStatus returns no-preview (not error) when the deployments read 404s (#7805)", async () => {
    // A 404 means the ref genuinely has no deployments -> a clean {url:null, failed:false}, distinct from the
    // non-404 error path above.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/deployments?")) return new Response("not found", { status: 404 });
      return Response.json([]);
    });
    await expect(getLatestDeploymentStatus({ token: "t", repo: REPO, sha: "abc" })).resolves.toEqual({
      url: null,
      failed: false,
    });
  });
});

describe("extractPreviewUrl", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
  ])("returns null for falsy input (%s)", (_label, input) => {
    expect(extractPreviewUrl(input)).toBeNull();
  });

  it("returns null when the text contains no URL at all", () => {
    expect(extractPreviewUrl("deploy is still pending, no link yet")).toBeNull();
  });

  it("returns null when the only URL is not a Cloudflare-preview host", () => {
    expect(extractPreviewUrl("see https://github.com/acme/widgets for details")).toBeNull();
  });

  it("skips a malformed URL-like substring that throws in new URL(...) and falls through to null", () => {
    // `http://[` matches the URL regex but throws inside `new URL(...)` (unterminated IPv6 host),
    // so the catch arm is taken and the scan falls through to null (#5848).
    expect(extractPreviewUrl("preview: http://[ oops")).toBeNull();
  });

  it("skips a malformed URL and still returns a later valid preview match", () => {
    // The malformed substring hits the catch arm, then the loop continues to the valid host.
    expect(extractPreviewUrl("http://[ then https://pr-1.app.workers.dev/route")).toBe(
      "https://pr-1.app.workers.dev",
    );
  });

  it("returns the base origin for a *.workers.dev link, dropping the path and query", () => {
    expect(extractPreviewUrl("build ready at https://pr-12.myapp.workers.dev/some/path?x=1")).toBe(
      "https://pr-12.myapp.workers.dev",
    );
  });

  it("returns the base origin for a *.pages.dev link", () => {
    expect(extractPreviewUrl("https://feature-x.docs.pages.dev")).toBe("https://feature-x.docs.pages.dev");
  });

  it("skips a non-preview URL that precedes the matching one (multi-match ordering)", () => {
    expect(
      extractPreviewUrl("https://github.com/acme/widgets/pull/7 and https://pr-3.site.pages.dev/preview"),
    ).toBe("https://pr-3.site.pages.dev");
  });
});
