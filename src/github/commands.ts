import { AGENT_COMMAND_COMMENT_MARKER } from "./comments";
import type { AgentRunBundle } from "../services/agent-orchestrator";
import type { GittensorContributorSnapshot, OfficialGittensorMinerDetection } from "../gittensor/api";
import type { AgentActionRecord } from "../types";
import type { CheckSummaryRecord, GitHubIssuePayload, IssueRecord, PullRequestRecord, RecentMergedPullRequestRecord, RepositoryRecord } from "../types";
import { buildCollisionReport, buildQueueHealth, type CollisionCluster, type QueueHealth } from "../signals/engine";

const PUBLIC_MENTION_COMMAND_CATALOG = [
  { id: "help", title: "Gittensory command help", description: "Show public-safe @gittensory command help." },
  { id: "preflight", title: "Gittensory preflight", description: "Summarize public PR hygiene and validation readiness." },
  { id: "blockers", title: "Gittensory readiness blockers", description: "Explain public-safe readiness blockers." },
  { id: "duplicate-check", title: "Gittensory duplicate & WIP check", description: "Summarize duplicate and in-progress overlap caution." },
  { id: "miner-context", title: "Gittensory miner context", description: "Confirm public Gittensor miner context when available." },
  { id: "next-action", title: "Gittensory next step", description: "Suggest the next public-safe action." },
  { id: "reviewability", title: "Gittensory PR readiness", description: "Summarize maintainer-friendly PR readiness without private review internals." },
  { id: "repo-fit", title: "Gittensory repository fit", description: "Summarize public-safe repository fit signals." },
  { id: "packet", title: "Gittensory public packet", description: "Prepare public-safe PR packet guidance." },
] as const;

const MAINTAINER_QUEUE_DIGEST_COMMAND_CATALOG = [
  { id: "queue-summary", title: "Gittensory maintainer queue summary", description: "Post a maintainer-only queue digest from cached GitHub metadata." },
  { id: "confirmed-miners", title: "Gittensory confirmed-miner PRs", description: "List open PRs whose authors are confirmed in the official-miner cache." },
  { id: "review-now", title: "Gittensory review-now queue", description: "List cached PRs that look ready for maintainer review." },
  { id: "needs-author", title: "Gittensory needs-author queue", description: "List cached PRs that need author cleanup before detailed review." },
  { id: "duplicate-clusters", title: "Gittensory duplicate clusters", description: "List duplicate or WIP clusters visible from cached GitHub metadata." },
] as const;

export const GITTENSORY_MENTION_COMMAND_CATALOG = [...PUBLIC_MENTION_COMMAND_CATALOG, ...MAINTAINER_QUEUE_DIGEST_COMMAND_CATALOG] as const;

export type GittensoryMentionCommandName = (typeof GITTENSORY_MENTION_COMMAND_CATALOG)[number]["id"];
export type MaintainerQueueDigestCommandName = (typeof MAINTAINER_QUEUE_DIGEST_COMMAND_CATALOG)[number]["id"];
type SnapshotCommandName = Exclude<GittensoryMentionCommandName, "help" | "miner-context" | MaintainerQueueDigestCommandName>;

export type GittensoryMentionCommand = {
  name: GittensoryMentionCommandName;
  raw: string;
};

type PublicAnswerCard = {
  title: string;
  summary: string;
  findings: string[];
  evidence: string[];
  nextActions: string[];
  sourceNotes: string[];
  safeDetails?: string[] | undefined;
};

export type AgentCommandFeedbackContext = {
  answerId: string;
  command: GittensoryMentionCommandName | null;
};

const COMMANDS = new Set<GittensoryMentionCommandName>(GITTENSORY_MENTION_COMMAND_CATALOG.map((command) => command.id));
const MAINTAINER_QUEUE_DIGEST_COMMANDS = new Set<MaintainerQueueDigestCommandName>(MAINTAINER_QUEUE_DIGEST_COMMAND_CATALOG.map((command) => command.id));
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const AGENT_COMMAND_FEEDBACK_MARKER = "gittensory-agent-command-answer";

const COMMAND_TITLES = Object.fromEntries(GITTENSORY_MENTION_COMMAND_CATALOG.map((command) => [command.id, command.title])) as Record<GittensoryMentionCommandName, string>;

const REFRESH_SECTION_TITLES: Record<SnapshotCommandName, string> = {
  preflight: "Preflight snapshot refresh",
  blockers: "Blocker snapshot refresh",
  "duplicate-check": "Duplicate-check snapshot refresh",
  "next-action": "Next-action snapshot refresh",
  reviewability: "PR readiness snapshot refresh",
  "repo-fit": "Repository fit snapshot refresh",
  packet: "Public packet snapshot refresh",
};

const EMPTY_SECTION_TITLES: Record<SnapshotCommandName, string> = {
  preflight: "Preflight summary",
  blockers: "Readiness blockers",
  "duplicate-check": "Duplicate & WIP caution",
  "next-action": "Recommended next step",
  reviewability: "PR readiness",
  "repo-fit": "Repository fit",
  packet: "Public packet",
};

export type MaintainerQueuePullRequestSummary = {
  number: number;
  title: string;
  authorLogin?: string | null | undefined;
  linkedIssues: number[];
  labels: string[];
  ageDays: number;
  confirmedMiner: boolean;
  signals: Array<"confirmed_miner" | "missing_linked_issue" | "duplicate_or_overlap" | "stale" | "draft" | "checks_need_attention" | "maintainer_authored">;
  reasons: string[];
};

export type MaintainerDuplicateClusterSummary = {
  id: string;
  risk: "medium" | "high";
  reason: string;
  items: Array<{ type: "issue" | "pull_request" | "recent_merged_pull_request"; number: number; title: string }>;
};

