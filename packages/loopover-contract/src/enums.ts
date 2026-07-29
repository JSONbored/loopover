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

/**
 * The engine's FULL action-class list (#9762).
 *
 * A superset of MAINTAIN_ACTION_CLASSES: the autonomy record is keyed by every class the agent can take,
 * while the maintain dial exposes only the operator-settable subset. Restated here and pinned against
 * @loopover/engine's own by a meta-test, the posture limits.ts established -- the settings response schema
 * needs this list and cannot import the engine.
 */
export const AGENT_ACTION_CLASSES = [
  "review",
  "request_changes",
  "approve",
  "merge",
  "close",
  "label",
  "review_state_label",
  "update_branch",
  "assign",
] as const;
export type AgentActionClass = (typeof AGENT_ACTION_CLASSES)[number];
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
 * Every `/v1/internal/jobs/*` maintenance job -- the input surface of the one `loopover_fleet_run_job` tool
 * that replaces ~30 bespoke per-job tools (#9522). All 20 of them, with nothing excluded.
 *
 * `messageType` exists because the route path is NOT always the queue message type, and assuming it was
 * would have enqueued messages the dispatcher silently drops: `rag-index` sends `rag-index-repo` and
 * `regate-pr` sends `agent-regate-pr`. `null` means the job has no queue message at all -- it is run-only,
 * and src/mcp/server.ts dispatches it to the same function its `/run` route calls.
 *
 * `modes` is per job because most offer both but seven do not; an unsupported pairing is answered with the
 * supported list rather than 404'ing against a route that was never there.
 *
 * Pinned in every direction by test/unit/mcp-fleet-job-parity.test.ts (route table vs this table, and each
 * job's modes), and each non-null messageType is asserted to be a real JobMessage type at COMPILE time in
 * src/mcp/server.ts -- the contract package cannot import src/, so a transcription is only honest if
 * something on the src side checks it.
 */
export const INTERNAL_JOB_RUN_MODES = ["enqueue", "run"] as const;
export type InternalJobRunMode = (typeof INTERNAL_JOB_RUN_MODES)[number];

export const INTERNAL_JOB_SPEC = {
  "backfill-contributor-gate-history": { messageType: null, modes: ["run"] },
  "backfill-pr-details": { messageType: "backfill-pr-details", modes: ["enqueue", "run"] },
  "backfill-registered-repos": { messageType: "backfill-registered-repos", modes: ["enqueue", "run"] },
  "backfill-repo-segment": { messageType: "backfill-repo-segment", modes: ["enqueue", "run"] },
  "build-burden-forecasts": { messageType: "build-burden-forecasts", modes: ["enqueue"] },
  "build-contributor-decision-packs": { messageType: "build-contributor-decision-packs", modes: ["enqueue", "run"] },
  "build-contributor-evidence": { messageType: "build-contributor-evidence", modes: ["enqueue"] },
  "file-upstream-drift-issues": { messageType: "file-upstream-drift-issues", modes: ["enqueue", "run"] },
  "generate-review-recap": { messageType: "generate-review-recap", modes: ["enqueue", "run"] },
  "generate-signal-snapshots": { messageType: "generate-signal-snapshots", modes: ["enqueue", "run"] },
  "generate-weekly-value-report": { messageType: "generate-weekly-value-report", modes: ["enqueue", "run"] },
  "rag-index": { messageType: "rag-index-repo", modes: ["enqueue"] },
  "refresh-contributor-activity": { messageType: "refresh-contributor-activity", modes: ["enqueue", "run"] },
  "refresh-installation-health": { messageType: null, modes: ["run"] },
  "refresh-registry": { messageType: "refresh-registry", modes: ["enqueue", "run"] },
  "refresh-scoring-model": { messageType: "refresh-scoring-model", modes: ["enqueue", "run"] },
  "refresh-upstream-drift": { messageType: "refresh-upstream-drift", modes: ["enqueue", "run"] },
  "regate-pr": { messageType: "agent-regate-pr", modes: ["enqueue"] },
  "repair-data-fidelity": { messageType: "repair-data-fidelity", modes: ["enqueue"] },
  "rollup-product-usage": { messageType: "rollup-product-usage", modes: ["enqueue", "run"] },
} as const satisfies Record<string, { messageType: string | null; modes: readonly InternalJobRunMode[] }>;

export const INTERNAL_JOB_NAMES = Object.keys(INTERNAL_JOB_SPEC) as [InternalJobName, ...InternalJobName[]];

export type InternalJobName = keyof typeof INTERNAL_JOB_SPEC;


/**
 * The hosted control plane's tenant products (#9522). The routes key their registry by `${product}:${name}`
 * (#8024) and reject a product-specific field paired with the wrong product, so this stays closed.
 */
export const TENANT_PRODUCTS = ["ams", "orb"] as const;
export type TenantProduct = (typeof TENANT_PRODUCTS)[number];

/** One doctor check's verdict (#9522). `warn` exists so a degraded-but-working instance is not reported as broken. */
export const INSTANCE_CHECK_STATUSES = ["pass", "warn", "fail"] as const;
export type InstanceCheckStatus = (typeof INSTANCE_CHECK_STATUSES)[number];

/**
 * The AMS miner's own vocabularies (#9660).
 *
 * Restated here for the usual reason -- this package cannot import the miner -- and pinned against the live
 * lists by test/unit/contract-registry.test.ts. They lived in tools/miner.ts until now, which put them
 * outside even the convention that a shared vocabulary lives in this file, and two of them appear in OUTPUT
 * schemas: a new queue status or run state would make a tool's real `structuredContent` fail the schema that
 * same tool advertises.
 */
/** packages/loopover-miner/lib/portfolio-queue.ts */
export const QUEUE_STATUSES = ["queued", "in_progress", "done"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];
/** packages/loopover-miner/lib/claim-ledger.ts */
export const CLAIM_STATUSES = ["active", "released", "expired"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
/** packages/loopover-miner/lib/run-state.ts */
export const MINER_RUN_STATES = ["idle", "discovering", "planning", "preparing"] as const;
export type MinerRunState = (typeof MINER_RUN_STATES)[number];
