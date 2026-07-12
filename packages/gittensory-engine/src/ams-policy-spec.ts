import { parse as parseYaml } from "yaml";

import { DEFAULT_PORTFOLIO_CONVERGENCE_THRESHOLDS, type PortfolioConvergenceThresholds } from "./portfolio/non-convergence.js";

// AmsPolicySpec (#5132, Wave 3.5 follow-up). The type surface for `.gittensory-ams.yml` -- the OPERATOR's own
// execution-risk policy for their miner (AMS: the autonomous mining system this file's fields configure), as
// opposed to `.gittensory-miner.yml` / MinerGoalSpec (this file's direct structural sibling), which is the
// TARGET REPO's own preferences about being mined at all. That distinction is deliberate and load-bearing: a
// target repo's own checked-in file legitimately gets to say "don't mine me" or "focus on these paths" --
// but it must NEVER get to say "let the operator's agent spend more budget" or "submit live instead of
// observing", since that would let a malicious or compromised repo talk an operator's own miner into raising
// its own risk tolerance against that exact repo. So this type is intentionally free of any field a target
// repo could use to loosen what an operator's agent is willing to do.
//
// Resolution deliberately stays operator-local: packages/gittensory-miner/lib/ams-policy.js reads only the
// operator's own local `.gittensory-ams.yml` (in their `gittensory-miner` config dir) and otherwise uses safe
// defaults. It does not fetch a target repo's checked-in file, because that would let untrusted repo content
// loosen operator-side budget, turn, slop, or submission controls.

/** Whether a real attempt is allowed to actually submit (open a PR), or only compute + log its decision.
 *  Mirrors `src/settings/autonomy.ts`'s deny-by-default dial: "observe" still runs every real signal/decision,
 *  it just never lets `wouldBeAction` become a real write. */
export type AmsSubmissionMode = "observe" | "enforce";

/** The strictest self-review slop band still allowed to reach submission (`isSlopBandWithinThreshold`,
 *  submission-gate.ts). Lower = stricter: "clean" only lets the cleanest band through. */
export type AmsSlopThreshold = "clean" | "low" | "elevated" | "high";

/** The three Governor cap ceilings (`GovernorCapLimits`, budget-cap.ts) for one attempt. */
export type AmsCapLimits = {
  /** Maximum cumulative budget/cost units (may be fractional, e.g. a dollar cost) permitted for one attempt. */
  budget: number;
  /** Maximum cumulative turns/iterations permitted for one attempt. */
  turns: number;
  /** Termination ceiling: maximum elapsed session time in milliseconds for one attempt. */
  elapsedMs: number;
};

/** Per-operator AMS execution policy parsed from `.gittensory-ams.yml`. See {@link DEFAULT_AMS_POLICY_SPEC}. */
export type AmsPolicySpec = {
  /** Whether a real attempt may actually submit. Default: "observe" (deny-by-default). */
  submissionMode: AmsSubmissionMode;
  /** The strictest self-review slop band still allowed to reach submission. Default: "low" (conservative). */
  slopThreshold: AmsSlopThreshold;
  /** Governor cap ceilings for one attempt. Default: { budget: 5, turns: 20, elapsedMs: 1_800_000 } (30 min). */
  capLimits: AmsCapLimits;
  /** Non-convergence detector thresholds. Default: {@link DEFAULT_PORTFOLIO_CONVERGENCE_THRESHOLDS}. */
  convergenceThresholds: PortfolioConvergenceThresholds;
  /** Hard ceiling on the iterate loop's own iteration count (IterateLoopInput.maxIterations). Default: 3. */
  maxIterations: number;
  /** Per-iteration turn budget passed to the coding-agent driver (IterateLoopInput.maxTurnsPerIteration).
   *  Default: 6. */
  maxTurnsPerIteration: number;
};

/** The tolerant parser result for `.gittensory-ams.yml`. Mirrors `ParsedMinerGoalSpec`'s present/warnings shape. */
export type ParsedAmsPolicySpec = {
  present: boolean;
  spec: AmsPolicySpec;
  warnings: string[];
};

/**
 * The safe defaults applied when a field is absent from `.gittensory-ams.yml` (or the file itself is
 * missing). Deep-frozen: a shared singleton, clone before layering overrides on top.
 */
