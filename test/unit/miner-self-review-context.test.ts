import { describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { MAX_FOCUS_MANIFEST_BYTES } from "../../packages/gittensory-engine/src/index";
import { fetchSelfReviewContext } from "../../packages/gittensory-miner/lib/self-review-context.js";

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
    expect("issueQuality" in result).toBe(false);
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

    const result = await fetchSelfReviewContext("acme/widgets", { linkedIssues: [7], fetchImpl: fetchImpl as never });
    expect(result.inDuplicateCluster).toBe(true);
  });

  it("returns false for inDuplicateCluster when no linkedIssues are supplied", async () => {
    const fetchImpl = routedFetch({
      "/repos/acme/widgets/issues": () => jsonResponse([issuePayload()]),
      "/repos/acme/widgets/pulls": () => jsonResponse([prPayload({ body: "Closes #7" }), prPayload({ number: 43, body: "Fixes #7" })]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
      "api.gittensor.io/miners": () => jsonResponse([]),
    });

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never });
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

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never });
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

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, perPage: 2 });
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

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never, perPage: 1 });
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

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never });
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

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never });
    expect(requestedPaths).toEqual([
      "https://raw.githubusercontent.com/acme/widgets/HEAD/.gittensory.yml",
      "https://raw.githubusercontent.com/acme/widgets/HEAD/.github/gittensory.yml",
      "https://raw.githubusercontent.com/acme/widgets/HEAD/.gittensory.json",
      "https://raw.githubusercontent.com/acme/widgets/HEAD/.github/gittensory.json",
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

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never });
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

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never });
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

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never });
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

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never });
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
    expect((await fetchSelfReviewContext("acme/widgets", { contributorLogin: "Miner-Bot", fetchImpl: miss as never })).confirmedContributor).toBe(false);

    const notOk = routedFetch({
      "api.gittensor.io/miners": () => jsonResponse(null, 500),
      "/repos/acme/widgets/issues": () => jsonResponse([]),
      "/repos/acme/widgets/pulls": () => jsonResponse([]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
    });
    expect((await fetchSelfReviewContext("acme/widgets", { contributorLogin: "miner-bot", fetchImpl: notOk as never })).confirmedContributor).toBe(false);

    const throwing = async (url: string) => {
      if (url.includes("api.gittensor.io/miners")) throw new Error("network down");
      if (url.includes("/repos/acme/widgets/issues")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets/pulls")) return jsonResponse([]);
      if (url.includes("/repos/acme/widgets")) return jsonResponse(REPO_PAYLOAD);
      if (url.includes("raw.githubusercontent.com")) return jsonResponse(null, 404);
      return jsonResponse(null, 404);
    };
    expect((await fetchSelfReviewContext("acme/widgets", { contributorLogin: "miner-bot", fetchImpl: throwing as never })).confirmedContributor).toBe(false);
  });

  it("matches a confirmed contributor case-insensitively", async () => {
    const fetchImpl = routedFetch({
      "api.gittensor.io/miners": () => jsonResponse([{ githubUsername: "Miner-Bot" }]),
      "/repos/acme/widgets/issues": () => jsonResponse([]),
      "/repos/acme/widgets/pulls": () => jsonResponse([]),
      "/repos/acme/widgets": () => jsonResponse(REPO_PAYLOAD),
      "raw.githubusercontent.com": () => jsonResponse(null, 404),
    });
    const result = await fetchSelfReviewContext("acme/widgets", { contributorLogin: "miner-bot", fetchImpl: fetchImpl as never });
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

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never });
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

    const result = await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never });
    expect(result.pullRequests.find((pr) => pr.number === 51)?.mergeableState).toBe("dirty");
    expect(result.pullRequests.find((pr) => pr.number === 52)?.mergeableState).toBeNull();
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
      await fetchSelfReviewContext("acme/widgets", { fetchImpl: fetchImpl as never });
      expect(capturedAuth).toBe("Bearer env-token");
    } finally {
      if (original === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = original;
    }
  });
});
