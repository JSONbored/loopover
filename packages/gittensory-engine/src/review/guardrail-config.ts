import type { RepositorySettings } from "../types/predicted-gate-types.js";

// This is a Set-membership guardrail list (order doesn't matter, unlike the loaders' priority-ordered candidate
// lists): a contributor PR touching the canonical `.loopover.*` config file gets hard-guardrail protection.
export const CONFIG_AS_CODE_GUARDRAIL_GLOBS = [
  ".loopover.yml",
  ".loopover.yaml",
  ".loopover.json",
  ".github/loopover.yml",
  ".github/loopover.yaml",
  ".github/loopover.json",
  "**/codecov.yml",
  "**/codecov.yaml",
  "**/.codecov.yml",
];

export const WORKFLOW_AND_RUNTIME_GUARDRAIL_GLOBS = [
  ".github/workflows/**",
  "scripts/**",
  "wrangler.jsonc",
  "src/selfhost/**",
];

export const ENGINE_DECISION_GUARDRAIL_GLOBS = [
  "src/rules/**",
  "src/services/**",
  "src/settings/agent-actions.ts",
  "src/settings/agent-execution.ts",
  "src/settings/agent-sweep.ts",
  "src/settings/autonomy.ts",
  "src/queue/**",
  "src/github/pr-actions.ts",
  "src/github/app.ts",
  "src/github/backfill.ts",
  // #4197: writes a real commit onto a CONTRIBUTOR's own PR branch (not a branch gittensory owns) — the same
  // guardrail tier as pr-actions.ts/app.ts for the same reason, a new GitHub-write surface.
  "src/github/e2e-test-commit.ts",
  "src/scoring/**",
  "src/auth/**",
  "src/review/safety.ts",
  "src/review/guardrail-config.ts",
  "src/review/cutover-gate.ts",
  "src/review/linked-issue-hard-rules.ts",
  "src/review/outcomes-wire.ts",
];

// Default, safe-by-default invariant set (restored by #3943 after the original pure-config-as-code design
// let a `.gittensory.yml` edit silently remove its own guardrail protection). Repo settings can only ADD to
// this set UNLESS the repo explicitly opts in via `hardGuardrailGlobsOverridesInvariants` (below).
export const DEFAULT_HARD_GUARDRAIL_GLOBS = [
  ...CONFIG_AS_CODE_GUARDRAIL_GLOBS,
  ...WORKFLOW_AND_RUNTIME_GUARDRAIL_GLOBS,
  ...ENGINE_DECISION_GUARDRAIL_GLOBS,
];

/**
 * Resolve hard-guardrail path globs from the already-effective repo settings.
 *
 * Safe by default (#3943): `DEFAULT_HARD_GUARDRAIL_GLOBS` is an invariant floor, and a repo's configured
 * `hardGuardrailGlobs` is ADDED to it (deduplicated), never allowed to shrink it — so an ordinary
 * `.gittensory.yml` edit (even a careless or malicious one) can only ever widen guardrail protection.
 *
 * Full self-hoster control, opt-in (config-as-code mandate): a repo that explicitly sets
 * `hardGuardrailGlobsOverridesInvariants: true` takes complete ownership of its guardrail list —
 * `hardGuardrailGlobs` is then used EXACTLY as given (including an explicit `[]` to disable path guardrails
 * entirely), REPLACING rather than adding to the built-in floor. This is deliberately a second, explicit
 * field rather than reusing `hardGuardrailGlobs: []`'s presence/absence, so opting out of the safety net is
 * always a conscious, separately-visible decision in the config file, not a side effect of trimming a list.
 */
export function resolveHardGuardrailGlobs(
  settings: Pick<RepositorySettings, "hardGuardrailGlobs" | "hardGuardrailGlobsOverridesInvariants"> | null | undefined,
): string[] {
  const configured = settings?.hardGuardrailGlobs;
  const configuredList = Array.isArray(configured) ? configured : [];
  if (settings?.hardGuardrailGlobsOverridesInvariants === true) return [...configuredList];
  return Array.from(new Set([...DEFAULT_HARD_GUARDRAIL_GLOBS, ...configuredList]));
}
