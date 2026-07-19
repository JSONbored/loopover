import type { EventLedger, LedgerEntry } from "./event-ledger.js";
import type { PortfolioQueueStore, QueueStatus } from "./portfolio-queue.js";
import type { RunState, RunStateStore } from "./run-state.js";
/** Event vocabulary for manage-phase PR snapshots written by manage poll. (#2325) */
export declare const MANAGE_PR_UPDATE_EVENT = "manage_pr_update";
export declare const MANAGED_PR_IDENTIFIER_PREFIX = "pr:";
export type ManageStatusRow = {
    repoFullName: string;
    prNumber: number;
    branch: string | null;
    ciState: string | null;
    gateVerdict: string | null;
    outcome: string | null;
    lastPolledAt: string | null;
    queueStatus: QueueStatus | null;
    priority: number | null;
};
export type ManageStatusSources = {
    portfolioQueue: PortfolioQueueStore;
    eventLedger: EventLedger;
};
export type RunPortfolioSources = ManageStatusSources & {
    runStateStore: RunStateStore;
};
export type RunPortfolioRow = {
    repoFullName: string;
    runState: RunState | null;
    runStateUpdatedAt: string | null;
    prCount: number;
    prs: ManageStatusRow[];
};
export type ManageUpdateSnapshot = {
    repoFullName: string;
    prNumber: number;
    branch: string | null;
    ciState: string | null;
    gateVerdict: string | null;
    outcome: string | null;
    lastPolledAt: string | null;
};
export declare function parseManagedPrIdentifier(identifier: string): number | null;
export declare function formatManagedPrIdentifier(prNumber: number): string;
/** Index the latest manage snapshot per repo/PR from ascending ledger events. Pure. */
export declare function indexLatestManageUpdates(events: LedgerEntry[]): Map<string, ManageUpdateSnapshot>;
/**
 * Aggregate managed PR rows from the local portfolio queue and append-only event ledger. Read-only — never calls
 * GitHub or mutates local stores. (#2325)
 */
export declare function collectManageStatus(sources: ManageStatusSources): ManageStatusRow[];
/**
 * Fold each tracked repo's current discover/plan/prepare run state alongside its managed PR rows into one
 * "run portfolio" row per repo (#4279). `collectManageStatus` alone is PR-scoped only and never surfaces the
 * run-state signal, so a repo actively discovering/planning with zero PRs yet is otherwise invisible. A repo
 * appears here if it has EITHER a recorded run state OR at least one managed PR row.
 */
export declare function collectRunPortfolio(sources: RunPortfolioSources): RunPortfolioRow[];
export declare function renderManageStatusTable(rows: ManageStatusRow[]): string;
/** One row per tracked repo (run state + PR count), the compact companion to {@link renderManageStatusTable}'s
 *  per-PR detail (#4279). */
export declare function renderRunPortfolioTable(portfolio: RunPortfolioRow[]): string;
export declare function parseManageStatusArgs(args?: string[]): {
    json: boolean;
} | {
    error: string;
};
export declare function runManageStatus(args?: string[], options?: {
    initPortfolioQueue?: () => PortfolioQueueStore;
    initEventLedger?: () => EventLedger;
    initRunStateStore?: () => RunStateStore;
}): number;
