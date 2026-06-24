import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { closePullRequest, createIssueComment, createPullRequestReview, getLastCloserLogin, mergePullRequest } from "../../src/github/pr-actions";
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
          ]);
        }
        if (page === "2") return Response.json([{ event: "closed", actor: { login: "maintainer" } }]);
      }
      return new Response("unexpected", { status: 500 });
    });

    await expect(getLastCloserLogin(envWithKey(), 123, "owner/repo", 17)).resolves.toBe("maintainer");
    expect(calls.some((url) => url.includes("per_page=100") && url.includes("page=1"))).toBe(true);
    expect(calls.some((url) => url.includes("per_page=100") && url.includes("page=2"))).toBe(true);
  });

  it("returns null when the events API throws (catch path)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/access_tokens")) return Response.json({ token: "t" });
      throw new Error("network failure");
    });
    await expect(getLastCloserLogin(envWithKey(), 123, "owner/repo", 18)).resolves.toBeNull();
  });

  it("records null lastCloser when the closed event has a null actor", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/access_tokens")) return Response.json({ token: "t" });
      if (input.toString().includes("/issues/19/events")) return Response.json([{ event: "closed", actor: null }]);
      return new Response("not found", { status: 404 });
    });
    await expect(getLastCloserLogin(envWithKey(), 123, "owner/repo", 19)).resolves.toBeNull();
  });

  it("returns the best-known closer when the 10-page event cap is reached (page-cap exit path)", async () => {
    const fetchedPages: number[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/issues/20/events")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        fetchedPages.push(page);
        // Page 5 contains the close event; all pages return exactly 100 entries so the loop never exits early.
        const events = Array.from({ length: 100 }, (_, i) =>
          page === 5 && i === 50 ? { event: "closed", actor: { login: "capped-closer" } } : { event: "labeled" },
        );
        return Response.json(events);
      }
      return new Response("unexpected", { status: 500 });
    });
    await expect(getLastCloserLogin(envWithKey(), 123, "owner/repo", 20)).resolves.toBe("capped-closer");
    // Loop ran pages 1–10 and then exited via the cap, never requesting page 11.
    expect(fetchedPages).toHaveLength(10);
    expect(fetchedPages).not.toContain(11);
  });
});

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}
