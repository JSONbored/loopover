import type {
  IssueRecord,
  PullRequestRecord,
  RecentMergedPullRequestRecord,
} from "../types";
import {
  STOPWORDS,
  buildCollisionReport,
  type CollisionReport,
  type SignalFinding,
} from "./engine";
import { isFocusManifestPublicSafe } from "./focus-manifest";

export type SlopBand = "clean" | "low" | "elevated" | "high";

export type SlopAssessmentInput = {
  repoFullName: string;
  issues: IssueRecord[];
  pullRequests: PullRequestRecord[];
  recentMergedPullRequests?: RecentMergedPullRequestRecord[] | undefined;
  targetPullRequestNumber?: number | undefined;
  commitMessages?: string[] | undefined;
  prebuiltCollisions?: CollisionReport | null | undefined;
};

export type SlopAssessment = {
  slopRisk: number;
  band: SlopBand;
  findings: SignalFinding[];
};

export type CommitMessageQualityFinding = {
  message: string;
  subject: string;
  reason:
    | "empty_subject"
    | "template_subject"
    | "generic_subject"
    | "stopword_only_subject";
};

const TEMPLATE_SUBJECTS = new Set([
  "wip",
  "tmp",
  "temp",
  "test",
  "misc",
  "stuff",
  "changes",
  "work",
  "progress",
  "checkpoint",
  "placeholder",
  "tbd",
  "asdf",
  "qwerty",
]);
const GENERIC_SUBJECTS = new Set([
  "update",
  "fix",
  "cleanup",
  "refactor",
  "changes",
  "misc",
  "stuff",
  "work",
  "progress",
  "minor fix",
  "small fix",
  "address review",
  "apply feedback",
]);

export const SLOP_WEIGHTS = {
  duplicateClusterMembership: 35,
  lowQualityCommitMessages: 20,
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
  "- low-quality commit messages",
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

  const lowQualityCommitMessages = findLowQualityCommitMessages(input.commitMessages ?? []);
  const commitMessageFinding = buildLowQualityCommitMessageFinding(lowQualityCommitMessages);
  if (commitMessageFinding) findings.push(commitMessageFinding);

  const slopRisk = clamp(
    (duplicateClusterFinding ? SLOP_WEIGHTS.duplicateClusterMembership : 0) +
      lowQualityCommitMessages.length * SLOP_WEIGHTS.lowQualityCommitMessages,
    0,
    100,
  );

  return {
    slopRisk,
    band: slopBandFor(slopRisk),
    findings,
  };
}

export function findLowQualityCommitMessages(
  commitMessages: string[],
): CommitMessageQualityFinding[] {
  const findings: CommitMessageQualityFinding[] = [];
  for (const message of commitMessages) {
    const subject = firstNonEmptyLine(message).trim();
    if (!subject) {
      findings.push({ message, subject: "", reason: "empty_subject" });
      continue;
    }
    const normalized = normalizeSubject(subject);
    if (TEMPLATE_SUBJECTS.has(normalized)) {
      findings.push({ message, subject, reason: "template_subject" });
      continue;
    }
    if (GENERIC_SUBJECTS.has(normalized)) {
      findings.push({ message, subject, reason: "generic_subject" });
      continue;
    }
    const tokens = normalized.match(/[a-z0-9]+/g) ?? [];
    if (tokens.length === 0) {
      findings.push({ message, subject, reason: "empty_subject" });
      continue;
    }
    const meaningfulTokens = tokens.filter(
      (term) => term.length > 2 && !STOPWORDS.has(term) && !TEMPLATE_SUBJECTS.has(term),
    );
    if (meaningfulTokens.length === 0) {
      findings.push({ message, subject, reason: "stopword_only_subject" });
    }
  }
  return findings;
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

function buildLowQualityCommitMessageFinding(
  flagged: CommitMessageQualityFinding[],
): SignalFinding | null {
  if (flagged.length === 0) return null;

  const examples = flagged
    .slice(0, 2)
    .map((entry) => `\`${truncate(entry.subject || "(empty)", 40)}\``)
    .join(", ");
  const detail = ensurePublicSafeText(
    `${flagged.length} low-quality commit message(s) were detected${examples ? `, including ${examples}` : ""}.`,
    "Low-quality commit messages were detected.",
  );
  const action = ensurePublicSafeText(
    "Rewrite commit subjects with traceable, descriptive summaries tied to the actual change.",
    "Rewrite commit subjects with descriptive summaries.",
  );

  return {
    code: "low_quality_commit_messages",
    title: "Commit history includes low-quality messages",
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

function firstNonEmptyLine(text: string): string {
  return String(text)
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0) ?? "";
}

function normalizeSubject(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
