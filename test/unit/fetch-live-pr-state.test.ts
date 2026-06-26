import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLivePullRequestState } from "../../src/github/backfill";
import { createTestEnv } from "../helpers/d1";

describe("fetchLivePullRequestState (#dup-winner / audit #15)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the live state from GET /pulls/{n}", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/repos/owner/repo/pulls/7");
      return Response.json({ state: "closed" });
    });
    expect(await fetchLivePullRequestState(env, "owner/repo", 7, "tok")).toBe("closed");
  });

  it("returns undefined when the payload omits state", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    vi.stubGlobal("fetch", async () => Response.json({}));
    expect(await fetchLivePullRequestState(env, "owner/repo", 7, "tok")).toBeUndefined();
  });

  it("returns undefined (fail-open) when the fetch errors", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    expect(await fetchLivePullRequestState(env, "owner/repo", 7, "tok")).toBeUndefined();
  });
});
