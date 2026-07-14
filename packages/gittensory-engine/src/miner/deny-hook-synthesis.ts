// Synthesize PreToolUse deny-hook rule proposals from per-repo blocker/path history (#4522, pure logic moved into
// the engine by #5667). Pure synthesis only: the optional local SQLite store for refresh + maintainer review lives
// in `packages/gittensory-miner/lib/deny-hook-synthesis.js`, which imports these pure functions from the engine.
// Approved rules merge with {@link DEFAULT_DENY_RULES}; unapproved proposals never block tool calls. Feeds the
// consumption surface #2343 will wire into evaluateDenyHooks — this module owns derivation + audit, not live hook
// interception. The clock is injected (nowMs) so the synthesis stays pure and deterministic.
import { createHash } from "node:crypto";
import { DEFAULT_DENY_RULES, evaluateDenyHooks, type DenyRule } from "./deny-hooks.js";

export type BlockerHistoryRecord = {
  repoFullName?: string | null;
  blockerCodes: string[];
  changedPaths?: string[];
  guardrailMatches?: string[];
  pullNumber?: number | null;
  recordedAt?: string | null;
};

export type DenyRuleProposalStatus = "proposed" | "approved" | "rejected";

export type DenyRuleProposalAudit = {
  kind: string;
  path?: string;
  pathPattern?: string;
  occurrenceCount?: number;
  blockerCodes?: string[];
  synthesizedAt: string;
};

export type DenyRuleProposal = {
  id: string;
  status: DenyRuleProposalStatus;
  rule: DenyRule;
  audit: DenyRuleProposalAudit;
};

export type SynthesisConfig = {
  minPathOccurrences?: number;
  maxProposals?: number;
};

export const PROPOSAL_STATUSES: readonly DenyRuleProposalStatus[] = Object.freeze(["proposed", "approved", "rejected"]);
export const proposalStatusSet: ReadonlySet<string> = new Set(PROPOSAL_STATUSES);

export const DEFAULT_SYNTHESIS_CONFIG: Readonly<Required<SynthesisConfig>> = Object.freeze({
  minPathOccurrences: 2,
  maxProposals: 20,
});

export function normalizeRepoFullName(repoFullName: unknown): string {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

function normalizeOptionalStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim());
}

/** Validate one blocker-history row from the review stack (gate block/close audit). */
export function normalizeBlockerHistoryRecord(record: unknown): BlockerHistoryRecord | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const source = record as Record<string, unknown>;
  const blockerCodes = normalizeOptionalStringArray(source.blockerCodes);
  if (blockerCodes.length === 0) return null;
  const changedPaths = normalizeOptionalStringArray(source.changedPaths);
  const guardrailMatches = normalizeOptionalStringArray(source.guardrailMatches);
  const repoFullName = typeof source.repoFullName === "string" && source.repoFullName.trim()
    ? normalizeRepoFullName(source.repoFullName)
    : null;
  return {
    repoFullName,
    blockerCodes,
    changedPaths,
    guardrailMatches,
    pullNumber: Number.isInteger(source.pullNumber) && (source.pullNumber as number) > 0 ? (source.pullNumber as number) : null,
    recordedAt: typeof source.recordedAt === "string" && source.recordedAt.trim() ? source.recordedAt.trim() : null,
  };
}

export function normalizeBlockerHistory(records: unknown): BlockerHistoryRecord[] {
  if (!Array.isArray(records)) return [];
  const normalized: BlockerHistoryRecord[] = [];
  for (const record of records) {
    const entry = normalizeBlockerHistoryRecord(record);
    if (entry) normalized.push(entry);
  }
  return normalized;
}

/** Canonicalize a changed path the same way guardrail matching does (case/separator insensitive). */
export function canonicalizeChangedPath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const trimmed = path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!trimmed || trimmed.includes("..")) return null;
  return trimmed.toLowerCase();
}

/** Convert a repo-relative changed path into a deny-hook glob matching DEFAULT_DENY_RULES shape. */
export function changedPathToDenyGlob(path: string): string | null {
  const canonical = canonicalizeChangedPath(path);
  if (!canonical) return null;
  return `**/${canonical}`;
}

function ruleSignature(rule: DenyRule): string {
  return JSON.stringify({
    matcher: rule.matcher,
    pathPattern: rule.pathPattern ?? null,
    inputIncludesAll: rule.inputIncludesAll ?? null,
    reason: rule.reason,
  });
}

