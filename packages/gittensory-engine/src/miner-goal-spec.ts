import { parse as parseYaml } from "yaml";

import { MINER_LIVE_MODE_OPT_IN } from "./governor/action-mode.js";
import {
  DEFAULT_SELF_PLAGIARISM_SIMILARITY_THRESHOLD,
  resolveSelfPlagiarismConfig,
} from "./governor/self-plagiarism.js";

// MinerGoalSpec (#2293 / #2301). The type surface for `.gittensory-miner.yml` — the per-repo config a
// maintainer/repo-owner drops in to tell an autonomous miner what to look for and how to behave when targeting
// their repo. This is the MINER-side analogue of the review-side `.gittensory.yml` focus manifest (see
// `src/signals/focus-manifest.ts`'s `FocusManifest`): a small typed config object paired with explicit
// safe-defaults and a tolerant parser that degrades malformed input to those defaults with warnings rather than
// throwing.

/** How strongly opening discovery issues is encouraged for this repo. Mirrors the review-side policy vocabulary. */
export type MinerIssueDiscoveryPolicy = "encouraged" | "neutral" | "discouraged";

/** Per-repo tuning for the feasibility gate (`buildFeasibilityVerdict`, see `feasibility.ts`) a miner consults
 *  before starting work. This is config-parsing surface only — it does not itself change the composer's
 *  behavior; a caller wiring the gate into a decision flow reads this policy and applies it. */
export type FeasibilityGatePolicy = {
  /** Whether this repo wants the feasibility gate consulted at all before a miner starts work. Setting this
   *  `false` lets a repo opt out of the gate entirely rather than tuning it. Default: true. */
  enabled: boolean;
  /** Specific `buildFeasibilityVerdict` avoid/raise reason codes (e.g. `"duplicate_cluster_high"`) this repo
   *  wants ignored — for a repo that doesn't want duplicate-cluster signals to affect feasibility, for example.
   *  String list. Default: [] (nothing suppressed). */
  suppressedReasons: readonly string[];
};

/** Per-repo self-plagiarism throttle tuning for Governor open_pr (#2345). */
export type SelfPlagiarismPolicy = {
  /** Jaccard similarity threshold in [0, 1] for near-duplicate diff fingerprints. Default: 0.85. */
  similarityThreshold: number;
};

/** Per-repo kill-switch tuning consulted by the Governor chokepoint's kill-switch primitive (#2341). */
export type MinerKillSwitchPolicy = {
  /**
   * Per-repo runtime halt: stops all miner WRITE actions for this repo without deregistering it from
   * targeting/discovery. Distinct from `minerEnabled` (a discovery-time opt-out) — pausing preserves in-flight
   * queue state so un-pausing resumes exactly where the queue left off. Default: false (not paused).
   */
  paused: boolean;
};

/** Per-repo dry-run/live execution tuning consulted by the Governor chokepoint's action-mode primitive (#2342). */
export type MinerExecutionPolicy = {
  /**
   * Explicit opt-in to LIVE write execution for this repo. Must equal EXACTLY the literal string `"live"` — any
   * other value (a typo, `"yes"`, `"on"`, or a boolean `true` from a malformed file) is treated as not opted
   * in, so a fat-fingered config can never accidentally enable live writes. A miner also stays in dry-run
   * unless its own operator separately opts in globally (`LOOPOVER_MINER_LIVE_MODE=live`) — this field alone
   * cannot force a stranger's miner instance live. Default: null (dry-run).
   */
  liveModeOptIn: typeof MINER_LIVE_MODE_OPT_IN | null;
};

