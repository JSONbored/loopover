import type { JsonValue } from "../types";

// Per-repo hard-guardrail path globs (paths that force MANUAL review — no auto-merge / no auto-close).
//
// Convergence note: gittensory does not have its own per-repo guardrail config surface, but reviewbot already
// stores carefully-tuned globs per repo in the shared REVIEW_CONFIG KV (keyed by repo slug, e.g. "gittensory"
// / "awesome-claude" / "metagraphed"). That KV is the established home for private, runtime-editable operator
// tuning, so the converged auto-maintain path reads its guardrail globs from there too — no redeploy needed
// to retune, and the same KV survives reviewbot's decommission.

// Conservative cross-repo fallback when a repo has no KV-configured globs: CI workflows + build/policy scripts
// are universally sensitive (the awesome-claude #4196 incident class). Fail-SAFE — a config miss still guards
// these, it never opens the gate wide.
export const DEFAULT_CRUCIAL_GUARDRAIL_GLOBS = [".github/workflows/**", "scripts/**"];

// A KV READ FAULT (binding present but the read threw — an outage/transient error) must fail CLOSED, NOT fall
// back to the narrow default: a config-read fault correlated with a contributor flood would otherwise silently
// shrink the guarded surface to CI+scripts and let crown-jewel edits (scoring/auth/rules/the gate) auto-merge.
// "**" matches every path (the glob engine maps ** -> .*), so this holds ALL PRs for human review until the
// config read recovers — fail-safe for the surface a flood most threatens. (#flood-readiness)
export const FAIL_CLOSED_GUARDRAIL_GLOBS = ["**"];

function asNonEmptyStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return out.length > 0 ? out : null;
}

/**
 * Resolve a repo's hard-guardrail path globs from the shared REVIEW_CONFIG KV (key = repo slug). Never throws
 * (the auto-maintain trigger is best-effort). A legitimately-absent binding/key/field falls back to the narrow
 * DEFAULT_CRUCIAL_GUARDRAIL_GLOBS so a freshly-installed repo can still operate; but a THROWN read (KV outage)
 * fails CLOSED to FAIL_CLOSED_GUARDRAIL_GLOBS so a config fault can never open the gate during a flood.
 */
export async function loadHardGuardrailGlobs(env: Env, repoFullName: string): Promise<string[]> {
  const slug = repoFullName.includes("/") ? repoFullName.slice(repoFullName.indexOf("/") + 1) : repoFullName;
  if (!env.REVIEW_CONFIG) return DEFAULT_CRUCIAL_GUARDRAIL_GLOBS;
  try {
    const config = (await env.REVIEW_CONFIG.get(slug, "json")) as { hardGuardrailGlobs?: JsonValue } | null;
    return asNonEmptyStringArray(config?.hardGuardrailGlobs) ?? DEFAULT_CRUCIAL_GUARDRAIL_GLOBS;
  } catch {
    return FAIL_CLOSED_GUARDRAIL_GLOBS;
  }
}

/**
 * Anti-farming submission-flood limit for a repo, read from the same shared REVIEW_CONFIG KV (key = repo slug):
 * `maxSubmissionsPerAuthorWindow` (the per-author cap) + `submissionWindowHours` (the window, default 24h). Returns
 * null when unset/invalid (the feature is DISABLED for that repo) or on a KV fault — never throws, and a fault
 * disables rather than false-holding a contributor. (#anti-gaming-flood)
 */
export async function loadSubmissionFloodLimit(env: Env, repoFullName: string): Promise<{ maxPerWindow: number; windowHours: number } | null> {
  const slug = repoFullName.includes("/") ? repoFullName.slice(repoFullName.indexOf("/") + 1) : repoFullName;
  if (!env.REVIEW_CONFIG) return null;
  try {
    const config = (await env.REVIEW_CONFIG.get(slug, "json")) as { maxSubmissionsPerAuthorWindow?: JsonValue; submissionWindowHours?: JsonValue } | null;
    const maxPerWindow = Number(config?.maxSubmissionsPerAuthorWindow);
    if (!Number.isFinite(maxPerWindow) || maxPerWindow <= 0) return null; // unset / invalid → disabled
    const hours = Number(config?.submissionWindowHours);
    return { maxPerWindow, windowHours: Number.isFinite(hours) && hours > 0 ? hours : 24 };
  } catch {
    return null; // KV fault → disabled (never false-hold)
  }
}
