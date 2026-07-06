// #1960 PR control-surface — shared classifier for every @gittensory action-command handler (review, pause,
// resume, resolve, configuration, explain; alongside the existing gate-override). maybeProcessGateOverrideCommand
// and maybeProcessPlanCommand (src/queue/processors.ts) each hand-roll the SAME guard preamble: reject a comment
// event that isn't `created`, reject a Bot/`[bot]` author, and reject a payload missing the repo/PR/installation/
// actor it needs. classifyPrCommandRequest extracts that preamble as a PURE function (mirroring
// classifyPlanCommandRequest, src/review/planner.ts:40) so every new command handler carries a single `ok` branch
// instead of re-deriving the same four guards. Contributor scope is this pure classifier + its tests; wiring it
// into the (maintainer-owned) handlers is a follow-up (#2161, part of #1960).

import type { GitHubWebhookPayload } from "../types";

/** The validated request for an @gittensory PR-comment action command, or a skip reason. PURE so every guard
 *  (unsupported comment action, bot author, missing repo/PR/installation/actor) is exhaustively unit-tested
 *  without the webhook harness; the processor then carries a single `ok` branch. */
export type PrCommandRequest =
  | {
      ok: true;
      repoFullName: string;
      installationId: number;
      actor: string;
      pr: { number: number; title?: string | null | undefined; body?: string | null | undefined };
    }
  | { ok: false; reason: "unsupported_comment_action" | "bot_author" | "missing_repo_pr_installation_or_actor"; repoFullName: string | null; actor: string | null; targetKey: string | null };

export function classifyPrCommandRequest(payload: GitHubWebhookPayload, installationId: number | null): PrCommandRequest {
  const comment = payload.comment;
  const repoFullName = payload.repository?.full_name ?? null;
  const issue = payload.issue ?? null;
  const actor = payload.sender?.login ?? comment?.user?.login ?? null;
  const targetKey = repoFullName && issue ? `${repoFullName}#${issue.number}` : repoFullName;

  if (payload.action !== "created") {
    return { ok: false, reason: "unsupported_comment_action", repoFullName, actor, targetKey };
  }
  if (comment?.user?.type === "Bot" || payload.sender?.type === "Bot" || /\[bot\]$/i.test(actor ?? "")) {
    return { ok: false, reason: "bot_author", repoFullName, actor, targetKey };
  }
  if (!repoFullName || !issue?.pull_request || !installationId || !actor) {
    return { ok: false, reason: "missing_repo_pr_installation_or_actor", repoFullName, actor, targetKey };
  }
  return { ok: true, repoFullName, installationId, actor, pr: { number: issue.number, title: issue.title, body: issue.body } };
}
