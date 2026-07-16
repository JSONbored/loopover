// Client for the local attempt action API (#6522, the attempt half of the miner-ui's chat action-dispatch
// surface). Mirrors governor.ts / portfolio-queue-actions.ts's shape (a typed discriminated result, never a
// thrown exception for an HTTP-level failure) via the authenticated dev-server bridge in vite-attempt-api.ts,
// which is a thin, non-bypassing wrapper around the real `loopover-miner attempt` CLI entry point (and so
// inherits the Governor chokepoint gate automatically).
//
// No credential is ever sent: the miner's local harness runs writes with its own local credentials, resolved
// server-side. The client only sends non-secret passthrough fields (owner/repo, issue number, minerLogin, base,
// live, dryRun, json).

export const ATTEMPT_API_PATH = "/api/attempt";

export type AttemptRunRequest = {
  repoFullName: string;
  issueNumber: number;
  minerLogin?: string;
  base?: string;
  live?: boolean;
  dryRun?: boolean;
  json?: boolean;
};

/** The structured result runAttempt reports via its onResult hook, surfaced verbatim by the route. The `outcome`
 *  discriminant (dry_run / blocked_* / attempt_*) is always present; the remaining fields vary by outcome. */
export type AttemptRunResult = {
  outcome: string;
  repoFullName: string;
  issueNumber: number;
} & Record<string, unknown>;

export type AttemptActionResult =
  { ok: true; result: AttemptRunResult; exitCode: number } | { ok: false; error: string };

function isAttemptRunResult(value: unknown): value is AttemptRunResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.outcome === "string" &&
    typeof result.repoFullName === "string" &&
    typeof result.issueNumber === "number"
  );
}

async function parseAttemptResponse(response: Response, label: string): Promise<AttemptActionResult> {
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
  if (!isAttemptRunResult(result) || typeof exitCode !== "number") {
    return { ok: false, error: `${label} returned an unexpected payload shape` };
  }
  return { ok: true, result, exitCode };
}

/** Attempt an issue — mirrors `loopover-miner attempt <owner/repo> <issue#> --miner-login <login> ...`. This may
 *  run for minutes server-side (full worktree + coding-agent iteration); the client simply awaits it. HTTP-level
 *  failures surface as a typed error result the view renders, never a thrown exception. */
export async function runAttemptAction(
  request: AttemptRunRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AttemptActionResult> {
  try {
    const response = await fetchImpl(ATTEMPT_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    return await parseAttemptResponse(response, "local attempt API");
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "failed to reach the local attempt API",
    };
  }
}
