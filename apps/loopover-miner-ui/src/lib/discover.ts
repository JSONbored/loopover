// Client for the local discover action API (#6522, the discover half of the miner-ui's chat action-dispatch
// surface). Mirrors governor.ts / portfolio-queue-actions.ts's shape (a typed discriminated result, never a
// thrown exception for an HTTP-level failure) via the authenticated dev-server bridge in vite-discover-api.ts,
// which is a thin, non-bypassing wrapper around the real `loopover-miner discover` CLI entry point.
//
// No credential is ever sent: GITHUB_TOKEN / the tenant's token env var is resolved server-side by runDiscover
// itself. The client only sends non-secret passthrough fields (repo targets, search query, apiBaseUrl, the NAME
// of a token-env var, dryRun, json).

export const DISCOVER_API_PATH = "/api/discover";

export type DiscoverRunRequest = {
  targets?: string[];
  search?: string;
  dryRun?: boolean;
  json?: boolean;
  apiBaseUrl?: string;
  tokenEnv?: string;
};

/** The structured result runDiscover reports via its onResult hook (#6522), surfaced verbatim by the route. */
export type DiscoverRunResult = {
  fanOutCount: number;
  ranked: unknown[];
  enqueueSummary: { enqueued: number } & Record<string, unknown>;
} & Record<string, unknown>;

export type DiscoverActionResult =
  { ok: true; result: DiscoverRunResult; exitCode: number } | { ok: false; error: string };

function isDiscoverRunResult(value: unknown): value is DiscoverRunResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.fanOutCount === "number" &&
    Array.isArray(result.ranked) &&
    typeof result.enqueueSummary === "object" &&
    result.enqueueSummary !== null
  );
}

async function parseDiscoverResponse(response: Response, label: string): Promise<DiscoverActionResult> {
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => ({}));
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error) {
      return { ok: false, error };
    }
    return { ok: false, error: `${label} responded ${response.status}` };
  }
  const payload: unknown = await response.json();
  const result = (payload as { result?: unknown }).result;
  const exitCode = (payload as { exitCode?: unknown }).exitCode;
  if (!isDiscoverRunResult(result) || typeof exitCode !== "number") {
    return { ok: false, error: `${label} returned an unexpected payload shape` };
  }
  return { ok: true, result, exitCode };
}

/** Run discover against repo targets or a search query — mirrors `loopover-miner discover ...`. HTTP-level
 *  failures surface as a typed error result the view renders, never a thrown exception. */
export async function runDiscoverAction(
  request: DiscoverRunRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoverActionResult> {
  try {
    const response = await fetchImpl(DISCOVER_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    return await parseDiscoverResponse(response, "local discover API");
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "failed to reach the local discover API",
    };
  }
}
