import type { RepositorySettings } from "../types";
import { isFocusManifestPublicSafe, type FocusManifest } from "./focus-manifest";
import type { ConfigQuality, ContributorIntakeHealth, LabelAudit, LaneAdvice, QueueHealth } from "./engine";

export type RepoPolicyReadinessWarningCategory =
  | "contribution_flow"
  | "direct_pr_policy"
  | "issue_discovery"
  | "validation"
  | "maintainer_burden";

export type RepoPolicyReadinessWarningCode =
  | "focus_policy_missing"
  | "focus_policy_needs_review"
  | "contribution_scope_unclear"
  | "blocked_work_without_wanted_scope"
  | "direct_pr_policy_unclear"
  | "linked_issue_policy_mismatch"
  | "issue_discovery_policy_mismatch"
  | "issue_discovery_intake_not_ready"
  | "validation_expectations_missing"
  | "validation_gate_uncertain"
  | "maintainer_burden_high";

export type RepoPolicyReadinessWarning = {
  code: RepoPolicyReadinessWarningCode;
  category: RepoPolicyReadinessWarningCategory;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  action: string;
};

export type RepoPolicyReadinessReport = {
  repoFullName: string;
  source: "focus_manifest_policy";
  previewOnly: true;
  present: boolean;
  publicWarnings: RepoPolicyReadinessWarning[];
  ownerContext: {
    manifestPresent: boolean;
    manifestSource: FocusManifest["source"];
    privateNoteCount: number;
    manifestWarningCount: number;
    wantedPathCount: number;
    blockedPathCount: number;
    validationExpectationCount: number;
    queueLevel: QueueHealth["level"];
    contributorIntakeLevel: ContributorIntakeHealth["level"];
    configLevel: ConfigQuality["level"];
    issuePolicy: string;
    issueDiscoveryPolicy: FocusManifest["issueDiscoveryPolicy"];
  };
  droppedPublicWarnings: Array<{
    code: RepoPolicyReadinessWarningCode;
    reason: "unsafe_public_text";
  }>;
  summary: string;
};

export type RepoPolicyReadinessInput = {
  repoFullName: string;
  focusManifest?: FocusManifest | undefined;
  settings: RepositorySettings;
  lane: LaneAdvice;
  configQuality: ConfigQuality;
  labelAudit: LabelAudit;
  queueHealth: QueueHealth;
  contributorIntakeHealth: ContributorIntakeHealth;
};

