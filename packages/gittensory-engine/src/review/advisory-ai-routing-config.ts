import type { AdvisoryAiRoutingConfig } from "../types/manifest-deps-types.js";

export const DEFAULT_ADVISORY_AI_ROUTING: AdvisoryAiRoutingConfig = {
  slop: false,
  e2eTestGen: false,
  planner: false,
  summaries: false,
  chatQa: false,
};

function normalizeField(value: unknown, field: keyof AdvisoryAiRoutingConfig, warnings: string[]): boolean {
  if (value === undefined) return DEFAULT_ADVISORY_AI_ROUTING[field];
  if (typeof value === "boolean") return value;
  warnings.push(`settings.advisoryAiRouting.${field} must be a boolean; using the default "${DEFAULT_ADVISORY_AI_ROUTING[field]}".`);
  return DEFAULT_ADVISORY_AI_ROUTING[field];
}

/**
 * Normalize a raw `.gittensory.yml settings.advisoryAiRouting` value into a typed config, fail-safe: any
 * malformed field falls back to its own (false) default and pushes a warning rather than rejecting the
 * whole block. Mirrors `normalizeUnlinkedIssueGuardrailConfig`'s per-field discipline.
 */
export function normalizeAdvisoryAiRoutingConfig(input: unknown, warnings: string[]): AdvisoryAiRoutingConfig {
  if (input === undefined) return { ...DEFAULT_ADVISORY_AI_ROUTING };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    warnings.push("settings.advisoryAiRouting must be an object; using the default (every capability off).");
    return { ...DEFAULT_ADVISORY_AI_ROUTING };
  }
  const record = input as Record<string, unknown>;
  return {
    slop: normalizeField(record.slop, "slop", warnings),
    e2eTestGen: normalizeField(record.e2eTestGen, "e2eTestGen", warnings),
    planner: normalizeField(record.planner, "planner", warnings),
    summaries: normalizeField(record.summaries, "summaries", warnings),
    chatQa: normalizeField(record.chatQa, "chatQa", warnings),
  };
}
