import type {
  IssueRecord,
  PullRequestRecord,
  RecentMergedPullRequestRecord,
} from "../types";
import { buildCollisionReport, type CollisionReport, type SignalFinding } from "./engine";
import { isFocusManifestPublicSafe } from "./focus-manifest";

export type SlopBand = "clean" | "low" | "elevated" | "high";

export type SlopAssessmentInput = {
  repoFullName: string;
  issues: IssueRecord[];
  pullRequests: PullRequestRecord[];
  recentMergedPullRequests?: RecentMergedPullRequestRecord[] | undefined;
  targetPullRequestNumber?: number | undefined;
  prebuiltCollisions?: CollisionReport | null | undefined;
};

export type SlopAssessment = {
  slopRisk: number;
  band: SlopBand;
  findings: SignalFinding[];
};

export const SLOP_WEIGHTS = {
  duplicateClusterMembership: 35,
} as const;

export const SLOP_RUBRIC_MARKDOWN = [
  "# Gittensory slop assessment rubric",
  "",
  "- `clean`: 0",
  "- `low`: 1-24",
  "- `elevated`: 25-59",
  "- `high`: 60-100",
  "",
  "Current deterministic signals:",
  "- duplicate-cluster membership",
].join("\n");

export function buildSlopAssessment(input: SlopAssessmentInput): SlopAssessment {
  const collisions =
    input.prebuiltCollisions ??
    buildCollisionReport(
      input.repoFullName,
      input.issues,
      input.pullRequests,
      input.recentMergedPullRequests ?? [],
    );
  const findings: SignalFinding[] = [];
  const duplicateClusterFinding = buildDuplicateClusterMembershipFinding(
    collisions,
    input.targetPullRequestNumber,
  );
  if (duplicateClusterFinding) findings.push(duplicateClusterFinding);

  const slopRisk = clamp(
    findings.reduce((total, finding) => {
      if (finding.code !== "duplicate_cluster_membership") return total;
      return total + SLOP_WEIGHTS.duplicateClusterMembership;
    }, 0),
    0,
    100,
  );

  return {
    slopRisk,
    band: slopBandFor(slopRisk),
    findings,
  };
}

function buildDuplicateClusterMembershipFinding(
  collisions: CollisionReport,
  targetPullRequestNumber: number | undefined,
): SignalFinding | null {
  if (!targetPullRequestNumber || !Number.isFinite(targetPullRequestNumber)) return null;

  const matchingClusters = collisions.clusters.filter(
    (cluster) =>
      cluster.risk === "high" &&
      cluster.items.some(
        (item) => item.type === "pull_request" && item.number === targetPullRequestNumber,
      ),
  );
  if (matchingClusters.length === 0) return null;

  const detail = ensurePublicSafeText(
    `${matchingClusters.length} high-risk duplicate or overlap cluster(s) include PR #${targetPullRequestNumber}.`,
    "High-risk duplicate or overlap work includes this PR.",
  );
  const action = ensurePublicSafeText(
    "Resolve or narrow overlapping PR work before asking for review.",
    "Resolve overlapping PR work before review.",
  );

  return {
    code: "duplicate_cluster_membership",
    title: "PR belongs to a high-risk duplicate cluster",
    severity: "warning",
    detail,
    action,
    publicText: detail,
  };
}

function ensurePublicSafeText(text: string, fallback: string): string {
  return isFocusManifestPublicSafe(text) ? text : fallback;
}

function slopBandFor(slopRisk: number): SlopBand {
  if (slopRisk <= 0) return "clean";
  if (slopRisk < 25) return "low";
  if (slopRisk < 60) return "elevated";
  return "high";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
