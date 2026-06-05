import type {
  Advisory,
  AdvisoryConclusion,
  AdvisoryFinding,
  AdvisorySeverity,
  IssueRecord,
  PullRequestRecord,
  RepositoryRecord,
} from "../types";
import { nowIso } from "../utils/json";

export type GateCheckConclusion = "success" | "failure" | "action_required";

export type GateCheckEvaluation = {
  enabled: boolean;
  conclusion: GateCheckConclusion;
  title: string;
  summary: string;
  blockers: AdvisoryFinding[];
  warnings: AdvisoryFinding[];
};

export function buildRepositoryAdvisory(repo: RepositoryRecord | null, fullName: string): Advisory {
  const findings: AdvisoryFinding[] = [];
  if (!repo) {
    findings.push({
      code: "repo_not_seen",
      severity: "warning",
      title: "Repository is not in the local index",
      detail: "Gittensory has not seen this repository through registry sync or GitHub App installation yet.",
      action: "Install the GitHub App or refresh the Gittensor registry snapshot.",
    });
  } else {
    addRepoFindings(repo, findings);
  }
  return advisory("repository", fullName, fullName, findings, "Repository advisory generated.");
}

export function buildPullRequestAdvisory(
  repo: RepositoryRecord | null,
  pr: PullRequestRecord | null,
  context: { otherOpenPullRequests?: PullRequestRecord[]; requireLinkedIssue?: boolean } = {},
): Advisory {
  const repoFullName = pr?.repoFullName ?? repo?.fullName ?? "unknown/unknown";
  const targetKey = pr ? `${repoFullName}#${pr.number}` : `${repoFullName}#unknown`;
  const findings: AdvisoryFinding[] = [];
  if (!repo) {
    findings.push({
      code: "repo_not_registered",
      severity: "warning",
      title: "Repository registration is unknown",
      detail: "Gittensory cannot evaluate repo-specific rules until registry data is available.",
      action: "Refresh the Gittensor registry snapshot.",
    });
  } else {
    addRepoFindings(repo, findings);
  }
  if (!pr) {
    findings.push({
      code: "pr_not_cached",
      severity: "warning",
      title: "Pull request is not cached",
      detail: "The GitHub webhook or manual fetch has not recorded this pull request yet.",
      action: "Re-deliver the webhook or wait for the next sync.",
    });
  } else {
    addPullRequestFindings(repo, pr, findings, context.otherOpenPullRequests ?? [], Boolean(context.requireLinkedIssue));
  }
  return advisory("pull_request", targetKey, repoFullName, findings, "Pull request advisory generated.", pr?.number, undefined, pr?.headSha ?? undefined);
}

export function buildIssueAdvisory(repo: RepositoryRecord | null, issue: IssueRecord | null): Advisory {
  const repoFullName = issue?.repoFullName ?? repo?.fullName ?? "unknown/unknown";
  const targetKey = issue ? `${repoFullName}#${issue.number}` : `${repoFullName}#unknown`;
  const findings: AdvisoryFinding[] = [];
  if (!repo) {
    findings.push({
      code: "repo_not_registered",
      severity: "warning",
      title: "Repository registration is unknown",
      detail: "Gittensory cannot evaluate repo-specific issue rules until registry data is available.",
    });
  } else {
    addRepoFindings(repo, findings);
  }
  if (!issue) {
    findings.push({
      code: "issue_not_cached",
      severity: "warning",
      title: "Issue is not cached",
      detail: "The GitHub webhook or manual fetch has not recorded this issue yet.",
    });
  } else {
    addIssueFindings(repo, issue, findings);
  }
  return advisory("issue", targetKey, repoFullName, findings, "Issue advisory generated.", undefined, issue?.number);
}

const CHECK_RUN_FORBIDDEN_TERMS =
  /\b(?:rewards?|payouts?|farming|estimated\s+scores?|raw\s+trust\s+scores?|trust\s+scores?|score\s+estimates?|reward\s+estimates?|wallets?|hotkeys?|coldkeys?|reviewability|scoreability|private\s+signals?)\b/gi;

function sanitizeForCheckRun(text: string): string {
  return text.replace(CHECK_RUN_FORBIDDEN_TERMS, "[context]").replace(/\s+/g, " ").trim();
}

export function formatCheckRunOutput(
  advisoryResult: Advisory,
  detailLevel: "minimal" | "standard" | "deep" = "minimal",
): { title: string; summary: string; text: string } {
  const title = advisoryResult.conclusion === "success" ? "Gittensory context checked" : "Gittensory context posted";
  const summary = "Gittensory public check output is intentionally minimal. Detailed maintainer context is available only through private API/MCP surfaces.";

  if (detailLevel === "minimal" || advisoryResult.findings.length === 0) {
    return { title, summary, text: "No detailed findings are published in check runs." };
  }

  const publicLines = advisoryResult.findings.flatMap((f) => {
    if (!f.publicText) return [];
    const label = f.severity === "warning" ? "⚠️" : "ℹ️";
    return [`${label} ${sanitizeForCheckRun(f.publicText)}`];
  });

  if (publicLines.length === 0) {
    return { title, summary, text: "No detailed findings are published in check runs." };
  }

  return { title, summary, text: publicLines.join("\n") };
}

