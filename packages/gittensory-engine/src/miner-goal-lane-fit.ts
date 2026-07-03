import type { MinerGoalSpec } from "./miner-goal-spec.js";

/** Whether a repo's miner goal spec permits autonomous targeting (explicit opt-out only). */
export function isMinerRepoTargetable(spec: MinerGoalSpec): boolean {
  return spec.minerEnabled;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normalizeLabels(labels: readonly string[]): string[] {
  return labels
    .filter((label): label is string => typeof label === "string")
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Compute a [0, 1] lane-fit score from issue labels and a parsed {@link MinerGoalSpec}. Path-based fit is
 * intentionally omitted — discovery metadata has labels only; path gating belongs in the analyze phase.
 */
export function computeMinerGoalLaneFit(
  issue: { labels: readonly string[] },
  spec: MinerGoalSpec,
): number {
  const issueLabels = normalizeLabels(issue.labels);
  const blocked = normalizeLabels(spec.blockedLabels);
  if (blocked.length > 0 && blocked.some((label) => issueLabels.includes(label))) {
    return 0;
  }

  const preferred = normalizeLabels(spec.preferredLabels);

  let score: number;
  if (preferred.length === 0) {
    score = 1;
  } else {
    const preferredMatch = preferred.some((want) => issueLabels.includes(want));
    if (preferredMatch) {
      score = 1;
    } else if (spec.issueDiscoveryPolicy === "discouraged") {
      score = 0.6;
    } else {
      score = 0.25;
    }
  }

  if (spec.issueDiscoveryPolicy === "encouraged") {
    score = Math.max(score, 0.85);
  }

  return clamp01(score);
}
