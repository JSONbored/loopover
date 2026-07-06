import { AGENT_COMMAND_COMMENT_MARKER } from "./comments";
import {
  buildDidYouMeanSections,
  suggestCommand as suggestCommandFromCatalog,
  type CommandSuggestCatalog,
} from "./command-suggest";
import { gittensoryFooter, GITTENSORY_SITE_URL } from "./footer";
import type { AgentRunBundle } from "../services/agent-orchestrator";
import type { GittensorContributorSnapshot, OfficialGittensorMinerDetection } from "../gittensor/api";
import type { AgentActionRecord, RepositoryCommandAuthorizationPolicy } from "../types";
import type { CheckSummaryRecord, GitHubIssuePayload, IssueRecord, PullRequestRecord, RecentMergedPullRequestRecord, RepositoryRecord } from "../types";
import { evaluateCommandAuthorization } from "../settings/command-authorization";
import {
  buildBurdenForecast,
  buildCollisionReport,
  buildContributorIntakeHealth,
  buildQueueHealth,
  buildRepoOutcomePatterns,
  type BurdenForecast,
  type CollisionCluster,
  type ContributorIntakeHealth,
  type QueueHealth,
  type RepoOutcomePatterns,
} from "../signals/engine";
import { isFailingCheckSummary } from "../signals/local-branch";
import { buildMaintainerNoiseReport, type MaintainerNoiseReport } from "../signals/reward-risk";

const PUBLIC_MENTION_COMMAND_CATALOG = [
  { id: "help", title: "Gittensory command help", description: "Show public-safe @gittensory command help." },
  { id: "ask", title: "Gittensory contribution context Q&A", description: "Answer contribution-quality questions from connected cached sources with citations." },
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
  { id: "burden-forecast", title: "Gittensory burden forecast", description: "Project maintainer review load and queue-growth risk from cached metadata." },
  { id: "intake-health", title: "Gittensory intake health", description: "Summarize contributor-intake health from cached queue and config signals." },
  { id: "outcome-patterns", title: "Gittensory outcome patterns", description: "Summarize what this repo actually merges vs closes from cached PR outcomes." },
  { id: "noise-report", title: "Gittensory noise report", description: "Highlight queue noise sources maintainers should triage first." },
] as const;

export const GITTENSORY_MENTION_COMMAND_CATALOG = [...PUBLIC_MENTION_COMMAND_CATALOG, ...MAINTAINER_QUEUE_DIGEST_COMMAND_CATALOG] as const;

export type GittensoryMentionCommandName = (typeof GITTENSORY_MENTION_COMMAND_CATALOG)[number]["id"];
export type MaintainerQueueDigestCommandName = (typeof MAINTAINER_QUEUE_DIGEST_COMMAND_CATALOG)[number]["id"];
type SnapshotCommandName = Exclude<GittensoryMentionCommandName, "help" | "miner-context" | MaintainerQueueDigestCommandName>;

// Action commands are NOT Q&A: they perform a side effect (handled before the mention-command path) rather
// than producing a public answer card. They are intentionally kept OUT of the Q&A catalog/unions so the
// exhaustive Q&A switches stay total, but parseGittensoryMentionCommand still recognizes them (so a bare
// @gittensory gate-override is not silently downgraded to "help"). #1960 adds the PR control-surface verbs
// (review, pause, resume, resolve, configuration, explain) as pure parse targets; per-command dispatch is
// wired incrementally in follow-up bounties, each mirroring maybeProcessGateOverrideCommand.
export const GITTENSORY_ACTION_COMMAND_CATALOG = [
  {
    id: "gate-override",
    title: "Gate override",
    description: "Record a maintainer override for this commit's gate check only (does not persist across new commits).",
  },
  {
    id: "review",
    title: "Request review",
    description: "Request an auto-review run on the current PR head (`@gittensory re-review` is an alias).",
  },
  {
    id: "pause",
    title: "Pause auto-review",
    description: "Pause auto-review for this PR with an optional reason; does not change gate enforcement.",
  },
  {
    id: "resume",
    title: "Resume auto-review",
    description: "Resume auto-review for this PR with an optional reason; does not change gate enforcement.",
  },
  {
    id: "resolve",
    title: "Resolve finding",
    description: "Mark a review finding as resolved, optionally naming the finding in trailing text.",
  },
  {
    id: "configuration",
    title: "Show configuration",
    description: "Show the effective resolved review configuration for this repository.",
  },
  {
    id: "explain",
    title: "Explain finding",
    description: "Explain a specific review finding; supply the finding reference in trailing text.",
  },
] as const;

export type GittensoryActionCommandName = (typeof GITTENSORY_ACTION_COMMAND_CATALOG)[number]["id"];

export const GITTENSORY_ACTION_COMMANDS = GITTENSORY_ACTION_COMMAND_CATALOG.map(
  (command) => command.id,
) as readonly GittensoryActionCommandName[];

// Alternate spellings that resolve to a canonical action command name so both forms dispatch to the same
// handler. Only "re-review" exists today (#1960); the map stays a single source of truth for any future alias.
const GITTENSORY_ACTION_COMMAND_ALIASES: Record<string, GittensoryActionCommandName> = {
  "re-review": "review",
};

