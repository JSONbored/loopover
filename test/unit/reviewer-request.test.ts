import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCodeownersFile, getRequestedReviewers, requestPullRequestReviewers } from "../../src/github/reviewer-request";
import { createTestEnv } from "../helpers/d1";

async function generatePrivateKeyPem(): Promise<string> {
  const key = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const base64 = Buffer.from(exported as ArrayBuffer)
    .toString("base64")
    .replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

describe("fetchCodeownersFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns content when CODEOWNERS found at root path", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/HEAD/CODEOWNERS")) return new Response("* @owner\n");
      return new Response("not found", { status: 404 });
    });
    const result = await fetchCodeownersFile("owner/repo");
    expect(result).toBe("* @owner\n");
  });

  it("falls through to .github/CODEOWNERS when root path returns 404", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/HEAD/CODEOWNERS")) return new Response("not found", { status: 404 });
      if (url.endsWith("/HEAD/.github/CODEOWNERS")) return new Response("* @github-owner\n");
      return new Response("not found", { status: 404 });
    });
    const result = await fetchCodeownersFile("owner/repo");
    expect(result).toBe("* @github-owner\n");
  });

  it("falls through to docs/CODEOWNERS when first two paths fail", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/HEAD/docs/CODEOWNERS")) return new Response("* @docs-owner\n");
      return new Response("not found", { status: 404 });
    });
    const result = await fetchCodeownersFile("owner/repo");
    expect(result).toBe("* @docs-owner\n");
  });

  it("returns null when all candidate paths return 404", async () => {
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    expect(await fetchCodeownersFile("owner/repo")).toBeNull();
  });

  it("returns null for malformed repoFullName (no slash, leading slash, trailing slash)", async () => {
    vi.stubGlobal("fetch", async () => new Response("should not be called", { status: 200 }));
    expect(await fetchCodeownersFile("noslash")).toBeNull();
    expect(await fetchCodeownersFile("/leading")).toBeNull();
    expect(await fetchCodeownersFile("trailing/")).toBeNull();
  });

  it("skips a path when content-length header exceeds the size limit", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      callCount++;
      const url = input.toString();
      if (url.endsWith("/HEAD/CODEOWNERS")) {
        return new Response("* @owner\n", { headers: { "content-length": String(512_001) } });
      }
      if (url.endsWith("/HEAD/.github/CODEOWNERS")) return new Response("* @fallback\n");
      return new Response("not found", { status: 404 });
    });
    const result = await fetchCodeownersFile("owner/repo");
    expect(result).toBe("* @fallback\n");
    expect(callCount).toBeGreaterThan(1);
  });

  it("returns null when fetch throws (network error)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network failure");
    });
    expect(await fetchCodeownersFile("owner/repo")).toBeNull();
  });

  it("proceeds when content-length header is non-numeric (treated as unknown size)", async () => {
    // Number.parseInt("junk") is NaN → not finite, so the size guard short-circuits and we read the body.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/HEAD/CODEOWNERS")) {
        return new Response("* @owner\n", { headers: { "content-length": "junk" } });
      }
      return new Response("not found", { status: 404 });
    });
    expect(await fetchCodeownersFile("owner/repo")).toBe("* @owner\n");
  });

  it("reads the body and skips a path whose actual content exceeds the size limit", async () => {
    // A content-length within the limit but an oversized actual body: the guard does not short-circuit
    // (parsed <= limit), so the body is read and then rejected by the post-read size check.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/HEAD/CODEOWNERS")) {
        return new Response("x".repeat(512_001), { headers: { "content-length": "1" } });
      }
      return new Response("not found", { status: 404 });
    });
    expect(await fetchCodeownersFile("owner/repo")).toBeNull();
  });
});

describe("getRequestedReviewers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns lowercase reviewer logins from the GitHub API", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "tok" });
      if (url.includes("/requested_reviewers")) return Response.json({ users: [{ login: "Alice" }, { login: "BOB" }] });
      return new Response("not found", { status: 404 });
    });
    const reviewers = await getRequestedReviewers(env, 1, "owner/repo", 42);
    expect(reviewers).toEqual(new Set(["alice", "bob"]));
  });

  it("returns empty set when API request fails", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "tok" });
      return new Response("internal error", { status: 500 });
    });
    const reviewers = await getRequestedReviewers(env, 1, "owner/repo", 42);
    expect(reviewers).toEqual(new Set());
  });

  it("returns empty set for users with no login field", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "tok" });
      if (url.includes("/requested_reviewers")) return Response.json({ users: [{ login: null }, {}] });
      return new Response("not found", { status: 404 });
    });
    const reviewers = await getRequestedReviewers(env, 1, "owner/repo", 42);
    expect(reviewers).toEqual(new Set());
  });

  it("returns empty set on invalid repoFullName without making network calls", async () => {
    const env = createTestEnv({});
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(input.toString());
      return new Response("unexpected", { status: 200 });
    });
    const reviewers = await getRequestedReviewers(env, 1, "noslash", 42);
    expect(reviewers).toEqual(new Set());
    expect(calls).toHaveLength(0);
  });

  it("returns empty set when the response omits the users field", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "tok" });
      // No "users" key at all — the nullish coalescing falls back to an empty iterable.
      if (url.includes("/requested_reviewers")) return Response.json({});
      return new Response("not found", { status: 404 });
    });
    const reviewers = await getRequestedReviewers(env, 1, "owner/repo", 42);
    expect(reviewers).toEqual(new Set());
  });
});

describe("requestPullRequestReviewers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts reviewer logins to GitHub API", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    let reviewersSent: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "tok" });
      if (url.includes("/requested_reviewers") && (init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { reviewers?: string[] };
        reviewersSent = body.reviewers ?? [];
        return Response.json({ id: 1 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });
    await requestPullRequestReviewers(env, 1, "owner/repo", 42, ["alice", "bob"]);
    expect(reviewersSent).toEqual(["alice", "bob"]);
  });

  it("is a no-op when reviewerLogins is empty — makes no network calls", async () => {
    const env = createTestEnv({});
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(input.toString());
      return new Response("unexpected", { status: 200 });
    });
    await requestPullRequestReviewers(env, 1, "owner/repo", 42, []);
    expect(calls).toHaveLength(0);
  });

  it("throws on invalid repoFullName", async () => {
    const env = createTestEnv({});
    await expect(requestPullRequestReviewers(env, 1, "noslash", 42, ["alice"])).rejects.toThrow(/Invalid repository/);
  });

  it("throws when the GitHub API returns a non-2xx response", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/access_tokens")) return Response.json({ token: "tok" });
      return new Response("unprocessable", { status: 422 });
    });
    await expect(requestPullRequestReviewers(env, 1, "owner/repo", 42, ["alice"])).rejects.toThrow();
  });
});
