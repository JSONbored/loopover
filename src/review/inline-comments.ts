// Quiet inline PR review comments (#inline-comments) — the CodeRabbit-style line-level layer ON TOP OF the
// decision summary. Posts the AI reviewer's line-anchored findings as a single NON-BLOCKING review (GitHub
// `event: COMMENT`, never REQUEST_CHANGES/APPROVE), so a contributor sees exactly what to fix on a resubmission
// without the gate or its verdict ever changing. Default OFF at BOTH layers: the operator flag
// GITTENSORY_REVIEW_INLINE_COMMENTS (+ the per-repo GITTENSORY_REVIEW_REPOS cutover allowlist) AND the per-repo
// `.gittensory.yml` review.inline_comments toggle — the caller ANDs all three to decide whether to ASK the model
// for inline findings AND passes the same resolved gate to the write boundary. Fully FAIL-SAFE: a finding whose
// line is not a commentable line in the PR diff is dropped (GitHub 422s otherwise), and any API error degrades to
// "no inline comments" — it NEVER throws and NEVER touches the gate.

import { createPullRequestReviewComments } from "../github/pr-actions";
import { isConvergenceRepoAllowed } from "./cutover-gate";
import { classifyFindingCategory } from "./finding-category-classify";
import { selectAnchoredInlineFindings } from "./inline-comments-select";
export { rightSideLinesFromPatch } from "./inline-comments-select";
import type { InlineFinding } from "../services/ai-review";
import type { ReviewFindingSeverity } from "../signals/focus-manifest";
import type { AgentActionMode } from "../settings/agent-execution";
import type { PullRequestFileRecord } from "../types";
import { errorMessage } from "../utils/json";

/** True when the operator enabled inline comments globally. Flag-OFF (default) ⇒ the caller never asks the model
 *  for inline findings, so this module is never reached. Truthy follows the codebase convention (same regex as
 *  isUnifiedReviewCommentEnabled / isSafetyEnabled). */
export function isInlineCommentsEnabled(env: { GITTENSORY_REVIEW_INLINE_COMMENTS?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_INLINE_COMMENTS ?? "");
}

/** PURE: should the reviewer be asked to emit line-anchored inline findings for this PR? True ONLY when ALL THREE
 *  gates pass — the per-repo `.gittensory.yml` toggle (`manifestToggle`), the operator flag, AND the cutover
 *  allowlist — so the feature is off by default at every layer. Keeps the three-way gate in one unit-testable
 *  place instead of inline in the review path. */
export function shouldRequestInlineFindings(
  env: { GITTENSORY_REVIEW_INLINE_COMMENTS?: string | undefined; GITTENSORY_REVIEW_REPOS?: string | undefined },
  repoFullName: string,
  manifestToggle: boolean | undefined,
): boolean {
  return manifestToggle === true && isInlineCommentsEnabled(env) && isConvergenceRepoAllowed(env, repoFullName);
}

/** PURE (#1956): should a `suggestion` be rendered as a GitHub-native ` ```suggestion ` block? This is an
 *  ADDITIONAL opt-in (`review.suggestions`) layered on top of inline comments being enabled at all — a
 *  suggestion has nothing to attach to without the inline comment it rides on, so it can never be true when
 *  `inlineCommentsEnabled` is false, regardless of the manifest toggle. */
export function shouldRenderSuggestions(
  inlineCommentsEnabled: boolean,
  manifestToggle: boolean | undefined,
): boolean {
  return inlineCommentsEnabled && manifestToggle === true;
}

/** PURE (#1958): should an inline finding's `category` be rendered? An ADDITIONAL opt-in (`review.finding_categories`)
 *  layered on top of inline comments being enabled at all — mirrors {@link shouldRenderSuggestions} exactly, since
 *  a category has nothing to categorize without the inline comment it rides on. */
export function shouldRenderFindingCategories(
  inlineCommentsEnabled: boolean,
  manifestToggle: boolean | undefined,
): boolean {
  return inlineCommentsEnabled && manifestToggle === true;
}

/** A GitHub inline review comment anchored to a line on the RIGHT (added/context) side of the PR diff. */
export type ReviewInlineComment = { path: string; line: number; side: "RIGHT"; body: string };

/** Hard cap on inline comments posted per PR review — a focused review leaves a handful of precise notes, not a
 *  wall (the model is also asked to be selective, and composeInlineFindings already caps at 10). */

/** GitHub's suggested-change syntax requires the LITERAL ` ```suggestion ` fence; if the suggestion text itself
 *  contains a triple-backtick run, embedding it verbatim would prematurely close the fence and corrupt the
 *  comment (the rest of the finding body would spill out as raw, unintended markdown). Fail-safe (#1956):
 *  drop the suggestion block and keep the finding text rather than risk a malformed comment — mirrors the
 *  "a bad/blank suggestion is simply dropped while keeping the finding itself" discipline already applied when
 *  the suggestion is parsed (ai-review.ts's parseModelReview). */
function safeSuggestionBlock(suggestion: string | undefined): string {
  if (!suggestion || suggestion.includes("```")) return "";
  return `\n\n\`\`\`suggestion\n${suggestion}\n\`\`\``;
}

/** The inline comment body: a compact severity (+ optional category) label + the finding, plus a one-click GitHub
 *  suggested-change block when the finding carries a `suggestion` AND the caller has suggestions enabled (#1956).
 *  When `categoriesEnabled` (#1958), the label gets a parenthetical category tag — the model's own `category` when
 *  it emitted one in the fixed enum, else the deterministic fallback (`classifyFindingCategory`), so the tag is
 *  never sometimes-present. Public-safe by construction — both the body and the suggestion were already run
 *  through the public-safe filter by composeInlineFindings before they reached here; `category` is a fixed enum
 *  literal, never free text. */
