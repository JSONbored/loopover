/** Suggestion anchor-safety for inline PR review comments (#2140). */

import { parseInlineLineRange } from "./inline-comment-range";
import type { InlineFinding } from "../services/ai-review";
import type { PullRequestFileRecord } from "../types";

/** PURE: RIGHT-side line numbers that are ADDED ("+") in a unified-diff patch — the only lines GitHub
 *  accepts a ```suggestion block on. Context lines are commentable for plain inline notes but not for
 *  suggested changes. */
export function addedLinesFromPatch(patch: string): Set<number> {
  const lines = new Set<number>();
  let right = 0;
  // Mirror rightSideLinesFromPatch (inline-comments-select.ts) line-for-line so both walkers agree on every
  // RIGHT-side line number (#9663). A patch ending in "\n" splits to a trailing empty element that is a split
  // artifact, not a diff line; drop it here so that a remaining empty element genuinely means "a context line
  // whose leading space was stripped" and advances `right` like the context line it is.
  const rawLines = patch.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  for (const raw of rawLines) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header?.[1]) {
      right = Number.parseInt(header[1], 10);
      continue;
    }
    if (right === 0) continue;
    const marker = raw[0];
    if (marker === "-" || marker === "\\") continue;
    // A zero-length patch line (marker `undefined`) is a context line whose single space was stripped, not a
    // line that does not exist (#9076/#9663). It is NOT added, but it must still advance `right` — skipping it
    // desynced every subsequent added-line number, so a blocker anchored after a blank context line was dropped
    // and one anchored on the blank context line itself was wrongly accepted.
    if (marker === "+") lines.add(right);
    right += 1;
  }
  return lines;
}

/** Build per-file ADDED-line sets from PR file records — skips files with empty or non-string patches. */
export function addedLinesByPath(
  files: Pick<PullRequestFileRecord, "path" | "payload">[],
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const file of files) {
    const patch = typeof file.payload?.patch === "string" ? file.payload.patch : "";
    if (patch) out.set(file.path, addedLinesFromPatch(patch));
  }
  return out;
}

/** True when a finding's line is an ADDED RIGHT-side line that can carry a ```suggestion block. */
export function isSuggestionAnchorable(
  finding: Pick<InlineFinding, "path" | "line" | "endLine">,
  addedLines: Map<string, Set<number>>,
): boolean {
  const validLines = addedLines.get(finding.path);
  if (validLines == null) return false;
  const { start, end } = parseInlineLineRange(finding);
  for (let line = start; line <= end; line += 1) {
    if (!validLines.has(line)) return false;
  }
  return true;
}

/** GitHub suggestion fence — dropped when blank or when the text would break the fence (#1956). */
export function safeSuggestionBlock(suggestion: string | undefined): string {
  if (!suggestion || suggestion.includes("```")) return "";
  return `\n\n\`\`\`suggestion\n${suggestion}\n\`\`\``;
}

/** Render a suggestion block only when enabled and the anchor is an added RIGHT-side line (#2140). */
export function anchoredSuggestionBlock(
  finding: InlineFinding,
  suggestionsEnabled: boolean,
  addedLines: Map<string, Set<number>>,
): string {
  if (!suggestionsEnabled || !isSuggestionAnchorable(finding, addedLines)) return "";
  return safeSuggestionBlock(finding.suggestion);
}
