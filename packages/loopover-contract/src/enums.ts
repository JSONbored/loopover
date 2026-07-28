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

/**
 * Lifecycle states of a plan step.
 *
 * One vocabulary, deliberately: the remote server's stateless plan-DAG tools (loopover_build_plan /
 * plan_status / record_step_result) and the miner's own plan store hold the same steps at different
 * points in their life, and a step written by one and read by the other must round-trip.
 *
 * This list said `in_progress` where both real surfaces say `running` until #9518. Nothing consumed
 * it yet, so nothing broke -- but the first consumer would have rejected every running step the
 * plan store has ever persisted.
 */
export const PLAN_STEP_STATUSES = ["pending", "running", "completed", "failed", "skipped"] as const;
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

/**
 * The secret files `loopover_admin_rotate_secret` may rotate (#9543). Closed on purpose: rotation writes to
 * a host path through the redeploy companion, so an open string would let a caller name any file the
 * companion can reach.
 */
export const ROTATABLE_SECRET_NAMES = [
  "claude_code_oauth_token",
  "github_webhook_secret",
  "loopover_api_token",
  "loopover_mcp_token",
  "loopover_mcp_admin_token",
  "pagerduty_routing_key",
] as const;

/**
 * Every `/v1/internal/jobs/*` maintenance job, and which modes each offers -- the input surface of the one
 * `loopover_fleet_run_job` tool that replaces ~30 bespoke per-job tools (#9522).
 *
 * Transcribed from the live route table and PINNED to it by test/unit/mcp-fleet-job-parity.test.ts in both
 * directions: a job route added or removed without updating this fails there, which is the only thing that
 * keeps a closed enum honest against a table it does not import (the contract package cannot reach src/).
 */
export const INTERNAL_JOB_NAMES = [
  "backfill-contributor-gate-history",
  "backfill-pr-details",
  "backfill-registered-repos",
  "backfill-repo-segment",
  "build-burden-forecasts",
  "build-contributor-decision-packs",
  "build-contributor-evidence",
  "file-upstream-drift-issues",
  "generate-review-recap",
  "generate-signal-snapshots",
  "generate-weekly-value-report",
  "rag-index",
  "refresh-contributor-activity",
  "refresh-installation-health",
  "refresh-registry",
  "refresh-scoring-model",
  "refresh-upstream-drift",
  "regate-pr",
  "repair-data-fidelity",
  "rollup-product-usage",
] as const;

export type InternalJobName = (typeof INTERNAL_JOB_NAMES)[number];

/** `enqueue` queues the job for the worker; `run` executes it inline and returns its result. */
export const INTERNAL_JOB_RUN_MODES = ["enqueue", "run"] as const;
export type InternalJobRunMode = (typeof INTERNAL_JOB_RUN_MODES)[number];

/** Not every job offers both modes; the tool rejects an unsupported pairing with the supported list. */
export const INTERNAL_JOB_MODES: Record<InternalJobName, readonly InternalJobRunMode[]> = {
  "backfill-contributor-gate-history": ["run"],
  "backfill-pr-details": ["enqueue", "run"],
  "backfill-registered-repos": ["enqueue", "run"],
  "backfill-repo-segment": ["enqueue", "run"],
  "build-burden-forecasts": ["enqueue"],
  "build-contributor-decision-packs": ["enqueue", "run"],
  "build-contributor-evidence": ["enqueue"],
  "file-upstream-drift-issues": ["enqueue", "run"],
  "generate-review-recap": ["enqueue", "run"],
  "generate-signal-snapshots": ["enqueue", "run"],
  "generate-weekly-value-report": ["enqueue", "run"],
  "rag-index": ["enqueue"],
  "refresh-contributor-activity": ["enqueue", "run"],
  "refresh-installation-health": ["run"],
  "refresh-registry": ["enqueue", "run"],
  "refresh-scoring-model": ["enqueue", "run"],
  "refresh-upstream-drift": ["enqueue", "run"],
  "regate-pr": ["enqueue"],
  "repair-data-fidelity": ["enqueue"],
  "rollup-product-usage": ["enqueue", "run"],
};

/**
 * The hosted control plane's tenant products (#9522). The routes key their registry by `${product}:${name}`
 * (#8024) and reject a product-specific field paired with the wrong product, so this stays closed.
 */
export const TENANT_PRODUCTS = ["ams", "orb"] as const;
export type TenantProduct = (typeof TENANT_PRODUCTS)[number];

/** One doctor check's verdict (#9522). `warn` exists so a degraded-but-working instance is not reported as broken. */
export const INSTANCE_CHECK_STATUSES = ["pass", "warn", "fail"] as const;
export type InstanceCheckStatus = (typeof INSTANCE_CHECK_STATUSES)[number];
