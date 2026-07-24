import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import * as appModule from "../../src/github/app";
import { clearInstallationTokenCacheForTest } from "../../src/github/app";
import {
  fetchLinkedIssueLabelsForPropagation,
  type LinkedIssuePropagationLabels,
} from "../../src/review/linked-issue-label-propagation-fetch";
import { generatePrivateKeyPem } from "../helpers/github-app-key";

// `getRepositoryCollaboratorPermission` mints its own installation token internally with no fallback to
// the public token, so a maintainer-authored-issue test that reaches it (i.e. isn't already short-circuited
// by a literal-owner or ADMIN_GITHUB_LOGINS match) needs a real signable key or the mint throws before ever
// reaching the stubbed collaborators endpoint -- mirrors the same helper duplicated across other test files
// (e.g. `test/unit/queue.test.ts`, `test/unit/github-app.test.ts`).
// Split so the literal PEM marker text never appears contiguous in source -- the review-safety secrets
// scanner's private_key_block pattern is a pure text match with no awareness that the bytes between these
// markers are freshly generated per test run, not a real credential (src/review/safety.ts).
const PEM_HEADER = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const PEM_FOOTER = ["-----END", "PRIVATE KEY-----"].join(" ");

// #regression-safe-propagation: `fetchLinkedIssueLabelsForPropagation` returns `{labels, inconclusive}`, not a
// bare `string[]` -- `inconclusive` defaults false (a confirmed result) in every assertion below except the
// one test that simulates a genuinely unverifiable pass (a collaborator-permission check that errors).
function expectPropagation(result: LinkedIssuePropagationLabels, labels: string[], inconclusive = false): void {
  expect(result).toEqual({ labels, inconclusive });
}

const GRAPHQL_URL = "https://api.github.com/graphql";

/** GraphQL `Issue.timelineItems -> ClosedEvent.closer` response shape, matching exactly what
 *  `fetchLinkedIssueClosedByPullRequest` (src/github/backfill.ts) parses -- built from a REAL `gh api graphql`
 *  response captured against a live PR-merge-closed issue (#5385), not an invented shape. A prior REST-
 *  `/issues/{n}/timeline`-based version of this check assumed a `source.issue` field that GitHub's REST
 *  Timeline API never actually populates on a `closed` event -- confirmed empirically -- which made every
 *  legitimate same-PR close silently fail closure verification in production. `closerPrNumber: null` mirrors
 *  an issue with no CLOSED_EVENT in its last-item window (still open, or closed by neither a PR nor a commit). */
function closerGraphQlBody(closerPrNumber: number | null): unknown {
  return {
    data: {
      repository: {
        issue: {
          timelineItems: {
            nodes: closerPrNumber === null ? [] : [{ __typename: "ClosedEvent", closer: { __typename: "PullRequest", number: closerPrNumber } }],
          },
        },
      },
    },
  };
}