function formatInlineBody(finding: InlineFinding, suggestionsEnabled: boolean, categoriesEnabled = false): string {
  const label = finding.severity === "blocker" ? "Blocker" : "Nit";
  const categoryTag = categoriesEnabled ? ` (${finding.category ?? classifyFindingCategory(finding)})` : "";
  const suggestionBlock = suggestionsEnabled ? safeSuggestionBlock(finding.suggestion) : "";
  return `**${label}${categoryTag}:** ${finding.body}${suggestionBlock}`;
}

/** PURE: turn the model's line-anchored findings into GitHub inline review comments, dropping any whose
 *  (path, line) is not a commentable RIGHT-side line in that file's diff (so GitHub never 422s) and any file with
 *  no usable patch. Dedupes by path+line (first wins) and caps the total. Empty in / nothing anchorable ⇒ [].
 *  `suggestionsEnabled` (#1956) gates whether a finding's `suggestion` is rendered as a committable GitHub
 *  suggested-change block — a suggestion is anchored to the SAME single line as its parent finding, so the
 *  existing line-validity check above already covers "drop it if the range can't be anchored". `categoriesEnabled`
 *  (#1958) gates whether the label carries a category tag. */
export function selectInlineComments(
  findings: InlineFinding[],
  files: Pick<PullRequestFileRecord, "path" | "payload">[],
  suggestionsEnabled = false,
  categoriesEnabled = false,
  minFindingSeverity: ReviewFindingSeverity | null | undefined = null,
  perCategoryCap: number | null | undefined = null,
): ReviewInlineComment[] {
  const selected = selectAnchoredInlineFindings(findings, files, {
    minFindingSeverity,
    perCategoryCap,
  });
  return selected.map((finding) => ({
    path: finding.path,
    line: finding.line,
    side: "RIGHT" as const,
    body: formatInlineBody(finding, suggestionsEnabled, categoriesEnabled),
  }));
}

/** Post the model's inline findings as ONE quiet, non-blocking review (`event: COMMENT`) on the PR. Fully
 *  FAIL-SAFE: selects only diff-valid lines, no-ops when nothing is postable or the head SHA is unknown, threads
 *  `mode` so a dry-run instance suppresses the write, and swallows any API error (logging it) — the gate is NEVER
 *  affected. Returns the number actually posted (0 when nothing was postable or on error). */
export async function postInlineReviewComments(
  env: Env,
  args: {
    installationId: number;
    repoFullName: string;
    pullNumber: number;
    commitId: string | null | undefined;
    findings: InlineFinding[];
    files: Pick<PullRequestFileRecord, "path" | "payload">[];
    mode: AgentActionMode;
    suggestionsEnabled?: boolean | undefined;
    categoriesEnabled?: boolean | undefined;
    minFindingSeverity?: ReviewFindingSeverity | null | undefined;
    perCategoryCap?: number | null | undefined;
  },
): Promise<{ posted: number }> {
  const comments = selectInlineComments(
    args.findings,
    args.files,
    args.suggestionsEnabled,
    args.categoriesEnabled,
    args.minFindingSeverity,
    args.perCategoryCap,
  );
  if (comments.length === 0 || !args.commitId) return { posted: 0 };
  try {
    await createPullRequestReviewComments(env, args.installationId, args.repoFullName, args.pullNumber, args.commitId, comments, args.mode);
    return { posted: comments.length };
  } catch (error) {
    // ERROR level (#5 review observability) so the central Sentry forwarder captures a failing inline-comment post
    // (auth/permission/422) — it degrades silently (gate unaffected) and was otherwise invisible at warn.
    console.error(JSON.stringify({ level: "error", event: "inline_comments_post_failed", repository: args.repoFullName, pullNumber: args.pullNumber, count: comments.length, error: errorMessage(error) }));
    return { posted: 0 };
  }
}

/** Review-path entry point (#inline-comments): post the fresh review's inline findings, if any. A no-op (NOT even
 *  loading the PR files) unless the review actually produced findings — so the off-path, and the ~2-min re-gate
 *  sweep's cache hits (which carry no findings), do ZERO extra work. `getFiles` is the caller's memoized PR-files
 *  reader, resolved only when there is something to post. Always fail-safe (postInlineReviewComments never throws). */
export async function maybePostInlineComments(
  env: Env,
  args: {
    aiReview: { inlineFindings?: InlineFinding[] | undefined } | undefined;
    installationId: number;
    repoFullName: string;
    pullNumber: number;
    commitId: string | null | undefined;
    getFiles: () => Promise<Pick<PullRequestFileRecord, "path" | "payload">[]>;
    mode: AgentActionMode;
    inlineCommentsEnabled: boolean;
    suggestionsEnabled?: boolean | undefined;
    categoriesEnabled?: boolean | undefined;
    minFindingSeverity?: ReviewFindingSeverity | null | undefined;
    perCategoryCap?: number | null | undefined;
  },
): Promise<void> {
  if (!args.inlineCommentsEnabled) return;
  const findings = args.aiReview?.inlineFindings;
  if (!findings?.length) return;
  await postInlineReviewComments(env, {
    installationId: args.installationId,
    repoFullName: args.repoFullName,
    pullNumber: args.pullNumber,
    commitId: args.commitId,
    findings,
    files: await args.getFiles(),
    mode: args.mode,
    suggestionsEnabled: args.suggestionsEnabled,
    categoriesEnabled: args.categoriesEnabled,
    minFindingSeverity: args.minFindingSeverity,
    perCategoryCap: args.perCategoryCap,
  });
}
