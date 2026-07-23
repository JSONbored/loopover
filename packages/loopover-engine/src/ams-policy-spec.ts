import { parse as parseYaml } from "yaml";

import { DEFAULT_PORTFOLIO_CONVERGENCE_THRESHOLDS, type PortfolioConvergenceThresholds } from "./portfolio/non-convergence.js";
import { AUTONOMY_LEVELS } from "./settings/autonomy.js";
import type { AutonomyLevel } from "./types/manifest-deps-types.js";

// Re-exported so the barrel can surface it from this module's own export block, alongside every other
// AmsPolicySpec field type (AmsSubmissionMode/AmsSlopThreshold/AmsCapLimits) rather than from a second place.
export type { AutonomyLevel };

// AmsPolicySpec (#5132, Wave 3.5 follow-up). The type surface for `.loopover-ams.yml` -- the OPERATOR's own
// execution-risk policy for their miner (AMS: the autonomous mining system this file's fields configure), as
// opposed to `.loopover-miner.yml` / MinerGoalSpec (this file's direct structural sibling), which is the
// TARGET REPO's own preferences about being mined at all. That distinction is deliberate and load-bearing: a
// target repo's own checked-in file legitimately gets to say "don't mine me" or "focus on these paths" --
// but it must NEVER get to say "let the operator's agent spend more budget" or "submit live instead of
// observing", since that would let a malicious or compromised repo talk an operator's own miner into raising
// its own risk tolerance against that exact repo. So this type is intentionally free of any field a target
// repo could use to loosen what an operator's agent is willing to do.
//
// Resolution deliberately stays operator-local: packages/loopover-miner/lib/ams-policy.js reads only the
// operator's own local `.loopover-ams.yml` (in their `loopover-miner` config dir) and otherwise uses safe
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

/** Curated ecosystem identifiers an operator may declare in {@link AmsNetworkAllowlist.ecosystems} -- the
 *  language/package-manager registries #7648 ratified as a safe default category. A closed set (not free
 *  text) so a typo degrades to a warning + drop, not a silently-ignored no-op. */
export const AMS_NETWORK_ALLOWLIST_ECOSYSTEMS = ["npm", "pypi", "crates", "go", "rubygems", "packagist", "maven", "nuget"] as const;
export type AmsNetworkAllowlistEcosystem = (typeof AMS_NETWORK_ALLOWLIST_ECOSYSTEMS)[number];

const MAX_NETWORK_ALLOWLIST_ECOSYSTEMS = AMS_NETWORK_ALLOWLIST_ECOSYSTEMS.length;
const MAX_NETWORK_ALLOWLIST_EXTRA_HOSTS = 50;
// RFC 1123 hostname shape (labels of letters/digits/hyphens, dot-separated, no leading/trailing hyphen per
// label) -- deliberately conservative since a future enforcement implementation (#7857's still-open mechanism
// half) will feed this straight into firewall/proxy rules; garbage here would be that implementation's problem
// to sanitize a second time.
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/** Operator-declared network-egress allowlist additions (#7857, config-surface half of #7648's ratified
 *  design) for AMS sandboxed execution. Deliberately operator-local ONLY, mirroring this whole file's own
 *  scope (see the module header) -- never fetched from a target repo. #7648 ratified "the repo's declared
 *  language-ecosystem registries" as a default-allowlist category, but deriving that from a TARGET repo's own
 *  manifest is unsafe: a malicious repo could fabricate a manifest entry to smuggle an attacker-controlled
 *  host into its own attempt's allowlist -- exactly the kind of repo-loosens-its-own-constraints hole this
 *  file's whole design already guards against. The operator declares which ecosystems and any extra hosts
 *  their own repos legitimately need instead.
 *
 *  INERT today: no OS-level network-egress enforcement exists yet for AMS sandboxed execution (#7857's
 *  mechanism half is still open, deliberately deferred separately from this config surface). This type is
 *  what a future enforcement implementation will read; landing it now settles the trust-boundary question
 *  ahead of that work instead of leaving it to be reopened once enforcement is being built. */
export type AmsNetworkAllowlist = {
  /** Ecosystem registries to allow, beyond the two categories #7648 ratified as always-on (OS package
   *  registries, the repo's own git remote) -- those aren't declared here since they apply unconditionally. */
  ecosystems: AmsNetworkAllowlistEcosystem[];
  /** Additional specific hostnames to allow beyond the curated ecosystem categories, e.g. a project's own
   *  third-party API (#7648's "requesting broader access" case). */
  extraHosts: string[];
};

