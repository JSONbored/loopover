import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { closePullRequest, createIssueComment, createPullRequestReview, mergePullRequest } from "../../src/github/pr-actions";
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
});

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}