export type MaintainerQueueDigest = {
  repoFullName: string;
  generatedAt: string;
  queue: {
    level: QueueHealth["level"];
    openIssues: number;
    openPullRequests: number;
    unlinkedPullRequests: number;
    stalePullRequests: number;
    likelyReviewablePullRequests: number;
    maintainerAuthoredPullRequests: number;
    duplicateClusters: number;
    highRiskDuplicateClusters: number;
  };
  totals: {
    reviewNow: number;
    needsAuthor: number;
    confirmedMinerPullRequests: number;
    duplicateClusters: number;
  };
  reviewNowPullRequests: MaintainerQueuePullRequestSummary[];
  needsAuthorPullRequests: MaintainerQueuePullRequestSummary[];
  confirmedMinerPullRequests: MaintainerQueuePullRequestSummary[];
  duplicateClusters: MaintainerDuplicateClusterSummary[];
  sourceNotes: string[];
  controlPanelUrl?: string | null | undefined;
};

export function parseGittensoryMentionCommand(body: string | null | undefined): GittensoryMentionCommand | null {
  if (!body) return null;
  const match = body.match(/(?:^|\s)@gittensory(?:\s+([a-z-]+))?/i);
  if (!match) return null;
  const requested = (match[1]?.toLowerCase() || "help") as GittensoryMentionCommandName;
  const name = COMMANDS.has(requested) ? requested : "help";
  return { name, raw: match[0].trim() };
}

export function isMaintainerAssociation(association: string | null | undefined): boolean {
  return Boolean(association && MAINTAINER_ASSOCIATIONS.has(association));
}

export function buildAgentCommandFeedbackMarker(answerId: string): string {
  return `<!-- ${AGENT_COMMAND_FEEDBACK_MARKER}:${sanitizeFeedbackAnswerId(answerId)} -->`;
}

export function parseAgentCommandFeedbackContext(body: string | null | undefined): AgentCommandFeedbackContext | null {
  if (!body) return null;
  const answerMatch = body.match(/<!--\s*gittensory-agent-command-answer:([A-Za-z0-9_.:-]{8,120})\s*-->/);
  if (!answerMatch?.[1]) return null;
  const commandMatch = body.match(/Command:\s*`@gittensory\s+([a-z-]+)`/i);
  const requestedCommand = commandMatch?.[1]?.toLowerCase() as GittensoryMentionCommandName | undefined;
  const command = requestedCommand && COMMANDS.has(requestedCommand) ? requestedCommand : null;
  return { answerId: answerMatch[1], command };
}

export function isMaintainerQueueDigestCommand(command: GittensoryMentionCommandName): command is MaintainerQueueDigestCommandName {
  return MAINTAINER_QUEUE_DIGEST_COMMANDS.has(command as MaintainerQueueDigestCommandName);
}

export function isMaintainerOnlyCommand(command: GittensoryMentionCommandName): boolean {
  return isMaintainerQueueDigestCommand(command);
}

export function isAuthorizedCommandActor(args: {
  commandName?: GittensoryMentionCommandName | undefined;
  commenterLogin?: string | null | undefined;
  commenterAssociation?: string | null | undefined;
  pullRequestAuthorLogin?: string | null | undefined;
  officialAuthorDetection?: OfficialGittensorMinerDetection | undefined;
}): { authorized: boolean; reason: string; actorKind: "maintainer" | "author" | "none" } {
  if (isMaintainerAssociation(args.commenterAssociation)) return { authorized: true, reason: "maintainer_invocation", actorKind: "maintainer" };
  if (args.commandName && isMaintainerOnlyCommand(args.commandName)) {
    return { authorized: false, reason: "maintainer_command_requires_maintainer", actorKind: "none" };
  }
  if (!args.commenterLogin || !args.pullRequestAuthorLogin || args.commenterLogin.toLowerCase() !== args.pullRequestAuthorLogin.toLowerCase()) {
    return { authorized: false, reason: "not_maintainer_or_pr_author", actorKind: "none" };
  }
  if (!args.officialAuthorDetection || args.officialAuthorDetection.status === "unavailable") {
    return { authorized: false, reason: "miner_detection_unavailable", actorKind: "author" };
  }
  if (args.officialAuthorDetection.status !== "confirmed") {
    return { authorized: false, reason: "pr_author_not_confirmed_miner", actorKind: "author" };
  }
  return { authorized: true, reason: "confirmed_miner_pr_author", actorKind: "author" };
}

export function buildPublicAgentCommandComment(args: {
  command: GittensoryMentionCommand;
  repo: RepositoryRecord | null;
  issue: GitHubIssuePayload;
  pullRequest: PullRequestRecord | null;
  actorKind: "maintainer" | "author";
  answerId?: string | null | undefined;
  officialMiner?: GittensorContributorSnapshot | null | undefined;
  bundle?: AgentRunBundle | null | undefined;
  maintainerDigest?: MaintainerQueueDigest | null | undefined;
}): string {
  const repoFullName = args.repo?.fullName ?? args.pullRequest?.repoFullName ?? "this repository";
  const sections = commandSections(args.command.name, args.bundle, args.officialMiner, args.maintainerDigest);
  const card = buildPublicAnswerCard({
    command: args.command.name,
    sections,
    bundle: args.bundle,
    officialMiner: args.officialMiner,
    actorKind: args.actorKind,
  });
  const body = [
    AGENT_COMMAND_COMMENT_MARKER,
    `### ${COMMAND_TITLES[args.command.name]}`,
    "",
    `Command: \`@gittensory ${args.command.name}\``,
    `Scope: ${repoFullName}#${args.issue.number}`,
    "",
    ...renderPublicAnswerCard(card),
    ...feedbackPromptSections(args.answerId),
    "",
    "_Advisory context only. Public comments exclude non-public contributor signals and private planning internals._",
  ].join("\n");
  return sanitizePublicComment(body);
}

