import { matchesManifestPath, type LabelingRule } from "../signals/focus-manifest";

// Deterministic evaluation of `review.labeling_rules` (#2045, part of #1959). Given a repo's parsed rules and a PR's
// facts, decide which non-scoring labels the rules SUGGEST — and, when the repo's `autoLabelEnabled` is set, which to
// auto-apply. Pure (no IO), mirroring the pure `resolvePrTypeLabel` decider in src/settings/pr-type-label.ts: the
// actual GitHub apply is a separate processor concern, kept out of here so this stays deterministic and unit-testable.

/** The PR facts a labeling rule matches against. */
export type LabelingRuleFacts = {
  changedPaths: readonly string[];
  title: string;
  description: string;
};

/** `suggest`: every firing rule's label (advisory, deduped, in rule order). `apply`: the subset to actually write —
 *  the same list when `autoLabelEnabled`, otherwise empty (suggestions only). */
export type LabelingDecision = { suggest: string[]; apply: string[] };

/** A rule fires when ALL of its specified criteria match: at least one changed path matches a `whenPaths` glob (when
 *  any is set), the title contains `titleContains` (case-insensitive), and the description contains
 *  `descriptionContains`. Unset criteria don't constrain. A rule always has ≥1 criterion (enforced at parse). Pure. */
function ruleMatches(rule: LabelingRule, facts: LabelingRuleFacts): boolean {
  if (rule.whenPaths.length > 0 && !facts.changedPaths.some((path) => rule.whenPaths.some((glob) => matchesManifestPath(path, glob)))) {
    return false;
  }
  if (rule.titleContains !== null && !facts.title.toLowerCase().includes(rule.titleContains.toLowerCase())) return false;
  if (rule.descriptionContains !== null && !facts.description.toLowerCase().includes(rule.descriptionContains.toLowerCase())) return false;
  return true;
}

/** Resolve the labels suggested (and, when auto-labeling is on, to apply) for a PR. Deterministic: preserves rule
 *  order, dedupes, and never mutates its inputs. Pure. */
export function resolveLabelingRules(input: {
  rules: readonly LabelingRule[];
  facts: LabelingRuleFacts;
  autoLabelEnabled: boolean;
}): LabelingDecision {
  const suggest: string[] = [];
  for (const rule of input.rules) {
    if (ruleMatches(rule, input.facts) && !suggest.includes(rule.label)) suggest.push(rule.label);
  }
  return { suggest, apply: input.autoLabelEnabled ? [...suggest] : [] };
}
