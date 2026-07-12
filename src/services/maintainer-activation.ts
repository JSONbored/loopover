import { buildPullRequestAdvisory } from "../rules/advisory";
import type { AdvisorySeverity, PullRequestRecord, RepositoryRecord, RepositorySettings } from "../types";

export type MaintainerActivationFinding = {
  code: string;
  severity: AdvisorySeverity;
  title: string;
};

export type MaintainerActivationSample = {
  number: number;
  title: string;
  severity: AdvisorySeverity;
  findingCount: number;
  findings: MaintainerActivationFinding[];
};

export type MaintainerActivationPreview = {
  repoFullName: string;
  generatedAt: string;
  // What's on today, so the UI can show the current state next to the one-click ramp. Sourced from
  // reviewCheckMode (#2852), the real publish authority -- not the deprecated gateCheckMode read-back
  // (#5373), which never carried more information than reviewCheckMode already does.
  currentReviewCheckMode: RepositorySettings["reviewCheckMode"];
  aiReviewConfigured: boolean;
  evaluatedCount: number;
  withFindingsCount: number;
  // Distinct advisory finding codes seen across the sampled PRs, with counts (the "here's what we'd flag").
  findingCodeCounts: Array<{ code: string; count: number }>;
  samples: MaintainerActivationSample[];
  // The single next action for the maintainer. null once advisory/blocking is already enabled.
  recommendedAction: "enable_advisory" | null;
  summary: string;
};

const DEFAULT_SAMPLE_SIZE = 10;

function recencyKey(pr: PullRequestRecord): string {
  return pr.updatedAt ?? pr.createdAt ?? "";
}

/**
 * Repo-specific install demo (#701): runs the deterministic advisory engine over the repo's most recent PRs
 * so a newly-installed maintainer sees concrete "here's what Gittensory would have surfaced" evidence. Pure
 * over already-loaded data; never runs AI (no surprise cost) — it only reports whether AI review is already
 * configured. Maintainer-private (served behind requireRepoMaintainer); PR titles are already public on GitHub.
 */
export function buildMaintainerActivationPreview(args: {
  repoFullName: string;
  repo: RepositoryRecord | null;
  settings: RepositorySettings;
  pullRequests: PullRequestRecord[];
  generatedAt: string;
  sampleSize?: number;
  /** GITTENSORY_DUPLICATE_WINNER (#dup-winner): mirror the live pipeline so the demo's duplicate findings
   *  match the real gate — when ON, the cluster winner is spared. Defaults to off (byte-identical preview). */
  duplicateWinnerEnabled?: boolean;
}): MaintainerActivationPreview {
  const sampleSize = Math.min(Math.max(args.sampleSize ?? DEFAULT_SAMPLE_SIZE, 1), 25);
  const recent = [...args.pullRequests].sort((left, right) => recencyKey(right).localeCompare(recencyKey(left))).slice(0, sampleSize);

  const codeCounts = new Map<string, number>();
  const samples: MaintainerActivationSample[] = recent.map((pr) => {
    const advisory = buildPullRequestAdvisory(args.repo, pr, {
      // Open-only siblings: a closed/merged PR isn't competing, and isDuplicateClusterWinner's invariant
      // requires open-only numbers — match the live pipeline (processors.ts:559/800), which feeds the
      // winner adjudication the same open-filtered set.
      otherOpenPullRequests: args.pullRequests.filter((other) => other.number !== pr.number && other.state === "open"),
      requireLinkedIssue: args.settings.requireLinkedIssue || args.settings.linkedIssueGateMode !== "off",
      duplicateWinnerEnabled: Boolean(args.duplicateWinnerEnabled),
    });
    for (const finding of advisory.findings) codeCounts.set(finding.code, (codeCounts.get(finding.code) ?? 0) + 1);
    return {
      number: pr.number,
      title: pr.title,
      severity: advisory.severity,
      findingCount: advisory.findings.length,
      findings: advisory.findings.map((finding) => ({ code: finding.code, severity: finding.severity, title: finding.title })),
    };
  });

  const withFindingsCount = samples.filter((sample) => sample.findingCount > 0).length;
  const findingCodeCounts = [...codeCounts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
  // reviewCheckMode (not the legacy gateCheckMode) is the actual publish authority (#2852) -- a repo activated
  // only via .gittensory.yml `gate.checkMode`/`gate.enabled` (never touching the old dashboard toggle) must not
  // be told to "enable advisory mode" again.
  const currentlyActive = args.settings.reviewCheckMode !== "disabled";

  return {
    repoFullName: args.repoFullName,
    generatedAt: args.generatedAt,
    currentReviewCheckMode: args.settings.reviewCheckMode,
    aiReviewConfigured: args.settings.aiReviewMode !== "off",
    evaluatedCount: samples.length,
    withFindingsCount,
    findingCodeCounts,
    samples,
    recommendedAction: currentlyActive ? null : "enable_advisory",
    summary: buildSummary(samples.length, withFindingsCount, currentlyActive),
  };
}

function buildSummary(evaluated: number, withFindings: number, currentlyActive: boolean): string {
  if (evaluated === 0) return "No recent pull requests are cached yet; LoopOver will start surfacing guidance as new PRs arrive.";
  const base = `LoopOver reviewed your ${evaluated} most recent pull request(s) and would have surfaced guidance on ${withFindings} of them.`;
  return currentlyActive ? `${base} The LoopOver gate is already enabled.` : `${base} Enable advisory mode to start surfacing this guidance automatically.`;
}

/**
 * The one-click "enable advisory mode" patch. Advisory-first by design (#525 cross-cutting AC): turns on the
 * gate check + the deterministic rules in ADVISORY mode (never blocking, never auto-merge). AI review stays
 * off — it's opt-in via the ai-review route. Merged onto current settings so unrelated fields are preserved.
 */
export function recommendedAdvisoryActivationSettings(): Pick<
  RepositorySettings,
  "reviewCheckMode" | "checkRunMode" | "linkedIssueGateMode" | "duplicatePrGateMode" | "qualityGateMode"
> {
  return {
    reviewCheckMode: "required",
    checkRunMode: "enabled",
    linkedIssueGateMode: "advisory",
    duplicatePrGateMode: "advisory",
    qualityGateMode: "advisory",
  };
}
