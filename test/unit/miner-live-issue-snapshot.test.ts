import { describe, expect, it } from "vitest";
import { fetchLiveIssueSnapshot } from "../../packages/gittensory-miner/lib/live-issue-snapshot.js";

function graphqlResponse(body: unknown, status = 200) {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response;
}

describe("fetchLiveIssueSnapshot (#5132)", () => {
  it("returns null for a malformed repoFullName or non-positive issue number", async () => {
    expect(await fetchLiveIssueSnapshot("not-a-repo", 1, { fetchImpl: graphqlResponse({}) })).toBeNull();
    expect(await fetchLiveIssueSnapshot("acme/widgets", 0, { fetchImpl: graphqlResponse({}) })).toBeNull();
    expect(await fetchLiveIssueSnapshot("acme/widgets", -1, { fetchImpl: graphqlResponse({}) })).toBeNull();
  });

  it("builds an open-issue snapshot with normalized, deduplicated-shape referencing PRs from GraphQL nodes", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    const fetchImpl = async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = init.body as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            repository: {
              issue: {
                state: "OPEN",
                closedByPullRequestsReferences: {
                  nodes: [
                    { number: 42, state: "MERGED", author: { login: "alice" } },
                    { number: 43, state: "OPEN", author: null },
                  ],
                },
              },
            },
          },
        }),
      } as Response;
    };

    const snapshot = await fetchLiveIssueSnapshot("acme/widgets", 7, { githubToken: "tok", fetchImpl });

    expect(snapshot).toEqual({
      state: "open",
      referencingPrs: [
        { number: 42, state: "merged", authorLogin: "alice" },
        { number: 43, state: "open", authorLogin: "" },
      ],
    });
    expect(capturedUrl).toBe("https://api.github.com/graphql");
    const parsedBody = JSON.parse(capturedBody ?? "{}");
    expect(parsedBody.variables).toEqual({ owner: "acme", repo: "widgets", number: 7, maxPrs: 50 });
  });

  it("returns a closed-issue snapshot with no referencing PRs when the connection is empty", async () => {
    const snapshot = await fetchLiveIssueSnapshot("acme/widgets", 7, {
      fetchImpl: graphqlResponse({
        data: { repository: { issue: { state: "CLOSED", closedByPullRequestsReferences: { nodes: [] } } } },
      }),
    });
    expect(snapshot).toEqual({ state: "closed", referencingPrs: [] });
  });

  it("returns null when the HTTP response is not ok", async () => {
    expect(await fetchLiveIssueSnapshot("acme/widgets", 7, { fetchImpl: graphqlResponse({}, 500) })).toBeNull();
  });

  it("returns null when GitHub returns GraphQL errors", async () => {
    expect(
      await fetchLiveIssueSnapshot("acme/widgets", 7, {
        fetchImpl: graphqlResponse({ errors: [{ message: "Could not resolve to an Issue" }] }),
      }),
    ).toBeNull();
  });

  it("returns null when the issue is missing (repository or issue null) or its state is unrecognized", async () => {
    expect(
      await fetchLiveIssueSnapshot("acme/widgets", 7, {
        fetchImpl: graphqlResponse({ data: { repository: { issue: null } } }),
      }),
    ).toBeNull();
    expect(
      await fetchLiveIssueSnapshot("acme/widgets", 7, {
        fetchImpl: graphqlResponse({ data: { repository: null } }),
      }),
    ).toBeNull();
    expect(
      await fetchLiveIssueSnapshot("acme/widgets", 7, {
        fetchImpl: graphqlResponse({ data: { repository: { issue: { state: "MERGED" } } } }),
      }),
    ).toBeNull();
  });

  it("filters out malformed referencing-PR nodes without dropping valid siblings", async () => {
    const snapshot = await fetchLiveIssueSnapshot("acme/widgets", 7, {
      fetchImpl: graphqlResponse({
        data: {
          repository: {
            issue: {
              state: "OPEN",
              closedByPullRequestsReferences: {
                nodes: [null, { number: 0, state: "OPEN" }, { number: 5, state: "bogus" }, { number: 9, state: "CLOSED" }],
              },
            },
          },
        },
      }),
    });
    expect(snapshot).toEqual({ state: "open", referencingPrs: [{ number: 9, state: "closed", authorLogin: "" }] });
  });

  it("returns null when the response is not valid JSON or the fetch itself rejects", async () => {
    expect(
      await fetchLiveIssueSnapshot("acme/widgets", 7, {
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }) as unknown as Response,
      }),
    ).toBeNull();
    expect(
      await fetchLiveIssueSnapshot("acme/widgets", 7, {
        fetchImpl: async () => {
          throw new Error("network down");
        },
      }),
    ).toBeNull();
  });

  it("sends an authorization header only when a token is provided", async () => {
    let capturedHeaders: HeadersInit | undefined;
    const fetchImpl = async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers;
      return { ok: true, status: 200, json: async () => ({ data: { repository: { issue: { state: "OPEN", closedByPullRequestsReferences: { nodes: [] } } } } }) } as Response;
    };

    await fetchLiveIssueSnapshot("acme/widgets", 7, { fetchImpl });
    expect((capturedHeaders as Record<string, string>).authorization).toBeUndefined();

    await fetchLiveIssueSnapshot("acme/widgets", 7, { githubToken: "  secret-token  ", fetchImpl });
    expect((capturedHeaders as Record<string, string>).authorization).toBe("Bearer secret-token");
  });

  it("respects a custom graphqlUrl override", async () => {
    let capturedUrl: string | undefined;
    await fetchLiveIssueSnapshot("acme/widgets", 7, {
      graphqlUrl: "https://ghe.example.com/api/graphql",
      fetchImpl: async (url: string) => {
        capturedUrl = url;
        return { ok: true, status: 200, json: async () => ({ data: { repository: { issue: { state: "OPEN", closedByPullRequestsReferences: { nodes: [] } } } } }) } as Response;
      },
    });
    expect(capturedUrl).toBe("https://ghe.example.com/api/graphql");
  });
});