function buildPublicAnswerCard(args: {
  command: GittensoryMentionCommandName;
  sections: string[];
  bundle: AgentRunBundle | null | undefined;
  officialMiner: GittensorContributorSnapshot | null | undefined;
  actorKind: "maintainer" | "author";
}): PublicAnswerCard {
  const [titleLine, ...contentLines] = args.sections;
  const safeContent = contentLines.map(stripBulletPrefix).filter((line) => line.length > 0);
  const findings = safeContent.length > 0 ? safeContent.slice(0, 5) : ["No public-safe findings are available from the current cached context."];
  return {
    title: stripEmphasis(titleLine ?? "Answer"),
    summary: commandSummary(args.command),
    findings,
    evidence: commandEvidence(args.command, args.bundle, args.officialMiner, args.actorKind),
    nextActions: commandNextActions(args.command, args.bundle),
    sourceNotes: commandSourceNotes(args.command, args.bundle, args.officialMiner),
    safeDetails: safeContent.slice(5),
  };
}

function renderPublicAnswerCard(card: PublicAnswerCard): string[] {
  const lines = [
    `**${sanitizePublicComment(card.title)}**`,
    "",
    `- ${sanitizePublicComment(card.summary)}`,
    "",
    "**Findings**",
    "",
    ...card.findings.map((line) => `- ${sanitizePublicComment(line)}`),
    "",
    "**Evidence**",
    "",
    ...card.evidence.map((line) => `- ${sanitizePublicComment(line)}`),
    "",
    "**Next actions**",
    "",
    ...card.nextActions.map((line) => `- ${sanitizePublicComment(line)}`),
    "",
    "<details>",
    "<summary>Source and freshness</summary>",
    "",
    ...card.sourceNotes.map((line) => `- ${sanitizePublicComment(line)}`),
    "",
    "</details>",
  ];
  if (card.safeDetails && card.safeDetails.length > 0) {
    lines.push("", "<details>", "<summary>Additional safe details</summary>", "", ...card.safeDetails.map((line) => `- ${sanitizePublicComment(line)}`), "", "</details>");
  }
  return lines;
}

function commandSummary(command: GittensoryMentionCommandName): string {
  switch (command) {
    case "help":
      return "Available public commands and their safest use on a PR thread.";
    case "miner-context":
      return "Public miner context from official Gittensor data when available.";
    case "preflight":
      return "Public PR hygiene and validation readiness for this thread.";
    case "blockers":
      return "Public readiness blockers that are safe to show in a PR comment.";
    case "duplicate-check":
      return "Public duplicate, WIP, and queue-overlap caution.";
    case "next-action":
      return "One public-safe next step for the contributor or maintainer.";
    case "reviewability":
      return "Maintainer-friendly PR readiness without private review internals.";
    case "repo-fit":
      return "Public-safe repository fit signals from cached context.";
    case "packet":
      return "Public-safe PR packet guidance for the current thread.";
    case "queue-summary":
      return "Maintainer-only queue-level digest from cached GitHub metadata.";
    case "confirmed-miners":
      return "Maintainer-only confirmed-miner PR list from cached queue metadata.";
    case "review-now":
      return "Maintainer-only review-now queue candidates from cached PR state.";
    case "needs-author":
      return "Maintainer-only author-cleanup queue candidates from cached PR state.";
    case "duplicate-clusters":
      return "Maintainer-only duplicate and WIP cluster summary from cached metadata.";
  }
}

function commandEvidence(
  command: GittensoryMentionCommandName,
  bundle: AgentRunBundle | null | undefined,
  officialMiner: GittensorContributorSnapshot | null | undefined,
  actorKind: "maintainer" | "author",
): string[] {
  const evidence = [`Invocation authorized for ${actorKind} command use.`, "Output is sanitized before posting to GitHub."];
  if (command === "miner-context") {
    evidence.push(officialMiner ? "Official Gittensor miner context was available." : "Official Gittensor miner context was unavailable.");
  }
  if (isMaintainerQueueDigestCommand(command)) {
    evidence.push("Maintainer-only queue digest command was authorized from GitHub author association.");
    evidence.push("Digest uses cached public GitHub queue metadata plus official-miner cache.");
  }
  if (bundle) {
    evidence.push(`Agent response status: ${publicStatus(bundle.run.status)}.`);
  }
  return evidence;
}

function commandNextActions(command: GittensoryMentionCommandName, bundle: AgentRunBundle | null | undefined): string[] {
  if (bundle?.run.status === "needs_snapshot_refresh") return ["Retry after the contributor decision snapshot refresh completes."];
  switch (command) {
    case "help":
      return ["Comment one listed command on the PR thread when more context is needed."];
    case "miner-context":
      return ["Use MCP or the authenticated control panel for private contributor planning."];
    case "preflight":
      return ["Run local validation and rerun before asking for maintainer review."];
    case "blockers":
      return ["Resolve visible blockers before requesting detailed review."];
    case "duplicate-check":
      return ["Compare linked issues, open PRs, and recent merges before expanding the branch."];
    case "next-action":
      return ["Follow the recommended public-safe action, then rerun if PR state changes."];
    case "reviewability":
      return ["Use this as public readiness guidance, then rerun after validation or maintainer state changes."];
    case "repo-fit":
      return ["Use MCP or the authenticated control panel for deeper private repository-fit planning."];
    case "packet":
      return ["Use this as public PR-thread guidance only; keep private scoring and planning details out of comments."];
    case "queue-summary":
      return ["Use the authenticated maintainer dashboard for private evidence and full queue detail."];
    case "confirmed-miners":
      return ["Review confirmed-miner PRs alongside linked issues before prioritizing maintainer attention."];
    case "review-now":
      return ["Use this list to prioritize detailed review, then rerun after checks or queue state changes."];
    case "needs-author":
      return ["Ask authors to clear visible cleanup items before detailed review."];
    case "duplicate-clusters":
      return ["Triage duplicate or WIP overlap before requesting deeper review."];
  }
}

