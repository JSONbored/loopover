import type { RepositorySettings } from "../types";

// Built-in defense-in-depth defaults used when the operator has not configured guardrails at all.
// A concrete `hardGuardrailGlobs: []` in private global or repo config remains the explicit opt-out.
export const DEFAULT_CRUCIAL_GUARDRAIL_GLOBS = [
  ".github/workflows/**",
  "scripts/**",
];

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
  "src/scoring/**",
  "src/auth/**",
  "src/review/safety.ts",
  "src/review/guardrail-config.ts",
  "src/review/cutover-gate.ts",
  "src/review/linked-issue-hard-rules.ts",
  "src/review/outcomes-wire.ts",
];

export const SELFHOST_RUNTIME_GUARDRAIL_GLOBS = [
  "src/selfhost/**",
  "src/server.ts",
  "src/db/**",
  "Dockerfile",
  "docker-compose*.yml*",
  "docker-compose*.yaml*",
  "compose*.yml*",
  "compose*.yaml*",
  "systemd/**",
];

export const DEFAULT_HARD_GUARDRAIL_GLOBS = [
  ...DEFAULT_CRUCIAL_GUARDRAIL_GLOBS,
  ...CONFIG_AS_CODE_GUARDRAIL_GLOBS,
  ...ENGINE_DECISION_GUARDRAIL_GLOBS,
  ...SELFHOST_RUNTIME_GUARDRAIL_GLOBS,
];

/**
 * Resolve hard-guardrail path globs from already-effective repo settings. Missing/null settings keep built-in
 * safety defaults; a concrete list replaces them wholesale, and `[]` is the explicit opt-out.
 */
export function resolveHardGuardrailGlobs(
  settings: Pick<RepositorySettings, "hardGuardrailGlobs"> | null | undefined,
): string[] {
  const configured = settings?.hardGuardrailGlobs;
  return Array.isArray(configured)
    ? [...configured]
    : [...DEFAULT_HARD_GUARDRAIL_GLOBS];
}