export function buildRepoPolicyReadiness(input: RepoPolicyReadinessInput): RepoPolicyReadinessReport {
  const manifest = input.focusManifest;
  const present = Boolean(manifest?.present);
  const issuePolicy = resolveIssuePolicy(input.lane, input.settings);
  const candidates: RepoPolicyReadinessWarning[] = [];

  if (!present) {
    candidates.push({
      code: "focus_policy_missing",
      category: "contribution_flow",
      severity: "warning",
      title: "Focus policy is not cached",
      detail: "Repo owners cannot preview explicit contribution scope from a focus manifest yet.",
      action: "Add or refresh a focus manifest before inviting broader contributor traffic.",
    });
  } else if (manifest) {
    if (manifest.warnings.length > 0) {
      candidates.push({
        code: "focus_policy_needs_review",
        category: "contribution_flow",
        severity: "warning",
        title: "Focus policy needs owner review",
        detail: `${manifest.warnings.length} focus manifest warning(s) were recorded during normalization.`,
        action: "Review the focus manifest shape before publishing onboarding guidance.",
      });
    }

    if (manifest.wantedPaths.length === 0 && manifest.preferredLabels.length === 0 && manifest.publicNotes.length === 0) {
      candidates.push({
        code: "contribution_scope_unclear",
        category: "contribution_flow",
        severity: "warning",
        title: "Contribution scope is unclear",
        detail: "The focus manifest does not define wanted paths, preferred labels, or public scope notes.",
        action: "Add explicit wanted work areas or public scope notes before increasing contributor traffic.",
      });
    }

    if (manifest.blockedPaths.length > 0 && manifest.wantedPaths.length === 0) {
      candidates.push({
        code: "blocked_work_without_wanted_scope",
        category: "contribution_flow",
        severity: "warning",
        title: "Blocked work lacks a positive lane",
        detail: "The focus manifest blocks work areas but does not define wanted paths.",
        action: "Pair blocked areas with wanted work areas so contributors know where to focus.",
      });
    }

    if (input.lane.lane === "direct_pr" && manifest.linkedIssuePolicy === "optional" && !input.settings.requireLinkedIssue) {
      candidates.push({
        code: "direct_pr_policy_unclear",
        category: "direct_pr_policy",
        severity: "warning",
        title: "Direct PR entry policy is loose",
        detail: "Direct PR intake is enabled without a linked-issue expectation in settings or focus policy.",
        action: "Decide whether direct PRs should link tracked issues before inviting more direct submissions.",
      });
    }

    if (input.settings.requireLinkedIssue && manifest.linkedIssuePolicy === "optional") {
      candidates.push({
        code: "linked_issue_policy_mismatch",
        category: "direct_pr_policy",
        severity: "info",
        title: "Linked-issue policy differs by source",
        detail: "Repository settings require linked issues, while the focus manifest leaves linked issues optional.",
        action: "Align settings and focus policy so owner guidance stays consistent.",
      });
    }

    if ((input.lane.lane === "issue_discovery" || input.lane.lane === "split") && manifest.issueDiscoveryPolicy === "discouraged") {
      candidates.push({
        code: "issue_discovery_policy_mismatch",
        category: "issue_discovery",
        severity: "warning",
        title: "Issue-discovery lane conflicts with focus policy",
        detail: "The registry lane allows issue discovery, but the focus manifest discourages new issue reports.",
        action: "Clarify whether issue discovery should stay open before publishing owner guidance.",
      });
    } else if (input.lane.lane === "direct_pr" && manifest.issueDiscoveryPolicy === "encouraged") {
      candidates.push({
        code: "issue_discovery_policy_mismatch",
        category: "issue_discovery",
        severity: "info",
        title: "Issue-discovery policy differs from registry lane",
        detail: "The focus manifest welcomes issue reports while the registry lane is direct-PR-first.",
        action: "Keep public guidance direct-PR-first unless maintainers intentionally open issue discovery.",
      });
    }

    if (manifest.testExpectations.length === 0) {
      candidates.push({
        code: "validation_expectations_missing",
        category: "validation",
        severity: "warning",
        title: "Validation expectations are missing",
        detail: "The focus manifest does not define test or validation expectations for incoming work.",
        action: "Add expected validation commands or evidence requirements before publishing contribution guidance.",
      });
    }
  }

  if ((input.lane.lane === "issue_discovery" || input.lane.lane === "split") && input.contributorIntakeHealth.level !== "healthy") {
    candidates.push({
      code: "issue_discovery_intake_not_ready",
      category: "issue_discovery",
      severity: input.contributorIntakeHealth.level === "blocked" ? "critical" : "warning",
      title: "Issue-discovery intake needs attention",
      detail: `Issue discovery is available, but contributor intake is ${input.contributorIntakeHealth.level}.`,
      action: "Stabilize intake and triage capacity before inviting more issue reports.",
    });
  }

  if (!input.labelAudit.trustedPipelineReady) {
    candidates.push({
      code: "validation_gate_uncertain",
      category: "validation",
      severity: "warning",
      title: "Validation gate is not verified",
      detail: "The trusted label pipeline is not verified for this repository.",
      action: "Verify label and validation gates before relying on automated readiness guidance.",
    });
  }

  if (input.queueHealth.level === "high" || input.queueHealth.level === "critical" || input.contributorIntakeHealth.level === "strained" || input.contributorIntakeHealth.level === "blocked") {
    candidates.push({
      code: "maintainer_burden_high",
      category: "maintainer_burden",
      severity: input.queueHealth.level === "critical" || input.contributorIntakeHealth.level === "blocked" ? "critical" : "warning",
      title: "Maintainer burden is elevated",
      detail: `Queue burden is ${input.queueHealth.level} and contributor intake is ${input.contributorIntakeHealth.level}.`,
      action: "Reduce queue pressure or narrow accepted lanes before inviting more contributor traffic.",
    });
  }

  const droppedPublicWarnings: RepoPolicyReadinessReport["droppedPublicWarnings"] = [];
  const publicWarnings = dedupeWarnings(candidates).filter((warning) => {
    const safe = warningTextValues(warning).every(isFocusManifestPublicSafe);
    if (!safe) droppedPublicWarnings.push({ code: warning.code, reason: "unsafe_public_text" });
    return safe;
  });

  return {
    repoFullName: input.repoFullName,
    source: "focus_manifest_policy",
    previewOnly: true,
    present,
    publicWarnings,
    ownerContext: {
      manifestPresent: present,
      manifestSource: manifest?.source ?? "none",
      privateNoteCount: manifest?.maintainerNotes.length ?? 0,
      manifestWarningCount: manifest?.warnings.length ?? 0,
      wantedPathCount: manifest?.wantedPaths.length ?? 0,
      blockedPathCount: manifest?.blockedPaths.length ?? 0,
      validationExpectationCount: manifest?.testExpectations.length ?? 0,
      queueLevel: input.queueHealth.level,
      contributorIntakeLevel: input.contributorIntakeHealth.level,
      configLevel: input.configQuality.level,
      issuePolicy,
      issueDiscoveryPolicy: manifest?.issueDiscoveryPolicy ?? "neutral",
    },
    droppedPublicWarnings,
    summary:
      publicWarnings.length > 0
        ? `${publicWarnings.length} policy readiness warning(s) need owner review before broader contributor traffic.`
        : "Policy readiness has no public-safe warnings for owner review.",
  };
}

export function policyReadinessWarningText(warning: RepoPolicyReadinessWarning): string {
  return `${warning.title}: ${warning.detail} ${warning.action}`;
}

function resolveIssuePolicy(lane: LaneAdvice, settings: RepositorySettings): string {
  if (lane.lane === "issue_discovery") return "issue_discovery_enabled";
  if (lane.lane === "split") return "split_pr_and_issue_discovery_enabled";
  return settings.requireLinkedIssue ? "direct_pr_requires_linked_issue" : "direct_pr_no_issue_required";
}

function dedupeWarnings(warnings: RepoPolicyReadinessWarning[]): RepoPolicyReadinessWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    if (seen.has(warning.code)) return false;
    seen.add(warning.code);
    return true;
  });
}

function warningTextValues(warning: RepoPolicyReadinessWarning): string[] {
  return [warning.title, warning.detail, warning.action, policyReadinessWarningText(warning)];
}