function commandSourceNotes(
  command: GittensoryMentionCommandName,
  bundle: AgentRunBundle | null | undefined,
  officialMiner: GittensorContributorSnapshot | null | undefined,
): string[] {
  const source =
    command === "help"
      ? "static command catalog"
      : command === "miner-context"
        ? officialMiner
          ? "official Gittensor miner API"
          : "official miner check fallback"
        : isMaintainerQueueDigestCommand(command)
          ? "cached GitHub queue metadata and official-miner cache"
        : "cached Gittensory agent context";
  return [
    `Source: ${source}.`,
    `Freshness: ${publicFreshness(bundle, command)}.`,
    "Boundary: public GitHub comment; non-public scoring and planning context is omitted.",
  ];
}

function publicFreshness(bundle: AgentRunBundle | null | undefined, command: GittensoryMentionCommandName): string {
  if (command === "help") return "shipped command list";
  if (isMaintainerQueueDigestCommand(command)) return "cached queue digest generated at invocation time";
  if (!bundle) return "no agent run was required or available";
  if (bundle.run.status === "needs_snapshot_refresh") return "snapshot refresh in progress";
  return `agent run status ${publicStatus(bundle.run.status)}`;
}

function publicStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function stripBulletPrefix(value: string): string {
  return stripEmphasis(value).replace(/^-\s+/, "").trim();
}

function stripEmphasis(value: string): string {
  return value.replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
}

function feedbackPromptSections(answerId: string | null | undefined): string[] {
  if (!answerId) return [];
  return [
    "",
    buildAgentCommandFeedbackMarker(answerId),
    "**Feedback**",
    "",
    "- Use a thumbs-up or thumbs-down reaction to mark whether this answer helped. Feedback is aggregate-only and never changes deterministic results.",
  ];
}

function commandSections(
  command: GittensoryMentionCommandName,
  bundle: AgentRunBundle | null | undefined,
  officialMiner: GittensorContributorSnapshot | null | undefined,
  maintainerDigest: MaintainerQueueDigest | null | undefined,
): string[] {
  switch (command) {
    case "help":
      return helpSections();
    case "miner-context":
      return minerContextSections(officialMiner);
    case "preflight":
      return preflightSections(bundle);
    case "blockers":
      return blockersSections(bundle);
    case "duplicate-check":
      return duplicateCheckSections(bundle);
    case "next-action":
      return nextActionSections(bundle);
    case "reviewability":
      return reviewabilitySections(bundle);
    case "repo-fit":
      return repoFitSections(bundle);
    case "packet":
      return packetSections(bundle);
    case "queue-summary":
    case "confirmed-miners":
    case "review-now":
    case "needs-author":
    case "duplicate-clusters":
      return maintainerDigestSections(command, maintainerDigest);
  }
}

function helpSections(): string[] {
  return [
    "**Commands**",
    "",
    "- `@gittensory help` shows this command list.",
    "- `@gittensory preflight` summarizes public PR hygiene.",
    "- `@gittensory blockers` explains public readiness blockers.",
    "- `@gittensory duplicate-check` summarizes duplicate/WIP caution.",
    "- `@gittensory miner-context` confirms public Gittensor miner context.",
    "- `@gittensory next-action` gives a public-safe next step.",
    "- `@gittensory reviewability` summarizes PR readiness without private review internals.",
    "- `@gittensory repo-fit` summarizes repository fit from cached public-safe signals.",
    "- `@gittensory packet` prepares public-safe PR packet guidance.",
    "- `@gittensory queue-summary` gives maintainers cached queue-level context.",
    "- `@gittensory review-now` lists maintainer-only review candidates.",
    "- `@gittensory needs-author` lists PRs that need author cleanup.",
    "- `@gittensory confirmed-miners` lists cached confirmed-miner PRs.",
    "- `@gittensory duplicate-clusters` lists duplicate/WIP clusters.",
  ];
}

function minerContextSections(miner: GittensorContributorSnapshot | null | undefined): string[] {
  if (!miner) {
    return ["**Miner context**", "", "- Official miner context is unavailable for this public response."];
  }
  return [
    "**Miner context**",
    "",
    `- GitHub user \`${miner.githubUsername}\` is confirmed by the official Gittensor API.`,
    `- Registered-repo PRs observed by Gittensor: ${miner.totals.pullRequests}.`,
    `- Merged registered-repo PRs observed by Gittensor: ${miner.totals.mergedPullRequests}.`,
    "- Use MCP for private branch planning before adding more public review load.",
  ];
}

function preflightSections(bundle: AgentRunBundle | null | undefined): string[] {
  if (bundle?.run.status === "needs_snapshot_refresh") {
    return refreshSections("preflight");
  }
  const actions = pickActions(bundle, (action) =>
    action.actionType === "preflight_branch" || action.actionType === "prepare_pr_packet" || /preflight|pr packet|linked context|validation/i.test(action.publicSafeSummary),
  );
  if (actions.length === 0) {
    return emptySections("preflight");
  }
  return [
    "**Preflight summary**",
    "",
    ...actions.slice(0, 3).flatMap((action) => formatActionBullets(action, { includeBlockers: true, includeRerun: true })),
  ];
}