/** Per-repo miner configuration parsed from `.gittensory-miner.yml`. See {@link DEFAULT_MINER_GOAL_SPEC}. */
export type MinerGoalSpec = {
  /**
   * Whether this repo permits autonomous miners at all. Explicit OPT-OUT, not opt-in: a public repo with no
   * `.gittensory-miner.yml` is still minable, mirroring `.gittensory.yml`'s "safe by default" stance. Set `false`
   * to halt all miner targeting of this repo. Default: true.
   */
  minerEnabled: boolean;
  /**
   * Work areas the maintainer wants a miner to focus on; a candidate touching these is preferred. Glob list.
   * Default: [] (no preference).
   */
  wantedPaths: readonly string[];
  /**
   * Paths off-limits to a miner. A candidate touching one of these should be skipped. Glob list.
   * Default: [] (nothing blocked).
   */
  blockedPaths: readonly string[];
  /**
   * Issue/PR labels the maintainer prefers a miner to target; a candidate carrying one is favored. String list.
   * Default: [] (no preference).
   */
  preferredLabels: readonly string[];
  /**
   * Issue/PR labels a miner must not target; a candidate carrying one should be skipped. String list.
   * Default: [] (nothing blocked).
   */
  blockedLabels: readonly string[];
  /**
   * Maximum number of issues a single miner may hold claimed on this repo at once, so one miner cannot monopolize
   * a repo's queue. A positive integer (`>= 1`); the parser is expected to floor a non-integer toward zero
   * (`Math.floor`) and reject any value below 1. Default: 1.
   */
  maxConcurrentClaims: number;
  /**
   * How strongly this repo encourages a miner to open discovery issues. Values: encouraged | neutral | discouraged.
   * Default: neutral.
   */
  issueDiscoveryPolicy: MinerIssueDiscoveryPolicy;
  /**
   * Per-repo tuning for the feasibility gate a miner consults before starting work. See {@link FeasibilityGatePolicy}.
   * Default: { enabled: true, suppressedReasons: [] }.
   */
  feasibilityGate: FeasibilityGatePolicy;
  /**
   * Self-plagiarism throttle consulted before open_pr (#2345). Default: { similarityThreshold: 0.85 }.
   */
  selfPlagiarism: SelfPlagiarismPolicy;
  /**
   * Per-repo kill-switch consulted by the Governor chokepoint before every write action (#2341).
   * Default: { paused: false }.
   */
  killSwitch: MinerKillSwitchPolicy;
  /**
   * Per-repo dry-run/live execution opt-in consulted by the Governor chokepoint (#2342).
   * Default: { liveModeOptIn: null }.
   */
  execution: MinerExecutionPolicy;
};

/** The tolerant parser result for `.gittensory-miner.yml`: the normalized spec plus parse warnings and whether the
 *  file actually expressed any non-default goal fields. Mirrors `parseFocusManifest`'s present/warnings pattern
 *  without forcing metadata onto downstream consumers that only need the config itself. */
export type ParsedMinerGoalSpec = {
  present: boolean;
  spec: MinerGoalSpec;
  warnings: string[];
};

/**
 * The safe defaults applied when a field is absent from `.gittensory-miner.yml` (or the file itself is missing).
 * Every value here matches the "Default: X" documented on its field above. Analogous to the defaults constant that
 * accompanies `FocusManifest` in `src/signals/focus-manifest.ts` — a repo with no file behaves as if it declared
 * this: minable, with no path/label preferences, one concurrent claim, and neutral discovery.
 *
 * Deep-frozen: this is a shared singleton, so runtime code can read it freely but must not mutate it — clone before
 * layering repo-specific overrides on top.
 */
export const DEFAULT_MINER_GOAL_SPEC: Readonly<MinerGoalSpec> = Object.freeze({
  minerEnabled: true,
  wantedPaths: Object.freeze([]),
  blockedPaths: Object.freeze([]),
  preferredLabels: Object.freeze([]),
  blockedLabels: Object.freeze([]),
  maxConcurrentClaims: 1,
  issueDiscoveryPolicy: "neutral",
  feasibilityGate: Object.freeze({ enabled: true, suppressedReasons: Object.freeze([]) }),
  selfPlagiarism: Object.freeze({ similarityThreshold: DEFAULT_SELF_PLAGIARISM_SIMILARITY_THRESHOLD }),
  killSwitch: Object.freeze({ paused: false }),
  execution: Object.freeze({ liveModeOptIn: null }),
});

const MAX_MINER_GOAL_SPEC_BYTES = 32_768;
const MAX_LIST_ITEMS = 100;
const MAX_ITEM_LENGTH = 256;

