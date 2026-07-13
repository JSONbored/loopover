// Client for the local governor pause-state read + pause/resume write API (#4857, the governor half of "Add
// real actions to the miner-ui"). Mirrors portfolio-queue.ts's shape (typed result union, no throw on a bad
// response, a guard narrowing the parsed JSON payload) but adds two WRITE actions, the miner-ui's first — safe
// only because vite-auth.ts (#4858) now authenticates every /api/* request, including these.

export const GOVERNOR_PAUSE_STATE_API_PATH = "/api/governor/pause-state";
export const GOVERNOR_PAUSE_API_PATH = "/api/governor/pause";
export const GOVERNOR_RESUME_API_PATH = "/api/governor/resume";

export type GovernorPauseState = { paused: boolean; reason: string | null; pausedAt: string | null };

export type GovernorPauseStateResult = { ok: true; pauseState: GovernorPauseState } | { ok: false; error: string };

function isGovernorPauseState(value: unknown): value is GovernorPauseState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.paused === "boolean" &&
    (state.reason === null || typeof state.reason === "string") &&
    (state.pausedAt === null || typeof state.pausedAt === "string")
  );
}

export const defaultGovernorPauseState = (): GovernorPauseState => ({ paused: false, reason: null, pausedAt: null });

async function parseGovernorPauseStateResponse(
  response: Response,
  apiLabel: string,
): Promise<GovernorPauseStateResult> {
  if (!response.ok) return { ok: false, error: `${apiLabel} responded ${response.status}` };
  const payload: unknown = await response.json();
  const pauseState = (payload as { pauseState?: unknown }).pauseState;
  if (!isGovernorPauseState(pauseState)) {
    return { ok: false, error: `${apiLabel} returned an unexpected payload shape` };
  }
  return { ok: true, pauseState };
}

/** Fetch the governor's current pause state; failures surface as a typed error result the view renders, never a crash. */
export async function fetchGovernorPauseState(fetchImpl: typeof fetch = fetch): Promise<GovernorPauseStateResult> {
  try {
    const response = await fetchImpl(GOVERNOR_PAUSE_STATE_API_PATH);
    return await parseGovernorPauseStateResponse(response, "local governor pause-state API");
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "failed to reach the local governor pause-state API",
    };
  }
}

async function postGovernorAction(
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<GovernorPauseStateResult> {
  try {
    const response = await fetchImpl(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await parseGovernorPauseStateResponse(response, "local governor action API");
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "failed to reach the local governor action API",
    };
  }
}

/** Pause the governor, optionally with a reason (mirrors `gittensory-miner governor pause [--reason <text>]`). */
export function pauseGovernor(reason?: string, fetchImpl: typeof fetch = fetch): Promise<GovernorPauseStateResult> {
  return postGovernorAction(GOVERNOR_PAUSE_API_PATH, reason ? { reason } : {}, fetchImpl);
}

/** Resume the governor (mirrors `gittensory-miner governor resume`). */
export function resumeGovernor(fetchImpl: typeof fetch = fetch): Promise<GovernorPauseStateResult> {
  return postGovernorAction(GOVERNOR_RESUME_API_PATH, {}, fetchImpl);
}
