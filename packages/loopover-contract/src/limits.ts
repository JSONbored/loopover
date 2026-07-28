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
