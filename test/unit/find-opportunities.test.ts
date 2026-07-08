import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_FIND_OPPORTUNITIES_LANGUAGE_LENGTH,
  MAX_FIND_OPPORTUNITIES_LANGUAGES,
  MAX_FIND_OPPORTUNITIES_OWNER_LENGTH,
  MAX_FIND_OPPORTUNITIES_REPO_LENGTH,
  MAX_FIND_OPPORTUNITIES_TARGETS,
  normalizeFindOpportunitiesLimit,
  publicRankScore,
  runFindOpportunities,
  validateFindOpportunitiesInput,
} from "../../src/mcp/find-opportunities";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

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

describe("validateFindOpportunitiesInput", () => {
  it("requires targets or searchQuery", () => {
    expect(validateFindOpportunitiesInput({})).toEqual({ ok: false, reason: "targets_or_search_query_required" });
  });

  it("rejects invalid targets and oversized search queries", () => {
    expect(validateFindOpportunitiesInput({ targets: [{ owner: "", repo: "demo" }] })).toEqual({ ok: false, reason: "invalid_target" });
    expect(validateFindOpportunitiesInput({ targets: [{ owner: 123 as unknown as string, repo: "demo" }] })).toEqual({
      ok: false,
      reason: "invalid_target",
    });
    expect(validateFindOpportunitiesInput({ targets: [{ owner: "acme", repo: 456 as unknown as string }] })).toEqual({
      ok: false,
      reason: "invalid_target",
    });
    expect(
      validateFindOpportunitiesInput({
        targets: Array.from({ length: MAX_FIND_OPPORTUNITIES_TARGETS + 1 }, () => ({ owner: "acme", repo: "demo" })),
      }),
    ).toEqual({ ok: false, reason: "too_many_targets" });
    expect(
      validateFindOpportunitiesInput({ targets: [{ owner: "x".repeat(MAX_FIND_OPPORTUNITIES_OWNER_LENGTH + 1), repo: "demo" }] }),
    ).toEqual({ ok: false, reason: "owner_too_long" });
    expect(
      validateFindOpportunitiesInput({ targets: [{ owner: "acme", repo: "x".repeat(MAX_FIND_OPPORTUNITIES_REPO_LENGTH + 1) }] }),
    ).toEqual({ ok: false, reason: "repo_too_long" });
    expect(validateFindOpportunitiesInput({ searchQuery: "x".repeat(501) })).toEqual({ ok: false, reason: "search_query_too_long" });
    expect(
      validateFindOpportunitiesInput({ searchQuery: "docs", goalSpec: { minRankScore: 101 } }),
    ).toEqual({ ok: false, reason: "invalid_min_rank_score" });
    expect(validateFindOpportunitiesInput({ searchQuery: "docs", goalSpec: { languages: [""] } })).toEqual({
      ok: false,
      reason: "invalid_languages",
    });
  });

  it("accepts trimmed targets and search queries", () => {
    const parsed = validateFindOpportunitiesInput({
      targets: [{ owner: " acme ", repo: " widgets " }],
      goalSpec: { lane: "docs", minRankScore: 40 },
      limit: 3,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.targets?.[0]).toEqual({ owner: "acme", repo: "widgets" });
      expect(parsed.value.goalSpec).toEqual({ lane: "docs", minRankScore: 40 });
      expect(parsed.value.limit).toBe(3);
    }
  });

  it("deduplicates targets before downstream authorization and lookup work", () => {
    const parsed = validateFindOpportunitiesInput({
      targets: [
        { owner: " acme ", repo: " widgets " },
        { owner: "ACME", repo: "widgets" },
        { owner: "acme", repo: "other" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.targets).toEqual([
        { owner: "acme", repo: "widgets" },
        { owner: "acme", repo: "other" },
      ]);
    }
  });

  it("accepts exactly MAX_FIND_OPPORTUNITIES_TARGETS targets (boundary, not just the +1 overflow)", () => {
    const parsed = validateFindOpportunitiesInput({
      targets: Array.from({ length: MAX_FIND_OPPORTUNITIES_TARGETS }, (_, i) => ({ owner: "acme", repo: `demo${i}` })),
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.targets).toHaveLength(MAX_FIND_OPPORTUNITIES_TARGETS);
  });

  it("rejects a non-array goalSpec.languages", () => {
    expect(
      validateFindOpportunitiesInput({ searchQuery: "docs", goalSpec: { languages: "typescript" as unknown as string[] } }),
    ).toEqual({ ok: false, reason: "invalid_languages" });
  });

  it("rejects a non-string language entry", () => {
    expect(
      validateFindOpportunitiesInput({ searchQuery: "docs", goalSpec: { languages: [123 as unknown as string] } }),
    ).toEqual({ ok: false, reason: "invalid_languages" });
  });

  it("rejects more than MAX_FIND_OPPORTUNITIES_LANGUAGES languages", () => {
    expect(
      validateFindOpportunitiesInput({
        searchQuery: "docs",
        goalSpec: { languages: Array.from({ length: MAX_FIND_OPPORTUNITIES_LANGUAGES + 1 }, (_, i) => `lang${i}`) },
      }),
    ).toEqual({ ok: false, reason: "invalid_languages" });
  });

  it("rejects a language entry longer than MAX_FIND_OPPORTUNITIES_LANGUAGE_LENGTH", () => {
    expect(
      validateFindOpportunitiesInput({
        searchQuery: "docs",
        goalSpec: { languages: ["x".repeat(MAX_FIND_OPPORTUNITIES_LANGUAGE_LENGTH + 1)] },
      }),
    ).toEqual({ ok: false, reason: "invalid_languages" });
  });

  it("accepts a valid languages list at or under the boundary", () => {
    const parsed = validateFindOpportunitiesInput({
      searchQuery: "docs",
      goalSpec: { languages: ["typescript", "x".repeat(MAX_FIND_OPPORTUNITIES_LANGUAGE_LENGTH)] },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.goalSpec).toEqual({ languages: ["typescript", "x".repeat(MAX_FIND_OPPORTUNITIES_LANGUAGE_LENGTH)] });
  });
});

describe("find-opportunities helpers", () => {
  it("normalizes limits and public rank scores", () => {
    expect(normalizeFindOpportunitiesLimit(undefined)).toBe(5);
    expect(normalizeFindOpportunitiesLimit(99)).toBe(50);
    expect(normalizeFindOpportunitiesLimit(0)).toBe(1);
    expect(publicRankScore(0.876)).toBe(88);
    expect(publicRankScore(Number.NaN)).toBe(0);
  });
});

describe("runFindOpportunities", () => {
  it("hard-skips banned repos before returning ranked opportunities", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "test-token" });
    const bannedPolicy = readFixture("banned-ai-usage.md");
    const allowedPolicy = readFixture("allowed-silent.md");

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/repos/acme/banned/contents/AI-USAGE.md")) return contentResponse(bannedPolicy);
      if (url.includes("/repos/acme/banned/issues?")) throw new Error("banned repo must be hard-skipped");
      if (url.includes("/repos/acme/allowed/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/allowed/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      if (url.includes("/repos/acme/allowed/issues?")) return jsonResponse([issue(7)]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await runFindOpportunities(env, {
      targets: [
        { owner: "acme", repo: "banned" },
        { owner: "acme", repo: "allowed" },
      ],
    });

    expect(result.status).toBe("ok");
    expect(result.ranked.map((entry) => `${entry.owner}/${entry.repo}#${entry.issueNumber}`)).toEqual(["acme/allowed#7"]);
    expect(result.ranked.every((entry) => entry.aiPolicyAllowed === true)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/wallet|hotkey|reward estimate/i);
  });

  it("returns github_token_unavailable when no token and no installed targets", async () => {
    const env = createTestEnv();
    const result = await runFindOpportunities(env, { targets: [{ owner: "missing", repo: "repo" }] });
    expect(result).toMatchObject({
      status: "github_token_unavailable",
      ranked: [],
      totalCandidates: 0,
      reason: "github_token_unavailable",
    });
  });

  it("checks access only once for duplicate targets", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "test-token" });
    const allowedPolicy = readFixture("allowed-silent.md");
    const accessChecks: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/repos/acme/allowed/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/allowed/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      if (url.includes("/repos/acme/allowed/issues?")) return jsonResponse([issue(5)]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await runFindOpportunities(
      env,
      {
        targets: [
          { owner: "acme", repo: "allowed" },
          { owner: "ACME", repo: "allowed" },
        ],
      },
      {
        canAccessRepo: async (repoFullName) => {
          accessChecks.push(repoFullName);
          return true;
        },
      },
    );

    expect(result.status).toBe("ok");
    expect(accessChecks).toEqual(["acme/allowed"]);
  });

  it("filters inaccessible targets via canAccessRepo", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "test-token" });
    await upsertRepositoryFromGitHub(env, { name: "allowed", full_name: "acme/allowed" });
    const allowedPolicy = readFixture("allowed-silent.md");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/repos/acme/allowed/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/allowed/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);
      if (url.includes("/repos/acme/allowed/issues?")) return jsonResponse([issue(3)]);
      return jsonResponse({}, { status: 404 });
    });

    const blocked = await runFindOpportunities(env, { targets: [{ owner: "acme", repo: "blocked" }] }, { canAccessRepo: async () => false });
    expect(blocked).toMatchObject({ status: "invalid_request", reason: "no_accessible_targets" });

    const allowed = await runFindOpportunities(env, { targets: [{ owner: "acme", repo: "allowed" }] }, { canAccessRepo: async () => true });
    expect(allowed.status).toBe("ok");
    expect(allowed.ranked).toHaveLength(1);
  });
});
