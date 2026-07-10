// Read-only client for the local run-state API (#4305). The dashboard is a browser app and the miner's stores
// are `node:sqlite` files on disk, so the view never touches SQL — it fetches the dev server's local read-only
// endpoint (see `vite-run-state-api.ts`), which itself calls into `packages/gittensory-miner/lib/run-state.js`'s
// existing exports.

export const RUN_STATE_API_PATH = "/api/run-state";

/** One `miner_run_state` row as served by the local API — mirrors `run-state.js`'s row shape. */
export type RunStateRow = {
  repoFullName: string;
  state: "idle" | "discovering" | "planning" | "preparing";
  updatedAt: string;
};

export type RunHistoryResult = { ok: true; rows: RunStateRow[] } | { ok: false; error: string };

function isRunStateRow(value: unknown): value is RunStateRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.repoFullName === "string" &&
    typeof row.updatedAt === "string" &&
    (row.state === "idle" || row.state === "discovering" || row.state === "planning" || row.state === "preparing")
  );
}

/** Fetch the local run-state rows. Failures (server down, malformed payload) surface as a typed error result —
 *  the view renders them as a message, never a crash. `fetchImpl` is injectable for tests. */
export async function fetchRunStates(fetchImpl: typeof fetch = fetch): Promise<RunHistoryResult> {
  try {
    const response = await fetchImpl(RUN_STATE_API_PATH);
    if (!response.ok) return { ok: false, error: `local run-state API responded ${response.status}` };
    const payload: unknown = await response.json();
    const rows = (payload as { rows?: unknown }).rows;
    if (!Array.isArray(rows) || !rows.every(isRunStateRow)) {
      return { ok: false, error: "local run-state API returned an unexpected payload shape" };
    }
    return { ok: true, rows };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "failed to reach the local run-state API" };
  }
}