function blockersSections(bundle: AgentRunBundle | null | undefined): string[] {
  if (bundle?.run.status === "needs_snapshot_refresh") {
    return refreshSections("blockers");
  }
  const actions = pickActions(bundle, (action) =>
    action.actionType === "explain_score_blockers" || action.blockedBy.length > 0 || action.status === "blocked",
  );
  if (actions.length === 0) {
    return ["**Readiness blockers**", "", "- No public readiness blockers are visible from the current cached context."];
  }
  const lines = ["**Readiness blockers**", ""];
  for (const action of actions.slice(0, 4)) {
    lines.push(...formatActionBullets(action, { includeBlockers: true, includeRerun: false }));
  }
  return dedupeBulletLines(lines);
}

function duplicateCheckSections(bundle: AgentRunBundle | null | undefined): string[] {
  if (bundle?.run.status === "needs_snapshot_refresh") {
    return refreshSections("duplicate-check");
  }
  const actions = pickActions(
    bundle,
    (action) => action.actionType === "check_duplicate_risk" || mentionsDuplicateRisk(action),
  );
  if (actions.length === 0) {
    return [
      "**Duplicate & WIP caution**",
      "",
      "- No duplicate or work-in-progress collision signal is visible from the current cached context.",
      "- Compare linked issues, open PRs, and recent merges before requesting detailed review.",
    ];
  }
  const lines = ["**Duplicate & WIP caution**", ""];
  for (const action of actions.slice(0, 4)) {
    lines.push(`- ${publicBlockerDetail(action.publicSafeSummary)}`);
    for (const code of action.blockedBy.slice(0, 3)) {
      lines.push(`- ${publicBlockerLabel(code)}`);
    }
    const caution = [...action.why, action.riskImpact ?? ""]
      .filter((item) => item.trim().length > 0 && (mentionsDuplicateRiskText(item) || /\blikely_duplicate\b/i.test(item)))
      .slice(0, 3)
      .map((item) => `- ${publicBlockerDetail(item)}`);
    lines.push(...caution);
  }
  return dedupeBulletLines(lines);
}

function nextActionSections(bundle: AgentRunBundle | null | undefined): string[] {
  if (bundle?.run.status === "needs_snapshot_refresh") {
    return refreshSections("next-action");
  }
  const actions = pickActions(bundle, (action) =>
    ["choose_next_work", "cleanup_existing_prs", "monitor_existing_pr", "explain_repo_fit"].includes(action.actionType),
  );
  if (actions.length === 0) {
    return emptySections("next-action");
  }
  const top = actions[0]!;
  return [
    "**Recommended next step**",
    "",
    `- ${publicBlockerDetail(top.publicSafeSummary)}`,
    ...(top.blockedBy.length > 0
      ? ["", "**Before proceeding**", "", ...top.blockedBy.slice(0, 4).map((item) => `- ${publicBlockerLabel(item)}`)]
      : []),
    ...(top.rerunWhen ? ["", "**Rerun when**", "", `- ${publicBlockerDetail(top.rerunWhen)}`] : []),
  ];
}

function reviewabilitySections(bundle: AgentRunBundle | null | undefined): string[] {
  if (bundle?.run.status === "needs_snapshot_refresh") {
    return refreshSections("reviewability");
  }
  const actions = pickActions(bundle, (action) =>
    action.actionType === "preflight_branch" || action.actionType === "prepare_pr_packet" || /preflight|packet|validation|maintainer/i.test(action.publicSafeSummary),
  );
  if (actions.length === 0) {
    return emptySections("reviewability");
  }
  return [
    "**PR readiness**",
    "",
    ...actions.slice(0, 3).flatMap((action) => formatActionBullets(action, { includeBlockers: true, includeRerun: true })),
  ];
}

function repoFitSections(bundle: AgentRunBundle | null | undefined): string[] {
  if (bundle?.run.status === "needs_snapshot_refresh") {
    return refreshSections("repo-fit");
  }
  const actions = pickActions(bundle, (action) => action.actionType === "explain_repo_fit" || action.actionType === "choose_next_work" || /repo fit|repository fit|lane fit/i.test(action.publicSafeSummary));
  if (actions.length === 0) {
    return emptySections("repo-fit");
  }
  const lines = ["**Repository fit**", ""];
  for (const action of actions.slice(0, 4)) {
    if (action.targetRepoFullName) lines.push(`- Target: \`${sanitizePublicComment(action.targetRepoFullName)}\``);
    lines.push(`- ${publicBlockerDetail(action.publicSafeSummary)}`);
    if (action.rerunWhen) lines.push(`- Rerun when: ${publicBlockerDetail(action.rerunWhen)}`);
  }
  return dedupeBulletLines(lines);
}

function packetSections(bundle: AgentRunBundle | null | undefined): string[] {
  if (bundle?.run.status === "needs_snapshot_refresh") {
    return refreshSections("packet");
  }
  const actions = pickActions(bundle, (action) => action.actionType === "prepare_pr_packet" || action.safetyClass === "public_safe" || /packet|public-safe PR/i.test(action.publicSafeSummary));
  if (actions.length === 0) {
    return emptySections("packet");
  }
  return [
    "**Public packet**",
    "",
    ...actions.slice(0, 3).flatMap((action) => formatActionBullets(action, { includeBlockers: true, includeRerun: true })),
    "",
    "- Use this as public PR-thread guidance only; keep private scorer context in MCP or the control panel.",
  ];
}

function refreshSections(command: SnapshotCommandName): string[] {
  return [
    `**${REFRESH_SECTION_TITLES[command]}**`,
    "",
    "- Gittensory is refreshing the contributor decision snapshot. Try the command again shortly.",
  ];
}

