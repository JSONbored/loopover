import { AGENT_COMMAND_COMMENT_MARKER } from "./comments";
import type { AgentRunBundle } from "../services/agent-orchestrator";
import type { GittensorContributorSnapshot, OfficialGittensorMinerDetection } from "../gittensor/api";
import type { AgentActionRecord } from "../types";
import type { GitHubIssuePayload, PullRequestRecord, RepositoryRecord } from "../types";

export type GittensoryMentionCommandName = "help" | "preflight" | "blockers" | "duplicate-check" | "miner-context" | "next-action";

export type GittensoryMentionCommand = {
  name: GittensoryMentionCommandName;
  raw: string;
};

const COMMANDS = new Set<GittensoryMentionCommandName>(["help", "preflight", "blockers", "duplicate-check", "miner-context", "next-action"]);
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const COMMAND_TITLES: Record<GittensoryMentionCommandName, string> = {
  help: "Gittensory command help",
  preflight: "Gittensory preflight",
  blockers: "Gittensory readiness blockers",
  "duplicate-check": "Gittensory duplicate & WIP check",
  "miner-context": "Gittensory miner context",
  "next-action": "Gittensory next step",
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
  const body = [
    AGENT_COMMAND_COMMENT_MARKER,
    `### ${COMMAND_TITLES[args.command.name]}`,
    "",
    `Command: \`@gittensory ${args.command.name}\``,
    `Scope: ${repoFullName}#${args.issue.number}`,
    "",
    ...sections,
    "",
    "_Advisory context only. Public comments exclude non-public contributor signals and reviewability internals._",
  ].join("\n");
  return sanitizePublicComment(body);
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
    if (action.why.length > 0) {
      lines.push(...action.why.slice(0, 4).map((item) => `- ${publicBlockerDetail(item)}`));
      continue;
    }
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

function refreshSections(command: Exclude<GittensoryMentionCommandName, "help" | "miner-context">): string[] {
  const labels: Record<typeof command, string> = {
    preflight: "Preflight snapshot refresh",
    blockers: "Blocker snapshot refresh",
    "duplicate-check": "Duplicate-check snapshot refresh",
    "next-action": "Next-action snapshot refresh",
  };
  return [
    `**${labels[command]}**`,
    "",
    "- Gittensory is refreshing the contributor decision snapshot. Try the command again shortly.",
  ];
}

function emptySections(command: Exclude<GittensoryMentionCommandName, "help" | "miner-context">): string[] {
  const labels: Record<typeof command, string> = {
    preflight: "Preflight summary",
    blockers: "Readiness blockers",
    "duplicate-check": "Duplicate & WIP caution",
    "next-action": "Recommended next step",
  };
  return [`**${labels[command]}**`, "", "- No public-safe context is available from the current cached snapshot."];
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
    .replace(/\b(estimated score|score estimate|reward estimate|payout|farming|reviewability)\b/gi, "private context")
    .replace(/\b(private ranking|private rankings)\b/gi, "private context")
    .replace(/\blikely_duplicate\b/gi, "possible overlap with existing work");
  return sanitized.replace(/private context(?:,\s*private context)+/gi, "private context");
}
