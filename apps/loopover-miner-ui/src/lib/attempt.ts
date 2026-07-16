// Client for the local attempt action API (#6522), the miner-ui's HTTP surface over the `attempt` CLI command.
// Mirrors governor.ts / discover.ts: a typed discriminated result, never a thrown exception for an HTTP-level
// failure, and a guard narrowing the parsed payload. Safe only because vite-auth.ts authenticates every /api/*
// request. `/api/attempt` can run for minutes (a real worktree + coding-agent iteration), so a caller that needs
// a deadline applies it here at the fetch layer — the route imposes none.

export const ATTEMPT_API_PATH = "/api/attempt";

/** Non-secret attempt inputs — never a credential; `runAttempt` resolves its own token server-side. */
export type AttemptActionInput = {
  repoFullName: string;
  issueNumber: number;
  minerLogin: string;
  base?: string;
  live?: boolean;
  dryRun?: boolean;
  json?: boolean;
};

/** `result` is the structured AttemptCliResult the CLI emits (with its own `outcome`); `exitCode` is returned
 *  alongside so a caller can tell a governed rejection/blocked outcome from a clean success without re-deriving
 *  it from the result shape. Kept as `unknown` so a later chat/message-list issue types it against the shared
 *  contract without this fetcher coupling to the full union. */
export type AttemptActionResult = { ok: true; result: unknown; exitCode: number } | { ok: false; error: string };

function isAttemptSuccessPayload(value: unknown): value is { result: unknown; exitCode: number } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return "result" in record && typeof record.exitCode === "number";
}

async function parseAttemptResponse(response: Response, apiLabel: string): Promise<AttemptActionResult> {
  if (!response.ok) return { ok: false, error: `${apiLabel} responded ${response.status}` };
  const payload: unknown = await response.json();
  if (!isAttemptSuccessPayload(payload)) {
    return { ok: false, error: `${apiLabel} returned an unexpected payload shape` };
  }
  return { ok: true, result: payload.result, exitCode: payload.exitCode };
}

/** Run a local attempt (mirrors `loopover-miner attempt <owner/repo> <issue#> --miner-login <login> [--live]
 *  [--dry-run]`); an HTTP or shape failure surfaces as a typed error result the view renders, never a crash. */
export async function requestAttempt(
  input: AttemptActionInput,
  fetchImpl: typeof fetch = fetch,
): Promise<AttemptActionResult> {
  try {
    const response = await fetchImpl(ATTEMPT_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return await parseAttemptResponse(response, "local attempt API");
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "failed to reach the local attempt API",
    };
  }
}