function emptySections(command: SnapshotCommandName): string[] {
  return [`**${EMPTY_SECTION_TITLES[command]}**`, "", "- No public-safe context is available from the current cached snapshot."];
}

function maintainerDigestSections(command: MaintainerQueueDigestCommandName, digest: MaintainerQueueDigest | null | undefined): string[] {
  if (!digest) {
    return [
      "**Maintainer queue digest**",
      "",
      "- Cached queue context is unavailable for this command.",
      "- Use the authenticated maintainer dashboard for private evidence and full API detail.",
    ];
  }
  const commandSpecific =
    command === "queue-summary"
      ? queueSummarySections(digest)
      : command === "confirmed-miners"
        ? listPrSection("Confirmed-miner PRs", digest.confirmedMinerPullRequests, "No cached confirmed-miner PRs are visible in this queue.")
        : command === "review-now"
          ? listPrSection("Review-now candidates", digest.reviewNowPullRequests, "No cached PR currently looks ready for detailed review.")
          : command === "needs-author"
            ? listPrSection("Needs-author queue", digest.needsAuthorPullRequests, "No cached PR currently needs obvious author cleanup first.")
            : duplicateClusterSection(digest);
  return [
    ...commandSpecific,
    "",
    "**Private detail**",
    "",
    ...(digest.controlPanelUrl
      ? [`- Authenticated control panel: ${digest.controlPanelUrl}`]
      : ["- Use the authenticated maintainer dashboard and private API for full cached evidence."]),
    "- Public GitHub output is limited to cached metadata and safe queue routing notes.",
    "",
    "**Source and freshness**",
    "",
    ...digest.sourceNotes.map((note) => `- ${publicBlockerDetail(note)}`),
    "",
    "**Feedback**",
    "",
    "- Feedback on this response is tracked separately from deterministic queue routing.",
  ];
}

function queueSummarySections(digest: MaintainerQueueDigest): string[] {
  return [
    "**Queue summary**",
    "",
    `- Queue level: ${digest.queue.level}.`,
    `- Open PRs: ${digest.queue.openPullRequests}; open issues: ${digest.queue.openIssues}.`,
    `- Review-now: ${digest.totals.reviewNow}; needs-author: ${digest.totals.needsAuthor}; confirmed-miner PRs: ${digest.totals.confirmedMinerPullRequests}.`,
    `- Duplicate/WIP clusters: ${digest.totals.duplicateClusters}; unlinked PRs: ${digest.queue.unlinkedPullRequests}; stale PRs: ${digest.queue.stalePullRequests}.`,
    `- Maintainer-authored PRs: ${digest.queue.maintainerAuthoredPullRequests}.`,
  ];
}

function listPrSection(title: string, items: MaintainerQueuePullRequestSummary[], empty: string): string[] {
  return [
    `**${title}**`,
    "",
    ...(items.length > 0 ? items.slice(0, 8).map(formatPrDigestItem) : [`- ${empty}`]),
  ];
}

function duplicateClusterSection(digest: MaintainerQueueDigest): string[] {
  return [
    "**Duplicate/WIP clusters**",
    "",
    ...(digest.duplicateClusters.length > 0
      ? digest.duplicateClusters.slice(0, 6).map((cluster) => {
          const refs = cluster.items
            .slice(0, 4)
            .map((item) => `${item.type === "pull_request" ? "PR" : item.type === "issue" ? "issue" : "recent merge"} #${item.number}: ${shortText(item.title, 90)}`)
            .join("; ");
          return `- ${cluster.risk} risk: ${publicBlockerDetail(cluster.reason)} Items: ${refs}.`;
        })
      : ["- No duplicate or WIP cluster is visible from cached metadata."]),
  ];
}

function formatPrDigestItem(item: MaintainerQueuePullRequestSummary): string {
  const author = item.authorLogin ? ` by @${item.authorLogin}` : "";
  const linked = item.linkedIssues.length > 0 ? ` Linked: ${item.linkedIssues.map((issue) => `#${issue}`).join(", ")}.` : "";
  const reasons = item.reasons.slice(0, 3).join("; ");
  return `- #${item.number}: ${shortText(item.title, 100)}${author}.${linked} ${reasons}`;
}

