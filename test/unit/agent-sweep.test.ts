import { describe, expect, it } from "vitest";
import { SWEEP_FRESHNESS_MS, SWEEP_MAX_PRS, isRegateSweepDraining, selectRegateCandidates } from "../../src/settings/agent-sweep";
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
  describe("don't-race-webhook freshness guard (GitHub updatedAt)", () => {
    it("drops PRs whose GitHub updatedAt is within the freshness window (a webhook is gating them)", () => {
      const pulls = [pr({ number: 1, updatedAt: minutesAgo(1) }), pr({ number: 2, updatedAt: minutesAgo(120) })];
      const picked = selectRegateCandidates({ pulls, now: NOW });
      expect(picked.map((p) => p.number)).toEqual([2]); // #1 updated 1m ago is inside the 2-min window
    });

    it("treats a missing updatedAt as NOT recently touched (eligible, never starved by the freshness guard)", () => {
      const pulls = [pr({ number: 1, updatedAt: minutesAgo(1) }), pr({ number: 2 })];
      const picked = selectRegateCandidates({ pulls, now: NOW });
      expect(picked.map((p) => p.number)).toEqual([2]); // #1 fresh → dropped; #2 has no updatedAt → eligible
    });

    it("keeps a PR whose lastRegatedAt is old but whose updatedAt is fresh OUT (the guard wins over the sort key)", () => {
      const pulls = [pr({ number: 1, updatedAt: minutesAgo(1), lastRegatedAt: minutesAgo(999) })];
      const picked = selectRegateCandidates({ pulls, now: NOW });
      expect(picked.map((p) => p.number)).toEqual([]); // stalest by re-gate, but a webhook just touched it → skip
    });

    it("live case: when updatedAt and lastRegatedAt move together, the PR is eligible once outside the window (not double-excluded)", () => {
      const pulls = [pr({ number: 1, updatedAt: minutesAgo(120), lastRegatedAt: minutesAgo(120) })];
      const picked = selectRegateCandidates({ pulls, now: NOW });
      expect(picked.map((p) => p.number)).toEqual([1]); // both old → freshness allows it, re-gate orders it
    });

    it("keeps every open non-draft PR when `now` is unparseable (no freshness cutoff possible)", () => {
      const pulls = [pr({ number: 1, createdAt: minutesAgo(5) }), pr({ number: 2, createdAt: minutesAgo(600) }), pr({ number: 3, isDraft: true })];
      const picked = selectRegateCandidates({ pulls, now: "not-a-date", freshnessWindowMs: 30 * 60 * 1000 });
      expect(picked.map((p) => p.number)).toEqual([2, 1]); // drafts still excluded; both non-draft kept, stalest-created first
    });
  });

  describe("convergence sort key (lastRegatedAt, NOT GitHub updatedAt)", () => {
    it("INVARIANT arm (i): orders by lastRegatedAt ascending when present — the staler RE-GATE sorts first", () => {
      // #1 was re-gated recently but created long ago; #2 was re-gated long ago but created recently. The re-gate
      // marker — not createdAt — drives the order, so #2 (stalest re-gate) comes first.
      const pulls = [
        pr({ number: 1, lastRegatedAt: minutesAgo(10), createdAt: minutesAgo(1000) }),
        pr({ number: 2, lastRegatedAt: minutesAgo(100), createdAt: minutesAgo(1) }),
      ];
      const picked = selectRegateCandidates({ pulls, now: NOW });
      expect(picked.map((p) => p.number)).toEqual([2, 1]);
    });

    it("INVARIANT arm (ii): falls back to createdAt when lastRegatedAt is absent — oldest-created sorts first", () => {
      const pulls = [pr({ number: 1, createdAt: minutesAgo(10) }), pr({ number: 2, createdAt: minutesAgo(600) })];
      const picked = selectRegateCandidates({ pulls, now: NOW });
      expect(picked.map((p) => p.number)).toEqual([2, 1]); // no lastRegatedAt on either → createdAt orders them
    });

    it("INVARIANT arm (iii): falls back to the epoch when both lastRegatedAt and createdAt are absent — tie broken by PR number", () => {
      const pulls = [pr({ number: 9 }), pr({ number: 4 }), pr({ number: 7 })];
      const picked = selectRegateCandidates({ pulls, now: NOW });
      expect(picked.map((p) => p.number)).toEqual([4, 7, 9]); // all epoch → deterministic number order
    });

    it("a never-regated PR (lastRegatedAt absent) outranks a just-regated one — the property that makes the sweep converge", () => {
      const pulls = [
        pr({ number: 1, lastRegatedAt: minutesAgo(1), createdAt: minutesAgo(1000) }), // just re-gated → freshest
        pr({ number: 2, createdAt: minutesAgo(50) }), // never re-gated → its createdAt (50m) is staler than #1's re-gate (1m)
      ];
      const picked = selectRegateCandidates({ pulls, now: NOW });
      expect(picked.map((p) => p.number)).toEqual([2, 1]);
    });

    it("bounds the batch to max (rate-aware) after ordering by re-gate staleness", () => {
      const pulls = [
        pr({ number: 1, lastRegatedAt: minutesAgo(120) }),
        pr({ number: 2, lastRegatedAt: minutesAgo(600) }),
        pr({ number: 3, lastRegatedAt: minutesAgo(300) }),
      ];
      const picked = selectRegateCandidates({ pulls, now: NOW, max: 2 });
      expect(picked.map((p) => p.number)).toEqual([2, 3]); // stalest re-gate (600m), then 300m; 120m dropped by cap
    });

    it("REGRESSION (repair priority): missing public surfaces are selected before ordinary stale PRs", () => {
      const pulls = [
        pr({ number: 1, lastRegatedAt: minutesAgo(900) }),
        pr({ number: 2, lastRegatedAt: minutesAgo(10) }),
        pr({ number: 3, lastRegatedAt: minutesAgo(800) }),
      ];
      const picked = selectRegateCandidates({
        pulls,
        now: NOW,
        max: 2,
        priorityPullNumbers: new Set([2]),
      });
      expect(picked.map((p) => p.number)).toEqual([2, 1]);
    });

    it("REGRESSION (repair priority): priority repairs can bypass webhook freshness when the current Gate check is missing", () => {
      const pulls = [
        pr({ number: 1, updatedAt: minutesAgo(1), lastRegatedAt: minutesAgo(900) }),
        pr({ number: 2, updatedAt: minutesAgo(120), lastRegatedAt: minutesAgo(800) }),
      ];
      const picked = selectRegateCandidates({
        pulls,
        now: NOW,
        max: 2,
        priorityPullNumbers: new Set([1]),
        priorityBypassesFreshness: true,
      });
      expect(picked.map((p) => p.number)).toEqual([1, 2]);
    });
  });

  it("excludes drafts and non-open PRs", () => {
    const pulls = [
      pr({ number: 1, createdAt: minutesAgo(120), isDraft: true }),
      pr({ number: 2, createdAt: minutesAgo(120), state: "closed" }),
      pr({ number: 3, createdAt: minutesAgo(120) }),
    ];
    const picked = selectRegateCandidates({ pulls, now: NOW });
    expect(picked.map((p) => p.number)).toEqual([3]);
  });

  it("REGRESSION (convergence): ceil(open/cap) sweeps with all GitHub writes suppressed cover ALL open PRs, none re-selected before the rest are stamped", () => {
    // Simulate the dry-run / paused world: a re-gate stamps lastRegatedAt (a D1 write, never suppressed) but the
    // GitHub updatedAt is frozen. Without the fix the same `cap` stalest would recur every sweep forever; with it,
    // ceil(open/cap) sweeps cover all distinct PRs exactly once — full coverage in ceil(open/max) sweeps. Sized off
    // the live cap so it stays correct as SWEEP_MAX_PRS is tuned for the REST budget (#audit-rate-headroom).
    const open = SWEEP_MAX_PRS * 2; // exactly two full sweeps' worth of stale open PRs
    const sweepsNeeded = Math.ceil(open / SWEEP_MAX_PRS);
    const pulls = Array.from({ length: open }, (_, i) => pr({ number: i + 1, createdAt: minutesAgo(1000 - i), updatedAt: minutesAgo(1000) }));
    const stampedAt = new Map<number, string>();
    const covered = new Set<number>();
    let sweepNow = nowMs;
    for (let sweep = 0; sweep < sweepsNeeded; sweep++) {
      sweepNow += 5 * 60 * 1000; // each sweep runs ~5 min later (outside the freshness window)
      const now = new Date(sweepNow).toISOString();
      const view = pulls.map((p) => ({ ...p, lastRegatedAt: stampedAt.get(p.number) ?? p.lastRegatedAt }));
      const picked = selectRegateCandidates({ pulls: view, now });
      expect(picked.length).toBe(SWEEP_MAX_PRS); // each sweep fills the cap until the queue is drained
      for (const p of picked) {
        expect(covered.has(p.number)).toBe(false); // never re-selected before all are stamped
        covered.add(p.number);
        stampedAt.set(p.number, now); // the sweep stamps lastRegatedAt = now
      }
    }
    expect(covered.size).toBe(open); // full coverage of every open PR
  });

  it("defaults: freshness window is two minutes and the cap is bounded for the shared REST budget (#audit-rate-headroom)", () => {
    expect(SWEEP_FRESHNESS_MS).toBe(2 * 60 * 1000);
    expect(SWEEP_MAX_PRS).toBe(3); // 3 × 3 repos × 9 GETs × 30 ticks/hr ≈ 2.4k/hr, leaving headroom for webhooks
    const pulls = Array.from({ length: 40 }, (_, i) => pr({ number: i + 1, createdAt: minutesAgo(120 + i) }));
    expect(selectRegateCandidates({ pulls, now: NOW })).toHaveLength(SWEEP_MAX_PRS);
  });
});

describe("isRegateSweepDraining (#audit-sweep-fanout in-flight guard)", () => {
  it("returns false when no PR has ever been regated (null/undefined marker → no sweep in flight)", () => {
    expect(isRegateSweepDraining(null, NOW)).toBe(false);
    expect(isRegateSweepDraining(undefined, NOW)).toBe(false);
  });

  it("returns true when the freshest regate is within the window (a sweep is actively draining)", () => {
    expect(isRegateSweepDraining(minutesAgo(1), NOW)).toBe(true); // 1m ago < 2m window
  });

  it("returns false when the freshest regate is older than the window (prior sweep already drained)", () => {
    expect(isRegateSweepDraining(minutesAgo(5), NOW)).toBe(false); // 5m ago > 2m window
  });

  it("returns false for an unparseable timestamp or unparseable now (fail-open: proceed)", () => {
    expect(isRegateSweepDraining("not-a-date", NOW)).toBe(false);
    expect(isRegateSweepDraining(minutesAgo(1), "not-a-date")).toBe(false);
  });
});
