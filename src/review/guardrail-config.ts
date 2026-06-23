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

function asNonEmptyStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return out.length > 0 ? out : null;
}

/**
 * Resolve a repo's hard-guardrail path globs from the shared REVIEW_CONFIG KV (key = repo slug). Falls back to
 * DEFAULT_CRUCIAL_GUARDRAIL_GLOBS when the binding / key / field is absent or malformed — fail-SAFE and never
 * throws (the auto-maintain trigger is best-effort and must not be sunk by a config read).
 */
export async function loadHardGuardrailGlobs(env: Env, repoFullName: string, installationId?: number | null | undefined): Promise<string[]> {
  const slug = repoFullName.includes("/") ? repoFullName.slice(repoFullName.indexOf("/") + 1) : repoFullName;
  if (!env.REVIEW_CONFIG) return DEFAULT_CRUCIAL_GUARDRAIL_GLOBS;
  try {
    const candidateKeys = [
      ...(installationId !== undefined && installationId !== null ? [`installation:${installationId}:${repoFullName.toLowerCase()}`, `installation:${installationId}:${slug.toLowerCase()}`] : []),
      repoFullName.toLowerCase(),
      slug.toLowerCase(),
    ];
    for (const key of candidateKeys) {
      const config = (await env.REVIEW_CONFIG.get(key, "json")) as { hardGuardrailGlobs?: JsonValue } | null;
      const globs = asNonEmptyStringArray(config?.hardGuardrailGlobs);
      if (globs) return globs;
    }
    return DEFAULT_CRUCIAL_GUARDRAIL_GLOBS;
  } catch {
    return DEFAULT_CRUCIAL_GUARDRAIL_GLOBS;
  }
}