export function buildMaintainerQueueDigest(args: {
  repo: RepositoryRecord | null;
  issues: IssueRecord[];
  pullRequests: PullRequestRecord[];
  recentMergedPullRequests?: RecentMergedPullRequestRecord[] | undefined;
  confirmedMinerLogins?: readonly string[] | undefined;
  checkSummariesByPullNumber?: Record<number, readonly CheckSummaryRecord[]> | undefined;
  controlPanelUrl?: string | null | undefined;
}): MaintainerQueueDigest {
  const repoFullName = args.repo?.fullName ?? args.pullRequests[0]?.repoFullName ?? args.issues[0]?.repoFullName ?? "this repository";
  const openPullRequests = args.pullRequests.filter((pr) => pr.state === "open");
  const collisions = buildCollisionReport(repoFullName, args.issues, args.pullRequests, args.recentMergedPullRequests ?? []);
  const queueHealth = buildQueueHealth(args.repo, args.issues, args.pullRequests, collisions);
  const confirmedMinerLogins = new Set((args.confirmedMinerLogins ?? []).map(normalizeLogin));
  const duplicatePrNumbers = duplicatePullRequestNumbers(collisions.clusters);
  const summaries = openPullRequests.map((pr) => summarizeQueuePullRequest(pr, confirmedMinerLogins, duplicatePrNumbers, args.checkSummariesByPullNumber?.[pr.number] ?? []));
  const needsAuthorPullRequests = summaries.filter(needsAuthorFirst).sort(needsAuthorSort);
  const reviewNowPullRequests = summaries
    .filter((item) => !needsAuthorFirst(item) && item.linkedIssues.length > 0 && !item.signals.includes("draft"))
    .sort(reviewNowSort);
  const confirmedMinerPullRequests = summaries.filter((item) => item.confirmedMiner).sort(reviewNowSort);
  const duplicateClusters = collisions.clusters.filter(isDuplicateWorkCluster).map(toMaintainerDuplicateClusterSummary);
  return {
    repoFullName,
    generatedAt: new Date().toISOString(),
    queue: {
      level: queueHealth.level,
      openIssues: queueHealth.signals.openIssues,
      openPullRequests: queueHealth.signals.openPullRequests,
      unlinkedPullRequests: queueHealth.signals.unlinkedPullRequests,
      stalePullRequests: queueHealth.signals.stalePullRequests,
      likelyReviewablePullRequests: queueHealth.signals.likelyReviewablePullRequests,
      maintainerAuthoredPullRequests: queueHealth.signals.maintainerAuthoredPullRequests,
      duplicateClusters: duplicateClusters.length,
      highRiskDuplicateClusters: duplicateClusters.filter((cluster) => cluster.risk === "high").length,
    },
    totals: {
      reviewNow: reviewNowPullRequests.length,
      needsAuthor: needsAuthorPullRequests.length,
      confirmedMinerPullRequests: confirmedMinerPullRequests.length,
      duplicateClusters: duplicateClusters.length,
    },
    reviewNowPullRequests,
    needsAuthorPullRequests,
    confirmedMinerPullRequests,
    duplicateClusters,
    sourceNotes: [
      "Queue digest uses cached GitHub issues, pull requests, recent merges, checks, PR age, and official-miner cache entries.",
      "Private evidence, detailed blockers, and full command history require authenticated dashboard/API access.",
      "Feedback prompt events are kept separate from deterministic queue routing.",
    ],
    controlPanelUrl: args.controlPanelUrl,
  };
}

