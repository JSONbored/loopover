import { afterEach, describe, expect, it, vi } from "vitest";
import * as repositoriesModule from "../../src/db/repositories";
import { upsertPullRequestFile, upsertRecentMergedPullRequest } from "../../src/db/repositories";
import { comparableAddedLines, MAX_COPYCAT_CANDIDATES, runCopycatAssessment, shouldCollectCopycatEvidence } from "../../src/queue/copycat-detection";
import type { PullRequestFileRecord, PullRequestRecord, RecentMergedPullRequestRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

afterEach(() => {
  vi.restoreAllMocks();
});

const REPO = "acme/widgets";

function file(pullNumber: number, path: string, patch: string): PullRequestFileRecord {
  return { repoFullName: REPO, pullNumber, path, status: "modified", additions: 1, deletions: 0, changes: 1, payload: { patch } };
}

function openSibling(number: number, createdAt: string): PullRequestRecord {
  return { repoFullName: REPO, number, title: "sibling", state: "open", labels: [], linkedIssues: [], createdAt };
}

function recentMerged(number: number, mergedAt: string, changedFiles: string[]): RecentMergedPullRequestRecord {
  return { repoFullName: REPO, number, title: "merged", labels: [], linkedIssues: [], changedFiles, mergedAt, payload: {} };
}

describe("shouldCollectCopycatEvidence", () => {
  it("is false for off/absent, true for warn/label/block", () => {
    expect(shouldCollectCopycatEvidence({ copycatGateMode: "off" })).toBe(false);
    expect(shouldCollectCopycatEvidence({ copycatGateMode: undefined })).toBe(false);
    expect(shouldCollectCopycatEvidence({ copycatGateMode: "warn" })).toBe(true);
    expect(shouldCollectCopycatEvidence({ copycatGateMode: "label" })).toBe(true);
    expect(shouldCollectCopycatEvidence({ copycatGateMode: "block" })).toBe(true);
  });
});

describe("comparableAddedLines", () => {
  it("extracts added lines from source files and concatenates in file order", () => {
    const files = [
      { path: "src/a.ts", payload: { patch: "+one\n+two" } },
      { path: "src/b.ts", payload: { patch: "+three" } },
    ];
    expect(comparableAddedLines(files)).toEqual(["one", "two", "three"]);
  });

  it("excludes lockfile/generated/vendored paths (#1969: reuse the generated/lockfile exclusion)", () => {
    const files = [
      { path: "package-lock.json", payload: { patch: "+lockfile content that would otherwise inflate containment" } },
      { path: "dist/bundle.js", payload: { patch: "+built output" } },
      { path: "src/real.ts", payload: { patch: "+real source" } },
    ];
    expect(comparableAddedLines(files)).toEqual(["real source"]);
  });

  it("skips a file with no patch (binary/too-large) without throwing", () => {
    expect(comparableAddedLines([{ path: "src/a.ts", payload: null }])).toEqual([]);
    expect(comparableAddedLines([{ path: "src/a.ts" }])).toEqual([]);
  });
});

describe("runCopycatAssessment", () => {
  it("falls back to mode off / engine-default minScore when settings.copycatGateMode/copycatGateMinScore are absent", async () => {
    const env = createTestEnv();
    const sourceLines = "+function add(a, b) {\n+const total = a + b;\n+logger.debug(total);\n+return total;\n+}\n+export default add;";
    await upsertPullRequestFile(env, file(42, "src/math.ts", sourceLines));

    const result = await runCopycatAssessment(env, {
      repoFullName: REPO,
      pr: { number: 100, createdAt: "2026-06-05T00:00:00Z" },
      files: [file(100, "src/copy.ts", sourceLines)],
      otherOpenPullRequests: [openSibling(42, "2026-06-01T00:00:00Z")],
      mode: undefined,
      minScore: undefined,
    });
    // Score is still computed for observability, but an absent mode (⇒ "off") never acts.
    expect(result.score).toBe(100);
    expect(result.wouldAct).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it("returns score 0 / no findings / no match when there is no prior art at all", async () => {
    const env = createTestEnv();
    const result = await runCopycatAssessment(env, {
      repoFullName: REPO,
      pr: { number: 100, createdAt: "2026-06-05T00:00:00Z" },
      files: [file(100, "src/a.ts", "+function add(a, b) {\n+const total = a + b;\n+return total;\n+}")],
      otherOpenPullRequests: [],
      mode: "block",
      minScore: null,
    });
    expect(result.score).toBe(0);
    expect(result.matchedPullNumber).toBeNull();
    expect(result.wouldAct).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it("scores this PR against an earlier open sibling's already-fetched files, producing a finding at block mode", async () => {
    const env = createTestEnv();
    const sourceLines = "+function add(a, b) {\n+const total = a + b;\n+logger.debug(total);\n+return total;\n+}\n+export default add;";
    await upsertPullRequestFile(env, file(42, "src/math.ts", sourceLines));

    const result = await runCopycatAssessment(env, {
      repoFullName: REPO,
      pr: { number: 100, createdAt: "2026-06-05T00:00:00Z" },
      files: [file(100, "src/copy.ts", sourceLines)],
      otherOpenPullRequests: [openSibling(42, "2026-06-01T00:00:00Z")],
      mode: "block",
      minScore: null,
    });
    expect(result.score).toBe(100);
    expect(result.matchedPullNumber).toBe(42);
    expect(result.wouldAct).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.publicText).toContain("#42");
  });

  it("includes a recently-merged candidate only when it shares at least one changed-file path with the current PR", async () => {
    const env = createTestEnv();
    const sourceLines = "+function add(a, b) {\n+const total = a + b;\n+logger.debug(total);\n+return total;\n+}\n+export default add;";
    // Overlapping path (src/math.ts) -- eligible for comparison, high containment.
    await upsertRecentMergedPullRequest(env, recentMerged(7, "2026-06-01T00:00:00Z", ["src/math.ts"]));
    await upsertPullRequestFile(env, file(7, "src/math.ts", sourceLines));
    // Non-overlapping path (src/unrelated.ts) -- must be excluded from comparison by the path pre-filter even
    // though its content would ALSO score 100% containment if compared (proves the pre-filter, not just luck).
    await upsertRecentMergedPullRequest(env, recentMerged(8, "2026-06-01T00:00:00Z", ["src/unrelated.ts"]));
    await upsertPullRequestFile(env, file(8, "src/unrelated.ts", sourceLines));

    const result = await runCopycatAssessment(env, {
      repoFullName: REPO,
      pr: { number: 100, createdAt: "2026-06-05T00:00:00Z" },
      files: [file(100, "src/math.ts", sourceLines)],
      otherOpenPullRequests: [],
      mode: "block",
      minScore: null,
    });
    expect(result.matchedPullNumber).toBe(7);
    expect(result.matches.map((m) => m.pullNumber)).toEqual([7]);
  });

  it("never acts when the only candidate is the earlier (victim) submission's own later, independent PR — direction excludes it", async () => {
    const env = createTestEnv();
    const sourceLines = "+function add(a, b) {\n+const total = a + b;\n+logger.debug(total);\n+return total;\n+}\n+export default add;";
    await upsertPullRequestFile(env, file(42, "src/math.ts", sourceLines));

    const result = await runCopycatAssessment(env, {
      repoFullName: REPO,
      pr: { number: 100, createdAt: "2026-06-01T00:00:00Z" }, // earlier than the "sibling" below
      files: [file(100, "src/copy.ts", sourceLines)],
      otherOpenPullRequests: [openSibling(42, "2026-06-05T00:00:00Z")], // later
      mode: "block",
      minScore: null,
    });
    expect(result.wouldAct).toBe(false);
    expect(result.matchedPullNumber).toBeNull();
  });

  it("caps the number of open-sibling candidates fetched at MAX_COPYCAT_CANDIDATES, leaving no budget for recently-merged candidates", async () => {
    const env = createTestEnv();
    // A recently-merged candidate that WOULD match (overlapping path) if the budget reached it.
    const sourceLines = "+function add(a, b) {\n+const total = a + b;\n+logger.debug(total);\n+return total;\n+}\n+export default add;";
    await upsertRecentMergedPullRequest(env, recentMerged(9000, "2026-06-01T00:00:00Z", ["src/math.ts"]));
    await upsertPullRequestFile(env, file(9000, "src/math.ts", sourceLines));

    // MAX_COPYCAT_CANDIDATES open siblings, none seeded with files (listPullRequestFiles returns [] for an
    // unseeded PR — no error), so the cap is exercised without needing real content for every one of them.
    const manyOpenSiblings = Array.from({ length: MAX_COPYCAT_CANDIDATES }, (_, i) => openSibling(i + 1, "2026-06-01T00:00:00Z"));

    const result = await runCopycatAssessment(env, {
      repoFullName: REPO,
      pr: { number: 100, createdAt: "2026-06-05T00:00:00Z" },
      files: [file(100, "src/math.ts", sourceLines)],
      otherOpenPullRequests: manyOpenSiblings,
      mode: "block",
      minScore: null,
    });
    // Exactly MAX_COPYCAT_CANDIDATES matches recorded (the open siblings), the recently-merged #9000 never reached.
    expect(result.matches).toHaveLength(MAX_COPYCAT_CANDIDATES);
    expect(result.matches.some((m) => m.pullNumber === 9000)).toBe(false);
  });

  it("degrades a failed per-candidate file fetch to empty lines (fail-safe) instead of throwing", async () => {
    const env = createTestEnv();
    vi.spyOn(repositoriesModule, "listPullRequestFiles").mockRejectedValueOnce(new Error("D1 read error"));

    const result = await runCopycatAssessment(env, {
      repoFullName: REPO,
      pr: { number: 100, createdAt: "2026-06-05T00:00:00Z" },
      files: [file(100, "src/copy.ts", "+some content")],
      otherOpenPullRequests: [openSibling(42, "2026-06-01T00:00:00Z")],
      mode: "block",
      minScore: null,
    });
    expect(result.matches).toEqual([{ pullNumber: 42, score: 0, direction: "candidate_copied" }]);
    expect(result.wouldAct).toBe(false);
  });

  it("degrades a failed recently-merged lookup to an empty candidate list (fail-safe) instead of throwing", async () => {
    const env = createTestEnv();
    vi.spyOn(repositoriesModule, "listRecentMergedPullRequests").mockRejectedValueOnce(new Error("D1 read error"));

    const result = await runCopycatAssessment(env, {
      repoFullName: REPO,
      pr: { number: 100, createdAt: "2026-06-05T00:00:00Z" },
      files: [file(100, "src/copy.ts", "+some content")],
      otherOpenPullRequests: [],
      mode: "block",
      minScore: null,
    });
    expect(result.matches).toEqual([]);
    expect(result.wouldAct).toBe(false);
  });
});
