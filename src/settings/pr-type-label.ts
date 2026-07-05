// Neutral per-PR TYPE label (reviewbot src/core/auto-label.ts parity). The label CATEGORIES are a
// config-driven, open `category -> label name` map (#label-modularity) — `bug`/`feature`/`priority` are
// the built-in gittensor:* categories shipped as the DEFAULT config, not hardcoded engine assumptions:
//   priority — ONLY when a linked/closing issue already carries the configured priority issue label
//              (#priority-linked-issue-gate, `linkedIssueLabelPropagation`). Never inferred from title,
//              changed files, AI output, or existing PR labels.
//   feature  — genuine NEW functionality only (conventional-commit `feat`/`feature`).
//   bug      — EVERYTHING ELSE: fix, test, docs, chore, refactor, perf, ci, build, style, revert.
// A self-hoster can register a bounded number of ADDITIONAL categories in `typeLabels` beyond these three (e.g.
// `security: "area:security"`) — an extra category is never chosen by title-classification (only bug/
// feature are), only ever by a configured `linkedIssueLabelPropagation` mapping's `prLabel` (which can
// target ANY string, registered in `typeLabels` or not); registering it here just makes it participate
// in the mutual-exclusivity cleanup below, i.e. eligible for automatic removal when a PR's classification
// moves away from it. Public + neutral categorization (NOT the reputation signal). Review-time +
// independent of the gate / autonomy / dry-run (matches reviewbot, where auto-label runs at review
// start). Fail-safe.
import type { LinkedIssueLabelPropagationConfig, PrTypeLabelSet } from "../types";

export type { PrTypeLabelSet } from "../types";

/** The gittensor: namespace Gittensor itself uses -- an EXAMPLE default config, not an engine
 *  assumption (#label-modularity): a self-hoster's `typeLabels` fully replaces the category set these
 *  keys are drawn from. The built-in categories are mutually exclusive by default (see
 *  `resolvePrTypeLabel`'s `removeLabels`) unless a propagation mapping is explicitly additive. */
export const DEFAULT_TYPE_LABELS: PrTypeLabelSet = {
  bug: "gittensor:bug",
  feature: "gittensor:feature",
  priority: "gittensor:priority",
};

/** Every label name in the built-in default set, generic over however many categories
 *  `DEFAULT_TYPE_LABELS` carries (#label-modularity) -- never hardcode `.bug`/`.feature`/`.priority`
 *  property access here, a configured set can carry more or fewer categories than the default. */
export const ALL_TYPE_LABELS: readonly string[] = Object.values(DEFAULT_TYPE_LABELS);

export const MAX_TYPE_LABEL_CATEGORIES = 32;
export const MAX_TYPE_LABEL_NAME_LENGTH = 50;

const FEATURE_TITLE_ACTION_RE = /\b(add|adds|added|create|creates|created|enable|enables|enabled|implement|implements|implemented|integrate|integrates|integrated|introduce|introduces|introduced|launch|launches|launched|support|supports|supported|wire|wires|wired)\b/i;
const FEATURE_TITLE_DOWNGRADE_RE = /\b(avoid|block|bug|bugfix|cache|classify|classifies|classifying|cleanup|clean-up|clean up|detect|detects|detecting|docs?|fix|format|guard|lint|normalize|recognize|recognizes|recognizing|refactor|regression|rename|test|tests|testing|tighten|typo)\b/i;

/** feature ONLY for substantial new functionality: a feat/feature prefix plus a concrete add/support/enable
 *  action, with small recognition/classification/cleanup-style work downgraded to bug/work. EVERYTHING else —
 *  fix, test, docs, chore, refactor, perf, ci, build, style, revert — is bug. */
export function deriveKindFromTitle(title: string | undefined): "bug" | "feature" {
  const normalized = (title ?? "").trim();
  const match = /^([a-zA-Z]+)/.exec(normalized);
  const type = match?.[1]?.toLowerCase();
  if (type !== "feat" && type !== "feature") return "bug";
  const subject = normalized.replace(/^[a-zA-Z]+(?:\([^)]*\))?:?\s*/, "");
  if (!FEATURE_TITLE_ACTION_RE.test(subject)) return "bug";
  return FEATURE_TITLE_DOWNGRADE_RE.test(subject) ? "bug" : "feature";
}

/** Defaults-fill a per-repo `typeLabels` override (config-as-code), generic over an arbitrary set of
 *  categories (#label-modularity): every key of `DEFAULT_TYPE_LABELS` (the built-in bug/feature/
 *  priority categories) is taken independently from `input` when it is a non-empty string, else falls
 *  back to the corresponding built-in default — so a repo can override just one built-in label name
 *  (e.g. only `priority`) and keep the others default. Any EXTRA key present in `input` beyond the
 *  built-in set (a self-hoster's own custom category, e.g. `security`) is included verbatim when
 *  valid, up to `MAX_TYPE_LABEL_CATEGORIES` total categories and GitHub's 50-character label-name
 *  limit; there is no built-in default for it to fall back to, so an invalid extra-category value is
 *  dropped entirely (warned, not defaulted) rather than silently defaulted. A non-object input yields
 *  the full default set; omitted is normal (no warning), present-but-wrong-shaped warns. An input that
 *  IS a valid object but has zero own keys (`{}`) also yields the full default set here — this
 *  function only ever defaults-fills or validates a COMPLETE settings value (the DB-persisted set, or
 *  a from-scratch construction); `resolveEffectiveSettings` (focus-manifest.ts) is what gives a
 *  manifest's *literal* `typeLabels: {}` its own distinct "deliberately zero categories" meaning,
 *  since collapsing that here would also flip every legacy `type_labels_json = '{}'` DB row (the SQL
 *  column's own default, predating any explicit customization) from full defaults to zero labels —
 *  the exact behavior change #priority-linked-issue-gate's migration promised existing repos would
 *  never see. Mirrors `normalizeCommandAuthorizationPolicy`'s defaults-fill pattern
 *  (`src/settings/command-authorization.ts`). */