function summarizeQueuePullRequest(
  pr: PullRequestRecord,
  confirmedMinerLogins: Set<string>,
  duplicatePrNumbers: Set<number>,
  checks: readonly CheckSummaryRecord[],
): MaintainerQueuePullRequestSummary {
  const ageDays = daysSince(pr.updatedAt ?? pr.createdAt);
  const confirmedMiner = Boolean(pr.authorLogin && confirmedMinerLogins.has(normalizeLogin(pr.authorLogin)));
  const failedChecks = checks.filter((check) => ["failure", "timed_out", "cancelled"].includes(check.conclusion ?? "")).length;
  const signals: MaintainerQueuePullRequestSummary["signals"] = [
    ...(confirmedMiner ? ["confirmed_miner" as const] : []),
    ...(pr.linkedIssues.length === 0 ? ["missing_linked_issue" as const] : []),
    ...(duplicatePrNumbers.has(pr.number) ? ["duplicate_or_overlap" as const] : []),
    ...(ageDays >= 14 ? ["stale" as const] : []),
    ...(pr.isDraft ? ["draft" as const] : []),
    ...(failedChecks > 0 ? ["checks_need_attention" as const] : []),
    ...(isMaintainerAssociation(pr.authorAssociation) ? ["maintainer_authored" as const] : []),
  ];
  const reasons = [
    ...(confirmedMiner ? ["Official-miner cache confirms this author."] : []),
    ...(pr.linkedIssues.length > 0 ? [`Linked issue context is present (${pr.linkedIssues.map((issue) => `#${issue}`).join(", ")}).`] : ["Missing linked issue or no-issue rationale."]),
    ...(duplicatePrNumbers.has(pr.number) ? ["Possible duplicate or WIP overlap needs triage first."] : []),
    ...(ageDays >= 14 ? [`No cached update for ${ageDays} day(s).`] : []),
    ...(pr.isDraft ? ["Draft PR should stay out of detailed review until marked ready."] : []),
    ...(failedChecks > 0 ? [`${failedChecks} cached check(s) need attention.`] : []),
    ...(isMaintainerAssociation(pr.authorAssociation) ? ["Maintainer-authored PR; review as repo stewardship."] : []),
  ];
  return {
    number: pr.number,
    title: pr.title,
    authorLogin: pr.authorLogin,
    linkedIssues: pr.linkedIssues,
    labels: pr.labels,
    ageDays,
    confirmedMiner,
    signals,
    reasons,
  };
}

function needsAuthorFirst(item: MaintainerQueuePullRequestSummary): boolean {
  return item.signals.some((signal) => signal === "missing_linked_issue" || signal === "duplicate_or_overlap" || signal === "stale" || signal === "draft" || signal === "checks_need_attention");
}

function reviewNowSort(left: MaintainerQueuePullRequestSummary, right: MaintainerQueuePullRequestSummary): number {
  return Number(right.confirmedMiner) - Number(left.confirmedMiner) || right.linkedIssues.length - left.linkedIssues.length || right.ageDays - left.ageDays || left.number - right.number;
}

function needsAuthorSort(left: MaintainerQueuePullRequestSummary, right: MaintainerQueuePullRequestSummary): number {
  return signalRank(right) - signalRank(left) || right.ageDays - left.ageDays || left.number - right.number;
}

function signalRank(item: MaintainerQueuePullRequestSummary): number {
  return (
    (item.signals.includes("duplicate_or_overlap") ? 10 : 0) +
    (item.signals.includes("checks_need_attention") ? 4 : 0) +
    (item.signals.includes("missing_linked_issue") ? 3 : 0) +
    (item.signals.includes("draft") ? 2 : 0) +
    (item.signals.includes("stale") ? 1 : 0)
  );
}

function duplicatePullRequestNumbers(clusters: CollisionCluster[]): Set<number> {
  return new Set(clusters.filter(isDuplicateWorkCluster).flatMap((cluster) => cluster.items.filter((item) => item.type === "pull_request").map((item) => item.number)));
}

function isDuplicateWorkCluster(cluster: CollisionCluster): boolean {
  const pullRequestCount = cluster.items.filter((item) => item.type === "pull_request").length;
  const recentMergeCount = cluster.items.filter((item) => item.type === "recent_merged_pull_request").length;
  return pullRequestCount > 1 || (pullRequestCount > 0 && recentMergeCount > 0);
}

function toMaintainerDuplicateClusterSummary(cluster: CollisionCluster): MaintainerDuplicateClusterSummary {
  return {
    id: cluster.id,
    risk: cluster.risk === "high" ? "high" : "medium",
    reason: cluster.reason,
    items: cluster.items.map((item) => ({ type: item.type, number: item.number, title: item.title })),
  };
}

function daysSince(value: string | null | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
}

function normalizeLogin(value: string): string {
  return value.trim().toLowerCase();
}

function shortText(value: string, maxLength: number): string {
  const sanitized = publicBlockerDetail(value).replace(/\s+/g, " ").trim();
  const safeText = neutralizePublicMarkdownText(sanitized);
  return safeText.length > maxLength ? `${safeText.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...` : safeText;
}

function neutralizePublicMarkdownText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}[\]()#+\-.!|])/g, "\\$1")
    .replace(/@(?=[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?)/gi, "@\u200B")
    .replace(/\bhttps?:\/\//gi, (match) => `${match.slice(0, -2)}\u200B//`);
}

function pickActions(
  bundle: AgentRunBundle | null | undefined,
  predicate: (action: AgentActionRecord) => boolean,
): AgentActionRecord[] {
  const actions = bundle?.actions ?? [];
  const matched = actions.filter(predicate);
  return matched.length > 0 ? matched : actions.slice(0, 2);
}

function formatActionBullets(
  action: AgentActionRecord,
  options: { includeBlockers: boolean; includeRerun: boolean },
): string[] {
  const lines = [`- ${publicBlockerDetail(action.publicSafeSummary)}`];
  if (options.includeBlockers && action.blockedBy.length > 0) {
    lines.push(...action.blockedBy.slice(0, 4).map((item) => `- ${publicBlockerLabel(item)}`));
  }
  if (options.includeRerun && action.rerunWhen) {
    lines.push(`- Rerun when: ${publicBlockerDetail(action.rerunWhen)}`);
  }
  return lines;
}

function mentionsDuplicateRisk(action: AgentActionRecord): boolean {
  return [action.publicSafeSummary, action.recommendation, action.riskImpact ?? "", ...action.why, ...action.blockedBy].some((item) =>
    mentionsDuplicateRiskText(item),
  );
}

function mentionsDuplicateRiskText(value: string): boolean {
  return /\b(duplicate|overlap|wip|collision|concurrent|in[- ]progress)\b/i.test(value);
}

function publicBlockerLabel(code: string): string {
  const normalized = code.trim().toLowerCase();
  const labels: Record<string, string> = {
    likely_duplicate: "Possible overlap with existing work",
    open_pr_pressure: "Open pull request queue pressure",
    closed_pr_credibility: "Closed pull request credibility signal",
    inactive_or_unknown_lane: "Repository lane is inactive or unknown",
    issue_discovery_only: "Repository is issue-discovery only",
    low_credibility: "Contributor credibility needs improvement",
    maintainer_lane: "Maintainer-lane activity is separate from outside-contributor work",
  };
  return labels[normalized] ?? sanitizePublicComment(code.replace(/_/g, " "));
}

function publicBlockerDetail(value: string): string {
  return sanitizePublicInlineDetail(
    sanitizePublicComment(
      value
        .replace(/\blikely_duplicate\b/gi, "possible overlap with existing work")
        .replace(/\bcheck_duplicate_risk\b/gi, "duplicate-risk review")
        .replace(/\bopen_pr_pressure\b/gi, "open pull request pressure"),
    ),
  );
}

function sanitizePublicInlineDetail(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/@(?=[A-Za-z0-9_-])/g, "@\u200B")
    .replace(/[\\`*_{}[\]()#+>|]/g, "\\$&")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeBulletLines(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    if (!line.startsWith("- ")) return true;
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });
}

function sanitizeFeedbackAnswerId(answerId: string): string {
  return answerId.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 120);
}

export function sanitizePublicComment(value: string): string {
  const sanitized = value
    .replace(/\b(raw trust score|trust score|wallet|hotkey|coldkey|seed phrase|mnemonic)\b/gi, "private context")
    .replace(/\b(public score estimate|estimated score|score estimate|reward estimates?|payout|farming|scoreability|score preview)\b/gi, "private context")
    .replace(/\b(private reviewability|reviewability internals?)\b/gi, "private context")
    .replace(/\b(private ranking|private rankings)\b/gi, "private context")
    .replace(/\blikely_duplicate\b/gi, "possible overlap with existing work");
  return sanitizeReviewabilityTerm(sanitized).replace(/private context(?:,\s*private context)+/gi, "private context");
}

function sanitizeReviewabilityTerm(value: string): string {
  return value.replace(/\breviewability\b/gi, (match, offset, fullText: string) => {
    const prefix = fullText.slice(Math.max(0, offset - "@gittensory ".length), offset).toLowerCase();
    return prefix.endsWith("@gittensory ") ? match : "private context";
  });
}
