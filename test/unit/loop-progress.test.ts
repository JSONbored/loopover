import { describe, expect, it } from "vitest";
import {
  buildProgressSnapshot,
  progressChanged,
  MAX_PROGRESS_ACTIVITY,
  type LoopProgressActivity,
  type LoopProgressState,
} from "../../packages/loopover-engine/src/loop-progress";

function running(overrides: Partial<LoopProgressState> = {}): LoopProgressState {
  return { iteration: 2, maxIterations: 5, phase: "coding", status: "running", ...overrides };
}

describe("buildProgressSnapshot (#4800)", () => {
  it("builds a snapshot with percent-complete from the iteration budget", () => {
    const s = buildProgressSnapshot(running({ recentActivity: [{ step: "claimed" }, { step: "coding" }] }));
    expect(s).toMatchObject({ phase: "coding", status: "running", iteration: 2, maxIterations: 5, percentComplete: 40, done: false });
    expect(s.recentActivity).toHaveLength(2);
  });

  it("leaves percent-complete null when the iteration budget is unknown", () => {
    expect(buildProgressSnapshot(running({ maxIterations: undefined })).percentComplete).toBeNull();
    expect(buildProgressSnapshot(running({ maxIterations: null })).maxIterations).toBeNull();
    expect(buildProgressSnapshot(running({ maxIterations: 0 })).percentComplete).toBeNull(); // 0 is not > 0
  });

  it("caps percent-complete at 100 when iteration exceeds the budget", () => {
    expect(buildProgressSnapshot(running({ iteration: 7, maxIterations: 5 })).percentComplete).toBe(100);
  });

  it("defaults recent activity to empty and caps the tail at MAX_PROGRESS_ACTIVITY", () => {
    expect(buildProgressSnapshot(running()).recentActivity).toEqual([]); // omitted
    const many = Array.from({ length: MAX_PROGRESS_ACTIVITY + 4 }, (_, i) => ({ step: `s${i}` }));
    const s = buildProgressSnapshot(running({ recentActivity: many }));
    expect(s.recentActivity).toHaveLength(MAX_PROGRESS_ACTIVITY);
    expect(s.recentActivity.at(-1)?.step).toBe(`s${MAX_PROGRESS_ACTIVITY + 3}`); // newest kept
  });

  it("marks the loop done once its status is no longer running", () => {
    expect(buildProgressSnapshot(running({ status: "converged" })).done).toBe(true);
    expect(buildProgressSnapshot(running({ status: "running" })).done).toBe(false);
  });
});

describe("progressChanged — push on change, not on a fixed interval (#4800)", () => {
  const base = buildProgressSnapshot(running({ recentActivity: [{ step: "a" }] }));

  it("always pushes the first snapshot (no prior)", () => {
    expect(progressChanged(null, base)).toBe(true);
  });

  it("pushes when phase, status, iteration, or the activity tail changes", () => {
    expect(progressChanged(base, buildProgressSnapshot(running({ phase: "reviewing", recentActivity: [{ step: "a" }] })))).toBe(true);
    expect(progressChanged(base, buildProgressSnapshot(running({ status: "converged", recentActivity: [{ step: "a" }] })))).toBe(true);
    expect(progressChanged(base, buildProgressSnapshot(running({ iteration: 3, recentActivity: [{ step: "a" }] })))).toBe(true);
    expect(progressChanged(base, buildProgressSnapshot(running({ recentActivity: [{ step: "a" }, { step: "b" }] })))).toBe(true);
  });

  it("does not push when nothing displayed has changed", () => {
    expect(progressChanged(base, buildProgressSnapshot(running({ recentActivity: [{ step: "a" }] })))).toBe(false);
  });

  // #6171: the tail is capped, so past the cap every new event evicts the oldest and the LENGTH stops moving.
  // A length-only check went permanently blind here — exactly on the long runs that stream the most.
  describe("activity tail at its cap (#6171)", () => {
    const activity = (count: number): LoopProgressActivity[] =>
      Array.from({ length: count }, (_, i) => ({ step: `step-${i}`, at: `2026-07-16T00:${String(i).padStart(2, "0")}:00Z` }));

    it("REGRESSION: still pushes for a new activity once the tail is full", () => {
      const full = buildProgressSnapshot(running({ recentActivity: activity(MAX_PROGRESS_ACTIVITY) }));
      const oneMore = buildProgressSnapshot(running({ recentActivity: activity(MAX_PROGRESS_ACTIVITY + 1) }));

      // The blind spot the length check could never see: both tails are pinned at the cap.
      expect(full.recentActivity).toHaveLength(MAX_PROGRESS_ACTIVITY);
      expect(oneMore.recentActivity).toHaveLength(MAX_PROGRESS_ACTIVITY);
      expect(progressChanged(full, oneMore)).toBe(true);
    });

    it("keeps pushing for every subsequent event, not just the first past the cap", () => {
      let prev = buildProgressSnapshot(running({ recentActivity: activity(MAX_PROGRESS_ACTIVITY) }));
      for (let n = MAX_PROGRESS_ACTIVITY + 1; n <= MAX_PROGRESS_ACTIVITY + 5; n += 1) {
        const next = buildProgressSnapshot(running({ recentActivity: activity(n) }));
        expect(progressChanged(prev, next)).toBe(true);
        prev = next;
      }
    });

    it("still does not push when a full tail is genuinely unchanged", () => {
      const a = buildProgressSnapshot(running({ recentActivity: activity(MAX_PROGRESS_ACTIVITY) }));
      const b = buildProgressSnapshot(running({ recentActivity: activity(MAX_PROGRESS_ACTIVITY) }));
      expect(progressChanged(a, b)).toBe(false);
    });

    it("detects a same-length change in any displayed activity field", () => {
      const base10 = buildProgressSnapshot(running({ recentActivity: activity(MAX_PROGRESS_ACTIVITY) }));
      const changedStep = activity(MAX_PROGRESS_ACTIVITY);
      changedStep[MAX_PROGRESS_ACTIVITY - 1] = { ...changedStep[MAX_PROGRESS_ACTIVITY - 1]!, step: "different" };
      const changedDetail = activity(MAX_PROGRESS_ACTIVITY);
      changedDetail[0] = { ...changedDetail[0]!, detail: "now has a detail" };
      const changedAt = activity(MAX_PROGRESS_ACTIVITY);
      changedAt[0] = { ...changedAt[0]!, at: "2026-07-16T09:99:00Z" };

      expect(progressChanged(base10, buildProgressSnapshot(running({ recentActivity: changedStep })))).toBe(true);
      expect(progressChanged(base10, buildProgressSnapshot(running({ recentActivity: changedDetail })))).toBe(true);
      expect(progressChanged(base10, buildProgressSnapshot(running({ recentActivity: changedAt })))).toBe(true);
    });
  });
});
