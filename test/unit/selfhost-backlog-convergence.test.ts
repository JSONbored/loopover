import { describe, expect, it } from "vitest";
import {
  BACKLOG_CONVERGENCE_SWEEP_MAX_PRS,
  needsSurfaceConvergence,
  selectBacklogConvergenceCandidates,
} from "../../src/selfhost/backlog-convergence";
import type { PullRequestRecord } from "../../src/types";

const NOW = "2026-06-17T12:00:00.000Z";
const nowMs = Date.parse(NOW);
const minutesAgo = (m: number): string => new Date(nowMs - m * 60 * 1000).toISOString();

function pr(overrides: Partial<PullRequestRecord> & { number: number }): PullRequestRecord {
  return {
    repoFullName: "owner/repo",
    title: `PR ${overrides.number}`,
    state: "open",
    labels: [],
    linkedIssues: [],
    ...overrides,
  };
}

describe("needsSurfaceConvergence (#selfhost-backlog-convergence)", () => {
  it("is false when the PR has no known headSha (nothing to compare against)", () => {
    expect(needsSurfaceConvergence({ headSha: null, lastPublishedSurfaceSha: null })).toBe(false);
    expect(needsSurfaceConvergence({ headSha: undefined, lastPublishedSurfaceSha: "abc" })).toBe(false);
  });

  it("is true when the surface has never been published at all", () => {
    expect(needsSurfaceConvergence({ headSha: "abc123", lastPublishedSurfaceSha: null })).toBe(true);
    expect(needsSurfaceConvergence({ headSha: "abc123", lastPublishedSurfaceSha: undefined })).toBe(true);
  });

  it("is true when the last published surface is for an OLDER head (stale)", () => {
    expect(needsSurfaceConvergence({ headSha: "def456", lastPublishedSurfaceSha: "abc123" })).toBe(true);
  });

  it("is false when the last published surface matches the current head", () => {
    expect(needsSurfaceConvergence({ headSha: "abc123", lastPublishedSurfaceSha: "abc123" })).toBe(false);
  });
});

describe("selectBacklogConvergenceCandidates (#selfhost-backlog-convergence)", () => {
  it("drops closed PRs and drafts", () => {
    const pulls = [
      pr({ number: 1, state: "closed", headSha: "a", lastPublishedSurfaceSha: null }),
      pr({ number: 2, isDraft: true, headSha: "a", lastPublishedSurfaceSha: null }),
      pr({ number: 3, headSha: "a", lastPublishedSurfaceSha: null }),
    ];
    const picked = selectBacklogConvergenceCandidates({ pulls });
    expect(picked.map((p) => p.number)).toEqual([3]);
  });

  it("drops PRs whose surface is already published at the current head", () => {
    const pulls = [
      pr({ number: 1, headSha: "a", lastPublishedSurfaceSha: "a" }),
      pr({ number: 2, headSha: "b", lastPublishedSurfaceSha: "stale" }),
    ];
    const picked = selectBacklogConvergenceCandidates({ pulls });
    expect(picked.map((p) => p.number)).toEqual([2]);
  });

  it("orders oldest createdAt first — the backlog-drain fairness ordering", () => {
    const pulls = [
      pr({ number: 1, headSha: "a", lastPublishedSurfaceSha: null, createdAt: minutesAgo(10) }),
      pr({ number: 2, headSha: "a", lastPublishedSurfaceSha: null, createdAt: minutesAgo(1000) }),
      pr({ number: 3, headSha: "a", lastPublishedSurfaceSha: null, createdAt: minutesAgo(100) }),
    ];
    const picked = selectBacklogConvergenceCandidates({ pulls });
    expect(picked.map((p) => p.number)).toEqual([2, 3, 1]);
  });

  it("falls back to the epoch (sorts first) when createdAt is missing or unparseable", () => {
    const pulls = [
      pr({ number: 1, headSha: "a", lastPublishedSurfaceSha: null, createdAt: minutesAgo(5) }),
      pr({ number: 2, headSha: "a", lastPublishedSurfaceSha: null }),
      pr({ number: 3, headSha: "a", lastPublishedSurfaceSha: null, createdAt: "not-a-date" }),
    ];
    const picked = selectBacklogConvergenceCandidates({ pulls });
    // #2 and #3 both fall back to epoch (0) — tie broken by PR number ascending — then #1's real timestamp last.
    expect(picked.map((p) => p.number)).toEqual([2, 3, 1]);
  });

  it("breaks ties by PR number when createdAt is identical", () => {
    const pulls = [
      pr({ number: 5, headSha: "a", lastPublishedSurfaceSha: null, createdAt: minutesAgo(10) }),
      pr({ number: 2, headSha: "a", lastPublishedSurfaceSha: null, createdAt: minutesAgo(10) }),
    ];
    const picked = selectBacklogConvergenceCandidates({ pulls });
    expect(picked.map((p) => p.number)).toEqual([2, 5]);
  });

  it("bounds the result to the default max", () => {
    expect(BACKLOG_CONVERGENCE_SWEEP_MAX_PRS).toBeGreaterThan(0);
    const pulls = Array.from({ length: BACKLOG_CONVERGENCE_SWEEP_MAX_PRS + 3 }, (_, i) =>
      pr({ number: i + 1, headSha: "a", lastPublishedSurfaceSha: null, createdAt: minutesAgo(i) }),
    );
    const picked = selectBacklogConvergenceCandidates({ pulls });
    expect(picked).toHaveLength(BACKLOG_CONVERGENCE_SWEEP_MAX_PRS);
  });

  it("respects a custom max", () => {
    const pulls = [
      pr({ number: 1, headSha: "a", lastPublishedSurfaceSha: null }),
      pr({ number: 2, headSha: "a", lastPublishedSurfaceSha: null }),
    ];
    const picked = selectBacklogConvergenceCandidates({ pulls, max: 1 });
    expect(picked).toHaveLength(1);
  });

  it("clamps a negative max to zero rather than throwing or wrapping", () => {
    const pulls = [pr({ number: 1, headSha: "a", lastPublishedSurfaceSha: null })];
    const picked = selectBacklogConvergenceCandidates({ pulls, max: -5 });
    expect(picked).toEqual([]);
  });

  it("returns an empty array when nothing needs convergence", () => {
    const pulls = [pr({ number: 1, headSha: "a", lastPublishedSurfaceSha: "a" })];
    expect(selectBacklogConvergenceCandidates({ pulls })).toEqual([]);
  });
});
