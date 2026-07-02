import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOverrideHeadSha } from "../../src/queue/processors";
import { createInstallationToken } from "../../src/github/app";
import { upsertPullRequestDetailSyncState } from "../../src/db/repositories";
import type { PullRequestRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

// resolveOverrideHeadSha re-fetches the live head via createInstallationToken + REST /pulls/{n}; mock the token
// mint (the test env holds no App key) and stub fetch per case.
vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  createInstallationToken: vi.fn(),
}));
const mockedToken = vi.mocked(createInstallationToken);

function makePr(headSha: string | null): PullRequestRecord {
  return { repoFullName: "owner/repo", number: 90, title: "Override me", state: "open", labels: [], linkedIssues: [], headSha };
}

function stubLiveHead(sha: string | null): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input).includes("/pulls/90")) return new Response(JSON.stringify(sha === null ? {} : { head: { sha } }), { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

describe("resolveOverrideHeadSha (#16 / gate-override stale head)", () => {
  beforeEach(() => {
    mockedToken.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the LIVE head when the token mint succeeds (overrides the current commit, not the cached one)", async () => {
    const env = createTestEnv();
    mockedToken.mockResolvedValue("inst-tok");
    stubLiveHead("live-sha");
    expect(await resolveOverrideHeadSha(env, 123, "owner/repo", makePr("stale-sha"))).toBe("live-sha");
    expect(mockedToken).toHaveBeenCalledWith(env, 123);
  });

  it("falls back to the public token when the mint throws, and still resolves the live head", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-tok" });
    mockedToken.mockRejectedValue(new Error("no app key"));
    stubLiveHead("live-sha");
    expect(await resolveOverrideHeadSha(env, 123, "owner/repo", makePr("stale-sha"))).toBe("live-sha");
  });

  it("fails OPEN to the cached head when the live fetch is unreadable", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-tok" });
    mockedToken.mockResolvedValue("inst-tok");
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    expect(await resolveOverrideHeadSha(env, 123, "owner/repo", makePr("stale-sha"))).toBe("stale-sha");
  });

  it("returns the cached head when the live payload omits head.sha (fail-open)", async () => {
    const env = createTestEnv();
    mockedToken.mockResolvedValue("inst-tok");
    stubLiveHead(null);
    expect(await resolveOverrideHeadSha(env, 123, "owner/repo", makePr("stale-sha"))).toBe("stale-sha");
  });

  it("REGRESSION (#2537, gate-flagged): a FRESH durable PR-state cache row for this PR must NOT short-circuit the live fetch — a commit landing inside the cache's freshness window right after the override comment is exactly the race this function exists to close, so it must always hit GitHub directly rather than trust a recent-but-possibly-already-stale cached headSha", async () => {
    const env = createTestEnv();
    mockedToken.mockResolvedValue("inst-tok");
    await upsertPullRequestDetailSyncState(env, {
      repoFullName: "owner/repo",
      pullNumber: 90,
      status: "complete",
      headSha: "cached-sha",
      prStateFetchedAt: new Date().toISOString(),
    });
    stubLiveHead("brand-new-live-sha");
    expect(await resolveOverrideHeadSha(env, 123, "owner/repo", makePr("stale-sha"))).toBe("brand-new-live-sha");
  });
});
