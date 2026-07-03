import { parse as parseYaml } from "yaml";

// MinerGoalSpec (#2293 / #2301). The type surface for `.gittensory-miner.yml` — the per-repo config a
// maintainer/repo-owner drops in to tell an autonomous miner what to look for and how to behave when targeting
// their repo. This is the MINER-side analogue of the review-side `.gittensory.yml` focus manifest (see
// `src/signals/focus-manifest.ts`'s `FocusManifest`): a small typed config object paired with explicit
// safe-defaults and a tolerant parser that degrades malformed input to those defaults with warnings rather than
// throwing.

/** How strongly opening discovery issues is encouraged for this repo. Mirrors the review-side policy vocabulary. */
export type MinerIssueDiscoveryPolicy = "encouraged" | "neutral" | "discouraged";

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
  maxConcurrentClaims: 1,
  issueDiscoveryPolicy: "neutral",
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
  for (const entry of value) {
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
    if (result.length >= MAX_LIST_ITEMS) {
      warnings.push(`MinerGoalSpec field "${field}" exceeded ${MAX_LIST_ITEMS} entries; extra entries ignored.`);
      break;
    }
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

function hasConfiguredGoalFields(spec: MinerGoalSpec): boolean {
  return (
    spec.minerEnabled !== DEFAULT_MINER_GOAL_SPEC.minerEnabled ||
    spec.wantedPaths.length > 0 ||
    spec.blockedPaths.length > 0 ||
    spec.preferredLabels.length > 0 ||
    spec.maxConcurrentClaims !== DEFAULT_MINER_GOAL_SPEC.maxConcurrentClaims ||
    spec.issueDiscoveryPolicy !== DEFAULT_MINER_GOAL_SPEC.issueDiscoveryPolicy
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
