// Shared severity-threshold resolver (#5119): global-default + per-repo-override precedence for gating how
// much observability noise an operator's ops channels receive. notify-pagerduty.ts's own
// resolvePagerDutyMinSeverity was the original, single-purpose version of this (paging only); sentry.ts's
// capture paths now share the SAME resolver so there is one severity-threshold concept in the codebase, not
// two parallel ones.

export type LoopoverSeverity = "critical" | "error" | "warning" | "info";

export const SEVERITY_RANK: Record<LoopoverSeverity, number> = { info: 0, warning: 1, error: 2, critical: 3 };

export function isLoopoverSeverity(value: unknown): value is LoopoverSeverity {
  return value === "critical" || value === "error" || value === "warning" || value === "info";
}

/** True when `severity` meets or exceeds `threshold` (higher {@link SEVERITY_RANK}) -- the shared "should this
 *  actually fire" comparison every severity-gated channel (PagerDuty pages, Sentry captures) makes. */
export function meetsSeverityThreshold(severity: LoopoverSeverity, threshold: LoopoverSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold];
}

function envString(env: Env, name: string): string | undefined {
  const fromEnv = (env as unknown as Record<string, unknown>)[name];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  /* v8 ignore next 2 -- process.env is the self-host Node fallback; Worker/D1 tests pass values on Env. */
  const processEnv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const fromProcess = processEnv?.[name];
  return typeof fromProcess === "string" && fromProcess.trim().length > 0 ? fromProcess.trim() : undefined;
}

/** Parse a `{repoFullName: value}` JSON map off `envName`, lower-casing repo keys. Malformed/absent -> `{}`. */
function repoJsonMap(env: Env, envName: string): Record<string, unknown> {
  const raw = envString(env, envName);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, unknown> = {};
    for (const [repo, value] of Object.entries(parsed)) out[repo.toLowerCase()] = value;
    return out;
  } catch {
    return {};
  }
}

/** Resolve the minimum severity threshold for `repoFullName`: a valid `repoMapVarName` JSON-map entry wins,
 *  else a valid `globalVarName` override, else `fallback` (default `"error"` -- the quietest safe default, so
 *  an operator who never touches these vars keeps today's de facto behavior). Mirrors
 *  {@link resolveDiscordWebhook}/{@link resolvePagerDutyRoutingKey}'s exact per-repo-override-wins-over-global
 *  precedence. `repoFullName` may be `""` for a non-repo-scoped event -- the (empty) map lookup simply misses
 *  and falls through to the global threshold, which is the correct behavior for global-only events. */
export function resolveSeverityThreshold(
  env: Env,
  repoFullName: string,
  globalVarName: string,
  repoMapVarName: string,
  fallback: LoopoverSeverity = "error",
): LoopoverSeverity {
  const map = repoJsonMap(env, repoMapVarName);
  const mapped = map[repoFullName.toLowerCase()];
  if (isLoopoverSeverity(mapped)) return mapped;
  const global = envString(env, globalVarName);
  return isLoopoverSeverity(global) ? global : fallback;
}