export function evaluateGateCheck(advisoryResult: Advisory): GateCheckEvaluation {
  const blockers = advisoryResult.findings.filter((finding) => isGateBlocker(finding.code));
  const brokenEvaluation = blockers.some((finding) => isEvaluationBlocker(finding.code));
  if (blockers.length === 0) {
    return {
      enabled: true,
      conclusion: "success",
      title: "Gittensory Gate passed",
      summary: "No configured merge-blocking hygiene issue was found.",
      blockers,
      warnings: advisoryResult.findings.filter((finding) => finding.severity === "warning"),
    };
  }
  return {
    enabled: true,
    conclusion: brokenEvaluation ? "action_required" : "failure",
    title: "Gittensory Gate is blocking merge",
    summary: `${blockers.length} configured merge-blocking issue${blockers.length === 1 ? "" : "s"} found.`,
    blockers,
    warnings: advisoryResult.findings.filter((finding) => finding.severity === "warning" && !blockers.includes(finding)),
  };
}

export function formatGateCheckOutput(gate: GateCheckEvaluation): { title: string; summary: string; text: string } {
  if (gate.conclusion === "success") {
    return {
      title: gate.title,
      summary: "Gittensory Gate is an opt-in merge gate. This PR passed the configured public hygiene checks.",
      text: "No configured merge-blocking issue was found.",
    };
  }
  const blockerLines = gate.blockers.slice(0, 8).map((finding) => {
    const action = finding.action ? ` Action: ${sanitizeForCheckRun(finding.action)}` : "";
    return `- ${sanitizeForCheckRun(finding.title)}.${action}`;
  });
  return {
    title: gate.title,
    summary: "Gittensory Gate is an opt-in merge gate. Fix the listed public hygiene issue before merge, or disable the gate for this repo.",
    text: blockerLines.length > 0 ? blockerLines.join("\n") : "A configured merge-blocking issue was found.",
  };
}

function addRepoFindings(repo: RepositoryRecord, findings: AdvisoryFinding[]): void {
  if (!repo.isRegistered) {
    findings.push({
      code: "repo_unregistered",
      severity: "warning",
      title: "Repository is not registered in the latest snapshot",
      detail: "This repository is installed in Gittensory, but the latest registry snapshot does not include it.",
      action: "Verify repository registration before relying on Gittensor-specific signals.",
    });
    return;
  }
  if (!repo.registryConfig) {
    findings.push({
      code: "repo_config_missing",
      severity: "warning",
      title: "Repository config was not parsed",
      detail: "The repository appears in the registry, but its config was not available in normalized form.",
    });
    return;
  }
  const issueShare = repo.registryConfig.issueDiscoveryShare;
  if (issueShare === 0) {
    findings.push({
      code: "issue_discovery_disabled",
      severity: "info",
      title: "Issue discovery is disabled for this repo",
      detail: "The current Gittensor registry config routes this repository away from issue-discovery work.",
      publicText: "This repo is configured for direct contribution review rather than issue-discovery flow.",
    });
  } else if (issueShare === 1) {
    findings.push({
      code: "direct_pr_pool_disabled",
      severity: "info",
      title: "Direct PR scoring is disabled for this repo",
      detail: "The current Gittensor registry config routes this repository fully toward issue-discovery work.",
      publicText: "This repo is configured around issue-discovery flow. Maintainers should review PR expectations manually.",
    });
  }
  if (repo.registryConfig.maintainerCut > 0) {
    findings.push({
      code: "maintainer_cut_enabled",
      severity: "info",
      title: "Maintainer allocation is configured",
      detail: "This repo has a maintainer allocation configured in the registry.",
    });
  }
}

