/** Suggestion anchor-safety for inline PR review comments (#2140). */

import type { InlineFinding } from "../services/ai-review";
import type { PullRequestFileRecord } from "../types";

/** PURE: RIGHT-side line numbers that are ADDED ("+") in a unified-diff patch — the only lines GitHub
 *  accepts a ```suggestion block on. Context lines are commentable for plain inline notes but not for
 *  suggested changes. */
export function addedLinesFromPatch(patch: string): Set<number> {
  const lines = new Set<number>();
  let right = 0;
  for (const raw of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header?.[1]) {
      right = Number.parseInt(header[1], 10);
      continue;
    }
    if (right === 0) continue;
    const marker = raw[0];
    if (marker === undefined || marker === "-" || marker === "\\") continue;
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
  finding: Pick<InlineFinding, "path" | "line">,
  addedLines: Map<string, Set<number>>,
): boolean {
  const validLines = addedLines.get(finding.path);
  return validLines != null && validLines.has(finding.line);
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
