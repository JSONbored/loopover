import { describe, expect, it } from "vitest";
import {
  SWEEP_FRESHNESS_MS,
  SWEEP_MAX_PRS,
  isRegateSweepDraining,
  selectRegateCandidates,
} from "../../src/settings/agent-sweep";
import type { PullRequestRecord } from "../../src/types";

const NOW = "2026-06-17T12:00:00.000Z";
const nowMs = Date.parse(NOW);
const minutesAgo = (m: number): string =>
  new Date(nowMs - m * 60 * 1000).toISOString();

function pr(
  overrides: Partial<PullRequestRecord> & { number: number },
): PullRequestRecord {
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
      const pulls = [
        pr({ number: 1, updatedAt: minutesAgo(1) }),
        pr({ number: 2, updatedAt: minutesAgo(120) }),
      ];
      const picked = selectRegateCandidates({ pulls, now: NOW });
      expect(picked.map((p) => p.number)).toEqual([2]); // #1 updated 1m ago is inside the 2-min window
    });

    it("treats a missing updatedAt as NOT recently touched (eligible, never starved by the freshness guard)", () => {
      const pulls = [
        pr({ number: 1, updatedAt: minutesAgo(1) }),
        pr({ number: 2 }),
      ];
      const picked = selectRegateCandidates({ pulls, now: NOW });
      expect(picked.map((p) => p.number)).toEqual([2]); // #1 fresh → dropped; #2 has no updatedAt → eligible
    });

    it("keeps a PR whose lastRegatedAt is old but whose updatedAt is fresh OUT (the guard wins over the sort key)", () => {
      const pulls = [
        pr({
          number: 1,
          updatedAt: minutesAgo(1),
          lastRegatedAt: minutesAgo(999),
        }),
      ];
      const picked = selectRegateCandidates({ pulls, now: NOW });
      expect(picked.map((p) => p.number)).toEqual([]); // stalest by re-gate, but a webhook just touched it → skip
    });

    it("a never-regated PR is eligible once its updatedAt is outside the freshness window (not blocked by the guard alone)", () => {
      const pulls = [pr({ number: 1, updatedAt: minutesAgo(120) })];
      const picked = selectRegateCandidates({ pulls, now: NOW });
      expect(picked.map((p) => p.number)).toEqual([1]); // old updatedAt, never regated → eligible
    });

    it("one-shot review (#never-endless-reregate): a PR already regated even once is excluded regardless of how old both timestamps are", () => {
      const pulls = [
        pr({
          number: 1,
          updatedAt: minutesAgo(120),
          lastRegatedAt: minutesAgo(120),
        }),
      ];
      const picked = selectRegateCandidates({ pulls, now: NOW });
      expect(picked.map((p) => p.number)).toEqual([]); // already regated once → never re-selected by the sweep
    });

    it("keeps every open non-draft PR when `now` is unparseable (no freshness cutoff possible)", () => {
      const pulls = [
        pr({ number: 1, createdAt: minutesAgo(5) }),
        pr({ number: 2, createdAt: minutesAgo(600) }),
        pr({ number: 3, isDraft: true }),
      ];
      const picked = selectRegateCandidates({
        pulls,
        now: "not-a-date",
        freshnessWindowMs: 30 * 60 * 1000,
      });
      expect(picked.map((p) => p.number)).toEqual([2, 1]); // drafts still excluded; both non-draft kept, stalest-created first
    });
  });

  describe("convergence sort key (lastRegatedAt, NOT GitHub updatedAt)", () => {
    it("INVARIANT arm (i): orders by lastRegatedAt ascending when present — the staler RE-GATE sorts first (among repair-eligible candidates; a plain already-regated PR is otherwise excluded, see #never-endless-reregate)", () => {
      // Both PRs already have a regate stamp, so both need repairPriority to remain eligible at all post-#never-
      // endless-reregate. #1 was re-gated recently but created long ago; #2 was re-gated long ago but created
      // recently. The re-gate marker — not createdAt — drives the order, so #2 (stalest re-gate) comes first.
      const pulls = [
        pr({
          number: 1,
          lastRegatedAt: minutesAgo(10),
          createdAt: minutesAgo(1000),
        }),
        pr({
          number: 2,
          lastRegatedAt: minutesAgo(100),
          createdAt: minutesAgo(1),
        }),
      ];
      const picked = selectRegateCandidates({
        pulls,
        now: NOW,
        priorityPullNumbers: new Set([1, 2]),
      });
      expect(picked.map((p) => p.number)).toEqual([2, 1]);
    });

    it("INVARIANT arm (ii): falls back to createdAt when lastRegatedAt is absent — oldest-created sorts first", () => {
      const pulls = [
        pr({ number: 1, createdAt: minutesAgo(10) }),
        pr({ number: 2, createdAt: minutesAgo(600) }),
      ];
      const picked = selectRegateCandidates({ pulls, now: NOW });
      expect(picked.map((p) => p.number)).toEqual([2, 1]); // no lastRegatedAt on either → createdAt orders them
    });

    it("INVARIANT arm (iii): falls back to the epoch when both lastRegatedAt and createdAt are absent — tie broken by PR number", () => {
      const pulls = [pr({ number: 9 }), pr({ number: 4 }), pr({ number: 7 })];
      const picked = selectRegateCandidates({ pulls, now: NOW });
      expect(picked.map((p) => p.number)).toEqual([4, 7, 9]); // all epoch → deterministic number order
    });

    it("one-shot review (#never-endless-reregate): a just-regated PR is excluded outright, never merely outranked — only the never-regated PR remains", () => {
      const pulls = [
        pr({
          number: 1,
          lastRegatedAt: minutesAgo(1),
          createdAt: minutesAgo(1000),
        }), // already regated once → permanently ineligible for the sweep, regardless of staleness
        pr({ number: 2, createdAt: minutesAgo(50) }), // never regated → the only real candidate
      ];
      const picked = selectRegateCandidates({ pulls, now: NOW });
      expect(picked.map((p) => p.number)).toEqual([2]);
    });

    it("bounds the batch to max (rate-aware) after ordering by re-gate staleness among repair-eligible candidates", () => {
      const pulls = [
        pr({ number: 1, lastRegatedAt: minutesAgo(120) }),
        pr({ number: 2, lastRegatedAt: minutesAgo(600) }),
        pr({ number: 3, lastRegatedAt: minutesAgo(300) }),
      ];
      const picked = selectRegateCandidates({
        pulls,
        now: NOW,
        max: 2,
        priorityPullNumbers: new Set([1, 2, 3]),
      });
      expect(picked.map((p) => p.number)).toEqual([2, 3]); // stalest re-gate (600m), then 300m; 120m dropped by cap
    });

    it("one-shot review (#never-endless-reregate): bounds the batch to max among never-regated candidates (the ordinary, non-repair case)", () => {
      const pulls = [
        pr({ number: 1, createdAt: minutesAgo(120) }),
        pr({ number: 2, createdAt: minutesAgo(600) }),
        pr({ number: 3, createdAt: minutesAgo(300) }),
      ];
      const picked = selectRegateCandidates({ pulls, now: NOW, max: 2 });
      expect(picked.map((p) => p.number)).toEqual([2, 3]); // none ever regated → falls back to createdAt; oldest-created first, 120m dropped by cap
    });

    it("#selfhost-fifo-ordering: a repair-flagged PR does NOT jump ahead of staler ordinary (never-regated) PRs — same orderKey for everyone", () => {
      // #1 and #3 have never been regated (the ordinary, post-#never-endless-reregate candidate shape). #2 has a
      // missing public surface (surfaceRepairPriorityPullNumbers would flag it) and already has its own regate
      // stamp from 10m ago — repair priority keeps it eligible despite that stamp, but its OWN regateProgress
      // (10m, very fresh) correctly sorts it LAST, not ahead of the staler ordinary backlog. An earlier revision
      // sorted repair candidates first regardless of staleness — this pinned repair work ahead of the ordinary
      // backlog and was observed live as PRs dispatching out of their creation/staleness order ("spraying")
      // whenever a repo had a mixed repair/ordinary backlog. Repair status must only affect eligibility, never order.
      const pulls = [
        pr({ number: 1, createdAt: minutesAgo(900) }),
        pr({ number: 2, lastRegatedAt: minutesAgo(10) }),
        pr({ number: 3, createdAt: minutesAgo(800) }),
      ];
      const picked = selectRegateCandidates({
        pulls,
        now: NOW,
        max: 2,
        priorityPullNumbers: new Set([2]),
      });
      expect(picked.map((p) => p.number)).toEqual([1, 3]); // oldest ordinary candidates first; repair-flagged #2 (freshly stamped) dropped by the cap
    });

    it("REGRESSION (repair priority): priority repairs can bypass webhook freshness when the current Gate check is missing", () => {
      const pulls = [
        pr({
          number: 1,
          updatedAt: minutesAgo(1),
          lastRegatedAt: minutesAgo(900),
        }),
        pr({
          number: 2,
          updatedAt: minutesAgo(120), // outside the freshness window on its own
          createdAt: minutesAgo(50), // more recent than #1's 900m regate stamp, so it still sorts after #1
          // never regated (the ordinary, post-#never-endless-reregate candidate shape) — #1's own regate
          // stamp above only stays eligible because of the repair-priority bypass being tested here.
        }),
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
    const pulls = Array.from({ length: open }, (_, i) =>
      pr({
        number: i + 1,
        createdAt: minutesAgo(1000 - i),
        updatedAt: minutesAgo(1000),
      }),
    );
    const stampedAt = new Map<number, string>();
    const covered = new Set<number>();
    let sweepNow = nowMs;
    for (let sweep = 0; sweep < sweepsNeeded; sweep++) {
      sweepNow += 5 * 60 * 1000; // each sweep runs ~5 min later (outside the freshness window)
      const now = new Date(sweepNow).toISOString();
      const view = pulls.map((p) => ({
        ...p,
        lastRegatedAt: stampedAt.get(p.number) ?? p.lastRegatedAt,
      }));
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
    const pulls = Array.from({ length: 40 }, (_, i) =>
      pr({ number: i + 1, createdAt: minutesAgo(120 + i) }),
    );
    expect(selectRegateCandidates({ pulls, now: NOW })).toHaveLength(
      SWEEP_MAX_PRS,
    );
  });

  it("INVARIANT (#never-endless-reregate, incident 2026-07-09): once regated (and not repair-priority), a PR never reappears on any later sweep, across every order mode -- the exact property the endless-reregate-sweep incident broke", () => {
    // A deliberately mixed, randomized-shape backlog: some PRs already regated (at varying ages), some never
    // regated, a handful flagged repair-priority (the ONLY sanctioned bypass). Every PR's GitHub updatedAt is
    // pinned far outside the freshness window so the freshness guard never masks this property. Simulates a
    // real multi-sweep drain (mirroring the "REGRESSION (convergence)" test above): each sweep's picks get
    // stamped with lastRegatedAt = now and feed into the next sweep, so the invariant is checked against
    // genuinely evolving state, not a single static snapshot.
    const TOTAL = 30;
    const repairPullNumbers = new Set([5, 17, 23]);
    const basePulls = Array.from({ length: TOTAL }, (_, i) => {
      const number = i + 1;
      const alreadyRegated = number % 3 !== 0 && !repairPullNumbers.has(number);
      return pr({
        number,
        createdAt: minutesAgo(2000 - number),
        updatedAt: minutesAgo(1000), // always stale relative to the freshness window
        ...(alreadyRegated ? { lastRegatedAt: minutesAgo(500 + (number % 400)) } : {}),
      });
    });
    const alreadyRegatedNonRepair = new Set(
      basePulls.filter((p) => Boolean(p.lastRegatedAt)).map((p) => p.number),
    );
    for (const orderMode of ["staleness", "oldest-first"] as const) {
      const stampedAt = new Map<number, string>();
      let sweepNow = nowMs;
      for (let sweep = 0; sweep < 8; sweep++) {
        sweepNow += 10 * 60 * 1000;
        const now = new Date(sweepNow).toISOString();
        const view = basePulls.map((p) => ({
          ...p,
          lastRegatedAt: stampedAt.get(p.number) ?? p.lastRegatedAt,
        }));
        const picked = selectRegateCandidates({
          pulls: view,
          now,
          orderMode,
          priorityPullNumbers: repairPullNumbers,
        });
        for (const p of picked) {
          expect(
            alreadyRegatedNonRepair.has(p.number),
            `orderMode=${orderMode} sweep=${sweep}: PR #${p.number} was already regated pre-test and is not repair-priority, yet was re-selected`,
          ).toBe(false);
          // A repair-priority PR CAN legitimately be picked more than once (its bypass is deliberate); any
          // other PR picked on THIS sweep must not already carry a stamp from an earlier sweep in this run.
          if (!repairPullNumbers.has(p.number)) {
            expect(stampedAt.has(p.number)).toBe(false);
          }
          stampedAt.set(p.number, now);
        }
      }
    }
  });

  describe("orderMode: oldest-first (#3815)", () => {
    it("orders by createdAt ascending when neither PR has ever been regated", () => {
      const pulls = [
        pr({ number: 1, createdAt: minutesAgo(1000) }),
        pr({ number: 2, createdAt: minutesAgo(1) }),
      ];
      const picked = selectRegateCandidates({
        pulls,
        now: NOW,
        orderMode: "oldest-first",
      });
      expect(picked.map((p) => p.number)).toEqual([1, 2]); // #1 (oldest-created) first, unlike staleness (which has no history here either, so both modes agree in this case)
    });

    it("orders by re-gate staleness among repair-eligible candidates once every one of them has a stamp (an ordinary already-regated PR stays excluded, see #never-endless-reregate)", () => {
      // Both PRs already have a regate stamp, so both need repairPriority to remain eligible at all. #1 was
      // re-gated most recently (10m ago) despite being the OLDEST-created PR by far; #2 was re-gated longer ago
      // (100m) despite being the NEWEST-created. Once every eligible (repair) PR has a lastRegatedAt stamp,
      // oldest-first uses re-gate staleness so ongoing sweeps keep converging instead of pinning old PRs.
      const pulls = [
        pr({
          number: 1,
          lastRegatedAt: minutesAgo(10),
          createdAt: minutesAgo(1000),
        }),
        pr({
          number: 2,
          lastRegatedAt: minutesAgo(100),
          createdAt: minutesAgo(1),
        }),
      ];
      const picked = selectRegateCandidates({
        pulls,
        now: NOW,
        orderMode: "oldest-first",
        priorityPullNumbers: new Set([1, 2]),
      });
      expect(picked.map((p) => p.number)).toEqual([2, 1]);
    });

    it("does not starve the sweep when EVERY repair-eligible PR ties on the same lastRegatedAt (a fully-covered small backlog)", () => {
      // Both PRs were dispatched together in the exact same prior sweep (identical lastRegatedAt stamp — see
      // markPullRequestsRegated, which stamps every candidate in one UPDATE) and need repairPriority to remain
      // eligible post-#never-endless-reregate. Since the initial drain is complete, oldest-first falls back to
      // the full (repair) pool rather than returning nothing.
      const pulls = [
        pr({
          number: 1,
          createdAt: minutesAgo(1000),
          lastRegatedAt: minutesAgo(10),
        }),
        pr({
          number: 2,
          createdAt: minutesAgo(500),
          lastRegatedAt: minutesAgo(10),
        }),
      ];
      const picked = selectRegateCandidates({
        pulls,
        now: NOW,
        orderMode: "oldest-first",
        priorityPullNumbers: new Set([1, 2]),
      });
      expect(picked.map((p) => p.number)).toEqual([1, 2]); // both tie → guard proceeds with the full pool, oldest first
    });

    it("falls back to the epoch (sorts as oldest) when createdAt is absent, tie broken by PR number", () => {
      const pulls = [
        pr({ number: 9, createdAt: minutesAgo(5) }),
        pr({ number: 4 }),
        pr({ number: 7 }),
      ];
      const picked = selectRegateCandidates({
        pulls,
        now: NOW,
        orderMode: "oldest-first",
      });
      expect(picked.map((p) => p.number)).toEqual([4, 7, 9]); // #4 and #7 (no createdAt) tie at epoch, then #9
    });

    it("bounds the batch to max after ordering by creation time", () => {
      const pulls = [
        pr({ number: 1, createdAt: minutesAgo(120) }),
        pr({ number: 2, createdAt: minutesAgo(600) }),
        pr({ number: 3, createdAt: minutesAgo(300) }),
      ];
      const picked = selectRegateCandidates({
        pulls,
        now: NOW,
        orderMode: "oldest-first",
        max: 2,
      });
      expect(picked.map((p) => p.number)).toEqual([2, 3]); // oldest-created (600m), then 300m; 120m dropped by cap
    });

    it("#selfhost-fifo-ordering: a repair-flagged PR does NOT jump ahead of older oldest-first candidates", () => {
      // #1 is flagged as a repair (e.g. opened during an extended agent pause, so it never published anything)
      // but is by far the NEWEST-created of the three. It stays eligible (see the initial-drain test below) but
      // must not cut ahead of #2/#3, which were created long before it — creation order is the same for every
      // candidate regardless of repair status.
      const pulls = [
        pr({ number: 1, createdAt: minutesAgo(10) }),
        pr({ number: 2, createdAt: minutesAgo(900) }),
        pr({ number: 3, createdAt: minutesAgo(800) }),
      ];
      const picked = selectRegateCandidates({
        pulls,
        now: NOW,
        orderMode: "oldest-first",
        max: 2,
        priorityPullNumbers: new Set([1]),
      });
      expect(picked.map((p) => p.number)).toEqual([2, 3]); // oldest-created first, same as with no priority set at all; #1 (newest) dropped by the cap
    });

    it("REGRESSION (repair priority): a priority repair stays eligible during the oldest-first initial drain", () => {
      // #1 is a priority repair AND has already been regated, while #2 is still in the never-regated initial
      // drain. Priority work remains ELIGIBLE (not excluded by the initial-drain pool narrowing just because it
      // already has a regate stamp) — but, per #selfhost-fifo-ordering, it no longer preempts the ordinary
      // creation-order backlog: #2 is older-created than #1, so #2 still sorts first.
      const pulls = [
        pr({
          number: 1,
          createdAt: minutesAgo(10),
          lastRegatedAt: minutesAgo(1),
        }),
        pr({ number: 2, createdAt: minutesAgo(900) }),
      ];
      const picked = selectRegateCandidates({
        pulls,
        now: NOW,
        orderMode: "oldest-first",
        priorityPullNumbers: new Set([1]),
        priorityBypassesFreshness: true,
      });
      expect(picked.map((p) => p.number)).toEqual([2, 1]); // #1 (priority) included despite already having a regate stamp, but #2 (older-created) still sorts first
    });

    it("a just-regated PR is excluded while any never-regated PR remains, not re-selected forever by fixed createdAt", () => {
      // createdAt never changes, so without the initial-drain narrowing #1 (oldest-created) would recur every
      // sweep even after being dispatched. #2 has never been regated, so it becomes the sole ordinary candidate.
      const pulls = [
        pr({
          number: 1,
          createdAt: minutesAgo(1000),
          lastRegatedAt: minutesAgo(1),
        }),
        pr({ number: 2, createdAt: minutesAgo(500) }),
      ];
      const picked = selectRegateCandidates({
        pulls,
        now: NOW,
        orderMode: "oldest-first",
      });
      expect(picked.map((p) => p.number)).toEqual([2]); // #1 already regated → skipped; #2 is the next-oldest never-regated PR
    });

    it("REGRESSION (convergence): ceil(open/cap) sweeps with all GitHub writes suppressed cover ALL open PRs under oldest-first too", () => {
      // Mirrors the staleness-mode convergence test above: dry-run/paused world where GitHub updatedAt never
      // moves, AND sweeps are spaced 5 minutes apart — well past any fixed freshness window, proving this
      // does NOT rely on wall-clock timing. createdAt is fixed too (by construction), so convergence for
      // oldest-first depends on never-regated PRs staying ahead of already-regated PRs during the initial drain:
      // after each sweep, its dispatched PRs are stamped, so the next never-regated creation-order batch surfaces
      // — without that, backlogs larger than two batches loop over the oldest stamped batches forever.
      const open = SWEEP_MAX_PRS * 3;
      const sweepsNeeded = Math.ceil(open / SWEEP_MAX_PRS);
      const pulls = Array.from({ length: open }, (_, i) =>
        pr({
          number: i + 1,
          createdAt: minutesAgo(1000 - i),
          updatedAt: minutesAgo(1000),
        }),
      );
      const stampedAt = new Map<number, string>();
      const covered = new Set<number>();
      let sweepNow = nowMs;
      for (let sweep = 0; sweep < sweepsNeeded; sweep++) {
        sweepNow += 5 * 60 * 1000;
        const now = new Date(sweepNow).toISOString();
        const view = pulls.map((p) => ({
          ...p,
          lastRegatedAt: stampedAt.get(p.number) ?? p.lastRegatedAt,
        }));
        const picked = selectRegateCandidates({
          pulls: view,
          now,
          orderMode: "oldest-first",
        });
        expect(picked.length).toBe(SWEEP_MAX_PRS);
        for (const p of picked) {
          expect(covered.has(p.number)).toBe(false);
          covered.add(p.number);
          stampedAt.set(p.number, now);
        }
      }
      expect(covered.size).toBe(open);
    });

    it("falls back to re-gate staleness among repair-eligible candidates once every one of them has been swept once", () => {
      const pulls = [
        pr({
          number: 1,
          createdAt: minutesAgo(1000),
          lastRegatedAt: minutesAgo(5),
        }),
        pr({
          number: 2,
          createdAt: minutesAgo(900),
          lastRegatedAt: minutesAgo(500),
        }),
        pr({
          number: 3,
          createdAt: minutesAgo(800),
          lastRegatedAt: minutesAgo(50),
        }),
      ];
      const picked = selectRegateCandidates({
        pulls,
        now: NOW,
        orderMode: "oldest-first",
        priorityPullNumbers: new Set([1, 2, 3]),
      });
      expect(picked.map((p) => p.number)).toEqual([2, 3, 1]);
    });

    it("one-shot review (#never-endless-reregate): an ordinary (non-repair) already-regated PR is excluded outright under oldest-first too", () => {
      const pulls = [
        pr({ number: 1, createdAt: minutesAgo(1000), lastRegatedAt: minutesAgo(5) }),
        pr({ number: 2, createdAt: minutesAgo(900) }), // never regated → the only real candidate
      ];
      const picked = selectRegateCandidates({
        pulls,
        now: NOW,
        orderMode: "oldest-first",
      });
      expect(picked.map((p) => p.number)).toEqual([2]);
    });
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