export const DEFAULT_AMS_POLICY_SPEC: Readonly<AmsPolicySpec> = Object.freeze({
  submissionMode: "observe",
  slopThreshold: "low",
  capLimits: Object.freeze({ budget: 5, turns: 20, elapsedMs: 1_800_000 }),
  convergenceThresholds: Object.freeze({ ...DEFAULT_PORTFOLIO_CONVERGENCE_THRESHOLDS }),
  maxIterations: 3,
  maxTurnsPerIteration: 6,
});

const MAX_AMS_POLICY_SPEC_BYTES = 8_192;

function cloneDefaultAmsPolicySpec(): AmsPolicySpec {
  return {
    submissionMode: DEFAULT_AMS_POLICY_SPEC.submissionMode,
    slopThreshold: DEFAULT_AMS_POLICY_SPEC.slopThreshold,
    capLimits: { ...DEFAULT_AMS_POLICY_SPEC.capLimits },
    convergenceThresholds: { ...DEFAULT_AMS_POLICY_SPEC.convergenceThresholds },
    maxIterations: DEFAULT_AMS_POLICY_SPEC.maxIterations,
    maxTurnsPerIteration: DEFAULT_AMS_POLICY_SPEC.maxTurnsPerIteration,
  };
}

function emptyAmsPolicySpec(warnings: string[] = []): ParsedAmsPolicySpec {
  return { present: false, spec: cloneDefaultAmsPolicySpec(), warnings };
}

function normalizeSubmissionMode(value: unknown, fallback: AmsSubmissionMode, warnings: string[]): AmsSubmissionMode {
  if (value === undefined || value === null) return fallback;
  if (value === "observe" || value === "enforce") return value;
  warnings.push(`AmsPolicySpec field "submissionMode" must be one of observe, enforce; falling back to "${fallback}".`);
  return fallback;
}

function normalizeSlopThreshold(value: unknown, fallback: AmsSlopThreshold, warnings: string[]): AmsSlopThreshold {
  if (value === undefined || value === null) return fallback;
  if (value === "clean" || value === "low" || value === "elevated" || value === "high") return value;
  warnings.push(`AmsPolicySpec field "slopThreshold" must be one of clean, low, elevated, high; falling back to "${fallback}".`);
  return fallback;
}

function normalizePositiveNumber(value: unknown, field: string, fallback: number, warnings: string[]): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    warnings.push(`AmsPolicySpec field "${field}" must be a non-negative number; falling back to ${fallback}.`);
    return fallback;
  }
  return value;
}

/** Like normalizePositiveNumber, but floors to a whole count -- for fields that are semantically integer
 *  counts (an iteration/turn budget), matching MinerGoalSpec's own normalizePositiveInteger convention. */
function normalizeNonNegativeInteger(value: unknown, field: string, fallback: number, warnings: string[]): number {
  const normalized = normalizePositiveNumber(value, field, fallback, warnings);
  return Math.floor(normalized);
}

function normalizeCapLimits(value: unknown, fallback: AmsCapLimits, warnings: string[]): AmsCapLimits {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push('AmsPolicySpec field "capLimits" must be a mapping; falling back to defaults.');
    return fallback;
  }
  const record = value as Record<string, unknown>;
  return {
    budget: normalizePositiveNumber(record.budget, "capLimits.budget", fallback.budget, warnings),
    turns: normalizePositiveNumber(record.turns, "capLimits.turns", fallback.turns, warnings),
    elapsedMs: normalizePositiveNumber(record.elapsedMs, "capLimits.elapsedMs", fallback.elapsedMs, warnings),
  };
}

function normalizeConvergenceThresholds(
  value: unknown,
  fallback: PortfolioConvergenceThresholds,
  warnings: string[],
): PortfolioConvergenceThresholds {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push('AmsPolicySpec field "convergenceThresholds" must be a mapping; falling back to defaults.');
    return fallback;
  }
  const record = value as Record<string, unknown>;
  return {
    maxConsecutiveFailures: normalizePositiveNumber(
      record.maxConsecutiveFailures,
      "convergenceThresholds.maxConsecutiveFailures",
      fallback.maxConsecutiveFailures,
      warnings,
    ),
    maxReenqueues: normalizePositiveNumber(record.maxReenqueues, "convergenceThresholds.maxReenqueues", fallback.maxReenqueues, warnings),
  };
}

