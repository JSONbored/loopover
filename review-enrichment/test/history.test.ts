import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyAuthorTier,
  extractLinkedIssues,
  fetchAuthorMergedCount,
  scanHistory,
} from "../src/analyzers/history.ts";

describe("history analyzer", () => {
  it("extracts linked issues from PR body with default and explicit repos", () => {
    assert.deepEqual(
      extractLinkedIssues("Fixes #12 and closes #34", "org/app"),
      [
        { repo: "org/app", number: 12 },
        { repo: "org/app", number: 34 },
      ],
    );
    assert.deepEqual(
      extractLinkedIssues("Closes other/repo#99", "org/app"),
      [{ repo: "other/repo", number: 99 }],
    );
  });

  it("classifies author tiers from merged PR counts", () => {
    assert.equal(classifyAuthorTier(null), "unknown");
    assert.equal(classifyAuthorTier(0), "newcomer");
    assert.equal(classifyAuthorTier(2), "newcomer");
    assert.equal(classifyAuthorTier(3), "established");
    assert.equal(classifyAuthorTier(40), "established");
  });

  it("fetchAuthorMergedCount reads search total_count", async () => {
    const fetchFn = async () =>
      ({
        ok: true,
        json: async () => ({ total_count: 7 }),
      }) as Response;
    assert.equal(
      await fetchAuthorMergedCount(
        "org/app",
        "dev1",
        "token",
        fetchFn as typeof fetch,
      ),
      7,
    );
  });

  it("scanHistory degrades gracefully without a token but still parses links", async () => {
    const result = await scanHistory({
      repoFullName: "org/app",
      prNumber: 5,
      author: "dev1",
      body: "Fixes #42",
    });
    assert.ok(result);
    assert.equal(result!.authorLogin, "dev1");
    assert.equal(result!.authorTier, "unknown");
    assert.deepEqual(result!.linkedIssues, [
      {
        number: 42,
        repo: "org/app",
        state: null,
        title: null,
        aligned: true,
      },
    ]);
  });

  it("scanHistory fetches author history and issue state when token present", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      if (url.includes("/search/issues")) {
        return {
          ok: true,
          json: async () => ({ total_count: 1 }),
        } as Response;
      }
      if (url.includes("/issues/7")) {
        return {
          ok: true,
          json: async () => ({ state: "open", title: "Bug in parser" }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    }) as typeof fetch;

    const result = await scanHistory(
      {
        repoFullName: "org/app",
        prNumber: 9,
        author: "dev1",
        body: "Fixes #7",
        githubToken: "ghs_test",
      },
      fetchFn,
    );
    assert.equal(result!.authorTier, "newcomer");
    assert.equal(result!.linkedIssues[0]?.state, "open");
    assert.match(result!.linkedIssues[0]?.title ?? "", /Bug in parser/);
    assert.ok(calls.some((u) => u.includes("/search/issues")));
    assert.ok(calls.some((u) => u.includes("/issues/7")));
  });
});
