// Convergence (#issue-coding-plan) — the `@gittensory plan` command: on a maintainer's request, generate a
// concise, actionable implementation plan from an ISSUE's text and post it as an issue comment so a contributor
// (or their agent) has a concrete starting point.
//
// SAFETY CONTRACT:
//   • flag-OFF (default) → isPlannerEnabled is false, the handler short-circuits BEFORE parsing, and the worker
//     is byte-identical to today (`@gittensory plan` falls through to the existing mention path → help card).
//   • flag-ON → only a MAINTAINER can trigger it; the model sees only the (already-public) issue title + body;
//     the output is public-safe-sanitized before posting; any model/error degrades to a no-plan no-op.

import { BEST_REVIEW_MODELS, coerceAiText, RELIABLE_FALLBACK_MODELS } from "../services/ai-review";
import { sanitizePublicComment } from "../github/commands";
import { AGENT_COMMAND_COMMENT_MARKER } from "../github/comments";
import { gittensoryFooter } from "../github/footer";
import type { GitHubWebhookPayload } from "../types";

/** True when the issue-planning command is enabled. Flag-OFF (default) → every export below is unreachable from
 *  the webhook path. Truthy follows the codebase convention (`/^(1|true|yes|on)$/i`, same as isSelfTuneEnabled). */
export function isPlannerEnabled(env: { GITTENSORY_REVIEW_PLANNER?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_PLANNER ?? "");
}

/** Recognize a bare `@gittensory plan` mention (the rest of the line is ignored). Returns false for any other
 *  body so the handler never intercepts an unrelated comment. PURE. */
export function isPlanCommand(body: string | null | undefined): boolean {
  if (!body) return false;
  return /(?:^|\s)@gittensory\s+plan\b/i.test(body);
}

/** The validated request for a `@gittensory plan` command, or a skip reason. PURE so every guard (wrong action,
 *  bot author, missing repo/issue/installation, a PR rather than an issue) is exhaustively unit-tested without the
 *  webhook harness; the processor then carries a single `ok` branch. (#issue-coding-plan) */
export type PlanCommandRequest =
  | { ok: true; repoFullName: string; installationId: number; actor: string; issue: { number: number; title?: string | null | undefined; body?: string | null | undefined } }
  | { ok: false; reason: string; repoFullName: string | null; actor: string | null; targetKey: string | null };

export function classifyPlanCommandRequest(payload: GitHubWebhookPayload, installationId: number | null): PlanCommandRequest {
  const comment = payload.comment;
  const repoFullName = payload.repository?.full_name ?? null;
  const issue = payload.issue ?? null;
  const actor = payload.sender?.login ?? comment?.user?.login ?? null;
  const targetKey = repoFullName && issue ? `${repoFullName}#${issue.number}` : repoFullName;
  if (payload.action !== "created" || comment?.user?.type === "Bot" || payload.sender?.type === "Bot" || /\[bot\]$/i.test(actor ?? "")) {
    return { ok: false, reason: "unsupported_comment_action_or_bot", repoFullName, actor, targetKey };
  }
  if (!repoFullName || !issue || issue.pull_request || !installationId || !actor) {
    return { ok: false, reason: "missing_repo_issue_installation_or_actor", repoFullName, actor, targetKey };
  }
  return { ok: true, repoFullName, installationId, actor, issue: { number: issue.number, title: issue.title, body: issue.body } };
}

const PLANNER_SYSTEM_PROMPT = [
  "You are a senior open-source maintainer assistant. Given a single GitHub issue, produce a CONCISE, actionable",
  "implementation plan a contributor can follow. Output GitHub-flavored markdown with these sections, in order:",
  "a one-line **Summary**; **Proposed approach** (2-4 bullets); **Steps** (an ordered checklist of concrete edits);",
  "**Files likely involved** (best-effort from the description, may be empty); **Tests to add**; and",
  "**Risks / open questions**. Be specific and practical; prefer the smallest correct change. Never invent file",
  "paths you are not reasonably confident about. Do NOT include secrets, credentials, tokens, or any private data.",
  "If the issue is too vague to plan, say so plainly and list the clarifying questions a maintainer should answer.",
].join(" ");

// Bound the issue text fed to the model so a giant issue body can't blow the prompt, and bound the plan we post.
const MAX_ISSUE_CHARS = 6_000;
const MAX_PLAN_CHARS = 8_000;
const PLANNER_MAX_TOKENS = 1_200;

/** One Workers-AI text completion for the planner: primary model, one reliable fallback, a single retry each.
 *  Fail-safe — any error or empty output returns null. Mirrors runWorkersOpinion's routing (AI Gateway when set). */
async function runPlannerModel(env: Env, system: string, user: string): Promise<string | null> {
  const ai = env.AI as unknown as { run?: (model: string, options: Record<string, unknown>, extra?: unknown) => Promise<unknown> } | undefined;
  if (!ai || typeof ai.run !== "function") return null;
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  const extra = gatewayId ? { gateway: { id: gatewayId } } : undefined;
  for (const model of [BEST_REVIEW_MODELS[0], RELIABLE_FALLBACK_MODELS[0]]) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await ai.run(model, { max_tokens: PLANNER_MAX_TOKENS, temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: user }] }, extra);
        const text = coerceAiText(result).trim();
        if (text) return text;
      } catch {
        /* retry, then fall through to the fallback model */
      }
    }
  }
  return null;
}

/** Generate an implementation plan (markdown) from an issue's title + body via Workers AI. Returns null when AI
 *  is unavailable or returns nothing (the caller then posts no plan). The returned text is bounded; the caller
 *  still sanitizes it before posting. */
export async function generateIssuePlan(env: Env, issue: { title?: string | null | undefined; body?: string | null | undefined }): Promise<string | null> {
  const title = (issue.title ?? "").trim();
  const body = (issue.body ?? "").trim().slice(0, MAX_ISSUE_CHARS);
  if (!title && !body) return null; // nothing to plan from
  const user = `Issue title: ${title || "(none)"}\n\nIssue description:\n${body || "(no description provided)"}`;
  const plan = await runPlannerModel(env, PLANNER_SYSTEM_PROMPT, user);
  if (!plan) return null;
  return plan.slice(0, MAX_PLAN_CHARS);
}

/** Render the generated plan into a public-safe issue comment. Sanitized at the boundary so the posted body can
 *  never carry private terms even if the model emitted them. */
export function buildIssuePlanComment(plan: string, args: { actor: string; repoFullName: string; issueNumber: number }): string {
  return sanitizePublicComment(
    [
      AGENT_COMMAND_COMMENT_MARKER,
      "",
      "> [!NOTE]",
      `> **Gittensory implementation plan** — requested by @${args.actor}`,
      "> AI-generated from the issue text. Treat it as a starting point and verify against the codebase before implementing.",
      "",
      "| Signal | State |",
      "| --- | --- |",
      "| Command | `@gittensory plan` |",
      `| Scope | ${args.repoFullName}#${args.issueNumber} |`,
      "",
      plan,
      "",
      "---",
      gittensoryFooter(),
    ].join("\n"),
  );
}
