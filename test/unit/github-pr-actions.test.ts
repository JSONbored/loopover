import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { closePullRequest, createIssueComment, createPullRequestReview, createPullRequestReviewComments, dismissLatestBotApproval, getLastCloserLogin, mergePullRequest, updatePullRequestBranch } from "../../src/github/pr-actions";
import { createTestEnv } from "../helpers/d1";

function envWithKey() {
  return createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
}

describe("GitHub PR action primitives (#778)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates the repo name before any GitHub call", async () => {
    await expect(closePullRequest(createTestEnv(), 1, "invalid", 4)).rejects.toThrow(/Invalid repository full name/);
  });

  it("posts a request-changes review with the body", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/pulls/7/reviews")) return Response.json({ id: 99 });
      return new Response("unexpected", { status: 500 });
    });
    const result = await createPullRequestReview(envWithKey(), 123, "owner/repo", 7, "REQUEST_CHANGES", "please fix");
    expect(result).toEqual({ id: 99 });
    expect(calls[0]).toMatchObject({ method: "POST", body: { event: "REQUEST_CHANGES", body: "please fix" } });
    expect(calls[0]?.url).toMatch(/\/repos\/owner\/repo\/pulls\/7\/reviews$/);
  });

  it("posts a quiet COMMENT review with inline comments anchored to the head SHA (#inline-comments)", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/pulls/7/reviews")) return Response.json({ id: 71 });
      return new Response("unexpected", { status: 500 });
    });
    const comments = [{ path: "src/a.ts", line: 2, side: "RIGHT" as const, body: "**Nit:** guard this." }];
    const result = await createPullRequestReviewComments(envWithKey(), 123, "owner/repo", 7, "headsha1", comments, "live");
    expect(result).toEqual({ id: 71 });
    expect(calls[0]).toMatchObject({ method: "POST", body: { event: "COMMENT", commit_id: "headsha1", comments } });
  });

  it("merges a PR with the method and head-sha guard", async () => {
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.endsWith("/pulls/7/merge")) return Response.json({ merged: true, sha: "abc" });
      return new Response("unexpected", { status: 500 });
    });
    const result = await mergePullRequest(envWithKey(), 123, "owner/repo", 7, { mergeMethod: "squash", sha: "head1" });
    expect(result).toEqual({ merged: true, sha: "abc" });
    expect(calls[0]).toMatchObject({ method: "PUT", body: { merge_method: "squash", sha: "head1" } });
  });

  it("omits the sha when not provided and defaults a sparse merge response", async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      sent = init?.body ? JSON.parse(String(init.body)) : {};
      return Response.json({}); // sparse body → defaults exercised
    });
    const result = await mergePullRequest(envWithKey(), 123, "owner/repo", 7, { mergeMethod: "merge" });
    expect(sent).toMatchObject({ merge_method: "merge" });
    expect(sent).not.toHaveProperty("sha");
    expect(result).toEqual({ merged: true, sha: null });
  });

  it("closes a PR via PATCH state=closed", async () => {
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      return Response.json({ state: "closed" });
    });
    const result = await closePullRequest(envWithKey(), 123, "owner/repo", 7);
    expect(result).toEqual({ state: "closed" });
    expect(calls[0]).toMatchObject({ method: "PATCH", body: { state: "closed" } });
    expect(calls[0]?.url).toMatch(/\/repos\/owner\/repo\/pulls\/7$/);
  });

  it("posts a plain issue comment", async () => {
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      return Response.json({ id: 5 });
    });
    const result = await createIssueComment(envWithKey(), 123, "owner/repo", 7, "hello");
    expect(result).toEqual({ id: 5 });
    expect(calls[0]).toMatchObject({ method: "POST", body: { body: "hello" } });
    expect(calls[0]?.url).toMatch(/\/repos\/owner\/repo\/issues\/7\/comments$/);
  });

  it("walks paginated issue events to find the true most recent closer", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/issues/17/events")) {
        const page = new URL(url).searchParams.get("page");
        if (page === "1") {
          return Response.json([
            ...Array.from({ length: 99 }, (_, index) => ({ event: "labeled", actor: { login: `labeler-${index}` } })),
            { event: "closed", actor: { login: "contributor" } },
          ], { headers: { link: '<https://api.github.test/issues/17/events?per_page=100&page=2>; rel="last"' } });
        }
        if (page === "2") return Response.json([{ event: "closed", actor: { login: "maintainer" } }]);
      }
      return new Response("unexpected", { status: 500 });
    });

    await expect(getLastCloserLogin(envWithKey(), 123, "owner/repo", 17)).resolves.toEqual({ login: "maintainer", coveredAllPages: true });
    expect(calls.some((url) => url.includes("per_page=100") && url.includes("page=1"))).toBe(true);
    expect(calls.some((url) => url.includes("per_page=100") && url.includes("page=2"))).toBe(true);
  });

  it("returns null when the events API throws (catch path)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/access_tokens")) return Response.json({ token: "t" });
      throw new Error("network failure");
    });
    await expect(getLastCloserLogin(envWithKey(), 123, "owner/repo", 18)).resolves.toEqual({ login: null, coveredAllPages: false });
  });

  it("records null lastCloser when the closed event has a null actor", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/access_tokens")) return Response.json({ token: "t" });
      if (input.toString().includes("/issues/19/events")) return Response.json([{ event: "closed", actor: null }]);
      return new Response("not found", { status: 404 });
    });
    await expect(getLastCloserLogin(envWithKey(), 123, "owner/repo", 19)).resolves.toEqual({ login: null, coveredAllPages: true });
  });

  it("reads the newest bounded event pages instead of the oldest prefix", async () => {
    const fetchedPages: number[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/issues/20/events")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        fetchedPages.push(page);
        if (page === 1) {
          return Response.json([{ event: "closed", actor: { login: "stale-contributor" } }], {
            headers: { link: '<https://api.github.test/issues/20/events?per_page=100&page=12>; rel="last"' },
          });
        }
        const events = Array.from({ length: 100 }, (_, i) =>
          page === 11 && i === 40 ? { event: "closed", actor: { login: "maintainer" } } : { event: "labeled" },
        );
        return Response.json(events);
      }
      return new Response("unexpected", { status: 500 });
    });
    await expect(getLastCloserLogin(envWithKey(), 123, "owner/repo", 20)).resolves.toEqual({ login: "maintainer", coveredAllPages: false });
    expect(fetchedPages).toEqual([1, 12, 11]);
    expect(fetchedPages).not.toContain(2);
  });

  it("returns null when the newest bounded event pages contain no close event", async () => {
    const fetchedPages: number[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/issues/21/events")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        fetchedPages.push(page);
        return Response.json(page === 1 ? [{ event: "closed", actor: { login: "stale-contributor" } }] : [{ event: "labeled" }],
          page === 1 ? { headers: { link: '<https://api.github.test/issues/21/events?per_page=100&page=12>; rel="last"' } } : undefined);
      }
      return new Response("unexpected", { status: 500 });
    });
    await expect(getLastCloserLogin(envWithKey(), 123, "owner/repo", 21)).resolves.toEqual({ login: null, coveredAllPages: false });
    expect(fetchedPages).toEqual([1, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });

  it("falls back to page-1 closer when bounded window (firstPageToRead=2) has no close event", async () => {
    // lastPage=5 → firstPageToRead = max(2, 5-10+1) = 2; the bounded scan covers pages 5→2 and finds
    // no closer there → falls through to line 140 with firstPageToRead===2 and returns the page-1 closer.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/issues/22/events")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        const linkHeader = page === 1 ? '<https://api.github.test/issues/22/events?per_page=100&page=5>; rel="last"' : undefined;
        const events = page === 1 ? [{ event: "closed", actor: { login: "page1-closer" } }] : [{ event: "labeled" }];
        return Response.json(events, linkHeader ? { headers: { link: linkHeader } } : undefined);
      }
      return new Response("unexpected", { status: 500 });
    });
    await expect(getLastCloserLogin(envWithKey(), 123, "owner/repo", 22)).resolves.toEqual({ login: "page1-closer", coveredAllPages: true });
  });

  it("follows rel=next forward when GitHub omits rel=last, finding the later maintainer close (#audit-rel-last)", async () => {
    // GitHub paginated WITHOUT rel="last" (only rel="next"). Trusting page 1 alone would surface the early
    // contributor close and miss the later maintainer close on page 2 — a window-evasion fail-OPEN. The forward
    // scan follows rel="next" to the tail (page 3, no Link) and reports the most recent close.
    const fetchedPages: number[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/issues/23/events")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        fetchedPages.push(page);
        if (page === 1) return Response.json([{ event: "closed", actor: { login: "early-contributor" } }], { headers: { link: '<https://api.github.test/issues/23/events?per_page=100&page=2>; rel="next"' } });
        if (page === 2) return Response.json([{ event: "closed", actor: { login: "maintainer" } }], { headers: { link: '<https://api.github.test/issues/23/events?per_page=100&page=3>; rel="next"' } });
        return Response.json([{ event: "labeled" }]); // page 3: the tail (no Link header)
      }
      return new Response("unexpected", { status: 500 });
    });
    await expect(getLastCloserLogin(envWithKey(), 123, "owner/repo", 23)).resolves.toEqual({ login: "maintainer", coveredAllPages: true });
    expect(fetchedPages).toEqual([1, 2, 3]);
  });

  it("fails CLOSED when rel=next never terminates within the page budget (no rel=last)", async () => {
    // Every page advertises rel="next" and never a rel="last": the forward scan exhausts the page budget without
    // reaching the tail, so it cannot prove no later close exists → coveredAllPages false, login null (fail-closed).
    const fetchedPages: number[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/issues/25/events")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        fetchedPages.push(page);
        return Response.json([{ event: "labeled" }], { headers: { link: `<https://api.github.test/issues/25/events?per_page=100&page=${page + 1}>; rel="next"` } });
      }
      return new Response("unexpected", { status: 500 });
    });
    await expect(getLastCloserLogin(envWithKey(), 123, "owner/repo", 25)).resolves.toEqual({ login: null, coveredAllPages: false });
    expect(fetchedPages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]); // page 1 + the 10-page budget
  });

  it("returns null but covered when a rel=next forward scan reaches the tail with no close at all", async () => {
    // No rel="last", forward scan reaches the tail (page 2, no Link) and finds no close on any page → the latest
    // close stays undefined → undefined ?? null = null, yet coveredAllPages is true (the whole timeline was read).
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/issues/26/events")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        if (page === 1) return Response.json([{ event: "labeled" }], { headers: { link: '<https://api.github.test/issues/26/events?per_page=100&page=2>; rel="next"' } });
        return Response.json([{ event: "labeled" }]); // page 2: the tail (no Link header)
      }
      return new Response("unexpected", { status: 500 });
    });
    await expect(getLastCloserLogin(envWithKey(), 123, "owner/repo", 26)).resolves.toEqual({ login: null, coveredAllPages: true });
  });

  it("returns null when bounded window (firstPageToRead=2) AND page 1 also have no close event (?? null right branch)", async () => {
    // lastPage=5 → firstPageToRead=2; pages 2–5 have no closer; page 1 also has no closer →
    // latestCloserInPage(firstEvents) returns undefined → undefined ?? null = null.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/issues/24/events")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        const linkHeader = page === 1 ? '<https://api.github.test/issues/24/events?per_page=100&page=5>; rel="last"' : undefined;
        return Response.json([{ event: "labeled" }], linkHeader ? { headers: { link: linkHeader } } : undefined);
      }
      return new Response("unexpected", { status: 500 });
    });
    await expect(getLastCloserLogin(envWithKey(), 123, "owner/repo", 24)).resolves.toEqual({ login: null, coveredAllPages: true });
  });

  it("dismisses the bot's own LATEST approve review, ignoring other reviewers and earlier bot reviews (#2254)", async () => {
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/pulls/7/reviews") && !url.includes("/dismissals") && method === "GET") {
        return Response.json([
          { id: 1, state: "COMMENTED", user: { login: "human-reviewer" } },
          { id: 2, state: "APPROVED", user: { login: "gittensory[bot]" } }, // an EARLIER bot approve
          { id: 3, state: "CHANGES_REQUESTED", user: { login: "gittensory[bot]" } },
          { id: 4, state: "APPROVED", user: { login: "gittensory[bot]" } }, // the LATEST bot approve — this one
        ]);
      }
      if (url.includes("/pulls/7/reviews/4/dismissals") && method === "PUT") {
        calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : {} });
        return Response.json({ id: 4, state: "DISMISSED" });
      }
      return new Response("unexpected", { status: 500 });
    });
    const result = await dismissLatestBotApproval(envWithKey(), 123, "owner/repo", 7, "stale approval retracted");
    expect(result).toEqual({ dismissed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ message: "stale approval retracted", event: "DISMISS" });
  });

  it("is a no-op when the bot never approved this PR", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/pulls/8/reviews")) return Response.json([{ id: 1, state: "APPROVED", user: { login: "human-reviewer" } }]);
      return new Response("unexpected", { status: 500 });
    });
    await expect(dismissLatestBotApproval(envWithKey(), 123, "owner/repo", 8, "retract")).resolves.toEqual({ dismissed: false });
  });

  it("finds the bot's LATEST approve on a second page, not an earlier one from page 1 (#2361)", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    // Page 1 is a full 100-row page (forces pagination to continue) whose only bot review is an EARLIER
    // approve; the actual latest bot approve is review id 999 on page 2 — a single-page fetch would wrongly
    // dismiss the page-1 review (or miss the real latest one) instead.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, state: "COMMENTED", user: { login: "human-reviewer" } }));
    page1[0] = { id: 1, state: "APPROVED", user: { login: "gittensory[bot]" } };
    const page2 = [
      { id: 998, state: "CHANGES_REQUESTED", user: { login: "gittensory[bot]" } },
      { id: 999, state: "APPROVED", user: { login: "gittensory[bot]" } },
    ];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/pulls/10/reviews") && !url.includes("/dismissals") && method === "GET") {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        return Response.json(page === 1 ? page1 : page === 2 ? page2 : []);
      }
      if (url.includes("/pulls/10/reviews/999/dismissals") && method === "PUT") {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
        return Response.json({ id: 999, state: "DISMISSED" });
      }
      return new Response("unexpected", { status: 500 });
    });
    const result = await dismissLatestBotApproval(envWithKey(), 123, "owner/repo", 10, "stale approval retracted");
    expect(result).toEqual({ dismissed: true });
    expect(calls).toHaveLength(1); // page 1's review 1 was never dismissed
  });

  it("is best-effort — an API error returns dismissed:false instead of throwing", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/access_tokens")) return Response.json({ token: "t" });
      throw new Error("network failure");
    });
    await expect(dismissLatestBotApproval(envWithKey(), 123, "owner/repo", 9, "retract")).resolves.toEqual({ dismissed: false });
  });

  it("updates branch without an expected head sha (omits expected_head_sha — FALSE branch of the spread ternary)", async () => {
    const requestBodies: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/pulls/55/update-branch")) {
        requestBodies.push(String(init?.body ?? ""));
        return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response("unexpected", { status: 500 });
    });
    await expect(updatePullRequestBranch(envWithKey(), 123, "owner/repo", 55)).resolves.toBeUndefined();
    expect(requestBodies.some((b) => !b.includes("expected_head_sha"))).toBe(true);
  });
});

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}
