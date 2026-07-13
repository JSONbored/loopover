import type { RepositorySettings } from "../types";

// New-brand (`loopover`) and legacy (`gittensory`) entries are both listed — this is a Set-membership guardrail
// list (order doesn't matter, unlike the loaders' priority-ordered candidate lists), so a contributor PR touching
// EITHER the new canonical `.loopover.*` config file or a still-supported legacy `.gittensory.*` one gets the same
// hard-guardrail protection (#4773 — dual-read, additive; the legacy globs are never removed).
export const CONFIG_AS_CODE_GUARDRAIL_GLOBS = [
  ".loopover.yml",
  ".loopover.yaml",
  ".loopover.json",
  ".github/loopover.yml",
  ".github/loopover.yaml",
  ".github/loopover.json",
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

export const DEFAULT_HARD_GUARDRAIL_GLOBS = [
  ...CONFIG_AS_CODE_GUARDRAIL_GLOBS,
  ...WORKFLOW_AND_RUNTIME_GUARDRAIL_GLOBS,
  ...ENGINE_DECISION_GUARDRAIL_GLOBS,
];

/**
 * Resolve hard-guardrail path globs from the already-effective repo settings. Built-in config-as-code,
 * workflow/runtime, and engine decision guardrails are invariants; repo settings may only add globs.
 */
export function resolveHardGuardrailGlobs(
  settings: Pick<RepositorySettings, "hardGuardrailGlobs"> | null | undefined,
): string[] {
  const configured = settings?.hardGuardrailGlobs;
  return Array.from(
    new Set([...DEFAULT_HARD_GUARDRAIL_GLOBS, ...(Array.isArray(configured) ? configured : [])]),
  );
}
