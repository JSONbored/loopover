import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyPullRequestFreshness,
  fetchPullRequestFreshness,
  pullRequestFreshnessDetail,
  reviewedPullRequestHeadSha,
} from "../../src/github/pr-freshness";
import { createTestEnv } from "../helpers/d1";

describe("PR freshness guards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies a matching open head as current", () => {
    const result = classifyPullRequestFreshness({ state: "open", head: { sha: "sha1" } }, "sha1");
    expect(result).toEqual({ status: "current", liveHeadSha: "sha1", liveState: "open" });
    expect(pullRequestFreshnessDetail(result)).toBe("PR is current");
  });

  it("allows an open PR when no exact head was requested", () => {
    expect(classifyPullRequestFreshness({ state: "open", head: {} }, null)).toEqual({
      status: "current",
      liveHeadSha: null,
      liveState: "open",
    });
  });

  it("treats unavailable live state as stale for callers that require proof", () => {
    const result = classifyPullRequestFreshness(undefined, "sha1");
    expect(result).toMatchObject({ status: "stale", reason: "unavailable", expectedHeadSha: "sha1" });
    expect(pullRequestFreshnessDetail(result)).toBe("live PR state could not be verified");
  });

  it("treats malformed live PR responses without state as unverifiable", () => {
    const result = classifyPullRequestFreshness({ state: undefined as unknown as string, head: { sha: "sha1" } }, "sha1");
    expect(result).toMatchObject({ status: "stale", reason: "unavailable", liveHeadSha: "sha1", liveState: null });
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

  it("uses the stored PR head before falling back to advisory metadata", () => {
    expect(reviewedPullRequestHeadSha(" pr-sha ", "advisory-sha")).toBe("pr-sha");
    expect(reviewedPullRequestHeadSha(null, " advisory-sha ")).toBe("advisory-sha");
    expect(reviewedPullRequestHeadSha(" ", undefined)).toBeNull();
  });

  it("normalizes head SHAs case-insensitively before comparing or returning them", () => {
    expect(reviewedPullRequestHeadSha(" AbC123 ", "fallback")).toBe("abc123");
    expect(
      classifyPullRequestFreshness({ state: "open", head: { sha: "AbC123" } }, "abc123"),
    ).toEqual({ status: "current", liveHeadSha: "abc123", liveState: "open" });
    expect(
      classifyPullRequestFreshness({ state: "open", head: { sha: "abc123" } }, " ABC123 "),
    ).toEqual({ status: "current", liveHeadSha: "abc123", liveState: "open" });
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

  it("fails closed when no token can verify live PR state", async () => {
    const env = createTestEnv();
    const result = await fetchPullRequestFreshness(env, {
      installationId: 123,
      repoFullName: "owner/repo",
      pullNumber: 7,
      expectedHeadSha: "sha7",
    });
    expect(result).toMatchObject({ status: "stale", reason: "unavailable" });
  });
});
