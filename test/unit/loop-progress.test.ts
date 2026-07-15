import { describe, expect, it } from "vitest";
import {
  buildProgressSnapshot,
  progressChanged,
  MAX_PROGRESS_ACTIVITY,
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

  it("pushes on a new activity event once the tail is full at the cap (#6171)", () => {
    // Once recentActivity fills to MAX_PROGRESS_ACTIVITY a new event evicts the oldest and appends the newest,
    // so the tail length stays constant — the length-only check missed this and stopped firing (#6171).
    const full = Array.from({ length: MAX_PROGRESS_ACTIVITY }, (_, i) => ({ step: `s${i}` }));
    const prev = buildProgressSnapshot(running({ recentActivity: full }));
    const nextState = running({ recentActivity: [...full.slice(1), { step: "s-new" }] });
    const next = buildProgressSnapshot(nextState);
    expect(prev.recentActivity).toHaveLength(MAX_PROGRESS_ACTIVITY);
    expect(next.recentActivity).toHaveLength(MAX_PROGRESS_ACTIVITY);
    expect(prev.recentActivity.length === next.recentActivity.length).toBe(true); // length alone can't tell them apart
    expect(progressChanged(prev, next)).toBe(true);
  });

  it("pushes when the newest activity entry differs in step, detail, or at (same tail length)", () => {
    const p = buildProgressSnapshot(running({ recentActivity: [{ step: "a", detail: "d", at: "t1" }] }));
    expect(progressChanged(p, buildProgressSnapshot(running({ recentActivity: [{ step: "b", detail: "d", at: "t1" }] })))).toBe(true);
    expect(progressChanged(p, buildProgressSnapshot(running({ recentActivity: [{ step: "a", detail: "e", at: "t1" }] })))).toBe(true);
    expect(progressChanged(p, buildProgressSnapshot(running({ recentActivity: [{ step: "a", detail: "d", at: "t2" }] })))).toBe(true);
  });

  it("does not push when the newest activity entry matches on every field", () => {
    const p = buildProgressSnapshot(running({ recentActivity: [{ step: "a", detail: "d", at: "t1" }] }));
    expect(progressChanged(p, buildProgressSnapshot(running({ recentActivity: [{ step: "a", detail: "d", at: "t1" }] })))).toBe(false);
  });

  it("does not push when both activity tails are empty (newest entry undefined on both sides)", () => {
    const empty = buildProgressSnapshot(running({ recentActivity: [] }));
    expect(progressChanged(empty, buildProgressSnapshot(running({ recentActivity: [] })))).toBe(false);
  });

  it("pushes when one tail is empty and the other has activity (newest entry undefined on one side)", () => {
    const empty = buildProgressSnapshot(running({ recentActivity: [] }));
    const oneItem = buildProgressSnapshot(running({ recentActivity: [{ step: "a" }] }));
    expect(progressChanged(empty, oneItem)).toBe(true);
  });
});
