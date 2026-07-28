// Shared enum vocabularies (#9517).
//
// These existed as hand-copied literals in packages/loopover-mcp/bin/loopover-mcp.ts because that
// package resolves @loopover/engine through the PUBLISHED package, whose export map never surfaced
// them -- so importing the canonical list would have meant widening the engine's public API
// (#6153). The comment on those copies noted the drift it invited "has bitten once already": the
// stdio list carried "suggest"/"propose" for the whole life of #4620 after the server dropped
// them, turning a clear client-side error into a confusing 400 from the API.
//
// This package is the answer that was missing: a zod-only leaf with no dependencies, so every
// surface (Worker, both stdio bins, miner, UI) can import the same values without pulling the
// engine in behind them.
//
// SCOPE NOTE: packages/loopover-engine/src/settings/autonomy.ts still declares its own
// AUTONOMY_LEVELS / AGENT_ACTION_CLASSES, because it is an engine-parity twin of
// src/settings/autonomy.ts and inverting that pair to import from here is #9518's batch work, not
// the keystone's. Until then the values below are pinned against the engine's by a meta-test, so
// the two cannot silently disagree.

/**
 * Per-action-class autonomy levels. Mirrors the engine's `AUTONOMY_LEVELS`.
 *
 * `observe` records what it would have done; `auto_with_approval` stages an action for a human
 * decision; `auto` acts directly.
 */
export const AUTONOMY_LEVELS = ["observe", "auto_with_approval", "auto"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/**
 * The action classes an operator may configure autonomy for.
 *
 * Deliberately NOT the engine's full `AGENT_ACTION_CLASSES` -- it is the operator-settable subset
 * the maintain surface exposes, matching `MAINTAIN_AUTONOMY_ACTION_CLASSES` in src/mcp/server.ts.
 * Do not "sync" this to the engine's list; the difference is the point.
 */
export const MAINTAIN_ACTION_CLASSES = ["review", "request_changes", "approve", "merge", "close", "label"] as const;
export type MaintainActionClass = (typeof MAINTAIN_ACTION_CLASSES)[number];

/**
 * Action classes accepted when proposing an action into the approval queue (#6744).
 *
 * Derived rather than restated: it is exactly the operator-settable set plus `review_state_label`,
 * and expressing that as code means the two can never drift apart the way three independent
 * literal lists did.
 */
export const PROPOSE_ACTION_CLASSES = [...MAINTAIN_ACTION_CLASSES, "review_state_label"] as const;
export type ProposeActionClass = (typeof PROPOSE_ACTION_CLASSES)[number];

/** Test frameworks the boundary-test and test-evidence surfaces recognize by name. */
export const TEST_FRAMEWORKS = ["vitest", "jest", "pytest", "go-test", "rspec", "cargo-test"] as const;
export type TestFramework = (typeof TEST_FRAMEWORKS)[number];

/** Lifecycle states of a plan step in the stateless plan-DAG tools. */
export const PLAN_STEP_STATUSES = ["pending", "in_progress", "completed", "skipped", "failed"] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

/** Verdicts the pre-start feasibility surfaces return. */
export const FEASIBILITY_VERDICTS = ["go", "raise", "avoid"] as const;
export type FeasibilityVerdict = (typeof FEASIBILITY_VERDICTS)[number];

/**
 * Why LoopOver's automated reviewer deliberately stayed quiet on a PR -- the filter vocabulary the
 * skipped-PR audit accepts. Mirrors `PUBLIC_SURFACE_SKIP_REASONS`
 * (src/signals/settings-preview.ts), pinned against it by a meta-test for the same reason the
 * autonomy enums above are: this package cannot import the Worker's `src/`, and a filter value that
 * silently stops matching is worse than one that fails loudly.
 */
export const PUBLIC_SURFACE_SKIP_REASONS = [
  "surface_off",
  "missing_author",
  "bot_author",
  "ignored_author",
  "maintainer_author",
  "miner_detection_unavailable",
  "not_official_gittensor_miner",
] as const;
export type PublicSurfaceSkipReason = (typeof PUBLIC_SURFACE_SKIP_REASONS)[number];

/**
 * Scope selector for WRITING the self-hosted private config: the deployment-wide default layer, or
 * one repository's override layer. Only real files are writable.
 */
export const CONFIG_ADMIN_WRITE_SCOPES = ["global", "repo"] as const;
export type ConfigAdminWriteScope = (typeof CONFIG_ADMIN_WRITE_SCOPES)[number];

/**
 * Scope selector for READING it. A superset of the write scopes: `effective` is the merged view
 * (shared base + global default + per-repo override) that no single file corresponds to, which is
 * exactly why it can be read but never written.
 */
export const CONFIG_ADMIN_READ_SCOPES = ["effective", ...CONFIG_ADMIN_WRITE_SCOPES] as const;
export type ConfigAdminReadScope = (typeof CONFIG_ADMIN_READ_SCOPES)[number];
