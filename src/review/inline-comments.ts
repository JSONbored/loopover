// Quiet inline PR review comments (#inline-comments) — the CodeRabbit-style line-level layer ON TOP OF the
// decision summary. Posts the AI reviewer's line-anchored findings as a single NON-BLOCKING review (GitHub
// `event: COMMENT`, never REQUEST_CHANGES/APPROVE), so a contributor sees exactly what to fix on a resubmission
// without the gate or its verdict ever changing. Default OFF at BOTH layers: the operator flag
// GITTENSORY_REVIEW_INLINE_COMMENTS (+ the per-repo GITTENSORY_REVIEW_REPOS cutover allowlist) AND the per-repo
// `.gittensory.yml` review.inline_comments toggle — the caller ANDs all three to decide whether to ASK the model
// for inline findings, so this module is only reached once findings exist. Fully FAIL-SAFE: a finding whose line
// is not a commentable line in the PR diff is dropped (GitHub 422s otherwise), and any API error degrades to "no
// inline comments" — it NEVER throws and NEVER touches the gate.

import { createPullRequestReviewComments } from "../github/pr-actions";
import { isConvergenceRepoAllowed } from "./cutover-gate";
import type { InlineFinding } from "../services/ai-review";
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

/** A GitHub inline review comment anchored to a line on the RIGHT (added/context) side of the PR diff. */
export type ReviewInlineComment = { path: string; line: number; side: "RIGHT"; body: string };

/** Hard cap on inline comments posted per PR review — a focused review leaves a handful of precise notes, not a
 *  wall (the model is also asked to be selective, and composeInlineFindings already caps at 10). */
const MAX_INLINE_COMMENTS = 10;

/** PURE: the set of NEW-file (RIGHT-side) line numbers a unified-diff patch makes commentable — every added
 *  ("+") and context (" ") line inside a hunk. GitHub 422s an inline comment whose line is NOT one of these, so
 *  {@link selectInlineComments} validates each finding against this set. Deleted ("-") lines are LEFT-side only
 *  and excluded; the "\ No newline at end of file" marker is skipped. Mirrors firstAddedLineFromPatch's
 *  hunk-header regex (advisory.ts). */
export function rightSideLinesFromPatch(patch: string): Set<number> {
  const lines = new Set<number>();
  let right = 0;
  for (const raw of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header?.[1]) {
      right = Number.parseInt(header[1], 10);
      continue;
    }
    if (right === 0) continue; // preamble before the first hunk header
    const marker = raw[0];
    // `undefined` ⇒ an empty "" element (a trailing-newline split artifact, NOT a real diff line — a blank
    // context line is " ", a single space); "-" ⇒ deleted (LEFT side only); "\\" ⇒ the "no newline" marker.
    if (marker === undefined || marker === "-" || marker === "\\") continue;
    lines.add(right); // added ("+") or context (" ") line → occupies a RIGHT-side line number
    right += 1;
  }
  return lines;
}

/** The inline comment body: a compact severity label + the finding. Public-safe by construction — the body was
 *  already run through the public-safe filter by composeInlineFindings before it reached here. */
function formatInlineBody(finding: InlineFinding): string {
  const label = finding.severity === "blocker" ? "Blocker" : "Nit";
  return `**${label}:** ${finding.body}`;
}

/** PURE: turn the model's line-anchored findings into GitHub inline review comments, dropping any whose
 *  (path, line) is not a commentable RIGHT-side line in that file's diff (so GitHub never 422s) and any file with
 *  no usable patch. Dedupes by path+line (first wins) and caps the total. Empty in / nothing anchorable ⇒ []. */
export function selectInlineComments(findings: InlineFinding[], files: Pick<PullRequestFileRecord, "path" | "payload">[]): ReviewInlineComment[] {
  const rightLinesByPath = new Map<string, Set<number>>();
  for (const file of files) {
    const patch = typeof file.payload?.patch === "string" ? file.payload.patch : "";
    if (patch) rightLinesByPath.set(file.path, rightSideLinesFromPatch(patch));
  }
  const out: ReviewInlineComment[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    if (out.length >= MAX_INLINE_COMMENTS) break;
    const validLines = rightLinesByPath.get(finding.path);
    if (!validLines || !validLines.has(finding.line)) continue; // not a commentable diff line → drop (no 422)
    const key = `${finding.path}:${finding.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: finding.path, line: finding.line, side: "RIGHT", body: formatInlineBody(finding) });
  }
  return out;
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
  },
): Promise<{ posted: number }> {
  const comments = selectInlineComments(args.findings, args.files);
  if (comments.length === 0 || !args.commitId) return { posted: 0 };
  try {
    await createPullRequestReviewComments(env, args.installationId, args.repoFullName, args.pullNumber, args.commitId, comments, args.mode);
    return { posted: comments.length };
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "inline_comments_post_failed", repository: args.repoFullName, pullNumber: args.pullNumber, count: comments.length, error: errorMessage(error) }));
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
  },
): Promise<void> {
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
  });
}
