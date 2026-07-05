import type { UnlinkedIssueGuardrailConfig, UnlinkedIssueGuardrailMode } from "../types";

const VALID_UNLINKED_ISSUE_GUARDRAIL_MODES: readonly UnlinkedIssueGuardrailMode[] = ["hold", "off"];
const DEFAULT_MIN_CONFIDENCE = 0.85;

export const DEFAULT_UNLINKED_ISSUE_GUARDRAIL: UnlinkedIssueGuardrailConfig = {
  mode: "off",
  minConfidence: DEFAULT_MIN_CONFIDENCE,
};

export function isUnlinkedIssueGuardrailMode(value: unknown): value is UnlinkedIssueGuardrailMode {
  return typeof value === "string" && (VALID_UNLINKED_ISSUE_GUARDRAIL_MODES as readonly string[]).includes(value);
}

function normalizeMode(value: unknown, warnings: string[]): UnlinkedIssueGuardrailMode {
  if (value === undefined) return DEFAULT_UNLINKED_ISSUE_GUARDRAIL.mode;
  if (isUnlinkedIssueGuardrailMode(value)) return value;
  warnings.push(`settings.unlinkedIssueGuardrail.mode must be one of hold, off; using the default "${DEFAULT_UNLINKED_ISSUE_GUARDRAIL.mode}".`);
  return DEFAULT_UNLINKED_ISSUE_GUARDRAIL.mode;
}

function normalizeMinConfidence(value: unknown, warnings: string[]): number {
  if (value === undefined) return DEFAULT_UNLINKED_ISSUE_GUARDRAIL.minConfidence;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    warnings.push(`settings.unlinkedIssueGuardrail.minConfidence must be a number between 0 and 1; using the default "${DEFAULT_MIN_CONFIDENCE}".`);
    return DEFAULT_MIN_CONFIDENCE;
  }
  return value;
}

/**
 * Normalize a raw `.gittensory.yml settings.unlinkedIssueGuardrail` value into a typed config,
 * fail-safe: any malformed field falls back to its own default and pushes a warning rather than
 * rejecting the whole block. Mirrors `normalizeLinkedIssueHardRulesConfig`'s per-field discipline.
 */
export function normalizeUnlinkedIssueGuardrailConfig(input: unknown, warnings: string[]): UnlinkedIssueGuardrailConfig {
  if (input === undefined) return { ...DEFAULT_UNLINKED_ISSUE_GUARDRAIL };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    warnings.push("settings.unlinkedIssueGuardrail must be an object; using the default off policy.");
    return { ...DEFAULT_UNLINKED_ISSUE_GUARDRAIL };
  }
  const record = input as Record<string, unknown>;
  return {
    mode: normalizeMode(record.mode, warnings),
    minConfidence: normalizeMinConfidence(record.minConfidence, warnings),
  };
}
