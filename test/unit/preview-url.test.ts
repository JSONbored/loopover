import { afterEach, describe, expect, it, vi } from "vitest";
import { clearGitHubResponseCacheForTest, githubRateLimitAdmissionKeyForInstallation, latestGitHubRestRateLimitObservation } from "../../src/github/client";
import { extractPreviewUrl, findPreviewUrlFromChecks, findPreviewUrlFromPrComments, getPreviewBuildState } from "../../src/review/visual/preview-url";

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

  // findPreviewUrlFromChecks scans the combined commit-status first, then walks check-runs. These stub the
  // status endpoint to an empty/no-preview payload so control reaches the check-runs walk under test (#7779).
  const emptyStatus = () => Response.json({ statuses: [] });

  it("findPreviewUrlFromChecks follows Link: rel=next and finds the preview check-run on page 2 (#7779)", async () => {
    // The bug: a commit with >100 check-runs pushes the Cloudflare Workers Builds check onto page 2+, which the
    // old single-page read missed. Page 1 is 100 non-preview runs advertising a next page; page 2 carries it.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/status")) return emptyStatus();
      if (url.includes("/check-runs")) {
        if (isPage2(input)) return Response.json({ check_runs: [{ status: "completed", conclusion: "success", details_url: "https://pr-9.pages.dev/" }] });
        return Response.json({ check_runs: Array.from({ length: 100 }, () => ({ status: "completed", conclusion: "success", details_url: "https://example.com/ci" })) }, { headers: { link: NEXT_LINK } });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(findPreviewUrlFromChecks({ token: "t", repo: REPO, sha: "abc" })).resolves.toBe("https://pr-9.pages.dev");
    // Page 2 of check-runs was actually fetched (the pre-#7779 bug never read it).
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/check-runs") && isPage2(c[0]))).toBe(true);
  });

  it("findPreviewUrlFromChecks skips a completed non-success check-run and reads the preview from output.summary/text (#7779)", async () => {
    // Exercises the `continue` (completed && conclusion !== success) skip and the details_url ?? summary ?? text
    // fallback chain: the first run is a hard failure (skipped), the second carries the URL only in output.text.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/status")) return emptyStatus();
      if (url.includes("/check-runs")) {
        return Response.json({
          check_runs: [
            { status: "completed", conclusion: "failure", details_url: "https://should-be-skipped.pages.dev/" },
            { status: "completed", conclusion: "success", output: { text: "preview at https://from-text.workers.dev/" } },
          ],
        });
      }
      return Response.json({});
    });
    await expect(findPreviewUrlFromChecks({ token: "t", repo: REPO, sha: "abc" })).resolves.toBe("https://from-text.workers.dev");
  });

  it("findPreviewUrlFromChecks returns null when no check-run carries a preview URL and there is no next page (#7779)", async () => {
    // The probe finds nothing on the only page and the payload has no `check_runs` array (treated as []): the
    // whole discovery degrades to null rather than throwing.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/status")) return emptyStatus();
      if (url.includes("/check-runs")) return Response.json({});
      return Response.json({});
    });
    await expect(findPreviewUrlFromChecks({ token: "t", repo: REPO, sha: "abc" })).resolves.toBeNull();
  });

  it("findPreviewUrlFromChecks degrades to null when the check-runs read fails, without throwing (#7779)", async () => {
    // The .catch(() => null) around the paginated walk preserves the pre-#7779 best-effort behavior: a check-runs
    // fetch error must not throw out of the function, just yield no URL from that source.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/status")) return emptyStatus();
      if (url.includes("/check-runs")) throw new Error("check-runs network down");
      return Response.json({});
    });
    await expect(findPreviewUrlFromChecks({ token: "t", repo: REPO, sha: "abc" })).resolves.toBeNull();
  });

  it("findPreviewUrlFromChecks returns a preview URL straight from the combined commit-status, before touching check-runs (#7779)", async () => {
    // The status-first path: a success status whose target_url is a preview host short-circuits before the
    // check-runs walk runs at all.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/status")) return Response.json({ statuses: [{ state: "success", target_url: "https://from-status.pages.dev/" }] });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(findPreviewUrlFromChecks({ token: "t", repo: REPO, sha: "abc" })).resolves.toBe("https://from-status.pages.dev");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/check-runs"))).toBe(false);
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