/** Per-operator AMS execution policy parsed from `.loopover-ams.yml`. See {@link DEFAULT_AMS_POLICY_SPEC}. */
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
  /** How much autonomy the iterate loop has over its OWN self-directed pass -> handoff transition (#6559).
   *
   *  Default: "auto" -- deliberately NOT settings/autonomy.ts's own DEFAULT_AUTONOMY_LEVEL of "observe". That
   *  default is right for the maintainer auto-maintain dial, which gates a capability with no prior acting
   *  behavior. This field gates something that already happens unconditionally today (a clean self-review pass
   *  hands off), so defaulting to "observe" would silently change behavior for every operator who leaves the
   *  field unset. Inert until the consultation issue reads it. */
  selfLoopAutonomy: AutonomyLevel;
  /** Operator-declared network-egress allowlist additions (#7857). Default: `{ ecosystems: [], extraHosts: [] }`
   *  -- no additions beyond the always-on OS-registry/git-remote defaults. INERT until #7857's OS-level
   *  enforcement mechanism is built; see {@link AmsNetworkAllowlist}'s own doc comment. */
  networkAllowlist: AmsNetworkAllowlist;
  /** Whether the min-rank skip threshold may self-adjust from backtest evidence (#8187, epic #8172). The
   *  FIRST of the double gates: with this OFF (the default) the apply/revert commands refuse and any
   *  previously-applied override reads as absent; the second gate is the per-apply `--approve` flag. */
  minRankAutotuneEnabled: boolean;
};

/** The tolerant parser result for `.loopover-ams.yml`. Mirrors `ParsedMinerGoalSpec`'s present/warnings shape. */
export type ParsedAmsPolicySpec = {
  present: boolean;
  spec: AmsPolicySpec;
  warnings: string[];
};

/**
 * The safe defaults applied when a field is absent from `.loopover-ams.yml` (or the file itself is
 * missing). Deep-frozen: a shared singleton, clone before layering overrides on top.
 */
export const DEFAULT_AMS_POLICY_SPEC: Readonly<AmsPolicySpec> = Object.freeze({
  submissionMode: "observe",
  slopThreshold: "low",
  capLimits: Object.freeze({ budget: 5, turns: 20, elapsedMs: 1_800_000 }),
  convergenceThresholds: Object.freeze({ ...DEFAULT_PORTFOLIO_CONVERGENCE_THRESHOLDS }),
  maxIterations: 3,
  maxTurnsPerIteration: 6,
  selfLoopAutonomy: "auto",
  networkAllowlist: Object.freeze({ ecosystems: [], extraHosts: [] }),
  minRankAutotuneEnabled: false,
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
    selfLoopAutonomy: DEFAULT_AMS_POLICY_SPEC.selfLoopAutonomy,
    networkAllowlist: {
      ecosystems: [...DEFAULT_AMS_POLICY_SPEC.networkAllowlist.ecosystems],
      extraHosts: [...DEFAULT_AMS_POLICY_SPEC.networkAllowlist.extraHosts],
    },
    minRankAutotuneEnabled: DEFAULT_AMS_POLICY_SPEC.minRankAutotuneEnabled,
  };
}

function emptyAmsPolicySpec(warnings: string[] = []): ParsedAmsPolicySpec {
  return { present: false, spec: cloneDefaultAmsPolicySpec(), warnings };
}

function normalizeBooleanFlag(value: unknown, field: string, fallback: boolean, warnings: string[]): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  warnings.push(`AmsPolicySpec field "${field}" must be a boolean; falling back to ${fallback}.`);
  return fallback;
}

function normalizeSubmissionMode(value: unknown, fallback: AmsSubmissionMode, warnings: string[]): AmsSubmissionMode {
  if (value === undefined || value === null) return fallback;
  if (value === "observe" || value === "enforce") return value;
  warnings.push(`AmsPolicySpec field "submissionMode" must be one of observe, enforce; falling back to "${fallback}".`);
  return fallback;
}

function normalizeSelfLoopAutonomy(value: unknown, fallback: AutonomyLevel, warnings: string[]): AutonomyLevel {
  if (value === undefined || value === null) return fallback;
  // Validated against AUTONOMY_LEVELS rather than a literal list so this can't drift from the vocabulary the
  // rest of the codebase resolves against.
  if (typeof value === "string" && (AUTONOMY_LEVELS as readonly string[]).includes(value)) return value as AutonomyLevel;
  warnings.push(
    `AmsPolicySpec field "selfLoopAutonomy" must be one of ${AUTONOMY_LEVELS.join(", ")}; falling back to "${fallback}".`,
  );
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
 *  counts (an iteration/turn budget). Its floor is >= 0: unlike MinerGoalSpec's normalizePositiveInteger
 *  (which rejects anything < 1 after flooring), 0 is deliberately accepted here (see the parser test's
 *  zero-budget case) -- a 0 budget is a meaningful "do nothing" setting, not a malformed value. */
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

/** Validates each entry independently and DROPS invalid ones rather than falling back to the whole list --
 *  unlike this file's single-value fields (one bad value = the whole field reverts to default), a list field
 *  reverting entirely on one typo would silently discard every other correctly-typed entry alongside it. */
function normalizeEcosystemList(value: unknown, fallback: AmsNetworkAllowlistEcosystem[], warnings: string[]): AmsNetworkAllowlistEcosystem[] {
  // A fresh copy, not `fallback` by reference: unlike this file's number-valued fields, an array is mutable,
  // so passing through the DEFAULT_AMS_POLICY_SPEC singleton's own array here would let a caller who mutates
  // their OWN resolved spec's list (e.g. `.push`) silently corrupt every other caller's shared defaults too.
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value)) {
    warnings.push('AmsPolicySpec field "networkAllowlist.ecosystems" must be an array; falling back to defaults.');
    return [...fallback];
  }
  const known = new Set<string>(AMS_NETWORK_ALLOWLIST_ECOSYSTEMS);
  const result: AmsNetworkAllowlistEcosystem[] = [];
  for (const entry of value.slice(0, MAX_NETWORK_ALLOWLIST_ECOSYSTEMS)) {
    if (typeof entry === "string" && known.has(entry) && !result.includes(entry as AmsNetworkAllowlistEcosystem)) {
      result.push(entry as AmsNetworkAllowlistEcosystem);
      continue;
    }
    warnings.push(
      `AmsPolicySpec field "networkAllowlist.ecosystems" entry ${JSON.stringify(entry)} must be one of ${AMS_NETWORK_ALLOWLIST_ECOSYSTEMS.join(", ")}; dropping it.`,
    );
  }
  return result;
}

