import { describe, expect, it } from "vitest";
import { SWEEP_FRESHNESS_MS, SWEEP_MAX_PRS, selectRegateCandidates } from "../../src/settings/agent-sweep";
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

describe("selectRegateCandidates (#777 re-gate sweep selection)", () => {
  it("drops PRs updated within the freshness window (recently gated by their webhook)", () => {
    const pulls = [pr({ number: 1, updatedAt: minutesAgo(1) }), pr({ number: 2, updatedAt: minutesAgo(120) })];
    const picked = selectRegateCandidates({ pulls, now: NOW });
    expect(picked.map((p) => p.number)).toEqual([2]); // #1 updated 1m ago is inside the 2-min freshness window
  });

  it("orders the stalest first and bounds to max (rate-aware)", () => {
    const pulls = [
      pr({ number: 1, updatedAt: minutesAgo(120) }),
      pr({ number: 2, updatedAt: minutesAgo(600) }),
      pr({ number: 3, updatedAt: minutesAgo(300) }),
    ];
    const picked = selectRegateCandidates({ pulls, now: NOW, max: 2 });
    expect(picked.map((p) => p.number)).toEqual([2, 3]); // stalest (600m), then 300m; 120m dropped by cap
  });

  it("treats a missing updatedAt as maximally stale and never starves it", () => {
    const pulls = [pr({ number: 1, updatedAt: minutesAgo(120) }), pr({ number: 2 })];
    const picked = selectRegateCandidates({ pulls, now: NOW });
    expect(picked.map((p) => p.number)).toEqual([2, 1]); // no-timestamp PR sorts oldest
  });

  it("excludes drafts and non-open PRs", () => {
    const pulls = [
      pr({ number: 1, updatedAt: minutesAgo(120), isDraft: true }),
      pr({ number: 2, updatedAt: minutesAgo(120), state: "closed" }),
      pr({ number: 3, updatedAt: minutesAgo(120) }),
    ];
    const picked = selectRegateCandidates({ pulls, now: NOW });
    expect(picked.map((p) => p.number)).toEqual([3]);
  });

  it("is deterministic: equal staleness breaks ties by PR number", () => {
    const ts = minutesAgo(200);
    const pulls = [pr({ number: 9, updatedAt: ts }), pr({ number: 4, updatedAt: ts }), pr({ number: 7, updatedAt: ts })];
    const picked = selectRegateCandidates({ pulls, now: NOW });
    expect(picked.map((p) => p.number)).toEqual([4, 7, 9]);
  });

  it("keeps every open non-draft PR when `now` is unparseable (no freshness cutoff possible)", () => {
    const pulls = [pr({ number: 1, updatedAt: minutesAgo(5) }), pr({ number: 2, updatedAt: minutesAgo(600) }), pr({ number: 3, isDraft: true })];
    const picked = selectRegateCandidates({ pulls, now: "not-a-date", freshnessWindowMs: 30 * 60 * 1000 });
    expect(picked.map((p) => p.number)).toEqual([2, 1]); // drafts still excluded; both non-draft kept, stalest first
  });

  it("defaults: freshness window is two minutes and the cap is 25", () => {
    expect(SWEEP_FRESHNESS_MS).toBe(2 * 60 * 1000);
    expect(SWEEP_MAX_PRS).toBe(25);
    const pulls = Array.from({ length: 40 }, (_, i) => pr({ number: i + 1, updatedAt: minutesAgo(120 + i) }));
    expect(selectRegateCandidates({ pulls, now: NOW })).toHaveLength(25);
  });
});
