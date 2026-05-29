import type { IssueRecord, PullRequestRecord, RepositoryRecord, RepositorySettings } from "../types";
import { nowIso } from "../utils/json";
import {
  buildCollisionReport,
  buildContributorProfile,
  buildPreflightResult,
  buildPublicPrIntelligenceComment,
  buildQueueHealth,
  type ContributorDetection,
} from "./engine";

export function hasVisiblePrSurface(settings: RepositorySettings): boolean {
  return settings.publicSurface !== "off" || settings.checkRunMode === "enabled";
}

export function shouldPublishPrComment(settings: RepositorySettings): boolean {
  if (settings.commentMode === "off") return false;
  return settings.publicSurface === "comment_and_label" || settings.publicSurface === "comment_only";
}

export function shouldApplyPrLabel(settings: RepositorySettings): boolean {
  return settings.autoLabelEnabled && (settings.publicSurface === "comment_and_label" || settings.publicSurface === "label_only");
}

export type PublicSurfaceMinerStatus = "confirmed" | "not_found" | "unavailable" | "not_checked";

export type PublicSurfaceSkipReason =
  | "surface_off"
  | "missing_author"
  | "bot_author"
  | "maintainer_author"
  | "miner_detection_unavailable"
  | "not_official_gittensor_miner";

export type PublicSurfaceAction = "skip" | "comment" | "label" | "check_run" | "none";

export type PublicSurfaceDecisionInput = {
  settings: RepositorySettings;
  authorLogin?: string | null | undefined;
  authorType?: string | null | undefined;
  authorAssociation?: string | null | undefined;
  minerStatus: PublicSurfaceMinerStatus;
};

export type PublicSurfaceDecision = {
  willComment: boolean;
  willLabel: boolean;
  willCheckRun: boolean;
  skipped: boolean;
  skipReason: PublicSurfaceSkipReason | null;
  actions: PublicSurfaceAction[];
  summary: string;
};

const SKIP_SUMMARY: Record<PublicSurfaceSkipReason, string> = {
  surface_off: "Public surface and check runs are both disabled for this repo; nothing would be posted.",
  missing_author: "The pull request has no resolvable author login; Gittensory would skip it.",
  bot_author: "The author is a bot account; Gittensory would skip it.",
  maintainer_author: "The author is a maintainer (owner/member/collaborator) and maintainer authors are excluded by this repo's settings.",
  miner_detection_unavailable: "Official Gittensor miner detection is unavailable, so Gittensory would skip rather than guess.",
  not_official_gittensor_miner: "The author is not a confirmed Gittensor miner; Gittensory would stay quiet.",
};

function skipDecision(reason: PublicSurfaceSkipReason): PublicSurfaceDecision {
  return { willComment: false, willLabel: false, willCheckRun: false, skipped: true, skipReason: reason, actions: ["skip"], summary: SKIP_SUMMARY[reason] };
}

/**
 * Pure decision for what the GitHub App's public surface would do for a PR.
 * This is the single source of truth shared by the live webhook processor and the
 * maintainer-facing dry-run preview, so the preview can never drift from real behavior.
 */
export function decidePublicSurface(input: PublicSurfaceDecisionInput): PublicSurfaceDecision {
  const { settings } = input;
  if (!hasVisiblePrSurface(settings)) return skipDecision("surface_off");
  if (!input.authorLogin) return skipDecision("missing_author");
  if (input.authorType === "Bot" || /\[bot\]$/i.test(input.authorLogin)) return skipDecision("bot_author");
  if (!settings.includeMaintainerAuthors && input.authorAssociation && ["OWNER", "MEMBER", "COLLABORATOR"].includes(input.authorAssociation)) {
    return skipDecision("maintainer_author");
  }
  if (input.minerStatus === "unavailable") return skipDecision("miner_detection_unavailable");
  if (input.minerStatus === "not_found") return skipDecision("not_official_gittensor_miner");

  const willComment = shouldPublishPrComment(settings);
  const willLabel = shouldApplyPrLabel(settings);
  const willCheckRun = settings.checkRunMode === "enabled";
  const actions: PublicSurfaceAction[] = [
    ...(willComment ? (["comment"] as const) : []),
    ...(willLabel ? (["label"] as const) : []),
    ...(willCheckRun ? (["check_run"] as const) : []),
  ];
  const surfaceActions = actions.length > 0 ? actions : (["none"] as PublicSurfaceAction[]);
  return {
    willComment,
    willLabel,
    willCheckRun,
    skipped: false,
    skipReason: null,
    actions: surfaceActions,
    summary: surfaceActions.includes("none")
      ? "The author qualifies, but no surface action is enabled by the current settings."
      : `Gittensory would ${surfaceActions.join(" + ").replace("check_run", "post a minimal check run")} for this PR.`,
  };
}

