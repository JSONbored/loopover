// Client for the local discover action API (#6522), the miner-ui's HTTP surface over the `discover` CLI command.
// Mirrors governor.ts's shape: a typed discriminated result, never a thrown exception for an HTTP-level failure,
// and a guard narrowing the parsed payload. Safe only because vite-auth.ts authenticates every /api/* request.

export const DISCOVER_API_PATH = "/api/discover";

/** Non-secret discover inputs — never a credential; the server resolves its own token, exactly as the CLI does. */
export type DiscoverActionInput = {
  targets?: string[];
  search?: string;
  dryRun?: boolean;
  json?: boolean;
  apiBaseUrl?: string;
  tokenEnv?: string;
};

/** `result` is the structured DiscoverResult the CLI emits; kept as `unknown` here so a later chat/message-list
 *  issue can type it against the shared contract without this fetcher coupling to the full result shape. */
export type DiscoverActionResult = { ok: true; result: unknown; exitCode: number } | { ok: false; error: string };

function isDiscoverSuccessPayload(value: unknown): value is { result: unknown; exitCode: number } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return "result" in record && typeof record.exitCode === "number";
}

async function parseDiscoverResponse(response: Response, apiLabel: string): Promise<DiscoverActionResult> {
  if (!response.ok) return { ok: false, error: `${apiLabel} responded ${response.status}` };
  const payload: unknown = await response.json();
  if (!isDiscoverSuccessPayload(payload)) {
    return { ok: false, error: `${apiLabel} returned an unexpected payload shape` };
  }
  return { ok: true, result: payload.result, exitCode: payload.exitCode };
}

/** Run a local discover (mirrors `loopover-miner discover <targets|--search> [--dry-run] [--json]`); an HTTP
 *  or shape failure surfaces as a typed error result the view renders, never a crash. */
export async function requestDiscover(
  input: DiscoverActionInput,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoverActionResult> {
  try {
    const response = await fetchImpl(DISCOVER_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return await parseDiscoverResponse(response, "local discover API");
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "failed to reach the local discover API",
    };
  }
}
