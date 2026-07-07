import { parseGittensoryMentionCommand } from "./commands";
import type { GitHubWebhookPayload } from "../types";

/** The validated request for an `@gittensory <verb>` PR-control-surface command, `null` when the comment is not
 *  that command, or a skip reason. PURE so every guard (wrong action, bot author, missing repo/issue/installation/
 *  actor) is exhaustively unit-tested without the webhook harness; the processor then carries a single `ok` branch.
 *  These commands are repo-level and answer on either a PR or an issue thread. (#2168, #2164) */
export type MentionCommandRequest =
  | { ok: true; repoFullName: string; installationId: number; actor: string; issueNumber: number }
  | { ok: false; reason: string; repoFullName: string | null; actor: string | null; targetKey: string | null };

/** Back-compat alias for the configuration command's request type. */
export type ConfigurationCommandRequest = MentionCommandRequest;

/** Classify an `@gittensory <commandName>` mention comment into a validated request, `null` (not this command, so
 *  the processor falls through to the next handler), or a skip reason — shared by every PR-control-surface verb
 *  (configuration, pause, …) so each dispatch handler carries only a single `ok` branch. */
export function classifyMentionCommandRequest(
  payload: GitHubWebhookPayload,
  installationId: number | null,
  commandName: string,
): MentionCommandRequest | null {
  const comment = payload.comment;
  const command = parseGittensoryMentionCommand(comment?.body);
  if (!command || command.name !== commandName) return null;
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

/** `@gittensory configuration` request classifier — the shared classifier bound to the `configuration` verb. (#2168) */
export function classifyConfigurationCommandRequest(
  payload: GitHubWebhookPayload,
  installationId: number | null,
): MentionCommandRequest | null {
  return classifyMentionCommandRequest(payload, installationId, "configuration");
}
