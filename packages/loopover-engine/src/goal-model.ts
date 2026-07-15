/**
 * Pure lane-fit scorer: the compiled form of a repo's `MinerGoalSpec` path/label preferences. Given a
 * candidate opportunity's paths and labels plus the operator's goal spec, it returns a single `[0, 1]`
 * lane-fit score with no IO, network, clock, or random input. It is the shared primitive that
 * `miner-goal-lane-fit.ts` and `opportunity-metadata.ts`'s `computeMetadataLaneFit` both consume; see
 * {@link computeLaneFit} for the exact precedence and scoring rules.
 */
import type { MinerGoalSpec } from "./miner-goal-spec.js";

/** The inputs to {@link computeLaneFit}: one candidate opportunity scored against a goal spec. */
export type GoalModelInput = {
  /** The candidate's changed/relevant file paths, matched against the spec's path globs (case-insensitive). */
  candidatePaths: string[];
  /** The candidate's labels, matched (trimmed + lowercased, exact) against the spec's label preferences. */
  candidateLabels: string[];
  /**
   * The operator's goal spec supplying `blockedPaths`/`blockedLabels` (hard vetoes) and
   * `wantedPaths`/`preferredLabels` (preferences).
   */
  goalSpec: MinerGoalSpec;
};

function normalizeLabels(labels: readonly string[]): string[] {
  return labels
    .filter((label): label is string => typeof label === "string")
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);
}

function normalizePathForMatch(path: string): string {
  return String(path ?? "").replace(/\\/g, "/").toLowerCase();
}

/**
 * Compile one glob pattern into a case-insensitive whole-path matcher. Supports `*` (any run of
 * non-`/` chars, within a single segment), a bare `**` (any run of chars including `/`), a `**` that is
 * immediately followed by a slash (an optional directory prefix — zero or more leading segments), and
 * `?` (a single non-`/` char). It does NOT
 * support character classes (`[abc]`) or brace expansion (`{a,b}`) — those metacharacters are escaped and
 * matched literally. Backslashes are normalized to `/` before matching, so patterns are OS-agnostic.
 */
function compileGlobMatcher(pattern: string): (path: string) => boolean {
  const normalizedPattern = normalizePathForMatch(pattern);
  if (!normalizedPattern) return () => false;
  let regex = "^";
  for (let i = 0; i < normalizedPattern.length; i++) {
    const ch = normalizedPattern[i];
    const next = normalizedPattern[i + 1];
    if (ch === "*" && next === "*") {
      const afterDoubleStar = normalizedPattern[i + 2];
      if (afterDoubleStar === "/") {
        regex += "(?:.*/)?";
        i += 2;
      } else {
        regex += ".*";
        i++;
      }
    } else if (ch === "*") {
      regex += "[^/]*";
    } else if (ch === "?") {
      regex += "[^/]";
    } else if (/[.+^$(){}|[\]\\]/.test(ch ?? "")) {
      regex += "\\" + ch;
    } else {
      regex += ch;
    }
  }
  regex += "$";
  const compiled = new RegExp(regex);
  return (path: string) => {
    const normalized = normalizePathForMatch(path);
    if (!normalized) return false;
    return compiled.test(normalized);
  };
}

function matchesAnyLabel(candidateLabels: readonly string[], goalLabels: readonly string[]): boolean {
  if (goalLabels.length === 0) return false;
  const normalizedCandidate = normalizeLabels(candidateLabels);
  const normalizedGoal = normalizeLabels(goalLabels);
  return normalizedGoal.some((label) => normalizedCandidate.includes(label));
}

function matchesAnyPath(candidatePaths: readonly string[], goalPaths: readonly string[]): boolean {
  if (goalPaths.length === 0) return false;
  return goalPaths.some((pattern) => {
    const matcher = compileGlobMatcher(pattern);
    return candidatePaths.some((path) => matcher(path));
  });
}

/**
 * Score how well a candidate fits the goal spec's lane, in `[0, 1]`. Rules, in strict precedence:
 *
 * 1. **Hard veto.** If any candidate path matches `blockedPaths`, or any candidate label matches
 *    `blockedLabels`, the result is `0` immediately — before any preference is considered.
 * 2. **Neutral default.** If the spec configures neither `wantedPaths` nor `preferredLabels`, the result
 *    is a fixed `0.5` (unopinionated), never `0` or `1`.
 * 3. **No match.** If at least one preference dimension is configured but none of the configured ones
 *    actually match, the result is `0`.
 * 4. **Partial credit.** Otherwise the result is `matchedDimensions / activeDimensions`, where a dimension
 *    (paths, labels) is "active" when configured and "matched" when it hit. So one active dimension that
 *    matches scores `1`; with both configured, matching only one scores `0.5` and matching both scores `1`.
 *    (Note `0.5` is thus reachable two ways — the neutral default of rule 2, and a one-of-two match here.)
 *
 * Pure: reads only its inputs, with no IO, network, clock, or randomness.
 */
export function computeLaneFit(input: GoalModelInput): number {
  const { candidatePaths, candidateLabels, goalSpec } = input;
  if (matchesAnyPath(candidatePaths, goalSpec.blockedPaths)) {
    return 0;
  }
  if (matchesAnyLabel(candidateLabels, goalSpec.blockedLabels)) {
    return 0;
  }
  const hasPathCriteria = goalSpec.wantedPaths.length > 0;
  const hasLabelCriteria = goalSpec.preferredLabels.length > 0;
  if (!hasPathCriteria && !hasLabelCriteria) {
    return 0.5;
  }
  const pathMatches = hasPathCriteria && matchesAnyPath(candidatePaths, goalSpec.wantedPaths);
  const labelMatches = hasLabelCriteria && matchesAnyLabel(candidateLabels, goalSpec.preferredLabels);
  if (!pathMatches && !labelMatches) {
    return 0;
  }
  const activeDimensions = (hasPathCriteria ? 1 : 0) + (hasLabelCriteria ? 1 : 0);
  const matchedDimensions = (pathMatches ? 1 : 0) + (labelMatches ? 1 : 0);
  return matchedDimensions / activeDimensions;
}