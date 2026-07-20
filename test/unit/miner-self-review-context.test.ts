import { describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import { MAX_FOCUS_MANIFEST_BYTES, parseFocusManifestContent } from "../../packages/loopover-engine/src/index";
import {
  applyLiveGateThresholdsToManifest,
  extractLinkedIssueNumbers,
  fetchSelfReviewContext,
  parseLiveGateThresholdFields,
} from "../../packages/loopover-miner/lib/self-review-context.js";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(text: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

function oversizedContentLengthResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(MAX_FOCUS_MANIFEST_BYTES + 1) }),
    json: async () => null,
    text: async () => {
      throw new Error("oversized manifest should not be materialized");
    },
  };
}

function chunkedManifestResponse(chunks: Uint8Array[], onCancel: () => void) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader: () => ({
        read: async () => (index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }),
        cancel: async () => {
          onCancel();
        },
        releaseLock: () => {},
      }),
    },
    json: async () => null,
    text: async () => {
      throw new Error("streaming manifest should not use response.text()");
    },
  };
}

const REPO_PAYLOAD = {
  name: "widgets",
  full_name: "acme/widgets",
  private: false,
  html_url: "https://github.com/acme/widgets",
  default_branch: "main",
  owner: { login: "acme" },
};

function issuePayload(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: "Uploads should retry on 5xx",
    state: "open",
    user: { login: "reporter" },
    author_association: "NONE",
    html_url: "https://github.com/acme/widgets/issues/7",
    body: "Uploads fail silently.",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    closed_at: null,
    labels: [{ name: "bug" }],
    ...overrides,
  };
}

function prPayload(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: "Add retry to the upload client",
    state: "open",
    user: { login: "miner-bot" },
    author_association: "CONTRIBUTOR",
    head: { sha: "abc123", ref: "miner/attempt-1" },
    base: { ref: "main" },
    html_url: "https://github.com/acme/widgets/pull/42",
    merged_at: null,
    draft: false,
    mergeable: true,
    body: "Closes #7",
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-07-03T00:00:00Z",
    closed_at: null,
    labels: [{ name: "enhancement" }],
    ...overrides,
  };
}

/** Routes by URL substring so a single fetchImpl can serve every call fetchSelfReviewContext fans out. */
function routedFetch(routes: Record<string, () => unknown>) {
  return async (url: string) => {
    for (const [substring, respond] of Object.entries(routes)) {
      if (url.includes(substring)) return respond();
    }
    return jsonResponse(null, 404);
  };
}

