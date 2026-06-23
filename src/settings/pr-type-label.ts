// Neutral per-PR TYPE label (reviewbot src/core/auto-label.ts parity). Applies EXACTLY ONE of:
//   gittensor:priority — a content submission (changed paths match contentGlobs) — truly valuable.
//   gittensor:feature  — genuine NEW functionality only (conventional-commit `feat`/`feature`).
//   gittensor:bug      — EVERYTHING ELSE: fix, test, docs, chore, refactor, perf, ci, build, style, revert.
// Public + neutral categorization (NOT the reputation signal). Review-time + independent of the gate /
// autonomy / dry-run (matches reviewbot, where auto-label runs at review start). Fail-safe.
import { matchesAny } from "../signals/change-guardrail";

export interface PrTypeLabelSet {
  bug: string;
  feature: string;
  priority: string;
}

/** The gittensor: namespace the maintainer uses. The three are mutually exclusive (the other two are dropped). */
export const DEFAULT_TYPE_LABELS: PrTypeLabelSet = {
  bug: "gittensor:bug",
  feature: "gittensor:feature",
  priority: "gittensor:priority",
};

export const ALL_TYPE_LABELS: readonly string[] = [DEFAULT_TYPE_LABELS.bug, DEFAULT_TYPE_LABELS.feature, DEFAULT_TYPE_LABELS.priority];

/** feature ONLY for genuine new functionality (feat); EVERYTHING else — fix, test, docs, chore, refactor,
 *  perf, ci, build, style, revert — is bug (a test PR is a test, not a feature). (reviewbot auto-label.ts:27) */
export function deriveKindFromTitle(title: string | undefined): "bug" | "feature" {
  const match = /^([a-zA-Z]+)/.exec((title ?? "").trim());
  const type = match?.[1]?.toLowerCase();
  return type === "feat" || type === "feature" ? "feature" : "bug";
}

/**
 * Resolve the single TYPE label for a PR (priority order):
 *  1. CONTENT submission — any changed path matches a contentGlob → priority.
 *  2. else feature (feat) / bug (everything else) by the conventional-commit title prefix.
 * Pure + total. Returns the chosen label name.
 */
export function resolvePrTypeLabel(input: { title: string | undefined; changedPaths: string[]; contentGlobs: string[]; labels?: PrTypeLabelSet }): string {
  const labels = input.labels ?? DEFAULT_TYPE_LABELS;
  if (input.contentGlobs.length > 0 && input.changedPaths.some((path) => matchesAny(path, input.contentGlobs))) {
    return labels.priority;
  }
  return labels[deriveKindFromTitle(input.title)];
}
