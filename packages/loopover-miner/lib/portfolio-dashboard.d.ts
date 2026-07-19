export interface PortfolioRepoSummary {
  apiBaseUrl: string;
  repoFullName: string;
  byStatus: { queued: number; in_progress: number; done: number };
  total: number;
}

export interface PortfolioDashboardSummary {
  total: number;
  byStatus: { queued: number; in_progress: number; done: number };
  repos: PortfolioRepoSummary[];
  oldestQueuedAgeMs: number | null;
}

export interface PortfolioDashboardSources {
  portfolioQueue: { listQueue(repoFullName?: string | null): unknown[] };
}

export function collectPortfolioDashboard(
  sources: PortfolioDashboardSources,
  options?: { nowMs?: number },
): PortfolioDashboardSummary;

export function renderPortfolioDashboardTable(summary: PortfolioDashboardSummary | null | undefined): string;

export function parsePortfolioDashboardArgs(args?: string[]): { json: boolean } | { error: string };

export function runPortfolioDashboard(
  args?: string[],
  options?: { initPortfolioQueue?: () => { listQueue(repoFullName: string | null): unknown[]; close(): void }; nowMs?: number },
): number;
