// Input bounds shared by the preflight/predictor surfaces (#9517).
//
// These exist in packages/loopover-engine/src/signals/preflight-limits.ts as PREFLIGHT_LIMITS, but
// this package cannot import the engine (it is a zod-only leaf, which is the property that lets
// every other surface depend on it). Restated here as the contract's own canonical copy and pinned
// against the engine's by a meta-test, so a bound cannot be raised on one side only -- the failure
// mode being a schema that rejects input the server would have accepted, or accepts input the
// server then truncates.
export const PREFLIGHT_LIMITS = {
  repoFullNameChars: 200,
  contributorLoginChars: 100,
  titleChars: 300,
  bodyChars: 20_000,
  labelChars: 100,
  changedFileChars: 300,
  testChars: 300,
  authorAssociationChars: 100,
  labels: 50,
  changedFiles: 200,
  linkedIssues: 100,
  tests: 50,
} as const;

/**
 * Cap on `changedPaths` for the gate predictor specifically.
 *
 * Deliberately larger than `PREFLIGHT_LIMITS.changedFiles` (200): paths are the cheapest possible
 * metadata and a large refactor legitimately touches more files than the preflight surface bounds,
 * so the predictor accepts a wider list than preflight does. Not a copy of that limit -- a
 * different limit for a different reason.
 */
export const PREDICT_GATE_MAX_CHANGED_PATHS = 500;

/**
 * Per-path character cap for the gate predictor.
 *
 * 400 rather than `PREFLIGHT_LIMITS.changedFileChars` (300) because the two servers disagreed: the
 * remote MCP server bounded these at 300 and the stdio server at 400. A shared contract takes the
 * WIDER of two historical bounds -- narrowing it would start rejecting input one of the two
 * servers accepts today, which is the one thing an input schema may never do.
 */
export const PREDICT_GATE_MAX_CHANGED_PATH_CHARS = 400;

/**
 * Bounds on the local-execution write-spec tools' free text (#780).
 *
 * These tools never perform a write -- they return a spec the caller runs with its own credentials
 * -- so the bounds are about keeping a spec small enough to be reviewable before it is executed,
 * not about protecting a database column. `bodyChars` matches GitHub's own 65536-character comment
 * ceiling with headroom for the wrapper the spec builder adds.
 */
export const WRITE_TOOL_LIMITS = {
  titleChars: 400,
  bodyChars: 60_000,
  branchChars: 255,
  targetFiles: 50,
} as const;

/**
 * Repo and branch identifier bounds.
 *
 * Restated from src/scenarios/input-model.ts for the same reason PREFLIGHT_LIMITS is restated from
 * the engine -- this package is a zod-only leaf and cannot import the Worker's `src/` -- and pinned
 * against it by a meta-test so the two cannot drift.
 */
export const SCENARIO_LIMITS = {
  repoFullNameChars: 200,
  branchRefChars: 200,
} as const;

// ---------------------------------------------------------------------------------------------------
// Bounds the Worker's REQUEST schemas apply (#9750).
//
// Same posture as PREFLIGHT_LIMITS above and for the same reason: api-requests.ts holds the schemas the
// API validates against, and this package cannot import the Worker or the engine. Each constant below is
// canonical in src/ or packages/loopover-engine/src/ and restated here, pinned against its original by
// test/unit/contract-api-requests.test.ts. A bound that drifts on one side only fails in the worst
// direction -- a schema that rejects input the server would have accepted, or accepts input it then
// truncates.
// ---------------------------------------------------------------------------------------------------

/** src/db/repositories.ts */
export const MAX_NOTIFICATION_MARK_READ_IDS = 100;
/** src/db/repositories.ts */
export const MAX_NOTIFICATION_DELIVERY_ID_LENGTH = 128;

/** src/signals/focus-manifest.ts */
export const MAX_FOCUS_MANIFEST_BYTES = 128 * 1024;

/** src/signals/local-scorer-diagnostics.ts */
export const MAX_LOCAL_SCORER_WARNING_COUNT = 20;
/** src/signals/local-scorer-diagnostics.ts */
export const MAX_LOCAL_SCORER_WARNING_CHARS = 1000;

/** src/scenarios/input-model.ts */
export const SCENARIO_MAX_REPO_FULL_NAME_CHARS = 200;
/** src/scenarios/input-model.ts */
export const SCENARIO_MAX_BRANCH_REF_CHARS = 200;
/** src/scenarios/input-model.ts */
export const SCENARIO_MAX_LINKED_ISSUE_NUMBERS = 50;

/** src/signals/settings-preview.ts -- the reasons the public surface reports for skipping a PR. */
export const PUBLIC_SURFACE_SKIP_REASONS = [
  "surface_off",
  "missing_author",
  "bot_author",
  "ignored_author",
  "maintainer_author",
  "miner_detection_unavailable",
  "not_official_gittensor_miner",
] as const;
