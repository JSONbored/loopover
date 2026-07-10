import type { DenyRule } from "./deny-hooks.js";

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

export const DEFAULT_SYNTHESIS_CONFIG: Readonly<Required<SynthesisConfig>>;

export function normalizeBlockerHistoryRecord(record: unknown): BlockerHistoryRecord | null;

export function normalizeBlockerHistory(records: unknown): BlockerHistoryRecord[];

export function canonicalizeChangedPath(path: unknown): string | null;

export function changedPathToDenyGlob(path: string): string | null;

export function isCoveredByDefaultDenyRules(pathPattern: string): boolean;

export function aggregateBlockerHistory(records: unknown): {
  pathCounts: Map<string, number>;
  pathBlockers: Map<string, Set<string>>;
  blockerCounts: Map<string, number>;
  recordCount: number;
};

export function synthesizeDenyRuleProposals(
  records: unknown,
  config?: SynthesisConfig,
): DenyRuleProposal[];

export function resolveEffectiveDenyRules(options?: {
  includeDefaults?: boolean;
  approvedProposals?: DenyRuleProposal[];
}): DenyRule[];

export function setProposalStatuses(
  proposals: DenyRuleProposal[],
  updates: Record<string, DenyRuleProposalStatus> | Map<string, DenyRuleProposalStatus>,
): DenyRuleProposal[];

export function resolveDenyHookSynthesisDbPath(env?: Record<string, string | undefined>): string;

export type DenyHookSynthesisStore = {
  dbPath: string;
  refreshProposals(
    repoFullName: string,
    history: unknown,
    config?: SynthesisConfig,
  ): DenyRuleProposal[];
  listProposals(repoFullName: string): DenyRuleProposal[];
  setProposalStatus(repoFullName: string, proposalId: string, status: DenyRuleProposalStatus): void;
  resolveEffectiveRules(repoFullName: string, options?: { includeDefaults?: boolean }): DenyRule[];
  close(): void;
};

export function initDenyHookSynthesisStore(dbPath?: string): DenyHookSynthesisStore;
