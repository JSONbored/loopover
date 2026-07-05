import type { LinkedIssueHardRulesConfig, LinkedIssueHardRulesMode } from "../types";

const VALID_LINKED_ISSUE_HARD_RULE_MODES: readonly LinkedIssueHardRulesMode[] = ["block", "off"];
const DEFAULT_CLOSE_DELAY_SECONDS = 30;
const MAX_CLOSE_DELAY_SECONDS = 300;

export const DEFAULT_LINKED_ISSUE_HARD_RULES: LinkedIssueHardRulesConfig = {
  ownerAssignedClose: "off",
  assignedIssueClose: "off",
  missingPointLabelClose: "off",
  maintainerOnlyLabelClose: "off",
  pointBearingLabels: [],
  maintainerOnlyLabels: [],
  defaultLabelRepo: false,
  verifyBeforeClose: true,
  closeDelaySeconds: DEFAULT_CLOSE_DELAY_SECONDS,
};

export function isLinkedIssueHardRuleMode(value: unknown): value is LinkedIssueHardRulesMode {
  return typeof value === "string" && (VALID_LINKED_ISSUE_HARD_RULE_MODES as readonly string[]).includes(value);
}

function normalizeStringList(value: unknown, field: string, warnings: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`settings.linkedIssueHardRules.${field} must be an array; using no labels.`);
    return [];
  }
  const labels: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim().length === 0) {
      warnings.push(`settings.linkedIssueHardRules.${field}[${index}] must be a non-empty string; ignoring it.`);
      continue;
    }
    labels.push(item.trim());
  }
  return labels;
}

function normalizeMode(
  value: unknown,
  field: "ownerAssignedClose" | "assignedIssueClose" | "missingPointLabelClose" | "maintainerOnlyLabelClose",
  warnings: string[],
): LinkedIssueHardRulesMode {
  if (value === undefined) return DEFAULT_LINKED_ISSUE_HARD_RULES[field];
  if (isLinkedIssueHardRuleMode(value)) return value;
  warnings.push(`settings.linkedIssueHardRules.${field} must be one of block, off; using the default "${DEFAULT_LINKED_ISSUE_HARD_RULES[field]}".`);
  return DEFAULT_LINKED_ISSUE_HARD_RULES[field];
}

function normalizeBoolean(value: unknown, field: "defaultLabelRepo" | "verifyBeforeClose", warnings: string[]): boolean {
  if (value === undefined) return DEFAULT_LINKED_ISSUE_HARD_RULES[field];
  if (typeof value === "boolean") return value;
  warnings.push(`settings.linkedIssueHardRules.${field} must be a boolean; using the default "${DEFAULT_LINKED_ISSUE_HARD_RULES[field]}".`);
  return DEFAULT_LINKED_ISSUE_HARD_RULES[field];
}

function normalizeCloseDelaySeconds(value: unknown, warnings: string[]): number {
  if (value === undefined) return DEFAULT_LINKED_ISSUE_HARD_RULES.closeDelaySeconds;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    warnings.push(`settings.linkedIssueHardRules.closeDelaySeconds must be a non-negative number; using the default "${DEFAULT_CLOSE_DELAY_SECONDS}".`);
    return DEFAULT_CLOSE_DELAY_SECONDS;
  }
  return Math.min(MAX_CLOSE_DELAY_SECONDS, Math.floor(value));
}

export function normalizeLinkedIssueHardRulesConfig(input: unknown, warnings: string[]): LinkedIssueHardRulesConfig {
  if (input === undefined) return { ...DEFAULT_LINKED_ISSUE_HARD_RULES, pointBearingLabels: [], maintainerOnlyLabels: [] };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    warnings.push("settings.linkedIssueHardRules must be an object; using the default all-off policy.");
    return { ...DEFAULT_LINKED_ISSUE_HARD_RULES, pointBearingLabels: [], maintainerOnlyLabels: [] };
  }
  const record = input as Record<string, unknown>;
  return {
    ownerAssignedClose: normalizeMode(record.ownerAssignedClose, "ownerAssignedClose", warnings),
    assignedIssueClose: normalizeMode(record.assignedIssueClose, "assignedIssueClose", warnings),
    missingPointLabelClose: normalizeMode(record.missingPointLabelClose, "missingPointLabelClose", warnings),
    maintainerOnlyLabelClose: normalizeMode(record.maintainerOnlyLabelClose, "maintainerOnlyLabelClose", warnings),
    pointBearingLabels: normalizeStringList(record.pointBearingLabels, "pointBearingLabels", warnings),
    maintainerOnlyLabels: normalizeStringList(record.maintainerOnlyLabels, "maintainerOnlyLabels", warnings),
    defaultLabelRepo: normalizeBoolean(record.defaultLabelRepo, "defaultLabelRepo", warnings),
    verifyBeforeClose: normalizeBoolean(record.verifyBeforeClose, "verifyBeforeClose", warnings),
    closeDelaySeconds: normalizeCloseDelaySeconds(record.closeDelaySeconds, warnings),
  };
}