describe("fetchSelfReviewContext (#5145)", () => {
  it("rejects a malformed repoFullName", async () => {
    await expect(fetchSelfReviewContext("not-a-repo")).rejects.toThrow("invalid_repo_full_name");
  });

  it("builds a full context from live GitHub data: repo, issues, pull requests, manifest, contributor, duplicate cluster", async () => {
    // The PR title is deliberately unrelated to the issue title -- buildCollisionReport's pairwise term-
    // overlap clustering would otherwise ALSO cluster this pair (e.g. two titles both mentioning "retry"/
    // "upload"), muddying this general integration test's inDuplicateCluster:false assertion. The dedicated
    // "flags inDuplicateCluster true..." test below covers the real high-risk case explicitly.
    const fetchImpl = routedFetch({
      "/repos/acme/widgets/issues": () => jsonResponse([issuePayload()]),
      "/repos/acme/widgets/pulls": () => jsonResponse([prPayload({ title: "Update contributing docs formatting" })]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => textResponse("gate:\n  duplicates: block\n"),
      "api.gittensor.io/miners": () => jsonResponse([{ githubUsername: "miner-bot" }]),
    });

    const result = await fetchSelfReviewContext("acme/widgets", {
      contributorLogin: "miner-bot",
      linkedIssues: [7],
      fetchImpl: fetchImpl as never,
      loopoverAuth: null,
    });

    expect(result.repo).toEqual({
      fullName: "acme/widgets",
      owner: "acme",
      name: "widgets",
      installationId: undefined,
      isInstalled: false,
      isRegistered: false,
      isPrivate: false,
      htmlUrl: "https://github.com/acme/widgets",
      defaultBranch: "main",
      registryConfig: null,
    });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toEqual({
      repoFullName: "acme/widgets",
      number: 7,
      title: "Uploads should retry on 5xx",
      state: "open",
      authorLogin: "reporter",
      authorAssociation: "NONE",
      htmlUrl: "https://github.com/acme/widgets/issues/7",
      body: "Uploads fail silently.",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      closedAt: null,
      labels: ["bug"],
      linkedPrs: [],
    });
    expect(result.pullRequests).toHaveLength(1);
    expect(result.pullRequests[0]).toEqual({
      repoFullName: "acme/widgets",
      number: 42,
      title: "Update contributing docs formatting",
      state: "open",
      authorLogin: "miner-bot",
      authorAssociation: "CONTRIBUTOR",
      headSha: "abc123",
      headRef: "miner/attempt-1",
      baseRef: "main",
      htmlUrl: "https://github.com/acme/widgets/pull/42",
      mergedAt: null,
      isDraft: false,
      mergeableState: "clean",
      reviewDecision: null,
      body: "Closes #7",
      createdAt: "2026-07-03T00:00:00Z",
      updatedAt: "2026-07-03T00:00:00Z",
      closedAt: null,
      labels: ["enhancement"],
      linkedIssues: [7],
    });
    expect(result.manifest.gate?.duplicates).toBe("block");
    expect(result.confirmedContributor).toBe(true);
    // Issue #7 has exactly 1 linked PR (linkedIssues.length is 1, not > 1) so buildCollisionReport's
    // "issue-7" cluster is "medium", not "high" -- confirms inDuplicateCluster only fires on a genuinely
    // high-risk cluster, not any overlap at all.
    expect(result.inDuplicateCluster).toBe(false);
    expect("bounties" in result).toBe(false);
    expect(result.issueQuality?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          number: 7,
          title: "Uploads should retry on 5xx",
          status: expect.any(String),
          score: expect.any(Number),
        }),
      ]),
    );
  });

  it("flags inDuplicateCluster true when the target issue already has 2+ open PRs referencing it (a real high-risk cluster)", async () => {
    const fetchImpl = routedFetch({
      "/repos/acme/widgets/issues": () => jsonResponse([issuePayload()]),
      "/repos/acme/widgets/pulls": () =>
        jsonResponse([prPayload({ number: 42, body: "Closes #7" }), prPayload({ number: 43, body: "Fixes #7" })]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
      "api.gittensor.io/miners": () => jsonResponse([]),
    });

    const result = await fetchSelfReviewContext("acme/widgets", { linkedIssues: [7], fetchImpl: fetchImpl as never, loopoverAuth: null });
    expect(result.inDuplicateCluster).toBe(true);
  });

  it("populates issueQuality from the live GitHub snapshot without bounty or recent-merged inputs (#6057)", async () => {
    const fetchImpl = routedFetch({
      "/repos/acme/widgets/issues": () => jsonResponse([issuePayload({ body: "x".repeat(220) })]),
      "/repos/acme/widgets/pulls": () => jsonResponse([]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
      "api.gittensor.io/miners": () => jsonResponse([]),
    });

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, loopoverAuth: null });
    expect(result.issueQuality?.issues).toHaveLength(1);
    expect(result.issueQuality?.issues[0]).toMatchObject({ number: 7, status: expect.any(String) });
    expect(result.issueQuality?.repoFullName).toBe("acme/widgets");
    // Empty bounty/recent-merged inputs must not invent derived bounty warnings.
    expect(result.issueQuality?.issues[0]?.warnings.join(" ")).not.toMatch(/bounty/i);
    expect("bounties" in result).toBe(false);
  });

  // #6769: a real linked PR needs a CLOSING KEYWORD, matching the host's extractLinkedPrNumbers. The miner's
  // copy had a bare `PR #N` pattern, so an incidental mention made the issue-quality report read the issue as
  // "already references a PR" — and the miner skipped an issue that was actually available.
  it("REGRESSION (#6769): a bare 'PR #N' mention in an issue body does NOT count as a linked PR", async () => {
    const fetchImpl = routedFetch({
      "/repos/acme/widgets/issues": () =>
        jsonResponse([issuePayload({ body: "Uploads fail. This looks similar to what we saw in PR #501, worth a look." })]),
      "/repos/acme/widgets/pulls": () => jsonResponse([]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
      "api.gittensor.io/miners": () => jsonResponse([]),
    });

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, loopoverAuth: null });
    expect(result.issues[0]?.linkedPrs).toEqual([]);
  });

  it("REGRESSION (#6769): a closing-keyword 'Closes PR #N' DOES count as a linked PR", async () => {
    const fetchImpl = routedFetch({
      "/repos/acme/widgets/issues": () => jsonResponse([issuePayload({ body: "Closes PR #501" })]),
      "/repos/acme/widgets/pulls": () => jsonResponse([]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
      "api.gittensor.io/miners": () => jsonResponse([]),
    });

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, loopoverAuth: null });
    expect(result.issues[0]?.linkedPrs).toEqual([501]);
  });
  it("returns false for inDuplicateCluster when no linkedIssues are supplied", async () => {
    const fetchImpl = routedFetch({
      "/repos/acme/widgets/issues": () => jsonResponse([issuePayload()]),
      "/repos/acme/widgets/pulls": () => jsonResponse([prPayload({ body: "Closes #7" }), prPayload({ number: 43, body: "Fixes #7" })]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
      "api.gittensor.io/miners": () => jsonResponse([]),
    });

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, loopoverAuth: null });
    expect(result.inDuplicateCluster).toBe(false);
  });

  it("filters out pull requests returned by the Issues endpoint (GitHub's own API quirk)", async () => {
    const fetchImpl = routedFetch({
      "/repos/acme/widgets/issues": () => jsonResponse([issuePayload(), issuePayload({ number: 8, pull_request: { url: "x" } })]),
      "/repos/acme/widgets/pulls": () => jsonResponse([]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
      "api.gittensor.io/miners": () => jsonResponse([]),
    });

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, loopoverAuth: null });
    expect(result.issues.map((issue) => issue.number)).toEqual([7]);
  });

  it("paginates issues/pull requests until a short page, and stops at maxPages", async () => {
    let issuePage = 0;
    const fetchImpl = async (url: string) => {
      if (url.includes("/repos/acme/widgets/issues")) {
        issuePage += 1;
        // Page 1 and 2 are full (perPage=2); page 3 is short, so pagination should stop after 3 pages -> 5 issues.
        if (issuePage <= 2) return jsonResponse([issuePayload({ number: issuePage * 10 + 1 }), issuePayload({ number: issuePage * 10 + 2 })]);
        return jsonResponse([issuePayload({ number: 99 })]);
      }
      if (url.includes("/repos/acme/widgets/pulls")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets")) return jsonResponse(REPO_PAYLOAD);
      if (url.includes("raw.githubusercontent.com")) return jsonResponse(null, 404);
      if (url.includes("api.gittensor.io/miners")) return jsonResponse([]);
      return jsonResponse(null, 404);
    };

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, perPage: 2, loopoverAuth: null });
    expect(result.issues.map((issue) => issue.number)).toEqual([11, 12, 21, 22, 99]);
    expect(issuePage).toBe(3);
  });

  it("stops paginating on a non-ok response instead of throwing", async () => {
    let calls = 0;
    const fetchImpl = async (url: string) => {
      if (url.includes("/repos/acme/widgets/issues")) {
        calls += 1;
        return calls === 1 ? jsonResponse([issuePayload()]) : jsonResponse(null, 500);
      }
      if (url.includes("/repos/acme/widgets/pulls")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets")) return jsonResponse(REPO_PAYLOAD);
      if (url.includes("raw.githubusercontent.com")) return jsonResponse(null, 404);
      if (url.includes("api.gittensor.io/miners")) return jsonResponse([]);
      return jsonResponse(null, 404);
    };

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, perPage: 1, loopoverAuth: null });
    expect(result.issues.map((issue) => issue.number)).toEqual([7]);
  });

  it("returns a null repo when the repository fetch fails (never throws)", async () => {
    const fetchImpl = routedFetch({
      "/repos/acme/widgets/issues": () => jsonResponse([]),
      "/repos/acme/widgets/pulls": () => jsonResponse([]),
      "/repos/acme/widgets": () => jsonResponse(null, 404),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
      "api.gittensor.io/miners": () => jsonResponse([]),
    });

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, loopoverAuth: null });
    expect(result.repo).toBeNull();
  });

  it("falls back through manifest candidate paths and parses an empty manifest when none resolve", async () => {
    let requestedPaths: string[] = [];
    const fetchImpl = async (url: string) => {
      if (url.includes("raw.githubusercontent.com")) {
        requestedPaths.push(url);
        return jsonResponse(null, 404);
      }
      if (url.includes("/repos/acme/widgets/issues")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets/pulls")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets")) return jsonResponse(REPO_PAYLOAD);
      if (url.includes("api.gittensor.io/miners")) return jsonResponse([]);
      return jsonResponse(null, 404);
    };

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, loopoverAuth: null });
    expect(requestedPaths).toEqual([
      "https://raw.githubusercontent.com/acme/widgets/HEAD/.loopover.yml",
      "https://raw.githubusercontent.com/acme/widgets/HEAD/.github/loopover.yml",
      "https://raw.githubusercontent.com/acme/widgets/HEAD/.loopover.json",
      "https://raw.githubusercontent.com/acme/widgets/HEAD/.github/loopover.json",
    ]);
    expect(result.manifest.gate).toBeDefined();
  });

  it("rejects oversized manifest responses from content-length before reading the body", async () => {
    let manifestRequests = 0;
    const fetchImpl = async (url: string) => {
      if (url.includes("raw.githubusercontent.com")) {
        manifestRequests += 1;
        return oversizedContentLengthResponse();
      }
      if (url.includes("/repos/acme/widgets/issues")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets/pulls")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets")) return jsonResponse(REPO_PAYLOAD);
      if (url.includes("api.gittensor.io/miners")) return jsonResponse([]);
      return jsonResponse(null, 404);
    };

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, loopoverAuth: null });
    expect(manifestRequests).toBe(4);
    expect(result.manifest.present).toBe(false);
    expect(result.manifest.warnings).toEqual([]);
  });

  it("cancels chunked manifest responses once the byte cap is exceeded", async () => {
    const chunks = [new Uint8Array(MAX_FOCUS_MANIFEST_BYTES), new Uint8Array([123])];
    let cancelCount = 0;
    const fetchImpl = async (url: string) => {
      if (url.includes("raw.githubusercontent.com")) return chunkedManifestResponse(chunks, () => { cancelCount += 1; });
      if (url.includes("/repos/acme/widgets/issues")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets/pulls")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets")) return jsonResponse(REPO_PAYLOAD);
      if (url.includes("api.gittensor.io/miners")) return jsonResponse([]);
      return jsonResponse(null, 404);
    };

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, loopoverAuth: null });
    expect(cancelCount).toBe(4);
    expect(result.manifest.present).toBe(false);
  });

  it("stops at the first manifest candidate that resolves, skipping the rest", async () => {
    let requestedPaths: string[] = [];
    const fetchImpl = async (url: string) => {
      if (url.includes("raw.githubusercontent.com")) {
        requestedPaths.push(url);
        return textResponse("gate:\n  duplicates: advisory\n");
      }
      if (url.includes("/repos/acme/widgets/issues")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets/pulls")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets")) return jsonResponse(REPO_PAYLOAD);
      if (url.includes("api.gittensor.io/miners")) return jsonResponse([]);
      return jsonResponse(null, 404);
    };

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, loopoverAuth: null });
    expect(requestedPaths).toHaveLength(1);
    expect(result.manifest.gate?.duplicates).toBe("advisory");
  });

  it("returns false for confirmedContributor when no contributorLogin is supplied, without making the request", async () => {
    let minersCalled = false;
    const fetchImpl = async (url: string) => {
      if (url.includes("api.gittensor.io/miners")) {
        minersCalled = true;
        return jsonResponse([{ githubUsername: "someone" }]);
      }
      if (url.includes("/repos/acme/widgets/issues")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets/pulls")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets")) return jsonResponse(REPO_PAYLOAD);
      if (url.includes("raw.githubusercontent.com")) return jsonResponse(null, 404);
      return jsonResponse(null, 404);
    };

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, loopoverAuth: null });
    expect(result.confirmedContributor).toBe(false);
    expect(minersCalled).toBe(false);
  });

  it("returns false for confirmedContributor on a case-insensitive miss, a non-ok response, and a transport error", async () => {
    const miss = routedFetch({
      "api.gittensor.io/miners": () => jsonResponse([{ githubUsername: "someone-else" }]),
      "/repos/acme/widgets/issues": () => jsonResponse([]),
      "/repos/acme/widgets/pulls": () => jsonResponse([]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
    });
    expect((await fetchSelfReviewContext("acme/widgets", { contributorLogin: "Miner-Bot", fetchImpl: miss as never, loopoverAuth: null })).confirmedContributor).toBe(false);

    const notOk = routedFetch({
      "api.gittensor.io/miners": () => jsonResponse(null, 500),
      "/repos/acme/widgets/issues": () => jsonResponse([]),
      "/repos/acme/widgets/pulls": () => jsonResponse([]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
    });
    expect((await fetchSelfReviewContext("acme/widgets", { contributorLogin: "miner-bot", fetchImpl: notOk as never, loopoverAuth: null })).confirmedContributor).toBe(false);

    const throwing = async (url: string) => {
      if (url.includes("api.gittensor.io/miners")) throw new Error("network down");
      if (url.includes("/repos/acme/widgets/issues")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets/pulls")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets")) return jsonResponse(REPO_PAYLOAD);
      if (url.includes("raw.githubusercontent.com")) return jsonResponse(null, 404);
      return jsonResponse(null, 404);
    };
    expect((await fetchSelfReviewContext("acme/widgets", { contributorLogin: "miner-bot", fetchImpl: throwing as never, loopoverAuth: null })).confirmedContributor).toBe(false);
  });

  it("matches a confirmed contributor case-insensitively", async () => {
    const fetchImpl = routedFetch({
      "api.gittensor.io/miners": () => jsonResponse([{ githubUsername: "Miner-Bot" }]),
      "/repos/acme/widgets/issues": () => jsonResponse([]),
      "/repos/acme/widgets/pulls": () => jsonResponse([]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
    });
    const result = await fetchSelfReviewContext("acme/widgets", { contributorLogin: "miner-bot", fetchImpl: fetchImpl as never, loopoverAuth: null });
    expect(result.confirmedContributor).toBe(true);
  });

  it("extractLinkedIssueNumbers only counts a cross-repo reference when it targets the same repo, and skips ones inside code spans", async () => {
    const fetchImpl = routedFetch({
      "/repos/acme/widgets/issues": () => jsonResponse([]),
      "/repos/acme/widgets/pulls": () =>
        jsonResponse([
          prPayload({
            number: 50,
            body: "Closes acme/widgets#7. Also mentions `Closes #999` as example code, and closes other-org/other-repo#7 (different repo, should not count).",
          }),
        ]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
      "api.gittensor.io/miners": () => jsonResponse([]),
    });

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, loopoverAuth: null });
    expect(result.pullRequests[0]?.linkedIssues).toEqual([7]);
  });

  it("maps a dirty and an unknown mergeable state correctly", async () => {
    const fetchImpl = routedFetch({
      "/repos/acme/widgets/issues": () => jsonResponse([]),
      "/repos/acme/widgets/pulls": () => jsonResponse([prPayload({ number: 51, mergeable: false }), prPayload({ number: 52, mergeable: null })]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
      "api.gittensor.io/miners": () => jsonResponse([]),
    });

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, loopoverAuth: null });
    expect(result.pullRequests.find((pr) => pr.number === 51)?.mergeableState).toBe("dirty");
    expect(result.pullRequests.find((pr) => pr.number === 52)?.mergeableState).toBeNull();
  });

  it("uses global fetch when fetchImpl is omitted", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes("/repos/acme/widgets/issues")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets/pulls")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets")) return jsonResponse(REPO_PAYLOAD);
      if (url.includes("raw.githubusercontent.com")) return jsonResponse(null, 404);
      if (url.includes("api.gittensor.io/miners")) return jsonResponse([]);
      return jsonResponse(null, 404);
    }) as unknown as typeof fetch;
    try {
      const result = await fetchSelfReviewContext("acme/widgets", { loopoverAuth: null });
      expect(result.repo?.fullName).toBe("acme/widgets");
      expect(globalThis.fetch).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("defaults GITHUB_TOKEN from process.env when not supplied", async () => {
    const original = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "env-token";
    try {
      let capturedAuth: string | undefined;
      const fetchImpl = async (url: string, init: { headers?: Record<string, string> }) => {
        if (url.includes("/repos/acme/widgets") && !url.includes("issues") && !url.includes("pulls")) {
          capturedAuth = init.headers?.authorization;
          return jsonResponse(REPO_PAYLOAD);
        }
        if (url.includes("/repos/acme/widgets/issues")) return jsonResponse([]);
        if (url.includes("/repos/acme/widgets/pulls")) return jsonResponse([]);
        if (url.includes("raw.githubusercontent.com")) return jsonResponse(null, 404);
        if (url.includes("api.gittensor.io/miners")) return jsonResponse([]);
        return jsonResponse(null, 404);
      };
      // loopoverAuth: null forces the ORB live-gate-thresholds probe off (#6487) -- without it, a real
      // loopover-mcp session recorded on disk (e.g. from `loopover-mcp login` on a contributor's machine)
      // would fire an extra concurrent fetch whose "Bearer <session token>" header could race with and
      // overwrite capturedAuth, since its URL also matches this test's own "/repos/acme/widgets" routing.
      await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, loopoverAuth: null });
      expect(capturedAuth).toBe("Bearer env-token");
    } finally {
      if (original === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = original;
    }
  });

  it("bounds every fetch (GitHub REST, raw manifest, Gittensor contributor lookup) with a per-call AbortSignal timeout, defaulting to 10s (#miner-github-read-timeouts)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const capturedSignals: unknown[] = [];
    const fetchImpl = async (url: string, init?: { signal?: unknown }) => {
      capturedSignals.push(init?.signal);
      if (url.includes("api.gittensor.io/miners")) return jsonResponse([{ githubUsername: "miner-bot" }]);
      if (url.includes("/repos/acme/widgets/issues")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets/pulls")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets")) return jsonResponse(REPO_PAYLOAD);
      if (url.includes("raw.githubusercontent.com")) return jsonResponse(null, 404);
      return jsonResponse(null, 404);
    };

    // loopoverAuth: null keeps this test's call count and 10s-default assertion honest -- see the note on
    // the "defaults GITHUB_TOKEN" test above for why an unforced probe is a real-environment hazard here too.
    await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, contributorLogin: "miner-bot", loopoverAuth: null });

    // repo + issues + pulls (githubGetJson) + 4 manifest candidates + 1 contributor lookup = 8 calls, every one bounded.
    expect(capturedSignals.length).toBeGreaterThanOrEqual(7);
    for (const signal of capturedSignals) expect(signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy.mock.calls.every(([ms]) => ms === 10_000)).toBe(true);
    timeoutSpy.mockRestore();
  });

  it("honors a custom requestTimeoutMs instead of the 10s default, across all three fetch call sites", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = routedFetch({
      "api.gittensor.io/miners": () => jsonResponse([]),
      "/repos/acme/widgets/issues": () => jsonResponse([]),
      "/repos/acme/widgets/pulls": () => jsonResponse([]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
    });

    await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, requestTimeoutMs: 4000, loopoverAuth: null });

    expect(timeoutSpy.mock.calls.length).toBeGreaterThan(0);
    expect(timeoutSpy.mock.calls.every(([ms]) => ms === 4000)).toBe(true);
    timeoutSpy.mockRestore();
  });

  it("falls back to the 10s default when requestTimeoutMs is not a positive integer", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = routedFetch({
      "api.gittensor.io/miners": () => jsonResponse([]),
      "/repos/acme/widgets/issues": () => jsonResponse([]),
      "/repos/acme/widgets/pulls": () => jsonResponse([]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
    });

    await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, requestTimeoutMs: -3, loopoverAuth: null });

    expect(timeoutSpy.mock.calls.length).toBeGreaterThan(0);
    expect(timeoutSpy.mock.calls.every(([ms]) => ms === 10_000)).toBe(true);
    timeoutSpy.mockRestore();
  });
});

