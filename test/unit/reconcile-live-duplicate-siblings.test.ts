import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileLiveDuplicateSiblings } from "../../src/queue/processors";
import { createInstallationToken } from "../../src/github/app";
import type { PullRequestRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

// reconcileLiveDuplicateSiblings re-fetches a lower duplicate sibling's LIVE state via createInstallationToken +
// the REST /pulls/{n} call, so mock the token mint (the test env holds no App key) and stub fetch per case.
vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  createInstallationToken: vi.fn(),
}));
const mockedToken = vi.mocked(createInstallationToken);

function makePr(number: number, state: string, linkedIssues: number[]): PullRequestRecord {
  return { repoFullName: "owner/repo", number, title: `PR ${number}`, state, labels: [], linkedIssues };
}

/** Stub fetch so any /pulls/{n} returns the mapped live state; an unmapped path 404s (→ undefined live state). */
function stubLiveStates(states: Record<number, string>): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [number, state] of Object.entries(states)) {
      if (url.includes(`/pulls/${number}`)) return new Response(JSON.stringify({ state }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("reconcileLiveDuplicateSiblings (#dup-winner / audit #15)", () => {
  beforeEach(() => {
    mockedToken.mockReset();
    mockedToken.mockRejectedValue(new Error("no app key in test env"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("flag OFF ⇒ returns the cached list untouched and never hits GitHub", async () => {
    const env = createTestEnv();
    env.GITTENSORY_DUPLICATE_WINNER = "false";
    vi.stubGlobal("fetch", async () => {
      throw new Error("fetch must not be called when the flag is off");
    });
    const siblings = [makePr(5, "open", [1])];
    const pr = makePr(9, "open", [1]);
    expect(await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings)).toBe(siblings);
  });

  it("flag ON but the PR links no issue ⇒ unchanged (no cluster to adjudicate)", async () => {
    const env = createTestEnv();
    env.GITTENSORY_DUPLICATE_WINNER = "true";
    const siblings = [makePr(5, "open", [1])];
    const pr = makePr(9, "open", []);
    expect(await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings)).toBe(siblings);
  });

  it("flag ON but every overlapping sibling is HIGHER-numbered ⇒ this PR already wins, unchanged (no fetch)", async () => {
    const env = createTestEnv();
    env.GITTENSORY_DUPLICATE_WINNER = "true";
    vi.stubGlobal("fetch", async () => {
      throw new Error("higher-numbered siblings cannot demote the winner; no live fetch expected");
    });
    const siblings = [makePr(12, "open", [1])];
    const pr = makePr(9, "open", [1]);
    expect(await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings)).toBe(siblings);
  });

  it("flag ON, a lower sibling that does NOT overlap the issue set ⇒ unchanged (not a cluster member)", async () => {
    const env = createTestEnv();
    env.GITTENSORY_DUPLICATE_WINNER = "true";
    const siblings = [makePr(5, "open", [2])];
    const pr = makePr(9, "open", [1]);
    expect(await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings)).toBe(siblings);
  });

  it("flag ON, a lower sibling already cached non-open ⇒ unchanged (the cache already excludes it)", async () => {
    const env = createTestEnv();
    env.GITTENSORY_DUPLICATE_WINNER = "true";
    const siblings = [makePr(5, "closed", [1])];
    const pr = makePr(9, "open", [1]);
    expect(await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings)).toBe(siblings);
  });

  it("flag ON, a lower overlapping sibling LIVE-closed ⇒ dropped so the real lowest-OPEN PR is the winner", async () => {
    const env = createTestEnv();
    env.GITTENSORY_DUPLICATE_WINNER = "true";
    stubLiveStates({ 5: "closed" });
    const siblings = [makePr(5, "open", [1])];
    const pr = makePr(9, "open", [1]);
    const result = await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings);
    expect(result.map((p) => p.number)).toEqual([]);
  });

  it("flag ON, a lower overlapping sibling LIVE-open ⇒ kept (this PR is genuinely a loser)", async () => {
    const env = createTestEnv();
    env.GITTENSORY_DUPLICATE_WINNER = "true";
    stubLiveStates({ 5: "open" });
    const siblings = [makePr(5, "open", [1])];
    const pr = makePr(9, "open", [1]);
    const result = await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings);
    expect(result.map((p) => p.number)).toEqual([5]);
  });

  it("flag ON, an unreadable live fetch ⇒ fails OPEN (sibling kept; no new spare on a transient hiccup)", async () => {
    const env = createTestEnv();
    env.GITTENSORY_DUPLICATE_WINNER = "true";
    stubLiveStates({}); // every /pulls/{n} 404s ⇒ undefined live state
    const siblings = [makePr(5, "open", [1])];
    const pr = makePr(9, "open", [1]);
    const result = await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings);
    expect(result.map((p) => p.number)).toEqual([5]);
  });

  it("flag ON, two lower overlapping siblings (one live-closed, one live-open) ⇒ only the closed one is dropped", async () => {
    const env = createTestEnv();
    env.GITTENSORY_DUPLICATE_WINNER = "true";
    stubLiveStates({ 4: "closed", 5: "open" });
    const siblings = [makePr(4, "open", [1]), makePr(5, "open", [1])];
    const pr = makePr(9, "open", [1]);
    const result = await reconcileLiveDuplicateSiblings(env, null, "owner/repo", pr, siblings);
    expect(result.map((p) => p.number)).toEqual([5]);
  });

  it("flag ON, a numeric installation whose token mint THROWS ⇒ falls back to the public token and still reconciles", async () => {
    const env = createTestEnv();
    env.GITTENSORY_DUPLICATE_WINNER = "true";
    env.GITHUB_PUBLIC_TOKEN = "public-tok";
    stubLiveStates({ 5: "closed" });
    const siblings = [makePr(5, "open", [1])];
    const pr = makePr(9, "open", [1]);
    const result = await reconcileLiveDuplicateSiblings(env, 4242, "owner/repo", pr, siblings);
    expect(mockedToken).toHaveBeenCalledWith(env, 4242);
    expect(result.map((p) => p.number)).toEqual([]);
  });

  it("flag ON, a numeric installation whose token mint SUCCEEDS ⇒ uses the installation token to reconcile", async () => {
    const env = createTestEnv();
    env.GITTENSORY_DUPLICATE_WINNER = "true";
    mockedToken.mockResolvedValue("inst-tok");
    stubLiveStates({ 5: "closed" });
    const siblings = [makePr(5, "open", [1])];
    const pr = makePr(9, "open", [1]);
    const result = await reconcileLiveDuplicateSiblings(env, 4242, "owner/repo", pr, siblings);
    expect(mockedToken).toHaveBeenCalledWith(env, 4242);
    expect(result.map((p) => p.number)).toEqual([]);
  });
});
