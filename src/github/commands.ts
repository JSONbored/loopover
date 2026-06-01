import { AGENT_COMMAND_COMMENT_MARKER } from "./comments";
import type { AgentRunBundle } from "../services/agent-orchestrator";
import type { GittensorContributorSnapshot, OfficialGittensorMinerDetection } from "../gittensor/api";
import type { AgentActionRecord } from "../types";
import type { GitHubIssuePayload, PullRequestRecord, RepositoryRecord } from "../types";

export const GITTENSORY_MENTION_COMMAND_CATALOG = [
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

export type GittensoryMentionCommandName = (typeof GITTENSORY_MENTION_COMMAND_CATALOG)[number]["id"];

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

const COMMANDS = new Set<GittensoryMentionCommandName>(GITTENSORY_MENTION_COMMAND_CATALOG.map((command) => command.id));
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const COMMAND_TITLES = Object.fromEntries(GITTENSORY_MENTION_COMMAND_CATALOG.map((command) => [command.id, command.title])) as Record<GittensoryMentionCommandName, string>;

const REFRESH_SECTION_TITLES: Record<Exclude<GittensoryMentionCommandName, "help" | "miner-context">, string> = {
  preflight: "Preflight snapshot refresh",
  blockers: "Blocker snapshot refresh",
  "duplicate-check": "Duplicate-check snapshot refresh",
  "next-action": "Next-action snapshot refresh",
  reviewability: "PR readiness snapshot refresh",
  "repo-fit": "Repository fit snapshot refresh",
  packet: "Public packet snapshot refresh",
};

const EMPTY_SECTION_TITLES: Record<Exclude<GittensoryMentionCommandName, "help" | "miner-context">, string> = {
  preflight: "Preflight summary",
  blockers: "Readiness blockers",
  "duplicate-check": "Duplicate & WIP caution",
  "next-action": "Recommended next step",
  reviewability: "PR readiness",
  "repo-fit": "Repository fit",
  packet: "Public packet",
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

export function isAuthorizedCommandActor(args: {
  commenterLogin?: string | null | undefined;
  commenterAssociation?: string | null | undefined;
  pullRequestAuthorLogin?: string | null | undefined;
  officialAuthorDetection?: OfficialGittensorMinerDetection | undefined;
}): { authorized: boolean; reason: string; actorKind: "maintainer" | "author" | "none" } {
  if (isMaintainerAssociation(args.commenterAssociation)) return { authorized: true, reason: "maintainer_invocation", actorKind: "maintainer" };
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
  officialMiner?: GittensorContributorSnapshot | null | undefined;
  bundle?: AgentRunBundle | null | undefined;
}): string {
  const repoFullName = args.repo?.fullName ?? args.pullRequest?.repoFullName ?? "this repository";
  const sections = commandSections(args.command.name, args.bundle, args.officialMiner);
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
        : "cached Gittensory agent context";
  return [
    `Source: ${source}.`,
    `Freshness: ${publicFreshness(bundle, command)}.`,
    "Boundary: public GitHub comment; non-public scoring and planning context is omitted.",
  ];
}

function publicFreshness(bundle: AgentRunBundle | null | undefined, command: GittensoryMentionCommandName): string {
  if (command === "help") return "shipped command list";
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

function commandSections(
  command: GittensoryMentionCommandName,
  bundle: AgentRunBundle | null | undefined,
  officialMiner: GittensorContributorSnapshot | null | undefined,
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

function refreshSections(command: Exclude<GittensoryMentionCommandName, "help" | "miner-context">): string[] {
  return [
    `**${REFRESH_SECTION_TITLES[command]}**`,
    "",
    "- Gittensory is refreshing the contributor decision snapshot. Try the command again shortly.",
  ];
}

function emptySections(command: Exclude<GittensoryMentionCommandName, "help" | "miner-context">): string[] {
  return [`**${EMPTY_SECTION_TITLES[command]}**`, "", "- No public-safe context is available from the current cached snapshot."];
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
  return sanitizePublicComment(
    value
      .replace(/\blikely_duplicate\b/gi, "possible overlap with existing work")
      .replace(/\bcheck_duplicate_risk\b/gi, "duplicate-risk review")
      .replace(/\bopen_pr_pressure\b/gi, "open pull request pressure"),
  );
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
