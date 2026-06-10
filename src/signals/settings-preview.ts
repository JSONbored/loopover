import type { CommandAuthorizationRole, IssueRecord, PullRequestRecord, RepositoryRecord, RepositorySettings } from "../types";
import {
  evaluateCommandAuthorization,
  summarizeCommandAuthorizationPolicy,
  type CommandAuthorizationDecision,
} from "../settings/command-authorization";
import { nowIso } from "../utils/json";
import {
  buildCollisionReport,
  buildContributorProfile,
  buildPreflightResult,
  buildPublicPrIntelligenceComment,
  buildQueueHealth,
  type ContributorDetection,
} from "./engine";
import { REQUIRED_INSTALLATION_PERMISSIONS } from "../github/backfill";

export function hasVisiblePrSurface(settings: RepositorySettings): boolean {
  return settings.publicSurface !== "off" || settings.checkRunMode === "enabled" || settings.gateCheckMode === "enabled";
}

export function shouldPublishPrComment(settings: RepositorySettings, minerStatus: PublicSurfaceMinerStatus = "not_checked"): boolean {
  if (settings.commentMode === "off") return false;
  if (settings.publicSurface !== "comment_and_label" && settings.publicSurface !== "comment_only") return false;
  if (settings.commentMode === "detected_contributors_only") return minerStatus === "confirmed";
  return true;
}

export function shouldApplyPrLabel(settings: RepositorySettings, minerStatus: PublicSurfaceMinerStatus = "not_checked"): boolean {
  if (settings.publicAudienceMode === "oss_maintainer" && minerStatus !== "confirmed") return false;
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
  if (settings.publicAudienceMode === "gittensor_only") {
    if (input.minerStatus === "unavailable") return skipDecision("miner_detection_unavailable");
    if (input.minerStatus === "not_found") return skipDecision("not_official_gittensor_miner");
  }

  const willComment = shouldPublishPrComment(settings, input.minerStatus);
  const willLabel =
    shouldApplyPrLabel(settings, input.minerStatus) ||
    (settings.publicAudienceMode === "oss_maintainer" && input.minerStatus === "not_checked" && settings.autoLabelEnabled && (settings.publicSurface === "comment_and_label" || settings.publicSurface === "label_only"));
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
  commandName?: string | undefined;
  commenterLogin?: string | null | undefined;
  commenterAssociation?: string | null | undefined;
};

export type InstallationHealthSummary = {
  installationId: number;
  status: "healthy" | "needs_attention" | "broken";
  missingPermissions: string[];
  missingEvents: string[];
  permissionRemediation: Array<{ permission: string; requiredAccess: string; currentAccess: string; ok: boolean; action: string }>;
};

export type RepoInstallPreviewStatus = "ready" | "needs_attention" | "blocked";

export type RepoInstallPreviewChecklistItem = {
  id: string;
  category: "permissions" | "public_outputs" | "private_context" | "command_authorization" | "audit" | "sanitizer" | "manual_control";
  status: RepoInstallPreviewStatus;
  label: string;
  summary: string;
  action: string;
};

export type RepoInstallPreview = {
  status: RepoInstallPreviewStatus;
  summary: string;
  readScope: string[];
  computedContext: string[];
  previewBehavior: string[];
  permissions: {
    status: RepoInstallPreviewStatus;
    required: string[];
    missing: string[];
    missingEvents: string[];
    summary: string;
  };
  publicOutputs: string[];
  privateOnlyContext: string[];
  commandAuthorization: string[];
  auditBehavior: string[];
  sanitizerBoundaries: string[];
  manualControls: string[];
  checklist: RepoInstallPreviewChecklistItem[];
};