export type PublicSurfaceSample = {
  authorLogin?: string | null | undefined;
  authorType?: string | null | undefined;
  authorAssociation?: string | null | undefined;
  minerStatus?: "confirmed" | "not_found" | "unavailable" | undefined;
  title?: string | undefined;
  body?: string | null | undefined;
  labels?: string[] | undefined;
  linkedIssues?: number[] | undefined;
};

export type InstallationHealthSummary = {
  installationId: number;
  status: "healthy" | "needs_attention" | "broken";
  missingPermissions: string[];
  missingEvents: string[];
  permissionRemediation: Array<{ permission: string; requiredAccess: string; currentAccess: string; ok: boolean; action: string }>;
};

export type RepoSettingsPreview = {
  repoFullName: string;
  generatedAt: string;
  settings: {
    publicSurface: RepositorySettings["publicSurface"];
    commentMode: RepositorySettings["commentMode"];
    publicSignalLevel: RepositorySettings["publicSignalLevel"];
    checkRunMode: RepositorySettings["checkRunMode"];
    checkRunDetailLevel: RepositorySettings["checkRunDetailLevel"];
    autoLabelEnabled: boolean;
    gittensorLabel: string;
    createMissingLabel: boolean;
    includeMaintainerAuthors: boolean;
    requireLinkedIssue: boolean;
  };
  installation: InstallationHealthSummary | null;
  sample: {
    authorLogin: string;
    authorType: string;
    authorAssociation: string;
    minerStatus: "confirmed" | "not_found" | "unavailable";
    title: string;
    labels: string[];
    linkedIssues: number[];
  };
  decision: PublicSurfaceDecision;
  previewComment: string | null;
  appliedLabel: string | null;
  checkRun: { willCreate: boolean; title: string; detailLevel: RepositorySettings["checkRunDetailLevel"] } | null;
  warnings: string[];
  summary: string;
};

/**
 * Assemble a maintainer-facing dry-run preview of the public surface for a sample PR.
 * Pure and read-only: it never posts to or mutates GitHub.
 */
export function buildRepoSettingsPreview(args: {
  repoFullName: string;
  repo: RepositoryRecord | null;
  settings: RepositorySettings;
  installation: InstallationHealthSummary | null;
  issues: IssueRecord[];
  pullRequests: PullRequestRecord[];
  sample: PublicSurfaceSample;
}): RepoSettingsPreview {
  const { settings, repo, repoFullName } = args;
  const sample = {
    authorLogin: args.sample.authorLogin?.trim() || "sample-contributor",
    authorType: args.sample.authorType || "User",
    authorAssociation: args.sample.authorAssociation || "NONE",
    minerStatus: args.sample.minerStatus ?? ("confirmed" as const),
    title: args.sample.title?.trim() || "Sample pull request",
    labels: args.sample.labels ?? [],
    linkedIssues: args.sample.linkedIssues ?? [],
  };

  const decision = decidePublicSurface({
    settings,
    authorLogin: sample.authorLogin,
    authorType: sample.authorType,
    authorAssociation: sample.authorAssociation,
    minerStatus: sample.minerStatus,
  });

  const previewComment = decision.willComment
    ? buildSamplePreviewComment({ repoFullName, repo, settings, issues: args.issues, pullRequests: args.pullRequests, sample, body: args.sample.body ?? null })
    : null;

  const warnings = buildWarnings(settings, decision, args.installation);

  return {
    repoFullName,
    generatedAt: nowIso(),
    settings: {
      publicSurface: settings.publicSurface,
      commentMode: settings.commentMode,
      publicSignalLevel: settings.publicSignalLevel,
      checkRunMode: settings.checkRunMode,
      checkRunDetailLevel: settings.checkRunDetailLevel,
      autoLabelEnabled: settings.autoLabelEnabled,
      gittensorLabel: settings.gittensorLabel,
      createMissingLabel: settings.createMissingLabel,
      includeMaintainerAuthors: settings.includeMaintainerAuthors,
      requireLinkedIssue: settings.requireLinkedIssue,
    },
    installation: args.installation,
    sample,
    decision,
    previewComment,
    appliedLabel: decision.willLabel ? settings.gittensorLabel : null,
    checkRun: decision.willCheckRun ? { willCreate: true, title: "Gittensory context posted", detailLevel: settings.checkRunDetailLevel } : null,
    warnings,
    summary: decision.skipped
      ? `Sample PR would be skipped: ${decision.summary}`
      : `Sample PR would result in: ${decision.actions.join(", ")}.${warnings.length > 0 ? ` ${warnings.length} permission/config warning(s).` : ""}`,
  };
}

