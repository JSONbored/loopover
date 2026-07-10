import type { EventLedger, LedgerEntry } from "./event-ledger.js";
import type { PortfolioQueueStore, QueueStatus } from "./portfolio-queue.js";
import type { RunState, RunStateStore } from "./run-state.js";

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

export const MANAGE_PR_UPDATE_EVENT: "manage_pr_update";
export const MANAGED_PR_IDENTIFIER_PREFIX: "pr:";

export function parseManagedPrIdentifier(identifier: string): number | null;

export function formatManagedPrIdentifier(prNumber: number): string;

export function indexLatestManageUpdates(events: LedgerEntry[]): Map<string, ManageUpdateSnapshot>;

export function collectManageStatus(sources: ManageStatusSources): ManageStatusRow[];

export function collectRunPortfolio(sources: RunPortfolioSources): RunPortfolioRow[];

export function renderManageStatusTable(rows: ManageStatusRow[]): string;

export function renderRunPortfolioTable(portfolio: RunPortfolioRow[]): string;

export function parseManageStatusArgs(args?: string[]): { json: boolean } | { error: string };

export function runManageStatus(
  args?: string[],
  options?: {
    initPortfolioQueue?: () => PortfolioQueueStore;
    initEventLedger?: () => EventLedger;
    initRunStateStore?: () => RunStateStore;
  },
): number;
