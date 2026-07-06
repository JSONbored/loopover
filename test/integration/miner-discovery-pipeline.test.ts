/**
 * Cross-module regression for Phase-1 miner discovery: AI-policy hard-skip, metadata fan-out,
 * goal-model lane fit, freshness, and duplicate-risk scoring composed through the ranker.
 * Per-module edge cases stay in `opportunity-fanout-ai-policy.test.ts`, `miner-opportunity-ranker.test.ts`,
 * `goal-model.test.ts`, and `ai-policy-map.test.ts` — this file pins the composed ordering only.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { fetchCandidateIssuesWithSummary } from "../../packages/gittensory-miner/lib/opportunity-fanout.js";
import { rankCandidateIssuesWithSummary } from "../../packages/gittensory-miner/lib/opportunity-ranker.js";

const API = "https://api.test";
const NOW = Date.parse("2026-07-03T12:00:00.000Z");
const FRESH = "2026-07-03T10:00:00.000Z";
const STALE = "2024-01-01T00:00:00.000Z";

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

function issueRow(
  number: number,
  overrides: {
    title?: string;
    labels?: string[];
    created_at?: string;
    updated_at?: string;
  } = {},
) {
  return {
    number,
    title: overrides.title ?? `Issue ${number}`,
    labels: (overrides.labels ?? ["help wanted"]).map((name) => ({ name })),
    comments: 1,
    created_at: overrides.created_at ?? FRESH,
    updated_at: overrides.updated_at ?? FRESH,
    html_url: `https://github.com/acme/widgets/issues/${number}`,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("miner discovery pipeline (#2311)", () => {
  it("fan-out, goal-model fit, freshness, and dupRisk produce a pinned ranked order", async () => {
    const bannedPolicy = readFixture("banned-ai-usage.md");
    const allowedPolicy = readFixture("allowed-silent.md");
    const dupTitle = "Implement cache invalidation for worker deploy pipeline";

    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);

      if (url.includes("/repos/acme/banned/contents/AI-USAGE.md")) {
        return contentResponse(bannedPolicy);
      }
      if (url.includes("/repos/acme/banned/")) {
        throw new Error("banned repo must be hard-skipped before any other GitHub work");
      }

      if (url.includes("/repos/acme/widgets/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/widgets/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      if (url.includes("/repos/acme/widgets/issues?")) {
        return jsonResponse([
          issueRow(10, { labels: ["feature", "help wanted"], title: "Add feature lane match" }),
          issueRow(20, { labels: ["help wanted"], title: "Neutral lane-fit candidate" }),
          issueRow(30, { labels: ["help wanted"], title: "Stale freshness candidate", updated_at: STALE, created_at: STALE }),
          issueRow(40, { labels: ["do-not-pick", "help wanted"], title: "Blocked label candidate" }),
          issueRow(50, { labels: ["help wanted"], title: dupTitle }),
          issueRow(51, { labels: ["help wanted"], title: `${dupTitle} retry` }),
        ]);
      }

      return jsonResponse({}, { status: 404 });
    });

    const fanout = await fetchCandidateIssuesWithSummary(
      [{ owner: "acme", repo: "banned" }, { owner: "acme", repo: "widgets" }],
      "token",
      { apiBaseUrl: API },
    );

    expect(fanout.issues.map((entry) => `${entry.repoFullName}#${entry.issueNumber}`)).toEqual([
      "acme/widgets#10",
      "acme/widgets#20",
      "acme/widgets#30",
      "acme/widgets#40",
      "acme/widgets#50",
      "acme/widgets#51",
    ]);
    expect(calls.filter((url) => url.includes("/repos/acme/banned/"))).toHaveLength(1);
    expect(calls.some((url) => url.includes("/repos/acme/banned/issues?"))).toBe(false);

    const ranked = rankCandidateIssuesWithSummary(fanout.issues, {
      nowMs: NOW,
      goalSpecContentByRepo: {
        "acme/widgets": "preferredLabels: [feature]\nblockedLabels: [do-not-pick]\n",
      },
    });

    expect(ranked.issues.map((entry) => `${entry.repoFullName}#${entry.issueNumber}`)).toEqual([
      "acme/widgets#10",
      "acme/widgets#20",
      "acme/widgets#50",
      "acme/widgets#51",
      "acme/widgets#30",
      "acme/widgets#40",
    ]);
    expect(ranked.issues[0]?.laneFit).toBeGreaterThanOrEqual(0.99);
    expect(ranked.issues.at(-1)?.laneFit).toBe(0);
    expect(ranked.issues.at(-1)?.rankScore).toBe(0);
    expect((ranked.issues[4]?.freshness ?? 1)).toBeLessThan(ranked.issues[1]?.freshness ?? 0);
    expect(ranked.issues[2]?.dupRisk ?? 0).toBeGreaterThan(0);
  });
});
