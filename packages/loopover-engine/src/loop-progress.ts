// Loop progress model (pure) — the near-real-time progress a customer watches while their rented loop runs
// (#4800, part of the Rent-a-Loop path #4778). This owns the DETERMINISTIC brain of the stream: it builds a
// progress snapshot from already-computed loop state, and decides when the snapshot has meaningfully changed
// so a customer-facing surface (#4807) can push ON CHANGE rather than poll on a fixed interval. No IO, no
// transport — a plain in/out transform, mirroring the intake bridge (#4798) and results composer (#4801).

// Cap the streamed activity tail so a long run never floods the surface; the loop's full log lives elsewhere.
export const MAX_PROGRESS_ACTIVITY = 10;

export type LoopPhase = "queued" | "claiming" | "coding" | "reviewing" | "submitting" | "done";
export type LoopRunStatus = "running" | "converged" | "abandoned" | "error";

export type LoopProgressActivity = {
  step: string;
  detail?: string | undefined;
  at?: string | undefined;
};

/** The already-computed state of one running loop, the input to a progress snapshot. */
export type LoopProgressState = {
  iteration: number;
  maxIterations?: number | null | undefined;
  phase: LoopPhase;
  status: LoopRunStatus;
  recentActivity?: LoopProgressActivity[] | undefined;
};

export type ProgressSnapshot = {
  phase: LoopPhase;
  status: LoopRunStatus;
  iteration: number;
  maxIterations: number | null;
  /** Progress through the iteration budget (0-100), or null when the budget is unknown. */
  percentComplete: number | null;
  /** The most recent activity, newest last, capped at {@link MAX_PROGRESS_ACTIVITY}. */
  recentActivity: LoopProgressActivity[];
  done: boolean;
};

/** Build a customer-facing progress snapshot from already-computed loop state (#4800). Pure. */
export function buildProgressSnapshot(state: LoopProgressState): ProgressSnapshot {
  const maxIterations = state.maxIterations ?? null;
  const percentComplete =
    maxIterations !== null && maxIterations > 0 ? Math.min(100, Math.round((state.iteration / maxIterations) * 100)) : null;
  return {
    phase: state.phase,
    status: state.status,
    iteration: state.iteration,
    maxIterations,
    percentComplete,
    recentActivity: (state.recentActivity ?? []).slice(-MAX_PROGRESS_ACTIVITY),
    done: state.status !== "running",
  };
}

/**
 * True when the activity tail differs — by length, or by CONTENT at the same length.
 *
 * Length alone is not enough (#6171): the tail is capped at {@link MAX_PROGRESS_ACTIVITY}, so once a loop has
 * accumulated that many entries every further event evicts the oldest and appends the newest, holding the
 * length at the cap forever. A length-only check therefore goes permanently blind to activity exactly on the
 * long runs that stream the most. Comparing the entries themselves is O(cap) — bounded by that same constant,
 * so a fixed handful of field reads, not a cost that grows with the run.
 */
function activityChanged(prev: readonly LoopProgressActivity[], next: readonly LoopProgressActivity[]): boolean {
  if (prev.length !== next.length) return true;
  for (let index = 0; index < next.length; index += 1) {
    const before = prev[index]!;
    const after = next[index]!;
    if (before.step !== after.step || before.detail !== after.detail || before.at !== after.at) return true;
  }
  return false;
}

/** True when `next` differs from `prev` in a way worth pushing to the customer — so the surface streams
 *  ON CHANGE instead of polling on a fixed interval (#4800's acceptance). A null `prev` (the first snapshot)
 *  always pushes. Compares the displayed axes: phase, status, iteration, and the activity tail's contents. */
export function progressChanged(prev: ProgressSnapshot | null, next: ProgressSnapshot): boolean {
  if (prev === null) return true;
  return (
    prev.phase !== next.phase ||
    prev.status !== next.status ||
    prev.iteration !== next.iteration ||
    activityChanged(prev.recentActivity, next.recentActivity)
  );
}