export type RepoSettingsPreview = {
  repoFullName: string;
  generatedAt: string;
  settings: {
    publicSurface: RepositorySettings["publicSurface"];
    commentMode: RepositorySettings["commentMode"];
    publicAudienceMode: RepositorySettings["publicAudienceMode"];
    publicSignalLevel: RepositorySettings["publicSignalLevel"];
    checkRunMode: RepositorySettings["checkRunMode"];
    checkRunDetailLevel: RepositorySettings["checkRunDetailLevel"];
    gateCheckMode: RepositorySettings["gateCheckMode"];
    linkedIssueGateMode: RepositorySettings["linkedIssueGateMode"];
    duplicatePrGateMode: RepositorySettings["duplicatePrGateMode"];
    qualityGateMode: RepositorySettings["qualityGateMode"];
    qualityGateMinScore?: number | null | undefined;
    autoLabelEnabled: boolean;
    gittensorLabel: string;
    createMissingLabel: boolean;
    includeMaintainerAuthors: boolean;
    requireLinkedIssue: boolean;
    commandAuthorization: {
      defaultAllowed: CommandAuthorizationRole[];
      commandOverrides: Array<{ command: string; allowedRoles: CommandAuthorizationRole[] }>;
    };
  };
  commandAuthorizationPreview: {
    commandName: string;
    commenterLogin: string;
    commenterAssociation: string;
    decision: CommandAuthorizationDecision;
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
  installPreview: RepoInstallPreview;
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
  const commandName = args.sample.commandName?.trim() || "preflight";
  const commenterLogin = args.sample.commenterLogin?.trim() || sample.authorLogin;
  const commenterAssociation = args.sample.commenterAssociation || sample.authorAssociation;
  const commandAuthorizationPreview = {
    commandName,
    commenterLogin,
    commenterAssociation,
    decision: evaluateCommandAuthorization({
      policy: settings.commandAuthorization,
      commandName,
      commenterLogin,
      commenterAssociation,
      pullRequestAuthorLogin: sample.authorLogin,
      minerStatus: sample.minerStatus,
    }),
  };
  const installPreview = buildRepoInstallPreview({
    repo,
    settings,
    installation: args.installation,
    decision,
    appliedLabel: decision.willLabel ? settings.gittensorLabel : null,
  });

  return {
    repoFullName,
    generatedAt: nowIso(),
    settings: {
      publicSurface: settings.publicSurface,
      commentMode: settings.commentMode,
      publicAudienceMode: settings.publicAudienceMode,
      publicSignalLevel: settings.publicSignalLevel,
      checkRunMode: settings.checkRunMode,
      checkRunDetailLevel: settings.checkRunDetailLevel,
      gateCheckMode: settings.gateCheckMode,
      linkedIssueGateMode: settings.linkedIssueGateMode,
      duplicatePrGateMode: settings.duplicatePrGateMode,
      qualityGateMode: settings.qualityGateMode,
      qualityGateMinScore: settings.qualityGateMinScore ?? null,
      autoLabelEnabled: settings.autoLabelEnabled,
      gittensorLabel: settings.gittensorLabel,
      createMissingLabel: settings.createMissingLabel,
      includeMaintainerAuthors: settings.includeMaintainerAuthors,
      requireLinkedIssue: settings.requireLinkedIssue,
      commandAuthorization: summarizeCommandAuthorizationPolicy(settings.commandAuthorization),
    },
    commandAuthorizationPreview,
    installation: args.installation,
    sample,
    decision,
    previewComment,
    appliedLabel: decision.willLabel ? settings.gittensorLabel : null,
    checkRun: decision.willCheckRun ? { willCreate: true, title: "Gittensory Context", detailLevel: settings.checkRunDetailLevel } : null,
    installPreview,
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
    warnings.push(
      "Comments and labels use GitHub Issues endpoints and require GitHub App permission Issues: write. Set Issues to write, then approve the change.",
    );
  }
  if (settings.checkRunMode === "enabled" && missing.has("checks")) {
    warnings.push("Check runs are enabled but GitHub App permission Checks: write is missing. Set repository permission checks to write, then approve the change.");
  }
  if (settings.gateCheckMode === "enabled" && missing.has("checks")) {
    warnings.push("Gate checks are enabled but GitHub App permission Checks: write is missing. Set repository permission checks to write, then approve the change.");
  }
  for (const event of installation.missingEvents) {
    warnings.push(`The GitHub App is not subscribed to the ${event} webhook event; subscribe to it so Gittensory receives the relevant deliveries.`);
  }
  if (installation.status !== "healthy" && warnings.length === 0) {
    warnings.push(`Installation status is ${installation.status}; review the installation health endpoint for remediation steps.`);
  }
  return warnings;
}

function buildRepoInstallPreview(args: {
  repo: RepositoryRecord | null;
  settings: RepositorySettings;
  installation: InstallationHealthSummary | null;
  decision: PublicSurfaceDecision;
  appliedLabel: string | null;
}): RepoInstallPreview {
  const required = requiredInstallPermissions(args.settings, args.decision);
  const missing = activeMissingPermissions(args.settings, args.decision, args.installation);
  const missingEvents = args.installation?.missingEvents ?? [];
  const permissionStatus: RepoInstallPreviewStatus = !args.installation || args.installation.status === "broken" ? "blocked" : missing.length > 0 || missingEvents.length > 0 || args.installation.status === "needs_attention" ? "needs_attention" : "ready";
  const publicOutputStatus: RepoInstallPreviewStatus = args.settings.commentMode === "all_prs" || args.settings.gateCheckMode === "enabled" ? "needs_attention" : "ready";
  const commandAuthorizationStatus: RepoInstallPreviewStatus = !args.installation ? "blocked" : new Set(args.installation.missingPermissions).has("issues") ? "needs_attention" : "ready";
  const manualControlStatus: RepoInstallPreviewStatus = args.settings.commentMode === "all_prs" ? "needs_attention" : "ready";
  const checklist: RepoInstallPreviewChecklistItem[] = [
    {
      id: "permissions",
      category: "permissions",
      status: permissionStatus,
      label: "Permissions and events",
      summary: permissionSummary(args.installation, missing, missingEvents),
      action: permissionStatus === "ready" ? "No permission change is needed for this previewed behavior." : "Refresh installation health, then approve the missing permission or webhook event before enabling public output.",
    },
    {
      id: "public-outputs",
      category: "public_outputs",
      status: publicOutputStatus,
      label: "Public outputs",
      summary: publicOutputSummary(args.decision),
      action: publicOutputStatus === "ready" ? "Review the rendered public preview before enabling this repo." : "Review all-PR or gate mode carefully; advisory-only output is quieter for first enablement.",
    },
    {
      id: "private-context",
      category: "private_context",
      status: "ready",
      label: "Private-only context",
      summary: "Decision packs, blocker detail, maintainer packet evidence, and scoring evidence stay on authenticated API or MCP surfaces.",
      action: "Keep private evidence out of public issue bodies, PR bodies, comments, and copied snippets.",
    },
    {
      id: "command-authorization",
      category: "command_authorization",
      status: commandAuthorizationStatus,
      label: "Command authorization",
      summary: "Public command responses require a maintainer or confirmed PR author; maintainer queue commands require owner, member, or collaborator context.",
      action:
        commandAuthorizationStatus === "ready"
          ? "Use command previews to confirm actor and permission behavior before relying on repo commands."
          : "Restore Issues: write before enabling public command responses.",
    },
    {
      id: "audit-behavior",
      category: "audit",
      status: "ready",
      label: "Audit behavior",
      summary: "This preview is read-only; live webhook skips, command handling, auth, and usage paths are recorded through audit or product-usage logs.",
      action: "Use preview output for review; use live audit records for production behavior after enablement.",
    },
    {
      id: "sanitizer-boundaries",
      category: "sanitizer",
      status: "ready",
      label: "Sanitizer boundaries",
      summary: "Public comments and copied snippets are sanitized before they leave the Worker.",
      action: "Private evidence remains authenticated-only and should not be copied into public surfaces.",
    },
    {
      id: "manual-controls",
      category: "manual_control",
      status: manualControlStatus,
      label: "Manual controls",
      summary: "Public audience, public surface mode, comments, labels, context checks, gate checks, maintainer-author inclusion, and linked-issue requirements remain repo-controlled settings.",
      action: manualControlStatus === "ready" ? "Enable only the specific public surface you want after previewing it." : "Switch away from all-PR mode unless broad public output is intentional.",
    },
  ];
  const status = checklist.some((item) => item.status === "blocked") ? "blocked" : checklist.some((item) => item.status === "needs_attention") ? "needs_attention" : "ready";

  return {
    status,
    summary:
      status === "ready"
        ? "Install preview is ready for maintainer review before enabling repo commands."
        : status === "blocked"
          ? "Install preview has a blocking setup gap before repo commands should be enabled."
          : "Install preview is usable, but one or more setup details need maintainer attention.",
    readScope: [
      "Cached repository metadata, issues, pull requests, labels, linked issues, repo settings, and installation health.",
      args.repo?.isInstalled ? "GitHub App installation metadata for the selected repository." : "No GitHub App installation metadata is linked to this repository yet.",
    ],
    computedContext: [
      "Public surface decision for comment, label, check-run, or skip behavior.",
      "Queue, collision, contributor profile, and preflight context for the sample public preview.",
    ],
    previewBehavior: [
      "The dry-run preview does not create GitHub comments, labels, check runs, or installation changes.",
      "A public comment body is rendered only when current settings would comment for the sample PR.",
    ],
    permissions: {
      status: permissionStatus,
      required,
      missing,
      missingEvents,
      summary: permissionSummary(args.installation, missing, missingEvents),
    },
    publicOutputs: publicOutputsFor(args.decision, args.appliedLabel, args.settings),
    privateOnlyContext: [
      "Decision packs, blocker details, maintainer packet evidence, and scoring evidence stay authenticated-only.",
      "This preview uses cached metadata and the supplied sample PR fields; it does not upload repository source.",
    ],
    commandAuthorization: [
      "Maintainer-only commands require owner, member, or collaborator context.",
      "Contributor-invoked public commands require the commenter to be the confirmed PR author.",
      "Private API commands require authenticated control-panel access and do not post public GitHub output.",
    ],
    auditBehavior: [
      "This preview is read-only and does not mutate GitHub.",
      "Live webhook skips, command handling, miner-detection fallbacks, auth, and usage paths are audit or product-usage logged.",
    ],
    sanitizerBoundaries: [
      "Public GitHub comments and copied snippets are sanitized before posting.",
      "Credential/key material, compensation estimates, trust metrics, score-prediction claims, private review evidence, private scoring evidence, and gaming language stay out of public output.",
      "Private evidence is not copied into public comments, issue bodies, PR bodies, or extension public panels.",
    ],
    manualControls: [
      "Public surface mode, comment mode, label name, check-run mode, maintainer-author inclusion, and linked-issue requirements remain repo settings.",
      "Maintainers preview first, then enable the specific public output they want.",
    ],
    checklist,
  };
}

function writesPrPublicSurface(settings: RepositorySettings, decision: PublicSurfaceDecision): boolean {
  return decision.willComment || decision.willLabel || shouldPublishPrComment(settings, "confirmed") || shouldApplyPrLabel(settings, "confirmed");
}

function requiredInstallPermissions(settings: RepositorySettings, decision: PublicSurfaceDecision): string[] {
  // Read-only base permissions are derived from the canonical constant so this surface stays in sync.
  // Write permissions are gated on whether the current settings actually produce that output.
  const permissions = new Set(
    Object.entries(REQUIRED_INSTALLATION_PERMISSIONS)
      .filter(([, value]) => value === "read")
      .map(([key, value]) => `${key}: ${value}`),
  );
  if (writesPrPublicSurface(settings, decision)) permissions.add("issues: write");
  if (decision.willCheckRun || settings.checkRunMode === "enabled" || settings.gateCheckMode === "enabled") permissions.add("checks: write");
  return [...permissions];
}

function activeMissingPermissions(settings: RepositorySettings, decision: PublicSurfaceDecision, installation: InstallationHealthSummary | null): string[] {
  if (!installation) return [];
  const missing = new Set(installation.missingPermissions);
  const active: string[] = [];
  if (missing.has("pull_requests")) active.push("pull_requests");
  // Comment/label output is gated on issues:write (Issues endpoints), not pull_requests:write.
  if (writesPrPublicSurface(settings, decision) && missing.has("issues")) active.push("issues");
  if ((decision.willCheckRun || settings.checkRunMode === "enabled" || settings.gateCheckMode === "enabled") && missing.has("checks")) active.push("checks");
  return active;
}

function permissionSummary(installation: InstallationHealthSummary | null, missing: string[], missingEvents: string[]): string {
  if (!installation) return "No installation health is cached for this repository.";
  if (installation.status === "broken") return "Installation health is broken and needs recovery before enablement.";
  if (missing.length > 0 || missingEvents.length > 0) {
    return `Installation needs attention: ${[missing.length > 0 ? `missing permission(s) ${missing.join(", ")}` : "", missingEvents.length > 0 ? `missing webhook event(s) ${missingEvents.join(", ")}` : ""].filter(Boolean).join("; ")}.`;
  }
  if (installation.status === "needs_attention") return "Installation health needs attention; review remediation before enabling public output.";
  return "Required permissions and webhook events are ready for the previewed behavior.";
}

function publicOutputsFor(decision: PublicSurfaceDecision, appliedLabel: string | null, settings: RepositorySettings): string[] {
  const gateOutput = settings.gateCheckMode === "enabled" ? ["Opt-in Gittensory Gate check run."] : [];
  if (decision.skipped) return [`No comment or label for this sample: ${decision.summary}`, ...gateOutput];
  const outputs = [
    ...(decision.willComment ? ["One sanitized sticky PR comment."] : []),
    ...(decision.willLabel ? [`Configured label "${appliedLabel ?? "gittensor"}".`] : []),
    ...(decision.willCheckRun ? ["Non-blocking Gittensory Context check run."] : []),
    ...gateOutput,
  ];
  return outputs.length > 0 ? outputs : ["No public comment, label, or check run for this sample."];
}

function publicOutputSummary(decision: PublicSurfaceDecision): string {
  if (decision.skipped) return `Current sample is skipped: ${decision.summary}`;
  return decision.actions.includes("none") ? "The sample qualifies, but no public output action is enabled." : `Current sample would create: ${decision.actions.join(", ")}.`;
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
