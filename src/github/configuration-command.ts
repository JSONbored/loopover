import { parseGittensoryMentionCommand } from "./commands";
import type { GitHubWebhookPayload } from "../types";

/** The validated request for a `@gittensory configuration` command, `null` when the comment is not that command,
 *  or a skip reason. PURE so every guard (wrong action, bot author, missing repo/issue/installation/actor) is
 *  exhaustively unit-tested without the webhook harness; the processor then carries a single `ok` branch. Unlike
 *  the issue-only planner, configuration is repo-level and answers on either a PR or an issue thread. (#2168) */
export type ConfigurationCommandRequest =
  | { ok: true; repoFullName: string; installationId: number; actor: string; issueNumber: number }
  | { ok: false; reason: string; repoFullName: string | null; actor: string | null; targetKey: string | null };

export function classifyConfigurationCommandRequest(
  payload: GitHubWebhookPayload,
  installationId: number | null,
): ConfigurationCommandRequest | null {
  const comment = payload.comment;
  const command = parseGittensoryMentionCommand(comment?.body);
  if (!command || command.name !== "configuration") return null; // not our command — fall through to other handlers
  const repoFullName = payload.repository?.full_name ?? null;
  const issue = payload.issue ?? null;
  const actor = payload.sender?.login ?? comment?.user?.login ?? null;
  const targetKey = repoFullName && issue ? `${repoFullName}#${issue.number}` : repoFullName;
  if (payload.action !== "created" || comment?.user?.type === "Bot" || payload.sender?.type === "Bot" || /\[bot\]$/i.test(actor ?? "")) {
    return { ok: false, reason: "unsupported_comment_action_or_bot", repoFullName, actor, targetKey };
  }
  if (!repoFullName || !issue || !installationId || !actor) {
    return { ok: false, reason: "missing_repo_issue_installation_or_actor", repoFullName, actor, targetKey };
  }
  return { ok: true, repoFullName, installationId, actor, issueNumber: issue.number };
}