/** Same drop-invalid-entries approach as {@link normalizeEcosystemList}. Hostname shape is validated (not just
 *  "is this a string") because this feeds a future firewall/proxy enforcement implementation directly -- see
 *  {@link AmsNetworkAllowlist}'s own doc comment. */
function normalizeExtraHosts(value: unknown, fallback: string[], warnings: string[]): string[] {
  // Fresh copies throughout, same reasoning as normalizeEcosystemList's own comment above.
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value)) {
    warnings.push('AmsPolicySpec field "networkAllowlist.extraHosts" must be an array; falling back to defaults.');
    return [...fallback];
  }
  const result: string[] = [];
  for (const entry of value.slice(0, MAX_NETWORK_ALLOWLIST_EXTRA_HOSTS)) {
    if (typeof entry === "string" && HOSTNAME_RE.test(entry) && !result.includes(entry)) {
      result.push(entry);
      continue;
    }
    warnings.push(`AmsPolicySpec field "networkAllowlist.extraHosts" entry ${JSON.stringify(entry)} is not a valid hostname; dropping it.`);
  }
  return result;
}

function normalizeNetworkAllowlist(value: unknown, fallback: AmsNetworkAllowlist, warnings: string[]): AmsNetworkAllowlist {
  // Fresh array copies in the fallback object too, same reasoning as normalizeEcosystemList's own comment.
  if (value === undefined || value === null) return { ecosystems: [...fallback.ecosystems], extraHosts: [...fallback.extraHosts] };
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push('AmsPolicySpec field "networkAllowlist" must be a mapping; falling back to defaults.');
    return { ecosystems: [...fallback.ecosystems], extraHosts: [...fallback.extraHosts] };
  }
  const record = value as Record<string, unknown>;
  return {
    ecosystems: normalizeEcosystemList(record.ecosystems, fallback.ecosystems, warnings),
    extraHosts: normalizeExtraHosts(record.extraHosts, fallback.extraHosts, warnings),
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
    spec.maxTurnsPerIteration !== DEFAULT_AMS_POLICY_SPEC.maxTurnsPerIteration ||
    spec.selfLoopAutonomy !== DEFAULT_AMS_POLICY_SPEC.selfLoopAutonomy ||
    // Default is always { ecosystems: [], extraHosts: [] } (see DEFAULT_AMS_POLICY_SPEC) -- any entry at all
    // means the operator configured something, so length alone is the right "differs from default" check;
    // no need to compare contents.
    spec.networkAllowlist.ecosystems.length > 0 ||
    spec.networkAllowlist.extraHosts.length > 0 ||
    spec.minRankAutotuneEnabled !== DEFAULT_AMS_POLICY_SPEC.minRankAutotuneEnabled
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
 * Tolerantly normalize an already-parsed `.loopover-ams.yml` object into a {@link ParsedAmsPolicySpec}.
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
    selfLoopAutonomy: normalizeSelfLoopAutonomy(
      record.selfLoopAutonomy,
      DEFAULT_AMS_POLICY_SPEC.selfLoopAutonomy,
      warnings,
    ),
    networkAllowlist: normalizeNetworkAllowlist(record.networkAllowlist, DEFAULT_AMS_POLICY_SPEC.networkAllowlist, warnings),
    minRankAutotuneEnabled: normalizeBooleanFlag(
      record.minRankAutotuneEnabled,
      "minRankAutotuneEnabled",
      DEFAULT_AMS_POLICY_SPEC.minRankAutotuneEnabled,
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
 * Parse raw `.loopover-ams.yml` file content (JSON or YAML). Malformed content degrades to an absent
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

/** The documented `.loopover-ams` file-discovery order (first match wins), mirroring `MINER_GOAL_SPEC_FILENAMES`. */
export const AMS_POLICY_SPEC_FILENAMES = [".loopover-ams.yml", ".github/loopover-ams.yml", ".loopover-ams.json", ".github/loopover-ams.json"] as const;
