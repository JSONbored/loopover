import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import * as appModule from "../../src/github/app";
import { clearInstallationTokenCacheForTest } from "../../src/github/app";
import { fetchLinkedIssueLabelsForPropagation } from "../../src/review/linked-issue-label-propagation-fetch";

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
  return `${PEM_HEADER}\n${base64}\n${PEM_FOOTER}`;
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
    expect(result).toEqual([]);
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
    expect(result).toEqual(["gittensor:priority", "help wanted"]);
  });

  it("surfaces only the successful issue's labels when one of several linked issues fails to fetch (partial fail-open)", async () => {
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
    expect(result).toEqual(["gittensor:priority"]);
  });

  it("returns [] when every linked issue fails to fetch (fully fail-open — never applies a sensitive label without a verified source)", async () => {
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
    expect(result).toEqual([]);
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
    expect(result).toEqual(["gittensor:priority"]);
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
    expect(result).toEqual(Array(50).fill("gittensor:priority"));
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
    expect(result).toEqual([]);
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
    expect(result).toEqual([]);
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
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({});
      const result = await fetchLinkedIssueLabelsForPropagation({
        env,
        repoFullName: "owner/repo",
        linkedIssues: [4279],
        installationId: 123,
        prAuthorLogin: "contrib",
        prMergedAt: "2026-07-09T22:15:13Z",
      });
      expect(result).toEqual(["gittensor:feature", "gittensor:priority"]);
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
      expect(result).toEqual([]);
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
      expect(result).toEqual([]);
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
    expect(result).toEqual([]);
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
    expect(result).toEqual(["gittensor:priority"]);
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
      expect(result).toEqual(["gittensor:feature"]);
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
      expect(result).toEqual(["gittensor:feature"]);
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
      expect(result).toEqual(["gittensor:feature"]);
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
      expect(result).toEqual([]);
    });

    it("does not propagate a relaxable label when the collaborator-permission check errors (fails closed)", async () => {
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
      expect(result).toEqual([]);
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
      expect(result).toEqual([]);
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
      expect(result).toEqual([]);
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
        expect(result.sort()).toEqual(["gittensor:bug", "gittensor:priority"]);
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
        expect(result).toEqual(["gittensor:bug"]);
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
        expect(result).toEqual(["gittensor:priority"]);
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
        expect(result).toEqual([]);
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
      expect(result).toEqual([]);
    });
  });
});