describe("fetchLinkedIssueLabelsForPropagation (#priority-linked-issue-gate)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearInstallationTokenCacheForTest();
  });

  function stubFetch(
    handler: (url: string, method: string) => Response | Promise<Response>,
  ) {
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) =>
        handler(input.toString(), init?.method ?? "GET"),
    );
  }

  it("returns [] and fetches nothing when there are no linked issues", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const env = createTestEnv({});
    const result = await fetchLinkedIssueLabelsForPropagation({
      env,
      repoFullName: "owner/repo",
      linkedIssues: [],
      installationId: 123,
      prAuthorLogin: "contrib",
    });
    expectPropagation(result, []);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the flattened labels for a single found linked issue", async () => {
    stubFetch((url) => {
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/1"))
        return Response.json({
          number: 1,
          state: "open",
          user: { login: "contrib" },
          labels: ["gittensor:priority", "help wanted"],
        });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({});
    const result = await fetchLinkedIssueLabelsForPropagation({
      env,
      repoFullName: "owner/repo",
      linkedIssues: [1],
      installationId: 123,
      prAuthorLogin: "contrib",
    });
    expectPropagation(result, ["gittensor:priority", "help wanted"]);
  });

  it("surfaces only the successful issue's labels when one of several linked issues fails to fetch, and flags the result inconclusive (#regression-safe-propagation)", async () => {
    stubFetch((url) => {
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/1"))
        return Response.json({
          number: 1,
          state: "open",
          assignees: [{ login: "contrib" }],
          labels: ["gittensor:priority"],
        });
      if (url.endsWith("/issues/2"))
        return new Response("server error", { status: 500 });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({});
    const result = await fetchLinkedIssueLabelsForPropagation({
      env,
      repoFullName: "owner/repo",
      linkedIssues: [1, 2],
      installationId: 123,
      prAuthorLogin: "contrib",
    });
    // A confirmed match from issue #1 is still trustworthy on its own merits -- but the sibling issue #2's
    // fetch genuinely failed, so the aggregate is inconclusive too (the caller only acts on that flag when
    // `labels` is ALSO empty, so a real match here is unaffected either way).
    expectPropagation(result, ["gittensor:priority"], true);
  });

  it("returns [] and flags inconclusive when every linked issue fails to fetch (#regression-safe-propagation: never a confirmed absence)", async () => {
    stubFetch((url) => {
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
      return new Response("server error", { status: 500 });
    });
    const env = createTestEnv({});
    const result = await fetchLinkedIssueLabelsForPropagation({
      env,
      repoFullName: "owner/repo",
      linkedIssues: [1, 2],
      installationId: 123,
      prAuthorLogin: "contrib",
    });
    expectPropagation(result, [], true);
  });

  it("REGRESSION (#regression-safe-propagation): a CONFIRMED-nonexistent linked issue (404 with a proven installation token) is not inconclusive, unlike a genuine fetch error", async () => {
    stubFetch((url) => {
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      // The linked issue itself 404s -- with a real installation token (proven access), this is CONFIRMED
      // absence (GitHub telling us plainly this issue number doesn't exist), not a transient hiccup.
      return new Response("not found", { status: 404 });
    });
    // A real signable key is required for createInstallationToken to actually mint (not silently fall back to
    // undefined via its own .catch) -- without it, `token` would be undefined here too, and hasProvenAccess in
    // fetchLinkedIssueFacts would be false, masking exactly the not_found/fetch_error distinction under test.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    const result = await fetchLinkedIssueLabelsForPropagation({
      env,
      repoFullName: "owner/repo",
      linkedIssues: [999],
      installationId: 123,
      prAuthorLogin: "contrib",
    });
    expectPropagation(result, [], false);
  });

  it("REGRESSION (#regression-safe-propagation): a confirmed-negative issue and an inconclusive issue aggregate to inconclusive, exercising the mixed (not just all-true/all-false) case", async () => {
    stubFetch((url) => {
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/1"))
        // Confirmed negative: found, open, but neither authored nor assigned to the PR author, no relaxable
        // mapping configured -- a real, deterministic "no", never inconclusive.
        return Response.json({ number: 1, state: "open", user: { login: "maintainer" }, assignees: [], labels: ["gittensor:priority"] });
      if (url.endsWith("/issues/2")) return new Response("server error", { status: 500 });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({});
    const result = await fetchLinkedIssueLabelsForPropagation({
      env,
      repoFullName: "owner/repo",
      linkedIssues: [1, 2],
      installationId: 123,
      prAuthorLogin: "contrib",
    });
    // Issue #1 alone would resolve confirmed-empty (inconclusive: false); issue #2's fetch failure must still
    // flip the AGGREGATE to inconclusive via .some(), proving the OR isn't accidentally an AND or a first-wins.
    expectPropagation(result, [], true);
  });

  it("falls back to the public token and still fails open (never throws) when the installation-token mint fails", async () => {
    const spy = vi
      .spyOn(appModule, "createInstallationToken")
      .mockRejectedValue(new Error("mint failed"));
    stubFetch((url) =>
      url.endsWith("/issues/1")
        ? Response.json({
            number: 1,
            state: "open",
            user: { login: "contrib" },
            labels: ["gittensor:priority"],
          })
        : new Response("not found", { status: 404 }),
    );
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    const result = await fetchLinkedIssueLabelsForPropagation({
      env,
      repoFullName: "owner/repo",
      linkedIssues: [1],
      installationId: 123,
      prAuthorLogin: "contrib",
    });
    expectPropagation(result, ["gittensor:priority"]);
    spy.mockRestore();
  });

  it("caps the number of linked issues fetched at 50, ignoring any beyond the cap (defense in depth against an unbounded parallel fan-out)", async () => {
    let issueFetchCount = 0;
    stubFetch((url) => {
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
      if (/\/issues\/\d+$/.test(url)) {
        issueFetchCount += 1;
        return Response.json({
          number: 1,
          state: "open",
          user: { login: "contrib" },
          labels: ["gittensor:priority"],
        });
      }
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({});
    const manyIssues = Array.from({ length: 75 }, (_, i) => i + 1);
    const result = await fetchLinkedIssueLabelsForPropagation({
      env,
      repoFullName: "owner/repo",
      linkedIssues: manyIssues,
      installationId: 123,
      prAuthorLogin: "contrib",
    });
    expect(issueFetchCount).toBe(50);
    expectPropagation(result, Array(50).fill("gittensor:priority"));
  });

  it("ignores a priority label on an open linked issue when the PR author neither opened nor is assigned to it", async () => {
    stubFetch((url) => {
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/777"))
        return Response.json({
          number: 777,
          state: "open",
          user: { login: "maintainer" },
          assignees: [],
          labels: ["gittensor:priority"],
        });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({});
    const result = await fetchLinkedIssueLabelsForPropagation({
      env,
      repoFullName: "owner/repo",
      linkedIssues: [777],
      installationId: 123,
      prAuthorLogin: "attacker",
    });
    expectPropagation(result, []);
  });

  it("ignores a priority label on a closed linked issue, even when the PR author is tied to it", async () => {
    stubFetch((url) => {
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/777"))
        return Response.json({
          number: 777,
          state: "closed",
          user: { login: "contrib" },
          labels: ["gittensor:priority"],
        });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({});
    const result = await fetchLinkedIssueLabelsForPropagation({
      env,
      repoFullName: "owner/repo",
      linkedIssues: [777],
      installationId: 123,
      prAuthorLogin: "contrib",
    });
    expectPropagation(result, []);
  });

  describe("closed-by-own-merge trust (#4528 — merging a PR auto-closes its linked issue)", () => {
    it("REGRESSION (PR #4494 shape): still propagates when the linked issue was closed at or after THIS PR's own merge", async () => {
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/4279"))
          return Response.json({
            number: 4279,
            state: "closed",
            closed_at: "2026-07-09T22:15:14Z",
            user: { login: "contrib" },
            labels: ["gittensor:feature", "gittensor:priority"],
          });
        if (url === GRAPHQL_URL) return Response.json(closerGraphQlBody(4494));
        return new Response("not found", { status: 404 });
      });
      // GITHUB_PUBLIC_TOKEN: the closure-verification GraphQL call (#5385) requires a real token to
      // authenticate at all (unlike REST, which can fall back to an unauthenticated read) -- createTestEnv({})
      // has no signable GITHUB_APP_PRIVATE_KEY, so createInstallationToken fails and this is the fallback.
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [4279],
        installationId: 123,
        prAuthorLogin: "contrib",
        prMergedAt: "2026-07-09T22:15:13Z",
        prNumber: 4494,
      });
      expectPropagation(result, ["gittensor:feature", "gittensor:priority"]);
    });

    it("REGRESSION (#closed-issue-timestamp-spoof): does NOT propagate when an unrelated issue closed after this PR merged", async () => {
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/9001"))
          return Response.json({
            number: 9001,
            state: "closed",
            closed_at: "2026-07-09T22:15:14Z",
            user: { login: "contrib" },
            labels: ["gittensor:feature", "gittensor:priority"],
          });
        // Closer is PR #123, not the PR calling in (#4494) -- proves the spoof protection still rejects an
        // unrelated issue that happened to close (by something else) after this PR merged.
        if (url === GRAPHQL_URL) return Response.json(closerGraphQlBody(123));
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [9001],
        installationId: 123,
        prAuthorLogin: "contrib",
        prMergedAt: "2026-07-09T22:15:13Z",
        prNumber: 4494,
      });
      expectPropagation(result, []);
    });

    it("does not propagate a timestamp-eligible closed issue when the caller cannot identify this PR number", async () => {
      const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/9003"))
          return Response.json({ number: 9003, state: "closed", closed_at: "2026-07-09T22:15:14Z", user: { login: "contrib" }, labels: ["gittensor:priority"] });
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchSpy);
      const env = createTestEnv({});
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [9003],
        installationId: 123,
        prAuthorLogin: "contrib",
        prMergedAt: "2026-07-09T22:15:13Z",
      });
      expectPropagation(result, []);
      expect(fetchSpy.mock.calls.some(([input]) => input.toString().includes("/timeline"))).toBe(false);
    });

    it("flags closed issue propagation inconclusive when the timeline closure check fails", async () => {
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/9002"))
          return Response.json({ number: 9002, state: "closed", closed_at: "2026-07-09T22:15:14Z", user: { login: "contrib" }, labels: ["gittensor:priority"] });
        if (url === GRAPHQL_URL) return new Response("server error", { status: 500 });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [9002],
        installationId: 123,
        prAuthorLogin: "contrib",
        prMergedAt: "2026-07-09T22:15:13Z",
        prNumber: 4494,
      });
      expectPropagation(result, [], true);
    });

    it("does NOT propagate when the linked issue was already closed BEFORE this PR merged (anti-gaming: an unrelated, already-resolved issue can't be borrowed)", async () => {
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/777"))
          return Response.json({
            number: 777,
            state: "closed",
            closed_at: "2026-07-01T00:00:00Z",
            user: { login: "contrib" },
            labels: ["gittensor:priority"],
          });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({});
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [777],
        installationId: 123,
        prAuthorLogin: "contrib",
        prMergedAt: "2026-07-09T22:15:13Z",
      });
      expectPropagation(result, []);
    });

    it("does not propagate a closed issue missing closed_at even when prMergedAt is present (defensive: no provable closing-time relationship)", async () => {
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/778"))
          return Response.json({ number: 778, state: "closed", user: { login: "contrib" }, labels: ["gittensor:priority"] });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({});
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [778],
        installationId: 123,
        prAuthorLogin: "contrib",
        prMergedAt: "2026-07-09T22:15:13Z",
      });
      expectPropagation(result, []);
    });
  });

  describe("webhook-race live-recheck (#4818 — a null prMergedAt from a stale webhook snapshot is ambiguous, not confirmed)", () => {
    it("REGRESSION (PR #4818 shape): propagates when prMergedAt reads null (a pull_request_review webhook's stale pre-merge snapshot) but a live check confirms the PR is actually merged at/before the issue's closedAt", async () => {
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/2192"))
          return Response.json({
            number: 2192,
            state: "closed",
            closed_at: "2026-07-11T02:26:25Z",
            user: { login: "owner" },
            labels: ["gittensor:feature"],
          });
        if (url.endsWith("/pulls/4818")) return Response.json({ merged_at: "2026-07-11T02:26:24Z" });
        if (url === GRAPHQL_URL) return Response.json(closerGraphQlBody(4818));
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [2192],
        installationId: 123,
        prAuthorLogin: "contrib",
        mappings: [{ issueLabel: "gittensor:feature", prLabel: "gittensor:feature", removeOtherTypeLabels: true, trustMaintainerAuthoredIssue: true }],
        prMergedAt: null,
        prNumber: 4818,
      });
      expectPropagation(result, ["gittensor:feature"]);
    });

    it("does not propagate when the live recheck confirms the PR is genuinely still unmerged (the real anti-gaming case #4528 protects)", async () => {
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/777"))
          return Response.json({ number: 777, state: "closed", closed_at: "2026-07-01T00:00:00Z", user: { login: "contrib" }, labels: ["gittensor:priority"] });
        if (url.endsWith("/pulls/42")) return Response.json({ merged_at: null });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({});
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [777],
        installationId: 123,
        prAuthorLogin: "contrib",
        prMergedAt: null,
        prNumber: 42,
      });
      expectPropagation(result, []);
    });

    it("does not propagate when the live recheck confirms the PR merged AFTER the issue's own independent closedAt (still not this PR's own close)", async () => {
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/777"))
          return Response.json({ number: 777, state: "closed", closed_at: "2026-07-01T00:00:00Z", user: { login: "contrib" }, labels: ["gittensor:priority"] });
        if (url.endsWith("/pulls/42")) return Response.json({ merged_at: "2026-07-05T00:00:00Z" });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({});
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [777],
        installationId: 123,
        prAuthorLogin: "contrib",
        prMergedAt: null,
        prNumber: 42,
      });
      expectPropagation(result, []);
    });

    it("flags the result inconclusive (never a confirmed absence) when the live merge-state recheck itself fails to fetch", async () => {
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/777"))
          return Response.json({ number: 777, state: "closed", closed_at: "2026-07-01T00:00:00Z", user: { login: "contrib" }, labels: ["gittensor:priority"] });
        if (url.endsWith("/pulls/42")) return new Response("server error", { status: 500 });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({});
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [777],
        installationId: 123,
        prAuthorLogin: "contrib",
        prMergedAt: null,
        prNumber: 42,
      });
      expectPropagation(result, [], true);
    });

    it("does not attempt a live recheck (and stays a confirmed negative, byte-identical to pre-#4818 behavior) when the caller omits prNumber", async () => {
      const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/777"))
          return Response.json({ number: 777, state: "closed", closed_at: "2026-07-01T00:00:00Z", user: { login: "contrib" }, labels: ["gittensor:priority"] });
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchSpy);
      const env = createTestEnv({});
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [777],
        installationId: 123,
        prAuthorLogin: "contrib",
        prMergedAt: null,
      });
      expectPropagation(result, []);
      expect(fetchSpy.mock.calls.some(([input]) => input.toString().includes("/pulls/"))).toBe(false);
    });
  });

  it("does not propagate labels when the PR author is missing", async () => {
    stubFetch((url) => {
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/1"))
        return Response.json({
          number: 1,
          state: "open",
          user: { login: "contrib" },
          labels: ["gittensor:priority"],
        });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({});
    const result = await fetchLinkedIssueLabelsForPropagation({
      env,
      repoFullName: "owner/repo",
      linkedIssues: [1],
      installationId: 123,
      prAuthorLogin: null,
    });
    expectPropagation(result, []);
  });

  it("propagates labels when the PR author is assigned to the open linked issue", async () => {
    stubFetch((url) => {
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/9"))
        return Response.json({
          number: 9,
          state: "open",
          user: { login: "maintainer" },
          assignees: [{ login: "contrib" }],
          labels: ["gittensor:priority"],
        });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({});
    const result = await fetchLinkedIssueLabelsForPropagation({
      env,
      repoFullName: "owner/repo",
      linkedIssues: [9],
      installationId: 123,
      prAuthorLogin: "Contrib",
    });
    expectPropagation(result, ["gittensor:priority"]);
  });

  describe("maintainer-authored-issue trust (#priority-linked-issue-gate-ownership)", () => {
    const RELAXABLE_MAPPINGS = [
      { issueLabel: "gittensor:feature", prLabel: "gittensor:feature", removeOtherTypeLabels: true, trustMaintainerAuthoredIssue: true },
      { issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: true },
    ];

    it("propagates only the relaxable label from an issue authored by the literal repo owner, excluding a co-present strict label, when the PR author neither opened nor is assigned to it", async () => {
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/10"))
          return Response.json({
            number: 10,
            state: "open",
            user: { login: "owner" },
            assignees: [],
            labels: ["gittensor:feature", "gittensor:priority"],
          });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({});
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [10],
        installationId: 123,
        prAuthorLogin: "contrib",
        mappings: RELAXABLE_MAPPINGS,
      });
      expectPropagation(result, ["gittensor:feature"]);
    });

    it("propagates a relaxable label from an issue authored by an ADMIN_GITHUB_LOGINS fleet-operator (not the literal repo owner)", async () => {
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/11"))
          return Response.json({ number: 11, state: "open", user: { login: "fleetop" }, assignees: [], labels: ["gittensor:feature"] });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "fleetop" });
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [11],
        installationId: 123,
        prAuthorLogin: "contrib",
        mappings: RELAXABLE_MAPPINGS,
      });
      expectPropagation(result, ["gittensor:feature"]);
    });

    it("stops trusting the global allowlist in per-repo admin mode (#4889): a fleet-operator author with only read access no longer propagates", async () => {
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/11"))
          return Response.json({ number: 11, state: "open", user: { login: "fleetop" }, assignees: [], labels: ["gittensor:feature"] });
        // The live per-repo answer now decides where the allowlist used to shortcut.
        if (url.includes("/collaborators/fleetop/permission")) return Response.json({ permission: "read" });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({
        ADMIN_GITHUB_LOGINS: "fleetop",
        LOOPOVER_PER_REPO_ADMIN: "true",
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      });
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [11],
        installationId: 123,
        prAuthorLogin: "contrib",
        mappings: RELAXABLE_MAPPINGS,
      });
      expectPropagation(result, []);
    });

    it("propagates a relaxable label from an issue authored by a live write-collaborator (not the owner, not in the admin allowlist)", async () => {
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/12"))
          return Response.json({ number: 12, state: "open", user: { login: "trusted-collab" }, assignees: [], labels: ["gittensor:feature"] });
        if (url.includes("/collaborators/trusted-collab/permission")) return Response.json({ permission: "write" });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [12],
        installationId: 123,
        prAuthorLogin: "contrib",
        mappings: RELAXABLE_MAPPINGS,
      });
      expectPropagation(result, ["gittensor:feature"]);
    });

    it("does not propagate a relaxable label when the issue author is a live collaborator with only read access", async () => {
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/13"))
          return Response.json({ number: 13, state: "open", user: { login: "rando" }, assignees: [], labels: ["gittensor:feature"] });
        if (url.includes("/collaborators/rando/permission")) return Response.json({ permission: "read" });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [13],
        installationId: 123,
        prAuthorLogin: "contrib",
        mappings: RELAXABLE_MAPPINGS,
      });
      expectPropagation(result, []);
    });

    it("does not propagate a relaxable label when the collaborator-permission check errors, and flags the result inconclusive rather than a confirmed absence (#regression-safe-propagation)", async () => {
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/14"))
          return Response.json({ number: 14, state: "open", user: { login: "rando" }, assignees: [], labels: ["gittensor:feature"] });
        if (url.includes("/collaborators/rando/permission")) return new Response("server error", { status: 500 });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [14],
        installationId: 123,
        prAuthorLogin: "contrib",
        mappings: RELAXABLE_MAPPINGS,
      });
      // Before #regression-safe-propagation this and a confirmed "read-only collaborator" negative (the test
      // above) were indistinguishable ([] either way) -- exactly the conflation that let a transient GitHub
      // hiccup permanently strip a correct propagated label. Now the caller can tell them apart.
      expectPropagation(result, [], true);
    });

    it("does not propagate a relaxable label when the linked issue has no author (deleted/ghost account)", async () => {
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/15")) return Response.json({ number: 15, state: "open", assignees: [], labels: ["gittensor:feature"] });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({});
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [15],
        installationId: 123,
        prAuthorLogin: "contrib",
        mappings: RELAXABLE_MAPPINGS,
      });
      expectPropagation(result, []);
    });

    it("does not propagate anything via maintainer-authored trust when no mapping opts in, even for the literal repo owner's own issue (byte-identical default)", async () => {
      const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/16"))
          return Response.json({ number: 16, state: "open", user: { login: "owner" }, assignees: [], labels: ["gittensor:feature"] });
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchSpy);
      const env = createTestEnv({});
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [16],
        installationId: 123,
        prAuthorLogin: "contrib",
      });
      expectPropagation(result, []);
      // No mapping opted in, so relaxableLabels is empty and the collaborator-permission check must never fire.
      expect(fetchSpy.mock.calls.some(([input]) => input.toString().includes("/collaborators/"))).toBe(false);
    });

    describe("reward-label maintainer trust (#priority-reward-maintainer-trust)", () => {
      it("REGRESSION (metagraphed PR #4554 / issue #3947 shape): a reward mapping with trustMaintainerAuthoredIssueForReward propagates alongside a routine trusted label from the SAME maintainer-authored issue, for a contributor who is neither its author nor assignee", async () => {
        const mappings = [
          { issueLabel: "gittensor:bug", prLabel: "gittensor:bug", removeOtherTypeLabels: true, trustMaintainerAuthoredIssue: true },
          { issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: false, trustMaintainerAuthoredIssueForReward: true },
        ];
        stubFetch((url) => {
          if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
          if (url.endsWith("/issues/3947"))
            return Response.json({ number: 3947, state: "open", user: { login: "owner" }, assignees: [], labels: ["gittensor:bug", "gittensor:priority"] });
          return new Response("not found", { status: 404 });
        });
        const env = createTestEnv({});
        const result = await fetchLinkedIssueLabelsForPropagation({
          env,
          repoFullName: "owner/repo",
          linkedIssues: [3947],
          installationId: 123,
          prAuthorLogin: "contrib",
          mappings,
        });
        expect(result.labels.sort()).toEqual(["gittensor:bug", "gittensor:priority"]);
        expect(result.inconclusive).toBe(false);
      });

      it("does NOT propagate the reward label from a maintainer-authored issue when its mapping has not opted into trustMaintainerAuthoredIssueForReward (unchanged strict default)", async () => {
        const mappings = [
          { issueLabel: "gittensor:bug", prLabel: "gittensor:bug", removeOtherTypeLabels: true, trustMaintainerAuthoredIssue: true },
          { issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: false },
        ];
        stubFetch((url) => {
          if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
          if (url.endsWith("/issues/3948"))
            return Response.json({ number: 3948, state: "open", user: { login: "owner" }, assignees: [], labels: ["gittensor:bug", "gittensor:priority"] });
          return new Response("not found", { status: 404 });
        });
        const env = createTestEnv({});
        const result = await fetchLinkedIssueLabelsForPropagation({
          env,
          repoFullName: "owner/repo",
          linkedIssues: [3948],
          installationId: 123,
          prAuthorLogin: "contrib",
          mappings,
        });
        expectPropagation(result, ["gittensor:bug"]);
      });

      it("REGRESSION: mixed-trust duplicate issue labels do not relax strict mappings through a shared label name", async () => {
        const mappings = [
          { issueLabel: "shared:gate", prLabel: "safe:type", removeOtherTypeLabels: true, trustMaintainerAuthoredIssue: true },
          { issueLabel: "shared:gate", prLabel: "sensitive:reward", removeOtherTypeLabels: false },
        ];
        stubFetch((url) => {
          if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
          if (url.endsWith("/issues/3951"))
            return Response.json({ number: 3951, state: "open", user: { login: "owner" }, assignees: [], labels: ["shared:gate"] });
          return new Response("not found", { status: 404 });
        });
        const env = createTestEnv({});
        const result = await fetchLinkedIssueLabelsForPropagation({
          env,
          repoFullName: "owner/repo",
          linkedIssues: [3951],
          installationId: 123,
          prAuthorLogin: "contrib",
          mappings,
        });
        expectPropagation(result, []);
      });

      it("still propagates the reward label via trustMaintainerAuthoredIssueForReward when the issue is authored by an ADMIN_GITHUB_LOGINS fleet-operator", async () => {
        const mappings = [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: false, trustMaintainerAuthoredIssueForReward: true }];
        stubFetch((url) => {
          if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
          if (url.endsWith("/issues/3949"))
            return Response.json({ number: 3949, state: "open", user: { login: "fleetop" }, assignees: [], labels: ["gittensor:priority"] });
          return new Response("not found", { status: 404 });
        });
        const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "fleetop" });
        const result = await fetchLinkedIssueLabelsForPropagation({
          env,
          repoFullName: "owner/repo",
          linkedIssues: [3949],
          installationId: 123,
          prAuthorLogin: "contrib",
          mappings,
        });
        expectPropagation(result, ["gittensor:priority"]);
      });

      it("does not propagate the reward label when the issue author is only a read-access collaborator (fails closed, same as trustMaintainerAuthoredIssue)", async () => {
        const mappings = [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: false, trustMaintainerAuthoredIssueForReward: true }];
        stubFetch((url) => {
          if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
          if (url.endsWith("/issues/3950"))
            return Response.json({ number: 3950, state: "open", user: { login: "rando" }, assignees: [], labels: ["gittensor:priority"] });
          if (url.includes("/collaborators/rando/permission")) return Response.json({ permission: "read" });
          return new Response("not found", { status: 404 });
        });
        const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
        const result = await fetchLinkedIssueLabelsForPropagation({
          env,
          repoFullName: "owner/repo",
          linkedIssues: [3950],
          installationId: 123,
          prAuthorLogin: "contrib",
          mappings,
        });
        expectPropagation(result, []);
      });
    });

    it("does not propagate anything when mappings are configured but none set trustMaintainerAuthoredIssue, even for the literal repo owner's own issue", async () => {
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/17"))
          return Response.json({ number: 17, state: "open", user: { login: "owner" }, assignees: [], labels: ["gittensor:priority"] });
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({});
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [17],
        installationId: 123,
        prAuthorLogin: "contrib",
        mappings: [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: true }],
      });
      expectPropagation(result, []);
    });
  });
});
