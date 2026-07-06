/** Pure inline-comment selection with optional per-category caps (#2159). */

import { classifyFindingCategory, type FindingCategory } from "./finding-category-classify";
import { shouldShowInlineFinding } from "./finding-severity-filter";
import type { InlineFinding } from "../services/ai-review";
import type { ReviewFindingSeverity } from "../signals/focus-manifest";
import type { PullRequestFileRecord } from "../types";

export const DEFAULT_MAX_INLINE_COMMENTS = 10;

/** PURE: the set of NEW-file (RIGHT-side) line numbers a unified-diff patch makes commentable. */
export function rightSideLinesFromPatch(patch: string): Set<number> {
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
  const out: AnchoredInlineFinding[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < findings.length; index++) {
    const finding = findings[index]!;
    if (!shouldShowInlineFinding(finding.severity, minFindingSeverity)) continue;
    const validLines = rightLinesByPath.get(finding.path);
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
  options: InlineCommentSelectOptions = {},
): InlineFinding[] {
  const anchored = anchorableInlineFindings(findings, files, options.minFindingSeverity);
  const maxComments = options.maxComments ?? DEFAULT_MAX_INLINE_COMMENTS;
  const perCategoryCap = options.perCategoryCap;
  const ordered =
    perCategoryCap == null
      ? anchored
      : [...anchored].sort((left, right) => compareInlineFindingPriority(left.finding, right.finding) || left.index - right.index);
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