export function normalizeTypeLabelSet(input: unknown, warnings: string[]): PrTypeLabelSet {
  if (input === undefined) return { ...DEFAULT_TYPE_LABELS };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    warnings.push("settings.typeLabels must be an object; using default label names.");
    return { ...DEFAULT_TYPE_LABELS };
  }
  const record = input as Record<string, unknown>;
  const keys = new Set([...Object.keys(DEFAULT_TYPE_LABELS), ...Object.keys(record)]);
  const result: PrTypeLabelSet = {};
  for (const key of keys) {
    const value = record[key];
    const wouldAddCategory = result[key] === undefined;
    if (wouldAddCategory && Object.keys(result).length >= MAX_TYPE_LABEL_CATEGORIES) {
      if (value !== undefined) warnings.push(`settings.typeLabels has more than ${MAX_TYPE_LABEL_CATEGORIES} categories; ignoring ${key}.`);
      continue;
    }
    const builtInDefault: string | undefined = DEFAULT_TYPE_LABELS[key];
    if (typeof value === "string" && value.trim().length > 0 && value.trim().length <= MAX_TYPE_LABEL_NAME_LENGTH) {
      result[key] = value.trim();
      continue;
    }
    if (value !== undefined) {
      const reason = typeof value === "string" && value.trim().length > MAX_TYPE_LABEL_NAME_LENGTH ? `a non-empty string no longer than ${MAX_TYPE_LABEL_NAME_LENGTH} characters` : "a non-empty string";
      warnings.push(
        builtInDefault !== undefined
          ? `settings.typeLabels.${key} must be ${reason}; using the default "${builtInDefault}".`
          : `settings.typeLabels.${key} must be ${reason}; ignoring it.`,
      );
    }
    // Reached for BOTH an invalid present value and an absent one -- a built-in category (bug/feature/
    // priority) always has a default to fall back to; an unknown custom category does not, so it is
    // dropped entirely (warned above when it was present-but-invalid, silently absent when never named).
    if (builtInDefault !== undefined) result[key] = builtInDefault;
  }
  return result;
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
 *  2. Otherwise, feature (feat/feature) / bug (everything else) by the conventional-commit title prefix
 *     -- ONLY when `labels` actually has a name registered for that built-in category; a configured set
 *     that omits `bug`/`feature` entirely (a self-hoster who only wants custom, propagation-driven
 *     categories, or an explicit `typeLabels: {}` resolved to zero categories) applies nothing for that
 *     branch rather than inventing a label name (#label-modularity).
 * `removeLabels` is always "every member of the configured type-label set that isn't one of
 * `applyLabels`" — generic and total over however many categories are configured, and safe even if a
 * misconfigured additive mapping's `prLabel` happens to collide with a type-label-set name (it is
 * excluded from removal since it is also being applied). Pure + total.
 */
export function resolvePrTypeLabel(input: {
  title: string | undefined;
  linkedIssueLabels?: string[] | undefined;
  labels?: PrTypeLabelSet | undefined;
  propagation?: LinkedIssueLabelPropagationConfig | undefined;
}): PrTypeLabelDecision {
  const labels = input.labels ?? DEFAULT_TYPE_LABELS;
  const isRealLabel = (label: string | undefined): label is string => typeof label === "string" && label.length > 0;
  const typeLabelSet = Object.values(labels).filter(isRealLabel).filter((label) => label.length <= MAX_TYPE_LABEL_NAME_LENGTH).slice(0, MAX_TYPE_LABEL_CATEGORIES);
  const titleLabel: string | undefined = labels[deriveKindFromTitle(input.title)];
  const decide = (applyLabels: ReadonlyArray<string | undefined>, source: PrTypeLabelDecision["source"]): PrTypeLabelDecision => {
    const apply = [...new Set(applyLabels.filter(isRealLabel))];
    return { applyLabels: apply, removeLabels: typeLabelSet.filter((label) => !apply.includes(label)), source };
  };

  if (input.propagation?.enabled) {
    const wanted = new Set((input.linkedIssueLabels ?? []).map((label) => label.toLowerCase()));
    for (const mapping of input.propagation.mappings) {
      if (!wanted.has(mapping.issueLabel.toLowerCase())) continue;
      return mapping.removeOtherTypeLabels ? decide([mapping.prLabel], "propagation_exclusive") : decide([titleLabel, mapping.prLabel], "propagation_additive");
    }
  }
  return decide([titleLabel], "title");
}