function buildWarnings(settings: RepositorySettings, decision: PublicSurfaceDecision, installation: InstallationHealthSummary | null): string[] {
  const warnings: string[] = [];
  if (!installation) {
    warnings.push("Installation health is unknown for this repo; run refresh-installation-health to verify GitHub App permissions and subscribed events.");
    return warnings;
  }
  const missing = new Set(installation.missingPermissions);
  if ((decision.willComment || decision.willLabel) && missing.has("issues")) {
    warnings.push("Comments and labels require GitHub App permission Issues: write, which is currently missing. Set repository permission issues to write, then approve the change.");
  }
  if (settings.checkRunMode === "enabled" && missing.has("checks")) {
    warnings.push("Check runs are enabled but GitHub App permission Checks: write is missing. Set repository permission checks to write, then approve the change.");
  }
  for (const event of installation.missingEvents) {
    warnings.push(`The GitHub App is not subscribed to the ${event} webhook event; subscribe to it so Gittensory receives the relevant deliveries.`);
  }
  if (installation.status !== "healthy" && warnings.length === 0) {
    warnings.push(`Installation status is ${installation.status}; review the installation health endpoint for remediation steps.`);
  }
  return warnings;
}

function buildSamplePreviewComment(args: {
  repoFullName: string;
  repo: RepositoryRecord | null;
  settings: RepositorySettings;
  issues: IssueRecord[];
  pullRequests: PullRequestRecord[];
  sample: { authorLogin: string; authorAssociation: string; minerStatus: "confirmed" | "not_found" | "unavailable"; title: string; labels: string[]; linkedIssues: number[] };
  body: string | null;
}): string {
  const samplePr: PullRequestRecord = {
    repoFullName: args.repoFullName,
    number: 0,
    title: args.sample.title,
    state: "open",
    authorLogin: args.sample.authorLogin,
    authorAssociation: args.sample.authorAssociation,
    labels: args.sample.labels,
    linkedIssues: args.sample.linkedIssues,
    body: args.body,
  };
  const profile = buildContributorProfile(args.sample.authorLogin, { login: args.sample.authorLogin, topLanguages: [], source: "unavailable" }, [], []);
  const detection: ContributorDetection = { detected: true, reason: "Confirmed Gittensor miner (simulated for preview).", source: "official_gittensor_api", priorPullRequests: 0, priorMergedPullRequests: 0, priorIssues: 0 };
  const collisions = buildCollisionReport(args.repoFullName, args.issues, args.pullRequests);
  const queueHealth = buildQueueHealth(args.repo, args.issues, args.pullRequests, collisions);
  const preflight = buildPreflightResult(
    {
      repoFullName: args.repoFullName,
      contributorLogin: args.sample.authorLogin,
      title: args.sample.title,
      body: args.body ?? undefined,
      labels: args.sample.labels,
      linkedIssues: args.sample.linkedIssues,
      authorAssociation: args.sample.authorAssociation,
    },
    args.repo,
    args.issues,
    args.pullRequests,
  );
  return buildPublicPrIntelligenceComment({ repo: args.repo, pr: samplePr, profile, detection, queueHealth, collisions, preflight, settings: args.settings });
}