export type GittensoryMentionCommand = {
  name: GittensoryMentionCommandName | GittensoryActionCommandName;
  raw: string;
  question?: string | undefined;
  reason?: string | undefined;
  argument?: string | undefined;
  /** Present when a non-empty verb was unrecognized and downgraded to `help` (#2170). */
  unknownVerb?: string | undefined;
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
const ACTION_COMMANDS = new Set<GittensoryActionCommandName>(GITTENSORY_ACTION_COMMANDS);
const MAINTAINER_QUEUE_DIGEST_COMMANDS = new Set<MaintainerQueueDigestCommandName>(MAINTAINER_QUEUE_DIGEST_COMMAND_CATALOG.map((command) => command.id));
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const AGENT_COMMAND_FEEDBACK_MARKER = "gittensory-agent-command-answer";

const COMMAND_TITLES = Object.fromEntries(GITTENSORY_MENTION_COMMAND_CATALOG.map((command) => [command.id, command.title])) as Record<GittensoryMentionCommandName, string>;

const REFRESH_SECTION_TITLES: Record<SnapshotCommandName, string> = {
  ask: "Contribution context snapshot refresh",
  preflight: "Preflight snapshot refresh",
  blockers: "Blocker snapshot refresh",
  "duplicate-check": "Duplicate-check snapshot refresh",
  "next-action": "Next-action snapshot refresh",
  reviewability: "PR readiness snapshot refresh",
  "repo-fit": "Repository fit snapshot refresh",
  packet: "Public packet snapshot refresh",
};

const EMPTY_SECTION_TITLES: Record<SnapshotCommandName, string> = {
  ask: "Contribution context Q&A",
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
  burdenForecast: BurdenForecast;
  intakeHealth: ContributorIntakeHealth;
  outcomePatterns: RepoOutcomePatterns;
  noiseReport: MaintainerNoiseReport;
  sourceNotes: string[];
  controlPanelUrl?: string | null | undefined;
};

// Verbs whose trailing free text is a lookup key (e.g. `explain <finding-id>`) rather than free-form prose —
// exposed as `argument` instead of `reason` so a handler can tell "no target supplied" apart from "no reason
// supplied" (#1960). Every other action command (gate-override, pause, resolve) keeps the existing `reason` shape.
const ARGUMENT_ACTION_COMMANDS = new Set<GittensoryActionCommandName>(["explain"]);

function commandSuggestCatalog(): CommandSuggestCatalog {
  return {
    mentionCommands: GITTENSORY_MENTION_COMMAND_CATALOG.map((command) => command.id),
    actionCommands: GITTENSORY_ACTION_COMMANDS,
    actionAliases: GITTENSORY_ACTION_COMMAND_ALIASES,
  };
}

/** Pure did-you-mean suggester for unrecognized @gittensory verbs (#2170). */
export function suggestCommand(rawVerb: string): string | null {
  return suggestCommandFromCatalog(rawVerb, commandSuggestCatalog());
}

export function parseGittensoryMentionCommand(body: string | null | undefined): GittensoryMentionCommand | null {
  if (!body) return null;
  // `(?![\w-])` requires the mention to end at a non-identifier char, so other usernames that merely
  // start with "@gittensory" — `@gittensory-bot`, `@gittensorybot`, `@gittensory2` — are not misread as a
  // bare `@gittensory help` command. A space, end-of-string, or punctuation still matches.
  const match = body.match(/(?:^|\s)@gittensory(?![\w-])(?:\s+([a-z-]+))?([^\n\r]*)/i);
  if (!match) return null;
  const rawVerbToken = match[1]?.toLowerCase();
  if (!rawVerbToken) {
    return { name: "help", raw: match[0].trim() };
  }
  const requested = (GITTENSORY_ACTION_COMMAND_ALIASES[rawVerbToken] ?? rawVerbToken) as GittensoryMentionCommandName | GittensoryActionCommandName;
  if (ACTION_COMMANDS.has(requested as GittensoryActionCommandName)) {
    // match[2] is captured by a `*`-quantified group outside any optional wrapper, so it always matches
    // (possibly empty) and is never actually undefined; the ?? below is a noUncheckedIndexedAccess guard only.
    /* v8 ignore next */
    const trailing = (match[2] ?? "").trim();
    const tail = trailing.length > 0 ? trailing : undefined;
    const name = requested as GittensoryActionCommandName;
    return ARGUMENT_ACTION_COMMANDS.has(name)
      ? { name, raw: match[0].trim(), argument: tail }
      : { name, raw: match[0].trim(), reason: tail };
  }
  if (COMMANDS.has(requested as GittensoryMentionCommandName)) {
    const name = requested as GittensoryMentionCommandName;
    // match[2] is always defined for the same reason as the action-command path above.
    /* v8 ignore next */
    const question = name === "ask" ? (match[2] ?? "").trim() : undefined;
    return {
      name,
      raw: match[0].trim(),
      question: question && question.length > 0 ? question : undefined,
    };
  }
  return { name: "help", raw: match[0].trim(), unknownVerb: rawVerbToken };
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

/** True for gate-override and every #1960 PR control-surface verb (review/pause/resume/resolve/configuration/
 *  explain) — the action commands that perform a side effect via their own dispatch rather than the Q&A answer-
 *  card path. The Q&A mention-command handler (maybeProcessGittensoryMentionCommand) uses this to bail before
 *  narrowing to a GittensoryMentionCommandName, so a newly-registered action verb is never misrendered as a
 *  Q&A card while its own dispatch handler has not landed yet (or has, and already claimed the event). */
export function isGittensoryActionCommand(name: GittensoryMentionCommandName | GittensoryActionCommandName): name is GittensoryActionCommandName {
  return ACTION_COMMANDS.has(name as GittensoryActionCommandName);
}

// Commands that dispatch to a real AI orchestrator call (planNextWork / explainBlockersWithAgent /
// preflightBranchWithAgent / preparePrPacketWithAgent in buildMentionCommandBundle), as opposed to `help`,
// `miner-context` (both no-op), and every maintainer queue-digest command (cache-only DB reads via
// buildMaintainerQueueDigestForCommand, no AI call at all) (#2560). Used to apply a tighter per-command rate
// limit to the AI-cost-bearing surface than the cheap one.
const AI_COST_BEARING_COMMANDS = new Set<GittensoryMentionCommandName>([
  "ask",
  "blockers",
  "preflight",
  "reviewability",
  "packet",
  "duplicate-check",
  "next-action",
  "repo-fit",
]);

export function isAiCostBearingCommand(command: GittensoryMentionCommandName): boolean {
  return AI_COST_BEARING_COMMANDS.has(command);
}

export function isAuthorizedCommandActor(args: {
  commandName?: GittensoryMentionCommandName | undefined;
  commenterLogin?: string | null | undefined;
  commenterAssociation?: string | null | undefined;
  pullRequestAuthorLogin?: string | null | undefined;
  officialAuthorDetection?: OfficialGittensorMinerDetection | undefined;
  commandAuthorizationPolicy?: RepositoryCommandAuthorizationPolicy | null | undefined;
}): { authorized: boolean; reason: string; actorKind: "maintainer" | "author" | "none" } {
  const decision = evaluateCommandAuthorization({
    policy: args.commandAuthorizationPolicy,
    commandName: args.commandName ?? "preflight",
    commenterLogin: args.commenterLogin,
    commenterAssociation: args.commenterAssociation,
    pullRequestAuthorLogin: args.pullRequestAuthorLogin,
    minerStatus: args.officialAuthorDetection?.status,
  });
  return { authorized: decision.authorized, reason: decision.reason, actorKind: decision.actorKind };
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
  // Action commands (e.g. gate-override) never reach this Q&A renderer — they are handled and short-circuited
  // earlier — so narrow the widened parse name back to a Q&A command name for the answer-card helpers.
  const commandName = args.command.name as GittensoryMentionCommandName;
  const sections = commandSections(
    commandName,
    args.bundle,
    args.officialMiner,
    args.maintainerDigest,
    args.command.question,
    args.command.unknownVerb,
  );
  const card = buildPublicAnswerCard({
    command: commandName,
    sections,
    bundle: args.bundle,
    officialMiner: args.officialMiner,
    actorKind: args.actorKind,
    question: commandName === "ask" ? args.command.question : undefined,
  });
  const body = [
    AGENT_COMMAND_COMMENT_MARKER,
    "",
    "> [!NOTE]",
    `> **${COMMAND_TITLES[commandName]}**`,
    "> Gittensory updated this command response in place from cached public-safe context.",
    "",
    "| Signal | State |",
    "| --- | --- |",
    `| Command | \`@gittensory ${commandName}\` |`,
    `| Scope | ${repoFullName}#${args.issue.number} |`,
    `| Actor | ${args.actorKind} |`,
    "",
    `Command: \`@gittensory ${commandName}\``,
    "",
    "<details>",
    "<summary>Command result</summary>",
    "",
    ...renderPublicAnswerCard(card),
    "",
    "</details>",
    ...feedbackPromptSections(args.answerId),
    "",
    "---",
    gittensoryFooter(),
  ].join("\n");
  return sanitizePublicComment(body);
}

function buildPublicAnswerCard(args: {
  command: GittensoryMentionCommandName;
  sections: string[];
  bundle: AgentRunBundle | null | undefined;
  officialMiner: GittensorContributorSnapshot | null | undefined;
  actorKind: "maintainer" | "author";
  question?: string | undefined;
}): PublicAnswerCard {
  if (args.command === "ask") {
    return buildAskPublicAnswerCard(args);
  }
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

function buildAskPublicAnswerCard(args: {
  bundle: AgentRunBundle | null | undefined;
  officialMiner: GittensorContributorSnapshot | null | undefined;
  actorKind: "maintainer" | "author";
  question?: string | undefined;
}): PublicAnswerCard {
  const title = "Contribution context Q&A";
  if (args.bundle?.run.status === "needs_snapshot_refresh") {
    return {
      title,
      summary: commandSummary("ask"),
      findings: [
        stripEmphasis(REFRESH_SECTION_TITLES.ask),
        "Gittensory is refreshing connected contribution-context snapshots (cached issues, PRs, signals, and decision packs). Try @gittensory ask again shortly.",
      ],
      evidence: commandEvidence("ask", args.bundle, args.officialMiner, args.actorKind),
      nextActions: commandNextActions("ask", args.bundle),
      sourceNotes: commandSourceNotes("ask", args.bundle, args.officialMiner),
    };
  }

  const contributingSources = prioritizeAskSources(collectAskContributingSources(args.bundle));
  const citationLines = contributingSources.slice(0, 8).map((source) => stripBulletPrefix(formatAskCitation(source)));
  const answerLines = pickActions(args.bundle, () => true)
    .slice(0, 3)
    .map((action) => (action.targetRepoFullName ? `${action.targetRepoFullName}: ${action.publicSafeSummary}` : action.publicSafeSummary))
    .filter((line) => line.trim().length > 0)
    .map((line) => publicBlockerDetail(line));
  // neutralizePublicMarkdownText (not just sanitizePublicComment) escapes markdown/HTML and zero-width-spaces
  // @mentions and bare URLs — the question is free-form contributor text, so without it an authorized-but-
  // untrusted actor (ask is not maintainer-gated; a confirmed-miner PR author qualifies) could post
  // `@gittensory ask **APPROVED by @maintainer**` and have that bold, live-mentioning line render verbatim
  // inside the bot's own trusted comment (#2457).
  const questionText = neutralizePublicMarkdownText(
    sanitizePublicComment(args.question?.trim() || "No specific question was provided; this response summarizes the closest cached contribution context."),
  );
  const findings = [
    `Question: ${questionText}`,
    ...(answerLines.length > 0 ? answerLines : ["No matching contribution-quality context is available in the current cached sources."]),
    // Only the first 4 citations belong in Findings; citations 5+ overflow into safeDetails via
    // `citationLines.slice(4)` below. Emitting the full list here duplicated those overflow citations in
    // both sections of the same public comment when a run had 5+ contributing sources.
    ...(citationLines.length > 0 ? citationLines.slice(0, 4) : ["No concrete cached source reference is available for this response."]),
  ];
  const sourceEvidence = contributingSources.slice(0, 3).map((source) => {
    const observed = source.generatedAt ? ` as of ${source.generatedAt}` : "";
    return `Connected source ${source.label}: freshness ${source.freshness}${observed}.`;
  });
  return {
    title,
    summary: commandSummary("ask"),
    findings,
    evidence: [...commandEvidence("ask", args.bundle, args.officialMiner, args.actorKind), ...sourceEvidence],
    nextActions: commandNextActions("ask", args.bundle),
    sourceNotes: commandSourceNotes("ask", args.bundle, args.officialMiner),
    safeDetails: [
      ...(citationLines.length > 4 ? citationLines.slice(4) : []),
      "README/docs context is included only when connected repo sources and app permissions allow it.",
      "Source contents are not sent to optional AI unless explicitly enabled.",
    ],
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
    case "ask":
      return "Contribution-context Q&A from connected cached sources, scoped to contribution quality and repository policy.";
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
    case "burden-forecast":
      return "Maintainer-only review-load and queue-growth forecast from cached metadata.";
    case "intake-health":
      return "Maintainer-only contributor-intake health summary from cached queue and config signals.";
    case "outcome-patterns":
      return "Maintainer-only summary of what this repo merges vs closes from cached PR outcomes.";
    case "noise-report":
      return "Maintainer-only queue-noise summary highlighting what to triage first.";
  }
}

function commandEvidence(
  command: GittensoryMentionCommandName,
  bundle: AgentRunBundle | null | undefined,
  officialMiner: GittensorContributorSnapshot | null | undefined,
  actorKind: "maintainer" | "author",
): string[] {
  const evidence = [`Invocation authorized for ${actorKind} command use.`, "Output is sanitized before posting to GitHub."];
  if (command === "ask") {
    evidence.push("Answer scope is limited to contribution quality and repository policy.");
    evidence.push("Sources are cited with freshness and public-boundary redaction.");
  }
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
  if (bundle?.run.status === "needs_snapshot_refresh") {
    return command === "ask"
      ? ["Retry @gittensory ask after the contribution context snapshot refresh completes."]
      : ["Retry after the contributor decision snapshot refresh completes."];
  }
  switch (command) {
    case "help":
      return ["Comment one listed command on the PR thread when more context is needed."];
    case "ask":
      return ["Ask one concrete contribution-quality question per command for clearer cited guidance."];
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
    case "burden-forecast":
      return ["Use this forecast to plan review capacity; rerun after the queue changes."];
    case "intake-health":
      return ["Address the lowest intake-health signals before inviting more contributions."];
    case "outcome-patterns":
      return ["Steer contributors toward the patterns this repo actually merges."];
    case "noise-report":
      return ["Clear the listed noise sources before deeper review to reduce queue drag."];
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
      : command === "ask"
        ? askCommandSourceSummary(bundle)
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
  if (bundle.run.status === "needs_snapshot_refresh") {
    return command === "ask" ? "contribution context snapshot refresh in progress" : "snapshot refresh in progress";
  }
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
  question?: string | undefined,
  /** Only read when `command === "help"` (#2170 did-you-mean hint). */
  unknownVerb?: string | undefined,
): string[] {
  switch (command) {
    case "help":
      return helpSections(unknownVerb);
    case "ask":
      return askSections(bundle, question);
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
    case "burden-forecast":
    case "intake-health":
    case "outcome-patterns":
    case "noise-report":
      return maintainerDigestSections(command, maintainerDigest);
  }
}

function actionCommandHelpSections(): string[] {
  return [
    "**PR action commands**",
    "",
    "- These verbs require maintainer or collaborator authorization (per command-authorization policy).",
    "- `pause` and `resume` affect only auto-review scheduling — they never change the gate disposition or make review advisory.",
    "",
    ...GITTENSORY_ACTION_COMMAND_CATALOG.map(
      (command) => `- \`@gittensory ${command.id}\` ${sanitizePublicComment(command.description)}`,
    ),
  ];
}

function helpSections(unknownVerb?: string | undefined): string[] {
  return [
    "**Commands**",
    "",
    ...buildDidYouMeanSections(unknownVerb, suggestCommand),
    "- `@gittensory help` shows this command list.",
    "- `@gittensory ask <question>` answers contribution-quality Q&A with source citations and freshness.",
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
    "- `@gittensory burden-forecast` projects maintainer review load and queue-growth risk.",
    "- `@gittensory intake-health` summarizes contributor-intake health.",
    "- `@gittensory outcome-patterns` summarizes what the repo merges vs closes.",
    "- `@gittensory noise-report` highlights queue noise to triage first.",
    "",
    ...actionCommandHelpSections(),
    "",
    `- Full command reference (syntax, roles, gate boundary): ${GITTENSORY_SITE_URL}/docs/gittensory-commands`,
  ];
}

type AskContributingSource = {
  key: string;
  label: string;
  origin: string;
  generatedAt: string | null;
  freshness: string;
  detail: string;
};

function askSections(bundle: AgentRunBundle | null | undefined, question?: string): string[] {
  if (bundle?.run.status === "needs_snapshot_refresh") {
    return refreshSections("ask");
  }
  const sourceReferences = askSourceReferences(bundle);
  const cited = pickActions(bundle, () => true)
    .slice(0, 4)
    .map((action) => action.targetRepoFullName ? `${action.targetRepoFullName}: ${action.publicSafeSummary}` : action.publicSafeSummary)
    .filter((line) => line.trim().length > 0)
    .map((line) => `- ${publicBlockerDetail(line)}`);
  return [
    "**Contribution context Q&A**",
    "",
    // Same escaping as buildAskPublicAnswerCard's questionText (#2457) — this is the sibling render path.
    `- Question: ${neutralizePublicMarkdownText(sanitizePublicComment(question?.trim() || "No specific question was provided; this response summarizes the closest cached contribution context."))}`,
    "",
    "**Answer**",
    "",
    ...(cited.length > 0 ? cited : ["- No matching contribution-quality context is available in the current cached sources."]),
    "",
    "**Citations**",
    "",
    ...(sourceReferences.length > 0 ? sourceReferences : ["- No concrete cached source reference is available for this response."]),
    "",
    "**Policy**",
    "",
    "- README/docs context is included only when connected repo sources and app permissions allow it.",
    "- Source contents are not sent to optional AI unless explicitly enabled.",
  ];
}

const ASK_SOURCE_DISPLAY_PRIORITY = [
  "contributor_decision_pack",
  "open_pr_monitor",
  "repo_decision",
  "github_cache",
  "official_gittensor",
  "repo_focus_manifest",
  "upstream_ruleset",
  "issue_quality",
  "computed",
  "mirror",
  "metadata_only",
  "cached_signals",
] as const;

function prioritizeAskSources(sources: AskContributingSource[]): AskContributingSource[] {
  const rank = (origin: string) => {
    const index = ASK_SOURCE_DISPLAY_PRIORITY.indexOf(origin as (typeof ASK_SOURCE_DISPLAY_PRIORITY)[number]);
    return index >= 0 ? index : ASK_SOURCE_DISPLAY_PRIORITY.length;
  };
  return [...sources].sort((left, right) => rank(left.origin) - rank(right.origin) || left.label.localeCompare(right.label));
}

function askSourceReferences(bundle: AgentRunBundle | null | undefined): string[] {
  return prioritizeAskSources(collectAskContributingSources(bundle)).slice(0, 8).map(formatAskCitation);
}

function collectAskContributingSources(bundle: AgentRunBundle | null | undefined): AskContributingSource[] {
  if (!bundle) return [];
  const collected: AskContributingSource[] = [];
  const seen = new Set<string>();
  const add = (entry: AskContributingSource | null | undefined) => {
    if (!entry) return;
    const dedupeKey = `${entry.key}|${entry.origin}|${entry.freshness}|${entry.generatedAt ?? ""}|${entry.detail}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    collected.push(entry);
  };
  for (const snapshot of bundle.contextSnapshots) {
    for (const entry of askSourcesFromContextSnapshot(snapshot)) add(entry);
  }
  for (const action of bundle.actions) {
    for (const entry of askSourcesFromActionEvidence(action)) add(entry);
  }
  return collected;
}

function askCommandSourceSummary(bundle: AgentRunBundle | null | undefined): string {
  const sources = collectAskContributingSources(bundle);
  if (sources.length === 0) return "cached Gittensory agent context (no connected-source metadata in this run)";
  return sources
    .slice(0, 4)
    .map((source) => source.label)
    .join("; ");
}

function askSourcesFromContextSnapshot(snapshot: AgentRunBundle["contextSnapshots"][number]): AskContributingSource[] {
  const payload = snapshot.payload ?? {};
  const generatedAt = snapshot.createdAt ?? snapshot.decisionPackVersion ?? null;
  const sources: AskContributingSource[] = [];
  const graph = payload.evidenceGraph;
  if (graph && typeof graph === "object" && !Array.isArray(graph)) {
    const graphRecord = graph as Record<string, unknown>;
    const graphGeneratedAt = typeof graphRecord.generatedAt === "string" ? graphRecord.generatedAt : generatedAt;
    const graphSources = graphRecord.sources;
    if (Array.isArray(graphSources)) {
      for (const item of graphSources) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        const kind = typeof record.source === "string" ? record.source : "connected_source";
        sources.push({
          key: `evidence_graph_${kind}`,
          label: askSourceLabel(kind),
          origin: kind,
          generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : graphGeneratedAt,
          freshness: typeof record.freshness === "string" ? record.freshness : "unknown",
          detail: publicContextSnapshotSourceDetail(kind),
        });
      }
    }
  }
  const baseFreshness = readRecord(payload.baseFreshness);
  if (baseFreshness) {
    sources.push({
      key: "base_freshness",
      label: askSourceLabel("base_freshness"),
      origin: "metadata_only",
      generatedAt: typeof baseFreshness.observedAt === "string" ? baseFreshness.observedAt : generatedAt,
      freshness: typeof baseFreshness.status === "string" ? baseFreshness.status : "unknown",
      detail: "Repo/issue/PR sync freshness used for contribution-context answers.",
    });
  }
  const branchEligibility = readRecord(payload.branchEligibility);
  if (branchEligibility) {
    sources.push({
      key: "branch_eligibility",
      label: askSourceLabel("branch_eligibility"),
      origin: "metadata_only",
      generatedAt,
      freshness: branchEligibility.stale === true ? "stale" : branchEligibility.evidence === "missing" ? "missing" : "fresh",
      detail: "Branch eligibility metadata from connected local/GitHub context.",
    });
  }
  const dataQuality = readRecord(payload.dataQuality);
  if (dataQuality && typeof dataQuality.status === "string") {
    sources.push({
      key: "signal_data_quality",
      label: askSourceLabel("data_quality"),
      origin: "cached_signals",
      generatedAt,
      freshness: dataQuality.status === "complete" ? "fresh" : String(dataQuality.status),
      detail: "Signal fidelity and data-quality status for connected repo sources.",
    });
  }
  if (snapshot.freshnessWarnings.length > 0) {
    sources.push({
      key: "freshness_warnings",
      label: "snapshot freshness warnings",
      origin: "cached_signals",
      generatedAt,
      freshness: "degraded",
      detail: snapshot.freshnessWarnings.slice(0, 2).join(" "),
    });
  }
  if (typeof payload.source === "string") {
    sources.push({
      key: "contributor_decision_pack",
      label: askSourceLabel("contributor_decision_pack"),
      origin: "contributor_decision_pack",
      generatedAt: generatedAt ?? snapshot.decisionPackVersion ?? null,
      freshness: snapshotFreshnessFromWarnings(snapshot),
      detail: "Contributor decision-pack metadata was available for this cached agent run.",
    });
  }
  const openPrMonitor = readRecord(payload.openPrMonitor);
  if (openPrMonitor) {
    sources.push({
      key: "open_pr_monitor",
      label: askSourceLabel("open_pr_monitor"),
      origin: "open_pr_monitor",
      generatedAt,
      freshness: typeof openPrMonitor.freshness === "string" ? openPrMonitor.freshness : "unknown",
      detail: "Cached open PR and issue queue used for contribution-context answers.",
    });
  }
  return sources;
}

function publicContextSnapshotSourceDetail(name: string): string {
  const details: Record<string, string> = {
    computed: "Computed contributor-signal metadata was available for this cached agent run.",
    mirror: "Gittensor mirror registry metadata was available for this cached agent run.",
    repo_focus_manifest: "Repo focus manifest metadata was available for this cached agent run.",
    open_pr_monitor: "Cached open PR and issue queue metadata was available for this cached agent run.",
  };
  return details[name] ?? "Connected contributor evidence metadata was available for this cached agent run.";
}

const PRIVATE_ASK_ACTION_EVIDENCE_SOURCES = new Set(["repo_decision", "score_preview"]);

function askSourcesFromActionEvidence(action: AgentActionRecord): AskContributingSource[] {
  const evidence = readRecord(action.payload.recommendationEvidence);
  if (!evidence || !Array.isArray(evidence.sources)) return [];
  return evidence.sources
    .map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const source = raw as Record<string, unknown>;
      const name = typeof source.name === "string" ? source.name : "connected_source";
      if (PRIVATE_ASK_ACTION_EVIDENCE_SOURCES.has(name)) return null;
      return {
        key: name,
        label: askSourceLabel(name),
        origin: name,
        generatedAt: typeof source.generatedAt === "string" ? source.generatedAt : null,
        freshness: typeof source.freshness === "string" ? source.freshness : "unknown",
        detail: publicActionEvidenceSourceDetail(name),
      };
    })
    .filter((entry): entry is AskContributingSource => entry !== null);
}

function publicActionEvidenceSourceDetail(name: string): string {
  const details: Record<string, string> = {
    contributor_decision_pack: "Contributor decision-pack metadata was available for this cached agent run.",
    official_contributor_stats: "Official contributor statistics metadata was available for this cached agent run.",
    repo_outcome_history: "Repo outcome history metadata was available for this cached agent run.",
    aggregate_outcome_quality: "Aggregate outcome-quality metadata was available for this cached agent run.",
    open_pr_monitor: "Cached open PR and issue queue metadata was available for this cached agent run.",
  };
  return details[name] ?? "Connected recommendation evidence metadata was available for this cached agent run.";
}

function formatAskCitation(source: AskContributingSource): string {
  const header = `Source: ${source.label}; freshness: ${source.freshness}`;
  const observed = source.generatedAt ? ` as of ${source.generatedAt}` : "";
  const detail = source.detail ? ` — ${publicBlockerDetail(source.detail)}` : "";
  return `- ${header}${observed}${detail}.`;
}

function askSourceLabel(name: string): string {
  const labels: Record<string, string> = {
    contributor_decision_pack: "contributor decision pack snapshot",
    repo_decision: "repo decision snapshot",
    official_contributor_stats: "official Gittensor contributor stats",
    repo_outcome_history: "repo outcome history",
    open_pr_monitor: "cached GitHub open PR/issue queue",
    local_branch_metadata: "local branch metadata (metadata-only)",
    base_branch_freshness: "local git branch freshness",
    base_freshness: "repo sync freshness metadata",
    branch_eligibility: "branch eligibility metadata",
    github_branch_status: "cached GitHub branch status",
    linked_issue_multiplier: "linked-issue policy context",
    score_preview: "private score preview metadata",
    data_quality: "signal data-quality status",
    official_gittensor: "official Gittensor API/cache",
    mirror: "Gittensor mirror registry snapshot",
    github_cache: "cached GitHub issues, PRs, reviews, and checks",
    computed: "derived Gittensory contribution signals",
    repo_focus_manifest: "repo focus manifest",
    issue_quality: "issue quality snapshot",
    upstream_ruleset: "upstream ruleset status",
  };
  return labels[name] ?? name.replace(/_/g, " ");
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function snapshotFreshnessFromWarnings(snapshot: AgentRunBundle["contextSnapshots"][number]): string {
  if (snapshot.freshnessWarnings.some((warning) => /stale|rebuild/i.test(warning))) return "stale";
  return "fresh";
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
  const body =
    command === "ask"
      ? "- Gittensory is refreshing connected contribution-context snapshots (cached issues, PRs, signals, and decision packs). Try @gittensory ask again shortly."
      : "- Gittensory is refreshing the contributor decision snapshot. Try the command again shortly.";
  return [`**${REFRESH_SECTION_TITLES[command]}**`, "", body];
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
            : command === "duplicate-clusters"
              ? duplicateClusterSection(digest)
              : command === "burden-forecast"
                ? burdenForecastSection(digest.burdenForecast)
                : command === "intake-health"
                  ? intakeHealthSection(digest.intakeHealth)
                  : command === "outcome-patterns"
                    ? outcomePatternsSection(digest.outcomePatterns)
                    : noiseReportSection(digest.noiseReport);
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

// Render up to the top three signal findings as public-safe bullets. Prefers the finding's
// explicit publicText (already vetted for a public audience) over the internal title, and routes
// every line through publicBlockerDetail so no private readiness/scoring vocabulary leaks.
function findingDigestLines(findings: Array<{ title: string; publicText?: string | undefined }>): string[] {
  return findings.slice(0, 3).map((finding) => `- ${publicBlockerDetail(finding.publicText ?? finding.title)}`);
}

// `@gittensory burden-forecast` renderer: surfaces the maintainer review-load / queue-growth
// forecast (level, projected load, reviewable/stale counts) so maintainers can plan capacity.
function burdenForecastSection(forecast: BurdenForecast): string[] {
  return [
    "**Burden forecast**",
    "",
    `- Forecast level: ${forecast.level} (horizon ${forecast.horizonDays} days).`,
    `- ${publicBlockerDetail(forecast.summary)}`,
    `- Projected review load: ${forecast.forecast.projectedReviewLoad}; queue-growth risk: ${forecast.forecast.queueGrowthRisk}.`,
    `- Reviewable PRs: ${forecast.forecast.reviewablePullRequests}; stale PRs: ${forecast.forecast.stalePullRequests}; duplicate trend: ${forecast.forecast.duplicateTrend}.`,
    ...findingDigestLines(forecast.findings),
  ];
}

// `@gittensory intake-health` renderer: summarizes how healthy contributor intake is (level, config
// quality, duplicate clusters, reviewable PRs) so maintainers can see whether the repo is set up to
// absorb more contributions before inviting them.
function intakeHealthSection(intake: ContributorIntakeHealth): string[] {
  return [
    "**Contributor intake health**",
    "",
    `- Intake level: ${intake.level}.`,
    `- ${publicBlockerDetail(intake.summary)}`,
    `- Config quality: ${intake.configLevel}; duplicate clusters: ${intake.duplicateClusters}; reviewable PRs: ${intake.reviewablePullRequests}.`,
    ...findingDigestLines(intake.findings),
  ];
}

// `@gittensory outcome-patterns` renderer: summarizes what the repo actually merges vs closes
// (totals, merge rates, and the top success/risk pattern when present) so maintainers can steer
// contributors toward the patterns that get merged. The success/risk lines are omitted when the
// cached sample has no pattern of that kind.
function outcomePatternsSection(patterns: RepoOutcomePatterns): string[] {
  return [
    "**Outcome patterns**",
    "",
    `- Lane: ${patterns.lane}; PRs analyzed: ${patterns.totals.analyzed}.`,
    `- ${publicBlockerDetail(patterns.summary)}`,
    `- Merged: ${patterns.totals.merged}; closed unmerged: ${patterns.totals.closedUnmerged}; open active: ${patterns.totals.openActive}; open stale: ${patterns.totals.openStale}.`,
    `- Outside-contributor merge rate: ${Math.round(patterns.outsideContributorMergeRate * 100)}%; maintainer-lane merge rate: ${Math.round(patterns.maintainerLaneMergeRate * 100)}%.`,
    ...(patterns.successPatterns.length > 0 ? [`- Merges when: ${publicBlockerDetail(patterns.successPatterns[0]!.detail)}`] : []),
    ...(patterns.riskPatterns.length > 0 ? [`- Closes when: ${publicBlockerDetail(patterns.riskPatterns[0]!.detail)}`] : []),
  ];
}

// `@gittensory noise-report` renderer: highlights the queue-noise sources maintainers should triage
// first (level, up to five noise sources, and the suggested triage actions). Falls back to a
// "no obvious noise" line when the cached metadata shows none, and omits the triage line when there
// are no suggested actions.
function noiseReportSection(noise: MaintainerNoiseReport): string[] {
  return [
    "**Noise report**",
    "",
    `- Noise level: ${noise.level}.`,
    `- ${publicBlockerDetail(noise.summary)}`,
    ...(noise.noiseSources.length > 0
      ? noise.noiseSources.slice(0, 5).map((source) => `- ${publicBlockerDetail(source)}`)
      : ["- No obvious queue noise source is visible from cached metadata."]),
    ...(noise.maintainerActions.length > 0 ? [`- Suggested triage: ${noise.maintainerActions.map((action) => publicBlockerDetail(action)).join(", ")}.`] : []),
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
  // Compute the maintainer-intelligence reports that back the burden-forecast / intake-health /
  // outcome-patterns / noise-report commands, reusing the already-computed collision report so the
  // digest stays a single deterministic pass over the cached metadata. They are command-agnostic;
  // maintainerDigestSections() picks the relevant one per command.
  const recentMergedPullRequests = args.recentMergedPullRequests ?? [];
  const burdenForecast = buildBurdenForecast(args.repo, args.issues, args.pullRequests, collisions);
  const intakeHealth = buildContributorIntakeHealth(args.repo, args.issues, args.pullRequests, repoFullName, collisions);
  const outcomePatterns = buildRepoOutcomePatterns({ repo: args.repo, repoFullName, pullRequests: args.pullRequests, recentMergedPullRequests });
  const noiseReport = buildMaintainerNoiseReport(args.repo, args.issues, args.pullRequests, recentMergedPullRequests, repoFullName);
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
    burdenForecast,
    intakeHealth,
    outcomePatterns,
    noiseReport,
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
  // Share the readiness path's canonical classifier so the digest counts the SAME failing checks the gate sees:
  // a failure carried on `status` (commit-status rows / runs that errored before concluding), startup_failure /
  // failed / action_required, and any case variant — not just three lowercase `conclusion` values.
  const failedChecks = checks.filter(isFailingCheckSummary).length;
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
  const sanitized = sanitizePublicComment(value)
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const safeText = neutralizePublicMarkdownText(sanitized);
  if (safeText.length <= maxLength) return safeText;
  // `slice` counts UTF-16 code units, so the cut can fall between the surrogate halves of an astral
  // character (an emoji) and leave a lone high surrogate — invalid UTF-16 that becomes a U+FFFD mojibake
  // glyph when the digest comment is UTF-8 encoded for the public GitHub comment. Drop a dangling high
  // surrogate before the ellipsis so truncation never splits a pair.
  let truncated = safeText.slice(0, Math.max(0, maxLength - 3));
  if (/[\uD800-\uDBFF]$/.test(truncated)) truncated = truncated.slice(0, -1);
  return `${truncated.trimEnd()}...`;
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
  return [action.publicSafeSummary, ...action.blockedBy].some(isPublicDuplicateCautionLine);
}

function mentionsDuplicateRiskText(value: string): boolean {
  return /\b(duplicate|overlap|wip|collision|concurrent|in[- ]progress)\b/i.test(value);
}

function isPublicDuplicateCautionLine(value: string): boolean {
  const detail = value.trim();
  return detail.length > 0 && !mentionsRepoOutcomePatternDetail(detail) && (mentionsDuplicateRiskText(detail) || /\blikely_duplicate\b/i.test(detail));
}

function mentionsRepoOutcomePatternDetail(value: string): boolean {
  return /\bPRs (?:touching|labeled|with|that|from) .+\b(?:merge well|high closure risk) here \(\d+\/\d+ merged\)\./i.test(value);
}

function publicBlockerLabel(code: string): string {
  const normalized = code.trim().toLowerCase();
  const privateDecisionBlockers = new Set(["open_pr_pressure", "closed_pr_credibility", "low_credibility", "maintainer_lane", "inactive_or_unknown_lane", "issue_discovery_only", "merged_pr_history_floor", "issue_discovery_validity_floor"]);
  const labels: Record<string, string> = {
    likely_duplicate: "Possible overlap with existing work",
  };
  if (privateDecisionBlockers.has(normalized)) {
    return "Private readiness context available in authenticated Gittensory views";
  }
  return labels[normalized] ?? sanitizePublicComment(code.replace(/_/g, " "));
}

function publicBlockerDetail(value: string): string {
  return sanitizePublicInlineDetail(
    sanitizePublicComment(
      value
        .replace(/\blikely_duplicate\b/gi, "possible overlap with existing work")
        .replace(/\bcheck_duplicate_risk\b/gi, "duplicate-risk review")
        .replace(/\b(?:open_pr_pressure|closed_pr_credibility|low_credibility|maintainer_lane|inactive_or_unknown_lane|issue_discovery_only|merged_pr_history_floor|issue_discovery_validity_floor)\b/gi, "private readiness context"),
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
    .replace(/\bopen pr count\s+\d+\s+exceeds threshold\s+\d+\b\.?/gi, "private context")
    .replace(/\bopen pr count is at or below\s+\d+\b/gi, "private context")
    .replace(/\bmerged pr count\s+\d+\s+is below upstream floor\s+\d+\b\.?/gi, "private context")
    .replace(/\bissue-discovery history\s*\(\s*\d+\s+valid solved,\s*credibility\s+[-+]?\d+(?:\.\d+)?\s*\)\s+is below upstream floors\s*\(\s*\d+\s+valid solved,\s*[-+]?\d+(?:\.\d+)?\s+credibility\s*\)\.?/gi, "private context")
    .replace(/\bcredibility\s+[-+]?\d+(?:\.\d+)?\s+is below floor\s+[-+]?\d+(?:\.\d+)?\b\.?/gi, "private context")
    .replace(/\b(?:effective|projected|estimated) score(?: changes?)?\b(?:\s+from)?\s+[-+]?\d+(?:\.\d+)?\s*(?:->|→|to)\s*[-+]?\d+(?:\.\d+)?/gi, "private context")
    .replace(/\b(raw trust scores?|trust scores?|wallets?|hotkeys?|coldkeys?|seed phrases?|mnemonics?)\b/gi, "private context")
    .replace(/\b(public score estimates?|estimated scores?|score estimates?|estimated rewards?|rewards?|reward estimates?|payouts?|farming|scoreability|score previews?|projected score changes?)\b/gi, "private context")
    .replace(/\b(private reviewability|reviewability internals?)\b/gi, "private context")
    .replace(/\b(private rankings?|rankings?)\b/gi, "private context")
    .replace(/\b(?:open_pr_pressure|closed_pr_credibility|low_credibility|maintainer_lane|inactive_or_unknown_lane|issue_discovery_only|merged_pr_history_floor|issue_discovery_validity_floor)\b/gi, "private context")
    .replace(/\b(?:credibility(?: updates?)?|closed pr credibility|low credibility|open pr pressure)\b/gi, "private context")
    // Catch-all: a phrase replacement above (e.g. "score estimate"/"score preview") can leave a bare
    // numeric score transition behind ("private context 32.5 -> 41.2"); redact those residual numbers too.
    .replace(/\bprivate context\b\s+[-+]?\d+(?:\.\d+)?\s*(?:->|→|to)\s*[-+]?\d+(?:\.\d+)?/gi, "private context")
    .replace(/\blikely_duplicate\b/gi, "possible overlap with existing work");
  return sanitizeReviewabilityTerm(sanitized).replace(/private context(?:,\s*private context)+/gi, "private context");
}

function sanitizeReviewabilityTerm(value: string): string {
  return value.replace(/\breviewability\b/gi, (match, offset, fullText: string) => {
    const prefix = fullText.slice(Math.max(0, offset - "@gittensory ".length), offset).toLowerCase();
    return prefix.endsWith("@gittensory ") ? match : "private context";
  });
}

/** @internal Exported for unit tests of ask citation helpers. */
export const githubCommandsInternals = {
  collectAskContributingSources,
  formatAskCitation,
  snapshotFreshnessFromWarnings,
  refreshSections,
  askSections,
  helpSections,
  actionCommandHelpSections,
};
