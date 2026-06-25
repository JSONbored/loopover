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

// The gate's OWN policy files, guarded for EVERY repo regardless of KV tuning. A PR that edits the
// config-as-code that defines the gate or coverage policy (the `.gittensory.*` focus manifest the loader
// reads, or `codecov.yml`) must always be HELD for the owner — otherwise one auto-merged config-only PR
// could weaken the gate repo-wide before any subsequent PR is evaluated against the new policy. The
// manifest filenames mirror signals/focus-manifest-loader's candidates; this only ever WIDENS the guard.
export const CONFIG_AS_CODE_GUARDRAIL_GLOBS = [
  ".gittensory.yml",
  ".gittensory.yaml",
  ".gittensory.json",
  ".github/gittensory.yml",
  ".github/gittensory.yaml",
  ".github/gittensory.json",
  "**/codecov.yml",
  "**/codecov.yaml",
  "**/.codecov.yml",
];

// The review engine's OWN decision + safety code — its crown jewels — guarded for EVERY repo regardless of KV
// tuning. A contributor PR that edits how the gate decides a verdict, how a merge or close executes, the
// action-mode kill-switch, scoring, auth, the CI aggregate the gate reads, or the guardrail itself must be HELD
// for the owner: the engine must never auto-merge a change to the very code that governs its own autonomy. This
// is the exact failure the FAIL_CLOSED comment warns about — but that fires only on a KV outage, so without this
// the narrow DEFAULT (CI + scripts) let crown-jewel edits auto-merge on every normal request. These are
// gittensory engine-specific paths, so they never match an unrelated reviewed repo's PR (e.g. metagraphed has no
// src/rules/** or agent-action-executor.ts); like the config-as-code set above, this only ever WIDENS the guard.
export const ENGINE_DECISION_GUARDRAIL_GLOBS = [
  "src/rules/**", // the gate verdict (advisory) + the predicted-gate mirror
  "src/services/**", // the merge/close action executor, approval queue, and merge-failure handling — the write chokepoint
  "src/settings/agent-actions.ts", // the disposition planner (canMerge / willClose / heldForManualReview)
  "src/settings/agent-execution.ts", // the action-mode resolver + the env kill-switch backstop
  "src/settings/agent-sweep.ts", // the re-gate maintenance sweep
  "src/settings/autonomy.ts", // the autonomy-level ladder (observe → suggest → auto → auto_with_approval)
  "src/queue/**", // webhook → gate → merge/close orchestration (processors) + dead-letter handling (dlq) — NOT in the KV dir-prefix guards
  "src/github/pr-actions.ts", // the GitHub merge / close / review / comment write primitives
  "src/github/app.ts", // installation auth + the per-installation token mint
  "src/github/backfill.ts", // the live CI aggregate (fetchLiveCiAggregate) the gate verdict reads
  "src/scoring/**", // the on-chain scoring model + previews
  "src/auth/**", // session/bearer auth + the admin allowlist
  "src/review/safety.ts", // the secret-leak + prompt-injection defenses
  "src/review/guardrail-config.ts", // the guardrail globs themselves (this file)
  "src/review/cutover-gate.ts", // the shadow → live cutover gate
  "src/review/linked-issue-hard-rules.ts", // the deterministic linked-issue auto-close rules
  "src/review/outcomes-wire.ts", // the pr_outcome + reversal telemetry that feeds self-tuning
];

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
  // The config-as-code policy files AND the engine's own crown-jewel paths are guarded for every repo regardless
  // of KV tuning (a narrow per-repo glob list never un-guards them); the fail-closed `**` already covers them.
  if (!env.REVIEW_CONFIG) return [...DEFAULT_CRUCIAL_GUARDRAIL_GLOBS, ...CONFIG_AS_CODE_GUARDRAIL_GLOBS, ...ENGINE_DECISION_GUARDRAIL_GLOBS];
  try {
    const config = (await env.REVIEW_CONFIG.get(slug, "json")) as { hardGuardrailGlobs?: JsonValue } | null;
    return [...(asNonEmptyStringArray(config?.hardGuardrailGlobs) ?? DEFAULT_CRUCIAL_GUARDRAIL_GLOBS), ...CONFIG_AS_CODE_GUARDRAIL_GLOBS, ...ENGINE_DECISION_GUARDRAIL_GLOBS];
  } catch {
    return FAIL_CLOSED_GUARDRAIL_GLOBS;
  }
}