function cloneDefaultMinerGoalSpec(): MinerGoalSpec {
  return {
    ...DEFAULT_MINER_GOAL_SPEC,
    wantedPaths: [...DEFAULT_MINER_GOAL_SPEC.wantedPaths],
    blockedPaths: [...DEFAULT_MINER_GOAL_SPEC.blockedPaths],
    preferredLabels: [...DEFAULT_MINER_GOAL_SPEC.preferredLabels],
    blockedLabels: [...DEFAULT_MINER_GOAL_SPEC.blockedLabels],
    feasibilityGate: {
      enabled: DEFAULT_MINER_GOAL_SPEC.feasibilityGate.enabled,
      suppressedReasons: [...DEFAULT_MINER_GOAL_SPEC.feasibilityGate.suppressedReasons],
    },
    selfPlagiarism: { ...DEFAULT_MINER_GOAL_SPEC.selfPlagiarism },
    killSwitch: { ...DEFAULT_MINER_GOAL_SPEC.killSwitch },
    execution: { ...DEFAULT_MINER_GOAL_SPEC.execution },
  };
}

function emptyMinerGoalSpec(warnings: string[] = []): ParsedMinerGoalSpec {
  return { present: false, spec: cloneDefaultMinerGoalSpec(), warnings };
}

function normalizeStringList(value: unknown, field: string, warnings: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`MinerGoalSpec field "${field}" must be a list; ignoring a ${typeof value} value.`);
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (index >= MAX_LIST_ITEMS) {
      warnings.push(`MinerGoalSpec field "${field}" exceeded ${MAX_LIST_ITEMS} entries; extra entries ignored.`);
      break;
    }
    if (typeof entry !== "string") {
      warnings.push(`MinerGoalSpec field "${field}" skipped a non-string entry.`);
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) continue;
    let normalized = trimmed;
    if (normalized.length > MAX_ITEM_LENGTH) {
      warnings.push(`MinerGoalSpec field "${field}" truncated an over-long entry.`);
      normalized = normalized.slice(0, MAX_ITEM_LENGTH);
    }
    if (seen.has(normalized)) continue;
    result.push(normalized);
    seen.add(normalized);
  }
  return result;
}

function normalizeBoolean(value: unknown, field: string, fallback: boolean, warnings: string[]): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  warnings.push(`MinerGoalSpec field "${field}" must be a boolean; falling back to ${String(fallback)}.`);
  return fallback;
}

function normalizeIssueDiscoveryPolicy(
  value: unknown,
  field: string,
  fallback: MinerIssueDiscoveryPolicy,
  warnings: string[],
): MinerIssueDiscoveryPolicy {
  if (value === undefined || value === null) return fallback;
  if (value === "encouraged" || value === "neutral" || value === "discouraged") return value;
  warnings.push(
    `MinerGoalSpec field "${field}" must be one of encouraged, neutral, discouraged; falling back to "${fallback}".`,
  );
  return fallback;
}

function normalizeFeasibilityGatePolicy(
  value: unknown,
  field: string,
  fallback: FeasibilityGatePolicy,
  warnings: string[],
): FeasibilityGatePolicy {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`MinerGoalSpec field "${field}" must be a mapping; falling back to defaults.`);
    return fallback;
  }
  const record = value as Record<string, unknown>;
  return {
    enabled: normalizeBoolean(record.enabled, `${field}.enabled`, fallback.enabled, warnings),
    suppressedReasons: normalizeStringList(record.suppressedReasons, `${field}.suppressedReasons`, warnings),
  };
}

function normalizeSelfPlagiarismPolicy(
  value: unknown,
  field: string,
  fallback: SelfPlagiarismPolicy,
  warnings: string[],
): SelfPlagiarismPolicy {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`MinerGoalSpec field "${field}" must be a mapping; falling back to defaults.`);
    return fallback;
  }
  const resolved = resolveSelfPlagiarismConfig(value);
  const record = value as Record<string, unknown>;
  if (
    record.similarityThreshold !== undefined &&
    typeof record.similarityThreshold !== "number"
  ) {
    warnings.push(
      `MinerGoalSpec field "${field}.similarityThreshold" must be a number; falling back to ${fallback.similarityThreshold}.`,
    );
    return fallback;
  }
  return resolved;
}

