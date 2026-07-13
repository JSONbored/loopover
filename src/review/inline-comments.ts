// Quiet inline PR review comments (#inline-comments) — the CodeRabbit-style line-level layer ON TOP OF the
// decision summary. Posts the AI reviewer's line-anchored findings as a single NON-BLOCKING review (GitHub
// `event: COMMENT`, never REQUEST_CHANGES/APPROVE), so a contributor sees exactly what to fix on a resubmission
// without the gate or its verdict ever changing. Default OFF: the operator flag GITTENSORY_REVIEW_INLINE_COMMENTS
// is a master kill-switch, and the per-repo `.gittensory.yml` review.inline_comments toggle (#4099) fully
// controls activation by itself when explicitly set — the GITTENSORY_REVIEW_REPOS cutover allowlist no longer
// applies to this feature (an unset manifest toggle preserves the ORIGINAL always-off default; it was never
// sufficient to be allowlisted alone). Fully FAIL-SAFE: a finding whose line is not a commentable line in the PR
// diff is dropped (GitHub 422s otherwise), and any API error degrades to "no inline comments" — it NEVER throws
// and NEVER touches the gate. `shouldRequestInlineFindings` is the "manifestOnly" precedence shape (#4616) —
// see `resolveManifestOnlyFeature`/`FeatureActivationMode` in `./feature-activation` for the shared core this,
// and four sibling `review:`-block features, now delegate to.

import { createPullRequestReviewComments } from "../github/pr-actions";
import { resolveManifestOnlyFeature } from "./feature-activation";
import { formatInlineCommentSeverityLabel } from "./inline-comment-label";
import { resolveInlineCommentAnchor, rightLinesByPath } from "./inline-comment-range";
import { addedLinesByPath, anchoredSuggestionBlock } from "./inline-suggestion-anchor";
import { selectAnchoredInlineFindings } from "./inline-comments-select";
export { rightSideLinesFromPatch } from "./inline-comments-select";
import type { InlineFinding } from "../services/ai-review";
import type { ReviewFindingSeverity } from "../signals/focus-manifest";
import type { AgentActionMode } from "../settings/agent-execution";
import type { PullRequestFileRecord } from "../types";
import { errorMessage } from "../utils/json";
import { dualPrefixEnvFlag } from "../utils/env";

/** True when the operator enabled inline comments globally. Flag-OFF (default) ⇒ the caller never asks the model
 *  for inline findings, so this module is never reached. Truthy follows the codebase convention (same regex as
 *  isUnifiedReviewCommentEnabled / isSafetyEnabled). */
export function isInlineCommentsEnabled(env: {
  GITTENSORY_REVIEW_INLINE_COMMENTS?: string | undefined;
  LOOPOVER_REVIEW_INLINE_COMMENTS?: string | undefined;
}): boolean {
  return dualPrefixEnvFlag(env as unknown as Record<string, string | undefined>, "REVIEW_INLINE_COMMENTS");
}

/** PURE (#4099): should the reviewer be asked to emit line-anchored inline findings for this PR? (1) The
 *  operator's GITTENSORY_REVIEW_INLINE_COMMENTS flag is an absolute MASTER KILL-SWITCH — off ⇒ always false,
 *  regardless of the manifest, and no per-repo config can bypass it (consistent with every other converged
 *  feature — see `resolveConvergedFeature` in `feature-activation.ts`). (2) An explicit per-repo
 *  `.gittensory.yml` `review.inlineComments` override (`true`/`false`) now FULLY controls the feature by itself
 *  — a repo can turn this on without needing the GITTENSORY_REVIEW_REPOS cutover allowlist at all. (3)
 *  `manifestToggle` unset (`undefined`) preserves this feature's ORIGINAL design exactly: unlike
 *  rag/reputation/safety/unifiedComment/grounding (which already fall back to the cutover allowlist when their
 *  manifest field is unset), inline comments have always required an EXPLICIT per-repo opt-in — being on the
 *  allowlist alone was never sufficient, so this stays `false` regardless of the allowlist, byte-identical to
 *  every repo's behavior before this change (now expressed as `resolveManifestOnlyFeature`'s `"manifestOnly"`
 *  mode, #4616 — see `feature-activation.ts`). `repoFullName` is kept for a stable call signature even though
 *  it's unused now that the allowlist no longer applies here. */
export function shouldRequestInlineFindings(
  // GITTENSORY_REVIEW_REPOS is accepted (not just GITTENSORY_REVIEW_INLINE_COMMENTS) purely for call-site
  // signature stability with existing callers/tests that pass a wider env object -- it's no longer read, see
  // the doc comment above.
  env: { GITTENSORY_REVIEW_INLINE_COMMENTS?: string | undefined; GITTENSORY_REVIEW_REPOS?: string | undefined },
  repoFullName: string,
  manifestToggle: boolean | undefined,
): boolean {
  void repoFullName; // kept for call-site signature stability, see doc comment above
  return resolveManifestOnlyFeature(isInlineCommentsEnabled(env), manifestToggle);
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

/** A GitHub inline review comment anchored to a line on the RIGHT (added/context) side of the PR diff. Multi-line
 *  comments set `start_line`/`start_side` with `line` as the inclusive end (#2141). */
export type ReviewInlineComment = {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
  start_line?: number;
  start_side?: "RIGHT";
};

/** Hard cap on inline comments posted per PR review — a focused review leaves a handful of precise notes, not a
 *  wall (the model is also asked to be selective, and composeInlineFindings already caps at 10). */

/** GitHub's suggested-change syntax requires the LITERAL ` ```suggestion ` fence; see
 *  {@link anchoredSuggestionBlock} for anchor-safety and fence validation (#2140 / #1956). */

/** The inline comment body: a compact severity (+ optional category) label + the finding, plus a one-click GitHub
 *  suggested-change block when the finding carries a `suggestion` AND the caller has suggestions enabled (#1956 / #2139).
 *  When `categoriesEnabled` (#1958 / #2149), the label carries a title-cased category tag (`Blocker · Security`) —
 *  the model's own `category` when it emitted one in the fixed enum, else the deterministic fallback
 *  (`classifyFindingCategory`), so the tag is never sometimes-present. Public-safe by construction — both the body
 *  and the suggestion were already run through the public-safe filter by composeInlineFindings before they reached
 *  here; `category` is a fixed enum literal, never free text. */
function formatInlineBody(
  finding: InlineFinding,
  suggestionsEnabled: boolean,
  categoriesEnabled: boolean,
  addedLines: Map<string, Set<number>>,
): string {
  const label = formatInlineCommentSeverityLabel(finding, categoriesEnabled);
  const suggestionBlock = anchoredSuggestionBlock(finding, suggestionsEnabled, addedLines);
  return `**${label}:** ${finding.body}${suggestionBlock}`;
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
  const addedLines = addedLinesByPath(files);
  const rightLines = rightLinesByPath(files);
  return selected.map((finding) => {
    const anchor = resolveInlineCommentAnchor(finding, rightLines);
    const anchoredFinding: InlineFinding =
      anchor.multiLine ? finding : { ...finding, endLine: undefined };
    const comment: ReviewInlineComment = {
      path: finding.path,
      line: anchor.end,
      side: "RIGHT" as const,
      body: formatInlineBody(anchoredFinding, suggestionsEnabled, categoriesEnabled, addedLines),
    };
    if (anchor.multiLine) {
      comment.start_line = anchor.start;
      comment.start_side = "RIGHT";
    }
    return comment;
  });
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
