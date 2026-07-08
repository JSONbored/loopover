import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { commitE2eTestToPrBranch, defaultE2eTestFilePath } from "../../src/github/e2e-test-commit";
import { createTestEnv } from "../helpers/d1";

function generateRsaPrivateKeyPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } }).privateKey;
}

function envWithKey() {
  return createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
}

const REPO = "owner/widgets";
const TOKEN_URL = /\/access_tokens$/;
const TEST_SOURCE = "import { test } from '@playwright/test';\ntest('x', () => {});";

const baseArgs = {
  installationId: 555,
  repoFullName: REPO,
  prNumber: 42,
  headRef: "feature/my-branch",
  headSha: "head-commit-sha",
  testSource: TEST_SOURCE,
  actor: "maintainer",
  mode: "live" as const,
};

describe("defaultE2eTestFilePath", () => {
  it("namespaces the generated file by PR number", () => {
    expect(defaultE2eTestFilePath(42)).toBe("e2e/gittensory-pr-42.spec.ts");
  });
});

describe("commitE2eTestToPrBranch (#4197)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declines without any GitHub call when mode is not live", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await commitE2eTestToPrBranch(envWithKey(), { ...baseArgs, mode: "dry_run" });
    expect(result).toEqual({ status: "declined", reason: 'commit not pushed: action mode is "dry_run"' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pushes a commit onto the PR's existing head branch via a ref UPDATE (not create)", async () => {
    const env = envWithKey();
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.endsWith("/git/commits/head-commit-sha") && method === "GET") return Response.json({ tree: { sha: "base-tree-sha" } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "new-tree-sha" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "new-commit-sha" });
      // Match by method only, not the exact ref path segment -- whether octokit percent-encodes the "/" in
      // "heads/feature/my-branch" is an internal templating detail this test shouldn't need to pin down.
      if (method === "PATCH") return Response.json({ ref: "refs/heads/feature/my-branch" });
      return new Response("unexpected", { status: 500 });
    });

    const result = await commitE2eTestToPrBranch(env, baseArgs);

    expect(result).toEqual({ status: "committed", commitSha: "new-commit-sha", htmlUrl: `https://github.com/${REPO}/commit/new-commit-sha` });

    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"));
    expect(treeCall?.body).toMatchObject({ base_tree: "base-tree-sha", tree: [{ path: "e2e/gittensory-pr-42.spec.ts", mode: "100644", type: "blob", content: TEST_SOURCE }] });

    const commitCall = calls.find((c) => c.url.endsWith("/git/commits") && c.method === "POST");
    expect(commitCall?.body).toMatchObject({ tree: "new-tree-sha", parents: ["head-commit-sha"] });
    expect(commitCall?.body.message as string).toContain("Generated-by: gittensory (invoked by @maintainer)");

    // octokit percent-encodes the whole "heads/feature/my-branch" ref value into one path segment.
    const refCall = calls.find((c) => c.method === "PATCH");
    expect(decodeURIComponent(refCall?.url ?? "")).toContain("/git/refs/heads/feature/my-branch");
    expect(refCall?.body).toMatchObject({ sha: "new-commit-sha" });
  });

  it("uses a custom file path when provided instead of the default", async () => {
    const env = envWithKey();
    let treeBody: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      if (url.endsWith("/git/commits/head-commit-sha") && method === "GET") return Response.json({ tree: { sha: "base-tree-sha" } });
      if (url.endsWith("/git/trees") && method === "POST") {
        treeBody = init?.body ? JSON.parse(String(init.body)) : {};
        return Response.json({ sha: "new-tree-sha" });
      }
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "new-commit-sha" });
      if (method === "PATCH") return Response.json({});
      return new Response("unexpected", { status: 500 });
    });

    await commitE2eTestToPrBranch(env, { ...baseArgs, testFilePath: "test/e2e/custom.spec.ts" });

    expect((treeBody.tree as Array<{ path: string }>)[0]?.path).toBe("test/e2e/custom.spec.ts");
  });

  it("declines with a clear reason on a 403/404 (no write access -- fork without maintainer edits)", async () => {
    const env = envWithKey();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      if (url.endsWith("/git/commits/head-commit-sha")) return new Response("forbidden", { status: 403 });
      return new Response("unexpected", { status: 500 });
    });

    const result = await commitE2eTestToPrBranch(env, baseArgs);
    expect(result).toMatchObject({ status: "declined" });
    if (result.status !== "declined") throw new Error("unreachable");
    expect(result.reason).toContain("no write access");
  });

  it("declines with a clear reason on a 422/409 (the branch moved since this pass started)", async () => {
    const env = envWithKey();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      if (url.endsWith("/git/commits/head-commit-sha") && method === "GET") return Response.json({ tree: { sha: "base-tree-sha" } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "new-tree-sha" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "new-commit-sha" });
      if (method === "PATCH") return new Response("conflict", { status: 422 });
      return new Response("unexpected", { status: 500 });
    });

    const result = await commitE2eTestToPrBranch(env, baseArgs);
    expect(result).toMatchObject({ status: "declined" });
    if (result.status !== "declined") throw new Error("unreachable");
    expect(result.reason).toContain("branch moved");
  });

  it("returns status: error (not declined, not thrown) on a genuinely unexpected failure", async () => {
    const env = envWithKey();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      if (url.endsWith("/git/commits/head-commit-sha")) return new Response("server exploded", { status: 500 });
      return new Response("unexpected", { status: 500 });
    });

    const result = await commitE2eTestToPrBranch(env, baseArgs);
    expect(result.status).toBe("error");
  });

  it("reports a genuinely unexpected failure (never throws) even when the underlying rejection is not itself an Error", async () => {
    const env = envWithKey();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      throw "boom"; // deliberately a non-Error throw -- octokit wraps this into its own Error before it
      // ever reaches our catch block, so this asserts the fail-safe status/shape, not a literal message.
    });

    const result = await commitE2eTestToPrBranch(env, baseArgs);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
