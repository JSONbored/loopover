import { aggregateBlockerHistory, canonicalizeChangedPath, changedPathToDenyGlob, DEFAULT_SYNTHESIS_CONFIG, isCoveredByDefaultDenyRules, normalizeBlockerHistory, normalizeBlockerHistoryRecord, resolveEffectiveDenyRules, setProposalStatuses } from "@loopover/engine";
import type { BlockerHistoryRecord, DenyRuleProposal, DenyRuleProposalAudit, DenyRuleProposalStatus, SynthesisConfig } from "@loopover/engine";
import type { DenyRule } from "./deny-hooks.js";
export { aggregateBlockerHistory, canonicalizeChangedPath, changedPathToDenyGlob, DEFAULT_SYNTHESIS_CONFIG, isCoveredByDefaultDenyRules, normalizeBlockerHistory, normalizeBlockerHistoryRecord, resolveEffectiveDenyRules, setProposalStatuses, };
export type { BlockerHistoryRecord, DenyRuleProposal, DenyRuleProposalAudit, DenyRuleProposalStatus, SynthesisConfig, };
export type DenyHookSynthesisStore = {
    dbPath: string;
    refreshProposals(repoFullName: string, history: unknown, config?: SynthesisConfig, apiBaseUrl?: string): DenyRuleProposal[];
    listProposals(repoFullName: string, apiBaseUrl?: string): DenyRuleProposal[];
    setProposalStatus(repoFullName: string, proposalId: string, status: DenyRuleProposalStatus, apiBaseUrl?: string): void;
    resolveEffectiveRules(repoFullName: string, options?: {
        includeDefaults?: boolean;
        apiBaseUrl?: string;
    }): DenyRule[];
    close(): void;
};
/**
 * Derive candidate deny-hook rules from blocker/path history. Miner-facing wrapper over the engine's pure
 * `synthesizeDenyRuleProposals`, defaulting the injected clock to `Date.now()` so this keeps the pre-#5667 2-arg
 * signature (and wall-clock `audit.synthesizedAt`) every existing caller and test relies on. Returns proposal
 * objects only — nothing is active until a maintainer approves them (see resolveEffectiveDenyRules).
 */
export declare function synthesizeDenyRuleProposals(records: unknown, config?: SynthesisConfig): DenyRuleProposal[];
export declare function resolveDenyHookSynthesisDbPath(env?: Record<string, string | undefined>): string;
/**
 * Local SQLite store for synthesized deny-rule proposals. Refresh re-derives proposals from history while
 * preserving maintainer decisions on ids that still exist.
 */
export declare function initDenyHookSynthesisStore(dbPath?: string): DenyHookSynthesisStore;