/** True when a synthesized glob is already enforced by a built-in default deny rule. */
export function isCoveredByDefaultDenyRules(pathPattern: string): boolean {
  if (typeof pathPattern !== "string" || !pathPattern.trim()) return false;
  const samplePath = pathPattern.replace(/^\*\*\//, "");
  if (!samplePath) return false;
  return !evaluateDenyHooks({ name: "Write", input: { file_path: samplePath } }, DEFAULT_DENY_RULES).allowed;
}

function collectPathsFromRecord(record: BlockerHistoryRecord): Set<string> {
  const paths = new Set<string>();
  for (const path of [...(record.changedPaths ?? []), ...(record.guardrailMatches ?? [])]) {
    const canonical = canonicalizeChangedPath(path);
    if (canonical) paths.add(canonical);
  }
  return paths;
}

/** Aggregate path and blocker-code frequencies from normalized history. Pure. */
export function aggregateBlockerHistory(records: unknown): {
  pathCounts: Map<string, number>;
  pathBlockers: Map<string, Set<string>>;
  blockerCounts: Map<string, number>;
  recordCount: number;
} {
  const normalized = normalizeBlockerHistory(records);
  const pathCounts = new Map<string, number>();
  const pathBlockers = new Map<string, Set<string>>();
  const blockerCounts = new Map<string, number>();

  for (const record of normalized) {
    for (const code of record.blockerCodes) {
      blockerCounts.set(code, (blockerCounts.get(code) ?? 0) + 1);
    }
    for (const path of collectPathsFromRecord(record)) {
      pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
      const blockers = pathBlockers.get(path) ?? new Set<string>();
      for (const code of record.blockerCodes) blockers.add(code);
      pathBlockers.set(path, blockers);
    }
  }

  return {
    pathCounts,
    pathBlockers,
    blockerCounts,
    recordCount: normalized.length,
  };
}

function stableProposalId(kind: string, key: string): string {
  const digest = createHash("sha256").update(`${kind}:${key}`).digest("hex").slice(0, 16);
  return `${kind}:${digest}`;
}

// Clock injected (nowMs) so the stamped `synthesizedAt` is deterministic and this stays pure (#5667). The miner
// wrapper defaults nowMs to Date.now(), preserving the pre-#5667 wall-clock behavior for existing callers.
function buildPathProposal(
  path: string,
  occurrenceCount: number,
  blockerCodes: Set<string>,
  nowMs: number,
): DenyRuleProposal | null {
  const pathPattern = changedPathToDenyGlob(path);
  if (!pathPattern || isCoveredByDefaultDenyRules(pathPattern)) return null;
  const sortedBlockers = [...blockerCodes].sort();
  const reason = `Synthesized deny rule: ${occurrenceCount} gate block(s) touched ${path} (${sortedBlockers.join(", ") || "path history"}). Review before enabling.`;
  const rule: DenyRule = { matcher: "*", pathPattern, reason };
  return {
    id: stableProposalId("path", pathPattern),
    status: "proposed",
    rule,
    audit: {
      kind: "path_history",
      path,
      pathPattern,
      occurrenceCount,
      blockerCodes: sortedBlockers,
      synthesizedAt: new Date(nowMs).toISOString(),
    },
  };
}

/**
 * Derive candidate deny-hook rules from blocker/path history. Returns proposal objects only — nothing is active
 * until a maintainer approves them (see resolveEffectiveDenyRules). `nowMs` is a required injected clock: the
 * emitted `audit.synthesizedAt` is `new Date(nowMs).toISOString()`, so identical inputs yield identical output.
 */
export function synthesizeDenyRuleProposals(records: unknown, config: SynthesisConfig, nowMs: number): DenyRuleProposal[] {
  const minPathOccurrences = Number.isInteger(config.minPathOccurrences)
    ? Math.max(1, config.minPathOccurrences as number)
    : DEFAULT_SYNTHESIS_CONFIG.minPathOccurrences;
  const maxProposals = Number.isInteger(config.maxProposals)
    ? Math.max(1, config.maxProposals as number)
    : DEFAULT_SYNTHESIS_CONFIG.maxProposals;

  const { pathCounts, pathBlockers, recordCount } = aggregateBlockerHistory(records);
  if (recordCount === 0) return [];

  const rankedPaths = [...pathCounts.entries()]
    .filter(([, count]) => count >= minPathOccurrences)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

  const proposals: DenyRuleProposal[] = [];
  const seenSignatures = new Set(DEFAULT_DENY_RULES.map(ruleSignature));
  for (const [path, count] of rankedPaths) {
    const proposal = buildPathProposal(path, count, pathBlockers.get(path) ?? new Set(), nowMs);
    if (!proposal) continue;
    const signature = ruleSignature(proposal.rule);
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);
    proposals.push(proposal);
    if (proposals.length >= maxProposals) break;
  }
  return proposals;
}

/** Merge built-in defaults with maintainer-approved synthesized rules (deduped, defaults first). */
export function resolveEffectiveDenyRules(
  options: { includeDefaults?: boolean; approvedProposals?: DenyRuleProposal[] } = {},
): DenyRule[] {
  const includeDefaults = options.includeDefaults !== false;
  const approvedProposals = Array.isArray(options.approvedProposals) ? options.approvedProposals : [];
  const merged: DenyRule[] = includeDefaults ? [...DEFAULT_DENY_RULES] : [];
  const seen = new Set(merged.map(ruleSignature));
  for (const proposal of approvedProposals) {
    if (proposal?.status !== "approved") continue;
    const rule = proposal.rule;
    if (!rule || typeof rule !== "object") continue;
    const signature = ruleSignature(rule);
    if (seen.has(signature)) continue;
    seen.add(signature);
    merged.push(rule);
  }
  return merged;
}

/** Apply maintainer approval/rejection to in-memory proposals. Pure. */
export function setProposalStatuses(
  proposals: DenyRuleProposal[],
  updates: Record<string, DenyRuleProposalStatus> | Map<string, DenyRuleProposalStatus>,
): DenyRuleProposal[] {
  if (!Array.isArray(proposals)) throw new Error("invalid_proposals");
  const updateMap: Map<string, DenyRuleProposalStatus> = updates instanceof Map
    ? updates
    : new Map(Object.entries(updates ?? {}).filter(([id]) => typeof id === "string"));
  return proposals.map((proposal) => {
    const nextStatus = updateMap.get(proposal.id);
    if (!nextStatus || !proposalStatusSet.has(nextStatus)) return proposal;
    return { ...proposal, status: nextStatus };
  });
}
