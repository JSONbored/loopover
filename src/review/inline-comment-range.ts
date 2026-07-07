/** Multi-line inline comment range validation (#2141). */

import { rightSideLinesFromPatch } from "./inline-comments-select";
import type { InlineFinding } from "../services/ai-review";
import type { PullRequestFileRecord } from "../types";

/** Normalized [start, end] for an inline finding — `line` is always the start; invalid/inverted/absent `endLine`
 *  collapses to a single-line anchor. */
export function parseInlineLineRange(finding: Pick<InlineFinding, "line" | "endLine">): { start: number; end: number } {
  const start = finding.line;
  const end = finding.endLine != null && finding.endLine > start ? finding.endLine : start;
  return { start, end };
}

/** True when every line in the inclusive [start, end] range is present in `lines`. */
export function everyLineInSet(start: number, end: number, lines: Set<number>): boolean {
  for (let line = start; line <= end; line += 1) {
    if (!lines.has(line)) return false;
  }
  return true;
}

/** Build per-file RIGHT-side commentable line sets from PR file records. */
export function rightLinesByPath(
  files: Pick<PullRequestFileRecord, "path" | "payload">[],
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const file of files) {
    const patch = typeof file.payload?.patch === "string" ? file.payload.patch : "";
    if (patch) out.set(file.path, rightSideLinesFromPatch(patch));
  }
  return out;
}

/** Resolve the GitHub inline-comment anchor for a finding. Multi-line ONLY when every line in [start,end] is
 *  commentable on the RIGHT side; otherwise downgrade to the single start line (fail-safe, no 422). */
export function resolveInlineCommentAnchor(
  finding: Pick<InlineFinding, "path" | "line" | "endLine">,
  rightLines: Map<string, Set<number>>,
): { start: number; end: number; multiLine: boolean } {
  const { start, end } = parseInlineLineRange(finding);
  const validLines = rightLines.get(finding.path);
  if (!validLines || !everyLineInSet(start, end, validLines)) {
    return { start, end: start, multiLine: false };
  }
  if (end > start) return { start, end, multiLine: true };
  return { start, end: start, multiLine: false };
}