function normalizeKillSwitchPolicy(
  value: unknown,
  field: string,
  fallback: MinerKillSwitchPolicy,
  warnings: string[],
): MinerKillSwitchPolicy {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`MinerGoalSpec field "${field}" must be a mapping; falling back to defaults.`);
    return fallback;
  }
  const record = value as Record<string, unknown>;
  return {
    paused: normalizeBoolean(record.paused, `${field}.paused`, fallback.paused, warnings),
  };
}

function normalizeExecutionPolicy(
  value: unknown,
  field: string,
  fallback: MinerExecutionPolicy,
  warnings: string[],
): MinerExecutionPolicy {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`MinerGoalSpec field "${field}" must be a mapping; falling back to defaults.`);
    return fallback;
  }
  const record = value as Record<string, unknown>;
  const raw = record.liveModeOptIn;
  if (raw === undefined || raw === null) return { liveModeOptIn: fallback.liveModeOptIn };
  if (typeof raw !== "string") {
    warnings.push(`MinerGoalSpec field "${field}.liveModeOptIn" must be a string; falling back to dry-run.`);
    return { liveModeOptIn: fallback.liveModeOptIn };
  }
  // A string that isn't the exact opt-in literal is NOT malformed (it's a valid string, just not the one value
  // that grants live mode) -- no warning, just a silent, safe fall-through to dry-run. Only a wrong TYPE above
  // warns, matching every other field's tolerant-parse convention.
  return { liveModeOptIn: raw === MINER_LIVE_MODE_OPT_IN ? raw : null };
}

function normalizePositiveInteger(value: unknown, field: string, fallback: number, warnings: string[]): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`MinerGoalSpec field "${field}" must be a positive whole number; falling back to ${fallback}.`);
    return fallback;
  }
  const normalized = Math.floor(value);
  if (normalized >= 1) return normalized;
  warnings.push(`MinerGoalSpec field "${field}" must be >= 1 after flooring; falling back to ${fallback}.`);
  return fallback;
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

function hasConfiguredGoalFields(spec: MinerGoalSpec): boolean {
  return (
    spec.minerEnabled !== DEFAULT_MINER_GOAL_SPEC.minerEnabled ||
    spec.wantedPaths.length > 0 ||
    spec.blockedPaths.length > 0 ||
    spec.preferredLabels.length > 0 ||
    spec.blockedLabels.length > 0 ||
    spec.maxConcurrentClaims !== DEFAULT_MINER_GOAL_SPEC.maxConcurrentClaims ||
    spec.issueDiscoveryPolicy !== DEFAULT_MINER_GOAL_SPEC.issueDiscoveryPolicy ||
    spec.feasibilityGate.enabled !== DEFAULT_MINER_GOAL_SPEC.feasibilityGate.enabled ||
    spec.feasibilityGate.suppressedReasons.length > 0 ||
    spec.selfPlagiarism.similarityThreshold !== DEFAULT_MINER_GOAL_SPEC.selfPlagiarism.similarityThreshold ||
    spec.killSwitch.paused !== DEFAULT_MINER_GOAL_SPEC.killSwitch.paused ||
    spec.execution.liveModeOptIn !== DEFAULT_MINER_GOAL_SPEC.execution.liveModeOptIn
  );
}

/**
 * Tolerantly normalize an already-parsed `.gittensory-miner.yml` object into a {@link ParsedMinerGoalSpec}.
 * Never throws: malformed shapes degrade to safe defaults and accumulate warnings so callers can surface
 * "your miner goal spec had problems" without hard-failing a run.
 */
