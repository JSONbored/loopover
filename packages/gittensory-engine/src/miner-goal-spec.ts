import { parse as parseYaml } from "yaml";

// MinerGoalSpec (#2293 / #2301). The type surface for `.gittensory-miner.yml` — the per-repo config a
// maintainer/repo-owner drops in to tell an autonomous miner what to look for and how to behave when targeting
// their repo. This is the MINER-side analogue of the review-side `.gittensory.yml` focus manifest (see
// `src/signals/focus-manifest.ts`'s `FocusManifest`): a small typed config object paired with explicit
// safe-defaults and a tolerant parser that degrades malformed input to those defaults with warnings rather than
// throwing.

/** How strongly opening discovery issues is encouraged for this repo. Mirrors the review-side policy vocabulary. */
export type MinerIssueDiscoveryPolicy = "encouraged" | "neutral" | "discouraged";

/**
 * Per-repo tuning for the miner's feasibility gate — how selective a miner is about which candidate issues it
 * deems workable before spending effort. Additive and OFF by default: with {@link DEFAULT_MINER_GOAL_SPEC}'s
 * values the gate never blocks, so a repo with no `feasibilityGate` block behaves exactly as before. The gate's
 * composer (a separate issue) is the consumer; this is only the config surface a maintainer tunes.
 */
export type MinerFeasibilityGate = {
  /**
   * Minimum feasibility score, in `[0, 1]`, a candidate must reach for a miner to pursue it. Default: `0` — no
   * floor, so the gate stays inert until a maintainer opts in. The parser clamps out-of-range or non-finite input
   * into `[0, 1]` (with a warning) rather than rejecting it.
   */
  minFeasibilityScore: number;
  /**
   * Feasibility "avoid" reason keys this repo opts to DOWNGRADE from blocking to advisory — a maintainer's way to
   * say "that reason does not apply here." Free-form string list; the composer owns the reason vocabulary, so the
   * config stays tolerant of unknown keys. Default: `[]` (suppress nothing).
   */
  suppressedAvoidReasons: readonly string[];
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
   * Per-repo feasibility-gate tuning. Default: an inert gate (score floor `0`, nothing suppressed), so the field
   * is fully additive — a repo that omits it behaves exactly as before. See {@link MinerFeasibilityGate}.
   */
  feasibilityGate: MinerFeasibilityGate;
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
  feasibilityGate: Object.freeze({ minFeasibilityScore: 0, suppressedAvoidReasons: Object.freeze([]) }),
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
    feasibilityGate: cloneDefaultFeasibilityGate(),
  };
}

function cloneDefaultFeasibilityGate(): MinerFeasibilityGate {
  return {
    minFeasibilityScore: DEFAULT_MINER_GOAL_SPEC.feasibilityGate.minFeasibilityScore,
    suppressedAvoidReasons: [...DEFAULT_MINER_GOAL_SPEC.feasibilityGate.suppressedAvoidReasons],
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

function normalizeFeasibilityGate(value: unknown, warnings: string[]): MinerFeasibilityGate {
  if (value === undefined || value === null) return cloneDefaultFeasibilityGate();
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push(
      `MinerGoalSpec field "feasibilityGate" must be a mapping; ignoring a ${Array.isArray(value) ? "array" : typeof value} value.`,
    );
    return cloneDefaultFeasibilityGate();
  }
  const record = value as Record<string, unknown>;
  return {
    minFeasibilityScore: normalizeUnitScore(
      record.minFeasibilityScore,
      "feasibilityGate.minFeasibilityScore",
      DEFAULT_MINER_GOAL_SPEC.feasibilityGate.minFeasibilityScore,
      warnings,
    ),
    suppressedAvoidReasons: normalizeStringList(
      record.suppressedAvoidReasons,
      "feasibilityGate.suppressedAvoidReasons",
      warnings,
    ),
  };
}

/** Normalize a `[0, 1]` score: a non-finite/non-number value falls back to `fallback`; an out-of-range finite value
 *  clamps into `[0, 1]`. Both cases warn, matching the tolerant "degrade, don't throw" convention of this parser. */
function normalizeUnitScore(value: unknown, field: string, fallback: number, warnings: string[]): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`MinerGoalSpec field "${field}" must be a number in [0, 1]; falling back to ${fallback}.`);
    return fallback;
  }
  if (value < 0 || value > 1) {
    const clamped = Math.min(1, Math.max(0, value));
    warnings.push(`MinerGoalSpec field "${field}" was outside [0, 1]; clamped to ${clamped}.`);
    return clamped;
  }
  return value;
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
    spec.feasibilityGate.minFeasibilityScore !== DEFAULT_MINER_GOAL_SPEC.feasibilityGate.minFeasibilityScore ||
    spec.feasibilityGate.suppressedAvoidReasons.length > 0
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
    feasibilityGate: normalizeFeasibilityGate(record.feasibilityGate, warnings),
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
