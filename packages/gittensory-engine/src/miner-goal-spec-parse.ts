import {
  DEFAULT_MINER_GOAL_SPEC,
  type MinerGoalSpec,
  type MinerIssueDiscoveryPolicy,
} from "./miner-goal-spec.js";

export type MinerGoalSpecParseResult = {
  present: boolean;
  spec: Readonly<MinerGoalSpec>;
  warnings: readonly string[];
};

const MAX_LIST_ENTRIES = 200;
const MAX_STRING_LEN = 300;
const POLICIES = new Set<MinerIssueDiscoveryPolicy>(["encouraged", "neutral", "discouraged"]);

function freezeSpec(spec: MinerGoalSpec): Readonly<MinerGoalSpec> {
  return Object.freeze({
    ...spec,
    wantedPaths: Object.freeze([...spec.wantedPaths]),
    blockedPaths: Object.freeze([...spec.blockedPaths]),
    preferredLabels: Object.freeze([...spec.preferredLabels]),
    blockedLabels: Object.freeze([...spec.blockedLabels]),
  });
}

function parseStringList(value: unknown, field: string, warnings: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`MinerGoalSpec field "${field}" must be an array; ignoring.`);
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      warnings.push(`MinerGoalSpec field "${field}" entries must be strings; skipping non-string.`);
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > MAX_STRING_LEN) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_LIST_ENTRIES) break;
  }
  return out;
}

function parseBoolean(value: unknown, field: string, fallback: boolean, warnings: string[]): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  warnings.push(`MinerGoalSpec field "${field}" must be a boolean; using default.`);
  return fallback;
}

function parseClaims(value: unknown, warnings: string[]): number {
  if (value === undefined) return DEFAULT_MINER_GOAL_SPEC.maxConcurrentClaims;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`MinerGoalSpec field "maxConcurrentClaims" must be a number; using default.`);
    return DEFAULT_MINER_GOAL_SPEC.maxConcurrentClaims;
  }
  const floored = Math.floor(value);
  if (floored < 1) {
    warnings.push(`MinerGoalSpec field "maxConcurrentClaims" must be >= 1; using 1.`);
    return 1;
  }
  return floored;
}

function parsePolicy(value: unknown, warnings: string[]): MinerIssueDiscoveryPolicy {
  if (value === undefined) return DEFAULT_MINER_GOAL_SPEC.issueDiscoveryPolicy;
  if (typeof value !== "string") {
    warnings.push(`MinerGoalSpec field "issueDiscoveryPolicy" must be a string; using neutral.`);
    return "neutral";
  }
  const normalized = value.trim().toLowerCase();
  if (POLICIES.has(normalized as MinerIssueDiscoveryPolicy)) return normalized as MinerIssueDiscoveryPolicy;
  warnings.push(
    `MinerGoalSpec field "issueDiscoveryPolicy" must be encouraged, neutral, or discouraged; using neutral.`,
  );
  return "neutral";
}

/** Parse raw JSON/YAML-decoded config into a deep-frozen {@link MinerGoalSpec}. Pure — no IO. */
export function parseMinerGoalSpec(raw: unknown): MinerGoalSpecParseResult {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return { present: false, spec: DEFAULT_MINER_GOAL_SPEC, warnings: [] };
  }

  const record = raw as Record<string, unknown>;
  const warnings: string[] = [];
  const present = Object.keys(record).length > 0;

  const spec = freezeSpec({
    minerEnabled: parseBoolean(record.minerEnabled, "minerEnabled", DEFAULT_MINER_GOAL_SPEC.minerEnabled, warnings),
    wantedPaths: parseStringList(record.wantedPaths, "wantedPaths", warnings),
    blockedPaths: parseStringList(record.blockedPaths, "blockedPaths", warnings),
    preferredLabels: parseStringList(record.preferredLabels, "preferredLabels", warnings),
    blockedLabels: parseStringList(record.blockedLabels, "blockedLabels", warnings),
    maxConcurrentClaims: parseClaims(record.maxConcurrentClaims, warnings),
    issueDiscoveryPolicy: parsePolicy(record.issueDiscoveryPolicy, warnings),
  });

  return { present, spec, warnings: Object.freeze(warnings) };
}