export function parseMinerGoalSpec(raw: unknown): ParsedMinerGoalSpec {
  if (raw === undefined || raw === null) return emptyMinerGoalSpec();
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return emptyMinerGoalSpec([
      "MinerGoalSpec must be a mapping of fields; ignoring malformed config and falling back to safe defaults.",
    ]);
  }
  const record = raw as Record<string, unknown>;
  const warnings: string[] = [];
  const spec: MinerGoalSpec = {
    minerEnabled: normalizeBoolean(
      record.minerEnabled,
      "minerEnabled",
      DEFAULT_MINER_GOAL_SPEC.minerEnabled,
      warnings,
    ),
    wantedPaths: normalizeStringList(record.wantedPaths, "wantedPaths", warnings),
    blockedPaths: normalizeStringList(record.blockedPaths, "blockedPaths", warnings),
    preferredLabels: normalizeStringList(record.preferredLabels, "preferredLabels", warnings),
    blockedLabels: normalizeStringList(record.blockedLabels, "blockedLabels", warnings),
    maxConcurrentClaims: normalizePositiveInteger(
      record.maxConcurrentClaims,
      "maxConcurrentClaims",
      DEFAULT_MINER_GOAL_SPEC.maxConcurrentClaims,
      warnings,
    ),
    issueDiscoveryPolicy: normalizeIssueDiscoveryPolicy(
      record.issueDiscoveryPolicy,
      "issueDiscoveryPolicy",
      DEFAULT_MINER_GOAL_SPEC.issueDiscoveryPolicy,
      warnings,
    ),
    feasibilityGate: normalizeFeasibilityGatePolicy(
      record.feasibilityGate,
      "feasibilityGate",
      DEFAULT_MINER_GOAL_SPEC.feasibilityGate,
      warnings,
    ),
    selfPlagiarism: normalizeSelfPlagiarismPolicy(
      record.selfPlagiarism,
      "selfPlagiarism",
      DEFAULT_MINER_GOAL_SPEC.selfPlagiarism,
      warnings,
    ),
    killSwitch: normalizeKillSwitchPolicy(record.killSwitch, "killSwitch", DEFAULT_MINER_GOAL_SPEC.killSwitch, warnings),
    execution: normalizeExecutionPolicy(record.execution, "execution", DEFAULT_MINER_GOAL_SPEC.execution, warnings),
  };
  if (!hasConfiguredGoalFields(spec)) {
    warnings.push("MinerGoalSpec contained no recognized non-default goal fields; falling back to safe defaults.");
    return { present: false, spec: cloneDefaultMinerGoalSpec(), warnings };
  }
  return { present: true, spec, warnings };
}

/**
 * Parse raw `.gittensory-miner.yml` file content (JSON or YAML). Malformed content degrades to an absent
 * goal spec with a warning rather than throwing, mirroring `parseFocusManifestContent`.
 */
export function parseMinerGoalSpecContent(content: string | null | undefined): ParsedMinerGoalSpec {
  if (content === undefined || content === null || content.trim() === "") return emptyMinerGoalSpec();
  if (utf8ByteLength(content) > MAX_MINER_GOAL_SPEC_BYTES) {
    return emptyMinerGoalSpec([
      `MinerGoalSpec content exceeded ${MAX_MINER_GOAL_SPEC_BYTES} bytes; ignoring it and falling back to safe defaults.`,
    ]);
  }
  const trimmed = content.trim();
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  let parsed: unknown;
  try {
    parsed = looksLikeJson ? JSON.parse(trimmed) : parseYaml(trimmed);
  } catch {
    return emptyMinerGoalSpec([
      looksLikeJson
        ? "MinerGoalSpec content was not valid JSON; ignoring it and falling back to safe defaults."
        : "MinerGoalSpec content was not valid YAML; ignoring it and falling back to safe defaults.",
    ]);
  }
  return parseMinerGoalSpec(parsed);
}

/**
 * The documented `.gittensory-miner` file-discovery order (first match wins), mirroring how `.gittensory.yml` is
 * discovered: repo-root YAML, then `.github/` YAML, then the JSON variants.
 */
export const MINER_GOAL_SPEC_FILENAMES = [
  ".gittensory-miner.yml",
  ".github/gittensory-miner.yml",
  ".gittensory-miner.json",
  ".github/gittensory-miner.json",
] as const;

/**
 * The first {@link MINER_GOAL_SPEC_FILENAMES} candidate that exists, or null. Pure: the caller injects the existence
 * check (e.g. `fs.existsSync`) so this module stays IO-free and unit-testable. A caller reads the returned path and
 * feeds its content to {@link parseMinerGoalSpecContent}.
 */
export function discoverMinerGoalSpecPath(exists: (path: string) => boolean): string | null {
  for (const name of MINER_GOAL_SPEC_FILENAMES) if (exists(name)) return name;
  return null;
}
