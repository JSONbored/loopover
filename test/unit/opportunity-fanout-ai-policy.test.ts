import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// Route the miner's bare "@jsonbored/gittensory-engine" import at the engine source (mirrors
// miner-opportunity-fanout.test.ts) so the fan-out uses the real resolveAiPolicyVerdict.
vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { fetchCandidateIssuesWithSummary } from "../../packages/gittensory-miner/lib/opportunity-fanout.js";

const API = "https://api.test";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/ai-policy");

function readFixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, {
    ...init,
    headers: {
      "x-ratelimit-remaining": "42",
      "x-ratelimit-reset": "1800000000",
      ...(init.headers ?? {}),
    },
  });
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
  labels: ["good first issue"],
  comments: 1,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T01:00:00Z",
  html_url: `https://github.com/acme/allowed/issues/${number}`,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("opportunity fan-out AI-policy hard-skip (#2306)", () => {
  // The hard-skip must run as a PRE-FILTER: a repo whose banned AI-USAGE.md/CONTRIBUTING.md yields
  // allowed === false is dropped BEFORE any per-issue GitHub call for that repo. A banned repo therefore
  // costs exactly one policy-doc fetch and zero issue-listing quota — never a post-hoc annotation on a
  // list that was already built by hitting the issues endpoint.
  it("excludes a banned repo before any per-issue GitHub work, at the cost of one policy fetch", async () => {
    const bannedPolicy = readFixture("banned-ai-usage.md");
    const allowedPolicy = readFixture("allowed-silent.md");

    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      // Banned repo declares its AI ban in AI-USAGE.md, which short-circuits before CONTRIBUTING.md.
      if (url.includes("/repos/acme/banned/contents/AI-USAGE.md")) {
        return contentResponse(bannedPolicy);
      }
      // Any issue listing for the banned repo means the hard-skip failed to pre-filter it.
      if (url.includes("/repos/acme/banned/issues?")) {
        throw new Error("banned repo must be hard-skipped before its issues are listed");
      }
      // Allowed repo: no AI-USAGE.md, a silent CONTRIBUTING.md, then one open issue.
      if (url.includes("/repos/acme/allowed/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/allowed/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      if (url.includes("/repos/acme/allowed/issues?")) return jsonResponse([issue(7)]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await fetchCandidateIssuesWithSummary(
      [
        { owner: "acme", repo: "banned" },
        { owner: "acme", repo: "allowed" },
      ],
      "placeholder-token",
      { apiBaseUrl: API },
    );

    // Only the allowed repo's issue survives; the banned repo contributes nothing and no warning.
    expect(result.issues.map((entry) => entry.repoFullName)).toEqual(["acme/allowed"]);
    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([7]);
    expect(result.warnings).toEqual([]);

    // The banned repo cost exactly one GitHub call — its single policy-doc fetch — and no issues call.
    const bannedCalls = calls.filter((url) => url.includes("/repos/acme/banned/"));
    expect(bannedCalls).toHaveLength(1);
    expect(bannedCalls[0]).toContain("/repos/acme/banned/contents/AI-USAGE.md");
    expect(calls.some((url) => url.includes("/repos/acme/banned/issues?"))).toBe(false);

    // The allowed repo was fanned out normally (policy fetch + issue listing).
    expect(calls.some((url) => url.includes("/repos/acme/allowed/issues?"))).toBe(true);
  });
});
