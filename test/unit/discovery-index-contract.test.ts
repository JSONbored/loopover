import { describe, expect, it } from "vitest";
import {
  DISCOVERY_INDEX_CONTRACT_VERSION,
  DISCOVERY_INDEX_FORBIDDEN_FIELDS,
  discoveryIndexBoundaryViolations,
  normalizeDiscoveryIndexCandidate,
  normalizeDiscoveryIndexRequest,
  normalizeDiscoveryIndexResponse,
} from "../../packages/gittensory-engine/src/index";

const VALID_CANDIDATE = {
  repoFullName: "owner/repo",
  issueNumber: 42,
  title: "Fix the thing",
  labels: ["help wanted", "  ", 7, "bug"],
  commentsCount: 3,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  htmlUrl: "https://github.com/owner/repo/issues/42",
  aiPolicyAllowed: true,
  aiPolicySource: "AI-USAGE.md",
};

describe("discovery-index API contract (#4300)", () => {
  it("re-exports the contract API from the engine barrel", () => {
    expect(typeof normalizeDiscoveryIndexRequest).toBe("function");
    expect(typeof normalizeDiscoveryIndexCandidate).toBe("function");
    expect(typeof normalizeDiscoveryIndexResponse).toBe("function");
    expect(typeof discoveryIndexBoundaryViolations).toBe("function");
    expect(DISCOVERY_INDEX_CONTRACT_VERSION).toBe(1);
    expect(DISCOVERY_INDEX_FORBIDDEN_FIELDS).toContain("wallet");
  });

  describe("normalizeDiscoveryIndexRequest", () => {
    it("normalizes scope lists (dedupe, skip invalid, cap) and clamps the limit", () => {
      const { request, warnings } = normalizeDiscoveryIndexRequest({
        repos: ["owner/a", "owner/a", "no-slash", "owner/b/extra", "/norepo", 5, "owner/b"],
        orgs: ["acme", "acme", "bad/owner", "  ", "beta"],
        searchTerms: ["label:bug", "  ", "", "is:open"],
        limit: 12.9,
        cursor: "eyJwIjoyfQ==",
      });
      expect(request.contractVersion).toBe(1);
      expect(request.query.repos).toEqual(["owner/a", "owner/b"]);
      expect(request.query.orgs).toEqual(["acme", "beta"]);
      expect(request.query.searchTerms).toEqual(["label:bug", "is:open"]);
      expect(request.query.limit).toBe(12);
      expect(request.query.cursor).toBe("eyJwIjoyfQ==");
      expect(warnings).toEqual([]);
    });

    it("clamps limit bounds and warns on a non-numeric limit", () => {
      expect(normalizeDiscoveryIndexRequest({ limit: 0 }).request.query.limit).toBe(1);
      expect(normalizeDiscoveryIndexRequest({ limit: 9999 }).request.query.limit).toBe(200);
      expect(normalizeDiscoveryIndexRequest({}).request.query.limit).toBe(50);
      const bad = normalizeDiscoveryIndexRequest({ limit: "lots" });
      expect(bad.request.query.limit).toBe(50);
      expect(bad.warnings.join(" ")).toMatch(/"limit" must be a number/);
    });

    it("blanks a non-string / empty cursor and non-array scopes", () => {
      expect(normalizeDiscoveryIndexRequest({ cursor: "   " }).request.query.cursor).toBeNull();
      expect(normalizeDiscoveryIndexRequest({ cursor: 12 }).request.query.cursor).toBeNull();
      expect(normalizeDiscoveryIndexRequest({ repos: "owner/a" }).request.query.repos).toEqual([]);
    });

    it("caps a scope list at 200 entries", () => {
      const many = Array.from({ length: 250 }, (_, i) => `owner/r${i}`);
      expect(normalizeDiscoveryIndexRequest({ repos: many }).request.query.repos).toHaveLength(200);
    });

    it("degrades a non-mapping request to an empty query with a warning", () => {
      for (const raw of [null, undefined, 42, ["a"]]) {
        const parsed = normalizeDiscoveryIndexRequest(raw);
        expect(parsed.request.query).toEqual({ repos: [], orgs: [], searchTerms: [], limit: 50, cursor: null });
        expect(parsed.warnings.join(" ")).toMatch(/must be a mapping/);
      }
    });
  });

  describe("discoveryIndexBoundaryViolations", () => {
    it("lists forbidden field names present on a raw object", () => {
      expect(discoveryIndexBoundaryViolations({ title: "ok", score: 9, walletAddress: "x", HotKey: "y" }).sort()).toEqual(
        ["HotKey", "score", "walletAddress"].sort(),
      );
    });
    it("returns [] for a clean object or a non-object", () => {
      expect(discoveryIndexBoundaryViolations({ repoFullName: "o/r", title: "t" })).toEqual([]);
      expect(discoveryIndexBoundaryViolations(null)).toEqual([]);
      expect(discoveryIndexBoundaryViolations(["score"])).toEqual([]);
    });
  });

  describe("normalizeDiscoveryIndexCandidate", () => {
    it("mirrors normalizeCandidate's shape for a valid public-safe candidate", () => {
      expect(normalizeDiscoveryIndexCandidate(VALID_CANDIDATE)).toEqual({
        owner: "owner",
        repo: "repo",
        repoFullName: "owner/repo",
        issueNumber: 42,
        title: "Fix the thing",
        labels: ["help wanted", "bug"],
        commentsCount: 3,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        htmlUrl: "https://github.com/owner/repo/issues/42",
        aiPolicyAllowed: true,
        aiPolicySource: "AI-USAGE.md",
      });
    });

    it("applies defaults for missing optional fields", () => {
      const c = normalizeDiscoveryIndexCandidate({ repoFullName: "o/r", issueNumber: 1, title: "t" });
      expect(c).toMatchObject({
        labels: [],
        commentsCount: 0,
        createdAt: null,
        updatedAt: null,
        htmlUrl: null,
        aiPolicyAllowed: true,
        aiPolicySource: "none",
      });
    });

    it("maps aiPolicySource and respects an explicit aiPolicyAllowed:false", () => {
      expect(normalizeDiscoveryIndexCandidate({ repoFullName: "o/r", issueNumber: 1, title: "t", aiPolicySource: "CONTRIBUTING.md", aiPolicyAllowed: false })).toMatchObject({
        aiPolicySource: "CONTRIBUTING.md",
        aiPolicyAllowed: false,
      });
      expect(normalizeDiscoveryIndexCandidate({ repoFullName: "o/r", issueNumber: 1, title: "t", aiPolicySource: "nope" })?.aiPolicySource).toBe("none");
    });

    it("rejects a candidate carrying any forbidden boundary field", () => {
      expect(normalizeDiscoveryIndexCandidate({ ...VALID_CANDIDATE, rewardScore: 0.9 })).toBeNull();
      expect(normalizeDiscoveryIndexCandidate({ ...VALID_CANDIDATE, diff: "@@ -1 +1 @@" })).toBeNull();
    });

    it("returns null on an invalid repo, issue number, title, or non-object", () => {
      expect(normalizeDiscoveryIndexCandidate({ issueNumber: 1, title: "t" })).toBeNull();
      expect(normalizeDiscoveryIndexCandidate({ repoFullName: "no-slash", issueNumber: 1, title: "t" })).toBeNull();
      expect(normalizeDiscoveryIndexCandidate({ repoFullName: "o/r", issueNumber: 0, title: "t" })).toBeNull();
      expect(normalizeDiscoveryIndexCandidate({ repoFullName: "o/r", issueNumber: 1.5, title: "t" })).toBeNull();
      expect(normalizeDiscoveryIndexCandidate({ repoFullName: "o/r", issueNumber: "1", title: "t" })).toBeNull();
      expect(normalizeDiscoveryIndexCandidate({ repoFullName: "o/r", issueNumber: 1, title: "   " })).toBeNull();
      expect(normalizeDiscoveryIndexCandidate(null)).toBeNull();
      expect(normalizeDiscoveryIndexCandidate([VALID_CANDIDATE])).toBeNull();
    });

    it("coerces a non-finite commentsCount and non-array labels to defaults", () => {
      const c = normalizeDiscoveryIndexCandidate({ repoFullName: "o/r", issueNumber: 1, title: "t", commentsCount: Infinity, labels: "bug" });
      expect(c?.commentsCount).toBe(0);
      expect(c?.labels).toEqual([]);
    });
  });

  describe("normalizeDiscoveryIndexResponse", () => {
    it("keeps valid candidates, drops invalid/boundary ones with warnings, and carries the cursor", () => {
      const parsed = normalizeDiscoveryIndexResponse({
        candidates: [VALID_CANDIDATE, { repoFullName: "no-slash" }, { ...VALID_CANDIDATE, walletBalance: 5 }],
        nextCursor: "next==",
      });
      expect(parsed.response.contractVersion).toBe(1);
      expect(parsed.response.candidates).toHaveLength(1);
      expect(parsed.response.candidates[0]?.repoFullName).toBe("owner/repo");
      expect(parsed.response.nextCursor).toBe("next==");
      expect(parsed.warnings.filter((w) => /dropped an invalid/.test(w))).toHaveLength(2);
    });

    it("degrades a non-mapping response and a missing/blank cursor", () => {
      const empty = normalizeDiscoveryIndexResponse(7);
      expect(empty.response.candidates).toEqual([]);
      expect(empty.response.nextCursor).toBeNull();
      expect(empty.warnings.join(" ")).toMatch(/must be a mapping/);
      expect(normalizeDiscoveryIndexResponse({ candidates: "nope", nextCursor: "  " }).response).toMatchObject({ candidates: [], nextCursor: null });
    });
  });
});
