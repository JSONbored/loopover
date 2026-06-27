import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLivePullRequest } from "../../src/github/backfill";
import { createTestEnv } from "../helpers/d1";

describe("fetchLivePullRequest (#sweep-resync)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the full live payload from GET /pulls/{n}", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/repos/owner/repo/pulls/7");
      return Response.json({
        number: 7,
        title: "Live PR",
        state: "open",
        head: { sha: "live-sha", ref: "feature" },
      });
    });
    const live = await fetchLivePullRequest(env, "owner/repo", 7, "tok");
    expect(live?.number).toBe(7);
    expect(live?.head?.sha).toBe("live-sha");
  });

  it("returns undefined (fail-open) when the fetch errors", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    expect(
      await fetchLivePullRequest(env, "owner/repo", 7, "tok"),
    ).toBeUndefined();
  });
});
