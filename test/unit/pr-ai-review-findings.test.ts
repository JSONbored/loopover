import { describe, expect, it } from "vitest";
import {
  assertContributorOwnsPullRequest,
  buildFindingCategoryCounts,
  buildStructuredAiReviewFindings,
  INLINE_FINDINGS_METADATA_KEY,
  loadPrAiReviewFindings,
  orderedFindingCategoryCountRows,
  parseStoredInlineFindings,
} from "../../src/mcp/pr-ai-review-findings";
import { markAiReviewPublished, putCachedAiReview, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import { buildFindingCategoryCollapsible } from "../../src/review/unified-comment-bridge";
import type { InlineFinding } from "../../src/services/ai-review";
import { createTestEnv } from "../helpers/d1";

const sampleFindings: InlineFinding[] = [
  { path: "src/db.ts", line: 12, severity: "blocker", body: "This is vulnerable to SQL injection.", category: "security" },
  { path: "src/util.ts", line: 4, severity: "nit", body: "This will throw on an empty array." },
  { path: "src/app.test.ts", line: 9, severity: "blocker", body: "Assert the right value here." },
];

describe("parseStoredInlineFindings", () => {
  it("returns an empty list when metadata is absent or malformed", () => {
    expect(parseStoredInlineFindings(undefined)).toEqual([]);
    expect(parseStoredInlineFindings({})).toEqual([]);
    expect(parseStoredInlineFindings({ [INLINE_FINDINGS_METADATA_KEY]: "nope" })).toEqual([]);
    expect(parseStoredInlineFindings({ [INLINE_FINDINGS_METADATA_KEY]: [{ path: "", line: 1, severity: "nit", body: "x" }] })).toEqual([]);
    expect(parseStoredInlineFindings({ [INLINE_FINDINGS_METADATA_KEY]: [{ path: "a.ts", line: 0, severity: "nit", body: "x" }] })).toEqual([]);
    expect(parseStoredInlineFindings({ [INLINE_FINDINGS_METADATA_KEY]: [{ path: "a.ts", line: 1, severity: "maybe", body: "x" }] })).toEqual([]);
  });

  it("skips non-object entries and findings whose body is not a string", () => {
    expect(
      parseStoredInlineFindings({
        [INLINE_FINDINGS_METADATA_KEY]: [null, 42, { path: "src/a.ts", line: 2, severity: "nit", body: 99 }],
      }),
    ).toEqual([]);
    expect(
      parseStoredInlineFindings({
        [INLINE_FINDINGS_METADATA_KEY]: [{ path: "src/a.ts", line: 2.5, severity: "nit", body: "fractional line" }],
      }),
    ).toEqual([]);
  });

  it("keeps valid inline findings and drops invalid category values", () => {
    const parsed = parseStoredInlineFindings({
      [INLINE_FINDINGS_METADATA_KEY]: [
        { path: "src/a.ts", line: 2, severity: "blocker", body: "Fix me.", category: "security" },
        { path: "src/b.ts", line: 3, severity: "nit", body: "Rename this.", category: "not-a-category" },
      ],
    });
    expect(parsed).toEqual([
      { path: "src/a.ts", line: 2, severity: "blocker", body: "Fix me.", category: "security" },
      { path: "src/b.ts", line: 3, severity: "nit", body: "Rename this." },
    ]);
  });
});

describe("buildStructuredAiReviewFindings", () => {
  it("matches the PR comment category collapsible counts for the same findings", () => {
    const structured = buildStructuredAiReviewFindings(sampleFindings);
    const collapsible = buildFindingCategoryCollapsible(
      sampleFindings.map((finding) => ({ path: finding.path, body: finding.body, category: finding.category })),
    );
    expect(collapsible).not.toBeNull();
    const counts = buildFindingCategoryCounts(structured);
    expect(counts).toEqual({ security: 1, correctness: 1, tests: 1 });
    expect(collapsible?.body).toContain("| Security | 1 |");
    expect(collapsible?.body).toContain("| Correctness | 1 |");
    expect(collapsible?.body).toContain("| Tests | 1 |");
    expect(structured).toEqual([
      {
        category: "security",
        path: "src/db.ts",
        severity: "blocker",
        line: 12,
        body: "This is vulnerable to SQL injection.",
      },
      {
        category: "correctness",
        path: "src/util.ts",
        severity: "nit",
        line: 4,
        body: "This will throw on an empty array.",
      },
      {
        category: "tests",
        path: "src/app.test.ts",
        severity: "blocker",
        line: 9,
        body: "Assert the right value here.",
      },
    ]);
  });

  it("returns an empty structured list for no inline findings", () => {
    expect(buildStructuredAiReviewFindings([])).toEqual([]);
    expect(buildFindingCategoryCounts([])).toEqual({});
    expect(buildFindingCategoryCounts([
      { category: "correctness", path: "a.ts", severity: "nit", line: 1, body: "one" },
      { category: "correctness", path: "b.ts", severity: "blocker", line: 2, body: "two" },
    ])).toEqual({ correctness: 2 });
  });
});

describe("orderedFindingCategoryCountRows", () => {
  it("returns only categories with a non-zero count, in canonical order", () => {
    expect(orderedFindingCategoryCountRows({ security: 2, style: 1 })).toEqual([
      { category: "security", count: 2 },
      { category: "style", count: 1 },
    ]);
    expect(orderedFindingCategoryCountRows({})).toEqual([]);
  });
});

describe("loadPrAiReviewFindings", () => {
  it("returns ready with empty findings when a published review has no inline metadata", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets", private: false, owner: { login: "acme" } });
    await upsertRepositorySettings(env, { repoFullName: "acme/widgets", aiReviewMode: "advisory" });
    await putCachedAiReview(env, "acme/widgets", 11, "sha-empty", "advisory", { notes: "Clean review.", reviewerCount: 1 });
    await markAiReviewPublished(env, "acme/widgets", 11, "sha-empty");

    expect(await loadPrAiReviewFindings(env, { repoFullName: "acme/widgets", pullNumber: 11, login: "Miner1" })).toEqual({
      status: "ready",
      repoFullName: "acme/widgets",
      pullNumber: 11,
      login: "miner1",
      headSha: "sha-empty",
      findings: [],
      categoryCounts: {},
    });
  });

  it("returns ai_review_off and not_found on the expected branches", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets", private: false, owner: { login: "acme" } });
    await upsertRepositorySettings(env, { repoFullName: "acme/widgets", aiReviewMode: "off" });
    expect(await loadPrAiReviewFindings(env, { repoFullName: "acme/widgets", pullNumber: 12, login: "miner1" })).toMatchObject({
      status: "ai_review_off",
      findings: [],
      categoryCounts: {},
    });

    await upsertRepositorySettings(env, { repoFullName: "acme/widgets", aiReviewMode: "block" });
    expect(await loadPrAiReviewFindings(env, { repoFullName: "acme/widgets", pullNumber: 12, login: "miner1" })).toMatchObject({
      status: "not_found",
      findings: [],
      categoryCounts: {},
    });
  });

  it("nulls headSha when the published row omits it from the repository read", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets", private: false, owner: { login: "acme" } });
    await upsertRepositorySettings(env, { repoFullName: "acme/widgets", aiReviewMode: "block" });
    await env.DB.prepare(
      `INSERT INTO ai_review_cache (repo_full_name, pull_number, head_sha, ai_review_mode, notes, reviewer_count, findings_json, metadata_json, cacheable, published_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind("acme/widgets", 13, "", "block", "held", 1, "[]", "{}", 1, "2026-07-09T00:00:00.000Z", "2026-07-09T00:00:00.000Z")
      .run();

    expect(await loadPrAiReviewFindings(env, { repoFullName: "acme/widgets", pullNumber: 13, login: "miner1" })).toMatchObject({
      status: "ready",
      headSha: null,
      findings: [],
    });
  });
});

describe("assertContributorOwnsPullRequest", () => {
  it("accepts a case-insensitive author match and rejects other authors", () => {
    expect(() => assertContributorOwnsPullRequest("Miner1", "miner1")).not.toThrow();
    expect(() => assertContributorOwnsPullRequest("other", "miner1")).toThrow(/own pull requests/i);
    expect(() => assertContributorOwnsPullRequest(null, "miner1")).toThrow(/own pull requests/i);
  });
});