function addPullRequestFindings(
  repo: RepositoryRecord | null,
  pr: PullRequestRecord,
  findings: AdvisoryFinding[],
  otherOpenPullRequests: PullRequestRecord[],
  requireLinkedIssue: boolean,
): void {
  if (pr.state !== "open") {
    findings.push({
      code: "pr_not_open",
      severity: "info",
      title: "Pull request is not open",
      detail: `The pull request state is ${pr.state}.`,
    });
  }
  if (pr.linkedIssues.length === 0 && requireLinkedIssue) {
    findings.push({
      code: "missing_linked_issue",
      severity: "warning",
      title: "No linked issue detected",
      detail: "No closing reference or linked issue number was found in the PR metadata/body.",
      action: "If this PR is intended to solve an issue, link it explicitly in the PR body.",
    });
  } else {
    const overlappingPrs = otherOpenPullRequests.filter((otherPr) =>
      otherPr.linkedIssues.some((issueNumber) => pr.linkedIssues.includes(issueNumber)),
    );
    if (overlappingPrs.length > 0) {
      findings.push({
        code: "duplicate_pr_risk",
        severity: "warning",
        title: "Linked issue overlaps another open PR",
        detail: `Other open pull requests reference the same linked issue set: ${overlappingPrs.map((otherPr) => `#${otherPr.number}`).join(", ")}.`,
        action: "Review the related PRs before spending reviewer time on duplicate work.",
      });
    }
  }
  if (otherOpenPullRequests.length >= 10) {
    findings.push({
      code: "busy_pr_queue",
      severity: "info",
      title: "Open PR queue is busy",
      detail: `Gittensory has ${otherOpenPullRequests.length} other open pull requests cached for this repository.`,
      publicText: "This repo has a busy open PR queue in the local Gittensory cache.",
    });
  }
  const repoMultipliers = repo?.registryConfig?.labelMultipliers ?? {};
  const matchedLabels = pr.labels.filter((label) => repoMultipliers[label] !== undefined);
  if (matchedLabels.length > 0) {
    findings.push({
      code: "label_context_found",
      severity: "info",
      title: "Configured label context found",
      detail: `Matched configured labels: ${matchedLabels.join(", ")}.`,
    });
  }
  if (pr.authorAssociation && ["OWNER", "MEMBER", "COLLABORATOR"].includes(pr.authorAssociation)) {
    findings.push({
      code: "maintainer_authored_pr",
      severity: "info",
      title: "PR author has maintainer association",
      detail: "GitHub marks this PR author as owner, member, or collaborator for the repository.",
      publicText: "This PR appears to come from a maintainer-associated account.",
    });
  }
}

function addIssueFindings(repo: RepositoryRecord | null, issue: IssueRecord, findings: AdvisoryFinding[]): void {
  if (issue.state !== "open") {
    findings.push({
      code: "issue_not_open",
      severity: "info",
      title: "Issue is not open",
      detail: `The issue state is ${issue.state}.`,
    });
  }
  if (issue.linkedPrs.length > 0) {
    findings.push({
      code: "issue_has_linked_prs",
      severity: "warning",
      title: "Issue already has linked PRs",
      detail: `Linked pull requests detected: ${issue.linkedPrs.join(", ")}.`,
      action: "Avoid duplicate work unless the linked PR is abandoned or incomplete.",
    });
  }
  const issueShare = repo?.registryConfig?.issueDiscoveryShare;
  if (issueShare === 0) {
    findings.push({
      code: "issue_discovery_not_configured",
      severity: "info",
      title: "Issue discovery is not configured for this repo",
      detail: "The current repo config does not route this repository toward issue-discovery work.",
    });
  }
}

function advisory(
  targetType: Advisory["targetType"],
  targetKey: string,
  repoFullName: string,
  findings: AdvisoryFinding[],
  fallbackSummary: string,
  pullNumber?: number,
  issueNumber?: number,
  headSha?: string,
): Advisory {
  const severity = highestSeverity(findings);
  const conclusion = conclusionForSeverity(severity, findings);
  const title = conclusion === "success" ? "Gittensory advisory passed" : "Gittensory advisory available";
  return {
    id: crypto.randomUUID(),
    targetType,
    targetKey,
    repoFullName,
    ...(pullNumber === undefined ? {} : { pullNumber }),
    ...(issueNumber === undefined ? {} : { issueNumber }),
    ...(headSha === undefined ? {} : { headSha }),
    conclusion,
    severity,
    title,
    summary: findings.length > 0 ? `${findings.length} advisory finding${findings.length === 1 ? "" : "s"} generated.` : fallbackSummary,
    findings,
    generatedAt: nowIso(),
  };
}

function highestSeverity(findings: AdvisoryFinding[]): AdvisorySeverity {
  if (findings.some((finding) => finding.severity === "critical")) return "critical";
  if (findings.some((finding) => finding.severity === "warning")) return "warning";
  return "info";
}

function conclusionForSeverity(severity: AdvisorySeverity, findings: AdvisoryFinding[]): AdvisoryConclusion {
  if (findings.some((finding) => finding.code === "repo_unregistered" || finding.code === "repo_not_seen")) return "action_required";
  if (severity === "warning") return "neutral";
  if (severity === "critical") return "action_required";
  return "success";
}

function isGateBlocker(code: string): boolean {
  return code === "missing_linked_issue" || code === "duplicate_pr_risk" || isEvaluationBlocker(code);
}

function isEvaluationBlocker(code: string): boolean {
  return code === "repo_not_registered" || code === "repo_not_seen" || code === "pr_not_cached";
}