describe("live gate thresholds probe (#6487)", () => {
  it("parseLiveGateThresholdFields accepts the field-limited snake_case payload and rejects empties", () => {
    expect(
      parseLiveGateThresholdFields({
        repoFullName: "acme/widgets",
        confidence_floor: 0.91,
        scope_cap_files: 8,
        scope_cap_lines: 250,
      }),
    ).toEqual({ confidence_floor: 0.91, scope_cap_files: 8, scope_cap_lines: 250 });
    expect(parseLiveGateThresholdFields({ confidence_floor: 0.5, scope_cap_files: null, scope_cap_lines: null })).toEqual({
      confidence_floor: 0.5,
      scope_cap_files: null,
      scope_cap_lines: null,
    });
    expect(parseLiveGateThresholdFields({ confidence_floor: null, scope_cap_files: null, scope_cap_lines: null })).toBeNull();
    expect(parseLiveGateThresholdFields({ confidence_floor: 1.5 })).toBeNull();
    expect(parseLiveGateThresholdFields(null)).toBeNull();
  });

  it("applyLiveGateThresholdsToManifest skips a non-numeric confidence_floor", () => {
    const base = parseFocusManifestContent("gate:\n  readiness:\n    mode: block\n    minScore: 70\n", "repo_file");
    const overlaid = applyLiveGateThresholdsToManifest(base, {
      confidence_floor: null,
      scope_cap_files: 3,
      scope_cap_lines: null,
    });
    expect(overlaid.gate.readinessMinScore).toBe(70);
    expect(overlaid.gate.sizeMaxFiles).toBe(3);
  });

  it("applyLiveGateThresholdsToManifest raises readinessMinScore and prefers live scope caps", () => {
    const base = parseFocusManifestContent("gate:\n  readiness:\n    mode: block\n    minScore: 70\n  size:\n    mode: block\n    maxFiles: 20\n    maxLines: 500\n", "repo_file");
    const overlaid = applyLiveGateThresholdsToManifest(base, {
      confidence_floor: 0.91,
      scope_cap_files: 8,
      scope_cap_lines: 250,
    });
    expect(overlaid.gate.readinessMinScore).toBe(91);
    expect(overlaid.gate.sizeMaxFiles).toBe(8);
    expect(overlaid.gate.sizeMaxLines).toBe(250);
    expect(overlaid.gate.duplicates).toBe(base.gate.duplicates);
    // Raise-only: a lower live floor must not loosen the static reconstruction.
    const notLoosened = applyLiveGateThresholdsToManifest(base, {
      confidence_floor: 0.5,
      scope_cap_files: null,
      scope_cap_lines: null,
    });
    expect(notLoosened.gate.readinessMinScore).toBe(70);
  });

  it("uses live ORB thresholds when the probe returns 200", async () => {
    const fetchImpl = routedFetch({
      "/live-gate-thresholds": () =>
        jsonResponse({
          repoFullName: "acme/widgets",
          confidence_floor: 0.91,
          scope_cap_files: 8,
          scope_cap_lines: 250,
        }),
      "/repos/acme/widgets/issues": () => jsonResponse([]),
      "/repos/acme/widgets/pulls": () => jsonResponse([]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => textResponse("gate:\n  readiness:\n    mode: block\n    minScore: 70\n  size:\n    mode: block\n    maxFiles: 20\n    maxLines: 500\n"),
      "api.gittensor.io/miners": () => jsonResponse([]),
    });

    const result = await fetchSelfReviewContext("acme/widgets", {
      fetchImpl: fetchImpl as never,
      loopoverAuth: { apiUrl: "https://orb.test", sessionToken: "mcp-test-token" },
    });
    expect(result.manifest.gate.readinessMinScore).toBe(91);
    expect(result.manifest.gate.sizeMaxFiles).toBe(8);
    expect(result.manifest.gate.sizeMaxLines).toBe(250);
  });

  it("falls back to static reconstruction when the probe 403s / 404s / times out", async () => {
    const staticYml = "gate:\n  readiness:\n    mode: block\n    minScore: 70\n  size:\n    mode: block\n    maxFiles: 20\n    maxLines: 500\n";

    for (const respond of [
      () => jsonResponse({ error: "forbidden_repo" }, 403),
      () => jsonResponse({ error: "live_gate_thresholds_not_found" }, 404),
      () => {
        throw new Error("timeout");
      },
    ]) {
      const fetchImpl = routedFetch({
        "/live-gate-thresholds": respond,
        "/repos/acme/widgets/issues": () => jsonResponse([]),
        "/repos/acme/widgets/pulls": () => jsonResponse([]),
        "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
        "raw.githubusercontent.com": () => textResponse(staticYml),
        "api.gittensor.io/miners": () => jsonResponse([]),
      });
      const result = await fetchSelfReviewContext("acme/widgets", {
        fetchImpl: fetchImpl as never,
        loopoverAuth: { apiUrl: "https://orb.test", sessionToken: "mcp-test-token" },
      });
      expect(result.manifest.gate.readinessMinScore).toBe(70);
      expect(result.manifest.gate.sizeMaxFiles).toBe(20);
      expect(result.manifest.gate.sizeMaxLines).toBe(500);
    }
  });

  it("skips the probe entirely when loopoverAuth is null (fully-standalone path)", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      if (url.includes("/repos/acme/widgets/issues")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets/pulls")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets")) return jsonResponse(REPO_PAYLOAD);
      if (url.includes("raw.githubusercontent.com")) return textResponse("gate:\n  duplicates: block\n");
      if (url.includes("api.gittensor.io/miners")) return jsonResponse([]);
      return jsonResponse(null, 404);
    };

    const result = await fetchSelfReviewContext("acme/widgets", {
      fetchImpl: fetchImpl as never,
      loopoverAuth: null,
    });
    expect(seen.some((url) => url.includes("live-gate-thresholds"))).toBe(false);
    expect(result.manifest.gate.duplicates).toBe("block");
  });

  it("uses the short probe timeout budget, not the GitHub request timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = routedFetch({
      "/repos/acme/widgets/issues": () => jsonResponse([]),
      "/repos/acme/widgets/pulls": () => jsonResponse([]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
      "api.gittensor.io/miners": () => jsonResponse([]),
      "/live-gate-thresholds": () => jsonResponse({ confidence_floor: 0.9, scope_cap_files: null, scope_cap_lines: null }),
    });

    await fetchSelfReviewContext("acme/widgets", {
      fetchImpl: fetchImpl as never,
      loopoverAuth: { apiUrl: "https://orb.test", sessionToken: "mcp-test-token" },
      requestTimeoutMs: 10_000,
      liveGateProbeTimeoutMs: 350,
    });

    expect(timeoutSpy.mock.calls.some(([ms]) => ms === 350)).toBe(true);
    timeoutSpy.mockRestore();
  });

  it("covers option defaults, sparse GitHub payloads, streaming manifest success, and label/date fallbacks", async () => {
    expect(parseLiveGateThresholdFields([])).toBeNull();
    expect(parseLiveGateThresholdFields({ scope_cap_files: 0, scope_cap_lines: -1 })).toBeNull();
    expect(applyLiveGateThresholdsToManifest(null as never, { confidence_floor: 0.9, scope_cap_files: null, scope_cap_lines: null })).toBeNull();
    expect(
      applyLiveGateThresholdsToManifest({ gate: { readinessMinScore: "x" } } as never, {
        confidence_floor: 0.9,
        scope_cap_files: null,
        scope_cap_lines: null,
      }),
    ).toEqual({ gate: { readinessMinScore: "x" } });
    const baseForFloor = parseFocusManifestContent("gate:\n  readiness:\n    mode: block\n    minScore: 10\n", "repo_file");
    expect(
      applyLiveGateThresholdsToManifest(baseForFloor, { confidence_floor: 0.9, scope_cap_files: 0, scope_cap_lines: 0 }),
    ).toMatchObject({ gate: { readinessMinScore: 90 } });

    const chunks = [new TextEncoder().encode("gate:\n  duplicates: advisory\n")];
    const fetchImpl = async (url: string) => {
      if (url.includes("raw.githubusercontent.com")) return chunkedManifestResponse(chunks, () => {});
      if (url.includes("/repos/acme/widgets/issues")) {
        return jsonResponse([
          issuePayload({
            user: undefined,
            author_association: undefined,
            html_url: undefined,
            body: undefined,
            created_at: undefined,
            updated_at: undefined,
            closed_at: undefined,
            labels: "bug",
          }),
          issuePayload({ number: 8, labels: [{}, { name: 1 }, { name: "ok" }, null] }),
          null,
          { pull_request: {} },
        ]);
      }
      if (url.includes("/repos/acme/widgets/pulls")) {
        return jsonResponse([
          prPayload({
            user: undefined,
            author_association: undefined,
            html_url: undefined,
            body: undefined,
            created_at: undefined,
            updated_at: undefined,
            closed_at: undefined,
            labels: null,
            head: { sha: undefined, ref: undefined },
            base: { ref: undefined },
          }),
        ]);
      }
      if (url.includes("/repos/acme/widgets")) {
        return jsonResponse({
          private: undefined,
          html_url: undefined,
          default_branch: undefined,
          owner: {},
        });
      }
      if (url.includes("api.gittensor.io/miners")) return jsonResponse({ not: "array" });
      return jsonResponse(null, 404);
    };

    const result = await fetchSelfReviewContext("acme/widgets", {
      fetchImpl: fetchImpl as never,
      loopoverAuth: null,
      apiBaseUrl: "   ",
      rawContentBaseUrl: "  ",
      gittensorApiBase: "\t",
      githubToken: 12 as unknown as string,
      perPage: -1,
      maxPages: 0,
      contributorLogin: "  Miner  ",
      linkedIssues: [7, "x", 8.5, null, 8] as unknown as number[],
      liveGateProbeTimeoutMs: -1,
      requestTimeoutMs: 0,
    });

    expect(result.manifest.present).toBe(true);
    expect(result.repo).toMatchObject({
      owner: "acme",
      name: "widgets",
      isPrivate: false,
      htmlUrl: null,
      defaultBranch: null,
    });
    expect(result.issues.some((issue) => issue.number === 8 && issue.labels.includes("ok"))).toBe(true);
    expect(result.issues.find((issue) => issue.number === 7)?.authorLogin).toBeNull();
    expect(result.confirmedContributor).toBe(false);
    expect(result.pullRequests[0]?.authorLogin).toBeNull();
    expect(result.pullRequests[0]?.labels).toEqual([]);
  });

  it("resolves loopoverAuth apiUrl from an explicit session when apiUrl is blank", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      if (url.includes("/live-gate-thresholds")) {
        return jsonResponse({ confidence_floor: 0.8, scope_cap_files: null, scope_cap_lines: null });
      }
      if (url.includes("/repos/acme/widgets/issues")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets/pulls")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets")) return jsonResponse(REPO_PAYLOAD);
      if (url.includes("raw.githubusercontent.com")) return jsonResponse(null, 404);
      if (url.includes("api.gittensor.io/miners")) return jsonResponse([]);
      return jsonResponse(null, 404);
    };

    await fetchSelfReviewContext("acme/widgets", {
      fetchImpl: fetchImpl as never,
      loopoverAuth: { apiUrl: "  ", sessionToken: "tok" },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(seen.some((url) => url.startsWith("https://api.loopover.ai/v1/repos/"))).toBe(true);
  });

  it("rejects a non-string repoFullName and a three-segment path", async () => {
    await expect(fetchSelfReviewContext(12 as unknown as string)).rejects.toThrow("invalid_repo_full_name");
    await expect(fetchSelfReviewContext("acme/widgets/extra")).rejects.toThrow("invalid_repo_full_name");
  });

  it("honors explicit non-blank API base URLs, pagination caps, and ignores PR #0 links", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      if (url.includes("raw.example.test")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-length": "32" }),
          text: async () => "gate:\n  duplicates: advisory\n",
        };
      }
      if (url.includes("api.example.test") && url.includes("/issues")) {
        return jsonResponse([
          issuePayload({ body: "Closes PR #0 and also Closes PR #7" }),
        ]);
      }
      if (url.includes("api.example.test") && url.includes("/pulls")) {
        return jsonResponse([
          prPayload({ body: "Closes #0 and Closes other/repo#9 and Closes #7", draft: undefined }),
        ]);
      }
      if (url.includes("api.example.test") && url.includes("/repos/")) return jsonResponse(REPO_PAYLOAD);
      if (url.includes("gittensor.example.test/miners")) return jsonResponse([]);
      return jsonResponse(null, 404);
    };

    const result = await fetchSelfReviewContext("acme/widgets", {
      fetchImpl: fetchImpl as never,
      loopoverAuth: null,
      apiBaseUrl: "https://api.example.test",
      rawContentBaseUrl: "https://raw.example.test",
      gittensorApiBase: "https://gittensor.example.test",
      perPage: 1,
      maxPages: 1,
      contributorLogin: "miner-bot",
    });

    expect(seen.some((url) => url.startsWith("https://api.example.test/"))).toBe(true);
    expect(seen.some((url) => url.startsWith("https://raw.example.test/"))).toBe(true);
    expect(seen.some((url) => url.startsWith("https://gittensor.example.test/"))).toBe(true);
    expect(result.issues[0]?.linkedPrs).toEqual([7]);
    expect(result.pullRequests[0]?.linkedIssues).toEqual([7]);
    expect(result.pullRequests[0]?.isDraft).toBeNull();
    expect(result.manifest.present).toBe(true);
  });

  it("falls back when a non-streaming manifest response is oversized by encoded byte length", async () => {
    const encodeSpy = vi.spyOn(TextEncoder.prototype, "encode").mockReturnValue(new Uint8Array(MAX_FOCUS_MANIFEST_BYTES + 1));
    try {
      const fetchImpl = async (url: string) => {
        if (url.includes("raw.githubusercontent.com")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            text: async () => "gate:\n  duplicates: advisory\n",
          };
        }
        if (url.includes("/repos/acme/widgets/issues")) return jsonResponse([]);
        if (url.includes("/repos/acme/widgets/pulls")) return jsonResponse([]);
        if (url.includes("/repos/acme/widgets")) return jsonResponse(REPO_PAYLOAD);
        if (url.includes("api.gittensor.io/miners")) return jsonResponse([]);
        return jsonResponse(null, 404);
      };

      const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, loopoverAuth: null });
      expect(result.manifest.present).toBe(false);
    } finally {
      encodeSpy.mockRestore();
    }
  });

  it("treats a non-string text() body on a non-streaming manifest as absent", async () => {
    const fetchImpl = async (url: string) => {
      if (url.includes("raw.githubusercontent.com")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => 123,
        };
      }
      if (url.includes("/repos/acme/widgets/issues")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets/pulls")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets")) return jsonResponse(REPO_PAYLOAD);
      if (url.includes("api.gittensor.io/miners")) return jsonResponse([]);
      return jsonResponse(null, 404);
    };

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, loopoverAuth: null });
    expect(result.manifest.present).toBe(false);
  });
});

