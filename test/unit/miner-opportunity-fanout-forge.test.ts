import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import {
  fetchCandidateIssues,
  searchCandidateIssuesWithSummary,
} from "../../packages/gittensory-miner/lib/opportunity-fanout.js";

type Call = { url: string; headers: Record<string, string> };

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, init);
}

function contentResponse(content: string) {
  return jsonResponse({
    type: "file",
    encoding: "base64",
    content: Buffer.from(content, "utf8").toString("base64"),
  });
}

const issue = (number: number) => ({
  number,
  title: `Issue ${number}`,
  labels: ["help wanted"],
  comments: 1,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T01:00:00Z",
  html_url: `https://forge.example.com/acme/widgets/issues/${number}`,
});

function stubFetch(handler: (url: string) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
    return handler(url);
  });
  return calls;
}

const CUSTOM_FORGE = {
  apiBaseUrl: "https://ghe.example.com/api/v3",
  apiVersion: "v9",
  apiVersionHeader: "x-forge-version",
  acceptHeader: "application/vnd.forge+json",
  userAgent: "acme-tenant-bot",
  repoPathPrefix: "/repositories",
  searchEndpoint: "/search/tickets",
  searchQualifiers: "is:open kind:issue",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("opportunity fan-out per-tenant forge config (#4784)", () => {
  it("routes repo fetches through the tenant forge host, path prefix, and headers", async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("Contributions welcome.");
      if (url.includes("/issues?")) return jsonResponse([issue(7)]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await fetchCandidateIssues([{ owner: "acme", repo: "widgets" }], "tenant-token", {
      forge: CUSTOM_FORGE,
    });

    expect(result.map((entry) => entry.issueNumber)).toEqual([7]);
    // Every request went to the tenant forge base URL + custom repo path prefix, not api.github.com/repos.
    expect(calls.every((call) => call.url.startsWith("https://ghe.example.com/api/v3/repositories/acme/widgets"))).toBe(
      true,
    );
    expect(calls.some((call) => call.url.includes("/repos/"))).toBe(false);
    // Headers carry the tenant's accept/user-agent and a custom API-version header name+value (no github header).
    const headers = calls[0]?.headers ?? {};
    expect(headers.accept).toBe("application/vnd.forge+json");
    expect(headers["user-agent"]).toBe("acme-tenant-bot");
    expect(headers["x-forge-version"]).toBe("v9");
    expect(headers["x-github-api-version"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer tenant-token");
  });

  it("routes search through the tenant search endpoint and search-qualifier dialect", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/search/tickets?")) {
        return jsonResponse({
          items: [
            {
              ...issue(21),
              repository: { full_name: "acme/widgets" },
              html_url: "https://ghe.example.com/acme/widgets/issues/21",
            },
          ],
        });
      }
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("Contributions welcome.");
      return jsonResponse({}, { status: 404 });
    });

    const result = await searchCandidateIssuesWithSummary("label:bug", "tenant-token", { forge: CUSTOM_FORGE });

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([21]);
    const searchCall = calls.find((call) => call.url.includes("/search/tickets?"));
    expect(searchCall).toBeDefined();
    expect(searchCall?.url).toContain(
      `q=${encodeURIComponent("label:bug is:open kind:issue")}`,
    );
    expect(calls.some((call) => call.url.includes("/search/issues?"))).toBe(false);
  });

  it("lets a legacy top-level apiBaseUrl win over forge.apiBaseUrl (back-compat)", async () => {
    const calls = stubFetch(() => contentResponse("AI-generated PRs are rejected."));

    await fetchCandidateIssues([{ owner: "acme", repo: "widgets" }], "", {
      apiBaseUrl: "https://legacy.example.com",
      forge: { apiBaseUrl: "https://ignored.example.com", repoPathPrefix: "/repositories" },
    });

    // The top-level override supplies the host; the rest of the forge config (path prefix) still applies.
    expect(calls[0]?.url).toBe("https://legacy.example.com/repositories/acme/widgets/contents/AI-USAGE.md");
  });
});
