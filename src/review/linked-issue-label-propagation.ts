import type { LinkedIssueLabelPropagationConfig, LinkedIssueLabelPropagationMapping, LinkedIssueLabelPropagationMode } from "../types";

export type { LinkedIssueLabelPropagationConfig, LinkedIssueLabelPropagationMapping, LinkedIssueLabelPropagationMode } from "../types";

// Linked-issue label PROPAGATION (#priority-linked-issue-gate). Generic, config-driven mechanism: when a
// linked/closing issue already carries a configured label, copy a mapped label onto the PR. Built specifically
// so a maintainer-reward/bonus label (e.g. `gittensor:priority`) can NEVER be inferred from a PR's title,
// changed files, AI output, or existing PR labels — only ever from a linked issue that ALREADY carries it.
// Generic beyond that one use case: any self-hoster can map any issue label to any PR label, exclusive
// (replaces the normal bug/feature type label, like priority does) or additive (applied alongside it).
//
// PURE config types + normalizer only — no GitHub/fetch/Env-dependent imports. `focus-manifest.ts`'s YAML
// parser imports this module directly, and `focus-manifest.ts` is itself pulled into the gittensory-ui
// workspace's isolated typecheck (via `apps/gittensory-ui/src/lib/registration-workspace.ts`), which has no
// visibility into the Worker's ambient `Env` type. The actual GitHub fetch orchestrator
// (`fetchLinkedIssueLabelsForPropagation`) lives in `linked-issue-label-propagation-fetch.ts` instead, kept
// out of this file specifically so the UI workspace's typecheck never has to resolve `Env`.

// Fail-SAFE default: propagation OFF, no mappings. A self-hoster must explicitly opt in per repo.
export const DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION: LinkedIssueLabelPropagationConfig = {
  enabled: false,
  mode: "exclusive_type_label",
  mappings: [],
};

const VALID_MODES: readonly LinkedIssueLabelPropagationMode[] = ["exclusive_type_label"];

function normalizeMapping(input: unknown, index: number, warnings: string[]): LinkedIssueLabelPropagationMapping | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    warnings.push(`settings.linkedIssueLabelPropagation.mappings[${index}] must be an object; ignoring it.`);
    return null;
  }
  const record = input as Record<string, unknown>;
  const issueLabel = typeof record.issueLabel === "string" ? record.issueLabel.trim() : "";
  const prLabel = typeof record.prLabel === "string" ? record.prLabel.trim() : "";
  if (issueLabel.length === 0 || prLabel.length === 0) {
    warnings.push(`settings.linkedIssueLabelPropagation.mappings[${index}] must have non-empty "issueLabel" and "prLabel" strings; ignoring it.`);
    return null;
  }
  return { issueLabel, prLabel, removeOtherTypeLabels: record.removeOtherTypeLabels === true };
}

/** Defaults-fill a per-repo `linkedIssueLabelPropagation` override into an always-complete, safe config —
 *  mirrors `normalizeCommandAuthorizationPolicy`'s defaults-fill pattern
 *  (`src/settings/command-authorization.ts`). Malformed mapping entries are dropped with a warning; valid
 *  entries in the same array are kept (matches `commandAuthorization`'s per-entry `commands` validation). */
export function normalizeLinkedIssueLabelPropagationConfig(input: unknown, warnings: string[]): LinkedIssueLabelPropagationConfig {
  if (input === undefined) return { ...DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION, mappings: [] };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    warnings.push("settings.linkedIssueLabelPropagation must be an object; propagation stays disabled.");
    return { ...DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION, mappings: [] };
  }
  const record = input as Record<string, unknown>;
  const enabled = record.enabled === true;
  let mode: LinkedIssueLabelPropagationMode = DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION.mode;
  if (record.mode !== undefined) {
    if (typeof record.mode === "string" && (VALID_MODES as readonly string[]).includes(record.mode)) {
      mode = record.mode as LinkedIssueLabelPropagationMode;
    } else {
      warnings.push(`settings.linkedIssueLabelPropagation.mode must be one of ${VALID_MODES.join(", ")}; using the default "${DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION.mode}".`);
    }
  }
  let mappings: LinkedIssueLabelPropagationMapping[] = [];
  if (record.mappings !== undefined) {
    if (Array.isArray(record.mappings)) {
      mappings = record.mappings.flatMap((entry, index) => {
        const normalized = normalizeMapping(entry, index, warnings);
        return normalized ? [normalized] : [];
      });
    } else {
      warnings.push("settings.linkedIssueLabelPropagation.mappings must be an array; using no mappings.");
    }
  }
  return { enabled, mode, mappings };
}