function hasConfiguredPolicyFields(spec: AmsPolicySpec): boolean {
  return (
    spec.submissionMode !== DEFAULT_AMS_POLICY_SPEC.submissionMode ||
    spec.slopThreshold !== DEFAULT_AMS_POLICY_SPEC.slopThreshold ||
    spec.capLimits.budget !== DEFAULT_AMS_POLICY_SPEC.capLimits.budget ||
    spec.capLimits.turns !== DEFAULT_AMS_POLICY_SPEC.capLimits.turns ||
    spec.capLimits.elapsedMs !== DEFAULT_AMS_POLICY_SPEC.capLimits.elapsedMs ||
    spec.convergenceThresholds.maxConsecutiveFailures !== DEFAULT_AMS_POLICY_SPEC.convergenceThresholds.maxConsecutiveFailures ||
    spec.convergenceThresholds.maxReenqueues !== DEFAULT_AMS_POLICY_SPEC.convergenceThresholds.maxReenqueues ||
    spec.maxIterations !== DEFAULT_AMS_POLICY_SPEC.maxIterations ||
    spec.maxTurnsPerIteration !== DEFAULT_AMS_POLICY_SPEC.maxTurnsPerIteration
  );
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) as number;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * Tolerantly normalize an already-parsed `.gittensory-ams.yml` object into a {@link ParsedAmsPolicySpec}.
 * Never throws: malformed shapes degrade to safe defaults and accumulate warnings.
 */
export function parseAmsPolicySpec(raw: unknown): ParsedAmsPolicySpec {
  if (raw === undefined || raw === null) return emptyAmsPolicySpec();
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return emptyAmsPolicySpec(["AmsPolicySpec must be a mapping of fields; ignoring malformed config and falling back to safe defaults."]);
  }
  const record = raw as Record<string, unknown>;
  const warnings: string[] = [];
  const spec: AmsPolicySpec = {
    submissionMode: normalizeSubmissionMode(record.submissionMode, DEFAULT_AMS_POLICY_SPEC.submissionMode, warnings),
    slopThreshold: normalizeSlopThreshold(record.slopThreshold, DEFAULT_AMS_POLICY_SPEC.slopThreshold, warnings),
    capLimits: normalizeCapLimits(record.capLimits, DEFAULT_AMS_POLICY_SPEC.capLimits, warnings),
    convergenceThresholds: normalizeConvergenceThresholds(
      record.convergenceThresholds,
      DEFAULT_AMS_POLICY_SPEC.convergenceThresholds,
      warnings,
    ),
    maxIterations: normalizeNonNegativeInteger(record.maxIterations, "maxIterations", DEFAULT_AMS_POLICY_SPEC.maxIterations, warnings),
    maxTurnsPerIteration: normalizeNonNegativeInteger(
      record.maxTurnsPerIteration,
      "maxTurnsPerIteration",
      DEFAULT_AMS_POLICY_SPEC.maxTurnsPerIteration,
      warnings,
    ),
  };
  if (!hasConfiguredPolicyFields(spec)) {
    warnings.push("AmsPolicySpec contained no recognized non-default policy fields; falling back to safe defaults.");
    return { present: false, spec: cloneDefaultAmsPolicySpec(), warnings };
  }
  return { present: true, spec, warnings };
}

/**
 * Parse raw `.gittensory-ams.yml` file content (JSON or YAML). Malformed content degrades to an absent
 * policy spec with a warning rather than throwing, mirroring `parseMinerGoalSpecContent`.
 */
export function parseAmsPolicySpecContent(content: string | null | undefined): ParsedAmsPolicySpec {
  if (content === undefined || content === null || content.trim() === "") return emptyAmsPolicySpec();
  if (utf8ByteLength(content) > MAX_AMS_POLICY_SPEC_BYTES) {
    return emptyAmsPolicySpec([`AmsPolicySpec content exceeded ${MAX_AMS_POLICY_SPEC_BYTES} bytes; ignoring it and falling back to safe defaults.`]);
  }
  const trimmed = content.trim();
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  let parsed: unknown;
  try {
    parsed = looksLikeJson ? JSON.parse(trimmed) : parseYaml(trimmed);
  } catch {
    return emptyAmsPolicySpec([
      looksLikeJson
        ? "AmsPolicySpec content was not valid JSON; ignoring it and falling back to safe defaults."
        : "AmsPolicySpec content was not valid YAML; ignoring it and falling back to safe defaults.",
    ]);
  }
  return parseAmsPolicySpec(parsed);
}

/** The documented `.gittensory-ams` file-discovery order (first match wins), mirroring `MINER_GOAL_SPEC_FILENAMES`. */
export const AMS_POLICY_SPEC_FILENAMES = [".gittensory-ams.yml", ".github/gittensory-ams.yml", ".gittensory-ams.json", ".github/gittensory-ams.json"] as const;
