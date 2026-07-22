import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLiveSessionGitHubToken } from "../../src/auth/github-oauth";
import { createAprRepoForCustomerSession } from "../../src/orb/apr-repo-creation";
import { createTestEnv } from "../helpers/d1";

// Mock the session-token lookup so no real session/DB state is needed. The mocked value is an opaque,
// obviously-fake placeholder — never a PEM/private-key-shaped fixture (a prior attempt at a sibling APR
// module was auto-closed by the secret scanner for exactly that).
vi.mock("../../src/auth/github-oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/auth/github-oauth")>()),
  getLiveSessionGitHubToken: vi.fn(),
}));
const mockedToken = vi.mocked(getLiveSessionGitHubToken);

/** Capture the outbound request so we can assert the endpoint, method, auth, and body. */
function stubFetch(handler: (url: string, init: RequestInit) => Response): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {}));
}

describe("createAprRepoForCustomerSession (#7637)", () => {
  beforeEach(() => {
    mockedToken.mockReset();
    mockedToken.mockResolvedValue("gho_customer_session_token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to /user/repos with the customer session's own token, defaulting to private", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    stubFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return new Response(
        JSON.stringify({ full_name: "joesmoe/widgets", html_url: "https://github.com/joesmoe/widgets", node_id: "R_abc123" }),
        { status: 201 },
      );
    });

    const env = createTestEnv();
    const result = await createAprRepoForCustomerSession(env, "session-1", "widgets");

    expect(mockedToken).toHaveBeenCalledWith(env, "session-1");
    expect(seenUrl).toBe("https://api.github.com/user/repos");
    expect(seenInit.method).toBe("POST");
    expect((seenInit.headers as Record<string, string>).authorization).toBe("Bearer gho_customer_session_token");
    expect(JSON.parse(String(seenInit.body))).toEqual({ name: "widgets", private: true });
    expect(result).toEqual({
      created: true,
      fullName: "joesmoe/widgets",
      htmlUrl: "https://github.com/joesmoe/widgets",
      nodeId: "R_abc123",
    });
  });

  it("passes through an explicit private:false and an optional description", async () => {
    let seenInit: RequestInit = {};
    stubFetch((_url, init) => {
      seenInit = init;
      return new Response(
        JSON.stringify({ full_name: "joesmoe/widgets", html_url: "https://github.com/joesmoe/widgets", node_id: "R_abc123" }),
        { status: 201 },
      );
    });

    await createAprRepoForCustomerSession(createTestEnv(), "session-1", "widgets", { private: false, description: "A widget repo" });

    expect(JSON.parse(String(seenInit.body))).toEqual({ name: "widgets", private: false, description: "A widget repo" });
  });

  it("fails closed without calling GitHub when the customer session has no live token", async () => {
    mockedToken.mockResolvedValue(null);
    const calls: string[] = [];
    stubFetch((url) => {
      calls.push(url);
      return new Response("", { status: 200 });
    });

    const result = await createAprRepoForCustomerSession(createTestEnv(), "session-1", "widgets");

    expect(result).toEqual({ created: false, status: null, error: "customer_session_token_unavailable" });
    expect(calls).toEqual([]);
  });

  it("returns a structured failure on a GitHub API error (e.g. a repo-name collision) without throwing", async () => {
    stubFetch(() => new Response("Repository creation failed.", { status: 422 }));

    const result = await createAprRepoForCustomerSession(createTestEnv(), "session-1", "widgets");

    expect(result).toEqual({ created: false, status: 422, error: "Repository creation failed." });
  });

  it("fails closed when GitHub returns 2xx but the payload is missing required fields", async () => {
    stubFetch(() => new Response(JSON.stringify({}), { status: 201 }));

    const result = await createAprRepoForCustomerSession(createTestEnv(), "session-1", "widgets");

    expect(result).toEqual({ created: false, status: 201, error: "repo creation response missing required fields" });
  });
});
