import type { MinerGoalSpec } from "./miner-goal-spec.js";

export type GoalModelInput = {
  candidatePaths: string[];
  candidateLabels: string[];
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

function compileGlobMatcher(pattern: string): (path: string) => boolean {
  const normalizedPattern = normalizePathForMatch(pattern);
  if (!normalizedPattern) return () => false;
  let regex = "^";
  for (let i = 0; i < normalizedPattern.length; i++) {
    const ch = normalizedPattern[i];
    if (ch === "*") {
      const next = normalizedPattern[i + 1];
      if (next === "*") {
        regex += ".*";
        i++;
      } else {
        regex += "[^/]*";
      }
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