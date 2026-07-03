// Neutral per-PR TYPE label (reviewbot src/core/auto-label.ts parity). Applies one or more of:
//   gittensor:priority — ONLY when a linked/closing issue already carries the configured priority
//                         issue label (#priority-linked-issue-gate, `linkedIssueLabelPropagation`).
//                         Never inferred from title, changed files, AI output, or existing PR labels.
//   gittensor:feature  — genuine NEW functionality only (conventional-commit `feat`/`feature`).
//   gittensor:bug      — EVERYTHING ELSE: fix, test, docs, chore, refactor, perf, ci, build, style, revert.
// Public + neutral categorization (NOT the reputation signal). Review-time + independent of the gate /
// autonomy / dry-run (matches reviewbot, where auto-label runs at review start). Fail-safe.
import type { LinkedIssueLabelPropagationConfig, PrTypeLabelSet } from "../types";

export type { PrTypeLabelSet } from "../types";

/** The gittensor: namespace the maintainer uses. The three are mutually exclusive by default (see
 *  `resolvePrTypeLabel`'s `removeLabels`) unless a propagation mapping is explicitly additive. */
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

/** Defaults-fill a per-repo `typeLabels` override (config-as-code): each of bug/feature/priority is
 *  taken independently from `input` when it is a non-empty string, else falls back to the
 *  corresponding `DEFAULT_TYPE_LABELS` value — so a repo can override just one label name and keep
 *  the other two at their default. A non-object input yields the full default set; omitted is normal
 *  (no warning), present-but-wrong-shaped warns. Mirrors `normalizeCommandAuthorizationPolicy`'s
 *  defaults-fill pattern (`src/settings/command-authorization.ts`). */
export function normalizeTypeLabelSet(input: unknown, warnings: string[]): PrTypeLabelSet {
  if (input === undefined) return { ...DEFAULT_TYPE_LABELS };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    warnings.push("settings.typeLabels must be an object; using default label names.");
    return { ...DEFAULT_TYPE_LABELS };
  }
  const record = input as Record<string, unknown>;
  const pick = (key: keyof PrTypeLabelSet): string => {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (value !== undefined) warnings.push(`settings.typeLabels.${key} must be a non-empty string; using the default "${DEFAULT_TYPE_LABELS[key]}".`);
    return DEFAULT_TYPE_LABELS[key];
  };
  return { bug: pick("bug"), feature: pick("feature"), priority: pick("priority") };
}

/** The pure decision `resolvePrTypeLabel` returns: which label(s) to apply, which configured
 *  type-label-set members to remove for mutual exclusivity, and why. */
export type PrTypeLabelDecision = {
  applyLabels: string[];
  removeLabels: string[];
  source: "propagation_exclusive" | "propagation_additive" | "title";
};

/**
 * Resolve the TYPE label decision for a PR.
 *  1. Linked-issue label PROPAGATION (config-driven, #priority-linked-issue-gate): when enabled, the
 *     FIRST configured mapping whose `issueLabel` appears (case-insensitively) among the
 *     ALREADY-FETCHED `linkedIssueLabels` wins. This is the ONLY way a label like `gittensor:priority`
 *     can ever be chosen — this function does no I/O and never infers it from title, changed files,
 *     AI output, or PR labels; the caller must fetch `linkedIssueLabels` itself (see
 *     `fetchLinkedIssueLabelsForPropagation` in `review/linked-issue-label-propagation-fetch.ts`).
 *     - `removeOtherTypeLabels: true` (exclusive) — the mapped label REPLACES the type label,
 *       exactly like today's bug/feature/priority classification (used for `gittensor:priority`).
 *     - `removeOtherTypeLabels: false` (additive) — the mapped label is applied ALONGSIDE the
 *       normal title-based bug/feature label, which is left untouched (e.g. a generic
 *       `customer:vip` → `triage:vip` triage marker that has nothing to do with bug/feature/priority).
 *  2. Otherwise, feature (feat/feature) / bug (everything else) by the conventional-commit title prefix.
 * `removeLabels` is always "every member of the configured type-label set that isn't one of
 * `applyLabels`" — generic and total, and safe even if a misconfigured additive mapping's `prLabel`
 * happens to collide with a type-label-set name (it is excluded from removal since it is also being
 * applied). Pure + total.
 */
export function resolvePrTypeLabel(input: {
  title: string | undefined;
  linkedIssueLabels?: string[] | undefined;
  labels?: PrTypeLabelSet | undefined;
  propagation?: LinkedIssueLabelPropagationConfig | undefined;
}): PrTypeLabelDecision {
  const labels = input.labels ?? DEFAULT_TYPE_LABELS;
  const typeLabelSet = Object.values(labels);
  const titleLabel = labels[deriveKindFromTitle(input.title)];
  const decide = (applyLabels: string[], source: PrTypeLabelDecision["source"]): PrTypeLabelDecision => ({
    applyLabels,
    removeLabels: typeLabelSet.filter((label) => !applyLabels.includes(label)),
    source,
  });

  if (input.propagation?.enabled) {
    const wanted = new Set((input.linkedIssueLabels ?? []).map((label) => label.toLowerCase()));
    for (const mapping of input.propagation.mappings) {
      if (!wanted.has(mapping.issueLabel.toLowerCase())) continue;
      return mapping.removeOtherTypeLabels
        ? decide([mapping.prLabel], "propagation_exclusive")
        : decide([...new Set([titleLabel, mapping.prLabel])], "propagation_additive");
    }
  }
  return decide([titleLabel], "title");
}
