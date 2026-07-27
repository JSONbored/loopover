/** Pure inline-comment selection with optional per-category caps (#2159). */

import { classifyFindingCategory, type FindingCategory } from "./finding-category-classify";
import { addedLinesByPath } from "./inline-suggestion-anchor";
import { shouldShowInlineFinding } from "./finding-severity-filter";
import type { InlineFinding } from "../services/ai-review";
import type { ReviewFindingSeverity } from "../signals/focus-manifest";
import type { PullRequestFileRecord } from "../types";

export const DEFAULT_MAX_INLINE_COMMENTS = 10;

/** PURE: the set of NEW-file (RIGHT-side) line numbers a unified-diff patch makes commentable. */
export function rightSideLinesFromPatch(patch: string): Set<number> {
  const lines = new Set<number>();
  let right = 0;
  // A patch ending in "\n" splits to a trailing empty element that is a split artifact, not a diff line. It is
  // dropped here rather than inside the loop so that a remaining empty element genuinely means "a context line
  // whose leading space was stripped" (#9076) and can be counted as one.
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
    // #9076: an EMPTY patch line (marker `undefined`) is a context line whose single space was stripped, not a
    // line that does not exist. Skipping it without advancing `right` desynchronized every subsequent line
    // number in the file, so findings anchored after it pointed somewhere else entirely. Git emits `" "` for a
    // blank context line so real GitHub payloads should not hit this, but nothing enforced that and the
    // failure was silent — counting it as the context line it is costs nothing and removes the whole class.
    lines.add(right);
    right += 1;
  }
  return lines;
}

/** Higher-priority categories survive per-category and total caps first (#2159). */
const INLINE_COMMENT_CATEGORY_PRIORITY: Record<FindingCategory, number> = {
  security: 0,
  correctness: 1,
  performance: 2,
  maintainability: 3,
  tests: 4,
  style: 5,
};

export function inlineFindingCategory(finding: InlineFinding): FindingCategory {
  return finding.category ?? classifyFindingCategory(finding);
}

/** Lower rank sorts earlier. Blockers always beat nits; ties break on category priority. */
export function compareInlineFindingPriority(left: InlineFinding, right: InlineFinding): number {
  const leftSeverity = left.severity === "blocker" ? 0 : 1;
  const rightSeverity = right.severity === "blocker" ? 0 : 1;
  if (leftSeverity !== rightSeverity) return leftSeverity - rightSeverity;
  const leftCategory = INLINE_COMMENT_CATEGORY_PRIORITY[inlineFindingCategory(left)];
  const rightCategory = INLINE_COMMENT_CATEGORY_PRIORITY[inlineFindingCategory(right)];
  return leftCategory - rightCategory;
}

export type InlineCommentSelectOptions = {
  suggestionsEnabled?: boolean | undefined;
  categoriesEnabled?: boolean | undefined;
  minFindingSeverity?: ReviewFindingSeverity | null | undefined;
  /** When unset, preserve first-seen order with only the total cap (#2159 default-off). */
  perCategoryCap?: number | null | undefined;
  maxComments?: number | undefined;
};

type AnchoredInlineFinding = { finding: InlineFinding; index: number };

function anchorableInlineFindings(
  findings: InlineFinding[],
  files: Pick<PullRequestFileRecord, "path" | "payload">[],
  minFindingSeverity: ReviewFindingSeverity | null | undefined,
): AnchoredInlineFinding[] {
  const rightLinesByPath = new Map<string, Set<number>>();
  for (const file of files) {
    const patch = typeof file.payload?.patch === "string" ? file.payload.patch : "";
    if (patch) rightLinesByPath.set(file.path, rightSideLinesFromPatch(patch));
  }
  // #9076: BLOCKERS must land on an ADDED line, not merely a commentable one. rightSideLinesFromPatch admits
  // every RIGHT-side line — added AND unchanged context — while the reviewer prompt explicitly asks for "an
  // ADDED (`+`) line" and warns that "a wrong line is worse than none". Set membership was the only check, and
  // a context line satisfies it, so a model miscounting by one to three lines within a hunk landed on context,
  // passed every check, and posted. The two properties this file conflated are not the same: "GitHub will
  // accept this anchor" is about avoiding a 422, and "this anchor is CORRECT" is about not telling a
  // contributor their bug is on a line they did not write.
  //
  // Scoped to blockers deliberately. A blocker is the finding that can cost someone their PR, so a wrong line
  // there is the expensive error; a misplaced nit is noise, and holding nits to the stricter rule would drop
  // legitimate ones that genuinely concern surrounding context.
  const addedLines = addedLinesByPath(files);
  const out: AnchoredInlineFinding[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < findings.length; index++) {
    const finding = findings[index]!;
    if (!shouldShowInlineFinding(finding.severity, minFindingSeverity)) continue;
    const validLines = finding.severity === "blocker" ? addedLines.get(finding.path) : rightLinesByPath.get(finding.path);
    if (!validLines || !validLines.has(finding.line)) continue;
    const key = `${finding.path}:${finding.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ finding, index });
  }
  return out;
}

/** Select anchorable inline findings, optionally applying a per-category sub-cap before the total cap. */
export function selectAnchoredInlineFindings(
  findings: InlineFinding[],
  files: Pick<PullRequestFileRecord, "path" | "payload">[],
  options: InlineCommentSelectOptions,
): InlineFinding[] {
  const anchored = anchorableInlineFindings(findings, files, options.minFindingSeverity);
  const maxComments = options.maxComments ?? DEFAULT_MAX_INLINE_COMMENTS;
  const perCategoryCap = options.perCategoryCap;
  const ordered =
    perCategoryCap == null
      ? anchored
      : [...anchored].sort((left, right) => {
          const byPriority = compareInlineFindingPriority(left.finding, right.finding);
          if (byPriority !== 0) return byPriority;
          return left.index - right.index;
        });
  const perCategoryCounts = new Map<FindingCategory, number>();
  const out: InlineFinding[] = [];
  for (const { finding } of ordered) {
    if (out.length >= maxComments) break;
    if (perCategoryCap != null) {
      const category = inlineFindingCategory(finding);
      const count = perCategoryCounts.get(category) ?? 0;
      if (count >= perCategoryCap) continue;
      perCategoryCounts.set(category, count + 1);
    }
    out.push(finding);
  }
  return out;
}