describe("extractLinkedIssueNumbers — parity with the host's byte-range exclusion + URL form (#7527)", () => {
  it("counts the bare #N and same-repo qualified owner/repo#N forms, rejecting a different-repo qualified ref", () => {
    expect(extractLinkedIssueNumbers("Closes #7", "acme/widgets")).toEqual([7]);
    expect(extractLinkedIssueNumbers("Fixes acme/widgets#12", "acme/widgets")).toEqual([12]);
    // Qualified reference to a DIFFERENT repo closes an issue there, not here.
    expect(extractLinkedIssueNumbers("Closes other/repo#99", "acme/widgets")).toEqual([]);
    // Case-insensitive keyword + owner match.
    expect(extractLinkedIssueNumbers("RESOLVED Acme/Widgets#5", "acme/widgets")).toEqual([5]);
  });

  it("REGRESSION (#7527): a closing keyword separated from the issue only by a code span does NOT link", () => {
    // "Fixes `some code` #45" -- the old string-strip (`body.replace(/`[^`]*`/g, "")`) turned this into
    // "Fixes  #45", whose surrounding spaces satisfied `\s+` and fabricated a link. The byte-range check
    // rejects the hit because a code span sits between the keyword and the number.
    expect(extractLinkedIssueNumbers("Fixes `some code` #45", "acme/widgets")).toEqual([]);
  });

  it("REGRESSION (#7527): a real 'Closes #N' quoted ENTIRELY inside a code span is excluded by byte range", () => {
    // The PR template itself contains "(e.g. `Closes #123`)" -- the pattern matches "Closes #45" inside the
    // backticks, but its byte range overlaps the code span, so it is rejected (this is the exclusion the
    // string-strip approach handled by accident and the range approach handles correctly).
    expect(extractLinkedIssueNumbers("see the example `Closes #45` in the template", "acme/widgets")).toEqual([]);
    // A code span that comes AFTER a genuine match must not exclude that earlier match (span starts past it).
    expect(extractLinkedIssueNumbers("Closes #45 (compare with `#99`)", "acme/widgets")).toEqual([45]);
  });

  it("REGRESSION (#7527): code-span exclusion does not swallow a legitimate adjacent match", () => {
    // "Fixes `#999` for real, Closes #45": the `#999` inside a code span must not count, but the real
    // "Closes #45" outside any span must still link -- the range check only skips the overlapping hit.
    expect(extractLinkedIssueNumbers("Fixes `#999` for real, Closes #45", "acme/widgets")).toEqual([45]);
  });

  it("REGRESSION (#7527): recognizes the full-GitHub-URL closing form, same-repo-scoped", () => {
    expect(extractLinkedIssueNumbers("Closes https://github.com/acme/widgets/issues/45", "acme/widgets")).toEqual([45]);
    // www. host + case-insensitive owner still match this repo.
    expect(extractLinkedIssueNumbers("Fixes https://www.github.com/Acme/Widgets/issues/8", "acme/widgets")).toEqual([8]);
    // A full URL pointing at a DIFFERENT repo must not count as a same-repo linked issue.
    expect(extractLinkedIssueNumbers("Closes https://github.com/other/repo/issues/77", "acme/widgets")).toEqual([]);
  });
});
