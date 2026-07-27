import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyPullRequestFreshness,
  fetchPullRequestFreshness,
  pullRequestFreshnessDetail,
  reviewedPullRequestHeadSha,
} from "../../src/github/pr-freshness";
import {
  clearInstallationTokenCacheForTest,
  setInstallationTokenStore,
} from "../../src/github/app";
import { createTestEnv } from "../helpers/d1";

describe("PR freshness guards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setInstallationTokenStore(null);
    clearInstallationTokenCacheForTest();
  });

  it("classifies a matching open head as current", () => {
    const result = classifyPullRequestFreshness({ state: "open", head: { sha: "sha1" } }, "sha1");
    expect(result).toEqual({ status: "current", liveHeadSha: "sha1", liveState: "open", liveLabels: [] });
    expect(pullRequestFreshnessDetail(result)).toBe("PR is current");
  });

  it("allows an open PR when no exact head was requested", () => {
    expect(classifyPullRequestFreshness({ state: "open", head: {} }, null)).toEqual({
      status: "current",
      liveHeadSha: null,
      liveState: "open",
      liveLabels: [],
    });
  });

  it("carries live label names alongside a current status (#3472 split-brain)", () => {
    const result = classifyPullRequestFreshness(
      { state: "open", head: { sha: "sha1" }, labels: [{ name: "manual-review" }, { name: "size/L" }] },
      "sha1",
    );
    expect(result).toEqual({ status: "current", liveHeadSha: "sha1", liveState: "open", liveLabels: ["manual-review", "size/L"] });
  });

  it("drops nameless label entries when carrying live labels", () => {
    const result = classifyPullRequestFreshness(
      { state: "open", head: { sha: "sha1" }, labels: [{ name: "manual-review" }, {}] },
      "sha1",
    );
    expect(result).toEqual({ status: "current", liveHeadSha: "sha1", liveState: "open", liveLabels: ["manual-review"] });
  });

  it("treats unavailable live state as stale for callers that require proof", () => {
    const result = classifyPullRequestFreshness(undefined, "sha1");
    expect(result).toMatchObject({ status: "stale", reason: "unavailable", expectedHeadSha: "sha1" });
    expect(pullRequestFreshnessDetail(result)).toBe("live PR state could not be verified");
  });

  it("carries internal unavailable metadata without changing the public detail", () => {
    const result = classifyPullRequestFreshness(undefined, "sha1", {
      unavailableSource: "pull_request_fetch",
      unavailableDetail: "GitHub API failed for owner/repo/pulls/1 (503)",
    });
    expect(result).toMatchObject({
      status: "stale",
      reason: "unavailable",
      expectedHeadSha: "sha1",
      unavailableSource: "pull_request_fetch",
      unavailableDetail: "GitHub API failed for owner/repo/pulls/1 (503)",
    });
    expect(pullRequestFreshnessDetail(result)).toBe("live PR state could not be verified");
  });

  it("treats malformed live PR responses without state as unverifiable", () => {
    const result = classifyPullRequestFreshness({ state: undefined as unknown as string, head: { sha: "sha1" } }, "sha1");
    expect(result).toMatchObject({
      status: "stale",
      reason: "unavailable",
      liveHeadSha: "sha1",
      liveState: null,
      unavailableSource: "live_payload",
    });
  });

  it("preserves a supplied unavailable source for malformed live PR payloads", () => {
    const result = classifyPullRequestFreshness(
      { state: undefined as unknown as string, head: { sha: "sha1" } },
      "sha1",
      { unavailableSource: "pull_request_fetch", unavailableDetail: "malformed replay" },
    );
    expect(result).toMatchObject({
      status: "stale",
      reason: "unavailable",
      liveHeadSha: "sha1",
      liveState: null,
      unavailableSource: "pull_request_fetch",
      unavailableDetail: "malformed replay",
    });
  });

  it("treats closed PRs as stale even when the head still matches", () => {
    const result = classifyPullRequestFreshness({ state: "closed", head: { sha: "sha1" } }, "sha1");
    expect(result).toMatchObject({ status: "stale", reason: "closed", liveState: "closed", liveHeadSha: "sha1" });
    expect(pullRequestFreshnessDetail(result)).toBe("PR is no longer open (live state: closed)");
  });

  it("treats missing live head as stale when an exact reviewed head is required", () => {
    const result = classifyPullRequestFreshness({ state: "open", head: {} }, "sha1");
    expect(result).toMatchObject({ status: "stale", reason: "head_unresolved", expectedHeadSha: "sha1" });
    expect(pullRequestFreshnessDetail(result)).toBe("live PR head SHA could not be verified");
  });

  it("treats a force-pushed head as stale", () => {
    const result = classifyPullRequestFreshness({ state: "open", head: { sha: "newsha" } }, "oldsha");
    expect(result).toMatchObject({ status: "stale", reason: "head_changed", expectedHeadSha: "oldsha", liveHeadSha: "newsha" });
    expect(pullRequestFreshnessDetail(result)).toBe("PR head changed from oldsha to newsha");
  });

  it("uses public-safe unknown fallbacks when stale detail metadata is absent", () => {
    expect(
      pullRequestFreshnessDetail({
        status: "stale",
        reason: "closed",
        expectedHeadSha: "sha1",
        liveHeadSha: "sha1",
        liveState: null,
      }),
    ).toBe("PR is no longer open (live state: unknown)");
    expect(
      pullRequestFreshnessDetail({
        status: "stale",
        reason: "head_changed",
        expectedHeadSha: null,
        liveHeadSha: null,
        liveState: "open",
      }),
    ).toBe("PR head changed from unknown to unknown");
  });

  it("does not require draft state by default, even when the PR is no longer a draft", () => {
    const result = classifyPullRequestFreshness({ state: "open", head: { sha: "sha1" }, draft: false }, "sha1");
    expect(result).toEqual({ status: "current", liveHeadSha: "sha1", liveState: "open", liveLabels: [] });
  });

  it("REGRESSION (#2130 follow-up): treats a same-head PR converted back to ready_for_review as stale when the caller requires draft", () => {
    const result = classifyPullRequestFreshness({ state: "open", head: { sha: "sha1" }, draft: false }, "sha1", { requireDraft: true });
    expect(result).toMatchObject({ status: "stale", reason: "no_longer_draft", liveState: "open", liveHeadSha: "sha1" });
    expect(pullRequestFreshnessDetail(result)).toBe("PR is no longer a draft");
  });

  it("treats a still-draft PR as current when the caller requires draft", () => {
    const result = classifyPullRequestFreshness({ state: "open", head: { sha: "sha1" }, draft: true }, "sha1", { requireDraft: true });
    expect(result).toEqual({ status: "current", liveHeadSha: "sha1", liveState: "open", liveLabels: [] });
  });

  it("treats a missing draft field as stale when the caller requires draft (fail-safe: only an explicit true counts)", () => {
    const result = classifyPullRequestFreshness({ state: "open", head: { sha: "sha1" } }, "sha1", { requireDraft: true });
    expect(result).toMatchObject({ status: "stale", reason: "no_longer_draft" });
  });

  it("fetches live PR state including draft, and requires draft when requested", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    vi.stubGlobal("fetch", async () => Response.json({ state: "open", head: { sha: "sha7" }, draft: false }));
    await expect(
      fetchPullRequestFreshness(env, {
        installationId: 123,
        repoFullName: "owner/repo",
        pullNumber: 7,
        expectedHeadSha: "sha7",
        requireDraft: true,
      }),
    ).resolves.toMatchObject({ status: "stale", reason: "no_longer_draft" });
  });

  it("uses the stored PR head before falling back to advisory metadata", () => {
    expect(reviewedPullRequestHeadSha(" pr-sha ", "advisory-sha")).toBe("pr-sha");
    expect(reviewedPullRequestHeadSha(null, " advisory-sha ")).toBe("advisory-sha");
    expect(reviewedPullRequestHeadSha(" ", undefined)).toBeNull();
  });

  it("normalizes head SHAs case-insensitively before comparing or returning them", () => {
    expect(reviewedPullRequestHeadSha(" AbC123 ", "fallback")).toBe("abc123");
    expect(
      classifyPullRequestFreshness({ state: "open", head: { sha: "AbC123" } }, "abc123"),
    ).toEqual({ status: "current", liveHeadSha: "abc123", liveState: "open", liveLabels: [] });
    expect(
      classifyPullRequestFreshness({ state: "open", head: { sha: "abc123" } }, " ABC123 "),
    ).toEqual({ status: "current", liveHeadSha: "abc123", liveState: "open", liveLabels: [] });
    expect(
      classifyPullRequestFreshness({ state: "open", head: { sha: "NewSha" } }, "oldsha"),
    ).toMatchObject({ status: "stale", reason: "head_changed", expectedHeadSha: "oldsha", liveHeadSha: "newsha" });
  });

  it("fetches live PR state using the existing GitHub GET path", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/repos/owner/repo/pulls/7");
      return Response.json({ state: "open", head: { sha: "sha7" } });
    });
    await expect(
      fetchPullRequestFreshness(env, {
        installationId: 123,
        repoFullName: "owner/repo",
        pullNumber: 7,
        expectedHeadSha: "sha7",
      }),
    ).resolves.toMatchObject({ status: "current", liveHeadSha: "sha7" });
  });

  it("classifies live PR fetch failures as retryable unavailable freshness metadata", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/repos/owner/repo/pulls/7");
      return new Response("temporary outage", { status: 503 });
    });
    const result = await fetchPullRequestFreshness(env, {
      installationId: 123,
      repoFullName: "owner/repo",
      pullNumber: 7,
      expectedHeadSha: "sha7",
    });
    expect(result).toMatchObject({
      status: "stale",
      reason: "unavailable",
      unavailableSource: "pull_request_fetch",
      unavailableDetail: expect.stringContaining("503"),
    });
  });

  it("self-heals a stale cached installation token on the live PR-freshness read (401 -> re-mint -> current)", async () => {
    // Regression for the read-path fail-closed bug: fetchPullRequestFreshness fed a stale cached installation
    // token straight into the live PR fetch with no retry, so a single 401 was classified `status: "stale",
    // reason: "unavailable"` -- failing the reopen-guard/gate-override re-check closed for what the write path
    // would have transparently retried. It now routes through withInstallationTokenRetry (#6191).
    const env = createTestEnv();
    let rejected = false;
    setInstallationTokenStore({
      get: async () => ({ token: rejected ? "fresh-token" : "stale-token", expiresAtMs: Date.now() + 60 * 60_000 }),
      set: async () => {},
    });
    const seenTokens: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const token = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      seenTokens.push(token);
      if (token === "stale-token") {
        rejected = true;
        return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
      }
      return Response.json({ state: "open", head: { sha: "sha7" } });
    });
    const result = await fetchPullRequestFreshness(env, {
      installationId: 123,
      repoFullName: "owner/repo",
      pullNumber: 7,
      expectedHeadSha: "sha7",
    });
    expect(result).toMatchObject({ status: "current", liveHeadSha: "sha7", liveState: "open" });
    expect(seenTokens).toEqual(["stale-token", "fresh-token"]);
  });

  it("fails closed when no token can verify live PR state", async () => {
    const env = createTestEnv();
    const result = await fetchPullRequestFreshness(env, {
      installationId: 123,
      repoFullName: "owner/repo",
      pullNumber: 7,
      expectedHeadSha: "sha7",
    });
    expect(result).toMatchObject({
      status: "stale",
      reason: "unavailable",
      unavailableSource: "token",
      unavailableDetail: expect.any(String),
    });
  });

  // #9055: a contributor can retarget a PR's base with the head UNCHANGED — CI green against the old base,
  // review computed against it, no new commit anywhere. Every other freshness check (head, state, draft)
  // reports nothing wrong, because none of them look at the base. This is the one check that does.
  describe("detects a base retarget the head/state checks cannot see (#9055)", () => {
    it("is current when the live base matches what the caller expected", () => {
      const result = classifyPullRequestFreshness({ state: "open", head: { sha: "sha1" }, base: { ref: "main" } }, "sha1", { expectedBaseRef: "main" });
      expect(result).toEqual({ status: "current", liveHeadSha: "sha1", liveState: "open", liveLabels: [] });
    });

    it("goes stale when the live base has moved, even though the head has not", () => {
      const result = classifyPullRequestFreshness({ state: "open", head: { sha: "sha1" }, base: { ref: "release/2.0" } }, "sha1", { expectedBaseRef: "main" });
      expect(result).toMatchObject({ status: "stale", reason: "base_changed", liveHeadSha: "sha1" });
      expect(pullRequestFreshnessDetail(result)).toContain("base branch changed");
    });

    it("does not check the base when the caller supplied no expectation — every existing caller is unaffected", () => {
      const result = classifyPullRequestFreshness({ state: "open", head: { sha: "sha1" }, base: { ref: "release/2.0" } }, "sha1");
      expect(result.status).toBe("current");
    });

    it("threads expectedBaseRef through the live fetch path", async () => {
      const env = createTestEnv();
      setInstallationTokenStore({
        get: async () => ({ token: "tok", expiresAtMs: Date.now() + 10 * 60_000 }),
        set: async () => {},
      });
      vi.stubGlobal("fetch", async () => Response.json({ state: "open", head: { sha: "sha1" }, base: { ref: "release/2.0" } }));

      const result = await fetchPullRequestFreshness(env, {
        installationId: 123,
        repoFullName: "owner/repo",
        pullNumber: 7,
        expectedHeadSha: "sha1",
        expectedBaseRef: "main",
      });
      expect(result).toMatchObject({ status: "stale", reason: "base_changed" });
    });
  });
});
