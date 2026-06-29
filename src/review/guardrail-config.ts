// Per-repo hard-guardrail path globs (paths that force MANUAL review — no auto-merge / no auto-close).
//
// Self-host note: hosted reviews and hosted policy storage are retired. Review execution uses the container-private
// `.gittensory.yml` path for repo policy; these hard guardrails remain built-in invariants so a missing private
// config cannot open the gate around CI, policy, or the review engine's own decision code.
export const DEFAULT_CRUCIAL_GUARDRAIL_GLOBS = [".github/workflows/**", "scripts/**"];

// The gate's OWN policy files, guarded for EVERY repo regardless of private config. A PR that edits the
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

// The review engine's OWN decision + safety code — its crown jewels — guarded for EVERY repo regardless of
// private config. A contributor PR that edits how the gate decides a verdict, how a merge or close executes, the
// action-mode kill-switch, scoring, auth, the CI aggregate the gate reads, or the guardrail itself must be HELD
// for the owner: the engine must never auto-merge a change to the very code that governs its own autonomy.
// These are gittensory engine-specific paths, so they never match an unrelated reviewed repo's PR (e.g.
// metagraphed has no src/rules/** or agent-action-executor.ts); like the config-as-code set above, this only
// ever WIDENS the guard.
export const ENGINE_DECISION_GUARDRAIL_GLOBS = [
  "src/rules/**", // the gate verdict (advisory) + the predicted-gate mirror
  "src/services/**", // the merge/close action executor, approval queue, and merge-failure handling — the write chokepoint
  "src/settings/agent-actions.ts", // the disposition planner (canMerge / willClose / heldForManualReview)
  "src/settings/agent-execution.ts", // the action-mode resolver + the env kill-switch backstop
  "src/settings/agent-sweep.ts", // the re-gate maintenance sweep
  "src/settings/autonomy.ts", // the autonomy-level ladder (observe → suggest → auto → auto_with_approval)
  "src/queue/**", // webhook → gate → merge/close orchestration (processors) + dead-letter handling (dlq)
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

/**
 * Resolve hard-guardrail path globs. Kept async to avoid touching the processor call graph, but this no longer
 * reads external policy storage; self-host review policy belongs in container-private `.gittensory.yml`, and these
 * engine-level guardrails are always-on invariants.
 */
export async function loadHardGuardrailGlobs(_env: Env, _repoFullName: string): Promise<string[]> {
  return [...DEFAULT_CRUCIAL_GUARDRAIL_GLOBS, ...CONFIG_AS_CODE_GUARDRAIL_GLOBS, ...ENGINE_DECISION_GUARDRAIL_GLOBS];
}
